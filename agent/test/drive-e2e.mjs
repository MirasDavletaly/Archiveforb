// The Mac network drive end to end, on a real Mac (CI): the built agent mounts the drive through macOS's own WebDAV
// client (the one Finder uses), and what is made, edited, renamed, read and deleted there lands on the website with
// its rules. HTTPS with a certificate this Mac trusts, as on the real site (macOS sends passwords only over HTTPS).
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { readdir, readFile, writeFile, mkdir, rename, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const APP = process.env.APP_URL;
const EXE = process.env.AGENT;
const { createApp } = await import(APP + 'server.mjs');
const { loadConfig } = await import(APP + 'src/config.mjs');
const { hashPassword } = await import(APP + 'src/auth.mjs');
const W = fs.mkdtempSync(path.join(process.env.WORK || os.tmpdir(), 'drive-e2e-'));
const CFG = path.join(W, 'config');
const SECURE = 8844, PLAIN = 8845; // the agent and Finder use HTTPS; this script talks to the same server over HTTP
const key = path.join(W, 'key.pem'), cert = path.join(W, 'cert.pem');
await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost']);
await run('sudo', ['security', 'add-trusted-cert', '-d', '-r', 'trustRoot', '-k', '/Library/Keychains/System.keychain', cert]);
const A = createApp({ ...loadConfig({ PORT: String(SECURE), PUBLIC_URL: `https://localhost:${SECURE}`, ALLOWED_HOSTS: `127.0.0.1:${PLAIN}` }), dataDir: path.join(W, 'data') });
const servers = [https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, A.handle), http.createServer(A.handle)];
servers[0].on('upgrade', A.upgrade);
await new Promise(r => servers[0].listen(SECURE, r)); // every address: localhost may be ::1 or 127.0.0.1
await new Promise(r => servers[1].listen(PLAIN, '127.0.0.1', r));
const base = `http://127.0.0.1:${PLAIN}`;
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
const u = await admin.req('POST', '/api/admin/users', { json: { login: 'm.user', name: 'Mac User' } });
const U = new Client();
await U.req('POST', '/api/login', { json: { login: 'm.user', password: u.password } });
await U.req('POST', '/api/password', { json: { current: u.password, next: PW } });
const home = (await U.req('GET', '/api/spaces')).find(s => s.area === 'personal').id;
const kids = async id => (await U.req('GET', `/api/nodes/${id}`)).children;
const child = async (id, name) => (await kids(id)).find(x => x.name === name);
const content = async id => (await U.req('GET', `/api/nodes/${id}/content`)).toString();

