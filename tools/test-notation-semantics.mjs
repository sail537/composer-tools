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
  const elements = [];
  tune.lines.forEach((line) => line.staff.forEach((staff) => staff.voices.forEach((voice) => {
    voice.forEach((el) => {
      /* 末小节补的休止符不是发声点，不参与起点比对 */
      if (el.el_type === 'note' && !el.rest) elements.push(el);
    });
  })));
  let multiplier = 1;
  let remaining = 0;
  let time = 0;
  const onsets = [];
  elements.forEach((el) => {
    if (el.startTriplet) {
      multiplier = el.tripletMultiplier != null ? el.tripletMultiplier : 1;
      remaining = el.tripletR != null ? el.tripletR : el.startTriplet;
    }
    onsets.push(time);
    time += el.duration * multiplier;
    if (remaining > 0) {
      remaining -= 1;
      if (remaining === 0) multiplier = 1;
    }
  });
  /* 总时长要把休止算进去，否则补休止后总长对不上 */
  const allElements = [];
  tune.lines.forEach((line) => line.staff.forEach((staff) => staff.voices.forEach((voice) => {
    voice.forEach((el) => { if (el.el_type === 'note') allElements.push(el); });
  })));
  return { warnings, onsets, total: time, count: elements.length, elementCount: allElements.length };
}

const EPS = 1e-6;
let passed = 0;
let failed = 0;

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
  /* 记谱总时长与真实总时长之差不得超过自报误差 */
  if (Math.abs(read.total - step.total) > quantized.maxError + EPS) {
    problems.push('总时长偏差 ' + (read.total - step.total).toFixed(5) + ' > 自报误差 ' + quantized.maxError.toFixed(5));
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

console.log('\n通过 ' + passed + ' 项' + (failed ? '，失败 ' + failed + ' 项' : '，全部通过'));
assert.equal(failed, 0, '有记谱语义失败');
