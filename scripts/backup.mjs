// Encrypted backup (spec section 8): a database snapshot plus every file it references, written to
// BACKUP_DIR with AES-256-GCM, one file at a time. The key (backup.key) stays in the data folder and is
// never written next to the backups, so a stolen backup copy is useless without it. Keep a copy of the key
// offline (password manager / safe): without it the backups cannot be restored.
//
//   npm run backup                                   make a backup now (the server also runs it nightly)
//   npm run backup -- verify                         decrypt the latest snapshot and check it
//   npm run backup -- key                            print the backup key to store offline
//   npm run backup -- restore <snapshot> <folder>    rebuild a data folder (key: data folder or BACKUP_KEY)
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.mjs';

// File layout: MAGIC(4) | IV(12) | ciphertext | GCM tag(16). CFB2 binds each file to its name (blob id, or
// snapshot file name) as GCM associated data, so encrypted files cannot be swapped or an old snapshot passed off
// as a newer one. CFB1 (no binding) is still read, so older backups restore.
const MAGIC = Buffer.from('CFB2');
const MAGIC_V1 = Buffer.from('CFB1');
const blobPath = (root, id) => path.join(root, 'blobs', id.slice(0, 2), id);
const snapshots = root => (fs.existsSync(path.join(root, 'db')) ? fs.readdirSync(path.join(root, 'db')).filter(f => /^db-.+\.sqlite\.enc$/.test(f)).sort() : []);
const manifestOf = snap => snap.replace(/\.sqlite\.enc$/, '.blobs');
const readManifest = snap => fs.readFileSync(manifestOf(snap), 'utf8').split('\n').filter(Boolean);

function referenced(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT blob FROM nodes WHERE blob IS NOT NULL UNION SELECT blob FROM versions').all().map(r => r.blob);
  } finally {
    db.close();
  }
}

export function loadKey(dataDir, { create = false } = {}) {
  if (process.env.BACKUP_KEY) {
    const k = Buffer.from(process.env.BACKUP_KEY, 'base64');
    if (k.length !== 32) throw new Error('BACKUP_KEY must be 32 bytes, base64-encoded.');
    return k;
  }
  const file = path.join(dataDir, 'backup.key');
  if (fs.existsSync(file)) return fs.readFileSync(file);
  if (!create) throw new Error(`Backup key not found at ${file}. Put the saved key there or set BACKUP_KEY.`);
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
  return key;
}

export async function encryptFile(src, dst, key, aad = path.basename(dst)) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const frame = new Transform({
    transform: (chunk, _enc, cb) => cb(null, chunk),
    flush(cb) {
      this.push(cipher.getAuthTag());
      cb();
    },
  });
  frame.push(Buffer.concat([MAGIC, iv]));
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  const part = `${dst}.part`;
  try {
    await pipeline(fs.createReadStream(src), cipher, frame, fs.createWriteStream(part, { mode: 0o600 }));
    await fsp.rename(part, dst);
  } catch (e) {
    await fsp.rm(part, { force: true });
    throw e;
  }
}

export async function decryptFile(src, dst, key, aad = path.basename(src)) {
  const size = (await fsp.stat(src)).size;
  const head = Buffer.alloc(16), tag = Buffer.alloc(16);
  const fh = await fsp.open(src, 'r');
  try {
    if (size >= 32) {
      await fh.read(head, 0, 16, 0);
      await fh.read(tag, 0, 16, size - 16);
    }
  } finally {
    await fh.close();
  }
  const v2 = head.subarray(0, 4).equals(MAGIC);
  if (size < 32 || !(v2 || head.subarray(0, 4).equals(MAGIC_V1))) throw new Error(`${src} is not an encrypted backup file.`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, head.subarray(4, 16));
  if (v2) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  const part = `${dst}.part`;
  try {
    const body = size > 32 ? fs.createReadStream(src, { start: 16, end: size - 17 }) : Readable.from([]);
    await pipeline(body, decipher, fs.createWriteStream(part, { mode: 0o600 }));
    await fsp.rename(part, dst);
  } catch {
    await fsp.rm(part, { force: true });
    throw new Error(`${src}: wrong backup key or damaged file.`);
  }
}

function isCurrent(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    return head.equals(MAGIC);
  } catch {
    return false;
  }
}

