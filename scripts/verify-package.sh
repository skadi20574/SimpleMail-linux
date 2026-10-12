#!/bin/bash
# .deb 打包产物校验
#
# 起因：曾经出现过两个只有装到真机上才会暴露的 bug ——
#   1. 自己写了 deb.afterInstall，把 electron-builder 默认 postinst 整个替换掉，
#      忘了补上 /usr/bin 下的命令入口 → 终端里 simplemail 提示 command not found；
#   2. linux.desktop 写成了嵌套的 `entry:`，生成一行非法的
#      `entry=[object Object]` → GNOME 直接忽略启动项，应用菜单里没有图标。
#
# 这两个问题在开发机上都不会有任何提示，所以这里做成一装完就能跑的自动校验。

set -uo pipefail

cd "$(dirname "$0")/.."

# 按 package.json 里的版本号挑包，**不要**用 `ls | head -1`。
#
# 曾经的写法 `ls -1 release/*.deb | head -1` 在 release/ 里同时存在 1.1.4 和 1.1.5
# 两个 deb 时，字典序会让它挑中 1.1.4 —— 于是校验通过的是旧包，
# 新包有没有问题反而看不出来。这种「校验了错的东西」比不校验更危险。
VERSION="$(node -p 'require("./package.json").version')"
DEB="release/SimpleMail_${VERSION}_amd64.deb"
if [ ! -f "$DEB" ]; then
  # 退一步：找同版本号的任意命名（arch 可能不是 amd64）
  DEB="$(ls -1 "release/SimpleMail_${VERSION}_"*.deb 2>/dev/null | head -1)"
