// Drives device/gaaatrr-ui.html in headless Chromium with a mocked window.max.
// Skipped when Playwright or a Chromium binary isn't available.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

let playwright = null;
try { playwright = require('playwright'); } catch (e) { /* optional */ }

const chromiumPath = ['/opt/pw-browsers/chromium', process.env.CHROMIUM_PATH].find((p) => p && fs.existsSync(p));
const root = path.join(__dirname, '..');
const skip = !playwright ? 'playwright not installed' : false;

const MOCK = `
  window.__sent = [];
  window.__inlets = {};
  window.max = {
    outlet: function () { window.__sent.push(Array.prototype.slice.call(arguments)); },
    bindInlet: function (name, fn) { window.__inlets[name] = fn; },
  };
`;

async function open(browser, query) {
  execFileSync(process.execPath, [path.join(root, 'scripts/build.js')], { stdio: 'ignore' });
  const page = await browser.newPage({ viewport: { width: 820, height: 169 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(MOCK);
  await page.goto('file://' + path.join(root, 'device/gaaatrr-ui.html') + (query || ''));
  await page.waitForTimeout(150);
  return { page, errors };
}

const stepXY = (i) => ({ x: 10 + i * 24.4 + 11, y: 85 });
const knobXY = (i) => ({ x: 412 + (i % 7) * 57.5 + 28.75, y: 34 + Math.floor(i / 7) * 66 + 30 });

test('ui', { skip }, async (t) => {
  const browser = await playwright.chromium.launch(chromiumPath ? { executablePath: chromiumPath } : {});
  t.after(() => browser.close());

  await t.test('loads cleanly and tells Max it is ready', async () => {
    const { page, errors } = await open(browser);
    const sent = await page.evaluate(() => window.__sent);
    assert.deepEqual(sent[0], ['ready']);
    assert.deepEqual(errors, []);
    assert.deepEqual(Object.keys(await page.evaluate(() => window.__inlets)).sort(), ['phase', 'state']);
    await page.close();
  });

  await t.test('the header buttons fit inside the 820px device', async () => {
    const { page } = await open(browser);
    const right = await page.evaluate(() => document.getElementById('bar').getBoundingClientRect().right);
    assert.ok(right <= 816, 'button bar ends at ' + right);
    const next = page.getByRole('button', { name: '\u203a' });
    for (let i = 0; i < 16; i++) {
      await next.click();
      await page.evaluate(() => window.__gaaatrr.state()); // let the click settle
      const fits = await page.evaluate(() => {
        const pill = document.querySelector('.pill');
        return { text: pill.textContent, ok: pill.scrollWidth <= pill.clientWidth + 1 };
      });
      assert.ok(fits.ok, 'preset name fits: ' + fits.text);
    }
    const stillFits = await page.evaluate(() => document.getElementById('bar').getBoundingClientRect().right);
    assert.ok(stillFits <= 816);
    await page.close();
  });

  await t.test('clicking a step toggles it and tells Max', async () => {
    const { page } = await open(browser);
    const before = await page.evaluate(() => window.__gaaatrr.state().steps[1]); // default pattern: step 2 is off
    assert.equal(before, 0);
    const { x, y } = stepXY(1);
    await page.mouse.click(x, y);
    assert.equal(await page.evaluate(() => window.__gaaatrr.state().steps[1]), 100);
    assert.deepEqual((await page.evaluate(() => window.__sent)).at(-1), ['params', 's2', 100]);
    await page.mouse.click(x, y);
    assert.equal(await page.evaluate(() => window.__gaaatrr.state().steps[1]), 0);
    await page.close();
  });

  await t.test('dragging a step vertically sets its level', async () => {
    const { page } = await open(browser);
    const { x } = stepXY(1);
    await page.mouse.move(x, 120);
    await page.mouse.down();
    await page.mouse.move(x, 85, { steps: 6 });
    await page.mouse.up();
    const v = await page.evaluate(() => window.__gaaatrr.state().steps[1]);
    assert.ok(v > 40 && v < 60, 'about half height, got ' + v);
    await page.close();
  });

  await t.test('dragging across steps paints them', async () => {
    const { page } = await open(browser);
    const a = stepXY(1), b = stepXY(5);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, a.y, { steps: 12 });
    await page.mouse.up();
    const steps = await page.evaluate(() => window.__gaaatrr.state().steps);
    assert.deepEqual(steps.slice(1, 6), [100, 100, 100, 100, 100]);
    await page.close();
  });

  await t.test('dragging a knob changes the parameter, double-click resets it', async () => {
    const { page } = await open(browser);
    const k = knobXY(7); // DEPTH
    await page.mouse.move(k.x, k.y);
    await page.mouse.down();
    await page.mouse.move(k.x, k.y + 60, { steps: 6 }); // down = less
    await page.mouse.up();
    const depth = await page.evaluate(() => window.__gaaatrr.state().depth);
    assert.ok(depth < 80, 'depth dropped, got ' + depth);
    const last = (await page.evaluate(() => window.__sent)).at(-1);
    assert.equal(last[0], 'params');
    assert.equal(last[1], 'depth');
    await page.mouse.dblclick(k.x, k.y);
    assert.equal(await page.evaluate(() => window.__gaaatrr.state().depth), 100);
    await page.close();
  });

  await t.test('state from Max updates the UI without echoing back', async () => {
    const { page } = await open(browser);
    const before = (await page.evaluate(() => window.__sent)).length;
    await page.evaluate(() => window.__inlets.state('len', 8, 's1', 33, 'rate', 3));
    const s = await page.evaluate(() => window.__gaaatrr.state());
    assert.equal(s.len, 8);
    assert.equal(s.rate, 3);
    assert.equal(s.steps[0], 33);
    assert.equal((await page.evaluate(() => window.__sent)).length, before);
    await page.close();
  });

  await t.test('DICE, undo and presets', async () => {
    const { page } = await open(browser);
    const original = await page.evaluate(() => window.__gaaatrr.state());
    await page.getByRole('button', { name: 'DICE' }).click();
    const rolled = await page.evaluate(() => window.__gaaatrr.state());
    assert.notDeepEqual(rolled.steps, original.steps);
    assert.ok((await page.evaluate(() => window.__sent)).at(-1).length > 2, 'one params message with several pairs');
    await page.getByRole('button', { name: 'UNDO' }).click();
    assert.deepEqual(await page.evaluate(() => window.__gaaatrr.state()), original);

    await page.getByRole('button', { name: '›' }).click();
    assert.equal(await page.locator('.pill').textContent(), 'TRANCE TIGER');
    await page.getByRole('button', { name: '›' }).click();
    assert.equal(await page.locator('.pill').textContent(), 'OFFBEAT PUMA');
    assert.equal(await page.evaluate(() => window.__gaaatrr.state().len), 8);
    await page.getByRole('button', { name: 'CLR' }).click();
    assert.ok((await page.evaluate(() => window.__gaaatrr.state().steps)).slice(0, 8).every((v) => v === 0));
    await page.close();
  });

  await t.test('pattern buttons', async () => {
    const { page } = await open(browser);
    await page.evaluate(() => window.__inlets.state('s1', 100, 's2', 0, 's3', 0, 's4', 0, 'len', 4));
    await page.getByRole('button', { name: '▶' }).click();
    assert.deepEqual((await page.evaluate(() => window.__gaaatrr.state().steps)).slice(0, 4), [0, 100, 0, 0]);
    await page.getByRole('button', { name: 'INV' }).click();
    assert.deepEqual((await page.evaluate(() => window.__gaaatrr.state().steps)).slice(0, 4), [100, 0, 100, 100]);
    await page.getByRole('button', { name: 'EUCLID' }).click();
    assert.equal((await page.evaluate(() => window.__gaaatrr.state().steps)).slice(0, 4).filter((v) => v).length, 1);
    await page.close();
  });

  await t.test('canvas actually paints (not blank) in demo mode', async () => {
    const { page, errors } = await open(browser, '?phase=0.3');
    const painted = await page.evaluate(() => {
      const c = document.getElementById('c');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 120 || d[i + 1] > 120 || d[i + 2] > 120) lit++;
      return lit;
    });
    assert.ok(painted > 2000, 'bright pixels: ' + painted);
    assert.deepEqual(errors, []);
    await page.close();
  });
});