export async function backup(dataDir, dest, keepDays = 120) {
  const key = loadKey(dataDir, { create: true });
  await fsp.mkdir(path.join(dest, 'db'), { recursive: true });
  await fsp.mkdir(path.join(dataDir, 'tmp'), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snap = path.join(dest, 'db', `db-${stamp}.sqlite.enc`);
  const plain = path.join(dataDir, 'tmp', `snapshot-${stamp}.sqlite`); // plaintext never touches BACKUP_DIR
  const src = new DatabaseSync(path.join(dataDir, 'app.db'));
  try {
    src.prepare('VACUUM INTO ?').run(plain);
  } finally {
    src.close();
  }
  let ids;
  try {
    ids = referenced(plain);
    await encryptFile(plain, snap, key);
  } finally {
    await fsp.rm(plain, { force: true });
  }
  await fsp.writeFile(manifestOf(snap), ids.join('\n'));

  let copied = 0, missing = 0;
  for (const id of ids) {
    if (isCurrent(blobPath(dest, id))) continue; // copies in the old CFB1 format are made again, bound to their id
    try {
      await encryptFile(blobPath(dataDir, id), blobPath(dest, id), key);
      copied++;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      missing++; // deleted from trash while the backup ran
    }
  }

  const cutoff = Date.now() - keepDays * 864e5;
  for (const f of snapshots(dest).slice(0, -1)) {
    const p = path.join(dest, 'db', f);
    if ((await fsp.stat(p)).mtimeMs < cutoff) {
      await fsp.rm(p);
      await fsp.rm(manifestOf(p), { force: true });
    }
  }
  const keep = new Set(snapshots(dest).flatMap(f => readManifest(path.join(dest, 'db', f))));
  let pruned = 0;
  for (const sub of fs.existsSync(path.join(dest, 'blobs')) ? await fsp.readdir(path.join(dest, 'blobs')) : [])
    for (const name of await fsp.readdir(path.join(dest, 'blobs', sub)))
      if (!keep.has(name)) {
        await fsp.rm(path.join(dest, 'blobs', sub, name));
        pruned++;
      }
  return { snapshot: snap, copied, missing, pruned, snapshots: snapshots(dest).length };
}

export async function verify(dest, dataDir) {
  const list = snapshots(dest);
  if (!list.length) throw new Error(`No backups found in ${dest}`);
  const key = loadKey(dataDir);
  const file = path.join(dest, 'db', list.at(-1));
  const tmp = path.join(dataDir, 'tmp', `verify-${process.pid}-${Date.now()}`);
  let integrity, ids;
  try {
    await decryptFile(file, tmp, key);
    const db = new DatabaseSync(tmp, { readOnly: true });
    integrity = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
    db.close();
    ids = referenced(tmp);
    // Spot-check that file copies decrypt with this key too.
    for (const id of ids.filter(id => fs.existsSync(blobPath(dest, id))).slice(-3)) {
      await decryptFile(blobPath(dest, id), `${tmp}.blob`, key);
      await fsp.rm(`${tmp}.blob`, { force: true });
    }
  } finally {
    await fsp.rm(tmp, { force: true });
  }
  return { snapshot: file, integrity, files: ids.length, missing: ids.filter(id => !fs.existsSync(blobPath(dest, id))).length };
}

export async function restore(snapshot, dest, key) {
  if (fs.existsSync(path.join(dest, 'app.db'))) throw new Error(`${dest} already contains app.db. Restore into an empty folder.`);
  const root = path.resolve(path.dirname(snapshot), '..');
  await decryptFile(snapshot, path.join(dest, 'app.db'), key);
  let restored = 0, missing = 0;
  for (const id of referenced(path.join(dest, 'app.db'))) {
    if (!fs.existsSync(blobPath(root, id))) {
      missing++;
      continue;
    }
    await decryptFile(blobPath(root, id), blobPath(dest, id), key);
    restored++;
  }
  fs.writeFileSync(path.join(dest, 'backup.key'), key, { mode: 0o600 });
  return { restored, missing };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [cmd = 'run', a, b] = process.argv.slice(2);
  const cfg = loadConfig();
  const target = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : null;
  try {
    if (cmd === 'key') {
      console.log(`Backup key (store it offline, e.g. in a password manager; needed to restore):\n${loadKey(cfg.dataDir, { create: true }).toString('base64')}`);
    } else if (cmd === 'restore') {
      if (!a || !b) throw new Error('Usage: npm run backup -- restore <db-....sqlite.enc> <empty folder>');
      const r = await restore(path.resolve(a), path.resolve(b), loadKey(cfg.dataDir));
      console.log(`Restored into ${path.resolve(b)}: ${r.restored} files${r.missing ? `, ${r.missing} MISSING` : ''}. Point DATA_DIR there and start the server.`);
    } else {
      if (!target) throw new Error('Set BACKUP_DIR to a folder on another disk or server (spec 8.1).');
      if (target.startsWith(cfg.dataDir)) throw new Error('BACKUP_DIR must not be inside the data folder.');
      if (cmd === 'verify') {
        const v = await verify(target, cfg.dataDir);
        console.log(`${v.snapshot}\n  integrity: ${v.integrity}, files: ${v.files}, missing: ${v.missing}`);
        if (v.integrity !== 'ok' || v.missing) process.exitCode = 1;
      } else {
        const r = await backup(cfg.dataDir, target, Number(process.env.BACKUP_KEEP_DAYS || 120));
        console.log(`${new Date().toISOString()} encrypted backup ${path.basename(r.snapshot)}: ${r.copied} new files, ${r.pruned} expired files removed, ${r.snapshots} snapshots kept${r.missing ? `, ${r.missing} files were deleted during the backup` : ''}`);
      }
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}