# The Max side: how it fits together, and what to check first

Gaaatrr's logic lives in plain JavaScript (`src/core.js`) and is unit-tested. The Max patch is only plumbing,
and **it has not been opened in Max yet** — it was generated and structurally tested, not run. This page is
the spec to build or repair it by hand, plus a checklist of the few places where Max behaviour is the
thing most likely to need a tweak.

## Signal flow

```
 plugin~ ─L─► *~ ──┐
          ─R─► *~ ─┤                       ┌─ live.gain~ ─► plugout~
                   └──────────────────────►┘
 [v8 gaaatrr.v8.js] ─ writes ─► buffer~ gaaatrr_L / gaaatrr_R   (32768 samples each)
                                    ▲
 phasor~ @lock 1 ─► wave~ gaaatrr_L ─► *~ (left)
                 └► wave~ gaaatrr_R ─► *~ (right)
```

`core.js` bakes the whole gate — step levels, gate length, attack/release curve, swing, depth, nudge,
direction, chance, humanize, stereo offset — into one envelope table covering **8 passes** of the pattern.
`phasor~ @lock 1` is told (as a tempo-relative time in ticks, e.g. `15360i`) how long that table is, so it
stays glued to Live's timeline. `wave~` reads the table, and the audio is multiplied by it. Nothing in the
audio path is tempo-aware; change the tempo and the phasor follows.

Because chance/humanize/direction are baked per pass with a seed, the gate is repeatable (same seed, same
groove) and sample-accurate, with no per-cycle messaging that could arrive late.

## Messages

| From → to | Message | Meaning |
|---|---|---|
| `live.thisdevice` → `[init]` → v8 | `init` | open buffers, write tables, push state to the UI |
| `live.thisdevice` → `[readfile gaaatrr-ui.html]` → jweb | `readfile …` | load the UI |
| live.numbox → `[prepend param <name>]` → v8 | `param s3 70` | automation / Set load; v8 updates the UI only |
| jweb → v8 | `params depth 40 s2 100 …` | the UI edited something; v8 updates the live.numboxes only |
| jweb → v8 | `ready` | UI finished loading; v8 replies with `state` |
| v8 outlet 0 → `thispatcher` | `script send <varname> set <value>` | silent update of a live.numbox |
| v8 outlet 1 → jweb | `state <name> <value> …` | refresh the whole UI |
| v8 outlet 2 → phasor~ | `15360i` | cycle length in ticks |
| phasor~ → `snapshot~ 33` → `prepend phase` → jweb | `phase 0.4132` | playhead |

Each side only updates the *other* side, so the live.numboxes and the UI never feed back into each other.

## Parameters

Thirty hidden `live.numbox` objects (16 steps + 14 globals), each with a `varname` equal to its name here, plus
`live.gain~` as the visible Output control. All are automatable and saved in the Set.

`s1`…`s16` step level 0–100 · `rate` 0–10 · `len` 1–16 · `swing` 0–100 · `gate` 5–100 · `attack` 0–100 ·
`release` 0–100 · `curve` −100–100 · `depth` 0–100 · `direction` 0–3 · `chance` 0–100 · `humanize` 0–100 ·
`nudge` 0–100 · `stereo` 0–15 · `seed` 0–9999.

## Putting it into a device

1. `npm run build` (or just use the committed `device/` folder).
2. In Live, drop a new **Max Audio Effect** on a track and click the edit button.
3. Open `device/Gaaatrr.maxpat` in Max, **Select All → Copy**, then paste into the device's patcher
   (replace the default `plugin~`/`plugout~`).
4. Save the device **in the same folder as** `gaaatrr.v8.js` and `gaaatrr-ui.html`, or put those two files in
   a folder on Max's search path.
5. Use **Freeze Device** before sharing, so the JS and HTML travel inside the `.amxd`.

Needs Live 12 (which ships Max 9, for the `v8` object).

## First-run checklist

These are the spots where I couldn't verify real Max behaviour. If something is silent or wrong, start here.

1. **`phasor~ @lock 1` accepting `15360i`.** Tempo-relative notation (`4n`, `8nd`, …) is documented for
   transport-locked objects; ticks (`i`, 480 per quarter) should work the same. If the phasor doesn't move
   or the gate drifts, check the Max console, then try sending a note-value form to see whether the object
   accepts symbols at all. The conversion is the single function `phasorMessage()` in `src/core.js`.
2. **`jweb` loading `gaaatrr-ui.html` via `readfile`.** If the UI stays blank, check that the file is on the
   search path (or frozen). Right-click the jweb → *Open Web Inspector* for the console. The generated patch
   creates jweb as a typed object (`jweb`); if Max rejects it, create a jweb by hand, give it the same
   connections, and set its presentation rect to `0 0 820 169`.
3. **`Buffer` in `v8`.** The engine calls `new Buffer('gaaatrr_L')`, `send('sizeinsamps', 32768)` and
   `poke(1, 0, array)` (channel 1-based). If the Max console prints `gaaatrr: cannot open buffer~`, the
   `buffer~` names don't match; if the gate does nothing, check `poke`'s channel/offset convention in
   the v8 docs.
4. **`script send <varname> set <value>`** into `thispatcher` to update a `live.numbox`. If UI edits sound right
   but don't survive saving the Set, this is the link to check.
5. **Start-up order.** `live.thisdevice` fires `init` while the live.numboxes may still be restoring. Values
   arriving after `init` flow through `param` and update everything, so this should just work, but verify
   that a saved Set reopens with its pattern intact.
6. **`wave~` over the full buffer.** With no start/end arguments it should map phase 0–1 across the whole
   buffer. If the gate looks stretched or squashed against the UI scope, give `wave~` explicit
   `0 <buffer length in ms>` arguments.

## Changing things

- A new parameter = one entry in `PARAM_DEFS` (`src/core.js`) + use it in `buildBase()` + a test. The patch
  generator, UI knob grid and engine pick it up automatically, except the UI's knob grid is laid out for
  14 knobs in 2 rows of 7 (`KNOB`/`KNOB_HUE` in `src/ui.html`).
- `npm test` covers the DSP, the engine (against a mock Max), the patch wiring and the UI (in headless
  Chromium, if Playwright is installed).
