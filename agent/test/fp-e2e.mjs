// Files on demand on a real Mac (CI), as OneDrive works: the signed app, installed in /Applications, adds its File
// Provider domain; Finder's folder for it (~/Library/CloudStorage/...) shows the website's places, a file opens
// (downloaded then), and what is made, renamed or deleted there reaches the website; a change on the website shows up
// here. HTTPS with a certificate this Mac trusts, as on the real site.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { readdir, readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const APP = process.env.APP_URL;
const EXE = process.env.AGENT;
const { createApp } = await import(APP + 'server.mjs');
const { loadConfig } = await import(APP + 'src/config.mjs');
const { hashPassword } = await import(APP + 'src/auth.mjs');
const W = fs.mkdtempSync(path.join(process.env.WORK || os.tmpdir(), 'fp-e2e-'));
const CFG = path.join(W, 'config');
const SECURE = 8846, PLAIN = 8847;
const key = path.join(W, 'key.pem'), cert = path.join(W, 'cert.pem');
await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost']);
await run('sudo', ['security', 'add-trusted-cert', '-d', '-r', 'trustRoot', '-k', '/Library/Keychains/System.keychain', cert]);
const A = createApp({ ...loadConfig({ PORT: String(SECURE), PUBLIC_URL: `https://localhost:${SECURE}`, ALLOWED_HOSTS: `127.0.0.1:${PLAIN}` }), dataDir: path.join(W, 'data') });
const reqLog = []; // what the extension asked the website for, shown when something fails
const handle = (req, res) => {
  if (req.url.startsWith('/api/agent/cloud')) res.on('close', () => reqLog.push(`${req.method} ${decodeURIComponent(req.url)} → ${res.statusCode}`));
  return A.handle(req, res);
};
const servers = [https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, handle), http.createServer(A.handle)];
servers[0].on('upgrade', A.upgrade);
await new Promise(r => servers[0].listen(SECURE, r));
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
await U.req('PUT', `/api/nodes/${home}/files?name=${encodeURIComponent('before.txt')}`, { raw: Buffer.from('there before the Mac connected') });
const kids = async id => (await U.req('GET', `/api/nodes/${id}`)).children;
const child = async (id, name) => (await kids(id)).find(x => x.name === name);
const content = async id => (await U.req('GET', `/api/nodes/${id}/content`)).toString();

