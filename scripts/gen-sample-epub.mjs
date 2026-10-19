// Generates a small, well-formed, multi-chapter EPUB for the reader
// browser tests. Run: node scripts/gen-sample-epub.mjs
import { deflateRawSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files) {
  const parts = [];
  let offset = 0;
  const centrals = [];
  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf8');
    const stored = file.stored === true;
    const compressed = stored ? file.data : deflateRawSync(file.data);

    // Local file header: sig, version, flags, method, time, date, crc,
    // compressed size, uncompressed size, name length, extra length, name.
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc32(file.data), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);

    // Central directory header: same sizes, plus version made by,
    // flags, and the extra attribute/offset fields.
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(stored ? 0 : 8, 10); // method
    central.writeUInt16LE(0, 12); // time
    central.writeUInt16LE(0, 14); // date
    central.writeUInt32LE(crc32(file.data), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42); // local header offset
    nameBytes.copy(central, 46);

    parts.push(local, compressed);
    centrals.push(central);
    offset += local.length + compressed.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const central of centrals) {
    parts.push(central);
    centralSize += central.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // cd disk
  eocd.writeUInt16LE(files.length, 8); // entries this disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  parts.push(eocd);
  return Buffer.concat(parts);
}

const chapter = (title, paras) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${title}</title></head>
<body>
<h1>${title}</h1>
${paras.map((p) => `<p>${p}</p>`).join('\n')}
</body>
</html>`;

const lorem = 'The morning light came slowly to the city, and with it the sound of lorries on the main road, the shout of sellers in the market, and the quiet footsteps of people going about their day.';

const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:sample-book-0001</dc:identifier>
    <dc:title>The Sample Road</dc:title>
    <dc:creator>Nooki Tests</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="style" href="style.css" media-type="text/css"/>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="chapter3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3"/>
  </spine>
</package>`;

const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Navigation</title></head>
<body>
<nav epub:type="toc"><h1>Contents</h1>
<ol>
<li><a href="chapter1.xhtml">Chapter One</a></li>
<li><a href="chapter2.xhtml">Chapter Two</a></li>
<li><a href="chapter3.xhtml">Chapter Three</a></li>
</ol>
</nav>
</body>
</html>`;

const repeat = (times) => Array.from({ length: times }, () => lorem).join(' ');

const files = [
  { name: 'mimetype', data: Buffer.from('application/epub+zip'), stored: true },
  { name: 'META-INF/container.xml', data: Buffer.from(container) },
  { name: 'OEBPS/content.opf', data: Buffer.from(opf) },
  { name: 'OEBPS/nav.xhtml', data: Buffer.from(nav) },
  { name: 'OEBPS/style.css', data: Buffer.from('body { font-family: serif; line-height: 1.6; }') },
  { name: 'OEBPS/chapter1.xhtml', data: Buffer.from(chapter('Chapter One', [repeat(12)])) },
  { name: 'OEBPS/chapter2.xhtml', data: Buffer.from(chapter('Chapter Two', [repeat(12)])) },
  { name: 'OEBPS/chapter3.xhtml', data: Buffer.from(chapter('Chapter Three', [repeat(12)])) },
];

const zip = buildZip(files);
mkdirSync('tests/browser/fixtures', { recursive: true });
writeFileSync('tests/browser/fixtures/sample.epub', zip);
// A truncated copy: the central directory at the end is gone, so the
// archive cannot be opened. The reader must say so, not hang blank.
writeFileSync('tests/browser/fixtures/corrupt.epub', zip.subarray(0, Math.floor(zip.length * 0.55)));
console.log('wrote tests/browser/fixtures/sample.epub', zip.length, 'bytes');
console.log('wrote tests/browser/fixtures/corrupt.epub (truncated)');
