#!/usr/bin/env node
/**
 * 开发用：播种演示数据 → 启动真实应用 → 截图。
 *
 * 用途是在没有 gnome-screenshot / scrot 之类的环境里，仍然能验证
 * 三栏布局、中文界面、附件与存档标签是不是真的显示正确。
 *
 * 运行：npm run screenshot
 */

import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..')
const electronBin = join(projectRoot, 'node_modules', 'electron', 'dist', 'electron')

if (!existsSync(electronBin)) {
  console.error('找不到 Electron，请先 npm install')
  process.exit(2)
}

const dataDir = join(tmpdir(), 'simplemail-demo-data')
const shotPath = join(projectRoot, 'release', 'screenshot.png')

rmSync(dataDir, { recursive: true, force: true })
mkdirSync(dataDir, { recursive: true })
mkdirSync(join(projectRoot, 'release'), { recursive: true })

const alias = { '@shared': join(projectRoot, 'src', 'shared') }

async function bundle(entry, outfile) {
  await build({
    entryPoints: [join(projectRoot, entry)],
    outfile: join(projectRoot, outfile),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
    alias,
    logLevel: 'warning'
  })
}

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(electronBin, args, {
      stdio: 'inherit',
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...env }
    })
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

console.log('› 打包演示数据种子…')
await bundle('src/main/demo.ts', 'out/dev/demo.cjs')

console.log('› 播种演示数据…')
const seedCode = await run(['--no-sandbox', 'out/dev/demo.cjs', `--user-data-dir=${dataDir}`])
if (seedCode !== 0) {
  console.error('播种失败')
  process.exit(seedCode)
}

if (!existsSync(join(dataDir, 'simplemail.db'))) {
  console.error(
    `数据库没有写到 --user-data-dir 指定的位置。\n实际目录内容：请检查 Electron 是否支持该开关。`
  )
  process.exit(3)
}

console.log('› 启动应用并截图…')
const shotCode = await run(['--no-sandbox', '--ozone-platform=x11', 'out/main/index.js', `--user-data-dir=${dataDir}`], {
  SIMPLEMAIL_SHOT: shotPath,
  SIMPLEMAIL_SHOT_DELAY: '4000'
})

if (existsSync(shotPath)) {
  console.log(`\n✅ 截图已生成：${shotPath}`)
  console.log(`   演示数据目录：${dataDir}`)
  console.log(`   想手动体验：${electronBin} out/main/index.js --user-data-dir=${dataDir}`)
} else {
  console.error('截图未生成')
  process.exit(shotCode === 0 ? 4 : shotCode)
}
