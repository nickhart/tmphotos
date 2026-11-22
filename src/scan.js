import fsp from 'node:fs/promises';
import path from 'node:path';
import { classifyFile, libraryKind, libraryRole, shouldSkipDir } from './classify.js';
import { readExif } from './exif.js';
import { fullDiskAccessError, listSnapshots, mountApfsSnapshot, unmountPath } from './mount.js';

/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */
/** @typedef {import('./mount.js').Attachment} Attachment */
/** @typedef {import('./mount.js').Snapshot} Snapshot */

/**
 * @typedef {object} ScanOptions
 * @property {string[]} [only]        snapshot names to scan (default: all)
 * @property {boolean} [latest]       scan only the most recent snapshot
 * @property {boolean} [rescan]       re-walk snapshots already marked done
 * @property {number} [concurrency]   parallel directory listings (default 8)
 * @property {boolean} [exif]         read EXIF for new files (default true)
 * @property {boolean} [videos]       index videos too (default true)
 * @property {number} [minSize]       ignore smaller files, bytes (default 10 KiB)
 * @property {boolean} [includeSystem] descend into /System, ~/Library, etc.
 * @property {RegExp[]} [excludes]    relpath patterns to skip
 * @property {boolean} [fastApfs]     skip APFS dirs whose inode+mtime were already walked
 * @property {AbortSignal} [signal]
 * @property {(p: ScanProgress) => void} [onProgress]
 * @property {(msg: string) => void} [log]
 */

/**
 * @typedef {object} ScanProgress
 * @property {string} snapshot
 * @property {number} index
 * @property {number} total
 * @property {number} dirs
 * @property {number} filesSeen
 * @property {number} filesNew
 * @property {number} dirsSkipped
 * @property {number} errors
 * @property {boolean} [done]
 */

/**
 * Register snapshots in the DB and return them with their row ids.
 *
 * @param {DatabaseSync} db
 * @param {number} bundleId
 * @param {Snapshot[]} snaps
 */
