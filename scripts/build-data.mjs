#!/usr/bin/env node
// アプリが読む実データ一式（data/bundle.json）を作る。架空のデータは一切使わない。
//
//   node scripts/build-data.mjs                      … 過去の開催日（data/history）＋今週の出馬表・オッズ・結果（JRA）
//   node scripts/build-data.mjs --offline            … JRAに接続せず、手元のデータだけで作る
//   node scripts/build-data.mjs --previous old.json  … 前回のバンドルを引き継ぐ（data/history がない環境用。URL も可）
//   node scripts/build-data.mjs --skip-if-idle       … 今日が開催日でなく、結果待ちも新しい出馬表もなければ「IDLE」と出して何もしない
//                                                     （自動更新のルーティンを祝日の月曜などにも動かすため）
//   最後に「NEXT=秒」を出す：次の取り込みまでの目安（発走が近いと 300、前日発売中は 1200、それ以外は 3600。Race day ワークフローが読む）
//   オプション：--past 4（過去の開催日の数） --out data/bundle.json --copy-dist（dist/data.json にもコピー）
//             --snapshots <dir>（オッズの推移を保存。データベースがない GitHub Actions 用） --records <dir>（結果の記録を保存）
//             --history <dir>（結果の記録を読む場所。既定は data/history。GitHub Actions では data ブランチの history/）
//             --exotic <dir>（馬連・ワイド・三連複・馬単の確定オッズの置き場。既定は data/odds-final。確定したレースのライブのオッズもここに残す）
//             --days-dir <dir>（過去の開催日のアーカイブ。結果の出そろった日を <dir>/<日付>.json に書き、直近の期間に足りない日はここから補う）
//             --past-days 14（data.json に入れる過去の期間。日数。少なくとも --past の開催日数は入れる）
//
// 集めたデータは個人の分析用です。不特定多数が見られる場所には置かないでください。

import path from 'node:path';
import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createJraClient } from '../src/collector/client.js';
import { emptyBundle, addPastDaysFromHistory, mergeBundle, refreshLive, pruneBundle, attachDayVariants, compactBundle, jstParts, startMs } from '../src/collector/bundle.js';
import { listCardMeetings } from '../src/collector/collect.js';
import { REAL_STATS } from '../src/engine/realStats.js';
import { loadHistory, saveRecord, appendOddsSnapshot, attachFinalExoticOdds, loadHorseSnapshots, readJson, writeJson, BUNDLE_FILE, CACHE_DIR, FINAL_ODDS_DIR, ROOT } from '../src/collector/store.js';
import { indexHistory, attachCareer } from '../src/data/history.js';
import { writeArchiveDay, rebuildArchiveIndex, archiveDates, readArchiveDay } from '../src/collector/archive.js';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const keepPast = Number(opt('past', 4));
const keepPastDays = Number(opt('past-days', 14));
const daysDir = opt('days-dir', null) ? path.resolve(opt('days-dir', null)) : null;
const exoticDir = opt('exotic', null) ? path.resolve(opt('exotic', null)) : undefined;
const out = path.resolve(opt('out', BUNDLE_FILE));
const today = jstParts().date;

const bundle = emptyBundle();

// 1) 収集済みの過去の結果から、直近の開催日
const records = await loadHistory(opt('history', null) ? path.resolve(opt('history', null)) : undefined);
if (records.length) {
  const pastDates = [...new Set(records.filter((r) => r.date < today).map((r) => r.date))].sort();
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - keepPastDays * 86400000).toISOString().slice(0, 10);
  const dates = pastDates.filter((d, i) => d >= cutoff || i >= pastDates.length - keepPast);
  addPastDaysFromHistory(bundle, records, indexHistory(records), dates);
  const n = await attachFinalExoticOdds(bundle.days.flatMap((d) => d.races), exoticDir);
  log(`過去の開催日：${dates.join(', ') || 'なし'}（data/history ${records.length}レースから。確定オッズあり ${n}レース）`);
}

