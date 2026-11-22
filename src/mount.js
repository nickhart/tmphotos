import fs from 'node:fs';
import path from 'node:path';
import { run, runPlist, CommandError } from './exec.js';
import { mountRoot } from './config.js';
import { upsertBundle, findBundle } from './db.js';

/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */
/** @typedef {import('./db.js').BundleRow} BundleRow */

/**
 * @typedef {object} Attachment
 * @property {BundleRow} bundle
 * @property {string} device      whole-disk device (/dev/diskN)
 * @property {string} volumeDev   volume device (/dev/diskNsM)
 * @property {string | null} mountPoint
 * @property {'hfs' | 'apfs'} format
 * @property {boolean} reused     true if the image was already attached
 * @property {boolean} [journalIgnored] HFS+ mounted ignoring a dirty journal
 */

/**
 * @typedef {object} Snapshot
 * @property {string} machine
 * @property {string} name       YYYY-MM-DD-HHMMSS
 * @property {string | null} apfsName  full APFS snapshot name, if any
 * @property {string | null} takenAt   ISO local timestamp
 * @property {string | null} root      path to walk (null until mounted for APFS)
 */

const BUNDLE_EXTS = ['.sparsebundle', '.backupbundle'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/;
const APFS_SNAP_RE = /^com\.apple\.TimeMachine\.(\d{4}-\d{2}-\d{2}-\d{6})\.backup$/;

/**
 * Resolve and validate a bundle path.
 *
 * @param {string} p
 * @returns {string} absolute real path
 */
export function resolveBundlePath(p) {
  const abs = fs.realpathSync(path.resolve(p));
  const st = fs.statSync(abs);
  if (!st.isDirectory() || !fs.existsSync(path.join(abs, 'Info.plist'))) {
    throw new Error(`${p} is not a disk image bundle (no Info.plist)`);
  }
  if (!BUNDLE_EXTS.includes(path.extname(abs).toLowerCase())) {
    throw new Error(`${p} is not a .sparsebundle or .backupbundle`);
  }
  return abs;
}

/**
 * Find bundles directly inside a directory (e.g. the root of an SMB share).
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function findBundles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && BUNDLE_EXTS.includes(path.extname(d.name).toLowerCase()))
    .map((d) => path.join(dir, d.name))
    .sort();
}

/**
 * Parse a Time Machine date stamp (YYYY-MM-DD-HHMMSS) into an ISO local time.
 *
 * @param {string} name
 * @returns {string | null}
 */
export function parseSnapshotDate(name) {
  const m = DATE_RE.exec(name);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

/** @returns {Promise<any[]>} hdiutil's list of attached images */
export async function hdiutilImages() {
  const info = await runPlist('hdiutil', ['info', '-plist']);
  return info.images ?? [];
}

/**
 * Find an existing attachment of the given image path.
 *
 * @param {string} bundlePath
 */
export async function findAttached(bundlePath) {
  const images = await hdiutilImages();
  return images.find((img) => {
    const p = img['image-path'];
    try {
      return p === bundlePath || fs.realpathSync(p) === bundlePath;
    } catch {
      return false;
    }
  });
}

/**
 * Pick the device / mount point / format from hdiutil's system-entities.
 *
 * @param {any[]} entities
 */
export function pickVolume(entities) {
  const whole = wholeDevice(entities);
  const vols = entities.map((e) => ({ e, kind: volumeKind(e) })).filter((v) => v.kind !== null);
  const vol =
    vols.find((v) => v.e['mount-point']) ?? vols.find((v) => v.kind === 'apfs') ?? vols[0];
  if (!vol) throw new Error('No HFS+ or APFS volume found in the attached image');
  return {
    device: whole,
    volumeDev: /** @type {string} */ (vol.e['dev-entry']),
    mountPoint: /** @type {string | null} */ (vol.e['mount-point'] ?? null),
    format: /** @type {'hfs'|'apfs'} */ (vol.kind),
  };
}

// Partition / volume type GUIDs as reported in hdiutil's content-hint.
const HFS_HINTS = new Set([
  'apple_hfs',
  'apple_hfsx',
  '48465300-0000-11aa-aa11-00306543ecac',
  '48465358-0000-11aa-aa11-00306543ecac',
]);
const APFS_VOLUME_HINT = '41504653-0000-11aa-aa11-00306543ecac';

/**
 * `hdiutil attach` reports volume-kind; `hdiutil info` only has content-hint.
 *
 * @param {any} e
 * @returns {'hfs' | 'apfs' | null}
 */
function volumeKind(e) {
  if (e['volume-kind'] === 'hfs' || e['volume-kind'] === 'apfs') return e['volume-kind'];
  const hint = String(e['content-hint'] ?? '').toLowerCase();
  if (HFS_HINTS.has(hint)) return 'hfs';
  if (hint === APFS_VOLUME_HINT) return 'apfs';
  return null;
}

/**
 * The whole-disk device (/dev/diskN) of an attachment.
 *
 * @param {any[]} entities
 */
export function wholeDevice(entities) {
  const devs = entities.map((e) => e['dev-entry']).filter(Boolean);
  return devs.filter((d) => /^\/dev\/disk\d+$/.test(d)).sort(byDiskNumber)[0] ?? devs[0];
}

/** @param {string} a @param {string} b */
function byDiskNumber(a, b) {
  return Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, ''));
}

