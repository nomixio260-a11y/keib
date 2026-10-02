// グラフ（SVG / HTML）。色はすべて CSS のトークンを使い、ライト・ダーク両方で読めるようにする。

import { esc, pct, yen } from './format.js';

/** きりのいい目盛り */
export function niceTicks(min, max, count = 5) {
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { ticks, lo, hi, step };
}

/** ファクター寄与の発散バー（HTML）。factors は係数が0でないものだけ渡す */
export function contribBars(row, factors, maxAbs) {
  const scale = maxAbs > 0 ? 50 / maxAbs : 0;
  return `<div class="contrib">${factors
    .map((f) => {
      const c = row.contrib[f.key];
      const w = Math.min(50, Math.abs(c) * scale);
      const side = c >= 0 ? 'pos' : 'neg';
      const tip = `${c >= 0 ? '+' : ''}${c.toFixed(2)}\n${f.label}（${f.desc}）`;
      return `<div class="contrib-row" tabindex="0" data-tip="${esc(tip)}">
        <span class="contrib-label">${esc(f.label)}</span>
        <span class="contrib-track"><span class="contrib-bar ${side}" style="width:${w.toFixed(1)}%"></span></span>
        <span class="contrib-val num">${c >= 0 ? '+' : ''}${c.toFixed(2)}</span>
      </div>`;
    })
    .join('')}</div>`;
}

/** 着順分布のヒートストリップ（HTML） */
export function positionStrip(posDist) {
  const max = Math.max(...posDist, 0.0001);
  return `<div class="pos-strip" role="img" aria-label="着順分布">${posDist
    .map((p, i) => {
      const a = Math.round((p / max) * 92 + 4);
      return `<span class="pos-cell" style="--p:${a}%" tabindex="0" data-tip="${esc(`${pct(p)}\n${i + 1}着になる確率`)}"><span class="pos-n">${i + 1}</span></span>`;
    })
    .join('')}</div>`;
}

const ZONES = [
  { label: '追込', from: 0, to: 0.34 },
  { label: '差し', from: 0.34, to: 0.64 },
  { label: '先行', from: 0.64, to: 0.9 },
  { label: '逃げ', from: 0.9, to: 1 },
];

/** 隊列予想（SVG）。右が進行方向、上が内ラチ */
export function paceMap(pred) {
  const W = 360;
  const padL = 14;
  const padR = 22;
  const top = 30;
  const r = 10;
  const slot = 2 * r + 3;
  const xOf = (e) => padL + r + e * (W - padL - padR - 2 * r);
  const gates = Math.max(...pred.rows.map((x) => x.entry.number));
  const items = pred.rows
    .map((row) => ({ row, e: row.style.early ?? 0.45, pref: (row.entry.number - 1) / Math.max(1, gates - 1) }))
    .sort((a, b) => b.e - a.e);
  const placed = [];
  let maxSlot = 0;
  for (const it of items) {
    const x = xOf(it.e);
    const prefSlot = Math.round(it.pref * 4);
    let s = prefSlot;
    for (let k = 0; k < 40; k++) {
      const cand = prefSlot + (k % 2 ? Math.ceil(k / 2) : -Math.ceil(k / 2));
      if (cand < 0) continue;
      if (!placed.some((p) => p.slot === cand && Math.abs(p.x - x) < 2 * r + 2)) {
        s = cand;
        break;
      }
    }
    placed.push({ ...it, x, slot: s });
    maxSlot = Math.max(maxSlot, s);
  }
  const laneH = (maxSlot + 1) * slot + 8;
  const H = top + laneH + 30;
  const zoneLines = ZONES.slice(1)
    .map((z) => `<line x1="${xOf(z.from)}" x2="${xOf(z.from)}" y1="${top}" y2="${top + laneH}" class="pm-zone-line"/>`)
    .join('');
  const zoneLabels = ZONES.map((z) => `<text x="${(xOf(z.from) + xOf(z.to)) / 2}" y="${top + laneH + 18}" class="pm-zone">${z.label}</text>`).join('');
  const horses = placed
    .map((p) => {
      const y = top + 4 + p.slot * slot + r;
      const e = p.row.entry;
      const unknown = p.row.style.early == null;
      const tip = `${e.number}番 ${e.name}\n${p.row.style.style}${unknown ? '（データなし）' : `・先行力 ${(p.row.style.early * 100).toFixed(0)}`}`;
      const mark = p.row.mark ? `<text x="${p.x}" y="${y - r - 3}" class="pm-mark ${p.row.mark === '◎' ? 'is-h' : ''}">${esc(p.row.mark)}</text>` : '';
      return `<g class="pm-horse${unknown ? ' is-unknown' : ''}" tabindex="0" data-tip="${esc(tip)}">
        <circle cx="${p.x}" cy="${y}" r="${r}" class="f${esc(e.frame)}"/>
        <text x="${p.x}" y="${y + 4}" class="pm-num fi${esc(e.frame)}">${esc(e.number)}</text>${mark}
      </g>`;
    })
    .join('');
  return `<svg class="pace-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="隊列予想">
    <rect x="${padL}" y="${top}" width="${W - padL - padR}" height="${laneH}" rx="8" class="pm-lane"/>
    <line x1="${padL}" x2="${W - padR}" y1="${top}" y2="${top}" class="pm-rail"/>
    <text x="${padL + 2}" y="${top - 8}" class="pm-caption">内ラチ</text>
    <text x="${W - padR}" y="${top - 8}" class="pm-caption pm-end">進行方向 →</text>
    ${zoneLines}${horses}${zoneLabels}
  </svg>`;
}

