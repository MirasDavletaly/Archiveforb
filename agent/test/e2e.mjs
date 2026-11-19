// End-to-end check of the built agent (the real CompanyFiles-Setup.exe, or the Linux binary via AGENT=...) against
// a throwaway Files server: pairing, folder structure, no overwrite, WebSocket push, catch-up after being off,
// disconnect from the website, unsafe paths from a hostile server, hidden mode.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const APP = process.env.APP_URL || 'file:///C:/Users/davle/OneDrive/Desktop/aifc/ArchiveForB/';
const { createApp } = await import(APP + 'server.mjs');
const { loadConfig } = await import(APP + 'src/config.mjs');
const { hashPassword } = await import(APP + 'src/auth.mjs');
const EXE = process.env.AGENT || 'C:/Users/davle/OneDrive/Desktop/aifc/ArchiveForB/downloads/CompanyFiles-Setup.exe';
const GUI = !process.env.AGENT; // the Windows build can also be tested in tray and hidden mode
const W = fs.mkdtempSync(path.join(process.env.WORK || os.tmpdir(), 'agent-e2e-'));
const CFG = path.join(W, 'config'), ROOT = path.join(W, 'Saved files');
const PORT = 8816;
const A = createApp({ ...loadConfig({ PORT: String(PORT), PUBLIC_URL: `http://127.0.0.1:${PORT}` }), dataDir: path.join(W, 'data') });
const server = http.createServer(A.handle);
server.on('upgrade', A.upgrade);
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const base = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
class Client {
  jar = '';
  async req(method, url, { json, raw } = {}) {
    const h = { 'x-requested-with': 'fetch', ...(this.jar ? { cookie: this.jar } : {}), ...(json ? { 'content-type': 'application/json' } : {}) };
    const r = await fetch(base + url, { method, headers: h, body: json ? JSON.stringify(json) : raw });
    const sc = r.headers.get('set-cookie');
    if (sc) this.jar = sc.split(';')[0];
    const d = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
    if (!r.ok) throw new Error(`${method} ${url} ${r.status} ${JSON.stringify(d)}`);
    return d;
  }
}
const PW = 'Demo-password-2026!';
A.db.run(`INSERT INTO users(login, name, pass, is_admin, must_change, created_at) VALUES('admin', 'IT', ?, 1, 0, ?)`, await hashPassword(PW), Date.now());
const admin = new Client();
await admin.req('POST', '/api/login', { json: { login: 'admin', password: PW } });
const u = await admin.req('POST', '/api/admin/users', { json: { login: 'p.owner', name: 'Pavel Owner' } });
const U = new Client();
await U.req('POST', '/api/login', { json: { login: 'p.owner', password: u.password } });
await U.req('POST', '/api/password', { json: { current: u.password, next: PW } });
const home = (await U.req('GET', '/api/spaces')).find(s => s.area === 'personal').id;
const upload = async (folder, name, text) => (await U.req('PUT', `/api/nodes/${folder}/files?name=${encodeURIComponent(name)}`, { raw: Buffer.from(text) })).id;
const send = ids => U.req('POST', '/api/devices/send', { json: { ids } });

const results = [];
const expect = (label, ok) => { results.push(`${ok ? 'ok  ' : 'FAIL'} ${label}`); };
const agent = (...args) => run(EXE, ['--config', CFG, ...args], { timeout: 60000, windowsHide: true }).then(r => ({ code: 0, out: r.stdout + r.stderr }), e => ({ code: e.code, out: (e.stdout || '') + (e.stderr || '') + e.message }));
const read = p => (fs.existsSync(path.join(ROOT, p)) ? fs.readFileSync(path.join(ROOT, p), 'utf8') : null);
const waitFile = async (p, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (read(p) != null) return true; await sleep(200); } return false; };
const cfgNow = () => JSON.parse(fs.readFileSync(path.join(CFG, 'agent.json'), 'utf8'));
const ipcQuit = async () => {
  const f = JSON.parse(fs.readFileSync(path.join(CFG, 'ipc.json'), 'utf8'));
  await fetch(`http://127.0.0.1:${f.port}/ipc`, { method: 'POST', headers: { 'x-secret': f.secret }, body: JSON.stringify({ quit: true }) }).catch(() => {});
};
let bg = null;
const startBg = (...args) => { bg = spawn(EXE, ['--config', CFG, ...args], { stdio: 'ignore', windowsHide: true }); return bg; };
const alive = p => p && p.exitCode === null;

