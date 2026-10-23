// 消息协议：手机端与电脑端之间只传很小的 JSON，朝向数据 60Hz。
export const PROTO_VERSION = 1;

export const MSG = Object.freeze({
  HELLO: 'hello',
  ORIENT: 'orient',
  CTRL: 'ctrl',
  PING: 'ping',
  PONG: 'pong',
});

// 4 位数字房间号是双方唯一的配对凭据。
export function randomRoom() {
  return String(1000 + Math.floor(Math.random() * 9000));
}

export function normalizeRoom(value) {
  return String(value ?? '').replace(/\D/g, '').slice(0, 4);
}

export function isValidRoom(value) {
  return /^\d{4}$/.test(String(value));
}

// 两个方向用不同 topic，这样 MQTT 上不会自己收到自己发的包。
export function topicUp(room) {
  return `videoflow/v${PROTO_VERSION}/${room}/up`;
}

export function topicDown(room) {
  return `videoflow/v${PROTO_VERSION}/${room}/down`;
}

// PeerJS 的 peer id 由房间号推导，双方无需额外交换连接码。
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