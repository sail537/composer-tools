#!/bin/zsh
# 重新打包「环形调制计算器.app」。
# 注意：app 运行时会优先加载 ../ringmod-demo.html，
#      改了那个 HTML 只需在 app 里按 ⌘R，不必重新打包。
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
TOOLS="$(cd "$DIR/.." && pwd)"
HTML="$TOOLS/ringmod-demo.html"
OUT="$TOOLS/build"
APP="$OUT/环形调制计算器.app"

if [ ! -f "$HTML" ]; then
  echo "找不到 $HTML" >&2
  exit 1
fi

mkdir -p "$OUT"
clang -fobjc-arc -O2 -framework Cocoa -framework WebKit -o "$OUT/RingMod" "$DIR/main.m"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$OUT/RingMod" "$APP/Contents/MacOS/RingMod"
cp "$DIR/Info.plist" "$APP/Contents/Info.plist"
cp "$DIR/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cp "$HTML" "$APP/Contents/Resources/ringmod-demo.html"
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

echo "已生成: $APP"
echo "安装到 /Applications 用："
echo "  ditto \"$APP\" /Applications/"
