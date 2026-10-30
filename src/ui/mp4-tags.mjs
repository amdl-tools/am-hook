// iTunes 风格的 MP4 标签（moov.udta.meta.ilst 的条目），由 media.wasm 在 defrag 时写入 moov（见 crates/am-media 的
// defrag::Options::tags），因此不需要第二遍改写文件。字段与参考实现 go-mp4tag 写入的相同。
//
//   buildIlst(tags) -> Uint8Array   tags 中缺省 / 空的字段不写；cover 为 { bytes, type: 'jpeg' | 'png' }

const encoder = new TextEncoder();
const TYPE_BINARY = 0;
const TYPE_UTF8 = 1;
const TYPE_JPEG = 13;
const TYPE_PNG = 14;
const TYPE_INT = 21;

/** box 类型：© 是 0xA9 单字节（Latin-1），不能按 UTF-8 编码 */
function fourcc(kind) {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[i] = kind.charCodeAt(i) & 0xff;
  return out;
}

function box(kind, ...parts) {
  const size = 8 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  out.set(fourcc(kind), 4);
  let at = 8;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}

function intBytes(value, width) {
  const b = new Uint8Array(width);
  const view = new DataView(b.buffer);
  if (width === 1) view.setInt8(0, value);
  else if (width === 2) view.setInt16(0, value);
  else if (width === 4) view.setUint32(0, value >>> 0);
  else view.setBigUint64(0, BigInt(value));
  return b;
}

/** data box：类型（4 字节，首字节为版本 0）+ locale（0）+ 值 */
const data = (type, value) => box('data', u32(type), u32(0), value);
const item = (kind, type, value) => box(kind, data(type, value));
const text = (kind, value) => item(kind, TYPE_UTF8, encoder.encode(value));

/** 自定义字段（----，mean 为 com.apple.iTunes），如 ISRC、UPC、LABEL */
function freeform(name, value) {
  return box('----', box('mean', u32(0), encoder.encode('com.apple.iTunes')), box('name', u32(0), encoder.encode(name)), data(TYPE_UTF8, encoder.encode(value)));
}

const present = (v) => v !== undefined && v !== null && v !== '' && !(typeof v === 'number' && Number.isNaN(v));
/** 数字 ID：只接受十进制数字串或安全整数 */
const numericId = (v) => (present(v) && /^\d{1,19}$/.test(String(v)) ? String(v) : null);

/**
 * iTunes Store 的 storefront ID（sfID 原子，MediaInfo 显示为 AppleStoreCountry），按两位国家 / 地区代码。
 * 只收 amp-api /v1/storefronts 里有的地区；表中没有的地区不写 sfID。
 */
const STOREFRONT_IDS = {
  ae: 143481, ag: 143540, ai: 143538, am: 143524, ao: 143564, ar: 143505, at: 143445, au: 143460, az: 143568,
  bb: 143541, be: 143446, bg: 143526, bh: 143559, bj: 143576, bm: 143542, bo: 143556, br: 143503,
  bs: 143539, bt: 143577, bw: 143525, by: 143565, bz: 143555, ca: 143455, cg: 143582, ch: 143459, cl: 143483, cn: 143465,
  co: 143501, cr: 143495, cv: 143580, cy: 143557, cz: 143489, de: 143443, dk: 143458, dm: 143545, do: 143508, dz: 143563,
  ec: 143509, ee: 143518, eg: 143516, es: 143454, fi: 143447, fj: 143583, fm: 143591, fr: 143442, gb: 143444, gd: 143546,
  gh: 143573, gm: 143584, gr: 143448, gt: 143504, gw: 143585, gy: 143553, hk: 143463, hn: 143510, hr: 143494, hu: 143482,
  id: 143476, ie: 143449, il: 143491, in: 143467, is: 143558, it: 143450, jm: 143511, jo: 143528, jp: 143462, ke: 143529,
  kg: 143586, kh: 143579, kn: 143548, kr: 143466, kw: 143493, ky: 143544, kz: 143517, la: 143587, lb: 143497, lc: 143549,
  lk: 143486, lr: 143588, lt: 143520, lu: 143451, lv: 143519, md: 143523, mg: 143531, mk: 143530, ml: 143532, mn: 143592,
  mo: 143515, mr: 143590, ms: 143547, mt: 143521, mu: 143533, mw: 143589, mx: 143468, my: 143473, mz: 143593, na: 143594,
  ne: 143534, ng: 143561, ni: 143512, nl: 143452, no: 143457, np: 143484, nz: 143461, om: 143562, pa: 143485, pe: 143507,
  pg: 143597, ph: 143474, pl: 143478, pt: 143453, py: 143513, qa: 143498, ro: 143487, ru: 143469,
  sa: 143479, sb: 143601, sc: 143599, se: 143456, sg: 143464, si: 143499, sk: 143496, sl: 143600, sn: 143535, sr: 143554,
  sv: 143506, sz: 143602, tc: 143552, td: 143581, th: 143475, tj: 143603, tm: 143604, tn: 143536, tr: 143480,
  tt: 143551, tw: 143470, tz: 143572, ua: 143492, ug: 143537, us: 143441, uy: 143514, uz: 143566, vc: 143550, ve: 143502,
  vg: 143543, vn: 143471, ye: 143571, za: 143472, zw: 143605,
};

