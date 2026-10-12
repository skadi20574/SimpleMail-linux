#!/usr/bin/env node
/**
 * 把仓库推送到 GitHub，并把安装包作为 Release 附件上传。
 *
 * 为什么安装包不直接进 git：
 *   GitHub 对单个文件有 100MB 的**硬上限**（超过直接拒绝推送），
 *   50MB 以上就会告警；而且二进制进版本库会让仓库永久膨胀、每次克隆都变慢。
 *   本项目三个产物分别是 78MB / 87MB / 108MB —— tar.gz 已经超限了。
 *   所以：**源码进 git，安装包进 Release 附件**（Release 单文件可到 2GB）。
 *
 * 用法：
 *   node scripts/publish-github.mjs             # 只推送分支和标签
 *   GITHUB_TOKEN=xxx node scripts/publish-github.mjs --release   # 再建 Release 并上传安装包
 *
 * 需要的权限（fine-grained token）：
 *   Contents: Read and write  —— 推送代码、创建 Release
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReadStream } from 'node:fs'
import { request } from 'node:https'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const withRelease = process.argv.includes('--release')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const tag = `v${version}`

/** 从 git remote 里解析出 owner/repo 和 URL */
function remoteInfo(name) {
  const out = execFileSync('git', ['remote', 'get-url', name], { cwd: root, encoding: 'utf8' }).trim()
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(out)
  if (!m) throw new Error(`无法从 remote ${name} 解析出 owner/repo：${out}`)
  return { url: out, owner: m[1], repo: m[2] }
}

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit' })
}

/** 用 Node 原生 https 发请求，避免依赖 curl（本机没有 curl） */
function apiRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = request(options, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          /* 非 JSON 响应 */
        }
        resolve({ status: res.statusCode ?? 0, json, text })
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function upsertRelease(owner, repo, token, payload) {
  const headers = {
    'User-Agent': 'SimpleMail-publish',
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  }

  // 已存在就先取回来（重复发布时不报错）
  const existing = await apiRequest({
    host: 'api.github.com',
    path: `/repos/${owner}/${repo}/releases/tags/${tag}`,
    method: 'GET',
    headers
  })
  if (existing.status === 200 && existing.json?.id) {
    console.log(`Release ${tag} 已存在，直接复用它（id=${existing.json.id}）`)
    return existing.json
  }

  const body = JSON.stringify(payload)
  const created = await apiRequest(
    {
      host: 'api.github.com',
      path: `/repos/${owner}/${repo}/releases`,
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    },
    body
  )
  if (created.status >= 300) {
    throw new Error(`创建 Release 失败（HTTP ${created.status}）：${created.text.slice(0, 400)}`)
  }
  console.log(`Release ${tag} 创建成功（id=${created.json.id}）`)
  return created.json
}

function uploadAsset(owner, repo, token, releaseId, filePath) {
  const name = basename(filePath)
  const size = statSync(filePath).size
  console.log(`\n上传 ${name}（${(size / 1024 / 1024).toFixed(1)} MB）…`)

  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: 'uploads.github.com',
        path: `/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
        method: 'POST',
        headers: {
          'User-Agent': 'SimpleMail-publish',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': size
        }
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if ((res.statusCode ?? 0) >= 300) {
            reject(new Error(`上传 ${name} 失败（HTTP ${res.statusCode}）：${text.slice(0, 300)}`))
          } else {
            console.log(`✅ ${name} 上传完成`)
            resolve()
          }
        })
      }
    )
    req.on('error', reject)
    createReadStream(filePath).pipe(req)
  })
}

function releaseNotes() {
  const notes = join(root, 'release-notes.md')
  if (existsSync(notes)) return readFileSync(notes, 'utf8')
  return [
    `SimpleMail ${version}`,
    '',
    '本地优先的开源 Linux 桌面邮件客户端。',
    '',
    '安装方式见 Release 附件中的 .deb（推荐）或 .tar.gz（免安装）。',
    '详细说明见仓库里的 docs/INSTALL.md。'
  ].join('\n')
}

async function main() {
  // ── 1. 推送代码与标签 ──
  const remoteName = process.env.SIMPLEMAIL_REMOTE || 'origin'
  const info = remoteInfo(remoteName)
  console.log(`目标仓库：${info.owner}/${info.repo}`)
  console.log(`remote：${info.url}`)

  run('git', ['push', '-u', remoteName, 'main'])
  run('git', ['push', remoteName, tag])

  if (!withRelease) {
    console.log('\n分支与标签已推送。')
    console.log('想同时发布安装包，请带 --release 并设置 GITHUB_TOKEN 重跑。')
    return
  }

  // ── 2. 创建 Release 并上传安装包 ──
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (!token) {
    console.error('\n❌ 没找到 GITHUB_TOKEN / GH_TOKEN 环境变量。')
    console.error('   安装包没法用 git 推送（单文件硬上限 100MB），需要走 Release API。')
    console.error('   也可以在网页上手动创建 Release 并把 release/ 里的文件拖进去。')
    process.exit(2)
  }

  const release = await upsertRelease(info.owner, info.repo, token, {
    tag_name: tag,
    name: `SimpleMail ${version}`,
    body: releaseNotes(),
    draft: false,
    prerelease: false
  })

  const candidates = [
    join(root, 'release', `SimpleMail_${version}_amd64.deb`),
    join(root, 'release', `SimpleMail-${version}-x86_64.AppImage`),
    join(root, 'release', `simplemail-${version}.tar.gz`)
  ].filter(existsSync)

  if (!candidates.length) {
    console.warn('\n⚠️ release/ 下没有找到安装包，跳过附件上传。')
    console.warn('   先跑 ./scripts/build.sh 生成它们。')
    return
  }

  for (const file of candidates) {
    await uploadAsset(info.owner, info.repo, token, release.id, file)
  }
  console.log(`\n✅ 全部完成：https://github.com/${info.owner}/${info.repo}/releases/tag/${tag}`)
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`)
  process.exit(1)
})