/**
 * 累積収支の折れ線（2系列）。focus 系列を強調、baseline は灰色。
 * 返り値の SVG には十字線用のオーバーレイがあり、bindLineChart で操作できる。
 */
export function lineChart({ id, series, height = 240, xLabel = (i) => i + 1 }) {
  const W = 640;
  const H = height;
  const pad = { l: 64, r: 16, t: 16, b: 30 };
  const n = Math.max(...series.map((s) => s.values.length), 1);
  const all = series.flatMap((s) => s.values).concat(0);
  const { ticks, lo, hi } = niceTicks(Math.min(...all), Math.max(...all), 5);
  const x = (i) => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - pad.l - pad.r));
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
  const grid = ticks
    .map((t) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}" class="${t === 0 ? 'ch-zero' : 'ch-grid'}"/><text x="${pad.l - 8}" y="${y(t) + 4}" class="ch-tick ch-y">${t.toLocaleString('ja-JP')}</text>`)
    .join('');
  const xt = niceTicks(1, n, 6).ticks.filter((t) => t >= 1 && t <= n);
  const xTicks = xt.map((t) => `<text x="${x(t - 1)}" y="${H - 8}" class="ch-tick ch-x">${xLabel(t - 1)}</text>`).join('');
  const lines = series
    .map((s) => {
      const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
      const last = s.values.length - 1;
      const end = last >= 0 ? `<circle cx="${x(last)}" cy="${y(s.values[last])}" r="4" class="ch-end ${s.cls}"/>` : '';
      const area = s.area && last >= 0 ? `<path d="${d}L${x(last)},${y(0)}L${x(0)},${y(0)}Z" class="ch-area ${s.cls}"/>` : '';
      return `${area}<path d="${d}" class="ch-line ${s.cls}"/>${end}`;
    })
    .join('');
  return `<svg class="line-chart" id="${esc(id)}" viewBox="0 0 ${W} ${H}" role="img" aria-label="累積収支の推移" data-n="${n}" data-l="${pad.l}" data-r="${W - pad.r}">
    ${grid}${xTicks}${lines}
    <line class="ch-cross" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/>
    <rect class="ch-hit" x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${H - pad.t - pad.b}" tabindex="0" aria-label="グラフを操作すると各レース時点の収支を表示"/>
  </svg>`;
}

