/**
 * SQLite 访问层。
 *
 * 设计要点：
 * - 使用 Electron 内置的 `node:sqlite`（Electron 38 自带 Node 22.20 / SQLite 3.50.4，
 *   且编译时已启用 FTS5）。这样**完全不需要任何原生模块**，也就不用 electron-rebuild，
 *   产出的安装包不绑死构建机的 glibc 版本 —— 这是能在 Ubuntu 22.04/24.04/26.04
 *   上通吃的前提。
 * - 所有数据库调用都集中在这里，将来若要换成 better-sqlite3，只需要改这一个文件。
 */

import { DatabaseSync } from 'node:sqlite'

export type SqlValue = null | number | bigint | string | Uint8Array

export interface RunResult {
  changes: number
  lastInsertRowid: number
}

export interface Statement {
  run(...params: SqlValue[]): RunResult
  get(...params: SqlValue[]): unknown
  all(...params: SqlValue[]): unknown[]
}

export interface Db {
  exec(sql: string): void
  prepare(sql: string): Statement
  close(): void
}

/** node:sqlite 返回的是 null 原型对象，跨 IPC 前统一转成普通对象 */
export function plain<T>(row: unknown): T | undefined {
  if (row === undefined || row === null) return undefined
  return { ...(row as object) } as T
}

export function plainAll<T>(rows: unknown[]): T[] {
  return rows.map((r) => ({ ...(r as object) }) as T)
}

export function openDatabase(file: string): Db {
  const db = new DatabaseSync(file) as unknown as Db
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA temp_store = MEMORY')
  db.exec('PRAGMA cache_size = -32000')
  db.exec('PRAGMA busy_timeout = 10000')
  return db
}
