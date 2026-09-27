/* ============================================================
   虚拟基音计算器 · 核心逻辑
   ------------------------------------------------------------
   忠实移植 IRCAM OpenMusic 的下列函数
   （OMTristan 与 Esquisse 两个库里是同源实现）：

     OMTristan/sources/TMlibrairie-OM.lisp:2337   virtual-fund
     OMTristan/sources/TMlibrairie-OM.lisp:2277   tolerant-gcd   [Gérard Assayag, 1993-07-16]
     OMTristan/sources/TMlibrairie-OM.lisp:2382   virt-fund-step

   OM 的语义：
   - 返回「最高的、能让和弦里每个音都（近似）成为其整数倍泛音的基音」；
     结果因而不超过和弦的最低音。
   - 容差以音分给出，内部换算为比例 grid-ratio = 2^(cents/1200) − 1。
   - 候选区间 [0.1, (1+ratio)·min(freqs)]，商从最小开始试 → 取最高解。
   - 十二平均律和弦在 0 音分容差下通常【无解】（ET 不等于纯律），这是常态，不是错误。

   依赖 InterpCore 提供音高 / MIDI 工具（interpolation-core.js）。
   这个文件不碰 DOM：浏览器挂 window.VirtualFundCore，Node 里可 require 做测试。
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./interpolation-core.js'));
  else root.VirtualFundCore = factory(root.InterpCore);
})(typeof self !== 'undefined' ? self : this, function (InterpCore) {
  'use strict';

  if (!InterpCore) throw new Error('虚拟基音核心需要 InterpCore（请先加载 interpolation-core.js）');

  const DEFAULT_CENTS = 50;          /* OM 的 :initvals 就是 50 */
  const MIN_CANDIDATE = 0.1;         /* tolerant-gcd 里的下界 .1 */
  const DEFAULT_NODE_BUDGET = 200000;
  const MIDI_LOW = 0;
  const MIDI_HIGH = 127;
  /* OM 的候选下界是 0.1 Hz，所以容差足够小时总能“解出”一个亚音基音
     （例如 C4 E4 G4 @1¢ → 5.68 Hz，泛音序号 46:58:69）。
     这是忠实的 OM 行为，但没有音乐意义，界面上必须点破。 */
  const MIN_AUDIBLE_HZ = 16;

  /* ---------- 容差换算 ---------- */

  function centsToRatio(cents) {
    return Math.pow(2, Number(cents) / 1200) - 1;
  }

  function ratioToCents(ratio) {
    return 1200 * Math.log2(1 + ratio);
  }

  /* ---------- tolerant-gcd：带容差的浮点最大公约数 ---------- */

  /* 对应 OM 的 (tolerant-gcd values grid-ratio)。
     分支定界：把每个音能接受的 (freq / g) 商圈成整数区间，从最小商开始试，
     每试一个就收窄 g 的区间；全部音走完则返回剩余区间中点。
     nodeBudget 是本实现额外加的保护（OM 原版没有），用于挡掉病态输入。 */
  function tolerantGCDDetailed(values, gridRatio, nodeBudget) {
    const budget = nodeBudget == null ? DEFAULT_NODE_BUDGET : nodeBudget;
    const any = values.length > 0;
    if (!any) return { value: null, nodes: 0, exhausted: false };

    /* OM 不排序，直接按传入顺序递归；这里排序只是为了让结果可复现 */
    const data = values.slice().sort(function (a, b) { return a - b; });
    let nodes = 0;
    let exhausted = false;
    const above = function (v) { return v * (1 + gridRatio); };
    const below = function (v) { return v / (1 + gridRatio); };

    function gcdTry(start, gMin, gMax) {
      if (gMin > gMax) return null;
      nodes += 1;
      if (nodes > budget) { exhausted = true; return null; }
      if (start >= data.length) return (gMin + gMax) / 2;
      const v = data[start];
      const vBelow = below(v);
      const vAbove = above(v);
      const quoMin = Math.ceil(vBelow / gMax);
      const quoMax = Math.floor(vAbove / gMin);
      for (let q = quoMin; q <= quoMax; q++) {
        const found = gcdTry(start + 1, Math.max(gMin, vBelow / q), Math.min(gMax, vAbove / q));
        if (found !== null) return found;
        if (exhausted) return null;
      }
      return null;
    }

    const value = gcdTry(0, MIN_CANDIDATE, above(Math.min.apply(null, data)));
    return { value: value, nodes: nodes, exhausted: exhausted };
  }

  /* 与 OM 同签名：返回数字或 null */
  function tolerantGCD(values, gridRatio, nodeBudget) {
    return tolerantGCDDetailed(values, gridRatio, nodeBudget).value;
  }

  /* fond-virt-f ：OM 里就是 (tolerant-gcd freqs approx) */
  function fundamentalFromFreqs(freqs, gridRatio) {
    return tolerantGCDDetailed(freqs, gridRatio);
  }

  /* ---------- 和弦规范化 ---------- */

  function normalizeChord(chord) {
    const out = [];
    (chord || []).forEach(function (v) {
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      const clamped = Math.min(MIDI_HIGH, Math.max(MIDI_LOW, n));
      if (!out.some(function (x) { return Math.abs(x - clamped) < 1e-9; })) out.push(clamped);
    });
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  /* ---------- 主分析 ---------- */

  /* analyze(chordMidi, cents, opts) → 完整报告
     {
       chord, cents, ratio, ok, reason,
       fund: { midi, freq, label, centsOff },   // 虚基音
       partials: [ { midi, freq, n, idealFreq, centsOff } ],
       maxCentsOff, nodes, exhausted
     }
     reason: 'ok' | 'empty' | 'no-solution' | 'budget' */
  function analyze(chordMidi, cents, opts) {
    opts = opts || {};
    const chord = normalizeChord(chordMidi);
    const tolerance = cents == null ? DEFAULT_CENTS : Number(cents);
    const ratio = centsToRatio(tolerance);
    const report = {
      chord: chord,
      cents: tolerance,
      ratio: ratio,
      ok: false,
      reason: 'empty',
      fund: null,
      partials: [],
      maxCentsOff: 0,
      nodes: 0,
      exhausted: false
    };
    if (!chord.length) return report;
    if (!(ratio >= 0)) { report.reason = 'bad-tolerance'; return report; }

    const freqs = chord.map(function (m) { return InterpCore.midiToFreq(m); });
    const solved = fundamentalFromFreqs(freqs, ratio, opts.nodeBudget);
    report.nodes = solved.nodes;
    report.exhausted = solved.exhausted;
    if (solved.value === null || !(solved.value > 0)) {
      report.reason = solved.exhausted ? 'budget' : 'no-solution';
      return report;
    }

    const f0 = solved.value;
    report.ok = true;
    report.reason = 'ok';
    report.fund = {
      midi: InterpCore.freqToMidi(f0),
      freq: f0,
      label: InterpCore.midiToLabel(InterpCore.freqToMidi(f0))
    };
    report.audible = f0 >= MIN_AUDIBLE_HZ;

    /* 每个和弦音 → 最近的整数泛音序号 + 实际偏差（音分） */
    let maxOff = 0;
    report.partials = chord.map(function (m, i) {
      const f = freqs[i];
      let n = Math.round(f / f0);
      if (n < 1) n = 1;
      const ideal = n * f0;
      const centsOff = 1200 * Math.log2(f / ideal);
      maxOff = Math.max(maxOff, Math.abs(centsOff));
      return { midi: m, freq: f, n: n, idealFreq: ideal, centsOff: centsOff };
    });
    report.maxCentsOff = maxOff;
    report.fund.centsOff = 0;
    return report;
  }

  /* ---------- 精度扫描（对应 OM 的 virt-fund-step） ---------- */

  /* 从 fromCents 到 toCents 逐步长扫描，返回每一步的解（可能为无解） */
  function virtualFundSweep(chordMidi, fromCents, toCents, stepCents, opts) {
    const chord = normalizeChord(chordMidi);
    const from = fromCents == null ? 0 : Number(fromCents);
    const to = toCents == null ? 120 : Number(toCents);
    const step = Math.max(0.5, Number(stepCents) || 2);
    const out = [];
    if (!chord.length) return out;
    const guard = 4000;
    for (let c = from, i = 0; c <= to + 1e-9 && i < guard; c += step, i++) {
      const report = analyze(chord, c, opts);
      out.push({
        cents: Math.round(c * 1000) / 1000,
        ok: report.ok,
        midi: report.ok ? report.fund.midi : null,
        freq: report.ok ? report.fund.freq : null,
        audible: report.ok ? !!report.audible : false,
        partials: report.ok ? report.partials.map(function (p) { return p.n; }) : null,
        maxCentsOff: report.maxCentsOff
      });
    }
    return out;
  }

  /* ---------- 泛音序列（给五线谱用） ---------- */

  /* 以 f0 为基音，取第 1..count 号泛音的 MIDI 音高，超出钢琴范围就截断 */
  function harmonicSeries(fundMidi, count, limitMidi) {
    const limit = limitMidi == null ? MIDI_HIGH : limitMidi;
    const out = [];
    if (fundMidi == null || !Number.isFinite(fundMidi)) return out;
    const f0 = InterpCore.midiToFreq(fundMidi);
    for (let n = 1; n <= Math.max(1, count); n++) {
      const midi = InterpCore.freqToMidi(f0 * n);
      if (midi > limit) break;
      out.push({ n: n, midi: midi });
    }
    return out;
  }

  /* ---------- 扫描曲线 SVG ---------- */

  function renderSweepSVG(sweep, opts) {
    opts = opts || {};
    const dark = !!opts.dark;
    const W = 920;
    const H = 300;
    const left = 62;
    const right = 22;
    const top = 30;
    const bottom = 40;
    const bg = dark ? '#1c1c1e' : '#ffffff';
    const ink = dark ? '#f2f2f7' : '#1c1c1e';
    const muted = dark ? '#a1a1aa' : '#6b6b70';
    const axis = dark ? '#48484a' : '#d9d9de';
    const p = [];
    p.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" '
      + 'font-family="-apple-system, \'PingFang SC\', Helvetica, Arial, sans-serif">');
    p.push('<rect width="' + W + '" height="' + H + '" fill="' + bg + '"/>');
    p.push('<text x="' + left + '" y="18" font-size="12.5" font-weight="600" fill="' + ink + '">'
      + '精度扫描：横轴＝容差（音分），纵轴＝虚基音</text>');

    if (!sweep || !sweep.length) {
      p.push('<text x="' + (W / 2) + '" y="' + (H / 2) + '" font-size="12" fill="' + muted + '" text-anchor="middle">（没有数据）</text>');
      p.push('</svg>');
      return p.join('\n');
    }

    /* 亚音解（< minFreq）默认不画：它们会把纵轴撑到几十个八度，
       图就完全没法看了。被隐藏的点数会写在图注里。 */
    const minFreq = opts.minFreq == null ? MIN_AUDIBLE_HZ : Number(opts.minFreq);
    const shown = (minFreq > 0)
      ? sweep.filter(function (s) { return s.ok && s.freq >= minFreq; })
      : sweep.filter(function (s) { return s.ok; });
    const hidden = sweep.filter(function (s) { return s.ok; }).length - shown.length;

    const xs = sweep.map(function (s) { return s.cents; });
    const xMin = Math.min.apply(null, xs);
    const xMax = Math.max.apply(null, xs);
    const ys = shown.map(function (s) { return s.midi; });
    if (!ys.length) {
      p.push('<text x="' + (W / 2) + '" y="' + (H / 2) + '" font-size="12" fill="' + muted + '" text-anchor="middle">'
        + (hidden ? '有解，但全部低于 ' + minFreq + ' Hz（亚音）' : '整个容差范围内都无解') + '</text>');
      p.push('</svg>');
      return p.join('\n');
    }
    let yMin = Math.min.apply(null, ys);
    let yMax = Math.max.apply(null, ys);
    if (yMax - yMin < 1) { yMax = yMin + 1; }
    const pad = (yMax - yMin) * 0.12;
    yMin -= pad;
    yMax += pad;

    const plotW = W - left - right;
    const plotH = H - top - bottom;
    const xOf = function (c) { return left + (xMax === xMin ? 0.5 : (c - xMin) / (xMax - xMin)) * plotW; };
    const yOf = function (m) { return top + plotH - (m - yMin) / (yMax - yMin) * plotH; };

    /* 纵向网格＝整数半音；横向网格＝每 20 音分 */
    const first = Math.ceil(yMin);
    for (let m = first; m <= yMax; m++) {
      const y = yOf(m);
      if (y < top - 0.5 || y > top + plotH + 0.5) continue;
      p.push('<line x1="' + left + '" y1="' + y.toFixed(1) + '" x2="' + (W - right) + '" y2="' + y.toFixed(1)
        + '" stroke="' + axis + '" stroke-width="0.7" stroke-dasharray="3 3"/>');
      p.push('<text x="' + (left - 8) + '" y="' + (y + 3.5).toFixed(1) + '" font-size="10" fill="' + muted
        + '" text-anchor="end">' + InterpCore.midiToName(m) + '</text>');
    }
    for (let c = Math.ceil(xMin / 20) * 20; c <= xMax; c += 20) {
      const x = xOf(c);
      p.push('<line x1="' + x.toFixed(1) + '" y1="' + top + '" x2="' + x.toFixed(1) + '" y2="' + (top + plotH)
        + '" stroke="' + axis + '" stroke-width="0.7"/>');
      p.push('<text x="' + x.toFixed(1) + '" y="' + (top + plotH + 16) + '" font-size="10" fill="' + muted
        + '" text-anchor="middle">' + c + '¢</text>');
    }

    /* 折线：只在连续的“有解”段之间连线 */
    let path = '';
    let pen = false;
    shown.forEach(function (s) {
      if (!s.ok) { pen = false; return; }
      const x = xOf(s.cents);
      const y = yOf(s.midi);
      path += (pen ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
      pen = true;
    });
    p.push('<path d="' + path.trim() + '" fill="none" stroke="#0a6cff" stroke-width="2" stroke-linejoin="round"/>');
    shown.forEach(function (s) {
      p.push('<circle cx="' + xOf(s.cents).toFixed(1) + '" cy="' + yOf(s.midi).toFixed(1)
        + '" r="2.4" fill="#0a6cff"/>');
    });
    if (hidden) {
      p.push('<text x="' + (W - right) + '" y="' + (H - 10) + '" font-size="10.5" fill="' + muted
        + '" text-anchor="end">已隐藏 ' + hidden + ' 个低于 ' + minFreq + ' Hz 的亚音解</text>');
    }
    p.push('</svg>');
    return p.join('\n');
  }

  /* ---------- 文本报告 ---------- */

  function describe(report) {
    if (!report || !report.chord.length) return '（和弦为空）';
    const head = '容差 ' + report.cents + '¢';
    if (report.reason === 'no-solution') {
      return head + '：无解——这个容差下不存在能把全部音归为整数倍泛音的基音';
    }
    if (report.reason === 'budget') {
      return head + '：搜索超出预算（病态输入），已放弃';
    }
    if (!report.ok) return head + '：' + report.reason;
    const parts = report.partials.map(function (p) {
      const off = Math.abs(p.centsOff) < 0.05 ? '精确' : (p.centsOff > 0 ? '+' : '−') + Math.abs(p.centsOff).toFixed(1) + '¢';
      return p.n + '×(' + off + ')';
    }).join(' · ');
    return head + '：虚基音 ' + report.fund.label + '，泛音序号 ' + parts
      + '，最大偏差 ' + report.maxCentsOff.toFixed(1) + '¢'
      + (report.audible === false ? '（⚠ 低于 ' + MIN_AUDIBLE_HZ + ' Hz，亚音，无音乐意义）' : '');
  }

  return {
    DEFAULT_CENTS: DEFAULT_CENTS,
    MIN_CANDIDATE: MIN_CANDIDATE,
    MIN_AUDIBLE_HZ: MIN_AUDIBLE_HZ,
    DEFAULT_NODE_BUDGET: DEFAULT_NODE_BUDGET,
    centsToRatio: centsToRatio,
    ratioToCents: ratioToCents,
    tolerantGCD: tolerantGCD,
    tolerantGCDDetailed: tolerantGCDDetailed,
    fundamentalFromFreqs: fundamentalFromFreqs,
    normalizeChord: normalizeChord,
    analyze: analyze,
    virtualFundSweep: virtualFundSweep,
    harmonicSeries: harmonicSeries,
    renderSweepSVG: renderSweepSVG,
    describe: describe
  };
});
