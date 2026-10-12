/**
 * electron-builder afterPack 钩子：给可执行文件套一层 shell 启动器。
 *
 * 为什么必须用 shell 而不是在主进程里判断：
 *   Chromium 在主脚本执行**之前**就完成了沙箱检查。主进程里再调用
 *   app.commandLine.appendSwitch('no-sandbox') 已经太晚，进程会直接 abort
 *   （setuid_sandbox_host.cc:166 或 zygote_host_impl_linux.cc:132）。
 *   唯一来得及的地方就是命令行本身，而 shell 包装器正好能在 exec 之前决定参数。
 *
 * 做法：
 *   simplemail      -> 原来的 Electron 可执行文件改名为 simplemail.bin
 *   simplemail      -> 新写入的 /bin/sh 启动器
 *
 * 启动器的判断逻辑：
 *   · chrome-sandbox 属于 root 且带 setuid 位（.deb 安装后脚本设置过）
 *     → 直接运行，沙箱真正开启；
 *   · 否则（AppImage 的 FUSE 只读挂载、tar.gz 解压出来属于普通用户）
 *     → 补上 --no-sandbox，保证「拷过去就能跑」。
 *
 * 三种分发形态（deb / AppImage / tar.gz）因此共用同一套逻辑，不需要各写一份。
 */

const { chmodSync, renameSync, statSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const LAUNCHER = `#!/bin/sh
# SimpleMail 启动器 —— 由构建脚本自动生成，请不要手动修改。
#
# 作用：根据 chrome-sandbox 的实际权限决定是否关闭 Chromium 沙箱。
# 详细原因见源码 src/main/index.ts 顶部关于「渲染进程沙箱」的注释。

HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HERE/simplemail.bin"

if [ ! -x "$BIN" ]; then
  echo "SimpleMail: 找不到可执行文件 $BIN" >&2
  exit 1
fi

# .deb 安装后 chrome-sandbox 会被设为 setuid root，这时沙箱是可用的
SANDBOX="$HERE/chrome-sandbox"
SANDBOX_OK=0
if [ -u "$SANDBOX" ] && [ -x "$SANDBOX" ]; then
  OWNER="$(stat -c '%u' "$SANDBOX" 2>/dev/null || echo x)"
  [ "$OWNER" = "0" ] && SANDBOX_OK=1
fi

if [ "$SANDBOX_OK" = "1" ]; then
  exec "$BIN" "$@"
fi

exec "$BIN" --no-sandbox --disable-gpu-sandbox "$@"
`

module.exports = async function afterPack(context) {
  const dir = context.appOutDir
  const realBin = join(dir, 'simplemail')
  const renamed = join(dir, 'simplemail.bin')

  try {
    const st = statSync(realBin)
    if (!st.isFile()) {
      console.log('[afterPack] 未找到可执行文件，跳过包装')
      return
    }
  } catch {
    console.log('[afterPack] 未找到可执行文件，跳过包装')
    return
  }

  renameSync(realBin, renamed)
  writeFileSync(join(dir, 'simplemail'), LAUNCHER, { mode: 0o755 })
  chmodSync(join(dir, 'simplemail'), 0o755)

  console.log('[afterPack] 已生成沙箱自适应启动器：simplemail -> simplemail.bin')
}
