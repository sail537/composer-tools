/* ============================================================
   记谱语义校验：把全局量化器生成的 ABC 交回 abcjs 解析，
   按连音括号还原每个音的真实时长，再和原始节奏逐点比对。

   为什么需要它：abcjs 的 (P:... 在 P ≥ 10 时【不报错、不警告，
   直接把整组当普通时值】，肉眼也看不出。所以记谱正确性必须自己验。

   运行：node tools/test-notation-semantics.mjs
   ============================================================ */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const C = require('./rhythm-interp-core.js');
const abcjs = require('./vendor/abcjs/abcjs-basic-min.js');

/* 解析 ABC → 每个音符符号的起点与真实时长（含连音缩放） */
function readNotation(abc) {
  const warnings = [];
  const tune = abcjs.parseOnly(abc, { warningsCallback: (x) => warnings.push(x) })[0];
  if (!tune) return { warnings: warnings.concat('解析失败'), onsets: [], total: 0, count: 0 };
  /* 时间轴要按【全部】音符元素累计（含休止），只在发声点记个数；
     否则跳过休止会让后面所有起点整体前移。 */
  const all = [];
  tune.lines.forEach((line) => line.staff.forEach((staff) => staff.voices.forEach((voice) => {
    voice.forEach((el) => { if (el.el_type === 'note') all.push(el); });
  })));
  let multiplier = 1;
  let remaining = 0;
  let time = 0;
  const onsets = [];
  all.forEach((el) => {
    if (el.startTriplet) {
      multiplier = el.tripletMultiplier != null ? el.tripletMultiplier : 1;
      remaining = el.tripletR != null ? el.tripletR : el.startTriplet;
    }
    if (!el.rest) { onsets.push(time); }
    time += el.duration * multiplier;
    if (remaining > 0) {
      remaining -= 1;
      if (remaining === 0) multiplier = 1;
    }
  });
  return { warnings, onsets, total: time, count: onsets.length, elementCount: all.length };
}

const EPS = 1e-6;
let passed = 0;
let failed = 0;

/* 量化结果的记谱总时长（含连音缩放） */
function quantizedTotal(q) {
  let t = 0;
  (q.groups || []).forEach((g) => {
    const scale = g.kind === 'bracket' ? g.Q / g.P : 1;
    g.symbols.forEach((s) => { t += s.value * scale; });
  });
  return t;
}

/* 谱面应有的总时长：量化后的时长 + 补齐到整小节（补末小节休止） */
function expectedStaffTotal(q, meter) {
  const barLength = C.parseMeter(meter).barLength;
  return Math.ceil(quantizedTotal(q) / barLength - 1e-9) * barLength;
}

function check(label, durations, options) {
  const step = {
    durations,
    onsets: C.durationsToOnsets(durations),
    total: C.totalDuration(durations)
  };
  const opts = Object.assign({ minValue: 1 / 16, preferTuplets: false }, options || {});
  const quantized = C.quantizeNotation(step, opts);
  const abc = C.abcFromQuantized(quantized, opts);
  const read = readNotation(abc);
  const body = abc.split('\n').filter((line) => line && !/^[A-Z]:/.test(line)).join(' ');

  const problems = [];
  if (read.warnings.length) problems.push('abcjs 警告：' + read.warnings.join('; '));
  /* 每个原始起点都要有一个记谱起点落在量化误差之内 */
  step.onsets.forEach((onset) => {
    const hit = read.onsets.some((other) => Math.abs(other - onset) <= quantized.maxError + EPS);
    if (!hit) problems.push('起点 ' + onset.toFixed(5) + ' 丢失');
  });
  /* 量化本身不能偏离真实时长超过自报误差 */
  if (Math.abs(quantizedTotal(quantized) - step.total) > quantized.maxError + EPS) {
    problems.push('量化偏差 ' + (quantizedTotal(quantized) - step.total).toFixed(5)
      + ' > 自报误差 ' + quantized.maxError.toFixed(5));
  }
  /* 谱面总时长应当是量化时长补齐到整小节（末小节补休止） */
  const expected = expectedStaffTotal(quantized, opts.meter);
  if (Math.abs(read.total - expected) > EPS) {
    problems.push('谱面总时长 ' + read.total.toFixed(5) + ' != 预期 ' + expected.toFixed(5));
  }
  /* 延音线的不变量：谱面上的发声点数 = 原起点数 + 延音线条数。
     少一条线意味着两个音被错误地并成一个（或相反），多一条意味着凭空切开。 */
  const bodyText = abc.split('\n').filter((l) => l && !/^[A-Z]:/.test(l) && !/^%%/.test(l)).join(' ');
  const dashes = (bodyText.match(/-/g) || []).length;
  if (read.onsets.length !== step.onsets.length + dashes) {
    problems.push('发声点数 ' + read.onsets.length + ' != 起点数 ' + step.onsets.length
      + ' + 延音线 ' + dashes);
  }

  if (problems.length) {
    failed += 1;
    console.log('  ✗ ' + label + '  ' + body);
    problems.forEach((p) => console.log('      ' + p));
  } else {
    passed += 1;
    console.log('  ✓ ' + label.padEnd(18) + ' ' + body.padEnd(46)
      + ' 误差≤' + quantized.maxError.toFixed(5));
  }
}

