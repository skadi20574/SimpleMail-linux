# 声明 / Notices

本文件不属于 MIT 许可条款的一部分，仅用于说明知识产权归属与第三方组件。
代码的使用条件见 [LICENSE](LICENSE)。

## 第三方商标说明 / Third-party trademark notice

本项目（SimpleMail）为**独立实现**，未使用 Foxmail、Microsoft Outlook 或其他商业邮件
客户端的商标、图标、界面素材或任何专有代码，与上述厂商无从属或背书关系。

对 Foxmail 邮件存档格式的兼容，是通过公开技术资料以及对**用户自有数据文件**的兼容性
分析实现的，目的是让用户能够读取和迁移自己的历史邮件。相关格式名称仅用于说明兼容性，
不主张任何权利。

界面与应用图标均为原创：应用图标由 `scripts/make-icon.mjs` 以代码绘制，界面图标是
`src/renderer/src/components/Icon.tsx` 中的线条 SVG，均以 MIT 许可开源。

## 第三方开源组件 / Third-party components

本项目基于以下开源组件构建，各自遵循其原始许可证：

| 组件 | 许可证 | 用途 |
| --- | --- | --- |
| [Electron](https://github.com/electron/electron) | MIT | 桌面运行时（同时提供 Node.js 与 SQLite） |
| [React](https://github.com/facebook/react) | MIT | 界面渲染 |
| [imapflow](https://github.com/postalsys/imapflow) | MIT | IMAP 收信与邮箱操作 |
| [nodemailer](https://github.com/nodemailer/nodemailer) | MIT | SMTP 发信 |
| [mailparser](https://github.com/nodemailer/mailparser) | MIT | MIME 解析 |
| [iconv-lite](https://github.com/ashtuchkin/iconv-lite) | MIT | GB18030 / GBK 等旧编码解码 |
| [SQLite](https://sqlite.org/) | Public Domain | 本地存储与 FTS5 全文检索（由 Electron 内置的 Node.js 提供） |

开发期依赖（TypeScript、Vite、electron-vite、electron-builder 等）同样为 MIT 或
Apache-2.0 许可，不随发行包分发其源码。
