// 双通道传输：发送方把同一条消息同时丢进 WebRTC 数据通道和 MQTT 中转；
// 接收方两条通道都监听，用消息里的自增 seq 去重，谁先到就用谁。
// 这样做的好处是双方不用协商走哪条路，任一条通就能用，另一条自动变成备份。
import { MSG, PROTO_VERSION, encode, decode, topicUp, topicDown, peerIdFor } from './protocol.js';

const MQTT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ],
};

const PEER_ATTEMPT_LIMIT = 20;
const PEER_STABLE_MS = 5000;
const DEDUPE_WINDOW = 1500;
const PEER_ACTIVE_MS = 3000;

export class DualTransport {
  constructor({ room, role, log = () => {} }) {
    this.room = room;
    this.role = role;
    this.isPhone = role === 'phone';
    this.log = log;

    this.status = {
      webrtc: { state: 'idle', detail: '' },
      mqtt: { state: 'idle', detail: '' },
    };
    this.stats = {
      received: 0,
      duplicates: 0,
      rejected: 0,
      sent: 0,
      lastSeq: -1,
      lastAt: -1e9,   // 哨兵值：未收到任何消息前 peerActive 必须为 false
      rtt: null,
      primaryChannel: '',
      orientCount: 0,
    };

    this._messageHandlers = new Set();
    this._statusHandlers = new Set();
    this._seq = 0;
    this._seen = new Set();
    this._seenOrder = [];
    this._closed = false;
    this._timers = new Set();
    this._peer = null;
    this._conns = new Set();
    this._mqttClient = null;
    this._mqttBrokerIndex = 0;
    this._mqttSwitching = false;
    this._rtcAttempts = 0;
    this._rtcRetryTimer = 0;
    // 点对点直连一旦稳定建立，就停用中转通道：
    // 公共 MQTT broker 没有鉴权，任何人订阅通配 topic 都能看到并伪造姿态数据。
    // 直连是加密的点对点通道，正常情况下不该再往公共服务器上发任何姿态。
    this._relayActive = true;
    this._mqttBaseDetail = '';
  }

  // ---- 对外接口 ----------------------------------------------------------

  async start() {
    this._closed = false;
    this._startWebRtc();
    this._startMqtt();
    this._later(() => this._heartbeat(), 1500);
    return this;
  }

  onMessage(handler) {
    this._messageHandlers.add(handler);
    return () => this._messageHandlers.delete(handler);
  }

  onStatus(handler) {
    this._statusHandlers.add(handler);
    handler(this.snapshot());
    return () => this._statusHandlers.delete(handler);
  }

  get peerActive() {
    return performance.now() - this.stats.lastAt < PEER_ACTIVE_MS;
  }

  snapshot() {
    return {
      room: this.room,
      role: this.role,
      webrtc: { ...this.status.webrtc },
      mqtt: { ...this.status.mqtt },
      stats: { ...this.stats },
      anyChannelOpen: this.status.webrtc.state === 'open' || this.status.mqtt.state === 'open',
      peerActive: this.peerActive,
    };
  }

  send(type, payload = {}) {
    if (this._closed) return false;
    const msg = {
      t: type,
      v: PROTO_VERSION,
      room: this.room,
      from: this.role,
      seq: ++this._seq,
      ts: Date.now(),
      ...payload,
    };
    return this._dispatch(encode(msg));
  }

  // 演示模式用：不经过网络，直接把一条消息喂进同一条管线。
  inject(type, payload = {}) {
    this._ingest(encode({
      t: type,
      v: PROTO_VERSION,
      room: this.room,
      from: this.role === 'pc' ? 'demo' : this.role,
      seq: ++this._seq,
      ts: Date.now(),
      ...payload,
    }), 'demo');
  }