console.log('记谱语义校验（abcjs 回读）');
check('三个均等三连音', [1 / 12, 1 / 12, 1 / 12]);
check('三连音里夹四分', [1 / 6, 1 / 12]);
check('五连音', Array(5).fill(1 / 20));
check('七连音', Array(7).fill(1 / 28));
check('九连音', Array(9).fill(1 / 18));
check('十二个三连音八分', Array(12).fill(1 / 12));
check('普通二分+四分', [1 / 2, 1 / 4, 1 / 4]);
check('附点八分', [3 / 16, 1 / 16]);
check('跨小节长音', [3 / 4, 3 / 4]);
check('跨小节三连音', [1 / 3, 1 / 3, 1 / 3]);
check('密集十六分', Array(8).fill(1 / 16));
check('复合拍二连音', [3 / 16, 3 / 16], { preferTuplets: true, tuplets: [[2, 3], [3, 2]], meter: [6, 8] });
check('五连音值 1/10+3/20', [0.1, 0.15, 0.075]);
check('1/3 与 1/6 混合', [1 / 3, 1 / 6, 1 / 6]);
check('6/8 三连音', Array(6).fill(1 / 12), { meter: [6, 8] });
check('3/4 跨小节长音', [1 / 2, 1 / 2], { meter: [3, 4] });
check('孤立 1/12 退回网格', [1 / 16, 1 / 12, 1 / 16]);

/* ---------- 音值组合法 ---------- */

check('组合法：跨单位拍要拆', [1 / 16, 1 / 16, 1 / 16, 2 / 16, 1 / 16, 1 / 16, 1 / 16, 1 / 2]);
check('组合法：弱位起的跨拍', [1 / 4, 3 / 8, 3 / 8]);
check('组合法：第2拍上的二分', [1 / 4, 1 / 2, 1 / 4]);
check('组合法：强位起的附点二分', [3 / 4, 1 / 4]);
check('组合法：3/4 第2拍上的二分', [1 / 4, 1 / 2], { meter: [3, 4] });
check('组合法：12/8 半分点', [3 / 8, 3 / 8, 3 / 4], { meter: [12, 8] });

/* ---------- 休止符 ---------- */

function checkRest(label, durations, rests, options) {
  const step = {
    durations,
    onsets: C.durationsToOnsets(durations),
    total: C.totalDuration(durations),
    rests
  };
  const opts = Object.assign({ minValue: 1 / 16 }, options || {});
  const q = C.quantizeNotation(step, opts);
  const abc = C.abcFromQuantized(q, opts);
  const read = readNotation(abc);
  const body = abc.split('\n').filter((line) => line && !/^[A-Z%]/.test(line)).join(' ');
  const sounding = step.onsets.filter((o, i) => !rests[i]);
  const problems = [];
  if (read.warnings.length) problems.push('abcjs 警告：' + read.warnings.join('; '));
  if (!abc.includes('z')) problems.push('谱面上没有休止符');
  /* 发声点必须都在；休止的位置不该出现发声点 */
  sounding.forEach((o) => {
    if (!read.onsets.some((x) => Math.abs(x - o) <= q.maxError + EPS)) {
      problems.push('发声点 ' + o.toFixed(5) + ' 丢失');
    }
  });
  rests.forEach((isRest, i) => {
    if (!isRest) return;
    if (read.onsets.some((x) => Math.abs(x - step.onsets[i]) < 1e-9)) {
      problems.push('休止位置 ' + step.onsets[i].toFixed(5) + ' 被算成了发声点');
    }
  });
  if (problems.length) {
    failed += 1;
    console.log('  ✗ ' + label + '  ' + body);
    problems.forEach((p) => console.log('      ' + p));
  } else {
    passed += 1;
    console.log('  ✓ ' + label.padEnd(18) + ' ' + body.padEnd(46) + ' 误差≤' + q.maxError.toFixed(5));
  }
}

