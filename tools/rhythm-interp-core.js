/* ============================================================
   节奏插值 · 核心算法（OpenMusic 同构的最小 demo）
   ------------------------------------------------------------
   与 OpenMusic 的关系：
   - 曲线权重沿用 OM 的 INTERPOLATION：w(t, curve) = t ^ (e ^ (-curve))
   - 时值列表 dx  ↔  起点列表 x：对应 OM 的 dx->x / x->dx
   - “逐项时值”= 对两个 dx 列表逐元素调用 INTERPOLATION（要求长度相同）
   - “时间弯曲”= 把每个节奏表示为 归一化事件索引 → 归一化起点时间 的
     分段线性函数，插值这两条函数后再采样；对应 OM 的 BPF-INTERPOL
     （'sample 模式）/ x-transfer 的思路，长度可以不同。
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RhythmCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- 输入解析 ---------- */

  /* 支持：0.25 / 1/8 / 1/4 / 1/16 之类的时值；空格、逗号、竖线分隔 */
  function parseRhythm(text) {
    const tokens = String(text).split(/[\s,;、，|]+/).filter(Boolean);
    const out = [];
    for (const token of tokens) {
      let value;
      if (token.includes('/')) {
        const parts = token.split('/');
        const numerator = Number(parts[0]);
        const denominator = Number(parts[1]);
        value = numerator / denominator;
      } else {
        value = Number(token);
      }
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('无法识别：' + token);
      }
      out.push(value);
    }
    if (!out.length) throw new Error('节奏不能为空');
    return out;
  }

  function formatNumber(value, digits) {
    if (digits == null) digits = 3;
    const rounded = Math.round(value * Math.pow(10, digits)) / Math.pow(10, digits);
    return String(rounded);
  }

  function totalDuration(durations) {
    return durations.reduce(function (sum, d) { return sum + d; }, 0);
  }

  /* dx -> x：时值列表 → 起点列表（对应 OM 的 dx->x） */
  function durationsToOnsets(durations, start) {
    let time = start == null ? 0 : start;
    const onsets = [];
    for (const d of durations) {
      onsets.push(time);
      time += d;
    }
    return onsets;
  }

  /* ---------- OM 同构的插值权重 ---------- */

  function curveWeight(t, curve) {
    const x = Math.min(1, Math.max(0, t));
    return Math.pow(x, Math.exp(-curve));
  }

  function samplePositions(samples) {
    const n = Math.max(1, Math.round(samples));
    if (n <= 1) return [0.5];
    const out = [];
    for (let j = 0; j < n; j++) out.push(j / (n - 1));
    return out;
  }

  /* ---------- 策略 1：逐项时值（OM 的 INTERPOLATION on dx） ---------- */

  function interpolateEqualDurations(a, b, samples, curve) {
    const positions = samplePositions(samples);
    const steps = positions.map(function (t, j) {
      const w = curveWeight(t, curve);
      const durations = a.map(function (av, i) {
        return av + (b[i] - av) * w;
      });
      const onsets = durationsToOnsets(durations);
      return {
        index: j,
        t: t,
        weight: w,
        durations: durations,
        onsets: onsets,
        total: totalDuration(durations)
      };
    });
    return steps;
  }

  /* ---------- 策略 2：时间弯曲（BPF / 归一化事件索引） ---------- */

  /* 把一个节奏整理成“归一化事件索引 u → 归一化起点时间 f”的分段线性函数 */
  function onsetShape(durations) {
    const total = totalDuration(durations);
    const onsets = durationsToOnsets(durations);
    const n = durations.length;
    const points = [{ u: 0, f: 0 }];
    for (let i = 1; i < n; i++) {
      points.push({ u: i / n, f: onsets[i] / total });
    }
    points.push({ u: 1, f: 1 });
    return { total: total, count: n, points: points };
  }

  function sampleShape(shape, u) {
    const points = shape.points;
    for (let i = 1; i < points.length; i++) {
      if (u <= points[i].u) {
        const p0 = points[i - 1];
        const p1 = points[i];
        const span = p1.u - p0.u;
        const ratio = span <= 0 ? 0 : (u - p0.u) / span;
        return p0.f + (p1.f - p0.f) * ratio;
      }
    }
    return 1;
  }

  function interpolateWarp(a, b, samples, curve) {
    const shapeA = onsetShape(a);
    const shapeB = onsetShape(b);
    const positions = samplePositions(samples);
    return positions.map(function (t, j) {
      const w = curveWeight(t, curve);
      const count = Math.max(1, Math.round((1 - w) * shapeA.count + w * shapeB.count));
      const total = (1 - w) * shapeA.total + w * shapeB.total;
      const onsets = [];
      for (let k = 0; k < count; k++) {
        const u = k / count;              /* 第一个起点 0，最后一个起点 < 1 */
        const f = (1 - w) * sampleShape(shapeA, u) + w * sampleShape(shapeB, u);
        onsets.push(total * f);
      }
      const durations = onsets.map(function (x, i) {
        return i < onsets.length - 1 ? onsets[i + 1] - x : total - x;
      });
      return {
        index: j,
        t: t,
        weight: w,
        durations: durations,
        onsets: onsets,
        total: total
      };
    });
  }

  /* ---------- 统一入口 ---------- */

  function interpolateRhythm(a, b, samples, curve, strategy) {
    if (!a.length || !b.length) throw new Error('节奏不能为空');
    if (strategy === 'dx') {
      if (a.length !== b.length) {
        throw new Error('“逐项时值”要求两个节奏长度相同（' + a.length + ' vs ' + b.length +
                        '）；请改用“时间弯曲”策略。');
      }
      return {
        strategy: 'dx',
        samples: samples,
        curve: curve,
        a: a,
        b: b,
        steps: interpolateEqualDurations(a, b, samples, curve)
      };
    }
    return {
      strategy: 'warp',
      samples: samples,
      curve: curve,
      a: a,
      b: b,
      steps: interpolateWarp(a, b, samples, curve)
    };
  }

  /* ---------- 时间线 SVG ---------- */

  /* ---------- 量化 + ABC 记谱 ---------- */

  /* 把一个中间状态的实数时值吸附到 unit 网格；返回整数单位的音符序列 */
  function quantizeStep(step, unit) {
    const onsets = step.onsets.map(function (x) { return Math.round(x / unit) * unit; });
    for (let i = 1; i < onsets.length; i++) {
      if (onsets[i] <= onsets[i - 1]) onsets[i] = onsets[i - 1] + unit;
    }
    const totalUnits = Math.max(Math.round(step.total / unit), onsets.length);
    const total = totalUnits * unit;
    const events = onsets.map(function (start, i) {
      const end = (i < onsets.length - 1) ? onsets[i + 1] : total;
      let units = Math.round((end - start) / unit);
      if (units < 1) units = 1;
      return { start: start, units: units, duration: units * unit };
    });
    return { unit: unit, total: total, totalUnits: totalUnits, events: events };
  }

  function unitLabel(value) {
    const known = [
      [1, '1'], [1 / 2, '1/2'], [1 / 4, '1/4'], [1 / 8, '1/8'],
      [1 / 16, '1/16'], [1 / 32, '1/32'], [1 / 64, '1/64'],
      [3 / 2, '3/2'], [3 / 4, '3/4'], [3 / 8, '3/8'],
      [3 / 16, '3/16'], [3 / 32, '3/32'], [3 / 64, '3/64']
    ];
    for (const pair of known) if (Math.abs(value - pair[0]) < 1e-9) return pair[1];
    return String(value);
  }

  /* ---------- 记谱：连续时值 → 音符值 / 三连音 ---------- */

  const NOTE_VALUES = [1, 1 / 2, 1 / 4, 1 / 8, 1 / 16, 1 / 32, 1 / 64];

  /* 连音比例 n:m = “n 个音占 m 个同值音符的时间”；
     顺序即优先级（默认先把 6 个音看成两组三连音，而不是一个六连音）。
     11:8 / 13:8 不列入默认值：abcjs 的 (p:q 语法只接受 p = 2…9。 */
  const DEFAULT_TUPLETS = [[3, 2], [5, 4], [6, 4], [7, 4], [9, 8]];

  /* abcjs 的 (p:q 语法（以及 ABC 记谱惯例）只接受个位数 p */
  const ABC_MAX_TUPLET = 9;

  /* 把 n:m 折成若干可记谱的小连音：需要 n、m 都能整除 k，且 n/k ≤ max */
  function splitTuplet(n, m, max) {
    max = max || ABC_MAX_TUPLET;
    if (!(n >= 2) || !(m >= 1)) return null;
    if (n <= max) return { n: n, m: m, groups: 1 };
    for (let k = 2; k <= n; k++) {
      if (n % k === 0 && m % k === 0 && n / k <= max) return { n: n / k, m: m / k, groups: k };
    }
    return null;
  }

  function canRenderTuplet(n, m) { return !!splitTuplet(n, m); }

  function parseTuplets(text) {
    const out = [];
    String(text).split(/[\s,;、，]+/).filter(Boolean).forEach(function (token) {
      const match = token.match(/^(\d+)\s*:\s*(\d+)$/);
      if (match) out.push([parseInt(match[1], 10), parseInt(match[2], 10)]);
    });
    return out.length ? out : DEFAULT_TUPLETS.slice();
  }

  function isClose(a, b, eps) { return Math.abs(a - b) < (eps === undefined ? 1e-6 : eps); }

  /* 允许的音符值（含附点）；minValue 是最小音符值，例如 1/16 */
  function allowedNoteValues(minValue) {
    const values = [];
    NOTE_VALUES.forEach(function (v) {
      if (v >= minValue - 1e-9) values.push(v);
      const dotted = v * 1.5;
      if (dotted >= minValue - 1e-9) values.push(dotted);
    });
    return values.sort(function (a, b) { return b - a; });
  }

  function abcNoteToken(units) {
    return 'B' + (units > 1 ? String(units) : '');
  }

  /* 选 ABC 的 L：能从大到小整除所有 written 值的最大音符值 */
  function chooseABCUnit(writtenValues) {
    for (const candidate of NOTE_VALUES) {
      if (writtenValues.every(function (w) {
        return Math.abs(w / candidate - Math.round(w / candidate)) < 1e-6;
      })) return candidate;
    }
    return 1 / 64;
  }

  /* 把一个非标准时值拆成若干音符值（用于连音线） */
  function decomposeValue(value, values) {
    const parts = [];
    let rest = value;
    let guard = 0;
    while (rest > 1e-6 && guard++ < 16) {
      const part = values.find(function (v) { return v <= rest + 1e-9; });
      if (!part) break;
      parts.push(part);
      rest -= part;
    }
    return parts.length ? parts : [values[values.length - 1]];
  }

  /* 可识别时值表：标准音符值 → 单音；written × m/n → 连音（任意 n:m） */
  function durationTable(values, pairs) {
    const table = [];
    values.forEach(function (v) { table.push({ actual: v, type: 'note', written: v }); });
    pairs.forEach(function (pair) {
      const n = pair[0];
      const m = pair[1];
      const split = splitTuplet(n, m);
      if (!split) return;
      values.forEach(function (v) {
        const actual = v * m / n;
        if (actual > 0) table.push({
          actual: actual, type: 'tuplet', written: v,
          n: split.n, m: split.m, groups: split.groups, pairN: n, pairM: m
        });
      });
    });
    return table;
  }

  function snapToTable(value, table, tol) {
    let best = null;
    let bestErr = Infinity;
    table.forEach(function (entry) {
      const err = Math.abs(value - entry.actual) / entry.actual;
      if (err < bestErr) { bestErr = err; best = entry; }
    });
    return (best && bestErr <= tol) ? best.actual : value;
  }

  /* 把连续时值转成记谱组：单音 / 连音线 / 连音（任意 n:m） */
  function notateStep(step, options) {
    options = options || {};
    const minValue = options.minValue || 1 / 16;
    const values = allowedNoteValues(minValue);
    const pairs = (options.tuplets && options.tuplets.length) ? options.tuplets : DEFAULT_TUPLETS;
    const preferTuplets = !!options.preferTuplets;
    const table = durationTable(values, pairs);
    const snapTol = 0.008;   /* 0.8% 以内视为同一个记谱时值 */
    const onsets = step.onsets.slice();
    for (let i = 1; i < onsets.length; i++) {
      if (!(onsets[i] > onsets[i - 1])) onsets[i] = onsets[i - 1] + 1e-9;
    }
    const total = Math.max(step.total, onsets.length ? onsets[onsets.length - 1] : 0);
    const durations = onsets.map(function (x, i) {
      const raw = (i < onsets.length - 1 ? onsets[i + 1] : total) - x;
      return snapToTable(raw, table, snapTol);
    });
    const groups = [];
    let i = 0;
    while (i < durations.length) {
      const actual = durations[i];
      const matches = table.filter(function (e) { return isClose(e.actual, actual, 1e-9); });
      const plain = matches.find(function (e) { return e.type === 'note'; });
      let tuplet = null;
      let fallback = null;
      pairs.forEach(function (pair) {
        const n = pair[0];
        const m = pair[1];
        let run = 1;
        while (i + run < durations.length && isClose(durations[i + run], actual, 1e-9)) run++;
        if (n < 2 || run < n || !splitTuplet(n, m)) return;
        const entry = matches.find(function (e) {
          return e.type === 'tuplet' && e.pairN === n && e.pairM === m;
        });
        if (!entry) return;
        if (!fallback) fallback = entry;
        /* 优先整段可整除的比例：6 个音 = 两组三连音，而不是一个五连音 + 1 个散音 */
        if (!tuplet && run % n === 0) tuplet = entry;
      });
      if (!tuplet) tuplet = fallback;
      if (tuplet && (preferTuplets || !plain)) {
        for (let g = 0; g < tuplet.groups; g++) {
          const writtenList = [];
          for (let k = 0; k < tuplet.n; k++) writtenList.push(tuplet.written);
          groups.push({
            type: 'tuplet', n: tuplet.n, m: tuplet.m,
            written: writtenList, actual: actual
          });
        }
        i += tuplet.n * tuplet.groups;
        continue;
      }
      const writtenValues = plain ? [plain.written] : decomposeValue(actual, values);
      groups.push({
        type: writtenValues.length > 1 ? 'tie' : 'note',
        written: writtenValues,
        actual: actual
      });
      i += 1;
    }
    const flatWritten = [];
    groups.forEach(function (g) { g.written.forEach(function (w) { flatWritten.push(w); }); });
    const L = chooseABCUnit(flatWritten);
    const tokens = [];
    let cursor = 0;
    const meter = parseMeter(options.meter);
    const barLength = meter.barLength;
    groups.forEach(function (g) {
      const units = g.written.map(function (w) { return Math.max(1, Math.round(w / L)); });
      if (g.type === 'tuplet') {
        const prefix = (g.n === 3 && g.m === 2) ? '(3' : '(' + g.n + ':' + g.m;
        tokens.push(prefix + units.map(abcNoteToken).join(' '));
      } else {
        tokens.push(units.map(abcNoteToken).join('-'));
      }
      cursor += g.actual * (g.type === 'tuplet' ? g.n : 1);
      while (cursor >= barLength - 1e-9) {
        tokens.push('|');
        cursor -= barLength;
      }
    });
    let body = tokens.join(' ');
    if (body.endsWith('|')) body += ']';
    else body += ' |]';
    const header = ['X:1', 'T:' + (options.title || ''), 'M:' + meter.num + '/' + meter.den,
                    'L:' + unitLabel(L), 'K:C clef=perc', 'V:1'];
    return header.join('\n') + '\n' + body;
  }

  /* 兼容旧的 (step, unit, options) 调用；第二个参数现在表示“最小音符值” */
  function stepToABC(step, unitOrOptions, options) {
    const opts = (typeof unitOrOptions === 'number')
      ? Object.assign({}, options || {}, { minValue: unitOrOptions })
      : (unitOrOptions || {});
    return notateStep(step, opts);
  }

  /* ============================================================
     全局量化器（引擎 2）
     ------------------------------------------------------------
     旧引擎（notateStep）：先把每个时值吸附到“等值连音表”，再按连续等值扫描成组，
     连音组内必须是同一个书面值。
     新引擎：把整条节奏切成若干「记谱层」片段，一层 =（书面原子值 u，比例 P:Q）。
     片段内每个音的书面值 = 整数个 u，于是允许混合时值
     （例：三连音里夹一个四分 → (3:2:2 写成一个四分 + 一个八分）。
     切法用动态规划取全局代价最小者，代价 = 记谱误差² + 括号/延音线/复杂度。

     一层把书面时长 W 映射到实际时长 S = W·Q/P，故层内实际原子值 a = u·Q/P。
     片段整体写成 ABC 的 (P:Q:R，R = 片段内音符符号数（延音线每一段都算一个）。
     实测约束（abcjs 6.7.1）：
     - P 只能是 0–9 的个位数；P ≥ 10 会被【静默忽略】——不报错、不警告，
       整组直接退回普通时值。所以比例一律先约分，P > 9 的层不生成。
     - R 可以是多位数（(3:2:12 正常）。
     - 括号不能嵌套（内层 (3 会被吞掉），嵌套只能摊平成等价比例。
     ============================================================ */

  /* 连音比例一律约分：12:8 → 3:2（记谱真正需要的只是比例，不是组数） */
  function reduceRatio(n, m) {
    const a0 = Math.abs(Math.round(n));
    const b0 = Math.abs(Math.round(m));
    if (!(a0 > 0) || !(b0 > 0)) return null;
    let a = a0;
    let b = b0;
    while (b) { const t = a % b; a = b; b = t; }
    return [a0 / a, b0 / a];
  }

  function isPowerOfTwo(value) {
    if (!(value > 0)) return false;
    let v = value;
    while (v < 1 - 1e-12) v *= 2;
    while (v > 1 + 1e-12) v /= 2;
    return Math.abs(v - 1) < 1e-9;
  }

  /* 把“m 个 u”拆成最少的可记谱音符值（附点/延音线由拆分自然产生）。
     以 u/2 为单位做 DP：可用部件 = 2^p（p≥1）与 3·2^p（p≥0）。
     每个部件的书面值必须 ≥ minValue —— 这才是“最小音符值”的含义：
     网格可以比它细（u = minValue/2，用来表达附点），但音符符号不能比它小。 */
  function decomposeWritten(m, u, minValue) {
    const target = Math.round(2 * m);
    if (!(target > 0)) return null;
    const minPart = minValue ? Math.ceil(2 * minValue / u - 1e-9) : 1;
    if (target < minPart) return null;
    const parts = [];
    for (let p = 1; ; p++) { const v = Math.pow(2, p); if (v > target) break; if (v >= minPart) parts.push(v); }
    for (let p = 0; ; p++) { const v = 3 * Math.pow(2, p); if (v > target) break; if (v >= minPart) parts.push(v); }
    if (!parts.length) return null;
    parts.sort(function (a, b) { return b - a; });
    const best = new Array(target + 1).fill(Infinity);
    best[0] = 0;
    for (let t = 1; t <= target; t++) {
      for (const p of parts) {
        if (p > t) continue;
        if (best[t - p] + 1 < best[t]) best[t] = best[t - p] + 1;
      }
    }
    if (!isFinite(best[target])) return null;
    const out = [];
    let t = target;
    while (t > 0) {
      const p = parts.find(function (pp) { return pp <= t && best[t - pp] === best[t] - 1; });
      if (!p) break;
      out.push(p * u / 2);
      t -= p;
    }
    return out.length ? out : null;
  }

  /* 记谱层 = 书面原子值 u + 比例 P:Q（约分后）。a = u·Q/P 是实际原子值。
     网格 u 取 2 的幂，一直细到 minValue/2 —— 比最小音符值再细一档，
     这样 3/32（附点十六分）、5/16 这类值才能落在整数倍上（m=3、m=5），
     而不是被逼着用连音去凑。 */
  function makeNotationLayers(minValue, pairs) {
    const ratios = [];
    const seen = { '1:1': true };
    (pairs && pairs.length ? pairs : DEFAULT_TUPLETS).forEach(function (pair) {
      const r = reduceRatio(pair[0], pair[1]);
      if (!r) return;
      if (r[0] < 2 || r[0] > ABC_MAX_TUPLET) return;   /* abcjs 只认个位数 P */
      const key = r[0] + ':' + r[1];
      if (seen[key]) return;
      seen[key] = true;
      ratios.push(r);
    });
    const layers = [];
    const units = [];
    for (let u = 1; u >= minValue / 2 - 1e-12; u /= 2) units.push(u);
    units.forEach(function (u) {
      layers.push({ u: u, a: u, P: 1, Q: 1, tuplet: false });
      ratios.forEach(function (r) {
        const a = u * r[1] / r[0];
        /* 注意：实际原子 a = u·Q/P 可以比 minValue 细 —— 这正是连音的意义
           （最小音符值 1/16 + 九连音 → 实际原子 1/18）。所以这里不设下限。 */
        layers.push({ u: u, a: a, P: r[0], Q: r[1], tuplet: true });
      });
    });
    return layers;
  }

  /* 拍号 → 小节长度与“单位拍”长度（全音符 = 1）。
     复拍子按惯例把附点拍当一拍：6/8、9/8、12/8 → 一拍 = 3/8。 */
  function parseMeter(meter) {
    let num = 4;
    let den = 4;
    if (Array.isArray(meter) && meter.length >= 2) {
      num = Math.max(1, Math.round(Number(meter[0]) || 4));
      den = Math.max(1, Math.round(Number(meter[1]) || 4));
    }
    const barLength = num / den;
    const compound = (num % 3 === 0) && num > 3 && den >= 8;
    const beatLength = compound ? 3 / den : 1 / den;
    return { num: num, den: den, barLength: barLength, beatLength: beatLength, compound: compound };
  }

  /* 跨小节的音在小节线上切开，切开处以后用延音线连起来 */
  function splitPiecesAtBars(durations, barLength) {
    const pieces = [];
    let cursor = 0;
    durations.forEach(function (d) {
      const end = cursor + d;
      let start = cursor;
      let guard = 0;
      while (end - start > 1e-9 && guard++ < 64) {
        const index = Math.floor((start + 1e-9) / barLength);
        const pieceEnd = Math.min(end, (index + 1) * barLength);
        pieces.push({
          dur: pieceEnd - start,
          tieNext: end - pieceEnd > 1e-9,
          bar: index,
          start: start,
          end: pieceEnd
        });
        start = pieceEnd;
      }
      cursor = end;
    });
    return pieces;
  }

  /* 片段起点离最近拍点的距离（用单位拍归一化，0 = 正好在拍点上） */
  function beatMisalignment(start, beatLength) {
    if (!(beatLength > 0)) return 0;
    const pos = start / beatLength;
    const frac = pos - Math.floor(pos + 1e-9);
    return Math.min(frac, 1 - frac);
  }

  /* 严格落在 (start, end) 内部的拍点个数 */
  function beatsCrossed(start, end, beatLength) {
    if (!(beatLength > 0)) return 0;
    const first = Math.floor(start / beatLength + 1e-9) + 1;
    const last = Math.ceil(end / beatLength - 1e-9) - 1;
    return Math.max(0, last - first + 1);
  }

  const DEFAULT_WEIGHTS = {
    error: 2000,       /* Σ(漂移 / 最小音符值)² 的权重：保真度压倒复杂度 */
    bracket: 2,        /* 每个连音括号 */
    avoidTuplet: 3,    /* 不优先连音时，括号额外代价 */
    preferTuplet: 4,   /* 连音优先时，括号的奖励 */
    span: 0.7,         /* |原子数 − P|：鼓励括号正好覆盖 n 个书面单位 */
    tie: 1.0,          /* 每个多余符号（延音线） */
    single: 3,         /* 括号里只有一个符号（几乎总是不该出现） */
    beatStart: 2.5,    /* 括号起点偏离拍点：按单位拍的比例计 */
    beatCross: 3       /* 括号跨过的拍点个数（鼓励一个括号 = 一拍） */
  };

  /* 连音括号至少要覆盖这么多【音】——用来干掉 (3:2:1B 这种孤立括号。
     真正的孤立三连音时值在记谱惯例里不会画括号，而是照拍点写成普通音符。 */
  const DEFAULT_MIN_BRACKET_NOTES = 2;

  /* 连音必须【严丝合缝】：括号只用来精确表达三连音这类节奏，
     不允许拿它去逼近别的时值（那会写出 (9:8:1B 这种荒唐记谱）。
     容差按最小音符值的比例给，默认 1%。 */
  const DEFAULT_TUPLET_TOLERANCE = 0.01;

  /* 全局量化（记谱用，勿与上面的网格量化 quantizeStep 混淆）：
     返回 { segments, groups, cost, maxError, endError, layers } */
  function quantizeNotation(step, options) {
    options = options || {};
    const minValue = options.minValue || 1 / 16;
    const meter = parseMeter(options.meter);
    const barLength = options.barLength || meter.barLength;
    const beatLength = options.beatLength || meter.beatLength;
    const maxNotes = options.maxSegmentNotes || 12;
    const minBracketNotes = options.minBracketNotes == null
      ? DEFAULT_MIN_BRACKET_NOTES : Math.max(1, options.minBracketNotes);
    const weights = Object.assign({}, DEFAULT_WEIGHTS, options.weights || {});
    const tupletTol = (options.tupletTolerance == null ? DEFAULT_TUPLET_TOLERANCE : options.tupletTolerance) * minValue;
    const preferTuplets = !!options.preferTuplets;
    const layers = makeNotationLayers(minValue, options.tuplets);

    const onsets = step.onsets.slice();
    for (let i = 1; i < onsets.length; i++) {
      if (!(onsets[i] > onsets[i - 1])) onsets[i] = onsets[i - 1] + 1e-9;
    }
    const total = Math.max(step.total, onsets.length ? onsets[onsets.length - 1] : 0);
    const durations = onsets.map(function (x, i) {
      return (i < onsets.length - 1 ? onsets[i + 1] : total) - x;
    });
    const pieces = splitPiecesAtBars(durations, barLength);
    const n = pieces.length;
    const best = new Array(n + 1).fill(null);
    best[0] = { cost: 0, from: -1, layer: null, parts: null, actual: 0, err: 0 };

    for (let i = 0; i < n; i++) {
      if (!best[i]) continue;
      for (const layer of layers) {
        let errSum = 0;      /* Σ（累计误差）² —— 惩罚漂移，不只是单音舍入 */
        let runErr = 0;
        let maxRunErr = 0;
        let symbols = 0;
        let atoms = 0;
        let actualSum = 0;
        let pieceTies = 0;
        const partsList = [];
        for (let j = i; j < n && j - i < maxNotes; j++) {
          const piece = pieces[j];
          if (layer.tuplet && piece.bar !== pieces[i].bar) break;   /* 括号不跨小节 */
          let m = Math.round(piece.dur / layer.a);
          if (m < 1) m = 1;
          const err = Math.abs(piece.dur - m * layer.a);
          /* 片段的第一格必须无条件接受：否则遇上比最小音符值还细的时值，
             整条节奏会无解（DP 找不到覆盖路径，直接吐空谱）。
             误差由代价函数承担，这里只对「继续延长片段」做半格剪枝。 */
          if (j > i && err > layer.a * 0.5 + 1e-9) break;
          if (layer.tuplet && atoms + m > layer.P) break;           /* 括号最多覆盖 n 个书面单位 */
          const parts = decomposeWritten(m, layer.u, minValue);
          if (!parts) break;
          runErr += m * layer.a - piece.dur;
          /* 连音只做精确表达；一旦漂移就整段作废，退回网格记谱 */
          if (layer.tuplet && Math.abs(runErr) > tupletTol) break;
          errSum += runErr * runErr;
          if (Math.abs(runErr) > maxRunErr) maxRunErr = Math.abs(runErr);
          symbols += parts.length;
          atoms += m;
          actualSum += piece.dur;
          if (piece.tieNext) pieceTies += 1;
          partsList.push({ parts: parts, tie: piece.tieNext });

          const ties = (symbols - partsList.length) + pieceTies;
          let cost = weights.error * errSum / (minValue * minValue);
          if (layer.tuplet) {
            const segStart = pieces[i].start;
            const segEnd = piece.end;
            cost += weights.bracket
              + (preferTuplets ? -weights.preferTuplet : weights.avoidTuplet)
              + weights.span * Math.abs(atoms - layer.P)
              + (symbols < 2 ? weights.single : 0)
              + weights.beatStart * beatMisalignment(segStart, beatLength)
              + weights.beatCross * beatsCrossed(segStart, segEnd, beatLength);
          }
          cost += weights.tie * ties;

          /* 括号至少要覆盖 minBracketNotes 个音，否则写出来就是 (3:2:1B 那种孤立括号。
             注意：这个判断必须放在【累计之后】——放在累计之前用 continue 跳过的
             话，后面的迭代就只累计了后半段，段会声称覆盖两个音却只算了一个。 */
          if (layer.tuplet && j - i + 1 < minBracketNotes) continue;

          const totalCost = best[i].cost + cost;
          if (!best[j + 1] || totalCost < best[j + 1].cost - 1e-9) {
            best[j + 1] = {
              cost: totalCost, from: i, layer: layer,
              parts: partsList.slice(), err: maxRunErr, actual: actualSum
            };
          }
        }
      }
    }

    /* 回溯 */
    const segments = [];
    let cursor = n;
    while (cursor > 0) {
      const node = best[cursor];
      if (!node || node.from < 0) return { segments: [], groups: [], cost: Infinity, maxError: Infinity, layers: layers };
      segments.unshift({
        layer: node.layer, parts: node.parts,
        actual: node.actual, err: node.err
      });
      cursor = node.from;
    }

    /* 展平成可输出/可检查的组 */
    const groups = segments.map(function (seg) {
      const symbols = [];
      seg.parts.forEach(function (entry) {
        entry.parts.forEach(function (value, k) {
          const last = k === entry.parts.length - 1;
          symbols.push({ value: value, tieToNext: !last || entry.tie });
        });
      });
      return {
        kind: seg.layer.tuplet ? 'bracket' : 'plain',
        P: seg.layer.P, Q: seg.layer.Q,
        u: seg.layer.u, a: seg.layer.a,
        symbols: symbols,
        notes: seg.parts.map(function (e) { return e.parts; }),
        actual: seg.actual,
        error: seg.err
      };
    });
    const maxError = segments.reduce(function (mx, s) { return Math.max(mx, s.err); }, 0);
    /* 全局漂移：每个音符起点相对原节奏的累计偏差（这才是耳朵听到的误差） */
    let drift = 0;
    let maxDrift = 0;
    let pieceIndex = 0;
    segments.forEach(function (seg) {
      const scale = seg.layer.tuplet ? seg.layer.Q / seg.layer.P : 1;
      seg.parts.forEach(function (entry) {
        const written = entry.parts.reduce(function (sum, v) { return sum + v; }, 0);
        drift += written * scale - pieces[pieceIndex].dur;
        if (Math.abs(drift) > maxDrift) maxDrift = Math.abs(drift);
        pieceIndex += 1;
      });
    });
    return {
      segments: segments, groups: groups, cost: best[n].cost,
      maxError: maxDrift, endError: Math.abs(drift), segmentError: maxError,
      layers: layers, pieces: pieces
    };
  }

  /* 组的实际时长（含连音缩放） */
  function groupActual(group) {
    if (group.kind === 'bracket') {
      return group.notes.reduce(function (sum, parts) {
        return sum + parts.reduce(function (s, v) { return s + v; }, 0);
      }, 0) * group.Q / group.P;
    }
    return group.symbols.reduce(function (sum, s) { return sum + s.value; }, 0);
  }

  /* 把量化结果渲染成 ABC */
  function abcFromQuantized(quantized, options) {
    options = options || {};
    const meter = parseMeter(options.meter);
    const barLength = options.barLength || meter.barLength;
    const groups = quantized.groups || [];
    const flat = [];
    groups.forEach(function (g) {
      g.symbols.forEach(function (s) { flat.push(s.value); });
    });
    const L = chooseABCUnit(flat.length ? flat : [1 / 16]);
    let body = '';
    let cursor = 0;
    let elapsed = 0;
    let nextBar = barLength;
    groups.forEach(function (g) {
      const units = g.symbols.map(function (s) { return Math.max(1, Math.round(s.value / L - 1e-9)); });
      const scale = g.kind === 'bracket' ? g.Q / g.P : 1;
      g.symbols.forEach(function (s, k) {
        let token = abcNoteToken(units[k]);
        if (k === 0 && g.kind === 'bracket') {
          /* (P:Q:R —— 只有 R ≠ P 时才需要写第三个数（默认 R = P） */
          token = '(' + g.P + ':' + g.Q
            + (units.length !== g.P ? ':' + units.length : '') + token;
        }
        body += (body ? ' ' : '') + token;
        if (s.tieToNext) body += '-';            /* 延音线紧跟音符，可跨小节线 */
        cursor += s.value * scale;
        elapsed += s.value * scale;
        while (cursor >= nextBar - 1e-9) {       /* 小节线落在音符边界上 */
          body += ' |';
          nextBar += barLength;
        }
      });
    });
    /* 末小节补休止：不足一小节时用休止符填满，谱面才完整 */
    if (options.padFinalBar !== false && elapsed > 1e-9) {
      const target = Math.ceil(elapsed / barLength - 1e-9) * barLength;
      const rest = target - elapsed;
      const parts = rest > 1e-9
        ? decomposeWritten(rest / L, L, options.minValue || 1 / 16)
        : null;
      if (parts) {
        parts.forEach(function (value) {
          const units = Math.max(1, Math.round(value / L));
          body += ' z' + (units > 1 ? units : '');
        });
      }
    }
    body += body.endsWith('|') ? ']' : ' |]';
    const header = ['X:1', 'T:' + (options.title || ''), 'M:4/4',
                    'L:' + unitLabel(L), 'K:C clef=perc', 'V:1'];
    header[2] = 'M:' + meter.num + '/' + meter.den;
    return header.join('\n') + '\n' + body;
  }

  /* 引擎 2 的入口（与 stepToABC 同签名） */
  function stepToABCGlobal(step, options) {
    const quantized = quantizeNotation(step, options || {});
    return abcFromQuantized(quantized, options || {});
  }

  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = h / 60;
    const x = c * (1 - Math.abs(hp % 2 - 1));
    let r = 0, g = 0, b = 0;
    if (hp < 1) { r = c; g = x; }
    else if (hp < 2) { r = x; g = c; }
    else if (hp < 3) { g = c; b = x; }
    else if (hp < 4) { g = x; b = c; }
    else if (hp < 5) { r = x; b = c; }
    else { r = c; b = x; }
    const m = l - c / 2;
    const to = function (v) {
      return Math.round((v + m) * 255).toString(16).padStart(2, '0');
    };
    return '#' + to(r) + to(g) + to(b);
  }

  function stepColor(t) {
    return hslToHex(216 + 171 * Math.min(1, Math.max(0, t)), 0.82, 0.52);
  }

  function renderTimelineSVG(result, options) {
    options = options || {};
    const dark = !!options.dark;
    const steps = result.steps;
    const W = 940;
    const rowHeight = 40;
    const top = 54;
    const left = 92;
    const right = 30;
    const H = top + steps.length * rowHeight + 20;
    const maxTotal = Math.max.apply(null, steps.map(function (s) { return s.total; }));
    const plot = W - left - right;
    const bg = dark ? '#1c1c1e' : '#ffffff';
    const ink = dark ? '#f2f2f7' : '#1c1c1e';
    const muted = dark ? '#a1a1aa' : '#6b6b70';
    const axis = dark ? '#48484a' : '#d9d9de';
    const p = [];
    p.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" '
      + 'font-family="-apple-system, \'PingFang SC\', Helvetica, Arial, sans-serif">');
    p.push('<rect width="' + W + '" height="' + H + '" fill="' + bg + '"/>');
    p.push('<text x="' + left + '" y="24" font-size="13" font-weight="600" fill="' + ink + '">'
      + (result.strategy === 'dx' ? '逐项时值（OM INTERPOLATION on dx）' : '时间弯曲（BPF / 归一化索引）')
      + '　·　samples=' + result.samples + '　curve=' + result.curve.toFixed(2) + '</text>');
    /* 顶部轴 */
    for (let i = 0; i <= 4; i++) {
      const value = maxTotal * i / 4;
      const x = left + plot * i / 4;
      p.push('<line x1="' + x.toFixed(1) + '" y1="34" x2="' + x.toFixed(1) + '" y2="' + (H - 12) + '" stroke="' + axis + '" stroke-width="0.8" stroke-dasharray="3 3"/>');
      p.push('<text x="' + x.toFixed(1) + '" y="50" font-size="10" fill="' + muted + '" text-anchor="middle">' + formatNumber(value, 2) + '</text>');
    }
    /* 每一行一个中间状态 */
    steps.forEach(function (step, j) {
      const y = top + j * rowHeight + 6;
      const barY = y + 6;
      const color = stepColor(step.t);
      p.push('<text x="' + (left - 10) + '" y="' + (barY + 12) + '" font-size="11" fill="' + muted + '" text-anchor="end">#' + (j + 1) + '</text>');
      p.push('<line x1="' + left + '" y1="' + barY + '" x2="' + (W - right) + '" y2="' + barY + '" stroke="' + axis + '" stroke-width="1"/>');
      step.durations.forEach(function (duration, i) {
        const x0 = left + plot * step.onsets[i] / maxTotal;
        const x1 = left + plot * (step.onsets[i] + duration) / maxTotal;
        const width = Math.max(2, x1 - x0 - 2);
        p.push('<rect x="' + (x0 + 1).toFixed(1) + '" y="' + (barY - 9) + '" width="' + width.toFixed(1)
          + '" height="18" rx="4" fill="' + color + '" opacity="0.9"/>');
        if (width > 34) {
          p.push('<text x="' + ((x0 + x1) / 2).toFixed(1) + '" y="' + (barY + 4) + '" font-size="9.5" fill="#fff" text-anchor="middle">'
            + formatNumber(duration, 3) + '</text>');
        }
      });
      p.push('<text x="' + (W - right + 6) + '" y="' + (barY + 4) + '" font-size="10" fill="' + muted + '">'
        + formatNumber(step.total, 2) + '</text>');
    });
    p.push('</svg>');
    return p.join('\n');
  }

  /* ---------- MIDI 导出 ---------- */

  const MIDI_PPQ = 480;

  function vlq(value) {
    const bytes = [value & 0x7F];
    let v = value >> 7;
    while (v > 0) { bytes.unshift((v & 0x7F) | 0x80); v >>= 7; }
    return bytes;
  }

  function asciiBytes(text) {
    const out = [];
    const s = String(text);
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      out.push(code < 128 ? code : 0x3F);   /* 非 ASCII 退化成 ?，避免破坏文件 */
    }
    return out;
  }

  /* 一个中间状态 → 单轨 MIDI：每个起点一个音，音长用时值。
     全音符 = 4 个四分音符 = 4×PPQ tick，与速度无关。 */
  function buildRhythmMidi(step, options) {
    options = options || {};
    const bpm = Math.max(20, Math.min(400, Number(options.bpm) || 120));
    const meter = parseMeter(options.meter);
    const percussion = options.percussion !== false;
    const channel = percussion ? 9 : (options.channel == null ? 0 : options.channel);
    const note = options.pitch == null ? (percussion ? 76 : 60) : options.pitch;
    const gate = options.gate == null ? 0.9 : options.gate;
    const velocities = options.velocities || null;

    const tickOf = function (t) { return Math.max(0, Math.round(t * 4 * MIDI_PPQ)); };
    const events = [];
    let seq = 0;
    function push(tick, order, data) { events.push({ tick: tick, order: order, seq: seq++, data: data }); }

    const usPerBeat = Math.round(60000000 / bpm);
    push(0, 0, [0xFF, 0x51, 0x03, (usPerBeat >> 16) & 0xFF, (usPerBeat >> 8) & 0xFF, usPerBeat & 0xFF]);
    push(0, 0, [0xFF, 0x58, 0x04, meter.num, Math.round(Math.log2(meter.den)), 24, 8]);
    const name = asciiBytes(options.trackName || 'Rhythm');
    push(0, 0, [0xFF, 0x03].concat(vlq(name.length), name));

    const onsets = step.onsets || durationsToOnsets(step.durations || []);
    const durations = step.durations || [];
    const total = step.total != null ? step.total : totalDuration(durations);
    const info = asciiBytes('rhythm meter=' + meter.num + '/' + meter.den
      + ' onsets=' + onsets.length);
    push(0, 0, [0xFF, 0x01].concat(vlq(info.length), info));
    if (!percussion) { push(0, 1, [0xC0 | channel, 0]); }

    onsets.forEach(function (onset, i) {
      const dur = (i < onsets.length - 1 ? onsets[i + 1] : total) - onset;
      const startTick = tickOf(onset);
      const durTicks = Math.max(1, Math.round(dur * 4 * MIDI_PPQ * gate));
      const vel = velocities ? Math.max(1, Math.min(127, velocities[i] | 0)) : 100;
      push(startTick, 3, [0x90 | channel, note & 0x7F, vel]);
      push(startTick + durTicks, 2, [0x80 | channel, note & 0x7F, 0]);
    });

    push(tickOf(total) + 1, 0, [0xFF, 0x2F, 0x00]);

    events.sort(function (a, b) {
      return a.tick - b.tick || a.order - b.order || a.seq - b.seq;
    });
    const track = [];
    let last = 0;
    events.forEach(function (e) {
      track.push.apply(track, vlq(e.tick - last));
      track.push.apply(track, e.data);
      last = e.tick;
    });
    const header = [0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1,
                    (MIDI_PPQ >> 8) & 0xFF, MIDI_PPQ & 0xFF];
    const len = track.length;
    const trackHeader = [0x4D, 0x54, 0x72, 0x6B,
                         (len >>> 24) & 0xFF, (len >>> 16) & 0xFF, (len >>> 8) & 0xFF, len & 0xFF];
    return { bytes: Uint8Array.from(header.concat(trackHeader, track)), eventCount: onsets.length };
  }

  return {
    parseRhythm: parseRhythm,
    formatNumber: formatNumber,
    totalDuration: totalDuration,
    durationsToOnsets: durationsToOnsets,
    curveWeight: curveWeight,
    samplePositions: samplePositions,
    interpolateRhythm: interpolateRhythm,
    interpolateEqualDurations: interpolateEqualDurations,
    interpolateWarp: interpolateWarp,
    renderTimelineSVG: renderTimelineSVG,
    quantizeStep: quantizeStep,
    unitLabel: unitLabel,
    stepToABC: stepToABC,
    stepToABCGlobal: stepToABCGlobal,
    quantizeNotation: quantizeNotation,
    abcFromQuantized: abcFromQuantized,
    groupActual: groupActual,
    makeNotationLayers: makeNotationLayers,
    decomposeWritten: decomposeWritten,
    reduceRatio: reduceRatio,
    splitPiecesAtBars: splitPiecesAtBars,
    parseMeter: parseMeter,
    beatMisalignment: beatMisalignment,
    beatsCrossed: beatsCrossed,
    DEFAULT_WEIGHTS: DEFAULT_WEIGHTS,
    DEFAULT_MIN_BRACKET_NOTES: DEFAULT_MIN_BRACKET_NOTES,
    DEFAULT_TUPLETS: DEFAULT_TUPLETS,
    parseTuplets: parseTuplets,
    ABC_MAX_TUPLET: ABC_MAX_TUPLET,
    splitTuplet: splitTuplet,
    canRenderTuplet: canRenderTuplet,
    stepColor: stepColor,
    buildRhythmMidi: buildRhythmMidi,
    MIDI_PPQ: MIDI_PPQ,
    vlq: vlq
  };
});
