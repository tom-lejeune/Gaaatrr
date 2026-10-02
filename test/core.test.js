const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core.js');

function params(over) {
  return Object.assign(C.defaults(), over || {});
}

function minmax(arr) {
  let lo = Infinity, hi = -Infinity;
  for (const v of arr) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return [lo, hi];
}

test('defaults are inside every parameter range', () => {
  const p = C.defaults();
  for (const d of C.PARAM_DEFS) {
    assert.ok(p[d.name] >= d.min && p[d.name] <= d.max, d.name);
  }
  assert.equal(p.steps.length, C.MAX_STEPS);
});

test('paramNames lists 16 steps then every global once', () => {
  const names = C.paramNames();
  assert.equal(names.length, 16 + C.PARAM_DEFS.length);
  assert.equal(new Set(names).size, names.length);
  assert.equal(names[0], 's1');
  assert.equal(names[15], 's16');
});

test('setParam clamps, rounds and reports changes', () => {
  const p = C.defaults();
  assert.equal(C.setParam(p, 'depth', 250), false, 'clamps to 100, which is already the value');
  assert.equal(p.depth, 100);
  assert.equal(C.setParam(p, 'depth', -20), true);
  assert.equal(p.depth, 0);
  assert.equal(C.setParam(p, 'len', 7.6), true);
  assert.equal(p.len, 8);
  assert.equal(C.setParam(p, 's3', -5), true);
  assert.equal(p.steps[2], 0);
  assert.equal(C.setParam(p, 's99', 50), false);
  assert.equal(C.setParam(p, 'nonsense', 1), false);
  assert.equal(C.setParam(p, 'rate', 'abc'), false);
});

test('tables have the documented size and stay inside 0..1', () => {
  const t = C.buildTables(params());
  assert.equal(t.L.length, C.TABLE_SIZE);
  assert.equal(t.R.length, C.TABLE_SIZE);
  const [lo, hi] = minmax(t.L);
  assert.ok(lo >= 0 && hi <= 1);
  assert.equal(hi, 1);
  assert.equal(lo, 0);
});

test('an off step closes the gate and an on step opens it', () => {
  const steps = new Array(16).fill(0);
  steps[0] = 100;
  const p = params({ steps, len: 4, gate: 50, attack: 0, release: 0 });
  const t = C.buildTables(p).L;
  const per = C.samplesPerStep(p);
  assert.ok(t[Math.floor(per * 0.25)] > 0.99, 'middle of the open half');
  assert.ok(t[Math.floor(per * 0.9)] < 0.01, 'after the gate length');
  assert.ok(t[Math.floor(per * 1.5)] < 0.01, 'off step');
});

test('depth sets the closed level', () => {
  const steps = new Array(16).fill(0);
  const p = params({ steps, depth: 40 });
  const t = C.buildTables(p).L;
  assert.ok(Math.abs(t[100] - 0.6) < 1e-6);
  const full = C.buildTables(params({ steps, depth: 0 })).L;
  assert.ok(Math.abs(full[100] - 1) < 1e-6);
});

test('step levels scale the open value', () => {
  const steps = new Array(16).fill(0);
  steps[0] = 50;
  const p = params({ steps, len: 4, gate: 100, attack: 0, release: 0 });
  const t = C.buildTables(p).L;
  assert.ok(Math.abs(t[200] - 0.5) < 1e-6);
});

test('attack and release are real ramps, not edges', () => {
  const steps = new Array(16).fill(0);
  steps[0] = 100;
  const p = params({ steps, len: 4, gate: 50, attack: 20, release: 40, curve: 0 });
  const t = C.buildTables(p).L;
  const per = C.samplesPerStep(p);
  const early = t[Math.floor(per * 0.05)];
  assert.ok(early > 0.1 && early < 0.9, 'inside the attack ramp: ' + early);
  const rel = t[Math.floor(per * 0.7)];
  assert.ok(rel > 0.1 && rel < 0.9, 'inside the release ramp: ' + rel);
  let maxJump = 0;
  for (let i = 1; i < t.length; i++) maxJump = Math.max(maxJump, Math.abs(t[i] - t[i - 1]));
  assert.ok(maxJump <= 0.51, 'no single-sample cliff, biggest jump ' + maxJump);
});

test('positive curve is snappier than negative curve', () => {
  const steps = new Array(16).fill(0);
  steps[0] = 100;
  const base = { steps, len: 4, gate: 100, attack: 40, release: 0 };
  const snap = C.buildTables(params(Object.assign({ curve: 80 }, base))).L;
  const soft = C.buildTables(params(Object.assign({ curve: -80 }, base))).L;
  const i = Math.floor(C.samplesPerStep(params(base)) * 0.1);
  assert.ok(snap[i] > soft[i]);
});

