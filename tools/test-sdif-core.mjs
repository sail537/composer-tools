/* ============================================================
   SDIF 读取核心测试

   测试自带一个最小 SDIF 写出器（按实测的字节布局），先写再读，
   不依赖任何外部文件；如果本机装了 OM 8.0，再拿它的样例交叉验证。

   运行：node tools/test-sdif-core.mjs
   ============================================================ */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const S = require('./sdif-core.js');

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log('  ✓ ' + name);
}
function close(a, b, eps) {
  assert.ok(Math.abs(a - b) < (eps === undefined ? 1e-6 : eps), `${a} != ${b}`);
}

/* ---------- 最小 SDIF 写出器（只写本测试需要的部分） ---------- */

function pad8(n) { return (n + 7) & ~7; }

function writeMatrix(sig, matrixSig, rows, cols, values, byteMode) {
  const elem = byteMode ? 1 : 4;
  const dataLen = rows * cols * elem;
  const size = 16 + dataLen;                 /* 矩阵头 16 字节 + 数据 */
  const out = new Uint8Array(pad8(size));
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = matrixSig.charCodeAt(i);
  dv.setUint32(4, elem, false);              /* 元素尺寸字段 */
  dv.setUint32(8, rows, false);
  dv.setUint32(12, cols, false);
  if (byteMode) {
    for (let i = 0; i < values.length; i++) out[16 + i] = values.charCodeAt(i);
  } else {
    values.forEach((v, i) => dv.setFloat32(16 + i * 4, v, false));
  }
  return out;
}

function writeFrame(sig, time, matrices) {
  const body = matrices.reduce((a, m) => a + m.length, 0);
  const size = 16 + body;                    /* 时间 8 + id 4 + nbMat 4 + 矩阵 */
  const out = new Uint8Array(8 + size);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = sig.charCodeAt(i);
  dv.setUint32(4, size, false);
  dv.setFloat64(8, time, false);
  dv.setUint32(16, 0, false);
  dv.setUint32(20, matrices.length, false);
  let off = 24;
  matrices.forEach((m) => { out.set(m, off); off += m.length; });
  return out;
}

function writeSDIF(frames) {
  const head = new Uint8Array(16);
  const dv = new DataView(head.buffer);
  for (let i = 0; i < 4; i++) head[i] = 'SDIF'.charCodeAt(i);
  dv.setUint32(4, 8, false); dv.setUint32(8, 3, false); dv.setUint32(12, 1, false);
  const total = frames.reduce((a, f) => a + f.length, 0);
  const out = new Uint8Array(head.length + total);
  out.set(head, 0);
  let off = head.length;
  frames.forEach((f) => { out.set(f, off); off += f.length; });
  return out;
}

/* 一段两帧的 1TRC：分音 1、2 在两帧里都有，分音 3 只在第二帧 */
const SAMPLE = writeSDIF([
  writeFrame('1TRC', 0.0, [writeMatrix('1TRC', '1TRC', 2, 4, [1, 440, 0.5, 0, 2, 880, 0.25, 0])]),
  writeFrame('1TRC', 0.01, [writeMatrix('1TRC', '1TRC', 3, 4, [1, 442, 0.4, 0, 2, 884, 0.2, 0, 3, 1320, 0.1, 0])])
]);

console.log('SDIF 核心测试');

/* ---------- 容器 ---------- */

ok('拒绝非 SDIF 文件', () => {
  assert.throws(() => S.parseSDIF(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17])), /不是 SDIF/);
});

ok('解析帧与矩阵结构', () => {
  const p = S.parseSDIF(SAMPLE);
  assert.equal(p.types['1TRC'], 2);
  assert.equal(p.frames.length, 2);
  assert.equal(p.frames[0].matrices.length, 1);
  assert.equal(p.frames[0].matrices[0].rows, 2);
  assert.equal(p.frames[0].matrices[0].cols, 4);
  close(p.frames[0].time, 0, 1e-9);
  close(p.frames[1].time, 0.01, 1e-9);
  assert.equal(p.trailing, 0);
});

ok('数值按行主序还原', () => {
  const m = S.parseSDIF(SAMPLE).frames[1].matrices[0];
  assert.equal(m.data.length, 3);
  close(m.data[0][0], 1, 1e-6);
  close(m.data[0][1], 442, 1e-3);
  close(m.data[2][2], 0.1, 1e-7);
});

ok('帧间隔取相邻时间的中位数', () => {
  close(S.frameInterval(S.parseSDIF(SAMPLE)), 0.01, 1e-9);
});

/* ---------- 分音轨迹 ---------- */

