#!/bin/zsh
# 重新打包「插值计算器.app」。
# app 运行时优先加载 ../interpolation-demo.html；
# 改了 HTML / JS 只需在 app 里按 ⌘R，不必重新打包。
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
TOOLS="$(cd "$DIR/.." && pwd)"
HTML="$TOOLS/interpolation-demo.html"
CORE="$TOOLS/interpolation-core.js"
OUT="$TOOLS/build"
APP="$OUT/插值计算器.app"

if [ ! -f "$HTML" ] || [ ! -f "$CORE" ]; then
  echo "找不到 $HTML 或 $CORE" >&2
  exit 1
fi

mkdir -p "$OUT"
clang -fobjc-arc -O2 -framework Cocoa -framework WebKit -o "$OUT/InterpCalc" "$DIR/main.m"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$OUT/InterpCalc" "$APP/Contents/MacOS/InterpCalc"
cp "$DIR/Info.plist" "$APP/Contents/Info.plist"
cp "$DIR/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cp "$HTML" "$APP/Contents/Resources/interpolation-demo.html"
cp "$CORE" "$APP/Contents/Resources/interpolation-core.js"
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

echo "已生成: $APP"
echo "安装到 /Applications 用："
echo "  ditto \"$APP\" /Applications/"
