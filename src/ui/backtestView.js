// バックテスト画面

import { PRESETS } from '../engine/model.js';
import { calibrationChart, lineChart } from './charts.js';
import { esc, pct, yen } from './format.js';

export function presetLabel(state) {
  return state.preset === 'custom' ? 'カスタム' : PRESETS[state.preset]?.label || 'バランス';
}

function controls(ctx) {
  const { state, bt } = ctx;
  return `<div class="bt-controls">
    <div class="field-row">
      <label class="field" for="bt-count">レース数</label>
      <select id="bt-count" data-bt-count ${bt.running ? 'disabled' : ''}>
        ${[100, 200, 400].map((n) => `<option value="${n}" ${bt.count === n ? 'selected' : ''}>${n}レース</option>`).join('')}
      </select>
    </div>
    <p class="bt-weights">使う設定：重み付け <b>${esc(presetLabel(state))}</b>・期待値にオッズを混ぜる割合 <b>${Math.round(state.blend * 100)}%</b>（予想画面の設定）</p>
    <button type="button" class="btn" data-action="run-backtest" ${bt.running ? 'disabled' : ''}>${bt.result ? 'もう一度検証' : '検証する'}</button>
    <div class="progress" ${bt.running ? '' : 'hidden'} role="progressbar" aria-label="検証の進み具合" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(bt.progress * 100)}">
      <span style="width:${(bt.progress * 100).toFixed(0)}%"></span>
    </div>
    <span class="progress-label" role="status">${bt.running ? esc(bt.stage) : ''}</span>
  </div>`;
}

function tiles(res) {
  const win = res.strategies.find((s) => s.key === 'win');
  const ai = res.strategies.find((s) => s.key === 'ai');
  return `<div class="summary bt-summary">
    <div class="tile"><div class="tile-label">◎の勝率</div><div class="tile-value num">${pct(res.ai.winRate)}</div><div class="tile-sub">1番人気は ${pct(res.fav.winRate)}</div></div>
    <div class="tile"><div class="tile-label">◎の複勝率</div><div class="tile-value num">${pct(res.ai.top3Rate)}</div><div class="tile-sub">1番人気は ${pct(res.fav.top3Rate)}</div></div>
    <div class="tile"><div class="tile-label">単勝◎の回収率</div><div class="tile-value num">${pct(win.roi)}</div><div class="tile-sub">収支 ${yen(win.profit)}（1点100円）</div></div>
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

export function renderBacktest(ctx) {
  const { bt } = ctx;
  const res = bt.result;
  const intro = `<div class="view-intro">
    <h1 class="view-title">バックテスト</h1>
    <p>結果がわかっている過去のレースで、今の予想設定と買い方を検証します。使うのは<strong>架空の過去レース</strong>（予想の学習には使っていないもの）で、オッズと払戻は「馬柱などの公開情報と、市場だけが持つ情報」を組み合わせた市場モデルで作っています。</p>
  </div>`;
  if (!res) {
    return `${intro}${controls(ctx)}<div class="empty-state small"><p>「検証する」を押すと、レースごとに予想 → 買い目 → 払戻の精算を行います。</p></div>`;
  }
  const focus = res.strategies.find((s) => s.key === bt.focus) || res.strategies[0];
  const base = res.strategies.find((s) => s.key === 'fav');
  const series = [
    { label: base.label, values: base.curve, cls: 's-base' },
    { label: focus.label, values: focus.curve, cls: 's-focus', area: true },
  ];
  return `${intro}${controls(ctx)}
    ${tiles(res)}
    <section class="bt-section">
      <h2 class="section-title">買い方ごとの成績 <small>${res.races}レース・行を押すとグラフが切り替わります</small></h2>
      ${strategyTable(res, focus.key)}
      <p class="panel-note">三連複などは1回の高配当で回収率が大きく動きます。「最高払戻」が収支の大半を占めているときは、レース数を増やして確かめてください。</p>
    </section>
    <div class="bt-charts">
      <section class="panel">
        <header class="panel-head"><h2>累積収支の推移</h2></header>
        <ul class="legend"><li><span class="lg-line s-focus"></span>${esc(focus.label)}</li><li><span class="lg-line s-base"></span>${esc(base.label)}</li></ul>
        <div class="chart-box">${lineChart({ id: 'bt-line', series })}</div>
        <p class="panel-note">最終収支：${esc(focus.label)} ${yen(focus.profit)}、${esc(base.label)} ${yen(base.profit)}。グラフにカーソルを合わせるか、選んで左右キーで各時点の値を表示します。</p>
      </section>
      <section class="panel">
        <header class="panel-head"><h2>予測の当たり具合</h2></header>
        <ul class="legend"><li><span class="lg-dot s-focus"></span>AI（${esc(presetLabel(ctx.state))}）</li><li><span class="lg-dot s-base"></span>オッズ（市場）</li></ul>
        <div class="chart-box">${calibrationChart(res.calibration)}</div>
        <p class="panel-note">点が斜めの線に近いほど、確率の見積もりが正確です。対数損失（小さいほど良い）は AI ${res.ai.logLoss.toFixed(3)}、オッズ ${res.fav.logLoss.toFixed(3)}。</p>
      </section>
    </div>
    <section class="note-box">
      <h2>結果の読み方</h2>
      <p>オッズには馬柱などの公開情報がすでに織り込まれているため、公開情報だけで計算する予想で長期的に回収率100%を超えるのは難しく、この検証でも多くの買い方が100%を下回ります。単発のレースや少ないレース数では運の影響が大きいので、数百レース単位で比べてください。ここでの数字は架空データでの結果で、実際の馬券での成績を保証するものではありません。</p>
    </section>`;
}
