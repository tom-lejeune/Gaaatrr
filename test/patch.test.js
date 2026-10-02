// Structural checks on the generated Max patcher. These can't prove Max will accept the file
// (see docs/PATCH.md for the first-run checklist) but they catch broken wiring and missing parameters.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core.js');
const { build } = require('../scripts/make-patch.js');

const patcher = build().patcher;
const boxes = patcher.boxes.map((b) => b.box);
const byId = Object.fromEntries(boxes.map((b) => [b.id, b]));

test('box ids are unique and every line points at a real inlet and outlet', () => {
  assert.equal(Object.keys(byId).length, boxes.length);
  assert.ok(patcher.lines.length > 60);
  for (const { patchline: l } of patcher.lines) {
    const from = byId[l.source[0]], to = byId[l.destination[0]];
    assert.ok(from && to, 'both ends exist: ' + JSON.stringify(l));
    assert.ok(l.source[1] < from.numoutlets, `${from.text || from.maxclass} has outlet ${l.source[1]}`);
    assert.ok(l.destination[1] < to.numinlets, `${to.text || to.maxclass} has inlet ${l.destination[1]}`);
  }
});

test('every parameter has exactly one live.numbox with the right range and varname', () => {
  const numboxes = boxes.filter((b) => b.maxclass === 'live.numbox');
  assert.equal(numboxes.length, C.paramNames().length);
  const defaults = C.defaults();
  for (const name of C.paramNames()) {
    const nb = numboxes.filter((b) => b.varname === name);
    assert.equal(nb.length, 1, name);
    const v = nb[0].saved_attribute_attributes.valueof;
    assert.equal(nb[0].parameter_enable, 1);
    assert.ok(v.parameter_mmin < v.parameter_mmax);
    assert.ok(v.parameter_initial[0] >= v.parameter_mmin && v.parameter_initial[0] <= v.parameter_mmax);
    if (/^s\d+$/.test(name)) assert.equal(v.parameter_initial[0], defaults.steps[Number(name.slice(1)) - 1]);
    else assert.equal(v.parameter_initial[0], defaults[name]);
  }
  const longnames = numboxes.map((b) => b.saved_attribute_attributes.valueof.parameter_longname);
  assert.equal(new Set(longnames).size, longnames.length, 'unique parameter names in Live');
});

test('each parameter reaches v8 through its own "prepend param <name>"', () => {
  const v8 = boxes.find((b) => b.text === 'v8 gaaatrr.v8.js');
  for (const name of C.paramNames()) {
    const prep = boxes.find((b) => b.text === 'prepend param ' + name);
    assert.ok(prep, name);
    const into = patcher.lines.filter((l) => l.patchline.destination[0] === prep.id);
    const out = patcher.lines.filter((l) => l.patchline.source[0] === prep.id);
    assert.equal(into.length, 1, name + ' fed by one numbox');
    assert.equal(byId[into[0].patchline.source[0]].varname, name);
    assert.deepEqual(out.map((l) => l.patchline.destination[0]), [v8.id]);
  }
});

test('the audio path is wired plugin~ -> *~ -> live.gain~ -> plugout~ with wave~ gating', () => {
  const find = (text) => boxes.find((b) => b.text === text);
  const wires = patcher.lines.map((l) => {
    const p = l.patchline;
    return `${byId[p.source[0]].text || byId[p.source[0]].maxclass}:${p.source[1]}>${byId[p.destination[0]].text || byId[p.destination[0]].maxclass}:${p.destination[1]}`;
  });
  for (const w of [
    'plugin~:0>*~:0', 'plugin~:1>*~:0',
    'phasor~ @lock 1:0>wave~ gaaatrr_L:0', 'phasor~ @lock 1:0>wave~ gaaatrr_R:0',
    'wave~ gaaatrr_L:0>*~:1', 'wave~ gaaatrr_R:0>*~:1',
    '*~:0>live.gain~:0', '*~:0>live.gain~:1',
    'live.gain~:0>plugout~:0', 'live.gain~:1>plugout~:1',
    'v8 gaaatrr.v8.js:2>phasor~ @lock 1:0',
    'v8 gaaatrr.v8.js:0>thispatcher:0',
    'v8 gaaatrr.v8.js:1>jweb:0',
    'jweb:0>v8 gaaatrr.v8.js:0',
    'phasor~ @lock 1:0>snapshot~ 33:0', 'snapshot~ 33:0>prepend phase:0', 'prepend phase:0>jweb:0',
  ]) assert.ok(wires.includes(w), 'missing wire ' + w);
  assert.ok(find('buffer~ gaaatrr_L 1000 1') && find('buffer~ gaaatrr_R 1000 1'));
});

test('buffer names in the patch match the ones the engine opens', () => {
  const engine = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/engine.js'), 'utf8');
  const names = [...engine.matchAll(/BUFFER_[LR] = '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(names.sort(), ['gaaatrr_L', 'gaaatrr_R']);
  for (const n of names) assert.ok(boxes.some((b) => b.text === 'wave~ ' + n), n);
});

test('the device presentation fits Live\'s fixed 169px height', () => {
  assert.equal(patcher.openinpresentation, 1);
  for (const b of boxes.filter((x) => x.presentation === 1)) {
    const [x, y, w, h] = b.presentation_rect;
    assert.ok(y + h <= 169, (b.text || b.maxclass) + ' bottom edge ' + (y + h));
    assert.ok(x + w <= patcher.devicewidth, (b.text || b.maxclass) + ' right edge');
  }
});
