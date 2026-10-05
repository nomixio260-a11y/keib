// 設定画面：予想のモデルと買い方の設定を一か所にまとめ、変えた効果（表示中の期間の実際の成績）をすぐ比べる。
// 予想画面には、いまの設定の要約と効果だけの小さなカード（renderSettingsCard）を出す。

import { BET_LABEL, BET_TYPES } from '../engine/constants.js';
import { FACTORS, PRESETS, DEFAULT_PRESET } from '../engine/model.js';
import { STRATEGIES, BLEND_OPTIONS, KEEP_OPTIONS, DAY_BUDGET_OPTIONS, DEFAULT_STRATEGY, DEFAULT_TYPES, resolveDayBudget } from '../engine/bets.js';
import { esc, pct, yen } from './format.js';
import { dayBars } from './charts.js';

/** 1日の予算の説明（倍数ごと）。発走前のオッズで選ぶ検証（scratchpad/ml8/grid-j）では、1日に買うのは平均1〜2レースなので上限にはほとんど届かない */
export const DAY_BUDGET_NOTE = {
  7: 'その日の買い目の合計が1レースの予算の7倍を超えたら、発走の早いレースから順に予算まで買い、入らないレースは見送ります（前のレースを買う時点では、後のレースのオッズはわからないため）。いまの的中重視の自動は1日に平均1〜2レースしか買わないので、上限に届く日はほとんどありません。1日の負けは最大でも1日の予算までです。',
  5: '1日の予算を1レースの予算の5倍までにします（発走の早いレースから順に）。1日の負けの上限が小さくなります。',
  10: '1日の予算を1レースの予算の10倍までにします（発走の早いレースから順に）。',
};
export const DAY_BUDGET_NONE_NOTE = '1日の予算はなし（その日の買い目をすべて買います）。1日の負けに上限がありません。';

