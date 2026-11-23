// Two people editing one document at the same time in the browser, like Word or Excel online: both open it in the
// editor (Collabora Online, the same version as on the NAS, in Docker), each types, and they work in one shared
// session: the saved file has both people's text. Runs in CI (test job office-coedit) with Chrome headless.
//   Collabora at http://localhost:9980 with aliasgroup1=http://host.docker.internal:8850
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
const ROOT = new URL('..', import.meta.url).href;
const { createApp } = await import(ROOT + 'server.mjs');
const { loadConfig } = await import(ROOT + 'src/config.mjs');
const { hashPassword } = await import(ROOT + 'src/auth.mjs');
const OFFICE = 'http://localhost:9980', PORT = 8850, base = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const expect = (label, ok) => { const l = `${ok ? 'ok  ' : 'FAIL'} ${label}`; results.push(l); console.log(l); };
const until = async (fn, ms = 60000, step = 500) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); } return null; };

// Collabora converts for us: the starting document (text -> docx) and the saved one back to text, to read it.
async function convert(buf, name, to) {
  const fd = new FormData();
  fd.append('data', new Blob([buf]), name);
  const r = await fetch(`${OFFICE}/cool/convert-to/${to}`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`convert-to ${to}: ${r.status} ${await r.text()}`);
  return Buffer.from(await r.arrayBuffer());
}

expect('the editor is up', !!(await until(async () => (await fetch(`${OFFICE}/hosting/discovery`)).ok, 180000, 2000)));
const W = fs.mkdtempSync(path.join(process.env.WORK || os.tmpdir(), 'coedit-'));
const A = createApp({ ...loadConfig({ PORT: String(PORT), PUBLIC_URL: base, OFFICE_URL: OFFICE, WOPI_URL: `http://host.docker.internal:${PORT}` }), dataDir: path.join(W, 'data') });
const server = http.createServer(A.handle);
await new Promise(r => server.listen(PORT, '0.0.0.0', r)); // Collabora (in Docker) calls the WOPI routes here

class Client {
  jar = '';
  async req(method, url, { json, raw } = {}) {
    const h = { 'x-requested-with': 'fetch', ...(this.jar ? { cookie: this.jar } : {}), ...(json ? { 'content-type': 'application/json' } : {}) };
    const r = await fetch(base + url, { method, headers: h, body: json ? JSON.stringify(json) : raw });
    const sc = r.headers.get('set-cookie');
    if (sc) this.jar = sc.split(';')[0];
    const d = (r.headers.get('content-type') || '').includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
    if (!r.ok) throw new Error(`${method} ${url} ${r.status} ${JSON.stringify(d)}`);
    return d;
  }
}
const PW = 'Demo-password-2026!';
A.db.run(`INSERT INTO users(login, name, pass, is_admin, must_change, created_at) VALUES('admin', 'IT', ?, 1, 0, ?)`, await hashPassword(PW), Date.now());
const admin = new Client();
await admin.req('POST', '/api/login', { json: { login: 'admin', password: PW } });
async function person(login, name) {
  const u = await admin.req('POST', '/api/admin/users', { json: { login, name } });
  const c = new Client();
  await c.req('POST', '/api/login', { json: { login, password: u.password } });
  await c.req('POST', '/api/password', { json: { current: u.password, next: PW } });
  return Object.assign(c, { id: u.id, login });
}
const aida = await person('a.aida', 'Aida'), bolat = await person('b.bolat', 'Bolat');
const home = (await aida.req('GET', '/api/spaces')).find(s => s.area === 'personal').id;
const folder = (await aida.req('POST', `/api/nodes/${home}/folders`, { json: { name: 'Team' } })).id;
await aida.req('PUT', `/api/nodes/${folder}/access`, { json: { entries: [{ type: 'user', id: bolat.id, level: 2 }] } }); // Bolat may edit
const docx = await convert(Buffer.from('Shared notes.\n'), 'notes.txt', 'docx');
const doc = (await aida.req('PUT', `/api/nodes/${folder}/files?name=Notes.docx`, { raw: docx })).id;
const startedAt = (await aida.req('GET', `/api/nodes/${doc}`)).node.updated_at;

