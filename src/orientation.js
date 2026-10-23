// 设备朝向 → 四元数，以及电脑端的平滑与外推。
// 关键约定：手机页和电脑端用的是同一套设备坐标系（three.js 里 DeviceOrientationControls 的经典换算），
// 因此手机上"把手机转过去对着某处"就等于虚拟手机摄像头转向同一方向。
import * as THREE from 'three';

const ZEE = new THREE.Vector3(0, 0, 1);
const EULER = new THREE.Euler();
const Q0 = new THREE.Quaternion();
const Q1 = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);

export function deviceOrientationToQuaternion(out, alpha, beta, gamma, screenAngle) {
  const a = THREE.MathUtils.degToRad(Number.isFinite(alpha) ? alpha : 0);
  const b = THREE.MathUtils.degToRad(Number.isFinite(beta) ? beta : 0);
  const g = THREE.MathUtils.degToRad(Number.isFinite(gamma) ? gamma : 0);
  const o = THREE.MathUtils.degToRad(Number.isFinite(screenAngle) ? screenAngle : 0);

  EULER.set(b, a, -g, 'YXZ');
  out.setFromEuler(EULER);
  out.multiply(Q1);
  out.multiply(Q0.setFromAxisAngle(ZEE, -o));
  return out;
}

export function supportsDeviceOrientation() {
  return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
}

export function needsPermissionGesture() {
  return supportsDeviceOrientation() &&
    typeof window.DeviceOrientationEvent.requestPermission === 'function';
}

// 手机端：把 deviceorientation 事件聚合成一个"当前朝四元数"。
export class OrientationSource {
  constructor() {
    this.quaternion = new THREE.Quaternion();
    this.alpha = 0;
    this.beta = 0;
    this.gamma = 0;
    this.absolute = false;
    this.hasData = false;
    this.eventCount = 0;
    this.lastEventAt = 0;
    this._listening = false;
    this._handler = null;
  }

  async start() {
    if (!supportsDeviceOrientation()) {
      throw new Error('这台设备/浏览器不支持 deviceorientation 传感器');
    }
    if (needsPermissionGesture()) {
      const result = await window.DeviceOrientationEvent.requestPermission();
      if (result !== 'granted') throw new Error('用户拒绝了陀螺仪权限');
    }

    this._handler = (e) => {
      // iOS 只在某些事件上给出 alpha=null，用它判断传感器是否真的在供货。
      if (e.alpha === null && e.beta === null && e.gamma === null) return;
      this.alpha = e.alpha ?? 0;
      this.beta = e.beta ?? 0;
      this.gamma = e.gamma ?? 0;
      // iOS Safari 提供 webkitCompassHeading（真北朝向），有它就能避免累积漂移。
      if (Number.isFinite(e.webkitCompassHeading)) {
        this.alpha = e.webkitCompassHeading;
        this.absolute = true;
      } else {
        this.absolute = e.absolute === true;
      }
      this.eventCount++;
      this.lastEventAt = performance.now();
      this.hasData = true;
    };

    window.addEventListener('deviceorientation', this._handler, true);
    this._listening = true;
    return true;
  }

  stop() {
    if (this._handler) window.removeEventListener('deviceorientation', this._handler, true);
    this._handler = null;
    this._listening = false;
  }

  get listening() {
    return this._listening;
  }

  screenAngle() {
    const angle = (screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0;
    return Number.isFinite(angle) ? angle : 0;
  }

  // 取一个"当下"的四元数：设备朝向换算之后，再叠加触摸微调产生的局部偏移。
  // 灵敏度不在这里做 —— 放大旋转必须相对"校准零点"来算，那个零点在电脑端，
  // 所以灵敏度由电脑端的 OrientationSmoother.gain 负责。
  readInto(out, offset = null) {
    deviceOrientationToQuaternion(out, this.alpha, this.beta, this.gamma, this.screenAngle());
    if (offset) out.multiply(offset);
    return out;
  }
}

// 电脑端：把收到的朝向做 slerp 平滑，并在延迟明显时做一点角速度外推。
export class OrientationSmoother {
  constructor({ tau = 0.055, leadCap = 0.09, gain = 1 } = {}) {
    this.tau = tau;
    this.leadCap = leadCap;
    // gain 是灵敏度：>1 表示手机转一点、虚拟摄像头转更多。
    this.gain = gain;
    this.target = new THREE.Quaternion();
    this.current = new THREE.Quaternion();
    this.predicted = new THREE.Quaternion();
    this._calib = new THREE.Quaternion();
    this._calibInverse = new THREE.Quaternion();
    this._prev = new THREE.Quaternion();
    // 上一帧"测量"到的相对量（未外推）。角速度必须由它算，不能用已外推的 target，
    // 否则外推量会被当成运动、下一帧差分反向，导致速率虚假放大与来回抖动。
    this._prevRelative = new THREE.Quaternion();
    this._lastSource = new THREE.Quaternion();
    this._hasSource = false;
    this._hasPrev = false;
    this._prevAt = 0;
    this._scratch = new THREE.Quaternion();
    this._extra = new THREE.Quaternion();
    this._axis = new THREE.Vector3();
    this.latency = 0;
    this.calibrated = false;
    this.angularRate = 0;
  }

