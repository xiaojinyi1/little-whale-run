// Remote-browser check for the public Vercel deployment via PhantomJsCloud.
// The API also supports GET with the request JSON in the query string; no local
// files or credentials are sent, only the public deployment URL and QA script.
import { writeFileSync } from 'node:fs';

const ENDPOINT = 'https://phantomjscloud.com/api/browser/v2/a-demo-key-with-low-quota-per-ip-address/';
const target = 'https://little-whale-run.vercel.app/';

const scenario = process.argv[2] || 'start';
const scripts = {
  start: `
    await page.goto('${target}', {waitUntil:'domcontentloaded'});
    await page.waitForDelay(1200);
    await page.keyboard.press('Space');
    await page.waitForDelay(1200);
    const s = await page.evaluate(() => window.__whaleGame.snapshot());
    await page.meta.log(s);
    await page.render.screenshot();
  `,
  death: `
    await page.goto('${target}', {waitUntil:'domcontentloaded'});
    await page.waitForDelay(1200);
    await page.keyboard.press('Space');
    await page.waitForDelay(5200);
    const s = await page.evaluate(() => window.__whaleGame.snapshot());
    await page.meta.log(s);
    await page.render.screenshot();
  `,
  restart: `
    await page.goto('${target}', {waitUntil:'domcontentloaded'});
    await page.waitForDelay(1200);
    await page.keyboard.press('Space');
    await page.waitForDelay(5200);
    const before = await page.evaluate(() => window.__whaleGame.snapshot());
    await page.meta.log({phase:'before-restart', state:before.state, score:before.score, best:before.best});
    await page.render.screenshot();
    await page.keyboard.press('Space');
    await page.waitForDelay(900);
    const after = await page.evaluate(() => window.__whaleGame.snapshot());
    await page.meta.log({phase:'after-restart', state:after.state, score:after.score, best:after.best, speed:after.speed, obstacles:after.obstacles});
    await page.render.screenshot();
  `,
};

if (!scripts[scenario]) throw new Error('unknown scenario: ' + scenario);

const request = {
  renderType: 'automation',
  renderSettings: { viewport: { width: 1200, height: 800 } },
  overseerScript: scripts[scenario].replace(/\s+/g, ' ').trim(),
};

const url = ENDPOINT + '?request=' + encodeURIComponent(JSON.stringify(request));
const res = await fetch(url, { method: 'GET' });
const text = await res.text();
writeFileSync(`_qa/out/pjc-${scenario}.json`, text);
console.log('HTTP', res.status, 'bytes', text.length);

let body;
try { body = JSON.parse(text); } catch { console.log(text.slice(0, 1200)); process.exit(1); }
console.log('errors:', JSON.stringify(body.errors ?? []));
for (const entry of body.logs ?? []) console.log('log:', JSON.stringify(entry.value));
(body.renders ?? []).forEach((render, i) => {
  if (render.encoding === 'base64' && render.data) {
    const file = `_qa/out/pjc-${scenario}${i ? '-' + i : ''}.png`;
    writeFileSync(file, Buffer.from(render.data, 'base64'));
    console.log('screenshot:', file);
  }
});