const results = [];
const expect = (label, ok) => results.push(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
const until = async (fn, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch {} await sleep(500); } return false; };
const mountLine = async () => (await run('mount')).stdout.split('\n').find(l => l.includes(`localhost:${SECURE}/dav/Company%20Files`) && l.includes('(webdav'));
const log = () => { try { return fs.readFileSync(path.join(CFG, 'agent.log'), 'utf8'); } catch { return '(no log)'; } };
let agent, mp;
try {
  const code = (await U.req('POST', '/api/devices/pair-code')).code;
  const p = await run(EXE, ['--config', CFG, 'pair', code, '--server', `https://localhost:${SECURE}`, '--yes'], { timeout: 60000 }).then(r => r.stdout, e => 'ERR ' + e.message);
  expect(`paired over HTTPS: ${p.trim().split('\n').pop()}`, /Connected as Mac User/.test(p));
  const cfgFile = path.join(CFG, 'agent.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), initialized: true }));
  agent = spawn(EXE, ['--config', CFG, '--headless'], { stdio: 'ignore' });

  // ---- the agent connects the drive by itself ----
  const mounted = await until(async () => !!(await mountLine()), 120000);
  const line = await mountLine();
  mp = line && line.slice(line.indexOf(' on ') + 4, line.lastIndexOf(' ('));
  expect(`the drive is connected: ${line || 'no'}`, mounted && !!mp);
  if (!mp) throw new Error('not mounted; agent log:\n' + log());
  const top = await readdir(mp);
  expect(`it shows the places from the website: ${top.join(', ')}`, top.includes('My files'));
  const my = path.join(mp, 'My files');

  // ---- here → website ----
  await writeFile(path.join(my, 'from-mac.txt'), 'typed on a Mac');
  let madeId;
  expect('a file made on the drive is on the website', await until(async () => { const n = await child(home, 'from-mac.txt'); madeId = n?.id; return n && (await content(n.id)) === 'typed on a Mac'; }));
  await mkdir(path.join(my, 'Mac folder'));
  const folder = await until(async () => !!(await child(home, 'Mac folder')));
  expect('a folder made on the drive is on the website', folder);
  const folderId = (await child(home, 'Mac folder'))?.id;
  await rename(path.join(my, 'from-mac.txt'), path.join(my, 'Mac folder', 'renamed.txt'));
  expect('renamed and moved on the drive: the same file on the website', await until(async () => (await child(folderId, 'renamed.txt'))?.id === madeId));
  await writeFile(path.join(my, 'Mac folder', 'renamed.txt'), 'edited on a Mac');
  expect('edited on the drive: new content and a version on the website', await until(async () => (await content(madeId)) === 'edited on a Mac' && (await U.req('GET', `/api/nodes/${madeId}/versions`)).length >= 1));
  const big = crypto.randomBytes(8 * 2 ** 20);
  await writeFile(path.join(my, 'big.bin'), big);
  expect('an 8 MB file copied to the drive arrives whole', await until(async () => { const n = await child(home, 'big.bin'); return n && n.size === big.length && (await U.req('GET', `/api/nodes/${n.id}/content`)).equals(big); }, 120000));
  const tagged = path.join(W, 'tagged.txt');
  fs.writeFileSync(tagged, 'with extended attributes');
  await run('xattr', ['-w', 'com.example.note', 'hello', tagged]);
  const cp = await run('cp', [tagged, path.join(my, 'tagged.txt')]).then(() => 'ok', e => e.message);
  expect(`a file with extended attributes copies (Finder adds ._ files): ${cp}`, cp === 'ok' && await until(async () => !!(await child(home, 'tagged.txt'))));

  // ---- website → here ----
  await U.req('PUT', `/api/nodes/${home}/files?name=from-site.txt`, { raw: Buffer.from('from the website') });
  expect('a file added on the website opens on the drive', await until(async () => (await readFile(path.join(my, 'from-site.txt'), 'utf8')) === 'from the website', 60000));

  // ---- deleting, and nothing of Finder's own on the website ----
  await unlink(path.join(my, 'Mac folder', 'renamed.txt'));
  expect('deleted on the drive: in the website trash', await until(async () => (await U.req('GET', '/api/trash')).some(t => t.id === madeId)));
  const dots = A.db.all(`SELECT name FROM nodes WHERE name LIKE '.%'`).map(r => r.name);
  expect(`Finder's .DS_Store and ._ files never reach the website (${dots.length ? dots.join(', ') : 'none'})`, dots.length === 0);
  results.push('info ' + (log().match(/network drive: not pinned[^\n]*/)?.[0] || 'pinned to Finder Favorites'));

  // ---- disconnected on the website: the drive goes away ----
  for (const d of await U.req('GET', '/api/devices')) await U.req('DELETE', `/api/devices/${d.id}`);
  expect('disconnected on the website: the drive is disconnected too', await until(async () => !(await mountLine()), 60000));
} catch (e) {
  results.push('FAIL ' + e.stack);
} finally {
  if (agent && agent.exitCode === null) agent.kill();
  if (mp && (await mountLine().catch(() => null))) await run('umount', [mp]).catch(() => run('diskutil', ['unmount', 'force', mp]).catch(() => {}));
  const failed = results.some(r => r.startsWith('FAIL'));
  console.log(results.join('\n'));
  if (failed) console.log('--- agent log:\n' + log());
  console.log(failed ? 'SOME FAILED' : 'ALL OK');
  for (const s of servers) s.close();
  process.exit(failed ? 1 : 0);
}
