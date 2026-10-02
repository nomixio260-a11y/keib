// バックテスト：結果のわかっている過去レースで予想と買い方を検証する。

import { predictRace } from './model.js';
import { recommendBets, marksToIndex, ticketLabel } from './bets.js';

/** 払戻表のキー（馬番で表す） */
export function payoutKey(type, nums) {
  switch (type) {
    case 'win':
    case 'place':
      return String(nums[0]);
    case 'quinella':
    case 'wide':
    case 'trio':
      return [...nums].sort((a, b) => a - b).join('-');
    case 'exacta':
    case 'trifecta':
      return nums.join('>');
    default:
      return '';
  }
}

/** 100円あたりの払戻（外れは 0） */
export function payoutOf(race, type, nums) {
  return race.payouts?.[type]?.[payoutKey(type, nums)] ?? 0;
}

const nums = (pred, idx) => idx.map((i) => pred.rows[i].entry.number);

export const BT_STRATEGIES = [
  { key: 'win', label: '単勝 ◎', build: (pred, m) => [{ type: 'win', idx: [m['◎']], stake: 100 }] },
  { key: 'place', label: '複勝 ◎', build: (pred, m) => (pred.placeCount ? [{ type: 'place', idx: [m['◎']], stake: 100 }] : []) },
  { key: 'quinella', label: '馬連 ◎-○', build: (pred, m) => (m['○'] >= 0 ? [{ type: 'quinella', idx: [m['◎'], m['○']], stake: 100 }] : []) },
  {
    key: 'wide',
    label: 'ワイド ◎-○▲',
    build: (pred, m) => (pred.n >= 8 ? [m['○'], m['▲']].filter((v) => v >= 0).map((o) => ({ type: 'wide', idx: [m['◎'], o], stake: 100 })) : []),
  },
  {
    key: 'trio',
    label: '三連複 ◎軸 相手4頭',
    build: (pred, m) => {
      const others = [m['○'], m['▲'], ...m['△']].filter((v) => v >= 0);
      const out = [];
      for (let i = 0; i < others.length; i++)
        for (let j = i + 1; j < others.length; j++) out.push({ type: 'trio', idx: [m['◎'], others[i], others[j]], stake: 100 });
      return out;
    },
  },
  {
    key: 'value',
    label: '単勝 期待値1.2以上',
    build: (pred) =>
      pred.rows
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => r.ev != null && r.ev >= 1.2 && r.pWin >= 0.05)
        .map(({ i }) => ({ type: 'win', idx: [i], stake: 100 })),
  },
  {
    key: 'ai',
    label: 'AI推奨（バランス・1R千円）',
    build: (pred, m, settings) => recommendBets(pred, { budget: 1000, strategy: 'balance', blend: settings?.blend }).tickets,
  },
  {
    key: 'fav',
    label: '1番人気の単勝（比較用）',
    baseline: true,
    build: (pred) => {
      let best = -1;
      pred.rows.forEach((r, i) => {
        if (r.odds && (best < 0 || r.odds < pred.rows[best].odds)) best = i;
      });
      return best >= 0 ? [{ type: 'win', idx: [best], stake: 100 }] : [];
    },
  },
];

const CAL_EDGES = [0, 0.03, 0.06, 0.1, 0.15, 0.2, 0.3, 0.45, 1.01];

function emptyCal() {
  return CAL_EDGES.slice(0, -1).map((lo, k) => ({ lo, hi: CAL_EDGES[k + 1], n: 0, sumP: 0, wins: 0 }));
}

function addCal(cal, p, won) {
  const k = cal.findIndex((b) => p >= b.lo && p < b.hi);
  if (k < 0) return;
  cal[k].n++;
  cal[k].sumP += p;
  if (won) cal[k].wins++;
}

/**
 * レースごとに予想 → 買い目 → 払戻で精算する。
 * UIを止めないよう、数レースごとに処理を譲る（onProgress で進捗を通知）。
 */