  // 校准：把"按下校准那一刻的朝向"记成虚拟摄像头的零点，
  // 之后所有旋转都是相对这个零点的增量，用户不用管手机初始朝向。
  calibrate(sourceQuaternion = null) {
    const source = sourceQuaternion || (this._hasSource ? this._lastSource : this.target);
    this._calib.copy(source);
    this._calibInverse.copy(source).invert();
    this.calibrated = true;
    this.target.identity();
    this.current.identity();
    this._prevRelative.identity();
    this._hasPrev = false;
  }

  push(sourceQuaternion, nowMs = performance.now()) {
    this._lastSource.copy(sourceQuaternion);
    this._hasSource = true;
    if (!this.calibrated) this.calibrate(sourceQuaternion);

    const relative = this._scratch.copy(this._calibInverse).multiply(sourceQuaternion);
    if (relative.w < 0) {
      // 统一成最短路径表示，后面的角度和轴才是对的。
      relative.set(-relative.x, -relative.y, -relative.z, -relative.w);
    }

    if (this.gain !== 1) {
      const half = Math.acos(Math.min(1, relative.w));
      const sin = Math.sin(half);
      if (sin > 1e-5) {
        this._axis.set(relative.x, relative.y, relative.z).divideScalar(sin);
        relative.setFromAxisAngle(this._axis, Math.min(2 * half * this.gain, Math.PI * 0.995));
      }
    }

    if (this._hasPrev) {
      const dt = Math.max(1e-3, (nowMs - this._prevAt) / 1000);
      // 差分参考上一帧"测量"相对量，而不是已外推的 target：
      // 否则外推量会被算进 delta，速率被放大、轴甚至反向，预测来回抖。
      const delta = this._prevRelative.clone().invert().multiply(relative);
      // relative 的 "w 取正" 会在旋转跨过 180° 时把四元数整体变号，
      // 于是这里的 delta 可能被带上一个多余负号，令轴反向、外推抖动。
      // 先把 delta 归一到 w>=0（最短路径），再取轴与半角，两者才自洽。
      if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
      const halfAngle = Math.acos(Math.min(1, delta.w));
      const sin = Math.sin(halfAngle);
      if (sin > 1e-5) {
        this._axis.set(delta.x, delta.y, delta.z).divideScalar(sin);
        // 把局部角速度轴搬到世界系，再绕它外推，这样不管手机什么姿态都成立。
        this._axis.applyQuaternion(relative);
        const rate = (2 * halfAngle) / dt;
        this.angularRate = rate;
        if (this.latency > 0.04) {
          const extra = Math.min(rate * Math.min(this.latency * 0.5, this.leadCap), 0.35);
          this._extra.setFromAxisAngle(this._axis, extra);
          this.predicted.copy(this._extra).multiply(relative);
        } else {
          this.predicted.copy(relative);
        }
      } else {
        this.predicted.copy(relative);
      }
    } else {
      this.predicted.copy(relative);
    }

    this._prev.copy(this.target);
    this._prevRelative.copy(relative);
    this._prevAt = nowMs;
    this._hasPrev = true;
    this.target.copy(this.predicted);
  }

  // 每帧调用：朝目标收敛。tau 越小越跟手，越大越平滑但更"拖"。
  update(dt) {
    if (!this.calibrated) return this.current;
    const tau = Math.max(0.001, this.tau);
    const alpha = 1 - Math.exp(-Math.max(dt, 0) / tau);
    this.current.slerp(this.target, Math.min(1, alpha));
    return this.current;
  }
}