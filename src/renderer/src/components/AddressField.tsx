/**
 * 收件人输入框 + 地址簿联想。
 *
 * 为什么要单独抽出来：收件人/抄送/密送三个框的行为完全一样，
 * 写成三份就会各自漂移。这里把「解析当前正在输入的那一段 → 查地址簿 →
 * 点选后拼回去」封装起来。
 */

import { useEffect, useRef, useState } from 'react'
import { api, type Contact } from '../api'
import Icon from './Icon'

interface Props {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  /** 无障碍/测试用的类名，例如 to / cc / bcc */
  name: string
}

/**
 * 取「最后一个逗号之后」那一段 —— 用户可能已经填了几个地址，
 * 联想只针对正在敲的那一个，不能把前面的也拿去查。
 */
function currentToken(value: string): { head: string; token: string } {
  const idx = Math.max(value.lastIndexOf(','), value.lastIndexOf(';'))
  if (idx === -1) return { head: '', token: value }
  return { head: value.slice(0, idx + 1), token: value.slice(idx + 1) }
}

/** 已经填进去的地址，联想时不再重复推荐 */
function takenEmails(value: string): Set<string> {
  const out = new Set<string>()
  for (const part of value.split(/[,;]/)) {
    const m = /<([^>]+)>/.exec(part)
    const addr = (m ? m[1] : part).trim().toLowerCase()
    if (addr.includes('@')) out.add(addr)
  }
  return out
}

export default function AddressField(props: Props): JSX.Element {
  const [suggestions, setSuggestions] = useState<Contact[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)
  const seqRef = useRef(0)

  const { head, token } = currentToken(props.value)
  const query = token.trim()

  // 输入变化就去查地址簿（防抖，避免每敲一个字查一次库）
  useEffect(() => {
    if (!open) return
    const seq = ++seqRef.current
    const t = window.setTimeout(() => {
      void api.contacts
        .list(query)
        .then((list) => {
          // 只接受最后一次查询的结果，防止慢请求覆盖新结果
          if (seq !== seqRef.current) return
          const taken = takenEmails(props.value)
          setSuggestions(list.filter((c) => !taken.has(c.email)).slice(0, 8))
          setActive(0)
        })
        .catch(() => setSuggestions([]))
    }, 120)
    return () => window.clearTimeout(t)
  }, [query, open, props.value])

  // 点别处收起
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const pick = (c: Contact): void => {
    const label = c.name ? `${c.name} <${c.email}>` : c.email
    // 已有内容时补一个逗号分隔
    const prefix = head ? `${head.replace(/\s*$/, '')} ` : ''
    props.onChange(`${prefix}${label}, `)
    setOpen(false)
    setSuggestions([])
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (!open || !suggestions.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % suggestions.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i - 1 + suggestions.length) % suggestions.length)
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      // 只在有高亮项时接管，否则让回车/制表正常走
      const target = suggestions[active]
      if (target) {
        e.preventDefault()
        pick(target)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div className="addrfield" ref={boxRef}>
      <input
        className={`addr-${props.name}`}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => {
          props.onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && suggestions.length > 0 && (
        <div className="addrsug" role="listbox">
          {suggestions.map((c, i) => (
            <button
              key={c.id}
              type="button"
              className={`addrsug-item${i === active ? ' active' : ''}`}
              // 用 mousedown 而不是 click：click 之前 input 会先失焦
              onMouseDown={(e) => {
                e.preventDefault()
                pick(c)
              }}
              title={c.email}
            >
              <Icon name="account" size={12} />
              <span className="nm">{c.name || c.email}</span>
              {c.name && <span className="em">{c.email}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
