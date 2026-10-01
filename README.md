这个小工具是辅助我搞算法作曲的，最近接了个枪手活儿，要我写频谱音乐。
从来没有人教过我写这种落后的东西（毕竟学校教的都是更落后的东西/笑），但甲方要我写，我不得不写。
于是我去看了SHCM的沈叶（葉）发布在其视频号上的OpenMusic教程（仅1篇），WHCM的龚华华也要我去看吴粤北的《先锋派实验音乐之涅磐》。
（A few days later）
终于我发现，语焉不详是中国音乐圈的一大特色，只靠书本和自己是不能根本学会新东西的。
就此，我决心假AI之新质生产力，搞一个大部分人看得懂，用得了的算法作曲工具。

    核心算法参考自 IRCAM 相关研究 / OpenMusic。
    界面设计由 DeepSeek 辅助完成。
    可自由下载、使用、修改，请遵守仓库中的 LICENSE。禁止倒卖或用于欺骗性商业行为。
    
⬆️以上都是人说的。
⬇️以下都是Codex+DeepSeek说的

# 作曲工具 / Composer Tools

**当前版本 0.2**（四个工具）· 面向频谱作曲与算法作曲的小工具集：
四个网页计算器，加一个原生 macOS 外壳（AppKit + WKWebView + 真 Liquid Glass）。

版本说明：0.x 阶段工具数量与算法覆盖还在长；**1.0 的判据**见下面的「路线图」——
大致是把 OMTristan / Esquisse 里频谱音乐创作最常用的那批算法做到可用。

## 包含什么

| 工具 | 位置 | 形态 |
|---|---|---|
| 环形调制计算器 | `tools/ringmod-demo.html` | 单文件网页：载音/调制音输入、和音差音、频率轴图示、试听、SVG/PNG 导出 |
| 插值计算器 | `tools/interpolation-demo.html` + `tools/interpolation-core.js` | 网页：与 OM 同构的插值、88 键输入、五线谱、曲线预览、MIDI 导出（含微分音） |
| 虚拟基音计算器 | `tools/virtualfund-demo.html` + `tools/virtualfund-core.js` | 网页：移植 OM 的 `tolerant-gcd` / `virtual-fund`，虚基音、泛音序号对照表、精度扫描、MIDI/SVG 导出 |
| 节奏插值 | `tools/rhythm-interp-demo.html` + `tools/rhythm-interp-core.js` | 网页：多声部、休止符、拍号、音值组合法、五线谱（abcjs）、MIDI/SVG 导出 |
| SDIF 读取器（独立 demo） | `tools/sdif-demo.html` + `tools/sdif-core.js` | 网页：读 SPEAR/AudioSculpt 导出的 `.sdif` 频谱分析，画频谱图、转成音高素材上五线谱、**慢速回放**（加法重合成 + 时间拉伸）、导出 MIDI/SVG |
| 算法作曲工具集 0.2（原生外壳） | `tools/app-shell/` | AppKit + WKWebView：侧边栏、独立置顶悬浮面板、真 Liquid Glass、**四工具**切换（⌘1–⌘4） |
| 两个单工具 .app | `tools/app-source/`、`tools/app-source-interpolation/` | ObjC + WKWebView 的 app 外壳源码与打包脚本 |

## 路线图：通往 1.0

功能清单不是我随手列的，是照着本机装的 **OMTristan 3.5**（菜单 `1-SPECTRAL HARMONY`
等 7 个一级分组）与 **Esquisse 1.3** 的实际函数表整理的。

| OM 分类 | 代表函数 | 状态 |
|---|---|---|
| 振幅调制 / 环形调制 | `rmo` `rm-gen` `ring-mod` | ✅ 0.1 |
| 频谱插值 | `f-interpol` | ✅ 0.1 |
| 虚拟基音 | `virtual-fund` `virt-fund-step` | ✅ 0.2 |
| 节奏插值 | OM 核心 `INTERPOLATION` on dx | ✅ 0.2 |
| SDIF 频谱导入 | `sdif->chord-seq` `GetSDIFChords`（1TRC / 1MRK） | 🚧 独立 demo |
| 泛音列生成 | `sp-gen` `n-sp-gen` `HARM-SERIES` `NTH-HARM` | ⬜ |
| 频率调制 | `fmo` `fm-origin` `fm-ratio` `fm-arp` `FREQ-MOD` | ⬜ |
| 频率移位 | `fsh` `fs-proc` `FSHIFT` | ⬜ |
| 失真 | `disto` `dist-gen` `dist-sym` `FDISTOR` | ⬜ |
| 频谱变换（加密 / 倍增 / 再生） | `f-densifier` `f-multiplier` `proliferer` `ch-mixture` | ⬜ |
| 和弦变形 | `reharmonizer` `diamanter` | ⬜ |
| 频谱归属与匹配 | `which-harm` `closest-harm` `match-n-sp` `match-trans` `BEST-FREQ` `HARM-DIST` | ⬜ |
| 中心 / 相邻频率 | `center-freq` `inter-freq` | ⬜ |
| 多解虚拟基音 | `virt-fund-multi`（Delerue） | ⬜ |
| 音高集合运算 | `BEST-TRANSP` `BEST-INV` `ALL-INVERSIONS` `SORT-MOD` | ⬜ |
| 声码器 | `vocoder` `ch-vocoder` `time-vocoder` | ⬜ |
| 分析 / 合成接口 | `SPDATA` `Addi-MSP` | ⬜ |

