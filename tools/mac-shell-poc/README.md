# 作曲工具 PoC v3（双工具 + 独立置顶面板 + bundle 资源）

## 工具

- 侧边栏：环形调制 / 插值。两个 `WKWebView` 常驻，切换时只显示/隐藏，各自状态保留。
- 悬浮面板按当前工具切换按钮与读数：
  - 环形调制：两音 / 环形调制 / 和音 + 差音 / 停止；读数含音名与频率
    （`载音 g¹ 392.0 Hz · 调制音 g♯ 207.7 Hz` / `和音 d² 599.6 Hz · 差音 f♯ 184.3 Hz`）
  - 插值：播放（带文字）/ 停止（图标）/ 导出 MIDI（图标）/ 五线谱 SVG（图标）；
    读数含和弦数、声部数、插值域、curve，播放时显示“第 n/N 步”；
    面板里还有一个**当前 curve 的曲率图示**（虚线 = 线性参考，实线 = `t^(e^(−curve))`）
- 切换工具会停掉另一个工具的声音，避免两路同时响。
- 面板材质固定为**真玻璃**（`NSGlassEffectView`）；菜单「显示 → 面板材质」里保留了
  磨砂回退项，调试时也可建 `/tmp/poc-use-frosted` 切到磨砂。

## 资源与 TCC（重要）

- 默认从 **app bundle** 读取页面：`Contents/Resources/ringmod-demo.html`、
  `interpolation-demo.html`、`interpolation-core.js`。
- 因此不访问 `~/Documents`，不会触发“访问文稿文件夹”的系统授权弹窗。
  **之前偶发卡死就是等待这个 TCC 弹窗时主线程被阻塞。**
- 需要实时编辑网页源码时，创建 `/tmp/poc-use-external`，会切回
  `~/Documents/ChatGPT/论文paper/tools/...`；首次会弹一次授权，允许即可。

## 运行与重编译

- 已编译：`build/作曲工具 PoC.app`
- 重新编译：`./build-poc.sh`
- 环境：macOS 26+（本机 macOS 27），Command Line Tools 即可，不需要 Xcode

## 已验证（日志）

| 项目 | 结果 |
|---|---|
| 启动资源 | 两个页面均从 `.../Contents/Resources/` 加载，无 Documents 访问 |
| 环形调制桥 | `bridge ringmod carrier=g¹ mod=g♯ sum=d² diff=f♯` |
| 插值桥 | `bridge interp chords=12 voices=3 step=0 playing=0` |
| 切换 | `tool switched to 1` / `tool switched to 0`，窗口标题随工具变化 |
| 插值播放 | `evalInterpJS … InterpAPI.play()`，`audio=running`，`step=1..6 playing=1` |
| 插值导出 | `download -> ~/Downloads/interpolation-12ch-midi-bend.mid` |
| 曲率图示 | `interp curve updated 0.000 → 0.800`，面板图示随 curve 重绘 |
| 心跳 | 两个工具各自 1s 心跳；最小化主窗口后仍继续（Web Audio 时间持续推进） |
| 面板 | 真 `NSGlassEffectView`，置顶 `level=3`；可隐藏、可切磨砂材质 |

## 关键实现约束

1. `NSGlassEffectView` 的 `contentView` 不要放复杂 Auto Layout 内容，会出现主线程卡死；
   用“先算内容尺寸、固定 frame 布局”。
2. 多行 `NSTextField`（`maximumNumberOfLines = 2`）与 `NSStackView.fittingSize` 组合
   也会卡死；读数改用两个独立单行标签。
3. 悬浮面板必须是独立 `NSPanel`（不能 `addChildWindow:`），否则主窗口最小化时会一起消失。
4. SwiftUI 属性包装（`@State` 等）依赖 Xcode 的 `SwiftUIMacros`；只有 CLT 时走 AppKit。
   这是编译期限制，不影响运行性能。
5. 默认只读 bundle 资源以避免 TCC 阻塞；外置路径仅在 `/tmp/poc-use-external` 时使用。
6. 面板**位置**可以 autosave，但**尺寸必须跟随内容**：旧尺寸会让窄内容右侧留白；
   读数标签的 `preferredMaxLayoutWidth` 放宽到 560pt，避免 curve/步进被省略号截断。
7. 窗口使用 `FullSizeContentView` 时，内容必须约束到 `root.safeAreaLayoutGuide`
   （本机顶部 safe area = 52pt），否则收起侧边栏后网页会压到左上角三个交通灯按钮上。
8. 内容四周留 10pt 渐变边框，并设置 `window.movableByWindowBackground = YES`，
   这样标题栏之外的边框区域也能拖动窗口，不再只能拖侧边栏。

## 调试开关（在 `/tmp` 下建同名文件）

- `poc-no-panel` / `poc-panel-simple` / `poc-panel-plain` / `poc-panel-no-order` / `poc-panel-no-autosave`
- `poc-no-web` / `poc-no-interp` / `poc-no-placeholder` / `poc-visual-effect`
- `poc-use-external`

日志：`/tmp/composer-poc.log`
