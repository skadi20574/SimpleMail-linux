import type { Db } from './sqlite'
import { createFts, ftsNeedsRebuild, rebuildFts } from './fts'

export const SCHEMA_VERSION = 3

/**
 * 建表语句。全部使用 IF NOT EXISTS，保证在已有数据库上重复执行是安全的。
 *
 * 关于「永久保存」：SimpleMail 不会对 mails / attachments 做任何自动清理，
 * 也没有任何定时删除任务。删除邮件只会由用户显式操作触发。
 */
const CORE_SCHEMA = `

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL,
  display_name  TEXT    NOT NULL DEFAULT '',
  -- 收件协议：imap（默认）或 pop3。
  -- IMAP 与 POP3 是两套模型：POP3 只有收件箱、没有服务器文件夹、
  -- 也没有已读/星标状态，所以两者的服务器参数各存一份，切换协议时不用重填。
  protocol      TEXT    NOT NULL DEFAULT 'imap',
  imap_host     TEXT    NOT NULL DEFAULT '',
  imap_port     INTEGER NOT NULL DEFAULT 993,
  imap_secure   INTEGER NOT NULL DEFAULT 1,
  pop3_host     TEXT    NOT NULL DEFAULT '',
  pop3_port     INTEGER NOT NULL DEFAULT 995,
  pop3_secure   INTEGER NOT NULL DEFAULT 1,
  -- 1 = 下载成功后从服务器删除（危险，默认 0 保留副本）
  pop3_delete_after_fetch INTEGER NOT NULL DEFAULT 0,
  smtp_host     TEXT    NOT NULL DEFAULT '',
  smtp_port     INTEGER NOT NULL DEFAULT 465,
  smtp_secure   INTEGER NOT NULL DEFAULT 1,
  username      TEXT    NOT NULL DEFAULT '',
  password      TEXT    NOT NULL DEFAULT '',
  signature     TEXT    NOT NULL DEFAULT '',
  color         TEXT    NOT NULL DEFAULT '#2f7fd8',
  sync_enabled  INTEGER NOT NULL DEFAULT 1,
  is_local      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT 0,
  last_sync_at  INTEGER
);

CREATE TABLE IF NOT EXISTS folders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  path        TEXT    NOT NULL,
  role        TEXT    NOT NULL DEFAULT 'custom',
  delimiter   TEXT    NOT NULL DEFAULT '/',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  -- 从 Foxmail .box/.ind 导入时自标定出来的索引布局（JSON）。
  -- 导出时沿用同一布局，保证「导出成同样格式」。
  box_layout  TEXT,
  UNIQUE (account_id, path)
);

CREATE TABLE IF NOT EXISTS mails (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder_id       INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  uid             INTEGER,
  -- POP3 的 UIDL（服务器给的唯一标识）。POP3 没有 UID，靠这个做增量与去重。
  pop3_uid        TEXT,
  message_id      TEXT,
  subject         TEXT    NOT NULL DEFAULT '',
  from_name       TEXT    NOT NULL DEFAULT '',
  from_addr       TEXT    NOT NULL DEFAULT '',
  to_text         TEXT    NOT NULL DEFAULT '',
  cc_text         TEXT    NOT NULL DEFAULT '',
  bcc_text        TEXT    NOT NULL DEFAULT '',
  reply_to        TEXT    NOT NULL DEFAULT '',
  date            INTEGER NOT NULL DEFAULT 0,
  body_text       TEXT    NOT NULL DEFAULT '',
  body_html       TEXT,
  raw_headers     TEXT    NOT NULL DEFAULT '',
  snippet         TEXT    NOT NULL DEFAULT '',
  in_reply_to     TEXT,
  refs            TEXT,
  size            INTEGER NOT NULL DEFAULT 0,
  unread          INTEGER NOT NULL DEFAULT 1,
  flagged         INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  source          TEXT    NOT NULL DEFAULT 'imap',
  archive_tag     TEXT,
  -- 自动规则状态。
  -- rules_fired：已经**实际执行过动作**的规则 id（JSON 数组）。
  --   必须记下来，否则正文补下来后重跑规则时，「移到垃圾箱」会对一封
  --   已经在垃圾箱里的邮件再执行一次 —— 而那个动作在垃圾箱里等同于永久删除。
  -- rules_done：当前规则集是否已完整评估过（含依赖正文的条件）。
  rules_fired     TEXT    NOT NULL DEFAULT '[]',
  rules_done      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  mail_id      INTEGER NOT NULL REFERENCES mails(id) ON DELETE CASCADE,
  filename     TEXT    NOT NULL DEFAULT '',
  content_type TEXT    NOT NULL DEFAULT 'application/octet-stream',
  size         INTEGER NOT NULL DEFAULT 0,
  content_id   TEXT,
  is_inline    INTEGER NOT NULL DEFAULT 0,
  stored_path  TEXT,
  created_at   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS archives (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  tag         TEXT    NOT NULL,
  source_path TEXT    NOT NULL DEFAULT '',
  kind        TEXT    NOT NULL DEFAULT 'unknown',
  imported    INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT 0
);

-- 自动归类 / 自动删除规则
CREATE TABLE IF NOT EXISTS rules (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  -- 排序权重，小的先跑
  priority      INTEGER NOT NULL DEFAULT 100,
  -- NULL 表示对所有账户生效
  account_id    INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  -- 多个条件之间：all = 全部满足，any = 满足任一
  match_mode    TEXT    NOT NULL DEFAULT 'all',
  -- 条件数组（JSON）：[{ field, op, value }]
  conditions    TEXT    NOT NULL DEFAULT '[]',
  -- 动作：trash | delete | move | mark_read | flag | mark_read_move
  action        TEXT    NOT NULL DEFAULT 'move',
  action_folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  -- 命中后是否停止继续匹配后面的规则
  stop          INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_state (
  account_id   INTEGER NOT NULL,
  folder_id    INTEGER NOT NULL,
  uid_validity INTEGER,
  last_uid     INTEGER NOT NULL DEFAULT 0,
  last_sync_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, folder_id)
);
`

