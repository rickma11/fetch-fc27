// ziplite.js —— 极简 ZIP 写入器（**只写、不读**），零依赖。
//
// 为什么需要它：roster 全量 payload 约 16MB，@cloudbase/node-sdk 的 uploadFile 对
// Buffer 是「单次 PUT 全量」，COS 对慢网下的大体积单请求直接回 UserNetworkTooSlow
// （2026-09-21 / 09-22 连续两次实锤，第 18 步 48 分钟后失败）。
// 官方口径的解法就是「分块 + 并发 + 压缩」，所以这里要能把 JSON 压成一个标准的
// 单条目 deflate zip，交给小程序端用 FileSystemManager.unzip（原生 API，无需引库）解开。
//
// 格式严格按 PKWARE APPNOTE 的最小可用集：
//   [Local file header][data] × N  →  [Central directory header] × N  →  [EOCD]
// 不带 extra field / data descriptor（压缩后大小与 CRC 上传前已知，属于最保守写法）。
//
// ⚠️ 时间戳固定为 1980-01-01（DOS epoch）：让同一份内容产出**字节完全相同**的 zip，
//    便于「上传后读回断言」与本地/CI 比对。
const zlib = require('zlib');

// ---- CRC-32（IEEE 802.3，ZIP 用）----
const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// 本地文件头 + 数据 + 中央目录头，拼成一个完整 zip（Buffer）
// entries: [{ name, data(Buffer) }]
function zip(entries) {
  const list = (entries || []).filter(function (e) { return e && e.name && e.data; });
  if (!list.length) throw new Error('ziplite: 至少需要一个条目');

  const locals = [];
  const central = [];
  let offset = 0;

  list.forEach(function (e) {
    const nameBuf = Buffer.from(String(e.name), 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // 压不动就明文存（method 0）——避免小文件被 deflate 头拖大
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);   // local file header signature
    lh.writeUInt16LE(20, 4);           // version needed
    lh.writeUInt16LE(0, 6);            // flags
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);           // mod time  = 1980-01-01 00:00（固定）
    lh.writeUInt16LE(0x0021, 12);      // mod date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);           // extra len

    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);   // central directory signature
    ch.writeUInt16LE(20, 4);           // version made by
    ch.writeUInt16LE(20, 6);           // version needed
    ch.writeUInt16LE(0, 8);            // flags
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x0021, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);           // extra len
    ch.writeUInt16LE(0, 32);           // comment len
    ch.writeUInt16LE(0, 34);           // disk start
    ch.writeUInt16LE(0, 36);           // internal attrs
    ch.writeUInt32LE(0, 38);           // external attrs
    ch.writeUInt32LE(offset, 42);      // local header offset
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  });

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);            // disk num
  eocd.writeUInt16LE(0, 6);            // cd start disk
  eocd.writeUInt16LE(list.length, 8);
  eocd.writeUInt16LE(list.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);      // cd offset
  eocd.writeUInt16LE(0, 20);           // comment len

  return Buffer.concat(locals.concat([cdBuf, eocd]));
}

// 单条目便捷写法
function zipOne(name, data) {
  return zip([{ name: name, data: data }]);
}

module.exports = { zip, zipOne, crc32 };
