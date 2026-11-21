import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { loadConfig, ROOT } from './src/config.mjs';
import { openDb, READ, EDIT, MANAGE } from './src/db.mjs';
import * as A from './src/auth.mjs';
import { makeAcl } from './src/acl.mjs';
import { makeStore } from './src/store.mjs';
import { sendMail } from './src/mail.mjs';

const DAY = 864e5;
const TRASH_DAYS = 30;
const MAX_VERSIONS = 20;
const LINK_MAX_DAYS = 30;
const PATH_MAX = 200;
const SESSION_IDLE = 12 * 3600e3;
const SESSION_MAX = 7 * DAY;
const LEVELS = ['', 'Read', 'Edit', 'Manage'];
const PREVIEW = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf' };
const NAME_RE = /^[\p{L}\p{M}\p{N} ._()\[\],+&'№-]+$/u;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const LOGIN_RE = /^[a-z0-9](?:[a-z0-9._-]{0,38}[a-z0-9])?$/i;
// Depth-capped, so a parent/child cycle can never hang the synchronous server.
const SUBTREE = 'WITH RECURSIVE t(id, d) AS (SELECT ?, 0 UNION ALL SELECT n.id, t.d + 1 FROM nodes n JOIN t ON n.parent_id = t.id WHERE t.d < 500)';
const CSP = "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'";
const STATIC = {
  '/': 'public/index.html',
  '/app.js': 'public/app.js',
  '/theme.js': 'public/theme.js',
  '/robots.txt': 'public/robots.txt',
  '/app.css': 'public/app.css',
  '/favicon.svg': 'public/favicon.svg',
  '/viewer.html': 'public/viewer.html',
  '/viewer.js': 'public/viewer.js',
  '/viewer.css': 'public/viewer.css',
  '/vendor/tus-4.3.1.min.js': 'public/vendor/tus-js-client-4.3.1/tus.min.js',
  '/fonts/archivo.woff2': 'node_modules/@fontsource-variable/archivo/files/archivo-latin-standard-normal.woff2',
  '/fonts/archivo-ext.woff2': 'node_modules/@fontsource-variable/archivo/files/archivo-latin-ext-standard-normal.woff2',
  '/fonts/plex-mono-400.woff2': 'node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2',
  '/fonts/plex-mono-500.woff2': 'node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2',
};
const VERSIONED = ['/app.js', '/app.css', '/theme.js']; // index.html links them as /x?v=<content tag>
const TYPES = { '.txt': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
// The PDF viewer (EmbedPDF 2.15.1, MIT, PDFium inside) is served from here; its versioned files never change.
const VIEWER_DIR = 'public/vendor/embedpdf-2.15.1';
// The viewer page alone may compile WebAssembly, start a blob worker and use its own inline styles; scripts still come
// only from this server and nothing is fetched from elsewhere. The rest of Files keeps the strict CSP above.
const VIEWER_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' blob: data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, message, code) => {
  throw new HttpError(status, message, code);
};

const str = (v, max) => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null);
const int = v => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : fail(400, 'Invalid id.'));
const ext = name => (/\.([a-z0-9]{1,10})$/i.exec(name)?.[1] || '').toLowerCase();
const pathOf = chain => chain.map(n => n.name).join(' / ');
const fmtBytes = n => (n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : `${Math.max(0, n / 2 ** 20).toFixed(1)} MB`);

function cleanName(v) {
  const s = typeof v === 'string' ? v.normalize('NFC').trim() : '';
  if (!s || s.length > 120) fail(400, 'Names must be 1 to 120 characters long.');
  if (!NAME_RE.test(s) || s.startsWith('.') || s.endsWith('.') || RESERVED.test(s))
    fail(400, "Use letters, digits, spaces and . _ - ( ) [ ] , + & ' only. Names cannot start or end with a dot.");
  return s;
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// The JSON body is read once, before authentication and route checks (see handle), so no handler can check
// access, then wait for a slow body while someone else changes the tree, then act on stale checks.
async function body(c, limit = 64 * 1024) {
  if (c.json) return c.json;
  if (!/^application\/json\b/i.test(c.req.headers['content-type'] || '')) fail(415, 'Expected a JSON body.');
  const chunks = [];
  let size = 0;
  for await (const ch of c.req) {
    if ((size += ch.length) > limit) fail(413, 'Request too large.');
    chunks.push(ch);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (v && typeof v === 'object' && !Array.isArray(v)) return (c.json = v);
  } catch {}
  fail(400, 'Invalid JSON.');
}

// Big answers go compressed when the browser takes it: a folder with thousands of files is about 1 MB of JSON and
// some 60 KB compressed, which matters over the internet. Small ones are not worth it.
// ponytail: compressed on the main thread (a few ms for 1 MB at these fast settings); move to zlib's async calls if
// listings ever get much bigger.
const json = (res, status, data) => sendBody(res, status, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(data)));
function sendBody(res, status, type, b) {
  const head = { 'Content-Type': type, 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
  const accepts = String(res.req?.headers['accept-encoding'] || '');
  const enc = b.length < 2048 ? null : /\bbr\b/.test(accepts) ? 'br' : /\bgzip\b/.test(accepts) ? 'gzip' : null;
  const out = enc === 'br' ? zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length } })
    : enc === 'gzip' ? zlib.gzipSync(b, { level: 5 }) : b;
  if (enc) head['Content-Encoding'] = enc;
  res.writeHead(status, { ...head, 'Content-Length': out.length });
  res.end(out);
}

function loadSecret(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
    return key;
  }
}

