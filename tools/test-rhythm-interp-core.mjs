import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const C = require('./rhythm-interp-core.js');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('  ✓ ' + name);
}
function close(a, b, eps = 1e-9) {
  assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
}

console.log('节奏插值核心测试');

ok('解析分数与小数', () => {
  assert.deepEqual(C.parseRhythm('1/8 1/8 1/4 1/2'), [0.125, 0.125, 0.25, 0.5]);
  assert.deepEqual(C.parseRhythm('0.25, 0.5 1'), [0.25, 0.5, 1]);
  assert.throws(() => C.parseRhythm('0 -1'));
});

ok('曲线权重与 OM 一致', () => {
  close(C.curveWeight(0.5, 1), Math.pow(0.5, Math.exp(-1)), 1e-12);
  close(C.curveWeight(0.5, -1), Math.pow(0.5, Math.exp(1)), 1e-12);
});

ok('逐项时值：线性插值', () => {
  const r = C.interpolateRhythm([1, 1], [0.5, 0.5], 3, 0, 'dx');
  assert.deepEqual(r.steps.map(s => s.durations), [[1, 1], [0.75, 0.75], [0.5, 0.5]]);
  assert.deepEqual(r.steps.map(s => s.total), [2, 1.5, 1]);
  assert.deepEqual(r.steps[0].onsets, [0, 1]);
  assert.deepEqual(r.steps[1].onsets, [0, 0.75]);
});

ok('逐项时值：长度不同时报错', () => {
  assert.throws(() => C.interpolateRhythm([1], [0.5, 0.5], 3, 0, 'dx'));
});

ok('时间弯曲：1 个音 → 2 个音', () => {
  const r = C.interpolateRhythm([1], [0.5, 0.5], 3, 0, 'warp');
  const mid = r.steps[1];
  assert.equal(mid.durations.length, 2);
  close(mid.total, 1);
  close(mid.onsets[0], 0);
  close(mid.onsets[1], 0.5);
  close(mid.durations[0], 0.5);
  close(mid.durations[1], 0.5);
});

ok('时间弯曲：等长时也成立', () => {
  const r = C.interpolateRhythm([1, 1], [0.5, 0.5], 3, 0, 'warp');
  const mid = r.steps[1];
  close(mid.total, 1.5);
  close(mid.onsets[0], 0);
  close(mid.onsets[1], 0.75);
  close(mid.durations[0], 0.75);
  close(mid.durations[1], 0.75);
});

ok('所有中间状态的时值为正、起点递增', () => {
  const cases = [
    [1, 1],
    [0.5, 0.5]
  ];
  const r = C.interpolateRhythm([0.125, 0.125, 0.25, 0.5],
                                [0.0625, 0.0625, 0.0625, 0.3125],
                                7, -0.6, 'warp');
  r.steps.forEach(step => {
    assert.ok(step.durations.every(d => d > 0), '时值必须为正');
    for (let i = 1; i < step.onsets.length; i++) {
      assert.ok(step.onsets[i] > step.onsets[i - 1], '起点必须递增');
    }
    close(step.onsets[0], 0);
    close(step.durations.reduce((s, d) => s + d, 0), step.total, 1e-9);
  });
});

ok('时间线 SVG 可生成且无 NaN', () => {
  const r = C.interpolateRhythm([1, 1], [0.5, 0.5], 4, 0.5, 'warp');
  const svg = C.renderTimelineSVG(r, { dark: true });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('</svg>'));
  assert.ok(!svg.includes('NaN'));
  assert.ok((svg.match(/<rect/g) || []).length >= 4);
});

ok('量化：1/16 网格', () => {
  const r = C.interpolateRhythm([0.125, 0.125, 0.25, 0.5],
                                [0.0625, 0.0625, 0.0625, 0.3125],
                                2, 0, 'dx');
  const q = C.quantizeStep(r.steps[0], 1 / 16);
  assert.deepEqual(q.events.map(e => e.units), [2, 2, 4, 8]);
  assert.equal(q.totalUnits, 16);
  close(q.events.reduce((s, e) => s + e.duration, 0), 1, 1e-9);
});

