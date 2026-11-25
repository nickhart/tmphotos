import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.TMPHOTOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tmphotos-home-'));

const { openDb, upsertBundle } = await import('../src/db.js');
const { buildGroups, renderReport, normalizeCamera, formatBytes } =
  await import('../src/report.js');
const { parseSelection, selectFiles, copyVerified, assertSafeTarget, sha256File } =
  await import('../src/extract.js');
const { parseSize } = await import('../src/cli.js');

/** Seed an in-memory index with a few files. */
function seed() {
  const db = openDb(':memory:');
  const b = upsertBundle(db, '/share/Old Mac.sparsebundle', { format: 'hfs', volumeUuid: 'U1' });
  db.prepare(
    "INSERT INTO snapshots (id, bundle_id, machine, name, status) VALUES (1, ?, 'Mac', '2010-01-01-000000', 'done')",
  ).run(b.id);
  db.prepare(
    "INSERT INTO libraries (id, bundle_id, relpath, kind, first_snapshot_id) VALUES (1, ?, 'HD/Users/a/Pictures/iPhoto Library', 'iphoto', 1)",
  ).run(b.id);
  const ins = db.prepare(
    `INSERT INTO files (bundle_id, ino, size, mtime_ms, relpath, folder, name, ext, kind,
       library_id, role, first_snapshot_id, exif_date, camera_make, camera_model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  );
  const rows = [
    [
      1,
      1000,
      1262304000000,
      'HD/Users/a/Pictures/Trip/a.jpg',
      'image',
      null,
      null,
      '2009-12-01T10:00:00',
      'Canon',
      'Canon EOS 5D',
    ],
    [
      2,
      2000,
      1262390400000,
      'HD/Users/a/Pictures/Trip/b.jpg',
      'image',
      null,
      null,
      '2009-12-03T10:00:00',
      'Canon',
      'Canon EOS 5D',
    ],
    [
      3,
      5000,
      1262390400000,
      'HD/Users/a/Pictures/Trip/c.mov',
      'video',
      null,
      null,
      null,
      null,
      null,
    ],
    [
      4,
      3000,
      1262390400000,
      'HD/Users/a/Pictures/Trip_2/d.jpg',
      'image',
      null,
      null,
      null,
      null,
      null,
    ],
    [
      5,
      4000,
      1262390400000,
      'HD/Users/a/Pictures/iPhoto Library/Masters/2009/e.jpg',
      'image',
      1,
      'original',
      '2009-06-01T00:00:00',
      'Apple',
      'iPhone 3GS',
    ],
    [
      6,
      4100,
      1262390400000,
      'HD/Users/a/Pictures/iPhoto Library/Modified/2009/e.jpg',
      'image',
      1,
      'edited',
      null,
      null,
      null,
    ],
  ];
  for (const [ino, size, mtime, rel, kind, lib, role, exif, make, model] of rows) {
    const relpath = /** @type {string} */ (rel);
    ins.run(
      b.id,
      ino,
      size,
      mtime,
      relpath,
      path.dirname(relpath),
      path.basename(relpath),
      path.extname(relpath).slice(1),
      kind,
      lib,
      role,
      exif,
      make,
      model,
    );
  }
  return { db, bundle: b };
}

test('upsertBundle matches a moved share by volume UUID', () => {
  const db = openDb(':memory:');
  const a = upsertBundle(db, '/Volumes/Backups/Mac.sparsebundle', {
    format: 'hfs',
    volumeUuid: 'X',
  });
  const b = upsertBundle(db, '/Volumes/Backups-1/Mac.sparsebundle', { volumeUuid: 'X' });
  assert.equal(a.id, b.id);
  assert.equal(b.path, '/Volumes/Backups-1/Mac.sparsebundle');
  assert.equal(b.format, 'hfs');
  const c = upsertBundle(db, '/Volumes/Backups/Other.sparsebundle', { volumeUuid: 'Y' });
  assert.notEqual(c.id, a.id);
});

test('buildGroups groups by folder and by library', () => {
  const { db } = seed();
  const groups = buildGroups(db);
  const byPath = Object.fromEntries(groups.map((g) => [g.path, g]));
  const trip = byPath['HD/Users/a/Pictures/Trip'];
  assert.equal(trip.type, 'folder');
  assert.equal(trip.files, 3);
  assert.equal(trip.images, 2);
  assert.equal(trip.videos, 1);
  assert.equal(trip.bytes, 8000);
  assert.equal(trip.exifMin, '2009-12-01T10:00:00');
  assert.equal(trip.exifMax, '2009-12-03T10:00:00');
  assert.deepEqual(trip.cameras, { 'Canon EOS 5D': 2 });
  const lib = byPath['HD/Users/a/Pictures/iPhoto Library'];
  assert.equal(lib.type, 'library');
  assert.equal(lib.libraryKind, 'iphoto');
  assert.equal(lib.files, 2);
  assert.equal(lib.edited, 1);
  assert.equal(groups.length, 3);
});

test('renderReport produces self-contained HTML with escaped data', () => {
  const { db } = seed();
  db.prepare(
    `INSERT INTO files (bundle_id, ino, size, mtime_ms, relpath, folder, name, ext, kind, first_snapshot_id)
     VALUES (1, 99, 10, 0, 'HD/</script><b>x/y.jpg', 'HD/</script><b>x', 'y.jpg', 'jpg', 'image', 1)`,
  ).run();
  const html = renderReport(db, { generatedAt: new Date('2026-01-01T00:00:00Z') });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Old Mac\.sparsebundle/);
  assert.match(html, /iPhoto Library/);
  assert.ok(!html.includes('</script><b>'), 'path cannot break out of the script tag');
  assert.ok(!/<script[^>]+src=/.test(html), 'no external scripts');
});

test('normalizeCamera and formatBytes', () => {
  assert.equal(normalizeCamera('Canon Canon EOS 5D'), 'Canon EOS 5D');
  assert.equal(normalizeCamera('NIKON CORPORATION NIKON D90'), 'NIKON CORPORATION NIKON D90');
  assert.equal(normalizeCamera('Apple iPhone 4'), 'Apple iPhone 4');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1500), '1.50 KB');
  assert.equal(formatBytes(2_500_000_000), '2.50 GB');
});

test('parseSize', () => {
  assert.equal(parseSize('10k'), 10240);
  assert.equal(parseSize('1M'), 1048576);
  assert.equal(parseSize('512'), 512);
  assert.equal(parseSize('1.5kb'), 1536);
  assert.throws(() => parseSize('lots'));
});

test('parseSelection and selectFiles use folder prefixes', () => {
  const { db, bundle } = seed();
  const sel = parseSelection(
    '# comment\nOld Mac.sparsebundle\tHD/Users/a/Pictures/Trip\n\nOther.sparsebundle\tHD\nHD/Users/a/Pictures/iPhoto Library/\n',
  );
  assert.deepEqual(sel, [
    { bundle: 'Old Mac.sparsebundle', prefix: 'HD/Users/a/Pictures/Trip' },
    { bundle: 'Other.sparsebundle', prefix: 'HD' },
    { bundle: null, prefix: 'HD/Users/a/Pictures/iPhoto Library' },
  ]);
  const files = selectFiles(db, bundle.id, bundle.name, sel);
  // Trip (3) + library (2); "Trip_2" is not inside "Trip"; Other bundle ignored.
  assert.deepEqual(files.map((f) => f.name).sort(), ['a.jpg', 'b.jpg', 'c.mov', 'e.jpg', 'e.jpg']);
  assert.equal(selectFiles(db, bundle.id, bundle.name, sel, { originalsOnly: true }).length, 4);
  assert.equal(selectFiles(db, bundle.id, bundle.name, sel, { videos: false }).length, 4);
  // LIKE wildcards in a prefix are literal.
  assert.equal(
    selectFiles(db, bundle.id, bundle.name, [{ bundle: null, prefix: 'HD/Users/a/Pictures/Tri_' }])
      .length,
    0,
  );
});

test('copyVerified copies, verifies and preserves mtime and creation date', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmphotos-copy-'));
  try {
    const src = path.join(dir, 'src.jpg');
    const data = crypto.randomBytes(200_000);
    fs.writeFileSync(src, data);
    const mtime = new Date('2008-05-06T07:08:09Z');
    fs.utimesSync(src, mtime, mtime);
    const st = fs.statSync(src);
    const dest = path.join(dir, 'out', 'nested', 'dest.jpg');
    const hash = await copyVerified(src, dest, st);
    assert.equal(hash, crypto.createHash('sha256').update(data).digest('hex'));
    assert.equal(await sha256File(dest), hash);
    const dst = fs.statSync(dest);
    assert.equal(Math.floor(dst.mtimeMs / 1000), Math.floor(mtime.getTime() / 1000));
    if (process.platform === 'darwin') {
      assert.ok(dst.birthtimeMs <= st.mtimeMs, 'creation date moved back to the original');
    }
    assert.ok(!fs.existsSync(`${dest}.tmphotos-partial`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assertSafeTarget refuses paths inside the source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmphotos-safe-'));
  try {
    const bundle = path.join(dir, 'Mac.sparsebundle');
    fs.mkdirSync(bundle);
    assert.throws(() => assertSafeTarget(path.join(bundle, 'out'), [bundle]), /Refusing/);
    assert.throws(() => assertSafeTarget(bundle, [bundle]), /Refusing/);
    assert.ok(assertSafeTarget(path.join(dir, 'restore'), [bundle]));
    assert.ok(assertSafeTarget(path.join(dir, 'Mac.sparsebundle-restore'), [bundle]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
