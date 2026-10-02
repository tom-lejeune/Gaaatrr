/* Gaaatrr engine — the glue that lives inside Max's v8 object.
 *
 * Needs GaaatrrCore in scope (scripts/build.js puts src/core.js in front of this file).
 *
 *   inlet 0   messages from the patch (see "Messages" below)
 *   outlet 0  -> [thispatcher]   "script send <varname> set <value>" to keep the live.* parameters in sync
 *   outlet 1  -> [jweb]          "state <name> <value> ..." to refresh the UI
 *   outlet 2  -> [phasor~]       tempo-relative cycle length, e.g. "7680i"
 *
 * Messages
 *   init                      once, from [live.thisdevice]
 *   param <name> <value>      from a live.* parameter (automation, preset recall, Live Set load)
 *   params <name> <value> ... from the UI: one or more edits
 *   ready                     from the UI once the page has loaded: send it the full state
 */

inlets = 1;
outlets = 3;

var BUFFER_L = 'gaaatrr_L';
var BUFFER_R = 'gaaatrr_R';
var REBUILD_DELAY_MS = 20; // coalesce bursts of edits into one table rewrite
var UI_DELAY_MS = 20;

var state = GaaatrrCore.defaults();
var bufL = null;
var bufR = null;
var rebuildTask = null;
var uiTask = null;

function ensureBuffers() {
  if (bufL && bufR) return true;
  try {
    bufL = new Buffer(BUFFER_L);
    bufR = new Buffer(BUFFER_R);
    bufL.send('sizeinsamps', GaaatrrCore.TABLE_SIZE);
    bufR.send('sizeinsamps', GaaatrrCore.TABLE_SIZE);
    return true;
  } catch (e) {
    bufL = bufR = null;
    post('gaaatrr: cannot open buffer~ ' + BUFFER_L + ' / ' + BUFFER_R + ' (' + e + ')\n');
    return false;
  }
}

function toArray(typed) { return Array.prototype.slice.call(typed); }

function rebuild() {
  if (!ensureBuffers()) return;
  var tables = GaaatrrCore.buildTables(state);
  bufL.poke(1, 0, toArray(tables.L));
  bufR.poke(1, 0, toArray(tables.R));
  outlet(2, GaaatrrCore.phasorMessage(state));
}

function sendState() {
  var args = ['state'];
  GaaatrrCore.paramNames().forEach(function (name) {
    args.push(name, GaaatrrCore.getParam(state, name));
  });
  outlet(1, ...args);
}

function schedule(kind) {
  if (typeof Task === 'undefined') {
    if (kind === 'rebuild') rebuild(); else sendState();
    return;
  }
  if (kind === 'rebuild') {
    if (!rebuildTask) rebuildTask = new Task(function () { rebuild(); }, this);
    rebuildTask.schedule(REBUILD_DELAY_MS);
  } else {
    if (!uiTask) uiTask = new Task(function () { sendState(); }, this);
    uiTask.schedule(UI_DELAY_MS);
  }
}

function init() {
  ensureBuffers();
  schedule('rebuild');
  schedule('ui');
}

/** A live.* parameter changed (automation, Live Set load...): update the UI, not the live.* object. */
function param(name, value) {
  if (GaaatrrCore.setParam(state, String(name), value)) {
    schedule('rebuild');
    schedule('ui');
  }
}

/** The UI edited something: update the live.* objects (silently), not the UI. */
function params() {
  var a = arrayfromargs(arguments);
  var changed = false;
  for (var i = 0; i + 1 < a.length; i += 2) {
    var name = String(a[i]);
    if (GaaatrrCore.setParam(state, name, a[i + 1])) {
      changed = true;
      outlet(0, 'script', 'send', name, 'set', GaaatrrCore.getParam(state, name));
    }
  }
  if (changed) schedule('rebuild');
}

function ready() {
  sendState();
}

function notifydeleted() {
  if (rebuildTask) rebuildTask.cancel();
  if (uiTask) uiTask.cancel();
}
