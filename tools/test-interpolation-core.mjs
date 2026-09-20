import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const C = require('./interpolation-core.js');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('  ✓ ' + name);
}
function close(a, b, eps = 1e-6) {
  assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
}

console.log('插值核心测试');

ok('线性权重序列', () => {
  const w = C.samplePositions(5).map(t => C.curveWeight(t, 0));
  assert.deepEqual(w.map(x => Math.round(x * 1e6) / 1e6), [0, 0.25, 0.5, 0.75, 1]);
});

ok('curve = 1 时有效指数为 e^-1（先快后慢）', () => {
  close(C.curveWeight(0.5, 1), Math.pow(0.5, Math.exp(-1)), 1e-12);
  assert.ok(C.curveWeight(0.5, 1) > 0.5);
});

ok('curve = -1 时有效指数为 e（先慢后快）', () => {
  close(C.curveWeight(0.5, -1), Math.pow(0.5, Math.exp(1)), 1e-12);
  assert.ok(C.curveWeight(0.5, -1) < 0.5);
});

ok('MIDI 域线性插值 60 → 72 共 5 步', () => {
  const r = C.computeInterpolation({ chordA: [60], chordB: [72], samples: 5, curve: 0, domain: 'midi' });
  assert.deepEqual(r.chords.map(c => c[0]), [60, 63, 66, 69, 72]);
});

ok('samples = 1 返回中点', () => {
  const r = C.computeInterpolation({ chordA: [60], chordB: [72], samples: 1, curve: 0, domain: 'midi' });
  assert.deepEqual(r.chords, [[66]]);
});

ok('频率域中点的频率等于两端频率的算术平均', () => {
  const r = C.computeInterpolation({ chordA: [60], chordB: [72], samples: 3, curve: 0, domain: 'freq' });
  const fMid = C.midiToFreq(r.chords[1][0]);
  close(fMid, (C.midiToFreq(60) + C.midiToFreq(72)) / 2, 1e-9);
  // 对数音高上它不在 66：线性频率 ≠ 线性音高
  assert.ok(Math.abs(r.chords[1][0] - 66) > 0.5);
});

ok('和弦逐声部插值', () => {
  const r = C.computeInterpolation({ chordA: [60, 64, 67], chordB: [62, 66, 69], samples: 2, curve: 0, domain: 'midi' });
  assert.deepEqual(r.chords, [[60, 64, 67], [62, 66, 69]]);
});

ok('起点终点音数不同时报错', () => {
  assert.throws(() => C.computeInterpolation({ chordA: [60], chordB: [60, 64], samples: 3, curve: 0, domain: 'midi' }));
});

ok('音名与数字混合解析', () => {
  assert.deepEqual(C.parseChordText('C4 E4 G4'), [60, 64, 67]);
  assert.deepEqual(C.parseChordText('C4, C#4, Db4, 60.5'), [60, 60.5, 61]);
  assert.deepEqual(C.parseChordText('36 48 55 60'), [36, 48, 55, 60]);
});

ok('音名与音分显示', () => {
  assert.equal(C.midiToName(61), 'C♯4');
  assert.equal(C.midiToLabel(60.5), 'C♯4 −50¢');
  assert.equal(C.midiToLabel(60.25), 'C4 +25¢');
});

ok('五线谱几何：谱线位置与加线', () => {
  assert.equal(C.staffY('treble', C.diatonicIndex(64)), 108); // E4 底线
  assert.equal(C.staffY('treble', C.diatonicIndex(77)), 60);  // F5 顶线
  assert.equal(C.staffY('bass', C.diatonicIndex(43)), 228);   // G2 底线
  assert.equal(C.staffY('bass', C.diatonicIndex(57)), 180);   // A3 顶线
  assert.deepEqual(C.ledgerYs('treble', C.diatonicIndex(60)), [120]); // 中央 C 下加一线
  assert.deepEqual(C.ledgerYs('bass', C.diatonicIndex(60)), [168]);   // 低音谱表上加一线
});

ok('五线谱 SVG 可生成且无 NaN', () => {
  const svg = C.renderStaffSVG([[60, 64, 67], [61, 65, 69], [62, 66, 70]], { perSystem: 8, showCents: true });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('</svg>'));
  assert.ok(!svg.includes('NaN'));
  assert.equal((svg.match(/<ellipse/g) || []).length, 9);
  assert.ok(svg.includes('\uD834\uDD1E'));
  assert.ok(svg.includes('\uD834\uDD22'));
});

