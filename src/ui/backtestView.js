// バックテスト画面：学習に使っていない実際のレース（JRA）で、予想と買い方を検証した結果。払戻は実際の金額

import { PRESETS } from '../engine/model.js';
import { REAL_BACKTEST } from '../data/realBacktest.js';
import { calibrationChart, lineChart, dayBars } from './charts.js';
import { esc, pct, yen } from './format.js';
import { renderReviewSection } from './reviewView.js';

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

/** AI推奨の日ごとの収支（負けた日・最悪の日・1回も勝てない日） */
function aiDailySection(res) {
  const ai = res.strategies.find((s) => s.key === 'ai');
  if (!ai?.daily?.length) return '';
  const days = ai.daily.map((d) => ({ date: d.date, profit: d.pay - d.stake, bets: d.races, hits: d.hits }));
  const total = days.reduce((a, d) => a + d.profit, 0);
  const lose = days.filter((d) => d.profit < 0).length;
  const noWin = days.filter((d) => d.hits === 0).length;
  const worst = Math.min(...days.map((d) => d.profit));
  return `<section class="bt-section">
      <h2 class="section-title">AI推奨の日ごとの収支 <small>${esc(ai.label)}・${days.length}日</small></h2>
      <dl class="ds-grid bt-daily">
        <div><dt>勝った日</dt><dd class="num">${days.length - lose}<small>/${days.length}日</small></dd></div>
        <div><dt>負けた日</dt><dd class="num">${lose}<small>/${days.length}日</small></dd></div>
        <div><dt>1回も勝てない日</dt><dd class="num">${noWin}<small>日</small></dd></div>
        <div><dt>最悪の日</dt><dd class="num">${signedYen(worst)}</dd></div>
        <div><dt>合計</dt><dd class="num ${total >= 0 ? 'tx-good' : 'tx-bad'}">${signedYen(total)}</dd></div>
      </dl>
      ${dayBars(days, null, { label: 'AI推奨の日ごとの収支' })}
      <p class="panel-note">負けた日は、買ったレースの払戻の合計が金額を下回った日です。どの買い方でも負ける日はなくなりません（発走前のオッズで選ぶ推定でも、買った日の約4割）。1日の予算で、負けた日の大きさを抑えています。この表は確定オッズで選び直したもので、実際に買う時点のオッズでは買うレースも成績も変わります（下の推定）。</p>
    </section>`;
}

