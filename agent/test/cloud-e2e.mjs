// Windows "files on demand" end to end, with the built agent against a throwaway server. It registers its own
// cloud folder under a test provider name in a temporary folder (never the real "Company Files" one) and removes the
// registration at the end.
import http from 'node:http';
import fs from 'node:fs';
import { readdir, stat, readFile, writeFile, rename, unlink, mkdir, access } from 'node:fs/promises';
// The server runs in this process: file operations on the cloud folder must not block it (Windows asks the agent,
// the agent asks the server), so they are all asynchronous here.
const exists = p => access(p).then(() => true, () => false);
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
const W = fs.mkdtempSync(path.join(process.env.WORK || os.tmpdir(), 'cloud-e2e-'));
const CFG = path.join(W, 'config'), ROOT = path.join(W, 'Cloud test');
const PROVIDER = 'CompanyFilesTest' + Date.now().toString(36);
const env = { ...process.env, COMPANYFILES_CLOUD_PROVIDER: PROVIDER };
const PORT = 8822;
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
const mkUser = async (login, name) => {
  const u = await admin.req('POST', '/api/admin/users', { json: { login, name } });
  const c = new Client();
  await c.req('POST', '/api/login', { json: { login, password: u.password } });
  await c.req('POST', '/api/password', { json: { current: u.password, next: PW } });
  return Object.assign(c, { id: u.id });
};
const U = await mkUser('p.owner', 'Pavel Owner'), F = await mkUser('f.friend', 'Fatima Friend');
const home = (await U.req('GET', '/api/spaces')).find(s => s.area === 'personal').id;
const fHome = (await F.req('GET', '/api/spaces')).find(s => s.area === 'personal').id;
const upload = async (c, folder, name, text) => (await c.req('PUT', `/api/nodes/${folder}/files?name=${encodeURIComponent(name)}`, { raw: Buffer.from(text) })).id;
const kids = async id => (await U.req('GET', `/api/nodes/${id}`)).children;
const child = async (id, name) => (await kids(id)).find(x => x.name === name);
const content = async id => (await U.req('GET', `/api/nodes/${id}/content`)).toString();
// what is there before the computer connects: it all shows up (files on demand covers everything)
const docs = (await U.req('POST', `/api/nodes/${home}/folders`, { json: { name: 'Docs' } })).id;
const report = await upload(U, docs, 'Report.txt', 'report v1');
const shared = (await F.req('POST', `/api/nodes/${fHome}/folders`, { json: { name: 'For Pavel' } })).id;
await F.req('PUT', `/api/nodes/${shared}/access`, { json: { entries: [{ type: 'user', id: U.id, level: 1 }] } });
const ro = await upload(F, shared, 'read only.txt', 'look, do not touch');