const signedYen = (v) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v)).toLocaleString('ja-JP')}円`);
const typesLabel = (types) => (types.length ? types.map((t) => BET_LABEL[t]).join('・') : 'なし');
const sameTypes = (a, b) => a.length === b.length && a.every((t) => b.includes(t));

/** いまの設定の要約（チップ用の短い文の配列） */
export function settingsChips(state) {
  const preset = state.preset === 'custom' ? 'カスタム' : PRESETS[state.preset]?.label || state.preset;
  const chips = [`予想：${preset}`, `荒れ度 ${Number(state.noise).toFixed(1)}`, `買い方：${STRATEGIES[state.strategy]?.label || state.strategy}`, `1R ${yen(state.budget)}`];
  if (STRATEGIES[state.strategy]?.autoStake) {
    const m = resolveDayBudget(state.dayBudget);
    chips.push(m > 0 ? `1日の予算 ${m}倍（${yen(m * state.budget)}）` : '1日の予算なし');
  }
  chips.push(`券種：${typesLabel(state.betTypes)}`);
  if (String(state.keep) !== 'auto') chips.push(`当たる確率で絞る ${KEEP_OPTIONS.find((o) => String(o.value) === String(state.keep))?.label || state.keep}`);
  if (String(state.blend) !== 'auto') chips.push(`オッズを混ぜる ${Math.round(Number(state.blend) * 100)}%`);
  return chips;
}

/** いまの設定のチップ（HTML） */
export function settingsChipsHtml(state) {
  return `<ul class="setting-chips" aria-label="いまの設定">${settingsChips(state).map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`;
}

/** 設定の短い名前（「変更前」の見出し用） */
export function settingsLabel(state) {
  return settingsChips(state).join('・');
}

/** 標準の設定（1レースの予算はそのまま）と同じか */
export function isStandardSettings(state, defaults) {
  return (
    state.preset === DEFAULT_PRESET &&
    FACTORS.every((f) => Number(state.weights[f.key]) === Number(defaults.weights[f.key])) &&
    Number(state.noise) === Number(defaults.noise) &&
    state.strategy === DEFAULT_STRATEGY &&
    sameTypes(state.betTypes, DEFAULT_TYPES) &&
    String(state.blend) === 'auto' &&
    String(state.keep) === 'auto' &&
    String(state.dayBudget ?? 'auto') === 'auto'
  );
}

/** 券種ごとの成績（いまの設定） */
function typeTable(types) {
  const list = Object.entries(types || {}).filter(([, a]) => a.n > 0);
  if (!list.length) return '';
  const order = ['win', 'place', 'quinella', 'wide', 'exacta', 'trio', 'trifecta'];
  list.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  return `<details class="settings-more"><summary>券種ごとの成績（いまの設定）</summary><div class="table-scroll"><table class="effect-table effect-types">
    <thead><tr><th>券種</th><th>点数</th><th>的中</th><th>回収率</th><th>収支</th></tr></thead>
    <tbody>${list
      .map(([t, a]) => `<tr><th scope="row">${esc(BET_LABEL[t] || t)}</th><td class="num">${a.n}</td><td class="num">${a.hits}</td><td class="num">${a.stake ? pct(a.pay / a.stake, 0) : '—'}</td><td class="num ${a.pay - a.stake >= 0 ? 'tx-good' : 'tx-bad'}">${signedYen(a.pay - a.stake)}</td></tr>`)
      .join('')}</tbody></table></div></details>`;
}

/** 効果の表の1列 */
function effectCol(sum, pending) {
  if (!sum || !sum.dayCount) return { profit: pending ? '計算中' : '—', roi: '', hits: '', lose: '', worst: '' };
  return {
    profit: `<span class="${sum.profit >= 0 ? 'tx-good' : 'tx-bad'}">${signedYen(sum.profit)}</span>`,
    roi: sum.roi != null ? pct(sum.roi, 1) : '—',
    hits: `${sum.hitRaces}<small>/${sum.bets}R</small>`,
    lose: `${sum.loseDays}<small>/${sum.betDays}日</small>`,
    worst: sum.worst != null ? signedYen(sum.worst) : '—',
  };
}

/** 変更の効果（表示中の期間の実際のレース：いまの設定・標準・変更前） */
export function renderEffectPanel(ctx) {
  const e = ctx.effect;
  if (!e) return '';
  const cols = [];
  if (e.prev) cols.push({ head: '変更前', sub: e.prev.label, sum: e.prev.sum });
  cols.push({ head: e.same ? 'いまの設定（標準）' : 'いまの設定', sum: e.cur, pending: e.curPending });
  if (!e.same) cols.push({ head: '標準', sub: '予想と買い方を標準に（1Rの予算は同じ）', sum: e.std, pending: e.stdPending });
  const cells = cols.map((c) => effectCol(c.sum, c.pending));
  const row = (label, key, title = '') => `<tr><th scope="row"${title ? ` title="${esc(title)}"` : ''}>${label}</th>${cells.map((c, i) => `<td class="num${cols[i].head.startsWith('いまの') ? ' is-cur' : ''}">${c[key]}</td>`).join('')}</tr>`;
  const stdDays = !e.same && e.std ? new Map(e.std.days.map((d) => [d.date, d])) : null;
  const pending = (e.curPending || 0) + (e.same ? 0 : e.stdPending || 0);
  const delta = e.prev?.sum && e.cur && !e.curPending ? e.cur.profit - e.prev.sum.profit : null;
  return `<section class="panel effect-panel" id="effect-panel" aria-labelledby="h-effect">
    <header class="panel-head"><h2 id="h-effect">変更の効果</h2><span class="panel-sub">${esc(e.period)}・実際の払戻</span></header>
    ${
      e.cur?.dayCount || e.curPending
        ? `<div class="table-scroll"><table class="effect-table">
      <thead><tr><th></th>${cols.map((c) => `<th scope="col"${c.sub ? ` title="${esc(c.sub)}"` : ''}>${esc(c.head)}</th>`).join('')}</tr></thead>
      <tbody>
        ${row('収支', 'profit')}
        ${row('回収率', 'roi')}
        ${row('的中したレース', 'hits', '払戻のあったレース／買ったレース')}
        ${row('負けた日', 'lose', '収支がマイナスの日／買った日')}
        ${row('最悪の日', 'worst')}
      </tbody>
    </table></div>
    ${delta != null ? `<p class="effect-delta ${delta >= 0 ? 'tx-good' : 'tx-bad'}">直前の変更で、この期間の収支は ${signedYen(delta)}（${signedYen(e.prev.sum.profit)} → ${signedYen(e.cur.profit)}）</p>` : ''}
    ${e.cur?.days?.length ? dayBars(e.cur.days, stdDays, { label: '日ごとの収支（いまの設定）' }) : ''}
    ${e.cur?.days?.length ? `<p class="panel-note effect-legend"><span class="eb-key eb-key-pos"></span>勝った日 <span class="eb-key eb-key-neg"></span>負けた日${stdDays ? ' <span class="eb-key eb-key-std"></span>標準の収支' : ''}</p>` : ''}`
        : '<p class="panel-note">結果の出たレースがまだありません。過去の開催日を読み込むと、その期間で比べられます。</p>'
    }
    ${typeTable(e.curTypes)}
    ${pending ? `<p class="panel-note muted">計算中（残り ${pending}レース）…</p>` : ''}
    <p class="panel-note">表示中の期間のレースを、それぞれの設定の予想と買い目で実際の払戻で精算しています（1日の予算も同じように当てはめます）。<b>終わったレースのオッズは確定オッズ（発走後に決まる）なので、実際に買う時点のオッズで選ぶより成績が良く出ます。</b>買う時点のオッズでの推定と、発走前に記録した買い目の本当の成績は「バックテスト」の画面にあります。期間が短いと偶然で大きく動きます。${e.prev ? '「変更前」は、最後に変えた設定の前の成績です。' : ''}</p>
    <div class="panel-actions">
      ${e.archiveAll ? '' : '<button type="button" class="ghost-btn" data-action="load-all-archive">過去30日を読み込んで比べる</button>'}
      <button type="button" class="ghost-btn" data-tab="backtest">バックテストを見る</button>
    </div>
  </section>`;
}

/** 予想のモデル */
function renderModelSection(ctx) {
  const { state } = ctx;
  const presets = Object.entries(PRESETS)
    .map(([k, p]) => `<button type="button" class="seg-btn${state.preset === k ? ' is-on' : ''}" data-preset="${k}" aria-pressed="${state.preset === k}">${esc(p.label)}</button>`)
    .join('');
  const ml = !!(PRESETS[state.preset]?.ml || PRESETS[state.preset]?.mlAi);
  const sliders = FACTORS.map(
    (f) => `<div class="slider">
      <label for="w-${f.key}"><span>${esc(f.label)}</span><output class="num" id="wo-${f.key}">${esc(state.weights[f.key])}</output></label>
      <input type="range" id="w-${f.key}" min="0" max="100" step="1" value="${esc(state.weights[f.key])}" data-weight="${f.key}" aria-describedby="wd-${f.key}">
      <p class="slider-desc" id="wd-${f.key}">${esc(f.desc)}</p>
    </div>`,
  ).join('');
  return `<section class="panel settings-section" id="panel-weights" aria-labelledby="h-weights">
    <header class="panel-head"><h2 id="h-weights">予想のモデル</h2><span class="pill" id="custom-pill" ${state.preset === 'custom' ? '' : 'hidden'}>カスタム</span></header>
    <div class="seg preset-seg" role="group" aria-label="予想のモデル">${presets}</div>
    ${PRESETS[state.preset]?.desc ? `<p class="panel-note preset-desc">${esc(PRESETS[state.preset].desc)}</p>` : ''}
    ${ml ? '' : `<details class="settings-more"><summary>重み付け（ファクターの重み）</summary><div class="sliders">${sliders}</div></details>`}
    <div class="slider">
      <label for="noise"><span>荒れ度</span><output class="num" id="noise-out">${Number(state.noise).toFixed(1)}</output></label>
      <input type="range" id="noise" min="0.6" max="1.6" step="0.1" value="${esc(state.noise)}" data-noise>
      <p class="slider-desc">小さいほど能力どおりの堅い決着、大きいほど波乱を多めに見込みます（標準 1.0 が、学習に使っていない期間で最もよく当たりました）。</p>
    </div>
    <div class="field-row">
      <label class="field" for="sims">シミュレーション回数</label>
      <select id="sims" data-sims>
        ${[20000, 50000, 100000].map((n) => `<option value="${n}" ${state.sims === n ? 'selected' : ''}>${n.toLocaleString('ja-JP')}回</option>`).join('')}
      </select>
    </div>
    <p class="panel-note">勝率・複勝率・各買い目の確率は1〜3着のすべての並びで厳密に計算するので、回数で予想は変わりません。回数は4着以下の分布と、買い目表の「この日の収支の見込み」の精度に効きます。</p>
  </section>`;
}

/** 買い方 */
function renderBetSection(ctx) {
  const { state } = ctx;
  const budgets = [1000, 3000, 5000, 10000];
  const strategies = Object.entries(STRATEGIES)
    .map(([k, s]) => `<button type="button" class="seg-btn${state.strategy === k ? ' is-on' : ''}" data-strategy="${k}" aria-pressed="${state.strategy === k}">${esc(s.label)}</button>`)
    .join('');
  const types = BET_TYPES.map(
    (t) => `<label class="toggle-chip"><input type="checkbox" data-bettype="${t}" ${state.betTypes.includes(t) ? 'checked' : ''}><span>${esc(BET_LABEL[t])}</span></label>`,
  ).join('');
  const auto = !!STRATEGIES[state.strategy]?.autoStake;
  const mult = resolveDayBudget(state.dayBudget);
  return `<section class="panel settings-section" id="panel-betset" aria-labelledby="h-betset">
    <header class="panel-head"><h2 id="h-betset">買い方</h2></header>
    <div class="seg strat-seg" role="group" aria-label="買い方">${strategies}</div>
    <p class="panel-note">${esc(STRATEGIES[state.strategy].desc)}</p>
    <div class="field-row">
      <label class="field" for="budget">1レースの予算（円）</label>
      <input id="budget" type="number" inputmode="numeric" min="100" step="100" value="${esc(state.budget)}" data-budget-input>
      <div class="quick">${budgets.map((b) => `<button type="button" class="mini-btn${state.budget === b ? ' is-on' : ''}" data-budget="${b}">${b.toLocaleString('ja-JP')}</button>`).join('')}</div>
    </div>
    <p class="panel-note">予算は1レースの上限です。的中重視（自動）は自信に応じて金額を決めるので、使い切るとは限りません。</p>
    ${
      auto
        ? `<div class="field-row">
      <label class="field" for="daybudget">1日の予算</label>
      <select id="daybudget" data-daybudget>
        ${DAY_BUDGET_OPTIONS.map((o) => `<option value="${o.value}" ${String(state.dayBudget ?? 'auto') === String(o.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>
    </div>
    <p class="panel-note">${
      mult > 0
        ? `朝や前日にまとめて買っても効くように、レースの結果を見ずに1日分の買い目で決めます。その日の買い目の合計が1日の予算（${yen(mult * state.budget)}）を超えたら、リスクに対する期待値の高い買い目から順に予算まで買い、入らない買い目は見送ります。1日の負けは最大でも1日の予算までです。${DAY_BUDGET_NOTE[mult] || ''}`
        : DAY_BUDGET_NONE_NOTE
    }</p>`
        : ''
    }
    <div class="chips-row" role="group" aria-label="券種">${types}</div>
    <p class="panel-note">標準はワイド以外のすべて。馬単・三連単は推定オッズなので、的中重視（自動）では買いません（自動で買うのは単勝・複勝と、JRA の実際のオッズのある馬連・三連複）。</p>
    <div class="field-row">
      <label class="field" for="keep">当たる確率で絞る</label>
      <select id="keep" data-keep>
        ${KEEP_OPTIONS.map((o) => `<option value="${o.value}" ${String(state.keep ?? 'auto') === String(o.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>
    </div>
    <div class="field-row">
      <label class="field" for="blend">期待値にオッズを混ぜる</label>
      <select id="blend" data-blend>
        ${BLEND_OPTIONS.map((o) => `<option value="${o.value}" ${String(state.blend) === String(o.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>
    </div>
    ${auto ? '<p class="panel-note">的中重視（自動）は、標準ではオッズを混ぜません（確定オッズで選ぶ以前の検証では、混ぜるほど買うレースと収支が減り、的中率は上がりませんでした）。</p>' : ''}
  </section>`;
}

/** 設定画面（タブ） */
export function renderSettingsView(ctx) {
  const { state } = ctx;
  return `<div class="settings-view">
    <div class="view-intro">
      <h1 class="view-title">設定と効果</h1>
      <p>予想のモデルと買い方の設定をここにまとめました。変えるとすぐ、表示中の期間の実際のレースで「いまの設定」「標準」「変更前」の成績を比べます。</p>
    </div>
    ${settingsChipsHtml(state)}
    <div class="settings-grid">
      <div class="settings-col" id="slot-effect">${renderEffectPanel(ctx)}</div>
      <div class="settings-col">
        ${renderBetSection(ctx)}
        ${renderModelSection(ctx)}
        <div class="panel-actions settings-reset"><button type="button" class="ghost-btn" data-action="reset-all">すべて標準に戻す</button><span class="muted">1レースの予算はそのまま</span></div>
      </div>
    </div>
  </div>`;
}

/** 予想画面の小さなカード：いまの設定と、表示中の期間の収支（標準との比較） */
export function renderSettingsCard(ctx) {
  const { state } = ctx;
  const e = ctx.effect;
  const cur = e?.cur;
  const line = cur?.dayCount
    ? `${esc(e.period)}：収支 <b class="num ${cur.profit >= 0 ? 'tx-good' : 'tx-bad'}">${signedYen(cur.profit)}</b>${!e.same && e.std?.dayCount ? `（標準 ${signedYen(e.std.profit)}）` : ''}${e.curPending ? '・計算中' : ''}`
    : '';
  return `<section class="panel settings-card" id="panel-settings-card" aria-labelledby="h-setcard">
    <header class="panel-head"><h2 id="h-setcard">いまの設定</h2><button type="button" class="btn btn-sm" data-tab="settings">設定を変える</button></header>
    ${settingsChipsHtml(state)}
    ${line ? `<p class="panel-note effect-mini">${line}</p>` : ''}
  </section>`;
}

/** 買い目の欄・買い目表の上に出す1行（設定はまとめて設定画面で） */
export function settingsLine(state) {
  return `<div class="settings-line"><span>${esc(settingsChips(state).slice(2, 5).join('・'))}</span><button type="button" class="link-btn" data-tab="settings">設定を変える</button></div>`;
}
