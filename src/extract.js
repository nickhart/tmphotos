import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { mountRoot } from './config.js';
import { mountApfsSnapshot, unmountPath } from './mount.js';

/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */
/** @typedef {import('./mount.js').Attachment} Attachment */

/**
 * Parse a selection file written by the report ("<bundle>\t<prefix>" per
 * line; a line without a tab is a prefix for every bundle; # comments).
 *
 * @param {string} text
 * @returns {{ bundle: string | null, prefix: string }[]}
 */
export function parseSelection(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const tab = line.indexOf('\t');
    if (tab >= 0)
      out.push({ bundle: line.slice(0, tab), prefix: trimSlashes(line.slice(tab + 1)) });
    else out.push({ bundle: null, prefix: trimSlashes(line) });
  }
  return out;
}

/** @param {string} s */
function trimSlashes(s) {
  return s.replace(/^\/+|\/+$/g, '');
}

/**
 * Select indexed files whose relpath is inside one of the prefixes.
 *
 * @param {DatabaseSync} db
 * @param {number} bundleId
 * @param {string} bundleName
 * @param {{ bundle: string | null, prefix: string }[]} selection
 * @param {{ originalsOnly?: boolean, videos?: boolean }} [opts]
 */
export function selectFiles(db, bundleId, bundleName, selection, opts = {}) {
  const prefixes = selection
    .filter((s) => s.bundle === null || s.bundle === bundleName)
    .map((s) => s.prefix);
  if (!prefixes.length) return [];
  const stmt = db.prepare(
    `SELECT f.*, s.name AS snapshot_name, s.machine, s.apfs_name
     FROM files f JOIN snapshots s ON s.id = f.first_snapshot_id
     WHERE f.bundle_id = ? AND (f.folder = ? OR f.relpath LIKE ? ESCAPE '\\')
     ORDER BY f.first_snapshot_id, f.relpath`,
  );
  /** @type {Map<number, any>} */
  const byId = new Map();
  for (const p of prefixes) {
    const like = `${p.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`;
    for (const row of /** @type {any[]} */ (stmt.all(bundleId, p, like))) {
      if (opts.originalsOnly && row.role === 'edited') continue;
      if (opts.videos === false && row.kind === 'video') continue;
      byId.set(row.id, row);
    }
  }
  return [...byId.values()].sort(
    (a, b) => a.first_snapshot_id - b.first_snapshot_id || a.relpath.localeCompare(b.relpath),
  );
}

/**
 * Refuse targets inside the source bundle, its mount points, or the
 * tmphotos mount root.
 *
 * @param {string} target
 * @param {string[]} forbidden absolute paths
 */
export function assertSafeTarget(target, forbidden) {
  const abs = path.resolve(target);
  // Resolve the nearest existing ancestor so symlinks can't sneak past.
  let probe = abs;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const real = path.join(fs.realpathSync(probe), path.relative(probe, abs));
  for (const f of [...forbidden, mountRoot()]) {
    if (!f) continue;
    let rf = f;
    try {
      rf = fs.realpathSync(f);
    } catch {
      // keep as-is
    }
    if (real === rf || real.startsWith(rf + path.sep)) {
      throw new Error(`Refusing to write to ${target}: it is inside the source (${f})`);
    }
  }
  return real;
}

/**
 * Hash a file with SHA-256.
 *
 * @param {string} file
 */
export async function sha256File(file) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file, { flags: 'r' }), h);
  return h.digest('hex');
}

/**
 * Copy src -> dest via a temp file, hashing the source as it streams, then
 * re-read the destination to verify. Preserves mtime/atime, and on macOS the
 * creation date (setting an mtime earlier than the birth time moves it back).
 *
 * @param {string} src
 * @param {string} dest
 * @param {import('node:fs').Stats} srcStat
 * @returns {Promise<string>} sha256 hex
 */