/** @param {string} dev */
async function volumeUuid(dev) {
  try {
    const info = await runPlist('diskutil', ['info', '-plist', dev]);
    return info.VolumeUUID ?? null;
  } catch {
    return null;
  }
}

/** Directory used as -mountroot for a bundle. */
export function bundleMountDir(bundlePath) {
  const base = path.basename(bundlePath).replace(/\.(sparsebundle|backupbundle)$/i, '');
  return path.join(mountRoot(), base);
}

/**
 * Attach a bundle read-only. Never uses a shadow file, never verifies or fscks
 * (both could be slow and fsck could attempt repairs), never opens Finder.
 *
 * @param {DatabaseSync} db
 * @param {string} bundleArg
 * @param {{ password?: string }} [opts]
 * @returns {Promise<Attachment>}
 */
export async function attach(db, bundleArg, opts = {}) {
  const bundlePath = resolveBundlePath(bundleArg);
  let entities;
  let reused = false;
  const existing = await findAttached(bundlePath);
  if (existing) {
    if (existing.writeable) {
      throw new Error(
        `${bundlePath} is already attached read-write by something else. ` +
          'Detach it first (hdiutil detach) so tmphotos can attach it read-only.',
      );
    }
    entities = existing['system-entities'];
    reused = true;
  } else {
    const args = [
      'attach',
      '-readonly',
      '-nobrowse',
      '-noverify',
      '-noautofsck',
      '-noautoopen',
      '-mountroot',
      bundleMountDir(bundlePath),
      '-plist',
    ];
    if (opts.password !== undefined) args.push('-stdinpass');
    args.push(bundlePath);
    const runOpts = { input: opts.password, inheritStdin: opts.password === undefined };
    try {
      entities = (await runPlist('hdiutil', args, runOpts))['system-entities'];
    } catch (err) {
      // Typically a journaled HFS+ volume left dirty by an interrupted
      // backup: a read-only mount can't replay the journal. Attach without
      // mounting and mount the volume ourselves below.
      if (!(err instanceof CommandError) || !/no mountable file systems/i.test(err.message)) {
        throw err;
      }
      const noMount = args.filter((a, i) => a !== '-mountroot' && args[i - 1] !== '-mountroot');
      noMount.splice(1, 0, '-nomount');
      entities = (await runPlist('hdiutil', noMount, runOpts))['system-entities'];
    }
  }
  const vol = pickVolume(entities);
  let journalIgnored = false;
  if (vol.format === 'hfs' && !vol.mountPoint) {
    try {
      const m = await mountHfsVolume(vol.volumeDev, bundleMountDir(bundlePath));
      vol.mountPoint = m.mountPoint;
      journalIgnored = m.journalIgnored;
    } catch (err) {
      // Don't leave an image we attached hanging around unmounted.
      if (!reused) await run('hdiutil', ['detach', vol.device], { allowFailure: true });
      throw err;
    }
  }
  const uuid = await volumeUuid(vol.volumeDev);
  const bundle = upsertBundle(db, bundlePath, { format: vol.format, volumeUuid: uuid });
  db.prepare(
    `INSERT INTO mounts (bundle_id, device, volume_dev, mount_point) VALUES (?, ?, ?, ?)
     ON CONFLICT (bundle_id) DO UPDATE SET device = excluded.device,
       volume_dev = excluded.volume_dev, mount_point = excluded.mount_point,
       mounted_at = datetime('now')`,
  ).run(bundle.id, vol.device, vol.volumeDev, vol.mountPoint);
  return { bundle, ...vol, reused, journalIgnored };
}

/**
 * Mount an attached HFS+ volume read-only. If the journal is dirty (the
 * last backup was interrupted) a read-only mount can't replay it, so retry
 * ignoring the journal. The device itself is read-only either way.
 *
 * @param {string} dev  e.g. /dev/disk7s2
 * @param {string} root directory to create the mount point in
 */
