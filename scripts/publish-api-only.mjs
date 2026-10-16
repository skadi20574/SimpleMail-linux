#!/usr/bin/env node
/**
 * 只用 GitHub API 发布：建标签、建 Release、上传安装包。
 *
 * 为什么需要它：`git push` 走的是 github.com:443 的 git 端点，而 API 走的是
 * api.github.com —— 两者在受限网络下**可用性不一样**。本机就反复出现过
 * 「main 推上去了、推标签时连接中断」，或者 git 端点整体不通、而 API 正常的情况。
 *
 * 这个脚本不碰 git 传输：用本地已有的 commit 与标签信息，直接调 API 建出
 * 远端标签（annotated tag 对象 + ref），再建 Release 并传附件。
 *
 * 用法：
 *   GITHUB_TOKEN=xxx node scripts/publish-api-only.mjs
 */

import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request } from 'node:https'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const tag = `v${version}`

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
if (!token) {
  console.error('❌ 需要 GITHUB_TOKEN / GH_TOKEN')
  process.exit(2)
}

const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

const remoteUrl = git(['remote', 'get-url', process.env.SIMPLEMAIL_REMOTE || 'origin'])
const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remoteUrl)
if (!m) {
  console.error(`❌ 无法从 remote 解析 owner/repo：${remoteUrl}`)
  process.exit(2)
}
const [, owner, repo] = m

const headers = {
  'User-Agent': 'SimpleMail-publish',
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28'
}

function api(method, path, payload, host = 'api.github.com') {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : null
    const req = request(
      {
        host,
        path,
        method,
        headers: {
          ...headers,
          ...(body
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            : {})
        }
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = JSON.parse(text)
          } catch {
            /* 可能是空响应 */
          }
          resolve({ status: res.statusCode ?? 0, json, text })
        })
      }
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function uploadAsset(releaseId, filePath) {
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

async function main() {
  console.log(`目标：${owner}/${repo}   版本：${version}   标签：${tag}`)

  // 本地必须已经有这个标签，且指向要发布的提交
  const commitSha = git(['rev-list', '-n', '1', tag])
  const tagMessage = (() => {
    try {
      return git(['tag', '-l', '--format=%(contents:subject)', tag]) || `SimpleMail ${version}`
    } catch {
      return `SimpleMail ${version}`
    }
  })()
  console.log(`提交：${commitSha.slice(0, 7)}`)

  // ① 远端标签
  const existingRef = await api('GET', `/repos/${owner}/${repo}/git/ref/tags/${tag}`)
  if (existingRef.status === 200) {
    console.log(`标签 ${tag} 已存在于远端，跳过`)
  } else {
    // annotated tag 对象 + ref，与 `git push --tags` 的效果一致
    const tagObj = await api('POST', `/repos/${owner}/${repo}/git/tags`, {
      tag,
      message: tagMessage,
      object: commitSha,
      type: 'commit'
    })
    if (tagObj.status >= 300) {
      throw new Error(`创建标签对象失败（HTTP ${tagObj.status}）：${tagObj.text.slice(0, 300)}`)
    }
    const ref = await api('POST', `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/tags/${tag}`,
      sha: tagObj.json.sha
    })
    if (ref.status >= 300) {
      throw new Error(`创建标签 ref 失败（HTTP ${ref.status}）：${ref.text.slice(0, 300)}`)
    }
    console.log(`✅ 远端标签 ${tag} 已创建`)
  }

  // ② Release
  let release = (await api('GET', `/repos/${owner}/${repo}/releases/tags/${tag}`)).json
  if (release?.id) {
    console.log(`Release ${tag} 已存在（id=${release.id}），复用`)
  } else {
    const notesPath = join(root, 'release-notes.md')
    const body = existsSync(notesPath)
      ? readFileSync(notesPath, 'utf8')
      : `SimpleMail ${version}`
    const created = await api('POST', `/repos/${owner}/${repo}/releases`, {
      tag_name: tag,
      name: `SimpleMail ${version}`,
      body,
      draft: false,
      prerelease: false
    })
    if (created.status >= 300) {
      throw new Error(`创建 Release 失败（HTTP ${created.status}）：${created.text.slice(0, 400)}`)
    }
    release = created.json
    console.log(`✅ Release 创建成功（id=${release.id}）`)
  }

  // ③ 附件
  const candidates = [
    join(root, 'release', `SimpleMail_${version}_amd64.deb`),
    join(root, 'release', `SimpleMail-${version}-x86_64.AppImage`),
    join(root, 'release', `simplemail-${version}.tar.gz`)
  ].filter(existsSync)

  if (!candidates.length) {
    console.warn('\n⚠️ release/ 下没找到安装包，跳过附件上传')
  }
  const have = new Set((release.assets ?? []).map((a) => a.name))
  for (const file of candidates) {
    if (have.has(basename(file))) {
      console.log(`\n附件 ${basename(file)} 已存在，跳过`)
      continue
    }
    await uploadAsset(release.id, file)
  }

  console.log(`\n✅ 全部完成：https://github.com/${owner}/${repo}/releases/tag/${tag}`)
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`)
  process.exit(1)
})
