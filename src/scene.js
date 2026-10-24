// 3D 场景：360° 全景天空球 + 地面道具 + 一台"虚拟手机"。
// 虚拟手机上有三台相机：
//   phoneCam   —— 装在手机背面（朝 -Z），这就是录制用的第一人称相机
//   previewCam —— 同一个位置，但用手机屏幕的竖屏比例，渲染到离屏纹理当手机屏幕内容
//   operatorCam—— 导播视角，绕着虚拟手机转，用来看这台手机在场景里的姿态
// 手机的姿态由外部每帧通过 setOrientation() 灌进来（来自真手机的陀螺仪）。
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';

const PHONE_PIVOT = new THREE.Vector3(0, 1.55, 0);
const BODY = { w: 0.072, h: 0.152, d: 0.0086 };
const SCREEN_INSET = 0.005;
const PREVIEW_SIZE = { w: 512, h: 1024 };

const _idleEuler = new THREE.Euler();
const _idleQuat = new THREE.Quaternion();

function mulberry32(seed) {
  let s = seed;
  return function next() {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roundedRectPath(path, w, h, r) {
  const x = -w / 2;
  const y = -h / 2;
  path.moveTo(x + r, y);
  path.lineTo(x + w - r, y);
  path.quadraticCurveTo(x + w, y, x + w, y + r);
  path.lineTo(x + w, y + h - r);
  path.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  path.lineTo(x + r, y + h);
  path.quadraticCurveTo(x, y + h, x, y + h - r);
  path.lineTo(x, y + r);
  path.quadraticCurveTo(x, y, x + r, y);
  return path;
}

// 兜底全景：万一 panorama.js 出问题，至少不是一片黑。
function makeFallbackPanorama() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, '#0b1030');
  g.addColorStop(0.45, '#3b2350');
  g.addColorStop(0.5, '#c96a3c');
  g.addColorStop(0.62, '#241a2e');
  g.addColorStop(1, '#07090f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 512);
  return canvas;
}

export class VirtualPhoneStudio {
  constructor({ canvas, container }) {
    this.canvas = canvas;
    this.container = container;
    this.layout = 'split';
    this.sizeMode = 'auto';
    this.size = { w: 16, h: 16 };
    this._css = { w: 0, h: 0 };
    this.idle = true;
    this.showPhone = true;
    this._target = new THREE.Quaternion();
    this._orientation = new THREE.Quaternion();
    this._elapsed = 0;
    this._lastAt = performance.now();
    this._raf = 0;
    this._sky = null;
    this.importedModel = null;
    this.onFrame = null;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.autoClear = true;

    this.scene = new THREE.Scene();
    this.previewRT = new THREE.WebGLRenderTarget(PREVIEW_SIZE.w, PREVIEW_SIZE.h, {
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.previewRT.texture.colorSpace = THREE.SRGBColorSpace;

    this._rects = { phone: null, operator: null };
    this._buildSky();
    this._buildLights();
    this._buildGround();
    this._buildProps();
    this._buildPhone();

    this.operatorCam = new THREE.PerspectiveCamera(50, 1, 0.05, 800);
    this.operatorCam.position.set(1.05, 1.95, 1.35);

    this.controls = new OrbitControls(this.operatorCam, this.container);
    this.controls.target.copy(PHONE_PIVOT);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = 0.45;
    this.controls.maxDistance = 12;
    this.controls.minPolarAngle = 0.15;
    this.controls.maxPolarAngle = Math.PI - 0.15;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.55;
    this.controls.update();

    this._observer = new ResizeObserver(() => this._applySize());
    this._observer.observe(container);
    this._applySize();
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
  }

  // ---- 对外接口 ---------------------------------------------------------

  async setPanorama(theme = 'dusk') {
    let canvas = null;
    try {
      const module = await import('./panorama.js');
      canvas = module.createPanoramaCanvas({ width: 4096, height: 2048, theme });
    } catch (err) {
      console.warn('[scene] 全景生成失败，使用内置渐变兜底', err);
    }
    const source = canvas || makeFallbackPanorama();
    const texture = new THREE.CanvasTexture(source);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());

    const previous = this._sky.material.map;
    this._sky.material.map = texture;
    this._sky.material.needsUpdate = true;
    if (previous) previous.dispose();
    return texture;
  }

  setLayout(mode) {
    this.layout = mode === 'phone' || mode === 'operator' ? mode : 'split';
    this.controls.enabled = this.layout !== 'phone';
    this._layoutViews();
  }

  setRenderSize(mode) {
    this.sizeMode = mode === 'auto' ? 'auto' : { w: mode.w | 0, h: mode.h | 0 };
    this._applySize();
  }

  setShowPhone(visible) {
    this.showPhone = !!visible;
    this.phoneVisual.visible = this.showPhone;
  }

  setAutoRotate(enabled) {
    this.controls.autoRotate = !!enabled;
  }

  setFov(degrees) {
    const fov = THREE.MathUtils.clamp(degrees, 30, 110);
    this.phoneCam.fov = fov;
    this.previewCam.fov = fov;
    this.phoneCam.updateProjectionMatrix();
    this.previewCam.updateProjectionMatrix();
  }

  setOrientation(quaternion) {
    this.idle = false;
    this._target.copy(quaternion);
  }

  // 给页面用：拿到当前各视角所占的像素矩形，用来把 DOM 标签对齐到画面对应位置。
  getViewRects() {
    return {
      phone: this._rects.phone,
      operator: this._rects.operator,
      size: { ...this.size },
      css: { ...this._css },
      scale: this._css.w / Math.max(1, this.size.w),
    };
  }

  setIdle(enabled) {
    this.idle = !!enabled;
  }

  snapOrientation() {
    this._orientation.copy(this._target);
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this._observer.disconnect();
    this.controls.dispose();
    this.scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      const material = obj.material;
      if (!material) return;
      const list = Array.isArray(material) ? material : [material];
      list.forEach((m) => {
        Object.values(m).forEach((v) => { if (v && v.isTexture) v.dispose(); });
        m.dispose();
      });
    });
    this.previewRT.dispose();
    this.renderer.dispose();
  }

  // ---- 导入自己的素材 ---------------------------------------------------

  // 换掉全景天空球。file 来自 <input type="file"> 或直接拖进画面。
  async loadPanoramaImage(file) {
    const image = await this._readImageFile(file);
    const texture = new THREE.Texture(image);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.needsUpdate = true;
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());

    const previous = this._sky.material.map;
    this._sky.material.map = texture;
    this._sky.material.needsUpdate = true;
    if (previous) previous.dispose();

    return {
      width: image.width,
      height: image.height,
      ratio: image.width / Math.max(1, image.height),
    };
  }

  _readImageFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('这个图片文件读不出来')); };
      image.src = url;
    });
  }

  // 载入 .glb（Blender 导出的 glTF 2.0 二进制）。
  // mode='surround'：把模型中心套在相机位置，适合房间、街景这类大场景，镜头是"站在里面"；
  // mode='prop'：把它当一个摆件放在镜头正前方。
  async loadModelFromFile(file, { mode = 'surround' } = {}) {
    const { GLTFLoader } = await import('../vendor/GLTFLoader.js');
    const loader = new GLTFLoader();
    const buffer = await file.arrayBuffer();

    const gltf = await new Promise((resolve, reject) => {
      loader.parse(buffer, '', resolve, (err) => {
        console.warn('[scene] glTF 解析失败：', err);
        reject(new Error(
          '这个文件不是有效的 .glb 模型。常见原因：导出时选了 glTF Separate（.gltf + .bin + 贴图）' +
          '而不是 .glb，或者勾了 Draco 压缩。',
        ));
      });
    });

    const root = gltf.scene;
    let meshes = 0;
    let triangles = 0;
    root.traverse((obj) => {
      if (!obj.isMesh) return;
      meshes++;
      const index = obj.geometry?.index;
      const position = obj.geometry?.attributes?.position;
      if (index) triangles += index.count / 3;
      else if (position) triangles += position.count / 3;
    });
    if (!meshes) throw new Error('这个模型里没有可显示的网格');

    root.position.set(0, 0, 0);
    root.updateMatrixWorld(true);
    const rawBox = new THREE.Box3().setFromObject(root);
    const rawSize = rawBox.getSize(new THREE.Vector3());
    if (!Number.isFinite(rawSize.x) || rawSize.length() === 0) throw new Error('模型尺寸异常');

    const largest = Math.max(rawSize.x, rawSize.y, rawSize.z);
    const scale = mode === 'surround'
      ? 8 / Math.max(Math.min(rawSize.x, rawSize.z), 1e-6)
      : 3.2 / largest;
    root.scale.setScalar(scale);
    root.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(root);
    const center = box.getCenter(new THREE.Vector3());
    if (mode === 'surround') {
      // 模型中心对齐到虚拟手机所在的位置，相机就落在模型内部
      root.position.copy(PHONE_PIVOT).sub(center);
    } else {
      // 底面贴地、水平居中，然后整体推到镜头正前方 2.6 米
      root.position.set(-center.x, -box.min.y, -box.max.z - 2.6);
    }

    this.clearImportedModel();
    this.importedModel = root;
    this.scene.add(root);
    this.setPropsVisible(false);
    this.groundGroup.visible = mode === 'prop';

    return {
      meshes,
      triangles: Math.round(triangles),
      rawSize: `${rawSize.x.toFixed(2)} × ${rawSize.y.toFixed(2)} × ${rawSize.z.toFixed(2)}`,
      scale,
    };
  }

  clearImportedModel() {
    if (!this.importedModel) return;
    this.scene.remove(this.importedModel);
    this.importedModel.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      const material = obj.material;
      if (!material) return;
      const list = Array.isArray(material) ? material : [material];
      list.forEach((m) => {
        Object.values(m).forEach((v) => { if (v && v.isTexture) v.dispose(); });
        m.dispose();
      });
    });
    this.importedModel = null;
    this.setPropsVisible(true);
    this.groundGroup.visible = true;
  }

  setPropsVisible(visible) {
    if (!this.props) return;
    this.props.forEach((prop) => { prop.visible = visible; });
  }

  // ---- 场景搭建 ---------------------------------------------------------

  _buildSky() {
    const geometry = new THREE.SphereGeometry(400, 64, 40);
    const material = new THREE.MeshBasicMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      toneMapped: false,
    });
    material.map = new THREE.CanvasTexture(makeFallbackPanorama());
    material.map.colorSpace = THREE.SRGBColorSpace;
    this._sky = new THREE.Mesh(geometry, material);
    this._sky.frustumCulled = false;
    // 全景纹理的水平中点正好落在球体的 +X，转 90° 之后"N"标记就出现在 -Z，
    // 也就是虚拟手机开机时（未校准、朝向为单位四元数）看向的方向。
    this._sky.rotation.y = Math.PI / 2;
    this.scene.add(this._sky);
  }

  _buildLights() {
    this.scene.add(new THREE.HemisphereLight(0x9ec5ff, 0x140a20, 1.05));

    const key = new THREE.DirectionalLight(0xffd7a8, 1.6);
    key.position.set(16, 24, 12);
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x4f8cff, 1.0);
    rim.position.set(-14, 9, -16);
    this.scene.add(rim);

    const glowA = new THREE.PointLight(0x38bdf8, 22, 22, 2);
    glowA.position.set(3.2, 2.4, -3.4);
    this.scene.add(glowA);

    const glowB = new THREE.PointLight(0xf472b6, 18, 20, 2);
    glowB.position.set(-3.6, 1.9, 3.1);
    this.scene.add(glowB);
  }

  _buildGround() {
    this.groundGroup = new THREE.Group();

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(90, 72),
      new THREE.MeshStandardMaterial({ color: 0x0a1120, roughness: 0.82, metalness: 0.18 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.001;
    this.groundGroup.add(floor);

    const grid = new THREE.PolarGridHelper(34, 16, 10, 72, 0x1f4066, 0x122740);
    grid.position.y = 0.004;
    grid.material.transparent = true;
    grid.material.opacity = 0.55;
    this.groundGroup.add(grid);

    this.scene.add(this.groundGroup);
  }

  _buildProps() {
    const random = mulberry32(97531);
    const palette = [0x38bdf8, 0x60a5fa, 0xa78bfa, 0xf472b6, 0x34d399, 0xfbbf24];
    this.props = [];

    // 一圈高低不同的柱子，用来产生明显的视差
    const pillarGeo = new THREE.BoxGeometry(1, 1, 1);
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2 + 0.13;
      const radius = 15 + random() * 9;
      const height = 2.2 + random() * 6.5;
      const width = 1.1 + random() * 1.5;
      const material = new THREE.MeshStandardMaterial({
        color: palette[i % palette.length],
        roughness: 0.35,
        metalness: 0.55,
        emissive: palette[i % palette.length],
        emissiveIntensity: 0.22,
      });
      const pillar = new THREE.Mesh(pillarGeo, material);
      pillar.position.set(Math.cos(angle) * radius, height / 2, Math.sin(angle) * radius);
      pillar.scale.set(width, height, width);
      this.scene.add(pillar);
      this.props.push(pillar);
    }

    // 悬空的圆环，缓慢自转，让静止画面也有动感
    const ringGeo = new THREE.TorusGeometry(2.4, 0.09, 12, 64);
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(
        ringGeo,
        new THREE.MeshStandardMaterial({
          color: palette[(i + 3) % palette.length],
          emissive: palette[(i + 3) % palette.length],
          emissiveIntensity: 0.7,
          roughness: 0.3,
          metalness: 0.4,
        }),
      );
      const angle = (i / 3) * Math.PI * 2 + 0.9;
      ring.position.set(Math.cos(angle) * 8.5, 2.2 + i * 1.5, Math.sin(angle) * 8.5);
      ring.rotation.set(random() * Math.PI, random() * Math.PI, 0);
      this.scene.add(ring);
      this.props.push(ring);
      ring.userData.spin = 0.25 + random() * 0.5;
    }

    // 近处漂浮的发光小球
    const orbGeo = new THREE.SphereGeometry(0.16, 20, 16);
    for (let i = 0; i < 10; i++) {
      const angle = (i / 10) * Math.PI * 2 + 0.4;
      const radius = 3.6 + random() * 4.2;
      const orb = new THREE.Mesh(
        orbGeo,
        new THREE.MeshStandardMaterial({
          color: palette[i % palette.length],
          emissive: palette[i % palette.length],
          emissiveIntensity: 1.6,
          roughness: 0.2,
        }),
      );
      orb.position.set(Math.cos(angle) * radius, 0.9 + random() * 3.2, Math.sin(angle) * radius);
      orb.userData.baseY = orb.position.y;
      orb.userData.phase = random() * Math.PI * 2;
      this.scene.add(orb);
      this.props.push(orb);
    }

    // 远处一圈巨大的"门"，给方位一个强参照
    const gateGeo = new THREE.TorusGeometry(9, 0.18, 10, 96, Math.PI * 1.15);
    const gate = new THREE.Mesh(
      gateGeo,
      new THREE.MeshStandardMaterial({
        color: 0x1d4ed8,
        emissive: 0x2563eb,
        emissiveIntensity: 0.9,
        roughness: 0.4,
        metalness: 0.6,
      }),
    );
    gate.position.set(0, 0, -30);
    this.scene.add(gate);
    this.props.push(gate);
  }

  _buildPhone() {
    // phoneGroup 是旋转枢轴，两台相机挂在原点，所以它只转不平移。
    this.phoneGroup = new THREE.Group();
    this.phoneGroup.position.copy(PHONE_PIVOT);
    this.scene.add(this.phoneGroup);

    this.phoneVisual = new THREE.Group();
    this.phoneGroup.add(this.phoneVisual);

    const bodyShape = roundedRectPath(new THREE.Shape(), BODY.w, BODY.h, 0.011);
    const bodyGeo = new THREE.ExtrudeGeometry(bodyShape, {
      depth: BODY.d,
      bevelEnabled: true,
      bevelThickness: 0.0012,
      bevelSize: 0.0012,
      bevelSegments: 3,
      curveSegments: 10,
    });
    bodyGeo.translate(0, 0, -BODY.d / 2);
    const body = new THREE.Mesh(
      bodyGeo,
      new THREE.MeshStandardMaterial({ color: 0x1b1f27, roughness: 0.32, metalness: 0.85 }),
    );
    this.phoneVisual.add(body);

    const innerW = BODY.w - SCREEN_INSET * 2;
    const innerH = BODY.h - SCREEN_INSET * 2.4;

    // 屏幕：PlaneGeometry 的 UV 天然是 0~1，正好贴离屏渲染纹理
    this.screenMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(innerW, innerH),
      new THREE.MeshBasicMaterial({ map: this.previewRT.texture, toneMapped: false }),
    );
    this.screenMesh.position.z = BODY.d / 2 + 0.0018;
    this.phoneVisual.add(this.screenMesh);

    // 屏幕外框：带内孔的圆角矩形，让屏幕看起来是嵌在手机里的
    const frameShape = roundedRectPath(new THREE.Shape(), innerW + 0.0075, innerH + 0.0075, 0.0072);
    const hole = roundedRectPath(new THREE.Path(), innerW, innerH, 0.0034);
    frameShape.holes.push(hole);
    const frame = new THREE.Mesh(
      new THREE.ShapeGeometry(frameShape, 12),
      new THREE.MeshStandardMaterial({ color: 0x05070b, roughness: 0.5, metalness: 0.4 }),
    );
    frame.position.z = BODY.d / 2 + 0.0022;
    this.phoneVisual.add(frame);

    // 背面的镜头模组
    const lensGroup = new THREE.Group();
    lensGroup.position.set(-BODY.w / 2 + 0.019, BODY.h / 2 - 0.022, -BODY.d / 2 - 0.0024);
    const lensRing = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0105, 0.0105, 0.004, 28),
      new THREE.MeshStandardMaterial({ color: 0x2c3440, roughness: 0.25, metalness: 0.95 }),
    );
    lensRing.rotation.x = Math.PI / 2;
    lensGroup.add(lensRing);
    const lens = new THREE.Mesh(
      new THREE.CircleGeometry(0.0072, 28),
      new THREE.MeshStandardMaterial({
        color: 0x05080f,
        roughness: 0.05,
        metalness: 0.4,
        emissive: 0x0a1a33,
        emissiveIntensity: 0.7,
      }),
    );
    lens.rotation.y = Math.PI;
    lens.position.z = -0.0022;
    lensGroup.add(lens);
    this.phoneVisual.add(lensGroup);

    const flash = new THREE.Mesh(
      new THREE.CircleGeometry(0.0032, 20),
      new THREE.MeshStandardMaterial({ color: 0xfff2cc, emissive: 0xffe9b0, emissiveIntensity: 1.4 }),
    );
    flash.rotation.y = Math.PI;
    flash.position.set(-BODY.w / 2 + 0.019, BODY.h / 2 - 0.048, -BODY.d / 2 - 0.0012);
    this.phoneVisual.add(flash);

    // 录制相机：朝手机背面看出去（局部 -Z），near 卡在机身之外
    this.phoneCam = new THREE.PerspectiveCamera(66, 16 / 9, 0.02, 800);
    this.phoneGroup.add(this.phoneCam);

    // 屏幕预览相机：同位置，但用竖屏比例
    this.previewCam = new THREE.PerspectiveCamera(66, PREVIEW_SIZE.w / PREVIEW_SIZE.h, 0.02, 800);
    this.phoneGroup.add(this.previewCam);
  }

  // ---- 每帧 -------------------------------------------------------------

  _applySize() {
    const cw = Math.max(1, this.container.clientWidth);
    const ch = Math.max(1, this.container.clientHeight);
    let bw;
    let bh;
    let cssW;
    let cssH;

    if (this.sizeMode === 'auto') {
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      bw = Math.max(320, Math.round(cw * scale));
      bh = Math.max(240, Math.round(ch * scale));
      cssW = cw;
      cssH = ch;
    } else {
      bw = Math.max(160, this.sizeMode.w);
      bh = Math.max(120, this.sizeMode.h);
      const fit = Math.min(cw / bw, ch / bh);
      cssW = Math.max(1, Math.round(bw * fit));
      cssH = Math.max(1, Math.round(bh * fit));
    }

    if (bw === this.size.w && bh === this.size.h && cssW === this._css.w && cssH === this._css.h) return;

    this.size = { w: bw, h: bh };
    this._css = { w: cssW, h: cssH };
    this.renderer.setSize(bw, bh, false);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.style.display = 'block';
    this._layoutViews();
  }

  _layoutViews() {
    const { w, h } = this.size;
    if (this.layout === 'split') {
      const half = Math.floor(w / 2);
      this._rects.phone = { x: 0, y: 0, w: half, h };
      this._rects.operator = { x: half, y: 0, w: w - half, h };
    } else if (this.layout === 'phone') {
      this._rects.phone = { x: 0, y: 0, w, h };
      this._rects.operator = null;
    } else {
      this._rects.phone = null;
      this._rects.operator = { x: 0, y: 0, w, h };
    }
    this._syncCameraAspect();
  }

  _syncCameraAspect() {
    const rect = this._rects.phone || this._rects.operator;
    if (rect) {
      const aspect = rect.w / rect.h;
      if (Math.abs(this.phoneCam.aspect - aspect) > 1e-4) {
        this.phoneCam.aspect = aspect;
        this.phoneCam.updateProjectionMatrix();
      }
    }
  }

  _updateIdle(dt) {
    const t = this._elapsed;
    _idleEuler.set(
      Math.sin(t * 0.13) * 0.17,
      Math.sin(t * 0.22) * 1.15,
      Math.sin(t * 0.07) * 0.10,
      'YXZ',
    );
    _idleQuat.setFromEuler(_idleEuler);
    this._orientation.slerp(_idleQuat, Math.min(1, dt * 1.5));
  }

  _animateProps(dt) {
    if (!this.props) return;
    const t = this._elapsed;
    for (const prop of this.props) {
      if (prop.userData.spin) {
        prop.rotation.z += prop.userData.spin * dt;
        prop.rotation.y += prop.userData.spin * dt * 0.4;
      }
      if (prop.userData.baseY !== undefined) {
        prop.position.y = prop.userData.baseY + Math.sin(t * 1.1 + prop.userData.phase) * 0.22;
      }
    }
  }

  // 推进并绘制一帧。抽成公开方法，这样渲染循环和外部（自动化测试）能用同一套逻辑，
  // 不会出现"测试里能转、实际跑不起来"的偏差。
  step(dt) {
    if (typeof this.onFrame === 'function') this.onFrame(dt, this._elapsed);

    if (this.idle) this._updateIdle(dt);
    else this._orientation.copy(this._target);

    // 手机模型可能被隐藏，但相机要靠它算世界矩阵，所以这里显式更新一次。
    this.phoneGroup.quaternion.copy(this._orientation);
    this.phoneGroup.updateMatrixWorld(true);

    this.controls.update();
    this._applySize();
    this._animateProps(dt);
    this._renderFrame();
  }

  _loop() {
    this._raf = requestAnimationFrame(this._loop);
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0.001, (now - this._lastAt) / 1000));
    this._lastAt = now;
    this._elapsed += dt;
    this.step(dt);
  }

  _renderFrame() {
    const renderer = this.renderer;

    // 先把"手机屏幕里看到的内容"渲染到离屏纹理
    this.screenMesh.visible = false;
    renderer.setScissorTest(false);
    renderer.setRenderTarget(this.previewRT);
    renderer.setViewport(0, 0, PREVIEW_SIZE.w, PREVIEW_SIZE.h);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(this.scene, this.previewCam);
    renderer.setRenderTarget(null);
    this.screenMesh.visible = this.showPhone;

    // 再把各视角拼到主画布上，录制的就是这块画布
    renderer.setScissorTest(true);
    this._renderView(this._rects.phone, this.phoneCam, 0x05070c);
    this._renderView(this._rects.operator, this.operatorCam, 0x05070c);
    renderer.setScissorTest(false);
  }

  _renderView(rect, camera, clearColor) {
    if (!rect || rect.w <= 0 || rect.h <= 0) return;
    const renderer = this.renderer;
    renderer.setViewport(rect.x, rect.y, rect.w, rect.h);
    renderer.setScissor(rect.x, rect.y, rect.w, rect.h);
    renderer.setClearColor(clearColor, 1);
    if (camera !== this.phoneCam) {
      const aspect = rect.w / rect.h;
      if (Math.abs(camera.aspect - aspect) > 1e-4) {
        camera.aspect = aspect;
        camera.updateProjectionMatrix();
      }
    }
    renderer.render(this.scene, camera);
  }
}