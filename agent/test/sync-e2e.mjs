// End-to-end check of the two-way My files sync with the built agent (Windows exe, or AGENT=... on Linux):
// website → computer (new, changed, renamed, moved, deleted to the trash, older files left alone) and
// computer → website (new file and folder, edit = new version, delete = website trash, conflict keeps both,
// Office temp files ignored, a vanished folder deletes nothing).
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
const WIN = process.platform === 'win32';
const W = fs.mkdtempSync(path.join(process.env.WORK || os.tmpdir(), 'agent-sync-'));
const CFG = path.join(W, 'config'), ROOT = path.join(W, 'Saved'), MY = path.join(ROOT, 'My files');
const PORT = 8821;
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
    const d = (r.headers.get('content-type') || '').includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
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
const kids = async id => (await U.req('GET', `/api/nodes/${id}`)).children;
const child = async (id, name) => (await kids(id)).find(x => x.name === name);
const content = async id => (await U.req('GET', `/api/nodes/${id}/content`)).toString();
const results = [];
const expect = (label, ok) => results.push(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
const read = rel => (fs.existsSync(path.join(MY, rel)) ? fs.readFileSync(path.join(MY, rel), 'utf8') : null);
const until = async (fn, ms = 25000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch {} await sleep(300); } return false; };
const agentCmd = (...args) => run(EXE, ['--config', CFG, ...args], { timeout: 60000, windowsHide: true }).catch(e => e);
let bg = null;
const start = () => { bg = spawn(EXE, ['--config', CFG, '--headless'], { stdio: 'ignore', windowsHide: true }); };
const quit = async () => {
  try {
    const f = JSON.parse(fs.readFileSync(path.join(CFG, 'ipc.json'), 'utf8'));
    await fetch(`http://127.0.0.1:${f.port}/ipc`, { method: 'POST', headers: { 'x-secret': f.secret }, body: JSON.stringify({ quit: true }) });
  } catch {}
  await sleep(800);
  if (bg?.exitCode === null) bg.kill();
};
const inTrash = async name => {
  if (WIN) {
    const r = await run('powershell', ['-NoProfile', '-Command', `$rb = (New-Object -ComObject Shell.Application).Namespace(10); @($rb.Items() | Where-Object { $rb.GetDetailsOf($_, 1) -like '${W.replace(/'/g, "''")}*' } | ForEach-Object { $_.Name }) -join '|'`]);
    return r.stdout.split('|').map(s => s.trim()).includes(name);
  }
  if (process.platform === 'darwin') {
    try {
      if (fs.readdirSync(path.join(os.homedir(), '.Trash')).some(f => f.startsWith(path.parse(name).name))) return true;
    } catch {} // listing ~/.Trash can need Full Disk Access; then the agent's log tells where the file went
    return fs.readFileSync(path.join(CFG, 'agent.log'), 'utf8').includes(`moved to the trash: Archive/${name}`);
  }
  return fs.existsSync(path.join(os.homedir(), '.local/share/Trash/files', name));
};

