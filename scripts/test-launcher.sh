#!/bin/bash
# 验证 afterPack 生成的启动器在两种沙箱情形下的行为。
#
# 之所以要单独测：构建机上没有 root，无法真的把 chrome-sandbox 变成
# setuid root，所以这里用 PATH 上的 stat 桩来模拟「属于 root 且带 setuid」，
# 确认启动器在这种情况下**不会**加 --no-sandbox（即 deb 安装后沙箱是真开着的）。

set -u

FAILED=0
pass() { echo "  ✅ $1"; }
fail() { echo "  ❌ $1"; FAILED=$((FAILED + 1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

LAUNCHER_DST="$WORK/pkg"
mkdir -p "$LAUNCHER_DST"

# 从构建产物里取启动器；没有就先提示去构建
if [ -f "release/linux-unpacked/simplemail" ]; then
  cp "release/linux-unpacked/simplemail" "$LAUNCHER_DST/simplemail"
else
  echo "找不到 release/linux-unpacked/simplemail，请先运行 npm run dist"
  exit 2
fi

# 用一个假的可执行文件替换真正的 Electron，把收到的参数打出来
cat > "$LAUNCHER_DST/simplemail.bin" <<'EOF'
#!/bin/sh
echo "ARGS: $*"
EOF
chmod +x "$LAUNCHER_DST/simplemail.bin" "$LAUNCHER_DST/simplemail"

# 造一个 chrome-sandbox（内容无所谓，只看权限）
: > "$LAUNCHER_DST/chrome-sandbox"
chmod 4755 "$LAUNCHER_DST/chrome-sandbox"

# PATH 桩：模拟 stat 报告「属主是 root」，以覆盖真实环境里无法构造的 setuid root 场景
STUB="$WORK/stub"
mkdir -p "$STUB"
cat > "$STUB/stat" <<'EOF'
#!/bin/sh
# 只处理 -c '%u' 这一种调用
if [ "$1" = "-c" ] && [ "$2" = "%u" ]; then
  echo 0
  exit 0
fi
exec /usr/bin/stat "$@"
EOF
chmod +x "$STUB/stat"

echo "=== 1. chrome-sandbox 属于 root 且带 setuid（模拟 .deb 安装后） ==="
OUT="$(cd "$LAUNCHER_DST" && PATH="$STUB:$PATH" ./simplemail --user-data-dir=/tmp/x 2>&1)"
echo "     $OUT"
case "$OUT" in
  *"--no-sandbox"*) fail "不该加 --no-sandbox（deb 场景沙箱应保持开启）" ;;
  *"ARGS: --user-data-dir=/tmp/x"*) pass "未加 --no-sandbox，参数原样透传，沙箱保持开启" ;;
  *) fail "输出不符合预期：$OUT" ;;
esac

echo "=== 2. chrome-sandbox 带 setuid 但属主不是 root（模拟解压出来的包） ==="
OUT="$(cd "$LAUNCHER_DST" && ./simplemail --user-data-dir=/tmp/x 2>&1)"
echo "     $OUT"
case "$OUT" in
  *"--no-sandbox"*) pass "自动补上 --no-sandbox" ;;
  *) fail "应当补上 --no-sandbox：$OUT" ;;
esac
case "$OUT" in
  *"ARGS: --no-sandbox --disable-gpu-sandbox --user-data-dir=/tmp/x"*)
    pass "用户参数拼接正确" ;;
  *) fail "参数拼接不正确：$OUT" ;;
esac

echo "=== 3. 完全没有 chrome-sandbox（AppImage 的 FUSE 挂载不会有 setuid） ==="
rm -f "$LAUNCHER_DST/chrome-sandbox"
OUT="$(cd "$LAUNCHER_DST" && ./simplemail 2>&1)"
echo "     $OUT"
case "$OUT" in
  *"--no-sandbox"*) pass "自动补上 --no-sandbox" ;;
  *) fail "应当补上 --no-sandbox：$OUT" ;;
esac

echo "=== 4. 缺少 simplemail.bin 时给出可读报错 ==="
rm -f "$LAUNCHER_DST/simplemail.bin"
OUT="$(cd "$LAUNCHER_DST" && ./simplemail 2>&1)"
CODE=$?
echo "     exit=$CODE  $OUT"
if [ "$CODE" -ne 0 ] && echo "$OUT" | grep -q "找不到可执行文件"; then
  pass "给出中文报错并非零退出"
else
  fail "报错信息不符合预期：$OUT"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "启动器自检全部通过"
  exit 0
fi
echo "启动器自检失败 $FAILED 项"
exit 1
