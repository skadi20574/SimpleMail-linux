/**
 * 线条图标集（自绘 SVG，统一 16×16 视图、currentColor 描边）。
 *
 * 为什么不用 emoji：emoji 是彩色位图字体，在不同系统/字体下字形差异很大，
 * 而且不能跟随文字颜色、不能调粗细，和「简洁清爽的浅色界面」完全不搭。
 * 线条图标能直接吃 currentColor，浅色深色主题下都清楚。
 *
 * 所有图标都是照着通用几何形状手写的，不取自任何图标库或商业软件素材。
 */

import type { CSSProperties } from 'react'

export type IconName =
  // 工具栏
  | 'compose'
  | 'reply'
  | 'replyAll'
  | 'forward'
  | 'trash'
  | 'deleteForever'
  | 'sync'
  | 'import'
  | 'export'
  | 'settings'
  | 'rules'
  // 文件夹
  | 'inbox'
  | 'drafts'
  | 'sent'
  | 'junk'
  | 'archive'
  | 'folder'
  // 邮件
  | 'paperclip'
  | 'folderOpen'
  | 'image'
  | 'mail'
  | 'mailbox'
  // 界面
  | 'search'
  | 'sun'
  | 'moon'
  | 'autoTheme'
  | 'chevronDown'
  | 'star'
  | 'check'
  | 'close'
  | 'warning'
  | 'info'
  | 'uninstall'
  | 'database'
  | 'account'

