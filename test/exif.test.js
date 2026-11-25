import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeExifDate, readExif } from '../src/exif.js';
import { makeJpeg } from './helpers/jpeg.js';

test('normalizeExifDate', () => {
  assert.equal(normalizeExifDate('2009:07:04 12:34:56'), '2009-07-04T12:34:56');
  assert.equal(normalizeExifDate('2009-07-04T12:34:56+02:00'), '2009-07-04T12:34:56');
  assert.equal(normalizeExifDate('0000:00:00 00:00:00'), null);
  assert.equal(normalizeExifDate('garbage'), null);
  assert.equal(normalizeExifDate(undefined), null);
  assert.equal(normalizeExifDate(new Date('2001-02-03T04:05:06Z')), '2001-02-03T04:05:06');
});

test('readExif reads date and camera from a JPEG', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmphotos-exif-'));
  try {
    const file = path.join(dir, 'a.jpg');
    fs.writeFileSync(
      file,
      makeJpeg({ make: 'NIKON CORPORATION', model: 'NIKON D90', date: '2011:01:20 11:00:00' }),
    );
    assert.deepEqual(await readExif(file, 'jpg'), {
      status: 'ok',
      date: '2011-01-20T11:00:00',
      make: 'NIKON CORPORATION',
      model: 'NIKON D90',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readExif tolerates files without metadata and skips videos', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmphotos-exif-'));
  try {
    const file = path.join(dir, 'b.jpg');
    fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const r = await readExif(file, 'jpg');
    assert.equal(r.date, null);
    assert.ok(['none', 'error'].includes(r.status));
    assert.equal((await readExif(file, 'mov')).status, 'skipped');
    assert.equal((await readExif(path.join(dir, 'missing.jpg'), 'jpg')).status, 'error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
