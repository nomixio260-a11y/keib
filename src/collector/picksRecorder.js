// 発走前の買い目の記録（Race day の取り込みのたびに呼ぶ）：画面と同じ計算（標準の設定）で、まだ発走していないレースの買い目を
// picks/YYYY-MM-DD.json に足す。発走1分前を過ぎたレースは書き換えない（src/engine/picks.js）。
// 1日の予算は発走順に先着なので、すでに発走したレースは記録した買い目の金額を先に使い、残りをこれからのレースに割り振る。

import path from 'node:path';
import { readJson, writeJson } from './store.js';
import { predictRace, PRESETS, DEFAULT_PRESET, DEFAULT_WEIGHTS, DEFAULT_NOISE } from '../engine/model.js';
import { recommendBets, planDay, DEFAULT_STRATEGY, DEFAULT_TYPES } from '../engine/bets.js';
import { REAL_STATS } from '../engine/realStats.js';
import { pickEntry, mergePicks, FREEZE_MS } from '../engine/picks.js';
import { startMs } from '../engine/raceTime.js';

export const PICK_SETTINGS = { budget: 1000, strategy: DEFAULT_STRATEGY, types: DEFAULT_TYPES, dayBudget: 'auto', preset: DEFAULT_PRESET };

/** 画面の currentStats と同じ：実データの統計に、バンドルの最近の開催日の馬場差を足したもの */
function bundleStats(bundle) {
  const extra = bundle?.dayVariant;
  return extra && Object.keys(extra).length ? { ...REAL_STATS, dayVariant: { ...(REAL_STATS.dayVariant || {}), ...extra } } : REAL_STATS;
}

/** 1日分：記録に足す買い目（{ raceId: pickEntry }）を計算する */
export function dayPicks(races, doc, { now = Date.now(), stats = REAL_STATS, budget = PICK_SETTINGS.budget } = {}) {
  const items = [];
  for (const race of races) {
    if (race.jump || race.surface === '障' || race.provisional || race.status === 'registration' || race.result?.length) continue;
    const st = startMs(race);
    if (!st) continue;
    const open = now < st - FREEZE_MS;
    const recorded = doc?.races?.[race.id]?.last || null;
    if (!open && !recorded) continue;
    const pred = predictRace(race, { weights: DEFAULT_WEIGHTS, noise: DEFAULT_NOISE, sims: 0, stats, ml: !!PRESETS[DEFAULT_PRESET]?.ml, mlAi: !!PRESETS[DEFAULT_PRESET]?.mlAi });
    if (pred.empty) continue;
    let rec = recommendBets(pred, { budget, strategy: PICK_SETTINGS.strategy, types: PICK_SETTINGS.types, blend: 'auto', keep: 'auto' });
    if (!open) {
      // 発走済み（記録あり）：記録した金額で1日の予算を使う
      const byNum = new Map(pred.rows.map((r, i) => [r.entry.number, i]));
      const tickets = recorded.tickets
        .map((t) => ({ type: t.type, idx: t.nums.map((n) => byNum.get(n) ?? -1), stake: t.stake, odds: t.odds, oddsExp: t.odds, pHit: t.p, p: t.p }))
        .filter((t) => t.idx.every((i) => i >= 0));
      rec = { ...rec, auto: true, tickets };
    }
    items.push({ race, pred, rec, open });
  }
  const planned = planDay(
    items.map((it) => ({ pred: it.pred, rec: it.rec })),
    { budget, dayBudget: PICK_SETTINGS.dayBudget },
  );
  const entries = {};
  items.forEach((it, k) => {
    if (!it.open) return;
    const rec = planned[k];
    // オッズの発売前・複勝のオッズ待ち（発走2時間前より前）は、まだ決めていないので記録しない
    if (rec?.noOdds) return;
    const placeWaiting = !rec?.tickets?.length && /複勝の実際のオッズ/.test(rec?.skipReason || '');
    if (placeWaiting) return;
    entries[it.race.id] = pickEntry(it.pred, rec, { at: new Date(now).toISOString(), oddsAt: it.race.oddsAt || null });
  });
  return entries;
}

/** バンドルのこれからのレース（24時間以内に発走）の買い目を記録する。返り値：書き換えたレースの数 */
export async function recordPicks(bundle, dir, { now = Date.now(), log = () => {} } = {}) {
  const stats = bundleStats(bundle);
  let total = 0;
  const dates = new Set();
  for (const day of bundle.days || []) {
    const upcoming = day.races.some((r) => {
      const st = startMs(r);
      return st && now < st - FREEZE_MS && st - now < 24 * 3600 * 1000 && !r.result?.length;
    });
    if (!upcoming) continue;
    const file = path.join(dir, `${day.date}.json`);
    const doc = await readJson(file);
    const entries = dayPicks(day.races, doc, { now, stats });
    const byId = new Map(day.races.map((r) => [r.id, r]));
    const { doc: next, changed } = mergePicks(doc, day.date, entries, { now, startOf: (id) => startMs(byId.get(id)), settings: { budget: PICK_SETTINGS.budget, strategy: PICK_SETTINGS.strategy, dayBudget: PICK_SETTINGS.dayBudget, preset: PICK_SETTINGS.preset } });
    if (changed) {
      await writeJson(file, next);
      total += changed;
      dates.add(day.date);
    }
  }
  // 一覧（画面が読む）
  if (dates.size) {
    const idxFile = path.join(dir, 'index.json');
    const idx = (await readJson(idxFile)) || { days: [] };
    const set = new Set([...(idx.days || []), ...dates]);
    await writeJson(idxFile, { days: [...set].sort(), updatedAt: new Date(now).toISOString() });
  }
  if (total) log(`発走前の買い目を記録：${total}レース（${[...dates].join('・')}）`);
  return total;
}
