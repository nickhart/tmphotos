// integration: exercises real hdiutil attach/detach against a generated
// Time Machine-style sparsebundle. macOS only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const isMac = process.platform === 'darwin';
const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tmphotos-it-'));
process.env.TMPHOTOS_HOME = path.join(work, 'home');

const { openDb } = await import('../src/db.js');
const { attach, detach, findAttached, listSnapshots, wholeDevice } =
  await import('../src/mount.js');
const { scanBundle, scanSnapshot, registerSnapshots } = await import('../src/scan.js');
const { buildGroups, renderReport } = await import('../src/report.js');
const { selectFiles, extractFiles, sha256File } = await import('../src/extract.js');
const { createTmBundle, fingerprint, HOME, SNAP1, SNAP2 } = await import('./helpers/fixture.js');

/** @type {string} */
let bundle;
/** @type {string} */
let before_;

before(() => {
  if (!isMac) return;
  bundle = createTmBundle(work);
  before_ = fingerprint(bundle);
});

after(async () => {
  const img = isMac && bundle ? await findAttached(fs.realpathSync(bundle)) : undefined;
  if (img) {
    execFileSync('hdiutil', ['detach', '-force', '-quiet', wholeDevice(img['system-entities'])], {
      stdio: 'ignore',
    });
  }
  fs.rmSync(work, { recursive: true, force: true });
});

