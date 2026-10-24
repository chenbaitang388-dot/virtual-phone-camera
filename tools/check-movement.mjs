// 无额外依赖：node tools/check-movement.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const threeUrl = new URL('../vendor/three.module.js', import.meta.url).href;
const THREE = await import(threeUrl);
const asModule = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const orbitSource = (await readFile(new URL('../vendor/OrbitControls.js', import.meta.url), 'utf8'))
  .replace(/from 'three'/g, `from '${threeUrl}'`);
const sceneSource = (await readFile(new URL('../src/scene.js', import.meta.url), 'utf8'))
  .replace(/from 'three'/g, `from '${threeUrl}'`)
  .replace("'../vendor/OrbitControls.js'", JSON.stringify(asModule(orbitSource)));
const { VirtualPhoneStudio } = await import(asModule(sceneSource));

// 跳过 WebGL 初始化，直接运行生产代码的输入、移动、step 和重置逻辑。
function fixture() {
  const studio = Object.create(VirtualPhoneStudio.prototype);
  Object.assign(studio, {
    phoneGroup: new THREE.Group(), phoneCam: new THREE.PerspectiveCamera(),
    previewCam: new THREE.PerspectiveCamera(), operatorCam: new THREE.PerspectiveCamera(),
    controls: { target: new THREE.Vector3(0, 1.55, 0), update() {} },
    walkSpeed: 2.8, runSpeed: 5.6, walkAccel: 12, walkBounds: 40,
    _walking: false,
    _moveInput: { forward: 0, right: 0, up: 0, run: false },
    _velocity: new THREE.Vector3(), _lastPhonePos: new THREE.Vector3(0, 1.55, 0),
    _orientation: new THREE.Quaternion(), _target: new THREE.Quaternion(),
    _obstacles: [], idle: false,
    _applySize() {}, _animateProps() {}, _renderFrame() {},
  });
  studio.phoneGroup.position.set(0, 1.55, 0);
  studio.operatorCam.position.set(1, 3, 2);
  studio.phoneGroup.add(studio.phoneCam, studio.previewCam);
  return studio;
}
function frames(studio, seconds = 1) {
  for (let i = 0; i < seconds * 60; i++) studio.step(1 / 60);
}
const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

const studio = fixture();
studio.idle = true;
studio.setMoveInput({ up: 1 });
assert.equal(studio.idle, false, 'vertical input exits idle animation');
frames(studio);
assert(studio.phoneGroup.position.y > 3.5);
close(studio.phoneCam.getWorldPosition(new THREE.Vector3()).y, studio.phoneGroup.position.y);
close(studio.previewCam.getWorldPosition(new THREE.Vector3()).y, studio.phoneGroup.position.y);
close(studio.controls.target.y, studio.phoneGroup.position.y);
close(studio.operatorCam.position.y - studio.phoneGroup.position.y, 3 - 1.55);
studio.setMoveInput();
frames(studio, 3);
const height = studio.phoneGroup.position.y;
studio.setMoveInput({ forward: 1 });
frames(studio);
close(studio.phoneGroup.position.y, height);
assert(studio.phoneGroup.position.z < -2, 'horizontal movement survives at raised height');
studio.setMoveInput({ up: -1 });
frames(studio, 20);
assert(studio.phoneGroup.position.y < -40, 'descent continues below ground without a lower limit');
studio.setMoveInput({ up: 1, run: true });
frames(studio, 20);
assert(studio.phoneGroup.position.y > 40, 'ascent continues beyond the former upper limit');
const high = studio.phoneGroup.position.y;
frames(studio, 20);
assert(studio.phoneGroup.position.y > high + 100, 'holding ascent keeps increasing height');
studio.setMoveInput();
studio.resetPosition();
close(studio.phoneGroup.position.y, 1.55);
close(studio.phoneGroup.position.lengthSq(), 1.55 ** 2);
close(studio._velocity.lengthSq(), 0);
close(studio.controls.target.y, 1.55);

const normal = fixture();
const fast = fixture();
normal.setMoveInput({ up: 1 }); fast.setMoveInput({ up: 1, run: true });
frames(normal); frames(fast);
close(fast.phoneGroup.position.y - 1.55, (normal.phoneGroup.position.y - 1.55) * 2);
const tilted = fixture();
tilted._target.setFromEuler(new THREE.Euler(1, 0.7, 0.4));
tilted.setMoveInput({ up: 1 }); frames(tilted);
close(tilted.phoneGroup.position.x, 0); close(tilted.phoneGroup.position.z, 0);
const diagonal = fixture();
diagonal.setMoveInput({ forward: 1, right: 1, up: 1 }); frames(diagonal);
assert(diagonal._velocity.length() <= diagonal.walkSpeed + 1e-9);
console.log('PASS: unlimited ascent/descent, hover, WASD, Shift speed, world vertical axis, diagonal speed, reset, preview/recording cameras and operator follow');

// 执行页面实际的键盘事件代码，检查组合键、输入框和失焦释放。
const page = await readFile(new URL('../pc.html', import.meta.url), 'utf8');
const controlsSource = page.slice(page.indexOf('const heldKeys = new Set();'), page.indexOf('// ---- 视口标签'));
class FakeElement { constructor(tagName = 'DIV') { this.tagName = tagName; } }
const listeners = { window: {}, document: {} };
const win = { addEventListener(name, fn) { listeners.window[name] = fn; } };
const doc = { hidden: false, addEventListener(name, fn) { listeners.document[name] = fn; } };
const keyboardStudio = fixture();
runInNewContext(controlsSource, { window: win, document: doc, Element: FakeElement, studio: keyboardStudio, toast() {}, doRecalibrate() {}, doLevel() {} });
const event = (code, target = new FakeElement()) => ({ code, target, preventDefault() {} });
listeners.window.keydown(event('KeyE'));
assert.equal(keyboardStudio._moveInput.up, 1);
listeners.window.keydown(event('KeyQ'));
assert.equal(keyboardStudio._moveInput.up, 0);
listeners.window.keyup(event('KeyE'));
assert.equal(keyboardStudio._moveInput.up, -1);
listeners.window.blur();
assert.equal(keyboardStudio._moveInput.up, 0);
listeners.window.keydown(event('KeyE', new FakeElement('TEXTAREA')));
assert.equal(keyboardStudio._moveInput.up, 0);
listeners.window.keydown(event('KeyE'));
doc.hidden = true;
listeners.document.visibilitychange();
assert.equal(keyboardStudio._moveInput.up, 0);
listeners.window.keydown(event('KeyQ'));
listeners.window.focusin(event('', new FakeElement('TEXTAREA')));
assert.equal(keyboardStudio._moveInput.up, 0);
console.log('PASS: page keyboard wiring, opposing keys, text fields, blur, hidden tab and focus release');