ok('按序号累积成分音轨迹', () => {
  const tracks = S.partialTracks(S.parseSDIF(SAMPLE));
  assert.equal(tracks.length, 3);
  const t1 = tracks.find((t) => t.index === 1);
  assert.deepEqual(t1.times, [0, 0.01]);
  close(t1.meanFreq, 441, 0.01);
  close(t1.maxAmp, 0.5, 1e-6);
  assert.equal(t1.start, 0);
  close(t1.end, 0.01, 1e-9);
  /* 只在第二帧出现的分音 3，时长应为 0 */
  const t3 = tracks.find((t) => t.index === 3);
  close(t3.end - t3.start, 0, 1e-9);
});

ok('振幅门限能滤掉弱分音', () => {
  const all = S.partialTracks(S.parseSDIF(SAMPLE));
  const strong = S.partialTracks(S.parseSDIF(SAMPLE), { minAmp: 0.3 });
  assert.equal(all.length, 3);
  assert.equal(strong.length, 1);
  assert.equal(strong[0].index, 1);
});

ok('轨迹 → 音符，按振幅取前 N 个', () => {
  const tracks = S.partialTracks(S.parseSDIF(SAMPLE));
  const notes = S.tracksToNotes(tracks, { maxNotes: 2 });
  assert.equal(notes.length, 2);
  assert.equal(notes[0].index, 1, '振幅最大的应当排进来');
  assert.ok(notes.every((n) => n.freq > 0 && n.dur >= 0));
});

/* ---------- 帧切片 ---------- */

ok('帧切片：每帧一个和弦', () => {
  const chords = S.frameChords(S.parseSDIF(SAMPLE));
  assert.equal(chords.length, 2);
  assert.equal(chords[0].partials.length, 2);
  assert.equal(chords[1].partials.length, 3);
  /* 按振幅降序 */
  assert.ok(chords[1].partials[0].amp >= chords[1].partials[1].amp);
});

ok('切片转成谱面列（音高用 MIDI）', () => {
  const moments = S.frameChordsToMoments(S.frameChords(S.parseSDIF(SAMPLE)));
  assert.equal(moments.length, 2);
  close(moments[0].midis[0], S.freqToMidi(440), 1e-9);
});

/* ---------- 音符 → 和弦列 ---------- */

ok('起点相同的音并成一列，可吸附网格', () => {
  const notes = [
    { freq: 440, onset: 0.001, dur: 1, amp: 1, index: 1 },
    { freq: 660, onset: 0.002, dur: 1, amp: 1, index: 2 },
    { freq: 880, onset: 0.51, dur: 1, amp: 1, index: 3 }
  ];
  const raw = S.notesToMoments(notes, {});
  assert.equal(raw.length, 3, '不吸附时三个起点各自成列');
  const snapped = S.notesToMoments(notes, { gridSeconds: 0.25 });
  assert.equal(snapped.length, 2, '吸附到 0.25 s 后前两个并成一列');
  assert.equal(snapped[0].freqs.length, 2);
});

/* ---------- 音高换算 ---------- */

ok('频率 ↔ MIDI 与音名', () => {
  close(S.freqToMidi(440), 69, 1e-9);
  close(S.midiToFreq(69), 440, 1e-9);
  assert.equal(S.snapFreq(440).name, 'A4');
  close(S.snapFreq(440).cents, 0, 1e-6);
  /* 比 A4 高四分之一音 */
  const q = S.snapFreq(440 * Math.pow(2, 0.25 / 12));
  assert.equal(q.name, 'A4');
  close(q.cents, 25, 1e-6);
});

/* ---------- 渲染与导出 ---------- */

console.log('\n慢速回放的数据准备');

ok('轨迹按时间断口切成多段', () => {
  /* 序号 1 出现两段：0–0.02 与 0.5–0.52，中间空档 0.48 s */
  const track = {
    index: 1,
    times: [0, 0.01, 0.02, 0.5, 0.51, 0.52],
    freqs: [440, 441, 442, 880, 881, 882],
    amps: [0.5, 0.5, 0.4, 0.3, 0.3, 0.2]
  };
  const segs = S.trackSegments([track], { gapSeconds: 0.03 });
  assert.equal(segs.length, 2, '应当切成两段');
  assert.equal(segs[0].index, 1);
  close(segs[0].start, 0, 1e-9);
  close(segs[1].start, 0.5, 1e-9);
  /* 段尾要补一个淡出点（振幅 0） */
  const tail = segs[0].points[segs[0].points.length - 1];
  close(tail.a, 0, 1e-9);
});

ok('段内抽稀：按 stepSeconds 丢点，首尾保留', () => {
  const n = 100;
  const track = {
    index: 2,
    times: Array.from({ length: n }, (_, i) => i * 0.001),
    freqs: Array.from({ length: n }, () => 660),
    amps: Array.from({ length: n }, () => 0.2)
  };
  const fine = S.trackSegments([track], { stepSeconds: 0.001 });
  const coarse = S.trackSegments([track], { stepSeconds: 0.02 });
  assert.ok(fine[0].points.length > coarse[0].points.length);
  assert.ok(coarse[0].points.length < 20, '0.02 秒一个点，100 个点应当被抽到 10 个上下');
  close(coarse[0].points[0].t, 0, 1e-9);
});

