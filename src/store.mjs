import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// File contents live under random ids (data/blobs/ab/abcdef...), never under user-supplied names,
// so no request can reach a path outside the store. Blobs are immutable: a new upload is a new blob.
// stallMs: an upload that sends less than 16 KB in this long is cut off, so nobody can hold a disk
// reservation open by trickling a byte now and then.
export function makeStore(dataDir, stallMs = 60e3) {
  const blobs = path.join(dataDir, 'blobs');
  const tmp = path.join(dataDir, 'tmp');
  const file = id => path.join(blobs, id.slice(0, 2), id);
  const bad = msg => Object.assign(new Error(msg), { status: 400 });

  return {
    file,

    // Streams the request body to disk; never buffers it in memory, so 5+ GB uploads are fine.
    async receive(stream, expected) {
      const id = crypto.randomBytes(16).toString('hex');
      const part = path.join(tmp, id);
      let n = 0;
      const guard = new Transform({
        transform(chunk, _enc, cb) {
          n += chunk.length;
          cb(n > expected ? bad('The upload is larger than its declared size.') : null, chunk);
        },
      });
      let seen = 0;
      const watch = setInterval(() => {
        if (n - seen < 16384 && n < expected) stream.destroy(Object.assign(new Error('The upload stalled. Try again.'), { status: 408 }));
        seen = n;
      }, stallMs);
      try {
        await pipeline(stream, guard, fs.createWriteStream(part, { flags: 'wx' }));
        if (n !== expected) throw bad('The upload was interrupted. Try again.');
        await fsp.mkdir(path.dirname(file(id)), { recursive: true });
        await fsp.rename(part, file(id));
        return id;
      } catch (e) {
        await fsp.rm(part, { force: true });
        throw e;
      } finally {
        clearInterval(watch);
      }
    },

    // Takes over a finished file from the same disk (a completed resumable upload) without copying it.
    async adopt(from) {
      const id = crypto.randomBytes(16).toString('hex');
      await fsp.mkdir(path.dirname(file(id)), { recursive: true });
      await fsp.rename(from, file(id));
      return id;
    },

    read: (id, start, end) => fs.createReadStream(file(id), { start, end }),

    async remove(ids) {
      // Never rejects: callers fire-and-forget, and an unhandled rejection exits Node.
      // A blob left behind only wastes disk; the DB row is already gone.
      await Promise.all(ids.filter(Boolean).map(id => fsp.rm(file(id), { force: true })
        .catch(e => console.error(`store: cannot remove blob ${id}: ${e.code || e.message}`))));
    },

    // Leftovers from uploads cut off mid-way.
    async sweepTmp(olderThanMs) {
      const now = Date.now();
      for (const f of await fsp.readdir(tmp)) {
        const p = path.join(tmp, f);
        const st = await fsp.stat(p).catch(() => null);
        if (st && now - st.mtimeMs > olderThanMs) await fsp.rm(p, { force: true });
      }
    },
  };
}
