/* ============================================================
   虚拟基音核心测试

   除了常规断言，这里还有一项【独立于实现】的暴力属性校验：
   直接按 OM 原文的容差条件去网格扫描，验证算法返回的确实是
   商序最小的那个解，而不是自己证明自己。

   运行：node tools/test-virtualfund-core.mjs
   ============================================================ */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const C = require('./virtualfund-core.js');
const I = require('./interpolation-core.js');

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log('  ✓ ' + name);
}
function close(a, b, eps) {
  assert.ok(Math.abs(a - b) < (eps === undefined ? 1e-9 : eps), `${a} != ${b}`);
}

const C4 = 60, E4 = 64, G4 = 67;
const MAJOR = [C4, E4, G4];

console.log('虚拟基音核心测试');

/* ---------- 容差换算 ---------- */

ok('音分 ↔ 比例换算', () => {
  close(C.centsToRatio(1200), 1, 1e-12);
  close(C.centsToRatio(0), 0, 1e-12);
  close(C.ratioToCents(C.centsToRatio(50)), 50, 1e-9);
  /* 50 音分 ≈ 2.93% */
  close(C.centsToRatio(50), 0.029302, 1e-6);
});

/* ---------- tolerant-gcd 本体 ---------- */

ok('tolerant-gcd：精确谐波列返回基频', () => {
  const g = C.tolerantGCD([100, 200, 300], 0);
  close(g, 100, 1e-9);
});

ok('tolerant-gcd：容差内接受近似整数倍', () => {
  /* 101 / 200.5 相对 100 / 200 偏 1%，容差 2% 应当接受 */
  const g = C.tolerantGCD([101, 200.5], C.centsToRatio(35));
  assert.ok(g !== null, '应当有解');
  /* 结果必须真的让两个数都在容差内成为整数倍 */
  [101, 200.5].forEach((f) => {
    const q = Math.round(f / g);
    assert.ok(Math.abs(q * g / f - 1) <= C.centsToRatio(35) + 1e-12, `${f} 不满足容差`);
  });
});

ok('tolerant-gcd：无理比例下无解', () => {
  /* 整数总归有公约数（1 就是），所以必须用无理频率比才谈得上“无解”：
     三全音是 √2，十二平均律的大三度是 2^(1/3)，都不是有理数 */
  assert.equal(C.tolerantGCD([C4, 66].map((m) => I.midiToFreq(m)), 0), null);
});

ok('tolerant-gcd：节点预算能兜住病态输入', () => {
  const r = C.tolerantGCDDetailed([20, 21, 22, 23, 24, 25], C.centsToRatio(50), 5);
  assert.equal(r.exhausted, true);
  assert.equal(r.value, null);
});

/* ---------- 平均律的现实 ---------- */

