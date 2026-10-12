import { useEffect, useRef, useState } from 'react'
import Icon from './Icon'

/**
 * 通用输入对话框。
 *
 * 为什么不用 window.prompt()：**Electron 根本没有实现它**，调用会直接返回 null，
 * 表现成「点了按钮没反应」。清除数据那个 bug 就是这么来的，所以这里一律自己画。
 */
export interface InputDialogProps {
  title: string
  label: string
  defaultValue?: string
  placeholder?: string
  hint?: string
  confirmText?: string
  /** 返回错误信息表示校验不通过，对话框保持打开 */
  onConfirm: (value: string) => void
  onCancel: () => void
}

export function InputDialog(props: InputDialogProps): JSX.Element {
  const [value, setValue] = useState(props.defaultValue ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const confirm = (): void => {
    if (!value.trim()) return
    props.onConfirm(value.trim())
  }

  return (
    <div className="overlay">
      <div className="dialog" style={{ width: 440 }}>
        <div className="dialog-head">
          <span>{props.title}</span>
          <span className="spacer" />
          <button className="iconbtn" onClick={props.onCancel} title="关闭">
            <Icon name="close" size={12} />
          </button>
        </div>
        <div className="dialog-body">
          <div className="field">
            <label>{props.label}</label>
            <input
              ref={inputRef}
              type="text"
              value={value}
              placeholder={props.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirm()
                if (e.key === 'Escape') props.onCancel()
              }}
            />
            {props.hint && <div className="hint" style={{ marginTop: 5 }}>{props.hint}</div>}
          </div>
        </div>
        <div className="dialog-foot">
          <button className="btn" onClick={props.onCancel}>
            取消
          </button>
          <button className="btn primary" disabled={!value.trim()} onClick={confirm}>
            {props.confirmText ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  )
}

export interface ChoiceDialogProps {
  title: string
  message: React.ReactNode
  choices: {
    label: string
    /** 次要按钮用普通样式，破坏性操作用 danger */
    kind?: 'normal' | 'primary' | 'danger'
    value: string
  }[]
  onChoose: (value: string) => void
  onCancel: () => void
}

/**
 * 通用选择对话框（多条出路时用，比如「删除文件夹时里面的邮件怎么办」）。
 * 同样是为了避开 Electron 不支持的 prompt()。
 */
export function ChoiceDialog(props: ChoiceDialogProps): JSX.Element {
  return (
    <div className="overlay">
      <div className="dialog" style={{ width: 480 }}>
        <div className="dialog-head">
          <span>{props.title}</span>
          <span className="spacer" />
          <button className="iconbtn" onClick={props.onCancel} title="关闭">
            <Icon name="close" size={12} />
          </button>
        </div>
        <div className="dialog-body">
          <div className="hint" style={{ lineHeight: 1.8 }}>
            {props.message}
          </div>
        </div>
        <div className="dialog-foot">
          <button className="btn" onClick={props.onCancel}>
            取消
          </button>
          {props.choices.map((c) => (
            <button
              key={c.value}
              className={`btn${c.kind === 'primary' ? ' primary' : c.kind === 'danger' ? ' danger' : ''}`}
              onClick={() => props.onChoose(c.value)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
