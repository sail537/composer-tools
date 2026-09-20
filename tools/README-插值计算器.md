# 插值计算器

与「环形调制计算器」同款的 macOS 小工具：用钢琴键盘输入起点/终点和弦，用五线谱显示
插值结果，并可播放、导出标准 MIDI 文件（SMF）与五线谱 SVG。

## 位置

- 已安装的 app：`/Applications/插值计算器.app`
- 网页源码：`tools/interpolation-demo.html`
- 核心算法：`tools/interpolation-core.js`
- app 外壳源码：`tools/app-source-interpolation/`
- 单元测试：`tools/test-interpolation-core.mjs`

app 运行时优先加载 `tools/interpolation-demo.html`（外置文件），所以改完 HTML / JS
在 app 里按 ⌘R 就能看到效果，不必重新打包。

## 用法

1. 左栏「编辑 A / 编辑 B」切换当前和弦，在完整的 88 键（A0–C8）上点击添加或移除音；
   也可以直接在文本框里输入 `60 64 67` 或 `C4 E4 G4` 后点「应用」。「定位已选音」会把
   当前输入的音滚到键盘中间。
2. 两个和弦的音数必须相同（OM 的和弦插值要求声部一一对应）。
3. 设置 `samples`（和弦数量，包含首尾）、`curve`（弯曲度）、插值域（MIDI / 频率 Hz）、
   每个和弦的时值与连断比例。
4. 「导出 MIDI」生成 `interpolation-<步数>ch-<域名>.mid`；「导出五线谱 SVG」导出当前谱面。

「曲线 / 参数预置」**只改步数、curve、插值域等参数，永不动你选定的 A / B**，
所以换预置时已经输入的两个和弦会原样保留。

## 微分音 MIDI

MIDI 1.0 的 note number 只能记整数半音，但微分音可以写进标准 MIDI 文件：

- **Pitch Bend（默认，推荐）**：每个声部占一个 MIDI 通道（跳过 GM 鼓通道 10），
  文件里先用 RPN 0 把弯音范围设为 ±2 或 ±12 半音，再为每个音写 pitch bend
  （14-bit），因此最多 15 个声部可以各自独立微分音。
- **MIDI Tuning Standard（MTS）**：把每个音高分配一个独立 note number，并在文件开头
  写一段 SysEx 批量调音表（`F0 7E 7F 08 01 …`），做绝对调音。需要合成器支持 MTS；
  音高种类超过 128 时自动退回 Pitch Bend。
- **音分文本（meta）**：可选写入每个和弦的精确浮点音高与音分，即使合成器忽略微分音，
  文件本身也保留了信息（文本为 ASCII，用 `c` 表示音分）。

导出文件名会带上模式，例如 `interpolation-12ch-freq-bend.mid`。

## 算法

与 OpenMusic 8.0 的 `INTERPOLATION` 同构：

```
w(t, curve) = t ^ ( e ^ (-curve) )
C(t)        = A + (B - A) * w(t, curve)
```

- `curve = 0`：线性
- `curve > 0`：先快后慢（上凸）
- `curve < 0`：先慢后快（下凹 / 加速）
- `samples = 1` 时返回中点（与 OM 一致）
- 频率域插值 = 先把 MIDI 转 Hz，线性插值频率，再转回 MIDI（对应 OM / OMTristan 的 `f-interpol`）

## 重新打包

```sh
tools/app-source-interpolation/build-app.sh          # 生成 tools/build/插值计算器.app
ditto "tools/build/插值计算器.app" /Applications/    # 安装/覆盖
```

图标由 `app-source-interpolation/make-icon.swift` 与 `make-icns.mjs` 生成。
