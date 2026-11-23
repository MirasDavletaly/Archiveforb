// Self-check: runs the app on a throwaway data folder and walks through the pre-launch checks
// from spec section 10, then the security rules. Run: npm run check
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { createApp, msUntil } from '../server.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDb } from '../src/db.mjs';
import { hashPassword } from '../src/auth.mjs';
import { backup, verify, restore, loadKey } from '../scripts/backup.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'files-check-'));
const dataDir = path.join(tmp, 'data');
const cfg = { ...loadConfig({}), dataDir, maxFile: 1024 * 1024, uploadStallMs: 1500 };
const app = createApp(cfg);
const server = http.createServer(app.handle);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
cfg.allowedHosts.push(`127.0.0.1:${server.address().port}`);
const rawRequest = (path, headers) =>
  new Promise((res, rej) => http.get({ host: '127.0.0.1', port: server.address().port, path, headers }, r => { r.resume(); res(r.statusCode); }).on('error', rej));

class Client {
  jar = new Map();
  async req(method, url, { json, raw, headers = {} } = {}) {
    const h = { 'x-requested-with': 'fetch', ...headers };
    if (this.jar.size) h.cookie = this.cookie();
    let body = raw;
    if (json !== undefined) {
      h['content-type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const res = await fetch(base + url, { method, headers: h, body });
    for (const sc of res.headers.getSetCookie()) {
      const kv = sc.split(';')[0];
      const i = kv.indexOf('=');
      if (/Max-Age=0\b/.test(sc)) this.jar.delete(kv.slice(0, i));
      else this.jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    const isJson = (res.headers.get('content-type') || '').includes('json');
    return { status: res.status, headers: res.headers, data: method === 'HEAD' ? null : isJson ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  }
  cookie = () => [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  get = u => this.req('GET', u);
  post = (u, json = {}) => this.req('POST', u, { json });
  put = (u, json) => this.req('PUT', u, { json });
  patch = (u, json) => this.req('PATCH', u, { json });
  del = u => this.req('DELETE', u);
  upload = (folder, name, content) => this.req('PUT', `/api/nodes/${folder}/files?name=${encodeURIComponent(name)}`, { raw: Buffer.from(content) });
}

const ok = (r, status = 200) => {
  assert.equal(r.status, status, Buffer.isBuffer(r.data) ? r.data.toString() : JSON.stringify(r.data));
  return r.data;
};
const pass = name => console.log(`  ok  ${name}`);
const pause = ms => new Promise(r => setTimeout(r, ms));
// Digits only in the random part: a random letter pair could spell a test login (such as "it") and be refused.
const strong = () => `Kx9-${crypto.randomInt(1e12)}-long-pass`;

try {
  // ---- IT bootstrap (what `npm run admin` does) ----
  app.db.run(`INSERT INTO users(login, name, pass, is_admin, must_change, created_at) VALUES('admin', 'IT', ?, 1, 0, ?)`, await hashPassword('admin-password-123'), Date.now());
  const admin = new Client();
  assert.equal(ok(await admin.post('/api/login', { login: 'admin', password: 'admin-password-123' })).stage, 'full');
  for (const gone of ['/api/login/totp', '/api/2fa/setup', '/api/2fa/enable']) assert.equal((await admin.post(gone, { code: '000000', password: 'x' })).status, 404, gone);
  pass('Sign-in is the password alone: no 2FA step, the 2FA endpoints are gone');

  const mk = async (login, name) => ({ ...ok(await admin.post('/api/admin/users', { login, name })), login });
  const head = await mk('a.head', 'Aigerim Head');
  const eng = await mk('e.eng', 'Erlan Engineer');
  const acc = await mk('a.acc', 'Asel Accountant');
  const mgr = await mk('m.mgr', 'Marat Manager');
  const hr = await mk('h.hr', 'Hana HR');
  assert.equal((await admin.post('/api/admin/users', { login: 'e.eng', name: 'Dup' })).status, 409);
  ok(await admin.post('/api/admin/departments', { name: 'Engineering', head_id: head.id, quota_gb: 1 }));
  ok(await admin.post('/api/admin/departments', { name: 'Accounting', head_id: acc.id }));
  const groups = ok(await admin.get('/api/admin/groups'));
  const gid = n => groups.find(g => g.name === n).id;
  ok(await admin.put(`/api/admin/groups/${gid('Engineering')}/members`, { user_ids: [head.id, eng.id] }));
  ok(await admin.put(`/api/admin/groups/${gid('Managers')}/members`, { user_ids: [mgr.id] }));
  assert.equal((await admin.put(`/api/admin/groups/${gid('Managers')}/members`, { user_ids: [mgr.id, 1] })).status, 400);
  pass('IT creates accounts, departments and groups; admin accounts cannot join groups');

  async function signIn(u) {
    const c = new Client();
    let r = ok(await c.post('/api/login', { login: u.login, password: u.password }));
    if (r.stage === 'change') {
      const next = strong();
      r = ok(await c.post('/api/password', { current: u.password, next }));
      u.password = next;
    }
    assert.equal(r.stage, 'full');
    return c;
  }
  const H = await signIn(head), E = await signIn(eng), AC = await signIn(acc), M = await signIn(mgr);
  const spaces = async c => ok(await c.get('/api/spaces'));
  const space = (list, name) => list.find(x => x.name === name);

  // ---- 1. one department cannot see another department's folder ----
  const engDir = space(await spaces(E), 'Engineering');
  assert.equal(engDir.area, 'departments');
  assert.ok(!space(await spaces(AC), 'Engineering'));
  assert.equal((await AC.get(`/api/nodes/${engDir.id}`)).status, 404);
  pass('1. Accounting cannot see or open the Engineering folder');

  // ---- 2. a department head restricts a subfolder without IT ----
  const sub = ok(await H.post(`/api/nodes/${engDir.id}/folders`, { name: 'Salaries 2026' })).id;
  ok(await H.put(`/api/nodes/${sub}/access`, { restricted: true, entries: [{ type: 'user', id: acc.id, level: 1 }] }));
  assert.equal((await E.get(`/api/nodes/${sub}`)).status, 404);
  assert.ok(!ok(await E.get(`/api/nodes/${engDir.id}`)).children.some(x => x.id === sub));
  assert.ok(space(await spaces(AC), 'Salaries 2026'));
  assert.equal(ok(await AC.get(`/api/nodes/${sub}`)).node.level, 1);
  assert.equal(ok(await H.get(`/api/nodes/${sub}`)).node.level, 3);
  const drawings = ok(await E.post(`/api/nodes/${engDir.id}/folders`, { name: 'Drawings' })).id;
  assert.equal((await E.put(`/api/nodes/${drawings}/access`, { restricted: true, entries: [] })).status, 403);
  assert.equal((await H.put(`/api/nodes/${drawings}/access`, { entries: [{ type: 'user', id: acc.id, level: 3 }] })).status, 400);
  const plans = ok(await H.post(`/api/nodes/${engDir.id}/folders`, { name: 'Plans' })).id;
  const secretPlans = ok(await H.post(`/api/nodes/${plans}/folders`, { name: 'Secret' })).id;
  ok(await H.put(`/api/nodes/${secretPlans}/access`, { restricted: true, entries: [] }));
  assert.equal((await E.del(`/api/nodes/${plans}`)).status, 403);
  assert.equal((await E.del(`/api/nodes/${engDir.id}`)).status, 403);
  pass('2. Head restricts a subfolder: members lose sight of it, the assigned outsider gets in; members cannot restrict or delete around it');

  // ---- 3. a manager can see all folders ----
  const ms = await spaces(M);
  for (const area of ['general', 'departments', 'projects', 'management', 'archive']) assert.ok(ms.some(x => x.area === area && x.root), area);
  assert.equal(ok(await M.get(`/api/nodes/${sub}`)).node.level, 2);
  assert.equal(ok(await M.get(`/api/nodes/${secretPlans}`)).node.level, 2);
  assert.ok(!ms.some(x => x.area === 'confidential'));
  pass('3. A manager sees every top-level folder and keeps Edit inside restricted subfolders');

  // ---- 4. deleted file comes back from trash and from the backup; versions ----
  const f1 = ok(await E.upload(drawings, 'spec.txt', 'v1')).id;
  ok(await E.upload(drawings, 'spec.txt', 'v2'));
  const vers = ok(await E.get(`/api/nodes/${f1}/versions`));
  assert.equal(vers.length, 1);
  assert.equal(ok(await E.get(`/api/nodes/${f1}/content`)).toString(), 'v2');
  ok(await E.post(`/api/versions/${vers[0].id}/restore`));
  assert.equal(ok(await E.get(`/api/nodes/${f1}/content`)).toString(), 'v1');
  ok(await E.del(`/api/nodes/${f1}`));
  assert.equal((await E.get(`/api/nodes/${f1}`)).status, 404);
  assert.ok(ok(await E.get('/api/trash')).some(x => x.id === f1));
  assert.ok(!ok(await AC.get('/api/trash')).some(x => x.id === f1));
  ok(await E.post(`/api/trash/${f1}/restore`));
  assert.equal(ok(await E.get(`/api/nodes/${f1}/content`)).toString(), 'v1');
  const bdir = path.join(tmp, 'backup');
  await backup(dataDir, bdir);
  const v = await verify(bdir, dataDir);
  assert.equal(v.integrity, 'ok');
  assert.equal(v.missing, 0);
  const rdir = path.join(tmp, 'restored');
  await restore(v.snapshot, rdir, loadKey(dataDir));
  const rdb = new DatabaseSync(path.join(rdir, 'app.db'), { readOnly: true });
  const blob = rdb.prepare('SELECT blob FROM nodes WHERE id = ?').get(f1).blob;
  rdb.close();
  assert.equal(fs.readFileSync(path.join(rdir, 'blobs', blob.slice(0, 2), blob), 'utf8'), 'v1');
  pass('4. A deleted file is restored from trash and from a backup; old versions can be restored');

  const backupBlob = path.join(bdir, 'blobs', blob.slice(0, 2), blob);
  assert.ok(!fs.readFileSync(backupBlob).includes(Buffer.from('v1')), 'backup copies must be encrypted');
  assert.ok(!fs.readFileSync(v.snapshot).includes(Buffer.from('SQLite format')), 'snapshot must be encrypted');
  assert.ok(!fs.existsSync(path.join(bdir, 'backup.key')) && !fs.existsSync(path.join(bdir, 'secret.key')), 'no keys next to backups');
  await assert.rejects(restore(v.snapshot, path.join(tmp, 'restored-wrong-key'), Buffer.alloc(32, 1)), /wrong backup key/);
  const tampered = fs.readFileSync(backupBlob);
  tampered[20] ^= 1;
  fs.writeFileSync(backupBlob, tampered);
  await assert.rejects(restore(v.snapshot, path.join(tmp, 'restored-tampered'), loadKey(dataDir)), /wrong backup key or damaged/);
  pass('Backups are encrypted (AES-256-GCM), keys are never stored with them, wrong keys and tampering are detected');

  ok(await H.del(`/api/nodes/${secretPlans}`));
  assert.ok(!ok(await E.get('/api/trash')).some(x => x.id === secretPlans), 'hidden restricted folder must not show in a member trash');
  assert.equal((await E.post(`/api/trash/${secretPlans}/restore`)).status, 404);
  assert.ok(ok(await H.get('/api/trash')).some(x => x.id === secretPlans));
  ok(await H.post(`/api/trash/${secretPlans}/restore`));
  pass('Trash shows and restores only what the user could open: deleted restricted folders stay hidden');

  ok(await H.put(`/api/nodes/${plans}/access`, { entries: [{ type: 'user', id: acc.id, level: 2 }] }));
  ok(await H.put(`/api/nodes/${secretPlans}/access`, { restricted: true, entries: [{ type: 'user', id: acc.id, level: 1 }] }));
  assert.equal((await AC.del(`/api/nodes/${secretPlans}`)).status, 403);
  assert.equal((await AC.del(`/api/nodes/${plans}`)).status, 403, 'Read on a restricted child must block deleting its parent');
  pass('Deleting or moving a folder needs Edit on every restricted folder inside it');

  // ---- 5. a blocked employee cannot sign in from any device ----
  const E2 = await signIn(eng);
  ok(await admin.patch(`/api/admin/users/${eng.id}`, { disabled: true }));
  assert.equal((await E.get('/api/spaces')).status, 401);
  assert.equal((await E2.get('/api/spaces')).status, 401);
  assert.equal((await new Client().post('/api/login', { login: eng.login, password: eng.password })).status, 403);
  pass('5. A blocked employee is signed out on every device and cannot sign in');

  // ---- IT admin has no file access ----
  const generalId = ms.find(x => x.area === 'general').id;
  assert.equal((await admin.get('/api/spaces')).status, 403);
  assert.equal((await admin.get(`/api/nodes/${engDir.id}`)).status, 403);
  assert.equal((await admin.put(`/api/nodes/${generalId}/access`, { entries: [{ type: 'user', id: 1, level: 2 }] })).status, 400);
  const adminLog = ok(await admin.get('/api/audit')).rows;
  assert.ok(adminLog.every(e => e.cat !== 'file'));
  assert.ok(adminLog.some(e => e.cat === 'acl' && e.action.includes('folder restricted')));
  assert.ok(adminLog.every(e => !String(e.target).includes('Salaries 2026')), 'IT must not see names of folders people created');
  assert.ok(adminLog.some(e => e.target === '02 Departments / Engineering / …'));
  assert.ok(ok(await M.get('/api/audit?cat=file')).rows.some(e => e.action === 'uploaded'));
  assert.equal((await E2.get('/api/audit')).status, 401);
  assert.equal((await AC.get('/api/audit')).status, 403);
  assert.throws(() => app.db.run('DELETE FROM audit'), /append-only/);
  pass('IT admin: no file access, cannot grant itself access, sees access changes but not file activity; log is append-only');

  // ---- confidential folders ----
  ok(await admin.post('/api/admin/confidential', { name: 'Payroll' }));
  const payroll = ok(await admin.get('/api/admin/folders')).find(f => f.name === 'Payroll');
  assert.equal((await admin.put(`/api/nodes/${payroll.id}/access`, { entries: [{ type: 'group', id: gid('Engineering'), level: 1 }] })).status, 400);
  ok(await admin.put(`/api/nodes/${payroll.id}/access`, { entries: [{ type: 'user', id: hr.id, level: 2 }] }));
  const hrFirst = new Client();
  assert.equal(ok(await hrFirst.post('/api/login', { login: hr.login, password: hr.password })).stage, 'change');
  assert.equal((await hrFirst.get('/api/spaces')).status, 403, 'a temporary password must be replaced before any folder opens');
  const HR = await signIn(hr);
  assert.ok(space(await spaces(HR), 'Payroll'));
  assert.equal((await M.get(`/api/nodes/${payroll.id}`)).status, 404);
  assert.equal((await HR.post(`/api/nodes/${payroll.id}/links`, { password: 'longenough', days: 5 })).status, 403);
  assert.equal(ok(await new Client().post('/api/login', { login: hr.login, password: hr.password })).stage, 'full', 'confidential access needs no extra sign-in step');
  pass('Confidential: named people only, hidden from Managers by default, no external links');

  ok(await HR.upload(payroll.id, 'Salary - Ivanov.xlsx', 'confidential'));
  assert.ok(ok(await M.get('/api/audit?cat=file')).rows.every(e => !String(e.target).includes('Salary')), 'Managers must not read names from folders they cannot open');
  const alertsSeen = ok(await M.get('/api/audit?cat=alerts')).rows.map(e => e.action);
  assert.ok(alertsSeen.some(a => a.startsWith('ALERT access changed')) && alertsSeen.some(a => a.startsWith('ALERT group members changed')));
  pass('Activity log shows people only rows about folders they can open; sensitive IT actions are flagged ALERT for Managers');

  ok(await admin.put(`/api/nodes/${payroll.id}/access`, { entries: [{ type: 'user', id: hr.id, level: 2 }, { type: 'group', id: gid('Managers'), level: 2 }] }));
  const leak = ok(await H.post(`/api/nodes/${engDir.id}/folders`, { name: 'Leak' })).id;
  ok(await H.put(`/api/nodes/${leak}/access`, { entries: [{ type: 'group', id: gid('Everyone'), level: 1 }] }));
  assert.equal((await M.patch(`/api/nodes/${leak}`, { parent_id: payroll.id })).status, 403);
  const clean = ok(await H.post(`/api/nodes/${engDir.id}/folders`, { name: 'Clean' })).id;
  ok(await M.patch(`/api/nodes/${clean}`, { parent_id: payroll.id }));
  ok(await admin.put(`/api/nodes/${payroll.id}/access`, { entries: [{ type: 'user', id: hr.id, level: 2 }] }));
  pass('A folder shared with groups cannot be moved into a confidential folder');

  ok(await admin.post('/api/admin/confidential', { name: 'HR files', owner_id: hr.id }));
  const hrFiles = ok(await admin.get('/api/admin/folders')).find(f => f.name === 'HR files');
  assert.equal(ok(await HR.get(`/api/nodes/${hrFiles.id}`)).can.manage, true, 'the owner can share a confidential folder');
  assert.equal(ok(await HR.get(`/api/nodes/${hrFiles.id}/access`)).editable, true);
  ok(await HR.put(`/api/nodes/${hrFiles.id}/access`, { entries: [{ type: 'user', id: acc.id, level: 1 }] }));
  assert.equal((await HR.put(`/api/nodes/${hrFiles.id}/access`, { entries: [{ type: 'user', id: acc.id, level: 3 }] })).status, 400, 'owners cannot hand out Manage');
  ok(await admin.put(`/api/nodes/${hrFiles.id}/access`, { entries: [{ type: 'user', id: hr.id, level: 3 }, { type: 'group', id: gid('Managers'), level: 1 }] }));
  ok(await HR.put(`/api/nodes/${hrFiles.id}/access`, { entries: [{ type: 'user', id: acc.id, level: 2 }, { type: 'group', id: gid('Engineering'), level: 2 }] }));
  const shared = ok(await HR.get(`/api/nodes/${hrFiles.id}/access`)).own;
  assert.ok(!shared.some(e => e.name === 'Engineering'), 'owners cannot add groups');
  assert.ok(shared.some(e => e.name === 'Managers' && e.level === 1), "IT's group grant survives the owner's edit");
  assert.ok(shared.some(e => e.id === acc.id && e.level === 2));
  assert.equal((await M.put(`/api/nodes/${hrFiles.id}/access`, { entries: [] })).status, 403, 'a reader cannot change sharing');
  ok(await HR.put(`/api/nodes/${hrFiles.id}/access`, { entries: [] }));
  assert.ok(ok(await admin.get('/api/audit?cat=alerts')).rows.some(e => e.action.startsWith('ALERT access changed') && e.target.endsWith('HR files')));
  pass('The owner of a confidential folder shares it with named people and removes access; no groups, no Manage, every change flagged');

  // ---- external links ----
  ok(await admin.post('/api/admin/projects', { name: 'Apollo', lead_id: head.id }));
  const apollo = space(await spaces(H), 'Apollo');
  const forContractor = ok(await H.post(`/api/nodes/${apollo.id}/folders`, { name: 'For contractor' })).id;
  const doc = ok(await H.upload(forContractor, 'drawing.pdf', '%PDF-1.4 test')).id;
  assert.equal((await H.post(`/api/nodes/${apollo.id}/links`, { password: 'longenough', days: 5 })).status, 403);
  assert.equal((await H.post(`/api/nodes/${forContractor}/links`, { password: 'longenough', days: 31 })).status, 400);
  assert.equal((await H.post(`/api/nodes/${drawings}/links`, { password: 'longenough', days: 5 })).status, 403);
  const l1 = ok(await H.post(`/api/nodes/${forContractor}/links`, { password: 'longenough', days: 30 }));
  const t1 = l1.url.split('/s/')[1];
  const guest = new Client();
  assert.equal((await guest.get(`/api/public/${t1}/items`)).status, 401);
  for (let i = 0; i < 5; i++) assert.equal((await guest.post(`/api/public/${t1}/unlock`, { password: 'wrong-guess' })).status, 401);
  assert.equal((await guest.post(`/api/public/${t1}/unlock`, { password: l1.password })).status, 429);
  assert.match(l1.password, /^[A-Za-z0-9]{16}$/, 'the server makes a strong link password');
  const l2 = ok(await H.post(`/api/nodes/${forContractor}/links`, { password: 'longenough', days: 1 }));
  const t2 = l2.url.split('/s/')[1];
  const guest2 = new Client();
  ok(await guest2.post(`/api/public/${t2}/unlock`, { password: l2.password }));
  assert.ok(ok(await guest2.get(`/api/public/${t2}/items`)).children.some(x => x.id === doc));
  assert.equal(ok(await guest2.get(`/api/public/${t2}/content?id=${doc}`)).toString(), '%PDF-1.4 test');
  assert.equal((await guest2.get(`/api/public/${t2}/items?id=${apollo.id}`)).status, 404);
  const internal = ok(await H.post(`/api/nodes/${forContractor}/folders`, { name: 'Internal' })).id;
  const internalDoc = ok(await H.upload(internal, 'costs.xlsx', 'secret')).id;
  ok(await H.put(`/api/nodes/${internal}/access`, { restricted: true, entries: [] }));
  assert.ok(!ok(await guest2.get(`/api/public/${t2}/items`)).children.some(x => x.id === internal));
  assert.equal((await guest2.get(`/api/public/${t2}/items?id=${internal}`)).status, 404);
  assert.equal((await guest2.get(`/api/public/${t2}/content?id=${internalDoc}`)).status, 404);
  assert.equal((await M.get(`/api/nodes/${forContractor}/links`)).status, 403);
  assert.equal(ok(await H.get(`/api/nodes/${forContractor}/links`)).length, 2);
  assert.equal((await guest2.get(`/api/public/${t1}/items`)).status, 401);
  ok(await H.del(`/api/links/${l2.id}`));
  assert.equal((await guest2.get(`/api/public/${t2}/items`)).status, 404);
  pass('External links: project lead only, password of 8+ characters, at most 30 days, brute force locked, cannot escape the shared folder, can be turned off');
  pass('External links hide restricted subfolders; only the lead can list link tokens');

  // ---- input and transport rules ----
  assert.equal((await H.upload(forContractor, '../evil.txt', 'x')).status, 400);
  assert.equal((await H.upload(forContractor, 'a:b.txt', 'x')).status, 400);
  assert.equal((await H.post(`/api/nodes/${forContractor}/folders`, { name: '..' })).status, 400);
  assert.equal((await H.post(`/api/nodes/${forContractor}/folders`, { name: 'x'.repeat(190) })).status, 400);
  assert.equal((await H.upload(forContractor, 'big.bin', Buffer.alloc(cfg.maxFile + 1))).status, 413);
  app.db.run('UPDATE nodes SET quota = 40 WHERE id = ?', engDir.id);
  const E3 = await signIn(head);
  assert.equal((await E3.upload(drawings, 'quota.bin', Buffer.alloc(60))).status, 413);
  const noHeader = await fetch(`${base}/api/nodes/${forContractor}/folders`, { method: 'POST', headers: { cookie: H.cookie(), 'content-type': 'application/json' }, body: '{"name":"x"}' });
  assert.equal(noHeader.status, 403);
  assert.equal((await H.req('POST', `/api/nodes/${forContractor}/folders`, { json: { name: 'x' }, headers: { origin: 'https://evil.example' } })).status, 403);
  const html = ok(await H.upload(forContractor, 'page.html', '<script>alert(1)</script>')).id;
  const dl = await H.get(`/api/nodes/${html}/content?inline=1`);
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
  assert.match(dl.headers.get('content-disposition'), /^attachment/);
  assert.match(dl.headers.get('content-security-policy'), /sandbox/);
  const part = await H.req('GET', `/api/nodes/${doc}/content`, { headers: { range: 'bytes=0-3' } });
  assert.equal(part.status, 206);
  assert.equal(part.data.toString(), '%PDF');
  const bf = new Client();
  for (let i = 0; i < 5; i++) assert.equal((await bf.post('/api/login', { login: acc.login, password: 'nope-nope-nope' })).status, 401);
  assert.equal((await bf.post('/api/login', { login: acc.login, password: acc.password })).status, 429);
  cfg.trustProxy = true;
  const from = ip => ({ headers: { 'x-forwarded-for': ip } });
  for (let i = 0; i < 5; i++) assert.equal((await new Client().req('POST', '/api/login', { json: { login: acc.login, password: 'nope-nope-nope' }, ...from('10.9.9.8') })).status, 401);
  assert.equal((await new Client().req('POST', '/api/login', { json: { login: acc.login, password: acc.password }, ...from('10.9.9.8') })).status, 429);
  assert.equal((await new Client().req('POST', '/api/login', { json: { login: acc.login, password: acc.password }, ...from('6.6.6.6, 10.9.9.8') })).status, 429, 'a client-supplied X-Forwarded-For entry must not dodge the lockout');
  assert.equal((await new Client().req('POST', '/api/login', { json: { login: acc.login, password: acc.password }, ...from('10.9.9.9') })).status, 200, 'an attacker on another machine must not lock the owner out');
  const web = new Client();
  assert.equal((await web.req('POST', '/api/login', { json: { login: acc.login, password: acc.password }, ...from('203.0.113.7') })).data.stage, 'full', 'from the internet too, the password is enough');
  ok(await web.req('GET', '/api/spaces', from('203.0.113.7')));
  cfg.trustProxy = false;
  const q = ok(await H.post(`/api/nodes/${forContractor}/folders`, { name: 'Quota test' })).id;
  app.db.run('UPDATE nodes SET quota = 100 WHERE id = ?', q);
  ok(await H.upload(q, 'a.bin', Buffer.alloc(60)));
  ok(await H.upload(q, 'a.bin', Buffer.alloc(0)));
  assert.equal((await H.upload(q, 'a.bin', Buffer.alloc(60))).status, 413, 'old versions count toward the quota');
  assert.equal((await new Client().post('/api/login', { login: 'nobody', password: 'x' })).status, 401);
  const users = ok(await admin.get('/api/admin/users'));
  assert.ok(!JSON.stringify(users).includes('scrypt$'));
  const page = await fetch(base + '/');
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('cross-origin-resource-policy'), 'same-origin');
  // The start page carries who is signed in and their places (two round trips fewer), safely escaped.
  const pageOf = async (c, site) => (await c.req('GET', '/', { headers: site ? { 'sec-fetch-site': site } : {} })).data.toString();
  const bootOf = html => JSON.parse(/<script type="application\/json" id="boot">(.*?)<\/script>/s.exec(html)[1]);
  const hb = bootOf(await pageOf(H));
  assert.equal(hb.me.user.id, ok(await H.get('/api/me')).user.id);
  assert.deepEqual(hb.spaces, ok(await H.get('/api/spaces')));
  assert.equal(bootOf(await pageOf(new Client(), 'none')).me.user, null, 'typed in or a bookmark without a session: not signed in, no extra request');
  assert.equal(bootOf(await pageOf(new Client(), 'cross-site')), null, 'from a link on another site the cookie may be held back: the page asks');
  const realName = app.db.get('SELECT name FROM users WHERE id = ?', hb.me.user.id).name;
  app.db.run('UPDATE users SET name = ? WHERE id = ?', '</script><img src=x onerror=alert(1)>', hb.me.user.id);
  const evil = await pageOf(H);
  assert.ok(!evil.includes('</script><img'), 'a name cannot end the data block');
  assert.equal(bootOf(evil).me.user.name, '</script><img src=x onerror=alert(1)>');
  app.db.run('UPDATE users SET name = ? WHERE id = ?', realName, hb.me.user.id);
  // Through the VPS entrance: the visitor's IP comes from the VPS's header, and only from the VPS.
  Object.assign(cfg, { trustProxy: true, relayIps: ['100.64.0.9'] });
  const failedFrom = async (xff, claimed) => {
    const login = 'relay-' + crypto.randomBytes(4).toString('hex');
    await fetch(base + '/api/login', { method: 'POST', headers: { 'x-requested-with': 'fetch', 'content-type': 'application/json', 'x-forwarded-for': xff, 'x-relay-client-ip': claimed }, body: JSON.stringify({ login, password: 'x' }) });
    return app.db.get('SELECT ip FROM audit WHERE target = ? ORDER BY id DESC', login)?.ip;
  };
  assert.equal(await failedFrom('100.64.0.9', '203.0.113.7'), '203.0.113.7', 'the VPS says whose request it passes on');
  assert.equal(await failedFrom('198.51.100.4', '203.0.113.7'), '198.51.100.4', 'anyone else saying so is ignored');
  assert.equal(await failedFrom('100.64.0.9', 'not an address'), '100.64.0.9', 'nonsense is ignored');
  Object.assign(cfg, { trustProxy: false, relayIps: [] });
  assert.equal(await rawRequest('/api/me', { host: 'evil.example' }), 421);
  assert.equal(await rawRequest('/api/me', { host: `127.0.0.1:${server.address().port}` }), 200);
  const minFree = cfg.minFree;
  cfg.minFree = Number.MAX_SAFE_INTEGER;
  assert.equal((await H.upload(forContractor, 'disk.bin', 'x')).status, 507);
  cfg.minFree = minFree;
  ok(await H.upload(forContractor, 'disk.bin', 'x'));
  await app.housekeeping();
  pass('Names, path length, file size, quota, CSRF, cross-site requests, unsafe file types, ranges, login lockout, headers');
  pass('Unknown Host headers are refused; uploads stop before the disk is full');

  const dlFiles = cfg.dlFiles;
  cfg.dlFiles = 3;
  const dlBytes = cfg.dlBytes;
  const D = M;
  const four = [doc];
  for (const n of ['a', 'b', 'c']) four.push(ok(await H.upload(forContractor, `four-${n}.txt`, 'xxxx')).id);
  ok(await D.get(`/api/nodes/${four[0]}/content`));
  ok(await D.req('GET', `/api/nodes/${four[1]}/content`, { headers: { range: 'bytes=1-' } }), 206);
  ok(await D.get(`/api/nodes/${four[2]}/content?inline=1`));
  for (const how of [{}, { headers: { range: 'bytes=1-' } }]) assert.equal((await D.req('GET', `/api/nodes/${four[3]}/content`, how)).status, 429, 'whole, ranged or preview: a 4th file is refused');
  assert.equal((await D.get(`/api/nodes/${four[3]}/content?inline=1`)).status, 429);
  assert.equal((await D.req('GET', `/api/nodes/${doc}/content`, { headers: { range: 'bytes=1-' } })).status, 206, 'a file already fetched this hour can be fetched again');
  const fileLog = ok(await M.get('/api/audit?cat=file')).rows;
  for (const [id, what] of [[four[1], 'downloaded'], [four[2], 'downloaded']])
    assert.ok(fileLog.some(e => e.action === what && e.target.endsWith(app.db.get('SELECT name FROM nodes WHERE id = ?', id).name)), 'ranged downloads and inline fetches of non-previewable files are logged');
  assert.ok(!fileLog.some(e => e.target.endsWith('four-c.txt') && /downloaded|opened/.test(e.action)), 'a refused download is not logged as one');
  cfg.dlBytes = 8;
  assert.equal((await D.req('GET', `/api/nodes/${doc}/content`, { headers: { range: 'bytes=1-' } })).status, 429);
  assert.ok(ok(await D.get('/api/audit?cat=file')).rows.some(e => e.action.startsWith('ALERT download limit')));
  Object.assign(cfg, { dlFiles, dlBytes });
  pass('Bulk downloads pause after the hourly limit (ranges counted by bytes) and raise an alert for Managers');
  pass('Login lockout is per person and machine; old versions count toward quotas');
  const robots = await fetch(`${base}/robots.txt`);
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get('x-robots-tag'), /noindex/);

  const l3 = ok(await H.post(`/api/nodes/${forContractor}/links`, { password: 'longenough', days: 3 }));
  const t3 = l3.url.split('/s/')[1];
  const guest3 = new Client();
  ok(await guest3.post(`/api/public/${t3}/unlock`, { password: l3.password }));
  ok(await guest3.get(`/api/public/${t3}/items`));
  ok(await admin.patch(`/api/admin/users/${head.id}`, { disabled: true }));
  assert.equal((await guest3.get(`/api/public/${t3}/items`)).status, 404, 'links stop when their creator is blocked');
  ok(await admin.patch(`/api/admin/users/${head.id}`, { disabled: false }));
  ok(await guest3.get(`/api/public/${t3}/items`));
  pass('External links stop working while their creator is blocked');

  const gone = await mk('x.leaver', 'Xenia Leaver');
  ok(await admin.put(`/api/admin/groups/${gid('Engineering')}/members`, { user_ids: [head.id, gone.id] }));
  const H2 = await signIn(head); // blocking the head above ended the old session
  ok(await H2.put(`/api/nodes/${drawings}/access`, { entries: [{ type: 'user', id: gone.id, level: 2 }] }));
  const X = await signIn(gone);
  ok(await X.get('/api/spaces'));
  assert.equal((await admin.del(`/api/admin/users/1`)).status, 400, 'an admin cannot delete itself');
  ok(await admin.del(`/api/admin/users/${gone.id}`));
  assert.equal((await X.get('/api/spaces')).status, 401, 'a deleted person is signed out everywhere');
  assert.equal((await new Client().post('/api/login', { login: 'x.leaver', password: gone.password })).status, 401);
  assert.ok(!ok(await admin.get('/api/admin/users')).some(u => u.id === gone.id), 'gone from People');
  assert.ok(!ok(await admin.get('/api/admin/groups')).find(g => g.name === 'Engineering').members.some(m => m.id === gone.id), 'gone from groups');
  assert.ok(!ok(await H2.get(`/api/nodes/${drawings}/access`)).own.some(e => e.id === gone.id && e.type === 'user'), 'gone from folder access');
  assert.ok(!ok(await admin.get('/api/directory')).users.some(u => u.id === gone.id));
  assert.ok(app.db.get(`SELECT deleted_at FROM nodes WHERE parent_id = ? AND name = 'x.leaver'`, app.db.ids.roots.personal).deleted_at, 'personal folder goes to trash');
  assert.ok(ok(await admin.get('/api/audit?cat=alerts')).rows.some(e => e.action.startsWith('ALERT deleted account') && e.target.includes('Xenia Leaver')));
  ok(await admin.post('/api/admin/users', { login: 'x.leaver', name: 'New Xenia' }));
  pass('An admin can delete an account: signed out, removed from groups and access, personal folder to trash, login reusable, history keeps the name');

  const roleOf = async id => { const u = ok(await admin.get('/api/admin/users')).find(x => x.id === id); return u.is_admin ? 'admin' : u.manager ? 'manager' : 'employee'; };
  const boss = { ...ok(await admin.post('/api/admin/users', { login: 'r.boss', name: 'Rustem Boss', role: 'manager' })), login: 'r.boss' };
  assert.equal(await roleOf(boss.id), 'manager');
  assert.equal(ok(await new Client().post('/api/login', { login: 'r.boss', password: boss.password })).stage, 'change', 'a new Manager only replaces the temporary password');
  const it2 = ok(await admin.post('/api/admin/users', { login: 'it.two', name: 'IT Two', role: 'admin' }));
  assert.equal(await roleOf(it2.id), 'admin');
  assert.equal((await admin.post('/api/admin/users', { login: 'r.bad', name: 'Bad', role: 'owner' })).status, 400);
  ok(await admin.patch(`/api/admin/users/${boss.id}`, { role: 'employee' }));
  assert.equal(await roleOf(boss.id), 'employee');
  ok(await admin.patch(`/api/admin/users/${eng.id}`, { role: 'manager' }));
  assert.equal(await roleOf(eng.id), 'manager');
  assert.ok(ok(await admin.get('/api/admin/groups')).find(g => g.name === 'Managers').members.some(m => m.id === eng.id));
  assert.ok(ok(await admin.get('/api/audit?cat=alerts')).rows.some(e => e.action === 'ALERT role changed to Manager' && e.target.includes('Erlan')));
  assert.equal((await admin.patch(`/api/admin/users/1`, { role: 'manager' })).status, 400, 'IT admin stays IT admin');
  assert.equal((await admin.patch(`/api/admin/users/${eng.id}`, { role: 'admin' })).status, 400, 'no promotion to IT admin');
  assert.equal((await admin.patch(`/api/admin/users/${gone.id}`, { role: 'manager' })).status, 404, 'deleted accounts cannot be changed');
  ok(await admin.patch(`/api/admin/users/${eng.id}`, { role: 'employee' }));
  ok(await admin.patch(`/api/admin/users/${boss.id}`, { role: 'manager' }));
  pass('IT picks the role when creating an account and can switch Employee and Manager later');

  const owner = await mk('p.owner', 'Pavel Owner'), friend = await mk('p.friend', 'Fatima Friend');
  const PO = await signIn(owner), PF = await signIn(friend);
  const home = space(await spaces(PO), 'p.owner');
  assert.equal(home.level, 3, 'owners manage their personal folder');
  app.db.run('UPDATE acl SET level = 2 WHERE node_id = ? AND user_id = ?', home.id, owner.id); // as in older databases
  openDb(dataDir).raw.close();
  assert.equal(space(await spaces(PO), 'p.owner').level, 3, 'older personal folders are upgraded on start');
  const passport = ok(await PO.upload(home.id, 'passport.pdf', '%PDF-1.4 mine')).id;
  const docs = ok(await PO.post(`/api/nodes/${home.id}/folders`, { name: 'Docs' })).id;
  assert.equal((await PF.get(`/api/nodes/${passport}`)).status, 404);
  ok(await PO.put(`/api/nodes/${passport}/access`, { entries: [{ type: 'user', id: friend.id, level: 1 }, { type: 'group', id: app.db.ids.everyone, level: 1 }] }));
  assert.deepEqual(ok(await PO.get(`/api/nodes/${passport}/access`)).own.map(e => e.type), ['user'], 'personal items go to named people, never groups');
  assert.equal(ok(await PF.get(`/api/nodes/${passport}/content`)).toString(), '%PDF-1.4 mine');
  assert.equal((await PF.get(`/api/nodes/${home.id}`)).status, 404, 'sharing one file does not open the folder');
  assert.ok(ok(await PF.get('/api/shared')).some(x => x.id === passport && x.location.includes('p.owner')));
  assert.equal((await PF.put(`/api/nodes/${passport}/access`, { entries: [] })).status, 403);
  assert.equal((await M.get(`/api/nodes/${home.id}`)).status, 404, 'Managers do not see personal folders');
  ok(await PO.put(`/api/nodes/${docs}/access`, { entries: [{ type: 'user', id: friend.id, level: 2 }] }));
  ok(await PF.upload(docs, 'from-friend.txt', 'hi'));
  const mine = ok(await PO.upload(docs, 'mine.txt', 'owner only')).id;
  ok(await PO.put(`/api/nodes/${mine}/access`, { restricted: true, entries: [] }));
  assert.equal((await PF.upload(docs, 'mine.txt', 'overwritten')).status, 409, 'a restricted file cannot be replaced by uploading over it from its folder');
  assert.equal(ok(await PO.get(`/api/nodes/${mine}/content`)).toString(), 'owner only');
  const friendHome = space(await spaces(PF), 'p.friend').id;
  assert.equal((await PF.patch(`/api/nodes/${docs}`, { parent_id: friendHome })).status, 403, 'people it is shared with cannot carry files off');
  ok(await PO.put(`/api/nodes/${passport}/access`, { entries: [] }));
  ok(await PO.put(`/api/nodes/${docs}/access`, { entries: [] }));
  assert.equal((await PF.get(`/api/nodes/${passport}/content`)).status, 404);
  assert.equal((await PF.get(`/api/nodes/${docs}`)).status, 404);
  assert.equal(ok(await PF.get('/api/shared')).length, 0);
  const one = ok(await H2.upload(drawings, 'for-friend.txt', 'only this')).id;
  ok(await H2.put(`/api/nodes/${one}/access`, { entries: [{ type: 'user', id: friend.id, level: 1 }] }));
  assert.equal(ok(await PF.get(`/api/nodes/${one}/content`)).toString(), 'only this');
  assert.equal((await PF.get(`/api/nodes/${drawings}`)).status, 404);
  pass('People share one file or a whole folder (personal ones too) with chosen people and take it back; it shows under Shared with me');

  const general = app.db.ids.roots.general;
  const newbie = await mk('n.newbie', 'Nurlan Newbie');
  const NB = await signIn(newbie);
  assert.deepEqual((await spaces(NB)).map(s => `${s.area}:${s.name}`), ['departments:Leak', 'personal:n.newbie'], 'a new employee sees their own folder and what was shared with Everyone on purpose');
  assert.equal((await NB.get(`/api/nodes/${general}`)).status, 404, '01 General is closed until someone gives access');
  const ga = ok(await M.get(`/api/nodes/${general}/access`));
  assert.ok(ga.editable && ga.lockedManagers, 'a Manager edits access to a section; the Managers group stays as IT set it');
  ok(await M.put(`/api/nodes/${general}/access`, { entries: [{ type: 'user', id: newbie.id, level: 1 }] }));
  assert.ok(ok(await NB.get(`/api/nodes/${general}`)).node.level === 1, 'a Manager opens a section to one person');
  assert.ok(ok(await M.get(`/api/nodes/${general}/access`)).own.some(e => e.kind === 'managers'), 'Managers cannot lock themselves out');
  ok(await M.put(`/api/nodes/${one}/access`, { entries: [{ type: 'user', id: newbie.id, level: 1 }] }));
  assert.equal(ok(await NB.get(`/api/nodes/${one}/content`)).toString(), 'only this', 'a Manager shares a single file');
  ok(await M.put(`/api/nodes/${general}/access`, { entries: [] }));
  assert.equal((await NB.get(`/api/nodes/${general}`)).status, 404, 'and takes it back');
  assert.equal((await M.put(`/api/nodes/${home.id}/access`, { entries: [] })).status, 404, 'Managers stay out of personal folders');
  app.db.run('INSERT INTO acl(node_id, group_id, level) VALUES(?, ?, 1)', general, app.db.ids.everyone);
  app.db.raw.exec('PRAGMA user_version = 0'); // a database from before this change
  openDb(dataDir).raw.close();
  assert.equal((await NB.get(`/api/nodes/${general}`)).status, 404, 'the old automatic Everyone access to 01 General is removed once');
  app.db.run('INSERT INTO acl(node_id, group_id, level) VALUES(?, ?, 1)', general, app.db.ids.everyone);
  openDb(dataDir).raw.close();
  assert.equal(ok(await NB.get(`/api/nodes/${general}`)).node.level, 1, 'an Everyone grant a Manager adds later survives restarts');
  app.db.run('DELETE FROM acl WHERE node_id = ? AND group_id = ?', general, app.db.ids.everyone);
  pass('Sections, folders and files stay closed until a Manager (or IT) gives access; personal folders work as before');

  const junk = ok(await PO.upload(home.id, 'junk.txt', 'bye')).id;
  const junkBlob = app.db.get('SELECT blob FROM nodes WHERE id = ?', junk).blob;
  ok(await PO.del(`/api/nodes/${junk}`));
  assert.equal((await PF.del(`/api/trash/${junk}`)).status, 404, 'nobody else can erase it');
  ok(await PO.del(`/api/trash/${junk}`));
  assert.ok(!ok(await PO.get('/api/trash')).some(x => x.id === junk));
  assert.equal((await PO.post(`/api/trash/${junk}/restore`)).status, 404);
  assert.ok(!app.db.get('SELECT 1 FROM nodes WHERE id = ?', junk) && !fs.existsSync(path.join(dataDir, 'blobs', junkBlob.slice(0, 2), junkBlob)), 'the file is gone from disk');
  const box = ok(await H2.post(`/api/nodes/${engDir.id}/folders`, { name: 'Box' })).id;
  const inner = ok(await H2.post(`/api/nodes/${box}/folders`, { name: 'Inner' })).id;
  ok(await H2.put(`/api/nodes/${inner}/access`, { restricted: true, entries: [] }));
  ok(await H2.del(`/api/nodes/${box}`));
  ok(await admin.put(`/api/admin/groups/${gid('Engineering')}/members`, { user_ids: [head.id, newbie.id] }));
  assert.ok(ok(await NB.get('/api/trash')).some(x => x.id === box), 'a member sees the deleted folder');
  assert.equal((await NB.del(`/api/trash/${box}`)).status, 403, 'but cannot erase restricted folders hidden inside');
  ok(await H2.del(`/api/trash/${box}`));
  pass('Trash: Delete forever erases at once, with versions and files on disk; only for those who may restore it');

  // ---- online editor: Collabora calls the WOPI routes with a file token (no cookies, no CSRF header) ----
  const officeSrv = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const got = Buffer.concat(chunks);
    // Stand-ins for the PDF->DOCX converter and Collabora's DOCX->PDF conversion.
    if (req.url === '/pdf2docx') return res.end(Buffer.concat([Buffer.from('DOCX<'), got, Buffer.from('>')]));
    if (req.url === '/cool/convert-to/pdf') return res.end(`%PDF-from ${/DOCX-EDIT:[^\r\n-]*/.exec(got.toString('latin1'))?.[0] ?? '?'}`);
    // Stand-ins for the PDF editor's inspect (page images + text lines) and apply (edits written into the PDF).
    if (req.url === '/inspect') return res.end(JSON.stringify({ pages: [{ width: 595, height: 842, rotated: false, image: Buffer.from(`PNG of ${got.length} bytes`).toString('base64'), mime: 'image/png', spans: [{ text: 'Old line', bbox: [72, 100, 200, 114], origin: [72, 111], size: 12, color: [0, 0, 0], family: 'sans', bold: false, italic: false }] }] }));
    if (req.url === '/apply') return res.end(`%PDF-applied ${got.subarray(0, got.indexOf(10)).toString()}`);
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(`<wopi-discovery><net-zone name="external-https"><app name="writer"><action default="true" ext="docx" name="edit" urlsrc="${officeOrigin}/browser/abc/cool.html?"/></app><app name="calc"><action ext="xlsx" name="edit" urlsrc="https://evil.example/cool.html?"/></app><app name="draw"><action ext="pdf" name="view_comment" urlsrc="${officeOrigin}/browser/abc/cool.html?"/></app></net-zone></wopi-discovery>`);
  });
  await new Promise(r => officeSrv.listen(0, '127.0.0.1', r));
  officeSrv.unref();
  const officeOrigin = `http://127.0.0.1:${officeSrv.address().port}`;
  const report = ok(await PO.upload(home.id, 'report.docx', 'v1')).id;
  assert.equal((await PO.post(`/api/nodes/${report}/editor`)).status, 404, 'no editor until OFFICE_URL is set');
  cfg.officeUrl = officeOrigin;
  assert.equal(ok(await PO.get('/api/me')).office, true);
  const ed = ok(await PO.post(`/api/nodes/${report}/editor`));
  assert.ok(ed.url.startsWith(`${officeOrigin}/browser/abc/cool.html?WOPISrc=`) && ed.edit && ed.ttl > Date.now());
  const src = new URL(decodeURIComponent(ed.url.split('WOPISrc=')[1])).pathname;
  assert.equal(src, `/api/wopi/files/${report}`);
  const wopiUrl = cfg.wopiUrl;
  cfg.wopiUrl = 'http://company-files-tailscale:8801';
  assert.ok(decodeURIComponent(ok(await PO.post(`/api/nodes/${report}/editor`)).url).includes(`WOPISrc=http://company-files-tailscale:8801/api/wopi/files/${report}`), 'the editor is pointed at the internal WOPI address');
  cfg.wopiUrl = wopiUrl;
  const wopi = async (p, tok, init) => {
    const r = await fetch(`${base}${p}?access_token=${encodeURIComponent(tok)}`, init);
    return { status: r.status, data: (r.headers.get('content-type') || '').includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  const save = (body, tok = ed.token, headers = {}) => wopi(`${src}/contents`, tok, { method: 'POST', body, headers: { 'x-wopi-override': 'PUT', 'content-type': 'application/octet-stream', ...headers } });
  const info = ok(await wopi(src, ed.token));
  assert.equal(info.BaseFileName, 'report.docx');
  assert.equal(info.UserCanWrite, true);
  assert.equal(ok(await wopi(`${src}/contents`, ed.token)).toString(), 'v1');
  const lm = ok(await save('v2')).LastModifiedTime;
  ok(await save('v3', ed.token, { 'x-cool-wopi-timestamp': lm }));
  assert.equal(ok(await PO.get(`/api/nodes/${report}/content`)).toString(), 'v3');
  let edVers = ok(await PO.get(`/api/nodes/${report}/versions`));
  assert.equal(edVers.length, 1, 'autosaves of one editing run make one version, not one per save');
  assert.equal(ok(await PO.get(`/api/versions/${edVers[0].id}/content`)).toString(), 'v1', 'the file as it was before editing stays in Versions');
  ok(await PO.upload(home.id, 'report.docx', 'v4 uploaded'));
  assert.equal(ok(await save('v5', ed.token, { 'x-cool-wopi-timestamp': lm }), 409).COOLStatusCode, 1010, 'a save over a newer upload asks first');
  ok(await save('v5'));
  edVers = ok(await PO.get(`/api/nodes/${report}/versions`));
  assert.deepEqual(await Promise.all(edVers.map(async v => ok(await PO.get(`/api/versions/${v.id}/content`)).toString())), ['v4 uploaded', 'v3', 'v1']);
  assert.equal(app.db.get(`SELECT COUNT(*) n FROM audit WHERE node_id = ? AND action = 'edited in the editor'`, report).n, 2);
  const [uid, nid, exp, sid, sig] = ed.token.split('.');
  assert.equal((await wopi(src, [friend.id, nid, exp, sid, sig].join('.'))).status, 401, 'a token cannot be re-pointed at another person');
  assert.equal((await wopi(`/api/wopi/files/${mine}`, ed.token)).status, 401, 'or at another file');
  assert.equal((await wopi(src, [uid, nid, Date.now() - 1, sid, sig].join('.'))).status, 401);
  ok(await PO.put(`/api/nodes/${report}/access`, { entries: [{ type: 'user', id: friend.id, level: 1 }] }));
  const PF2 = await signIn(friend);
  const ro = ok(await PF2.post(`/api/nodes/${report}/editor`));
  assert.equal(ro.edit, false);
  assert.equal(ok(await wopi(src, ro.token)).UserCanWrite, false);
  assert.equal((await save('hijack', ro.token)).status, 403, 'Read access opens view-only');
  ok(await PO.put(`/api/nodes/${report}/access`, { entries: [] }));
  assert.equal((await wopi(src, ro.token)).status, 404, 'taking access away ends editing at once');
  ok(await PO.put(`/api/nodes/${report}/access`, { entries: [{ type: 'user', id: friend.id, level: 2 }] }));
  ok(await wopi(src, ro.token));
  ok(await PF2.post('/api/logout'));
  assert.equal((await wopi(src, ro.token)).status, 401, 'signing out ends editing');
  const sheet = ok(await PO.upload(home.id, 'budget.xlsx', 'x')).id;
  assert.ok(ok(await PO.post(`/api/nodes/${sheet}/editor`)).url.startsWith(`${officeOrigin}/cool.html?WOPISrc=`), 'browsers are only ever sent to OFFICE_URL, whatever host discovery names');
  const pdf = ok(await PO.upload(home.id, 'contract.pdf', '%PDF-1.4 original')).id;
  assert.equal(ok(await PO.get('/api/me')).pdfEdit, false, 'PDF editing needs the converter');
  cfg.pdfConverter = officeOrigin;
  const pe = ok(await PO.post(`/api/nodes/${pdf}/editor`));
  assert.ok(pe.pdf && pe.edit && decodeURIComponent(pe.url).includes(`/api/wopi/files/p${pdf}`), 'a PDF opens as an editable document');
  const psrc = `/api/wopi/files/p${pdf}`;
  const pinfo = ok(await wopi(psrc, pe.token));
  assert.equal(pinfo.BaseFileName, 'contract.docx');
  assert.equal(ok(await wopi(`${psrc}/contents`, pe.token)).toString(), 'DOCX<%PDF-1.4 original>');
  const plm = ok(await wopi(`${psrc}/contents`, pe.token, { method: 'POST', body: 'DOCX-EDIT:changed', headers: { 'x-cool-wopi-timestamp': pinfo.LastModifiedTime } })).LastModifiedTime;
  assert.equal(ok(await PO.get(`/api/nodes/${pdf}/content`)).toString(), '%PDF-from DOCX-EDIT:changed', 'saves land in the PDF itself');
  assert.equal(ok(await PO.get(`/api/nodes/${pdf}`)).node.name, 'contract.pdf');
  assert.equal(ok(await PO.get(`/api/nodes/${pdf}/versions`)).length, 0, 'PDF saves go straight into the file, no version');
  assert.equal(ok(await wopi(`${psrc}/contents`, pe.token)).toString(), 'DOCX-EDIT:changed', 'the shared work copy follows the saves');
  ok(await wopi(`${psrc}/contents`, pe.token, { method: 'POST', body: 'DOCX-EDIT:again', headers: { 'x-cool-wopi-timestamp': plm } }));
  assert.equal(ok(await PO.get(`/api/nodes/${pdf}/versions`)).length, 0);
  const blobsOnDisk = () => fs.readdirSync(path.join(dataDir, 'blobs')).reduce((n, d) => n + fs.readdirSync(path.join(dataDir, 'blobs', d)).length, 0);
  ok(await PO.upload(home.id, 'contract.pdf', '%PDF-1.4 replaced by upload'));
  assert.equal(ok(await wopi(`${psrc}/contents`, pe.token, { method: 'POST', body: 'DOCX-EDIT:stale', headers: { 'x-cool-wopi-timestamp': plm } }), 409).COOLStatusCode, 1010, 'a newer upload is not overwritten silently');
  assert.equal((await wopi(`/api/wopi/files/${pdf}`, pe.token)).status, 401, 'a work-copy token does not open the PDF itself');
  ok(await PO.put(`/api/nodes/${pdf}/access`, { entries: [{ type: 'user', id: friend.id, level: 1 }] }));
  const PF3 = await signIn(friend);
  const pro = ok(await PF3.post(`/api/nodes/${pdf}/editor`));
  assert.ok(!pro.pdf && !pro.edit, 'with Read, a PDF is only viewed');
  assert.equal((await wopi(psrc, [friend.id, ...pro.token.split('.').slice(1)].join('.'))).status, 401);
  const txt = ok(await PO.upload(home.id, 'notes.txt', 'x')).id;
  assert.equal((await PO.post(`/api/nodes/${txt}/editor`)).status, 400, 'types the editor does not list are refused');
  assert.equal(ok(await PO.get(`/api/nodes/${report}/content`)).toString(), 'v5');
  // The PDF editor that keeps pages as they are.
  ok(await PO.put(`/api/nodes/${pdf}/access`, { entries: [{ type: 'user', id: friend.id, level: 1 }] }));
  const pv2 = ok(await PO.post(`/api/nodes/${pdf}/pdf-edit`));
  assert.equal(pv2.pages[0].spans[0].text, 'Old line');
  assert.ok(!('image' in pv2.pages[0]), 'page images come separately');
  const img = await PO.req('GET', `/api/nodes/${pdf}/pdf-page/0?v=${pv2.version}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await PO.get(`/api/nodes/${pdf}/pdf-page/0?v=1`)).status, 404, 'only images of the version that was opened');
  assert.equal((await PF3.post(`/api/nodes/${pdf}/pdf-edit`)).status, 403, 'with Read, a PDF is only viewed');
  assert.equal((await PF3.get(`/api/nodes/${pdf}/pdf-page/0?v=${pv2.version}`)).status, 403);
  const changes = [
    { type: 'replace', page: 0, bbox: [72, 100, 200, 114], origin: [72, 111], text: 'New line', size: 12, color: [0, 0, 0], family: 'sans' },
    { type: 'add', page: 0, origin: [72, 300], text: '19.11.2026', size: 11, color: [0, 0, 0] },
    { type: 'erase', page: 0, bbox: [72, 400, 300, 414] },
  ];
  const versionsBefore = ok(await PO.get(`/api/nodes/${pdf}/versions`)).length; // one, from the upload above
  const blobsBefore = blobsOnDisk();
  const savedPdf = ok(await PO.post(`/api/nodes/${pdf}/pdf-edit/save`, { version: pv2.version, edits: changes }));
  const afterPdf = ok(await PO.get(`/api/nodes/${pdf}/content`)).toString();
  assert.ok(afterPdf.startsWith('%PDF-applied [') && afterPdf.includes('"New line"') && afterPdf.includes('"19.11.2026"') && afterPdf.includes('"erase"'), 'changes are written into the PDF itself');
  assert.equal(ok(await PO.get(`/api/nodes/${pdf}/versions`)).length, versionsBefore, 'saving does not add a version');
  assert.equal(blobsOnDisk(), blobsBefore, 'the old content is replaced on disk, not kept');
  assert.equal((await PO.post(`/api/nodes/${pdf}/pdf-edit/save`, { version: pv2.version, edits: changes })).status, 409, 'changes made on an older version are not written over a newer one');
  assert.equal((await PO.post(`/api/nodes/${pdf}/pdf-edit/save`, { version: savedPdf.version, edits: [{ type: 'replace', page: 0, bbox: [1, 2], text: 'x' }] })).status, 400, 'malformed changes are refused');
  assert.ok(app.db.get(`SELECT 1 FROM audit WHERE action = 'edited in the PDF editor (3 changes)' AND node_id = ?`, pdf));
  // The PDF viewer (EmbedPDF): its own page with its own CSP, its files from this server, saves as new versions.
  const vpage = await fetch(`${base}/viewer.html`);
  assert.match(vpage.headers.get('content-security-policy'), /script-src 'self' 'wasm-unsafe-eval'/, 'only the viewer page may run WebAssembly');
  assert.doesNotMatch((await fetch(`${base}/`)).headers.get('content-security-policy'), /wasm-unsafe-eval|unsafe-inline/, 'the rest of Files keeps the strict CSP');
  const wasm = await fetch(`${base}/vendor/embedpdf-2.15.1/pdfium.wasm`);
  assert.equal(wasm.headers.get('content-type'), 'application/wasm');
  assert.match(wasm.headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(`${base}/vendor/embedpdf-2.15.1/..%2F..%2F..%2Fserver.mjs`)).status, 404);
  const appjs = await fetch(`${base}/app.js`);
  const etag = appjs.headers.get('etag');
  assert.ok(etag && appjs.headers.get('vary') === 'Accept-Encoding');
  assert.equal((await fetch(`${base}/app.js`, { headers: { 'if-none-match': etag } })).status, 304, 'unchanged files are not downloaded again');
  const putPdf = (c, body, v) => c.req('PUT', `/api/nodes/${pdf}/content`, { raw: Buffer.from(body), headers: { 'content-type': 'application/pdf', 'x-base-version': String(v) } });
  const cur = ok(await PO.get(`/api/nodes/${pdf}`)).node.updated_at;
  assert.equal((await putPdf(PO, '%PDF-1.7 signed', cur - 1)).status, 409, 'saving over a newer version is refused');
  assert.equal((await putPdf(PO, 'not a pdf at all', cur)).status, 400, 'only PDFs are accepted');
  assert.equal((await putPdf(PF3, '%PDF-1.7 signed', cur)).status, 403, 'Read access cannot save');
  const vBefore = ok(await PO.get(`/api/nodes/${pdf}/versions`)).length;
  const vs = ok(await putPdf(PO, '%PDF-1.7 signed in the viewer', cur));
  assert.ok(vs.version > cur);
  assert.equal(ok(await PO.get(`/api/nodes/${pdf}/versions`)).length, vBefore, 'the viewer saves into the same file, no version');
  assert.equal(ok(await PO.get(`/api/nodes/${pdf}/content`)).toString(), '%PDF-1.7 signed in the viewer');
  assert.ok(app.db.get(`SELECT 1 FROM audit WHERE action = 'edited in the PDF viewer' AND node_id = ?`, pdf));
  Object.assign(cfg, { officeUrl: null, pdfConverter: null });
  officeSrv.close();

  // ---- auto-save to computers: pairing, the agent's token, its WebSocket, the queue ----
  server.on('upgrade', app.upgrade);
  const agent = async (method, url, token, json) => {
    const r = await fetch(base + url, { method, headers: { authorization: `Bearer ${token}`, ...(json ? { 'content-type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
    return { status: r.status, data: (r.headers.get('content-type') || '').includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  assert.equal((await PO.post('/api/devices/send', { ids: [passport] })).status, 400, 'nothing to send to before a computer is connected');
  const pc = ok(await PO.post('/api/devices/pair-code'));
  assert.match(pc.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(pc.link.startsWith(`myfiles://pair?code=${pc.code}&server=`));
  const anon = new Client();
  assert.equal(ok(await anon.post('/api/agent/pair-info', { code: pc.code.toLowerCase() })).user.login, 'p.owner', 'the agent shows whose account it is about to join');
  const paired = ok(await anon.post('/api/agent/pair', { code: pc.code, name: 'Pavel laptop', os: 'windows' }));
  assert.equal((await anon.post('/api/agent/pair', { code: pc.code, name: 'again' })).status, 404, 'a code works once');
  const devTok = paired.token;
  assert.equal(ok(await agent('GET', '/api/agent/me', devTok)).user.login, 'p.owner');
  assert.equal((await agent('GET', '/api/agent/me', 'x'.repeat(43))).status, 401);
  assert.equal((await agent('GET', `/api/nodes/${home.id}`, devTok)).status, 401, 'an agent token cannot browse files');
  assert.ok(app.db.get(`SELECT 1 FROM audit WHERE action LIKE 'ALERT computer connected for auto-save: Pavel laptop%'`));
  // The WebSocket: a raw upgrade, then the server's text frames.
  const ws = await new Promise((res, rej) => {
    const rq = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/agent/ws', headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': crypto.randomBytes(16).toString('base64'), authorization: `Bearer ${devTok}` } });
    rq.on('upgrade', (_res, socket, head) => res(Object.assign(socket, { head }))).on('response', r => rej(new Error(`no upgrade: ${r.statusCode}`))).on('error', rej).end();
  });
  const pushed = [];
  const frames = d => { for (let i = 0; i + 2 <= d.length; i += 2 + d[i + 1]) if ((d[i] & 15) === 1) pushed.push(JSON.parse(d.subarray(i + 2, i + 2 + d[i + 1]).toString())); };
  frames(ws.head); // the first frame can arrive together with the handshake
  ws.on('data', frames);
  await pause(100);
  assert.deepEqual(pushed.slice(-2), [{ type: 'queue' }, { type: 'mirror' }], 'on connect the agent is told to check its queue and My files');
  assert.deepEqual(ok(await PO.get('/api/devices')).map(d => [d.name, d.online]), [['Pavel laptop', true]]);
  const badWs = await new Promise(res => http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/agent/ws', headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'x', authorization: 'Bearer nope-nope-nope-nope-nope' } }).on('response', r => res(r.statusCode)).on('upgrade', () => res(101)).end());
  assert.equal(badWs, 401, 'no WebSocket without a valid token');
  const sentNow = ok(await PO.post('/api/devices/send', { ids: [docs, passport] }));
  assert.deepEqual(sentNow.devices, ['Pavel laptop']);
  await pause(100);
  assert.equal(pushed.filter(p => p.type === 'queue').length, 2, 'sending pushes a queue notice at once');
  let aq = ok(await agent('GET', '/api/agent/queue', devTok));
  assert.ok(aq.some(x => x.path === 'Docs/from-friend.txt') && aq.some(x => x.path === 'passport.pdf'), 'folders keep their structure');
  const one1 = aq.find(x => x.path === 'passport.pdf');
  assert.equal(ok(await agent('GET', `/api/agent/files/${one1.id}`, devTok)).toString(), '%PDF-1.4 mine');
  ok(await agent('POST', `/api/agent/files/${one1.id}/done`, devTok, { result: 'saved' }));
  assert.ok(!ok(await agent('GET', '/api/agent/queue', devTok)).some(x => x.id === one1.id), 'saved files leave the queue');
  assert.ok(app.db.get(`SELECT 1 FROM audit WHERE action = 'saved to computer "Pavel laptop"' AND node_id = ?`, passport));

  // My files kept in sync both ways: any change in the personal folder pushes "mirror"; the agent lists and
  // fetches, and sends its own changes back (a new file, an edit based on the version it had, a deletion).
  const mirrorPushes = () => pushed.filter(p => p.type === 'mirror').length;
  const mp = mirrorPushes();
  const mfile = ok(await PO.upload(home.id, 'mirror me.txt', 'from the website')).id;
  await pause(1300);
  assert.equal(mirrorPushes(), mp + 1, 'a change in My files tells the computer within a second');
  const ml = ok(await agent('GET', '/api/agent/mirror', devTok));
  const mi = ml.files.find(f => f.id === mfile);
  assert.ok(mi && mi.path === 'mirror me.txt' && mi.v && ml.since > 0, 'the list has the file, its path and its version');
  assert.ok(ml.files.some(f => f.path === 'Docs/from-friend.txt'), 'paths are relative to My files');
  const asAgent = (method, url, body) => fetch(base + url, { method, headers: { authorization: `Bearer ${devTok}`, ...(body ? { 'content-type': 'application/octet-stream' } : {}) }, body: body && Buffer.from(body) })
    .then(async r => ({ status: r.status, headers: r.headers, text: await r.text() }));
  const mget = await asAgent('GET', `/api/agent/mirror/${mfile}`);
  assert.ok(mget.text === 'from the website' && mget.headers.get('x-version') === mi.v);
  const notMine = ok(await PF3.upload(space(await spaces(PF3), 'p.friend').id, 'not yours.txt', 'x')).id;
  assert.equal((await asAgent('GET', `/api/agent/mirror/${notMine}`)).status, 404, 'files outside My files are not served');
  const putM = (q, text) => asAgent('PUT', `/api/agent/mirror/file?${new URLSearchParams(q)}`, text).then(r => ({ ...r, data: JSON.parse(r.text) }));
  const nf = await putM({ path: 'From laptop/notes#1.txt' }, 'typed on the laptop');
  assert.equal(nf.data.path, 'From laptop/notes_1.txt', 'a new file from the computer lands in a new folder; characters the website does not allow become "_"');
  assert.equal((await putM({ path: '../escape.txt' }, 'x')).data.path, 'file/escape.txt', 'paths cannot climb out of My files');
  const med = await putM({ id: mfile, base: mi.v }, 'edited on the laptop');
  assert.equal(ok(await PO.get(`/api/nodes/${mfile}/content`)).toString(), 'edited on the laptop');
  assert.ok(ok(await PO.get(`/api/nodes/${mfile}/versions`)).length >= 1, 'an edit from the computer is a new version');
  assert.equal((await putM({ id: mfile, base: mi.v }, 'stale')).status, 409, 'an edit of an older version never replaces a newer one');
  assert.equal((await asAgent('DELETE', `/api/agent/mirror/${mfile}?base=${mi.v}`)).status, 409, 'nor does a stale deletion');
  assert.equal((await asAgent('DELETE', `/api/agent/mirror/${mfile}?base=${med.data.v}`)).status, 200);
  assert.ok(ok(await PO.get('/api/trash')).some(t => t.id === mfile), 'deleted on the computer: in the website trash');
  assert.ok(app.db.get(`SELECT 1 FROM audit WHERE action = 'moved to trash (deleted on computer "Pavel laptop")' AND node_id = ?`, mfile));
  // folders: listed (empty ones too), made, renamed and moved as the same item, deleted only when empty
  const md = JSON.parse((await asAgent('POST', '/api/agent/mirror/dir?path=' + encodeURIComponent('Plans/2026/Empty one'))).text);
  assert.equal(md.path, 'Plans/2026/Empty one', 'a folder made on the computer, with its parents');
  const ml2 = ok(await agent('GET', '/api/agent/mirror', devTok));
  assert.ok(['Plans', 'Plans/2026', 'Plans/2026/Empty one', 'From laptop'].every(p => ml2.dirs.some(d => d.path === p)), 'the list has the folders, empty ones too');
  const plansDir = ml2.dirs.find(d => d.path === 'Plans').id;
  const mv = JSON.parse((await asAgent('POST', `/api/agent/mirror/move?dir=1&id=${plansDir}&path=${encodeURIComponent('Archive/Plans old')}`)).text);
  assert.equal(mv.id, plansDir);
  assert.equal(mv.path, 'Archive/Plans old', 'a folder renamed and moved on the computer: the same folder, renamed and moved here');
  assert.ok(ok(await agent('GET', '/api/agent/mirror', devTok)).dirs.some(d => d.path === 'Archive/Plans old/2026/Empty one'), 'its contents travel with it');
  const nfId = nf.data.id, nfV = JSON.parse((await asAgent('GET', '/api/agent/mirror')).text).files.find(f => f.id === nfId).v;
  const fmv = JSON.parse((await asAgent('POST', `/api/agent/mirror/move?id=${nfId}&base=${nfV}&path=${encodeURIComponent('Archive/notes renamed.txt')}`)).text);
  assert.ok(fmv.id === nfId && fmv.path === 'Archive/notes renamed.txt', 'a file renamed and moved: the same file (versions stay)');
  assert.equal((await asAgent('POST', `/api/agent/mirror/move?id=${nfId}&base=stale&path=x.txt`)).status, 409, 'not if it changed on the website meanwhile');
  assert.equal((await asAgent('POST', `/api/agent/mirror/move?dir=1&id=${plansDir}&path=${encodeURIComponent('Archive/Plans old/2026/inside')}`)).status, 400, 'a folder cannot go into itself');
  assert.equal((await asAgent('DELETE', `/api/agent/mirror/dir/${plansDir}`)).status, 409, 'a folder that still holds something is not deleted');
  const emptyOne = ok(await agent('GET', '/api/agent/mirror', devTok)).dirs.find(d => d.path.endsWith('Empty one')).id;
  assert.equal((await asAgent('DELETE', `/api/agent/mirror/dir/${emptyOne}`)).status, 200);
  assert.ok(ok(await PO.get('/api/trash')).some(t => t.id === emptyOne), 'an empty folder deleted on the computer: in the website trash');
  assert.equal((await asAgent('DELETE', `/api/agent/mirror/dir/${home.id}`)).status, 404, 'My files itself can never be deleted this way');
  pass('My files in sync both ways: changes push a notice, the agent lists and fetches its own folder only, its new files, edits, deletions, folders, renames and moves come back with version checks');

  // Files on demand: the whole tree this person can open, with the website's rules.
  const forPavel = ok(await PF3.post(`/api/nodes/${space(await spaces(PF3), 'p.friend').id}/folders`, { name: 'For Pavel' })).id;
  ok(await PF3.put(`/api/nodes/${forPavel}/access`, { entries: [{ type: 'user', id: owner.id, level: 1 }] }));
  ok(await PF3.upload(forPavel, 'read me.txt', 'shared, read only'));
  const roots = ok(await agent('GET', '/api/agent/cloud', devTok));
  const myRoot = roots.find(x => x.name === 'My files');
  const sharedRoot = roots.find(x => x.name === 'For Pavel');
  assert.ok(myRoot?.id === home.id && !myRoot.readOnly && sharedRoot?.readOnly, `the top level is what the website shows: ${roots.map(x => x.name + (x.readOnly ? ' (read only)' : '')).join(', ')}`);
  const sharedKids = ok(await agent('GET', `/api/agent/cloud/${forPavel}`, devTok));
  assert.ok(sharedKids.length === 1 && sharedKids[0].name === 'read me.txt' && sharedKids[0].readOnly && sharedKids[0].v);
  const rm = await asAgent('GET', `/api/agent/cloud/${sharedKids[0].id}/content`);
  assert.ok(rm.text === 'shared, read only' && rm.headers.get('x-version') === sharedKids[0].v, 'a file is fetched when it is opened');
  assert.equal((await asAgent('PUT', `/api/agent/cloud/${forPavel}/files?name=nope.txt`, 'x')).status, 403, 'read only stays read only');
  assert.equal((await asAgent('DELETE', `/api/agent/cloud/${sharedKids[0].id}`)).status, 403);
  const cNew = JSON.parse((await asAgent('PUT', `/api/agent/cloud/${home.id}/files?name=${encodeURIComponent('On demand?.txt')}`, 'one')).text);
  assert.ok(cNew.name === 'On demand_.txt' && cNew.v, 'a new file from the computer (name fitted)');
  assert.equal((await asAgent('PUT', `/api/agent/cloud/${home.id}/files?id=${cNew.id}&base=stale`, 'two')).status, 409, 'an edit of an older version is refused');
  const cV2 = JSON.parse((await asAgent('PUT', `/api/agent/cloud/${home.id}/files?id=${cNew.id}&base=${cNew.v}`, 'two')).text);
  assert.ok(cV2.id === cNew.id && cV2.v !== cNew.v, 'an edit becomes a new version of the same file');
  const cDir = JSON.parse((await asAgent('POST', `/api/agent/cloud/${home.id}/folders?name=Cloud%20folder`)).text);
  assert.equal(JSON.parse((await asAgent('POST', `/api/agent/cloud/${home.id}/folders?name=Cloud%20folder`)).text).id, cDir.id, 'making a folder that exists gives the same folder');
  const cMv = JSON.parse((await asAgent('POST', `/api/agent/cloud/${cNew.id}/move?parent=${cDir.id}&name=moved.txt&base=${cV2.v}`)).text);
  assert.ok(cMv.id === cNew.id && cMv.name === 'moved.txt' && ok(await agent('GET', `/api/agent/cloud/${cDir.id}`, devTok)).some(x => x.id === cNew.id), 'renamed and moved: the same file');
  assert.equal((await asAgent('POST', `/api/agent/cloud/${cNew.id}/move?parent=${forPavel}`)).status, 403, 'nothing moves into a read-only folder');
  assert.equal((await asAgent('DELETE', `/api/agent/cloud/${cDir.id}`)).status, 200);
  assert.ok(ok(await PO.get('/api/trash')).some(t => t.id === cDir.id), 'deleted on the computer: in the website trash');
  // the push: a computer that asked for it hears which folders changed
  const ws2 = await new Promise((res, rej) => {
    const rq = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/agent/ws?cloud=1', headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': crypto.randomBytes(16).toString('base64'), authorization: `Bearer ${devTok}` } });
    rq.on('upgrade', (_r, socket, head) => res(Object.assign(socket, { head }))).on('response', r => rej(new Error(`no upgrade: ${r.statusCode}`))).on('error', rej).end();
  });
  const cloudFrames = [];
  const grab = d => { for (let i = 0; i + 2 <= d.length; i += 2 + d[i + 1]) if ((d[i] & 15) === 1) cloudFrames.push(JSON.parse(d.subarray(i + 2, i + 2 + d[i + 1]).toString())); };
  grab(ws2.head);
  ws2.on('data', grab);
  ok(await PF3.upload(forPavel, 'new from friend.txt', 'hi'));
  await pause(1400);
  assert.ok(cloudFrames.some(f => f.type === 'cloud' && f.folders.includes(forPavel)), 'a change in a shared folder tells the computer which folder changed');
  assert.ok(!pushed.some(f => f.type === 'cloud'), 'agents that did not ask for it get no such notices');
  ws2.destroy();
  pass('Files on demand: the agent sees the website\'s tree (no confidential), fetches on open, read only stays read only, new files, versions, folders, moves and deletions with the website\'s rules, change notices per folder');

  // The Mac's File Provider: one item with its parent, and a change log of what changed since a point.
  const start = ok(await agent('GET', '/api/agent/cloud-changes', devTok)).anchor;
  assert.ok(Number.isSafeInteger(start) && start > 0, 'the change log has a current point');
  const myInfo = ok(await agent('GET', `/api/agent/cloud/${home.id}/info`, devTok));
  assert.ok(myInfo.name === 'My files' && myInfo.parent === 0, 'a place at the top level: its name there and no parent');
  const fpFile = ok(await PO.upload(home.id, 'for the mac.txt', 'hello mac')).id;
  const ch1 = ok(await agent('GET', `/api/agent/cloud-changes?since=${start}`, devTok));
  const seen = ch1.items.find(x => x.id === fpFile);
  assert.ok(seen && seen.parent === home.id && seen.v && ch1.anchor > start && !ch1.reset, 'a file added on the website is in the changes, with its parent');
  assert.equal(ok(await agent('GET', `/api/agent/cloud/${fpFile}/info`, devTok)).parent, home.id);
  ok(await PO.del(`/api/nodes/${fpFile}`));
  const ch2 = ok(await agent('GET', `/api/agent/cloud-changes?since=${ch1.anchor}`, devTok));
  assert.ok(ch2.deleted.includes(fpFile) && !ch2.items.some(x => x.id === fpFile), 'moved to the trash: gone for the computer');
  ok(await PF3.put(`/api/nodes/${forPavel}/access`, { entries: [] }));
  const ch3 = ok(await agent('GET', `/api/agent/cloud-changes?since=${ch2.anchor}`, devTok));
  assert.ok(ch3.deleted.includes(forPavel), 'access taken away: the shared folder is gone for the computer');
  ok(await PF3.put(`/api/nodes/${forPavel}/access`, { entries: [{ type: 'user', id: owner.id, level: 1 }] }));
  const ch4 = ok(await agent('GET', `/api/agent/cloud-changes?since=${ch3.anchor}`, devTok));
  assert.ok(ch4.items.some(x => x.id === forPavel && x.parent === 0 && x.readOnly), 'access given back: it is a place at the top level again (read only)');
  app.db.run('DELETE FROM changes WHERE seq <= ?', ch3.anchor);
  assert.ok(ok(await agent('GET', `/api/agent/cloud-changes?since=${start}`, devTok)).reset, 'a point older than the log kept: start over');
  assert.equal((await asAgent('GET', `/api/agent/cloud/${forPavel}/info`)).status, 200);
  pass('Mac File Provider: items with their parents, a change log with additions, trashing and access changes, and a reset when a point is too old');

  // Network drive for Macs (WebDAV): Finder's view of the same tree, with the computer's token as the password.
  const davBase = `/dav/${encodeURIComponent('Company Files')}`;
  const davAuthH = { authorization: 'Basic ' + Buffer.from(`computer:${devTok}`).toString('base64') };
  const dv = (method, p, { body, headers = {} } = {}) => fetch(base + davBase + p, { method, headers: { ...davAuthH, ...headers }, body })
    .then(async r => ({ status: r.status, headers: r.headers, text: await r.text() }));
  const noAuth = await fetch(base + davBase + '/', { method: 'PROPFIND' });
  assert.ok(noAuth.status === 401 && /Basic/.test(noAuth.headers.get('www-authenticate')), 'the drive asks for the password');
  assert.equal((await fetch(base + davBase + '/', { method: 'PROPFIND', headers: { authorization: 'Basic ' + Buffer.from('x:wrong-token-wrong-token').toString('base64') } })).status, 401);
  const top = await dv('PROPFIND', '/', { headers: { depth: '1' } });
  assert.ok(top.status === 207 && top.text.includes(`${davBase}/My%20files/`) && top.text.includes(`${davBase}/For%20Pavel/`), 'the top level shows the same places as the website');
  assert.ok(!/confidential/i.test(top.text), 'no confidential folders');
  assert.equal((await dv('PUT', '/My%20files/drive.txt', { body: 'from Finder' })).status, 201, 'a new file from Finder');
  assert.equal((await dv('GET', '/My%20files/drive.txt')).text, 'from Finder', 'and read back');
  const driveId = ok(await PO.get(`/api/nodes/${home.id}`)).children.find(x => x.name === 'drive.txt').id;
  assert.equal((await dv('PUT', '/My%20files/drive.txt', { body: 'edited in Finder' })).status, 204);
  assert.equal(ok(await PO.get(`/api/nodes/${driveId}/versions`)).length, 1, 'writing it again makes a new version');
  assert.equal((await dv('PUT', '/My%20files/empty first.txt', { body: '' })).status, 201);
  assert.equal((await dv('PUT', '/My%20files/empty first.txt', { body: 'content' })).status, 204);
  const emptyFirst = ok(await PO.get(`/api/nodes/${home.id}`)).children.find(x => x.name === 'empty first.txt').id;
  assert.equal(ok(await PO.get(`/api/nodes/${emptyFirst}/versions`)).length, 0, 'the empty file Finder makes first is not kept as a version');
  const chunked = await new Promise((res, rej) => {
    const rq = http.request({ host: '127.0.0.1', port: server.address().port, method: 'PUT', path: davBase + '/My%20files/chunked.bin', headers: { ...davAuthH, 'transfer-encoding': 'chunked', 'x-expected-entity-length': '200000' } }, r => { r.resume(); r.on('end', () => res(r.statusCode)); }).on('error', rej);
    for (let i = 0; i < 4; i++) rq.write(Buffer.alloc(50000, 65 + i));
    rq.end();
  });
  assert.equal(chunked, 201, 'a big file sent in chunks without a length (as Finder does)');
  assert.equal((await dv('GET', '/My%20files/chunked.bin')).text.length, 200000);
  assert.equal((await dv('MKCOL', '/My%20files/From%20Finder')).status, 201, 'a new folder');
  assert.equal((await dv('MKCOL', '/My%20files/From%20Finder')).status, 405, 'not twice');
  assert.equal((await dv('MOVE', '/My%20files/drive.txt', { headers: { destination: `${base}${davBase}/My%20files/From%20Finder/moved.txt` } })).status, 201);
  assert.ok(ok(await PO.get(`/api/nodes/${driveId}`)).node.name === 'moved.txt', 'renamed and moved: the same file (its versions stay)');
  const listing = await dv('PROPFIND', '/My%20files/From%20Finder/', { headers: { depth: '1' } });
  assert.ok(listing.text.includes('moved.txt') && listing.text.includes('<D:getcontentlength>16</D:getcontentlength>'), 'a folder lists its files with their sizes');
  assert.equal((await dv('PUT', '/For%20Pavel/nope.txt', { body: 'x' })).status, 403, 'read only stays read only');
  assert.equal((await dv('DELETE', '/For%20Pavel/read%20me.txt')).status, 403);
  assert.equal((await dv('PUT', '/nope.txt', { body: 'x' })).status, 403, 'the top level only holds the places');
  // Finder's own files and programs' temporary files stay in memory; a temporary file saved over a real one is a new version
  assert.equal((await dv('PUT', '/My%20files/.DS_Store', { body: 'finder stuff' })).status, 201);
  assert.equal((await dv('PUT', '/My%20files/From%20Finder/._moved.txt', { body: 'resource fork' })).status, 201);
  assert.equal((await dv('GET', '/My%20files/.DS_Store')).text, 'finder stuff');
  assert.ok(!ok(await PO.get(`/api/nodes/${home.id}`)).children.some(x => x.name.startsWith('.')), 'never among the company\'s files');
  assert.ok((await dv('PROPFIND', '/My%20files/', { headers: { depth: '1' } })).text.includes('.DS_Store'), 'but Finder still sees them');
  assert.equal((await dv('PUT', '/My%20files/From%20Finder/.moved.txt.sb-1234', { body: 'saved by a program' })).status, 201);
  assert.equal((await dv('MOVE', '/My%20files/From%20Finder/.moved.txt.sb-1234', { headers: { destination: `${davBase}/My%20files/From%20Finder/moved.txt`, overwrite: 'T' } })).status, 204);
  assert.equal(ok(await PO.get(`/api/nodes/${driveId}/content`)).toString(), 'saved by a program', 'a program saving through a temporary file: the same file gets the new content');
  assert.equal(ok(await PO.get(`/api/nodes/${driveId}/versions`)).length, 2, '... as a new version');
  assert.equal((await dv('MOVE', '/My%20files/From%20Finder/moved.txt', { headers: { destination: `${davBase}/My%20files/.hidden.txt` } })).status, 403, 'real files are never moved into memory');
  const lock = await dv('LOCK', '/My%20files/From%20Finder/moved.txt', { body: '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"/>' });
  assert.ok(lock.status === 200 && /opaquelocktoken/.test(lock.headers.get('lock-token')), 'locks are granted (Finder writes only to drives that lock)');
  assert.equal((await dv('DELETE', '/My%20files/From%20Finder/moved.txt')).status, 204);
  assert.ok(ok(await PO.get('/api/trash')).some(t => t.id === driveId), 'deleted in Finder: in the website trash');
  assert.equal((await dv('DELETE', '/My%20files')).status, 403, 'the places themselves cannot be deleted');
  assert.ok(app.db.get(`SELECT 1 FROM audit WHERE action LIKE 'created folder on computer "Pavel laptop" (network drive)'`), 'logged with the computer\'s name');
  pass('Network drive (WebDAV) for Macs: the computer\'s token is the password, the same places and rules as the website, files and folders made, read, renamed, moved and trashed, versions kept (also through programs\' temporary files), Finder\'s own files kept out, locks for Finder');

  const gone2 = ok(await PO.upload(home.id, 'temp.txt', 'bye')).id;
  ok(await PO.post('/api/devices/send', { ids: [gone2] }));
  ok(await PO.del(`/api/nodes/${gone2}`));
  aq = ok(await agent('GET', '/api/agent/queue', devTok));
  assert.ok(!aq.some(x => x.path === 'temp.txt'), 'a file deleted after sending is skipped');
  const undoNow = ok(await PO.post('/api/devices/send', { ids: [passport] }));
  assert.equal(ok(await PO.del(`/api/devices/batches/${undoNow.batch}`)).removed, 1, 'Undo takes back what was not saved yet');
  const hrCode = ok(await HR.post('/api/devices/pair-code')).code;
  const hrTok = ok(await anon.post('/api/agent/pair', { code: hrCode, name: 'HR desk', os: 'linux' })).token;
  assert.equal((await HR.post('/api/devices/send', { ids: [payroll.id] })).status, 403, 'confidential files are never sent to computers');
  for (let i = 0; i < 5; i++) await anon.post('/api/agent/pair-info', { code: 'AAAA-AAAA' });
  assert.equal((await anon.post('/api/agent/pair-info', { code: 'AAAA-AAAA' })).status, 429, 'guessing codes is throttled');
  const devId = ok(await PO.get('/api/devices'))[0].id;
  ok(await PO.del(`/api/devices/${devId}`));
  assert.equal((await agent('GET', '/api/agent/queue', devTok)).status, 401, 'a disconnected computer loses access at once');
  await pause(100);
  assert.ok(ws.destroyed || ws.readableEnded, 'and its WebSocket is closed');
  ok(await agent('POST', '/api/agent/unpair', hrTok));
  assert.equal(ok(await HR.get('/api/devices')).length, 0, 'an agent can disconnect itself');
  pass('Auto-save: one-time pairing codes, agent tokens that only fetch what was sent, WebSocket push, folder structure kept, deleted files skipped, Undo, no confidential files, disconnect ends access');
  pass('Online editor: per-file tokens bound to person and session, Read opens view-only, saves become versions (one per editing run), conflicts are caught, revoking access or signing out ends editing');

  // ---- resumable uploads (tus 1.0), folder structures, a folder as a zip ----
  ok(await admin.patch(`/api/admin/users/${eng.id}`, { disabled: false }));
  // Sessions made directly: the earlier checks used up this IP's sign-in attempts.
  const sessionOf = u => {
    const t = crypto.randomBytes(24).toString('base64url'), now = Date.now();
    app.db.run('INSERT INTO sessions(id, user_id, mfa, created_at, seen_at, ip, ua) VALUES(?, ?, 0, ?, ?, ?, ?)', crypto.createHash('sha256').update(t).digest('hex'), u.id, now, now, '127.0.0.1', 'check');
    const c = new Client();
    c.jar.set('sid', t);
    return c;
  };
  const TE = sessionOf(eng), TA = sessionOf(acc), TH = sessionOf(head);
  const tusMeta = o => Object.entries(o).map(([k, v]) => `${k} ${Buffer.from(String(v)).toString('base64')}`).join(',');
  const tus = (c, method, url, headers = {}, raw) => c.req(method, url, { raw, headers: { 'tus-resumable': '1.0.0', ...headers } });
  const octet = { 'content-type': 'application/offset+octet-stream' };
  app.db.run('UPDATE nodes SET quota = NULL WHERE id = ?', engDir.id); // an earlier check set it to 40 bytes
  const tusDir = ok(await TH.post(`/api/nodes/${engDir.id}/folders`, { name: 'Tus' })).id;
  ok(await TH.put(`/api/nodes/${tusDir}/access`, { entries: [{ type: 'user', id: eng.id, level: 2 }] }));
  const into = (name, more = {}) => ({ 'upload-metadata': tusMeta({ folder: tusDir, name }), ...more });
  const bigBody = crypto.randomBytes(300000);
  let tr = await tus(TE, 'POST', '/api/tus', into('big.bin', { 'upload-length': String(bigBody.length) }));
  assert.equal(tr.status, 201);
  assert.equal(tr.headers.get('tus-resumable'), '1.0.0');
  const loc = tr.headers.get('location');
  tr = await tus(TE, 'PATCH', loc, { ...octet, 'upload-offset': '0' }, bigBody.subarray(0, 100000));
  assert.equal(tr.status, 204);
  assert.equal(tr.headers.get('upload-offset'), '100000');
  await new Promise(res => { // the connection drops half-way through the next part
    const rq = http.request({ host: '127.0.0.1', port: server.address().port, path: loc, method: 'PATCH', headers: { cookie: TE.cookie(), 'x-requested-with': 'fetch', 'tus-resumable': '1.0.0', ...octet, 'upload-offset': '100000', 'content-length': '100000' } });
    rq.on('error', () => {});
    rq.write(bigBody.subarray(100000, 150000), () => setTimeout(() => (rq.destroy(), res()), 300));
  });
  await pause(300);
  const at = Number((await tus(TE, 'HEAD', loc)).headers.get('upload-offset'));
  assert.ok(at > 100000 && at <= 150000, `bytes that arrived before the drop are kept (${at})`);
  assert.equal((await tus(TE, 'PATCH', loc, { ...octet, 'upload-offset': '0' }, Buffer.from('x'))).status, 409, 'a wrong offset is refused');
  assert.equal((await tus(TE, 'PATCH', loc, { ...octet, 'upload-offset': String(at) }, bigBody.subarray(at))).status, 204);
  const tusKids = async () => ok(await TE.get(`/api/nodes/${tusDir}`)).children;
  const bigNode = (await tusKids()).find(x => x.name === 'big.bin');
  assert.ok(ok(await TE.get(`/api/nodes/${bigNode.id}/content`)).equals(bigBody), 'the resumed file is byte-identical');
  assert.equal((await tus(TE, 'HEAD', loc)).status, 404, 'a finished upload is gone');
  tr = await tus(TE, 'POST', '/api/tus', into('one.txt', { ...octet, 'upload-length': '5' }), Buffer.from('hello'));
  assert.equal(tr.status, 201);
  assert.equal(tr.headers.get('upload-offset'), '5', 'a small file arrives with the request that creates it');
  ok(await tus(TE, 'POST', '/api/tus', into('empty.txt', { 'upload-length': '0' })), 201);
  const tusPart = async buf => {
    const r = await tus(TE, 'POST', '/api/tus', into('joined.bin', { ...octet, 'upload-concat': 'partial', 'upload-length': String(buf.length) }), buf);
    assert.equal(r.status, 201);
    return r.headers.get('location');
  };
  const p1 = await tusPart(bigBody.subarray(0, 120000)), p2 = await tusPart(bigBody.subarray(120000));
  assert.equal((await tus(TE, 'HEAD', p1)).headers.get('upload-concat'), 'partial');
  ok(await tus(TE, 'POST', '/api/tus', into('joined.bin', { 'upload-concat': `final;${base}${p1} ${base}${p2}` })), 201);
  const joined = (await tusKids()).find(x => x.name === 'joined.bin');
  assert.ok(ok(await TE.get(`/api/nodes/${joined.id}/content`)).equals(bigBody), 'parts sent in parallel join into the exact file');
  assert.deepEqual((await tusKids()).map(x => [x.name, x.size]).sort(), [['big.bin', 300000], ['empty.txt', 0], ['joined.bin', 300000], ['one.txt', 5]]);
  const cl = (await tus(TE, 'POST', '/api/tus', into('cancel.bin', { 'upload-length': '10' }))).headers.get('location');
  assert.deepEqual(ok(await TE.get('/api/tus')).map(u => [u.name, u.size, u.done]), [['cancel.bin', 10, 0]], 'unfinished uploads are listed, to continue after a reload');
  assert.equal((await tus(TA, 'HEAD', cl)).status, 404, 'nobody else can see or continue it');
  ok(await tus(TE, 'DELETE', cl), 204);
  assert.deepEqual(ok(await TE.get('/api/tus')), [], 'Cancel removes it');
  assert.equal((await tus(TA, 'POST', '/api/tus', into('x.txt', { 'upload-length': '3' }))).status, 404, 'no uploads into a folder without Edit');
  assert.equal((await tus(TE, 'POST', '/api/tus', into('huge.bin', { 'upload-length': String(cfg.maxFile + 1) }))).status, 413);
  assert.equal((await tus(TE, 'POST', '/api/tus', into('over.txt', { ...octet, 'upload-length': '3' }), Buffer.from('12345'))).status, 413, 'more bytes than announced');
  assert.equal((await tus(TE, 'POST', '/api/tus', into('../evil', { 'upload-length': '3' }))).status, 400);
  const late = (await tus(TE, 'POST', '/api/tus', into('late.txt', { 'upload-length': '3' }))).headers.get('location');
  ok(await TE.post(`/api/nodes/${tusDir}/folders`, { name: 'late.txt' }));
  assert.equal((await tus(TE, 'PATCH', late, { ...octet, 'upload-offset': '0' }, Buffer.from('abc'))).status, 422, 'a name taken meanwhile stops the upload (422, so the client does not retry)');
  assert.equal((await tus(TE, 'HEAD', late)).status, 404);
  assert.deepEqual(ok(await TE.get('/api/tus')), [], 'refused uploads leave nothing behind');
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'uploads')), [], 'and no bytes on disk');
  pass('Resumable uploads (tus): bytes survive a dropped connection, resume from the exact offset, small files in one request, parallel parts joined, cancel, other people locked out, limits and name rules enforced');

  const tree = ok(await TE.post(`/api/nodes/${tusDir}/tree`, { paths: ['Site/Photos/2026', 'Site/Empty', 'Site/Photos'] })).ids;
  assert.ok(tree.Site && tree['Site/Photos'] && tree['Site/Photos/2026'] && tree['Site/Empty']);
  assert.equal(ok(await TE.post(`/api/nodes/${tusDir}/tree`, { paths: ['Site/Photos/2026'] })).ids['Site/Photos/2026'], tree['Site/Photos/2026'], 'existing folders are reused');
  assert.equal((await TE.post(`/api/nodes/${tusDir}/tree`, { paths: ['one.txt/sub'] })).status, 409, 'a file in the way is refused');
  assert.equal((await TE.post(`/api/nodes/${tusDir}/tree`, { paths: ['Site/../x'] })).status, 400);
  assert.equal((await TA.post(`/api/nodes/${tusDir}/tree`, { paths: ['x'] })).status, 404);
  ok(await TE.upload(tree['Site/Photos/2026'], 'a.txt', 'alpha'));
  ok(await TE.upload(tree.Site, 'Отчёт.txt', 'беta'));
  const hidden = ok(await TE.post(`/api/nodes/${tree.Site}/folders`, { name: 'Hidden' })).id;
  ok(await TE.upload(hidden, 'secret.txt', 's'));
  ok(await TH.put(`/api/nodes/${hidden}/access`, { restricted: true, entries: [] }));
  const zr = await TE.get(`/api/nodes/${tree.Site}/zip`);
  const zip = ok(zr);
  assert.equal(Number(zr.headers.get('content-length')), zip.length, 'the announced length is exact, so the browser shows time left');
  assert.match(zr.headers.get('content-disposition'), /filename\*=UTF-8''Site\.zip/);
  const inZip = {};
  const eocd = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50);
  for (let i = 0, p = zip.readUInt32LE(eocd + 16); i < zip.readUInt16LE(eocd + 10); i++) {
    assert.equal(zip.readUInt32LE(p), 0x02014b50);
    const nl = zip.readUInt16LE(p + 28), off = zip.readUInt32LE(p + 42), size = zip.readUInt32LE(p + 24);
    const name = zip.subarray(p + 46, p + 46 + nl).toString();
    const from = off + 30 + zip.readUInt16LE(off + 26) + zip.readUInt16LE(off + 28);
    const data = zip.subarray(from, from + size);
    assert.equal(zlib.crc32(data), zip.readUInt32LE(p + 16), `CRC of ${name}`);
    inZip[name] = data.toString();
    p += 46 + nl + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  assert.deepEqual(Object.keys(inZip).sort(), ['Site/', 'Site/Empty/', 'Site/Photos/', 'Site/Photos/2026/', 'Site/Photos/2026/a.txt', 'Site/Отчёт.txt'], 'empty folders kept, restricted ones left out');
  assert.equal(inZip['Site/Photos/2026/a.txt'], 'alpha');
  assert.equal(inZip['Site/Отчёт.txt'], 'беta');
  assert.ok(app.db.get(`SELECT 1 FROM audit WHERE action LIKE 'downloaded as zip (2 files%'`));
  assert.equal((await TA.get(`/api/nodes/${tree.Site}/zip`)).status, 404);
  pass('Folders: whole structures created in one call (empty folders too), existing folders reused; a folder downloads as a streamed zip with exact length, CRCs, Unicode names, empty folders, and without restricted items');

  // A tiny SMTP server that keeps what it receives, so the check can read the one-time codes.
  const inbox = [];
  const smtp = net.createServer(s => {
    let buf = '', msg = null;
    s.setEncoding('utf8');
    s.write('220 test\r\n');
    s.on('data', d => {
      buf += d;
      for (let i; (i = buf.indexOf('\r\n')) >= 0; ) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (msg !== null) {
          if (line === '.') { inbox.push(msg); msg = null; s.write('250 queued\r\n'); } else msg += line + '\r\n';
          continue;
        }
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') s.write('250-test\r\n250 AUTH PLAIN\r\n');
        else if (verb === 'AUTH') s.write(line === `AUTH PLAIN ${Buffer.from('\0u\0p').toString('base64')}` ? '235 ok\r\n' : '535 no\r\n');
        else if (verb === 'DATA') { msg = ''; s.write('354 go\r\n'); }
        else if (verb === 'QUIT') s.end('221 bye\r\n');
        else s.write('250 ok\r\n');
      }
    });
  });
  await new Promise(r => smtp.listen(0, '127.0.0.1', r));
  smtp.unref(); // a failed check must not leave the process hanging on this server
  const lastMail = () => {
    const [head, text] = inbox.at(-1).split('\r\n\r\n');
    return { to: /^To: <(.+)>$/m.exec(head)[1], subject: Buffer.from(/=\?UTF-8\?B\?(.+)\?=/.exec(head)[1], 'base64').toString(), text: Buffer.from(text.replace(/\s/g, ''), 'base64').toString() };
  };
  const tok = ok(await admin.post('/api/admin/invites', { days: 7, max_uses: 3, domain: '@Example.com' })).url.split('/join/')[1];
  assert.equal((await new Client().get(`/api/join/${tok}`)).status, 503, 'no sign-up while email is not set up');
  cfg.smtp = { host: '127.0.0.1', port: smtp.address().port, user: 'u', pass: 'p', from: 'Company Files <files@example.com>' };
  const joiner = new Client();
  assert.equal(ok(await joiner.get(`/api/join/${tok}`)).domain, 'example.com');
  assert.equal((await joiner.post(`/api/join/${tok}/code`, { name: 'Out Sider', email: 'out@gmail.com' })).status, 400, 'only the invited domain');
  ok(await joiner.post(`/api/join/${tok}/code`, { name: 'Aruzhan New', email: 'Aruzhan.New@example.com' }));
  let m = lastMail();
  const codeA = /code: (\d{6})/.exec(m.text)[1];
  assert.ok(m.to === 'aruzhan.new@example.com' && m.subject.startsWith(codeA));
  assert.equal((await joiner.post(`/api/join/${tok}/code`, { name: 'Aruzhan New', email: 'aruzhan.new@example.com' })).status, 429, 'one code a minute');
  const joinAs = (email, c, password, name = 'Joining Person') => joiner.post(`/api/join/${tok}/confirm`, { name, email, code: c, password });
  const pwA = strong();
  assert.equal((await joinAs('aruzhan.new@example.com', codeA, 'short')).status, 400, 'password rules apply');
  const made = ok(await joinAs('aruzhan.new@example.com', codeA, pwA));
  assert.equal(made.login, 'aruzhan.new');
  assert.equal((await joinAs('aruzhan.new@example.com', codeA, pwA)).status, 400, 'a code works once');
  const AN = new Client();
  assert.equal(ok(await AN.post('/api/login', { login: 'Aruzhan.New@example.com', password: pwA })).stage, 'full', 'sign in with the email');
  assert.ok(!(await spaces(AN)).some(s => s.area === 'general') && (await spaces(AN)).some(s => s.area === 'personal' && s.level === 3), 'only their own folder');
  ok(await new Client().post(`/api/join/${tok}/code`, { name: 'Again', email: 'aruzhan.new@example.com' }));
  m = lastMail();
  assert.ok(m.subject.includes('already have an account') && m.text.includes('aruzhan.new'), 'a second sign-up gets a reminder, not a code');
  assert.equal((await new Client().post(`/api/join/${tok}/code`, { name: 'Again', email: 'aruzhan.new@example.com' })).status, 429, 'registered and new addresses get the same one-minute pause');
  assert.equal((await joinAs('aruzhan.new@example.com', '123456', strong())).status, 400, 'and the same "wrong code" answer');
  for (const bad of ['a+tag@example.com', 'a%evil.test@example.com']) assert.equal((await joiner.post(`/api/join/${tok}/code`, { name: 'X', email: bad })).status, 400, `${bad} is refused`);
  ok(await joiner.post(`/api/join/${tok}/code`, { name: 'Attacker Chosen', email: 'it@example.com' }));
  const itMade = ok(await joinAs('it@example.com', /code: (\d{6})/.exec(lastMail().text)[1], strong(), 'Real Person'));
  assert.equal(itMade.login, 'it2', 'generic logins such as "it" are reserved');
  assert.equal(app.db.get(`SELECT name FROM users WHERE login = 'it2'`).name, 'Real Person', 'the name comes from the person who confirms');
  ok(await joiner.post(`/api/join/${tok}/code`, { name: 'Bolat Second', email: 'bolat@example.com' }));
  const codeB = /code: (\d{6})/.exec(lastMail().text)[1];
  const wrong = codeB === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i++) assert.equal((await joinAs('bolat@example.com', wrong, strong())).status, 400);
  assert.match((await joinAs('bolat@example.com', wrong, strong())).data.error, /Too many wrong codes/);
  assert.equal((await joinAs('bolat@example.com', codeB, strong())).status, 400, 'after 5 wrong tries the code is dead');
  ok(await joiner.post(`/api/join/${tok}/code`, { name: 'Bolat Second', email: 'bolat@example.com' }));
  ok(await joinAs('bolat@example.com', /code: (\d{6})/.exec(lastMail().text)[1], strong()));
  assert.equal((await new Client().get(`/api/join/${tok}`)).status, 404, 'the link is used up after 3 people');
  const people = ok(await admin.get('/api/admin/users'));
  assert.ok(people.some(u => u.login === 'aruzhan.new' && u.email === 'aruzhan.new@example.com' && !u.is_admin && !u.manager));
  assert.ok(ok(await admin.get('/api/audit?cat=alerts')).rows.some(e => e.action.startsWith('ALERT account created through invite link')));
  const tok2 = ok(await admin.post('/api/admin/invites', { days: 1, max_uses: 5 }));
  ok(await admin.del(`/api/admin/invites/${tok2.id}`));
  assert.equal((await new Client().get(`/api/join/${tok2.url.split('/join/')[1]}`)).status, 404, 'a turned-off link stops at once');
  assert.equal((await admin.post('/api/admin/invites', { days: 31, max_uses: 5 })).status, 400);
  ok(await admin.del(`/api/admin/users/${people.find(u => u.login === 'aruzhan.new').id}`));
  assert.equal(app.db.get(`SELECT email FROM users WHERE login LIKE 'aruzhan.new~deleted-%'`).email, null, 'a deleted account frees its email');
  // One email, one account: an address IT records also stops a second account through an invite link.
  const rassul = ok(await admin.post('/api/admin/users', { login: 'r.temiresh', name: 'Rassul T', email: ' Sales@Example.com ' }));
  assert.equal(app.db.get('SELECT email FROM users WHERE id = ?', rassul.id).email, 'sales@example.com');
  assert.equal((await admin.post('/api/admin/users', { login: 'r.other', name: 'Other', email: 'SALES@example.com' })).status, 409, 'IT cannot make a second account with the same email');
  assert.ok(!app.db.get(`SELECT 1 FROM users WHERE login = 'r.other'`), 'and nothing is created');
  assert.equal((await admin.patch(`/api/admin/users/${eng.id}`, { email: 'sales@example.com' })).status, 409, 'nor give the email to someone else');
  assert.equal((await admin.post('/api/admin/users', { login: 'r.bad', name: 'Bad', email: 'not an email' })).status, 400);
  const tok3 = ok(await admin.post('/api/admin/invites', { days: 1, max_uses: 5 })).url.split('/join/')[1];
  ok(await new Client().post(`/api/join/${tok3}/code`, { name: 'Rassul Again', email: 'sales@example.com' }));
  m = lastMail();
  assert.ok(m.subject.includes('already have an account') && m.text.includes('r.temiresh'), 'signing up with an email IT recorded gets a login reminder, not a code');
  assert.equal((await new Client().post(`/api/join/${tok3}/confirm`, { name: 'Rassul Again', email: 'sales@example.com', code: '123456', password: strong() })).status, 400);
  assert.equal(app.db.get(`SELECT COUNT(*) n FROM users WHERE email = 'sales@example.com'`).n, 1, 'still one account');
  assert.equal(ok(await new Client().post('/api/login', { login: 'sales@example.com', password: rassul.password })).stage, 'change', 'they can sign in with the email IT recorded');
  ok(await admin.patch(`/api/admin/users/${rassul.id}`, { email: '' }));
  assert.equal(app.db.get('SELECT email FROM users WHERE id = ?', rassul.id).email, null, 'IT can remove the email');
  cfg.smtp = null;
  smtp.close();
  pass('Sign-up by invite link: email confirmed with a one-time code (10 min, 5 tries, 1 a minute), invited domain only, link limits, sign in with email');
  pass('One email, one account: IT can record an email; neither IT nor an invite link can make a second account with it');

  // ---- regressions for the security audit of 2026-11-13 (each was a working exploit) ----
  {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    // A request whose body arrives in pieces, to hold a handler open.
    const slow = (method, url, length, headers = {}) => {
      const u = new URL(base + url);
      let rq;
      const done = new Promise(resolve => {
        rq = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { 'x-requested-with': 'fetch', 'content-length': length, ...headers } }, s => {
          let b = '';
          s.on('data', d => (b += d));
          s.on('end', () => resolve({ status: s.statusCode, body: b }));
        });
        rq.on('error', e => resolve({ status: 0, error: e.code }));
      });
      rq.flushHeaders();
      return { send: d => rq.write(d), end: d => rq.end(d), done };
    };
    const folder = (c, parent, name) => c.post(`/api/nodes/${parent}/folders`, { name }).then(r => ok(r).id);

    // A slow rename can no longer undo a move made meanwhile (it used to re-parent the folder, escaping every move rule).
    const raceA = await folder(H2, engDir.id, 'Race A'), raceB = await folder(H2, engDir.id, 'Race B'), raceN = await folder(H2, raceA, 'Race N');
    const json = JSON.stringify({ name: 'Race N2' });
    const rn = slow('PATCH', `/api/nodes/${raceN}`, Buffer.byteLength(json), { cookie: H2.cookie(), 'content-type': 'application/json' });
    rn.send(json.slice(0, 5));
    await sleep(150);
    ok(await H2.patch(`/api/nodes/${raceN}`, { parent_id: raceB }));
    rn.end(json.slice(5));
    assert.equal((await rn.done).status, 200);
    assert.deepEqual(Object.values(app.db.get('SELECT parent_id, name FROM nodes WHERE id = ?', raceN)), [raceB, 'Race N2']);
    // And if a parent/child cycle ever appears, requests answer instead of hanging the server.
    app.db.run('UPDATE nodes SET parent_id = ? WHERE id = ?', raceN, raceB);
    const t0 = Date.now();
    assert.equal((await H2.get(`/api/nodes/${raceN}`)).status, 404);
    assert.equal((await H2.get('/api/search?q=Race')).status, 200);
    assert.ok(Date.now() - t0 < 5000, 'a cycle must not hang the server');
    app.db.run('UPDATE nodes SET parent_id = ? WHERE id = ?', engDir.id, raceB);

    // Shared files cannot be pulled into a personal folder (where the owner holds Manage), and a folder with its own
    // access settings cannot be carried into a department by someone without Manage there.
    const budget = await folder(H2, engDir.id, 'Budget');
    const nbHome = space(await spaces(NB), 'n.newbie').id;
    assert.equal((await NB.patch(`/api/nodes/${budget}`, { parent_id: nbHome })).status, 403);
    const drop = await folder(NB, nbHome, 'Drop');
    ok(await NB.put(`/api/nodes/${drop}/access`, { entries: [{ type: 'user', id: friend.id, level: 2 }] }));
    assert.equal((await NB.patch(`/api/nodes/${drop}`, { parent_id: engDir.id })).status, 403);
    ok(await NB.put(`/api/nodes/${drop}/access`, { entries: [] }));
    ok(await NB.patch(`/api/nodes/${drop}`, { parent_id: engDir.id }), 200);

    // A restricted folder in the trash still protects its parent from being moved or deleted by members.
    const plansX = await folder(H2, engDir.id, 'Plans X'), layoffs = await folder(H2, plansX, 'Layoffs');
    ok(await H2.put(`/api/nodes/${layoffs}/access`, { restricted: true, entries: [] }));
    ok(await H2.del(`/api/nodes/${layoffs}`));
    assert.equal((await NB.patch(`/api/nodes/${plansX}`, { parent_id: budget })).status, 403);
    assert.equal((await NB.del(`/api/nodes/${plansX}`)).status, 403);

    // A Manager given Edit on part of someone's personal folder cannot erase restricted folders they cannot open,
    // and the activity log never names a restricted item that was erased.
    const holder = await folder(PO, home.id, 'Shared box'), box2 = await folder(PO, holder, 'Box2'), notes = await folder(PO, box2, 'Therapy notes');
    ok(await PO.put(`/api/nodes/${notes}/access`, { restricted: true, entries: [] }));
    ok(await PO.put(`/api/nodes/${holder}/access`, { entries: [{ type: 'user', id: mgr.id, level: 2 }] }));
    ok(await PO.del(`/api/nodes/${box2}`));
    assert.equal((await M.del(`/api/trash/${box2}`)).status, 403);
    ok(await PO.post(`/api/trash/${box2}/restore`));
    ok(await PO.del(`/api/nodes/${notes}`));
    ok(await PO.del(`/api/trash/${notes}`));
    const erased = app.db.get(`SELECT target FROM audit WHERE action = 'deleted forever from trash' ORDER BY id DESC LIMIT 1`).target;
    assert.ok(erased.endsWith('(restricted item)') && !erased.includes('Therapy'), erased);

    // Uploads: access is checked again at the end, a hidden restricted file with the same name is not replaced,
    // one person cannot hold more than two maximum-size uploads, and stalled uploads are cut off.
    const up = slow('PUT', `/api/nodes/${budget}/files?name=late.txt`, 4, { cookie: NB.cookie() });
    up.send('ab');
    await sleep(100);
    ok(await H2.put(`/api/nodes/${budget}/access`, { restricted: true, entries: [] }));
    up.end('cd');
    assert.equal((await up.done).status, 403, 'access removed while uploading');
    ok(await H2.put(`/api/nodes/${budget}/access`, { entries: [] }));
    const plan = ok(await H2.upload(budget, 'plan.txt', 'head text')).id;
    ok(await H2.put(`/api/nodes/${plan}/access`, { restricted: true, entries: [] }));
    assert.equal((await NB.upload(budget, 'plan.txt', 'member text')).status, 409);
    assert.equal(ok(await H2.get(`/api/nodes/${plan}/content`)).toString(), 'head text');
    const big = cfg.maxFile;
    const hold1 = slow('PUT', `/api/nodes/${nbHome}/files?name=hold1.bin`, big, { cookie: NB.cookie() });
    const hold2 = slow('PUT', `/api/nodes/${nbHome}/files?name=hold2.bin`, big, { cookie: NB.cookie() });
    hold1.send(Buffer.alloc(10));
    hold2.send(Buffer.alloc(10));
    await sleep(200);
    assert.equal((await NB.upload(nbHome, 'third.bin', Buffer.alloc(big))).status, 429, 'at most two big uploads in flight per person');
    assert.equal((await hold1.done).status, 0, 'a stalled upload is cut off');
    await hold2.done;
    await sleep(300); // the server frees the reservation right after cleaning up the cut-off temp files
    ok(await NB.upload(nbHome, 'third.bin', Buffer.alloc(big)));

    // Moving a file brings its old versions into the destination quota.
    const small = await folder(NB, nbHome, 'Small');
    app.db.run('UPDATE nodes SET quota = 100 WHERE id = ?', small);
    ok(await NB.upload(nbHome, 'v.txt', Buffer.alloc(60)));
    const vfile = ok(await NB.upload(nbHome, 'v.txt', Buffer.alloc(60))).id;
    assert.equal((await NB.patch(`/api/nodes/${vfile}`, { parent_id: small })).status, 413, '60 B now + 60 B old version > 100 B');

    // Brute force: IPv6 clients are counted per /64.
    cfg.trustProxy = true;
    const loginFrom = (u, pw, how) => new Client().req('POST', '/api/login', { json: { login: u.login, password: pw }, ...how });
    const v6 = i => ({ headers: { 'x-forwarded-for': `2001:db8:1:2::${i}` } });
    for (let i = 1; i <= 5; i++) assert.equal((await loginFrom({ login: 'nobody-v6' }, 'wrong-password-1', v6(i))).status, 401);
    assert.equal((await loginFrom({ login: 'nobody-v6' }, 'wrong-password-1', v6(99))).status, 429, 'another address in the same /64 is still locked');
    assert.equal((await loginFrom({ login: 'nobody-v6' }, 'wrong-password-1', { headers: { 'x-forwarded-for': '2001:db8:9:9::1' } })).status, 401);
    cfg.trustProxy = false;

    // Backups: encrypted files are bound to their names, so swapping two of them is detected on restore.
    const bdir2 = path.join(tmp, 'backup-aad');
    await backup(dataDir, bdir2);
    const blobsDir = path.join(bdir2, 'blobs');
    const files = fs.readdirSync(blobsDir).flatMap(d => fs.readdirSync(path.join(blobsDir, d)).map(f => path.join(blobsDir, d, f)));
    const [f1b, f2b] = files;
    const [x1, x2] = [fs.readFileSync(f1b), fs.readFileSync(f2b)];
    fs.writeFileSync(f1b, x2);
    fs.writeFileSync(f2b, x1);
    const snap = path.join(bdir2, 'db', fs.readdirSync(path.join(bdir2, 'db')).find(f => f.endsWith('.enc')));
    await assert.rejects(restore(snap, path.join(tmp, 'restored-swapped'), loadKey(dataDir)), /wrong backup key or damaged/);
  }
  pass('Audit fixes: no stale-rename re-parenting or cycle hangs, no pulling shared files into personal folders, trashed restricted folders still guarded, no erasing hidden folders, upload re-checks and limits, quotas count versions, IPv6 brute force limits, backups bound to file names');

  assert.equal(msUntil('00:00', new Date(2026, 10, 5, 23, 30)), 30 * 60e3);
  assert.equal(msUntil('00:00', new Date(2026, 10, 5, 0, 0)), 24 * 3600e3);
  assert.equal(msUntil('02:15', new Date(2026, 10, 5, 1, 15)), 3600e3);
  pass('Nightly backup timer fires at the configured local time');

  console.log('\nAll checks passed.');
} catch (e) {
  console.error('\nCHECK FAILED\n', e);
  process.exitCode = 1;
} finally {
  server.close();
  server.closeAllConnections();
  app.db.raw.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
