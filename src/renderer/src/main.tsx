import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import MailWindow from './MailWindow'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('找不到 #root 挂载点')

/**
 * 同一个渲染层入口服务两种窗口：
 *   · 主窗口 —— 三栏界面；
 *   · 邮件窗口 —— 双击邮件开出来的独立读信窗口（URL 上带 ?mailWindow=<id>）。
 */
const mailWindowId = new URLSearchParams(window.location.search).get('mailWindow')
const mailId = mailWindowId ? Number(mailWindowId) : NaN

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    {Number.isFinite(mailId) && mailId > 0 ? <MailWindow mailId={mailId} /> : <App />}
  </React.StrictMode>
)
