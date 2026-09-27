#!/bin/zsh
# 编译并组装「算法作曲工具集.app」
# 需要 macOS 26+ SDK；本机用 Command Line Tools 即可，不依赖 Xcode。
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
TOOLS="$(cd "$DIR/.." && pwd)"
OUT="$DIR/build"
APP="$OUT/算法作曲工具集.app"

mkdir -p "$OUT"
rm -f "$OUT/AlgorithmicComposer" "$OUT/ComposerToolsPoc"

clang -fobjc-arc -O2 -framework Cocoa -framework WebKit -framework QuartzCore \
  -o "$OUT/AlgorithmicComposer" "$DIR/main.m"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$OUT/AlgorithmicComposer" "$APP/Contents/MacOS/AlgorithmicComposer"
cp "$DIR/Info.plist" "$APP/Contents/Info.plist"
cp "$DIR/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cp "$TOOLS/ringmod-demo.html" "$APP/Contents/Resources/ringmod-demo.html"
cp "$TOOLS/interpolation-demo.html" "$APP/Contents/Resources/interpolation-demo.html"
cp "$TOOLS/interpolation-core.js" "$APP/Contents/Resources/interpolation-core.js"
cp "$TOOLS/virtualfund-demo.html" "$APP/Contents/Resources/virtualfund-demo.html"
cp "$TOOLS/virtualfund-core.js" "$APP/Contents/Resources/virtualfund-core.js"
cp "$TOOLS/rhythm-interp-demo.html" "$APP/Contents/Resources/rhythm-interp-demo.html"
cp "$TOOLS/rhythm-interp-core.js" "$APP/Contents/Resources/rhythm-interp-core.js"
mkdir -p "$APP/Contents/Resources/vendor"
cp -R "$TOOLS/vendor/abcjs" "$APP/Contents/Resources/vendor/abcjs"
cp "$DIR/README.md" "$APP/Contents/Resources/README.md"
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

echo "已生成: $APP"
