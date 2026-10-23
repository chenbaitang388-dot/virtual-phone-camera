// 录制虚拟手机摄像头的画面：直接把 Three.js 的主 canvas 抓成流给 MediaRecorder。
// 因为画面就是 canvas 本身，所以"录什么"完全由渲染时的构图决定。
const CANDIDATE_MIME = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
];

export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const type of CANDIDATE_MIME) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch { /* 某些浏览器 isTypeSupported 会抛错 */ }
  }
  return '';
}

export function recorderSupport() {
  const ok = typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function';
  return { ok, mimeType: ok ? pickMimeType() : '' };
}

export class CanvasRecorder {
  constructor(canvas, { onStateChange = () => {}, onDone = () => {} } = {}) {
    this.canvas = canvas;
    this.onStateChange = onStateChange;
    this.onDone = onDone;
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
    this.startedAt = 0;
    this.lastDuration = 0;
    this.lastBlob = null;
    this.mimeType = '';
  }

  get recording() {
    return !!this.recorder && this.recorder.state === 'recording';
  }

  get elapsed() {
    return this.recording ? performance.now() - this.startedAt : this.lastDuration;
  }

  start({ fps = 30, bitsPerSecond = 12_000_000 } = {}) {
    if (this.recording) return false;
    if (typeof this.canvas.captureStream !== 'function') {
      throw new Error('这个浏览器不支持 canvas.captureStream()，请用电脑上的 Chrome 或 Edge');
    }
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('这个浏览器不支持 MediaRecorder');
    }

    this.stream = this.canvas.captureStream(fps);
    const mimeType = pickMimeType();
    const options = {};
    if (mimeType) options.mimeType = mimeType;
    if (bitsPerSecond > 0) options.videoBitsPerSecond = bitsPerSecond;

    try {
      this.recorder = new MediaRecorder(this.stream, options);
    } catch {
      this.recorder = new MediaRecorder(this.stream);
    }
    this.mimeType = this.recorder.mimeType || mimeType || 'video/webm';

    this.chunks = [];
    this.startedAt = performance.now();

    this.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.onerror = (event) => {
      this._releaseStream();
      this.onStateChange({ state: 'error', error: event.error || new Error('录制过程出错') });
    };
    this.recorder.onstop = () => {
      this.lastDuration = performance.now() - this.startedAt;
      const blob = new Blob(this.chunks, { type: this.mimeType.split(';')[0] || 'video/webm' });
      this.chunks = [];
      this.lastBlob = blob;
      this._releaseStream();
      this.onStateChange({ state: 'stopped', duration: this.lastDuration, size: blob.size });
      this.onDone({ blob, duration: this.lastDuration, mimeType: this.mimeType });
    };

    // 每秒切一个分片，长时间录制就不会在内存里攒出一个巨大的 blob。
    this.recorder.start(1000);
    this.onStateChange({ state: 'recording', mimeType: this.mimeType });
    return true;
  }

  stop() {
    if (this.recording) this.recorder.stop();
  }

  toggle(options) {
    if (this.recording) {
      this.stop();
      return false;
    }
    this.start(options);
    return true;
  }

  _releaseStream() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => { try { track.stop(); } catch { /* 已停止 */ } });
      this.stream = null;
    }
  }
}