ok('ABC：普通节奏（自动选 L）', () => {
  const step = { onsets: [0, 1 / 8, 1 / 4, 1 / 2],
                 durations: [1 / 8, 1 / 8, 1 / 4, 1 / 2], total: 1 };
  const abc = C.stepToABC(step, { minValue: 1 / 16, title: '#1' });
  assert.ok(abc.includes('L:1/8'));
  assert.ok(abc.includes('K:C clef=perc'));
  assert.ok(abc.includes('B B B2 B4'));
});

ok('ABC：三连音八分（(3 + 写成八分）', () => {
  const step = { onsets: [0, 1 / 12, 1 / 6, 1 / 4],
                 durations: [1 / 12, 1 / 12, 1 / 12, 1 / 4], total: 1 / 2 };
  const abc = C.stepToABC(step, { minValue: 1 / 16, title: 'triplet' });
  assert.ok(abc.includes('L:1/8'));
  assert.ok(abc.includes('(3B B B'));
  assert.ok(abc.includes('B2'));
});

ok('ABC：三连音十六分（(3 + 写成十六分）', () => {
  const step = { onsets: [0, 1 / 24, 1 / 12, 1 / 8],
                 durations: [1 / 24, 1 / 24, 1 / 24, 1 / 8], total: 1 / 4 };
  const abc = C.stepToABC(step, { minValue: 1 / 16, title: 'triplet16' });
  assert.ok(abc.includes('L:1/16'));
  assert.ok(abc.includes('(3B B B'));
  assert.ok(abc.includes('B2'));
});

function stepFrom(durations) {
  return {
    onsets: C.durationsToOnsets(durations),
    durations: durations,
    total: C.totalDuration(durations)
  };
}

ok('连音比例：解析 3:2,5:4,7:4', () => {
  assert.deepEqual(C.parseTuplets('3:2, 5:4;7:4、9:8'), [[3, 2], [5, 4], [7, 4], [9, 8]]);
  assert.deepEqual(C.parseTuplets('乱写'), C.DEFAULT_TUPLETS);
});

ok('ABC：五连音 5:4（写成十六分）', () => {
  const step = stepFrom([1 / 20, 1 / 20, 1 / 20, 1 / 20, 1 / 20, 1 / 4]);
  const abc = C.stepToABC(step, { minValue: 1 / 16, title: 'quintuplet' });
  assert.ok(abc.includes('L:1/16'), abc);
  assert.ok(abc.includes('(5:4B B B B B'), abc);
  assert.ok(abc.includes('B4'), abc);
});

ok('ABC：七连音 7:4', () => {
  const step = stepFrom([1 / 28, 1 / 28, 1 / 28, 1 / 28, 1 / 28, 1 / 28, 1 / 28, 1 / 4]);
  const abc = C.stepToABC(step, { minValue: 1 / 16, title: 'septuplet' });
  assert.ok(abc.includes('L:1/16'), abc);
  assert.ok(abc.includes('(7:4B B B B B B B'), abc);
});

ok('ABC：二连音 2:3（复合拍，开启连音优先）', () => {
  const step = stepFrom([3 / 16, 3 / 16]);
  const abc = C.stepToABC(step, {
    minValue: 1 / 16, tuplets: [[2, 3]], preferTuplets: true, title: 'duplet'
  });
  assert.ok(abc.includes('L:1/8'), abc);
  assert.ok(abc.includes('(2:3B B'), abc);
});

ok('ABC：默认优先标准音符值（3/16 读作附点八分而非二连音）', () => {
  const step = stepFrom([3 / 16, 3 / 16]);
  const abc = C.stepToABC(step, { minValue: 1 / 16, tuplets: [[2, 3]], title: 'dotted' });
  assert.ok(!abc.includes('(2'), abc);
  assert.ok(abc.includes('B3 B3'), abc);
});