const signedYen = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v)).toLocaleString('ja-JP')}円`;

/** 発走前に記録した買い目の成績（Race day が発走前に記録したもの。後から選び直せないので、ごまかしのない成績） */
export function picksSection(picks) {
  const head = '<h2 class="section-title">発走前に記録した買い目の成績 <small>標準の設定（1R 1,000円・的中重視の自動・1日の予算 7倍）</small></h2>';
  const how = '<p class="panel-note">Race day（自動更新）が取り込みのたびに、まだ発走していないレースの買い目を記録しています（data ブランチの picks/）。発走1分前を過ぎたレースの記録は書き換えません。「直前」は発走前に最後に記録した買い目、「最初」は複勝のオッズが出た発走2時間前ごろに最初に記録した買い目です。下の検証（確定オッズで選び直したもの）と違い、レースの前に決まっていた買い目なので、後からごまかすことができません。</p>';
  if (!picks || picks.loading) return `<section class="bt-section bt-picks">${head}<p class="panel-note">記録を読み込んでいます…</p></section>`;
  const last = picks.last;
  if (!last?.recorded) {
    return `<section class="bt-section bt-picks">${head}<div class="empty-state small"><p>記録は 2026-10-05 から始めました。最初の成績は次の開催日（10/10〜）のレースが確定すると表示されます。</p></div>${how}</section>`;
  }
  const row = (label, s) =>
    `<tr><th scope="row">${esc(label)}</th><td class="num">${s.recorded.toLocaleString('ja-JP')}</td><td class="num">${s.bets.toLocaleString('ja-JP')}</td><td class="num">${s.hitRate != null ? pct(s.hitRate) : '—'}</td><td class="num">${s.roi != null ? pct(s.roi) : '—'}</td><td class="num ${s.profit >= 0 ? 'tx-good' : 'tx-bad'}">${signedYen(s.profit)}</td><td class="num">${s.loseDays}<small>/${s.betDays}日</small></td></tr>`;
  const days = last.days
    .slice()
    .reverse()
    .slice(0, 30)
    .map((d) => `<tr><th scope="row">${esc(d.date)}</th><td class="num">${d.settled}<small>/${d.recorded}</small></td><td class="num">${d.bets}</td><td class="num">${d.hits}</td><td class="num">${d.stake.toLocaleString('ja-JP')}</td><td class="num">${Math.round(d.pay).toLocaleString('ja-JP')}</td><td class="num ${d.profit >= 0 ? 'tx-good' : 'tx-bad'}">${signedYen(d.profit)}</td></tr>`)
    .join('');
  return `<section class="bt-section bt-picks">${head}
    <div class="table-scroll"><table class="bt-table">
      <thead><tr><th>記録</th><th>記録したレース</th><th>買ったレース</th><th>的中率</th><th>回収率</th><th>収支</th><th>負けた日</th></tr></thead>
      <tbody>${row('直前（発走1分前まで）', last)}${picks.first ? row('最初（発走2時間前ごろ）', picks.first) : ''}</tbody>
    </table></div>
    <div class="table-scroll"><table class="bt-table">
      <thead><tr><th>開催日</th><th>確定<small>/記録</small></th><th>買ったレース</th><th>的中</th><th>投資（円）</th><th>払戻（円）</th><th>収支</th></tr></thead>
      <tbody>${days}</tbody>
    </table></div>
    ${how}
  </section>`;
}

/** 発走前のオッズで選んだ場合（推定）：確定オッズで選ぶ検証との比較 */
export function realisticSection(real) {
  if (!real?.estimate || !real.final) return '';
  const r = (label, x, note = '') =>
    `<tr><th scope="row">${esc(label)}${note}</th><td class="num">${Math.round(x.races).toLocaleString('ja-JP')}</td><td class="num">${pct(x.hitRate)}</td><td class="num">${pct(x.roi)}</td><td class="num ${x.profit >= 0 ? 'tx-good' : 'tx-bad'}">${signedYen(x.profit)}</td><td class="num">${Number(x.loseDays).toFixed(Number.isInteger(x.loseDays) ? 0 : 1)}<small>/${Math.round(x.betDays)}日</small></td></tr>`;
  const d = real.drift || {};
  const runs = (real.runs || []).map((x, i) => r(`発走${real.minutes}分前（乱数${i + 1}）`, x)).join('');
  return `<section class="bt-section bt-real">
      <h2 class="section-title">発走${real.minutes}分前のオッズで選んだ場合（推定） <small>AI推奨（標準の設定・1R 1,000円）</small></h2>
      <div class="table-scroll"><table class="bt-table">
        <thead><tr><th>オッズの時点</th><th>買ったレース</th><th>的中率</th><th>回収率</th><th>収支</th><th>負けた日</th></tr></thead>
        <tbody>${r('確定オッズ（上の検証）', real.final)}${r(`発走${real.minutes}分前（推定・平均）`, real.estimate)}${runs}</tbody>
      </table></div>
      <p class="panel-note"><strong>上の検証は、発走後に決まる確定オッズで買い目を選んでいます。</strong>実際に買う時点のオッズは確定オッズからかなりずれます（締切の直前に多くの票が入るため。記録したオッズの推移 ${d.races ?? '—'}レース・${d.days ?? '—'}日では、5倍未満の馬で発走${real.minutes}分前と確定の差の中央値 ${d.favMedianAbs != null ? `${Math.round((Math.exp(d.favMedianAbs) - 1) * 100)}%` : '—'}）。そのずれを確定オッズに足して予想し直し、実際の払戻で精算したのがこの推定です。確定オッズで選んだ成績は、実際には出せません。記録したオッズの推移はまだ少ないので、推定には幅があります（乱数ごとの差を見てください）。本当の成績は、上の「発走前に記録した買い目の成績」で確かめてください。</p>
    </section>`;
}

export function renderBacktest(ctx) {
  const { bt, state } = ctx;
  const saved = REAL_BACKTEST;
  const intro = `<div class="view-intro">
    <h1 class="view-title">バックテスト</h1>
    <p>実際のレース（JRA）で予想と買い方を検証した結果です。各レースの予想は、出馬表・前4走・騎手と厩舎の成績（そのレースより前の分）と<strong>確定オッズ</strong>で計算し、払戻は実際の金額で精算しています。「検証済み」は、予想の重みの学習にも統計にも<strong>使っていない</strong>期間のレースでの結果です。</p>
    <p class="bt-warn">確定オッズは発走後に決まるので、実際に買う時点ではわかりません。確定オッズで選んだ成績は実際より良く出ます（下の「発走前のオッズで選んだ場合（推定）」）。本当の成績は「発走前に記録した買い目の成績」で確かめてください。</p>
    ${saved ? `<p class="bt-meta">検証済みの期間 <b>${esc(saved.period)}</b>・<b class="num">${saved.races.toLocaleString('ja-JP')}</b>レース（平地）・データ JRA・作成 ${esc(saved.generatedAt)}</p>` : ''}
  </div>`;
  const res = currentBacktest(bt);
  if (!res) {
    return `${intro}${picksSection(ctx.picks)}${sourceSwitch(ctx)}<div class="empty-state small"><p>${saved ? '「直近の開催日を検証」を押すと、表示中の設定で予想 → 買い目 → 実際の払戻の精算を行います。' : '検証結果はまだありません。npm run evaluate で作成するか、直近の開催日で検証してください。'}</p></div>${renderReviewSection(ctx)}`;
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
  return `${intro}${picksSection(ctx.picks)}${sourceSwitch(ctx)}
    <p class="bt-weights">${settingNote}</p>
    ${tiles(res)}
    <section class="bt-section">
      <h2 class="section-title">買い方ごとの成績 <small>${res.races.toLocaleString('ja-JP')}レース・1点100円・行を押すとグラフが切り替わります</small></h2>
      ${strategyTable(res, focus.key)}
      <p class="panel-note">三連複などは1回の高配当で回収率が大きく動きます。「最高払戻」が収支の大半を占めているときは、運の要素が大きいと考えてください。</p>
    </section>
    ${aiDailySection(res)}
    ${bt.source === 'saved' ? realisticSection(saved?.realistic) : ''}
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
    ${renderReviewSection(ctx)}
    <section class="note-box">
      <h2>結果の読み方</h2>
      <p>オッズには多くの人の予想がすでに織り込まれているため、公開情報だけで長期的に回収率100%を超えるのは非常に難しく、この検証でも多くの買い方が100%を下回ります。◎の勝率・複勝率が1番人気と比べてどうか、キャリブレーション（予測した確率と実際の勝率の一致）がどうかを、予想の確かさの目安にしてください。過去の成績は将来の結果を保証するものではありません。</p>
    </section>`;
}