const PATHS: Record<IconName, JSX.Element> = {
  compose: (
    <>
      <path d="M10.6 2.4l3 3L5 14H2v-3z" />
      <path d="M9.1 3.9l3 3" />
    </>
  ),
  reply: (
    <>
      <path d="M6 4L2.5 7.5 6 11" />
      <path d="M2.5 7.5H9A4.5 4.5 0 0113.5 12v1" />
    </>
  ),
  replyAll: (
    <>
      <path d="M5 4L1.5 7.5 5 11" />
      <path d="M9 4L5.5 7.5 9 11" />
      <path d="M5.5 7.5H10A4 4 0 0114 11.5v1" />
    </>
  ),
  forward: (
    <>
      <path d="M10 4l3.5 3.5L10 11" />
      <path d="M13.5 7.5H7A4.5 4.5 0 002.5 12v1" />
    </>
  ),
  trash: (
    <>
      <path d="M2.5 4.5h11" />
      <path d="M6 4.5V3h4v1.5" />
      <path d="M4 4.5l.8 9h6.4l.8-9" />
      <path d="M6.8 7v4M9.2 7v4" />
    </>
  ),
  deleteForever: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2" />
    </>
  ),
  sync: (
    <>
      <path d="M2.6 6.4A5.5 5.5 0 0112.6 5.2" />
      <path d="M13.4 9.6A5.5 5.5 0 013.4 10.8" />
      <path d="M12.6 2.3v2.9h-2.9" />
      <path d="M3.4 13.7v-2.9h2.9" />
    </>
  ),
  import: (
    <>
      <path d="M8 2v7" />
      <path d="M5 6.5L8 9.5l3-3" />
      <path d="M2.5 11.5v2h11v-2" />
    </>
  ),
  export: (
    <>
      <path d="M8 9.5v-7" />
      <path d="M5 5.5L8 2.5l3 3" />
      <path d="M2.5 11.5v2h11v-2" />
    </>
  ),
  /**
   * 齿轮。
   *
   * 之前这里画的是「圆圈 + 八条射线」，在 16px 下和小太阳完全分不出来 ——
   * 用户反馈「设置图标和主题图标长得一样」。现在换成真正的六齿齿轮轮廓，
   * 齿顶/齿根用圆弧，坐标是脚本算出来的（见 README 的图标说明）。
   */
  settings: (
    <>
      <path d="M6.40 1.49 L8.00 1.30 L9.60 1.49 L9.16 3.29 L10.42 3.80 L11.50 4.64 L12.84 3.36 L13.80 4.65 L14.43 6.13 L12.66 6.65 L12.85 8.00 L12.66 9.35 L14.43 9.87 L13.80 11.35 L12.84 12.64 L11.50 11.36 L10.43 12.20 L9.16 12.71 L9.60 14.51 L8.00 14.70 L6.40 14.51 L6.84 12.71 L5.58 12.20 L4.50 11.36 L3.16 12.64 L2.20 11.35 L1.57 9.87 L3.34 9.35 L3.15 8.00 L3.34 6.65 L1.57 6.13 L2.20 4.65 L3.16 3.36 L4.50 4.64 L5.57 3.80 L6.84 3.29 Z" />
      <circle cx="8" cy="8" r="2.15" />
    </>
  ),
  rules: <path d="M2 3h12l-4.5 5.2v4.4L6.5 14.5V8.2L2 3z" />,

  inbox: (
    <>
      <path d="M2 8.5L3.8 3.5h8.4L14 8.5v4.2H2V8.5z" />
      <path d="M2 8.5h3.4l.8 1.7h3.6l.8-1.7H14" />
    </>
  ),
  drafts: (
    <>
      <path d="M9.6 13.6H2.6V2.4h6" />
      <path d="M12.4 6.3l1.6 1.6-4.7 4.7H7.9v-1.4z" />
    </>
  ),
  sent: (
    <>
      <path d="M14 2L7 9" />
      <path d="M14 2l-4.3 12-2.7-5-5-2.7L14 2z" />
    </>
  ),
  junk: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M4.2 11.8l7.6-7.6" />
    </>
  ),
  archive: (
    <>
      <path d="M2 5.6h12V3.4H2v2.2z" />
      <path d="M3.1 5.6v7.4h9.8V5.6" />
      <path d="M6.5 8.5h3" />
    </>
  ),
  folder: <path d="M2 4.2h4.1l1.4 1.8H14v6.9H2V4.2z" />,

  paperclip: (
    <path d="M11.4 7.1l-4.6 4.6a2.4 2.4 0 01-3.4-3.4l5-5a1.7 1.7 0 012.4 2.4l-4.6 4.6a.85.85 0 01-1.2-1.2l4.2-4.2" />
  ),
  folderOpen: (
    <>
      <path d="M2 4.5h4l1.3 1.7h5.7v1.6" />
      <path d="M2 13V4.5" />
      <path d="M2 13l2.2-5.2H15L12.8 13H2z" />
    </>
  ),
  image: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.3" />
      <circle cx="5.6" cy="6.4" r="1.1" />
      <path d="M2.6 11.6l3.4-3.4 2.6 2.6 2-2 2.8 2.8" />
    </>
  ),
  mail: (
    <>
      <rect x="1.6" y="3.6" width="12.8" height="8.8" rx="1.3" />
      <path d="M2.2 4.6L8 8.9l5.8-4.3" />
    </>
  ),
  mailbox: (
    <>
      <path d="M2 8.4a3.5 3.5 0 017 0v4.4H2V8.4z" />
      <path d="M9 12.8V8.4a3.5 3.5 0 017 0v4.4" />
      <path d="M2 6.4V2.6h5.4v2.6" />
    </>
  ),

  search: (
    <>
      <circle cx="6.9" cy="6.9" r="4.3" />
      <path d="M10 10l3.6 3.6" />
    </>
  ),
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.4v1.8M8 12.8v1.8M1.4 8h1.8M12.8 8h1.8" />
      <path d="M3.4 3.4l1.2 1.2M11.4 11.4l1.2 1.2M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2" />
    </>
  ),
  moon: <path d="M13.2 9.7A5.6 5.6 0 016.3 2.8a5.6 5.6 0 106.9 6.9z" />,
  autoTheme: (
    <>
      <circle cx="8" cy="8" r="5.4" />
      <path d="M8 2.6a5.4 5.4 0 010 10.8z" fill="currentColor" stroke="none" />
    </>
  ),
  chevronDown: <path d="M4.6 6.6L8 10l3.4-3.4" />,
  star: <path d="M8.00 1.80 L9.53 5.90 L13.90 6.08 L10.47 8.80 L11.64 13.02 L8.00 10.60 L4.36 13.02 L5.53 8.80 L2.10 6.08 L6.47 5.90 Z" fill="currentColor" strokeWidth={1} />,
  check: <path d="M3 8.6l3.2 3.2L13 4.9" />,
  close: <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" />,
  warning: (
    <>
      <path d="M8 2.4l6.2 10.8H1.8L8 2.4z" />
      <path d="M8 6.4v3.4" />
      <circle cx="8" cy="11.5" r="0.75" fill="currentColor" stroke="none" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 7.3v3.6" />
      <circle cx="8" cy="5.2" r="0.75" fill="currentColor" stroke="none" />
    </>
  ),
  uninstall: (
    <>
      <path d="M2.4 5.2h11.2v8.2H2.4z" />
      <path d="M2.4 5.2L4 2.6h8l1.6 2.6" />
      <path d="M6.1 8.6l3.8 3.8M9.9 8.6l-3.8 3.8" />
    </>
  ),
  database: (
    <>
      <ellipse cx="8" cy="4.2" rx="5.4" ry="2" />
      <path d="M2.6 4.2v7.6c0 1.1 2.4 2 5.4 2s5.4-.9 5.4-2V4.2" />
      <path d="M2.6 8c0 1.1 2.4 2 5.4 2s5.4-.9 5.4-2" />
    </>
  ),
  account: (
    <>
      <circle cx="8" cy="5.8" r="2.6" />
      <path d="M2.8 13.6a5.4 5.4 0 0110.4 0" />
    </>
  )
}

interface Props {
  name: IconName
  /** 边长（像素），默认 16 */
  size?: number
  className?: string
  style?: CSSProperties
  /** 无障碍标签；给了就会加上 role="img" */
  title?: string
}

export default function Icon({ name, size = 16, className, style, title }: Props): JSX.Element {
  return (
    <svg
      className={className ? `icon-svg ${className}` : 'icon-svg'}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: '0 0 auto', verticalAlign: '-0.15em', ...style }}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  )
}