test('swing pushes odd steps later and leaves even steps alone', () => {
  const steps = new Array(16).fill(100);
  const straight = params({ steps, len: 4, gate: 20, attack: 0, release: 0, swing: 0 });
  const swung = params({ steps, len: 4, gate: 20, attack: 0, release: 0, swing: 100 });
  const per = C.samplesPerStep(straight);
  const a = C.buildTables(straight).L;
  const b = C.buildTables(swung).L;
  assert.ok(a[Math.floor(per * 1.05)] > 0.9, 'step 2 open without swing');
  assert.ok(b[Math.floor(per * 1.05)] < 0.1, 'step 2 delayed with swing');
  assert.ok(b[Math.floor(per * 1.6)] > 0.9, 'step 2 now open half a step later');
  assert.ok(Math.abs(a[Math.floor(per * 2.05)] - b[Math.floor(per * 2.05)]) < 1e-6, 'step 3 untouched');
});

test('nudge rotates the pattern', () => {
  const steps = new Array(16).fill(0);
  steps[0] = 100;
  const a = C.buildTables(params({ steps, len: 4, gate: 25, attack: 0, release: 0 })).L;
  const b = C.buildTables(params({ steps, len: 4, gate: 25, attack: 0, release: 0, nudge: 25 })).L;
  const shift = C.TABLE_CYCLE * 0.25;
  assert.ok(a[10] > 0.9 && b[10] < 0.1);
  assert.ok(Math.abs(b[10 + shift] - a[10]) < 1e-6);
});

test('stereo offsets the right channel by whole steps', () => {
  const steps = new Array(16).fill(0);
  steps[0] = 100;
  const p = params({ steps, len: 4, gate: 25, attack: 0, release: 0, stereo: 1 });
  const t = C.buildTables(p);
  const per = C.samplesPerStep(p);
  assert.ok(t.L[10] > 0.9 && t.R[10] < 0.1);
  assert.ok(t.R[Math.floor(per) + 10] > 0.9);
  const mono = C.buildTables(params({ steps, stereo: 0 }));
  assert.equal(mono.L, mono.R);
});

test('direction: reverse, ping-pong and random orders', () => {
  const p = params({ len: 4 });
  assert.deepEqual(C.stepOrder(p, 0), [0, 1, 2, 3]);
  p.direction = 1;
  assert.deepEqual(C.stepOrder(p, 0), [3, 2, 1, 0]);
  p.direction = 2;
  assert.deepEqual(C.stepOrder(p, 0), [0, 1, 2, 3]);
  assert.deepEqual(C.stepOrder(p, 1), [3, 2, 1, 0]);
  p.direction = 3;
  const o = C.stepOrder(p, 0);
  assert.deepEqual(o.slice().sort(), [0, 1, 2, 3]);
  assert.deepEqual(C.stepOrder(p, 0), o, 'same seed + pass, same shuffle');
  const distinct = new Set([0, 1, 2, 3, 4, 5, 6, 7].map((c) => C.stepOrder(p, c).join('')));
  assert.ok(distinct.size > 1, 'RAND reshuffles between passes');
});

test('chance 0 silences every step, chance 100 keeps them', () => {
  const none = C.cycleLevels(params({ chance: 0, steps: new Array(16).fill(100) }), 0);
  assert.ok(none.every((v) => v === 0));
  const all = C.cycleLevels(params({ chance: 100, steps: new Array(16).fill(100) }), 0);
  assert.ok(all.every((v) => v === 1));
});

test('chance 50 drops roughly half and is repeatable for one seed', () => {
  const p = params({ chance: 50, steps: new Array(16).fill(100), len: 16 });
  let on = 0, total = 0;
  for (let c = 0; c < C.VARIATION_CYCLES; c++) {
    for (const v of C.cycleLevels(p, c)) { total++; if (v > 0) on++; }
  }
  assert.ok(on / total > 0.3 && on / total < 0.7, 'ratio ' + on / total);
  assert.deepEqual(C.cycleLevels(p, 3), C.cycleLevels(p, 3));
  const q = params({ chance: 50, steps: new Array(16).fill(100), seed: 2 });
  assert.notDeepEqual(C.cycleLevels(p, 0), C.cycleLevels(q, 0));
});

test('humanize only ever lowers levels', () => {
  const p = params({ humanize: 100, steps: new Array(16).fill(100) });
  const levels = C.cycleLevels(p, 0);
  assert.ok(levels.every((v) => v >= 0 && v <= 1));
  assert.ok(levels.some((v) => v < 1));
});