ok('ABC：九连音 9:8（1/18 无法写成标准音符）', () => {
  const step = stepFrom([1 / 18, 1 / 18, 1 / 18, 1 / 18, 1 / 18, 1 / 18, 1 / 18, 1 / 18, 1 / 18]);
  const abc = C.stepToABC(step, { minValue: 1 / 16, title: 'nine' });
  assert.ok(abc.includes('L:1/16'), abc);
  assert.ok(abc.includes('(9:8B B B B B B B B B'), abc);
});

ok('ABC：六个等值音 = 两组三连音（不是 5:4 + 散音）', () => {
  const step = stepFrom([1 / 24, 1 / 24, 1 / 24, 1 / 24, 1 / 24, 1 / 24]);
  const abc = C.stepToABC(step, { minValue: 1 / 16, title: 'six' });
  assert.ok(abc.includes('(3B B B (3B B B'), abc);
});

ok('连音表可收紧：只允许 3:2 时五连音不再被识别', () => {
  const step = stepFrom([1 / 20, 1 / 20, 1 / 20, 1 / 20, 1 / 20, 1 / 4]);
  const abc = C.stepToABC(step, { minValue: 1 / 16, tuplets: [[3, 2]], title: 'strict' });
  assert.ok(!abc.includes('(5'), abc);
  /* 五连音被禁 → 退回最近的标准音符值（1/16），不再标成连音 */
  assert.ok(abc.includes('B B B B B'), abc);
});

/* ---------- 引擎 2：全局量化器 ---------- */

console.log('\n全局量化器');

ok('比例一律约分：12:8 → 3:2', () => {
  assert.deepEqual(C.reduceRatio(12, 8), [3, 2]);
  assert.deepEqual(C.reduceRatio(9, 8), [9, 8]);
  /* P > 9 的层不生成：abcjs 的 (P: 只认个位数，P≥10 会被静默忽略 */
  const layers = C.makeNotationLayers(1 / 16, [[11, 8], [13, 8], [3, 2]]);
  assert.ok(layers.every(l => l.P <= 9), JSON.stringify(layers.filter(l => l.P > 9)));
  assert.ok(layers.some(l => l.P === 3 && l.Q === 2));
});

ok('网格细到 minValue/2：附点值不必借连音', () => {
  /* 3/32 = 附点十六分，minValue=1/16 时应当是「一个附点十六分」而不是连音 */
  const step = stepFrom([3 / 32, 3 / 32, 5 / 32, 13 / 32]);
  const q = C.quantizeNotation(step, { minValue: 1 / 16 });
  const abc = C.abcFromQuantized(q, {});
  close(q.maxError, 0, 1e-12);
  assert.ok(!abc.includes('('), abc);
});

ok('混合时值连音：三连音里夹四分 → (3:2:2B2 B', () => {
  const step = stepFrom([1 / 6, 1 / 12]);
  const abc = C.stepToABCGlobal(step, { minValue: 1 / 16, title: 'mixed' });
  assert.ok(abc.includes('(3:2:2B2 B'), abc);
});

ok('跨小节长音：小节线上切开并加延音线', () => {
  const step = stepFrom([3 / 4, 3 / 4]);
  const abc = C.stepToABCGlobal(step, { minValue: 1 / 16, title: 'bar' });
  assert.ok(abc.includes('B3 B- | B2'), abc);
});

ok('总时长守恒：粗网格下也不丢时长（旧引擎会缩短）', () => {
  const durations = [7 / 64, 7 / 64, 13 / 64, 29 / 64];   /* 合计 56/64 = 7/8 */
  const step = stepFrom(durations);
  const q = C.quantizeNotation(step, { minValue: 1 / 16 });
  const notated = q.groups.reduce((sum, g) => sum + C.groupActual(g), 0);
  close(notated, C.totalDuration(durations), 1e-9);
});

ok('连音只做精确表达，不用于逼近', () => {
  /* 64 分网格的节奏在 1/16 网格上：应当老老实实网格化，而不是写 (9:8 硬凑 */
  const step = stepFrom([7 / 64, 7 / 64, 13 / 64, 29 / 64]);
  const abc = C.stepToABCGlobal(step, { minValue: 1 / 16, title: 'no fudge' });
  assert.ok(!abc.includes('('), abc);
});

