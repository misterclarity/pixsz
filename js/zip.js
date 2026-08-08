/* Minimal store-only ZIP writer, so "Download all" produces one file instead of
   a burst of downloads that mobile browsers block. No compression: JPEGs are
   already compressed, so deflate would cost CPU for ~0% gain. */

const table = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosTime(date) {
  const time = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5)
    | ((date.getSeconds() / 2) & 0x1F);
  const day = (((date.getFullYear() - 1980) & 0x7F) << 9)
    | (((date.getMonth() + 1) & 0x0F) << 5) | (date.getDate() & 0x1F);
  return { time, day };
}

function u8(len) { return new Uint8Array(len); }

function writer(bytes) {
  const view = new DataView(bytes.buffer);
  let at = 0;
  return {
    u16(v) { view.setUint16(at, v, true); at += 2; },
    u32(v) { view.setUint32(at, v >>> 0, true); at += 4; },
    raw(src) { bytes.set(src, at); at += src.length; },
    get offset() { return at; },
  };
}

/**
 * @param {Array<{name: string, blob: Blob, date?: Date}>} entries
 * @returns {Promise<Blob>}
 */
export async function zip(entries) {
  const encoder = new TextEncoder();
  const files = [];
  let offset = 0;
  const parts = [];

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = new Uint8Array(await entry.blob.arrayBuffer());
    const { time, day } = dosTime(entry.date || new Date());
    const crc = crc32(data);

    const header = u8(30 + name.length);
    const w = writer(header);
    w.u32(0x04034b50);
    w.u16(20);          // version needed
    w.u16(0x0800);      // UTF-8 filenames
    w.u16(0);           // stored
    w.u16(time);
    w.u16(day);
    w.u32(crc);
    w.u32(data.length);
    w.u32(data.length);
    w.u16(name.length);
    w.u16(0);
    w.raw(name);

    parts.push(header, data);
    files.push({ name, crc, size: data.length, time, day, offset });
    offset += header.length + data.length;
  }

  const centralStart = offset;
  let centralSize = 0;

  for (const f of files) {
    const rec = u8(46 + f.name.length);
    const w = writer(rec);
    w.u32(0x02014b50);
    w.u16(20);          // version made by
    w.u16(20);          // version needed
    w.u16(0x0800);
    w.u16(0);
    w.u16(f.time);
    w.u16(f.day);
    w.u32(f.crc);
    w.u32(f.size);
    w.u32(f.size);
    w.u16(f.name.length);
    w.u16(0);           // extra
    w.u16(0);           // comment
    w.u16(0);           // disk
    w.u16(0);           // internal attrs
    w.u32(0);           // external attrs
    w.u32(f.offset);
    w.raw(f.name);

    parts.push(rec);
    centralSize += rec.length;
  }

  const end = u8(22);
  const w = writer(end);
  w.u32(0x06054b50);
  w.u16(0);
  w.u16(0);
  w.u16(files.length);
  w.u16(files.length);
  w.u32(centralSize);
  w.u32(centralStart);
  w.u16(0);
  parts.push(end);

  return new Blob(parts, { type: 'application/zip' });
}