test('phasorMessage covers the whole table in ticks', () => {
  // 1/16 = 0.25 beat, 16 steps, 8 passes = 32 beats = 15360 ticks
  assert.equal(C.phasorMessage(params({ rate: 6, len: 16 })), '15360i');
  // 1/4T, 3 steps = 2 beats a pass, 16 beats total = 7680 ticks
  assert.equal(C.phasorMessage(params({ rate: 2, len: 3 })), '7680i');
  for (let r = 0; r < C.RATES.length; r++) {
    for (let len = 1; len <= 16; len++) {
      const ticks = C.tableBeats(params({ rate: r, len })) * C.TICKS_PER_BEAT;
      assert.ok(Math.abs(ticks - Math.round(ticks)) < 1e-6, 'whole ticks for rate ' + r + ' len ' + len);
    }
  }
});

test('locate follows direction and nudge', () => {
  const p = params({ len: 4 });
  assert.equal(C.locate(p, 0).step, 0);
  const per = 1 / C.VARIATION_CYCLES / 4; // one step, as a fraction of the whole table
  assert.equal(C.locate(p, per * 2.5).slot, 2);
  p.direction = 1;
  assert.equal(C.locate(p, per * 2.5).step, 1);
  p.direction = 0; p.nudge = 25;
  assert.equal(C.locate(p, per * 4 * 0.25 + per * 0.5).slot, 0);
});

test('euclid distributes hits evenly', () => {
  const e = C.euclid(16, 4);
  assert.equal(e.filter((v) => v).length, 4);
  assert.deepEqual(e.map((v, i) => (v ? i : -1)).filter((i) => i >= 0).map((i) => i % 4), [3, 3, 3, 3]);
  assert.equal(C.euclid(8, 3).filter((v) => v).length, 3);
  assert.equal(C.euclid(12, 12).filter((v) => v).length, 12);
  assert.equal(C.euclid(5, 0).filter((v) => v).length, 0);
});

test('pattern tools only touch the first len steps', () => {
  const steps = [100, 0, 0, 0, 7, 8, 9, 10, 0, 0, 0, 0, 0, 0, 0, 0];
  assert.deepEqual(C.rotateSteps(steps, 4, 1).slice(0, 4), [0, 100, 0, 0]);
  assert.deepEqual(C.rotateSteps(steps, 4, -1).slice(0, 4), [0, 0, 0, 100]);
  assert.deepEqual(C.rotateSteps(steps, 4, 1).slice(4), steps.slice(4));
  assert.deepEqual(C.invertSteps(steps, 4).slice(0, 4), [0, 100, 100, 100]);
  assert.equal(C.invertSteps(steps, 4)[4], 7);
  assert.deepEqual(C.mirrorSteps([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 4).slice(0, 5), [4, 3, 2, 1, 5]);
  assert.deepEqual(C.fillSteps(steps, 2, 100).slice(0, 3), [100, 100, 0]);
});

test('randomSteps respects density extremes', () => {
  const r = C.rng(5);
  const steps = new Array(16).fill(0);
  assert.ok(C.randomSteps(steps, 16, 0, r).every((v) => v === 0));
  assert.ok(C.randomSteps(steps, 16, 1, r).every((v) => v === 100));
  const soft = C.randomSteps(steps, 16, 1, C.rng(9), true);
  assert.ok(soft.every((v) => v >= 40 && v <= 100));
});

test('every preset is valid and builds a finite table', () => {
  assert.ok(C.PRESETS.length >= 12);
  const names = new Set();
  for (let i = 0; i < C.PRESETS.length; i++) {
    const p = C.presetParams(i, { seed: 77 });
    names.add(C.PRESETS[i].name);
    assert.equal(p.seed, 77);
    assert.equal(p.steps.length, 16);
    for (const d of C.PARAM_DEFS) assert.ok(p[d.name] >= d.min && p[d.name] <= d.max, C.PRESETS[i].name + ' ' + d.name);
    const t = C.buildTables(p).L;
    const [lo, hi] = minmax(t);
    assert.ok(lo >= 0 && hi <= 1 && Number.isFinite(lo + hi), C.PRESETS[i].name);
    assert.ok(hi - lo > 0.4, C.PRESETS[i].name + ' actually gates');
  }
  assert.equal(names.size, C.PRESETS.length, 'unique names');
  assert.equal(C.presetParams(-1).seed, C.defaults().seed, 'wraps around');
});

test('formatValue', () => {
  assert.equal(C.formatValue('rate', 6), '1/16');
  assert.equal(C.formatValue('direction', 2), 'PING');
  assert.equal(C.formatValue('stereo', 0), 'OFF');
  assert.equal(C.formatValue('depth', 50), '50%');
});
