// 騎手・厩舎などの成績表（出走・勝利・3着内）と、少数の出走を全体の平均に寄せた率（事前分布つき）。
// 学習（scripts/dataset.mjs：その日より前の分だけを順に足す）と、統計（scripts/calibrate.mjs）で同じ計算を使う。

/** 成績表に1頭分を足す */
export function tally(table, key, runner) {
  if (!key) return;
  const a = (table[key] ||= { starts: 0, wins: 0, top3: 0 });
  a.starts++;
  if (runner.finish === 1) a.wins++;
  if (runner.finish > 0 && runner.finish <= 3) a.top3++;
}

/** 成績表 → { rates: { key: { starts, winRate, top3Rate } }, average }。prior 出走分だけ全体の平均に寄せる */
export function rates(table, prior = 60) {
  let s = 0;
  let w = 0;
  let t = 0;
  for (const a of Object.values(table)) {
    s += a.starts;
    w += a.wins;
    t += a.top3;
  }
  const w0 = s ? w / s : 0.07;
  const t0 = s ? t / s : 0.21;
  const out = {};
  for (const [k, a] of Object.entries(table)) out[k] = { starts: a.starts, winRate: (a.wins + prior * w0) / (a.starts + prior), top3Rate: (a.top3 + prior * t0) / (a.starts + prior) };
  return { rates: out, average: { winRate: w0, top3Rate: t0 } };
}

/** 条件つきの成績表のキー：騎手×競馬場、厩舎×芝ダ、騎手×厩舎 */
export const CONDITION_KEYS = {
  jockeyCourse: (rec, r) => (r.jockey && rec.course ? `${r.jockey}|${rec.course}` : null),
  trainerSurface: (rec, r) => (r.trainer && rec.surface ? `${r.trainer}|${rec.surface}` : null),
  pair: (rec, r) => (r.jockey && r.trainer ? `${r.jockey}|${r.trainer}` : null),
  // 血統（馬ページから集めた父・母の父が runner に付いているとき。scripts/collect-horses.mjs）
  sireSurface: (rec, r) => (r.sire && rec.surface ? `${r.sire}|${rec.surface}` : null),
  damSireSurface: (rec, r) => (r.damSire && rec.surface ? `${r.damSire}|${rec.surface}` : null),
};

/** 記録の配列から条件つきの率をまとめて作る（統計用。出走 minStarts 未満は省く） */
export function conditionRates(records, { minStarts = 5, prior = 60, horseInfo = null } = {}) {
  const tables = Object.fromEntries(Object.keys(CONDITION_KEYS).map((k) => [k, {}]));
  for (const rec of records) {
    if (rec.jump || rec.surface === '障') continue;
    for (const r0 of rec.runners) {
      if (!(r0.finish > 0 || r0.status === '中止')) continue;
      const info = horseInfo?.get?.(r0.horseId);
      const r = info ? { ...r0, sire: info.sire, damSire: info.damSire } : r0;
      for (const [k, keyOf] of Object.entries(CONDITION_KEYS)) tally(tables[k], keyOf(rec, r), r);
    }
  }
  const round3 = (v) => Math.round(v * 1000) / 1000;
  const out = {};
  for (const [k, table] of Object.entries(tables)) {
    const { rates: rt } = rates(table, prior);
    out[k] = Object.fromEntries(
      Object.entries(rt)
        .filter(([, v]) => v.starts >= minStarts)
        .map(([key, v]) => [key, { starts: v.starts, winRate: round3(v.winRate), top3Rate: round3(v.top3Rate) }]),
    );
  }
  return out;
}