ok('88 键极端音区（A0 / C8）的加线与纵向自适应', () => {
  assert.equal(C.diatonicIndex(21), 5);   // A0
  assert.equal(C.staffY('bass', 5), 306); // A0 在低音谱表下方
  assert.equal(C.ledgerYs('bass', 5).length, 6);
  const a0 = C.renderStaffSVG([[21]], { perSystem: 8, showCents: true });
  const c8 = C.renderStaffSVG([[108]], { perSystem: 8, showCents: true });
  const both = C.renderStaffSVG([[21, 108]], { perSystem: 8, showCents: true });
  for (const svg of [a0, c8, both]) {
    assert.ok(!svg.includes('NaN'));
    const h = Number(svg.match(/height="(\d+)"/)[1]);
    assert.ok(h > 280, '极端音区应自动加高谱面，实际 ' + h);
  }
  assert.ok(Number(both.match(/height="(\d+)"/)[1]) >= Number(a0.match(/height="(\d+)"/)[1]));
});

ok('过渡曲线 SVG 可生成且无 NaN', () => {
  const svg = C.renderCurveSVG(-0.8, 12);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(!svg.includes('NaN'));
  assert.ok(svg.includes('先慢后快'));
});

ok('预置只含参数，不包含任何和弦数据', () => {
  assert.ok(C.PRESETS.length >= 4);
  for (const p of C.PRESETS) {
    assert.equal('a' in p, false, p.id + ' 不应包含 a');
    assert.equal('b' in p, false, p.id + ' 不应包含 b');
    assert.equal(typeof p.samples, 'number');
    assert.equal(typeof p.curve, 'number');
    assert.ok(p.domain === 'midi' || p.domain === 'freq');
  }
});

