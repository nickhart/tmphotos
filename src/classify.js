import path from 'node:path';

export const IMAGE_EXTS = new Set(
  'jpg jpeg jpe png gif heic heif tif tiff bmp webp psd jp2'.split(' '),
);
export const RAW_EXTS = new Set(
  'cr2 cr3 crw nef nrw arw srf sr2 dng orf rw2 raf srw pef x3f 3fr erf kdc mrw rwl'.split(' '),
);
export const VIDEO_EXTS = new Set('mov mp4 m4v avi 3gp 3g2 mts m2ts mpg mpeg wmv mkv'.split(' '));

/** Extensions exifr can read capture date / camera from. */
export const EXIF_EXTS = new Set(
  'jpg jpeg jpe heic heif tif tiff png webp cr2 nef arw dng orf rw2 pef srw sr2 nrw raf cr3'.split(
    ' ',
  ),
);

/**
 * @param {string} name file name
 * @param {{ videos?: boolean }} [opts]
 * @returns {{ ext: string, kind: 'image' | 'raw' | 'video' } | null}
 */
export function classifyFile(name, opts = {}) {
  if (name.startsWith('._')) return null; // AppleDouble resource forks
  const ext = path.extname(name).slice(1).toLowerCase();
  if (!ext) return null;
  if (IMAGE_EXTS.has(ext)) return { ext, kind: 'image' };
  if (RAW_EXTS.has(ext)) return { ext, kind: 'raw' };
  if (opts.videos !== false && VIDEO_EXTS.has(ext)) return { ext, kind: 'video' };
  return null;
}

/**
 * Identify photo library packages.
 *
 * @param {string} name directory name
 * @returns {'photos' | 'iphoto' | 'aperture' | null}
 */
export function libraryKind(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.photoslibrary')) return 'photos';
  if (lower.endsWith('.photolibrary') || lower.endsWith('.migratedphotolibrary')) return 'iphoto';
  if (lower === 'iphoto library') return 'iphoto';
  if (lower.endsWith('.aplibrary') || lower === 'aperture library') return 'aperture';
  return null;
}

// Top-level folders of a backed-up volume that never hold user photos.
const SYSTEM_TOP = new Set([
  'system',
  'applications',
  'library',
  'private',
  'usr',
  'bin',
  'sbin',
  'cores',
  'opt',
  'volumes',
  'dev',
  'net',
  'home',
  'etc',
  'tmp',
  'var',
  '.spotlight-v100',
  '.fseventsd',
  '.documentrevisions-v100',
  '.mobilebackups',
  '.vol',
  '.temporaryitems',
  '.pkinstallsandboxmanager',
]);

// Directory names skipped anywhere: app bundles, caches, dev cruft.
const SKIP_ANYWHERE = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'caches',
  '.cache',
  '.dropbox.cache',
  '.trash-cache',
  'deriveddata',
  '.npm',
  '.gradle',
]);
const SKIP_SUFFIXES = [
  '.app',
  '.framework',
  '.bundle',
  '.plugin',
  '.kext',
  '.xcassets',
  '.lproj',
  '.prefpane',
  '.qlgenerator',
  '.mdimporter',
  '.saver',
  '.wdgt',
  '.appex',
  '.xpc',
];

// Inside photo libraries: thumbnails, previews and databases (not originals).
const LIBRARY_SKIP = new Set([
  'thumbnails',
  'thumbs',
  'previews',
  'data',
  'database',
  'private',
  'caches',
  'ipod photo cache',
  'attachments',
  'apple tv photo cache',
  'faces',
  'derivatives',
  'proxies',
  'cpl',
  'scopes',
  'facetiles',
  '.ipspot_update',
]);

/**
 * Decide whether to descend into a directory.
 *
 * @param {string[]} parts relpath components of the directory (from snapshot root)
 * @param {{ includeSystem?: boolean, insideLibrary?: boolean, excludes?: RegExp[] }} [opts]
 */
export function shouldSkipDir(parts, opts = {}) {
  const name = parts[parts.length - 1];
  const lower = name.toLowerCase();
  const rel = parts.join('/');
  if (opts.excludes?.some((re) => re.test(rel))) return true;
  if (opts.insideLibrary) return LIBRARY_SKIP.has(lower);
  // parts[0] is the backed-up volume ("Macintosh HD"); parts[1] is its top level.
  if (!opts.includeSystem) {
    if (parts.length === 2 && SYSTEM_TOP.has(lower)) return true;
    // ~/Library: app data, caches, mail/message attachments. Mostly noise.
    if (parts.length === 4 && parts[1].toLowerCase() === 'users' && lower === 'library') {
      return true;
    }
  }
  if (SKIP_ANYWHERE.has(lower)) return true;
  return SKIP_SUFFIXES.some((s) => lower.endsWith(s));
}

/**
 * Role of a file inside a library, from its path relative to the library root.
 *
 * @param {string[]} libRelParts
 * @returns {'original' | 'edited'}
 */
export function libraryRole(libRelParts) {
  const lower = libRelParts.map((p) => p.toLowerCase());
  if (lower.includes('modified') || lower.includes('renders')) return 'edited';
  if (lower[0] === 'resources' && lower[1] === 'media' && lower[2] === 'version') return 'edited';
  return 'original';
}

/**
 * Convert a simple glob (`*`, `**`, `?`) to an anchored RegExp matched
 * against relpaths like "Macintosh HD/Users/me/Pictures".
 *
 * @param {string} glob
 */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          re += '(?:.*/)?';
          i++;
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}
