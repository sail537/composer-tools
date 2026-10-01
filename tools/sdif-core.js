/* ============================================================
   SDIF 读取核心（把频谱分析结果变成音高素材）
   ------------------------------------------------------------
   SDIF 是 IRCAM 存频谱分析结果的格式。SPEAR / AudioSculpt / SuperVP
   导出的正弦成分分析就是它。这个文件把 .sdif 读成：
     分音轨迹（partial tracks） → 音符 → 和弦快照
   语义与 OpenMusic 的 sdif->chord-seq 对齐（见 OM 8.0 的
   code/projects/sdif/sdif-om/cseq2sdif.lisp）：
     · 1TRC / 1HRM 帧：每行 (序号, 频率Hz, 振幅, 相位)，按序号累积成分音轨迹
     · 1MRK 帧：内含 1BEG / 1TRC / 1END 三个矩阵，给出一组有起止的音符
     · 1NVT 帧：名字/值表（元数据），跳过

   字节布局（对着 OM 自带样例实测确定，四个样例零异常行）：
     文件头 16 字节： "SDIF" + 3 个 uint32
     帧头 24 字节：   char[4] 帧类型 | uint32 帧体字节数 | float64 时间(秒)
                      | uint32 streamID | uint32 矩阵个数
     矩阵头 16 字节： char[4] 矩阵类型 | uint32 保留/元素尺寸 | uint32 nRows
                      | uint32 nCols
     数据：nRows × nCols 个元素，行主序，整体补到 8 字节

   这个文件不碰 DOM：浏览器挂 window.SdifCore，Node 里可 require 做测试。
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SdifCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FILE_HEADER = 16;
  const FRAME_HEADER = 24;
  const MATRIX_HEADER = 16;

  /* 这些帧类型的矩阵数据是字符串/字节，元素尺寸 1；其余按 4 字节浮点 */
  const BYTE_TYPES = { '1NVT': true, '1TYP': true, '1TXT': true };

  const TRACK_TYPES = { '1TRC': true, '1HRM': true };

  function pad8(n) { return (n + 7) & ~7; }

  function signature(buf, off) {
    return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
  }

  function isSignature(s) {
    return /^[\x20-\x7e]{4}$/.test(s);
  }

  /* 一个 4 字节单元可能是 float32，也可能是 int32——SDIF 里 1BEG/1END 的序号列
     就是 int32。整数值当 float 读会变成 1e-45 这种次正规数，几乎不可能出现在
     真实数据里，所以用这个特征自动判别。 */
  function readCell(dv, off) {
    const f = dv.getFloat32(off);
    if (f === 0 || Math.abs(f) > 1e-30) return f;
    return dv.getInt32(off);
  }

  /* ---------- 底层：把字节流切成帧 / 矩阵 ---------- */

  function parseSDIF(input) {
    const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (signature(buf, 0) !== 'SDIF') throw new Error('不是 SDIF 文件（开头应是 SDIF）');

    const frames = [];
    let off = FILE_HEADER;
    let trailing = 0;
    while (off + FRAME_HEADER <= buf.length) {
      const sig = signature(buf, off);
      const size = dv.getUint32(off + 4);
      if (!isSignature(sig) || size < 16 || off + 8 + size > buf.length) break;
      const time = dv.getFloat64(off + 8);
      const id = dv.getUint32(off + 16);
      const nbMatrix = dv.getUint32(off + 20);
      const end = off + 8 + size;

      const matrices = [];
      let m = off + FRAME_HEADER;
      for (let i = 0; i < nbMatrix; i++) {
        if (m + MATRIX_HEADER > end) break;
        const msig = signature(buf, m);
        if (!isSignature(msig)) break;
        const rows = dv.getUint32(m + 8);
        const cols = dv.getUint32(m + 12);
        const elemSize = BYTE_TYPES[msig] ? 1 : 4;
        const dataOff = m + MATRIX_HEADER;
        const need = rows * cols * elemSize;
        if (rows < 0 || cols < 0 || dataOff + need > end) break;

        const data = [];
        if (elemSize === 1) {
          let text = '';
          for (let k = 0; k < rows * cols; k++) text += String.fromCharCode(buf[dataOff + k]);
          data.push(text);
        } else {
          for (let r = 0; r < rows; r++) {
            const row = new Array(cols);
            for (let c = 0; c < cols; c++) row[c] = readCell(dv, dataOff + (r * cols + c) * 4);
            data.push(row);
          }
        }
        matrices.push({ sig: msig, rows: rows, cols: cols, elemSize: elemSize, data: data });
        m = dataOff + pad8(need);
      }
      frames.push({ sig: sig, time: time, id: id, matrices: matrices });
      off = end;
    }
    trailing = buf.length - off;

    const types = {};
    frames.forEach(function (f) { types[f.sig] = (types[f.sig] || 0) + 1; });
    /* 元数据帧（1NVT / 1TYP）没有有意义的时间戳，不能进时间统计 */
    const times = frames
      .filter(function (f) { return isFinite(f.time) && Math.abs(f.time) < 1e9; })
      .map(function (f) { return f.time; });
    return {
      frames: frames,
      types: types,
      bytes: buf.length,
      trailing: trailing,
      times: times
    };
  }

  /* 采样间隔（秒）：相邻帧时间的众数差 */
  function frameInterval(parsed) {
    const t = parsed.times;
    if (t.length < 2) return 0;
    const diffs = [];
    for (let i = 1; i < t.length; i++) {
      const d = t[i] - t[i - 1];
      if (d > 1e-9) diffs.push(d);
    }
    if (!diffs.length) return 0;
    diffs.sort(function (a, b) { return a - b; });
    return diffs[Math.floor(diffs.length / 2)];
  }

  /* ---------- 分音轨迹：1TRC / 1HRM ---------- */

  /* 每个序号一条轨迹：时间序列 + 频率序列 + 振幅序列 */
  function partialTracks(parsed, options) {
    options = options || {};
    const minAmp = options.minAmp == null ? 0 : options.minAmp;
    const map = new Map();
    parsed.frames.forEach(function (f) {
      if (!TRACK_TYPES[f.sig]) return;
      f.matrices.forEach(function (mat) {
        if (!TRACK_TYPES[mat.sig]) return;
        mat.data.forEach(function (row) {
          const index = Math.round(row[0]);
          const freq = row[1];
          const amp = row[2];
          const phase = row.length > 3 ? row[3] : 0;
          if (!(index >= 1) || !(freq > 0)) return;
          if (amp < minAmp) return;
          let track = map.get(index);
          if (!track) {
            track = { index: index, times: [], freqs: [], amps: [], phases: [] };
            map.set(index, track);
          }
          track.times.push(f.time);
          track.freqs.push(freq);
          track.amps.push(amp);
          track.phases.push(phase);
        });
      });
    });
    const out = Array.from(map.values());
    out.forEach(function (t) {
      t.start = t.times[0];
      t.end = t.times[t.times.length - 1];
      t.meanFreq = t.freqs.reduce(function (a, b) { return a + b; }, 0) / t.freqs.length;
      t.maxAmp = Math.max.apply(null, t.amps);
      t.meanAmp = t.amps.reduce(function (a, b) { return a + b; }, 0) / t.amps.length;
    });
    out.sort(function (a, b) { return a.start - b.start || a.index - b.index; });
    return out;
  }

  /* ---------- 记号音符：1MRK（1BEG / 1TRC / 1END） ---------- */

  /* 对应 OM 的 GetSDIFChords 里 mrk 那一支：
     1BEG 给起点、1TRC 给频率与振幅、1END 给终点 */
  function markerNotes(parsed) {
    const notes = new Map();
    parsed.frames.forEach(function (f) {
      if (f.sig !== '1MRK' && f.sig !== '1TRC') return;
      f.matrices.forEach(function (mat) {
        if (mat.sig === '1BEG') {
          mat.data.forEach(function (row) {
            const index = Math.round(row[0]);
            if (!(index >= 1)) return;
            notes.set(index, { index: index, onset: f.time, end: null, freq: 0, amp: 0 });
          });
        } else if (TRACK_TYPES[mat.sig]) {
          mat.data.forEach(function (row) {
            const index = Math.round(row[0]);
            const n = notes.get(index);
            if (!n) return;
            n.freq = row[1];
            n.amp = row[2];
          });
        } else if (mat.sig === '1END') {
          mat.data.forEach(function (row) {
            const index = Math.round(row[0]);
            const n = notes.get(index);
            if (n) n.end = f.time;
          });
        }
      });
    });
    const out = Array.from(notes.values()).filter(function (n) { return n.freq > 0; });
    out.forEach(function (n) {
      if (n.end == null) n.end = n.onset;
      n.dur = Math.max(0, n.end - n.onset);
    });
    out.sort(function (a, b) { return a.onset - b.onset || a.freq - b.freq; });
    return out;
  }

  /* ---------- 两种“变成音高素材”的方式 ---------- */

  /* 方式一：分音轨迹 → 音符（每条轨迹一个长音，音高取轨迹的均值） */
  function tracksToNotes(tracks, options) {
    options = options || {};
    const minDur = options.minDur == null ? 0 : options.minDur;
    const maxNotes = options.maxNotes == null ? 0 : options.maxNotes;
    let list = tracks
      .filter(function (t) { return t.end - t.start >= minDur - 1e-9; })
      .sort(function (a, b) { return b.maxAmp - a.maxAmp; });
    if (maxNotes > 0) list = list.slice(0, maxNotes);
    return list.map(function (t) {
      return {
        freq: t.meanFreq, onset: t.start, dur: Math.max(t.end - t.start, 0),
        amp: t.maxAmp, index: t.index,
        freqs: t.freqs, times: t.times, amps: t.amps
      };
    }).sort(function (a, b) { return a.onset - b.onset; });
  }

  /* 方式二：按帧切片 —— 每个帧时刻就是一个和弦（频谱快照） */
  function frameChords(parsed, options) {
    options = options || {};
    const minAmp = options.minAmp == null ? 0 : options.minAmp;
    const maxPerChord = options.maxPerChord == null ? 0 : options.maxPerChord;
    const out = [];
    parsed.frames.forEach(function (f) {
      if (!TRACK_TYPES[f.sig]) return;
      const parts = [];
      f.matrices.forEach(function (mat) {
        if (!TRACK_TYPES[mat.sig]) return;
        mat.data.forEach(function (row) {
          if (!(row[1] > 0) || row[2] < minAmp) return;
          parts.push({ index: Math.round(row[0]), freq: row[1], amp: row[2] });
        });
      });
      if (!parts.length) return;
      parts.sort(function (a, b) { return b.amp - a.amp; });
      out.push({ time: f.time, partials: maxPerChord > 0 ? parts.slice(0, maxPerChord) : parts });
    });
    return out;
  }

  /* ---------- 统计与筛选 ---------- */

  function summarize(parsed, tracks) {
    const s = {
      bytes: parsed.bytes,
      frameCount: parsed.frames.length,
      types: parsed.types,
      frameInterval: frameInterval(parsed),
      trackCount: tracks.length,
      trailing: parsed.trailing
    };
    if (parsed.times.length) {
      s.startTime = Math.min.apply(null, parsed.times);
      s.endTime = Math.max.apply(null, parsed.times);
      s.duration = s.endTime - s.startTime;
    }
    if (tracks.length) {
      s.freqLow = Math.min.apply(null, tracks.map(function (t) { return Math.min.apply(null, t.freqs); }));
      s.freqHigh = Math.max.apply(null, tracks.map(function (t) { return Math.max.apply(null, t.freqs); }));
      s.ampMax = Math.max.apply(null, tracks.map(function (t) { return t.maxAmp; }));
    }
    return s;
  }

  /* ---------- 频率 → 音高 ---------- */

  function freqToMidi(freq) { return 69 + 12 * Math.log2(freq / 440); }
  function midiToFreq(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

  function pitchCentsDev(freq, midi) {
    return 1200 * Math.log2(freq / midiToFreq(midi));
  }

  /* 把频率吸附到最接近的 12 平均律音；返回 {midi, cents, name} */
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function snapFreq(freq) {
    const m = freqToMidi(freq);
    const rounded = Math.round(m);
    const octave = Math.floor(rounded / 12) - 1;
    return {
      midi: m, rounded: rounded, cents: (m - rounded) * 100,
      name: NAMES[((rounded % 12) + 12) % 12] + octave
    };
  }

  /* ---------- 音符 → 和弦快照（乐谱的一列） ---------- */

  /* 与 OM 的 sdif->chord-seq 同一思路：把起点相同的音并成一个和弦。
     起点先吸到时间网格上（gridSeconds，0 表示不吸附）。 */
  function notesToMoments(notes, options) {
    options = options || {};
    const grid = options.gridSeconds > 0 ? options.gridSeconds : 0;
    const bucket = new Map();
    notes.forEach(function (n) {
      const t = grid > 0 ? Math.round(n.onset / grid) * grid : n.onset;
      const key = t.toFixed(6);
      if (!bucket.has(key)) bucket.set(key, { time: t, notes: [] });
      bucket.get(key).notes.push(n);
    });
    const out = Array.from(bucket.values());
    out.sort(function (a, b) { return a.time - b.time; });
    out.forEach(function (m) {
      m.notes.sort(function (a, b) { return a.freq - b.freq; });
      m.freqs = m.notes.map(function (n) { return n.freq; });
      m.midis = m.freqs.map(freqToMidi);
      m.amps = m.notes.map(function (n) { return n.amp; });
      m.indexes = m.notes.map(function (n) { return n.index; });
    });
    return out;
  }

  /* 帧切片直接就是和弦快照 */
  function frameChordsToMoments(chords) {
    return chords.map(function (c) {
      const freqs = c.partials.map(function (p) { return p.freq; });
      return {
        time: c.time, freqs: freqs, midis: freqs.map(freqToMidi),
        amps: c.partials.map(function (p) { return p.amp; }),
        indexes: c.partials.map(function (p) { return p.index; }),
        notes: c.partials
      };
    });
  }

  /* ---------- 频谱图：横轴时间、纵轴频率、大小与透明度 = 振幅 ---------- */

  /* 频谱图的画布几何：demo 里的播放头要用同一套数字才能对齐 */
  const SPECTRUM_GEOM = { W: 940, H: 360, left: 58, right: 16, top: 26, bottom: 38 };

  function renderSpectrumSVG(tracks, options) {
    options = options || {};
    const dark = !!options.dark;
    const W = SPECTRUM_GEOM.W, H = SPECTRUM_GEOM.H;
    const left = SPECTRUM_GEOM.left, right = SPECTRUM_GEOM.right;
    const top = SPECTRUM_GEOM.top, bottom = SPECTRUM_GEOM.bottom;
    const bg = dark ? '#1c1c1e' : '#ffffff';
    const ink = dark ? '#f2f2f7' : '#1c1c1e';
    const muted = dark ? '#a1a1aa' : '#6b6b70';
    const axis = dark ? '#48484a' : '#d9d9de';
    const p = [];
    p.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H
      + '" font-family="-apple-system, \'PingFang SC\', Helvetica, Arial, sans-serif">');
    p.push('<rect width="' + W + '" height="' + H + '" fill="' + bg + '"/>');

    const pts = [];
    tracks.forEach(function (t) {
      for (let i = 0; i < t.times.length; i++) {
        pts.push({ t: t.times[i], f: t.freqs[i], a: t.amps[i] });
      }
    });
    if (!pts.length) {
      p.push('<text x="' + (W / 2) + '" y="' + (H / 2) + '" font-size="12" fill="' + muted
        + '" text-anchor="middle">没有 1TRC 分音数据</text></svg>');
      return p.join('\n');
    }
    const tMin = Math.min.apply(null, pts.map(function (x) { return x.t; }));
    const tMax = Math.max.apply(null, pts.map(function (x) { return x.t; }));
    let fMin = options.freqLow > 0 ? options.freqLow : Math.min.apply(null, pts.map(function (x) { return x.f; }));
    let fMax = options.freqHigh > 0 ? options.freqHigh : Math.max.apply(null, pts.map(function (x) { return x.f; }));
    fMin = Math.max(fMin, 20);
    if (!(fMax > fMin * 1.01)) fMax = fMin * 2;
    const aMax = Math.max.apply(null, pts.map(function (x) { return x.a; })) || 1;
    const logMin = Math.log2(fMin), logMax = Math.log2(fMax);
    const plotW = W - left - right, plotH = H - top - bottom;
    const xOf = function (t) { return left + (tMax > tMin ? (t - tMin) / (tMax - tMin) : 0.5) * plotW; };
    const yOf = function (f) { return top + plotH - (Math.log2(f) - logMin) / (logMax - logMin) * plotH; };

    /* 频率刻度：整八度 */
    for (let oct = Math.ceil(logMin); oct <= logMax; oct++) {
      const y = yOf(Math.pow(2, oct));
      p.push('<line x1="' + left + '" y1="' + y.toFixed(1) + '" x2="' + (W - right) + '" y2="' + y.toFixed(1)
        + '" stroke="' + axis + '" stroke-width="0.7" stroke-dasharray="3 3"/>');
      p.push('<text x="' + (left - 8) + '" y="' + (y + 3.5).toFixed(1) + '" font-size="10" fill="' + muted
        + '" text-anchor="end">' + Math.round(Math.pow(2, oct)) + ' Hz</text>');
    }
    const tSteps = 5;
    for (let i = 0; i <= tSteps; i++) {
      const t = tMin + (tMax - tMin) * i / tSteps;
      const x = xOf(t);
      p.push('<line x1="' + x.toFixed(1) + '" y1="' + top + '" x2="' + x.toFixed(1) + '" y2="' + (top + plotH)
        + '" stroke="' + axis + '" stroke-width="0.7"/>');
      p.push('<text x="' + x.toFixed(1) + '" y="' + (top + plotH + 16) + '" font-size="10" fill="' + muted
        + '" text-anchor="middle">' + t.toFixed(2) + 's</text>');
    }
    /* 点：按振幅调半径与透明度 */
    pts.forEach(function (x) {
      if (x.f < fMin || x.f > fMax) return;
      const r = (1.1 + 2.6 * Math.sqrt(Math.min(1, x.a / aMax))).toFixed(2);
      const o = (0.25 + 0.7 * Math.min(1, x.a / aMax)).toFixed(2);
      p.push('<circle cx="' + xOf(x.t).toFixed(1) + '" cy="' + yOf(x.f).toFixed(1) + '" r="' + r
        + '" fill="#0a6cff" opacity="' + o + '"/>');
    });
    /* 播放头：默认隐藏，demo 回放时直接改 x1/x2 */
    p.push('<line class="playhead" x1="' + left + '" y1="' + top + '" x2="' + left + '" y2="' + (top + plotH)
      + '" stroke="#ff3b30" stroke-width="1.5" opacity="0"/>');
    p.push('<text x="' + left + '" y="16" font-size="12" font-weight="600" fill="' + ink + '">'
      + '频谱（点＝某时刻的一个分音，大小与深浅＝振幅）</text>');
    p.push('</svg>');
    return p.join('\n');
  }

  /* ---------- 慢速回放用的轨迹分段 ---------- */

  /* 把一条轨迹切成若干段，并在段内抽稀。慢速回放要听的是「包络过程」，
     所以这里只做数据准备，Web Audio 的调度放在 demo 里。

     为什么要切段：SDIF 里的分音会因为振幅掉到门限以下而中断，
     按序号累积时中间的空档会被抹掉；不切段就会听到一个拖长的假音。
     为什么要抽稀：帧间隔只有几毫秒，一秒钟就是几百个自动化点，
     原样铺给 Web Audio 会卡；抽到 step 秒一个点，听感几乎没差别。 */
  function trackSegments(tracks, options) {
    options = options || {};
    const gap = options.gapSeconds > 0 ? options.gapSeconds : 0.03;
    const step = options.stepSeconds > 0 ? options.stepSeconds : 0.02;
    const out = [];
    tracks.forEach(function (track) {
      let seg = null;
      let lastKept = -Infinity;
      for (let i = 0; i < track.times.length; i++) {
        const t = track.times[i];
        const f = track.freqs[i];
        const a = track.amps[i];
        if (seg && (t - seg.end) > gap) {
          /* 时间上断了：给这一段收一个淡出点，然后另起一段 */
          const last = seg.points[seg.points.length - 1];
          if (last && last.a > 0) seg.points.push({ t: seg.end, f: last.f, a: 0 });
          out.push(seg);
          seg = null;
        }
        if (!seg) {
          seg = { index: track.index, start: t, end: t, points: [{ t: t, f: f, a: a }] };
          lastKept = t;
          continue;
        }
        seg.end = t;
        if (t - lastKept >= step) {
          seg.points.push({ t: t, f: f, a: a });
          lastKept = t;
        }
      }
      if (seg) {
        const last = seg.points[seg.points.length - 1];
        if (last && last.a > 0) seg.points.push({ t: seg.end, f: last.f, a: 0 });
        out.push(seg);
      }
    });
    return out.filter(function (s) { return s.points.length >= 2; });
  }

  function segmentPeak(seg) {
    return seg.points.reduce(function (m, p) { return Math.max(m, p.a); }, 0);
  }

  /* ---------- MIDI 导出：音符按绝对时间摆放 ---------- */

  /* 包络轨道：横轴与五线谱共用同一套列几何（leftPad + i·colWidth），
     所以把它放在谱面正下方就能逐列对齐。columns = [{time, amp}]，amp 已归一化到 0–1。 */
  function renderEnvelopeSVG(columns, options) {
    options = options || {};
    const dark = !!options.dark;
    const leftPad = options.leftPad == null ? 96 : options.leftPad;
    const colWidth = options.colWidth == null ? 70 : options.colWidth;
    const rightPad = options.rightPad == null ? 30 : options.rightPad;
    const H = options.height || 72;
    const n = Math.max(1, (columns || []).length);
    const W = leftPad + n * colWidth + rightPad;
    const pad = 12;
    const baseY = H - pad - 10;
    const topY = pad + 4;
    const ink = dark ? '#f2f2f7' : '#1c1c1e';
    const muted = dark ? '#a1a1aa' : '#6b6b70';
    const axis = dark ? '#48484a' : '#d9d9de';
    const p = [];
    p.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H
      + '" font-family="-apple-system, \'PingFang SC\', Helvetica, Arial, sans-serif">');

    /* 每列的横坐标＝该列符头所在的位置 */
    const xOf = function (i) { return leftPad + i * colWidth; };
    p.push('<line x1="' + (leftPad - 14) + '" y1="' + baseY + '" x2="' + (W - rightPad + 6) + '" y2="' + baseY
      + '" stroke="' + axis + '" stroke-width="1"/>');
    p.push('<text x="' + (leftPad - 20) + '" y="' + (baseY + 4) + '" font-size="10" fill="' + muted
      + '" text-anchor="end">振幅</text>');

    if (!columns || !columns.length) {
      p.push('<text x="' + (W / 2) + '" y="' + (H / 2) + '" font-size="11" fill="' + muted
        + '" text-anchor="middle">（没有数据）</text></svg>');
      return p.join('\n');
    }
    const pts = columns.map(function (c, i) {
      const a = Math.min(1, Math.max(0, c.amp || 0));
      return { x: xOf(i), y: baseY - (baseY - topY) * a, a: a };
    });
    /* 折线 + 逐列圆点，点的大小再强调一次振幅 */
    p.push('<polyline fill="none" stroke="#0a6cff" stroke-width="1.8" stroke-linejoin="round" points="'
      + pts.map(function (q) { return q.x.toFixed(1) + ',' + q.y.toFixed(1); }).join(' ') + '"/>');
    pts.forEach(function (q) {
      p.push('<circle cx="' + q.x.toFixed(1) + '" cy="' + q.y.toFixed(1) + '" r="'
        + (2.2 + 3.4 * Math.sqrt(q.a)).toFixed(2) + '" fill="#0a6cff" opacity="0.85"/>');
    });
    p.push('<text x="' + (leftPad - 20) + '" y="' + (topY + 4) + '" font-size="10" fill="' + muted
      + '" text-anchor="end">最大</text>');
    p.push('<text x="' + (W - rightPad + 6) + '" y="' + (H - 2) + '" font-size="10" fill="' + muted
      + '" text-anchor="end">时间 →</text>');
    p.push('</svg>');
    return p.join('\n');
  }

  const MIDI_PPQ = 480;
  const NOTES_PER_WHOLE = 4;

  function vlq(value) {
    const bytes = [value & 0x7F];
    let v = value >> 7;
    while (v > 0) { bytes.unshift((v & 0x7F) | 0x80); v >>= 7; }
    return bytes;
  }

  /* notes: [{freq, onset, dur, amp}]，时间单位秒。bpm 决定秒→tick 的换算。 */
  function buildNotesMidi(notes, options) {
    options = options || {};
    const bpm = Math.max(20, Math.min(400, Number(options.bpm) || 120));
    const gate = options.gate == null ? 0.95 : options.gate;
    const tickOf = function (t) { return Math.max(0, Math.round(t * bpm / 60 * MIDI_PPQ)); };
    const events = [];
    let seq = 0;
    const push = function (tick, order, data) { events.push({ tick: tick, order: order, seq: seq++, data: data }); };
    const usPerBeat = Math.round(60000000 / bpm);
    push(0, 0, [0xFF, 0x51, 0x03, (usPerBeat >> 16) & 0xFF, (usPerBeat >> 8) & 0xFF, usPerBeat & 0xFF]);
    const aMax = Math.max.apply(null, notes.map(function (n) { return n.amp; })) || 1;
    notes.forEach(function (n) {
      const midi = Math.max(0, Math.min(127, Math.round(freqToMidi(n.freq))));
      const vel = Math.max(1, Math.min(127, Math.round(30 + 97 * Math.sqrt(n.amp / aMax))));
      const start = tickOf(n.onset);
      const dur = Math.max(1, Math.round(n.dur * bpm / 60 * MIDI_PPQ * gate));
      push(start, 3, [0x90, midi, vel]);
      push(start + dur, 2, [0x80, midi, 0]);
    });
    /* 结束标记必须排在所有事件之后：用实际事件的最大 tick 加一，
       不能拿「起点+时值」估算——取整方式不同会让 note-off 反而更大。 */
    const lastTick = events.reduce(function (m, e) { return Math.max(m, e.tick); }, 1) + 1;
    push(lastTick, 0, [0xFF, 0x2F, 0x00]);
    events.sort(function (a, b) { return a.tick - b.tick || a.order - b.order || a.seq - b.seq; });
    const track = [];
    let last = 0;
    events.forEach(function (e) {
      track.push.apply(track, vlq(e.tick - last));
      track.push.apply(track, e.data);
      last = e.tick;
    });
    const header = [0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 1, 0,
                    (MIDI_PPQ >> 8) & 0xFF, MIDI_PPQ & 0xFF];
    const len = track.length;
    const trackHeader = [0x4D, 0x54, 0x72, 0x6B,
                         (len >>> 24) & 0xFF, (len >>> 16) & 0xFF, (len >>> 8) & 0xFF, len & 0xFF];
    return { bytes: Uint8Array.from(header.concat(trackHeader, track)), eventCount: notes.length };
  }

  return {
    parseSDIF: parseSDIF,
    frameInterval: frameInterval,
    partialTracks: partialTracks,
    markerNotes: markerNotes,
    tracksToNotes: tracksToNotes,
    frameChords: frameChords,
    summarize: summarize,
    freqToMidi: freqToMidi,
    midiToFreq: midiToFreq,
    pitchCentsDev: pitchCentsDev,
    snapFreq: snapFreq,
    notesToMoments: notesToMoments,
    frameChordsToMoments: frameChordsToMoments,
    trackSegments: trackSegments,
    segmentPeak: segmentPeak,
    SPECTRUM_GEOM: SPECTRUM_GEOM,
    renderSpectrumSVG: renderSpectrumSVG,
    renderEnvelopeSVG: renderEnvelopeSVG,
    buildNotesMidi: buildNotesMidi
  };
});