  close() {
    this._closed = true;
    this._timers.forEach((id) => clearTimeout(id));
    this._timers.clear();
    this._rtcRetryTimer = 0;
    this._conns.forEach((conn) => { try { conn.close(); } catch { /* 已断开 */ } });
    this._conns.clear();
    if (this._peer) {
      try { this._peer.destroy(); } catch { /* 已销毁 */ }
      this._peer = null;
    }
    if (this._mqttClient) {
      const client = this._mqttClient;
      this._mqttClient = null;
      try { client.removeAllListeners(); client.end(true); } catch { /* 已关闭 */ }
    }
  }

  // ---- 内部 --------------------------------------------------------------

  _later(fn, ms) {
    const id = setTimeout(() => {
      this._timers.delete(id);
      if (!this._closed) fn();
    }, ms);
    this._timers.add(id);
    return id;
  }

  _dispatch(text) {
    let delivered = false;
    const client = this._mqttClient;
    if (this._relayActive && client && this.status.mqtt.state === 'open') {
      try {
        client.publish(this.isPhone ? topicUp(this.room) : topicDown(this.room), text, { qos: 0, retain: false });
        delivered = true;
      } catch { /* 掉线了，下一条会走重连后的 client */ }
    }
    this._conns.forEach((conn) => {
      if (conn.open === false) return;
      try { conn.send(text); delivered = true; } catch { /* 连接正在关闭 */ }
    });
    if (delivered) this.stats.sent++;
    return delivered;
  }

  _setStatus(channel, state, detail = '') {
    const cur = this.status[channel];
    if (cur.state === state && cur.detail === detail) return;
    cur.state = state;
    cur.detail = detail;
    if (channel === 'webrtc') this._syncRelay();
    const snap = this.snapshot();
    this._statusHandlers.forEach((fn) => { try { fn(snap); } catch (e) { console.error(e); } });
  }

  // 直连可用就把中转关掉（发送侧停发，接收侧也忽略中转来的包），
  // 直连断了再自动打开，保证"任一条路通就能用"这个前提不被破坏。
  _syncRelay() {
    const direct = this.status.webrtc.state === 'open' && this._conns.size > 0;
    const want = !direct;
    if (want === this._relayActive) return;
    this._relayActive = want;
    this._setMqttStatus(this.status.mqtt.state, this._mqttBaseDetail || '');
  }

  // 中转通道的说明要同时反映两件事：broker 连得怎么样，以及是否因为
  // 直连可用而主动停用。broker 自己的事件随时会刷新说明，所以统一从这一个出口走。
  _setMqttStatus(state, baseDetail) {
    this._mqttBaseDetail = baseDetail;
    const detail = this._relayActive ? baseDetail : '已暂停（点对点直连中）';
    this._setStatus('mqtt', state, detail);
  }

  _ingest(text, channel) {
    const msg = decode(text);
    if (!msg) return;

    // 直连已经可用时，中转通道来的包一律不采信：
    // 公共 broker 上任何人都能往这个 topic 发东西，不能让第三方劫持姿态。
    if (channel === 'mqtt' && !this._relayActive) {
      this.stats.rejected++;
      return;
    }

    const seq = msg.seq;
    if (Number.isFinite(seq)) {
      if (this._seen.has(seq)) {
        this.stats.duplicates++;
        return;
      }
      this._seen.add(seq);
      this._seenOrder.push(seq);
      if (this._seenOrder.length > DEDUPE_WINDOW) this._seen.delete(this._seenOrder.shift());
      this.stats.lastSeq = seq;
    }

    this.stats.received++;
    this.stats.lastAt = performance.now();
    if (msg.t === MSG.ORIENT) {
      this.stats.orientCount++;
      this.stats.primaryChannel = channel;
    }

    if (msg.t === MSG.PING) {
      this.send(MSG.PONG, { echo: msg.ts });
    } else if (msg.t === MSG.PONG && Number.isFinite(msg.echo)) {
      // echo 是本端 PING 时写入的 Date.now()，必须用同一时钟相减，否则 RTT 恒为 0。
      this.stats.rtt = Math.max(0, Date.now() - msg.echo);
    } else if (msg.t === MSG.HELLO && !this.isPhone) {
      this._setStatus('webrtc', this.status.webrtc.state === 'open' ? 'open' : this.status.webrtc.state, '手机已接入');
    }

    this._messageHandlers.forEach((fn) => { try { fn(msg, channel); } catch (e) { console.error(e); } });
  }

