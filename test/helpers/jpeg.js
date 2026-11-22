/**
 * Build a tiny (not decodable, but well-formed for metadata readers) JPEG
 * carrying an EXIF block with Make, Model and DateTimeOriginal.
 *
 * @param {{ make?: string, model?: string, date?: string, padTo?: number }} [opts]
 *   date in EXIF form "YYYY:MM:DD HH:MM:SS"
 */
export function makeJpeg(opts = {}) {
  const make = `${opts.make ?? 'Canon'}\0`;
  const model = `${opts.model ?? 'Canon PowerShot S95'}\0`;
  const date = `${opts.date ?? '2010:07:04 12:34:56'}\0`;

  // TIFF, big-endian. Layout: header(8) | IFD0 | Exif IFD | data
  const ifd0Count = 3;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const exifCount = 1;
  const exifSize = 2 + exifCount * 12 + 4;
  const ifd0Off = 8;
  const exifOff = ifd0Off + ifd0Size;
  let dataOff = exifOff + exifSize;
  const makeOff = dataOff;
  dataOff += make.length;
  const modelOff = dataOff;
  dataOff += model.length;
  const dateOff = dataOff;
  dataOff += date.length;

  const tiff = Buffer.alloc(dataOff);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(ifd0Off, 4);

  /**
   * @param {number} at
   * @param {number} tag
   * @param {number} type
   * @param {number} count
   * @param {number} value
   */
  const entry = (at, tag, type, count, value) => {
    tiff.writeUInt16BE(tag, at);
    tiff.writeUInt16BE(type, at + 2);
    tiff.writeUInt32BE(count, at + 4);
    tiff.writeUInt32BE(value, at + 8);
  };
  tiff.writeUInt16BE(ifd0Count, ifd0Off);
  entry(ifd0Off + 2, 0x010f, 2, make.length, makeOff);
  entry(ifd0Off + 14, 0x0110, 2, model.length, modelOff);
  entry(ifd0Off + 26, 0x8769, 4, 1, exifOff);
  tiff.writeUInt32BE(0, ifd0Off + 38);
  tiff.writeUInt16BE(exifCount, exifOff);
  entry(exifOff + 2, 0x9003, 2, date.length, dateOff);
  tiff.writeUInt32BE(0, exifOff + 14);
  tiff.write(make, makeOff, 'latin1');
  tiff.write(model, modelOff, 'latin1');
  tiff.write(date, dateOff, 'latin1');

  const app1Body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(app1Body.length + 2, 2);
  const parts = [Buffer.from([0xff, 0xd8]), app1, app1Body];
  const base = Buffer.concat([...parts, Buffer.from([0xff, 0xd9])]);
  if (opts.padTo && opts.padTo > base.length) {
    // Pad with a COM segment so the file is big enough to pass --min-size.
    const padLen = Math.min(opts.padTo - base.length - 4, 65533);
    const com = Buffer.alloc(4 + padLen, 0x20);
    com.writeUInt16BE(0xfffe, 0);
    com.writeUInt16BE(padLen + 2, 2);
    return Buffer.concat([...parts, com, Buffer.from([0xff, 0xd9])]);
  }
  return base;
}
