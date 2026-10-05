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
//             --picks <dir>（発走前の買い目の記録。発走1分前を過ぎたレースは書き換えない）
//             --history <dir>（結果の記録を読む場所。既定は data/history。GitHub Actions では data ブランチの history/）
//             --exotic <dir>（馬連・ワイド・三連複・馬単の確定オッズの置き場。既定は data/odds-final。確定したレースのライブのオッズもここに残す）
//             --days-dir <dir>（過去の開催日のアーカイブ。結果の出そろった日を <dir>/<日付>.json に書き、直近の期間に足りない日はここから補う）
//             --past-days 14（data.json に入れる過去の期間。日数。少なくとも --past の開催日数は入れる）
//             --registrations（特別登録＝来週の特別レースの登録馬から、出馬表が出る前の暫定のレースを入れる。出馬表が出たら消える）
//             --history-keep-days 400（--history の置き場から、この日数より古い結果の記録を消す。data ブランチが大きくなりすぎないように）
//             --near <path>（発走の近いレース：今日のまだ確定していないレースで発走30分前〜発走15分後のものだけの小さなファイル。
//                           画面は構成の署名が同じなら data.json を読み直さずにこれで差し替える）
//
// 集めたデータは個人の分析用です。不特定多数が見られる場所には置かないでください。

import path from 'node:path';
import { copyFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createJraClient } from '../src/collector/client.js';
import { emptyBundle, addPastDaysFromHistory, mergeBundle, refreshLive, pruneBundle, attachDayVariants, compactBundle, jstParts, startMs, upsertRace, sortBundle, nextRefreshSec, bundleSig, nearFile } from '../src/collector/bundle.js';
import { listRegistrations, fetchRegistrations, registrationToRace, addProvisionalRaces, removeProvisionalRaces } from '../src/collector/registrations.js';
import { listCardMeetings } from '../src/collector/collect.js';
import { REAL_STATS } from '../src/engine/realStats.js';
import { loadHistory, saveRecord, appendOddsSnapshot, attachFinalExoticOdds, loadHorseSnapshots, readJson, writeJson, BUNDLE_FILE, CACHE_DIR, FINAL_ODDS_DIR, ROOT } from '../src/collector/store.js';
import { indexHistory, attachCareer } from '../src/data/history.js';
import { writeArchiveDay, rebuildArchiveIndex, archiveDates, readArchiveDay } from '../src/collector/archive.js';
import { recordPicks } from '../src/collector/picksRecorder.js';

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
let historyIndex = null;
const getIndex = () => historyIndex || (historyIndex = indexHistory(records));
if (records.length) {
  const pastDates = [...new Set(records.filter((r) => r.date < today).map((r) => r.date))].sort();
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - keepPastDays * 86400000).toISOString().slice(0, 10);
  const dates = pastDates.filter((d, i) => d >= cutoff || i >= pastDates.length - keepPast);
  addPastDaysFromHistory(bundle, records, getIndex(), dates);
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

// 暫定のレース（特別登録）は毎回作り直す。取得に失敗したときのために前回の分を取っておく
const prevProvisional = removeProvisionalRaces(bundle);
let regList = null;

