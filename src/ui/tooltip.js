// グラフ用のツールチップ。data-tip（1行目=値、2行目以降=説明）を持つ要素に反応する。

let tip = null;

function ensure() {
  if (tip) return tip;
  tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.setAttribute('role', 'status');
  tip.hidden = true;
  document.body.appendChild(tip);
  return tip;
}

function show(target, x, y) {
  const text = target.getAttribute('data-tip');
  if (!text) return;
  const el = ensure();
  el.replaceChildren();
  text.split('\n').forEach((line, i) => {
    const div = document.createElement('div');
    div.className = i === 0 ? 'tooltip-value' : 'tooltip-label';
    div.textContent = line;
    el.appendChild(div);
  });
  el.hidden = false;
  const pad = 12;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let left = x + pad;
  let top = y - h - pad;
  if (left + w > window.innerWidth - 8) left = x - w - pad;
  if (top < 8) top = y + pad;
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, top)}px`;
}

function hide() {
  if (tip) tip.hidden = true;
}

export function installTooltips(root = document) {
  root.addEventListener('pointermove', (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (t) show(t, e.clientX, e.clientY);
    else hide();
  });
  root.addEventListener('pointerleave', hide, true);
  root.addEventListener('focusin', (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (!t) return;
    const r = t.getBoundingClientRect();
    show(t, r.left + r.width / 2, r.top);
  });
  root.addEventListener('focusout', hide);
  window.addEventListener('scroll', hide, { passive: true });
}