/**
 * 索引与表结构**分开**：迁移必须先于索引创建执行。
 *
 * 这里是踩过的坑：老版本数据库里 mails 表已经存在但还没有 pop3_uid 列，
 * 如果先执行建索引语句就会报 "no such column: pop3_uid"，
 * 结果所有老用户一升级就启动失败。正确顺序是
 * 建表（IF NOT EXISTS，对已有表无影响）→ 补列迁移 → 再建索引。
 */
const INDEX_SCHEMA = `
CREATE INDEX IF NOT EXISTS idx_mails_folder_date ON mails(folder_id, date DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_mails_account     ON mails(account_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_mails_uid         ON mails(folder_id, uid);

CREATE INDEX IF NOT EXISTS idx_mails_source      ON mails(source, archive_tag);

-- 去重：同一账户内 Message-ID 唯一（存档重复导入时靠它跳过）
CREATE UNIQUE INDEX IF NOT EXISTS idx_mails_dedup
  ON mails(account_id, message_id)
  WHERE message_id IS NOT NULL AND message_id <> '';

-- 没有 Message-ID 的老邮件，用 账户+文件夹+日期+主题+发件人 做二次去重。
-- 注意：**排除 IMAP 来源**，因为服务器上的邮件 UID 才是权威标识，
-- 而两条内容完全相同的通知邮件是合法的（比如监控告警），不应被当成重复丢掉。
CREATE UNIQUE INDEX IF NOT EXISTS idx_mails_dedup2
  ON mails(account_id, folder_id, date, subject, from_addr)
  WHERE (message_id IS NULL OR message_id = '') AND source <> 'imap';

-- IMAP 来源以 (文件夹, UID) 唯一，保证重复同步不会产生副本
CREATE UNIQUE INDEX IF NOT EXISTS idx_mails_uid_unique
  ON mails(folder_id, uid)
  WHERE uid IS NOT NULL;

-- POP3 来源以 UIDL 唯一
CREATE UNIQUE INDEX IF NOT EXISTS idx_mails_pop3_uid
  ON mails(folder_id, pop3_uid)
  WHERE pop3_uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_attachments_mail ON attachments(mail_id);
`


export interface FtsInit {
  /** true 表示用的是 contentless 表 */
  contentless: boolean
}

