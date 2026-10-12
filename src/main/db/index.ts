import { openDatabase, type Db } from './sqlite'
import { initSchema, getMeta, setMeta } from './schema'
import { appPaths } from '../paths'

let instance: Db | null = null

export function getDb(): Db {
  if (instance) return instance
  instance = openDatabase(appPaths().database)
  // 迁移过程中会重建全文索引（结构变了），大库可能要几秒，
  // 打一行日志方便排查启动变慢的原因。
  initSchema(instance, (msg) => {
    // eslint-disable-next-line no-console
    console.log(`[SimpleMail] ${msg}`)
  })
  return instance
}

export function closeDb(): void {
  if (instance) {
    try {
      instance.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      /* ignore */
    }
    instance.close()
    instance = null
  }
}

export { getMeta, setMeta }
export type { Db }
