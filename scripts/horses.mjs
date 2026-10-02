#!/usr/bin/env node
// 馬ごとの通算要約（機械学習の特徴量 cStarts などに使う）を data/history から作り、src/data/horses.json に書き出す。
//   node scripts/horses.mjs
// サーバーもデータベースもない環境（GitHub Pages）でも、この要約で予想できる。収集し直したら作り直す。

import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { loadHistory, ROOT } from '../src/collector/store.js';
import { indexHistory, runFromRecord } from '../src/data/history.js';
import { careerSnapshot } from '../src/engine/features.js';

const all = await loadHistory();
const index = indexHistory(all);
const out = {};
for (const [horseId, hist] of index.byHorse) {
  const c = careerSnapshot(hist.map((h) => runFromRecord(h.rec, h.runner)));
  if (!c) continue;
  out[horseId] = [c.starts, c.wins, c.top3, c.siBest, c.siMean, c.posMean, c.bestClass, index.ratings.current.get(horseId) ?? null];
}
const file = path.join(ROOT, 'src/data/horses.json');
await writeFile(file, JSON.stringify({ asOf: all[all.length - 1]?.date, fields: ['starts', 'wins', 'top3', 'siBest', 'siMean', 'posMean', 'bestClass', 'elo'], horses: out }));
console.log(`書き出し：src/data/horses.json（${Object.keys(out).length}頭、${all[all.length - 1]?.date} 時点）`);
