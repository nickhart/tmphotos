import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- One row per .sparsebundle / .backupbundle.
CREATE TABLE IF NOT EXISTS bundles (
  id         INTEGER PRIMARY KEY,
  path       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  format     TEXT,               -- 'hfs' | 'apfs'
  volume_uuid TEXT,              -- filesystem UUID; survives share remounts
  added_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Live hdiutil attachments created by tmphotos.
CREATE TABLE IF NOT EXISTS mounts (
  bundle_id    INTEGER PRIMARY KEY REFERENCES bundles(id),
  device       TEXT NOT NULL,     -- whole-disk device, e.g. /dev/disk7
  volume_dev   TEXT,              -- volume device, e.g. /dev/disk7s1
  mount_point  TEXT,
  mounted_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per Time Machine backup (HFS+ dated folder or APFS snapshot).
CREATE TABLE IF NOT EXISTS snapshots (
  id           INTEGER PRIMARY KEY,
  bundle_id    INTEGER NOT NULL REFERENCES bundles(id),
  machine      TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL,     -- e.g. 2012-03-04-120000
  apfs_name    TEXT,              -- e.g. com.apple.TimeMachine.2021-...backup
  taken_at     TEXT,              -- ISO-ish local time parsed from the name
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | scanning | done
  files_seen   INTEGER NOT NULL DEFAULT 0,
  files_new    INTEGER NOT NULL DEFAULT 0,
  dirs_skipped INTEGER NOT NULL DEFAULT 0,
  errors       INTEGER NOT NULL DEFAULT 0,
  started_at   TEXT,
  finished_at  TEXT,
  UNIQUE (bundle_id, machine, name)
);

-- Photos / iPhoto / Aperture libraries discovered during the walk.
CREATE TABLE IF NOT EXISTS libraries (
  id                INTEGER PRIMARY KEY,
  bundle_id         INTEGER NOT NULL REFERENCES bundles(id),
  relpath           TEXT NOT NULL,
  kind              TEXT NOT NULL,  -- photos | iphoto | aperture
  first_snapshot_id INTEGER REFERENCES snapshots(id),
  last_snapshot_id  INTEGER REFERENCES snapshots(id),
  UNIQUE (bundle_id, relpath)
);

-- Each unique file, counted once no matter how many snapshots contain it.
-- Identity within a bundle is (inode, size, mtime): Time Machine hard-links
-- (HFS+) or shares (APFS snapshots) unchanged files, so they keep the inode.
CREATE TABLE IF NOT EXISTS files (
  id                INTEGER PRIMARY KEY,
  bundle_id         INTEGER NOT NULL REFERENCES bundles(id),
  ino               INTEGER NOT NULL,
  size              INTEGER NOT NULL,
  mtime_ms          INTEGER NOT NULL,
  birthtime_ms      INTEGER,
  relpath           TEXT NOT NULL,  -- relative to the snapshot root
  folder            TEXT NOT NULL,  -- dirname(relpath)
  name              TEXT NOT NULL,
  ext               TEXT NOT NULL,
  kind              TEXT NOT NULL,  -- image | raw | video
  library_id        INTEGER REFERENCES libraries(id),
  role              TEXT,           -- original | edited (inside libraries)
  first_snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  exif_status       TEXT,           -- ok | none | error | skipped
  exif_date         TEXT,
  camera_make       TEXT,
  camera_model      TEXT,
  UNIQUE (bundle_id, ino, size, mtime_ms)
);
CREATE INDEX IF NOT EXISTS files_folder ON files (bundle_id, folder);
CREATE INDEX IF NOT EXISTS files_library ON files (library_id);

-- Directories fully listed in a snapshot. Used to skip HFS+ directory hard
-- links (identical subtrees) in later snapshots.
CREATE TABLE IF NOT EXISTS walked_dirs (
  bundle_id   INTEGER NOT NULL,
  ino         INTEGER NOT NULL,
  mtime_ms    INTEGER NOT NULL,
  snapshot_id INTEGER NOT NULL,
  PRIMARY KEY (bundle_id, ino, mtime_ms)
) WITHOUT ROWID;

-- Files copied out by \`extract\`.
CREATE TABLE IF NOT EXISTS extractions (
  file_id      INTEGER NOT NULL REFERENCES files(id),
  dest         TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  extracted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (file_id, dest)
);
`;

/**
 * Open (and migrate) the index database.
 *
 * @param {string} file
 * @returns {DatabaseSync}
 */
export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(
    'schema_version',
    String(SCHEMA_VERSION),
  );
  return db;
}

/**
 * Run `fn` inside a transaction.
 *
 * @template T
 * @param {DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * @typedef {{ id: number, path: string, name: string, format: string | null, volume_uuid: string | null }} BundleRow
 */

/**
 * Find or create the bundle row. A bundle seen before under a different path
 * (e.g. the SMB share now mounts at /Volumes/Backups-1) is matched by its
 * filesystem UUID and its path is updated.
 *
 * @param {DatabaseSync} db
 * @param {string} bundlePath absolute path
 * @param {{ format?: string | null, volumeUuid?: string | null }} [info]
 * @returns {BundleRow}
 */
export function upsertBundle(db, bundlePath, info = {}) {
  const { format = null, volumeUuid = null } = info;
  /** @type {BundleRow | undefined} */
  let row = volumeUuid
    ? /** @type {any} */ (db.prepare('SELECT * FROM bundles WHERE volume_uuid = ?').get(volumeUuid))
    : undefined;
  row ??= /** @type {any} */ (db.prepare('SELECT * FROM bundles WHERE path = ?').get(bundlePath));
  if (!row) {
    db.prepare('INSERT INTO bundles (path, name, format, volume_uuid) VALUES (?, ?, ?, ?)').run(
      bundlePath,
      path.basename(bundlePath),
      format,
      volumeUuid,
    );
  } else {
    db.prepare(
      `UPDATE bundles SET path = ?, name = ?, format = COALESCE(?, format),
         volume_uuid = COALESCE(?, volume_uuid) WHERE id = ?`,
    ).run(bundlePath, path.basename(bundlePath), format, volumeUuid, row.id);
  }
  return /** @type {any} */ (db.prepare('SELECT * FROM bundles WHERE path = ?').get(bundlePath));
}

/**
 * @param {DatabaseSync} db
 * @param {string} bundlePath
 * @returns {BundleRow | undefined}
 */
export function findBundle(db, bundlePath) {
  return /** @type {any} */ (db.prepare('SELECT * FROM bundles WHERE path = ?').get(bundlePath));
}
