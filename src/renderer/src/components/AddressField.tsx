/**
 * 收件人 / 抄送 / 密送输入框：地址做成一个个标签（chip），带地址簿联想。
 *
 * 为什么要改成标签而不是一行逗号分隔的文本：
 *   · 一行文本里想删中间某个地址，得精确选中那几个字符再删 —— 很容易删错；
 *   · 想改其中一个地址，得在一长串里先找到它。
 * 现在每个地址是一个标签，标签上有 × 直接删；点标签文字可以拿回输入框里改。
 *
 * 对外契约没变：value 仍然是「逗号分隔的地址串」，上层 payload 逻辑一行不用改。
 *
 * ⚠️ onChange 在**每次输入**时都会触发，把「已确认的标签 + 输入框里正在敲的那段」
 * 一起吐给上层，而不是等到回车/失焦才吐。原因：
 *   Ctrl+Enter 直接发送是挂在 window 上的捕获监听，它会在输入框的 keydown
 *   之前就跑完 —— 如果「正在敲的那一段」还没同步出去，这封信就会少一个收件人，
 *   而且没有任何提示。宁可把没敲完的地址也带上（发送时会自然报错），
 *   也不能静默地少发一个人。
 */

import { useEffect, useRef, useState } from 'react'
import { api, type Contact } from '../api'
import { addressOf, splitAddressList } from '@shared/address'
import Icon from './Icon'

interface Props {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  /** 无障碍/测试用的类名，例如 to / cc / bcc */
  name: string
}

/** 标签上显示的文字：有显示名就只显示名字，鼠标悬停能看到完整地址 */
function chipLabel(part: string): string {
  const m = /^(.*?)<([^>]+)>$/.exec(part.trim())
  if (m && m[1].trim()) return m[1].trim().replace(/^["']|["']$/g, '')
  return addressOf(part) || part
}

export default function AddressField(props: Props): JSX.Element {
  const [chips, setChips] = useState<string[]>(() => splitAddressList(props.value))
  const [draft, setDraft] = useState('')
  const [suggestions, setSuggestions] = useState<Contact[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const seqRef = useRef(0)
  /** 最近一次「我们自己」吐出去的串：用来区分外部改动与自己的回声 */
  const emittedRef = useRef(props.value)

  // 外部改了 value（打开草稿、点回复、切换账户…）→ 重新切成标签
  useEffect(() => {
    if (props.value === emittedRef.current) return
    emittedRef.current = props.value
    setChips(splitAddressList(props.value))
    setDraft('')
  }, [props.value])

  /** 标签 + 正在输入的那一段 → 一行地址串（上层看到的就是屏幕上这些） */
  const serialize = (next: string[], draftText: string): string =>
    [...next, draftText.trim()].filter(Boolean).join(', ')

  const emit = (next: string[], draftText: string): void => {
    const joined = serialize(next, draftText)
    emittedRef.current = joined
    props.onChange(joined)
  }

  /** 把输入框里的文字（可能一次粘进来好几个地址）变成标签 */
  const commitDraft = (raw?: string): void => {
    const text = (raw ?? draft).trim()
    if (!text) return
    const parts = splitAddressList(text)
    const next = [...chips]
    for (const p of parts) {
      const t = p.trim()
      if (!t) continue
      // 同一个地址不重复加（大小写无关）
      const addr = addressOf(t)
      if (addr && next.some((c) => addressOf(c) === addr)) continue
      next.push(t)
    }
    setChips(next)
    setDraft('')
    emit(next, '')
  }

  const removeChip = (index: number): void => {
    const next = chips.filter((_, i) => i !== index)
    setChips(next)
    emit(next, draft)
    inputRef.current?.focus()
  }

  /** 点标签文字：把它拿回输入框继续编辑 */
  const editChip = (index: number): void => {
    const part = chips[index]
    if (!part) return
    const next = chips.filter((_, i) => i !== index)
    setChips(next)
    emit(next, part)
    setDraft(part)
    setOpen(true)
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }

  // 联想：只查正在输入的这一段
  const query = draft.trim()
  useEffect(() => {
    if (!open) return
    const seq = ++seqRef.current
    const t = window.setTimeout(() => {
      void api.contacts
        .list(query)
        .then((list) => {
          // 只接受最后一次查询的结果，防止慢请求覆盖新结果
          if (seq !== seqRef.current) return
          const taken = new Set(chips.map((c) => addressOf(c)))
          setSuggestions(list.filter((c) => !taken.has(c.email.toLowerCase())).slice(0, 8))
          setActive(0)
        })
        .catch(() => setSuggestions([]))
    }, 120)
    return () => window.clearTimeout(t)
  }, [query, open, chips])

  // 点别处收起联想
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
    const next = [...chips]
    if (!next.some((x) => addressOf(x) === c.email.toLowerCase())) next.push(label)
    setChips(next)
    setDraft('')
    emit(next, '')
    setOpen(false)
    setSuggestions([])
    inputRef.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    // 联想候选项的方向键 / 回车优先
    if (open && suggestions.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((i) => (i + 1) % suggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => (i - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const target = suggestions[active]
        if (target) {
          e.preventDefault()
          pick(target)
          return
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        return
      }
    }

    // Ctrl+Enter = 发送：先把正在输入的地址落成标签，
    // 否则这封信会漏掉最后一个收件人（不拦事件，让发送继续）
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      commitDraft()
      return
    }

    if (e.key === 'Enter' || e.key === ',' || e.key === ';' || e.key === '；' || e.key === '，') {
      // 逗号 / 分号 / 回车：确认这一个地址
      if (draft.trim()) {
        e.preventDefault()
        commitDraft()
      }
      return
    }

    if (e.key === 'Backspace' && !draft && chips.length) {
      // 输入框空了按退格 → 删掉最后一个标签（邮件客户端都这么干）
      e.preventDefault()
      removeChip(chips.length - 1)
      return
    }

    if (e.key === 'ArrowLeft' && !draft && chips.length) {
      // 光标空着按左键 → 把最后一个标签拿回来改
      e.preventDefault()
      editChip(chips.length - 1)
    }
  }

  return (
    <div className={`addrfield addrfield-${props.name}`} ref={boxRef}>
      <div
        className="addrchips"
        onClick={(e) => {
          // 点空白处把焦点给输入框
          if (e.target === e.currentTarget) inputRef.current?.focus()
        }}
      >
        {chips.map((chip, i) => (
          <span className="addrchip" key={`${chip}-${i}`} title={chip}>
            <button
              type="button"
              className="addrchip-label"
              title={`点击编辑：${chip}`}
              onClick={() => editChip(i)}
            >
              {chipLabel(chip)}
            </button>
            <button
              type="button"
              className="addrchip-x"
              title="移除这个收件人"
              onClick={() => removeChip(i)}
            >
              <Icon name="close" size={9} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className={`addr-${props.name}`}
          value={draft}
          placeholder={chips.length ? '' : props.placeholder}
          onChange={(e) => {
            // 每次输入都同步给上层：Ctrl+Enter 才不会漏掉正在敲的地址
            setDraft(e.target.value)
            emit(chips, e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // 焦点走了就把正在输入的地址落下来，别让它停在「看着填了其实没算」的状态
            commitDraft()
            setOpen(false)
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            // 粘一整串地址进来（比如从别处复制的收件人行）：直接切成标签
            const text = e.clipboardData.getData('text/plain')
            if (!text) return
            if (!/[,;，；]/.test(text) && !/<\S+@\S+>/.test(text)) return
            e.preventDefault()
            commitDraft(`${draft ? `${draft} ` : ''}${text}`)
          }}
        />
      </div>
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
