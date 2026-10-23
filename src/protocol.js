// 消息协议：手机端与电脑端之间只传很小的 JSON，朝向数据 60Hz。
export const PROTO_VERSION = 1;

export const MSG = Object.freeze({
  HELLO: 'hello',
  ORIENT: 'orient',
  CTRL: 'ctrl',
  PING: 'ping',
  PONG: 'pong',
});

// 房间码用的字符集：去掉 0/o/1/l/i 这些容易看错的字符，降低手输出错率。
// 31 个字符取 6 位 ≈ 8.9 亿种组合，比 4 位数字（9000 种）难猜得多 ——
// 公共 MQTT broker 没有鉴权，房间码本身就是唯一的"密钥"。
const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const CODE_LENGTH = 6;

export function randomRoom() {
  const bytes = new Uint8Array(CODE_LENGTH);
  if (globalThis.crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < CODE_LENGTH; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

// 用户手输时统一成小写，并丢掉字符集之外的字符（比如误输的连字符）。
export function normalizeRoom(value) {
  const raw = String(value ?? '').toLowerCase();
  let out = '';
  for (const ch of raw) {
    if (CODE_ALPHABET.includes(ch)) out += ch;
    if (out.length >= CODE_LENGTH) break;
  }
  return out;
}

export function isValidRoom(value) {
  return typeof value === 'string' && value.length === CODE_LENGTH &&
    [...value].every((ch) => CODE_ALPHABET.includes(ch));
}

export const ROOM_LENGTH = CODE_LENGTH;

// 两个方向用不同 topic，这样 MQTT 上不会自己收到自己发的包。
export function topicUp(room) {
  return `videoflow/v${PROTO_VERSION}/${room}/up`;
}

export function topicDown(room) {
  return `videoflow/v${PROTO_VERSION}/${room}/down`;
}

// PeerJS 的 peer id 由房间码推导，双方无需额外交换连接码。
export function peerIdFor(room) {
  return `videoflow-pc-${room}`;
}

export function encode(msg) {
  return JSON.stringify(msg);
}

export function decode(raw) {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || typeof obj.t !== 'string') return null;
    return obj;
  } catch {
    return null;
  }
}

// 四元数必须由 4 个有限数组成。收到不合规的值时必须丢掉，
// 否则 NaN 会钻进平滑器和相机矩阵，画面永久变黑且刷新才能恢复。
export function isFiniteQuaternion(value) {
  return Array.isArray(value) && value.length === 4 &&
    Number.isFinite(value[0]) && Number.isFinite(value[1]) &&
    Number.isFinite(value[2]) && Number.isFinite(value[3]);
}