// 2) 前回のバンドル（ファイルか URL。GitHub Pages で公開中の data.json を引き継ぐときは URL）
const prevPath = opt('previous', null);
if (prevPath) {
  const prev = /^https?:/.test(prevPath)
    ? await fetch(prevPath, { signal: AbortSignal.timeout(30000) })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
    : await readJson(path.resolve(prevPath));
  if (prev) {
    mergeBundle(bundle, prev);
    log(`前回のバンドルを引き継ぎ：${prev.days?.length ?? 0}日分（${prev.generatedAt ?? '日時不明'}）`);
  } else log(`前回のバンドルを読めませんでした：${prevPath}`);
}

// 3) JRA の今週の出馬表・オッズと、発走後のレースの結果
if (!flag('offline')) {
  const client = createJraClient({ minIntervalMs: Number(process.env.KEIB_INTERVAL_MS || 1200), cacheDir: flag('no-cache') ? null : CACHE_DIR, log });
  if (flag('skip-if-idle')) {
    // 今日の開催がなく、発走済みで結果待ちのレースもなく、出馬表の開催日がすべて取り込み済みなら何もしない
    const meetings = await listCardMeetings(client);
    const known = new Set(bundle.days.map((d) => d.date));
    const now = Date.now();
    const races = bundle.days.flatMap((d) => d.races);
    const pending = races.filter((r) => r.status !== 'result' && startMs(r) && startMs(r) < now).length;
    // 24時間以内に発走するレース（前日発売のオッズが動く）
    const soon = races.filter((r) => r.status !== 'result' && startMs(r) && startMs(r) > now && startMs(r) - now < 24 * 3600 * 1000).length;
    const racingToday = meetings.some((m) => m.date === today);
    const newDates = meetings.filter((m) => !known.has(m.date)).length;
    if (!racingToday && !pending && !newDates && !soon) {
      log('IDLE：今日は開催がなく、結果待ちのレース・24時間以内のレース・新しい出馬表もありません。更新しません。');
      console.log('NEXT=3600');
      process.exit(0);
    }
    log(`更新します（今日の開催 ${racingToday ? 'あり' : 'なし'}・結果待ち ${pending}・24時間以内 ${soon}・新しい開催日 ${newDates}）`);
  }
  const snapDir = opt('snapshots', null);
  const recDir = opt('records', null);
  const { cards, results } = await refreshLive(client, bundle, {
    log,
    onRecord: recDir ? (rec) => saveRecord(rec, path.resolve(recDir)) : records.length ? (rec) => saveRecord(rec) : null,
    onOdds: snapDir ? (race) => appendOddsSnapshot(race, path.resolve(snapDir)) : records.length ? (race) => appendOddsSnapshot(race) : null,
  });
  log(`JRA：出馬表 ${cards}件・結果 ${results}件（通信 ${client.stats().requests}回）`);
} else bundle.generatedAt = new Date().toISOString();