ok('十二平均律和弦在 0 音分容差下无解', () => {
  const r = C.analyze(MAJOR, 0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-solution');
  assert.equal(r.fund, null);
});

ok('大三和弦 @50¢ → C2，泛音序号 4:5:6', () => {
  const r = C.analyze(MAJOR, 50);
  assert.equal(r.ok, true);
  /* 3606 音分上下 → MIDI 36.06，取整是 C2 */
  close(r.fund.midi, 36, 0.1);
  assert.equal(I.midiToName(Math.round(r.fund.midi)), 'C2');
  assert.deepEqual(r.partials.map((p) => p.n), [4, 5, 6]);
  assert.ok(r.maxCentsOff < 50, '最大偏差应当在容差内');
});

ok('虚基音永远不高于和弦最低音', () => {
  [0, 10, 25, 50, 75, 100, 150].forEach((cents) => {
    const r = C.analyze(MAJOR, cents);
    if (!r.ok) return;
    assert.ok(r.fund.midi <= C4 + cents / 100 + 1e-9,
      `容差 ${cents}¢ 时虚基音 ${r.fund.midi} 超过了最低音上界`);
  });
});

ok('容差越大，解不会更低（“取最高解”的直接后果）', () => {
  let last = -Infinity;
  for (let cents = 5; cents <= 100; cents += 5) {
    const r = C.analyze(MAJOR, cents);
    if (!r.ok) continue;
    assert.ok(r.fund.midi >= last - 1e-9,
      `容差 ${cents}¢ 的解 ${r.fund.midi} 比更小容差的解还低`);
    last = r.fund.midi;
  }
});

ok('谐波集合 C2 C3 G3 C4 E4 G4 B4 → C1', () => {
  const r = C.analyze([36, 48, 55, 60, 64, 67, 71], 50);
  assert.equal(r.ok, true);
  close(r.fund.midi, 24, 0.1);
  assert.equal(I.midiToName(Math.round(r.fund.midi)), 'C1');
});

ok('单音返回自身', () => {
  const r = C.analyze([C4], 50);
  assert.equal(r.ok, true);
  close(r.fund.midi, C4, 0.05);
  assert.deepEqual(r.partials.map((p) => p.n), [1]);
});

ok('极小容差会降到亚音基音，且被如实标出', () => {
  /* OM 的候选下界是 0.1 Hz，所以容差足够小时总能凑出一个“解”，
     泛音序号会大到没有音乐意义——这是忠实行为，核心必须标记出来 */
  const tight = C.analyze(MAJOR, 1);
  assert.equal(tight.ok, true);
  assert.equal(tight.audible, false);
  assert.ok(tight.fund.freq < C.MIN_AUDIBLE_HZ, '应当是亚音：' + tight.fund.freq);
  assert.ok(Math.max.apply(null, tight.partials.map((p) => p.n)) > 20, '泛音序号应当很大');

  const normal = C.analyze(MAJOR, 50);
  assert.equal(normal.audible, true);
  assert.ok(C.describe(tight).includes('亚音'));
});

ok('空和弦与坏容差不会抛异常', () => {
  assert.equal(C.analyze([], 50).reason, 'empty');
  assert.equal(C.analyze([C4, E4, G4], -5).ok, false);
  assert.equal(C.analyze([NaN, Infinity], 50).reason, 'empty');
});

/* ---------- 独立于实现的暴力属性校验 ---------- */

/* OM 原文的容差条件：存在整数 q 使 v/(1+r) ≤ q·g ≤ v(1+r) */
function feasible(freqs, g, ratio) {
  return freqs.every((f) => {
    const q = Math.round(f / g);
    if (q < 1) return false;
    return q * g >= f / (1 + ratio) - 1e-12 && q * g <= f * (1 + ratio) + 1e-12;
  });
}

function bruteForceCheck(chord, cents) {
  const r = C.analyze(chord, cents);
  const ratio = C.centsToRatio(cents);
  const freqs = chord.map((m) => I.midiToFreq(m));
  const lowest = Math.min(...freqs);
  const upper = lowest * (1 + ratio);

  assert.equal(feasible(freqs, r.fund.freq, ratio), true,
    `返回的 ${r.fund.freq.toFixed(3)} Hz 自己不满足容差条件`);

  /* 返回解对最低音的商，必须是所有可行解里最小的那个商 */
  const qReturned = Math.round(lowest / r.fund.freq);
  /* 只有 g ≥ lowest/((1+r)·(q-1+1)) 才可能给出更小的商，这一段密集扫描 */
  const lo = Math.max(C.MIN_CANDIDATE, lowest / ((1 + ratio) * (qReturned + 1)));
  const steps = 40000;
  for (let i = 0; i <= steps; i++) {
    const g = lo + (upper - lo) * (i / steps);
    if (!feasible(freqs, g, ratio)) continue;
    const q = Math.round(lowest / g);
    assert.ok(q >= qReturned,
      `在 ${g.toFixed(3)} Hz 存在商更小(${q} < ${qReturned})的可行解，说明返回的不是最高解`);
  }
}

ok('暴力校验：大三和弦（多档容差）', () => {
  [20, 35, 50, 75, 100].forEach((c) => bruteForceCheck(MAJOR, c));
});

ok('暴力校验：增三和弦', () => {
  [20, 50, 100].forEach((c) => bruteForceCheck([C4, E4, 68], c));
});

ok('暴力校验：三全音与音簇', () => {
  [20, 50].forEach((c) => bruteForceCheck([C4, 66], c));
  [40, 60].forEach((c) => bruteForceCheck([C4, 61, 62], c));
});

ok('核心契约：解出的每个音都真的落在容差内', () => {
  const chords = [];
  for (let a = 60; a <= 66; a++) {
    for (let b = a + 1; b <= 67; b++) {
      for (let c = b + 1; c <= 68; c++) chords.push([a, b, c]);
    }
  }
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 300; i++) {
    const set = new Set();
    while (set.size < 4) set.add(24 + Math.floor(rnd() * 84));
    chords.push([...set].sort((x, y) => x - y));
  }
  let cases = 0;
  let solved = 0;
  chords.forEach((ch) => {
    [0, 10, 25, 50, 75, 120].forEach((cents) => {
      const r = C.analyze(ch, cents);
      cases += 1;
      if (!r.ok) return;
      solved += 1;
      assert.ok(r.maxCentsOff <= cents + 1e-6,
        `和弦 ${ch} 在 ${cents}¢ 下给出越界解：最大偏差 ${r.maxCentsOff.toFixed(4)}¢`);
      r.partials.forEach((p) => {
        assert.ok(Number.isInteger(p.n) && p.n >= 1, `泛音序号必须是正整数：${p.n}`);
        close(p.idealFreq, p.n * r.fund.freq, 1e-9);
      });
    });
  });
  assert.ok(cases >= 1000, '用例数太少：' + cases);
  assert.ok(solved > cases / 2, '大多数用例本应有解');
});

