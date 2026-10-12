#!/usr/bin/env node
/**
 * 运行端到端自检：
 *   1. 用 esbuild 把 src/main/selftest.ts 打成一个 CJS 包；
 *   2. 用 Electron 的主进程把它跑起来（不需要窗口、不需要网络）；
 *   3. 透传退出码。
 *
 * 自检会构造老版 .box/.ind、.fox 不透明容器、ZIP、.eml 目录、裸 GBK 老邮件、
 * 以及 zlib 压缩存档，然后跑完整的 识别 → 导入 → 中文全文搜索 → 导出 →
 * 再导入 闭环，用来证明「新老版本自动兼容」不是一句口号。
 */

import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..')
const outFile = join(projectRoot, 'out', 'dev', 'selftest.cjs')

mkdirSync(join(projectRoot, 'out', 'dev'), { recursive: true })

console.log('› 打包自检入口…')
await build({
  entryPoints: [join(projectRoot, 'src', 'main', 'selftest.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  external: ['electron'],
  alias: {
    '@shared': join(projectRoot, 'src', 'shared')
  },
  logLevel: 'warning'
})

const electronBin = join(projectRoot, 'node_modules', 'electron', 'dist', 'electron')
if (!existsSync(electronBin)) {
  console.error('找不到 Electron 可执行文件，请先运行 npm install')
  process.exit(2)
}

console.log('› 启动 Electron 执行自检…\n')
const child = spawn(electronBin, ['--no-sandbox', outFile], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', NODE_NO_WARNINGS: '1' }
})

child.on('exit', (code) => {
  process.exit(code ?? 1)
})
