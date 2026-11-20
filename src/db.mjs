import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const READ = 1, EDIT = 2, MANAGE = 3;
export const AREAS = ['general', 'departments', 'projects', 'confidential', 'management', 'archive', 'personal'];

// Top-level folders from the spec (section 3). Only Managers get in by default; everyone else waits
// until a Manager or IT gives access (to a whole section, a folder or a single file).
const TOP = [
  ['01 General', 'general', [['managers', EDIT]]],
  ['02 Departments', 'departments', [['managers', EDIT]]],
  ['03 Projects', 'projects', [['managers', EDIT]]],
  ['04 Confidential', 'confidential', []],
  ['05 Management', 'management', [['managers', EDIT]]],
  ['06 Archive', 'archive', [['managers', READ]]],
  ['Personal', 'personal', []],
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  pass TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  must_change INTEGER NOT NULL DEFAULT 1,
  totp TEXT,
  totp_pending TEXT,
  totp_last INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  no2fa INTEGER NOT NULL DEFAULT 0,
  email TEXT,
  enroll_until INTEGER);

-- Sign-up links IT sends out; only a hash of the link token is stored.
CREATE TABLE IF NOT EXISTS invites(
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  domain TEXT,
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS groups(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind TEXT NOT NULL CHECK(kind IN ('everyone', 'managers', 'department', 'project', 'team')));

CREATE TABLE IF NOT EXISTS members(
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(group_id, user_id));

-- area is set on top-level rows only; everything below inherits it from its root.
CREATE TABLE IF NOT EXISTS nodes(
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_dir INTEGER NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  blob TEXT,
  system INTEGER NOT NULL DEFAULT 0,
  inherit INTEGER NOT NULL DEFAULT 1,
  area TEXT,
  quota INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  deleted_at INTEGER,
  deleted_by INTEGER REFERENCES users(id));
CREATE UNIQUE INDEX IF NOT EXISTS nodes_live_name ON nodes(parent_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS nodes_trash ON nodes(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS acl(
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 3),
  CHECK((user_id IS NULL) <> (group_id IS NULL)));
CREATE UNIQUE INDEX IF NOT EXISTS acl_node_user ON acl(node_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS acl_node_group ON acl(node_id, group_id) WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS acl_user ON acl(user_id);
CREATE INDEX IF NOT EXISTS acl_group ON acl(group_id);

CREATE TABLE IF NOT EXISTS versions(
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  blob TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id));
CREATE INDEX IF NOT EXISTS versions_node ON versions(node_id);

CREATE TABLE IF NOT EXISTS shares(
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  pass TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mfa INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  ip TEXT,
  ua TEXT);

-- Computers running the auto-save agent. Only a hash of each agent's token is stored.
CREATE TABLE IF NOT EXISTS devices(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  os TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  seen_at INTEGER,
  revoked_at INTEGER);
CREATE INDEX IF NOT EXISTS devices_user ON devices(user_id);

-- One-time codes that link an agent to the account that asked for one (hash only, valid 10 minutes).
CREATE TABLE IF NOT EXISTS pair_codes(
  code TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL);

-- Files waiting to be saved on a computer: a snapshot of what was sent, with the path below the save folder.
-- result: 'saved' or 'skipped' (gone, or no longer allowed) once handled.
CREATE TABLE IF NOT EXISTS device_queue(
  id INTEGER PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  batch TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  done_at INTEGER,
  result TEXT);
CREATE INDEX IF NOT EXISTS device_queue_pending ON device_queue(device_id) WHERE done_at IS NULL;
CREATE INDEX IF NOT EXISTS device_queue_batch ON device_queue(batch);

-- Resumable uploads in progress (tus). The bytes so far are in data/uploads/<id>; kind 'partial' is one of the
-- parts of a large file sent in parallel, joined when all are complete.
CREATE TABLE IF NOT EXISTS uploads(
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('single', 'partial')),
  folder_id INTEGER,
  name TEXT,
  size INTEGER NOT NULL,
  offset INTEGER NOT NULL DEFAULT 0,
  meta TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS uploads_user ON uploads(user_id);

CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  cat TEXT NOT NULL,
  actor INTEGER,
  action TEXT NOT NULL,
  target TEXT,
  ip TEXT,
  node_id INTEGER);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

-- What changed, in order (a file or folder added, edited, renamed, moved, trashed, erased, or its access changed):
-- the Mac's File Provider asks "what changed since N" and gets each item as it is now, or "gone" for this person.
-- Written by the database itself, so no change is missed whoever makes it; rows older than 30 days are dropped.
CREATE TABLE IF NOT EXISTS changes(seq INTEGER PRIMARY KEY, node_id INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS changes_at ON changes(at);
CREATE TRIGGER IF NOT EXISTS changes_node_add AFTER INSERT ON nodes BEGIN INSERT INTO changes(node_id, at) VALUES(NEW.id, CAST(unixepoch('subsec') * 1000 AS INTEGER)); END;
CREATE TRIGGER IF NOT EXISTS changes_node_set AFTER UPDATE ON nodes BEGIN INSERT INTO changes(node_id, at) VALUES(NEW.id, CAST(unixepoch('subsec') * 1000 AS INTEGER)); END;
CREATE TRIGGER IF NOT EXISTS changes_node_del AFTER DELETE ON nodes BEGIN INSERT INTO changes(node_id, at) VALUES(OLD.id, CAST(unixepoch('subsec') * 1000 AS INTEGER)); END;
CREATE TRIGGER IF NOT EXISTS changes_acl_add AFTER INSERT ON acl BEGIN INSERT INTO changes(node_id, at) VALUES(NEW.node_id, CAST(unixepoch('subsec') * 1000 AS INTEGER)); END;
CREATE TRIGGER IF NOT EXISTS changes_acl_set AFTER UPDATE ON acl BEGIN INSERT INTO changes(node_id, at) VALUES(NEW.node_id, CAST(unixepoch('subsec') * 1000 AS INTEGER)); END;
CREATE TRIGGER IF NOT EXISTS changes_acl_del AFTER DELETE ON acl BEGIN INSERT INTO changes(node_id, at) VALUES(OLD.node_id, CAST(unixepoch('subsec') * 1000 AS INTEGER)); END;
`;

function wrap(raw) {
  const cache = new Map();
  const st = sql => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = raw.prepare(sql)));
    return s;
  };
  const db = {
    raw,
    get: (sql, ...p) => st(sql).get(...p),
    all: (sql, ...p) => st(sql).all(...p),
    run: (sql, ...p) => st(sql).run(...p),
    tx(fn) {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
    // node_id lets the activity log hide rows about files a viewer cannot open.
    audit: (cat, actor, action, target = null, ip = null, nodeId = null) =>
      db.run('INSERT INTO audit(ts, cat, actor, action, target, ip, node_id) VALUES(?, ?, ?, ?, ?, ?, ?)', Date.now(), cat, actor ?? null, action, target ?? null, ip ?? null, nodeId ?? null),
    // fn(folderIds) runs after any change to the tree made through this connection: a file or folder added, changed,
    // renamed, moved, trashed, restored or erased (ids of the folders it was in, before and after). TEMP triggers
    // live only on this connection, so other connections (backup, admin scripts) never call the missing function.
    onTreeChange(fn) {
      const touched = new Set();
      let queued = false;
      raw.function('cf_touched', (a, b) => {
        if (a != null) touched.add(a);
        if (b != null) touched.add(b);
        if (!queued) {
          queued = true;
          setImmediate(() => {
            queued = false;
            const ids = [...touched];
            touched.clear();
            fn(ids);
          });
        }
        return null;
      });
      raw.exec(`CREATE TEMP TRIGGER cf_nodes_insert AFTER INSERT ON main.nodes BEGIN SELECT cf_touched(NEW.parent_id, NULL); END;
        CREATE TEMP TRIGGER cf_nodes_update AFTER UPDATE ON main.nodes BEGIN SELECT cf_touched(OLD.parent_id, NEW.parent_id); END;
        CREATE TEMP TRIGGER cf_nodes_delete AFTER DELETE ON main.nodes BEGIN SELECT cf_touched(OLD.parent_id, NULL); END;`);
    },
  };
  return db;
}

export function openDb(dataDir) {
  for (const d of ['blobs', 'tmp']) fs.mkdirSync(path.join(dataDir, d), { recursive: true });
  const raw = new DatabaseSync(path.join(dataDir, 'app.db'));
  // synchronous = NORMAL with WAL: a commit no longer waits for the disk (about 10 ms per commit on the NAS drives,
  // and node:sqlite blocks the whole server meanwhile). The database cannot be corrupted this way; a power cut can
  // only lose the last moments of commits, leaving at worst a stored file nobody points to.
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  // Reads from memory: a 32 MB page cache (the default is 2 MB) and the file mapped, so a busy tree and the activity
  // log are not read from disk again and again; temporary sorts stay in memory.
  raw.exec('PRAGMA cache_size = -32768; PRAGMA mmap_size = 268435456; PRAGMA temp_store = MEMORY;');
  raw.exec(SCHEMA);
  raw.exec(`CREATE INDEX IF NOT EXISTS audit_alerts ON audit(id) WHERE action GLOB 'ALERT*'`);
  if (!raw.prepare(`SELECT 1 FROM pragma_table_info('audit') WHERE name = 'node_id'`).get()) raw.exec('ALTER TABLE audit ADD COLUMN node_id INTEGER');
  // Deleted accounts stay as tombstones so file history and the activity log keep their names.
  if (!raw.prepare(`SELECT 1 FROM pragma_table_info('users') WHERE name = 'deleted_at'`).get()) raw.exec('ALTER TABLE users ADD COLUMN deleted_at INTEGER');
  // Test accounts IT exempts from 2FA from the server console only; no API can set it.
  if (!raw.prepare(`SELECT 1 FROM pragma_table_info('users') WHERE name = 'no2fa'`).get()) raw.exec('ALTER TABLE users ADD COLUMN no2fa INTEGER NOT NULL DEFAULT 0');
  // Email of people who signed up by invite link (stored lowercase); they may sign in with it instead of the login.
  if (!raw.prepare(`SELECT 1 FROM pragma_table_info('users') WHERE name = 'email'`).get()) raw.exec('ALTER TABLE users ADD COLUMN email TEXT');
  raw.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(email) WHERE email IS NOT NULL');
  // Until when this account may set up 2FA for the first time from the internet (fresh sign-up).
  if (!raw.prepare(`SELECT 1 FROM pragma_table_info('users') WHERE name = 'enroll_until'`).get()) {
    raw.exec('ALTER TABLE users ADD COLUMN enroll_until INTEGER');
    // People who signed up before this rule existed and have no 2FA yet get the same 24 hours from now.
    raw.prepare('UPDATE users SET enroll_until = ? WHERE email IS NOT NULL AND totp IS NULL').run(Date.now() + 864e5);
  }
  const db = wrap(raw);
  if (!db.get('SELECT 1 FROM groups LIMIT 1')) {
    db.tx(() => {
      const g = {
        everyone: db.run(`INSERT INTO groups(name, kind) VALUES('Everyone', 'everyone')`).lastInsertRowid,
        managers: db.run(`INSERT INTO groups(name, kind) VALUES('Managers', 'managers')`).lastInsertRowid,
      };
      const now = Date.now();
      for (const [name, area, grants] of TOP) {
        const id = db.run('INSERT INTO nodes(name, is_dir, system, area, created_at, updated_at) VALUES(?, 1, 1, ?, ?, ?)', name, area, now, now).lastInsertRowid;
        for (const [who, level] of grants) db.run('INSERT INTO acl(node_id, group_id, level) VALUES(?, ?, ?)', id, g[who], level);
      }
    });
  }
  db.ids = {
    everyone: db.get(`SELECT id FROM groups WHERE kind = 'everyone'`).id,
    managers: db.get(`SELECT id FROM groups WHERE kind = 'managers'`).id,
    roots: Object.fromEntries(db.all('SELECT area, id FROM nodes WHERE parent_id IS NULL').map(r => [r.area, r.id])),
  };
  // v1: 01 General used to open to Everyone; now nobody sees it until a Manager or IT gives access. Runs once,
  // so an Everyone grant a Manager adds later stays.
  if (raw.prepare('PRAGMA user_version').get().user_version < 1) {
    db.run('DELETE FROM acl WHERE node_id = ? AND group_id = ?', db.ids.roots.general, db.ids.everyone);
    raw.exec('PRAGMA user_version = 1');
  }
  // v2: 2FA was removed (2026-11-18); the stored authenticator secrets are no longer needed, so they are wiped.
  if (raw.prepare('PRAGMA user_version').get().user_version < 2) {
    db.run('UPDATE users SET totp = NULL, totp_pending = NULL, totp_last = 0');
    raw.exec('PRAGMA user_version = 2');
  }
  // Owners manage (and so can share) their personal folder; older databases gave them Edit.
  db.run(
    'UPDATE acl SET level = 3 WHERE level = 2 AND node_id IN (SELECT n.id FROM nodes n JOIN users u ON u.login = n.name WHERE n.parent_id = ? AND u.id = acl.user_id)',
    db.ids.roots.personal,
  );
  return db;
}
