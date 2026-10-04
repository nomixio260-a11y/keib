#!/usr/bin/env node
// 過去の開催日のアーカイブ（開催日ごとのファイルと index.json）を、手元のデータベース（data/history）から作る。
//
//   node scripts/build-archive.mjs [--from 2026-07-01] [--to 2026-10-03] [--out data/days]
//
// 1日分のバンドル（出馬表・結果・払戻・確定オッズ・各馬の「そのレースより前」の通算要約）を <out>/<日付>.json に、一覧を <out>/index.json に書く。
// 学習に使った期間（TEST_START より前）の日は、いまのモデルで計算し直すと実際より良く見えるので、既定は TEST_START（2026-07-01）以降だけ。
// GitHub Actions（race-day.yml）は data ブランチの days/ に、結果の出そろった日を自動で書き足す。

import path from 'node:path';
import { emptyBundle, addPastDaysFromHistory, compactBundle, jstParts } from '../src/collector/bundle.js';
import { loadHistory, attachFinalExoticOdds, DATA_DIR } from '../src/collector/store.js';
import { indexHistory, attachCareer } from '../src/data/history.js';
import { REAL_STATS } from '../src/engine/realStats.js';
import { writeArchiveDay, rebuildArchiveIndex } from '../src/collector/archive.js';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const today = jstParts().date;
const from = opt('from', process.env.TEST_START || '2026-07-01');
const to = opt('to', today);
const out = path.resolve(opt('out', path.join(DATA_DIR, 'days')));

const records = await loadHistory();
const index = indexHistory(records);
const dates = [...new Set(records.map((r) => r.date))].filter((d) => d >= from && d <= to && d < today).sort();
log(`${dates.length}開催日（${dates[0] || '—'}〜${dates.at(-1) || '—'}）を ${out} に書きます`);
let written = 0;
for (const date of dates) {
  const b = emptyBundle();
  addPastDaysFromHistory(b, records, index, [date]);
  const races = b.days.flatMap((d) => d.races);
  const exotic = await attachFinalExoticOdds(races);
  attachCareer(races, index, { stats: REAL_STATS });
  compactBundle(b);
  const day = b.days[0];
  if (!day) continue;
  if (await writeArchiveDay(out, day)) written++;
  log(`  ${date} ${day.venues.join('・')} ${day.races.length}R（別の投票市場のオッズ ${exotic}R）`);
}
const idx = await rebuildArchiveIndex(out);
log(`書き出し ${written}日・一覧 ${idx.days.length}日（${out}/index.json）`);
