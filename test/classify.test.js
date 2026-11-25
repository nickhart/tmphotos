import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFile,
  globToRegExp,
  libraryKind,
  libraryRole,
  shouldSkipDir,
} from '../src/classify.js';

test('classifyFile recognises images, RAW and video case-insensitively', () => {
  assert.deepEqual(classifyFile('IMG_0001.JPG'), { ext: 'jpg', kind: 'image' });
  assert.deepEqual(classifyFile('photo.heic'), { ext: 'heic', kind: 'image' });
  assert.deepEqual(classifyFile('DSC_1.NEF'), { ext: 'nef', kind: 'raw' });
  assert.deepEqual(classifyFile('clip.MOV'), { ext: 'mov', kind: 'video' });
  assert.equal(classifyFile('clip.mov', { videos: false }), null);
  assert.equal(classifyFile('notes.txt'), null);
  assert.equal(classifyFile('README'), null);
  assert.equal(classifyFile('._IMG_0001.jpg'), null, 'AppleDouble files are ignored');
  assert.equal(classifyFile('IMG_0001.AAE'), null, 'edit sidecars are not photos');
});

test('libraryKind detects Photos, iPhoto and Aperture libraries', () => {
  assert.equal(libraryKind('Photos Library.photoslibrary'), 'photos');
  assert.equal(libraryKind('iPhoto Library.photolibrary'), 'iphoto');
  assert.equal(libraryKind('iPhoto Library'), 'iphoto');
  assert.equal(libraryKind('iPhoto Library.migratedphotolibrary'), 'iphoto');
  assert.equal(libraryKind('Aperture Library.aplibrary'), 'aperture');
  assert.equal(libraryKind('Pictures'), null);
});

test('shouldSkipDir skips system folders, ~/Library, bundles and caches', () => {
  const skip = (/** @type {string} */ p, opts = {}) => shouldSkipDir(p.split('/'), opts);
  assert.equal(skip('Macintosh HD/System'), true);
  assert.equal(skip('Macintosh HD/Applications'), true);
  assert.equal(skip('Macintosh HD/Library'), true);
  assert.equal(skip('Macintosh HD/Users'), false);
  assert.equal(skip('Macintosh HD/Users/alice/Library'), true);
  assert.equal(skip('Macintosh HD/Users/alice/Pictures'), false);
  assert.equal(skip('Macintosh HD/Users/alice/Code/app/node_modules'), true);
  assert.equal(skip('Macintosh HD/Users/alice/Downloads/Foo.app'), true);
  assert.equal(skip('Macintosh HD/Users/alice/Dropbox/.dropbox.cache'), true);
  assert.equal(skip('Macintosh HD/Users/alice/Library', { includeSystem: true }), false);
  assert.equal(skip('Macintosh HD/System', { includeSystem: true }), false);
  assert.equal(
    skip('Macintosh HD/Users/alice/Pictures/junk', { excludes: [globToRegExp('**/junk')] }),
    true,
  );
});

test('shouldSkipDir inside a library skips thumbnails and databases only', () => {
  const inLib = (/** @type {string} */ p) => shouldSkipDir(p.split('/'), { insideLibrary: true });
  assert.equal(inLib('Masters'), false);
  assert.equal(inLib('originals'), false);
  assert.equal(inLib('Thumbnails'), true);
  assert.equal(inLib('Data'), true);
  assert.equal(inLib('database'), true);
  assert.equal(inLib('resources/derivatives'), true);
  assert.equal(inLib('resources/renders'), false);
});

test('libraryRole marks edited versions', () => {
  assert.equal(libraryRole(['Masters', '2010', 'a.jpg']), 'original');
  assert.equal(libraryRole(['originals', 'A', 'x.heic']), 'original');
  assert.equal(libraryRole(['Modified', '2010', 'a.jpg']), 'edited');
  assert.equal(libraryRole(['resources', 'renders', 'A', 'x.jpeg']), 'edited');
  assert.equal(libraryRole(['resources', 'media', 'version', 'x.jpg']), 'edited');
});

test('globToRegExp', () => {
  assert.ok(globToRegExp('**/Caches').test('Macintosh HD/Users/a/Caches'));
  assert.ok(globToRegExp('**/Caches').test('Caches'));
  assert.ok(!globToRegExp('**/Caches').test('Macintosh HD/MyCaches'));
  assert.ok(globToRegExp('Macintosh HD/Users/*/Music').test('Macintosh HD/Users/bob/Music'));
  assert.ok(!globToRegExp('Macintosh HD/Users/*/Music').test('Macintosh HD/Users/bob/x/Music'));
  assert.ok(globToRegExp('*.photoslibrary').test('Photos Library.photoslibrary'));
  assert.ok(globToRegExp('a/b?').test('a/bc'));
  assert.ok(
    globToRegExp('weird (1)+[x]').test('weird (1)+[x]'),
    'regex metacharacters are literal',
  );
});
