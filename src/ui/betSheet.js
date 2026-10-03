// 買い目表：選んだ開催日の全レースの印・買い目・状態を1枚の表にまとめる（印刷・コピー向け）。
// 買い目は今の買い方（戦略・予算・券種）と発売中のオッズで計算し、確定したレースは実際の払戻で精算する。

import { esc, frameBadge, pct, yen, odds, markClass } from './format.js';
import { raceStatus, startMs, untilText } from '../engine/raceTime.js';
import { BET_LABEL } from '../engine/constants.js';
import { ticketLabel, STRATEGIES } from '../engine/bets.js';
import { payoutOf } from '../engine/backtest.js';
import { dayLabel, gradeChip, surfaceChip } from './timeline.js';

const MARKS = ['◎', '○', '▲'];
const ticketNums = (t, pred) => t.idx.map((i) => pred.rows[i].entry.number);

/** 買い目を実際の払戻で精算（確定したレースだけ） */
export function settleTickets(race, pred, tickets) {
  if (!race?.result?.length || !tickets?.length) return null;
  let stake = 0;
  let pay = 0;
  let hits = 0;
  const detail = tickets.map((t) => {
    const nums = ticketNums(t, pred);
    const ret = (payoutOf(race, t.type, nums) * t.stake) / 100;
    stake += t.stake;
    pay += ret;
    if (ret > 0) hits++;
    return { type: t.type, nums, stake: t.stake, pay: ret };
  });
  return { stake, pay, hits, detail };
}

/** 状態の短い説明 */
export function statusText(race, st, now) {
  if (st === 'result') return '確定';
  const t = startMs(race);
  if (st === 'live') {
    const m = t ? Math.max(0, Math.floor((now - t) / 60000)) : 0;
    return `発走済み（${m}分前）・結果は数分後に反映`;
  }
  if (st === 'closing') return '締切間近';
  return t ? `発売中・${untilText(t - now)}` : '発売中';
}

/** 表の中身を計算（画面でもテキストでも使う） */
export function buildSheet(ctx) {
  const { state, racesOf, predFor, recFor, now } = ctx;
  const races = racesOf(state.day, null)
    .slice()
    .sort((a, b) => String(a.startTime || '').localeCompare(String(b.startTime || '')) || String(a.course).localeCompare(String(b.course)));
  const rows = races.map((race) => {
    const st = raceStatus(race, now);
    if (race.jump || race.surface === '障') return { race, st, jump: true };
    const pred = predFor(race);
    if (!pred || pred.empty) return { race, st, empty: true };
    const rec = recFor(pred);
    const marks = MARKS.map((m, k) => pred.order[k]).filter(Boolean);
    return { race, st, pred, rec, marks, settle: settleTickets(race, pred, rec.tickets) };
  });
  const withBets = rows.filter((r) => r.rec?.tickets.length);
  const settled = rows.filter((r) => r.settle);
  const sum = {
    races: rows.length,
    bets: withBets.length,
    total: withBets.reduce((a, r) => a + r.rec.tickets.reduce((x, t) => x + t.stake, 0), 0),
    settledRaces: settled.length,
    settledStake: settled.reduce((a, r) => a + r.settle.stake, 0),
    settledPay: settled.reduce((a, r) => a + r.settle.pay, 0),
    hitRaces: settled.filter((r) => r.settle.hits > 0).length,
  };
  return { rows, sum };
}

function nameOf(race, number) {
  return race.entries.find((e) => e.number === number)?.name || '';
}

function resultCell(row) {
  const { race, settle } = row;
  if (!race.result?.length) return '<span class="muted">—</span>';
  const top = race.result.slice(0, 3).map((n, i) => `<div class="sheet-fin"><small>${i + 1}着</small>${frameBadge(race.entries.find((e) => e.number === n)?.frame, n, 'sm')} ${esc(nameOf(race, n))}</div>`).join('');
  if (!settle) return top;
  const diff = settle.pay - settle.stake;
  return `${top}<div class="sheet-settle ${settle.hits ? 'tx-hit' : 'tx-miss'}">${settle.hits ? `的中 ${settle.hits}点・払戻 ${yen(settle.pay)}` : '不的中'}<br><small>収支 ${diff >= 0 ? '+' : ''}${diff.toLocaleString('ja-JP')}円</small></div>`;
}

