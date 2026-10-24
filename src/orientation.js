// 设备朝向 → 四元数，以及电脑端的平滑、设正与姿态矫正。
//
// 灵敏度固定 1:1：不对旋转角做任何放大/缩小，手机转多少度，虚拟手机就转多少度。
// 平滑只影响"追上去"的速度，不影响最终角度 —— 停下来之后角度与真机完全一致。
// 之前那套角速度外推会在运动途中超过真实角度，正是"不一致"的来源，已经删掉。
import * as THREE from 'three';

const ZEE = new THREE.Vector3(0, 0, 1);
const EULER = new THREE.Euler();
const Q0 = new THREE.Quaternion();
const Q1 = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);

const _rel = new THREE.Quaternion();
const _leveled = new THREE.Quaternion();
const _inv = new THREE.Quaternion();
const _angles = new THREE.Euler();

export function deviceOrientationToQuaternion(out, alpha, beta, gamma, screenAngle) {
  const a = THREE.MathUtils.degToRad(Number.isFinite(alpha) ? alpha : 0);
  const b = THREE.MathUtils.degToRad(Number.isFinite(beta) ? beta : 0);
  const g = THREE.MathUtils.degToRad(Number.isFinite(gamma) ? gamma : 0);
  const o = THREE.MathUtils.degToRad(Number.isFinite(screenAngle) ? screenAngle : 0);

  EULER.set(b, a, -g, 'YXZ');
  out.setFromEuler(EULER);
  out.multiply(Q1);
  // 这一步是"按屏幕方向修正"：手机横过来时，画面不会跟着翻滚 90°，
  // 而是像相机 App 一样保持地平线水平。竖屏/横屏的差别全靠它。
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

export function screenOrientationLabel(angle) {
  const a = ((Math.round(Number(angle) || 0) % 360) + 360) % 360;
  if (a === 0) return '竖屏';
  if (a === 90) return '横屏 90°';
  if (a === 180) return '倒竖屏 180°';
  if (a === 270) return '横屏 270°';
  return `屏幕 ${a}°`;
}

// 四元数 → 直观的三轴角度（度）。yaw=左右，pitch=俯仰，roll=翻滚。
export function quaternionToAngles(q, out = {}) {
  _angles.setFromQuaternion(q, 'YXZ');
  out.yaw = THREE.MathUtils.radToDeg(_angles.y);
  out.pitch = THREE.MathUtils.radToDeg(_angles.x);
  out.roll = THREE.MathUtils.radToDeg(_angles.z);
  return out;
}

// 去掉翻滚、保留朝向和俯仰：地平线转正，但看的方向不变。
export function withoutRoll(q, out = new THREE.Quaternion()) {
  _angles.setFromQuaternion(q, 'YXZ');
  _angles.z = 0;
  return out.setFromEuler(_angles);
}

function shortest(q) {
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
  return q;
}

// 手机端：把 deviceorientation 聚合成一个"当前朝向四元数"。
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
  readInto(out, offset = null) {
    deviceOrientationToQuaternion(out, this.alpha, this.beta, this.gamma, this.screenAngle());
    if (offset) out.multiply(offset);
    return out;
  }
}

// 电脑端：平滑 + 设正 + 校平。灵敏度不在这里做任何缩放。
export class OrientationSmoother {
  constructor({ tau = 0.04, rollLock = true } = {}) {
    this.tau = tau;
    // 自动校平：每帧把翻滚清零，地平线永远水平。
    // 关掉之后手机怎么翻，虚拟手机就怎么翻（完整 3DoF）。
    this.rollLock = rollLock;
    this.target = new THREE.Quaternion();
    this.current = new THREE.Quaternion();
    this.relative = new THREE.Quaternion();
    this._calib = new THREE.Quaternion();
    this._calibInverse = new THREE.Quaternion();
    this._lastSource = new THREE.Quaternion();
    this._hasSource = false;
    this.calibrated = false;
    this.received = 0;
  }

  // 设正：把"按下这一刻的朝向"记成正前方，读数和画面全部归零。
  calibrate(sourceQuaternion = null) {
    const source = sourceQuaternion || (this._hasSource ? this._lastSource : this.target);
    this._calib.copy(source);
    this._calibInverse.copy(source).invert();
    this.calibrated = true;
    this.target.identity();
    this.current.identity();
    this.relative.identity();
    return this;
  }

  // 校平：只把翻滚转正（地平线水平），朝向和俯仰保持不变，画面不跳。
  level(sourceQuaternion = null) {
    const source = sourceQuaternion || (this._hasSource ? this._lastSource : null);
    if (!this.calibrated || !source) return this.calibrate(source || this.target);

    _rel.copy(this._calibInverse).multiply(source);
    shortest(_rel);
    withoutRoll(_rel, _leveled);

    // 新的校准零点 C' 满足 C'⁻¹·S = 校平后的相对量：C' = S·L⁻¹
    _inv.copy(_leveled).invert();
    this._calib.copy(source).multiply(_inv);
    this._calibInverse.copy(this._calib).invert();

    this.relative.copy(_leveled);
    this.target.copy(_leveled);
    this.current.copy(_leveled);
    return this;
  }

  push(sourceQuaternion) {
    this._lastSource.copy(sourceQuaternion);
    this._hasSource = true;
    this.received++;
    if (!this.calibrated) this.calibrate(sourceQuaternion);

    _rel.copy(this._calibInverse).multiply(sourceQuaternion);
    shortest(_rel);
    if (this.rollLock) withoutRoll(_rel, _rel);

    this.relative.copy(_rel);
    this.target.copy(_rel);
    return this.target;
  }

  // 每帧调用：朝目标收敛。tau 越小越跟手，0 就是完全不过滤。
  update(dt) {
    if (!this.calibrated) return this.current;
    if (this.tau <= 0.001) {
      this.current.copy(this.target);
      return this.current;
    }
    const alpha = 1 - Math.exp(-Math.max(dt, 0) / this.tau);
    this.current.slerp(this.target, Math.min(1, alpha));
    // slerp 只会无限逼近；把残差按浮点精度直接抹平，保证静止时角度严格 1:1。
    if (Math.abs(this.current.dot(this.target)) > 0.99999999) this.current.copy(this.target);
    return this.current;
  }

  getAngles(out = {}) {
    return quaternionToAngles(this.current, out);
  }
}

// 手机端只用来显示相对角度，不参与控制（真正的校准在电脑端）。
export class RelativeOrientation {
  constructor() {
    this._inverse = new THREE.Quaternion();
    this.calibrated = false;
    this.angles = { yaw: 0, pitch: 0, roll: 0 };
  }

  reset() {
    this.calibrated = false;
    this.angles.yaw = this.angles.pitch = this.angles.roll = 0;
  }

  calibrate(q) {
    this._inverse.copy(q).invert();
    this.calibrated = true;
    this.angles.yaw = this.angles.pitch = this.angles.roll = 0;
  }

  level(q) {
    if (!this.calibrated) return this.calibrate(q);
    _rel.copy(this._inverse).multiply(q);
    shortest(_rel);
    withoutRoll(_rel, _leveled);
    _inv.copy(q).invert();
    this._inverse.copy(_leveled).multiply(_inv);
  }

  readAngles(q, rollLock = false, out = this.angles) {
    if (!this.calibrated) this.calibrate(q);
    _rel.copy(this._inverse).multiply(q);
    shortest(_rel);
    quaternionToAngles(_rel, out);
    if (rollLock) out.roll = 0;
    return out;
  }
}
