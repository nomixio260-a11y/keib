// バックテスト画面：学習に使っていない実際のレース（JRA）で、予想と買い方を検証した結果。払戻は実際の金額

import { PRESETS } from '../engine/model.js';
import { REAL_BACKTEST } from '../data/realBacktest.js';
import { calibrationChart, lineChart } from './charts.js';
import { esc, pct, yen } from './format.js';

export function presetLabel(state) {
  return state.preset === 'custom' ? 'カスタム' : PRESETS[state.preset]?.label || 'バランス';
}

/** 表示中の検証結果（保存済みの検証 or 直近の開催日の再計算） */
export function currentBacktest(bt) {
  if (bt.source === 'recent') return bt.recent.result ? { ...bt.recent.result, step: 1 } : null;
  const p = REAL_BACKTEST?.presets?.[bt.preset] || REAL_BACKTEST?.presets?.balance;
  return p ? { ...p, races: REAL_BACKTEST.races, step: p.curveStep || 1 } : null;
}

function tiles(res) {
  const win = res.strategies.find((s) => s.key === 'win');
  const place = res.strategies.find((s) => s.key === 'place');
  const ai = res.strategies.find((s) => s.key === 'ai');
  return `<div class="summary bt-summary">
    <div class="tile"><div class="tile-label">◎の勝率</div><div class="tile-value num">${pct(res.ai.winRate)}</div><div class="tile-sub">1番人気は ${pct(res.fav.winRate)}</div></div>
    <div class="tile"><div class="tile-label">◎の複勝率</div><div class="tile-value num">${pct(res.ai.top3Rate)}</div><div class="tile-sub">1番人気は ${pct(res.fav.top3Rate)}</div></div>
    <div class="tile"><div class="tile-label">単勝◎の回収率</div><div class="tile-value num">${pct(win.roi)}</div><div class="tile-sub">複勝◎は ${pct(place.roi)}</div></div>
    <div class="tile"><div class="tile-label">AI推奨の回収率</div><div class="tile-value num">${pct(ai.roi)}</div><div class="tile-sub">的中率 ${pct(ai.hitRate)}・${ai.bets.toLocaleString('ja-JP')}点</div></div>
  </div>`;
}

