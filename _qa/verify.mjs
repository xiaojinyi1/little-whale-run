/* Local acceptance harness: static server + headless Chrome over CDP. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '_qa', 'out');
const PORT = 4173;
const DEBUG_PORT = 9333;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows', '--hide-scrollbars',
  '--window-size=1280,800', 'about:blank',
], { stdio: 'ignore', windowsHide: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(fn, timeout = 15000, interval = 120) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(interval);
  }
  throw new Error('poll timeout');
}

const version = await poll(async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).ok && (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json());
const browserWs = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => browserWs.addEventListener('open', r, { once: true }));
let browserSeq = 0;
const browserPending = new Map();
browserWs.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && browserPending.has(msg.id)) { const { resolve, reject } = browserPending.get(msg.id); browserPending.delete(msg.id); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); }
});
function browserSend(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++browserSeq; browserPending.set(id, { resolve, reject });
    browserWs.send(JSON.stringify({ id, method, params }));
  });
}
const { targetId } = await browserSend('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await browserSend('Target.attachToTarget', { targetId, flatten: true });
let seq = 0;
const pending = new Map();
const events = [];
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    browserWs.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
const consoleErrors = [];
const requests = [];
browserWs.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(`${methodOf(msg.id)} ${JSON.stringify(msg.error)}`)) : resolve(msg.result); return; }
  if (msg.sessionId !== sessionId) return;
  if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(['exception', msg.params.exceptionDetails?.text, msg.params.exceptionDetails?.exception?.description].filter(Boolean).join(' '));
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(msg.params.type)) consoleErrors.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') consoleErrors.push(`log: ${msg.params.entry.text}`);
  if (msg.method === 'Network.requestWillBeSent') requests.push(msg.params.request.url);
  if (msg.method === 'Page.frameNavigated') events.push(msg.params.frame.url);
});
const methodById = new Map();
const originalSend = send;
function methodOf(id) { return methodById.get(id); }
async function call(method, params = {}) { const id = ++seq; methodById.set(id, method); return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); browserWs.send(JSON.stringify({ id, method, params, sessionId })); }); }

await call('Page.enable');
await call('Runtime.enable');
await call('Log.enable');
await call('Network.enable');
await call('Performance.enable');
await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/?qa=1&t=${Date.now()}` });
await poll(async () => (await call('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })).result.value === 'complete');
await poll(async () => (await call('Runtime.evaluate', { expression: '!!window.__whaleGame', returnByValue: true })).result.value === true);
await sleep(800);

const results = {};
async function ev(expression) {
  const out = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.text + ' ' + (out.exceptionDetails.exception?.description || ''));
  return out.result.value;
}
async function snap() { return ev('window.__whaleGame.snapshot()'); }
async function screenshot(name) {
  const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(shot.data, 'base64'));
}
const keyDefs = { Space: { key: ' ', code: 'Space', vk: 32 }, ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 }, ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 }, KeyP: { key: 'p', code: 'KeyP', vk: 80 } };
async function key(type, name) {
  const d = keyDefs[name];
  await call('Input.dispatchKeyEvent', { type, key: d.key, code: d.code, windowsVirtualKeyCode: d.vk, nativeVirtualKeyCode: d.vk });
}
async function tapKey(name, hold = 50) { await key('keyDown', name); await sleep(hold); await key('keyUp', name); }
async function waitState(state, timeout = 7000) { return poll(async () => (await snap()).state === state, timeout, 80); }
async function touch(type, points) { await call('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i, radiusX: 1, radiusY: 1, force: 1 })) }); }

// ---- Ready state and basic frame pacing ----
const s0 = await snap();
const fA = s0.frames, tA = Date.now();
await sleep(1000);
const s0b = await snap();
results.ready = { state: s0.state, framesPerSecond: Number(((s0b.frames - fA) * 1000 / (Date.now() - tA)).toFixed(1)), snapshot: s0 };
await screenshot('01-desktop-ready.png');

// ---- Long jump vs short tap jump (start explicitly so the sample is deterministic) ----
await ev('__whaleGame.start()');
await sleep(120);
await key('keyDown', 'Space');
await sleep(300);
const sJump = await snap();
await screenshot('02-desktop-jump.png');
await key('keyUp', 'Space');
await sleep(900);
const sLand = await snap();
await tapKey('Space', 55);
await sleep(260);
const sShort = await snap();
results.jump = {
  state: sJump.state,
  longY: sJump.player.y,
  longHeight: 416 - sJump.player.y,
  shortY: sShort.player.y,
  shortHeight: 416 - sShort.player.y,
  landedBeforeShort: sLand.player.onGround,
  longHigher: sJump.player.y < sShort.player.y,
};
await sleep(700);

// ---- Alternate inputs: ArrowUp and mouse click ----
await ev('__whaleGame.start()');
await sleep(120);
await key('keyDown', 'ArrowUp');
await sleep(240);
const sUp = await snap();
await key('keyUp', 'ArrowUp');
await ev('__whaleGame.start()');
await sleep(120);
const clickAt = await ev('({ x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) })');
const mouse = { x: clickAt.x, y: clickAt.y, button: 'left', buttons: 1, clickCount: 1 };
await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...mouse });
await sleep(240);
const sClick = await snap();
await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mouse, buttons: 0 });
results.altInput = {
  arrowUpJumped: sUp.player.y < 416,
  arrowUpY: sUp.player.y,
  mouseClickJumped: sClick.player.y < 416,
  mouseClickY: sClick.player.y,
};
await sleep(700);

// ---- Pause / resume, blur auto-pause, preventDefault ----
await ev('__whaleGame.start()');
await sleep(250);
await tapKey('KeyP');
await sleep(150);
const p1 = await snap();
await sleep(450);
const p2 = await snap();
await screenshot('03-desktop-paused.png');
const pausedRunTime = p2.runTime === p1.runTime;
await ev("window.dispatchEvent(new Event('blur'))");
await sleep(120);
const blurWhilePaused = await snap();
await tapKey('KeyP');
await sleep(160);
await ev("window.dispatchEvent(new Event('blur'))");
await sleep(160);
const blurAutoPaused = await snap();
await tapKey('KeyP');
await sleep(160);
await ev(`window.__spacePrevented = null; window.addEventListener('keydown', (e) => { if (e.code === 'Space') window.__spacePrevented = e.defaultPrevented; });`);
await tapKey('Space');
await sleep(80);
const prevented = await ev('window.__spacePrevented');
results.pause = { paused: p1.paused, runTimeFrozen: pausedRunTime, blurWhilePaused: blurWhilePaused.paused, blurAutoPaused: blurAutoPaused.paused, resumed: !(await snap()).paused };
results.keyboard = { spaceDefaultPrevented: prevented === true };

// ---- Isolated duck ----
await ev('__whaleGame.start()');
await ev('__whaleGame.clear()');
await key('keyDown', 'ArrowDown');
await sleep(360);
const sDuck = await snap();
await screenshot('04-desktop-duck.png');
await key('keyUp', 'ArrowDown');
results.duck = { duck: sDuck.player.duck, height: sDuck.player.rect.h, state: sDuck.state };

// ---- Overhang can be passed by ducking ----
await ev('__whaleGame.start()');
await ev('__whaleGame.clear()');
await ev('__whaleGame.spawn("overhang-single", 650)');
await key('keyDown', 'ArrowDown');
await sleep(1150);
await screenshot('05-desktop-overhang-duck.png');
const sDuckPass = await snap();
await sleep(800);
const sDuckAfter = await snap();
await key('keyUp', 'ArrowDown');
results.overhangDuckPass = { midState: sDuckPass.state, afterState: sDuckAfter.state, duck: sDuckPass.player.duck, obstacleIds: sDuckAfter.obstacleIds, score: sDuckAfter.score };

// ---- Rock can be cleared by jumping ----
await ev('__whaleGame.start()');
await ev('__whaleGame.clear()');
await ev('__whaleGame.spawn("rock-double", 640)');
await sleep(900);
await key('keyDown', 'Space');
await sleep(300);
const sRockJump = await snap();
await screenshot('06-desktop-rock-jump.png');
await key('keyUp', 'Space');
await sleep(1000);
const sRockAfter = await snap();
results.rockJumpPass = { state: sRockAfter.state, y: sRockJump.player.y, obstacleIds: sRockAfter.obstacleIds };

// ---- Overhang cannot be cleared by jumping: expect game over ----
await ev('__whaleGame.start()');
await ev('__whaleGame.clear()');
await ev('__whaleGame.spawn("overhang-single", 700)');
await sleep(800);
await key('keyDown', 'Space');
await sleep(300);
await key('keyUp', 'Space');
try {
  await waitState('gameover', 3000);
} catch (error) {
  console.error('OVERHANG WAIT FAILED', JSON.stringify(await snap()), JSON.stringify(consoleErrors, null, 2));
  throw error;
}
await sleep(750);
const sOverJump = await snap();
await screenshot('07-desktop-gameover-overhang.png');
const restartTextVisible = await ev(`(() => { const c = document.getElementById('game'); const g = c.getContext('2d'); return c.width > 0 && c.height > 0; })()`);
results.jumpIntoOverhangGameOver = { state: sOverJump.state, score: sOverJump.score, best: sOverJump.best, canvasAlive: restartTextVisible };

// ---- Restart resets run state ----
await sleep(600);
await tapKey('Space');
await sleep(350);
const sRestart = await snap();
results.restart = { state: sRestart.state, score: sRestart.score, speed: sRestart.speed, frames: sRestart.frames, obstacles: sRestart.obstacles };
await screenshot('08-desktop-restart.png');

// ---- Night palette + transition ----
await ev('__whaleGame.clear()');
await ev('__whaleGame.setScore(520)');
await sleep(1000);
const sNight = await snap();
await screenshot('09-desktop-night.png');
await ev('__whaleGame.setScore(0)');
await ev('__whaleGame.clear()');
await sleep(900);
const sDay = await snap();
results.theme = { night: sNight.night, day: sDay.night, scoreAtNight: 520 };

// ---- localStorage best persisted across reload ----
const storedBefore = await ev(`localStorage.getItem('little-whale-run.best.v1')`);
await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/?qa=1&reload=${Date.now()}` });
await poll(async () => (await call('Runtime.evaluate', { expression: '!!window.__whaleGame', returnByValue: true })).result.value === true);
await sleep(500);
const sReload = await snap();
results.persistence = { stored: storedBefore, bestAfterReload: sReload.best };

// ---- Mobile layout + touch start + swipe down ----
await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/?qa=1&mobile=${Date.now()}` });
await poll(async () => (await call('Runtime.evaluate', { expression: '!!window.__whaleGame', returnByValue: true })).result.value === true);
await sleep(700);
const sMobile = await snap();
const layout = await ev(`(() => { const c = document.getElementById('game').getBoundingClientRect(); return { innerWidth, innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, canvas: {x:c.x,y:c.y,w:c.width,h:c.height}, backing: [document.getElementById('game').width, document.getElementById('game').height], dpr: devicePixelRatio }; })()`);
await screenshot('10-mobile-ready.png');
await touch('touchStart', [[195, 620]]);
await sleep(70);
await touch('touchEnd', []);
await sleep(250);
const sMobileTap = await snap();
await screenshot('11-mobile-tap.png');

// 触屏上滑：从海面位置向上滑，必须起跳。
await ev('__whaleGame.start()');
await sleep(200);
await touch('touchStart', [[195, 540]]);
await sleep(40);
await touch('touchMove', [[195, 440]]);
await sleep(40);
await touch('touchMove', [[195, 360]]);
await sleep(40);
await touch('touchEnd', []);
await sleep(250);
const sMobileSwipeUp = await snap();
await screenshot('11b-mobile-swipe-up.png');

// 触屏下滑：从高处向下滑，必须下潜。
await ev('__whaleGame.start()');
await sleep(200);
await touch('touchStart', [[195, 360]]);
await sleep(40);
await touch('touchMove', [[195, 440]]);
await sleep(40);
await touch('touchMove', [[195, 540]]);
await sleep(40);
await touch('touchEnd', []);
await sleep(280);
const sMobileDuck = await snap();
await screenshot('12-mobile-swipe-down.png');
results.mobile = {
  layout,
  stateAfterTap: sMobileTap.state,
  jumpYAfterTap: sMobileTap.player.y,
  swipeUpJumped: sMobileSwipeUp.player.y < 416,
  swipeUpY: sMobileSwipeUp.player.y,
  duckAfterSwipe: sMobileDuck.player.duck,
  stateAfterSwipe: sMobileDuck.state,
};

// ---- Mobile landscape ----
await call('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } });
await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/?qa=1&landscape=${Date.now()}` });
await poll(async () => (await call('Runtime.evaluate', { expression: '!!window.__whaleGame', returnByValue: true })).result.value === true);
await sleep(700);
const landscapeLayout = await ev(`(() => { const c = document.getElementById('game').getBoundingClientRect(); return { innerWidth, innerHeight, scrollWidth: document.documentElement.scrollWidth, canvas: {x:c.x,y:c.y,w:c.width,h:c.height}, backing: [document.getElementById('game').width, document.getElementById('game').height], dpr: devicePixelRatio }; })()`);
await screenshot('13-mobile-landscape-ready.png');
await touch('touchStart', [[422, 250]]);
await sleep(70);
await touch('touchEnd', []);
await sleep(250);
const sLandscapeTap = await snap();
await screenshot('14-mobile-landscape-play.png');
results.mobileLandscape = { layout: landscapeLayout, stateAfterTap: sLandscapeTap.state, jumpYAfterTap: sLandscapeTap.player.y };

// ---- External requests + console errors ----
results.network = { hosts: [...new Set(requests.map((u) => { try { return new URL(u).host; } catch { return u; } }))], total: requests.length };
results.consoleErrors = consoleErrors;
results.screenshots = fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).sort();

console.log(JSON.stringify(results, null, 2));
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2));

await call('Emulation.clearDeviceMetricsOverride').catch(() => {});
browserWs.close(); server.close();
chrome.kill();
await sleep(500);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