try {
  const before = await upload(home, 'older.txt', 'was there before');
  await sleep(50);
  const code = (await U.req('POST', '/api/devices/pair-code')).code;
  await agentCmd('pair', code, '--server', base, '--folder', ROOT, '--yes');
  start();

  // ---- website → computer ----
  const s1 = await upload(home, 'Report.txt', 'v1 from the website');
  expect('new file on the website appears in My files', await until(() => read('Report.txt') === 'v1 from the website'));
  expect('a file that was there before connecting is not copied', read('older.txt') === null);
  await upload(home, 'Report.txt', 'v2 from the website');
  expect('changed on the website: the copy is replaced (no "(1)")', await until(() => read('Report.txt') === 'v2 from the website') && read('Report (1).txt') === null);
  await U.req('PATCH', `/api/nodes/${s1}`, { json: { name: 'Report final.txt' } });
  expect('renamed on the website: renamed here', await until(() => read('Report final.txt') === 'v2 from the website' && read('Report.txt') === null));
  const sub = (await U.req('POST', `/api/nodes/${home}/folders`, { json: { name: 'Archive' } })).id;
  await U.req('PATCH', `/api/nodes/${s1}`, { json: { parent_id: sub } });
  expect('moved on the website: moved here', await until(() => read('Archive/Report final.txt') === 'v2 from the website' && read('Report final.txt') === null));
  await U.req('DELETE', `/api/nodes/${s1}`);
  expect('deleted on the website: gone here', await until(() => read('Archive/Report final.txt') === null));
  expect(`... and in this computer's ${WIN ? 'Recycle Bin' : 'Trash'}`, await until(() => inTrash('Report final.txt'), 8000));

  // ---- computer → website ----
  fs.writeFileSync(path.join(MY, 'Typed here.txt'), 'made on the laptop');
  let lid;
  expect('new file on the computer appears on the website', await until(async () => { const n = await child(home, 'Typed here.txt'); lid = n?.id; return n && (await content(n.id)) === 'made on the laptop'; }));
  fs.mkdirSync(path.join(MY, 'Projects', 'Site plan'), { recursive: true });
  fs.writeFileSync(path.join(MY, 'Projects', 'Site plan', 'notes#1.txt'), 'nested');
  expect('a new folder with a file: same structure on the website ("#" → "_", and the copy here follows)', await until(async () => {
    const p = await child(home, 'Projects'); const s = p && await child(p.id, 'Site plan'); const f = s && await child(s.id, 'notes_1.txt');
    return f && read('Projects/Site plan/notes_1.txt') === 'nested' && read('Projects/Site plan/notes#1.txt') === null;
  }));
  fs.writeFileSync(path.join(MY, '~$Typed here.txt'), 'office lock file');
  fs.writeFileSync(path.join(MY, 'Typed here.txt'), 'edited on the laptop');
  expect('edited on the computer: the website gets it as a new version', await until(async () => (await content(lid)) === 'edited on the laptop' && (await U.req('GET', `/api/nodes/${lid}/versions`)).length >= 1));
  expect('Office lock files (~$…) are not sent', !(await child(home, '~$Typed here.txt')) && !(await child(home, '_$Typed here.txt')));
  fs.unlinkSync(path.join(MY, 'Typed here.txt'));
  expect('deleted on the computer: in the website trash', await until(async () => (await U.req('GET', '/api/trash')).some(t => t.id === lid)));

  // ---- both changed while the agent was off: nothing is lost ----
  const both = await upload(home, 'Budget.txt', 'base');
  expect('(setup) Budget.txt arrives', await until(() => read('Budget.txt') === 'base'));
  await quit();
  fs.writeFileSync(path.join(MY, 'Budget.txt'), 'laptop edit');
  await upload(home, 'Budget.txt', 'website edit');
  start();
  const conflictName = n => n.startsWith('Budget (conflict, ') && n.endsWith(').txt');
  expect('conflict: the website version takes the name, the laptop edit stays as "Budget (conflict, <computer>).txt" on both sides', await until(async () => {
    const local = fs.readdirSync(MY).find(conflictName);
    const remote = (await kids(home)).find(x => conflictName(x.name));
    return read('Budget.txt') === 'website edit' && local && read(local) === 'laptop edit' && remote && (await content(remote.id)) === 'laptop edit' && (await content(both)) === 'website edit';
  }, 40000));

  // ---- the whole folder disappears (a drive unplugged, deleted by hand): the website keeps everything ----
  const countBefore = (await kids(home)).length;
  fs.renameSync(MY, MY + ' moved away');
  await sleep(12000);
  expect(`a vanished My files folder deletes nothing on the website (${(await kids(home)).length} of ${countBefore} items)`, (await kids(home)).length === countBefore && !(await U.req('GET', '/api/trash')).some(t => t.name === 'Budget.txt'));
  const log = fs.readFileSync(path.join(CFG, 'agent.log'), 'utf8');
  expect('the token never appears in the log', !log.includes(JSON.parse(fs.readFileSync(path.join(CFG, 'agent.json'), 'utf8')).token || 'none'));
} catch (e) {
  results.push('FAIL ' + e.stack);
} finally {
  await quit();
  if (WIN) { // take this test's files out of the Recycle Bin again
    await run('powershell', ['-NoProfile', '-Command', `$rb = (New-Object -ComObject Shell.Application).Namespace(10); foreach ($i in @($rb.Items())) { if ($rb.GetDetailsOf($i, 1) -like '${W.replace(/'/g, "''")}*') { $p = $i.Path; Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath ($p -replace '\\\\\\$R([^\\\\]+)$', '\\$I$1') -Force -ErrorAction SilentlyContinue } }`]).catch(() => {});
  }
  console.log(results.join('\n'));
  const failed = results.some(r => r.startsWith('FAIL'));
  console.log(failed ? 'SOME FAILED' : 'ALL OK');
  server.close();
  process.exit(failed ? 1 : 0);
}
