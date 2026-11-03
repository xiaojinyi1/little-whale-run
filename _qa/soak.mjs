/* 5-minute continuous-run soak test: headless Chrome + CDP, qa invincibility. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '_qa', 'out');
const PORT = 4174;
const DEBUG_PORT = 9334;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DURATION_MS = 300_000;
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-soak-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows', '--hide-scrollbars',
  '--window-size=1280,800', 'about:blank',
], { stdio: 'ignore', windowsHide: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(fn, timeout = 20000, interval = 120) {
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
  return new Promise((resolve, reject) => { const id = ++browserSeq; browserPending.set(id, { resolve, reject }); browserWs.send(JSON.stringify({ id, method, params })); });
}
const { targetId } = await browserSend('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await browserSend('Target.attachToTarget', { targetId, flatten: true });
let seq = 0;
const pending = new Map();
const methodById = new Map();
const consoleErrors = [];
browserWs.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? reject(new Error(`${methodById.get(msg.id)} ${JSON.stringify(msg.error)}`)) : resolve(msg.result);
    return;
  }
  if (msg.sessionId !== sessionId) return;
  if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(['exception', msg.params.exceptionDetails?.text, msg.params.exceptionDetails?.exception?.description].filter(Boolean).join(' '));
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(msg.params.type)) consoleErrors.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
});
function call(method, params = {}) {
  const id = ++seq; methodById.set(id, method);
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); browserWs.send(JSON.stringify({ id, method, params, sessionId })); });
}
async function ev(expression) {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}
async function heap() {
  await call('HeapProfiler.collectGarbage').catch(() => {});
  const perf = await call('Performance.getMetrics');
  const values = Object.fromEntries(perf.metrics.map((m) => [m.name, m.value]));
  const dom = await call('Memory.getDOMCounters');
  return {
    jsHeapMB: Number((values.JSHeapUsedSize / 1048576).toFixed(2)),
    nodes: dom.nodes,
    documents: dom.documents,
    listeners: dom.jsEventListeners,
  };
}

await call('Page.enable');
await call('Runtime.enable');
await call('Performance.enable');
await call('HeapProfiler.enable').catch(() => {});
await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/?qa=1&soak=${Date.now()}` });
await poll(async () => (await call('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })).result.value === 'complete');
await poll(async () => (await call('Runtime.evaluate', { expression: '!!window.__whaleGame', returnByValue: true })).result.value === true);
await sleep(600);

await ev(`(() => {
  window.__soak = { start: performance.now(), last: 0, intervals: [] };
  const tick = (t) => {
    if (window.__soak.last) window.__soak.intervals.push(t - window.__soak.last);
    window.__soak.last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})()`);
await ev('__whaleGame.start(); __whaleGame.setInvincible(true); true');
const samples = [{ t: 0, ...(await heap()) }];
const snapshots = [];
const started = Date.now();
let nextSample = 30_000;
while (Date.now() - started < DURATION_MS) {
  await sleep(1000);
  const elapsed = Date.now() - started;
  if (elapsed >= nextSample) {
    samples.push({ t: Math.round(elapsed / 1000), ...(await heap()) });
    snapshots.push(await ev('__whaleGame.snapshot()'));
    nextSample += 30_000;
  }
}
const finalSnap = await ev('__whaleGame.snapshot()');
const timing = await ev(`(() => {
  const a = window.__soak.intervals.slice(1);
  const sorted = [...a].sort((x, y) => x - y);
  const avg = a.reduce((s, x) => s + x, 0) / a.length;
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return {
    frames: a.length,
    avgMs: Number(avg.toFixed(3)),
    p50: Number(p(0.5).toFixed(3)),
    p95: Number(p(0.95).toFixed(3)),
    p99: Number(p(0.99).toFixed(3)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(3)),
    over25ms: a.filter((x) => x > 25).length,
    over50ms: a.filter((x) => x > 50).length,
    minFpsWindow: Number((1000 / sorted[sorted.length - 1]).toFixed(1)),
  };
})()`);
const report = {
  durationSec: Math.round((Date.now() - started) / 1000),
  timing,
  heap: samples,
  heapStartMB: samples[0].jsHeapMB,
  heapEndMB: samples[samples.length - 1].jsHeapMB,
  heapDeltaMB: Number((samples[samples.length - 1].jsHeapMB - samples[0].jsHeapMB).toFixed(2)),
  nodeDelta: samples[samples.length - 1].nodes - samples[0].nodes,
  listenerDelta: samples[samples.length - 1].listeners - samples[0].listeners,
  final: { state: finalSnap.state, score: finalSnap.score, speed: finalSnap.speed, frames: finalSnap.frames, night: finalSnap.night, runTime: finalSnap.runTime },
  consoleErrors,
};
console.log(JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(OUT, 'soak.json'), JSON.stringify(report, null, 2));

browserWs.close(); server.close(); chrome.kill();
await sleep(500);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
