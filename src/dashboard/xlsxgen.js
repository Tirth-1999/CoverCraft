// xlsxgen.js — Minimal XLSX (ZIP-based) generator, no external dependencies
// Produces proper .xlsx files that open in Excel without format warnings.
(function(global) {

  // ── CRC-32 ──────────────────────────────────────────────────────────────────
  var CRC_TABLE = (function() {
    var t = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })();

  function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ── String → UTF-8 bytes ────────────────────────────────────────────────────
  function strBytes(s) {
    var bytes = [];
    for (var i = 0; i < s.length; i++) {
      var cc = s.charCodeAt(i);
      if (cc < 0x80)       { bytes.push(cc); }
      else if (cc < 0x800) { bytes.push(0xC0|(cc>>6), 0x80|(cc&0x3F)); }
      else                 { bytes.push(0xE0|(cc>>12), 0x80|((cc>>6)&0x3F), 0x80|(cc&0x3F)); }
    }
    return new Uint8Array(bytes);
  }

  // ── Little-endian helpers ────────────────────────────────────────────────────
  function u16(arr, o, v) { arr[o]=v&0xFF; arr[o+1]=(v>>8)&0xFF; }
  function u32(arr, o, v) { arr[o]=v&0xFF; arr[o+1]=(v>>8)&0xFF; arr[o+2]=(v>>16)&0xFF; arr[o+3]=(v>>24)&0xFF; }

  // ── Build ZIP (STORED — no compression) ─────────────────────────────────────
  function buildZip(files) {
    var locals = [], centrals = [], offset = 0;

    files.forEach(function(f) {
      var name = strBytes(f.name);
      var data = f.data;
      var crc  = crc32(data);

      var lh = new Uint8Array(30 + name.length);
      u32(lh,  0, 0x04034b50); u16(lh, 4, 20); u16(lh, 6, 0); u16(lh, 8, 0);
      u16(lh, 10, 0); u16(lh, 12, 0);
      u32(lh, 14, crc); u32(lh, 18, data.length); u32(lh, 22, data.length);
      u16(lh, 26, name.length); u16(lh, 28, 0);
      lh.set(name, 30);

      var ch = new Uint8Array(46 + name.length);
      u32(ch,  0, 0x02014b50); u16(ch, 4, 20); u16(ch, 6, 20); u16(ch, 8, 0);
      u16(ch, 10, 0); u16(ch, 12, 0); u16(ch, 14, 0);
      u32(ch, 16, crc); u32(ch, 20, data.length); u32(ch, 24, data.length);
      u16(ch, 28, name.length); u16(ch, 30, 0); u16(ch, 32, 0);
      u16(ch, 34, 0); u16(ch, 36, 0); u32(ch, 38, 0); u32(ch, 42, offset);
      ch.set(name, 46);

      locals.push(lh, data);
      centrals.push(ch);
      offset += lh.length + data.length;
    });

    var cdSize = centrals.reduce(function(s, c) { return s + c.length; }, 0);
    var eocd = new Uint8Array(22);
    u32(eocd, 0, 0x06054b50); u16(eocd, 4, 0); u16(eocd, 6, 0);
    u16(eocd, 8, files.length); u16(eocd, 10, files.length);
    u32(eocd, 12, cdSize); u32(eocd, 16, offset); u16(eocd, 20, 0);

    var all = locals.concat(centrals).concat([eocd]);
    var total = all.reduce(function(s, a) { return s + a.length; }, 0);
    var out = new Uint8Array(total);
    var pos = 0;
    all.forEach(function(a) { out.set(a, pos); pos += a.length; });
    return out;
  }

  // ── XML escape ───────────────────────────────────────────────────────────────
  function xe(v) {
    return String(v == null ? '' : v)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&apos;');
  }

  // ── Column letter (A, B, …, Z, AA, AB, …) ──────────────────────────────────
  function colLetter(n) {
    var s = '';
    n++;
    while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
    return s;
  }

  // ── Build XLSX ───────────────────────────────────────────────────────────────
  function buildXLSX(sheets) {
    var files = [];

    // [Content_Types].xml — includes styles part for full Excel compatibility
    var cts = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + sheets.map(function(_,i) {
          return '<Override PartName="/xl/worksheets/sheet'+(i+1)+'.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
        }).join('')
      + '</Types>';
    files.push({ name: '[Content_Types].xml', data: strBytes(cts) });

    // _rels/.rels
    files.push({ name: '_rels/.rels', data: strBytes(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>'
    )});

    // xl/_rels/workbook.xml.rels — includes styles relationship
    files.push({ name: 'xl/_rels/workbook.xml.rels', data: strBytes(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId0" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + sheets.map(function(_,i) {
          return '<Relationship Id="rId'+(i+1)+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet'+(i+1)+'.xml"/>';
        }).join('')
      + '</Relationships>'
    )});

    // xl/styles.xml — minimal but valid; required to suppress Excel format warnings
    files.push({ name: 'xl/styles.xml', data: strBytes(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
      + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
      + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
      + '</styleSheet>'
    )});

    // xl/workbook.xml
    files.push({ name: 'xl/workbook.xml', data: strBytes(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets>'
      + sheets.map(function(s,i) {
          return '<sheet name="'+xe(s.name)+'" sheetId="'+(i+1)+'" r:id="rId'+(i+1)+'"/>';
        }).join('')
      + '</sheets></workbook>'
    )});

    // xl/worksheets/sheet{i}.xml
    sheets.forEach(function(sheet, si) {
      var rowsXml = sheet.rows.map(function(row, ri) {
        var cells = row.map(function(cell, ci) {
          var ref = colLetter(ci) + (ri + 1);
          var v   = String(cell == null ? '' : cell);
          var num = v.trim() !== '' && !isNaN(Number(v));
          if (num) return '<c r="'+ref+'"><v>'+xe(v)+'</v></c>';
          return '<c r="'+ref+'" t="inlineStr"><is><t>'+xe(v)+'</t></is></c>';
        }).join('');
        return '<row r="'+(ri+1)+'">'+cells+'</row>';
      }).join('');

      files.push({ name: 'xl/worksheets/sheet'+(si+1)+'.xml', data: strBytes(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + '<sheetData>'+rowsXml+'</sheetData>'
        + '</worksheet>'
      )});
    });

    return buildZip(files);
  }

  global.XLSXGen = { generate: buildXLSX };

})(typeof window !== 'undefined' ? window : this);
