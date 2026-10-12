import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync, existsSync } from 'node:fs'
import type { AppPaths } from '@shared/types'

let cached: AppPaths | null = null

export function appPaths(): AppPaths {
  if (cached) return cached
  const userData = app.getPath('userData')
  const attachments = join(userData, 'attachments')
  const exportsDir = join(userData, 'exports')
  const logs = join(userData, 'logs')
  for (const dir of [userData, attachments, exportsDir, logs]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
  cached = {
    userData,
    database: join(userData, 'simplemail.db'),
    attachments,
    exports: exportsDir,
    logs,
    version: app.getVersion(),
    platform: `${process.platform}-${process.arch}`
  }
  return cached
}

export function attachmentsRoot(): string {
  return appPaths().attachments
}
