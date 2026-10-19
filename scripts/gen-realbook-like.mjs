// Generates EPUBs that mimic the couple's book structure to bisect
// which feature stalls the reader's percent calculation:
//   realbook-like.epub  — EPUB 2.0 + ncx + SVG cover + @font-face + xpgt
//   v-epub3.epub        — same but EPUB 3.0 + nav
//   v-nocover.epub      — EPUB 2.0, text cover instead of SVG
//   v-nofonts.epub      — EPUB 2.0, no @font-face rules
//   v-noxpgt.epub       — EPUB 2.0, no page-template link
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

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc32(file.data), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);

    parts.push(local, compressed);
    centrals.push(central);
    offset += local.length + compressed.length;
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const central of centrals) { parts.push(central); centralSize += central.length; }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  parts.push(eocd);
  return Buffer.concat(parts);
}

const lorem = 'The morning light came slowly to the city, and with it the sound of lorries on the main road, the shout of sellers in the market, and the quiet footsteps of people going about their day.';
const repeat = (times) => Array.from({ length: times }, () => lorem).join(' ');

const headExtras = (opts) => [
  opts.xpgt ? '<link href="../styles/page-template.xpgt" rel="stylesheet" type="application/vnd.adobe-page-template+xml"/>' : '',
  '<meta content="urn:uuid:07f4b532-7ed7-46a1-b218-c71b4c0598d6" name="Adept.expected.resource"/>',
].filter(Boolean).join('\n');

const chapter = (title, paras, opts) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
<head><title>${title}</title>
<link href="../styles/stylesheet.css" rel="stylesheet" type="text/css"/>
${headExtras(opts)}
</head>
<body>
<h1>${title}</h1>
${paras.map((p) => `<p class="paranoindent">${p}</p>`).join('\n')}
</body>
</html>`;

const svgCover = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:svg="http://www.w3.org/2000/svg">
<head><title>Cover</title>
<meta content="application/xhtml+xml; charset=utf-8" http-equiv="Content-Type"/>
</head>
<body>
<div id="cover">
<svg:svg xmlns:xlink="http://www.w3.org/1999/xlink" enable-background="new 0 0 507 681.177" height="98%" id="cover-svg" version="1.1" viewBox="0 0 507 681.177" width="98%" x="0px" xml:space="preserve" y="0px">
<svg:path d="M254.172,671.497C86.237,671.836,40.938,493.278,40.651,340.313C40.557,289.899,32.061,8.415,252.163,7.981 s214.066,282.516,214.172,332.941C466.616,493.887,422.096,671.168,254.172,671.497z" fill="#FFFFFF"/>
<svg:path d="M370.204,263.274c-20.682-31.418-49.664-68.531-52.891-106.734c-2.035-23.965-0.562-50.754-17.449-70.547 c-4.914-5.766-11.863-11.086-18.762-14.52c-7.367-3.656-16.855-5.977-25.193-5.977c-7.867,0-15.736,1.172-23.264,3.34 c-8.883,2.555-17.715,5.578-26.936,6.82c-10.678,1.43-19.316,0.926-29.727-1.289c-6.221-1.324-7.916-1.828-14.146-3.105" fill="#FFFFFF"/>
</svg:svg>
</div>
</body>
</html>`;

const textCover = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Cover</title></head>
<body>
<h1 style="text-align:center; margin-top:40%">The Sample Road</h1>
<p style="text-align:center">A Nooki Test Novel</p>
</body>
</html>`;

const fontFaceCss = `@font-face
{
font-family: "Charis";
src: url(../fonts/CharisSILR.ttf);
font-style: normal;
font-weight: normal;
}

@font-face
{
font-family: "Charis";
src: url(../fonts/CharisSILB.ttf);
font-style: normal;
font-weight: bold;
}

body
{
font-family: "Charis";
font-size: medium;
}

p.paranoindent
{
    margin-top: 1em;
    margin-bottom: .2em;
    line-height: 1.2em;
    text-indent: 0%;
}`;

const plainCss = `body
{
font-family: serif;
font-size: medium;
}

p.paranoindent
{
    margin-top: 1em;
    margin-bottom: .2em;
    line-height: 1.2em;
    text-indent: 0%;
}`;

const xpgtContent = `<?xml version="1.0" encoding="UTF-8"?>
<adobe-template xmlns="http://ns.adobe.com/AdobePageTemplate/1.0/" name="template">
<template>
<page>
<preference name="parsing" value="compatibility" />
</page>
</template>
</adobe-template>`;

function ncxToc() {
  return `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="en">
