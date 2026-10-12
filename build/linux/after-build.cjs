/**
 * electron-builder afterAllArtifactBuild 钩子。
 *
 * 干两件事，都是 electron-builder 本身不支持的：
 *
 * 1. **往 .deb 里塞 AppStream 元数据**（/usr/share/metainfo/simplemail.metainfo.xml）。
 *    不塞的话 GNOME 软件中心只能回退到 deb control 的 Description，
 *    而那条链路上非 ASCII 字符会变成「?」—— 双击安装包看到一串问号就是这个原因。
 *
 * 2. **把版本号与日期注入到元数据里**，免得 <releases> 手写之后忘记更新。
 *
 * 做法是把构建好的 deb 解包、加文件、再重新打包（dpkg-deb --root-owner-group
 * 保证属主是 root:root，和 fpm 打出来的一致）。
 */

const { execFileSync } = require('node:child_process')
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, chmodSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

/** 在 macOS / Windows 上构建时不做这些事 */
function isLinux() {
  return process.platform === 'linux'
}

function which(bin) {
  try {
    execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** 把版本号写进 <releases>，日期用给定的字符串（保持构建可复现） */
function renderMetainfo(template, version, date) {
  const releases = [
    '  <releases>',
    `    <release version="${version}" date="${date}"/>`,
    '  </releases>'
  ].join('\n')
  return template.replace('<!--RELEASES-->', releases)
}

/**
 * 把多行文本转成 DEP-5 的续行形式：每行前加一个空格，空行写成 " ."。
 * Debian 的 copyright 文件用这种格式承载整段许可证正文。
 */
function dep5Block(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\s+$/, '')
    .split('\n')
    .map((line) => (line.trim() === '' ? ' .' : ` ${line}`))
    .join('\n')
}

/**
 * 生成 /usr/share/doc/<pkg>/copyright（Debian 机器可读格式 DEP-5）。
 *
 * MIT 要求「版权声明与许可声明须包含在本软件的所有副本中」，而 .deb 就是一个副本，
 * 所以安装包里必须带上它 —— electron-builder 自己不会生成这个文件
 * （没有 copyright 的包在 lintian 下也会报 no-copyright-file）。
 *
 * 正文直接从 LICENSE 读出来拼接，避免许可证文本在这里出现第二份、以后改一处忘一处。
 */
function renderCopyright(licenseText, noticeText, version) {
  // 去掉 NOTICE.md 里的一级标题（在 copyright 里有 Comment: 这个字段名承担标题作用）
  const noticeBody = noticeText
    .split('\n')
    .filter((l) => !l.startsWith('# '))
    .join('\n')
    .replace(/^\s*\n+/, '')
    .trimEnd()

  // 注意：段落之间只能用空行分隔，而一个段落里**必须**有 Files 和 License。
  // 所以 Comment 要跟在 License 正文后面、中间不能插空行 —— 否则会被解析成
  // 一个没有 Files 字段的独立段落，lintian 直接报错。
  return [
    'Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/',
    'Upstream-Name: SimpleMail',
    'Source: https://github.com/skadi20574/SimpleMail-linux',
    '',
    'Files: *',
    'Copyright: 2026 skadi20574',
    'License: MIT',
    dep5Block(licenseText),
    'Comment:',
    dep5Block(`SimpleMail ${version}\n\n${noticeBody}`),
    ''
  ].join('\n')
}

function injectIntoDeb(debPath, { metainfoXml, copyright, licenseText, noticeText }) {
  const work = mkdtempSync(join(tmpdir(), 'simplemail-deb-'))
  const root = join(work, 'root')
  mkdirSync(root, { recursive: true })

  try {
    execFileSync('dpkg-deb', ['-R', debPath, root], { stdio: 'inherit' })
    // 保留原包的压缩方式（-R 会把 control 里的字段带出来，但压缩参数要显式指定）

    const metaDir = join(root, 'usr', 'share', 'metainfo')
    mkdirSync(metaDir, { recursive: true })
    writeFileSync(join(metaDir, 'simplemail.metainfo.xml'), metainfoXml, 'utf8')

    // 许可证正文必须随副本分发；放 /usr/share/doc/<pkg>/ 是 Debian 的惯例位置。
    // 目录名要跟包名一致（control 里的 Package 字段，小写）。注意 dpkg-deb -R
    // 出来的控制信息在 root/DEBIAN/control，不是 root/control。
    const controlText = readFileSync(join(root, 'DEBIAN', 'control'), 'utf8')
    const pkgName = /^Package:\s*(\S+)/m.exec(controlText)?.[1] ?? 'simplemail'
    const docDir = join(root, 'usr', 'share', 'doc', pkgName)
    mkdirSync(docDir, { recursive: true })
    writeFileSync(join(docDir, 'copyright'), copyright, 'utf8')
    writeFileSync(join(docDir, 'LICENSE'), licenseText, 'utf8')
    writeFileSync(join(docDir, 'NOTICE.md'), noticeText, 'utf8')

    // mkdtemp 建的目录受 umask 影响，写出来的文件是 664（同组可写）。
    // 系统目录里的文档惯例是 644；--root-owner-group 只管属主，不管权限位。
    for (const p of [
      join(metaDir, 'simplemail.metainfo.xml'),
      join(docDir, 'copyright'),
      join(docDir, 'LICENSE'),
      join(docDir, 'NOTICE.md')
    ]) {
      chmodSync(p, 0o644)
    }

    // --root-owner-group：把我们新加的文件也统一成 root:root
    //
    // -Zxz -z9 必须显式给：dpkg-deb 默认用 gzip，重打包会让安装包从 78MB 涨到 85MB。
    // electron-builder 用的是 compression: maximum（xz -9），这里必须对齐，
    // 否则「注入一个几 KB 的 XML」的代价是多出 7MB。
    execFileSync(
      'dpkg-deb',
      ['--root-owner-group', '-Zxz', '-z9', '-b', root, debPath],
      { stdio: 'inherit' }
    )
    return true
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * 用 appstreamcli 校验元数据。
 *
 * 只在**出现 error 级问题**时判定失败：警告（比如 id 没按 RDNS 命名）不影响
 * 软件中心正常展示，不该因此中止打包。appstreamcli 在有警告时也会返回非零，
 * 所以这里解析输出里的 "E:" 行，而不是只看退出码。
 */
function validateMetainfo(xmlPath) {
  if (!which('appstreamcli')) {
    console.log('[afterAllArtifactBuild] 没有 appstreamcli，跳过元数据校验')
    return true
  }
  let out = ''
  try {
    out = execFileSync('appstreamcli', ['validate', '--no-net', xmlPath], { encoding: 'utf8' })
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
  out = out.trim()
  if (out) console.log(out)

  const errors = out.split('\n').filter((l) => /^\s*E:/.test(l))
  if (errors.length) {
    console.error('[afterAllArtifactBuild] AppStream 元数据存在错误：')
    for (const e of errors) console.error(`  ${e}`)
    return false
  }
  console.log('[afterAllArtifactBuild] AppStream 元数据校验通过（无 error 级问题）')
  return true
}

async function afterAllArtifactBuild(buildResult) {
  if (!isLinux()) return []

  // electron-builder 以项目根目录为 cwd 调用这个钩子；outDir 只是个兜底
  const candidates = [process.cwd()]
  if (buildResult?.outDir) candidates.push(join(buildResult.outDir, '..'))
  const projectDir =
    candidates.find((d) => existsSync(join(d, 'package.json'))) ?? process.cwd()

  const templatePath = join(projectDir, 'build', 'linux', 'simplemail.metainfo.xml')
  if (!existsSync(templatePath)) {
    console.warn('[afterAllArtifactBuild] 找不到 metainfo 模板，跳过')
    return []
  }

  const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'))
  const version = pkg.version ?? '0.0.0'
  const date = new Date().toISOString().slice(0, 10)

  const metainfoXml = renderMetainfo(readFileSync(templatePath, 'utf8'), version, date)

  // 许可证声明：同样是从单一来源（LICENSE / NOTICE.md）读出来，不在这里另抄一份
  const licensePath = join(projectDir, 'LICENSE')
  const noticePath = join(projectDir, 'NOTICE.md')
  const licenseText = existsSync(licensePath) ? readFileSync(licensePath, 'utf8') : ''
  const noticeText = existsSync(noticePath) ? readFileSync(noticePath, 'utf8') : ''
  const copyright = renderCopyright(licenseText, noticeText, version)

  // 先校验模板（万一 appstreamcli 报错，能在打包阶段就发现）
  const tmpXml = join(tmpdir(), `simplemail-${version}.metainfo.xml`)
  writeFileSync(tmpXml, metainfoXml, 'utf8')
  const ok = validateMetainfo(tmpXml)
  rmSync(tmpXml, { force: true })
  if (!ok) {
    throw new Error('AppStream 元数据校验未通过，已中止构建')
  }

  const artifacts = buildResult?.artifactPaths ?? []
  const debs = artifacts.filter((p) => typeof p === 'string' && p.endsWith('.deb'))
  if (!debs.length) {
    console.log('[afterAllArtifactBuild] 本次没有生成 .deb，跳过元数据注入')
    return []
  }

  for (const deb of debs) {
    console.log(`[afterAllArtifactBuild] 注入 AppStream 元数据与许可证声明：${deb}`)
    injectIntoDeb(deb, { metainfoXml, copyright, licenseText, noticeText })
  }
  return []
}

module.exports = afterAllArtifactBuild
// 便于脚本里单测这几个纯函数（见 scripts/verify-package.sh）
module.exports.renderCopyright = renderCopyright
module.exports.dep5Block = dep5Block
module.exports.injectIntoDeb = injectIntoDeb
