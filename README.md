# 作曲工具 / Composer Tools

一组面向频谱作曲与算法作曲的小工具：两个网页计算器，加一个原生 macOS 外壳
（AppKit + WKWebView + 真 Liquid Glass）。

## 包含什么

| 工具 | 位置 | 形态 |
|---|---|---|
| 环形调制计算器 | `tools/ringmod-demo.html` | 单文件网页：载音/调制音输入、和音差音、频率轴图示、试听、SVG/PNG 导出 |
| 插值计算器 | `tools/interpolation-demo.html` + `tools/interpolation-core.js` | 网页：与 OM 同构的插值、88 键输入、五线谱、曲线预览、MIDI 导出（含微分音） |
| 作曲工具（原生外壳） | `tools/mac-shell-poc/` | AppKit + WKWebView：侧边栏、独立置顶悬浮面板、真 Liquid Glass、双工具切换 |
| 两个单工具 .app | `tools/app-source/`、`tools/app-source-interpolation/` | ObjC + WKWebView 的 app 外壳源码与打包脚本 |

## 环境要求

- 原生外壳 / 两个 .app：macOS 26+，Command Line Tools 即可（不需要 Xcode）
- 网页工具：任意现代浏览器（Safari / Chrome）
- 单元测试：Node.js 18+

## 快速开始

### 网页工具

直接用浏览器打开：

- `tools/ringmod-demo.html`
- `tools/interpolation-demo.html`

### 插值核心测试

```sh
node tools/test-interpolation-core.mjs
```

### 作曲工具（原生外壳）

```sh
cd tools/mac-shell-poc
./build-poc.sh
open "build/作曲工具 PoC.app"
```

功能：

- 侧边栏在「环形调制 / 插值」之间切换，两个 `WKWebView` 常驻，各自状态保留
- 独立 `NSPanel` 悬浮条：真 `NSGlassEffectView`、可置顶、可隐藏、可拖动、位置记忆
- 读数含音名与频率；插值面板含当前 curve 的曲率图示
- Swift ↔ JS 双向桥；导出经 `WKDownload` 落到 `~/Downloads`

### 两个单工具 .app

```sh
cd tools/app-source && ./build-app.sh                 # 环形调制计算器
cd tools/app-source-interpolation && ./build-app.sh   # 插值计算器
```

## 目录结构

```text
tools/
├── ringmod-demo.html                 环形调制计算器（网页）
├── interpolation-demo.html           插值计算器（网页）
├── interpolation-core.js             插值 / 音名 / MIDI 文件写出核心
├── test-interpolation-core.mjs       19 项核心测试
├── README-插值计算器.md               插值计算器说明
├── app-source/                       环形调制 .app 外壳（ObjC）
├── app-source-interpolation/         插值 .app 外壳（ObjC）
└── mac-shell-poc/                    作曲工具原生外壳
    ├── main.m                        AppKit 外壳 + 悬浮面板 + 桥
    ├── build-poc.sh                  编译打包脚本
    ├── make-icon.swift               图标绘制
    ├── Info.plist / AppIcon.icns
    └── README.md
```

## 技术要点

- **OM 同构插值**：`w = t^(e^(−curve))`，`samples` 含首尾；频率域插值对应 OM 的 `f-interpol`
- **微分音 MIDI**：Pitch Bend（每声部一通道，RPN 0 设弯音范围）与 MIDI Tuning Standard
  （SysEx 批量调音）双方案，并写入音分文本 meta
- **原生外壳**：AppKit + WKWebView；`NSGlassEffectView` 真玻璃悬浮面板；面板为独立
  `NSPanel`，主窗口最小化后仍置顶
- **资源打包**：默认从 app bundle 读取 HTML/JS，不访问 `~/Documents`，
  避免 macOS TCC 授权弹窗阻塞主线程
- **已知实现约束**：`NSGlassEffectView` 内不要放复杂 Auto Layout；多行 `NSTextField`
  与 `NSStackView.fittingSize` 组合会卡死（改用两个单行标签）；面板尺寸跟随内容、
  位置 autosave

## 开发提示

- 建 `/tmp/poc-use-external` 可让原生外壳切到 `~/Documents/.../tools/` 读取网页源码
  （首次会弹一次文稿授权，允许即可）
- 重新编译并覆盖安装：

  ```sh
  cd tools/mac-shell-poc
  ./build-poc.sh
  ditto "build/作曲工具 PoC.app" "/Applications/作曲工具 PoC.app"
  ```

- 没有 Xcode 时，SwiftUI 的 `@State` 等属性包装不可用（缺 `SwiftUIMacros` 插件）；
  原生外壳使用 AppKit，运行性能不受影响

## 已知限制

- 原生 app 目标为 macOS 26+ / arm64，ad-hoc 签名；他人下载后首次打开需右键“打开”，
  或执行 `xattr -dr com.apple.quarantine "/Applications/作曲工具 PoC.app"`
- 想要更广分发，需要 Apple Developer ID 签名 + 公证
- 没有 Xcode 时不能产出 Liquid Glass 时代的分层 app 图标（当前使用传统 `.icns`）

## 致谢

算法与交互思路参考了 IRCAM OpenMusic 的 `INTERPOLATION` / `f-interpol` 等概念；
本项目为独立实现，与 IRCAM 无隶属关系。OMTristan / Esquisse 属于 IRCAM 的
OpenMusic 库，不在本仓库中。

## 许可

MIT License，见 [LICENSE](LICENSE)。