ok('连音优先级开关：复合拍二连音', () => {
  /* 6/8 里两个附点八分占满一个附点拍（3/8）——这才是二连音的典型场合 */
  const step = stepFrom([3 / 16, 3 / 16]);
  const base = { minValue: 1 / 16, tuplets: [[2, 3], [3, 2]], meter: [6, 8] };
  const on = C.stepToABCGlobal(step, Object.assign({ preferTuplets: true }, base));
  assert.ok(on.includes('(2:3B B'), on);
});

ok('跨两拍的连音括号不如直接写音符（节拍对齐代价）', () => {
  /* 4/4 里两个附点四分＝两拍：写 B3 B3 比套一个跨两拍的括号规范 */
  const step = stepFrom([3 / 8, 3 / 8]);
  const abc = C.stepToABCGlobal(step, { minValue: 1 / 16, tuplets: [[2, 3], [3, 2]], preferTuplets: true });
  assert.ok(!abc.includes('('), abc);
  assert.ok(abc.includes('B3 B3'), abc);
});

/* ---------- 拍号与节拍层级 ---------- */

console.log('\n拍号与节拍层级');

ok('拍号解析：单拍子与复拍子', () => {
  const simple = C.parseMeter([4, 4]);
  close(simple.barLength, 1, 1e-12);
  close(simple.beatLength, 0.25, 1e-12);
  assert.equal(simple.compound, false);

  /* 复拍子按惯例把附点拍当一拍 */
  const compound = C.parseMeter([6, 8]);
  close(compound.barLength, 0.75, 1e-12);
  close(compound.beatLength, 0.375, 1e-12);
  assert.equal(compound.compound, true);

  /* 3/4 不算复拍子 */
  assert.equal(C.parseMeter([3, 4]).compound, false);
  assert.equal(C.parseMeter(null).num, 4);
});

ok('拍点对齐与跨拍计数', () => {
  close(C.beatMisalignment(0.25, 0.25), 0, 1e-9);
  close(C.beatMisalignment(0.375, 0.25), 0.5, 1e-9);
  assert.equal(C.beatsCrossed(0, 0.25, 0.25), 0);
  assert.equal(C.beatsCrossed(0, 0.5, 0.25), 1);
  assert.equal(C.beatsCrossed(0, 0.75, 0.25), 2);
});

ok('M: 行跟随拍号，小节线按拍号落', () => {
  /* 6/8：一小节 3/4。六个八分正好一小节 */
  const step = stepFrom(Array(6).fill(1 / 8));
  const abc = C.stepToABCGlobal(step, { minValue: 1 / 16, meter: [6, 8] });
  assert.ok(abc.includes('M:6/8'), abc);
  assert.ok(abc.includes('|]'), abc);
  /* 4/4 的同一串音应当跨到第二小节 */
  const four = C.stepToABCGlobal(step, { minValue: 1 / 16, meter: [4, 4] });
  assert.ok(four.includes('M:4/4'), four);
  assert.ok(four.includes('|'), four);
});

ok('孤立连音不再画单音符括号', () => {
  /* 1/16 与 1/12 混排：1/12 是孤立的，不该写成 (3:2:1B */
  const step = stepFrom([1 / 16, 1 / 12, 1 / 16]);
  const abc = C.stepToABCGlobal(step, { minValue: 1 / 16 });
  assert.ok(!abc.includes('(3:2:1'), abc);
  assert.ok(!abc.includes('('), abc);
});