ok('段峰值用于挑选发声声部', () => {
  const mk = (a) => ({ index: 1, times: [0, 0.01], freqs: [440, 440], amps: [a, a * 0.5] });
  const segs = S.trackSegments([mk(0.2), mk(0.8)], {});
  const peaks = segs.map(S.segmentPeak).sort((x, y) => y - x);
  close(peaks[0], 0.8, 1e-6);
  close(peaks[1], 0.2, 1e-6);
});

ok('频谱图带播放头且默认隐藏', () => {
  const svg = S.renderSpectrumSVG(S.partialTracks(S.parseSDIF(SAMPLE)), {});
  assert.ok(svg.includes('class="playhead"'), '应当有播放头元素');
  assert.ok(/class="playhead"[^>]*opacity="0"/.test(svg), '默认应当隐藏');
});

ok('频谱图可生成且无 NaN', () => {
  const tracks = S.partialTracks(S.parseSDIF(SAMPLE));
  const svg = S.renderSpectrumSVG(tracks, {});
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.endsWith('</svg>'));
  assert.ok(!svg.includes('NaN'));
});

ok('没有分音数据时频谱图也给得出提示', () => {
  assert.ok(S.renderSpectrumSVG([], {}).includes('没有 1TRC 分音数据'));
});

ok('MIDI 导出：头、事件数、结束标记', () => {
  const notes = S.tracksToNotes(S.partialTracks(S.parseSDIF(SAMPLE)), {});
  const out = S.buildNotesMidi(notes, { bpm: 120 });
  const b = out.bytes;
  assert.deepEqual(Array.from(b.slice(0, 4)), [0x4D, 0x54, 0x68, 0x64]);
  assert.deepEqual(Array.from(b.slice(14, 18)), [0x4D, 0x54, 0x72, 0x6B]);
  assert.deepEqual(Array.from(b.slice(-3)), [0xFF, 0x2F, 0x00]);
  assert.equal(out.eventCount, notes.length);
});

/* ---------- 交叉验证：OM 自带的真实样例 ---------- */

const OM_DIR = '/Applications/OM 8.0.app/Contents/Resources/in-files/';
const realFiles = [
  { file: 'africa.trc.sdif', tracks: 127, expectFreq: [150, 2700] },
  { file: 'file01.sdif', tracks: 20, expectFreq: [250, 11000] }
];

console.log('\n真实样例（OM 8.0 自带）');

if (!existsSync(OM_DIR)) {
  console.log('  （本机没有 OM 8.0，跳过）');
} else {
  realFiles.forEach((spec) => {
    ok(spec.file, () => {
      const parsed = S.parseSDIF(readFileSync(OM_DIR + spec.file));
      const tracks = S.partialTracks(parsed);
      const sum = S.summarize(parsed, tracks);
      assert.equal(sum.trackCount, spec.tracks, '轨迹条数');
      assert.ok(sum.freqLow >= spec.expectFreq[0] && sum.freqHigh <= spec.expectFreq[1],
        `频率范围 ${sum.freqLow}–${sum.freqHigh} 超出预期`);
      assert.ok(sum.duration > 0.1 && sum.duration < 600, '时长 ' + sum.duration);
      /* 所有行都应当是合理的（序号正整数、频率在音频范围、振幅非负） */
      tracks.forEach((t) => {
        assert.ok(t.index >= 1);
        t.freqs.forEach((f) => assert.ok(f > 10 && f < 25000, '频率 ' + f));
        t.amps.forEach((a) => assert.ok(a >= 0 && a < 1e6, '振幅 ' + a));
      });
    });
  });

  ok('file01 的分音是谐波列（4:5:7 倍）', () => {
    const tracks = S.partialTracks(S.parseSDIF(readFileSync(OM_DIR + 'file01.sdif')));
    const f0 = 394.4;
    const found = tracks.filter((t) => Math.abs(t.meanFreq / f0 - Math.round(t.meanFreq / f0)) < 0.05);
    assert.ok(found.length >= 5, '应当有多个音落在同一个基音的整数倍上，实际 ' + found.length);
  });

  ok('1MRK 文件能解出带起止的音符', () => {
    const parsed = S.parseSDIF(readFileSync(OM_DIR + 'africa.cs.sdif'));
    const notes = S.markerNotes(parsed);
    assert.ok(notes.length > 50, '音符数 ' + notes.length);
    assert.ok(notes.every((n) => n.freq > 0 && n.dur >= 0));
    assert.ok(notes.some((n) => n.dur > 0), '应当有带时长的音');
  });
}

console.log('\n全部通过：' + passed + ' 项');
