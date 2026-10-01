/* ============================================================
   插值计算器 · 核心逻辑
   ------------------------------------------------------------
   这个文件不碰 DOM，浏览器里挂到 window.InterpCore，
   Node 里可以直接 require 做单元测试。
   算法与 OpenMusic 8.0 的 INTERPOLATION 保持同构：

       w(t, curve) = t ^ ( e ^ (-curve) )
       C(t) = A + (B - A) * w(t, curve)

   curve = 0 线性；curve > 0 先快后慢；curve < 0 先慢后快。
   频率域插值对应 OpenMusic / OMTristan 的 f-interpol：
   先把 MIDI 转成 Hz，线性插值频率，再转回 MIDI。
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InterpCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIDI_A4 = 69;
  const FREQ_A4 = 440;
  const PPQ = 480;

  const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const FLAT_NAMES  = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
  const BLACK_PC = new Set([1, 3, 6, 8, 10]);

  function mod12(n) { return ((n % 12) + 12) % 12; }

  function midiToFreq(midi) {
    return FREQ_A4 * Math.pow(2, (midi - MIDI_A4) / 12);
  }

  function freqToMidi(freq) {
    return MIDI_A4 + 12 * Math.log2(freq / FREQ_A4);
  }

  /* ---------- 音名 / 输入解析 ---------- */

  function pitchParts(midi, opts) {
    opts = opts || {};
    const names = opts.flats ? FLAT_NAMES : SHARP_NAMES;
    const rounded = Math.round(midi);
    const cents = Math.round((midi - rounded) * 100);
    const pc = mod12(rounded);
    const octave = Math.floor(rounded / 12) - 1;
    return {
      midi: midi,
      rounded: rounded,
      cents: cents,
      pc: pc,
      octave: octave,
      name: names[pc] + octave,
      accidental: BLACK_PC.has(pc) ? '♯' : '',
      black: BLACK_PC.has(pc)
    };
  }

  function midiToName(midi, opts) {
    return pitchParts(midi, opts).name;
  }

  function midiToLabel(midi, opts) {
    const p = pitchParts(midi, opts);
    if (Math.abs(p.cents) < 1) return p.name;
    return p.name + (p.cents > 0 ? ' +' : ' −') + Math.abs(p.cents) + '¢';
  }

  /* 接受 C4 / C#4 / Db4 / C♯4 / 60 / 60.5 之类的写法 */
  function parsePitchToken(token) {
    const t = String(token).trim();
    if (!t) return null;
    const num = Number(t);
    if (Number.isFinite(num)) return num;
    const m = t.match(/^([A-Ga-g])([#♯b♭]?)(-?\d+)$/);
    if (!m) return null;
    const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()];
    const acc = m[2] === '#' || m[2] === '♯' ? 1 : (m[2] === 'b' || m[2] === '♭' ? -1 : 0);
    const octave = parseInt(m[3], 10);
    return (octave + 1) * 12 + base + acc;
  }

  function parseChordText(text) {
    const tokens = String(text).split(/[\s,;、，]+/).filter(Boolean);
    const out = [];
    for (const token of tokens) {
      const v = parsePitchToken(token);
      if (v === null) throw new Error('无法识别：' + token);
      out.push(v);
    }
    out.sort(function (a, b) { return a - b; });
    const dedup = [];
    for (const v of out) {
      if (!dedup.some(function (x) { return Math.abs(x - v) < 1e-9; })) dedup.push(v);
    }
    return dedup;
  }

  /* ---------- 插值算法（与 OM 同构） ---------- */

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

  function computeInterpolation(cfg) {
    const chordA = cfg.chordA.slice();
    const chordB = cfg.chordB.slice();
    if (!chordA.length || !chordB.length) throw new Error('起点和终点都不能为空');
    if (chordA.length !== chordB.length) {
      throw new Error('起点 ' + chordA.length + ' 个音，终点 ' + chordB.length + ' 个音；音数必须相同');
    }
    const samples = Math.max(1, Math.min(128, Math.round(cfg.samples || 1)));
    const curve = Number(cfg.curve || 0);
    const domain = cfg.domain === 'freq' ? 'freq' : 'midi';
    const positions = samplePositions(samples);
    const weights = positions.map(function (t) { return curveWeight(t, curve); });
    const chords = positions.map(function (t, j) {
      return chordA.map(function (a, i) {
        const b = chordB[i];
        const w = weights[j];
        if (domain === 'freq') {
          const fa = midiToFreq(a);
          const fb = midiToFreq(b);
          return freqToMidi(fa + (fb - fa) * w);
        }
        return a + (b - a) * w;
      });
    });
    return { samples: samples, curve: curve, domain: domain, positions: positions, weights: weights, chords: chords };
  }

  function buildRows(result, opts) {
    return result.chords.map(function (chord, j) {
      const notes = chord.map(function (midi) {
        const parts = pitchParts(midi, opts);
        parts.freq = midiToFreq(midi);
        return parts;
      });
      const midiRounded = chord.map(function (m) {
        return Math.max(0, Math.min(127, Math.round(m)));
      });
      const freqs = notes.map(function (n) { return n.freq; });
      const centroid = freqs.reduce(function (s, f) { return s + f; }, 0) / (freqs.length || 1);
      return {
        index: j,
        t: result.positions[j],
        weight: result.weights[j],
        notes: notes,
        midiRounded: midiRounded,
        centroid: centroid
      };
    });
  }

  /* ---------- MIDI 文件写出（SMF format 0） ---------- */

  function vlq(value) {
    let n = Math.max(0, Math.round(value));
    const bytes = [n & 0x7f];
    n >>= 7;
    while (n > 0) {
      bytes.unshift((n & 0x7f) | 0x80);
      n >>= 7;
    }
    return bytes;
  }

  function asciiBytes(text) {
    const out = [];
    for (let i = 0; i < text.length; i++) out.push(text.charCodeAt(i) & 0x7f);
    return out;
  }

  /* 文本 meta 按 SMF 规范用 ASCII；把音乐符号换成可读的 ASCII 写法 */
  function asciiSafe(text) {
    return String(text)
      .replace(/♯/g, '#')
      .replace(/♭/g, 'b')
      .replace(/−/g, '-')
      .replace(/¢/g, 'c');
  }

  function clampNumber(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  /* 文本 meta：让文件本身保留精确音分信息（即使合成器忽略微分音也能读到） */
  function textMetaBytes(text) {
    const bytes = asciiBytes(asciiSafe(text));
    return [0xFF, 0x01].concat(vlq(bytes.length), bytes);
  }

  function chordText(index, chord, assigned) {
    const items = chord.map(function (v, i) {
      const p = pitchParts(v, {});
      const cents = p.cents === 0 ? '' : (p.cents > 0 ? ' +' + p.cents : ' ' + p.cents) + 'c';
      const key = assigned ? ' key=' + assigned[i] : '';
      return p.name + cents + ' [' + v.toFixed(4) + ']' + key;
    });
    return '#' + (index + 1) + ' ' + items.join(', ');
  }

  function uniqueRoundedNotes(chord) {
    return Array.from(new Set(chord.map(function (m) {
      return clampNumber(Math.round(m), 0, 127);
    }))).sort(function (a, b) { return a - b; });
  }

  function packMidiEvents(events, ppq) {
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
    const header = [0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (ppq >> 8) & 0xFF, ppq & 0xFF];
    const len = track.length;
    const trackHeader = [0x4D, 0x54, 0x72, 0x6B, (len >>> 24) & 0xFF, (len >>> 16) & 0xFF, (len >>> 8) & 0xFF, len & 0xFF];
    return Uint8Array.from(header.concat(trackHeader, track));
  }

  function buildMidiFile(cfg) {
    const chords = cfg.chords || [];
    const stepMs = Math.max(10, Number(cfg.stepMs || 500));
    const gate = Math.min(1, Math.max(0.05, Number(cfg.gate == null ? 0.9 : cfg.gate)));
    const bpm = Math.max(20, Math.min(400, Number(cfg.bpm || 120)));
    const program = cfg.program == null ? 0 : Number(cfg.program);
    const trackName = cfg.trackName || 'Interpolation';
    const microMode = cfg.microMode || 'plain';          // plain | bend | mts
    const bendRange = clampNumber(Number(cfg.bendRange || 2), 0.25, 24);
    const includeText = cfg.includeText !== false;

    const msPerBeat = 60000 / bpm;
    const stepTicks = Math.max(1, Math.round(stepMs * PPQ / msPerBeat));
    const durTicks = Math.max(1, Math.round(stepTicks * gate));

    const hasMicro = chords.some(function (chord) {
      return chord.some(function (v) { return Math.abs(v - Math.round(v)) > 1e-6; });
    });
    /* 没有微分音时自动走最兼容的单通道 12 平均律写法 */
    const mode = hasMicro && (microMode === 'bend' || microMode === 'mts') ? microMode : 'plain';
    const maxVoices = chords.reduce(function (m, c) { return Math.max(m, c.length); }, 0);

    const events = [];
    let seq = 0;
    function push(tick, order, data) { events.push({ tick: tick, order: order, seq: seq++, data: data }); }

    const usPerBeat = Math.round(60000000 / bpm);
    push(0, 0, [0xFF, 0x51, 0x03, (usPerBeat >> 16) & 0xFF, (usPerBeat >> 8) & 0xFF, usPerBeat & 0xFF]);
    push(0, 0, [0xFF, 0x58, 0x04, 4, 2, 24, 8]);
    const nameBytes = asciiBytes(trackName);
    push(0, 0, [0xFF, 0x03].concat(vlq(nameBytes.length), nameBytes));
    if (includeText) {
      push(0, 0, textMetaBytes('interpolation micro=' + mode + ' bendRange=' + bendRange
        + ' voices=' + maxVoices + ' tuning=' + (hasMicro ? 'microtonal' : '12tet')));
    }

    /* ---------- 12 平均律（最兼容） ---------- */
    if (mode === 'plain') {
      if (program >= 0) push(0, 1, [0xC0, program & 0x7f]);
      let tick = 0;
      chords.forEach(function (chord, j) {
        const keys = chord.map(function (m) { return clampNumber(Math.round(m), 0, 127); });
        if (includeText) push(tick, 0, textMetaBytes(chordText(j, chord, keys)));
        const notes = uniqueRoundedNotes(chord);
        notes.forEach(function (n) { push(tick, 3, [0x90, n, 96]); });
        notes.forEach(function (n) { push(tick + durTicks, 2, [0x80, n, 0]); });
        tick += stepTicks;
      });
      push(tick, 0, [0xFF, 0x2F, 0x00]);
      return packMidiEvents(events, PPQ);
    }

    /* ---------- Pitch Bend：每声部一个通道 ---------- */
    if (mode === 'bend') {
      /* 0–15 通道里跳过 9（GM 鼓通道），因此最多 15 个独立声部 */
      const channelFor = function (v) { return v < 9 ? v : (v < 15 ? v + 1 : 15); };
      const channels = [];
      for (let v = 0; v < maxVoices; v++) {
        const ch = channelFor(v);
        if (channels.indexOf(ch) < 0) channels.push(ch);
      }
      let ord = 0;
      const semis = Math.floor(bendRange);
      const cents = Math.round((bendRange - semis) * 100);
      channels.forEach(function (ch) {
        push(0, ord++, [0xB0 | ch, 101, 0]);   // RPN 0 MSB：Pitch Bend Sensitivity
        push(0, ord++, [0xB0 | ch, 100, 0]);   // RPN 0 LSB
        push(0, ord++, [0xB0 | ch, 6, clampNumber(semis, 0, 127)]);
        push(0, ord++, [0xB0 | ch, 38, clampNumber(cents, 0, 127)]);
        push(0, ord++, [0xB0 | ch, 101, 127]); // RPN null
        push(0, ord++, [0xB0 | ch, 100, 127]);
        if (program >= 0) push(0, ord++, [0xC0 | ch, program & 0x7f]);
      });
      let tick = 0;
      chords.forEach(function (chord, j) {
        const keys = chord.map(function (v) { return clampNumber(Math.round(v), 0, 127); });
        if (includeText) push(tick, 0, textMetaBytes(chordText(j, chord, keys)));
        chord.forEach(function (value, v) {
          const ch = channelFor(v);
          const note = clampNumber(Math.round(value), 0, 127);
          const dev = value - note;                                     // 半音
          const bend = clampNumber(8192 + Math.round(dev / bendRange * 8192), 0, 16383);
          push(tick, 2, [0xE0 | ch, bend & 0x7f, (bend >> 7) & 0x7f]);  // 先弯音
          push(tick, 3, [0x90 | ch, note, 96]);                         // 再触键
          push(tick + durTicks, 1, [0x80 | ch, note, 0]);
        });
        tick += stepTicks;
      });
      push(tick, 0, [0xFF, 0x2F, 0x00]);
      return packMidiEvents(events, PPQ);
    }

    /* ---------- MIDI Tuning Standard：绝对调音 ---------- */
    const keyOf = function (v) { return v.toFixed(6); };
    const map = new Map();
    chords.forEach(function (chord) {
      chord.forEach(function (v) {
        const k = keyOf(v);
        if (!map.has(k)) map.set(k, { key: k, value: v, note: null });
      });
    });
    const list = Array.from(map.values()).sort(function (a, b) { return a.value - b.value; });
    if (list.length > 128) {
      /* MTS 的 note 表只有 128 个位置，音高过多时退回 Pitch Bend */
      const fallback = {};
      Object.keys(cfg).forEach(function (k) { fallback[k] = cfg[k]; });
      fallback.microMode = 'bend';
      return buildMidiFile(fallback);
    }
    const used = new Set();
    list.forEach(function (item) {
      let n = clampNumber(Math.round(item.value), 0, 127);
      if (used.has(n)) {
        let found = false;
        for (let d = 1; d <= 127 && !found; d++) {
          if (n - d >= 0 && !used.has(n - d)) { n = n - d; found = true; }
          else if (n + d <= 127 && !used.has(n + d)) { n = n + d; found = true; }
        }
      }
      used.add(n);
      item.note = n;
    });
    const noteOf = new Map();
    list.forEach(function (item) { noteOf.set(item.key, item.note); });

    const table = [];
    for (let n = 0; n < 128; n++) table.push([n, 0]);
    list.forEach(function (item) {
      let base = Math.floor(item.value + 1e-9);
      let frac = item.value - base;
      if (base < 0) { base = 0; frac = 0; }
      if (base > 127) { base = 127; frac = 0.999999; }
      let f14 = Math.round(frac * 16384);
      if (f14 >= 16384) { base += 1; f14 = 0; }
      if (base > 127) { base = 127; f14 = 16383; }
      table[item.note] = [base, f14];
    });
    const payload = [0x7E, 0x7F, 0x08, 0x01, 0x00];
    table.forEach(function (entry) {
      payload.push(entry[0] & 0x7F, (entry[1] >> 7) & 0x7F, entry[1] & 0x7F);
    });
    push(0, 0, [0xF0].concat(vlq(payload.length + 1), payload, [0xF7]));
    if (program >= 0) push(0, 1, [0xC0, program & 0x7f]);

    let tick = 0;
    chords.forEach(function (chord, j) {
      const keys = chord.map(function (v) { return noteOf.get(keyOf(v)); });
      if (includeText) push(tick, 0, textMetaBytes(chordText(j, chord, keys)));
      const notes = Array.from(new Set(keys)).sort(function (a, b) { return a - b; });
      notes.forEach(function (n) { push(tick, 3, [0x90, n, 96]); });
      notes.forEach(function (n) { push(tick + durTicks, 2, [0x80, n, 0]); });
      tick += stepTicks;
    });
    push(tick, 0, [0xFF, 0x2F, 0x00]);
    return packMidiEvents(events, PPQ);
  }

  /* ---------- 五线谱几何 ---------- */

  const GEOM = {
    spacing: 12,          // 五线间距
    trebleBottomY: 108,   // 高音谱表底线 E4
    bassBottomY: 228,     // 低音谱表底线 G2
    leftPad: 96,
    colWidth: 70,
    rightPad: 30,
    systemHeight: 278,
    topMargin: 16
  };

  const PC_STEP = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];

  function diatonicIndex(midi) {
    const m = Math.round(midi);
    const octave = Math.floor(m / 12) - 1;
    return octave * 7 + PC_STEP[mod12(m)];
  }

  const BOTTOM_IDX = { treble: diatonicIndex(64), bass: diatonicIndex(43) }; // E4 / G2
  const TOP_IDX = { treble: diatonicIndex(77), bass: diatonicIndex(57) };    // F5 / A3
  const BOTTOM_Y = { treble: GEOM.trebleBottomY, bass: GEOM.bassBottomY };
  const MID_Y = { treble: 84, bass: 204 };

  function staffY(staff, idx) {
    return BOTTOM_Y[staff] - (idx - BOTTOM_IDX[staff]) * (GEOM.spacing / 2);
  }

  function ledgerYs(staff, idx) {
    const out = [];
    const bottom = BOTTOM_IDX[staff];
    const top = TOP_IDX[staff];
    if (idx < bottom) {
      for (let i = bottom - 2; i >= idx; i -= 2) out.push(staffY(staff, i));
    }
    if (idx > top) {
      for (let i = top + 2; i <= idx; i += 2) out.push(staffY(staff, i));
    }
    return out;
  }

  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = Math.min(1, Math.max(0, s));
    l = Math.min(1, Math.max(0, l));
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

  function gradientColor(t) {
    const x = Math.min(1, Math.max(0, t));
    return hslToHex(216 + 171 * x, 0.82, 0.5);
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* 生成整段五线谱 SVG；和弦数组的每个元素是一个“时刻”。 */
  function renderStaffSVG(chords, opts) {
    opts = opts || {};
    const perSystem = Math.max(2, Math.min(16, Math.round(opts.perSystem || 8)));
    const showCents = opts.showCents !== false;
    const total = chords.length;
    const systems = [];
    for (let start = 0; start < total; start += perSystem) {
      systems.push({ start: start, chords: chords.slice(start, start + perSystem) });
    }

    /* 第一遍：先算每个系统里所有音符的位置、加线、符干，得到实际需要的纵向空间。
       这样 A0–C8 这种极端音区（大量加线）也不会画到谱表外面。 */
    const layouts = systems.map(function (sys) {
      const items = sys.chords.map(function (chord, ci) {
        const groups = { treble: [], bass: [] };
        chord.forEach(function (item) {
          /* 允许 {midi, amp} 形式：amp 用来把符头按振幅画大画小，
             这样包络过程就直接长在五线谱上了。也兼容纯数字的旧写法。 */
          const midi = (typeof item === 'number') ? item : item.midi;
          const parts = pitchParts(midi, opts);
          if (typeof item !== 'number' && item.amp != null) parts.amp = item.amp;
          const staff = parts.rounded >= 60 ? 'treble' : 'bass';
          parts.staff = staff;
          parts.diatonic = diatonicIndex(parts.rounded);
          groups[staff].push(parts);
        });
        ['treble', 'bass'].forEach(function (staff) {
          const notes = groups[staff];
          if (!notes.length) return;
          notes.sort(function (a, b) { return a.diatonic - b.diatonic; });
          for (let i = 1; i < notes.length; i++) {
            if (notes[i].diatonic - notes[i - 1].diatonic === 1) notes[i].xOffset = 11;
          }
          notes.forEach(function (n) {
            n.y0 = staffY(staff, n.diatonic);
            n.x = GEOM.leftPad + ci * GEOM.colWidth + (n.xOffset || 0);
            n.ledgers = ledgerYs(staff, n.diatonic);
          });
          const ys = notes.map(function (n) { return n.y0; });
          const minY = Math.min.apply(null, ys);
          const maxY = Math.max.apply(null, ys);
          const stemUp = (minY + maxY) / 2 >= MID_Y[staff];
          notes.forEach(function (n) { n.stemUp = stemUp; });
        });
        return { chord: chord, ci: ci, gi: sys.start + ci, groups: groups };
      });

      let minY = 60;    // 高音谱表顶线
      let maxY = 228;   // 低音谱表底线
      items.forEach(function (item) {
        ['treble', 'bass'].forEach(function (staff) {
          item.groups[staff].forEach(function (n) {
            minY = Math.min(minY, n.y0);
            maxY = Math.max(maxY, n.y0);
            n.ledgers.forEach(function (ly) {
              minY = Math.min(minY, ly);
              maxY = Math.max(maxY, ly);
            });
            if (n.stemUp) minY = Math.min(minY, n.y0 - 34);
            else maxY = Math.max(maxY, n.y0 + 34);
            if (showCents && Math.abs(n.cents) >= 20) minY = Math.min(minY, n.y0 - 20);
          });
        });
      });
      const shift = Math.max(0, 46 - minY);
      return { sys: sys, items: items, shift: shift, height: shift + maxY + 46 };
    });

    const W = GEOM.leftPad + perSystem * GEOM.colWidth + GEOM.rightPad;
    let H = 8;
    layouts.forEach(function (l) { H += l.height; });
    const p = [];
    p.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" '
      + 'font-family="-apple-system, \'PingFang SC\', Helvetica, Arial, sans-serif">');
    p.push('<rect width="' + W + '" height="' + H + '" fill="#ffffff"/>');

    let cursor = 4;
    layouts.forEach(function (layout) {
      const sys = layout.sys;
      const dy = cursor + layout.shift;
      const x1 = GEOM.leftPad - 66;
      const x2 = W - GEOM.rightPad + 8;

      for (let k = 0; k < 5; k++) {
        const ty = dy + GEOM.trebleBottomY - k * GEOM.spacing;
        const by = dy + GEOM.bassBottomY - k * GEOM.spacing;
        p.push('<line x1="' + x1 + '" y1="' + ty + '" x2="' + x2 + '" y2="' + ty + '" stroke="#b6bbc4" stroke-width="1"/>');
        p.push('<line x1="' + x1 + '" y1="' + by + '" x2="' + x2 + '" y2="' + by + '" stroke="#b6bbc4" stroke-width="1"/>');
      }
      p.push('<line x1="' + (GEOM.leftPad - 78) + '" y1="' + (dy + GEOM.trebleBottomY - 4 * GEOM.spacing) + '" x2="' + (GEOM.leftPad - 78) + '" y2="' + (dy + GEOM.bassBottomY) + '" stroke="#4a4a52" stroke-width="2.2"/>');
      p.push('<text x="' + (GEOM.leftPad - 64) + '" y="' + (dy + GEOM.trebleBottomY + 4) + '" font-size="76" font-family="\'Apple Symbols\', serif" fill="#222">\uD834\uDD1E</text>');
      p.push('<text x="' + (GEOM.leftPad - 64) + '" y="' + (dy + GEOM.bassBottomY + 2) + '" font-size="58" font-family="\'Apple Symbols\', serif" fill="#222">\uD834\uDD22</text>');

      layout.items.forEach(function (item) {
        const gi = item.gi;
        const t = total <= 1 ? 0.5 : gi / (total - 1);
        const color = gradientColor(t);
        const x = GEOM.leftPad + item.ci * GEOM.colWidth;

        p.push('<text x="' + x + '" y="' + (dy + 26) + '" font-size="9.5" fill="#9a9aa2" text-anchor="middle">' + (gi + 1) + '</text>');
        if (gi === 0) p.push('<text x="' + x + '" y="' + (dy + 40) + '" font-size="11" font-weight="600" fill="' + gradientColor(0) + '" text-anchor="middle">A</text>');
        if (gi === total - 1) p.push('<text x="' + x + '" y="' + (dy + 40) + '" font-size="11" font-weight="600" fill="' + gradientColor(1) + '" text-anchor="middle">B</text>');

        ['treble', 'bass'].forEach(function (staff) {
          const notes = item.groups[staff];
          if (!notes.length) return;
          notes.forEach(function (n) { n.y = dy + n.y0; });

          /* 加线 */
          notes.forEach(function (n) {
            n.ledgers.forEach(function (ly) {
              p.push('<line x1="' + (n.x - 9).toFixed(1) + '" y1="' + (dy + ly).toFixed(1) + '" x2="' + (n.x + 9).toFixed(1) + '" y2="' + (dy + ly).toFixed(1) + '" stroke="#5a5a62" stroke-width="1.2"/>');
            });
          });

          /* 符干 */
          const ys = notes.map(function (n) { return n.y; });
          const minY = Math.min.apply(null, ys);
          const maxY = Math.max.apply(null, ys);
          const stemUp = notes[0].stemUp;
          if (stemUp) {
            const topNote = notes.filter(function (n) { return n.y === minY; })[0];
            p.push('<line x1="' + (topNote.x + 5.3).toFixed(1) + '" y1="' + minY.toFixed(1) + '" x2="' + (topNote.x + 5.3).toFixed(1) + '" y2="' + (minY - 34).toFixed(1) + '" stroke="' + color + '" stroke-width="1.6"/>');
          } else {
            const bottomNote = notes.filter(function (n) { return n.y === maxY; })[0];
            p.push('<line x1="' + (bottomNote.x - 5.3).toFixed(1) + '" y1="' + maxY.toFixed(1) + '" x2="' + (bottomNote.x - 5.3).toFixed(1) + '" y2="' + (maxY + 34).toFixed(1) + '" stroke="' + color + '" stroke-width="1.6"/>');
          }

          /* 符头 */
          notes.forEach(function (n) {
            /* 符头大小随振幅：0 → 0.62 倍，满 → 1.42 倍 */
            const k = (n.amp == null) ? 1 : (0.62 + 0.80 * Math.sqrt(Math.min(1, Math.max(0, n.amp))));
            p.push('<ellipse cx="' + n.x.toFixed(1) + '" cy="' + n.y.toFixed(1) + '" rx="' + (5.6 * k).toFixed(2)
              + '" ry="' + (4.2 * k).toFixed(2) + '" transform="rotate(-20 ' + n.x.toFixed(1) + ' ' + n.y.toFixed(1) + ')" fill="' + color + '"/>');
          });

          /* 升降号：同一列里按 y 碰撞向左错开 */
          const placed = [];
          notes.slice().sort(function (a, b) { return a.y - b.y; }).forEach(function (n) {
            if (!n.accidental) return;
            let ax = x - 16;
            let guard = 0;
            while (placed.some(function (q) { return Math.abs(q.y - n.y) < 10 && Math.abs(q.x - ax) < 9; }) && guard++ < 8) ax -= 10;
            placed.push({ x: ax, y: n.y });
            p.push('<text x="' + ax.toFixed(1) + '" y="' + (n.y + 7).toFixed(1) + '" font-size="21" font-family="\'Hiragino Sans W3\', \'Apple Symbols\', serif" fill="' + color + '" text-anchor="middle">♯</text>');
          });

          /* 微分音偏差 */
          if (showCents) {
            notes.forEach(function (n) {
              if (Math.abs(n.cents) < 20) return;
              p.push('<text x="' + n.x.toFixed(1) + '" y="' + (n.y - 11).toFixed(1) + '" font-size="9" fill="#b26a00" text-anchor="middle">' + (n.cents > 0 ? '+' : '−') + Math.abs(n.cents) + '¢</text>');
            });
          }
        });
      });
      cursor += layout.height;
    });
    p.push('</svg>');
    return p.join('\n');
  }

  /* ---------- 过渡曲线 SVG ---------- */

  function renderCurveSVG(curve, samples) {
    const W = 880, H = 210;
    const padL = 58, padR = 26, padT = 20, padB = 40;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const XP = function (t) { return padL + t * plotW; };
    const YP = function (v) { return padT + (1 - v) * plotH; };
    const p = [];
    p.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" font-family="-apple-system, \'PingFang SC\', Helvetica, Arial, sans-serif">');
    p.push('<rect width="' + W + '" height="' + H + '" fill="#ffffff"/>');
    for (let i = 0; i <= 4; i++) {
      const v = i / 4;
      p.push('<line x1="' + padL + '" y1="' + YP(v) + '" x2="' + (W - padR) + '" y2="' + YP(v) + '" stroke="#eceef2" stroke-width="1"/>');
      p.push('<text x="' + (padL - 8) + '" y="' + (YP(v) + 3.5) + '" font-size="10" fill="#9a9aa2" text-anchor="end">' + v.toFixed(2) + '</text>');
    }
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      p.push('<line x1="' + XP(t) + '" y1="' + padT + '" x2="' + XP(t) + '" y2="' + (H - padB) + '" stroke="#f2f3f6" stroke-width="1"/>');
      p.push('<text x="' + XP(t) + '" y="' + (H - padB + 15) + '" font-size="10" fill="#9a9aa2" text-anchor="middle">' + t.toFixed(2) + '</text>');
    }
    p.push('<line x1="' + padL + '" y1="' + (H - padB) + '" x2="' + (W - padR) + '" y2="' + (H - padB) + '" stroke="#8a8a93" stroke-width="1"/>');
    p.push('<line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (H - padB) + '" stroke="#8a8a93" stroke-width="1"/>');
    p.push('<line x1="' + XP(0) + '" y1="' + YP(0) + '" x2="' + XP(1) + '" y2="' + YP(1) + '" stroke="#c2c6cf" stroke-width="1.2" stroke-dasharray="5 4"/>');

    const pts = [];
    for (let i = 0; i <= 120; i++) {
      const t = i / 120;
      pts.push(XP(t).toFixed(1) + ',' + YP(curveWeight(t, curve)).toFixed(1));
    }
    p.push('<polyline points="' + pts.join(' ') + '" fill="none" stroke="#0a6cff" stroke-width="2.2"/>');

    samplePositions(samples).forEach(function (t) {
      p.push('<circle cx="' + XP(t).toFixed(1) + '" cy="' + YP(curveWeight(t, curve)).toFixed(1) + '" r="3.1" fill="#0a6cff"/>');
    });

    const exponent = Math.exp(-curve);
    const shape = Math.abs(curve) < 0.02 ? '线性' : (curve > 0 ? '先快后慢（上凸）' : '先慢后快（下凹 / 加速）');
    p.push('<text x="' + (padL + 6) + '" y="' + (padT + 16) + '" font-size="12.5" fill="#0a6cff" font-weight="600">w = t ^ ( e^(−curve) )</text>');
    p.push('<text x="' + (padL + 6) + '" y="' + (padT + 34) + '" font-size="11.5" fill="#6b6b70">curve = ' + curve.toFixed(2) + '　有效指数 = ' + exponent.toFixed(3) + '　' + shape + '</text>');
    p.push('<text x="' + (W - padR) + '" y="' + (padT + 16) + '" font-size="11" fill="#9a9aa2" text-anchor="end">虚线 = 线性参考</text>');
    p.push('</svg>');
    return p.join('\n');
  }

  /* ---------- 预置 ---------- */

  const PRESETS = [
    {
      id: 'ex32',
      label: '线性 12 步（curve 0）',
      samples: 12, curve: 0, domain: 'midi'
    },
    {
      id: 'accel',
      label: '先慢后快 12 步（curve −0.8）',
      samples: 12, curve: -0.8, domain: 'midi'
    },
    {
      id: 'freq',
      label: '频率域 9 步（Hz 线性）',
      samples: 9, curve: 0, domain: 'freq'
    },
    {
      id: 'micro',
      label: '微分音 13 步（半音域）',
      samples: 13, curve: 0, domain: 'midi'
    },
    {
      id: 'wide',
      label: '先快后慢 16 步（curve +0.4）',
      samples: 16, curve: 0.4, domain: 'midi'
    }
  ];

  function svgToDataUrl(svg) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  return {
    MIDI_A4: MIDI_A4,
    FREQ_A4: FREQ_A4,
    PPQ: PPQ,
    SHARP_NAMES: SHARP_NAMES,
    midiToFreq: midiToFreq,
    freqToMidi: freqToMidi,
    pitchParts: pitchParts,
    midiToName: midiToName,
    midiToLabel: midiToLabel,
    parsePitchToken: parsePitchToken,
    parseChordText: parseChordText,
    curveWeight: curveWeight,
    samplePositions: samplePositions,
    computeInterpolation: computeInterpolation,
    buildRows: buildRows,
    buildMidiFile: buildMidiFile,
    vlq: vlq,
    diatonicIndex: diatonicIndex,
    staffY: staffY,
    ledgerYs: ledgerYs,
    gradientColor: gradientColor,
    renderStaffSVG: renderStaffSVG,
    renderCurveSVG: renderCurveSVG,
    PRESETS: PRESETS,
    svgToDataUrl: svgToDataUrl,
    GEOM: GEOM
  };
});
