/* Gaaatrr core — pure logic, no Max and no DOM dependencies.
 *
 * The same file runs in three places:
 *   - Max's v8 object   (scripts/build.js concatenates it into device/gaaatrr.v8.js)
 *   - the jweb UI       (scripts/build.js inlines it into device/gaaatrr-ui.html)
 *   - Node              (test/*.test.js)
 *
 * Because the UI draws the very same envelope tables the audio engine plays,
 * what you see is exactly what you hear.
 */
var GaaatrrCore = (function () {
  'use strict';

  const MAX_STEPS = 16;
  const TABLE_CYCLE = 4096; // table samples covering one pass through the pattern
  const VARIATION_CYCLES = 8; // passes baked into one table (chance / humanize / direction vary per pass)
  const TABLE_SIZE = TABLE_CYCLE * VARIATION_CYCLES;
  const TICKS_PER_BEAT = 480;
  const MIN_RAMP = 2; // table samples; keeps hard edges click-free

  // Step length. `beats` is in quarter notes.
  const RATES = [
    { name: '1/2', beats: 2 },
    { name: '1/4', beats: 1 },
    { name: '1/4T', beats: 2 / 3 },
    { name: '1/8', beats: 1 / 2 },
    { name: '1/8D', beats: 3 / 4 },
    { name: '1/8T', beats: 1 / 3 },
    { name: '1/16', beats: 1 / 4 },
    { name: '1/16D', beats: 3 / 8 },
    { name: '1/16T', beats: 1 / 6 },
    { name: '1/32', beats: 1 / 8 },
    { name: '1/32T', beats: 1 / 12 },
  ];

  const DIRECTIONS = ['FWD', 'REV', 'PING', 'RAND'];

  // Everything except the 16 step levels. Order is the order of the knobs in the UI.
  const PARAM_DEFS = [
    { name: 'rate', label: 'RATE', min: 0, max: RATES.length - 1, def: 6, int: true },
    { name: 'len', label: 'LENGTH', min: 1, max: MAX_STEPS, def: 16, int: true },
    { name: 'swing', label: 'SWING', min: 0, max: 100, def: 0, int: true },
    { name: 'gate', label: 'GATE', min: 5, max: 100, def: 75, int: true },
    { name: 'attack', label: 'ATTACK', min: 0, max: 100, def: 8, int: true },
    { name: 'release', label: 'RELEASE', min: 0, max: 100, def: 30, int: true },
    { name: 'curve', label: 'CURVE', min: -100, max: 100, def: 0, int: true },
    { name: 'depth', label: 'DEPTH', min: 0, max: 100, def: 100, int: true },
    { name: 'direction', label: 'DIRECTION', min: 0, max: DIRECTIONS.length - 1, def: 0, int: true },
    { name: 'chance', label: 'CHANCE', min: 0, max: 100, def: 100, int: true },
    { name: 'humanize', label: 'HUMANIZE', min: 0, max: 100, def: 0, int: true },
    { name: 'nudge', label: 'NUDGE', min: 0, max: 100, def: 0, int: true },
    { name: 'stereo', label: 'STEREO', min: 0, max: MAX_STEPS - 1, def: 0, int: true },
    { name: 'seed', label: 'SEED', min: 0, max: 9999, def: 1, int: true },
  ];

  const DEF_BY_NAME = {};
  PARAM_DEFS.forEach(function (d) { DEF_BY_NAME[d.name] = d; });

  const STEP_NAMES = [];
  for (let i = 1; i <= MAX_STEPS; i++) STEP_NAMES.push('s' + i);

  /** Names of every parameter, as exposed to Live: s1..s16 then the globals. */
  function paramNames() {
    return STEP_NAMES.concat(PARAM_DEFS.map(function (d) { return d.name; }));
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // 'X' full, 'x' strong, 'o' soft, '.' off
  const GLYPH_LEVEL = { X: 100, x: 70, o: 40, '.': 0 };

  function stepsFromString(str) {
    const steps = [];
    for (let i = 0; i < MAX_STEPS; i++) {
      const ch = str.charAt(i % str.length);
      steps.push(GLYPH_LEVEL[ch] || 0);
    }
    return steps;
  }

  function defaults() {
    const p = { steps: stepsFromString('X.XX.XX.X.XX.XX.') };
    PARAM_DEFS.forEach(function (d) { p[d.name] = d.def; });
    return p;
  }

  function clone(p) {
    const q = {};
    Object.keys(p).forEach(function (k) { q[k] = k === 'steps' ? p.steps.slice() : p[k]; });
    return q;
  }

  function clampParam(name, value) {
    let v = Number(value);
    if (!isFinite(v)) return null;
    if (/^s\d+$/.test(name)) return Math.round(clamp(v, 0, 100));
    const d = DEF_BY_NAME[name];
    if (!d) return null;
    v = clamp(v, d.min, d.max);
    return d.int ? Math.round(v) : v;
  }

  /** Set one parameter ('s1'..'s16' or a global). Returns true when the value changed. */
  function setParam(p, name, value) {
    const v = clampParam(name, value);
    if (v === null) return false;
    const m = /^s(\d+)$/.exec(name);
    if (m) {
      const i = Number(m[1]) - 1;
      if (i < 0 || i >= MAX_STEPS) return false;
      if (p.steps[i] === v) return false;
      p.steps[i] = v;
      return true;
    }
    if (p[name] === v) return false;
    p[name] = v;
    return true;
  }

  function getParam(p, name) {
    const m = /^s(\d+)$/.exec(name);
    return m ? p.steps[Number(m[1]) - 1] : p[name];
  }

  /** Mulberry32: tiny, fast, seedable. */
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function cycleRng(p, cycle) {
    return rng((p.seed * 2654435761 + cycle * 40503 + 12345) >>> 0);
  }

  /**
   * Which source step plays in each slot of the given pass.
   * FWD/REV are fixed, PING flips direction every other pass, RAND reshuffles every pass.
   */
  function stepOrder(p, cycle, random) {
    const n = p.len;
    const order = [];
    for (let i = 0; i < n; i++) order.push(i);
    const dir = p.direction;
    if (dir === 1 || (dir === 2 && cycle % 2 === 1)) order.reverse();
    if (dir === 3) {
      const r = random || cycleRng(p, cycle);
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        const t = order[i]; order[i] = order[j]; order[j] = t;
      }
    }
    return order;
  }

  /** Per-slot gate levels (0..1) for one pass, after direction, chance and humanize. */
  function cycleLevels(p, cycle) {
    const r = cycleRng(p, cycle);
    const order = stepOrder(p, cycle, r);
    const levels = [];
    for (let j = 0; j < p.len; j++) {
      let level = p.steps[order[j]] / 100;
      if (level > 0) {
        if (p.chance < 100 && r() * 100 >= p.chance) level = 0;
        else if (p.humanize > 0) level *= 1 - (p.humanize / 100) * r();
      }
      levels.push(level);
    }
    return levels;
  }

  function riseShape(x, curve) { return 1 - Math.pow(1 - x, Math.pow(4, curve / 100)); }
  function fallShape(x, curve) { return Math.pow(1 - x, Math.pow(4, curve / 100)); }

  function rotateTable(src, shift) {
    const n = src.length;
    const s = ((Math.round(shift) % n) + n) % n;
    if (s === 0) return src;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[(i + s) % n] = src[i];
    return out;
  }

  function samplesPerStep(p) { return TABLE_CYCLE / p.len; }

  /**
   * The gate envelope for the left channel: VARIATION_CYCLES passes of the pattern,
   * TABLE_SIZE samples, values 0..1 (1 = fully open). Playing it with a phasor~
   * that covers the whole table reproduces the gate sample-accurately.
   */
  function buildBase(p) {
    const env = new Float32Array(TABLE_SIZE);
    const per = samplesPerStep(p);
    const swingShift = (p.swing / 100) * 0.5; // odd slots slide up to half a step later
    const gate = p.gate / 100;
    const attack = Math.min(p.attack / 100, gate);
    const release = p.release / 100;

    for (let c = 0; c < VARIATION_CYCLES; c++) {
      const levels = cycleLevels(p, c);
      for (let j = 0; j < p.len; j++) {
        const level = levels[j];
        if (level <= 0) continue;
        const start = (c * p.len + j + (j % 2 === 1 ? swingShift : 0)) * per;
        const aLen = Math.max(attack * per, MIN_RAMP);
        const holdEnd = start + Math.max(gate * per, MIN_RAMP);
        const rLen = Math.max(release * per, MIN_RAMP);
        const end = holdEnd + rLen;
        for (let n = Math.floor(start); n <= Math.ceil(end); n++) {
          const t = n + 0.5;
          let v;
          if (t < start) continue;
          if (t < start + aLen) v = riseShape((t - start) / aLen, p.curve);
          else if (t < holdEnd) v = 1;
          else if (t < end) v = fallShape((t - holdEnd) / rLen, p.curve);
          else continue;
          v *= level;
          const idx = ((n % TABLE_SIZE) + TABLE_SIZE) % TABLE_SIZE;
          if (v > env[idx]) env[idx] = v;
        }
      }
    }

    // DEPTH: 100% = gate fully closes, 0% = no effect
    const depth = p.depth / 100;
    for (let i = 0; i < TABLE_SIZE; i++) env[i] = 1 - depth * (1 - env[i]);

    // NUDGE slides the whole pattern later by a fraction of one pass
    return rotateTable(env, (p.nudge / 100) * TABLE_CYCLE);
  }

  /** Left and right envelope tables. STEREO shifts the right channel by whole steps. */
  function buildTables(p) {
    const left = buildBase(p);
    const right = p.stereo > 0 ? rotateTable(left, p.stereo * samplesPerStep(p)) : left;
    return { L: left, R: right };
  }

  /** Gate value (0..1) at a phase (0..1 across the whole table), linearly interpolated. */
  function tableAt(table, phase) {
    const x = (((phase % 1) + 1) % 1) * table.length;
    const i = Math.floor(x);
    const f = x - i;
    const a = table[i % table.length];
    const b = table[(i + 1) % table.length];
    return a + (b - a) * f;
  }

  /** Length of one full table, in quarter notes. */
  function tableBeats(p) { return VARIATION_CYCLES * p.len * RATES[p.rate].beats; }

  /** Tempo-relative time for phasor~ @lock 1, in ticks, e.g. "7680i". */
  function phasorMessage(p) { return Math.round(tableBeats(p) * TICKS_PER_BEAT) + 'i'; }

  /** Where the playhead is, from a table phase (0..1). */
  function locate(p, phase) {
    const pos = (((phase % 1) + 1) % 1) * VARIATION_CYCLES;
    const cycle = Math.min(VARIATION_CYCLES - 1, Math.floor(pos));
    const inCycle = pos - cycle;
    const shifted = (((inCycle - p.nudge / 100) % 1) + 1) % 1; // undo NUDGE for display
    const slot = Math.min(p.len - 1, Math.floor(shifted * p.len));
    const order = stepOrder(p, cycle);
    return { cycle: cycle, inCycle: inCycle, slot: slot, step: order[slot] };
  }

  // ---- pattern tools -------------------------------------------------------

  function euclid(len, hits, rot) {
    const out = [];
    for (let i = 0; i < len; i++) {
      out.push(Math.floor(((i + 1) * hits) / len) - Math.floor((i * hits) / len) > 0 ? 100 : 0);
    }
    return rotateSteps(out, len, rot || 0);
  }

  /** Rotate the first `len` entries by n (positive = later). Entries past len are untouched. */
  function rotateSteps(steps, len, n) {
    const out = steps.slice();
    for (let i = 0; i < len; i++) out[(((i + n) % len) + len) % len] = steps[i];
    return out;
  }

  function invertSteps(steps, len) {
    return steps.map(function (v, i) { return i < len ? (v > 0 ? 0 : 100) : v; });
  }

  function mirrorSteps(steps, len) {
    return steps.map(function (v, i) { return i < len ? steps[len - 1 - i] : v; });
  }

  function fillSteps(steps, len, value) {
    return steps.map(function (v, i) { return i < len ? value : v; });
  }

  function randomSteps(steps, len, density, random, softLevels) {
    return steps.map(function (v, i) {
      if (i >= len) return v;
      if (random() >= density) return 0;
      return softLevels && random() < 0.3 ? 40 + Math.round(random() * 40) : 100;
    });
  }

  // ---- presets -------------------------------------------------------------

  const PRESETS = [
    { name: 'TRANCE TIGER', pattern: 'X.XX.XX.X.XX.XX.', rate: 6, gate: 75, attack: 8, release: 30 },
    { name: 'OFFBEAT PUMA', pattern: '.X.X.X.X', len: 8, rate: 3, gate: 60, attack: 6, release: 25 },
    { name: 'GALLOP GOBLIN', pattern: 'XX.XX.XXXX.XX.XX', rate: 6, gate: 70, release: 20 },
    { name: 'TRESILLO TURTLE', pattern: 'X..X..X.', len: 8, rate: 3, gate: 85, attack: 10, release: 35 },
    { name: 'STUTTER OTTER', pattern: 'XXXXXXXX........', rate: 9, gate: 45, attack: 0, release: 15 },
    { name: 'HALF-TIME HIPPO', pattern: 'X.XX.X..', len: 8, rate: 1, gate: 90, attack: 12, release: 40 },
    { name: 'ROLLING NOODLE', pattern: 'XXX.XXX.XXX.', len: 12, rate: 8, gate: 80, release: 25 },
    { name: 'DRIVING DINGO', pattern: 'X.X.X.X.X.X.X.XX', rate: 6, gate: 55, attack: 4, release: 20, curve: 30 },
    { name: 'SPARSE SLOTH', pattern: 'X.......X..X....', rate: 6, gate: 95, attack: 20, release: 60, curve: -30 },
    { name: 'SYNCOPATED SQUID', pattern: 'X..X..X..X..X.X.', rate: 6, gate: 70, release: 30, swing: 25 },
    { name: 'SOFT PILLOW', pattern: 'XoXoXoXoXoXoXoXo', rate: 6, gate: 90, attack: 30, release: 55, curve: -40, depth: 75 },
    { name: 'MACHINE GUN', pattern: 'XXXXXXXXXXXXXXXX', rate: 9, gate: 50, attack: 0, release: 10, curve: 40 },
    { name: 'WIDE WOBBLE', pattern: 'X.XXX.X.XX.XX.X.', rate: 6, gate: 80, release: 40, stereo: 4, depth: 90 },
    { name: 'GHOST NOTES', pattern: 'XoxoXoxoXoxoXoxo', rate: 6, gate: 65, release: 30, chance: 80, humanize: 30 },
    { name: 'EUCLID 5/16', euclid: [16, 5], rate: 6, gate: 70, release: 30 },
    { name: 'EUCLID 7/12', euclid: [12, 7], len: 12, rate: 8, gate: 75, release: 30 },
  ];

  /** A full parameter set for a preset (the current seed is kept). */
  function presetParams(index, current) {
    const preset = PRESETS[((index % PRESETS.length) + PRESETS.length) % PRESETS.length];
    const p = defaults();
    if (current) p.seed = current.seed;
    if (preset.len) p.len = preset.len;
    if (preset.euclid) {
      p.len = preset.euclid[0];
      p.steps = euclid(p.len, preset.euclid[1], 0);
      while (p.steps.length < MAX_STEPS) p.steps.push(0);
    } else {
      p.steps = stepsFromString(preset.pattern);
    }
    ['rate', 'swing', 'gate', 'attack', 'release', 'curve', 'depth', 'chance', 'humanize', 'stereo', 'direction', 'nudge']
      .forEach(function (k) { if (preset[k] !== undefined) p[k] = preset[k]; });
    return p;
  }

  // ---- display helpers -----------------------------------------------------

  function formatValue(name, value) {
    if (name === 'rate') return RATES[value].name;
    if (name === 'direction') return DIRECTIONS[value];
    if (name === 'len' || name === 'seed') return String(value);
    if (name === 'stereo') return value === 0 ? 'OFF' : value + ' ST';
    return value + '%';
  }

  return {
    MAX_STEPS: MAX_STEPS,
    TABLE_CYCLE: TABLE_CYCLE,
    VARIATION_CYCLES: VARIATION_CYCLES,
    TABLE_SIZE: TABLE_SIZE,
    TICKS_PER_BEAT: TICKS_PER_BEAT,
    RATES: RATES,
    DIRECTIONS: DIRECTIONS,
    PARAM_DEFS: PARAM_DEFS,
    PRESETS: PRESETS,
    paramNames: paramNames,
    defaults: defaults,
    clone: clone,
    clamp: clamp,
    clampParam: clampParam,
    setParam: setParam,
    getParam: getParam,
    rng: rng,
    stepOrder: stepOrder,
    cycleLevels: cycleLevels,
    buildTables: buildTables,
    tableAt: tableAt,
    tableBeats: tableBeats,
    phasorMessage: phasorMessage,
    locate: locate,
    samplesPerStep: samplesPerStep,
    euclid: euclid,
    rotateSteps: rotateSteps,
    invertSteps: invertSteps,
    mirrorSteps: mirrorSteps,
    fillSteps: fillSteps,
    randomSteps: randomSteps,
    stepsFromString: stepsFromString,
    presetParams: presetParams,
    formatValue: formatValue,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = GaaatrrCore;