// 確定したレースの最後に取れた馬連・ワイド・三連複・馬単のオッズを残す（機械学習の特徴量に使う。公式の確定オッズは scripts/collect-exotic.mjs が後で上書き）
{
  let saved = 0;
  for (const race of bundle.days.flatMap((d) => d.races)) {
    if (race.status !== 'result' || !race.exoticOdds || !race.date) continue;
    const file = path.join(exoticDir || FINAL_ODDS_DIR, race.date.slice(0, 4), `${race.id}.json`);
    if (existsSync(file)) continue;
    await writeJson(file, { id: race.id, date: race.date, course: race.course, raceNo: race.raceNo, source: 'live', ...race.exoticOdds });
    saved++;
  }
  if (saved) log(`確定レースのオッズ（馬連・ワイド・三連複・馬単）を保存：${saved}レース`);
}
// 当日のレースにも、確定オッズの保存があれば付ける（データベースのない環境で past days を作り直したとき用）
await attachFinalExoticOdds(bundle.days.flatMap((d) => d.races).filter((r) => !r.exoticOdds), exoticDir);
// アーカイブ：直近の期間の過去の開催日は、アーカイブ（結果の出そろった日。各馬の通算要約もそのレースより前で計算済み）を使う
if (daysDir) {
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - keepPastDays * 86400000).toISOString().slice(0, 10);
  const have = await archiveDates(daysDir);
  let used = 0;
  for (const date of [...have].filter((d) => d >= cutoff && d < today)) {
    const day = await readArchiveDay(daysDir, date);
    if (!day?.races?.length) continue;
    bundle.days = bundle.days.filter((d) => d.date !== date);
    mergeBundle(bundle, { days: [day] });
    used++;
  }
  if (used) log(`アーカイブから過去の開催日を補いました：${used}日`);
}
pruneBundle(bundle, { keepPast, keepPastDays, today });
attachDayVariants(bundle, records, REAL_STATS, { today });
// 機械学習の特徴量に使う馬ごとの通算要約。データベースがあればそのレースより前の出走から、なければ src/data/horses.json
// （記録が少ないとき＝GitHub Actions の data ブランチの history/ だけのときは、通算の要約にならないので horses.json を使う）
{
  const snaps = await loadHorseSnapshots();
  const index = records.length >= 1000 ? indexHistory(records) : null;
  const n = attachCareer(bundle.days.flatMap((d) => d.races), index, { stats: REAL_STATS, fallback: snaps.get, fallbackAsOf: snaps.asOf, keepExisting: true });
  log(`通算要約を付けた馬：${n}（${index ? 'データベース' : `horses.json ${snaps.asOf || '—'} 時点`}）`);
}
compactBundle(bundle);
await writeJson(out, bundle);
// 結果の出そろった日をアーカイブに書く（変わっていなければ書かない）
if (daysDir) {
  let wrote = 0;
  for (const day of bundle.days) {
    if (day.date > today || !day.races.length || !day.races.every((r) => r.status === 'result')) continue;
    if (await writeArchiveDay(daysDir, day)) wrote++;
  }
  const idx = await rebuildArchiveIndex(daysDir);
  log(`アーカイブ：書き足し ${wrote}日・一覧 ${idx.days.length}日`);
}
const races = bundle.days.reduce((a, d) => a + d.races.length, 0);
log(`書き出しました：${path.relative(ROOT, out)}（${bundle.days.length}日・${races}レース）`);
for (const d of bundle.days) log(`  ${d.date} ${d.venues.join('・')} ${d.races.length}R（結果 ${d.races.filter((r) => r.status === 'result').length}）`);
console.log(`NEXT=${nextInterval(bundle)}`);

/** 次の取り込みまでの目安（秒）。今日の未確定レースの発走 90分前〜結果待ちは 300、それ以外の開催日と前日発売中は 1200、深夜（JST 0〜7時）と開催のない日は 3600 */
function nextInterval(b, now = Date.now()) {
  const all = b.days.flatMap((d) => d.races);
  const jstHour = new Date(now + 9 * 3600 * 1000).getUTCHours();
  if (jstHour < 7) return 3600;
  const pendingToday = all.filter((r) => r.date === today && r.status !== 'result');
  if (pendingToday.length) {
    const first = Math.min(...pendingToday.map((r) => startMs(r) || Infinity));
    return !Number.isFinite(first) || first - now < 90 * 60 * 1000 ? 300 : 1200;
  }
  const soon = all.some((r) => r.status !== 'result' && startMs(r) && startMs(r) > now && startMs(r) - now < 24 * 3600 * 1000);
  return soon ? 1200 : 3600;
}

if (flag('copy-dist')) {
  await mkdir(path.join(ROOT, 'dist'), { recursive: true });
  await copyFile(out, path.join(ROOT, 'dist/data.json'));
  log('dist/data.json にコピーしました');
}
