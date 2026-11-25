import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { makeJpeg } from './jpeg.js';

export const MACHINE = 'TestMac';
export const SNAP1 = '2011-01-01-100000';
export const SNAP2 = '2011-02-01-100000';
export const HOME = 'Macintosh HD/Users/alice';

/**
 * Create a small HFS+ sparsebundle laid out like a Time Machine network
 * backup with two snapshots. Unchanged files in the second snapshot are hard
 * links to the first, as Time Machine does.
 *
 * @param {string} dir
 * @returns {string} bundle path
 */
export function createTmBundle(dir) {
  const base = path.join(dir, 'TestMac');
  execFileSync('hdiutil', [
    'create',
    '-quiet',
    '-size',
    '32m',
    '-type',
    'SPARSEBUNDLE',
    '-fs',
    'HFS+J',
    '-volname',
    'Time Machine Backups',
    base,
  ]);
  const bundle = `${base}.sparsebundle`;
  const mnt = path.join(dir, 'rw');
  execFileSync('hdiutil', ['attach', '-quiet', '-nobrowse', '-mountroot', mnt, bundle]);
  const vol = path.join(mnt, 'Time Machine Backups');
  try {
    const db = path.join(vol, 'Backups.backupdb', MACHINE);
    const s1 = path.join(db, SNAP1);
    const s2 = path.join(db, SNAP2);
    const pad = 12 * 1024;
    /** @param {string} rel @param {Buffer} data @param {string} [mtime] */
    const put = (rel, data, mtime = '2010-07-04T12:00:00Z') => {
      const p = path.join(s1, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, data);
      const t = new Date(mtime);
      fs.utimesSync(p, t, t);
    };
    const jpg = (/** @type {object} */ o) => makeJpeg({ padTo: pad, ...o });

    put(`${HOME}/Pictures/Hawaii 2010/IMG_0001.jpg`, jpg({ date: '2010:07:04 09:00:00' }));
    put(`${HOME}/Pictures/Hawaii 2010/IMG_0002.jpg`, jpg({ date: '2010:07:05 10:00:00' }));
    put(
      `${HOME}/Pictures/iPhoto Library/Masters/2010/07/04/IMG_0100.jpg`,
      jpg({ make: 'Apple', model: 'iPhone 4', date: '2010:07:04 18:00:00' }),
    );
    put(
      `${HOME}/Pictures/iPhoto Library/Modified/2010/07/04/IMG_0100.jpg`,
      jpg({ make: 'Apple', model: 'iPhone 4', date: '2010:07:04 18:00:00' }),
    );
    put(`${HOME}/Pictures/iPhoto Library/Data/2010/IMG_0100.jpg`, jpg({})); // thumbnail: skipped
    put(`${HOME}/Library/Caches/cached.jpg`, jpg({})); // skipped
    put('Macintosh HD/Applications/Foo.app/Contents/Resources/icon.png', Buffer.alloc(pad)); // skipped
    put(`${HOME}/Desktop/tiny.png`, Buffer.alloc(100)); // below --min-size
    put(`${HOME}/Movies/clip.mov`, crypto.randomBytes(pad)); // video
    put(`${HOME}/Documents/notes.txt`, Buffer.alloc(pad)); // not media
    put(`${HOME}/Pictures/._IMG_0001.jpg`, Buffer.alloc(pad)); // AppleDouble: skipped

    // Snapshot 2: hard-link everything, then change things.
    linkTree(s1, s2);
    fs.rmSync(path.join(s2, `${HOME}/Pictures/Hawaii 2010/IMG_0002.jpg`));
    const p2 = path.join(s2, `${HOME}/Pictures/Hawaii 2010/IMG_0002.jpg`);
    fs.writeFileSync(p2, jpg({ date: '2010:07:05 10:00:00', model: 'Canon PowerShot S95 edit' }));
    fs.utimesSync(p2, new Date('2011-01-15T00:00:00Z'), new Date('2011-01-15T00:00:00Z'));
    const p3 = path.join(s2, `${HOME}/Pictures/Ski 2011/DSC_0001.jpg`);
    fs.mkdirSync(path.dirname(p3), { recursive: true });
    fs.writeFileSync(
      p3,
      jpg({ make: 'NIKON CORPORATION', model: 'NIKON D90', date: '2011:01:20 11:00:00' }),
    );
    fs.symlinkSync(SNAP2, path.join(db, 'Latest'));
  } finally {
    execFileSync('hdiutil', ['detach', '-quiet', vol]);
  }
  return bundle;
}

/** Recreate `src` under `dest` with directories copied and files hard-linked. */
function linkTree(/** @type {string} */ src, /** @type {string} */ dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, ent.name);
    const b = path.join(dest, ent.name);
    if (ent.isDirectory()) linkTree(a, b);
    else fs.linkSync(a, b);
  }
}

/**
 * Fingerprint every file in a bundle (content hash + size + mtime) so tests
 * can prove the source was never modified.
 *
 * @param {string} bundle
 */
export function fingerprint(bundle) {
  /** @type {string[]} */
  const lines = [];
  const walk = (/** @type {string} */ d) => {
    for (const ent of fs
      .readdirSync(d, { withFileTypes: true })
      .sort((x, y) => (x.name < y.name ? -1 : 1))) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else {
        const st = fs.statSync(p);
        const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
        lines.push(`${path.relative(bundle, p)} ${st.size} ${st.mtimeMs} ${h}`);
      }
    }
  };
  walk(bundle);
  return lines.join('\n');
}