const results = [];
const expect = (label, ok) => results.push(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch {} await sleep(300); } return false; };
const ps = async cmd => (await run('powershell', ['-NoProfile', '-Command', cmd], { env, timeout: 60000 })).stdout.trim();
const attrs = async p => Number(await ps(`[int](Get-Item -LiteralPath '${p.replace(/'/g, "''")}' -Force).Attributes`));
const CLOUD_ONLY = 0x400000; // FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: the data is not on this computer
let agent;
try {
  const code = (await U.req('POST', '/api/devices/pair-code')).code;
  await run(EXE, ['--config', CFG, 'pair', code, '--server', base, '--yes'], { env, timeout: 60000 });
  const cfgFile = path.join(CFG, 'agent.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), cloud_root: ROOT, initialized: true }));
  agent = spawn(EXE, ['--config', CFG, '--headless'], { env, stdio: 'ignore', windowsHide: true });

  // ---- registered with Windows, and the whole tree shows up as it is opened ----
  expect('the cloud folder is registered with Windows', await until(async () => (await ps(`(Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager' | Where-Object { $_.PSChildName -like '${PROVIDER}!*' }).Count`)) === '1'));
  let top = [];
  expect('opening it lists the sections from the website', await until(async () => { top = await readdir(ROOT); return top.includes('My files') && top.includes('For Pavel'); }));
  const reportPath = path.join(ROOT, 'My files', 'Docs', 'Report.txt');
  expect(`files show up without being downloaded (cloud only, right size): ${top.join(', ')}`, await until(async () => (await stat(reportPath)).size === 9 && ((await attrs(reportPath)) & CLOUD_ONLY) !== 0));
  expect('opening a file downloads it', (await readFile(reportPath, 'utf8')) === 'report v1' && ((await attrs(reportPath)) & CLOUD_ONLY) === 0);

  // Explorer's Free up space (unpinned): the downloaded file goes back to cloud only
  await ps(`attrib -P +U '${reportPath.replace(/'/g, "''")}'`);
  expect('Free up space: the file is only in the cloud again', await until(async () => ((await attrs(reportPath)) & CLOUD_ONLY) !== 0));
  await ps(`attrib -U '${reportPath.replace(/'/g, "''")}'`);

  // ---- website → here ----
  await upload(U, docs, 'New on site.txt', 'from the website');
  expect('a file added on the website appears here within seconds', await until(() => exists(path.join(ROOT, 'My files', 'Docs', 'New on site.txt'))));
  await upload(U, docs, 'Report.txt', 'report v2 from the website');
  const gotV2 = await until(async () => (await readFile(reportPath, 'utf8')) === 'report v2 from the website');
  expect('a file changed on the website: opening it gives the new version' + (gotV2 ? '' : ` (size ${(await stat(reportPath)).size}, read ${JSON.stringify(await readFile(reportPath, 'utf8').catch(e => e.code))}, attributes 0x${(await attrs(reportPath)).toString(16)})`), gotV2);
  const siteNew = (await child(docs, 'New on site.txt')).id;
  await U.req('PATCH', `/api/nodes/${siteNew}`, { json: { name: 'Renamed on site.txt' } });
  expect('renamed on the website: renamed here', await until(async () => (await exists(path.join(ROOT, 'My files', 'Docs', 'Renamed on site.txt'))) && !(await exists(path.join(ROOT, 'My files', 'Docs', 'New on site.txt')))));
  await U.req('DELETE', `/api/nodes/${siteNew}`);
  expect('deleted on the website: gone here', await until(async () => !(await exists(path.join(ROOT, 'My files', 'Docs', 'Renamed on site.txt')))));

  // ---- here → website ----
  await writeFile(path.join(ROOT, 'My files', 'Docs', 'Made here.txt'), 'typed on the laptop');
  let madeId;
  expect('a file made here goes to the website', await until(async () => { const n = await child(docs, 'Made here.txt'); madeId = n?.id; return n && (await content(n.id)) === 'typed on the laptop'; }));
  const madePath = path.join(ROOT, 'My files', 'Docs', 'Made here.txt');
  expect('... and then stays here only as its icon (cloud only), like OneDrive after Free up space', await until(async () => ((await attrs(madePath)) & CLOUD_ONLY) !== 0));
  expect('opening it downloads it again', (await readFile(madePath, 'utf8')) === 'typed on the laptop');
  await mkdir(path.join(ROOT, 'My files', 'Folder made here'));
  expect('a folder made here goes to the website', await until(async () => !!(await child(home, 'Folder made here'))));
  await writeFile(reportPath, 'report v3 edited here');
  expect('a file edited here: a new version on the website', await until(async () => (await content(report)) === 'report v3 edited here' && (await U.req('GET', `/api/nodes/${report}/versions`)).length >= 2));
  expect('... and the edited file becomes cloud only too', await until(async () => ((await attrs(reportPath)) & CLOUD_ONLY) !== 0));
  // "Always keep on this device": a pinned file is never freed, even after an edit
  const keepPath = path.join(ROOT, 'My files', 'Docs', 'Keep here.txt');
  await writeFile(keepPath, 'keep v1');
  expect('(setup) Keep here.txt is sent and freed', await until(async () => !!(await child(docs, 'Keep here.txt')) && ((await attrs(keepPath)) & CLOUD_ONLY) !== 0));
  await ps(`attrib +P -U '${keepPath.replace(/'/g, "''")}'`);
  expect('Always keep on this device: downloaded and kept', await until(async () => ((await attrs(keepPath)) & CLOUD_ONLY) === 0));
  await writeFile(keepPath, 'keep v2 edited');
  const keepId = (await child(docs, 'Keep here.txt')).id;
  expect('a pinned file edited here: new version on the website, and it stays on this computer', await until(async () => (await content(keepId)) === 'keep v2 edited') && (await sleep(4000), ((await attrs(keepPath)) & CLOUD_ONLY) === 0));
  await rename(path.join(ROOT, 'My files', 'Docs', 'Made here.txt'), path.join(ROOT, 'My files', 'Folder made here', 'Moved here.txt'));
  expect('renamed and moved here: the same file on the website', await until(async () => { const f = await child(home, 'Folder made here'); return f && (await child(f.id, 'Moved here.txt'))?.id === madeId; }));
  await unlink(path.join(ROOT, 'My files', 'Folder made here', 'Moved here.txt'));
  expect('deleted here: in the website trash', await until(async () => (await U.req('GET', '/api/trash')).some(t => t.id === madeId)));

  // ---- Word-style save: rename to a temp name, write the new file, delete the temp copy ----
  const versionsBefore = (await U.req('GET', `/api/nodes/${report}/versions`)).length;
  await rename(reportPath, path.join(ROOT, 'My files', 'Docs', '~WRL0001.tmp'));
  await writeFile(reportPath, 'report v4 saved by Word');
  await unlink(path.join(ROOT, 'My files', 'Docs', '~WRL0001.tmp'));
  expect('a Word-style save becomes a new version of the same file (not delete + new)', await until(async () => (await content(report)) === 'report v4 saved by Word' && (await U.req('GET', `/api/nodes/${report}/versions`)).length === versionsBefore + 1 && !(await U.req('GET', '/api/trash')).some(t => t.id === report)));

  // ---- read only stays read only ----
  const roPath = path.join(ROOT, 'For Pavel', 'read only.txt');
  expect('a read-only file opens', await until(async () => (await readFile(roPath, 'utf8')) === 'look, do not touch'));
  let refused = false;
  try { await unlink(roPath); } catch { refused = true; }
  expect('deleting it is refused, here and on the website', refused && (await exists(roPath)) && (await F.req('GET', `/api/nodes/${shared}`)).children.some(x => x.id === ro));
} catch (e) {
  results.push('FAIL ' + e.stack);
} finally {
  if (agent && agent.exitCode === null) {
    try {
      const f = JSON.parse(fs.readFileSync(path.join(CFG, 'ipc.json'), 'utf8'));
      await fetch(`http://127.0.0.1:${f.port}/ipc`, { method: 'POST', headers: { 'x-secret': f.secret }, body: JSON.stringify({ quit: true }) });
    } catch {}
    await sleep(1500);
    if (agent.exitCode === null) agent.kill();
  }
  // take the test registration away again
  await run(EXE, ['--config', CFG, 'cloud-stop'], { env, timeout: 60000 }).catch(e => results.push('FAIL cloud-stop: ' + e.message));
  const left = await ps(`(Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager' | Where-Object { $_.PSChildName -like '${PROVIDER}!*' }).Count`).catch(() => '?');
  expect(`the test registration is gone afterwards (${left} left)`, left === '0');
  const failed = results.some(r => r.startsWith('FAIL'));
  console.log(results.join('\n'));
  console.log(failed ? 'SOME FAILED' : 'ALL OK');
  server.close();
  process.exit(failed ? 1 : 0);
}
