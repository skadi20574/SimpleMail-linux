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
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } = require('node:fs')
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

function injectIntoDeb(debPath, metainfoXml) {
  const work = mkdtempSync(join(tmpdir(), 'simplemail-deb-'))
  const root = join(work, 'root')
  mkdirSync(root, { recursive: true })

  try {
    execFileSync('dpkg-deb', ['-R', debPath, root], { stdio: 'inherit' })
    // 保留原包的压缩方式（-R 会把 control 里的字段带出来，但压缩参数要显式指定）

    const metaDir = join(root, 'usr', 'share', 'metainfo')
    mkdirSync(metaDir, { recursive: true })
    writeFileSync(join(metaDir, 'simplemail.metainfo.xml'), metainfoXml, 'utf8')

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

module.exports = async function afterAllArtifactBuild(buildResult) {
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
    console.log(`[afterAllArtifactBuild] 注入 AppStream 元数据：${deb}`)
    injectIntoDeb(deb, metainfoXml)
  }
  return []
}