/* ---------- 扫描与渲染 ---------- */

ok('精度扫描：步长与点数正确', () => {
  const sweep = C.virtualFundSweep(MAJOR, 0, 100, 5);
  assert.equal(sweep.length, 21);
  close(sweep[0].cents, 0, 1e-9);
  close(sweep[20].cents, 100, 1e-9);
  assert.equal(sweep[0].ok, false, '0¢ 应当无解');
  assert.ok(sweep.some((s) => s.ok), '扫描中应当有解');
});

ok('扫描曲线的平段与跳变都能被捕捉', () => {
  const sweep = C.virtualFundSweep(MAJOR, 0, 100, 1);
  const values = new Set(sweep.filter((s) => s.ok).map((s) => Math.round(s.midi)));
  assert.ok(values.size >= 2, '容差变化时答案应当发生过跳变：' + [...values].join(','));
});

ok('扫描曲线 SVG 可生成且无 NaN', () => {
  const sweep = C.virtualFundSweep(MAJOR, 0, 100, 2);
  const svg = C.renderSweepSVG(sweep, { dark: false });
  assert.ok(svg.startsWith('<svg'), '应当是 SVG');
  assert.ok(!svg.includes('NaN'), 'SVG 里不该出现 NaN');
  assert.ok(svg.includes('</svg>'));
});

ok('无解与空输入的 SVG 不炸', () => {
  assert.ok(C.renderSweepSVG([], {}).includes('没有数据'));
  assert.ok(C.renderSweepSVG(C.virtualFundSweep(MAJOR, 0, 0, 1), {}).includes('无解'));
});

ok('扫描图默认隐藏亚音解，并如实计数', () => {
  const sweep = C.virtualFundSweep(MAJOR, 0, 100, 1);
  const hiddenCount = sweep.filter((s) => s.ok && !s.audible).length;
  assert.ok(hiddenCount > 0, '这一档容差下应当存在亚音解');
  const svg = C.renderSweepSVG(sweep, {});
  assert.ok(svg.includes('已隐藏 ' + hiddenCount + ' 个'), svg.slice(0, 0) + '未标注隐藏数量');
  /* 关掉阈值就应当全部画出来 */
  const all = C.renderSweepSVG(sweep, { minFreq: 0 });
  assert.ok(!all.includes('已隐藏'), '不设阈值时不该有隐藏提示');
});

ok('泛音序列从基音起按整数倍展开', () => {
  const series = C.harmonicSeries(36, 8);
  assert.equal(series[0].n, 1);
  close(series[0].midi, 36, 1e-9);
  /* 第 2、4、8 号泛音是纯八度 */
  close(series[1].midi, 48, 1e-9);
  close(series[3].midi, 60, 1e-9);
  close(series[7].midi, 72, 1e-9);
});

ok('文本报告可读且不抛异常', () => {
  assert.ok(C.describe(C.analyze(MAJOR, 50)).includes('虚基音'));
  assert.ok(C.describe(C.analyze(MAJOR, 0)).includes('无解'));
  assert.equal(C.describe(C.analyze([], 50)), '（和弦为空）');
});

console.log('\n全部通过：' + passed + ' 项');
