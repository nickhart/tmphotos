import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  apfsSnapshotRoot,
  findBundles,
  listHfsSnapshots,
  parseApfsSnapshotList,
  parseSnapshotDate,
  parseSnapshotMounts,
  pickVolume,
} from '../src/mount.js';

test('parseSnapshotDate', () => {
  assert.equal(parseSnapshotDate('2012-03-04-051617'), '2012-03-04T05:16:17');
  assert.equal(parseSnapshotDate('Latest'), null);
  assert.equal(parseSnapshotDate('2012-03-04-051617.inProgress'), null);
});

test('pickVolume handles HFS+ sparsebundle output', () => {
  const v = pickVolume([
    { 'content-hint': 'GUID_partition_scheme', 'dev-entry': '/dev/disk44' },
    {
      'content-hint': 'Apple_HFS',
      'dev-entry': '/dev/disk44s1',
      'mount-point': '/x/Time Machine Backups',
      'volume-kind': 'hfs',
    },
  ]);
  assert.deepEqual(v, {
    device: '/dev/disk44',
    volumeDev: '/dev/disk44s1',
    mountPoint: '/x/Time Machine Backups',
    format: 'hfs',
  });
});

test('pickVolume handles APFS output with a synthesized container', () => {
  const v = pickVolume([
    { 'content-hint': 'GUID_partition_scheme', 'dev-entry': '/dev/disk8' },
    { 'content-hint': '7C3457EF-0000-11AA-AA11-00306543ECAC', 'dev-entry': '/dev/disk8s1' },
    { 'content-hint': '41504653-0000-11AA-AA11-00306543ECAC', 'dev-entry': '/dev/disk9' },
    {
      'dev-entry': '/dev/disk9s1',
      'mount-point': '/x/Backups of Mac',
      'volume-kind': 'apfs',
    },
  ]);
  assert.equal(v.device, '/dev/disk8');
  assert.equal(v.volumeDev, '/dev/disk9s1');
  assert.equal(v.format, 'apfs');
});

test('pickVolume rejects images with no usable volume', () => {
  assert.throws(() => pickVolume([{ 'dev-entry': '/dev/disk3' }]), /No HFS\+ or APFS volume/);
});

test('parseApfsSnapshotList keeps Time Machine snapshots, sorted', () => {
  const snaps = parseApfsSnapshotList({
    Snapshots: [
      { SnapshotName: 'com.apple.TimeMachine.2022-05-01-101010.backup' },
      { SnapshotName: 'com.apple.os.update-ABC' },
      { SnapshotName: 'com.apple.TimeMachine.2021-01-02-030405.backup' },
    ],
  });
  assert.deepEqual(
    snaps.map((s) => [s.name, s.takenAt, s.apfsName]),
    [
      [
        '2021-01-02-030405',
        '2021-01-02T03:04:05',
        'com.apple.TimeMachine.2021-01-02-030405.backup',
      ],
      [
        '2022-05-01-101010',
        '2022-05-01T10:10:10',
        'com.apple.TimeMachine.2022-05-01-101010.backup',
      ],
    ],
  );
});

test('parseSnapshotMounts reads `mount` output', () => {
  const text = [
    '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
    'com.apple.TimeMachine.2021-01-02-030405.backup@/dev/disk9s1 on /Volumes/.timemachine/ABC/2021-01-02-030405.backup (apfs, local, nodev, nosuid, read-only, journaled, nobrowse)',
  ].join('\n');
  assert.deepEqual(parseSnapshotMounts(text), [
    {
      snapshot: 'com.apple.TimeMachine.2021-01-02-030405.backup',
      device: '/dev/disk9s1',
      mountPoint: '/Volumes/.timemachine/ABC/2021-01-02-030405.backup',
    },
  ]);
});

test('listHfsSnapshots finds dated folders per machine and ignores Latest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tmphotos-hfs-'));
  try {
    for (const p of [
      'Backups.backupdb/MacA/2010-01-01-000000/HD',
      'Backups.backupdb/MacA/2010-02-01-000000/HD',
      'Backups.backupdb/MacA/2010-03-01-000000.inProgress',
      'Backups.backupdb/MacB/2009-12-31-235959/HD',
    ]) {
      fs.mkdirSync(path.join(root, p), { recursive: true });
    }
    fs.symlinkSync('2010-02-01-000000', path.join(root, 'Backups.backupdb/MacA/Latest'));
    const snaps = listHfsSnapshots(root);
    assert.deepEqual(
      snaps.map((s) => `${s.machine}/${s.name}`),
      ['MacB/2009-12-31-235959', 'MacA/2010-01-01-000000', 'MacA/2010-02-01-000000'],
    );
    assert.equal(snaps[1].root, path.join(root, 'Backups.backupdb/MacA/2010-01-01-000000'));
    assert.throws(() => listHfsSnapshots(path.join(root, 'nope')), /No Backups\.backupdb/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('apfsSnapshotRoot descends into the <date>.backup folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tmphotos-apfs-'));
  try {
    fs.mkdirSync(path.join(root, '2021-01-02-030405.backup', 'Macintosh HD - Data'), {
      recursive: true,
    });
    assert.equal(
      apfsSnapshotRoot(root, '2021-01-02-030405'),
      path.join(root, '2021-01-02-030405.backup'),
    );
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'tmphotos-apfs-'));
    fs.mkdirSync(path.join(other, 'Macintosh HD'));
    assert.equal(apfsSnapshotRoot(other, '2021-01-02-030405'), other);
    fs.rmSync(other, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findBundles lists only bundles', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tmphotos-share-'));
  try {
    fs.mkdirSync(path.join(root, 'Old Mac.sparsebundle'));
    fs.mkdirSync(path.join(root, 'New Mac.backupbundle'));
    fs.mkdirSync(path.join(root, 'Other'));
    fs.writeFileSync(path.join(root, 'x.sparsebundle.txt'), '');
    assert.deepEqual(
      findBundles(root).map((p) => path.basename(p)),
      ['New Mac.backupbundle', 'Old Mac.sparsebundle'],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('isPermissionError recognises EPERM and "Operation not permitted" output', async () => {
  const { isPermissionError } = await import('../src/mount.js');
  const { CommandError } = await import('../src/exec.js');
  assert.ok(isPermissionError(Object.assign(new Error('x'), { code: 'EPERM' })));
  assert.ok(
    isPermissionError(
      new CommandError('mount_hfs', [], 1, '', 'mount_hfs: Operation not permitted'),
    ),
  );
  assert.ok(!isPermissionError(new CommandError('mount_hfs', [], 1, '', 'Invalid argument')));
  assert.ok(!isPermissionError(Object.assign(new Error('x'), { code: 'ENOENT' })));
});

test('hasFullDiskAccess only reports false on EPERM', async () => {
  const { hasFullDiskAccess, fullDiskAccessError } = await import('../src/mount.js');
  assert.equal(hasFullDiskAccess(path.join(os.tmpdir(), 'tmphotos-no-such-file')), true);
  assert.equal(hasFullDiskAccess(fs.realpathSync(os.tmpdir())), true);
  assert.match(fullDiskAccessError('x').message, /Full Disk Access/);
});