const results = [];
const expect = (label, ok) => results.push(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
const until = async (fn, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch {} await sleep(1000); } return false; };
const log = () => { try { return fs.readFileSync(path.join(CFG, 'agent.log'), 'utf8'); } catch { return '(no log)'; } };
const storage = path.join(os.homedir(), 'Library', 'CloudStorage');
let agent, root;
try {
  const code = (await U.req('POST', '/api/devices/pair-code')).code;
  const p = await run(EXE, ['--config', CFG, 'pair', code, '--server', `https://localhost:${SECURE}`, '--yes'], { timeout: 60000 }).then(r => r.stdout, e => 'ERR ' + e.message);
  expect(`paired: ${p.trim().split('\n').pop()}`, /Connected as Mac User/.test(p));
  const cfgFile = path.join(CFG, 'agent.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), initialized: true }));
  const pk = () => run('pluginkit', ['-m', '-v', '-v', '-v', '-i', 'com.companyfiles.agent.provider']).then(r => r.stdout.trim(), e => e.message);
  results.push('info extension before the app starts: ' + (await pk()).replace(/\s+/g, ' '));
  agent = spawn(EXE, ['--config', CFG, '--headless'], { stdio: 'ignore' });
  await sleep(8000);
  results.push('info extension once the app runs: ' + (await pk()).replace(/\s+/g, ' '));

  // ---- in Finder, like OneDrive: a folder under ~/Library/CloudStorage ----
  const found = await until(async () => (root = (await readdir(storage).catch(() => [])).find(n => /company/i.test(n))) && true, 120000);
  root = root && path.join(storage, root);
  expect(`Company Files is in Finder's cloud storage: ${root || 'no'}`, found);
  if (!root) throw new Error('no File Provider folder; agent log:\n' + log());
  let top = [];
  expect('it shows the places from the website', await until(async () => (top = await readdir(root)).includes('My files')));
  const my = path.join(root, 'My files');
  expect('a file that is on the website opens (downloaded when opened)', await until(async () => (await readFile(path.join(my, 'before.txt'), 'utf8')) === 'there before the Mac connected'));

  // ---- here → website ----
  await writeFile(path.join(my, 'from-mac.txt'), 'typed on a Mac');
  let madeId;
  expect('a file made here goes to the website', await until(async () => { const n = await child(home, 'from-mac.txt'); madeId = n?.id; return n && (await content(n.id)) === 'typed on a Mac'; }));
  await mkdir(path.join(my, 'Mac folder'));
  expect('a folder made here goes to the website', await until(async () => !!(await child(home, 'Mac folder'))));
  const folderId = (await child(home, 'Mac folder'))?.id;
  await rename(path.join(my, 'from-mac.txt'), path.join(my, 'Mac folder', 'renamed.txt'));
  expect('renamed and moved here: the same file on the website', await until(async () => (await child(folderId, 'renamed.txt'))?.id === madeId));
  await writeFile(path.join(my, 'Mac folder', 'renamed.txt'), 'edited on a Mac');
  expect('edited here: a new version on the website', await until(async () => (await content(madeId)) === 'edited on a Mac' && (await U.req('GET', `/api/nodes/${madeId}/versions`)).length >= 1));
  await writeFile(path.join(my, '.DS_Store'), 'finder stuff');
  await sleep(3000);
  expect('Finder\'s own files stay on this Mac', !A.db.get(`SELECT 1 FROM nodes WHERE name LIKE '.%'`));

  // ---- website → here ----
  await U.req('PUT', `/api/nodes/${home}/files?name=${encodeURIComponent('from-site.txt')}`, { raw: Buffer.from('from the website') });
  expect('a file added on the website shows up here', await until(async () => (await readFile(path.join(my, 'from-site.txt'), 'utf8')) === 'from the website', 90000));
  const siteId = (await child(home, 'from-site.txt')).id;
  await U.req('PATCH', `/api/nodes/${siteId}`, { json: { name: 'renamed on site.txt' } });
  expect('renamed on the website: renamed here', await until(async () => (await readdir(my)).includes('renamed on site.txt'), 90000));
  await U.req('DELETE', `/api/nodes/${siteId}`);
  expect('deleted on the website: gone here', await until(async () => !(await readdir(my)).includes('renamed on site.txt'), 90000));

  // ---- deleting here ----
  await unlink(path.join(my, 'Mac folder', 'renamed.txt'));
  expect('deleted here: in the website trash', await until(async () => (await U.req('GET', '/api/trash')).some(t => t.id === madeId)));
} catch (e) {
  results.push('FAIL ' + e.stack);
} finally {
  // The safety net: when files on demand does not come up, the app switches to the network drive by itself.
  if (results.some(r => r.startsWith('FAIL')) && agent && agent.exitCode === null) {
    const mounted = await until(async () => (await run('mount')).stdout.includes(`localhost:${SECURE}/dav/Company%20Files`), 420000);
    results.push(`${mounted ? 'ok  ' : 'FAIL'} fallback: the app switched to the network drive by itself`);
  }
  if (agent && agent.exitCode === null) agent.kill();
  const failed = results.some(r => r.startsWith('FAIL'));
  console.log(results.join('\n'));
  if (failed) {
    console.log('--- agent log:\n' + log());
    console.log(`--- requests from the extension (${reqLog.length}, last 60):\n` + reqLog.slice(-60).join('\n'));
    const sh = cmd => run('sh', ['-c', cmd], { maxBuffer: 64 << 20 }).then(r => r.stdout + r.stderr, e => (e.stdout || '') + e.message);
    console.log('--- shared folder:\n' + await sh('ls -la ~/Library/Group\\ Containers/ | grep -i companyfiles; ls -la ~/Library/Group\\ Containers/*companyfiles*/ 2>&1'));
    console.log('--- crash reports:\n' + await sh('ls -t ~/Library/Logs/DiagnosticReports/ /Library/Logs/DiagnosticReports/ 2>/dev/null | grep -i companyfiles | head; f=$(ls -t ~/Library/Logs/DiagnosticReports/*ompanyFiles* 2>/dev/null | head -1); [ -n "$f" ] && head -c 6000 "$f"'));
    const show = pred => sh(`log show --last 15m --style compact --info --debug --predicate '${pred}'`);
    console.log('--- the extension\'s own log:\n' + (await show('subsystem == "com.companyfiles.provider" OR process == "CompanyFilesProvider"')).split('\n').slice(-120).join('\n'));
    console.log('--- everything that names the extension (launchd, runningboard, pkd, sandbox, fileproviderd):\n' + (await show('eventMessage CONTAINS[c] "CompanyFilesProvider" OR eventMessage CONTAINS[c] "companyfiles.agent.provider" OR category CONTAINS[c] "companyfiles"')).split('\n').slice(-160).join('\n'));
    console.log('--- the domain as the system sees it:\n' + (await sh('fileproviderctl dump 2>&1 | grep -iE "companyfiles|enabled|disabled|disconnect|userEnabled|hidden" | head -60')));
    console.log('--- fileproviderd errors:\n' + (await show('process == "fileproviderd" AND (messageType == error OR messageType == fault)')).split('\n').slice(-60).join('\n'));
    console.log('--- the extension started by hand (shows a loading error, if any):\n' + await sh('"/Applications/Company Files.app/Contents/PlugIns/CompanyFilesProvider.appex/Contents/MacOS/CompanyFilesProvider" & p=$!; sleep 4; kill $p 2>/dev/null; wait $p; echo "exit $?"'));
    console.log('--- its signature and entitlements:\n' + await sh('codesign -d --entitlements :- -vv "/Applications/Company Files.app/Contents/PlugIns/CompanyFilesProvider.appex" 2>&1 | head -40; spctl -a -vv "/Applications/Company Files.app" 2>&1'));
  }
  console.log(failed ? 'SOME FAILED' : 'ALL OK');
  for (const s of servers) s.close();
  process.exit(failed ? 1 : 0);
}