fi
if [ -z "${DEB:-}" ] || [ ! -f "$DEB" ]; then
  echo "找不到版本为 $VERSION 的 .deb（release/ 里现有：）"
  ls -1 release/*.deb 2>/dev/null | sed 's/^/  /' || echo "  （没有 deb）"
  echo "请先运行 ./scripts/build.sh"
  exit 2
fi

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

PASSED=0
FAILED=0
ok()   { echo "  ✅ $1"; PASSED=$((PASSED + 1)); }
bad()  { echo "  ❌ $1"; FAILED=$((FAILED + 1)); }
note() { echo "     $1"; }

echo "校验目标：$DEB"

# ── 解包 ────────────────────────────────────────────────────────
dpkg-deb -x "$DEB" "$WORK/fs" 2>/dev/null
dpkg-deb -e "$DEB" "$WORK/DEBIAN" 2>/dev/null

DESKTOP="$WORK/fs/usr/share/applications/simplemail.desktop"
POSTINST="$WORK/DEBIAN/postinst"
POSTRM="$WORK/DEBIAN/postrm"
ICON="$WORK/fs/usr/share/icons/hicolor/512x512/apps/simplemail.png"

# ── 1. 桌面启动项 ───────────────────────────────────────────────
echo "1. 桌面启动项"
if [ -f "$DESKTOP" ]; then
  ok "存在 simplemail.desktop"

  if grep -q "object Object" "$DESKTOP"; then
    bad "desktop 文件里出现了 'object Object'（八成是 linux.desktop 写成了嵌套结构）"
  else
    ok "没有 'object Object' 这类序列化残留"
  fi

  if command -v desktop-file-validate >/dev/null 2>&1; then
    VOUT="$(desktop-file-validate "$DESKTOP" 2>&1)"
    if [ -z "$VOUT" ]; then
      ok "desktop-file-validate 通过（零错误零警告）"
    else
      if echo "$VOUT" | grep -q "^[^:]*: error:"; then
        bad "desktop-file-validate 报错："
        echo "$VOUT" | sed 's/^/       /'
      else
        ok "desktop-file-validate 无错误（有警告，见下）"
        echo "$VOUT" | sed 's/^/       /'
      fi
    fi
  else
    note "（系统没有 desktop-file-validate，跳过正式校验）"
  fi

  for key in "Type=Application" "Name=" "Exec=" "Icon=" "Categories="; do
    if grep -q "^${key}" "$DESKTOP"; then
      ok "含必需字段 ${key%%=*}"
    else
      bad "缺少必需字段 ${key%%=*}"
    fi
  done

  # Comment 必须是单行 —— 之前多行的 description 被塞进来过
  CMT_LINES="$(awk '/^Comment=/{n++} END{print n+0}' "$DESKTOP")"
  if [ "$CMT_LINES" -eq 1 ]; then
    ok "Comment 只有一行"
  else
    bad "Comment 出现了 $CMT_LINES 行（desktop 文件不允许续行值）"
  fi

  # 分类要真的落在「邮件」下，同时只能有一个主分类。
  #
  # 曾经踩过两件事：
  #   1. 分类写在 desktop.Categories 里，但 electron-builder 会在铺开 desktop
  #      键值对之后用 linux.category 覆盖它 —— 配置里写着 Network;Email;Office;，
  #      生成的却只有 Network;，而且**没有任何报错**。只检查「Categories= 存在」
  #      是抓不到这种静默丢失的。
  #   2. Network 和 Office 都是主分类，同时出现会让应用菜单里重复出现条目，
  #      desktop-file-validate 会给 hint。
  CATS="$(grep '^Categories=' "$DESKTOP" | head -1 | cut -d= -f2-)"
  for want in Network Email; do
    if echo "$CATS" | tr ';' '\n' | grep -qx "$want"; then
      ok "分类含 $want"
    else
      bad "分类缺少 $want（当前 Categories=$CATS）—— 八成是被 linux.category 覆盖了"
    fi
  done
  MAIN_CATS=0
  for main in AudioVideo Development Education Game Graphics Network Office Science Settings System Utility; do
    if echo "$CATS" | tr ';' '\n' | grep -qx "$main"; then
      MAIN_CATS=$((MAIN_CATS + 1))
    fi
  done
  if [ "$MAIN_CATS" -eq 1 ]; then
    ok "只有一个主分类（菜单里不会重复出现）"
  else
    bad "有 $MAIN_CATS 个主分类（Categories=$CATS）—— 应用菜单里会重复出现条目"
  fi
else
  bad "没有找到 simplemail.desktop"
fi

# ── 2. 命令入口（/usr/bin） ─────────────────────────────────────
echo "2. 终端命令入口"
if [ -f "$POSTINST" ]; then
  if grep -q "update-alternatives" "$POSTINST" && grep -q "/usr/bin/" "$POSTINST"; then
    ok "postinst 会在 /usr/bin 下建立命令入口"
  else
    bad "postinst 没有建立 /usr/bin 入口 —— 终端里敲 simplemail 会 command not found"
  fi
  if grep -q "chrome-sandbox" "$POSTINST"; then
    ok "postinst 会修正 chrome-sandbox 权限（沙箱可用）"
  else
    bad "postinst 没有修正 chrome-sandbox 权限"
  fi
else
  bad "没有 postinst"
fi

if [ -f "$POSTRM" ] && grep -q "update-alternatives" "$POSTRM"; then
  ok "postrm 会清理命令入口（卸载干净）"
else
  note "postrm 未清理 update-alternatives（卸载后 /usr/bin/simplemail 可能残留）"
fi

# ── 3. 文件布局 ─────────────────────────────────────────────────
echo "3. 文件布局"
for f in opt/SimpleMail/simplemail opt/SimpleMail/simplemail.bin opt/SimpleMail/resources/app.asar; do
  if [ -e "$WORK/fs/$f" ]; then
    ok "存在 $f"
  else
    bad "缺少 $f"
  fi
done

if [ -f "$WORK/fs/opt/SimpleMail/simplemail" ]; then
  if head -c 2 "$WORK/fs/opt/SimpleMail/simplemail" | grep -q '#!'; then
    ok "simplemail 是启动器脚本（沙箱自适应）"
  else
    bad "simplemail 不是脚本，说明 afterPack 启动器没生效"
  fi
fi

if [ -f "$WORK/fs/opt/SimpleMail/simplemail.bin" ]; then
  if head -c 4 "$WORK/fs/opt/SimpleMail/simplemail.bin" | grep -q $'\x7fELF'; then
    ok "simplemail.bin 是 ELF 可执行文件"
  else
    bad "simplemail.bin 不是 ELF"
  fi
fi

# ── 3b. 重启路径（曾经导致「清除数据后闪退」） ─────────────────────
echo "3b. 重启路径"
LAUNCHER="$WORK/fs/opt/SimpleMail/simplemail"
if grep -q -- "--no-sandbox" "$LAUNCHER" 2>/dev/null; then
  ok "启动器脚本里带 --no-sandbox"
else
  bad "启动器脚本没有 --no-sandbox，无 setuid 的环境下会起不来"
fi

# 抽取 asar 里的主进程代码，确认重启走的是启动器而不是裸二进制。
# 背景：app.relaunch() 默认用 process.execPath（= simplemail.bin），
# 会绕过启动器补的 --no-sandbox，在 Ubuntu 24.04+ 上直接 abort ——
# 现象就是「清除数据后闪退，重新打开又正常」。
if command -v npx >/dev/null 2>&1; then
  ASAR_DIR="$WORK/asar"
  mkdir -p "$ASAR_DIR"
  if npx asar extract "$WORK/fs/opt/SimpleMail/resources/app.asar" "$ASAR_DIR" >/dev/null 2>&1 \
     && [ -f "$ASAR_DIR/out/main/index.js" ]; then
    if grep -q "execPath: launcher" "$ASAR_DIR/out/main/index.js"; then
      ok "重启显式使用启动器路径（不会绕过 --no-sandbox）"
    else
      bad "重启没有指定启动器路径 —— 重启后可能因沙箱直接崩溃"
    fi
  else
    note "（没能解开 asar，跳过重启路径检查）"
  fi
fi

# ── 4. 图标 ─────────────────────────────────────────────────────
echo "4. 图标"
if [ -f "$ICON" ]; then
  if head -c 8 "$ICON" | grep -q $'\x89PNG'; then
    ok "图标是合法 PNG"
  else
    bad "图标不是 PNG"
  fi
  ICON_REF="$(grep '^Icon=' "$DESKTOP" 2>/dev/null | cut -d= -f2)"
  if [ "$ICON_REF" = "simplemail" ]; then
    ok "desktop 的 Icon= 与图标文件名对得上"
  else
    bad "desktop 的 Icon=$ICON_REF 与安装的图标 simplemail.png 不一致"
  fi
else
  bad "没有安装图标文件"
fi

# ── 5. 依赖 ─────────────────────────────────────────────────────
echo "5. 依赖声明"
DEPS="$(dpkg-deb -f "$DEB" Depends 2>/dev/null)"
for lib in libgtk-3-0 libnss3 libgbm1 libasound2 libsecret-1-0; do
  if echo "$DEPS" | grep -q "$lib"; then
    ok "依赖含 $lib"
  else
    bad "依赖缺少 $lib"
  fi
done

# ── 6. 许可证声明 ───────────────────────────────────────────────
#
# MIT 的条件之一是「版权声明与许可声明须随本软件的所有副本一起分发」，而 .deb 就是
# 一个副本。Debian 的惯例是把它们放在 /usr/share/doc/<包名>/ 下，其中 copyright
# 用 DEP-5（机器可读）格式。lintian 对缺 copyright 的包会报 no-copyright-file。
echo "6. 许可证声明"
DOCDIR="$WORK/fs/usr/share/doc/simplemail"
for f in copyright LICENSE NOTICE.md; do
  if [ -s "$DOCDIR/$f" ]; then
    ok "/usr/share/doc/simplemail/$f 存在（$(stat -c%s "$DOCDIR/$f") 字节）"
  else
    bad "缺少 /usr/share/doc/simplemail/$f —— MIT 要求副本携带许可声明"
  fi
done

if [ -s "$DOCDIR/copyright" ]; then
  if grep -q "^Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/" "$DOCDIR/copyright"; then
    ok "copyright 是 DEP-5 格式"
  else
    bad "copyright 缺少 Format 字段，不是机器可读格式"
  fi

  # DEP-5 结构：段落之间用空行分隔，头段落必须有 Format，
  # 其余每个段落都必须同时有 Files 和 License。
  #
  # 曾经踩过：Comment 前面多了一个空行，就多出一个没有 Files 字段的孤儿段落，
  # 这种文件 lintian 直接判非法。
  if awk '
      function flush() {
        if (buf == "") return
        if (n == 0) { if (buf !~ /(^|\n)Format:/) bad = 1 }
        else        { if (buf !~ /(^|\n)Files:/ || buf !~ /(^|\n)License:/) bad = 1 }
        n++
        buf = ""
      }
      /^$/ { flush(); next }
      { buf = buf $0 "\n" }
      END  { flush(); exit bad }
    ' "$DOCDIR/copyright"; then
    ok "段落结构合法（头段落有 Format，其余都有 Files + License）"
  else
    bad "copyright 结构非法：存在缺 Format/Files/License 的段落"
  fi

  if grep -q "Permission is hereby granted" "$DOCDIR/copyright" \
     && grep -q "WITHOUT WARRANTY OF ANY KIND" "$DOCDIR/copyright"; then
    ok "copyright 内含完整 MIT 正文"
  else
    bad "copyright 里的 MIT 正文不完整"
  fi
fi

# 许可证文件还要随每种安装形态一起走（AppImage / tar.gz 里就在应用根目录的
# resources/ 下），所以这里顺带检查 extraResources 有没有生效。
APP_RES="$WORK/fs/opt/SimpleMail/resources"
if [ -d "$APP_RES" ]; then
  for f in LICENSE NOTICE.md; do
    if [ -s "$APP_RES/$f" ]; then
      ok "resources/$f 随应用分发"
    else
      bad "resources/$f 缺失 —— extraResources 没生效"
    fi
  done
else
  note "（没找到 $APP_RES，跳过 extraResources 检查）"
fi

# ── 结果 ────────────────────────────────────────────────────────
echo
if [ "$FAILED" -eq 0 ]; then
  echo "deb 产物校验通过（$PASSED 项）"
  exit 0
fi
echo "deb 产物校验失败：$FAILED 项不合格（通过 $PASSED 项）"
exit 1
