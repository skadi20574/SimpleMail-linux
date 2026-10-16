/**
 * 应用设置：一个放在 userData 里的 JSON 文件，读写都很轻。
 * 账户密码不在这里 —— 它存在 SQLite 的 accounts 表里（同样是本地文件）。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nativeTheme } from 'electron'
import type { AppSettings } from '@shared/types'
import { appPaths } from './paths'

export const DEFAULT_SETTINGS: AppSettings = {
  splitRatio: 0.42,
  sidebarWidth: 232,
  pageSize: 200,
  syncBatch: 500,
  autoDownloadBodies: true,
  allowRemoteImages: false,
  theme: 'system',
  shortcuts: {},
  autoSyncOnStart: true,
  defaultArchiveTag: 'Foxmail存档',
  autoMarkRead: true
}

let cache: AppSettings | null = null

function settingsPath(): string {
  return join(appPaths().userData, 'settings.json')
}

export function loadSettings(): AppSettings {
  if (cache) return cache
  const file = settingsPath()
  if (!existsSync(file)) {
    cache = { ...DEFAULT_SETTINGS }
    return cache
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppSettings>
    cache = normalizeSettings({ ...DEFAULT_SETTINGS, ...raw })
  } catch {
    cache = { ...DEFAULT_SETTINGS }
  }
  return cache
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const current = loadSettings()
  cache = normalizeSettings({ ...current, ...patch })
  writeFileSync(settingsPath(), JSON.stringify(cache, null, 2), 'utf8')
  applyThemeToNative()
  return cache
}

/**
 * 把主题模式交给 Electron。
 *
 * 设置成 'system' 后，Chromium 会跟随系统；设置成 light/dark 则强制。
 * 无论哪种，渲染层的 prefers-color-scheme 都会同步反映出来，
 * 所以界面侧不需要额外的主题 IPC。
 */
export function applyThemeToNative(): void {
  try {
    nativeTheme.themeSource = loadSettings().theme
  } catch {
    /* 极早期调用（app ready 之前）忽略 */
  }
}

/** 校正非法值，避免老版本设置文件里的字段让界面崩掉 */
export function normalizeSettings(s: AppSettings): AppSettings {
  const theme: AppSettings['theme'] =
    s.theme === 'light' || s.theme === 'dark' || s.theme === 'system' ? s.theme : 'system'
  const shortcuts =
    s.shortcuts && typeof s.shortcuts === 'object' && !Array.isArray(s.shortcuts)
      ? s.shortcuts
      : {}
  const autoMarkRead = typeof s.autoMarkRead === 'boolean' ? s.autoMarkRead : true
  return { ...s, theme, shortcuts, autoMarkRead }
}
