// 確定したレース：着順・払戻と、予想の答え合わせ（実際の払戻で精算）

import { BET_LABEL } from '../engine/constants.js';
import { ticketLabel, evaluateFormations } from '../engine/bets.js';
import { payoutOf } from '../engine/backtest.js';
import { formatTime } from '../engine/util.js';
import { reviewRace, reviewText, MISS_KINDS } from '../engine/review.js';
import { horseComment } from '../engine/comments.js';
import { REAL_STATS } from '../engine/realStats.js';
import { esc, frameBadge, markClass, odds, yen } from './format.js';

const PAY_ORDER = ['win', 'place', 'bracket', 'quinella', 'wide', 'exacta', 'trio', 'trifecta'];
const PAY_LABEL = { ...BET_LABEL, bracket: '枠連' };

function payoutTable(race) {
  const rows = PAY_ORDER.filter((t) => race.payouts?.[t] && Object.keys(race.payouts[t]).length)
    .map((t) => {
      const items = Object.entries(race.payouts[t])
        .map(([k, v]) => `<span class="pay-item"><span class="num pay-combo">${esc(k.replace(/>/g, '→'))}</span><span class="num pay-yen">${Number(v).toLocaleString('ja-JP')}円</span></span>`)
        .join('');
      return `<tr><th>${esc(PAY_LABEL[t])}</th><td>${items}</td></tr>`;
    })
    .join('');
  return rows ? `<div class="table-scroll"><table class="pay-table"><tbody>${rows}</tbody></table></div>` : '<p class="muted">払戻のデータがありません。</p>';
}

/** 実際の払戻で精算 */
function settle(race, tickets) {
  let stake = 0;
  let ret = 0;
  const hits = [];
  for (const t of tickets) {
    stake += t.stake;
    const pay = payoutOf(race, t.type, t.nums);
    if (pay > 0) {
      ret += (t.stake / 100) * pay;
      hits.push({ ...t, pay });
    }
  }
  return { stake, ret, hits };
}

function settleRow(label, tickets, race) {
  if (!tickets.length) return `<tr><td>${esc(label)}</td><td class="num">0</td><td class="num">—</td><td class="num">—</td><td class="num">—</td></tr>`;
  const s = settle(race, tickets);
  const profit = s.ret - s.stake;
  const hitText = s.hits.length ? s.hits.map((h) => `${BET_LABEL[h.type]} ${ticketLabel(h)}`).join('、') : '不的中';
  return `<tr class="${s.hits.length ? 'is-hit' : ''}">
    <td>${esc(label)}<small class="settle-hit">${esc(hitText)}</small></td>
    <td class="num">${tickets.length}</td>
    <td class="num">${s.stake.toLocaleString('ja-JP')}</td>
    <td class="num">${s.ret.toLocaleString('ja-JP')}</td>
    <td class="num ${profit >= 0 ? 'tx-good' : 'tx-bad'}">${profit >= 0 ? '+' : ''}${profit.toLocaleString('ja-JP')}</td>
  </tr>`;
}

/** 答え合わせの分析：外れ方の型（惜しい外れ・波乱・AI の見落とし）、勝ち馬の良かった点と◎の不安点（レース前のデータ）、AI推奨 */
function reviewBlock(pred, rec, race) {
  const r = reviewRace(pred, race);
  if (!r) return '';
  const jockeys = race.jockeys && Object.keys(race.jockeys).length ? race.jockeys : REAL_STATS.jockeyRates;
  const byNum = new Map(pred.rows.map((x) => [x.entry.number, x]));
  const w = byNum.get(r.winner.number);
  const h = byNum.get(r.honmei.number);
  const notes = [];
  if (r.kind !== 'hit' && w) {
    const pros = horseComment(w, pred, jockeys).pros;
    if (pros.length) notes.push(`<li><b>勝ち馬の良かった点</b>：${esc(pros.join('・'))}</li>`);
  }
  if (r.kind !== 'hit' && h) {
    const cons = horseComment(h, pred, jockeys).cons;
    if (cons.length) notes.push(`<li><b>◎の不安点</b>：${esc(cons.join('・'))}</li>`);
  }
  let betLine = '';
  if (rec?.tickets?.length) {
    const s = settle(race, rec.tickets);
    const exp = rec.stats?.hitRate;
    betLine = s.hits.length
      ? `<p class="rv-bet tx-good">AI推奨は的中（${esc(s.hits.map((x) => `${BET_LABEL[x.type]} ${ticketLabel(x)}`).join('、'))}）。どれかが当たる確率は ${exp != null ? `${Math.round(exp * 100)}%` : '—'} でした。</p>`
      : `<p class="rv-bet tx-bad">AI推奨（${rec.tickets.length}点）は外れ。どれかが当たる確率は ${exp != null ? `${Math.round(exp * 100)}%` : '—'} で、${exp != null && exp > 0 && exp < 1 ? `約${Math.max(2, Math.round(1 / (1 - exp)))}回に1回は起きる外れです。` : ''}</p>`;
  }
  return `<div class="review rv-${r.kind}">
    <div class="rv-head"><span class="rv-badge">${esc(MISS_KINDS[r.kind].label)}</span>${MISS_KINDS[r.kind].desc ? `<small>${esc(MISS_KINDS[r.kind].desc)}</small>` : ''}</div>
    <p>${esc(reviewText(r))}</p>
    ${notes.length ? `<ul class="rv-notes">${notes.join('')}</ul>` : ''}
    ${betLine}
  </div>`;
}

