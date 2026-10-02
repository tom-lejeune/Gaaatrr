#!/usr/bin/env node
/* Generates device/Gaaatrr.maxpat.
 *
 * The audio path is deliberately tiny — all the thinking happens in src/core.js:
 *
 *   plugin~ ─► *~ ─► live.gain~ ─► plugout~          (x2, left and right)
 *               ▲
 *   phasor~ @lock 1 ─► wave~ gaaatrr_L / gaaatrr_R   (envelope tables written by [v8])
 *
 * Every parameter is a hidden live.numbox so Live can automate it, save it in the Set and
 * recall it in presets. [v8] is the hub: UI edits flow  jweb -> v8 -> thispatcher -> live.numbox,
 * and automation flows  live.numbox -> prepend param -> v8 -> jweb.
 *
 * Generated, not hand-edited, so it diffs well. See docs/PATCH.md for the object-by-object spec.
 */
const fs = require('fs');
const path = require('path');
const C = require('../src/core.js');

const DEVICE_W = 868;
const DEVICE_H = 169;

const LONG_NAMES = { len: 'Length', rate: 'Rate' };

function build() {
  const boxes = [];
  const lines = [];
  let n = 0;

  function add(box) {
    const id = 'obj-' + ++n;
    boxes.push({ box: Object.assign({ id }, box) });
    return id;
  }
  function connect(from, outlet, to, inlet) {
    lines.push({ patchline: { source: [from, outlet], destination: [to, inlet] } });
  }
  function comment(text, x, y, w) {
    return add({
      maxclass: 'comment', text, numinlets: 1, numoutlets: 0,
      patching_rect: [x, y, w || 300, 20], fontsize: 11,
    });
  }
  function obj(text, x, y, inlets, outlets, outlettype, extra) {
    return add(Object.assign({
      maxclass: 'newobj', text, numinlets: inlets, numoutlets: outlets,
      outlettype: outlettype, patching_rect: [x, y, Math.max(40, text.length * 7 + 12), 22],
    }, extra));
  }
  function message(text, x, y) {
    return add({
      maxclass: 'message', text, numinlets: 2, numoutlets: 1, outlettype: [''],
      patching_rect: [x, y, Math.max(40, text.length * 7 + 12), 22],
    });
  }

  // ---- UI + hub ------------------------------------------------------------
  comment('UI: jweb shows src/ui.html. Hub: v8 runs core + engine.', 20, 10, 420);
  const jweb = obj('jweb', 20, 70, 1, 2, ['', ''], {
    presentation: 1, presentation_rect: [0, 0, 820, DEVICE_H],
  });
  const v8 = obj('v8 gaaatrr.v8.js', 20, 140, 1, 3, ['', '', '']);
  const thispatcher = obj('thispatcher', 20, 190, 1, 2, ['', '']);
  const loadUi = message('readfile gaaatrr-ui.html', 260, 40);
  const initMsg = message('init', 260, 100);
  const thisdevice = obj('live.thisdevice', 260, 10, 1, 3, ['bang', 'int', 'int']);

  connect(thisdevice, 0, loadUi, 0);
  connect(thisdevice, 0, initMsg, 0);
  connect(loadUi, 0, jweb, 0);
  connect(initMsg, 0, v8, 0);
  connect(jweb, 0, v8, 0); // params ... / ready
  connect(v8, 0, thispatcher, 0); // script send <name> set <value>
  connect(v8, 1, jweb, 0); // state ...

  // ---- audio ---------------------------------------------------------------
  comment('Audio: gate tables are read by wave~ driven by a transport-locked phasor~.', 480, 10, 460);
  const plugin = obj('plugin~', 480, 40, 0, 2, ['signal', 'signal']);
  const phasor = obj('phasor~ @lock 1', 700, 40, 2, 1, ['signal']);
  const waveL = obj('wave~ gaaatrr_L', 700, 90, 3, 2, ['signal', 'signal']);
  const waveR = obj('wave~ gaaatrr_R', 850, 90, 3, 2, ['signal', 'signal']);
  const mulL = obj('*~', 480, 140, 2, 1, ['signal']);
  const mulR = obj('*~', 530, 140, 2, 1, ['signal']);
  const gain = add({
    maxclass: 'live.gain~', numinlets: 2, numoutlets: 5,
    outlettype: ['signal', 'signal', '', 'float', 'list'],
    patching_rect: [480, 190, 40, 94], presentation: 1, presentation_rect: [824, 4, 42, 161],
    parameter_enable: 1,
    saved_attribute_attributes: {
      valueof: {
        parameter_longname: 'Output', parameter_shortname: 'Out', parameter_type: 0,
        parameter_mmin: -70, parameter_mmax: 6, parameter_initial: [0], parameter_initial_enable: 1,
        parameter_unitstyle: 4,
      },
    },
    varname: 'output',
  });
  const plugout = obj('plugout~', 480, 300, 2, 0, []);
  const bufL = obj('buffer~ gaaatrr_L 1000 1', 700, 190, 1, 2, ['float', 'bang']);
  const bufR = obj('buffer~ gaaatrr_R 1000 1', 880, 190, 1, 2, ['float', 'bang']);
  comment('buffer~ lengths are set by [v8] on init (sizeinsamps).', 700, 220, 320);

  connect(plugin, 0, mulL, 0);
  connect(plugin, 1, mulR, 0);
  connect(phasor, 0, waveL, 0);
  connect(phasor, 0, waveR, 0);
  connect(waveL, 0, mulL, 1);
  connect(waveR, 0, mulR, 1);
  connect(mulL, 0, gain, 0);
  connect(mulR, 0, gain, 1);
  connect(gain, 0, plugout, 0);
  connect(gain, 1, plugout, 1);
  connect(v8, 2, phasor, 0); // tempo-relative cycle length, e.g. 15360i

  // playhead -> UI at ~30 fps
  const snap = obj('snapshot~ 33', 700, 140, 2, 1, ['float']);
  const prependPhase = obj('prepend phase', 800, 140, 1, 1, ['']);
  connect(phasor, 0, snap, 0);
  connect(snap, 0, prependPhase, 0);
  connect(prependPhase, 0, jweb, 0);
  comment('(wired: phasor~ -> snapshot~ -> prepend phase -> jweb)', 700, 165, 330);

  // ---- parameters ----------------------------------------------------------
  comment('Hidden parameters (automatable, saved with the Set). live.numbox -> prepend param <name> -> v8.', 20, 330, 700);
  const defaults = C.defaults();
  const specs = [];
  C.paramNames().forEach(function (name, i) {
    if (/^s\d+$/.test(name)) {
      specs.push({ name, longname: 'Step ' + name.slice(1), min: 0, max: 100, init: defaults.steps[i] });
    } else {
      const d = C.PARAM_DEFS.find(function (x) { return x.name === name; });
      specs.push({
        name, longname: LONG_NAMES[name] || d.label.charAt(0) + d.label.slice(1).toLowerCase(),
        min: d.min, max: d.max, init: d.def,
      });
    }
  });

  specs.forEach(function (s, i) {
    const col = i % 6;
    const row = Math.floor(i / 6);
    const x = 20 + col * 160;
    const y = 360 + row * 70;
    const numbox = add({
      maxclass: 'live.numbox', numinlets: 1, numoutlets: 2, outlettype: ['', 'float'],
      patching_rect: [x, y, 52, 15], parameter_enable: 1,
      saved_attribute_attributes: {
        valueof: {
          parameter_longname: s.longname, parameter_shortname: s.longname, parameter_type: 1,
          parameter_mmin: s.min, parameter_mmax: s.max, parameter_initial: [s.init],
          parameter_initial_enable: 1, parameter_unitstyle: 0,
        },
      },
      varname: s.name,
    });
    const prep = obj('prepend param ' + s.name, x, y + 28, 1, 1, ['']);
    connect(numbox, 0, prep, 0);
    connect(prep, 0, v8, 0);
  });

  return {
    patcher: {
      fileversion: 1,
      appversion: { major: 9, minor: 0, revision: 0, architecture: 'x64', modernui: 1 },
      classnamespace: 'box',
      rect: [60, 60, 1160, 760],
      openinpresentation: 1,
      devicewidth: DEVICE_W,
      gridsize: [15, 15],
      boxes: boxes,
      lines: lines,
      dependency_cache: [],
      autosave: 0,
    },
  };
}

function write(file) {
  fs.writeFileSync(file, JSON.stringify(build(), null, 2) + '\n');
}

module.exports = { build, write, DEVICE_W, DEVICE_H };

if (require.main === module) {
  const out = path.join(__dirname, '..', 'device', 'Gaaatrr.maxpat');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  write(out);
  console.log('wrote ' + out);
}