// 3) JRA の今週の出馬表・オッズと、発走後のレースの結果
let client = null;
if (!flag('offline')) {
  client = createJraClient({ minIntervalMs: Number(process.env.KEIB_INTERVAL_MS || 1200), cacheDir: flag('no-cache') ? null : CACHE_DIR, log });
  if (flag('registrations')) {
    try {
      regList = await listRegistrations(client);
    } catch (e) {
      log(`特別登録の一覧を読めませんでした：${e.message}`);
    }
  }
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
    // 新しい特別登録（前回の暫定のレースにも出馬表にもないレース）
    const knownIds = new Set([...races.map((r) => r.id), ...prevProvisional.map((r) => r.id)]);
    const newRegs = (regList || []).filter((x) => x.date >= today && !knownIds.has(x.raceId)).length;
    if (!racingToday && !pending && !newDates && !soon && !newRegs) {
      log('IDLE：今日は開催がなく、結果待ちのレース・24時間以内のレース・新しい出馬表・新しい特別登録もありません。更新しません。');
      console.log('NEXT=3600');
      process.exit(0);
    }
    log(`更新します（今日の開催 ${racingToday ? 'あり' : 'なし'}・結果待ち ${pending}・24時間以内 ${soon}・新しい開催日 ${newDates}・新しい特別登録 ${newRegs}）`);
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
// 特別登録から、出馬表が出る前の暫定のレース（来週の特別レース）。出馬表が出たレース・開催日には入れない
{
  let provisional = null;
  if (client && flag('registrations')) {
    try {
      // 出馬表の出たレース・開催日の分は取りにいかない（開催中も一覧に残っているため）
      const realIds = new Set(bundle.days.flatMap((d) => d.races.map((r) => r.id)));
      const realDates = new Set(bundle.days.filter((d) => d.races.length).map((d) => d.date));
      const list = (regList || (await listRegistrations(client))).filter((x) => x.date >= today && !realIds.has(x.raceId) && !realDates.has(x.date));
      const regs = list.length ? await fetchRegistrations(client, { log, list }) : [];
      const recById = new Map(records.map((r) => [r.id, r]));
      provisional = regs.map((r) => registrationToRace(r, { index: records.length ? getIndex() : null, recById }));
    } catch (e) {
      log(`特別登録の取得に失敗：${e.message}`);
    }
  }
  // 取得できなかったとき（provisional が null）は前回の分を使う。取得できて0件なら（出馬表が出そろった）入れない
  const use = (provisional ?? prevProvisional).filter((r) => r.date >= today);
  const n = addProvisionalRaces(bundle, use, { upsert: upsertRace });
  sortBundle(bundle);
  if (use.length) log(`特別登録（出馬表の前の暫定のレース）：${n}レース${provisional ? '' : '（前回の分を引き継ぎ）'}`);
}
pruneBundle(bundle, { keepPast, keepPastDays, today });
attachDayVariants(bundle, records, REAL_STATS, { today });
// 機械学習の特徴量に使う馬ごとの通算要約。手元のデータベース（data/history、全期間）があればそのレースより前の出走から、
// なければ src/data/horses.json。--history で別の置き場（GitHub Actions の data ブランチの history/。直近1年ほど）を読むときは、
// 通算の要約にならない（古い出走が欠ける）ので horses.json を使う
{
  const snaps = await loadHorseSnapshots();
  const fullHistory = !opt('history', null);
  const index = fullHistory && records.length >= 1000 ? getIndex() : null;
  const n = attachCareer(bundle.days.flatMap((d) => d.races), index, { stats: REAL_STATS, fallback: snaps.get, fallbackAsOf: snaps.asOf, keepExisting: true });
  log(`通算要約を付けた馬：${n}（${index ? 'データベース' : `horses.json ${snaps.asOf || '—'} 時点`}）`);
}
compactBundle(bundle);
// 発走前の買い目の記録（--picks <dir>）：まだ発走していないレースの標準の設定の買い目を picks/YYYY-MM-DD.json に足す
// （発走1分前を過ぎたレースは書き換えない。画面が実際の払戻で精算して「ごまかしのない成績」として見せる）
if (opt('picks', null)) {
  try {
    await recordPicks(bundle, path.resolve(opt('picks', null)), { log });
  } catch (e) {
    log(`買い目の記録に失敗：${e.message}`);
  }
}
// 構成の署名（画面が near.json だけで差し替えてよいかを決める）
bundle.sig = bundleSig(bundle);
await writeJson(out, bundle);
// 発走の近いレース（--near <path>）：画面は data.json（数MB）を読み直さずに、これ（数十KB）で発走前のオッズを新しくする
if (opt('near', null)) {
  const near = nearFile(bundle, { today });
  await writeJson(path.resolve(opt('near', null)), near);
  log(`発走の近いレース：${near.races.length}レース（near.json）`);
}
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
// 古い結果の記録を消す（--history の置き場。直近の開催日と、特別登録の馬の前4走に使う分だけ残す）
if (opt('history-keep-days', null) && opt('history', null)) {
  const keepDays = Number(opt('history-keep-days', 400));
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - keepDays * 86400000).toISOString().slice(0, 10);
  const dir = path.resolve(opt('history', null));
  let removed = 0;
  for (const rec of records) {
    if (rec.date >= cutoff) continue;
    await unlink(path.join(dir, rec.date.slice(0, 4), `${rec.id}.json`)).then(() => removed++, () => {});
  }
  if (removed) log(`古い結果の記録を消しました：${removed}件（${cutoff} より前）`);
}
const races = bundle.days.reduce((a, d) => a + d.races.length, 0);
log(`書き出しました：${path.relative(ROOT, out)}（${bundle.days.length}日・${races}レース）`);
for (const d of bundle.days) log(`  ${d.date} ${d.venues.join('・')} ${d.races.length}R（結果 ${d.races.filter((r) => r.status === 'result').length}${d.races.some((r) => r.provisional) ? `・特別登録の暫定 ${d.races.filter((r) => r.provisional).length}` : ''}）`);
console.log(`NEXT=${nextRefreshSec(bundle, { today })}`);

if (flag('copy-dist')) {
  await mkdir(path.join(ROOT, 'dist'), { recursive: true });
  await copyFile(out, path.join(ROOT, 'dist/data.json'));
  log('dist/data.json にコピーしました');
}
