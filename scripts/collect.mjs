#!/usr/bin/env node
// JRA公式サイトから実際のレースデータを集める。
//
//   node scripts/collect.mjs week                       … 今週の出馬表（前4走・単勝オッズ）と直近の結果
//   node scripts/collect.mjs history 2025-10 2026-09     … 指定期間の全レース結果と最終オッズ（学習・検証用）
//
// 取得間隔は既定で1.2秒（KEIB_INTERVAL_MS で変更可）。変わらないページは data/cache にキャッシュする。
// 集めたデータは個人の分析用です。JRA・各サイトの利用規約に従い、不特定多数への再配布はしないでください。

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJraClient } from '../src/collector/client.js';
import {
  listCardMeetings,
  listRecentResultMeetings,
  listMonthMeetings,
  listRaces,
  fetchCard,
  fetchResult,
  fetchOdds,
  cardToRace,
  resultToRecord,
} from '../src/collector/collect.js';
import { raceKeyFromCname } from '../src/collector/jra.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.KEIB_DATA_DIR || path.join(root, 'data');
const interval = Number(process.env.KEIB_INTERVAL_MS || 1200);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const client = createJraClient({ minIntervalMs: interval, cacheDir: path.join(DATA, 'cache'), log });

const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
const todayYm = () => jstNow().toISOString().slice(0, 7);

function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data));
}

/** 開催1日分の全レース（結果＋最終オッズ）を保存。保存済みは飛ばす */
async function collectMeetingResults(meeting) {
  const dir = path.join(DATA, 'history', meeting.date.slice(0, 4));
  const races = await listRaces(client, meeting);
  let saved = 0;
  for (const link of races) {
    const file = path.join(dir, `${link.raceId}.json`);
    if (existsSync(file) || !link.resultCname) continue;
    try {
      const result = await fetchResult(client, link.resultCname);
      if (!result.rows.length) continue;
      const odds = link.oddsCname ? await fetchOdds(client, link.oddsCname, { final: true }) : null;
      await writeJson(file, resultToRecord(result, odds, raceKeyFromCname(link.resultCname)));
      saved++;
    } catch (e) {
      log(`  失敗 ${link.raceId}: ${e.message}`);
    }
  }
  return saved;
}

async function history(from, to) {
  const months = monthsBetween(from, to).reverse();
  const recent = await listRecentResultMeetings(client);
  const recentDates = new Set(recent.map((m) => m.date));
  for (const ym of months) {
    let meetings = await listMonthMeetings(client, ym, todayYm());
    // 払戻期間内の月は「レース結果」一覧のほうに載っている
    const fromRecent = recent.filter((m) => m.date.startsWith(ym));
    const seen = new Set(meetings.map((m) => m.cname));
    for (const m of fromRecent) if (!seen.has(m.cname)) meetings.push(m);
    meetings = meetings.filter((m) => m.date.slice(0, 7) === ym);
    log(`${ym}: ${meetings.length}開催日`);
    for (const meeting of meetings.sort((a, b) => (a.date < b.date ? 1 : -1))) {
      const n = await collectMeetingResults(meeting);
      log(`  ${meeting.date} ${meeting.course}${meeting.kai}回${meeting.day}日 保存${n}  (通信${client.stats().requests} / キャッシュ${client.stats().cacheHits})`);
    }
    if (!recentDates.size) continue;
  }
}

/** 今週の出馬表と直近の結果を data/live に保存 */
async function week() {
  const meetings = await listCardMeetings(client);
  const byDate = {};
  for (const meeting of meetings) {
    const races = await listRaces(client, meeting, { live: true });
    for (const link of races) {
      if (!link.cardCname) continue;
      try {
        const card = await fetchCard(client, link.cardCname);
        const race = cardToRace(card, raceKeyFromCname(link.cardCname));
        race.fetchedAt = new Date().toISOString();
        (byDate[race.date] ||= []).push(race);
      } catch (e) {
        log(`  出馬表の取得に失敗 ${link.raceId}: ${e.message}`);
      }
    }
    log(`${meeting.date} ${meeting.course}: ${races.length}レース`);
  }
  for (const [date, races] of Object.entries(byDate)) {
    await writeJson(path.join(DATA, 'live', `${date}.json`), races.sort((a, b) => a.course.localeCompare(b.course) || a.raceNo - b.raceNo));
  }
  log('完了', client.stats());
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'history') await history(a || '2025-10', b || todayYm());
else if (cmd === 'week') await week();
else {
  console.log('使い方: node scripts/collect.mjs week | history <YYYY-MM> <YYYY-MM>');
  process.exit(1);
}
