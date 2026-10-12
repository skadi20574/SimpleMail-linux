#!/bin/bash
# SimpleMail .deb 安装后脚本
#
# ⚠️ 重要：只要在 electron-builder.yml 里指定了 `deb.afterInstall`，
# electron-builder 自带的默认 postinst 模板就会被**整个替换掉**。默认模板里
# 有一件必做的事 —— 在 /usr/bin 下建立命令入口。忘了补上它的直接后果就是：
# 应用中心显示安装成功，但终端里敲 simplemail 却提示 command not found。
# 所以下面第 1 步必须保留。

# ⚠️ 还有一个坑：electron-builder 的 fpm 打包器会把脚本当模板做变量替换，
# 正则只匹配**纯字母**的 ${...}，命中但不在已知宏列表里就直接报
# "Macro XXX is not defined" 让打包失败。所以这里的 shell 变量名一律带下划线
# （${APP_DIR} / ${APP_EXEC}），正则匹配不到，原样保留给 shell 用。

set -e

APP_DIR="/opt/SimpleMail"
APP_EXEC="simplemail"

# ── 1) 建立 /usr/bin/simplemail 命令入口 ──────────────────────────
if command -v update-alternatives >/dev/null 2>&1; then
  update-alternatives --install "/usr/bin/${APP_EXEC}" "${APP_EXEC}" \
    "${APP_DIR}/${APP_EXEC}" 100
else
  ln -sf "${APP_DIR}/${APP_EXEC}" "/usr/bin/${APP_EXEC}"
fi

# ── 2) 修正 chrome-sandbox 权限 ───────────────────────────────────
# Electron 需要 chrome-sandbox 带 setuid root 位才能启用渲染进程沙箱。
# 缺这个位时，在 Ubuntu 23.10+ 上（AppArmor 限制了非特权用户命名空间）
# 会直接启动失败。这一步让 deb 安装的沙箱真正可用，
# 而 AppImage / tar.gz 只能退化为 --no-sandbox。
if [ -f "${APP_DIR}/chrome-sandbox" ]; then
  chown root:root "${APP_DIR}/chrome-sandbox" 2>/dev/null || true
  chmod 4755 "${APP_DIR}/chrome-sandbox" 2>/dev/null || true
fi

# ── 3) 刷新桌面数据库与图标缓存，让应用菜单立刻出现 ─────────────────
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t /usr/share/icons/hicolor >/dev/null 2>&1 || true
fi

exit 0