/** 十字線＋ツールチップを付ける */
export function bindLineChart(svg, series, labelOf, xLabel = (i) => i + 1) {
  if (!svg) return;
  const n = Number(svg.dataset.n);
  const l = Number(svg.dataset.l);
  const r = Number(svg.dataset.r);
  const hit = svg.querySelector('.ch-hit');
  const cross = svg.querySelector('.ch-cross');
  const update = (i) => {
    const x = l + (n <= 1 ? 0 : (i / (n - 1)) * (r - l));
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    cross.setAttribute('visibility', 'visible');
    const lines = series.map((s) => `${s.label} ${yen(s.values[i] ?? 0)}`);
    hit.setAttribute('data-tip', [`${xLabel(i)}レース目まで`, ...lines, labelOf ? labelOf(i) : ''].filter(Boolean).join('\n'));
  };
  const fromEvent = (e) => {
    const box = svg.getBoundingClientRect();
    const scale = svg.viewBox.baseVal.width / box.width;
    const px = (e.clientX - box.left) * scale;
    return Math.max(0, Math.min(n - 1, Math.round(((px - l) / (r - l)) * (n - 1))));
  };
  let idx = n - 1;
  hit.addEventListener('pointermove', (e) => {
    idx = fromEvent(e);
    update(idx);
  });
  hit.addEventListener('pointerleave', () => cross.setAttribute('visibility', 'hidden'));
  hit.addEventListener('focus', () => update(idx));
  hit.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') idx = Math.max(0, idx - 1);
    else if (e.key === 'ArrowRight') idx = Math.min(n - 1, idx + 1);
    else return;
    e.preventDefault();
    update(idx);
    hit.blur();
    hit.focus();
  });
}

/** キャリブレーション（予測勝率と実際の勝率） */
export function calibrationChart(cal) {
  const W = 340;
  const H = 280;
  const pad = { l: 44, r: 14, t: 14, b: 40 };
  const maxV = 0.5;
  const x = (v) => pad.l + (Math.min(v, maxV) / maxV) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - Math.min(v, maxV) / maxV) * (H - pad.t - pad.b);
  const ticks = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
  const grid = ticks
    .map(
      (t) =>
        `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}" class="ch-grid"/><text x="${pad.l - 6}" y="${y(t) + 4}" class="ch-tick ch-y">${t * 100}%</text><text x="${x(t)}" y="${H - pad.b + 16}" class="ch-tick ch-x">${t * 100}%</text>`,
    )
    .join('');
  const ser = [
    { key: 'market', label: 'オッズ（市場）', cls: 's-base' },
    { key: 'ai', label: 'AI', cls: 's-focus' },
  ]
    .map((s) => {
      const pts = cal[s.key].filter((b) => b.n >= 8).map((b) => ({ px: b.sumP / b.n, py: b.wins / b.n, n: b.n }));
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.px).toFixed(1)},${y(p.py).toFixed(1)}`).join('');
      const dots = pts
        .map(
          (p) =>
            `<g tabindex="0" data-tip="${esc(`実際 ${pct(p.py)}\n${s.label}：予測 ${pct(p.px)}（${p.n}頭）`)}"><circle cx="${x(p.px)}" cy="${y(p.py)}" r="12" class="ch-hitdot"/><circle cx="${x(p.px)}" cy="${y(p.py)}" r="4.5" class="ch-dot ${s.cls}"/></g>`,
        )
        .join('');
      return `<path d="${d}" class="ch-line ${s.cls}"/>${dots}`;
    })
    .join('');
  return `<svg class="cal-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="予測勝率と実際の勝率">
    ${grid}
    <line x1="${x(0)}" y1="${y(0)}" x2="${x(maxV)}" y2="${y(maxV)}" class="ch-diag"/>
    <text x="${x(0.36)}" y="${y(0.4)}" class="ch-note">予測どおり</text>
    ${ser}
    <text x="${(pad.l + W - pad.r) / 2}" y="${H - 6}" class="ch-axis">予測した勝率</text>
    <text x="12" y="${(pad.t + H - pad.b) / 2}" class="ch-axis" transform="rotate(-90 12 ${(pad.t + H - pad.b) / 2})">実際の勝率</text>
  </svg>`;
}