ok('连音括号优先落在一拍之内', () => {
  /* 12 个三连音八分 = 4 拍：应当是四个「一拍一组」的括号 */
  const step = stepFrom(Array(12).fill(1 / 12));
  const abc = C.stepToABCGlobal(step, { minValue: 1 / 16 });
  assert.equal((abc.match(/\(3:2B B B/g) || []).length, 4, abc);
});

/* ---------- 末小节补休止 ---------- */

ok('末小节自动补休止填满小节', () => {
  const step = stepFrom([1 / 8, 1 / 8, 1 / 4]);   /* 合计 1/2，差一半才满 4/4 */
  const abc = C.stepToABCGlobal(step, { minValue: 1 / 16 });
  assert.ok(abc.includes('z'), '应当补出休止符：' + abc);
  /* 关掉补休止就不该出现 z */
  const raw = C.stepToABCGlobal(step, { minValue: 1 / 16, padFinalBar: false });
  assert.ok(!raw.includes('z'), raw);
});

ok('正好满小节时不补多余的休止', () => {
  const step = stepFrom([1 / 4, 1 / 4, 1 / 4, 1 / 4]);
  const abc = C.stepToABCGlobal(step, { minValue: 1 / 16 });
  assert.ok(!abc.includes('z'), abc);
});

/* ---------- MIDI 导出 ---------- */

console.log('\nMIDI 导出');

ok('生成的 MIDI 是合法 SMF：头、轨道、结束标记', () => {
  const step = stepFrom([1 / 4, 1 / 8, 1 / 8]);
  const out = C.buildRhythmMidi(step, { bpm: 120, meter: [4, 4] });
  const b = out.bytes;
  assert.deepEqual(Array.from(b.slice(0, 4)), [0x4D, 0x54, 0x68, 0x64], 'MThd');
  assert.deepEqual(Array.from(b.slice(14, 18)), [0x4D, 0x54, 0x72, 0x6B], 'MTrk');
  assert.equal(out.eventCount, 3);
  /* 末尾必须是 FF 2F 00 */
  assert.deepEqual(Array.from(b.slice(-3)), [0xFF, 0x2F, 0x00]);
});

ok('MIDI 的起点落在正确的 tick 上', () => {
  const step = stepFrom([1 / 4, 1 / 4, 1 / 2]);   /* 全音符 = 4×PPQ tick */
  const out = C.buildRhythmMidi(step, { bpm: 120 });
  const b = Array.from(out.bytes);
  /* 直接扫轨道里的 note-on（0x99 = 打击乐通道 9 的 note-on） */
  const ticks = [];
  let i = 22;          /* 跳过 14 字节 MThd + 8 字节 MTrk 头 */
  let t = 0;
  while (i < b.length - 3) {
    let delta = 0;
    while (b[i] & 0x80) { delta = (delta << 7) | (b[i] & 0x7F); i += 1; }
    delta = (delta << 7) | b[i];
    i += 1;
    t += delta;
    const status = b[i];
    if (status === 0xFF) {
      const type = b[i + 1];
      let len = 0;
      i += 2;
      while (b[i] & 0x80) { len = (len << 7) | (b[i] & 0x7F); i += 1; }
      len = (len << 7) | b[i];
      i += 1 + len;
      if (type === 0x2F) break;
      continue;
    }
    if ((status & 0xF0) === 0x90) {
      ticks.push(t);
      i += 3;
    } else if ((status & 0xF0) === 0x80) {
      i += 3;
    } else if ((status & 0xF0) === 0xC0) {
      i += 2;
    } else {
      break;
    }
  }
  /* 1/4 → 0 tick，第二个 1/4 → PPQ，1/2 → 2×PPQ */
  assert.deepEqual(ticks, [0, C.MIDI_PPQ, C.MIDI_PPQ * 2]);
});

ok('MIDI 也可导出成有音高的单通道', () => {
  const step = stepFrom([1 / 4, 1 / 4]);
  const out = C.buildRhythmMidi(step, { percussion: false, pitch: 62 });
  assert.ok(out.bytes.length > 40);
  const b = Array.from(out.bytes);
  assert.ok(b.includes(0x90), '应当有通道 0 的 note-on');
  assert.ok(b.includes(62), '应当带上指定的音高');
});

ok('括号最多覆盖 n 个书面单位（不写超大括号）', () => {
  /* 12 个三连音八分 = 四个 3:2 括号，而不是一个跨两拍的巨括号 */
  const step = stepFrom(Array(12).fill(1 / 12));
  const abc = C.stepToABCGlobal(step, { minValue: 1 / 16, title: 'groups' });
  assert.equal((abc.match(/\(3:2/g) || []).length, 4, abc);
  assert.ok(!abc.includes('(3:2:12'), abc);
});

console.log('\n全部通过：' + passed + ' 项');