export async function runBacktest(races, settings = {}, { onProgress, sims = 3000, yieldEvery = 8 } = {}) {
  const acc = Object.fromEntries(
    BT_STRATEGIES.map((s) => [s.key, { key: s.key, label: s.label, baseline: !!s.baseline, races: 0, bets: 0, hits: 0, stake: 0, ret: 0, maxPay: 0, curve: [] }]),
  );
  const ai = { n: 0, win: 0, top2: 0, top3: 0, logLoss: 0 };
  const fav = { n: 0, win: 0, top2: 0, top3: 0, logLoss: 0 };
  const calAi = emptyCal();
  const calMkt = emptyCal();
  const log = [];

  for (let ri = 0; ri < races.length; ri++) {
    const race = races[ri];
    const pred = predictRace(race, { ...settings, sims });
    if (pred.empty || !race.result?.length) continue;
    const finishOf = new Map(race.result.map((num, k) => [num, k + 1]));
    const m = marksToIndex(pred);
    const honmei = pred.rows[m['◎']];
    const favRow = [...pred.rows].filter((r) => r.odds).sort((a, b) => a.odds - b.odds)[0];
    const winnerRow = pred.rows.find((r) => r.entry.number === race.result[0]);

    const tally = (o, row, prob) => {
      if (!row) return;
      const f = finishOf.get(row.entry.number) ?? 99;
      o.n++;
      if (f === 1) o.win++;
      if (f <= 2) o.top2++;
      if (f <= 3) o.top3++;
      o.logLoss += -Math.log(Math.max(1e-4, prob));
    };
    tally(ai, honmei, winnerRow?.pWin ?? 1e-4);
    tally(fav, favRow, winnerRow?.marketProb ?? 1e-4);
    for (const r of pred.rows) {
      const won = r.entry.number === race.result[0];
      addCal(calAi, r.pWin, won);
      addCal(calMkt, r.marketProb, won);
    }

    const raceLog = { id: race.id, label: `${race.course}${race.raceNo}R ${race.name}`, honmei: honmei?.entry.number, finish: finishOf.get(honmei?.entry.number) ?? null, profit: {} };
    for (const s of BT_STRATEGIES) {
      const a = acc[s.key];
      const tickets = s.build(pred, m, settings).filter((t) => t.idx.every((i) => i >= 0) && t.stake > 0);
      let stake = 0;
      let ret = 0;
      for (const t of tickets) {
        stake += t.stake;
        const pay = payoutOf(race, t.type, nums(pred, t.idx));
        if (pay > 0) {
          const back = (t.stake / 100) * pay;
          ret += back;
          a.hits++;
          if (back > a.maxPay) a.maxPay = back;
        }
      }
      if (tickets.length) a.races++;
      a.bets += tickets.length;
      a.stake += stake;
      a.ret += ret;
      a.curve.push(a.ret - a.stake);
      raceLog.profit[s.key] = ret - stake;
      if (s.key === 'ai') raceLog.aiTickets = tickets.map((t) => `${t.type}:${ticketLabel({ ...t, nums: nums(pred, t.idx) })}`);
    }
    log.push(raceLog);

    if (onProgress && ri % yieldEvery === yieldEvery - 1) {
      onProgress((ri + 1) / races.length);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  onProgress?.(1);

  const strategies = BT_STRATEGIES.map((s) => {
    const a = acc[s.key];
    return { ...a, hitRate: a.bets ? a.hits / a.bets : 0, roi: a.stake ? a.ret / a.stake : 0, profit: a.ret - a.stake };
  });
  const rate = (o) => ({ ...o, winRate: o.n ? o.win / o.n : 0, top2Rate: o.n ? o.top2 / o.n : 0, top3Rate: o.n ? o.top3 / o.n : 0, logLoss: o.n ? o.logLoss / o.n : 0 });
  return { races: log.length, strategies, ai: rate(ai), fav: rate(fav), calibration: { ai: calAi, market: calMkt }, log };
}
