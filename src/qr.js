// 用 vendor/qrcode.min.js 里暴露的全局 qrcode() 画二维码。
// 二维码里编码的是带 room 参数的手机端地址，用手机自带相机扫一下就能直接打开页面，
// 所以站点里不需要内置扫码器，也就不需要摄像头权限。
const QUIET_MODULES = 2;

export function renderQr(container, text, { modules = 220 } = {}) {
  if (!container) return null;
  container.textContent = '';
  if (typeof window.qrcode !== 'function') {
    const fallback = document.createElement('div');
    fallback.className = 'muted';
    fallback.textContent = '二维码组件未加载，请手动输入房间号';
    container.appendChild(fallback);
    return null;
  }

  // typeNumber 传 0 让库自己选最小版本，纠错等级 M 在容错和尺寸间比较平衡。
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const total = count + QUIET_MODULES * 2;
  const scale = Math.max(1, Math.floor(modules / total));
  const px = total * scale;

  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  canvas.style.width = '100%';
  canvas.style.height = 'auto';
  canvas.style.display = 'block';
  canvas.style.borderRadius = '6px';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', '手机端连接二维码');

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) {
        ctx.fillRect((c + QUIET_MODULES) * scale, (r + QUIET_MODULES) * scale, scale, scale);
      }
    }
  }

  container.appendChild(canvas);
  return canvas;
}