**建议的 1.0 判据**（可检验，不是感觉）：

1. `1-SPECTRAL HARMONY` 的七个二级分类（和声列、频率调制、振幅调制、失真、频率移位、
   频谱变换、频谱分析）**每一类至少有一个可用实现**；
2. 频谱分析里的 `virtual-fund` 家族与频率匹配（`match-*`）齐全；
3. 每个工具都具备同样的四件套：88 键或等价输入、五线谱/图示、试听、MIDI 导出；
4. 全部工具收进同一个外壳，⌘1–⌘N 切换。

第 3、4 条现在已经做到了，主要缺的是第 1、2 条里的算法。

## 环境要求

- 原生外壳 / 两个 .app：macOS 26+，Command Line Tools 即可（不需要 Xcode）
- 网页工具：任意现代浏览器（Safari / Chrome）
- 单元测试：Node.js 18+

## 快速开始

### 网页工具

直接用浏览器打开：

- `tools/ringmod-demo.html`
- `tools/interpolation-demo.html`

### 核心测试

```sh
node tools/test-interpolation-core.mjs      # 19 项
node tools/test-rhythm-interp-core.mjs      # 53 项
node tools/test-notation-semantics.mjs      # 28 项（abcjs 回读校验）
node tools/test-virtualfund-core.mjs        # 24 项
node tools/test-sdif-core.mjs               # 22 项（含 OM 样例交叉验证）
```
共 146 项，全绿。

### 算法作曲工具集（原生外壳）

```sh
cd tools/app-shell
./build-app.sh
open "build/算法作曲工具集.app"
```

功能（0.2）：

- 侧边栏在「环形调制 / 插值 / 虚拟基音 / 节奏插值」之间切换（⌘1–⌘4），
  四个 `WKWebView` 常驻，各自状态保留
- 独立 `NSPanel` 悬浮条：真 `NSGlassEffectView`、可置顶、可隐藏、可拖动、位置记忆
- 悬浮条读数随工具切换；插值与节奏插值面板含当前 curve 的曲率图示
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
├── virtualfund-demo.html             虚拟基音计算器（网页）
├── virtualfund-core.js               tolerant-gcd / virtual-fund 核心
├── rhythm-interp-demo.html           节奏插值（网页，多声部）
├── rhythm-interp-core.js             节奏插值 / 全局量化记谱核心
├── sdif-demo.html                    SDIF 读取器（独立 demo）
├── sdif-core.js                      SDIF 解析 / 分音轨迹 / 频谱图 / MIDI
├── vendor/abcjs/                     五线谱渲染（MIT）
├── test-interpolation-core.mjs       19 项
├── test-virtualfund-core.mjs         24 项
├── test-rhythm-interp-core.mjs       53 项
├── test-notation-semantics.mjs       28 项（abcjs 回读校验）
├── test-sdif-core.mjs                22 项（含 OM 样例交叉验证）
├── README-插值计算器.md
├── README-虚拟基音计算器.md
├── README-节奏插值.md
├── app-source/                       环形调制 .app 外壳（ObjC）
├── app-source-interpolation/         插值 .app 外壳（ObjC）
└── app-shell/                    算法作曲工具集 0.2 原生外壳
    ├── main.m                        AppKit 外壳 + 悬浮面板 + 桥
    ├── build-app.sh                  编译打包脚本
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

- 建 `/tmp/debug-use-external` 可让原生外壳切到 `~/Documents/.../tools/` 读取网页源码
  （首次会弹一次文稿授权，允许即可）
- 重新编译并覆盖安装：

  ```sh
  cd tools/app-shell
  ./build-app.sh
  ditto "build/算法作曲工具集.app" "/Applications/算法作曲工具集.app"
  ```

- 没有 Xcode 时，SwiftUI 的 `@State` 等属性包装不可用（缺 `SwiftUIMacros` 插件）；
  原生外壳使用 AppKit，运行性能不受影响

## 已知限制

- 原生 app 目标为 macOS 26+ / arm64，ad-hoc 签名；他人下载后首次打开需右键“打开”，
  或执行 `xattr -dr com.apple.quarantine "/Applications/算法作曲工具集.app"`
- 想要更广分发，需要 Apple Developer ID 签名 + 公证
- 没有 Xcode 时不能产出 Liquid Glass 时代的分层 app 图标（当前使用传统 `.icns`）

## 致谢

算法与交互思路参考了 IRCAM OpenMusic 的 `INTERPOLATION` / `f-interpol` 等概念；
本项目为独立实现，与 IRCAM 无隶属关系。OMTristan / Esquisse 属于 IRCAM 的
OpenMusic 库，不在本仓库中。

## 许可

MIT License，见 [LICENSE](LICENSE)。