export async function copyVerified(src, dest, srcStat) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmphotos-partial`;
  const h = crypto.createHash('sha256');
  const rs = fs.createReadStream(src, { flags: 'r' });
  rs.on('data', (chunk) => h.update(chunk));
  try {
    await pipeline(rs, fs.createWriteStream(tmp, { flags: 'w' }));
    const fh = await fsp.open(tmp, 'r+');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    const srcHash = h.digest('hex');
    const destHash = await sha256File(tmp);
    if (srcHash !== destHash) {
      throw new Error(`Checksum mismatch copying ${src}: ${srcHash} != ${destHash}`);
    }
    await fsp.rename(tmp, dest);
    if (srcStat.birthtimeMs && srcStat.birthtimeMs < srcStat.mtimeMs) {
      await fsp.utimes(dest, srcStat.atime, srcStat.birthtime);
    }
    await fsp.utimes(dest, srcStat.atime, srcStat.mtime);
    return srcHash;
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Pick a destination path that doesn't collide: "a.jpg", "a (1).jpg", ...
 *
 * @param {string} dest
 * @param {number} n
 */
function numbered(dest, n) {
  if (n === 0) return dest;
  const ext = path.extname(dest);
  return `${dest.slice(0, dest.length - ext.length)} (${n})${ext}`;
}

/**
 * @typedef {object} ExtractOptions
 * @property {string} target
 * @property {boolean} [dryRun]
 * @property {AbortSignal} [signal]
 * @property {(p: { done: number, total: number, bytes: number, copied: number, skipped: number, failed: number, file?: string }) => void} [onProgress]
 * @property {(msg: string) => void} [log]
 */

/**
 * Copy the given files out of an attached bundle.
 *
 * @param {DatabaseSync} db
 * @param {Attachment} att
 * @param {any[]} files rows from selectFiles
 * @param {ExtractOptions} opts
 */
export async function extractFiles(db, att, files, opts) {
  const log = opts.log ?? (() => {});
  const bundleDir = att.bundle.name.replace(/\.(sparsebundle|backupbundle)$/i, '');
  const targetRoot = assertSafeTarget(opts.target, [att.bundle.path, att.mountPoint ?? '']);
  const totalBytes = files.reduce((a, f) => a + f.size, 0);
  const stats = { done: 0, total: files.length, bytes: 0, copied: 0, skipped: 0, failed: 0 };
  /** @type {{ file: string, error: string }[]} */
  const failures = [];

  if (opts.dryRun) {
    return { ...stats, totalBytes, targetRoot, failures, dryRun: true };
  }
  await fsp.mkdir(targetRoot, { recursive: true });
  const free = fs.statfsSync(targetRoot);
  const freeBytes = Number(free.bavail) * Number(free.bsize);
  if (freeBytes < totalBytes) {
    throw new Error(
      `Not enough space in ${targetRoot}: need ${totalBytes} bytes, ${freeBytes} available`,
    );
  }

  const recorded = db.prepare('SELECT sha256 FROM extractions WHERE file_id = ? AND dest = ?');
  const record = db.prepare(
    'INSERT OR REPLACE INTO extractions (file_id, dest, sha256) VALUES (?, ?, ?)',
  );

  // Group by snapshot so each APFS snapshot is mounted once.
  /** @type {Map<number, any[]>} */
  const bySnap = new Map();
  for (const f of files) {
    const list = bySnap.get(f.first_snapshot_id) ?? [];
    list.push(f);
    bySnap.set(f.first_snapshot_id, list);
  }

  for (const [, group] of bySnap) {
    if (opts.signal?.aborted) break;
    const first = group[0];
    /** @type {string} */
    let root;
    /** @type {string | null} */
    let ourMount = null;
    if (att.format === 'apfs') {
      const m = await mountApfsSnapshot(att, {
        machine: first.machine,
        name: first.snapshot_name,
        apfsName: first.apfs_name,
        takenAt: null,
        root: null,
      });
      root = m.root;
      if (m.mountedByUs) ourMount = m.mountPoint;
    } else {
      root = path.join(
        /** @type {string} */ (att.mountPoint),
        'Backups.backupdb',
        first.machine,
        first.snapshot_name,
      );
    }
    try {
      for (const f of group) {
        if (opts.signal?.aborted) break;
        const src = path.join(root, f.relpath);
        const baseDest = path.join(targetRoot, bundleDir, f.relpath);
        try {
          const outcome = await extractOne(f, src, baseDest, { recorded, record });
          if (outcome === 'copied') stats.copied++;
          else stats.skipped++;
        } catch (err) {
          stats.failed++;
          failures.push({ file: f.relpath, error: /** @type {Error} */ (err).message });
          log(`FAILED ${f.relpath}: ${/** @type {Error} */ (err).message}`);
        }
        stats.done++;
        stats.bytes += f.size;
        opts.onProgress?.({ ...stats, file: f.relpath });
      }
    } finally {
      if (ourMount) await unmountPath(ourMount).catch(() => {});
    }
  }
  return { ...stats, totalBytes, targetRoot, failures, dryRun: false };
}

/**
 * @param {any} f file row
 * @param {string} src
 * @param {string} baseDest
 * @param {{ recorded: any, record: any }} q
 * @returns {Promise<'copied' | 'skipped'>}
 */
async function extractOne(f, src, baseDest, q) {
  const st = await fsp.lstat(src);
  if (!st.isFile()) throw new Error('source is not a regular file');
  if (st.size !== f.size || Math.floor(st.mtimeMs) !== f.mtime_ms) {
    throw new Error('source no longer matches the index (size/mtime changed); re-run scan');
  }
  for (let n = 0; n < 1000; n++) {
    const dest = numbered(baseDest, n);
    const prior = /** @type {any} */ (q.recorded.get(f.id, dest));
    let destStat = null;
    try {
      destStat = await fsp.stat(dest);
    } catch {
      // does not exist
    }
    if (!destStat) {
      const hash = await copyVerified(src, dest, st);
      q.record.run(f.id, dest, hash);
      return 'copied';
    }
    if (prior && destStat.size === f.size) return 'skipped'; // done in an earlier run
    if (destStat.size === f.size) {
      // Same name and size: identical if the content matches.
      const [a, b] = await Promise.all([sha256File(src), sha256File(dest)]);
      if (a === b) {
        q.record.run(f.id, dest, a);
        return 'skipped';
      }
    }
    // Different file already there: try "name (n).ext".
  }
  throw new Error('too many name collisions');
}
