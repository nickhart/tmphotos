import exifr from 'exifr';
import { EXIF_EXTS } from './classify.js';

const PICK = ['DateTimeOriginal', 'CreateDate', 'ModifyDate', 'Make', 'Model'];

/**
 * Normalize an EXIF date ("2009:07:04 12:34:56") to "2009-07-04T12:34:56".
 * EXIF dates have no time zone; the result is local camera time.
 *
 * @param {unknown} v
 * @returns {string | null}
 */
export function normalizeExifDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 19);
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(v.trim());
  if (!m || m[1] === '0000') return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

/** @param {unknown} v */
function clean(v) {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/\u0000/g, '').trim();
  return s || null;
}

/**
 * Read capture date and camera from a file. Reads only the metadata segments.
 *
 * @param {string} file
 * @param {string} ext lower-case extension
 * @returns {Promise<{ status: 'ok' | 'none' | 'error' | 'skipped', date: string | null, make: string | null, model: string | null }>}
 */
export async function readExif(file, ext) {
  if (!EXIF_EXTS.has(ext)) return { status: 'skipped', date: null, make: null, model: null };
  try {
    const tags = await exifr.parse(file, { pick: PICK, reviveValues: false, silentErrors: true });
    if (!tags) return { status: 'none', date: null, make: null, model: null };
    const date =
      normalizeExifDate(tags.DateTimeOriginal) ??
      normalizeExifDate(tags.CreateDate) ??
      normalizeExifDate(tags.ModifyDate);
    const make = clean(tags.Make);
    const model = clean(tags.Model);
    const status = date || make || model ? 'ok' : 'none';
    return { status, date, make, model };
  } catch {
    return { status: 'error', date: null, make: null, model: null };
  }
}