export function renderResultPanel(pred, rec, ctx) {
  const race = pred.race;
  const byNum = new Map(pred.rows.map((r) => [r.entry.number, r]));
  const entryBy = new Map(race.entries.map((e) => [e.number, e]));
  const rows = [...(race.resultRows || [])].sort((a, b) => (a.finish || 99) - (b.finish || 99) || a.number - b.number);
  const honmei = pred.order?.[0];
  const hFin = honmei ? race.finishes?.[honmei.entry.number] : null;
  const head = honmei
    ? `<span class="panel-sub">◎ ${esc(honmei.entry.number)}番 ${esc(honmei.entry.name)} は <b class="${hFin === 1 ? 'tx-good' : ''}">${typeof hFin === 'number' && hFin > 0 ? `${hFin}着` : esc(hFin || '—')}</b></span>`
    : '';
  const body = rows
    .map((r) => {
      const e = entryBy.get(r.number) || {};
      const p = byNum.get(r.number);
      const fin = r.finish > 0 ? r.finish : r.status || '—';
      return `<tr class="${r.finish === 1 ? 'is-win' : r.finish > 0 && r.finish <= 3 ? 'is-top3' : ''}">
        <td class="num res-fin">${esc(fin)}</td>
        <td>${frameBadge(e.frame, r.number, 'sm')}</td>
        <td class="res-name">${esc(e.name || '')}</td>
        <td class="c-mark">${p?.mark ? `<span class="mark ${markClass(p.mark)}">${esc(p.mark)}</span>` : ''}</td>
        <td class="num">${r.time ? esc(formatTime(r.time)) : ''}</td>
        <td class="num">${esc(r.marginText || '')}</td>
        <td class="num">${r.last3f ? esc(r.last3f.toFixed(1)) : ''}</td>
        <td class="num">${r.popularity ? `${esc(r.popularity)}人` : ''}</td>
        <td class="num">${odds(r.odds ?? e.odds)}</td>
        <td class="num">${p ? `${(p.pWin * 100).toFixed(1)}%` : ''}</td>
      </tr>`;
    })
    .join('');

  // 答え合わせ（実際の払戻）
  const settleRows = [];
  if (rec) settleRows.push(settleRow(`AI推奨（${ctx.strategyLabel}・${yen(rec.tickets.reduce((a, t) => a + t.stake, 0))}）`, rec.tickets, race));
  for (const f of evaluateFormations(pred, ctx.state.blend)) settleRows.push(settleRow(f.label, f.tickets, race));

  return `<section class="panel result-panel" id="panel-result" aria-labelledby="h-result">
    <header class="panel-head"><h2 id="h-result">レース結果</h2><span class="status-badge sb-result">確定</span>${head}</header>
    ${reviewBlock(pred, rec, race)}
    <div class="table-scroll"><table class="res-table">
      <thead><tr><th>着</th><th>馬番</th><th>馬名</th><th>印</th><th>タイム</th><th>着差</th><th>上り</th><th>人気</th><th>単勝</th><th title="レース前のAIの勝率">AI勝率</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    <div class="result-cols">
      <div>
        <h3 class="panel-h3">払戻 <small>100円あたり</small></h3>
        ${payoutTable(race)}
      </div>
      <div>
        <h3 class="panel-h3">予想の答え合わせ <small>実際の払戻で精算</small></h3>
        <div class="table-scroll"><table class="bets settle-table">
          <thead><tr><th>買い方</th><th>点数</th><th>購入</th><th>払戻</th><th>収支</th></tr></thead>
          <tbody>${settleRows.join('')}</tbody>
        </table></div>
        <p class="panel-note">印から組む買い方は1点100円。予想は発走前に手に入る情報（出馬表・前4走・最終オッズ）だけで計算し、今の重み付けと買い方の設定で精算しています。</p>
      </div>
    </div>
  </section>`;
}