  _heartbeat() {
    if (this._closed) return;
    if (this._conns.size > 0 || this.status.mqtt.state === 'open') this.send(MSG.PING);
    this._later(() => this._heartbeat(), 1500);
  }

  // ---- WebRTC (PeerJS) ---------------------------------------------------

  _startWebRtc() {
    if (typeof window.Peer === 'undefined') {
      this._setStatus('webrtc', 'failed', 'peerjs 未加载');
      return;
    }
    this._setStatus('webrtc', 'connecting', '连接信令服务器…');
    if (this.isPhone) this._openPeerAsPhone();
    else this._openPeerAsHost();
  }

  _openPeerAsHost() {
    if (this._closed) return;
    let peer;
    try {
      peer = new window.Peer(peerIdFor(this.room), { config: RTC_CONFIG, debug: 0 });
    } catch {
      this._setStatus('webrtc', 'failed', '无法创建 Peer');
      return;
    }
    this._peer = peer;

    peer.on('open', () => this._setStatus('webrtc', 'open', '等待手机接入'));
    peer.on('connection', (conn) => {
      this._conns.add(conn);
      this._wireConn(conn);
      this._setStatus('webrtc', 'open', '手机已接入');
    });
    peer.on('disconnected', () => {
      if (this._closed) return;
      this._setStatus('webrtc', 'connecting', '信令断开，重连中');
      try { peer.reconnect(); } catch { /* 已销毁 */ }
    });
    peer.on('error', (err) => {
      const type = err && err.type;
      if (type === 'unavailable-id') {
        // 上一次会话占用的 peer id 还没被信令服务器回收，等几秒重试。
        try { peer.destroy(); } catch { /* 已销毁 */ }
        this._setStatus('webrtc', 'connecting', '房间号占用，稍后重试');
        this._later(() => this._openPeerAsHost(), 5000);
        return;
      }
      this._setStatus('webrtc', 'failed', type === 'network' ? '信令服务器不可达' : String(type || '连接失败'));
      this._later(() => {
        // 同一个 peer 反复报错会排出多个重启定时器；若期间已有新 peer 接替就跳过，避免堆叠实例。
        if (this._closed || this._peer !== peer || this.status.webrtc.state === 'open') return;
        try { peer.destroy(); } catch { /* 已销毁 */ }
        this._openPeerAsHost();
      }, 6000);
    });
  }

  _openPeerAsPhone() {
    if (this._closed) return;
    let peer;
    try {
      peer = new window.Peer(null, { config: RTC_CONFIG, debug: 0 });
    } catch {
      this._setStatus('webrtc', 'failed', '无法创建 Peer');
      return;
    }
    this._peer = peer;

    peer.on('open', () => {
      this._setStatus('webrtc', 'connecting', '寻找电脑端…');
      let conn;
      try {
        conn = peer.connect(peerIdFor(this.room), { reliable: false, serialization: 'json' });
      } catch {
        this._queuePeerRetry();
        return;
      }
      conn.on('open', () => {
        this._conns.add(conn);
        this._wireConn(conn);
        // 连接稳定存活一段时间后才清零计数；若一 open 就清零，反复 open/close 会冲掉重试上限。
        this._later(() => {
          if (this._conns.has(conn) && conn.open) this._rtcAttempts = 0;
        }, PEER_STABLE_MS);
        this._setStatus('webrtc', 'open', '点对点已直连');
        this.send(MSG.HELLO);
      });
      conn.on('error', () => this._queuePeerRetry());
    });

    peer.on('error', (err) => {
      const type = err && err.type;
      if (type === 'peer-unavailable') {
        this._setStatus('webrtc', 'connecting', '电脑端未上线，重试中');
      } else {
        this._setStatus('webrtc', 'failed', String(type || '连接失败'));
      }
      this._queuePeerRetry();
    });

    peer.on('disconnected', () => {
      if (this._closed) return;
      this._setStatus('webrtc', 'connecting', '信令断开，重连中');
      try { peer.reconnect(); } catch { /* 已销毁 */ }
    });
  }