/* ---- MIDI 文件结构解析 ---- */
function parseMidi(bytes) {
  const u8 = Uint8Array.from(bytes);
  assert.equal(String.fromCharCode(...u8.slice(0, 4)), 'MThd');
  const headerLen = (u8[4] << 24) | (u8[5] << 16) | (u8[6] << 8) | u8[7];
  assert.equal(headerLen, 6);
  const format = (u8[8] << 8) | u8[9];
  const ntrks = (u8[10] << 8) | u8[11];
  const division = (u8[12] << 8) | u8[13];
  let pos = 14;
  assert.equal(String.fromCharCode(...u8.slice(pos, pos + 4)), 'MTrk');
  const trackLen = (u8[pos + 4] << 24) | (u8[pos + 5] << 16) | (u8[pos + 6] << 8) | u8[pos + 7];
  pos += 8;
  const end = pos + trackLen;
  assert.equal(end, u8.length);

  const events = [];
  let tick = 0;
  let running = 0;
  while (pos < end) {
    let delta = 0;
    while (true) {
      const b = u8[pos++];
      delta = (delta << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    tick += delta;
    let status = u8[pos];
    if (status & 0x80) { pos++; running = status; } else { status = running; }
    if (status === 0xFF) {
      const type = u8[pos++];
      let len = 0;
      while (true) {
        const b = u8[pos++];
        len = (len << 7) | (b & 0x7f);
        if (!(b & 0x80)) break;
      }
      const data = Array.from(u8.slice(pos, pos + len));
      pos += len;
      events.push({ tick, type: 'meta', meta: type, data });
      if (type === 0x2F) break;
    } else if (status === 0xF0) {
      let len = 0;
      while (true) {
        const b = u8[pos++];
        len = (len << 7) | (b & 0x7f);
        if (!(b & 0x80)) break;
      }
      const data = Array.from(u8.slice(pos, pos + len));
      pos += len;
      events.push({ tick, type: 'sysex', data });
      running = 0;
    } else {
      const hi = status & 0xF0;
      const channel = status & 0x0F;
      const n = hi === 0xC0 || hi === 0xD0 ? 1 : 2;
      const data = Array.from(u8.slice(pos, pos + n));
      pos += n;
      if (hi === 0x90) events.push({ tick, type: 'on', channel, note: data[0], vel: data[1] });
      else if (hi === 0x80) events.push({ tick, type: 'off', channel, note: data[0] });
      else if (hi === 0xB0) events.push({ tick, type: 'cc', channel, controller: data[0], value: data[1] });
      else if (hi === 0xE0) events.push({ tick, type: 'bend', channel, value: data[0] | (data[1] << 7) });
      else events.push({ tick, type: 'other', channel, data });
    }
  }
  return { format, ntrks, division, events };
}

ok('MIDI 文件结构与事件时间正确', () => {
  const bytes = C.buildMidiFile({
    chords: [[60, 64, 67], [62, 66, 69]],
    stepMs: 500,
    gate: 0.9,
    bpm: 120,
    trackName: 'Interpolation'
  });
  const mid = parseMidi(bytes);
  assert.equal(mid.format, 0);
  assert.equal(mid.ntrks, 1);
  assert.equal(mid.division, 480);

  const tempo = mid.events.find(e => e.meta === 0x51);
  assert.deepEqual(tempo.data, [0x07, 0xA1, 0x20]); // 500000 us = 120 BPM

  const ons = mid.events.filter(e => e.type === 'on');
  const offs = mid.events.filter(e => e.type === 'off');
  assert.equal(ons.length, 6);
  assert.equal(offs.length, 6);

  // 500 ms @120BPM = 480 ticks；0.9 gate = 432 ticks
  assert.deepEqual(Array.from(new Set(ons.map(e => e.tick))), [0, 480]);
  assert.deepEqual(Array.from(new Set(offs.map(e => e.tick))), [432, 912]);
  assert.deepEqual(mid.events.filter(e => e.type === 'on' && e.tick === 480).map(e => e.note), [62, 66, 69]);

  const end = mid.events[mid.events.length - 1];
  assert.equal(end.meta, 0x2F);
  assert.equal(end.tick, 960);
});

ok('Pitch Bend 微分音导出：每声部独立通道 + RPN 弯音范围', () => {
  const chords = [[60.25, 64.25], [60.5, 64.5], [60.75, 64.75]];
  const mid = parseMidi(C.buildMidiFile({
    chords, stepMs: 500, gate: 0.9, bpm: 120,
    microMode: 'bend', bendRange: 2, includeText: true
  }));
  const bends0 = mid.events.filter(e => e.type === 'bend' && e.channel === 0).map(e => e.value);
  const bends1 = mid.events.filter(e => e.type === 'bend' && e.channel === 1).map(e => e.value);
  assert.deepEqual(bends0, [9216, 6144, 7168]);   // +25c / −50c / −25c
  assert.deepEqual(bends1, [9216, 6144, 7168]);
  assert.deepEqual(mid.events.filter(e => e.type === 'on' && e.channel === 0).map(e => e.note), [60, 61, 61]);
  assert.deepEqual(mid.events.filter(e => e.type === 'on' && e.channel === 1).map(e => e.note), [64, 65, 65]);
  const cc0 = mid.events.filter(e => e.type === 'cc' && e.channel === 0);
  assert.deepEqual(cc0.slice(0, 6).map(e => [e.controller, e.value]),
    [[101, 0], [100, 0], [6, 2], [38, 0], [101, 127], [100, 127]]);
  const texts = mid.events.filter(e => e.type === 'meta' && e.meta === 0x01)
    .map(e => String.fromCharCode(...e.data));
  assert.ok(texts.some(t => t.includes('60.2500')));
  assert.ok(texts.some(t => t.includes('64.7500')));
  assert.ok(texts.some(t => t.includes('micro=bend')));
  assert.ok(texts.some(t => t.includes('C#4')), '文本 meta 里升号应写成 ASCII 的 #');
});

ok('MTS 批量调音导出：SysEx 与半音分数', () => {
  const mid = parseMidi(C.buildMidiFile({
    chords: [[60.5]], stepMs: 500, gate: 0.9, bpm: 120,
    microMode: 'mts', includeText: true
  }));
  const sysex = mid.events.find(e => e.type === 'sysex');
  assert.ok(sysex, '应包含 MTS SysEx');
  assert.deepEqual(sysex.data.slice(0, 5), [0x7E, 0x7F, 0x08, 0x01, 0x00]);
  assert.equal(sysex.data.length, 5 + 128 * 3 + 1);
  assert.equal(sysex.data[sysex.data.length - 1], 0xF7);
  const note = 61;                                  // round(60.5)
  const entry = sysex.data.slice(5 + note * 3, 5 + note * 3 + 3);
  assert.deepEqual(entry, [60, 0x40, 0x00]);        // 60 + 0.5 半音 = 8192/16384
  assert.deepEqual(mid.events.filter(e => e.type === 'on').map(e => e.note), [61]);
  assert.equal(mid.events.filter(e => e.type === 'bend').length, 0);
});

ok('整数音高自动退回最兼容的单通道写法', () => {
  const mid = parseMidi(C.buildMidiFile({
    chords: [[60, 64, 67]], microMode: 'bend', bendRange: 2, includeText: true
  }));
  assert.equal(mid.events.filter(e => e.type === 'bend').length, 0);
  assert.equal(mid.events.filter(e => e.type === 'sysex').length, 0);
  const ons = mid.events.filter(e => e.type === 'on');
  assert.ok(ons.every(e => e.channel === 0));
  assert.deepEqual(ons.map(e => e.note), [60, 64, 67]);
});

console.log('\n全部通过：' + passed + ' 项');