export function createApp(cfg = loadConfig()) {
  const db = openDb(cfg.dataDir);
  const acl = makeAcl(db);
  const store = makeStore(cfg.dataDir, cfg.uploadStallMs);
  const secret = loadSecret(path.join(cfg.dataDir, 'secret.key'));
  // Hard lock per (login, IP): a stranger cannot lock someone out from another machine.
  // The per-login ceiling only stops slow password spraying from many IPs.
  const userThrottle = A.throttle({ max: 5 });
  const loginThrottle = A.throttle({ max: 50 });
  const ipThrottle = A.throttle({ max: 30 });
  const SID = cfg.secure ? '__Host-sid' : 'sid';
  const GRANT = cfg.secure ? '__Secure-grant' : 'grant';
  const staticCache = new Map();
  // The editor page is framed from its own origin, and the file token is posted to it.
  const csp = cfg.officeUrl ? CSP.replace("form-action 'self'", `frame-src 'self' ${cfg.officeUrl}; form-action 'self' ${cfg.officeUrl}`) : CSP;
  const routes = [];
  // Bytes of uploads still streaming, so parallel uploads cannot overshoot quotas or fill the disk.
  const reserved = new Map();
  const userInflight = new Map(); // user id -> bytes of their uploads still streaming
  let inflight = 0;
  const downloads = new Map(); // who -> { since, files, bytes, flagged }, one-hour window

  const add = (method, pattern, mode, fn) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, mode, fn });
  };

  const cookie = (name, value, { maxAge, path: p = '/' } = {}) =>
    [`${name}=${value}`, `Path=${p}`, 'HttpOnly', 'SameSite=Strict', cfg.secure && 'Secure', maxAge != null && `Max-Age=${Math.max(0, Math.floor(maxAge))}`]
      .filter(Boolean)
      .join('; ');

  // Proxy headers are believed only from a proxy on this machine (Tailscale Serve, Caddy).
  // The last X-Forwarded-For entry is the one that proxy added; proxies that append (nginx) keep whatever the client sent in front.
  const viaProxy = req => cfg.trustProxy && /^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress || '');
  const clientIp = req => (viaProxy(req) && String(req.headers['x-forwarded-for'] || '').split(',').pop().trim()) || req.socket.remoteAddress || '';

  // Per-IP limits: an IPv6 client controls a whole /64, so the /64 is what gets counted.
  const ipKey = ip => {
    if (!ip.includes(':') || ip.startsWith('::ffff:')) return ip.replace(/^::ffff:/, '');
    const [head, tail = ''] = ip.split('%')[0].split('::');
    const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
    return [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t].slice(0, 4).join(':') + '::/64';
  };

  // At most two password checks at a time: scrypt is CPU-heavy, and the NAS serves other people too.
  // A "busy" answer counts against the IP, so one source cannot keep both slots full for long.
  // ponytail: a large botnet can still keep them busy; add proof-of-work or a CAPTCHA if that ever happens.
  let hashing = 0;
  async function checkPassword(c, pw, hash) {
    if (hashing >= 2) {
      ipThrottle.fail('ip:' + ipKey(c.ip));
      fail(503, 'The server is busy. Try again in a few seconds.');
    }
    hashing++;
    try {
      return await A.verifyPassword(pw, hash);
    } finally {
      hashing--;
    }
  }

  // ---------- brute force ----------
  // perKey: the ceiling across all IPs. Off for external links: their passwords are long random ones, and a
  // global ceiling would only let whoever has the URL lock the real recipient out.
  function guard(c, key, perKey = true) {
    const wait = Math.max(userThrottle.wait(`${key}@${ipKey(c.ip)}`), perKey ? loginThrottle.wait(key) : 0, ipThrottle.wait('ip:' + ipKey(c.ip)));
    if (wait) fail(429, `Too many failed attempts. Try again in ${Math.ceil(wait / 60e3)} min.`);
  }
  const cleared = (c, key) => userThrottle.clear(`${key}@${ipKey(c.ip)}`);
  function failed(c, key, perKey = true) {
    userThrottle.fail(`${key}@${ipKey(c.ip)}`);
    if (perKey) loginThrottle.fail(key);
    ipThrottle.fail('ip:' + ipKey(c.ip));
  }

  // ---------- sessions ----------
  const isManager = u => !!db.get('SELECT 1 FROM members WHERE user_id = ? AND group_id = ?', u.id, db.ids.managers);

  // Sign-in is the password alone (2FA was removed at the company's request on 2026-11-18); a temporary password
  // from IT must be replaced first.
  const stageOf = user => (user.must_change ? 'change' : 'full');

  const STAGES = { pw: ['change', 'full'], full: ['full'], user: ['full'], admin: ['full'], audit: ['full'] };

  function authenticate(c, mode) {
    if (mode === 'public' || mode === 'wopi') return; // wopi: checked by its token in the route
    if (mode === 'agent') return Object.assign(c, agentAuth(c.req)); // auto-save agent: device token, no cookies
    const t = cookies(c.req)[SID];
    const now = Date.now();
    const s = t && db.get('SELECT * FROM sessions WHERE id = ?', A.sha256(t));
    const user = s && db.get('SELECT * FROM users WHERE id = ?', s.user_id);
    if (!s || !user || user.disabled || now - s.seen_at > SESSION_IDLE || now - s.created_at > SESSION_MAX) {
      if (s) db.run('DELETE FROM sessions WHERE id = ?', s.id);
      if (mode === 'optional') return;
      fail(401, 'Your session has ended. Sign in again.', 'auth');
    }
    if (now - s.seen_at > 60e3) db.run('UPDATE sessions SET seen_at = ? WHERE id = ?', now, s.id);
    Object.assign(c, { user, session: s, stage: stageOf(user), ctx: acl.ctxFor(user) });
    if (mode === 'optional' || mode === 'any') return;
    if (!STAGES[mode].includes(c.stage)) fail(403, 'Finish signing in first.', 'stage');
    if (mode === 'user' && user.is_admin) fail(403, 'Admin accounts have no access to files. Sign in with your employee account.');
    if (mode === 'admin' && !user.is_admin) fail(403, 'Only IT administrators can do this.');
    if (mode === 'audit' && !user.is_admin && !isManager(user)) fail(403, 'Only Managers and IT can view the activity log.');
  }

  const audit = (c, cat, action, target, nodeId = null) => db.audit(cat, c.user?.id ?? null, action, target, c.ip, nodeId);

  // ---------- files ----------
  function need(c, id, min) {
    const r = acl.resolve(c.ctx, Number(id));
    if (!r || !r.level) fail(404, 'This file or folder does not exist, or you have no access to it.');
    if (r.level < min) fail(403, min === EDIT ? 'You can only view this folder.' : 'Only the folder manager can do this.');
    return r;
  }

  const view = (n, level) => ({
    id: n.id,
    name: n.name,
    dir: !!n.is_dir,
    size: n.size,
    updated_at: n.updated_at,
    updated_by: n.updated_by_name ?? null,
    level,
    restricted: !n.inherit,
    system: !!n.system,
  });

  // Current files, files in trash and their older versions all take disk space, so all count. Summing a big folder
  // takes a while, so the total is kept until the database changes (any write here, or one by another process); an
  // upload adds its own size instead (placeFile), so a burst of uploads does not sum the whole folder for each file.
  const usageMemo = new Map(); // folder id -> { mark, used }
  const changeMark = () => `${db.get('SELECT total_changes() AS t').t}:${db.get('PRAGMA data_version').data_version}`;
  const usage = id => {
    const mark = changeMark();
    const m = usageMemo.get(id);
    if (m?.mark === mark) return m.used;
    const used = db.get(
      `${SUBTREE} SELECT COALESCE((SELECT SUM(n.size) FROM nodes n JOIN t ON n.id = t.id WHERE n.is_dir = 0), 0)
                    + COALESCE((SELECT SUM(v.size) FROM versions v JOIN t ON v.node_id = t.id), 0) AS used`,
      id,
    ).used;
    if (usageMemo.size > 500) usageMemo.clear();
    usageMemo.set(id, { mark, used });
    return used;
  };

  function checkQuota(chain, adding, skip = []) {
    for (const n of chain) {
      if (n.quota == null || skip.includes(n.id)) continue;
      const used = usage(n.id) + (reserved.get(n.id) || 0);
      if (used + adding > n.quota) fail(413, `Not enough space in "${n.name}": ${fmtBytes(n.quota - used)} free of ${fmtBytes(n.quota)}.`);
    }
  }

  const reserve = (ids, bytes) => {
    for (const id of ids) reserved.set(id, (reserved.get(id) || 0) + bytes);
    inflight += bytes;
  };

  // The NAS also holds other data: never let uploads eat the last MIN_FREE_GB of the disk.
  async function checkDisk() {
    const s = await fs.promises.statfs(cfg.dataDir);
    if (s.bavail * s.bsize - inflight < cfg.minFree) fail(507, 'The server is running out of disk space. Ask IT to free some space.');
  }


  // Streams a request body into a new blob, holding its size against quotas and the disk while it arrives.
  async function receiveBlob(c, chain, size) {
    checkQuota(chain, size);
    // One person cannot hold the disk with many slow uploads: at most two maximum-size uploads in flight.
    const mine = userInflight.get(c.user.id) || 0;
    if (mine + size > 2 * cfg.maxFile) fail(429, 'Wait until your other uploads finish.');
    const quotaIds = chain.filter(n => n.quota != null).map(n => n.id);
    reserve(quotaIds, size);
    userInflight.set(c.user.id, mine + size);
    try {
      await checkDisk();
      return await store.receive(c.req, size);
    } finally {
      reserve(quotaIds, -size);
      const left = (userInflight.get(c.user.id) || 0) - size;
      if (left > 0) userInflight.set(c.user.id, left);
      else userInflight.delete(c.user.id);
    }
  }

  function checkPathLength(chain, name, nodeId = null) {
    const deepest = nodeId
      ? db.get('WITH RECURSIVE t(id, len, d) AS (SELECT ?, 0, 0 UNION ALL SELECT n.id, t.len + 1 + length(n.name), t.d + 1 FROM nodes n JOIN t ON n.parent_id = t.id WHERE t.d < 500) SELECT MAX(len) AS m FROM t', nodeId).m
      : 0;
    if (chain.map(n => n.name).join('/').length + 1 + name.length + deepest > PATH_MAX) fail(400, `The full path would be longer than ${PATH_MAX} characters. Use a shorter name.`);
  }

  // Stops someone with Edit from moving or deleting restricted folders they cannot even see.
  // Restricted folders in the trash count too: otherwise moving the parent somewhere you manage would let you
  // restore and open them.
  function guardHidden(c, r) {
    if (!r.node.is_dir) return;
    const rows = db.all(`${SUBTREE} SELECT n.id FROM nodes n JOIN t ON n.id = t.id WHERE n.inherit = 0 AND n.id != ?`, r.node.id, r.node.id);
    for (const { id } of rows)
      if ((acl.resolve(c.ctx, id, { anyDeleted: true })?.level || 0) < EDIT) fail(403, 'This folder contains restricted folders you cannot edit, so only their managers can move or delete it.');
  }

  const taken = (parentId, name) => db.get('SELECT * FROM nodes WHERE parent_id = ? AND name = ? COLLATE NOCASE AND deleted_at IS NULL', parentId, name);
  const unique = (fn, msg = 'Something with this name already exists here.') => {
    try {
      return fn();
    } catch (e) {
      if (/UNIQUE/.test(e.message)) fail(409, msg);
      throw e;
    }
  };

  function trimVersions(nodeId) {
    const old = db.all('SELECT id, blob FROM versions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?', nodeId, MAX_VERSIONS);
    for (const v of old) db.run('DELETE FROM versions WHERE id = ?', v.id);
    store.remove(old.map(v => v.blob));
  }

  // Bulk-download brake against data theft: counts every byte sent (ranges included) and every distinct file,
  // however it is fetched (whole, in ranges, as a preview). Returns true the first time a file is sent this hour.
  function meterDownload(c, who, bytes, blob) {
    const now = Date.now();
    let e = downloads.get(who);
    if (!e || now - e.since > 3600e3) downloads.set(who, (e = { since: now, files: 0, bytes: 0, flagged: false, seen: new Set() }));
    const newFile = !e.seen.has(blob);
    if (e.files + (newFile ? 1 : 0) > cfg.dlFiles || e.bytes + bytes > cfg.dlBytes) {
      if (!e.flagged) {
        e.flagged = true;
        audit(c, 'file', `ALERT download limit reached (${e.files} files, ${fmtBytes(e.bytes)} in under an hour); downloads paused`, who);
      }
      fail(429, 'You downloaded a lot in the last hour, so downloads are paused for a while. If you need more, ask your manager or IT.');
    }
    e.files += newFile ? 1 : 0;
    e.bytes += bytes;
    e.seen.add(blob);
    return newFile;
  }

  // logged(action) writes the activity-log row; it runs once per file per hour, after the limit check passed.
  function sendFile(c, blob, size, name, inline, who, logged) {
    const type = inline ? PREVIEW[ext(name)] : null;
    const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    const headers = {
      'Content-Type': type || 'application/octet-stream',
      'Content-Disposition': `${type ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
    };
    // PDFs need the browser viewer; anything else is locked into a sandbox so it can never run as a page.
    if (type === 'application/pdf') c.res.removeHeader('Content-Security-Policy');
    else c.res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    let start = 0, end = size - 1, status = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(c.req.headers.range || '');
    if (m && size > 0) {
      if (m[1] === '') start = Math.max(0, size - Number(m[2] || 0));
      else {
        start = Number(m[1]);
        if (m[2] !== '') end = Math.min(Number(m[2]), size - 1);
      }
      if (start > end || start >= size) {
        c.res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        return c.res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = size ? end - start + 1 : 0;
    if (c.req.method !== 'HEAD' && meterDownload(c, who, headers['Content-Length'], blob)) logged?.(type ? 'opened' : 'downloaded');
    c.res.writeHead(status, headers);
    if (!size || c.req.method === 'HEAD') return c.res.end();
    pipeline(store.read(blob, start, end), c.res).catch(() => {});
  }

  // ---------- sharing ----------
  const canShare = r => r.area === 'projects' && !r.node.system && r.level === MANAGE;

  function shareFor(c) {
    const s = db.get('SELECT * FROM shares WHERE token = ?', String(c.params.token));
    const creator = s && db.get('SELECT * FROM users WHERE id = ?', s.created_by);
    const r = s && !s.revoked && s.expires_at > Date.now() && creator && !creator.disabled ? acl.resolve(acl.NOBODY, s.node_id) : null;
    // A link lives only while its creator is active and still manages the folder.
    if (!r || r.area !== 'projects' || acl.resolve(acl.ctxFor(creator, true), s.node_id)?.level !== MANAGE)
      fail(404, 'This link has expired or was turned off. Ask the sender for a new one.');
    return { s, r };
  }
  function granted(c, s) {
    const [exp, sig] = (cookies(c.req)[GRANT] || '').split('.');
    return Number(exp) > Date.now() && A.safeEqual(sig, A.hmac(secret, `${s.id}.${exp}`));
  }
  function sharedItem(c, s) {
    const x = acl.resolve(acl.NOBODY, c.query.get('id') ? Number(c.query.get('id')) : s.node_id);
    const at = x ? x.chain.findIndex(n => n.id === s.node_id) : -1;
    // Restricted subfolders inside a shared folder stay internal.
    if (at < 0 || x.chain.slice(at + 1).some(n => !n.inherit)) fail(404, 'Not found.');
    return { x, crumbs: x.chain.slice(at).map(n => ({ id: n.id, name: n.name })) };
  }

  // ---------- access lists ----------
  const describeAcl = id =>
    db
      .all(`SELECT COALESCE(u.name, g.name) AS name, a.level FROM acl a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN groups g ON g.id = a.group_id WHERE a.node_id = ? ORDER BY name`, id)
      .map(e => `${e.name}: ${LEVELS[e.level]}`)
      .join('; ') || 'nobody';

  function accessTarget(c) {
    if (c.user.is_admin) {
      const r = acl.resolve(acl.NOBODY, Number(c.params.id));
      if (!r || !r.node.system) fail(404, 'Not found.');
      return { r, editable: r.area !== 'personal', maxLevel: MANAGE };
    }
    const r = need(c, c.params.id, READ);
    return { r, editable: canManageAccess(r.node, r.level, r.area, isManager(c.user)), maxLevel: EDIT };
  }

  // Who may change access to a section, folder or single file: Managers anywhere they can open, except
  // confidential and personal space; otherwise whoever manages it. IT-made folders are off limits to
  // Manage holders, except confidential folders (owner set by IT) and personal folders (their owner).
  function canManageAccess(node, level, area, manager = false) {
    if (manager && level > 0 && area !== 'confidential' && area !== 'personal') return true;
    return level === MANAGE && (!node.system || area === 'confidential' || area === 'personal');
  }

  function parseEntries(list, { maxLevel, confidential }) {
    if (!Array.isArray(list) || list.length > 300) fail(400, 'Invalid access list.');
    const seen = new Set();
    const out = [];
    for (const e of list) {
      const level = Number(e?.level), id = Number(e?.id);
      if (![READ, EDIT, MANAGE].includes(level)) fail(400, 'Invalid access level.');
      if (level > maxLevel) fail(400, 'You can give Read or Edit access. Manage access is set by IT.');
      if (e.type === 'user') {
        const u = db.get('SELECT is_admin, disabled FROM users WHERE id = ?', id);
        if (!u || u.disabled) fail(400, 'Unknown or blocked employee.');
        if (u.is_admin) fail(400, 'Admin accounts cannot be given access to files.');
      } else if (e.type === 'group') {
        const g = db.get('SELECT kind FROM groups WHERE id = ?', id);
        if (!g) fail(400, 'Unknown group.');
        if (confidential && g.kind !== 'managers') fail(400, 'Confidential folders are shared with specific people, not groups.');
      } else fail(400, 'Invalid access entry.');
      if (seen.has(e.type + id)) continue;
      seen.add(e.type + id);
      out.push({ type: e.type, id, level });
    }
    return out;
  }

  function insertAcl(nodeId, e, orIgnore = false) {
    db.run(`INSERT ${orIgnore ? 'OR IGNORE ' : ''}INTO acl(node_id, ${e.type === 'user' ? 'user_id' : 'group_id'}, level) VALUES(?, ?, ?)`, nodeId, e.id, e.level);
  }

  function newSystemFolder(parentId, name, quota) {
    const now = Date.now();
    return unique(() => db.run('INSERT INTO nodes(parent_id, name, is_dir, system, quota, created_at, updated_at) VALUES(?, ?, 1, 1, ?, ?, ?)', parentId, name, quota, now, now).lastInsertRowid);
  }

  const quotaArg = v => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!(n > 0 && n <= 100000)) fail(400, 'Quota must be a number of GB between 1 and 100000.');
    return Math.round(n * 2 ** 30);
  };

  const activeUser = id => {
    const u = db.get('SELECT * FROM users WHERE id = ?', Number(id));
    if (!u || u.disabled || u.is_admin) fail(400, 'Choose an active employee account.');
    return u;
  };

  // =====================================================================
  // Sign-in
  // =====================================================================
  add('GET', '/api/me', 'optional', c => ({
    appName: cfg.appName,
    office: !!cfg.officeUrl,
    pdfEdit: !!(cfg.officeUrl && cfg.pdfConverter),
    stage: c.stage ?? null,
    user: c.user ? { id: c.user.id, login: c.user.login, name: c.user.name, admin: !!c.user.is_admin, manager: isManager(c.user) } : null,
  }));

  add('POST', '/api/login', 'public', async c => {
    const b = await body(c);
    const login = str(b.login, 64);
    const password = typeof b.password === 'string' ? b.password.slice(0, 200) : '';
    if (!login || !password) fail(400, 'Enter your login and password.');
    const user = db.get('SELECT * FROM users WHERE login = ? OR email = ?', login, login.toLowerCase());
    const key = 'u:' + (user ? user.login : login).toLowerCase(); // login and email share one budget
    guard(c, key);
    const ok = await checkPassword(c, password, user ? user.pass : A.DUMMY_HASH);
    if (!user || !ok) {
      failed(c, key);
      db.audit('auth', user?.id, 'sign-in failed: wrong password', login, c.ip);
      fail(401, 'Wrong login or password.');
    }
    if (user.disabled) {
      db.audit('auth', user.id, 'sign-in refused: account blocked', login, c.ip);
      fail(403, 'This account is blocked. Ask IT to unblock it.');
    }
    cleared(c, key);
    const t = A.token();
    const now = Date.now();
    db.run('INSERT INTO sessions(id, user_id, mfa, created_at, seen_at, ip, ua) VALUES(?, ?, 0, ?, ?, ?, ?)', A.sha256(t), user.id, now, now, c.ip, String(c.req.headers['user-agent'] || '').slice(0, 200));
    c.res.setHeader('Set-Cookie', cookie(SID, t, { maxAge: SESSION_MAX / 1000 }));
    db.audit('auth', user.id, 'signed in', null, c.ip);
    return { stage: stageOf(user) };
  });

  add('POST', '/api/logout', 'optional', c => {
    if (c.session) {
      db.run('DELETE FROM sessions WHERE id = ?', c.session.id);
      audit(c, 'auth', 'signed out');
    }
    c.res.setHeader('Set-Cookie', cookie(SID, '', { maxAge: 0 }));
  });

  add('POST', '/api/password', 'pw', async c => {
    const b = await body(c);
    const key = 'u:' + c.user.login.toLowerCase();
    guard(c, key);
    if (!(await checkPassword(c, String(b.current ?? ''), c.user.pass))) {
      failed(c, key);
      fail(400, 'Your current password is wrong.');
    }
    const problem = A.passwordProblem(b.next, c.user.login);
    if (problem) fail(400, problem);
    if (b.next === b.current) fail(400, 'Choose a password different from the current one.');
    db.run('UPDATE users SET pass = ?, must_change = 0 WHERE id = ?', await A.hashPassword(b.next), c.user.id);
    db.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', c.user.id, c.session.id);
    audit(c, 'auth', 'password changed');
    return { stage: stageOf({ ...c.user, must_change: 0 }) };
  });

  // =====================================================================
  // Files and folders
  // =====================================================================
  add('GET', '/api/spaces', 'user', c => acl.spaces(c.ctx));

  // Shared with me: files and folders people gave me by name. Manage grants come from IT and live in the sidebar.
  add('GET', '/api/shared', 'user', c => {
    const out = [];
    const res = acl.resolver(c.ctx);
    for (const { node_id } of db.all('SELECT node_id FROM acl WHERE user_id = ? AND level < ?', c.user.id, MANAGE)) {
      const r = res(node_id);
      if (!r?.level) continue;
      const { context, crumbs } = acl.crumbs(c.ctx, r);
      out.push({ ...view(r.node, r.level), location: [context, ...crumbs.slice(0, -1).map(x => x.name)].filter(Boolean).join(' / ') });
    }
    return out.sort((a, b) => b.updated_at - a.updated_at);
  });

  add('GET', '/api/directory', 'full', () => ({
    users: db.all('SELECT id, name, login FROM users WHERE disabled = 0 AND is_admin = 0 ORDER BY name'),
    groups: db.all('SELECT id, name, kind FROM groups ORDER BY kind, name'),
  }));

  add('GET', '/api/nodes/:id', 'user', c => {
    const r = need(c, c.params.id, READ);
    const q = r.chain.findLast(n => n.quota != null);
    const mgr = isManager(c.user);
    return {
      node: view(r.node, r.level),
      area: r.area,
      ...acl.crumbs(c.ctx, r),
      quota: q ? { name: q.name, used: usage(q.id), total: q.quota } : null,
      can: { edit: r.level >= EDIT, manage: canManageAccess(r.node, r.level, r.area, mgr), share: canShare(r) },
      children: r.node.is_dir
        ? acl.children(c.ctx, r).map(n => ({ ...view(n, n.level), manage: canManageAccess(n, n.level, r.area, mgr), share: r.area === 'projects' && !n.system && n.level === MANAGE }))
        : undefined,
    };
  });

  add('POST', '/api/nodes/:id/folders', 'user', async c => {
    const r = need(c, c.params.id, EDIT);
    if (!r.node.is_dir) fail(400, 'Choose a folder.');
    const name = cleanName((await body(c)).name);
    checkPathLength(r.chain, name);
    const now = Date.now();
    const id = unique(() => db.run('INSERT INTO nodes(parent_id, name, is_dir, created_at, updated_at, updated_by) VALUES(?, ?, 1, ?, ?, ?)', r.node.id, name, now, now, c.user.id).lastInsertRowid);
    audit(c, 'file', 'created folder', `${pathOf(r.chain)} / ${name}`, id);
    return { id };
  });

  add('PUT', '/api/nodes/:id/files', 'user', async c => {
    const r = need(c, c.params.id, EDIT);
    if (!r.node.is_dir) fail(400, 'Choose a folder.');
    const name = cleanName(c.query.get('name'));
    checkPathLength(r.chain, name);
    const size = Number(c.req.headers['content-length']);
    if (!Number.isSafeInteger(size) || size < 0) fail(411, 'The file size is missing.');
    if (size > cfg.maxFile) fail(413, `Files larger than ${fmtBytes(cfg.maxFile)} cannot be uploaded.`);
    // Only a clash with something this person can see is answered up front; anything else is checked at the
    // end, so an early answer cannot reveal hidden restricted names.
    const before = taken(r.node.id, name);
    if (before?.is_dir && acl.resolve(c.ctx, before.id)?.level) fail(409, 'A folder with this name already exists here.');
    const blob = await receiveBlob(c, r.chain, size);
    return { id: placeFile(c, r, name, blob, size).id };
  });

  // =====================================================================
  // Resumable uploads: tus 1.0 (creation, creation-with-upload, termination, concatenation, expiration)
  // =====================================================================
  // Bytes are appended to data/uploads/<id> as they arrive, so an upload cut off by a lost connection or a closed
  // page continues from the last byte stored. Small files come with the creating request (one round trip); large
  // ones in parallel parts joined at the end. A finished upload becomes a file through the same checks as any.
  const TUS_DIR = path.join(cfg.dataDir, 'uploads');
  fs.mkdirSync(TUS_DIR, { recursive: true });
  const TUS_TTL = 3 * DAY;
  const tusBusy = new Set(); // uploads a request is writing to right now
  const tusFile = id => path.join(TUS_DIR, id);
  const tusOffset = id => fs.statSync(tusFile(id)).size;
  const tusHeaders = (extra = {}) => ({ 'Tus-Resumable': '1.0.0', 'Cache-Control': 'no-store', ...extra });
  const tusExpires = () => new Date(Date.now() + TUS_TTL).toUTCString();
  const tusPending = () => db.get('SELECT COALESCE(SUM(size - offset), 0) AS n FROM uploads').n;
  const isTusBody = c => /^application\/offset\+octet-stream\b/i.test(c.req.headers['content-type'] || '');

  function tusMeta(header) {
    const out = {};
    for (const pair of String(header || '').split(',')) {
      const [k, v] = pair.trim().split(' ');
      if (k) out[k] = v ? Buffer.from(v, 'base64').toString('utf8') : '';
    }
    return out;
  }

  function tusRow(c) {
    const up = db.get('SELECT * FROM uploads WHERE id = ? AND user_id = ?', String(c.params.id), c.user.id);
    if (!up || !fs.existsSync(tusFile(up.id))) fail(404, 'This upload is gone. Start it again.');
    return up;
  }

  // Where it will land (from the upload's metadata): a folder this person can edit, and a valid name.
  // In tus a 409 means "wrong offset, ask again", so refusals about the file itself are 422: the client stops.
  function tusTarget(c, meta) {
    try {
      const r = need(c, int(meta.folder), EDIT);
      if (!r.node.is_dir) fail(400, 'Choose a folder.');
      const name = cleanName(meta.name);
      checkPathLength(r.chain, name);
      const before = taken(r.node.id, name);
      if (before?.is_dir && acl.resolve(c.ctx, before.id)?.level) fail(422, 'A folder with this name already exists here.');
      return { r, name };
    } catch (e) {
      if (e.status === 409) e.status = 422;
      throw e;
    }
  }

  // One request at a time per upload; a second one gets 423 and the client asks again later.
  async function tusLocked(id, fn) {
    if (tusBusy.has(id)) fail(423, 'This upload is already receiving data.');
    tusBusy.add(id);
    try {
      return await fn();
    } finally {
      tusBusy.delete(id);
    }
  }

  function tusDrop(ids) {
    for (const id of ids) {
      db.run('DELETE FROM uploads WHERE id = ?', id);
      fs.rmSync(tusFile(id), { force: true });
    }
  }

  // Appends the request body to the upload. A dropped connection keeps what arrived; the client resumes from there.
  async function tusAppend(c, up) {
    const at = tusOffset(up.id);
    if (Number(c.req.headers['upload-offset']) !== at) fail(409, 'The upload continues from another point.');
    let n = 0, seen = 0;
    const room = up.size - at;
    const guard = new Transform({
      transform(chunk, _enc, cb) {
        n += chunk.length;
        cb(n > room ? Object.assign(new Error('More data than the upload size.'), { status: 413 }) : null, chunk);
      },
    });
    const watch = setInterval(() => {
      if (n - seen < 16384) c.req.destroy(Object.assign(new Error('The upload stalled.'), { status: 408 }));
      seen = n;
    }, cfg.uploadStallMs || 60e3);
    try {
      await pipeline(c.req, guard, fs.createWriteStream(tusFile(up.id), { flags: 'a' }));
    } catch (e) {
      if (e.status === 413) throw e;
    } finally {
      clearInterval(watch);
    }
    const offset = tusOffset(up.id);
    db.run('UPDATE uploads SET offset = ?, expires_at = ? WHERE id = ?', offset, Date.now() + TUS_TTL, up.id);
    return offset;
  }

  // The last byte arrived: the file goes into its folder. If that is refused now (access taken away, quota full,
  // a file of that name made meanwhile), the upload is dropped so the client reports it instead of retrying.
  async function tusFinish(c, ups, meta, size) {
    let target;
    try {
      target = tusTarget(c, meta);
      if (ups.length > 1) checkQuota(target.r.chain, size);
    } catch (e) {
      if (e.status < 500) tusDrop(ups.map(u => u.id));
      throw e;
    }
    const first = tusFile(ups[0].id);
    for (const p of ups.slice(1)) await pipeline(fs.createReadStream(tusFile(p.id)), fs.createWriteStream(first, { flags: 'a' }));
    for (const p of ups) db.run('DELETE FROM uploads WHERE id = ?', p.id);
    for (const p of ups.slice(1)) fs.rmSync(tusFile(p.id), { force: true });
    const blob = await store.adopt(first);
    try {
      return placeFile(c, target.r, target.name, blob, size); // removes the blob itself when refused
    } catch (e) {
      if (e.status === 409) e.status = 422;
      throw e;
    }
  }

  add('POST', '/api/tus', 'user', async c => {
    const h = c.req.headers;
    const concat = String(h['upload-concat'] || '');
    const meta = tusMeta(h['upload-metadata']);
    if (concat.startsWith('final;')) return tusConcat(c, concat.slice(6), meta);
    const size = Number(h['upload-length']);
    if (!Number.isSafeInteger(size) || size < 0) fail(400, 'The upload size is missing.');
    if (size > cfg.maxFile) fail(413, `Files larger than ${fmtBytes(cfg.maxFile)} cannot be uploaded.`);
    const partial = concat === 'partial';
    const { r, name } = tusTarget(c, meta); // parts carry the metadata too, so a refused upload stops at once
    // A small file arriving whole with the creating request: received and placed in one go, with no upload record
    // (the client starts such files again rather than resuming them). Same cost as the plain upload.
    if (!partial && isTusBody(c) && Number(c.req.headers['content-length']) === size) {
      const blob = await receiveBlob(c, r.chain, size);
      try {
        placeFile(c, r, name, blob, size);
      } catch (e) {
        if (e.status === 409) e.status = 422;
        throw e;
      }
      c.res.writeHead(201, tusHeaders({ Location: `/api/tus/${A.token(18)}`, 'Upload-Offset': size }));
      return c.res.end();
    }
    // ponytail: unfinished uploads hold no quota; the check when the file is placed is the one that counts.
    if (!partial) checkQuota(r.chain, size);
    const mine = db.get('SELECT COUNT(*) AS n, COALESCE(SUM(size - offset), 0) AS b FROM uploads WHERE user_id = ?', c.user.id);
    if (mine.n >= 20000 || mine.b + size > 2 * cfg.maxFile) fail(429, 'You have too many unfinished uploads. Let them finish or cancel some.');
    const s = await fs.promises.statfs(cfg.dataDir);
    if (s.bavail * s.bsize - inflight - tusPending() - size < cfg.minFree) fail(507, 'The server is running out of disk space. Ask IT to free some space.');
    const id = A.token(18);
    fs.writeFileSync(tusFile(id), '', { flag: 'wx' });
    const now = Date.now();
    db.run('INSERT INTO uploads(id, user_id, kind, folder_id, name, size, offset, meta, created_at, expires_at) VALUES(?, ?, ?, ?, ?, ?, 0, ?, ?, ?)',
      id, c.user.id, partial ? 'partial' : 'single', r.node.id, name, size, JSON.stringify(meta), now, now + TUS_TTL);
    let offset = 0;
    await tusLocked(id, async () => {
      const up = db.get('SELECT * FROM uploads WHERE id = ?', id);
      if (isTusBody(c)) {
        c.req.headers['upload-offset'] = '0';
        offset = await tusAppend(c, up).catch(e => {
          tusDrop([id]);
          throw e;
        });
      }
      if (!partial && offset === size) await tusFinish(c, [up], meta, size);
    });
    c.res.writeHead(201, tusHeaders({ Location: `/api/tus/${id}`, 'Upload-Offset': offset, 'Upload-Expires': tusExpires() }));
    c.res.end();
  });

  add('HEAD', '/api/tus/:id', 'user', c => {
    const up = tusRow(c);
    c.res.writeHead(200, tusHeaders({ 'Upload-Offset': tusOffset(up.id), 'Upload-Length': up.size, ...(up.kind === 'partial' ? { 'Upload-Concat': 'partial' } : {}) }));
    c.res.end();
  });

  add('PATCH', '/api/tus/:id', 'user', async c => {
    if (!isTusBody(c)) fail(415, 'Expected application/offset+octet-stream.');
    const offset = await tusLocked(String(c.params.id), async () => {
      const up = tusRow(c);
      const at = await tusAppend(c, up);
      if (up.kind === 'single' && at === up.size) await tusFinish(c, [up], JSON.parse(up.meta), up.size);
      return at;
    });
    c.res.writeHead(204, tusHeaders({ 'Upload-Offset': offset, 'Upload-Expires': tusExpires() }));
    c.res.end();
  });

  add('DELETE', '/api/tus/:id', 'user', async c => {
    await tusLocked(String(c.params.id), () => tusDrop([tusRow(c).id]));
    c.res.writeHead(204, tusHeaders());
    c.res.end();
  });

  // The parts of a large file sent in parallel are joined into one: the first part's file grows, the rest go.
  async function tusConcat(c, list, meta) {
    const ids = list.trim().split(/\s+/).map(u => u.split('/').pop());
    if (!ids.length || ids.length > 64 || new Set(ids).size !== ids.length) fail(400, 'Invalid upload parts.');
    const parts = ids.map(id => db.get("SELECT * FROM uploads WHERE id = ? AND user_id = ? AND kind = 'partial'", id, c.user.id));
    if (parts.some(p => !p || tusBusy.has(p.id) || !fs.existsSync(tusFile(p.id)) || tusOffset(p.id) !== p.size)) fail(400, 'Some parts of this upload are missing or unfinished.');
    const size = parts.reduce((sum, p) => sum + p.size, 0);
    if (size > cfg.maxFile) {
      tusDrop(ids);
      fail(413, `Files larger than ${fmtBytes(cfg.maxFile)} cannot be uploaded.`);
    }
    for (const id of ids) tusBusy.add(id);
    try {
      await tusFinish(c, parts, meta, size);
    } finally {
      for (const id of ids) tusBusy.delete(id);
    }
    c.res.writeHead(201, tusHeaders({ Location: `/api/tus/${parts[0].id}`, 'Upload-Offset': size }));
    c.res.end();
  }

  // Unfinished uploads of this person (to offer "continue" after a page reload); parts are counted per file.
  add('GET', '/api/tus', 'user', c => {
    const rows = db.all('SELECT folder_id, name, kind, SUM(size) AS size, SUM(offset) AS done, MAX(expires_at) AS expires_at FROM uploads WHERE user_id = ? GROUP BY folder_id, name ORDER BY MAX(created_at)', c.user.id);
    return rows.map(u => ({ folder: u.folder_id, name: u.name, size: u.size, done: u.done, expires_at: u.expires_at }));
  });

  // "Discard" for unfinished uploads someone does not want to continue.
  add('DELETE', '/api/tus', 'user', c => {
    tusDrop(db.all('SELECT id FROM uploads WHERE user_id = ?', c.user.id).map(u => u.id).filter(id => !tusBusy.has(id)));
  });

  // Creates a folder structure in one go (folder uploads), reusing folders that already exist.
  add('POST', '/api/nodes/:id/tree', 'user', async c => {
    const paths = (await body(c)).paths;
    const r = need(c, c.params.id, EDIT);
    if (!r.node.is_dir) fail(400, 'Choose a folder.');
    if (!Array.isArray(paths) || !paths.length || paths.length > 1000) fail(400, 'Send between 1 and 1000 folder paths at a time.');
    const ids = {};
    let created = 0;
    db.tx(() => {
      for (const p of paths) {
        const segs = typeof p === 'string' ? p.split('/').filter(Boolean) : [];
        if (!segs.length || segs.length > 40) fail(400, 'Invalid folder path.');
        let parent = r.node.id, names = r.chain.map(n => n.name), key = '';
        for (const raw of segs) {
          const name = cleanName(raw);
          key = key ? `${key}/${raw}` : raw;
          if (names.join('/').length + 1 + name.length > PATH_MAX) fail(400, `The full path would be longer than ${PATH_MAX} characters: ${key}`);
          names = [...names, name];
          if (ids[key]) {
            parent = ids[key];
            continue;
          }
          const ex = taken(parent, name);
          if (ex) {
            if (!ex.is_dir) fail(409, `"${key}" already exists here as a file.`);
            if ((acl.resolve(c.ctx, ex.id)?.level || 0) < EDIT) fail(403, `You cannot add files to "${key}".`);
            parent = ex.id;
          } else {
            const now = Date.now();
            parent = db.run('INSERT INTO nodes(parent_id, name, is_dir, created_at, updated_at, updated_by) VALUES(?, ?, 1, ?, ?, ?)', parent, name, now, now, c.user.id).lastInsertRowid;
            created++;
          }
          ids[key] = parent;
        }
      }
    });
    if (created) audit(c, 'file', `uploaded a folder structure (${created} new folder${created === 1 ? '' : 's'})`, pathOf(r.chain), r.node.id);
    return { ids };
  });

  // ---- a folder as a zip, written while it is read: no temporary archive, the download starts at once ----
  // Stored (not compressed): office files, PDFs and photos are compressed already, and the NAS CPU stays free.
  // The exact length is known beforehand, so the browser shows progress and time left.
  function zipPlan(c, r) {
    const entries = [];
    const walk = (id, prefix) => {
      for (const n of db.all('SELECT * FROM nodes WHERE parent_id = ? AND deleted_at IS NULL ORDER BY is_dir DESC, name', id)) {
        if (!acl.resolve(c.ctx, n.id)?.level) continue; // restricted items this person cannot open stay out
        const p = `${prefix}${n.name}`;
        if (n.is_dir) {
          entries.push({ path: `${p}/`, dir: true, time: n.updated_at });
          walk(n.id, `${p}/`);
        } else entries.push({ path: p, size: n.size, blob: n.blob, time: n.updated_at, id: n.id });
        if (entries.length > 100000) fail(413, 'This folder has too many items to download at once. Download its subfolders.');
      }
    };
    entries.push({ path: `${r.node.name}/`, dir: true, time: r.node.updated_at });
    walk(r.node.id, `${r.node.name}/`);
    let at = 0;
    for (const e of entries) {
      e.name = Buffer.from(e.path);
      e.offset = at;
      e.zip64 = !e.dir && (e.size >= 0xffffffff || at >= 0xffffffff);
      at += 30 + e.name.length + (e.zip64 ? 20 : 0) + (e.dir ? 0 : e.size + (e.zip64 ? 24 : 16));
    }
    const cdStart = at;
    for (const e of entries) at += 46 + e.name.length + (e.zip64 || e.offset >= 0xffffffff ? 28 : 0);
    const cdSize = at - cdStart;
    const big = entries.length > 0xffff || cdStart >= 0xffffffff || cdSize >= 0xffffffff;
    return { entries, cdStart, cdSize, big, total: at + (big ? 76 : 0) + 22 };
  }

  function dosTime(t) {
    const d = new Date(t);
    return [(d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()];
  }

  add('GET', '/api/nodes/:id/zip', 'user', async c => {
    const r = need(c, c.params.id, READ);
    if (!r.node.is_dir) fail(400, 'Only folders are downloaded as a zip.');
    const plan = zipPlan(c, r);
    const files = plan.entries.filter(e => !e.dir);
    const bytes = files.reduce((s, e) => s + e.size, 0);
    if (files.length > cfg.dlFiles || bytes > cfg.dlBytes)
      fail(429, `This folder (${files.length} files, ${fmtBytes(bytes)}) is more than the hourly download limit. Download its subfolders, or ask your manager or IT.`);
    if (c.query.get('check') === '1') return { files: files.length, bytes }; // the page asks first, so a refusal shows as a message
    const who = `user ${c.user.login}`;
    for (const e of files) meterDownload(c, who, e.size, e.blob); // counted as downloads, before anything is sent
    audit(c, 'file', `downloaded as zip (${files.length} file${files.length === 1 ? '' : 's'}, ${fmtBytes(bytes)})`, pathOf(r.chain), r.node.id);
    const ascii = `${r.node.name}.zip`.replace(/[^\x20-\x7e]|["\\]/g, '_');
    c.res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': plan.total,
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(`${r.node.name}.zip`)}`,
      'Cache-Control': 'private, no-store',
    });
    const res = c.res;
    // Waits while the network is slower than the disk; both listeners go each time (a 50 GB zip waits thousands of times).
    const send = buf => res.write(buf) || new Promise((ok, no) => {
      const drained = () => (res.off('close', closed), ok());
      const closed = () => (res.off('drain', drained), no(new Error('closed')));
      res.once('drain', drained);
      res.once('close', closed);
    });
    try {
      for (const e of plan.entries) {
        const [time, date] = dosTime(e.time);
        const h = Buffer.alloc(30);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(e.zip64 ? 45 : 20, 4);
        h.writeUInt16LE(e.dir ? 0x800 : 0x808, 6); // UTF-8 names; files: sizes and CRC follow the data
        h.writeUInt16LE(time, 10);
        h.writeUInt16LE(date, 12);
        if (e.zip64) h.writeUInt32LE(0xffffffff, 18), h.writeUInt32LE(0xffffffff, 22);
        h.writeUInt16LE(e.name.length, 26);
        h.writeUInt16LE(e.zip64 ? 20 : 0, 28);
        const extra = e.zip64 ? Buffer.concat([Buffer.from([1, 0, 16, 0]), Buffer.alloc(16)]) : Buffer.alloc(0);
        await send(Buffer.concat([h, e.name, extra]));
        if (e.dir) continue;
        let crc = 0, n = 0;
        if (e.size) {
          for await (const chunk of store.read(e.blob)) {
            crc = zlib.crc32(chunk, crc);
            n += chunk.length;
            await send(chunk);
          }
        }
        if (n !== e.size) throw new Error(`size changed: ${e.path}`);
        e.crc = crc;
        const dd = Buffer.alloc(e.zip64 ? 24 : 16);
        dd.writeUInt32LE(0x08074b50, 0);
        dd.writeUInt32LE(crc, 4);
        if (e.zip64) dd.writeBigUInt64LE(BigInt(n), 8), dd.writeBigUInt64LE(BigInt(n), 16);
        else dd.writeUInt32LE(n, 8), dd.writeUInt32LE(n, 12);
        await send(dd);
      }
      const cd = [];
      for (const e of plan.entries) {
        const [time, date] = dosTime(e.time);
        const z = e.zip64 || e.offset >= 0xffffffff;
        const h = Buffer.alloc(46);
        h.writeUInt32LE(0x02014b50, 0);
        h.writeUInt16LE(0x031e, 4); // made by: Unix, spec 3.0
        h.writeUInt16LE(z ? 45 : 20, 6);
        h.writeUInt16LE(e.dir ? 0x800 : 0x808, 8);
        h.writeUInt16LE(time, 12);
        h.writeUInt16LE(date, 14);
        h.writeUInt32LE(e.crc || 0, 16);
        h.writeUInt32LE(z ? 0xffffffff : e.size || 0, 20);
        h.writeUInt32LE(z ? 0xffffffff : e.size || 0, 24);
        h.writeUInt16LE(e.name.length, 28);
        h.writeUInt16LE(z ? 28 : 0, 30);
        h.writeUInt32LE(e.dir ? (0o40755 << 16) | 0x10 : (0o100644 << 16) >>> 0, 38);
        h.writeUInt32LE(z ? 0xffffffff : e.offset, 42);
        let extra = Buffer.alloc(0);
        if (z) {
          extra = Buffer.alloc(28);
          extra.writeUInt16LE(1, 0);
          extra.writeUInt16LE(24, 2);
          extra.writeBigUInt64LE(BigInt(e.size || 0), 4);
          extra.writeBigUInt64LE(BigInt(e.size || 0), 12);
          extra.writeBigUInt64LE(BigInt(e.offset), 20);
        }
        cd.push(h, e.name, extra);
        if (cd.length > 300) await send(Buffer.concat(cd.splice(0)));
      }
      const tail = [];
      const count = plan.entries.length;
      if (plan.big) {
        const z = Buffer.alloc(56);
        z.writeUInt32LE(0x06064b50, 0);
        z.writeBigUInt64LE(44n, 4);
        z.writeUInt16LE(45, 12);
        z.writeUInt16LE(45, 14);
        z.writeBigUInt64LE(BigInt(count), 24);
        z.writeBigUInt64LE(BigInt(count), 32);
        z.writeBigUInt64LE(BigInt(plan.cdSize), 40);
        z.writeBigUInt64LE(BigInt(plan.cdStart), 48);
        const loc = Buffer.alloc(20);
        loc.writeUInt32LE(0x07064b50, 0);
        loc.writeBigUInt64LE(BigInt(plan.cdStart + plan.cdSize), 8);
        loc.writeUInt32LE(1, 16);
        tail.push(z, loc);
      }
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(plan.big ? 0xffff : count, 8);
      end.writeUInt16LE(plan.big ? 0xffff : count, 10);
      end.writeUInt32LE(plan.big ? 0xffffffff : plan.cdSize, 12);
      end.writeUInt32LE(plan.big ? 0xffffffff : plan.cdStart, 16);
      tail.push(end);
      await send(Buffer.concat([...cd, ...tail]));
      res.end();
    } catch {
      res.destroy(); // the browser marks the download as failed instead of saving a broken zip
    }
  });

  // Puts a fully received blob into folder r as `name`: a new file, or a new version of the file already there.
  function placeFile(c, r, name, blob, size) {
    let made, before, above;
    try {
      made = db.tx(() => {
        // Access is checked again now: it may have changed while the file was streaming in.
        const u = db.get('SELECT * FROM users WHERE id = ?', c.user.id);
        const ctx = acl.ctxFor(u);
        const fresh = acl.resolve(ctx, r.node.id);
        if (u.disabled || (fresh?.level || 0) < EDIT) fail(403, 'You no longer have Edit access to this folder.');
        checkQuota(fresh.chain, size); // final word on quotas, also for uploads that took days
        before = changeMark();
        above = fresh.chain.map(n => n.id);
        const cur = taken(r.node.id, name);
        const now = Date.now();
        if (cur && (cur.is_dir || (acl.resolve(ctx, cur.id)?.level || 0) < EDIT)) fail(409, 'Something with this name already exists here.');
        let id;
        // An empty file is not kept as a version (Finder and other programs make one first, then write into it).
        const keep = cur && cur.size > 0;
        if (cur) {
          if (keep) db.run('INSERT INTO versions(node_id, blob, size, created_at, created_by) VALUES(?, ?, ?, ?, ?)', cur.id, cur.blob, cur.size, cur.updated_at, cur.updated_by);
          db.run('UPDATE nodes SET blob = ?, size = ?, updated_at = ?, updated_by = ? WHERE id = ?', blob, size, now, c.user.id, cur.id);
          id = cur.id;
        } else id = db.run('INSERT INTO nodes(parent_id, name, is_dir, size, blob, created_at, updated_at, updated_by) VALUES(?, ?, 0, ?, ?, ?, ?, ?)', r.node.id, name, size, blob, now, now, c.user.id).lastInsertRowid;
        audit(c, 'file', keep ? 'uploaded a new version' : 'uploaded', `${pathOf(r.chain)} / ${name}`, id); // one commit with the file
        return { id, replaced: keep, created: !cur, dropped: cur && !keep ? cur.blob : null };
      });
    } catch (e) {
      store.remove([blob]);
      throw e;
    }
    // The totals of the folders above grow by exactly this file (a replaced version is kept and still counts).
    const after = changeMark();
    for (const id of above) {
      const m = usageMemo.get(id);
      if (m?.mark === before) usageMemo.set(id, { mark: after, used: m.used + size });
    }
    if (made.dropped) store.remove([made.dropped]);
    if (made.replaced) trimVersions(made.id);
    return made;
  }

  add('GET', '/api/nodes/:id/content', 'user', c => {
    const r = need(c, c.params.id, READ);
    if (r.node.is_dir) fail(400, 'Folders cannot be downloaded as one file.');
    sendFile(c, r.node.blob, r.node.size, r.node.name, c.query.get('inline') === '1', `user ${c.user.login}`, what => audit(c, 'file', what, pathOf(r.chain), r.node.id));
  });

  add('PATCH', '/api/nodes/:id', 'user', async c => moveNode(c, c.params.id, await body(c)));

  // Rename and/or move (b.name, b.parent_id), with every rule of the website; the desktop agent uses it too.
  function moveNode(c, id, b) {
    const r = need(c, id, EDIT);
    if (r.node.system) fail(403, 'This folder is managed by IT and cannot be renamed or moved.');
    if (r.parentLevel < EDIT) fail(403, 'You need Edit access to the folder this is in.');
    let name = r.node.name;
    let dest = r.chain.slice(0, -1);
    let carried = false;
    if (b.name !== undefined) name = cleanName(b.name);
    const moving = b.parent_id !== undefined && Number(b.parent_id) !== r.node.parent_id;
    if (moving) {
      const d = need(c, b.parent_id, EDIT);
      if (!d.node.is_dir) fail(400, 'Choose a folder to move into.');
      if (d.chain.some(n => n.id === r.node.id)) fail(400, 'A folder cannot be moved into itself.');
      if (r.area === 'confidential' && d.area !== 'confidential') fail(403, 'Files cannot be moved out of confidential folders.');
      // Its owner holds Manage over everything in a personal folder, so shared files must never land there:
      // that would let anyone with Edit take them over, change who has access, and move them back.
      if (d.area === 'personal' && r.area !== 'personal') fail(403, 'Files from shared folders cannot be moved into a personal folder.');
      // People a personal folder is shared with may edit and delete (the owner can restore), but not carry files off.
      if (r.area === 'personal' && d.chain[1]?.id !== r.chain[1].id && acl.levelOf(c.ctx, r.infos[1]) < MANAGE)
        fail(403, 'Only the owner can move things out of a personal folder.');
      // Access settings travel with what is moved. Into another area they may come only with someone who could
      // set them there (Manage on the destination), and groups never enter confidential space.
      const grants = d.area === r.area ? [] : db.all(`${SUBTREE} SELECT a.group_id FROM acl a JOIN t ON a.node_id = t.id`, r.node.id);
      if (d.area === 'confidential' && grants.some(g => g.group_id != null && g.group_id !== db.ids.managers))
        fail(403, 'This folder is shared with groups. Remove group access before moving it into a confidential folder.');
      if (grants.length && !canManageAccess(d.node, d.level, d.area, isManager(c.user)) && d.level < MANAGE) fail(403, 'This has its own access settings, so only the manager of the destination folder can move it there. Remove the access settings first.');
      carried = grants.length > 0 && d.area === 'confidential';
      guardHidden(c, r);
      const size = usage(r.node.id); // a file's old versions move with it and count too
      checkQuota(d.chain, size, r.chain.map(n => n.id));
      dest = d.chain;
    }
    if (!moving && name === r.node.name) return { id: r.node.id };
    checkPathLength(dest, name, r.node.is_dir ? r.node.id : null);
    // A rename never touches parent_id, so it cannot undo a move made in the meantime.
    if (moving) unique(() => db.run('UPDATE nodes SET name = ?, parent_id = ?, updated_at = ?, updated_by = ? WHERE id = ?', name, dest.at(-1).id, Date.now(), c.user.id, r.node.id));
    else unique(() => db.run('UPDATE nodes SET name = ?, updated_at = ?, updated_by = ? WHERE id = ?', name, Date.now(), c.user.id, r.node.id));
    const how = c.device ? ` (on computer "${c.device.name}")` : '';
    if (moving) audit(c, 'file', `${carried ? 'ALERT moved with its own access settings' : 'moved'}${how}`, `${pathOf(r.chain)} → ${pathOf(dest)} / ${name}`, r.node.id);
    else audit(c, 'file', `renamed${how}`, `${pathOf(r.chain)} → ${name}`, r.node.id);
    return { id: r.node.id };
  }

  add('DELETE', '/api/nodes/:id', 'user', c => trashNode(c, c.params.id));

  function trashNode(c, id) {
    const r = need(c, id, EDIT);
    if (r.node.system) fail(403, 'This folder is managed by IT and cannot be deleted.');
    if (r.parentLevel < EDIT) fail(403, 'You need Edit access to the folder this is in.');
    guardHidden(c, r);
    db.run('UPDATE nodes SET deleted_at = ?, deleted_by = ? WHERE id = ?', Date.now(), c.user.id, r.node.id);
    audit(c, 'file', `moved to trash${c.device ? ` (deleted on computer "${c.device.name}")` : ''}`, pathOf(r.chain), r.node.id);
  }

  add('GET', '/api/trash', 'user', c => {
    const rows = db.all(
      'SELECT n.id, n.parent_id, n.name, n.is_dir, n.size, n.deleted_at, u.name AS deleted_by FROM nodes n LEFT JOIN users u ON u.id = n.deleted_by WHERE n.deleted_at IS NOT NULL ORDER BY n.deleted_at DESC LIMIT 5000',
    );
    const out = [];
    const res = acl.resolver(c.ctx);
    for (const { parent_id, ...row } of rows) {
      if ((res(parent_id)?.level || 0) < EDIT) continue; // restoring needs Edit on the folder it was in (cheap check first)
      // Only items the user could open before deletion: a hidden restricted folder must not surface here.
      const r = res(row.id, { trashed: true });
      if (!r || !r.level || r.parentLevel < EDIT) continue;
      out.push({ ...row, dir: !!row.is_dir, location: pathOf(r.chain.slice(0, -1)), purge_at: row.deleted_at + TRASH_DAYS * DAY });
    }
    return out;
  });

  add('POST', '/api/trash/:id/restore', 'user', c => {
    const r = acl.resolve(c.ctx, int(c.params.id), { trashed: true });
    if (!r || !r.node.deleted_at || !r.level || r.parentLevel < EDIT) fail(404, 'Not found in your trash.');
    const n = r.node;
    let name = n.name;
    const dot = n.is_dir ? -1 : name.lastIndexOf('.');
    for (let i = 1; taken(n.parent_id, name); i++) {
      const tag = ` (restored${i > 1 ? ' ' + i : ''})`;
      name = dot > 0 ? n.name.slice(0, dot) + tag + n.name.slice(dot) : n.name + tag;
    }
    db.run('UPDATE nodes SET deleted_at = NULL, deleted_by = NULL, name = ? WHERE id = ?', name, n.id);
    audit(c, 'file', 'restored from trash', pathOf(r.chain), n.id);
    return { id: n.id, name, parent_id: n.parent_id };
  });

  // Erases a trashed item with everything inside it, its versions and their files on disk.
  async function purge(id) {
    const blobs = db
      .all(`${SUBTREE} SELECT blob FROM nodes WHERE id IN (SELECT id FROM t) AND blob IS NOT NULL UNION ALL SELECT blob FROM versions WHERE node_id IN (SELECT id FROM t)`, id)
      .map(r => r.blob);
    db.run('DELETE FROM nodes WHERE id = ?', id);
    await store.remove(blobs);
  }

  // Delete forever, without waiting 30 days: whoever may restore it. Nightly backups still hold it for 120 days.
  add('DELETE', '/api/trash/:id', 'user', async c => {
    const r = acl.resolve(c.ctx, int(c.params.id), { trashed: true });
    if (!r || !r.node.deleted_at || !r.level || r.parentLevel < EDIT) fail(404, 'Not found in your trash.');
    guardHidden(c, r); // restricted folders inside: only people who can edit all of them may erase the lot
    // Logged against the parent, so people who can open the parent see it; a restricted item's own name stays hidden.
    const target = r.node.inherit ? pathOf(r.chain) : `${pathOf(r.chain.slice(0, -1))} / (restricted item)`;
    await purge(r.node.id);
    audit(c, 'file', 'deleted forever from trash', target, r.node.parent_id);
  });

  add('GET', '/api/nodes/:id/versions', 'user', c => {
    const r = need(c, c.params.id, READ);
    if (r.node.is_dir) fail(400, 'Folders have no versions.');
    return db.all(
      'SELECT v.id, v.size, v.created_at, u.name AS created_by FROM versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.node_id = ? ORDER BY v.created_at DESC, v.id DESC',
      r.node.id,
    );
  });

  const versionOf = (c, min) => {
    const v = db.get('SELECT * FROM versions WHERE id = ?', int(c.params.vid));
    if (!v) fail(404, 'This version no longer exists.');
    return { v, r: need(c, v.node_id, min) };
  };

  add('GET', '/api/versions/:vid/content', 'user', c => {
    const { v, r } = versionOf(c, READ);
    sendFile(c, v.blob, v.size, r.node.name, false, `user ${c.user.login}`, () => audit(c, 'file', 'downloaded an older version', pathOf(r.chain), r.node.id));
  });

  add('POST', '/api/versions/:vid/restore', 'user', c => {
    const { v, r } = versionOf(c, EDIT);
    const n = r.node;
    db.tx(() => {
      db.run('INSERT INTO versions(node_id, blob, size, created_at, created_by) VALUES(?, ?, ?, ?, ?)', n.id, n.blob, n.size, n.updated_at, n.updated_by);
      db.run('UPDATE nodes SET blob = ?, size = ?, updated_at = ?, updated_by = ? WHERE id = ?', v.blob, v.size, Date.now(), c.user.id, n.id);
      db.run('DELETE FROM versions WHERE id = ?', v.id);
    });
    trimVersions(n.id);
    audit(c, 'file', 'restored an older version', pathOf(r.chain), n.id);
  });

  // =====================================================================
  // Online editor (Collabora Online over WOPI)
  // =====================================================================
  // The browser gets a token for one file; Collabora calls the /api/wopi routes with it, server to server.
  // Every call re-checks the person, their session and their current access, so blocking someone, signing out
  // or taking access away ends editing at once. Read opens view-only; saving needs Edit.
  const WOPI_TTL = 10 * 3600e3;
  const wopiSig = (uid, nid, exp, sid) => A.hmac(secret, `wopi.${uid}.${nid}.${exp}.${sid}`);
  let discovery = null; // { at, urls: ext -> editor URL }

  async function editorUrls() {
    if (discovery && Date.now() - discovery.at < 3600e3) return discovery.urls;
    let xml;
    try {
      const res = await fetch(`${cfg.officeInternal || cfg.officeUrl}/hosting/discovery`, { signal: AbortSignal.timeout(15e3) });
      if (!res.ok) throw new Error(res.status);
      xml = await res.text();
    } catch (e) {
      console.error(new Date().toISOString(), 'editor discovery failed', e.message);
      fail(503, 'The document editor is not reachable right now. Try again in a minute.');
    }
    const urls = {};
    for (const [, tag] of xml.matchAll(/<action\b([^>]*)>/g)) {
      const a = Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map(m => [m[1], m[2].replace(/&amp;/g, '&')]));
      let u = null;
      try {
        u = new URL(a.urlsrc.replace(/<[^>]*>/g, ''));
      } catch {}
      // Only the path is taken: browsers always go to OFFICE_URL, whatever address discovery was fetched from.
      if (a.ext && u && (a.name === 'edit' || !urls[a.ext])) urls[a.ext] = cfg.officeUrl + u.pathname + u.search;
    }
    discovery = { at: Date.now(), urls };
    return urls;
  }

  // PDF text cannot be edited in place, so a PDF is edited as a Word document: the converter service turns it into
  // DOCX once, everyone editing that PDF shares the work copy (so they co-edit), and every save is turned back into
  // PDF by Collabora and stored as a new version of the PDF itself.
  const PDF_EDIT_MAX = 50 * 2 ** 20;
  const pdfWork = new Map(); // node id -> { docx, at, base: node.updated_at it matches }
  const SERVICE_FAIL = {
    pdf2docx: 'This PDF could not be prepared for editing (it may be a scan or protected by a password).',
    inspect: 'This PDF could not be opened for editing (it may be damaged or protected by a password).',
    apply: 'Your changes could not be written into the PDF. Try again.',
    docx2pdf: 'The edited PDF could not be saved. Try again.',
  };
  async function service(what, url, init) {
    let said = null;
    try {
      // PDF -> Word runs two engines and compares them, which takes a while on the NAS.
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(what === 'pdf2docx' ? 360e3 : 180e3) });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 300);
        // The converter's own explanations (password, too many pages, took too long) are shown as they are.
        if (/^(The PDF|PDFs with|This PDF|Turned pages|Processing this PDF)/.test(text)) said = text;
        throw new Error(`HTTP ${res.status} ${text}`);
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      console.error(new Date().toISOString(), what, 'failed:', e.message);
      fail(502, said || SERVICE_FAIL[what]);
    }
  }
  function toPdf(docx) {
    const fd = new FormData();
    fd.append('data', new Blob([docx]), 'document.docx');
    return service('docx2pdf', `${cfg.officeInternal || cfg.officeUrl}/cool/convert-to/pdf`, { method: 'POST', body: fd });
  }
  async function pdfCopy(node) {
    const w = pdfWork.get(node.id);
    if (w && w.base === node.updated_at) return w;
    if (node.size > PDF_EDIT_MAX) fail(413, 'PDFs larger than 50 MB cannot be edited in the browser.');
    const pdf = await fs.promises.readFile(store.file(node.blob));
    const docx = await service('pdf2docx', `${cfg.pdfConverter}/pdf2docx`, { method: 'POST', body: pdf, headers: { 'content-type': 'application/pdf' } });
    const fresh = { docx, at: Date.now(), base: node.updated_at };
    pdfWork.set(node.id, fresh);
    return fresh;
  }
  const pdfEditable = (r, name = r.node.name) => !!cfg.pdfConverter && ext(name) === 'pdf' && r.level >= EDIT;

  // ---- PDF editor that keeps every page exactly as it is: the browser shows page images with the text lines on
  // top; only the lines someone changes are rewritten in the file (by the converter service), nothing else. ----
  const pdfViews = new Map(); // `${node id}:${updated_at}` -> { at, pages, images }
  async function pdfView(node) {
    const key = `${node.id}:${node.updated_at}`;
    let v = pdfViews.get(key);
    if (!v) {
      if (node.size > PDF_EDIT_MAX) fail(413, 'PDFs larger than 50 MB cannot be edited in the browser.');
      const pdf = await fs.promises.readFile(store.file(node.blob));
      const out = JSON.parse((await service('inspect', `${cfg.pdfConverter}/inspect`, { method: 'POST', body: pdf })).toString());
      v = {
        pages: out.pages.map(({ image, mime, ...p }) => p),
        images: out.pages.map(p => ({ buf: Buffer.from(p.image, 'base64'), type: p.mime === 'image/png' ? 'image/png' : 'image/jpeg' })),
      };
      for (const k of pdfViews.keys()) if (k.startsWith(`${node.id}:`)) pdfViews.delete(k); // older versions of it
      pdfViews.set(key, v);
    }
    v.at = Date.now();
    return v;
  }

  add('POST', '/api/nodes/:id/pdf-edit', 'user', async c => {
    if (!cfg.pdfConverter) fail(404, 'PDF editing is not set up.');
    const r = need(c, c.params.id, EDIT);
    if (r.node.is_dir || ext(r.node.name) !== 'pdf') fail(400, 'Only PDF files open in the PDF editor.');
    const v = await pdfView(r.node);
    if (meterDownload(c, `user ${c.user.login}`, r.node.size, r.node.blob)) audit(c, 'file', 'opened in the PDF editor', pathOf(r.chain), r.node.id);
    return { version: r.node.updated_at, pages: v.pages };
  });

  add('GET', '/api/nodes/:id/pdf-page/:n', 'user', c => {
    const r = need(c, c.params.id, EDIT);
    const img = pdfViews.get(`${r.node.id}:${Number(c.query.get('v'))}`)?.images[Number(c.params.n)];
    if (!img) fail(404, 'Open the PDF again.');
    c.res.writeHead(200, { 'Content-Type': img.type, 'Content-Length': img.buf.length, 'Cache-Control': 'private, max-age=3600' });
    c.res.end(img.buf);
  });

  function pdfEdits(list) {
    if (!Array.isArray(list) || list.length > 2000) fail(400, 'Too many changes at once. Save in smaller steps.');
    const bad = () => fail(400, 'A change could not be read. Reopen the PDF and try again.');
    const nums = (v, n) => (Array.isArray(v) && v.length === n && v.every(x => Number.isFinite(x)) ? v.map(Number) : bad());
    return list.map(e => {
      if (!['replace', 'add', 'erase'].includes(e?.type) || !Number.isInteger(e.page) || e.page < 0 || e.page >= 1000) bad();
      const out = { type: e.type, page: e.page };
      if (e.type !== 'add') out.bbox = nums(e.bbox, 4);
      if (e.type !== 'erase') {
        if (typeof e.text !== 'string' || e.text.length > 5000) bad();
        Object.assign(out, {
          origin: nums(e.origin, 2),
          text: e.text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ''),
          size: Math.min(200, Math.max(2, Number(e.size) || 11)),
          color: nums(e.color, 3).map(x => Math.min(1, Math.max(0, x))),
          family: ['sans', 'serif', 'mono'].includes(e.family) ? e.family : 'sans',
          bold: !!e.bold,
          italic: !!e.italic,
          // The line's own font (as named inside the PDF) so it is written in the same font when possible.
          font: typeof e.font === 'string' && /^[\w .+-]{1,100}$/.test(e.font) ? e.font : '',
          pdfFont: typeof e.pdfFont === 'string' && /^[\w .+,#-]{1,120}$/.test(e.pdfFont) ? e.pdfFont : '',
        });
      }
      return out;
    });
  }

  add('POST', '/api/nodes/:id/pdf-edit/save', 'user', async c => {
    if (!cfg.pdfConverter) fail(404, 'PDF editing is not set up.');
    const b = await body(c);
    const r = need(c, c.params.id, EDIT);
    if (r.node.is_dir || ext(r.node.name) !== 'pdf') fail(400, 'Only PDF files open in the PDF editor.');
    if (Number(b.version) !== r.node.updated_at) fail(409, 'This PDF was changed by someone else after you opened it. Close it and open it again to see the new version.');
    const edits = pdfEdits(b.edits);
    if (!edits.length) return { version: r.node.updated_at };
    const pdf = await fs.promises.readFile(store.file(r.node.blob));
    const out = await service('apply', `${cfg.pdfConverter}/apply`, { method: 'POST', body: Buffer.concat([Buffer.from(JSON.stringify(edits) + '\n'), pdf]) });
    if (out.subarray(0, 5).toString() !== '%PDF-') fail(502, SERVICE_FAIL.apply);
    const blob = await receiveBlob({ user: c.user, req: Readable.from([out]) }, r.chain, out.length);
    const now = overwriteContent(c, r, blob, out.length);
    audit(c, 'file', `edited in the PDF editor (${edits.length} change${edits.length === 1 ? '' : 's'})`, pathOf(r.chain), r.node.id);
    return { version: now };
  });

  // Saves from the PDF editors write straight into the same file (the company does not want a version per save; the
  // nightly backups still hold earlier days). Access and the version the person started from are checked again
  // inside the transaction, so a newer save by someone else is never overwritten.
  function overwriteContent(c, r, blob, size) {
    const now = Date.now();
    let old;
    try {
      db.tx(() => {
        const u = db.get('SELECT * FROM users WHERE id = ?', c.user.id);
        const fresh = acl.resolve(acl.ctxFor(u), r.node.id);
        if (u.disabled || (fresh?.level || 0) < EDIT || fresh.node.is_dir) fail(403, 'You no longer have Edit access to this file.');
        if (fresh.node.updated_at !== r.node.updated_at) fail(409, 'This file was changed by someone else meanwhile. Open it again and redo your changes.');
        old = fresh.node.blob;
        db.run('UPDATE nodes SET blob = ?, size = ?, updated_at = ?, updated_by = ? WHERE id = ?', blob, size, now, c.user.id, fresh.node.id);
      });
    } catch (e) {
      store.remove([blob]);
      throw e;
    }
    if (old !== blob) store.remove([old]);
    return now;
  }

  // The PDF viewer saves the whole finished PDF (with highlights, notes, signatures, filled forms, redactions).
  add('PUT', '/api/nodes/:id/content', 'user', async c => {
    const r = need(c, c.params.id, EDIT);
    if (r.node.is_dir || ext(r.node.name) !== 'pdf') fail(400, 'Only PDF files are saved this way.');
    if (Number(c.req.headers['x-base-version']) !== r.node.updated_at) fail(409, 'This PDF was changed by someone else after you opened it. Close it and open it again to see the new version.');
    const size = Number(c.req.headers['content-length']);
    if (!Number.isSafeInteger(size) || size < 5) fail(411, 'The file size is missing.');
    if (size > cfg.maxFile) fail(413, `Files larger than ${fmtBytes(cfg.maxFile)} cannot be saved.`);
    const blob = await receiveBlob(c, r.chain, size);
    const head = Buffer.alloc(5);
    const fh = await fs.promises.open(store.file(blob));
    await fh.read(head, 0, 5, 0).finally(() => fh.close());
    if (head.toString() !== '%PDF-') {
      store.remove([blob]);
      fail(400, 'That is not a PDF file.');
    }
    const now = overwriteContent(c, r, blob, size);
    audit(c, 'file', 'edited in the PDF viewer', pathOf(r.chain), r.node.id);
    return { version: now };
  });

  add('POST', '/api/nodes/:id/editor', 'user', async c => {
    if (!cfg.officeUrl) fail(404, 'The document editor is not set up.');
    const r = need(c, c.params.id, READ);
    const pdf = !r.node.is_dir && pdfEditable(r);
    const url = !r.node.is_dir && (await editorUrls())[pdf ? 'docx' : ext(r.node.name)];
    if (!url) fail(400, 'This type of file cannot be opened in the editor.');
    if (pdf) await pdfCopy(r.node); // the conversion wait happens here, while the page says so
    const wid = pdf ? `p${r.node.id}` : String(r.node.id);
    const exp = Date.now() + WOPI_TTL;
    const src = `${cfg.wopiUrl}/api/wopi/files/${wid}`;
    return {
      url: `${url}${/[?&]$/.test(url) ? '' : url.includes('?') ? '&' : '?'}WOPISrc=${encodeURIComponent(src)}`,
      token: [c.user.id, wid, exp, c.session.id, wopiSig(c.user.id, wid, exp, c.session.id)].join('.'),
      ttl: exp,
      edit: r.level >= EDIT,
      pdf,
    };
  });

  // Token ids: "123" is the file itself, "p123" the Word work copy of PDF 123.
  function wopiFile(c) {
    const [uid, nid, exp, sid, sig] = String(c.query.get('access_token') || '').split('.');
    if (nid !== c.params.id || !(Number(exp) > Date.now()) || !sig || !A.safeEqual(sig, wopiSig(uid, nid, exp, sid))) fail(401, 'Invalid or expired token.');
    const user = db.get('SELECT * FROM users WHERE id = ?', Number(uid));
    const s = db.get('SELECT * FROM sessions WHERE id = ? AND user_id = ?', sid, Number(uid));
    if (!user || user.disabled || user.is_admin || user.must_change || !s || Date.now() - s.created_at > SESSION_MAX) fail(401, 'Your session has ended.');
    Object.assign(c, { user, ctx: acl.ctxFor(user) });
    const pdf = nid.startsWith('p');
    const r = acl.resolve(c.ctx, Number(pdf ? nid.slice(1) : nid));
    if (!r?.level || r.node.is_dir || (pdf && !pdfEditable(r))) fail(404, 'Not found.');
    r.pdf = pdf;
    return r;
  }

  const iso = t => new Date(t).toISOString();

  add('GET', '/api/wopi/files/:id', 'wopi', async c => {
    const r = wopiFile(c);
    const w = r.pdf ? await pdfCopy(r.node) : null;
    return {
      BaseFileName: w ? `${r.node.name.replace(/\.pdf$/i, '')}.docx` : r.node.name,
      Size: w ? w.docx.length : r.node.size,
      Version: String(w ? w.at : r.node.updated_at),
      LastModifiedTime: iso(w ? w.at : r.node.updated_at),
      OwnerId: 'company-files',
      UserId: String(c.user.id),
      UserFriendlyName: c.user.name,
      UserCanWrite: r.level >= EDIT,
      UserCanNotWriteRelative: true, // no "Save as" into the storage: new files go through upload checks
      SupportsUpdate: true,
      SupportsLocks: false,
      PostMessageOrigin: cfg.publicUrl.origin,
      EnableInsertRemoteImage: false,
      EnableShare: false,
    };
  });

  add('GET', '/api/wopi/files/:id/contents', 'wopi', async c => {
    const r = wopiFile(c);
    const opened = () => audit(c, 'file', 'opened in the editor', pathOf(r.chain), r.node.id);
    if (!r.pdf) return sendFile(c, r.node.blob, r.node.size, r.node.name, false, `user ${c.user.login}`, opened);
    const w = await pdfCopy(r.node);
    if (meterDownload(c, `user ${c.user.login}`, w.docx.length, r.node.blob)) opened();
    c.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': w.docx.length, 'Cache-Control': 'no-store' });
    c.res.end(w.docx);
  });

  // Collabora saves every few minutes while someone edits. One editing run by one person is kept as one version
  // (the file as it was before they started stays in Versions); a new version starts after 30 minutes.
  const editRuns = new Map(); // node id -> { uid, blob, since }
  add('POST', '/api/wopi/files/:id/contents', 'wopi', async c => {
    const r = wopiFile(c);
    if (r.level < EDIT) fail(403, 'You can only view this file.');
    // The file changed since the editor loaded it (someone uploaded a new version): Collabora asks what to do.
    const seen = Date.parse(c.req.headers['x-cool-wopi-timestamp'] || '');
    const w = r.pdf ? pdfWork.get(r.node.id) : null;
    if (Number.isFinite(seen) && (r.pdf ? !w || seen !== w.at || w.base !== r.node.updated_at : seen !== r.node.updated_at))
      return json(c.res, 409, { COOLStatusCode: 1010 });
    const size = Number(c.req.headers['content-length']);
    if (!Number.isSafeInteger(size) || size < 0) fail(411, 'The file size is missing.');
    if (size > (r.pdf ? PDF_EDIT_MAX : cfg.maxFile)) fail(413, `Files larger than ${fmtBytes(r.pdf ? PDF_EDIT_MAX : cfg.maxFile)} cannot be saved.`);
    let blob, docx, pdfSize;
    if (r.pdf) {
      const chunks = [];
      for await (const ch of c.req) chunks.push(ch);
      docx = Buffer.concat(chunks);
      if (docx.length !== size) fail(400, 'The upload was interrupted. Try again.');
      const pdf = await toPdf(docx);
      pdfSize = pdf.length;
      blob = await receiveBlob({ user: c.user, req: Readable.from([pdf]) }, r.chain, pdf.length);
    } else blob = await receiveBlob(c, r.chain, size);
    const now = Date.now();
    let res;
    try {
      res = db.tx(() => {
        // Checked again: access may have changed while the file was streaming in.
        const u = db.get('SELECT * FROM users WHERE id = ?', c.user.id);
        const fresh = acl.resolve(acl.ctxFor(u), r.node.id);
        if (u.disabled || (fresh?.level || 0) < EDIT || fresh.node.is_dir) fail(403, 'You no longer have Edit access to this file.');
        const cur = fresh.node;
        const run = editRuns.get(cur.id);
        const same = run && run.uid === c.user.id && run.blob === cur.blob && now - run.since < 30 * 60e3;
        // PDFs are saved straight into the file; Word, Excel and the like keep one version per editing run.
        const keep = !r.pdf && !same;
        if (keep) db.run('INSERT INTO versions(node_id, blob, size, created_at, created_by) VALUES(?, ?, ?, ?, ?)', cur.id, cur.blob, cur.size, cur.updated_at, cur.updated_by);
        db.run('UPDATE nodes SET blob = ?, size = ?, updated_at = ?, updated_by = ? WHERE id = ?', blob, pdfSize ?? size, now, c.user.id, cur.id);
        return { old: keep ? null : cur.blob, since: same ? run.since : now, newRun: !same };
      });
    } catch (e) {
      store.remove([blob]);
      throw e;
    }
    if (r.pdf) pdfWork.set(r.node.id, { docx, at: now, base: now });
    editRuns.set(r.node.id, { uid: c.user.id, blob, since: res.since });
    if (res.old) store.remove([res.old]);
    if (res.newRun) {
      if (!r.pdf) trimVersions(r.node.id);
      audit(c, 'file', 'edited in the editor', pathOf(r.chain), r.node.id);
    }
    return { LastModifiedTime: iso(now) };
  });

  // =====================================================================
  // Auto-save to computers (tray agent)
  // =====================================================================
  // A person links a computer with a one-time code; its agent then holds a token that can do one thing: fetch the
  // files that person sent to that computer. Access is checked again when each file is fetched, confidential files
  // never leave, and fetches count toward the person's hourly download limit like any download.
  const PAIR_TTL = 10 * 60e3;
  const SEND_MAX_FILES = 5000;
  const PAIR_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const sockets = new Map(); // device id -> Set of agent WebSockets
  const online = id => (sockets.get(id)?.size || 0) > 0;
  function notify(deviceId, msg = { type: 'queue' }, which = () => true) {
    for (const s of sockets.get(deviceId) || []) if (which(s)) wsSend(s, JSON.stringify(msg));
  }
  function dropDevice(deviceId) {
    for (const s of sockets.get(deviceId) || []) s.destroy();
    sockets.delete(deviceId);
  }

  // "My files" stay copied on the person's computers while their agent runs (decided 2026-11-19: only the personal
  // folder, only what changes after the computer was connected, changes replace the copy, deletions delete it).
  // Any change inside a personal folder, however it is made, tells its owner's online computers to compare.
  const homeOf = user => db.get('SELECT * FROM nodes WHERE parent_id = ? AND name = ? AND is_dir = 1 AND deleted_at IS NULL', db.ids.roots.personal, user.login);
  const contentVersion = n => A.sha256(String(n.blob)).slice(0, 20); // changes with the content, not with a rename
  const mirrorSoon = new Map(); // device id -> timer: a burst of changes (a folder upload) becomes one notice
  db.onTreeChange(ids => {
    const homes = new Set();
    for (const id of ids) {
      const h = db.get('WITH RECURSIVE up(id, parent_id, d) AS (SELECT id, parent_id, 0 FROM nodes WHERE id = ? UNION ALL SELECT n.id, n.parent_id, up.d + 1 FROM nodes n JOIN up ON n.id = up.parent_id WHERE up.d < 200) SELECT id FROM up WHERE parent_id = ?', id, db.ids.roots.personal);
      if (h) homes.add(h.id);
    }
    for (const home of homes) {
      for (const d of db.all('SELECT d.id FROM devices d JOIN users u ON u.id = d.user_id JOIN nodes n ON n.name = u.login AND n.parent_id = ? WHERE n.id = ? AND d.revoked_at IS NULL', db.ids.roots.personal, home)) {
        if (!online(d.id) || mirrorSoon.has(d.id)) continue;
        mirrorSoon.set(d.id, setTimeout(() => {
          mirrorSoon.delete(d.id);
          notify(d.id, { type: 'mirror' });
        }, 1000).unref());
      }
    }
    // Files on demand: each online computer that asked for it hears which of the changed folders its person can see.
    for (const [deviceId, set] of sockets) {
      if (![...set].some(s => s.cloud)) continue;
      const u = db.get('SELECT u.* FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = ? AND d.revoked_at IS NULL', deviceId);
      if (!u) continue;
      const ctx = acl.ctxFor(u);
      const seen = ids.filter(id => { const r = acl.resolve(ctx, id); return r?.level && r.area !== 'confidential'; });
      if (!seen.length) continue;
      let p = cloudSoon.get(deviceId);
      if (!p) {
        cloudSoon.set(deviceId, (p = { folders: new Set() }));
        setTimeout(() => {
          cloudSoon.delete(deviceId);
          notify(deviceId, { type: 'cloud', folders: [...p.folders].slice(0, 500) }, s => s.cloud);
        }, 1000).unref();
      }
      for (const id of seen) p.folders.add(id);
    }
  });
  const cloudSoon = new Map(); // device id -> folder ids changed in the last second

  function agentAuth(req) {
    const m = /^Bearer ([\w-]{20,100})$/.exec(req.headers.authorization || '');
    const device = m && db.get('SELECT * FROM devices WHERE token = ? AND revoked_at IS NULL', A.sha256(m[1]));
    const user = device && db.get('SELECT * FROM users WHERE id = ?', device.user_id);
    if (!user || user.disabled || user.deleted_at || user.is_admin) fail(401, 'This computer is not connected any more. Connect it again from the website.', 'unpaired');
    if (Date.now() - (device.seen_at || 0) > 60e3) db.run('UPDATE devices SET seen_at = ? WHERE id = ?', Date.now(), device.id);
    return { device, user, ctx: acl.ctxFor(user) };
  }

  const myDevices = c => db.all('SELECT * FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at', c.user.id);

  add('POST', '/api/devices/pair-code', 'user', c => {
    let code = '';
    for (let i = 0; i < 8; i++) code += PAIR_ABC[crypto.randomInt(PAIR_ABC.length)];
    const expires = Date.now() + PAIR_TTL;
    db.tx(() => {
      db.run('DELETE FROM pair_codes WHERE user_id = ? OR expires_at < ?', c.user.id, Date.now());
      db.run('INSERT INTO pair_codes(code, user_id, expires_at) VALUES(?, ?, ?)', A.sha256(code), c.user.id, expires);
    });
    const shown = `${code.slice(0, 4)}-${code.slice(4)}`;
    return { code: shown, expires_at: expires, link: `myfiles://pair?code=${shown}&server=${encodeURIComponent(cfg.publicUrl.origin)}` };
  });

  // The agent first shows whose account a code belongs to and asks before linking, so a link someone else made
  // cannot quietly tie this computer to their account (and drop their files on it).
  function pairCode(c) {
    const key = 'pair';
    guard(c, key, false);
    const code = String(c.json?.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const row = code.length === 8 && db.get('SELECT * FROM pair_codes WHERE code = ?', A.sha256(code));
    const user = row && row.expires_at > Date.now() && db.get('SELECT * FROM users WHERE id = ?', row.user_id);
    if (!user || user.disabled || user.deleted_at) {
      failed(c, key, false);
      fail(404, 'This code is wrong or has expired. Get a new one on the website.');
    }
    return { row, user };
  }
  add('POST', '/api/agent/pair-info', 'public', async c => {
    const { user } = pairCode(c);
    return { appName: cfg.appName, server: cfg.publicUrl.origin, user: { name: user.name, login: user.login } };
  });
  add('POST', '/api/agent/pair', 'public', async c => {
    const b = await body(c);
    const { row, user } = pairCode(c);
    const name = (str(b.name, 60) || 'Computer').replace(/[\u0000-\u001f]/g, '');
    const os = ['windows', 'macos', 'linux'].includes(b.os) ? b.os : 'other';
    const token = A.token();
    const id = db.tx(() => {
      if (!db.run('DELETE FROM pair_codes WHERE code = ?', row.code).changes) fail(404, 'This code was already used.');
      return db.run('INSERT INTO devices(user_id, name, os, token, created_at, seen_at) VALUES(?, ?, ?, ?, ?, ?)', user.id, name, os, A.sha256(token), Date.now(), Date.now()).lastInsertRowid;
    });
    db.audit('admin', user.id, `ALERT computer connected for auto-save: ${name} (${os})`, `${user.name} (${user.login})`, c.ip);
    return { token, device: { id, name }, user: { name: user.name, login: user.login }, appName: cfg.appName };
  });

  add('GET', '/api/devices', 'user', c =>
    myDevices(c).map(d => ({
      id: d.id, name: d.name, os: d.os, created_at: d.created_at, seen_at: d.seen_at, online: online(d.id),
      pending: db.get('SELECT COUNT(*) n FROM device_queue WHERE device_id = ? AND done_at IS NULL', d.id).n,
    })),
  );

  function unpair(c, d, how) {
    db.tx(() => {
      db.run('UPDATE devices SET revoked_at = ? WHERE id = ?', Date.now(), d.id);
      db.run('DELETE FROM device_queue WHERE device_id = ? AND done_at IS NULL', d.id);
    });
    dropDevice(d.id);
    audit(c, 'admin', `computer disconnected from auto-save${how}: ${d.name}`, `${c.user.name} (${c.user.login})`);
  }
  add('DELETE', '/api/devices/:id', 'user', c => {
    const d = db.get('SELECT * FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL', int(c.params.id), c.user.id);
    if (!d) fail(404, 'This computer is not connected.');
    unpair(c, d, '');
  });

  // Sends files and whole folders (as they are now) to every computer of this person.
  add('POST', '/api/devices/send', 'user', async c => {
    const ids = (await body(c)).ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 500) fail(400, 'Choose what to save.');
    const devices = myDevices(c);
    if (!devices.length) fail(400, 'No computer is connected yet. Connect one on the Account page.');
    const files = [];
    const roots = [];
    for (const id of new Set(ids.map(Number))) {
      const r = need(c, id, READ);
      if (r.area === 'confidential') fail(403, `"${r.node.name}" is in a confidential folder. Confidential files are not saved to computers.`);
      roots.push(r);
      if (!r.node.is_dir) {
        files.push({ id: r.node.id, path: r.node.name, size: r.node.size });
        continue;
      }
      // Everything below that this person can open; hidden restricted folders are left out with their contents.
      const rows = db.all(`${SUBTREE} SELECT n.id FROM nodes n JOIN t ON n.id = t.id WHERE n.is_dir = 0 AND n.deleted_at IS NULL`, r.node.id);
      for (const { id: fid } of rows) {
        const x = acl.resolve(c.ctx, fid);
        if (!x?.level) continue;
        const at = x.chain.findIndex(n => n.id === r.node.id);
        files.push({ id: fid, path: x.chain.slice(at).map(n => n.name).join('/'), size: x.node.size });
        if (files.length > SEND_MAX_FILES) fail(413, `That is more than ${SEND_MAX_FILES} files at once. Send smaller folders.`);
      }
    }
    if (!files.length) fail(400, 'There are no files to save in what you chose.');
    const batch = A.token(12);
    const now = Date.now();
    db.tx(() => {
      for (const d of devices) for (const f of files) db.run('INSERT INTO device_queue(device_id, node_id, path, batch, created_at) VALUES(?, ?, ?, ?, ?)', d.id, f.id, f.path, batch, now);
    });
    for (const r of roots) audit(c, 'file', `sent for auto-save to ${devices.length === 1 ? `computer "${devices[0].name}"` : `${devices.length} computers`}`, pathOf(r.chain), r.node.id);
    for (const d of devices) notify(d.id);
    return { batch, files: files.length, bytes: files.reduce((s, f) => s + f.size, 0), devices: devices.map(d => d.name) };
  });

  // Undo right after sending: whatever no computer has saved yet is taken back.
  add('DELETE', '/api/devices/batches/:batch', 'user', c => {
    const n = db.run('DELETE FROM device_queue WHERE batch = ? AND done_at IS NULL AND device_id IN (SELECT id FROM devices WHERE user_id = ?)', String(c.params.batch), c.user.id).changes;
    return { removed: n };
  });

  // Installers for the Download button, from the downloads/ folder shipped in the image.
  const DOWNLOADS = { windows: 'CompanyFiles-Setup.exe', macos: 'CompanyFiles.dmg', linux: 'company-files-agent_amd64.deb' };
  add('GET', '/api/agent/downloads', 'user', () =>
    Object.fromEntries(Object.entries(DOWNLOADS).map(([os, f]) => {
      const st = fs.statSync(path.join(ROOT, 'downloads', f), { throwIfNoEntry: false });
      return [os, st ? { url: `/downloads/${f}`, size: st.size } : null];
    })),
  );

  // ---- what the agent calls ----
  add('GET', '/api/agent/me', 'agent', c => ({ appName: cfg.appName, server: cfg.publicUrl.origin, device: { id: c.device.id, name: c.device.name }, user: { name: c.user.name, login: c.user.login } }));

  add('POST', '/api/agent/unpair', 'agent', c => unpair(c, c.device, ' by the computer itself'));

  const queued = (c, qid) => db.get('SELECT * FROM device_queue WHERE id = ? AND device_id = ? AND done_at IS NULL', qid, c.device.id);
  // A queued file that was deleted, moved to a confidential folder or is no longer open to this person is skipped.
  const queuedFile = (c, q) => {
    const r = acl.resolve(c.ctx, q.node_id);
    return r?.level && !r.node.is_dir && r.area !== 'confidential' ? r : null;
  };
  const finish = (q, result) => db.run('UPDATE device_queue SET done_at = ?, result = ? WHERE id = ?', Date.now(), result, q.id);

  add('GET', '/api/agent/queue', 'agent', c => {
    const out = [];
    for (const q of db.all('SELECT * FROM device_queue WHERE device_id = ? AND done_at IS NULL ORDER BY id LIMIT 1000', c.device.id)) {
      const r = queuedFile(c, q);
      if (!r) finish(q, 'skipped');
      else out.push({ id: q.id, path: q.path, size: r.node.size, modified: r.node.updated_at });
    }
    return out;
  });

  add('GET', '/api/agent/files/:qid', 'agent', c => {
    const q = queued(c, int(c.params.qid));
    const r = q && queuedFile(c, q);
    if (!r) {
      if (q) finish(q, 'skipped');
      fail(404, 'This file is no longer available.');
    }
    sendFile(c, r.node.blob, r.node.size, r.node.name, false, `user ${c.user.login}`, () => audit(c, 'file', `saved to computer "${c.device.name}"`, pathOf(r.chain), r.node.id));
  });

  // The list of files in "My files" (what the agent compares its copy with) and one file from it.
  add('GET', '/api/agent/mirror', 'agent', c => {
    const home = homeOf(c.user);
    const files = [], dirs = [];
    if (home) {
      for (const { id } of db.all(`${SUBTREE} SELECT n.id FROM nodes n JOIN t ON n.id = t.id WHERE n.deleted_at IS NULL AND n.id != ?`, home.id, home.id)) {
        const x = acl.resolve(c.ctx, id);
        if (!x?.level) continue;
        const path = relOf(x, home);
        if (x.node.is_dir) dirs.push({ id, path, created: x.node.created_at });
        else files.push({ id, path, size: x.node.size, v: contentVersion(x.node), modified: x.node.updated_at });
      }
    }
    return { since: c.device.created_at, files, dirs };
  });

  // A file (or, with dir, a folder) inside My files, never My files itself.
  function inHome(c, home, id, dir = false) {
    const x = home && acl.resolve(c.ctx, int(id));
    if (!x?.level || !!x.node.is_dir !== dir || x.node.id === home.id || !x.chain.some(n => n.id === home.id)) fail(404, `This ${dir ? 'folder' : 'file'} is no longer in My files.`);
    return x;
  }
  function relOf(x, home) {
    return x.chain.slice(x.chain.findIndex(n => n.id === home.id) + 1).map(n => n.name).join('/');
  }

  add('GET', '/api/agent/mirror/:id', 'agent', c => {
    const x = inHome(c, homeOf(c.user), c.params.id);
    c.res.setHeader('X-Version', contentVersion(x.node));
    sendFile(c, x.node.blob, x.node.size, x.node.name, false, `user ${c.user.login}`, () => audit(c, 'file', `auto-saved to computer "${c.device.name}"`, pathOf(x.chain), x.node.id));
  });

  // The other way: what is added or edited in the computer's copy of My files is uploaded (an edit becomes a new
  // version; base= is the version the computer had, so an edit never silently replaces a newer one), and what is
  // deleted there goes to the website's trash. Names the website does not allow get "_" instead.
  const NAME_BAD = /[^\p{L}\p{M}\p{N} ._()\[\],+&'№-]/gu;
  function fitName(raw) {
    let s = String(raw).normalize('NFC').replace(NAME_BAD, '_').replace(/_{2,}/g, '_').trim().replace(/^[.\s]+|[.\s]+$/g, '');
    if (s.length > 120) {
      const ext = /\.[^.]{1,10}$/.exec(s)?.[0] || '';
      s = s.slice(0, 120 - ext.length).trim() + ext;
    }
    return cleanName(/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s) ? `_${s}` : s || 'file'); // Windows device names
  }

  add('PUT', '/api/agent/mirror/file', 'agent', async c => {
    const home = homeOf(c.user);
    if (!home) fail(404, 'This account has no My files folder.');
    const size = Number(c.req.headers['content-length']);
    if (!Number.isSafeInteger(size) || size < 0) fail(411, 'The file size is missing.');
    if (size > cfg.maxFile) fail(413, `Files larger than ${fmtBytes(cfg.maxFile)} cannot be uploaded.`);
    let folderId, name;
    if (c.query.get('id')) {
      const x = inHome(c, home, c.query.get('id'));
      if (contentVersion(x.node) !== c.query.get('base')) fail(409, 'It was changed on the website meanwhile.', 'changed');
      folderId = x.node.parent_id;
      name = x.node.name;
    } else ({ folderId, name } = homePath(c, home, c.query.get('path')));
    const r = acl.resolve(c.ctx, folderId);
    if ((r?.level || 0) < EDIT) fail(403, 'You cannot add files here.');
    checkPathLength(r.chain, name);
    const blob = await receiveBlob(c, r.chain, size);
    const made = placeFile(c, r, name, blob, size);
    const x = acl.resolve(c.ctx, made.id);
    return { id: made.id, path: relOf(x, home), v: contentVersion(x.node), modified: x.node.updated_at };
  });

  // ---- "Files on demand" (Windows agent, decided 2026-11-20): everything this person can open, as on the website ----
  // The computer shows the whole tree as placeholders and fetches a file when it is opened. The same access rules as
  // the website apply (Read stays read-only there), and confidential folders never reach computers.
  const AREA_ALL = { general: 'All documents', departments: 'All departments', projects: 'All projects', management: 'Management files', archive: 'Whole archive', personal: 'My files' };
  const cloudItem = (n, level) => ({ id: n.id, name: n.name, dir: !!n.is_dir, size: n.is_dir ? 0 : n.size, v: n.is_dir ? '' : contentVersion(n), modified: n.updated_at, created: n.created_at, readOnly: level < EDIT });
  function cloudNode(c, id, min = READ) {
    const r = need(c, id, min);
    if (r.area === 'confidential') fail(403, 'Confidential files are not available on computers.');
    return r;
  }

  // The top level: the same places as the website's sidebar (My files, departments, projects, shared folders).
  function cloudTop(c) {
    const out = [], used = new Set();
    for (const s of acl.spaces(c.ctx)) {
      if (s.area === 'confidential') continue;
      let name = s.area === 'personal' && s.level === MANAGE ? 'My files' : s.root ? AREA_ALL[s.area] : s.name;
      for (let i = 2; used.has(name.toLowerCase()); i++) name = `${s.name} (${i})`;
      used.add(name.toLowerCase());
      out.push({ ...cloudItem(db.get('SELECT * FROM nodes WHERE id = ?', s.id), s.level), name });
    }
    return out;
  }
  add('GET', '/api/agent/cloud', 'agent', cloudTop);

  // For the Mac's File Provider: an item with its parent there (0 = the top level) and, for a place at the top level,
  // the name it has there ("My files"). A file shared on its own, outside any folder the person can open, has no
  // place in the tree (as on Windows) and counts as gone.
  const topsOf = c => new Map(cloudTop(c).map(t => [t.id, t]));
  function cloudEntry(r, tops) {
    const t = tops.get(r.node.id);
    if (t) return { ...cloudItem(r.node, r.level), name: t.name, parent: 0 };
    return r.parentLevel ? { ...cloudItem(r.node, r.level), parent: r.node.parent_id } : null;
  }
  add('GET', '/api/agent/cloud/:id/info', 'agent', c => cloudEntry(cloudNode(c, c.params.id), topsOf(c)) ?? fail(404, 'Not in the tree.'));

  // What changed since a point of the change log (?since=seq): the items as they are now for this person, and the
  // ids that are gone for them (deleted, trashed, access taken away). No since: just the current point. A point
  // older than the log keeps says reset (the computer then lists everything again).
  add('GET', '/api/agent/cloud-changes', 'agent', c => {
    const latest = db.get('SELECT MAX(seq) AS s FROM changes').s || 0;
    const since = Number(c.query.get('since') ?? NaN);
    if (!Number.isSafeInteger(since) || since < 0) return { anchor: latest };
    const oldest = db.get('SELECT MIN(seq) AS s FROM changes').s;
    if (since < latest && (oldest == null || since < oldest - 1)) return { anchor: latest, reset: true };
    const rows = db.all('SELECT node_id, MAX(seq) AS seq FROM changes WHERE seq > ? GROUP BY node_id ORDER BY seq LIMIT 1000', since);
    const tops = topsOf(c), res = acl.resolver(c.ctx), items = [], deleted = [];
    for (const { node_id } of rows) {
      const r = res(node_id);
      const e = r?.level && r.area !== 'confidential' ? cloudEntry(r, tops) : null;
      if (e) items.push(e);
      else deleted.push(node_id);
    }
    return { anchor: rows.length ? rows.at(-1).seq : since, more: rows.length === 1000, items, deleted };
  });

  add('GET', '/api/agent/cloud/:id', 'agent', c => {
    const r = cloudNode(c, c.params.id);
    if (!r.node.is_dir) fail(400, 'Not a folder.');
    const out = [];
    for (const n of db.all('SELECT id FROM nodes WHERE parent_id = ? AND deleted_at IS NULL ORDER BY is_dir DESC, name', r.node.id)) {
      const x = acl.resolve(c.ctx, n.id);
      if (x?.level) out.push(cloudItem(x.node, x.level));
    }
    return out;
  });

  add('GET', '/api/agent/cloud/:id/content', 'agent', c => {
    const r = cloudNode(c, c.params.id);
    if (r.node.is_dir) fail(400, 'Not a file.');
    c.res.setHeader('X-Version', contentVersion(r.node));
    sendFile(c, r.node.blob, r.node.size, r.node.name, false, `user ${c.user.login}`, () => audit(c, 'file', `opened on computer "${c.device.name}"`, pathOf(r.chain), r.node.id));
  });

  // A new file in a folder, or (id=, base=) a new version of a file there.
  add('PUT', '/api/agent/cloud/:id/files', 'agent', async c => {
    let r = cloudNode(c, c.params.id, EDIT);
    if (!r.node.is_dir) fail(400, 'Not a folder.');
    let name = fitName(c.query.get('name') || '');
    if (c.query.get('id')) {
      const x = cloudNode(c, c.query.get('id'), EDIT);
      if (x.node.is_dir || x.node.parent_id !== r.node.id) fail(400, 'That file is not in this folder.');
      if (contentVersion(x.node) !== c.query.get('base')) fail(409, 'It was changed on the website meanwhile.', 'changed');
      name = x.node.name;
    }
    const size = Number(c.req.headers['content-length']);
    if (!Number.isSafeInteger(size) || size < 0) fail(411, 'The file size is missing.');
    if (size > cfg.maxFile) fail(413, `Files larger than ${fmtBytes(cfg.maxFile)} cannot be uploaded.`);
    checkPathLength(r.chain, name);
    const blob = await receiveBlob(c, r.chain, size);
    const made = placeFile(c, r, name, blob, size);
    const x = acl.resolve(c.ctx, made.id);
    return cloudItem(x.node, x.level);
  });

  add('POST', '/api/agent/cloud/:id/folders', 'agent', c => {
    const r = cloudNode(c, c.params.id, EDIT);
    if (!r.node.is_dir) fail(400, 'Not a folder.');
    const name = fitName(c.query.get('name') || '');
    const ex = taken(r.node.id, name);
    if (ex) {
      const x = ex.is_dir && acl.resolve(c.ctx, ex.id);
      if (!x?.level) fail(409, 'Something with this name already exists here.');
      return cloudItem(x.node, x.level); // made on the website meanwhile, or by another computer: the same folder
    }
    checkPathLength(r.chain, name);
    const now = Date.now();
    const id = unique(() => db.run('INSERT INTO nodes(parent_id, name, is_dir, created_at, updated_at, updated_by) VALUES(?, ?, 1, ?, ?, ?)', r.node.id, name, now, now, c.user.id).lastInsertRowid);
    audit(c, 'file', `created folder (on computer "${c.device.name}")`, `${pathOf(r.chain)} / ${name}`, id);
    const x = acl.resolve(c.ctx, id);
    return cloudItem(x.node, x.level);
  });

  // Renamed and/or moved on the computer (name=, parent=; base= for a file): the same item, every website rule applies.
  add('POST', '/api/agent/cloud/:id/move', 'agent', c => {
    const r = cloudNode(c, c.params.id, EDIT);
    if (!r.node.is_dir && c.query.get('base') && contentVersion(r.node) !== c.query.get('base')) fail(409, 'It was changed on the website meanwhile.', 'changed');
    const parent = c.query.get('parent');
    if (parent) cloudNode(c, parent, EDIT);
    moveNode(c, r.node.id, { name: c.query.get('name') ? fitName(c.query.get('name')) : undefined, parent_id: parent ? int(parent) : undefined });
    const x = acl.resolve(c.ctx, r.node.id);
    return cloudItem(x.node, x.level);
  });

  add('DELETE', '/api/agent/cloud/:id', 'agent', c => {
    const r = cloudNode(c, c.params.id, EDIT);
    if (!r.node.is_dir && c.query.get('base') && contentVersion(r.node) !== c.query.get('base')) fail(409, 'It was changed on the website meanwhile.', 'changed');
    trashNode(c, r.node.id);
  });

  // ---- Network drive for Macs (WebDAV), decided 2026-11-20 ----
  // Finder mounts the same tree as files on demand (the sidebar's places, no confidential folders) and fetches a file
  // when it is opened: as close to OneDrive as a Mac allows without Apple's paid signing. The password is a paired
  // computer's agent token (Basic auth; the site is HTTPS only), and every website rule applies (Read stays read
  // only, deletions go to the trash, downloads are metered and logged). Names starting with a dot (Finder's
  // .DS_Store and ._ files, programs' temporary files) are kept in memory per computer, never among the company's
  // files; a temporary file renamed onto a real one (a program saving) becomes a new version of it.
  const DAV_ROOT = ['dav', cfg.appName]; // mounted as https://<site>/dav/<app name>; the volume takes that name
  const davMem = new Map(); // `${device id}\n${path in lower case}` -> { name, dir, buf, at }
  let davMemBytes = 0;
  const xmlEsc = s => String(s).replace(/[<>&'"]/g, ch => `&#${ch.charCodeAt(0)};`);
  const davHref = (segs, dir) => '/' + [...DAV_ROOT, ...segs].map(encodeURIComponent).join('/') + (dir ? '/' : '');
  const davKey = (c, segs) => `${c.device.id}\n${segs.join('/').toLowerCase()}`;
  const inMemory = segs => segs.some(s => s.startsWith('.'));
  function davPath(pathname) { // the path below the drive's root, or null when outside it
    const segs = pathname.split('/').filter(Boolean).map(s => decodeURIComponent(s).normalize('NFC'));
    return segs[0] === DAV_ROOT[0] && segs[1] === DAV_ROOT[1] ? segs.slice(2) : null;
  }
  function davAuth(c) {
    const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(c.req.headers.authorization || '');
    const token = m ? Buffer.from(m[1], 'base64').toString().split(':').slice(1).join(':') : '';
    try {
      Object.assign(c, agentAuth({ headers: { authorization: `Bearer ${token}` } }));
    } catch (e) {
      c.res.setHeader('WWW-Authenticate', `Basic realm="${cfg.appName}", charset="UTF-8"`);
      throw e;
    }
  }
  // { top } for the drive's root, the resolved item, or null when it is not there for this person.
  function davFind(c, segs) {
    if (!segs.length) return { top: true };
    const t = cloudTop(c).find(x => x.name.toLowerCase() === segs[0].toLowerCase());
    let r = t && acl.resolve(c.ctx, t.id);
    for (const s of segs.slice(1)) {
      if (!r?.level || !r.node.is_dir) return null;
      const n = taken(r.node.id, s);
      r = n && acl.resolve(c.ctx, n.id);
    }
    return r?.level && r.area !== 'confidential' ? r : null;
  }
  // The folder a new item goes into: an existing folder below the root, where this person may edit.
  function davParent(c, segs) {
    const p = davFind(c, segs.slice(0, -1));
    if (!p) fail(409, 'The folder it should go into does not exist.');
    if (p.top) fail(403, 'The top level holds the sections; put files inside one of them.');
    if (!p.node.is_dir) fail(409, 'That is not a folder.');
    if (p.level < EDIT) fail(403, 'You can only view this folder.');
    return p;
  }
  // No quota properties: macOS 15.4 and later stalls every mount for 90 s when a WebDAV server reports them (the
  // workaround Cryptomator ships too; measured on a CI Mac: 90 s from the mount to its first use).
  function davEntry(href, it) {
    return `<D:response><D:href>${xmlEsc(href)}</D:href><D:propstat><D:prop><D:displayname>${xmlEsc(it.name)}</D:displayname>` +
      (it.dir
        ? '<D:resourcetype><D:collection/></D:resourcetype>'
        : `<D:resourcetype/><D:getcontentlength>${it.size}</D:getcontentlength><D:getcontenttype>${PREVIEW[ext(it.name)] || 'application/octet-stream'}</D:getcontenttype><D:getetag>"${it.v || it.modified}"</D:getetag>`) +
      `<D:getlastmodified>${new Date(it.modified).toUTCString()}</D:getlastmodified><D:creationdate>${new Date(it.created).toISOString()}</D:creationdate>` +
      '<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>' +
      '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>';
  }
  const memItem = m => ({ name: m.name, dir: m.dir, size: m.buf?.length || 0, modified: m.at, created: m.at });
  const davXml = (c, status, xml) => sendBody(c.res, status, 'application/xml; charset=utf-8', Buffer.from(`<?xml version="1.0" encoding="utf-8"?>\n${xml}`));
  async function readSmall(req, max) {
    const chunks = [];
    let n = 0;
    for await (const ch of req) {
      if ((n += ch.length) > max) fail(413, 'Too large for a temporary file.');
      chunks.push(ch);
    }
    return Buffer.concat(chunks);
  }
  function memPut(key, entry) {
    const old = davMem.get(key);
    davMemBytes += (entry.buf?.length || 0) - (old?.buf?.length || 0);
    davMem.delete(key);
    davMem.set(key, entry);
    for (const [k, v] of davMem) { // oldest first, while over 128 MB in all
      if (davMemBytes <= 128 * 2 ** 20) break;
      davMemBytes -= v.buf?.length || 0;
      davMem.delete(k);
    }
  }
  function memDrop(key) {
    davMemBytes -= davMem.get(key)?.buf?.length || 0;
    davMem.delete(key);
  }
  // Received content as a stored file: the body of this request, or a temporary file kept in memory.
  async function davReceive(c, chain, from) {
    if (from) return { blob: await store.receive(Readable.from([from.buf]), from.buf.length), size: from.buf.length };
    const len = c.req.headers['content-length'];
    if (len != null) {
      const size = Number(len);
      if (!Number.isSafeInteger(size) || size < 0) fail(400, 'Invalid size.');
      if (size > cfg.maxFile) fail(413, `Files larger than ${fmtBytes(cfg.maxFile)} cannot be uploaded.`);
      return { blob: await receiveBlob(c, chain, size), size };
    }
    // Chunked: Finder sends big files without a length (X-Expected-Entity-Length says what is coming).
    const hint = Number(c.req.headers['x-expected-entity-length']);
    if (Number.isSafeInteger(hint)) {
      if (hint > cfg.maxFile) fail(413, `Files larger than ${fmtBytes(cfg.maxFile)} cannot be uploaded.`);
      checkQuota(chain, hint);
    }
    await checkDisk();
    const blob = await store.receive(c.req, null, cfg.maxFile);
    return { blob, size: (await fs.promises.stat(store.file(blob))).size };
  }

  async function dav(c, url) {
    const m = c.req.method;
    if (m === 'OPTIONS') {
      c.res.writeHead(200, { DAV: '1, 2', 'MS-Author-Via': 'DAV', Allow: 'OPTIONS, PROPFIND, PROPPATCH, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY, LOCK, UNLOCK', 'Content-Length': 0 });
      return c.res.end();
    }
    davAuth(c);
    const segs = davPath(url.pathname);
    if (!segs) fail(404, 'Not found.');
    if (m !== 'PUT') c.req.resume(); // request bodies other than files are not needed (PROPFIND asks for the usual set)
    const mem = inMemory(segs);
    const key = davKey(c, segs);
    const label = `on computer "${c.device.name}" (network drive)`;

    if (m === 'PROPFIND') {
      const depth = c.req.headers.depth === '0' ? 0 : 1; // "infinity" is answered one level deep
      let self, kids = [];
      if (mem) {
        const e = davMem.get(key);
        if (!e) fail(404, 'Not found.');
        self = memItem(e);
      } else {
        const r = davFind(c, segs);
        if (!r) fail(404, 'Not found.');
        self = r.top ? { name: cfg.appName, dir: true, modified: Date.now(), created: Date.now() } : { ...cloudItem(r.node, r.level), name: segs.at(-1) };
        if (depth && self.dir) kids = r.top ? cloudTop(c) : acl.children(c.ctx, r).map(n => cloudItem(n, n.level));
      }
      const out = [davEntry(davHref(segs, self.dir), self), ...kids.map(k => davEntry(davHref([...segs, k.name], k.dir), k))];
      if (depth && self.dir) { // temporary files kept in memory for this folder
        const prefix = davKey(c, segs) + (segs.length ? '/' : '');
        for (const [k, e] of davMem) if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/')) out.push(davEntry(davHref([...segs, e.name], e.dir), memItem(e)));
      }
      return davXml(c, 207, `<D:multistatus xmlns:D="DAV:">${out.join('')}</D:multistatus>`);
    }

    if (m === 'GET' || m === 'HEAD') {
      if (mem) {
        const e = davMem.get(key);
        if (!e || e.dir) fail(404, 'Not found.');
        c.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': e.buf.length });
        return c.res.end(m === 'HEAD' ? undefined : e.buf);
      }
      const r = davFind(c, segs);
      if (!r) fail(404, 'Not found.');
      if (r.top || r.node.is_dir) {
        c.res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return c.res.end(m === 'HEAD' ? undefined : `${cfg.appName} network drive: connect it from the Company Files program.\n`);
      }
      return sendFile(c, r.node.blob, r.node.size, r.node.name, false, `user ${c.user.login}`, () => audit(c, 'file', `opened ${label}`, pathOf(r.chain), r.node.id));
    }

    if (m === 'PUT') {
      if (!segs.length) fail(405, 'Not a file.');
      if (mem) {
        if (davMem.get(key)?.dir) fail(405, 'That is a folder.');
        memPut(key, { name: segs.at(-1), dir: false, buf: await readSmall(c.req, 64 * 2 ** 20), at: Date.now() });
        c.res.writeHead(201, { 'Content-Length': 0 });
        return c.res.end();
      }
      const p = davParent(c, segs);
      const name = cleanName(segs.at(-1));
      checkPathLength(p.chain, name);
      const before = taken(p.node.id, name);
      if (before?.is_dir && acl.resolve(c.ctx, before.id)?.level) fail(405, 'A folder with this name already exists here.');
      const { blob, size } = await davReceive(c, p.chain);
      const made = placeFile(c, p, name, blob, size);
      c.res.writeHead(made.created ? 201 : 204, { 'Content-Length': 0 });
      return c.res.end();
    }

    if (m === 'MKCOL') {
      if (!segs.length) fail(405, 'It exists.');
      if (mem) {
        if (davMem.has(key)) fail(405, 'It exists.');
        memPut(key, { name: segs.at(-1), dir: true, buf: null, at: Date.now() });
      } else {
        const p = davParent(c, segs);
        const name = cleanName(segs.at(-1));
        if (taken(p.node.id, name)) fail(405, 'Something with this name already exists here.');
        checkPathLength(p.chain, name);
        const now = Date.now();
        const id = unique(() => db.run('INSERT INTO nodes(parent_id, name, is_dir, created_at, updated_at, updated_by) VALUES(?, ?, 1, ?, ?, ?)', p.node.id, name, now, now, c.user.id).lastInsertRowid);
        audit(c, 'file', `created folder ${label}`, `${pathOf(p.chain)} / ${name}`, id);
      }
      c.res.writeHead(201, { 'Content-Length': 0 });
      return c.res.end();
    }

    if (m === 'DELETE') {
      if (mem) {
        if (!davMem.has(key)) fail(404, 'Not found.');
        for (const k of [...davMem.keys()]) if (k === key || k.startsWith(key + '/')) memDrop(k);
      } else {
        const r = davFind(c, segs);
        if (!r) fail(404, 'Not found.');
        if (r.top || segs.length < 2) fail(403, 'The places at the top level cannot be deleted.');
        trashNode(c, r.node.id);
      }
      c.res.writeHead(204);
      return c.res.end();
    }

    if (m === 'MOVE' || m === 'COPY') {
      const dest = davPath(new URL(String(c.req.headers.destination || ''), 'http://x').pathname);
      if (!dest?.length || !segs.length) fail(403, 'Choose another place.');
      const overwrite = String(c.req.headers.overwrite || 'T').toUpperCase() !== 'F';
      const destKey = davKey(c, dest);
      if (mem) {
        const e = davMem.get(key);
        if (!e) fail(404, 'Not found.');
        if (inMemory(dest)) { // temporary file renamed to another temporary name
          if (davMem.has(destKey) && !overwrite) fail(412, 'It exists.');
          if (m === 'MOVE') memDrop(key);
          memPut(destKey, { ...e, name: dest.at(-1), at: Date.now() });
          c.res.writeHead(201, { 'Content-Length': 0 });
          return c.res.end();
        }
        // a program saving: its temporary file becomes the real one (a new version when that exists)
        if (e.dir) fail(403, 'Folders cannot be moved here this way.');
        const p = davParent(c, dest);
        const name = cleanName(dest.at(-1));
        const before = taken(p.node.id, name);
        if (before && !overwrite) fail(412, 'Something with this name already exists here.');
        if (before?.is_dir) fail(403, 'A folder with this name already exists here.');
        const { blob, size } = await davReceive(c, p.chain, e);
        const made = placeFile(c, p, name, blob, size);
        if (m === 'MOVE') memDrop(key);
        c.res.writeHead(made.created ? 201 : 204, { 'Content-Length': 0 });
        return c.res.end();
      }
      if (inMemory(dest)) fail(403, 'Files cannot be given names starting with a dot here.'); // never take real files into memory
      const r = davFind(c, segs);
      if (!r) fail(404, 'Not found.');
      if (r.top || segs.length < 2) fail(403, 'The places at the top level cannot be moved.');
      const p = davParent(c, dest);
      const name = cleanName(dest.at(-1));
      const before = taken(p.node.id, name);
      const replacing = before && before.id !== r.node.id;
      if (replacing && !overwrite) fail(412, 'Something with this name already exists here.');
      if (replacing && !before.is_dir && !r.node.is_dir) {
        // A file put over a file: a new version of it, so its history stays (the moved one goes to the trash).
        const tmp = path.join(cfg.dataDir, 'tmp', crypto.randomBytes(16).toString('hex'));
        await fs.promises.copyFile(store.file(r.node.blob), tmp);
        placeFile(c, p, name, await store.adopt(tmp), r.node.size);
        if (m === 'MOVE') trashNode(c, r.node.id);
        c.res.writeHead(204);
        return c.res.end();
      }
      if (replacing) trashNode(c, before.id);
      if (m === 'MOVE') moveNode(c, r.node.id, { name, parent_id: p.node.id });
      else {
        if (r.node.is_dir) fail(403, 'Copy folders on the website.');
        const tmp = path.join(cfg.dataDir, 'tmp', crypto.randomBytes(16).toString('hex'));
        await fs.promises.copyFile(store.file(r.node.blob), tmp);
        placeFile(c, p, name, await store.adopt(tmp), r.node.size);
      }
      c.res.writeHead(replacing ? 204 : 201, { 'Content-Length': 0 });
      return c.res.end();
    }

    if (m === 'LOCK') { // Finder writes only to drives that lock; nothing else here relies on locks
      const token = `opaquelocktoken:${crypto.randomUUID()}`;
      c.res.setHeader('Lock-Token', `<${token}>`);
      return davXml(c, 200, `<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>0</D:depth><D:owner>${xmlEsc(c.device.name)}</D:owner><D:timeout>Second-3600</D:timeout><D:locktoken><D:href>${token}</D:href></D:locktoken><D:lockroot><D:href>${xmlEsc(davHref(segs))}</D:href></D:lockroot></D:activelock></D:lockdiscovery></D:prop>`);
    }
    if (m === 'UNLOCK') {
      c.res.writeHead(204);
      return c.res.end();
    }
    if (m === 'PROPPATCH') { // Finder stores its own properties; they are not kept
      return davXml(c, 207, `<D:multistatus xmlns:D="DAV:"><D:response><D:href>${xmlEsc(davHref(segs))}</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`);
    }
    fail(405, 'Not supported.');
  }

  // "A/B/name" below My files: creates the folders that are missing (names fitted) and returns the last folder's id
  // and the fitted name. With dir, all of it is folders.
  function homePath(c, home, raw, dir = false) {
    const segs = String(raw || '').split('/').filter(Boolean);
    if (!segs.length || segs.length > 40) fail(400, 'Invalid path.');
    const name = dir ? null : fitName(segs.pop());
    const dirs = segs.map(fitName);
    if ([...acl.resolve(c.ctx, home.id).chain.map(n => n.name), ...dirs, name || ''].join('/').length > PATH_MAX) fail(400, `The full path would be longer than ${PATH_MAX} characters.`);
    let folderId = home.id;
    db.tx(() => {
      for (const seg of dirs) {
        const ex = taken(folderId, seg);
        if (ex && !ex.is_dir) fail(409, `"${seg}" is a file on the website, not a folder.`);
        if (ex && (acl.resolve(c.ctx, ex.id)?.level || 0) < EDIT) fail(403, `You cannot add files to "${seg}".`);
        const now = Date.now();
        folderId = ex ? ex.id : db.run('INSERT INTO nodes(parent_id, name, is_dir, created_at, updated_at, updated_by) VALUES(?, ?, 1, ?, ?, ?)', folderId, seg, now, now, c.user.id).lastInsertRowid;
      }
    });
    return { folderId, name };
  }

  // A folder made on the computer (empty ones too).
  add('POST', '/api/agent/mirror/dir', 'agent', c => {
    const home = homeOf(c.user);
    if (!home) fail(404, 'This account has no My files folder.');
    const { folderId } = homePath(c, home, c.query.get('path'), true);
    return { id: folderId, path: relOf(acl.resolve(c.ctx, folderId), home) };
  });

  // A file or folder renamed or moved on the computer: the same item is renamed or moved here (its versions and
  // access settings stay). For a file, base= is the version the computer had.
  add('POST', '/api/agent/mirror/move', 'agent', c => {
    const home = homeOf(c.user);
    const dir = c.query.get('dir') === '1';
    const r = inHome(c, home, c.query.get('id'), dir);
    if (!dir && contentVersion(r.node) !== c.query.get('base')) fail(409, 'It was changed on the website meanwhile.', 'changed');
    if (r.parentLevel < EDIT) fail(403, 'You cannot move this.');
    const segs = String(c.query.get('path') || '').split('/').filter(Boolean);
    if (!segs.length || segs.length > 40) fail(400, 'Invalid path.');
    const name = fitName(segs.pop());
    const { folderId } = segs.length ? homePath(c, home, segs.join('/'), true) : { folderId: home.id };
    const d = acl.resolve(c.ctx, folderId);
    if ((d?.level || 0) < EDIT) fail(403, 'You cannot move things there.');
    if (d.chain.some(n => n.id === r.node.id)) fail(400, 'A folder cannot be moved into itself.');
    guardHidden(c, r);
    if (folderId !== r.node.parent_id || name !== r.node.name) {
      checkPathLength(d.chain, name, dir ? r.node.id : null);
      unique(() => db.run('UPDATE nodes SET name = ?, parent_id = ?, updated_at = ?, updated_by = ? WHERE id = ?', name, folderId, Date.now(), c.user.id, r.node.id));
      audit(c, 'file', `${folderId !== r.node.parent_id ? 'moved' : 'renamed'} (on computer "${c.device.name}")`, `${pathOf(r.chain)} → ${pathOf(d.chain)} / ${name}`, r.node.id);
    }
    return { id: r.node.id, path: relOf(acl.resolve(c.ctx, r.node.id), home) };
  });

  // A folder deleted on the computer goes to the trash here, once it holds nothing more (its files go one by one).
  add('DELETE', '/api/agent/mirror/dir/:id', 'agent', c => {
    const x = inHome(c, homeOf(c.user), c.params.id, true);
    if (db.get('SELECT 1 FROM nodes WHERE parent_id = ? AND deleted_at IS NULL', x.node.id)) fail(409, 'This folder still has something in it on the website.', 'not-empty');
    if (x.parentLevel < EDIT) fail(403, 'You cannot delete this folder.');
    db.run('UPDATE nodes SET deleted_at = ?, deleted_by = ? WHERE id = ?', Date.now(), c.user.id, x.node.id);
    audit(c, 'file', `moved to trash (deleted on computer "${c.device.name}")`, pathOf(x.chain), x.node.id);
  });

  add('DELETE', '/api/agent/mirror/:id', 'agent', c => {
    const x = inHome(c, homeOf(c.user), c.params.id);
    if (contentVersion(x.node) !== c.query.get('base')) fail(409, 'It was changed on the website meanwhile.', 'changed');
    if (x.parentLevel < EDIT) fail(403, 'You cannot delete files here.');
    db.run('UPDATE nodes SET deleted_at = ?, deleted_by = ? WHERE id = ?', Date.now(), c.user.id, x.node.id);
    audit(c, 'file', `moved to trash (deleted on computer "${c.device.name}")`, pathOf(x.chain), x.node.id);
  });

  add('POST', '/api/agent/files/:qid/done', 'agent', async c => {
    const q = queued(c, int(c.params.qid));
    if (!q) fail(404, 'Not in the queue.');
    finish(q, (await body(c)).result === 'skipped' ? 'skipped' : 'saved');
  });

  // ---- WebSocket: the server only pushes "your queue changed"; the agent fetches over HTTP ----
  function wsSend(socket, text) {
    const p = Buffer.from(text);
    const head = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]);
    if (!socket.destroyed) socket.write(Buffer.concat([head, p]));
  }
  function upgrade(req, socket) {
    const reject = (status, msg) => {
      socket.end(`HTTP/1.1 ${status} ${msg}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${msg}`);
    };
    let who;
    try {
      if (!cfg.allowedHosts.includes(String(req.headers.host || '').toLowerCase())) return reject(421, 'Misdirected Request');
      if (new URL(req.url, 'http://x').pathname !== '/api/agent/ws' || req.headers.upgrade?.toLowerCase() !== 'websocket' || !req.headers['sec-websocket-key']) return reject(404, 'Not Found');
      who = agentAuth(req);
    } catch (e) {
      return reject(e.status === 401 ? 401 : 400, e.status === 401 ? 'Unauthorized' : 'Bad Request');
    }
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    socket.cloud = new URL(req.url, 'http://x').searchParams.get('cloud') === '1'; // agents with files on demand
    const id = who.device.id;
    if (!sockets.has(id)) sockets.set(id, new Set());
    sockets.get(id).add(socket);
    let buf = Buffer.alloc(0), heard = Date.now();
    // Ping every 30 s keeps proxies from closing an idle line; silence for 75 s, or a revoked device, ends it.
    const timer = setInterval(() => {
      const d = db.get('SELECT revoked_at FROM devices WHERE id = ?', id);
      const u = db.get('SELECT disabled FROM users WHERE id = ?', who.user.id);
      if (Date.now() - heard > 75e3 || !d || d.revoked_at || u.disabled) return socket.destroy();
      if (!socket.destroyed) socket.write(Buffer.from([0x89, 0]));
    }, 30e3);
    const gone = () => {
      clearInterval(timer);
      sockets.get(id)?.delete(socket);
    };
    socket.on('close', gone).on('error', () => socket.destroy());
    socket.on('data', d => {
      heard = Date.now();
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        const op = buf[0] & 15, masked = buf[1] & 128;
        let len = buf[1] & 127, off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) return socket.destroy(); // agents never send large frames
        if (!masked || len > 4096) return socket.destroy();
        if (buf.length < off + 4 + len) return;
        const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < data.length; i++) data[i] ^= buf[off + (i & 3)];
        buf = buf.subarray(off + 4 + len);
        if (op === 8) return socket.end(Buffer.from([0x88, 0]));
        if (op === 9) socket.write(Buffer.concat([Buffer.from([0x8a, data.length]), data]));
      }
    });
    if (Date.now() - (who.device.seen_at || 0) > 60e3) db.run('UPDATE devices SET seen_at = ? WHERE id = ?', Date.now(), id);
    wsSend(socket, JSON.stringify({ type: 'queue' })); // fetch whatever was sent while it was off
    wsSend(socket, JSON.stringify({ type: 'mirror' })); // and catch up with My files
  }

  add('GET', '/api/search', 'user', c => {
    const q = (c.query.get('q') || '').trim().slice(0, 100);
    if (q.length < 2) return [];
    const like = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';
    const out = [];
    const res = acl.resolver(c.ctx);
    // Someone with a whole section (Managers) sees most of the tree: one pass over all names is quickest. Everyone
    // else searches only below the folders and files granted to them (everything they can open is there; UNION also
    // ends a parent/child cycle), instead of sifting the whole company's names. resolve() has the last word.
    const groups = JSON.stringify([...c.ctx.groups]);
    const wide = db.get('SELECT 1 FROM acl a JOIN nodes n ON n.id = a.node_id WHERE n.parent_id IS NULL AND (a.user_id = ? OR a.group_id IN (SELECT value FROM json_each(?))) LIMIT 1', c.ctx.uid, groups);
    const match = "n.name LIKE ? ESCAPE '\\' AND n.deleted_at IS NULL AND n.parent_id IS NOT NULL ORDER BY n.updated_at DESC LIMIT 2000";
    const hits = wide
      ? db.all(`SELECT n.id FROM nodes n WHERE ${match}`, like)
      : db.all(
          `WITH RECURSIVE t(id) AS (
             SELECT node_id FROM acl WHERE user_id = ? OR group_id IN (SELECT value FROM json_each(?))
             UNION SELECT n.id FROM nodes n JOIN t ON n.parent_id = t.id WHERE n.deleted_at IS NULL)
           SELECT n.id FROM nodes n JOIN t ON n.id = t.id WHERE ${match}`,
          c.ctx.uid,
          groups,
          like,
        );
    for (const { id } of hits) {
      const r = res(id);
      if (!r?.level) continue;
      out.push({ ...view(r.node, r.level), location: acl.crumbs(c.ctx, r).crumbs.slice(0, -1).map(x => x.name).join(' / '), parent_id: r.node.parent_id });
      if (out.length >= 100) break;
    }
    return out;
  });

  // =====================================================================
  // Access lists and external links
  // =====================================================================
  add('GET', '/api/nodes/:id/access', 'full', c => {
    const { r, editable, maxLevel } = accessTarget(c);
    return {
      ...acl.accessView(r),
      path: pathOf(r.chain),
      editable,
      maxLevel,
      dir: !!r.node.is_dir,
      canRestrict: editable && !r.node.system && !!r.node.is_dir,
      confidential: r.area === 'confidential',
      personal: r.area === 'personal',
      // Confidential and personal items are shared with named people; group grants there are IT's call.
      lockedGroups: !c.user.is_admin && (r.area === 'confidential' || r.area === 'personal'),
      lockedManagers: !c.user.is_admin, // only IT changes the Managers group's access, so nobody locks Managers out
    };
  });

  add('PUT', '/api/nodes/:id/access', 'full', async c => {
    const { r, editable, maxLevel } = accessTarget(c);
    if (!editable) fail(403, 'Only the folder manager can change access here.');
    const b = await body(c);
    // Confidential and personal owners share with named people only; group grants there stay as IT set them.
    const ownerMode = !c.user.is_admin && (r.area === 'confidential' || r.area === 'personal');
    const keep = e => (ownerMode ? e?.type === 'user' : c.user.is_admin || !(e?.type === 'group' && Number(e.id) === db.ids.managers));
    const incoming = Array.isArray(b.entries) ? b.entries.filter(keep) : b.entries;
    const entries = parseEntries(incoming, { maxLevel, confidential: r.area === 'confidential' });
    const id = r.node.id;
    const before = describeAcl(id);
    const inherit = r.node.system ? r.node.inherit : b.restricted ? 0 : 1;
    db.tx(() => {
      // Managers and folder managers cannot touch Manage grants or the Managers group (set by IT); admins replace the whole list.
      const kept = c.user.is_admin ? '' : ` AND level < 3 AND (group_id IS NULL OR group_id != ${db.ids.managers})`;
      db.run(`DELETE FROM acl WHERE node_id = ?${kept}${ownerMode ? ' AND user_id IS NOT NULL' : ''}`, id);
      for (const e of entries) insertAcl(id, e, true);
      db.run('UPDATE nodes SET inherit = ? WHERE id = ?', inherit, id);
    });
    const restrictNote = inherit === r.node.inherit ? '' : inherit ? ' (restriction removed)' : ' (folder restricted)';
    // Admin changes (system folders only) are logged without node_id so every Manager sees them;
    // changes inside a department or a personal folder show only to people who can open it.
    const alert = r.area === 'confidential' ? 'ALERT ' : '';
    audit(c, 'acl', `${alert}access changed${restrictNote}: ${before} → ${describeAcl(id)}`, pathOf(r.chain), r.node.system && r.area !== 'personal' ? null : id);
  });

  add('GET', '/api/nodes/:id/links', 'user', c => {
    const r = need(c, c.params.id, READ);
    if (!canShare(r)) fail(403, 'Only the project lead can see external links.');
    return db
      .all('SELECT s.id, s.token, s.expires_at, s.created_at, u.name AS created_by FROM shares s LEFT JOIN users u ON u.id = s.created_by WHERE s.node_id = ? AND s.revoked = 0 AND s.expires_at > ? ORDER BY s.created_at DESC', r.node.id, Date.now())
      .map(({ token, ...s }) => ({ ...s, url: `${cfg.publicUrl.origin}/s/${token}` }));
  });

  add('POST', '/api/nodes/:id/links', 'user', async c => {
    const r = need(c, c.params.id, READ);
    if (r.area === 'confidential') fail(403, 'External links are turned off for confidential folders.');
    if (!canShare(r)) fail(403, 'External links can only be created by the project lead, for folders and files inside a project.');
    const b = await body(c);
    const days = Number(b.days);
    if (!Number.isInteger(days) || days < 1 || days > LINK_MAX_DAYS) fail(400, `Expiry must be between 1 and ${LINK_MAX_DAYS} days.`);
    // The server picks the password (16 random characters), so it cannot be a weak one; it is shown once.
    const password = A.tempPassword();
    const token = A.token(18);
    const expires_at = Date.now() + days * DAY;
    const id = db.run('INSERT INTO shares(token, node_id, pass, expires_at, created_by, created_at) VALUES(?, ?, ?, ?, ?, ?)', token, r.node.id, await A.hashPassword(password), expires_at, c.user.id, Date.now()).lastInsertRowid;
    audit(c, 'acl', `external link #${id} created, expires in ${days} days`, pathOf(r.chain), r.node.id);
    return { id, url: `${cfg.publicUrl.origin}/s/${token}`, password, expires_at };
  });

  add('DELETE', '/api/links/:sid', 'user', c => {
    const s = db.get('SELECT * FROM shares WHERE id = ?', int(c.params.sid));
    if (!s) fail(404, 'Link not found.');
    const r = need(c, s.node_id, READ);
    if (s.created_by !== c.user.id && r.level < MANAGE) fail(403, 'Only the person who created the link or the folder manager can turn it off.');
    db.run('UPDATE shares SET revoked = 1 WHERE id = ?', s.id);
    audit(c, 'acl', `external link #${s.id} turned off`, pathOf(r.chain), s.node_id);
  });

  // Public side of external links. Password first; then a signed cookie scoped to this one link.
  add('GET', '/api/public/:token', 'public', c => {
    const { s } = shareFor(c);
    return { appName: cfg.appName, unlocked: granted(c, s), expires_at: s.expires_at };
  });

  add('POST', '/api/public/:token/unlock', 'public', async c => {
    const { s, r } = shareFor(c);
    const key = 'link:' + s.id;
    guard(c, key, false);
    const { password } = await body(c);
    if (!(await checkPassword(c, String(password ?? '').trim().slice(0, 200), s.pass))) {
      failed(c, key, false);
      fail(401, 'Wrong password.');
    }
    cleared(c, key);
    const exp = Math.min(s.expires_at, Date.now() + 8 * 3600e3);
    c.res.setHeader('Set-Cookie', cookie(GRANT, `${exp}.${A.hmac(secret, `${s.id}.${exp}`)}`, { path: `/api/public/${s.token}`, maxAge: (exp - Date.now()) / 1000 }));
    audit(c, 'share', `external link #${s.id} opened`, pathOf(r.chain), s.node_id);
  });

  add('GET', '/api/public/:token/items', 'public', c => {
    const { s } = shareFor(c);
    if (!granted(c, s)) fail(401, 'Enter the link password.');
    const { x, crumbs } = sharedItem(c, s);
    const children = x.node.is_dir
      ? db.all('SELECT * FROM nodes WHERE parent_id = ? AND deleted_at IS NULL AND inherit = 1 ORDER BY is_dir DESC, name COLLATE NOCASE', x.node.id).map(n => view(n, READ))
      : [];
    return { node: view(x.node, READ), crumbs, children, expires_at: s.expires_at };
  });

  add('GET', '/api/public/:token/content', 'public', c => {
    const { s } = shareFor(c);
    if (!granted(c, s)) fail(401, 'Enter the link password.');
    const { x } = sharedItem(c, s);
    if (x.node.is_dir) fail(400, 'Folders cannot be downloaded as one file.');
    sendFile(c, x.node.blob, x.node.size, x.node.name, c.query.get('inline') === '1', `external link #${s.id}`, what => audit(c, 'share', `external link #${s.id}: ${what}`, pathOf(x.chain), x.node.id));
  });

  // =====================================================================
  // Sign-up by invite link. IT sends the link; people confirm their email with a one-time code.
  // New accounts are ordinary employees: they see only their own folder until someone gives access.
  // =====================================================================
  // No "+tag" (one mailbox, many accounts) and no "%" (old relays reroute user%other@domain elsewhere).
  const EMAIL_RE = /^[a-z0-9._-]{1,64}@[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/;
  const RESERVED = new Set(['admin', 'administrator', 'root', 'it', 'support', 'security', 'system', 'manager', 'managers', 'noreply', 'postmaster', 'hostmaster', 'webmaster']);
  const CODE_TTL = 10 * 60e3;
  const MAILS_PER_HOUR = 300; // all sign-up emails together, so nobody can burn the company mailbox
  let mailWindow = { since: 0, n: 0 };
  const pending = new Map(); // `${invite id}:${email}` -> { code (sha256, or null for known addresses), until, tries, sent }
  const joinIp = A.throttle({ max: 20, windowMs: 3600e3, lockMs: 3600e3 }); // code emails per IP per hour
  const joinMail = A.throttle({ max: 5, windowMs: 3600e3, lockMs: 3600e3 }); // and per address
  const LINK_GONE = 'This invitation link has expired or was turned off. Ask IT for a new one.';

  function inviteFor(token) {
    const inv = db.get('SELECT * FROM invites WHERE token = ?', A.sha256(String(token)));
    if (!inv || inv.revoked || inv.expires_at < Date.now() || inv.uses >= inv.max_uses) fail(404, LINK_GONE);
    if (!cfg.smtp) fail(503, 'Sign-up is not available yet because email is not set up. Ask IT.');
    return inv;
  }

  async function mail(to, subject, text) {
    try {
      await sendMail({ ...cfg.smtp, helo: cfg.publicUrl.hostname }, { to, subject, text });
    } catch (e) {
      console.error(`sign-up email failed: ${e.message}`); // no address in the log: it is personal data
      fail(502, 'The email could not be sent. Try again in a few minutes or ask IT.');
    }
  }

  add('GET', '/api/join/:token', 'public', c => ({ appName: cfg.appName, domain: inviteFor(c.params.token).domain }));

  add('POST', '/api/join/:token/code', 'public', async c => {
    const inv = inviteFor(c.params.token);
    const b = await body(c);
    const name = str(b.name, 80) || fail(400, 'Enter your full name.');
    const email = (str(b.email, 254) || '').toLowerCase();
    if (!EMAIL_RE.test(email)) fail(400, 'Enter a valid email address.');
    if (inv.domain && !email.endsWith(`@${inv.domain}`)) fail(400, `Use your @${inv.domain} address.`);
    const key = `${inv.id}:${email}`;
    const now = Date.now();
    if (now - (pending.get(key)?.sent || 0) < 60e3) fail(429, 'A code was sent less than a minute ago. Check your inbox and the spam folder.');
    if (pending.size > 10000) for (const [k, p] of pending) if (p.until < now) pending.delete(k);
    if (now - mailWindow.since > 3600e3) mailWindow = { since: now, n: 0 };
    if (joinIp.wait(ipKey(c.ip)) || joinMail.wait(email) || pending.size > 10000 || mailWindow.n >= MAILS_PER_HOUR) fail(429, 'Too many codes were requested. Try again in an hour.');
    joinIp.fail(ipKey(c.ip));
    joinMail.fail(email);
    mailWindow.n++;
    // Same answer, same timing rules, whether or not the address is registered, so nobody can look people up.
    const known = db.get('SELECT login FROM users WHERE email = ?', email);
    const code = A.otp();
    if (known)
      await mail(email, `${cfg.appName}: you already have an account`,
        `Someone, probably you, tried to sign up with this email again.\n\nYou already have an account. Your login is ${known.login}; you can also sign in with this email.\nForgot your password? IT can reset it.\n\nIf it was not you, ignore this email.\n\n${cfg.publicUrl.origin}`);
    else
      await mail(email, `${code} is your ${cfg.appName} code`,
        `Your confirmation code: ${code}\n\nIt works for 10 minutes. Enter it on the sign-up page to create your account.\nIf you did not ask for it, ignore this email: without the code nothing happens.`);
    pending.set(key, { code: known ? null : A.sha256(code), until: now + CODE_TTL, tries: 0, sent: now });
    return { sent: true };
  });

  add('POST', '/api/join/:token/confirm', 'public', async c => {
    const inv = inviteFor(c.params.token);
    const b = await body(c);
    const email = (str(b.email, 254) || '').toLowerCase();
    // The name comes with the confirmation, so someone re-requesting a code cannot rename the person who confirms.
    const name = str(b.name, 80) || fail(400, 'Enter your full name.');
    const key = `${inv.id}:${email}`;
    const p = pending.get(key);
    if (!p || p.until < Date.now()) {
      pending.delete(key);
      fail(400, 'This code has expired. Ask for a new one.');
    }
    if (!A.safeEqual(A.sha256(String(b.code ?? '').replace(/\s/g, '')), p.code)) {
      if (++p.tries >= 5) pending.delete(key);
      fail(400, p.tries >= 5 ? 'Too many wrong codes. Ask for a new one.' : 'Wrong code. Use the one from the latest email.');
    }
    const base = email.split('@')[0].replace(/[^a-z0-9._-]+/g, '.').replace(/^[._-]+|[._-]+$/g, '').slice(0, 36) || 'user';
    const problem = A.passwordProblem(b.password, base);
    if (problem) fail(400, problem);
    const hash = await A.hashPassword(b.password);
    const made = db.tx(() => {
      const fresh = db.get('SELECT * FROM invites WHERE id = ?', inv.id);
      if (fresh.revoked || fresh.expires_at < Date.now() || fresh.uses >= fresh.max_uses) fail(404, LINK_GONE);
      if (db.get('SELECT 1 FROM users WHERE email = ?', email)) fail(409, 'This email already has an account, so no new one is made. Sign in with it instead (your login is in the email we sent).');
      const free = l => !RESERVED.has(l) && !db.get('SELECT 1 FROM users WHERE login = ?', l);
      let login = base;
      for (let i = 2; !free(login); i++) login = `${base}${i}`;
      const now = Date.now();
      const uid = db.run('INSERT INTO users(login, name, email, pass, must_change, created_at) VALUES(?, ?, ?, ?, 0, ?)', login, name, email, hash, now).lastInsertRowid;
      insertAcl(newSystemFolder(db.ids.roots.personal, login, cfg.personalQuota), { type: 'user', id: uid, level: MANAGE });
      db.run('UPDATE invites SET uses = uses + 1 WHERE id = ?', inv.id);
      return { uid, login };
    });
    pending.delete(key);
    db.audit('admin', made.uid, `ALERT account created through invite link #${inv.id}`, `${name} (${made.login}, ${email})`, c.ip);
    return { login: made.login };
  });

  // =====================================================================
  // Administration (IT). Admin accounts manage people and structure, never file contents.
  // =====================================================================
  add('GET', '/api/admin/invites', 'admin', () => ({
    mail: !!cfg.smtp,
    invites: db.all(
      `SELECT i.id, i.domain, i.max_uses, i.uses, i.expires_at, i.created_at, u.name AS created_by FROM invites i LEFT JOIN users u ON u.id = i.created_by
       WHERE i.revoked = 0 AND i.expires_at > ? AND i.uses < i.max_uses ORDER BY i.created_at DESC`,
      Date.now(),
    ),
  }));

  add('POST', '/api/admin/invites', 'admin', async c => {
    const b = await body(c);
    const days = Number(b.days), uses = Number(b.max_uses);
    if (!Number.isInteger(days) || days < 1 || days > 30) fail(400, 'The link can work from 1 to 30 days.');
    if (!Number.isInteger(uses) || uses < 1 || uses > 500) fail(400, 'Allow from 1 to 500 people.');
    const domain = (str(b.domain, 100) || '').toLowerCase().replace(/^@/, '') || null;
    if (domain && !/^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/.test(domain)) fail(400, 'Enter a domain like algoritmi.kz, or leave it empty.');
    const token = A.token(24);
    const now = Date.now();
    const id = db.run('INSERT INTO invites(token, domain, max_uses, expires_at, created_by, created_at) VALUES(?, ?, ?, ?, ?, ?)', A.sha256(token), domain, uses, now + days * DAY, c.user.id, now).lastInsertRowid;
    audit(c, 'admin', `ALERT invite link #${id} created: ${days} days, up to ${uses} people${domain ? `, only @${domain}` : ''}`, null);
    return { id, url: `${cfg.publicUrl.origin}/join/${token}` };
  });

  add('DELETE', '/api/admin/invites/:id', 'admin', c => {
    const id = int(c.params.id);
    if (!db.run('UPDATE invites SET revoked = 1 WHERE id = ? AND revoked = 0', id).changes) fail(404, 'Link not found.');
    audit(c, 'admin', `invite link #${id} turned off`, null);
  });

  add('GET', '/api/admin/users', 'admin', () =>
    db.all(
      `SELECT u.id, u.login, u.name, u.email, u.is_admin, u.disabled, u.created_at,
         EXISTS(SELECT 1 FROM members m WHERE m.user_id = u.id AND m.group_id = ${db.ids.managers}) AS manager,
         (SELECT MAX(seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen,
         (SELECT group_concat(g.name, ', ') FROM members m JOIN groups g ON g.id = m.group_id WHERE m.user_id = u.id) AS groups
       FROM users u WHERE u.deleted_at IS NULL ORDER BY u.disabled, u.is_admin DESC, u.name`,
    ),
  );

  add('POST', '/api/admin/users', 'admin', async c => {
    const b = await body(c);
    const login = str(b.login, 40);
    const name = str(b.name, 80);
    if (!login || !LOGIN_RE.test(login)) fail(400, 'Logins use Latin letters, digits, dots, dashes or underscores, for example a.serikova.');
    if (!name) fail(400, 'Enter the full name.');
    const role = b.role || 'employee';
    if (!['employee', 'manager', 'admin'].includes(role)) fail(400, 'Choose a role: Employee, Manager or IT admin.');
    const admin = role === 'admin';
    const email = emailArg(b.email);
    const password = A.tempPassword();
    const hash = await A.hashPassword(password);
    const id = unique(() =>
      db.tx(() => {
        const now = Date.now();
        if (email) emailFree(email);
        const uid = db.run('INSERT INTO users(login, name, email, pass, is_admin, created_at) VALUES(?, ?, ?, ?, ?, ?)', login, name, email, hash, admin ? 1 : 0, now).lastInsertRowid;
        if (!admin) {
          const home = newSystemFolder(db.ids.roots.personal, login, cfg.personalQuota);
          insertAcl(home, { type: 'user', id: uid, level: MANAGE });
        }
        if (role === 'manager') db.run('INSERT INTO members(group_id, user_id) VALUES(?, ?)', db.ids.managers, uid);
        return uid;
      }),
      'This login is already taken.',
    );
    audit(c, 'admin', { admin: 'ALERT created admin account', manager: 'ALERT created account with the Manager role', employee: 'created account' }[role], `${name} (${login})`);
    return { id, password };
  });

  // One email, one account: an address IT records for someone also stops a second account through an invite link
  // (that person gets a reminder of their login instead), and lets them sign in with it.
  function emailArg(v) {
    if (v == null || (typeof v === 'string' && !v.trim())) return null;
    const email = typeof v === 'string' ? v.trim().toLowerCase() : '';
    if (email.length > 254 || !EMAIL_RE.test(email)) fail(400, 'Enter a valid email address (letters, digits, dots, dashes), or leave it empty.');
    return email;
  }
  function emailFree(email, exceptId = 0) {
    const other = db.get('SELECT login FROM users WHERE email = ? AND id != ?', email, exceptId);
    if (other) fail(409, `This email already belongs to the account "${other.login}". One email can have only one account.`);
  }

  add('PATCH', '/api/admin/users/:id', 'admin', async c => {
    const u = db.get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', int(c.params.id));
    if (!u) fail(404, 'Account not found.');
    const b = await body(c);
    const who = `${u.name} (${u.login})`;
    if (b.role !== undefined) {
      if (!['employee', 'manager'].includes(b.role)) fail(400, 'The role can be Employee or Manager.');
      if (u.is_admin) fail(400, 'IT admin accounts cannot open files, so their role stays IT admin. Create an employee account for this person instead.');
      const was = isManager(u);
      if (b.role === 'manager' && !was) {
        db.run('INSERT INTO members(group_id, user_id) VALUES(?, ?)', db.ids.managers, u.id);
        audit(c, 'admin', 'ALERT role changed to Manager', who);
      } else if (b.role === 'employee' && was) {
        db.run('DELETE FROM members WHERE group_id = ? AND user_id = ?', db.ids.managers, u.id);
        audit(c, 'admin', 'Manager role removed', who);
      }
    }
    const out = { ok: true };
    // Resetting someone with access to protected folders would let IT sign in as them: flag it for Managers.
    const flag = acl.sensitive(u) ? 'ALERT ' : '';
    if (typeof b.name === 'string') {
      const name = str(b.name, 80) || fail(400, 'Enter the full name.');
      db.run('UPDATE users SET name = ? WHERE id = ?', name, u.id);
      audit(c, 'admin', `renamed account to ${name}`, who);
    }
    if (b.email !== undefined) {
      const email = emailArg(b.email);
      if (email !== u.email) {
        db.tx(() => {
          if (email) emailFree(email, u.id);
          db.run('UPDATE users SET email = ? WHERE id = ?', email, u.id);
        });
        audit(c, 'admin', email ? `email set to ${email}` : 'email removed', who);
      }
    }
    if (typeof b.disabled === 'boolean') {
      if (u.id === c.user.id) fail(400, 'You cannot block your own account.');
      db.run('UPDATE users SET disabled = ? WHERE id = ?', b.disabled ? 1 : 0, u.id);
      if (b.disabled) db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
      audit(c, 'admin', b.disabled ? 'blocked account (all devices signed out)' : 'unblocked account', who);
    }
    if (b.reset_password === true) {
      out.password = A.tempPassword();
      db.run('UPDATE users SET pass = ?, must_change = 1 WHERE id = ?', await A.hashPassword(out.password), u.id);
      db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
      audit(c, 'admin', `${flag}reset password`, who);
    }
    return out;
  });

  // Delete an account for good. The row stays as a tombstone (renamed login, no password, blocked) so that
  // "uploaded by" and the activity log keep showing who it was; everything that gave it access is removed.
  add('DELETE', '/api/admin/users/:id', 'admin', c => {
    const u = db.get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', int(c.params.id));
    if (!u) fail(404, 'Account not found.');
    if (u.id === c.user.id) fail(400, 'You cannot delete your own account.');
    const home = db.get('SELECT id FROM nodes WHERE parent_id = ? AND name = ? AND deleted_at IS NULL', db.ids.roots.personal, u.login);
    const now = Date.now();
    db.tx(() => {
      db.run(`UPDATE users SET deleted_at = ?, disabled = 1, login = ?, email = NULL, pass = '!', totp = NULL, totp_pending = NULL WHERE id = ?`, now, `${u.login}~deleted-${u.id}`, u.id);
      db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
      db.run('DELETE FROM members WHERE user_id = ?', u.id);
      db.run('DELETE FROM acl WHERE user_id = ?', u.id);
      db.run('UPDATE shares SET revoked = 1 WHERE created_by = ?', u.id);
      if (home) db.run('UPDATE nodes SET deleted_at = ?, deleted_by = ? WHERE id = ?', now, c.user.id, home.id); // erased with the trash after 30 days
      db.run('UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', now, u.id);
    });
    for (const d of db.all('SELECT id FROM devices WHERE user_id = ?', u.id)) dropDevice(d.id);
    audit(c, 'admin', `ALERT deleted account${home ? '; personal folder goes to trash and is erased after 30 days' : ''}`, `${u.name} (${u.login})`);
  });

  add('GET', '/api/admin/groups', 'admin', () => {
    const groups = db.all('SELECT id, name, kind FROM groups ORDER BY kind, name');
    const members = db.all('SELECT m.group_id, u.id, u.name, u.login FROM members m JOIN users u ON u.id = m.user_id ORDER BY u.name');
    return groups.map(g => ({ ...g, members: members.filter(m => m.group_id === g.id).map(({ group_id, ...m }) => m) }));
  });

  add('POST', '/api/admin/groups', 'admin', async c => {
    const name = str((await body(c)).name, 60) || fail(400, 'Enter a group name.');
    const id = unique(() => db.run(`INSERT INTO groups(name, kind) VALUES(?, 'team')`, name).lastInsertRowid, 'A group with this name already exists.');
    audit(c, 'admin', 'created group', name);
    return { id };
  });

  add('PUT', '/api/admin/groups/:id/members', 'admin', async c => {
    const g = db.get('SELECT * FROM groups WHERE id = ?', int(c.params.id));
    if (!g) fail(404, 'Group not found.');
    if (g.kind === 'everyone') fail(400, 'Everyone always includes all employees.');
    const ids = (await body(c)).user_ids;
    if (!Array.isArray(ids) || ids.length > 5000) fail(400, 'Invalid member list.');
    const want = [...new Set(ids.map(Number))];
    for (const id of want) if (!db.get('SELECT 1 FROM users WHERE id = ? AND is_admin = 0 AND deleted_at IS NULL', id)) fail(400, 'Admin accounts cannot be group members.');
    const had = db.all('SELECT user_id FROM members WHERE group_id = ?', g.id).map(r => r.user_id);
    const nameOf = id => db.get('SELECT name FROM users WHERE id = ?', id).name;
    const added = want.filter(id => !had.includes(id)).map(nameOf);
    const removed = had.filter(id => !want.includes(id)).map(nameOf);
    db.tx(() => {
      db.run('DELETE FROM members WHERE group_id = ?', g.id);
      for (const id of want) db.run('INSERT INTO members(group_id, user_id) VALUES(?, ?)', g.id, id);
    });
    if (added.length || removed.length)
      audit(c, 'admin', `${g.kind === 'managers' && added.length ? 'ALERT ' : ''}group members changed${added.length ? `; added: ${added.join(', ')}` : ''}${removed.length ? `; removed: ${removed.join(', ')}` : ''}`, g.name);
  });

  add('GET', '/api/admin/folders', 'admin', () => {
    const rows = db.all(
      'SELECT id, parent_id, name, area, quota FROM nodes WHERE system = 1 AND deleted_at IS NULL AND (parent_id IS NULL OR parent_id != ?) ORDER BY parent_id IS NOT NULL, name COLLATE NOCASE',
      db.ids.roots.personal,
    );
    return rows.map(r => ({
      ...r,
      used: r.quota != null ? usage(r.id) : null,
      access: describeAcl(r.id),
      archivable: r.parent_id === db.ids.roots.projects,
    }));
  });

  add('POST', '/api/admin/departments', 'admin', async c => {
    const b = await body(c);
    const name = cleanName(b.name);
    const head = activeUser(b.head_id);
    const quota = quotaArg(b.quota_gb);
    db.tx(() => {
      const gid = unique(() => db.run(`INSERT INTO groups(name, kind) VALUES(?, 'department')`, name).lastInsertRowid, 'A group with this name already exists.');
      db.run('INSERT INTO members(group_id, user_id) VALUES(?, ?)', gid, head.id);
      const dept = newSystemFolder(db.ids.roots.departments, name, quota);
      insertAcl(dept, { type: 'group', id: gid, level: EDIT });
      insertAcl(dept, { type: 'user', id: head.id, level: MANAGE });
      const arch = newSystemFolder(db.ids.roots.archive, name, null);
      insertAcl(arch, { type: 'group', id: gid, level: READ });
      insertAcl(arch, { type: 'user', id: head.id, level: READ });
    });
    audit(c, 'admin', `created department, head: ${head.name}`, name);
  });

  add('POST', '/api/admin/projects', 'admin', async c => {
    const b = await body(c);
    const name = cleanName(b.name);
    const lead = activeUser(b.lead_id);
    const quota = quotaArg(b.quota_gb);
    db.tx(() => {
      const gid = unique(() => db.run(`INSERT INTO groups(name, kind) VALUES(?, 'project')`, `${name} team`).lastInsertRowid, 'A group with this name already exists.');
      db.run('INSERT INTO members(group_id, user_id) VALUES(?, ?)', gid, lead.id);
      const p = newSystemFolder(db.ids.roots.projects, name, quota);
      insertAcl(p, { type: 'group', id: gid, level: EDIT });
      insertAcl(p, { type: 'user', id: lead.id, level: MANAGE });
    });
    audit(c, 'admin', `created project, lead: ${lead.name}`, name);
  });

  add('POST', '/api/admin/confidential', 'admin', async c => {
    const b = await body(c);
    const name = cleanName(b.name);
    const managers = Number(b.managers || 0);
    if (![0, READ, EDIT].includes(managers)) fail(400, 'Invalid Managers access.');
    const owner = b.owner_id ? activeUser(b.owner_id) : null; // owner = Manage: shares the folder with named people
    db.tx(() => {
      const id = newSystemFolder(db.ids.roots.confidential, name, quotaArg(b.quota_gb));
      if (managers) insertAcl(id, { type: 'group', id: db.ids.managers, level: managers });
      if (owner) insertAcl(id, { type: 'user', id: owner.id, level: MANAGE });
    });
    audit(c, 'admin', `${owner ? 'ALERT ' : ''}created confidential folder, owner: ${owner?.name || 'nobody'}, Managers: ${LEVELS[managers] || 'no access'}`, name);
  });

  add('PATCH', '/api/admin/folders/:id', 'admin', async c => {
    const n = db.get('SELECT * FROM nodes WHERE id = ? AND system = 1', int(c.params.id));
    if (!n) fail(404, 'Folder not found.');
    const quota = quotaArg((await body(c)).quota_gb);
    db.run('UPDATE nodes SET quota = ? WHERE id = ?', quota, n.id);
    audit(c, 'admin', `quota set to ${quota ? fmtBytes(quota) : 'unlimited'}`, n.name);
  });

  add('POST', '/api/admin/folders/:id/archive', 'admin', c => {
    const n = db.get('SELECT * FROM nodes WHERE id = ? AND system = 1 AND parent_id = ?', int(c.params.id), db.ids.roots.projects);
    if (!n) fail(404, 'Only project folders can be archived.');
    db.tx(() => {
      unique(() => db.run('UPDATE nodes SET parent_id = ? WHERE id = ?', db.ids.roots.archive, n.id));
      db.run(`${SUBTREE} UPDATE acl SET level = 1 WHERE node_id IN (SELECT id FROM t)`, n.id);
      db.run(`${SUBTREE} UPDATE shares SET revoked = 1 WHERE node_id IN (SELECT id FROM t)`, n.id);
    });
    audit(c, 'admin', 'archived project: moved to 06 Archive, everyone set to Read, external links turned off', n.name);
  });

  add('GET', '/api/audit', 'audit', c => {
    const cats = c.user.is_admin ? ['auth', 'admin', 'acl'] : ['auth', 'admin', 'acl', 'file', 'share'];
    const want = c.query.get('cat');
    const alerts = want === 'alerts';
    const list = want && !alerts ? cats.filter(x => x === want) : cats;
    const before = Number(c.query.get('before')) || Number.MAX_SAFE_INTEGER;
    // Alerts are rare among many rows: their own partial index (audit_alerts, same GLOB term) finds them directly.
    const rows = db.all(
      `SELECT a.id, a.ts, a.cat, a.action, a.target, a.ip, a.node_id, u.name AS actor, u.login AS actor_login
       FROM audit a LEFT JOIN users u ON u.id = a.actor
       WHERE a.id < ? AND a.cat IN (SELECT value FROM json_each(?))${alerts ? " AND a.action GLOB 'ALERT*'" : ''}
       ORDER BY a.id DESC LIMIT 200`,
      before,
      JSON.stringify(list),
    );
    const out = [];
    const res = acl.resolver(c.user.is_admin ? acl.NOBODY : c.ctx);
    for (const { node_id, ...row } of rows) {
      if (node_id != null) {
        if (c.user.is_admin) {
          // IT sees where access changed, never the names people gave their own folders and files.
          const x = res(node_id, { trashed: true });
          if (!x?.node.system) row.target = x ? `${pathOf(x.chain.slice(0, x.chain.findLastIndex(n => n.system) + 1))} / …` : '(deleted item)';
        } else if (!res(node_id, { trashed: true })?.level) continue; // rows about files this Manager cannot open
      }
      out.push(row);
    }
    return { rows: out, next: rows.length === 200 ? rows.at(-1).id : null };
  });

  // =====================================================================
  // HTTP plumbing
  // =====================================================================
  const etag = buf => `"${crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 16)}"`;
  function staticFile(key) {
    if (!staticCache.has(key)) {
      let buf = null;
      try {
        buf = fs.readFileSync(path.join(ROOT, key));
      } catch {}
      staticCache.set(key, buf && { buf, tag: etag(buf) });
    }
    return staticCache.get(key);
  }
  const version = a => staticFile(STATIC[a]).tag.slice(1, -1);
  // index.html with its scripts and styles linked by version, in each encoding (made once).
  function startPage() {
    if (!staticCache.has('#page')) {
      let html = staticFile(STATIC['/']).buf.toString();
      for (const a of VERSIONED) html = html.replace(`"${a}"`, `"${a}?v=${version(a)}"`);
      const buf = Buffer.from(html), tag = etag(buf);
      staticCache.set('#page', { '': { buf, tag }, br: { buf: zlib.brotliCompressSync(buf), tag: tag.replace(/"$/, '-br"') }, gzip: { buf: zlib.gzipSync(buf), tag: tag.replace(/"$/, '-gz"') } });
    }
    return staticCache.get('#page');
  }

  function serveStatic(req, res, p) {
    const dl = /^\/downloads\/([\w.-]+)$/.exec(p)?.[1];
    if (dl && !dl.startsWith('.')) {
      const file = path.join(ROOT, 'downloads', dl);
      const st = fs.statSync(file, { throwIfNoEntry: false });
      // Installers come from the download server when one is set; ?v= changes with each build, so no cache serves
      // an old one. The copy there is uploaded with every release.
      if (st?.isFile() && cfg.downloadsUrl && Object.values(DOWNLOADS).includes(dl)) {
        res.writeHead(302, { Location: `${cfg.downloadsUrl}/${dl}?v=${st.size}-${Math.floor(st.mtimeMs)}`, 'Cache-Control': 'no-cache' });
        return res.end();
      }
      if (st?.isFile()) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Content-Disposition': `attachment; filename="${dl}"`, 'Cache-Control': 'no-cache' });
        if (req.method === 'HEAD') return res.end();
        return pipeline(fs.createReadStream(file), res).catch(() => {});
      }
    }
    const vendor = /^\/vendor\/embedpdf-2\.15\.1\/([\w-]+\.(?:js|wasm))$/.exec(p)?.[1];
    const rel = STATIC[p] ?? (/^\/(s|join)\/[\w-]{10,64}$/.test(p) ? STATIC['/'] : null) ??
      (vendor && fs.existsSync(path.join(ROOT, VIEWER_DIR, vendor)) ? `${VIEWER_DIR}/${vendor}` : null);
    if (rel === STATIC['/viewer.html']) res.setHeader('Content-Security-Policy', VIEWER_CSP);
    if (!rel) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    // Brotli or gzip copies made when the image was built (scripts/precompress.mjs), if the browser takes them.
    const accepts = String(req.headers['accept-encoding'] || '');
    const enc = /\bbr\b(?!;q=0(\.0*)?\b)/.test(accepts) ? 'br' : /\bgzip\b(?!;q=0(\.0*)?\b)/.test(accepts) ? 'gzip' : null;
    const load = suffix => staticFile(rel + suffix);
    // The page asks for its scripts and styles by version (?v=), so those never need checking again: a repeat visit
    // downloads nothing but the page itself, instead of asking about each file.
    const page = rel === STATIC['/'] && startPage();
    const packed = enc && (page ? page[enc] : load(enc === 'br' ? '.br' : '.gz'));
    const file = packed || (page ? page[''] : load(''));
    const pinned = VERSIONED.includes(p) && new URL(req.url, 'http://x').searchParams.get('v') === version(p);
    const headers = {
      'Content-Type': TYPES[path.extname(rel)],
      'Cache-Control': pinned || rel.endsWith('.woff2') || rel.startsWith('public/vendor/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      ETag: file.tag,
      Vary: 'Accept-Encoding',
    };
    if (packed) headers['Content-Encoding'] = enc;
    // no-cache files are checked, not downloaded again, when unchanged.
    if (req.headers['if-none-match'] === file.tag) {
      res.writeHead(304, headers);
      return res.end();
    }
    headers['Content-Length'] = file.buf.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : file.buf);
  }

  function checkOrigin(req) {
    if (req.headers['x-requested-with'] !== 'fetch') fail(403, 'Request blocked: missing X-Requested-With header.');
    const o = req.headers.origin;
    if (!o || o === cfg.publicUrl.origin) return;
    let host = null;
    try {
      host = new URL(o).host;
    } catch {}
    if (host !== req.headers.host) fail(403, 'Request blocked: it came from another site.');
  }

  async function handle(req, res) {
    const c = { req, res, ip: clientIp(req), user: null };
    let url;
    try {
      res.setHeader('Content-Security-Policy', csp);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      if (cfg.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      if (!cfg.allowedHosts.includes(String(req.headers.host || '').toLowerCase())) fail(421, 'Unknown host. Open the storage by its address.');
      url = new URL(req.url, 'http://localhost');
      c.query = url.searchParams;
      // The network drive: its own methods and Basic auth with a computer's token (no cookies, so no CSRF).
      if (url.pathname === '/dav' || url.pathname.startsWith('/dav/')) return await dav(c, url);
      if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
      let route, m;
      for (route of routes) if (route.method === req.method && (m = route.re.exec(url.pathname))) break;
      if (!m) fail(404, 'Not found.');
      // WOPI calls come from the editor server with a token and no cookies, so there is no CSRF to stop.
      if (req.method !== 'GET' && route.mode !== 'wopi' && route.mode !== 'agent') checkOrigin(req);
      c.params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      if (req.method !== 'GET' && /^application\/json\b/i.test(req.headers['content-type'] || '')) await body(c);
      authenticate(c, route.mode);
      const out = await route.fn(c);
      if (!res.headersSent) json(res, 200, out === undefined ? { ok: true } : out);
    } catch (e) {
      const status = Number.isInteger(e.status) ? e.status : e instanceof URIError ? 400 : 500;
      // Expected refusals (busy, disk full, mail down) get one line; only real bugs get a stack trace.
      if (status >= 500) console.error(new Date().toISOString(), req.method, url?.pathname ?? '?', Number.isInteger(e.status) ? `${status} ${e.message}` : e);
      if (res.headersSent) return res.destroy();
      if (!req.complete) res.setHeader('Connection', 'close');
      json(res, status, { error: status < 500 ? e.message : 'Something went wrong on the server. Try again.', code: e.code });
    }
  }

  async function housekeeping() {
    const now = Date.now();
    for (const { id } of db.all('SELECT id FROM nodes WHERE deleted_at IS NOT NULL AND deleted_at < ?', now - TRASH_DAYS * DAY)) await purge(id);
    for (const [k, p] of pending) if (p.until < now) pending.delete(k);
    joinIp.sweep();
    joinMail.sweep();
    db.run('DELETE FROM sessions WHERE seen_at < ? OR created_at < ?', now - SESSION_IDLE, now - SESSION_MAX);
    db.run('DELETE FROM pair_codes WHERE expires_at < ?', now);
    db.run('DELETE FROM device_queue WHERE done_at < ?', now - 30 * DAY);
    db.run('DELETE FROM changes WHERE at < ?', now - 30 * DAY);
    userThrottle.sweep();
    loginThrottle.sweep();
    ipThrottle.sweep();
    for (const [who, e] of downloads) if (now - e.since > 3600e3) downloads.delete(who);
    for (const [id, run] of editRuns) if (now - run.since > 30 * 60e3) editRuns.delete(id);
    for (const [id, w] of pdfWork) if (now - w.at > WOPI_TTL) pdfWork.delete(id); // editing sessions end by then
    for (const [k, v] of pdfViews) if (now - v.at > 6 * 3600e3) pdfViews.delete(k);
    // Unfinished uploads nobody continued for 3 days, and leftover files with no upload behind them.
    for (const up of db.all('SELECT id FROM uploads WHERE expires_at < ?', now)) {
      db.run('DELETE FROM uploads WHERE id = ?', up.id);
      fs.rmSync(tusFile(up.id), { force: true });
    }
    for (const f of fs.readdirSync(TUS_DIR)) {
      if (db.get('SELECT 1 FROM uploads WHERE id = ?', f)) continue;
      const st = fs.statSync(path.join(TUS_DIR, f), { throwIfNoEntry: false });
      if (st && now - st.mtimeMs > DAY) fs.rmSync(path.join(TUS_DIR, f), { force: true });
    }
    await store.sweepTmp(DAY);
  }

  return { handle, upgrade, housekeeping, db };
}

// Milliseconds from `now` until the next local HH:MM (a full day if it is exactly HH:MM now).
export function msUntil(hhmm, now = new Date()) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = new Date(now);
  t.setHours(h, m, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t - now;
}

// Nightly backup + verify (spec 8). Runs as a child process so copying large files never blocks the server;
// the outcome goes to the activity log, where IT sees it every morning.
function scheduleBackups(cfg, app) {
  if (!cfg.backupDir) return console.log('BACKUP_DIR is not set: nightly backups are OFF.');
  const run = args =>
    new Promise(resolve => {
      const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'scripts', 'backup.mjs'), ...args], { env: process.env });
      let out = '';
      p.stdout.on('data', d => (out += d));
      p.stderr.on('data', d => (out += d));
      p.on('error', e => resolve({ ok: false, out: e.message }));
      p.on('close', code => resolve({ ok: code === 0, out: out.trim() }));
    });
  const tick = async () => {
    const b = await run([]);
    const v = b.ok ? await run(['verify']) : null;
    const ok = b.ok && v.ok;
    console.log(b.out + (v ? `\n${v.out}` : ''));
    app.db.audit('admin', null, ok ? 'nightly backup done and verified' : 'nightly backup FAILED', (ok ? b.out : v?.out || b.out).slice(-600));
    setTimeout(tick, msUntil(cfg.backupTime));
  };
  setTimeout(tick, msUntil(cfg.backupTime));
  console.log(`Nightly backup at ${cfg.backupTime} (server time) to ${cfg.backupDir}`);
}

function start() {
  const cfg = loadConfig();
  const app = createApp(cfg);
  const server =
    cfg.tlsCert && cfg.tlsKey
      ? https.createServer({ cert: fs.readFileSync(cfg.tlsCert), key: fs.readFileSync(cfg.tlsKey), minVersion: 'TLSv1.2' }, app.handle)
      : http.createServer(app.handle);
  server.on('upgrade', app.upgrade); // auto-save agents' WebSocket
  server.headersTimeout = 30e3;
  server.requestTimeout = 0; // large uploads can take hours; idle sockets are cut by setTimeout below
  server.keepAliveTimeout = 10e3;
  server.setTimeout(5 * 60e3);
  server.listen(cfg.port, cfg.host, () => {
    const proto = cfg.tlsCert ? 'https' : 'http';
    console.log(`${cfg.appName} is running on ${proto}://${cfg.host}:${cfg.port}  (public address: ${cfg.publicUrl.origin})`);
    console.log(`Data folder: ${cfg.dataDir}`);
    if (!app.db.get('SELECT 1 FROM users WHERE is_admin = 1')) console.log('No admin account yet. Create one with:  npm run admin');
  });
  // The editor's server-to-server calls. Bound to the container's own network address, not 127.0.0.1, so Tailscale's
  // userspace forwarding cannot reach it from the tailnet; only WOPI routes are served here.
  if (cfg.wopiPort) {
    const ip = Object.values(os.networkInterfaces()).flat().find(a => a.family === 'IPv4' && !a.internal)?.address;
    if (!ip) console.error('WOPI_PORT is set but there is no network interface to listen on: the editor cannot reach Files.');
    else {
      const wopi = http.createServer((req, res) => (req.url.startsWith('/api/wopi/') ? app.handle(req, res) : res.writeHead(404).end()));
      wopi.headersTimeout = 30e3;
      wopi.requestTimeout = 0;
      wopi.setTimeout(5 * 60e3);
      wopi.listen(cfg.wopiPort, ip, () => console.log(`Editor (WOPI) calls are served on http://${ip}:${cfg.wopiPort} as ${cfg.wopiUrl}`));
    }
  }
  const tick = () => app.housekeeping().catch(e => console.error('housekeeping failed', e));
  tick();
  setInterval(tick, 6 * 3600e3).unref();
  scheduleBackups(cfg, app);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) start();
