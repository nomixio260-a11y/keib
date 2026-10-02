#!/usr/bin/env node
// アプリが読む実データ一式（data/bundle.json）を作る。架空のデータは一切使わない。
//
//   node scripts/build-data.mjs                      … 過去の開催日（data/history）＋今週の出馬表・オッズ・結果（JRA）
//   node scripts/build-data.mjs --offline            … JRAに接続せず、手元のデータだけで作る
//   node scripts/build-data.mjs --previous old.json  … 前回のバンドルを引き継ぐ（data/history がない環境用）
//   オプション：--past 4（過去の開催日の数） --out data/bundle.json --copy-dist（dist/data.json にもコピー）
//
// 集めたデータは個人の分析用です。不特定多数が見られる場所には置かないでください。

import path from 'node:path';
import { copyFile, mkdir } from 'node:fs/promises';
import { createJraClient } from '../src/collector/client.js';
import { emptyBundle, addPastDaysFromHistory, mergeBundle, refreshLive, pruneBundle, attachDayVariants, compactBundle, jstParts } from '../src/collector/bundle.js';
import { REAL_STATS } from '../src/engine/realStats.js';
import { loadHistory, saveRecord, readJson, writeJson, BUNDLE_FILE, CACHE_DIR, ROOT } from '../src/collector/store.js';
import { indexHistory } from '../src/data/history.js';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const keepPast = Number(opt('past', 4));
const out = path.resolve(opt('out', BUNDLE_FILE));
const today = jstParts().date;

const bundle = emptyBundle();

// 1) 収集済みの過去の結果から、直近の開催日
const records = await loadHistory();
if (records.length) {
  const dates = [...new Set(records.filter((r) => r.date < today).map((r) => r.date))].sort().slice(-keepPast);
  addPastDaysFromHistory(bundle, records, indexHistory(records), dates);
  log(`過去の開催日：${dates.join(', ') || 'なし'}（data/history ${records.length}レースから）`);
}

// 2) 前回のバンドル
const prevPath = opt('previous', null);
if (prevPath) {
  const prev = await readJson(path.resolve(prevPath));
  if (prev) {
    mergeBundle(bundle, prev);
    log(`前回のバンドルを引き継ぎ：${prev.days?.length ?? 0}日分（${prev.generatedAt ?? '日時不明'}）`);
  } else log(`前回のバンドルを読めませんでした：${prevPath}`);
}

// 3) JRA の今週の出馬表・オッズと、発走後のレースの結果
if (!flag('offline')) {
  const client = createJraClient({ minIntervalMs: Number(process.env.KEIB_INTERVAL_MS || 1200), cacheDir: flag('no-cache') ? null : CACHE_DIR, log });
  const { cards, results } = await refreshLive(client, bundle, {
    log,
    onRecord: records.length ? (rec) => saveRecord(rec) : null,
  });
  log(`JRA：出馬表 ${cards}件・結果 ${results}件（通信 ${client.stats().requests}回）`);
} else bundle.generatedAt = new Date().toISOString();

pruneBundle(bundle, { keepPast, today });
attachDayVariants(bundle, records, REAL_STATS, { today });
compactBundle(bundle);
await writeJson(out, bundle);
const races = bundle.days.reduce((a, d) => a + d.races.length, 0);
log(`書き出しました：${path.relative(ROOT, out)}（${bundle.days.length}日・${races}レース）`);
for (const d of bundle.days) log(`  ${d.date} ${d.venues.join('・')} ${d.races.length}R（結果 ${d.races.filter((r) => r.status === 'result').length}）`);

if (flag('copy-dist')) {
  await mkdir(path.join(ROOT, 'dist'), { recursive: true });
  await copyFile(out, path.join(ROOT, 'dist/data.json'));
  log('dist/data.json にコピーしました');
}
