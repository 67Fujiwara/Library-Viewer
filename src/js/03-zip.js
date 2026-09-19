/* ZIP ライター (格納方式 method 0、無圧縮、自作)
 *   ZIP.write([{name:'dir/file.glb', data:Uint8Array}, ...]) → Uint8Array
 * ファイル名は日本語を含むので汎用フラグ bit 11 (0x0800) を立てて UTF-8 にする。
 */
var ZIP = (function () {
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(d) {
    d = d || new Date();
    var time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
    var date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time: time, date: date };
  }

  function write(files, when) {
    var enc = new TextEncoder(), dt = dosDateTime(when);
    var locals = [], centrals = [], offset = 0;
    files.forEach(function (f) {
      var name = enc.encode(f.name.replace(/\\/g, '/'));
      var data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
      var crc = crc32(data);
      var lh = new Uint8Array(30 + name.length), lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
      lv.setUint16(10, dt.time, true); lv.setUint16(12, dt.date, true); lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
      lh.set(name, 30);
      var ch = new Uint8Array(46 + name.length), cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
      cv.setUint16(12, dt.time, true); cv.setUint16(14, dt.date, true); cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true); cv.setUint16(34, 0, true); cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true); cv.setUint32(42, offset, true);
      ch.set(name, 46);
      locals.push(lh, data); centrals.push(ch);
      offset += lh.length + data.length;
    });
    var cdSize = centrals.reduce(function (s, c) { return s + c.length; }, 0);
    var eocd = new Uint8Array(22), ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true); ev.setUint16(20, 0, true);
    var out = new Uint8Array(offset + cdSize + 22), p = 0;
    locals.concat(centrals, [eocd]).forEach(function (b) { out.set(b, p); p += b.length; });
    return out;
  }

  return { write: write, crc32: crc32 };
})();
if (typeof module !== 'undefined') module.exports = ZIP;
