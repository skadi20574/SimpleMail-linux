/**
 * 主题应用（渲染层）。
 *
 * 分工：
 *   · 主进程负责把「浅色 / 深色 / 跟随系统」写进 nativeTheme.themeSource；
 *   · 渲染层只读 prefers-color-scheme 来判断当前实际是深是浅，然后给
 *     <html> 打上 data-theme。
 *
 * 这样「跟随系统」不需要任何 IPC：Chromium 会把 nativeTheme 的结果直接反映到
 * prefers-color-scheme 上，系统切换主题时这里也能收到 change 事件。
 */

import type { ThemeMode } from '@shared/types'

export type EffectiveTheme = 'light' | 'dark'

const DARK_QUERY = '(prefers-color-scheme: dark)'

export function systemPrefersDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches
}

export function effectiveTheme(mode: ThemeMode): EffectiveTheme {
  if (mode === 'system') return systemPrefersDark() ? 'dark' : 'light'
  return mode
}

/** 把主题写到 <html data-theme="..."> 上，CSS 靠它切换变量 */
export function applyTheme(mode: ThemeMode): EffectiveTheme {
  const theme = effectiveTheme(mode)
  document.documentElement.dataset.theme = theme
  return theme
}

/** 监听系统主题变化；返回取消订阅函数 */
export function watchSystemTheme(callback: () => void): () => void {
  const mq = window.matchMedia(DARK_QUERY)
  const handler = (): void => callback()
  mq.addEventListener('change', handler)
  return () => mq.removeEventListener('change', handler)
}
