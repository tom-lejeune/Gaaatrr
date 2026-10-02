#!/usr/bin/env node
/* Renders the UI in headless Chromium and writes docs/*.png. Needs Playwright:
 *   npm i --no-save playwright   (or have it installed globally; set CHROMIUM_PATH if needed)
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
execFileSync(process.execPath, [path.join(root, 'scripts/build.js')], { stdio: 'inherit' });
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });

const shots = [
  { file: 'gaaatrr.png', presets: 1, phase: 0.31 },
  { file: 'gaaatrr-wobble.png', presets: 13, phase: 0.62 },
];

(async () => {
  const exe = ['/opt/pw-browsers/chromium', process.env.CHROMIUM_PATH].find((p) => p && fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  for (const shot of shots) {
    const page = await browser.newPage({ viewport: { width: 820, height: 169 }, deviceScaleFactor: 2 });
    await page.goto('file://' + path.join(root, 'device/gaaatrr-ui.html') + '?phase=' + shot.phase);
    for (let i = 0; i < shot.presets; i++) await page.getByRole('button', { name: '›' }).click();
    await page.mouse.move(2, 2);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(root, 'docs', shot.file) });
    console.log('wrote docs/' + shot.file);
    await page.close();
  }
  await browser.close();
})();