checkRest('休止：八分休止', [1 / 4, 1 / 8, 1 / 8, 1 / 2], [false, true, false, false]);
checkRest('休止：整拍休止', [1 / 4, 1 / 2, 1 / 4], [false, true, false]);

/* ---------- 多声部 ---------- */

function checkMulti(label, durationsList, options) {
  const opts = Object.assign({ minValue: 1 / 16 }, options || {});
  const steps = durationsList.map((d) => ({
    durations: d, onsets: C.durationsToOnsets(d), total: C.totalDuration(d)
  }));
  const quantized = steps.map((s) => C.quantizeNotation(s, opts));
  const abc = C.abcFromQuantizedMulti(quantized, opts);
  const warnings = [];
  const tune = abcjs.parseOnly(abc, { warningsCallback: (x) => warnings.push(x) })[0];
  const problems = [];
  if (warnings.length) problems.push('abcjs 警告：' + warnings.join('; '));
  const staves = tune && tune.lines[0] ? tune.lines[0].staff : [];
  if (staves.length !== steps.length) {
    problems.push('谱表数 ' + staves.length + ' != 声部数 ' + steps.length);
  }
  staves.forEach((staff, vi) => {
    /* 时间轴按全部音符元素累计（含休止），只在发声点记个数 */
    const all = staff.voices[0].filter((el) => el.el_type === 'note');
    const onsets = [];
    let t = 0;
    let mult = 1;
    let left = 0;
    all.forEach((el) => {
      if (el.startTriplet) { mult = el.tripletMultiplier != null ? el.tripletMultiplier : 1; left = el.tripletR; }
      if (!el.rest) onsets.push(t);
      t += el.duration * mult;
      if (left > 0) { left -= 1; if (left === 0) mult = 1; }
    });
    const want = steps[vi].onsets;
    const err = quantized[vi].maxError;
    want.forEach((o) => {
      if (!onsets.some((x) => Math.abs(x - o) <= err + EPS)) {
        problems.push('声部 ' + (vi + 1) + ' 起点 ' + o.toFixed(5) + ' 丢失');
      }
    });
    /* 延音线会让符号数多于发声点数，所以这里只查总时长要补齐到整小节 */
    const expected = expectedStaffTotal(quantized[vi], opts.meter);
    if (Math.abs(t - expected) > EPS) {
      problems.push('声部 ' + (vi + 1) + ' 谱面总时长 ' + t.toFixed(5) + ' != ' + expected.toFixed(5));
    }
  });
  if (problems.length) {
    failed += 1;
    console.log('  ✗ ' + label);
    console.log(abc.split('\n').map((l) => '      ' + l).join('\n'));
    problems.forEach((p) => console.log('      ' + p));
  } else {
    passed += 1;
    console.log('  ✓ ' + label.padEnd(18) + ' ' + (steps.length + ' 行谱表、'
      + steps.map((s, i) => s.onsets.length + '音').join('+') + '，零警告'));
  }
}

checkMulti('双声部总谱', [[1 / 8, 1 / 8, 1 / 4, 1 / 2], [1 / 16, 1 / 16, 1 / 16, 5 / 16]]);
checkMulti('三声部总谱', [[1 / 4, 1 / 4, 1 / 2], [1 / 8, 1 / 8, 1 / 4, 1 / 2], [1 / 2, 1 / 2]]);
checkMulti('双声部（复拍子）', [[3 / 16, 3 / 16], [1 / 8, 1 / 4]], { meter: [6, 8] });

console.log('\n通过 ' + passed + ' 项' + (failed ? '，失败 ' + failed + ' 项' : '，全部通过'));
assert.equal(failed, 0, '有记谱语义失败');