<head>
<meta name="dtb:uid" content="9780141954806"/>
<meta name="dtb:depth" content="1"/>
</head>
<docTitle><text>The Sample Road</text></docTitle>
<navMap>
<navPoint id="navpoint-1" playOrder="1"><navLabel><text>Chapter One</text></navLabel><content src="xhtml/chapter001.html"/></navPoint>
<navPoint id="navpoint-2" playOrder="2"><navLabel><text>Chapter Two</text></navLabel><content src="xhtml/chapter002.html"/></navPoint>
</navMap>
</ncx>`;
}

function navToc() {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Navigation</title></head>
<body>
<nav epub:type="toc"><h1>Contents</h1>
<ol>
<li><a href="chapter001.html">Chapter One</a></li>
<li><a href="chapter002.html">Chapter Two</a></li>
</ol>
</nav>
</body>
</html>`;
}

function build({ epub3, svgCoverPage, fonts, xpgt: includeXpgt }) {
  const opts = { xpgt: includeXpgt };
  const cover = svgCoverPage ? svgCover : textCover;
  const css = fonts ? fontFaceCss : plainCss;
  const version = epub3 ? '3.0' : '2.0';
  const uniqueAttr = epub3 ? 'unique-identifier="bookid"' : 'unique-identifier="bookid"';
  const dcMeta = epub3
    ? '<dc:identifier id="bookid">urn:uuid:sample-book-0002</dc:identifier>'
    : '<dc:identifier id="bookid">URN:ISBN: 978-0-14-195480-6</dc:identifier>';
  const navItem = epub3
    ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
    : '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>';
  const tocFile = epub3 ? 'OEBPS/nav.xhtml' : 'OEBPS/toc.ncx';
  const tocContent = epub3 ? navToc() : ncxToc();
  const spineToc = epub3 ? '' : ' toc="ncx"';
  const modified = epub3 ? '<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>' : '';

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" ${uniqueAttr} version="${version}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:creator>Nooki Tests</dc:creator>
<dc:title>The Sample Road</dc:title>
${dcMeta}
<dc:language>en</dc:language>
${modified}
</metadata>
<manifest>
<item id="cover" href="xhtml/cover.html" media-type="application/xhtml+xml"/>
<item id="chapter001" href="xhtml/chapter001.html" media-type="application/xhtml+xml"/>
<item id="chapter002" href="xhtml/chapter002.html" media-type="application/xhtml+xml"/>
<item id="stylesheet" href="styles/stylesheet.css" media-type="text/css"/>
<item id="page-template" href="styles/page-template.xpgt" media-type="application/vnd.adobe-page-template+xml"/>
${navItem}
</manifest>
<spine${spineToc}>
<itemref idref="cover"/>
<itemref idref="chapter001"/>
<itemref idref="chapter002"/>
</spine>
</package>`;

  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles>
<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
</rootfiles>
</container>`;

  const files = [
    { name: 'mimetype', data: Buffer.from('application/epub+zip'), stored: true },
    { name: 'META-INF/container.xml', data: Buffer.from(container) },
    { name: 'OEBPS/content.opf', data: Buffer.from(opf) },
    { name: `OEBPS/${tocFile.split('/').pop()}`, data: Buffer.from(tocContent) },
    { name: 'OEBPS/styles/stylesheet.css', data: Buffer.from(css) },
    { name: 'OEBPS/styles/page-template.xpgt', data: Buffer.from(xpgtContent) },
    { name: 'OEBPS/xhtml/cover.html', data: Buffer.from(cover) },
    { name: 'OEBPS/xhtml/chapter001.html', data: Buffer.from(chapter('Chapter One', [repeat(12)], opts)) },
    { name: 'OEBPS/xhtml/chapter002.html', data: Buffer.from(chapter('Chapter Two', [repeat(12)], opts)) },
  ];
  return buildZip(files);
}

mkdirSync('tests/browser/fixtures', { recursive: true });
const variants = {
  'realbook-like.epub': build({ epub3: false, svgCoverPage: true, fonts: true, xpgt: true }),
  'v-epub3.epub': build({ epub3: true, svgCoverPage: true, fonts: true, xpgt: true }),
  'v-nocover.epub': build({ epub3: false, svgCoverPage: false, fonts: true, xpgt: true }),
  'v-nofonts.epub': build({ epub3: false, svgCoverPage: true, fonts: false, xpgt: true }),
  'v-noxpgt.epub': build({ epub3: false, svgCoverPage: true, fonts: true, xpgt: false }),
};
for (const [name, zip] of Object.entries(variants)) {
  writeFileSync(`tests/browser/fixtures/${name}`, zip);
  console.log('wrote', name, zip.length, 'bytes');
}