function strategyTable(res, focus) {
  const maxRoi = Math.max(1.5, ...res.strategies.map((s) => s.roi));
  const rows = res.strategies
    .map((s) => {
      const w = (s.roi / maxRoi) * 100;
      const ref = (1 / maxRoi) * 100;
      return `<tr class="${s.key === focus ? 'is-focus' : ''}${s.baseline ? ' is-baseline' : ''}" data-bt-focus="${esc(s.key)}" tabindex="0" aria-label="${esc(s.label)}のグラフを表示">
        <td>${esc(s.label)}</td>
        <td class="num">${s.bets.toLocaleString('ja-JP')}</td>
        <td class="num">${s.hits.toLocaleString('ja-JP')}</td>
        <td class="num">${pct(s.hitRate)}</td>
        <td class="c-roi"><span class="roi-bar" aria-hidden="true"><span class="roi-fill ${s.roi >= 1 ? 'is-plus' : ''}" style="width:${w.toFixed(1)}%"></span><span class="roi-ref" style="left:${ref.toFixed(1)}%"></span></span><span class="num">${pct(s.roi)}</span></td>
        <td class="num ${s.profit >= 0 ? 'tx-good' : 'tx-bad'}">${s.profit >= 0 ? '+' : ''}${s.profit.toLocaleString('ja-JP')}</td>
        <td class="num">${s.maxPay ? s.maxPay.toLocaleString('ja-JP') : '—'}</td>
      </tr>`;
    })
    .join('');
  return `<div class="table-scroll"><table class="bt-table">
    <thead><tr><th>買い方</th><th>購入点数</th><th>的中</th><th>的中率</th><th>回収率 <small>線=100%</small></th><th>収支（円）</th><th title="1回の的中で戻った最大額">最高払戻（円）</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function sourceSwitch(ctx) {
  const { bt, recentCount } = ctx;
  const presets = REAL_BACKTEST?.presets
    ? Object.entries(REAL_BACKTEST.presets)
        .map(([k, p]) => `<button type="button" class="seg-btn${bt.source === 'saved' && bt.preset === k ? ' is-on' : ''}" data-bt-preset="${esc(k)}" aria-pressed="${bt.source === 'saved' && bt.preset === k}">${esc(p.label)}</button>`)
        .join('')
    : '';
  return `<div class="bt-controls">
    ${presets ? `<div class="seg" role="group" aria-label="検証結果"><span class="seg-label">検証済み</span>${presets}</div>` : ''}
    <button type="button" class="${bt.source === 'recent' ? 'btn' : 'ghost-btn'}" data-action="run-recent" ${bt.recent.running || !recentCount ? 'disabled' : ''}>直近の開催日（${recentCount}レース）を今の設定で検証</button>
    <div class="progress" ${bt.recent.running ? '' : 'hidden'} role="progressbar" aria-label="検証の進み具合" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(bt.recent.progress * 100)}">
      <span style="width:${(bt.recent.progress * 100).toFixed(0)}%"></span>
    </div>
    <span class="progress-label" role="status">${bt.recent.running ? '予想して実際の払戻で精算しています' : ''}</span>
  </div>`;
}

export function renderBacktest(ctx) {
  const { bt, state } = ctx;
  const saved = REAL_BACKTEST;
  const intro = `<div class="view-intro">
    <h1 class="view-title">バックテスト</h1>
    <p>実際のレース（JRA）で予想と買い方を検証した結果です。各レースの予想は、そのレースより前の情報（出馬表・前4走・騎手と厩舎の成績・最終オッズ）だけで計算し、払戻は実際の金額で精算しています。「検証済み」は、予想の重みの学習にも統計にも<strong>使っていない</strong>期間のレースでの結果です。</p>
    ${saved ? `<p class="bt-meta">検証済みの期間 <b>${esc(saved.period)}</b>・<b class="num">${saved.races.toLocaleString('ja-JP')}</b>レース（平地）・データ JRA・作成 ${esc(saved.generatedAt)}</p>` : ''}
  </div>`;
  const res = currentBacktest(bt);
  if (!res) {
    return `${intro}${sourceSwitch(ctx)}<div class="empty-state small"><p>${saved ? '「直近の開催日を検証」を押すと、表示中の設定で予想 → 買い目 → 実際の払戻の精算を行います。' : '検証結果はまだありません。npm run evaluate で作成するか、直近の開催日で検証してください。'}</p></div>`;
  }
  const focus = res.strategies.find((s) => s.key === bt.focus) || res.strategies[0];
  const base = res.strategies.find((s) => s.key === 'fav');
  const step = res.step || 1;
  const xLabel = (i) => Math.min(res.races, (i + 1) * step);
  const series = [
    { label: base.label, values: base.curve, cls: 's-base' },
    { label: focus.label, values: focus.curve, cls: 's-focus', area: true },
  ];
  const settingNote =
    bt.source === 'recent'
      ? `表示中の設定（重み付け <b>${esc(presetLabel(state))}</b>・オッズを混ぜる割合 <b>${state.blend === 'auto' ? '買い方の標準' : `${Math.round(state.blend * 100)}%`}</b>）で、直近の開催日の${res.races}レースを検証した結果です（統計にはこの期間の結果も含まれるので、厳密な検証は「検証済み」を見てください）。`
      : `重み付け <b>${esc(res.label)}</b>・オッズを混ぜる割合 50% で検証した結果です。`;
  return `${intro}${sourceSwitch(ctx)}
    <p class="bt-weights">${settingNote}</p>
    ${tiles(res)}
    <section class="bt-section">
      <h2 class="section-title">買い方ごとの成績 <small>${res.races.toLocaleString('ja-JP')}レース・1点100円・行を押すとグラフが切り替わります</small></h2>
      ${strategyTable(res, focus.key)}
      <p class="panel-note">三連複などは1回の高配当で回収率が大きく動きます。「最高払戻」が収支の大半を占めているときは、運の要素が大きいと考えてください。</p>
    </section>
    <div class="bt-charts">
      <section class="panel">
        <header class="panel-head"><h2>累積収支の推移</h2></header>
        <ul class="legend"><li><span class="lg-line s-focus"></span>${esc(focus.label)}</li><li><span class="lg-line s-base"></span>${esc(base.label)}</li></ul>
        <div class="chart-box">${lineChart({ id: 'bt-line', series, xLabel })}</div>
        <p class="panel-note">最終収支：${esc(focus.label)} ${yen(focus.profit)}、${esc(base.label)} ${yen(base.profit)}。グラフにカーソルを合わせるか、選んで左右キーで各時点の値を表示します。</p>
      </section>
      <section class="panel">
        <header class="panel-head"><h2>予測の当たり具合</h2></header>
        <ul class="legend"><li><span class="lg-dot s-focus"></span>AI</li><li><span class="lg-dot s-base"></span>オッズ（市場）</li></ul>
        <div class="chart-box">${calibrationChart(res.calibration)}</div>
        <p class="panel-note">点が斜めの線に近いほど、確率の見積もりが正確です。対数損失（小さいほど良い）は AI ${res.ai.logLoss.toFixed(3)}、オッズ ${res.fav.logLoss.toFixed(3)}。</p>
      </section>
    </div>
    <section class="note-box">
      <h2>結果の読み方</h2>
      <p>オッズには多くの人の予想がすでに織り込まれているため、公開情報だけで長期的に回収率100%を超えるのは非常に難しく、この検証でも多くの買い方が100%を下回ります。◎の勝率・複勝率が1番人気と比べてどうか、キャリブレーション（予測した確率と実際の勝率の一致）がどうかを、予想の確かさの目安にしてください。過去の成績は将来の結果を保証するものではありません。</p>
    </section>`;
}
