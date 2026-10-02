// 表示用の書式

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML エスケープ（取り込んだ馬名などを安全に表示する） */
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const pct = (v, digits = 1) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(digits)}%`);

export const yen = (v) => `${Math.round(v || 0).toLocaleString('ja-JP')}円`;

export const odds = (v) => (v > 0 ? (v >= 100 ? v.toFixed(0) : v.toFixed(1)) : '—');

export const fixed = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));

export const signed = (v, d = 0) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}`);

export const surfaceName = (s) => (s === '芝' ? '芝' : 'ダート');

/** 枠番バッジ（枠色） */
export function frameBadge(frame, number, extra = '') {
  return `<span class="num-badge f${esc(frame)} ${extra}" aria-label="${esc(frame)}枠${esc(number)}番">${esc(number)}</span>`;
}

export const STYLE_CLASS = { 逃げ: 'st-nige', 先行: 'st-senko', 差し: 'st-sashi', 追込: 'st-oikomi', 不明: 'st-none' };

export const markClass = (m) => ({ '◎': 'mk-h', '○': 'mk-t', '▲': 'mk-s', '△': 'mk-r', '☆': 'mk-a' })[m] || '';