function betsCell(row) {
  const { rec, settle } = row;
  if (rec.noOdds) return '<span class="muted">オッズ待ち<br><small>単勝オッズが出たら計算します</small></span>';
  if (!rec.tickets.length) return `<span class="muted">見送り${rec.skipped ? '<br><small>自信度の条件に合わないレース</small>' : '<br><small>期待値の条件に合う買い目なし</small>'}</span>`;
  const lines = rec.tickets.map((t, i) => {
    const hit = settle?.detail?.[i]?.pay > 0;
    return `<div class="sheet-bet${hit ? ' tx-hit' : ''}">${esc(BET_LABEL[t.type])} <b class="num">${esc(ticketLabel(t))}</b> <span class="num">${yen(t.stake)}</span>${hit ? ' ✓' : ''}</div>`;
  });
  const total = rec.tickets.reduce((a, t) => a + t.stake, 0);
  return `${lines.join('')}<div class="sheet-bet-total"><small>計 ${yen(total)}・どれかが当たる確率 ${pct(rec.stats.hitRate, 0)}</small></div>`;
}

function marksCell(row) {
  return row.marks
    .map((h, k) => {
      const e = h.entry;
      return `<div class="sheet-mark"><span class="mark ${markClass(MARKS[k])}">${MARKS[k]}</span>${frameBadge(e.frame, e.number, 'sm')} <span class="sheet-horse">${esc(e.name)}</span> <small class="num">${pct(h.pWin, 0)}${h.odds ? `・${odds(h.odds)}倍` : ''}</small></div>`;
    })
    .join('');
}