  _queuePeerRetry() {
    if (this._closed || this._rtcRetryTimer) return;
    this._rtcAttempts++;
    if (this._rtcAttempts > PEER_ATTEMPT_LIMIT) {
      this._setStatus('webrtc', 'failed', '点对点没连上，已全靠中转通道');
      return;
    }
    const delay = Math.min(1200 + this._rtcAttempts * 900, 6000);
    this._rtcRetryTimer = this._later(() => {
      this._rtcRetryTimer = 0;
      if (this._closed || this.status.webrtc.state === 'open') return;
      try { this._peer?.destroy(); } catch { /* 已销毁 */ }
      this._peer = null;
      this._openPeerAsPhone();
    }, delay);
  }

  _wireConn(conn) {
    conn.on('data', (data) => {
      if (typeof data === 'string') this._ingest(data, 'webrtc');
      else if (data && typeof data === 'object') this._ingest(encode(data), 'webrtc');
    });
    conn.on('close', () => {
      this._conns.delete(conn);
      if (this._closed) return;
      this._setStatus('webrtc', 'connecting', '点对点断开，重试中');
      if (this.isPhone) this._queuePeerRetry();
    });
    conn.on('error', () => { /* 交给 close / peer error 处理 */ });
  }

  // ---- MQTT 中转 ---------------------------------------------------------

  _startMqtt() {
    if (typeof window.mqtt === 'undefined') {
      this._setMqttStatus( 'failed', 'mqtt.js 未加载');
      return;
    }
    const url = MQTT_BROKERS[this._mqttBrokerIndex];
    this._setMqttStatus( 'connecting', url);

    let client;
    try {
      client = window.mqtt.connect(url, {
        clientId: `vf-${this.role}-${this.room}-${Math.random().toString(16).slice(2, 8)}`,
        clean: true,
        reconnectPeriod: 2500,
        connectTimeout: 8000,
        keepalive: 30,
        protocolVersion: 4,
      });
    } catch {
      this._switchBroker();
      return;
    }
    this._mqttClient = client;
    let everConnected = false;

    client.on('connect', () => {
      everConnected = true;
      this._mqttSwitching = false;
      const topic = this.isPhone ? topicDown(this.room) : topicUp(this.room);
      client.subscribe(topic, { qos: 0 }, (err) => {
        if (err) this._setMqttStatus( 'failed', '订阅失败');
        else this._setMqttStatus( 'open', url.replace('wss://', ''));
      });
    });

    client.on('message', (_topic, payload) => this._ingest(String(payload), 'mqtt'));

    client.on('error', () => {
      if (!everConnected) this._switchBroker();
      else this._setMqttStatus( 'connecting', '中转连接异常，重连中');
    });

    client.on('close', () => {
      if (!this._closed && !everConnected) return;
      if (!this._closed && this.status.mqtt.state === 'open') {
        this._setMqttStatus( 'connecting', '中转断开，重连中');
      }
    });
  }

  _switchBroker() {
    if (this._closed || this._mqttSwitching) return;
    if (this._mqttBrokerIndex >= MQTT_BROKERS.length - 1) {
      this._setMqttStatus( 'failed', '两个中转服务器都没连上');
      return;
    }
    this._mqttSwitching = true;
    this._mqttBrokerIndex++;
    const old = this._mqttClient;
    this._mqttClient = null;
    if (old) {
      try { old.removeAllListeners(); old.end(true); } catch { /* 已关闭 */ }
    }
    this._setMqttStatus( 'connecting', `切换中转服务器…`);
    this._later(() => { this._mqttSwitching = false; this._startMqtt(); }, 400);
  }
}