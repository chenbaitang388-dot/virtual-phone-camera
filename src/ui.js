export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function fmtClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function createLogger(el, max = 200) {
  function write(text, kind = '') {
    if (!el) return;
    const line = document.createElement('div');
    line.className = 'log__line' + (kind ? ` log__line--${kind}` : '');
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    line.textContent = `[${stamp}] ${text}`;
    el.appendChild(line);
    while (el.childElementCount > max) el.removeChild(el.firstElementChild);
    el.scrollTop = el.scrollHeight;
  }
  return {
    info: (t) => write(t),
    ok: (t) => write(t, 'ok'),
    warn: (t) => write(t, 'warn'),
    err: (t) => write(t, 'err'),
  };
}

export function createToast(el, duration = 3600) {
  let timer = 0;
  return function toast(text, kind = 'ok') {
    if (!el) return;
    el.textContent = text;
    el.className = `toast toast--${kind} toast--show`;
    clearTimeout(timer);
    timer = setTimeout(() => { el.className = `toast toast--${kind}`; }, duration);
  };
}

// 状态胶囊的约定了两种写法：`.pill > .dot + .pill__text`，或者只有纯文本。
export function setPill(el, state, text) {
  if (!el) return;
  el.dataset.state = state;
  const dot = $('.dot', el);
  if (dot) dot.className = `dot dot--${state}`;
  const span = $('.pill__text', el);
  if (span) span.textContent = text;
  else if (!dot) el.textContent = text;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function timestampName(prefix, ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${prefix}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

export function toggleFullscreen(el) {
  if (document.fullscreenElement) return document.exitFullscreen();
  return el.requestFullscreen?.();
}