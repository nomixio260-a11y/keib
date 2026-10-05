// 設定の効果：レースごとの精算（投資・払戻）を日ごとにまとめ、収支・回収率・負けた日・最悪の日などを出す。
// 設定画面で「いまの設定」「標準」「変更前」を同じ物差しで比べるのに使う。

/**
 * rows … レースごとの精算 [{ date, stake, pay, hit }]（買わなかったレースは stake 0）
 * 返り値：日ごとの集計（日付順）と全体の集計
 */
export function summarizeDays(rows) {
  const byDate = new Map();
  for (const r of rows) {
    const d = byDate.get(r.date) || { date: r.date, races: 0, bets: 0, hits: 0, stake: 0, pay: 0 };
    d.races++;
    if (r.stake > 0) {
      d.bets++;
      d.stake += r.stake;
      d.pay += r.pay || 0;
      if (r.hit) d.hits++;
    }
    byDate.set(r.date, d);
  }
  const days = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).map((d) => ({ ...d, profit: d.pay - d.stake }));
  const betDays = days.filter((d) => d.bets > 0);
  const stake = days.reduce((a, d) => a + d.stake, 0);
  const pay = days.reduce((a, d) => a + d.pay, 0);
  const profits = betDays.map((d) => d.profit);
  return {
    days,
    races: days.reduce((a, d) => a + d.races, 0),
    bets: days.reduce((a, d) => a + d.bets, 0),
    hitRaces: days.reduce((a, d) => a + d.hits, 0),
    stake,
    pay,
    profit: pay - stake,
    roi: stake ? pay / stake : null,
    dayCount: days.length,
    betDays: betDays.length,
    loseDays: betDays.filter((d) => d.profit < 0).length,
    noWinDays: betDays.filter((d) => d.hits === 0).length,
    worst: profits.length ? Math.min(...profits) : null,
    best: profits.length ? Math.max(...profits) : null,
  };
}

/** 2つの集計の差（b − a）。どちらかがなければ null */
export function effectDelta(a, b) {
  if (!a || !b) return null;
  return {
    profit: b.profit - a.profit,
    roi: a.roi != null && b.roi != null ? b.roi - a.roi : null,
    hitRaces: b.hitRaces - a.hitRaces,
    bets: b.bets - a.bets,
    loseDays: b.loseDays - a.loseDays,
    worst: a.worst != null && b.worst != null ? b.worst - a.worst : null,
  };
}
