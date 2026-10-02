// スピード指数（走破タイムを基準タイムと比べて数値化）
//
//   指数 = 80 + 1000 × (基準タイム − 走破タイム) ÷ 基準タイム + 2 × (斤量 − 55)
//
// 基準タイムは実際のレース結果から、競馬場×芝ダート×距離ごとに「2勝クラス・良馬場の勝ち時計」相当として推定し、
// 馬場状態の補正と、開催日ごとの馬場差（その日の勝ち時計のずれ）を加える（src/engine/realStats.js）。
// 80 が2勝クラスの勝ち馬の水準。

import { REAL_STATS } from './realStats.js';
import { COURSES } from './constants.js';

// 統計がない条件のための式: a × (距離/1200)^b
const FORMULA = {
  芝: { a: 69.0, b: 1.0765 },
  ダ: { a: 71.8, b: 1.1076 },
};

// 統計がないときの馬場補正（1000mあたりの秒）
const GOING_DEFAULT = {
  芝: { 良: 0, 稍重: 0.4, 重: 1.0, 不良: 1.8 },
  ダ: { 良: 0, 稍重: -0.25, 重: -0.5, 不良: -0.6 },
};

const L3F_DEFAULT = { 芝: 34.9, ダ: 37.6 };

const indexCache = new WeakMap();
/** コース×芝ダごとの [距離, 基準タイム] 一覧 */
function distanceIndex(stats, table) {
  let byStats = indexCache.get(stats);
  if (!byStats) indexCache.set(stats, (byStats = {}));
  if (byStats[table]) return byStats[table];
  const idx = new Map();
  for (const [k, v] of Object.entries(stats?.[table] || {})) {
    const [course, surface, d] = k.split('|');
    const key = `${course}|${surface}`;
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push([Number(d), Array.isArray(v) ? v[0] : v]);
  }
  byStats[table] = idx;
  return idx;
}

function nearest(stats, table, course, surface, distance, maxGap = 400) {
  const list = distanceIndex(stats, table).get(`${course}|${surface}`);
  if (!list) return null;
  let best = null;
  for (const [d, t] of list) if (!best || Math.abs(d - distance) < Math.abs(best[0] - distance)) best = [d, t];
  return best && Math.abs(best[0] - distance) <= maxGap ? { d: best[0], t: best[1] } : null;
}

export function goingAdjust(surface, going, stats = REAL_STATS) {
  return stats?.goingAdj?.[`${surface}|${going}`] ?? GOING_DEFAULT[surface]?.[going] ?? 0;
}

/** 基準タイム（秒）。障害レースは null */
export function baseTime(surface, distance, going = '良', course = null, stats = REAL_STATS) {
  if (!(distance > 0) || (surface !== '芝' && surface !== 'ダ')) return null;
  const k = distance / 1000;
  const g = goingAdjust(surface, going || '良', stats) * k;
  const exact = stats?.baseTimes?.[`${course}|${surface}|${distance}`];
  if (exact) return exact[0] + g;
  const f = stats?.formula?.[surface] || FORMULA[surface];
  const near = course ? nearest(stats, 'baseTimes', course, surface, distance) : null;
  if (near) return near.t * Math.pow(distance / near.d, f.b) + g;
  return f.a * Math.pow(distance / 1200, f.b) + g;
}

/** 上がり3Fの基準（その条件の中央値） */
export function last3fBase(course, surface, distance, stats = REAL_STATS) {
  const exact = stats?.last3f?.[`${course}|${surface}|${distance}`];
  if (exact) return exact;
  const near = nearest(stats, 'last3f', course, surface, distance, 600);
  if (near) return near.t;
  return L3F_DEFAULT[surface] ?? null;
}

/** 過去走1走分のスピード指数。タイムがない・障害・JRA以外の競馬場なら null */
export function speedFigure(run, stats = REAL_STATS) {
  if (!run || !(run.time > 0) || !(run.distance > 0)) return null;
  // 地方・海外の競馬場は馬場が違い、JRAの基準タイムとは比べられない
  if (run.course && !COURSES[run.course]) return null;
  let base = baseTime(run.surface, run.distance, run.going, run.course, stats);
  if (!base) return null;
  // その日の馬場差（実データから推定）。わからない日は馬場状態の補正だけ
  const variant = stats?.dayVariant?.[`${run.date}|${run.course}|${run.surface}`];
  if (variant) base += (variant * run.distance) / 1000;
  const weight = run.weight > 0 ? run.weight : 55;
  return 80 + (1000 * (base - run.time)) / base + 2 * (weight - 55);
}