export function registerSnapshots(db, bundleId, snaps) {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO snapshots (bundle_id, machine, name, apfs_name, taken_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const get = db.prepare(
    'SELECT * FROM snapshots WHERE bundle_id = ? AND machine = ? AND name = ?',
  );
  return snaps.map((s) => {
    ins.run(bundleId, s.machine, s.name, s.apfsName, s.takenAt);
    const row = /** @type {any} */ (get.get(bundleId, s.machine, s.name));
    return { ...s, id: /** @type {number} */ (row.id), status: /** @type {string} */ (row.status) };
  });
}

/**
 * Scan every (selected) snapshot of an attached bundle into the index.
 * Safe to interrupt: finished snapshots are skipped next time, and a
 * partially-scanned snapshot is re-walked (inserts are idempotent).
 *
 * @param {DatabaseSync} db
 * @param {Attachment} att
 * @param {ScanOptions} [opts]
 */
export async function scanBundle(db, att, opts = {}) {
  const log = opts.log ?? (() => {});
  const all = registerSnapshots(db, att.bundle.id, await listSnapshots(att));
  let selected = all;
  if (opts.only?.length) selected = all.filter((s) => opts.only?.includes(s.name));
  if (opts.latest) selected = selected.slice(-1);
  const todo = selected.filter((s) => opts.rescan || s.status !== 'done');
  log(
    `${all.length} snapshot(s) in bundle, ${selected.length} selected, ` +
      `${selected.length - todo.length} already scanned, ${todo.length} to scan`,
  );

  const results = [];
  for (let i = 0; i < todo.length; i++) {
    if (opts.signal?.aborted) break;
    const snap = todo[i];
    let root = snap.root;
    /** @type {string | null} */
    let ourMount = null;
    if (att.format === 'apfs') {
      const m = await mountApfsSnapshot(att, snap);
      root = m.root;
      if (m.mountedByUs) ourMount = m.mountPoint;
    }
    try {
      const r = await scanSnapshot(db, att, snap, /** @type {string} */ (root), {
        ...opts,
        index: i + 1,
        total: todo.length,
      });
      results.push(r);
    } finally {
      if (ourMount) await unmountPath(ourMount).catch(() => {});
    }
  }
  return { snapshots: all.length, scanned: results, aborted: Boolean(opts.signal?.aborted) };
}

/**
 * Walk one snapshot.
 *
 * @param {DatabaseSync} db
 * @param {Attachment} att
 * @param {Snapshot & { id: number }} snap
 * @param {string} root directory whose children are the backed-up volumes
 * @param {ScanOptions & { index?: number, total?: number }} opts
 */
export async function scanSnapshot(db, att, snap, root, opts = {}) {
  const bundleId = att.bundle.id;
  const snapId = snap.id;
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  const minSize = opts.minSize ?? 10 * 1024;
  const wantExif = opts.exif !== false;
  const skipByInode = att.format === 'hfs' || Boolean(opts.fastApfs);

  db.prepare(
    `UPDATE snapshots SET status = 'scanning', started_at = datetime('now'), finished_at = NULL,
       files_seen = 0, files_new = 0, dirs_skipped = 0, errors = 0 WHERE id = ?`,
  ).run(snapId);
  // Rows from an interrupted run of this snapshot can't be trusted: the
  // subtrees below them may not have been finished.
  db.prepare('DELETE FROM walked_dirs WHERE bundle_id = ? AND snapshot_id = ?').run(
    bundleId,
    snapId,
  );

  const q = {
    fileExists: db.prepare(
      'SELECT 1 FROM files WHERE bundle_id = ? AND ino = ? AND size = ? AND mtime_ms = ?',
    ),
    insertFile: db.prepare(
      `INSERT OR IGNORE INTO files (bundle_id, ino, size, mtime_ms, birthtime_ms, relpath, folder,
         name, ext, kind, library_id, role, first_snapshot_id, exif_status, exif_date,
         camera_make, camera_model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    walked: db.prepare(
      `SELECT 1 FROM walked_dirs w JOIN snapshots s ON s.id = w.snapshot_id
       WHERE w.bundle_id = ? AND w.ino = ? AND w.mtime_ms = ?
         AND (s.status = 'done' OR s.id = ?)`,
    ),
    markWalked: db.prepare(
      'INSERT OR IGNORE INTO walked_dirs (bundle_id, ino, mtime_ms, snapshot_id) VALUES (?, ?, ?, ?)',
    ),
    insertLib: db.prepare(
      `INSERT INTO libraries (bundle_id, relpath, kind, first_snapshot_id, last_snapshot_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (bundle_id, relpath) DO UPDATE SET last_snapshot_id = excluded.last_snapshot_id`,
    ),
    getLib: db.prepare('SELECT id FROM libraries WHERE bundle_id = ? AND relpath = ?'),
  };

  const stats = { dirs: 0, filesSeen: 0, filesNew: 0, dirsSkipped: 0, errors: 0 };
  const progress = (done = false) =>
    opts.onProgress?.({
      snapshot: snap.machine ? `${snap.machine}/${snap.name}` : snap.name,
      index: opts.index ?? 1,
      total: opts.total ?? 1,
      ...stats,
      done,
    });

  // Batch writes into transactions; commit periodically so progress survives
  // an interruption.
  let pending = 0;
  let lastCommit = Date.now();
  db.exec('BEGIN');
  const maybeCommit = (force = false) => {
    if (force || pending >= 500 || Date.now() - lastCommit > 3000) {
      db.exec('COMMIT');
      db.exec('BEGIN');
      pending = 0;
      lastCommit = Date.now();
      progress();
    }
  };

  /**
   * @param {string} relpath
   * @param {string} kind
   */
  const registerLibrary = (relpath, kind) => {
    q.insertLib.run(bundleId, relpath, kind, snapId, snapId);
    pending++;
    return /** @type {number} */ (/** @type {any} */ (q.getLib.get(bundleId, relpath)).id);
  };

  /** @typedef {{ abs: string, parts: string[], lib: { id: number, depth: number } | null }} Task */
  /** @type {Task[]} */
  const queue = [{ abs: root, parts: [], lib: null }];
  let active = 0;

  /** @param {Task} task */
  const processDir = async (task) => {
    let entries;
    try {
      entries = await fsp.readdir(task.abs, { withFileTypes: true });
    } catch (err) {
      // An unreadable snapshot root means nothing can be scanned: fail loudly.
      if (task.parts.length === 0) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM') {
          throw fullDiskAccessError(task.abs);
        }
        throw err;
      }
      stats.errors++;
      return;
    }
    stats.dirs++;
    // Stat entries a few at a time: over SMB each stat is a round trip.
    const CHUNK = 16;
    for (let i = 0; i < entries.length; i += CHUNK) {
      if (opts.signal?.aborted) return;
      await Promise.all(
        entries.slice(i, i + CHUNK).map((ent) => {
          const abs = path.join(task.abs, ent.name);
          const parts = [...task.parts, ent.name];
          if (ent.isDirectory()) return handleDir(task, ent.name, abs, parts);
          if (ent.isFile()) return handleFile(task, ent.name, abs, parts);
          return undefined; // symlinks (e.g. "Latest"), devices, sockets
        }),
      );
    }
  };

  /**
   * @param {Task} parent
   * @param {string} name
   * @param {string} abs
   * @param {string[]} parts
   */
  const handleDir = async (parent, name, abs, parts) => {
    const kind = parent.lib ? null : libraryKind(name);
    if (parent.lib) {
      if (shouldSkipDir(parts.slice(parent.lib.depth), { insideLibrary: true })) return;
    } else if (
      !kind &&
      shouldSkipDir(parts, { includeSystem: opts.includeSystem, excludes: opts.excludes })
    ) {
      return;
    }
    let lib = parent.lib;
    if (kind) lib = { id: registerLibrary(parts.join('/'), kind), depth: parts.length };
    if (skipByInode) {
      let st;
      try {
        st = await fsp.lstat(abs, { bigint: true });
      } catch {
        stats.errors++;
        return;
      }
      const ino = st.ino;
      const mtime = Number(st.mtimeMs);
      if (q.walked.get(bundleId, ino, mtime, snapId)) {
        stats.dirsSkipped++;
        return;
      }
      // Mark when queued: a crash before the subtree finishes leaves the
      // snapshot in 'scanning', and these rows are discarded on resume.
      q.markWalked.run(bundleId, ino, mtime, snapId);
      pending++;
    }
    queue.push({ abs, parts, lib });
  };

  /**
   * @param {Task} parent
   * @param {string} name
   * @param {string} abs
   * @param {string[]} parts
   */
  const handleFile = async (parent, name, abs, parts) => {
    const c = classifyFile(name, { videos: opts.videos });
    if (!c) return;
    let st;
    try {
      st = await fsp.lstat(abs, { bigint: true });
    } catch {
      stats.errors++;
      return;
    }
    const size = Number(st.size);
    if (size < minSize) return;
    stats.filesSeen++;
    const ino = st.ino;
    const mtime = Number(st.mtimeMs);
    if (q.fileExists.get(bundleId, ino, size, mtime)) return;
    const exif = wantExif
      ? await readExif(abs, c.ext)
      : { status: 'skipped', date: null, make: null, model: null };
    const relpath = parts.join('/');
    const role = parent.lib ? libraryRole(parts.slice(parent.lib.depth)) : null;
    const res = q.insertFile.run(
      bundleId,
      ino,
      size,
      mtime,
      Number(st.birthtimeMs),
      relpath,
      parts.slice(0, -1).join('/'),
      name,
      c.ext,
      c.kind,
      parent.lib?.id ?? null,
      role,
      snapId,
      exif.status,
      exif.date,
      exif.make,
      exif.model,
    );
    if (res.changes) {
      stats.filesNew++;
      pending++;
    }
    maybeCommit();
  };

  const ticker = setInterval(() => progress(), 1000);
  try {
    await new Promise((resolve, reject) => {
      const pump = () => {
        if (opts.signal?.aborted && active === 0) return resolve(undefined);
        while (!opts.signal?.aborted && active < concurrency && queue.length) {
          const task = /** @type {Task} */ (queue.pop());
          active++;
          processDir(task)
            .then(() => {
              active--;
              maybeCommit();
              if (active === 0 && (queue.length === 0 || opts.signal?.aborted)) resolve(undefined);
              else pump();
            })
            .catch(reject);
        }
        if (active === 0 && queue.length === 0) resolve(undefined);
      };
      pump();
    });
  } catch (err) {
    db.exec('COMMIT');
    throw err;
  } finally {
    clearInterval(ticker);
  }

  const finished = !opts.signal?.aborted;
  db.prepare(
    `UPDATE snapshots SET status = ?, finished_at = ?, files_seen = ?, files_new = ?,
       dirs_skipped = ?, errors = ? WHERE id = ?`,
  ).run(
    finished ? 'done' : 'scanning',
    finished ? new Date().toISOString() : null,
    stats.filesSeen,
    stats.filesNew,
    stats.dirsSkipped,
    stats.errors,
    snapId,
  );
  db.exec('COMMIT');
  progress(true);
  return { snapshot: snap.name, finished, ...stats };
}