export async function mountHfsVolume(dev, root) {
  let name = 'Time Machine Backups';
  try {
    name = (await runPlist('diskutil', ['info', '-plist', dev])).VolumeName || name;
  } catch {
    // keep default
  }
  const dir = path.join(root, name.replace(/\//g, ':'));
  fs.mkdirSync(dir, { recursive: true });
  try {
    await run('mount_hfs', ['-o', 'rdonly,nobrowse', dev, dir]);
    return { mountPoint: dir, journalIgnored: false };
  } catch (err) {
    if (isPermissionError(err)) throw fullDiskAccessError(dev, err);
  }
  try {
    await run('mount_hfs', ['-j', '-o', 'rdonly,nobrowse', dev, dir]);
    return { mountPoint: dir, journalIgnored: true };
  } catch (err) {
    if (isPermissionError(err)) throw fullDiskAccessError(dev, err);
    throw err;
  }
}

/**
 * True for "Operation not permitted" from a command or syscall. On macOS
 * that is almost always privacy protection (TCC), not file permissions.
 *
 * @param {unknown} err
 */
export function isPermissionError(err) {
  if (err instanceof CommandError) return /operation not permitted/i.test(err.stderr + err.stdout);
  return /** @type {NodeJS.ErrnoException} */ (err)?.code === 'EPERM';
}

/**
 * List the Time Machine backups contained in an attached bundle.
 *
 * @param {Attachment} att
 * @returns {Promise<Snapshot[]>}
 */
export async function listSnapshots(att) {
  if (att.format === 'hfs') return listHfsSnapshots(att.mountPoint);
  return listApfsSnapshots(att.volumeDev);
}

/**
 * HFS+: Backups.backupdb/<machine>/<YYYY-MM-DD-HHMMSS>/
 *
 * @param {string | null} mountPoint
 * @returns {Snapshot[]}
 */
export function listHfsSnapshots(mountPoint) {
  if (!mountPoint) throw new Error('HFS+ volume is not mounted');
  const db = path.join(mountPoint, 'Backups.backupdb');
  if (!fs.existsSync(db)) {
    throw new Error(`No Backups.backupdb found in ${mountPoint}; is this a Time Machine bundle?`);
  }
  /** @type {Snapshot[]} */
  const snaps = [];
  let machines;
  try {
    machines = fs.readdirSync(db, { withFileTypes: true });
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM') throw fullDiskAccessError(db);
    throw err;
  }
  for (const machine of machines) {
    if (!machine.isDirectory() || machine.name.startsWith('.')) continue;
    const mdir = path.join(db, machine.name);
    for (const ent of fs.readdirSync(mdir, { withFileTypes: true })) {
      if (!ent.isDirectory() || !DATE_RE.test(ent.name)) continue;
      snaps.push({
        machine: machine.name,
        name: ent.name,
        apfsName: null,
        takenAt: parseSnapshotDate(ent.name),
        root: path.join(mdir, ent.name),
      });
    }
  }
  return snaps.sort((a, b) => a.name.localeCompare(b.name) || a.machine.localeCompare(b.machine));
}

/**
 * macOS privacy protection (TCC) blocks reading Time Machine data unless the
 * app running tmphotos has Full Disk Access.
 *
 * @param {string} p
 * @param {unknown} [cause]
 */
export function fullDiskAccessError(p, cause) {
  return new Error(
    `macOS blocked access to ${p} ("Operation not permitted"). Time Machine backups and the ` +
      'disk devices they attach as are protected: give the app you run tmphotos from ' +
      '(Terminal, iTerm, VS Code, …) Full Disk Access in System Settings → Privacy & Security ' +
      '→ Full Disk Access, then quit and reopen that app.',
    { cause },
  );
}

/** A file only processes with Full Disk Access can open. */
export const FDA_PROBE = '/Library/Application Support/com.apple.TCC/TCC.db';

/**
 * Best-effort check that this process has Full Disk Access. Returns false
 * only on a definite "Operation not permitted"; any other outcome (e.g. the
 * probe file is missing on some macOS version) counts as "probably fine".
 *
 * @param {string} [probe]
 */
export function hasFullDiskAccess(probe = FDA_PROBE) {
  try {
    fs.closeSync(fs.openSync(probe, 'r'));
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code !== 'EPERM';
  }
}

/** Throw the Full Disk Access explanation if the preflight check fails. */
export function assertFullDiskAccess() {
  if (process.env.TMPHOTOS_SKIP_FDA_CHECK) return;
  if (!hasFullDiskAccess()) throw fullDiskAccessError('Time Machine backup data');
}

/**
 * APFS: one APFS snapshot per backup, named com.apple.TimeMachine.<date>.backup
 *
 * @param {string} volumeDev
 * @returns {Promise<Snapshot[]>}
 */
export async function listApfsSnapshots(volumeDev) {
  const out = await runPlist('diskutil', ['apfs', 'listSnapshots', '-plist', volumeDev]);
  return parseApfsSnapshotList(out);
}

/**
 * @param {any} plist output of `diskutil apfs listSnapshots -plist`
 * @returns {Snapshot[]}
 */
export function parseApfsSnapshotList(plist) {
  /** @type {Snapshot[]} */
  const snaps = [];
  for (const s of plist.Snapshots ?? []) {
    const m = APFS_SNAP_RE.exec(s.SnapshotName ?? '');
    if (!m) continue;
    snaps.push({
      machine: '',
      name: m[1],
      apfsName: s.SnapshotName,
      takenAt: parseSnapshotDate(m[1]),
      root: null,
    });
  }
  return snaps.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Parse `mount` output for mounted APFS snapshots: "<snap>@/dev/diskNsM on <path> (...)".
 *
 * @param {string} text
 * @returns {{ snapshot: string, device: string, mountPoint: string }[]}
 */
export function parseSnapshotMounts(text) {
  const result = [];
  for (const line of text.split('\n')) {
    const m = /^(.+?)@(\/dev\/\S+) on (.+) \([^)]*\)$/.exec(line);
    if (m) result.push({ snapshot: m[1], device: m[2], mountPoint: m[3] });
  }
  return result;
}

/**
 * Find the directory inside a mounted APFS snapshot that mirrors the HFS+
 * snapshot layout (contains the backed-up volume folders).
 *
 * @param {string} mountPoint
 * @param {string} name  YYYY-MM-DD-HHMMSS
 */
export function apfsSnapshotRoot(mountPoint, name) {
  const preferred = path.join(mountPoint, `${name}.backup`);
  if (fs.existsSync(preferred)) return preferred;
  const dirs = fs
    .readdirSync(mountPoint, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /\.(backup|previous|interrupted)$/.test(d.name));
  if (dirs.length === 1) return path.join(mountPoint, dirs[0].name);
  return mountPoint;
}

/**
 * Mount one APFS snapshot read-only (or reuse an existing mount).
 *
 * @param {Attachment} att
 * @param {Snapshot} snap
 * @returns {Promise<{ root: string, mountPoint: string, mountedByUs: boolean }>}
 */
export async function mountApfsSnapshot(att, snap) {
  if (!snap.apfsName) throw new Error(`Snapshot ${snap.name} has no APFS name`);
  const { stdout } = await run('mount', []);
  const existing = parseSnapshotMounts(stdout).find(
    (m) => m.snapshot === snap.apfsName && m.device === att.volumeDev,
  );
  if (existing) {
    return {
      root: apfsSnapshotRoot(existing.mountPoint, snap.name),
      mountPoint: existing.mountPoint,
      mountedByUs: false,
    };
  }
  const dir = path.join(bundleMountDir(att.bundle.path), 'snapshots', snap.name);
  fs.mkdirSync(dir, { recursive: true });
  try {
    await run('mount_apfs', ['-o', 'rdonly,nobrowse', '-s', snap.apfsName, att.volumeDev, dir]);
  } catch (err) {
    if (err instanceof CommandError && /not permitted|permission denied/i.test(err.stderr)) {
      throw new Error(
        `macOS refused to mount APFS snapshot ${snap.apfsName} (${err.stderr.trim()}). ` +
          'Grant your terminal Full Disk Access, or re-run this command with sudo.',
        { cause: err },
      );
    }
    throw err;
  }
  return { root: apfsSnapshotRoot(dir, snap.name), mountPoint: dir, mountedByUs: true };
}

/** @param {string} mountPoint */
export async function unmountPath(mountPoint) {
  // diskutil goes through DiskArbitration, which can unmount where a plain
  // umount(2) is refused.
  const r = await run('diskutil', ['unmount', mountPoint], { allowFailure: true });
  if (r.code !== 0) await run('umount', [mountPoint]);
  try {
    fs.rmdirSync(mountPoint);
  } catch {
    // ignore: directory may be in use or not ours
  }
}

/**
 * Unmount any snapshot mounts we created, then detach the image.
 *
 * @param {DatabaseSync} db
 * @param {string} bundleArg
 * @param {{ force?: boolean }} [opts]
 */
export async function detach(db, bundleArg, opts = {}) {
  const bundlePath = resolveBundlePath(bundleArg);
  const img = await findAttached(bundlePath);
  const bundle = findBundle(db, bundlePath);
  if (img) {
    const { stdout } = await run('mount', []);
    const devs = new Set(img['system-entities'].map((e) => e['dev-entry']));
    for (const m of parseSnapshotMounts(stdout)) {
      if (devs.has(m.device)) await unmountPath(m.mountPoint);
    }
    const args = ['detach', wholeDevice(img['system-entities'])];
    if (opts.force) args.push('-force');
    await run('hdiutil', args);
  }
  if (bundle) db.prepare('DELETE FROM mounts WHERE bundle_id = ?').run(bundle.id);
  return { detached: Boolean(img) };
}
