// 汎用ユーティリティ（数値・日付・書式）

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const sum = (arr) => arr.reduce((a, b) => a + b, 0);
export const mean = (arr) => (arr.length ? sum(arr) / arr.length : 0);

export function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(sum(arr.map((v) => (v - m) ** 2)) / (arr.length - 1));
}

export const round1 = (v) => Math.round(v * 10) / 10;

const pad2 = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' を UTC のミリ秒に（タイムゾーンの影響を受けない） */
export function parseDate(s) {
  const str = String(s);
  if (str.length === 10 && str[4] === '-' && str[7] === '-') {
    return Date.UTC(+str.slice(0, 4), +str.slice(5, 7) - 1, +str.slice(8, 10));
  }
  const [y, m, d] = str.split('-').map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1);
}

export function isValidDate(s) {
  const m = String(s).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}

export function addDays(s, days) {
  const d = new Date(parseDate(s) + days * 86400000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
export const weekday = (s) => WEEKDAYS[new Date(parseDate(s)).getUTCDay()];

export function formatDateJa(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return `${y}年${m}月${d}日(${weekday(s)})`;
}

/** 馬柱向けの短い日付 26.9.6 */
export function formatShortDate(s) {
  const [y, m, d] = String(s).split('-');
  return `${y.slice(2)}.${Number(m)}.${Number(d)}`;
}

/** 秒 → 1:34.5 */
export function formatTime(sec) {
  if (!(sec > 0)) return '—';
  const tenths = Math.round(sec * 10);
  const m = Math.floor(tenths / 600);
  const rest = (tenths - m * 600) / 10;
  return m > 0 ? `${m}:${rest.toFixed(1).padStart(4, '0')}` : rest.toFixed(1);
}

/** '1:34.5' / '94.5' / '1.34.5' → 秒。解釈できなければ null */
export function parseTime(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (!s) return null;
  let m = s.match(/^(\d+)[:.](\d{1,2})\.(\d)$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 10;
  m = s.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const v = Number(s);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function argsortDesc(values) {
  return values.map((v, i) => i).sort((a, b) => values[b] - values[a]);
}
