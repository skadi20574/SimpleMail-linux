#!/bin/bash
# SimpleMail 一键构建脚本
#
#   ./scripts/build.sh              # 构建 + 自检 + 打包 deb / AppImage / tar.gz
#   ./scripts/build.sh --no-test    # 跳过自检（快一些）
#   ./scripts/build.sh --only deb   # 只出 deb
#
# 中国大陆网络下，Electron 与 electron-builder 的二进制默认从 GitHub 下载，
# 常常很慢甚至失败。脚本默认走 npmmirror 镜像；如果你的网络能直连 GitHub，
# 设置 USE_MIRROR=0 即可关闭。

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

USE_MIRROR="${USE_MIRROR:-1}"
RUN_TEST=1
TARGETS="deb AppImage tar.gz"

while [ $# -gt 0 ]; do
  case "$1" in
    --no-test) RUN_TEST=0 ;;
    --only) shift; TARGETS="$1" ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *) echo "未知参数：$1"; exit 1 ;;
  esac
  shift
done

if [ "$USE_MIRROR" = "1" ]; then
  export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://registry.npmmirror.com/-/binary/electron/}"
  export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://registry.npmmirror.com/-/binary/electron-builder-binaries/}"
  echo "› 使用国内镜像下载 Electron 与打包工具"
fi

echo "› 检查工具链…"
for tool in node npm; do
  command -v "$tool" >/dev/null 2>&1 || { echo "缺少 $tool，请先安装 Node.js 20+"; exit 1; }
done
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 版本过低（$NODE_MAJOR），请升级到 20 或更高"
  exit 1
fi
echo "  Node $(node -v) / npm $(npm -v)"

if [ ! -d node_modules ]; then
  echo "› 安装依赖…"
  npm install --no-audit --no-fund
fi

echo "› 生成应用图标…"
npm run icon

echo "› 类型检查…"
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json

echo "› 编译主进程 / preload / 渲染进程…"
npm run build

if [ "$RUN_TEST" = "1" ]; then
  echo "› 运行端到端自检（构造 4 种存档做导入导出闭环）…"
  npm run selftest
  echo "› 运行启动器自检…"
  # 启动器是打包时生成的，这里先打包一次再说；若还没打包则跳过
  if [ -f release/linux-unpacked/simplemail ]; then
    npm run test:launcher
  else
    echo "  （首次构建，启动器自检将在打包后自动执行）"
  fi
fi

echo "› 打包：$TARGETS"
# shellcheck disable=SC2086
npx electron-builder --linux $TARGETS

if [ "$RUN_TEST" = "1" ] && [ -f release/linux-unpacked/simplemail ]; then
  echo "› 打包后再次运行启动器自检…"
  npm run test:launcher
  echo "› 校验 .deb 产物（桌面启动项 / 命令入口 / 图标 / 依赖）…"
  npm run test:package
fi

echo
echo "════════════════════════════════════════════"
echo " 构建完成，产物在 $ROOT/release/"
ls -lh release/*.deb release/*.AppImage release/*.tar.gz 2>/dev/null || true
echo
echo " 安装 / 运行方式见 docs/INSTALL.md"
echo "════════════════════════════════════════════"