try {
  // 1. pairing with a code from the website
  const code = (await U.req('POST', '/api/devices/pair-code')).code;
  const p = await agent('pair', code, '--server', base, '--folder', ROOT, '--yes');
  expect(`pair: "${p.out.trim().split('\n').pop()}"`, p.code === 0 && /Connected as Pavel Owner/.test(p.out));
  const devices = await U.req('GET', '/api/devices');
  expect(`the website lists the computer (${devices.map(d => d.name + '/' + d.os).join(', ')})`, devices.length === 1);
  expect('the token is kept only in the config file', !!cfgNow().token && (await agent('pair', code, '--server', base, '--yes')).code !== 0);

  // 2. a folder with subfolders and a loose file, saved with the structure
  const docs = (await U.req('POST', `/api/nodes/${home}/folders`, { json: { name: 'Docs' } })).id;
  const sub = (await U.req('POST', `/api/nodes/${docs}/folders`, { json: { name: 'Sub folder' } })).id;
  await upload(docs, 'a.txt', 'alpha');
  await upload(sub, 'b.txt', 'beta');
  await upload(sub, 'Отчёт 2026.txt', 'кириллица');
  const top = await upload(home, 'top.txt', 'v1');
  await send([docs, top]);
  const s1 = await agent('sync', '--once');
  expect('sync --once', s1.code === 0);
  expect('structure kept: Docs/a.txt, Docs/Sub folder/b.txt, Cyrillic names, top.txt', read('Docs/a.txt') === 'alpha' && read('Docs/Sub folder/b.txt') === 'beta' && read('Docs/Sub folder/Отчёт 2026.txt') === 'кириллица' && read('top.txt') === 'v1');
  expect('no temporary files left', !fs.readdirSync(ROOT, { recursive: true }).some(f => String(f).includes('.part')));

  // 3. the same name again: nothing is overwritten
  await upload(home, 'top.txt', 'v2');
  await send([top]);
  await agent('sync', '--once');
  expect('same name: "top (1).txt" next to the untouched original', read('top.txt') === 'v1' && read('top (1).txt') === 'v2');

  // 4. running in the background: the WebSocket brings new files at once
  startBg('--headless');
  await sleep(1500);
  const live = await upload(home, 'live.txt', 'pushed');
  const t0 = Date.now();
  await send([live]);
  expect(`WebSocket push: saved ${((Date.now() - t0) / 1000).toFixed(1)} s after sending`, await waitFile('live.txt', 5000));
  expect('the website shows it online', (await U.req('GET', '/api/devices'))[0].online === true);

  // 5. off while files are sent: they arrive when it starts again
  await ipcQuit();
  await sleep(800);
  expect('quits on request', !alive(bg));
  const off1 = await upload(home, 'while-off-1.txt', 'one');
  const off2 = await upload(docs, 'while-off-2.txt', 'two');
  await send([off1, off2]);
  startBg('--headless');
  expect('catch-up after being off: both files arrive on start', (await waitFile('while-off-1.txt')) && (await waitFile('while-off-2.txt')));

  // 6. disconnected on the website: the agent drops its token at once
  await U.req('DELETE', `/api/devices/${(await U.req('GET', '/api/devices'))[0].id}`);
  let dropped = false;
  for (let i = 0; i < 50 && !dropped; i++) { await sleep(200); dropped = !cfgNow().token; }
  expect('disconnect on the website: the agent forgets its token', dropped);
  await ipcQuit();
  await sleep(500);
  if (alive(bg)) bg.kill();

  // 7. a hostile server sends paths that try to leave the folder
  const got = [];
  const fake = http.createServer((req, res) => {
    const items = [['../evil.txt'], ['a/../../evil2.txt'], ['C:/Windows/evil3.txt'], ['..\\evil4.txt'], ['/etc/evil5'], ['ok/../../../evil6'], ['con.txt'], ['ok/fine.txt'], ['nul'], ['trail. /x.txt']]
      .map(([p], i) => ({ id: i + 1, path: p, size: 4, modified: 0 }));
    if (req.url === '/api/agent/queue') return res.end(JSON.stringify(items));
    const m = /^\/api\/agent\/files\/(\d+)(\/done)?$/.exec(req.url);
    if (m && m[2]) { let b = ''; req.on('data', d => (b += d)); req.on('end', () => { got.push([items[m[1] - 1].path, JSON.parse(b).result]); res.writeHead(204); res.end(); }); return; }
    if (m) return res.end('data');
    res.writeHead(404); res.end('{}');
  });
  await new Promise(r => fake.listen(8817, '127.0.0.1', r));
  const evilRoot = path.join(W, 'evil', 'root');
  fs.mkdirSync(evilRoot, { recursive: true });
  const cfg2 = path.join(W, 'config-evil');
  fs.mkdirSync(cfg2);
  fs.writeFileSync(path.join(cfg2, 'agent.json'), JSON.stringify({ server: 'http://127.0.0.1:8817', token: 'x'.repeat(43), user: 'test', folder: evilRoot, autostart: false, initialized: true }));
  await run(EXE, ['--config', cfg2, 'sync', '--once'], { timeout: 30000, windowsHide: true }).catch(() => {});
  fake.close();
  const outside = fs.readdirSync(path.join(W, 'evil')).filter(f => f !== 'root');
  const inside = fs.readdirSync(evilRoot, { recursive: true }).map(String).sort();
  expect(`unsafe paths: nothing written outside the folder (${outside.join(',') || 'nothing'})`, outside.length === 0 && !fs.existsSync(path.join(W, 'evil.txt')));
  expect(`refused ones reported as skipped (${got.filter(g => g[1] === 'skipped').map(g => g[0]).join(' | ')})`, got.filter(g => g[1] === 'skipped').length >= 6);
  expect(`safe ones saved, device names neutralised (${inside.join(', ')})`, inside.includes(path.join('ok', 'fine.txt')) && inside.includes('_con.txt'));

  // 8. hidden mode (Windows build): runs without a tray icon and keeps saving
  if (GUI) {
    const code2 = (await U.req('POST', '/api/devices/pair-code')).code;
    await agent('pair', code2, '--server', base, '--yes');
    fs.writeFileSync(path.join(CFG, 'agent.json'), JSON.stringify({ ...cfgNow(), hidden: true, initialized: true }));
    startBg('--background');
    await sleep(2000);
    const hid = await upload(home, 'hidden.txt', 'quiet');
    await send([hid]);
    expect('hidden mode: running, no tray, still saves', alive(bg) && (await waitFile('hidden.txt')));
    await ipcQuit();
    await sleep(800);
    // tray mode: starts with its icon and quits from the menu's Quit path (IPC here)
    fs.writeFileSync(path.join(CFG, 'agent.json'), JSON.stringify({ ...cfgNow(), hidden: false }));
    startBg('--background');
    await sleep(2500);
    const trayUp = alive(bg) && fs.existsSync(path.join(CFG, 'ipc.json'));
    await ipcQuit();
    await sleep(1000);
    expect('tray mode: starts and quits cleanly', trayUp && !alive(bg));
  }
  const log = fs.readFileSync(path.join(CFG, 'agent.log'), 'utf8');
  expect('the token never appears in the log', !log.includes(cfgNow().token || 'no-token-now'));
} catch (e) {
  results.push('FAIL ' + e.stack);
} finally {
  if (alive(bg)) bg.kill();
  console.log(results.join('\n'));
  const failed = results.some(r => r.startsWith('FAIL'));
  console.log(failed ? 'SOME FAILED' : 'ALL OK');
  server.close();
  process.exit(failed ? 1 : 0);
}