export function initSchema(db: Db, onProgress?: (msg: string) => void): FtsInit {
  // 顺序很关键：建表 → 迁移补列 → 建索引（详见 INDEX_SCHEMA 的注释）
  db.exec(CORE_SCHEMA)
  migrate(db)
  db.exec(INDEX_SCHEMA)

  // FTS 表结构不对（老版本的单列 cjk 结构）或者干脆缺失 → 重建索引。
  // 注意：只重建**索引**，完全不碰 mails 表，所以邮件一封都不会丢。
  const hasFts =
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='mails_fts'`).get() !==
    undefined

  let contentless = getMeta(db, 'fts_contentless') !== '0'
  if (!hasFts || ftsNeedsRebuild(db)) {
    onProgress?.('正在重建全文索引…')
    const result = rebuildFts(db, (done, total) => {
      onProgress?.(`正在重建全文索引… ${done}/${total}`)
    })
    contentless = result.contentless
    setMeta(db, 'fts_contentless', contentless ? '1' : '0')
    setMeta(db, 'fts_rebuilt_at', new Date().toISOString())
  } else if (!hasFts) {
    contentless = createFts(db)
  }

  setMeta(db, 'schema_version', String(SCHEMA_VERSION))
  return { contentless }
}

/** 读取一张表已有的列名 */
function tableColumns(db: Db, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return new Set(rows.map((r) => r.name))
}

/**
 * 增量迁移。
 *
 * 老版本的数据库（比如只支持 IMAP 的 v1）必须能直接升级，不能让用户删库重来 ——
 * 那等于丢掉全部历史邮件。所以这里用「缺哪列补哪列」的方式做前向迁移，
 * 每一步都幂等，重复执行安全。
 */
export function migrate(db: Db): void {
  const current = Number(getMeta(db, 'schema_version') ?? '1')
  if (current >= SCHEMA_VERSION) return

  // v1 → v2：收件协议增加 POP3
  if (current < 2) {
    const accountCols = tableColumns(db, 'accounts')
    const addAccountColumn = (name: string, ddl: string): void => {
      if (!accountCols.has(name)) db.exec(`ALTER TABLE accounts ADD COLUMN ${ddl}`)
    }
    addAccountColumn('protocol', `protocol TEXT NOT NULL DEFAULT 'imap'`)
    addAccountColumn('pop3_host', `pop3_host TEXT NOT NULL DEFAULT ''`)
    addAccountColumn('pop3_port', `pop3_port INTEGER NOT NULL DEFAULT 995`)
    addAccountColumn('pop3_secure', `pop3_secure INTEGER NOT NULL DEFAULT 1`)
    addAccountColumn(
      'pop3_delete_after_fetch',
      `pop3_delete_after_fetch INTEGER NOT NULL DEFAULT 0`
    )

    const mailCols = tableColumns(db, 'mails')
    if (!mailCols.has('pop3_uid')) {
      db.exec('ALTER TABLE mails ADD COLUMN pop3_uid TEXT')
    }
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_mails_pop3_uid
         ON mails(folder_id, pop3_uid) WHERE pop3_uid IS NOT NULL`
    )

    setMeta(db, 'schema_version', '2')
  }

  // v2 → v3：自动归类规则 + 分字段全文索引
  if (Number(getMeta(db, 'schema_version') ?? '1') < 3) {
    const mailCols = tableColumns(db, 'mails')
    if (!mailCols.has('rules_done')) {
      db.exec('ALTER TABLE mails ADD COLUMN rules_done INTEGER NOT NULL DEFAULT 0')
    }
    if (!mailCols.has('rules_fired')) {
      db.exec("ALTER TABLE mails ADD COLUMN rules_fired TEXT NOT NULL DEFAULT '[]'")
    }
    // rules 表本身由 CORE_SCHEMA 的 IF NOT EXISTS 保证存在；
    // 这里再补一次是为了让「老库」也能拿到（CORE_SCHEMA 建表语句用的是 IF NOT EXISTS）
    db.exec(`CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 100,
      account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
      match_mode TEXT NOT NULL DEFAULT 'all',
      conditions TEXT NOT NULL DEFAULT '[]',
      action TEXT NOT NULL DEFAULT 'move',
      action_folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
      stop INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT 0
    )`)

    // 全文索引会在 initSchema 里检测到结构变化后整体重建
    setMeta(db, 'schema_version', '3')
  }
}

export function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value)
}