// ---- Chrome with two separate profiles (two people on two computers) ----
const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--remote-debugging-port=9339', `--user-data-dir=${path.join(W, 'chrome')}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const version = await until(async () => (await fetch('http://127.0.0.1:9339/json/version')).json(), 30000);
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let mid = 0;
const pending = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}, sessionId) => new Promise(r => { const i = ++mid; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
async function tab() {
  const { result: { browserContextId } } = await send('Target.createBrowserContext');
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = {
    send: (m, p) => send(m, p, sessionId),
    eval: async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'error'); return r.result?.result?.value; },
  };
  await s.send('Page.enable');
  await s.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  return s;
}
// Signs in on the website and opens the document in the editor, the way the site does it (a form posted with the token).
async function open(s, who) {
  await s.send('Page.navigate', { url: base + '/' });
  await sleep(1500);
  await s.eval(`fetch('/api/login', { method: 'POST', headers: { 'x-requested-with': 'fetch', 'content-type': 'application/json' }, body: JSON.stringify({ login: ${JSON.stringify(who.login)}, password: ${JSON.stringify(PW)} }) }).then(r => r.status)`);
  await s.eval(`fetch('/api/nodes/${doc}/editor', { method: 'POST', headers: { 'x-requested-with': 'fetch' } }).then(r => r.json()).then(e => {
    const f = document.createElement('form'); f.method = 'post'; f.action = e.url;
    for (const [k, v] of [['access_token', e.token], ['access_token_ttl', String(e.ttl)]]) { const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; f.append(i); }
    document.body.append(f); f.submit(); return e.edit; })`);
  return !!(await until(() => s.eval(`!!(window.app && app.map && app.map._docLayer && document.querySelector('canvas'))`), 120000, 1000));
}
const views = s => s.eval(`Object.keys((window.app && app.map && app.map._viewInfo) || {}).length`).catch(() => -1);
async function type(s, text) {
  const box = await s.eval(`(() => { const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0]; const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 3, 200) }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await s.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(800);
  await s.send('Input.insertText', { text });
}

let failed = false;
try {
  const pa = await tab(), pb = await tab();
  expect('Aida opens the document in the editor', await open(pa, aida));
  expect('Bolat opens the same document at the same time', await open(pb, bolat));
  await sleep(4000);
  const seen = await until(async () => (await views(pb)) >= 2 && (await views(pa)) >= 2, 30000);
  expect(`both are in one shared editing session (people each sees: ${await views(pa)} and ${await views(pb)})`, !!seen);
  await type(pa, ' Aida was here.');
  await sleep(1500);
  await type(pb, ' Bolat too.');
  await sleep(3000);
  await pa.eval(`app.map.sendUnoCommand('.uno:Save')`);
  const saved = await until(async () => (await aida.req('GET', `/api/nodes/${doc}`)).node.updated_at > startedAt, 60000, 1000);
  expect('the document is saved to the website', !!saved);
  const text = (await convert(await aida.req('GET', `/api/nodes/${doc}/content`), 'Notes.docx', 'txt')).toString('utf8');
  expect(`the saved file has both people's text: ${JSON.stringify(text.trim())}`, text.includes('Aida was here.') && text.includes('Bolat too.') && text.includes('Shared notes.'));
  const versions = await aida.req('GET', `/api/nodes/${doc}/versions`);
  expect(`the version from before the editing is kept (${versions.length})`, versions.length >= 1);
} catch (e) {
  expect(e.stack, false);
} finally {
  failed = results.some(r => r.startsWith('FAIL'));
  console.log(failed ? 'SOME FAILED' : 'ALL OK');
  chrome.kill();
  server.close();
  process.exit(failed ? 1 : 0);
}
