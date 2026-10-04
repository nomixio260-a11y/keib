#!/usr/bin/env node
// コース（競馬場・芝ダ・距離）ごとの過去の傾向を、学習期間のレース結果から集計して src/engine/courseStats.js に書く。
// レース画面の「レース分析」の「このコースの傾向」に使う（1番人気の勝率・複勝率、人気3頭以外が勝った割合、単勝の平均配当、
// 勝ち馬の脚質・枠）。検証期間（TEST_START 以降）の結果は使わない。
//
//   node scripts/course-stats.mjs        （npm run course-stats）

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadHistory, ROOT } from '../src/collector/store.js';
import { usable } from './calibrate.mjs';

const TEST_START = process.env.TEST_START || '2026-07-01';
const MIN_RACES = Number(process.env.MIN_RACES || 20);
const STYLES = ['逃げ', '先行', '差し', '追込'];

/** 最初のコーナーの位置から脚質（逃げ・先行・差し・追込） */
function styleOf(runner, fieldSize) {
  const p = runner.passing?.[0];
  if (!(p > 0) || !(fieldSize > 1)) return null;
  if (p === 1) return '逃げ';
  const frac = (p - 1) / (fieldSize - 1);
  return frac <= 0.33 ? '先行' : frac <= 0.66 ? '差し' : '追込';
}

const records = (await loadHistory()).filter((r) => r.date < TEST_START && usable(r) && !r.jump && r.surface !== '障');
const acc = new Map();
for (const rec of records) {
  const runners = rec.runners.filter((r) => r.finish > 0);
  const n = runners.length;
  if (n < 5) continue;
  const key = `${rec.course}|${rec.surface}|${rec.distance}`;
  const a =
    acc.get(key) ||
    acc.set(key, { n: 0, favWin: 0, favTop3: 0, popTop3Win: 0, pays: [], style: Object.fromEntries(STYLES.map((s) => [s, [0, 0]])), styleKnown: 0, innerWin: 0, innerRunners: 0, runners: 0, frameKnown: 0 }).get(key);
  const winner = runners.find((r) => r.finish === 1);
  if (!winner) continue;
  a.n++;
  const fav = runners.find((r) => r.popularity === 1);
  if (fav?.finish === 1) a.favWin++;
  if (fav && fav.finish <= 3) a.favTop3++;
  if (winner.popularity > 0 && winner.popularity <= 3) a.popTop3Win++;
  const pay = rec.payouts?.win?.[String(winner.number)];
  if (pay > 0) a.pays.push(pay);
  // 脚質：勝ち馬と全出走馬（勝率 = その脚質の勝ち ÷ その脚質の出走）
  const ws = styleOf(winner, n);
  if (ws) {
    a.styleKnown++;
    for (const r of runners) {
      const s = styleOf(r, n);
      if (s) a.style[s][1]++;
    }
    a.style[ws][0]++;
  }
  // 枠：内枠（1〜4枠）の勝ちの割合と、出走の割合
  if (winner.frame > 0) {
    a.frameKnown++;
    if (winner.frame <= 4) a.innerWin++;
    for (const r of runners) {
      if (!(r.frame > 0)) continue;
      a.runners++;
      if (r.frame <= 4) a.innerRunners++;
    }
  }
}

const r3 = (v) => Math.round(v * 1000) / 1000;
const out = {};
for (const [key, a] of [...acc].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
  if (a.n < MIN_RACES) continue;
  const pays = [...a.pays].sort((x, y) => x - y);
  out[key] = {
    n: a.n,
    favWin: r3(a.favWin / a.n),
    favTop3: r3(a.favTop3 / a.n),
    upset: r3(1 - a.popTop3Win / a.n),
    avgWinPay: Math.round(pays.reduce((s, v) => s + v, 0) / Math.max(1, pays.length)),
    medWinPay: pays.length ? pays[Math.floor(pays.length / 2)] : null,
    // 脚質ごと：勝ち馬に占める割合と勝率
    style: a.styleKnown >= MIN_RACES ? Object.fromEntries(STYLES.map((s) => [s, { share: r3(a.style[s][0] / a.styleKnown), win: r3(a.style[s][0] / Math.max(1, a.style[s][1])) }])) : null,
    // 内枠（1〜4枠）：勝ち馬に占める割合と、出走に占める割合
    inner: a.frameKnown >= MIN_RACES ? { win: r3(a.innerWin / a.frameKnown), runners: r3(a.innerRunners / Math.max(1, a.runners)) } : null,
  };
}
const period = records.length ? `${records[0].date}〜${records[records.length - 1].date}` : '';
const doc = { period, races: records.length, minRaces: MIN_RACES, courses: out };
const file = path.join(ROOT, 'src/engine/courseStats.js');
await writeFile(
  file,
  `// scripts/course-stats.mjs がレース結果（学習期間）から作る。手で編集しないでください。\nexport const COURSE_STATS = ${JSON.stringify(doc)};\n`,
);
console.log(`書き出しました：src/engine/courseStats.js（${Object.keys(out).length}コース・${records.length}レース、${period}）`);