test('integration: mount, scan, report, extract, unmount', { skip: !isMac }, async (t) => {
  const db = openDb(path.join(work, 'index.sqlite'));

  const att = await attach(db, bundle);
  await t.test('attaches read-only', () => {
    assert.equal(att.format, 'hfs');
    assert.ok(att.mountPoint && fs.existsSync(att.mountPoint));
    assert.throws(
      () => fs.writeFileSync(path.join(/** @type {string} */ (att.mountPoint), 'x'), ''),
      {
        code: 'EROFS',
      },
    );
  });

  await t.test('lists both snapshots', async () => {
    const snaps = await listSnapshots(att);
    assert.deepEqual(
      snaps.map((s) => s.name),
      [SNAP1, SNAP2],
    );
  });

  await t.test('an interrupted snapshot scan is resumed', async () => {
    const [s1] = registerSnapshots(db, att.bundle.id, await listSnapshots(att));
    const ac = new AbortController();
    ac.abort();
    const r = await scanSnapshot(db, att, s1, /** @type {string} */ (s1.root), {
      signal: ac.signal,
    });
    assert.equal(r.finished, false);
    const row = /** @type {any} */ (
      db.prepare('SELECT status FROM snapshots WHERE id = ?').get(s1.id)
    );
    assert.equal(row.status, 'scanning');
  });

  await t.test('scan counts each unique file once', async () => {
    const res = await scanBundle(db, att, { only: [SNAP1] });
    assert.equal(res.scanned.length, 1);
    assert.equal(res.scanned[0].filesNew, 5);
    const res2 = await scanBundle(db, att, {});
    assert.equal(res2.scanned.length, 1, 'first snapshot is not rescanned');
    assert.equal(res2.scanned[0].snapshot, SNAP2);
    assert.equal(res2.scanned[0].filesNew, 2, 'only the changed IMG_0002 and new DSC_0001');
    assert.equal(res2.scanned[0].filesSeen, 6);
    const res3 = await scanBundle(db, att, {});
    assert.equal(res3.scanned.length, 0, 'nothing left to scan');

    const names = /** @type {any[]} */ (
      db.prepare('SELECT relpath FROM files ORDER BY relpath').all()
    ).map((r) => r.relpath);
    assert.deepEqual(names, [
      `${HOME}/Movies/clip.mov`,
      `${HOME}/Pictures/Hawaii 2010/IMG_0001.jpg`,
      `${HOME}/Pictures/Hawaii 2010/IMG_0002.jpg`,
      `${HOME}/Pictures/Hawaii 2010/IMG_0002.jpg`,
      `${HOME}/Pictures/Ski 2011/DSC_0001.jpg`,
      `${HOME}/Pictures/iPhoto Library/Masters/2010/07/04/IMG_0100.jpg`,
      `${HOME}/Pictures/iPhoto Library/Modified/2010/07/04/IMG_0100.jpg`,
    ]);
  });

  await t.test('EXIF, libraries and roles are recorded', () => {
    const nikon = /** @type {any} */ (
      db.prepare("SELECT * FROM files WHERE name = 'DSC_0001.jpg'").get()
    );
    assert.equal(nikon.exif_date, '2011-01-20T11:00:00');
    assert.equal(nikon.camera_model, 'NIKON D90');
    const libs = /** @type {any[]} */ (db.prepare('SELECT * FROM libraries').all());
    assert.equal(libs.length, 1);
    assert.equal(libs[0].kind, 'iphoto');
    const roles = /** @type {any[]} */ (
      db
        .prepare(
          'SELECT role, COUNT(*) n FROM files WHERE library_id IS NOT NULL GROUP BY role ORDER BY role',
        )
        .all()
    ).map((r) => `${r.role}:${r.n}`);
    assert.deepEqual(roles, ['edited:1', 'original:1']);
  });

  await t.test('report groups folders', () => {
    const groups = buildGroups(db);
    const hawaii = groups.find((g) => g.path === `${HOME}/Pictures/Hawaii 2010`);
    assert.equal(hawaii?.files, 3);
    assert.match(renderReport(db), /Hawaii 2010/);
  });

  await t.test('extract copies, verifies and preserves mtimes', async () => {
    const target = path.join(work, 'restore');
    const files = selectFiles(db, att.bundle.id, att.bundle.name, [
      { bundle: null, prefix: `${HOME}/Pictures/Hawaii 2010` },
    ]);
    assert.equal(files.length, 3);
    const res = await extractFiles(db, att, files, { target });
    assert.equal(res.copied, 3);
    assert.equal(res.failed, 0);
    const outDir = path.join(target, 'TestMac', HOME, 'Pictures', 'Hawaii 2010');
    assert.deepEqual(fs.readdirSync(outDir).sort(), [
      'IMG_0001.jpg',
      'IMG_0002 (1).jpg',
      'IMG_0002.jpg',
    ]);
    const one = fs.statSync(path.join(outDir, 'IMG_0001.jpg'));
    assert.equal(one.mtime.toISOString(), '2010-07-04T12:00:00.000Z');
    const src = path.join(
      /** @type {string} */ (att.mountPoint),
      'Backups.backupdb',
      'TestMac',
      SNAP1,
      HOME,
      'Pictures',
      'Hawaii 2010',
      'IMG_0001.jpg',
    );
    assert.equal(await sha256File(path.join(outDir, 'IMG_0001.jpg')), await sha256File(src));

    const again = await extractFiles(db, att, files, { target });
    assert.equal(again.copied, 0, 'second run is a no-op');
    assert.equal(again.skipped, 3);
  });

  await t.test('extract refuses to write into the source', async () => {
    const files = selectFiles(db, att.bundle.id, att.bundle.name, [{ bundle: null, prefix: HOME }]);
    await assert.rejects(
      extractFiles(db, att, files, { target: path.join(bundle, 'out') }),
      /Refusing/,
    );
    await assert.rejects(
      extractFiles(db, att, files, { target: /** @type {string} */ (att.mountPoint) }),
      /Refusing/,
    );
  });

  await t.test('detach', async () => {
    const r = await detach(db, bundle);
    assert.equal(r.detached, true);
    assert.equal(await findAttached(fs.realpathSync(bundle)), undefined);
  });

  await t.test('the source bundle is byte-for-byte unchanged', () => {
    assert.equal(fingerprint(bundle), before_);
  });
});