export function renderBetSheet(ctx) {
  const { state, now, venuesOf } = ctx;
  const { rows, sum } = buildSheet(ctx);
  const strat = STRATEGIES[state.strategy] || STRATEGIES.hit;
  const budgets = [1000, 3000, 5000, 10000];
  const stratBtns = Object.entries(STRATEGIES)
    .map(([k, s]) => `<button type="button" class="seg-btn${state.strategy === k ? ' is-on' : ''}" data-strategy="${k}" aria-pressed="${state.strategy === k}">${esc(s.label)}</button>`)
    .join('');
  const body = rows
    .map((row) => {
      const { race, st } = row;
      const head = `<td class="sheet-time"><b class="num">${esc(race.startTime || '—')}</b><br><small class="sheet-st">${esc(statusText(race, st, now))}</small></td>
        <td class="sheet-race"><button type="button" class="link-btn" data-race="${esc(race.id)}"><b>${esc(race.course)}${esc(race.raceNo)}R</b> ${esc(race.name)}</button><br>${surfaceChip(race)}${gradeChip(race.grade)}<small>${race.entries.filter((e) => !e.scratched).length}頭</small></td>`;
      if (row.jump) return `<tr class="sr-${st}">${head}<td colspan="4" class="muted">障害レース（予想対象外）</td></tr>`;
      if (row.empty) return `<tr class="sr-${st}">${head}<td colspan="4" class="muted">出馬表が足りないため予想できません</td></tr>`;
      return `<tr class="sr-${st}">${head}
        <td class="sheet-marks">${marksCell(row)}</td>
        <td class="sheet-grade"><span class="ri-grade g-${esc(row.pred.confidence.grade)}" title="自信度">${esc(row.pred.confidence.grade)}</span></td>
        <td class="sheet-bets">${betsCell(row)}</td>
        <td class="sheet-result">${resultCell(row)}</td>
      </tr>`;
    })
    .join('');
  const settledNote = sum.settledRaces
    ? `<div><dt>確定分の収支</dt><dd class="num ${sum.settledPay - sum.settledStake >= 0 ? 'tx-good' : 'tx-bad'}">${sum.settledPay - sum.settledStake >= 0 ? '+' : ''}${(sum.settledPay - sum.settledStake).toLocaleString('ja-JP')}円<small>（${sum.settledRaces}R・的中 ${sum.hitRaces}R・払戻 ${yen(sum.settledPay)}）</small></dd></div>`
    : '';
  return `<section class="bet-sheet" aria-label="買い目表">
    <div class="view-intro">
      <h1 class="view-title">買い目表 <small>${esc(dayLabel(state.day))}・${esc((venuesOf(state.day) || []).join('・'))}</small></h1>
      <p>この日の全レースの印（◎○▲＝機械学習の勝率順）と、今の買い方で選んだ買い目です。買い目は発売中の単勝オッズと複勝オッズで計算し、オッズが動けば変わります（画面は1分ごと、データは開催日に数分ごとに更新）。確定したレースは実際の払戻で精算しています。</p>
    </div>
    <div class="sheet-controls">
      <div class="seg strat-seg" role="group" aria-label="買い方">${stratBtns}</div>
      <div class="quick"><span class="seg-label">1レースの予算</span>${budgets.map((b) => `<button type="button" class="mini-btn${state.budget === b ? ' is-on' : ''}" data-budget="${b}">${b.toLocaleString('ja-JP')}円</button>`).join('')}</div>
      <p class="panel-note">${esc(strat.desc)}</p>
    </div>
    <dl class="ds-grid sheet-sum">
      <div><dt>レース</dt><dd class="num">${sum.races}</dd></div>
      <div><dt>買い目あり</dt><dd class="num">${sum.bets}<small>R</small></dd></div>
      <div><dt>合計金額</dt><dd class="num">${yen(sum.total)}</dd></div>
      ${settledNote}
    </dl>
    <div class="panel-actions">
      <button type="button" class="btn" data-action="copy-sheet">表をコピー</button>
      <button type="button" class="ghost-btn" data-action="print-sheet">印刷</button>
      <button type="button" class="ghost-btn" data-action="show-race">レースごとの画面へ</button>
      <span class="copy-status" role="status" aria-live="polite"></span>
    </div>
    <div class="table-scroll"><table class="sheet-table">
      <thead><tr><th>発走</th><th>レース</th><th>印（勝率・単勝）</th><th>自信度</th><th>買い目</th><th>結果</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    <p class="panel-note">自信度は S・A・B・C の順に当たりやすく、検証では S の◎が約6割勝っています。「控えめ」は S・A のレースだけ買い、ほかは見送ります。どの買い方でも長期的な回収率は 100% を下回っています（バックテストを参照）。</p>
    <textarea class="copy-fallback" id="copy-fallback-sheet" readonly hidden aria-label="コピー用の買い目表"></textarea>
  </section>`;
}

/** コピー用のテキスト */
export function sheetText(ctx) {
  const { state } = ctx;
  const { rows, sum } = buildSheet(ctx);
  const lines = [`KEIB 買い目表 ${dayLabel(state.day)}（${STRATEGIES[state.strategy]?.label || ''}・1レース${yen(state.budget)}）`];
  for (const row of rows) {
    const { race } = row;
    const head = `${race.startTime || '--:--'} ${race.course}${race.raceNo}R ${race.name}`;
    if (row.jump) {
      lines.push(`${head} 障害（対象外）`);
      continue;
    }
    if (row.empty) {
      lines.push(`${head} 予想なし`);
      continue;
    }
    const marks = row.marks.map((h, k) => `${MARKS[k]}${h.entry.number}${h.entry.name}`).join(' ');
    const bets = row.rec.noOdds ? 'オッズ待ち' : row.rec.tickets.length ? row.rec.tickets.map((t) => `${BET_LABEL[t.type]} ${ticketLabel(t)} ${t.stake}円`).join(' / ') : '見送り';
    const res = race.result?.length ? ` 結果 ${race.result.slice(0, 3).join('-')}${row.settle ? ` 払戻${Math.round(row.settle.pay)}円` : ''}` : '';
    lines.push(`${head} [${row.pred.confidence.grade}] ${marks} ｜ ${bets}${res}`);
  }
  lines.push(`合計 ${yen(sum.total)}（${sum.bets}レース）${sum.settledRaces ? `・確定分の収支 ${Math.round(sum.settledPay - sum.settledStake)}円` : ''}`);
  return lines.join('\n');
}
