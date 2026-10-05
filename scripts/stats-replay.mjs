#!/usr/bin/env node
// 過去の開催日を画面で再現する（成績・設定の効果・アーカイブ）ときに使う統計を、検証の開始日より前のレースだけで作る。
//
//   node scripts/stats-replay.mjs        … src/engine/replayStats.js（環境変数 TEST_START=2026-07-01）
//
// realStats.js（全期間の統計）の騎手・厩舎の成績と枠順の傾向には、再現する日そのものの結果も入っている
// （その日に勝った騎手の勝率が上がった状態で、その日のレースを予想することになる）。
// 検証（evaluate.mjs）と同じく、TEST_START より前のレースだけで作ったものを、realStats.js の期間内の日の再現に使う。

import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadHistory, statsForEngine } from './calibrate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_START = process.env.TEST_START || '2026-07-01';
const all = await loadHistory();
const s = statsForEngine(all.filter((r) => r.date < TEST_START), all);
const out = {
  asOf: TEST_START,
  from: s.from,
  to: s.to,
  races: s.races,
  jockeyRates: s.jockeyRates,
  jockeyAverage: s.jockeyAverage,
  trainerRates: s.trainerRates,
  trainerAverage: s.trainerAverage,
  draw: s.draw,
};
const header = '// scripts/stats-replay.mjs が実際のレース結果（JRA）から生成。手で編集しないでください。\n';
await writeFile(path.join(root, 'src/engine/replayStats.js'), `${header}export const REPLAY_STATS = ${JSON.stringify(out)};\n`);
console.log(`書き出しました：src/engine/replayStats.js（${s.from}〜${s.to}・${s.races}レース。騎手 ${Object.keys(s.jockeyRates).length}人・厩舎 ${Object.keys(s.trainerRates).length}）`);
