// 発走前の買い目の記録：Race day（GitHub Actions）が取り込みのたびに、まだ発走していないレースの「標準の設定」
// （1R 1,000円・的中重視の自動・1日の予算 7倍）の買い目を data ブランチの picks/YYYY-MM-DD.json に記録する。
//
//  - first … そのレースで最初に記録した買い目（複勝のオッズが出る発走2時間前ごろ）
//  - last  … 発走の1分前までに最後に記録した買い目（画面がその時点で出していたもの）
//  発走1分前を過ぎたレースの記録は書き換えない。画面は記録した買い目を実際の払戻で精算して見せる。
//  検証（過去のレース）は確定オッズや後から作った統計で選び直せてしまうが、この記録はレースの前に決まっていたものなので、ごまかしようがない。

import { payoutKey } from './backtest.js';

export const PICKS_VERSION = 1;
/** 発走の何ミリ秒前から記録を書き換えないか */
export const FREEZE_MS = 60 * 1000;

const round = (v, d) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/** 予想（pred）と推奨（rec：planDay のあと）から、記録に残す形（at：記録した時刻、oddsAt：オッズの時刻） */
export function pickEntry(pred, rec, { at, oddsAt = null } = {}) {
  const tickets = (rec?.tickets || [])
    .filter((t) => t.stake > 0)
    .map((t) => ({ type: t.type, nums: t.idx.map((i) => pred.rows[i].entry.number), stake: t.stake, odds: round(t.odds, 2), p: round(t.pHit ?? t.p, 3) }));
  const skip = tickets.length ? null : rec?.noOdds ? 'オッズの発売前' : rec?.skipReason || '見送り';
  return { at, oddsAt, tickets, used: tickets.reduce((s, t) => s + t.stake, 0), skip };
}

const sameTickets = (a, b) => JSON.stringify(a?.tickets || []) === JSON.stringify(b?.tickets || []) && (a?.skip || null) === (b?.skip || null);

/**
 * 記録に足す（発走1分前を過ぎたレースは触らない）。
 *   doc … これまでの記録（なければ null）、entries … { raceId: pickEntry }、startOf(raceId) … 発走時刻（ミリ秒）
 * 返り値 { doc, changed }（changed：書き換えたレースの数）
 */
export function mergePicks(doc, date, entries, { now = Date.now(), startOf, settings = null } = {}) {
  const out = doc && doc.date === date ? { ...doc, races: { ...(doc.races || {}) } } : { version: PICKS_VERSION, date, settings, races: {} };
  if (settings && !out.settings) out.settings = settings;
  let changed = 0;
  for (const [id, e] of Object.entries(entries)) {
    const st = startOf(id);
    if (!(st > 0) || now >= st - FREEZE_MS) continue;
    const cur = { ...(out.races[id] || {}) };
    let touched = false;
    if (!cur.first) {
      cur.first = e;
      touched = true;
    }
    if (!cur.last || !sameTickets(cur.last, e)) {
      cur.last = e;
      touched = true;
    }
    cur.start = new Date(st).toISOString();
    if (touched) {
      out.races[id] = cur;
      changed++;
    }
  }
  return { doc: out, changed };
}

/** 記録した買い目を実際の払戻で精算（結果がまだなら null） */
export function settlePick(race, entry) {
  if (!entry || !race?.result?.length || !race.payouts) return null;
  let stake = 0;
  let pay = 0;
  let hits = 0;
  for (const t of entry.tickets || []) {
    const ret = ((race.payouts?.[t.type]?.[payoutKey(t.type, t.nums)] ?? 0) * t.stake) / 100;
    stake += t.stake;
    pay += ret;
    if (ret > 0) hits++;
  }
  return { stake, pay, hits };
}

/**
 * 記録の成績：docs … picks の記録の配列、raceById(id) … 結果つきのレース、which … 'last' | 'first'
 * 返り値：日ごとと全体（買ったレース・的中したレース・投資・払戻）
 */
export function summarizePicks(docs, raceById, which = 'last') {
  const days = [];
  for (const doc of docs || []) {
    if (!doc?.races) continue;
    const d = { date: doc.date, recorded: 0, settled: 0, bets: 0, hits: 0, stake: 0, pay: 0 };
    for (const [id, r] of Object.entries(doc.races)) {
      const entry = r[which];
      if (!entry) continue;
      d.recorded++;
      const s = settlePick(raceById(id), entry);
      if (!s) continue;
      d.settled++;
      if (s.stake > 0) {
        d.bets++;
        d.stake += s.stake;
        d.pay += s.pay;
        if (s.hits) d.hits++;
      }
    }
    if (d.recorded) days.push({ ...d, profit: d.pay - d.stake });
  }
  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const sum = (k) => days.reduce((s, d) => s + d[k], 0);
  const stake = sum('stake');
  const pay = sum('pay');
  const betDays = days.filter((d) => d.bets > 0);
  return {
    days,
    recorded: sum('recorded'),
    settled: sum('settled'),
    bets: sum('bets'),
    hits: sum('hits'),
    stake,
    pay,
    profit: pay - stake,
    roi: stake ? pay / stake : null,
    hitRate: sum('bets') ? sum('hits') / sum('bets') : null,
    betDays: betDays.length,
    loseDays: betDays.filter((d) => d.profit < 0).length,
  };
}
