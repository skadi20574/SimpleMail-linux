# SimpleMail 1.1.5

一个**本地优先（local-first）**的开源 Linux 桌面邮件客户端。界面与操作习惯参照 Foxmail，
但完全独立实现 —— 不使用任何商业软件的商标、图标、素材或代码。

核心特点：**所有邮件永久保存在你自己电脑上**，断网也能阅读和搜索；
并且能读你以前的 **Foxmail 存档**。

---

## 下载

| 文件 | 大小 | 适用 |
| --- | --- | --- |
| `SimpleMail_1.1.5_amd64.deb` | 78 MB | **推荐**。`sudo apt install ./SimpleMail_1.1.5_amd64.deb`，依赖自动处理，沙箱真正开启 |
| `simplemail-1.1.5.tar.gz` | 108 MB | 免安装。解压后 `./simplemail` 直接跑，不依赖 FUSE、不需要 root |
| `SimpleMail-1.1.5-x86_64.AppImage` | 87 MB | 单文件。Ubuntu 22.04+ 需先 `sudo apt install libfuse2`（24.04+ 是 `libfuse2t64`） |

适用 Ubuntu 22.04 / 24.04 / 26.04（其他 glibc ≥ 2.31 的发行版基本也可以）。

---

## 本版变更（1.1.5）

这是一个**只动许可与打包元数据的版本，没有任何功能改动**，邮件数据完全不受影响。

修掉两个查许可证识别问题时牵出来的缺陷：

- **`LICENSE` 现在能被正确识别为 MIT。** 之前文件末尾追加了一段商标说明，
  破坏了与标准 MIT 文本的逐字匹配 —— 法律上没问题（MIT 正文是完整的），
  但 GitHub 会把许可证显示成 `NOASSERTION`（未识别），企业里常见的自动化
  许可证扫描器（FOSSA / ScanCode / Snyk）会把它报成「未知许可证」。
  附加说明已移到独立的 [`NOTICE.md`](NOTICE.md)，`LICENSE` 保持逐字 MIT。
- **安装包开始携带许可声明。** 之前的 `.deb` / AppImage / `.tar.gz` 里**没有任何
  许可文本**，而 MIT 的条件之一正是「版权声明与许可声明须包含在本软件的所有副本中」
  —— 安装包就是副本。现在三种形态都会带上 `LICENSE` 与 `NOTICE.md`；
  `.deb` 另外在 `/usr/share/doc/simplemail/` 下提供 DEP-5（机器可读）格式的
  `copyright`，`lintian` 不再报 `no-copyright-file`。

顺带修正应用菜单分类：

- 生成的启动项之前是 `Categories=Network;`，配置里写的 `Email` 被
  electron-builder **静默丢弃**（它会在铺开 `desktop` 键值对之后用
  `linux.category` 覆盖掉 `desktop.Categories`）。现在改为 `Network;Email;`
  —— 应用菜单里会正确归到「邮件」，同时只有一个主分类，不会重复出现条目。

如果你把 1.1.4 的安装包再分发出去过，建议换成 1.1.5。

---

## 功能

- **收件**：IMAP 与 POP3，内置 QQ 邮箱、163、126、腾讯企业邮、新浪、Gmail、Outlook 预设
- **发信**：SMTP，支持附件
- **永久本地存储**：正文、头部、附件元数据都在本地 SQLite；附件单独落盘；程序不做任何自动清理
- **全文检索**：SQLite FTS5，可按发件人 / 收件人 / 主题 / 正文**分字段搜索**，结果按 bm25 相关度排序；中文逐字建索引，1~2 个字的短词也能命中
- **Foxmail 存档导入导出**：`.fox` 单文件、`.box + .ind` 目录、`Storage` 数据目录、zip 打包；GB 级存档走**流式导入**，峰值内存只与单封邮件有关
- **自动归类规则**：按发件人 / 收件人 / 主题 / 正文 / **自定义邮件头**匹配，自动归类或删除，带「试运行」预览
- **文件夹管理**：新建 / 新建子文件夹 / 重命名 / 删除，**拖拽归类**；IMAP 账户同步到服务器
- **多账户**：左侧按账户分组，每个账户独立签名与颜色
- **键盘快捷键**：可自定义，含多选（Ctrl/Shift）、Delete 进垃圾箱、Shift+Delete 永久删除
- **主题**：浅色 / 深色 / 跟随系统
- **软件内卸载**：检测安装方式，deb 版可通过系统授权对话框直接卸载

---

## 技术选型

**Electron 38 + TypeScript + React 18 + Vite**，数据库用 Electron 内置 Node 22 的
`node:sqlite`（编译时已启用 FTS5）。

因此这个项目**没有任何原生模块**：不需要 electron-rebuild、不需要 node-gyp、
安装包也不绑死构建机的 glibc —— 这正是它能在 22.04/24.04/26.04 上通吃的前提。

---

## 自检

```bash
npm test
```

覆盖 **213 项断言**，全部是可复现的自动化测试，不依赖任何真实邮箱账号：

- 构造 6 种真实形态的存档（老版 `.box`、不透明 `.fox`、ZIP、`.eml` 目录、裸 GBK 老邮件、zlib 压缩），跑「识别 → 导入 → 中文搜索 → 导出 → 再导入」闭环
- 本地 mock POP3 服务器：点填充还原、UIDL 增量、无 UIDL 退化、隐式 TLS、STLS 升级、删除提交语义
- 数据库逐版本迁移不丢邮件（v1 → v3）
- 大文件流式导入：把内存阈值压到 1KB 强制走流式，结果与内存路径**逐字节一致**
- 文件夹管理：路径拼接、重名拦截、重命名同步改路径、删除时邮件进垃圾箱 vs 永久删除
- 键盘快捷键解析与冲突检测
- 界面资源：样式类名存在且有尺寸、产物里没有调用 Electron 不支持的 `prompt()`

---

## 从旧版本升级

覆盖安装即可，**邮件不会丢**。数据库会自动逐版本迁移（补 POP3 字段、加规则表、
重建分字段全文索引）。

```bash
sudo apt install --reinstall ./SimpleMail_1.1.5_amd64.deb
```

---

## 许可证

MIT（见 [`LICENSE`](LICENSE)）。第三方组件与商标说明见 [`NOTICE.md`](NOTICE.md)。

三种安装形态都会随包分发这两份声明；`.deb` 还提供
`/usr/share/doc/simplemail/copyright`（DEP-5 机器可读格式）。
