// Runs the built device/gaaatrr.v8.js against a small mock of Max's v8 environment.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');

function loadEngine() {
  execFileSync(process.execPath, [path.join(root, 'scripts/build.js')], { stdio: 'ignore' });
  const source = fs.readFileSync(path.join(root, 'device/gaaatrr.v8.js'), 'utf8');

  const out = { thispatcher: [], ui: [], phasor: [], posts: [] };
  const buffers = {};
  class Buffer {
    constructor(name) {
      this.name = name;
      this.sent = [];
      this.data = null;
      buffers[name] = this;
    }
    send(...args) { this.sent.push(args); }
    poke(channel, index, data) { this.data = { channel, index, data }; }
  }
  class Task {
    constructor(fn) { this.fn = fn; }
    schedule() { this.fn(); } // run immediately
    cancel() {}
  }
  const sandbox = {
    Buffer,
    Task,
    post: (m) => out.posts.push(m),
    arrayfromargs: (a) => Array.prototype.slice.call(a),
    outlet: (n, ...args) => {
      if (n === 0) out.thispatcher.push(args);
      if (n === 1) out.ui.push(args);
      if (n === 2) out.phasor.push(args);
    },
    module: undefined,
  };
  vm.createContext(sandbox);
  // top-level `var`/`function` declarations land on the sandbox global
  vm.runInContext(source, sandbox);
  return { sandbox, out, buffers };
}

test('init creates both buffers, sizes them and writes the tables', () => {
  const { sandbox, out, buffers } = loadEngine();
  sandbox.init();
  const size = sandbox.GaaatrrCore.TABLE_SIZE;
  assert.deepEqual(buffers.gaaatrr_L.sent[0], ['sizeinsamps', size]);
  assert.deepEqual(buffers.gaaatrr_R.sent[0], ['sizeinsamps', size]);
  assert.equal(buffers.gaaatrr_L.data.data.length, size);
  assert.equal(buffers.gaaatrr_L.data.channel, 1);
  assert.equal(buffers.gaaatrr_L.data.index, 0);
  assert.deepEqual(out.phasor.at(-1), [sandbox.GaaatrrCore.phasorMessage(sandbox.state)]);
  assert.equal(out.ui.at(-1)[0], 'state');
});

test('params from the UI update live.* objects and the tables, but not the UI', () => {
  const { sandbox, out, buffers } = loadEngine();
  sandbox.init();
  const before = out.ui.length;
  sandbox.params('depth', 40, 's2', 100, 'len', 8);
  assert.deepEqual(out.thispatcher, [
    ['script', 'send', 'depth', 'set', 40],
    ['script', 'send', 's2', 'set', 100],
    ['script', 'send', 'len', 'set', 8],
  ]);
  assert.equal(out.ui.length, before, 'no echo back to the UI');
  assert.equal(sandbox.state.len, 8);
  assert.equal(out.phasor.at(-1)[0], sandbox.GaaatrrCore.phasorMessage(sandbox.state));
  const tables = sandbox.GaaatrrCore.buildTables(sandbox.state);
  assert.deepEqual(Array.from(buffers.gaaatrr_L.data.data.slice(0, 64)), Array.from(tables.L.slice(0, 64)));
});

test('params that change nothing stay silent', () => {
  const { sandbox, out } = loadEngine();
  sandbox.init();
  const n = out.thispatcher.length;
  sandbox.params('depth', sandbox.state.depth);
  sandbox.params('bogus', 5, 's99', 1);
  assert.equal(out.thispatcher.length, n);
});

test('param from a live.* object updates the UI but does not write back to live.*', () => {
  const { sandbox, out } = loadEngine();
  sandbox.init();
  out.ui.length = 0;
  sandbox.param('swing', 33);
  assert.equal(sandbox.state.swing, 33);
  assert.equal(out.thispatcher.length, 0);
  const msg = out.ui.at(-1);
  assert.equal(msg[0], 'state');
  assert.equal(msg[msg.indexOf('swing') + 1], 33);
});

test('ready sends the whole state as name/value pairs', () => {
  const { sandbox, out } = loadEngine();
  sandbox.ready();
  const msg = out.ui.at(-1);
  assert.equal(msg[0], 'state');
  const names = sandbox.GaaatrrCore.paramNames();
  assert.equal(msg.length, 1 + names.length * 2);
  names.forEach((n, i) => assert.equal(msg[1 + i * 2], n));
});

test('a missing buffer~ is reported, not thrown', () => {
  const { sandbox, out } = loadEngine();
  sandbox.Buffer = function () { throw new Error('no such buffer'); };
  assert.doesNotThrow(() => sandbox.init());
  assert.ok(out.posts.some((m) => m.includes('cannot open buffer~')));
});