/** 由专辑的曲目列表得出每张碟的歌曲数与碟数（MV 不计）：trkn / disk 的 total 以此为准 */
export function discLayout(tracks) {
  const perDisc = new Map();
  let discCount = 1;
  for (const r of tracks || []) {
    if (r.type === 'music-videos') continue;
    const disc = (r.attributes && r.attributes.discNumber) || 1;
    perDisc.set(disc, (perDisc.get(disc) || 0) + 1);
    if (disc > discCount) discCount = disc;
  }
  return { perDisc, discCount };
}

/**
 * tags：{ title, artist, album, albumArtist, composer, genre, date, track: [n, total], disc: [n, total], lyrics,
 *   cover: { bytes, type }, copyright, label, upc, isrc, rating（0 无 / 1 explicit / 2 clean）, songId, albumId, artistId,
 *   compilation, storefront（两位地区代码，写 sfID）, sort: { title, artist, album, albumArtist, composer }, mediaType（stik：1 音乐，6 音乐视频，缺省为 1）,
 *   custom: { 名称: 值 }（其他 com.apple.iTunes 自定义字段，如 MV 的 PERFORMER、RELEASETIME） }
 */
export function buildIlst(tags) {
  const items = [];
  const add = (cond, fn) => { if (cond) items.push(fn()); };
  add(present(tags.title), () => text('\xa9nam', tags.title));
  add(present(tags.artist), () => text('\xa9ART', tags.artist));
  add(present(tags.album), () => text('\xa9alb', tags.album));
  add(present(tags.albumArtist), () => text('aART', tags.albumArtist));
  add(present(tags.composer), () => text('\xa9wrt', tags.composer));
  add(present(tags.genre), () => text('\xa9gen', tags.genre));
  add(present(tags.date), () => text('\xa9day', tags.date));
  if (tags.track && tags.track[0] > 0) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setUint16(2, Math.min(tags.track[0], 0xffff));
    new DataView(b.buffer).setUint16(4, Math.min(tags.track[1] || 0, 0xffff));
    items.push(item('trkn', TYPE_BINARY, b));
  }
  if (tags.disc && tags.disc[0] > 0) {
    const b = new Uint8Array(6);
    new DataView(b.buffer).setUint16(2, Math.min(tags.disc[0], 0xffff));
    new DataView(b.buffer).setUint16(4, Math.min(tags.disc[1] || 0, 0xffff));
    items.push(item('disk', TYPE_BINARY, b));
  }
  add(tags.compilation, () => item('cpil', TYPE_INT, intBytes(1, 1)));
  // 媒体类型：音乐或音乐视频
  items.push(item('stik', TYPE_INT, intBytes(tags.mediaType || 1, 1)));
  add(present(tags.rating), () => item('rtng', TYPE_INT, intBytes(tags.rating, 1)));
  add(present(tags.copyright), () => text('cprt', tags.copyright));
  if (present(tags.label)) {
    items.push(freeform('LABEL', tags.label));
  }
  add(present(tags.isrc), () => freeform('ISRC', tags.isrc));
  add(present(tags.upc), () => freeform('UPC', tags.upc));
  for (const [name, value] of Object.entries(tags.custom || {})) add(present(value), () => freeform(name, String(value)));
  const songId = numericId(tags.songId);
  const albumId = numericId(tags.albumId);
  const artistId = numericId(tags.artistId);
  // plID 固定 64 位；cnID / atID 在 32 位放得下时按 iTunes 的 4 字节写，放不下（如 2026 年起的歌曲 ID）改写 8 字节，与其他标签工具一致
  const idBytes = (id) => (Number(id) <= 0xffffffff ? intBytes(Number(id), 4) : intBytes(id, 8));
  add(songId, () => item('cnID', TYPE_INT, idBytes(songId)));
  add(albumId, () => item('plID', TYPE_INT, intBytes(albumId, 8)));
  add(artistId, () => item('atID', TYPE_INT, idBytes(artistId)));
  const sfId = tags.storefront ? STOREFRONT_IDS[String(tags.storefront).toLowerCase()] : null;
  add(sfId, () => item('sfID', TYPE_INT, intBytes(sfId, 4)));
  const sort = tags.sort || {};
  add(present(sort.title), () => text('sonm', sort.title));
  add(present(sort.artist), () => text('soar', sort.artist));
  add(present(sort.album), () => text('soal', sort.album));
  add(present(sort.albumArtist), () => text('soaa', sort.albumArtist));
  add(present(sort.composer), () => text('soco', sort.composer));
  add(present(tags.lyrics), () => text('\xa9lyr', tags.lyrics));
  if (tags.cover && tags.cover.bytes && tags.cover.bytes.length) {
    items.push(item('covr', tags.cover.type === 'png' ? TYPE_PNG : TYPE_JPEG, tags.cover.bytes));
  }
  const out = new Uint8Array(items.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of items) { out.set(b, at); at += b.length; }
  return out;
}

/** 由文件头判断图片类型 */
export function imageType(bytes) {
  return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 ? 'png' : 'jpeg';
}
