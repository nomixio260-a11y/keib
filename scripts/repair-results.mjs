#!/usr/bin/env node
// 途中までしか入っていない結果の記録（速報の上位だけ・頭数が足りない）を見つけて、結果を取り直して上書きする。
//
//   node scripts/repair-results.mjs                 … data/history を確定オッズ（data/odds-final）の頭数と比べて、足りない記録を取り直す
//   node scripts/repair-results.mjs --dry           … 見つけるだけ
//   node scripts/repair-results.mjs --history out/history --exotic out/odds-final   … data ブランチの作業コピーを直す（Race day ワークフロー）
//
// 2026-10-04 の京都 4・6・8・9R は、速報の上位5頭だけが記録され、検証では「上位5頭の中から当てる」形になっていた（三連複の的中が
// 実際にはありえない形で数えられていた）。取得の間隔は 1.2秒（KEIB_INTERVAL_MS）。直す記録の数 × 2ページだけ取る。

import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createJraClient } from '../src/collector/client.js';
import { listRecentResultMeetings, listMonthMeetings, listRaces, fetchResult, fetchOdds, resultToRecord, recordCoverage } from '../src/collector/collect.js';
import { raceKeyFromCname } from '../src/collector/jra.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.KEIB_DATA_DIR || path.join(root, 'data');
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : def;
};
const HISTORY = arg('--history', path.join(DATA, 'history'));
const EXOTIC = arg('--exotic', path.join(DATA, 'odds-final'));
const DRY = process.argv.includes('--dry');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** 確定オッズ（馬連の組み合わせ）に出てくる馬番の数＝取消・除外を除いた出走頭数 */
async function runnersFromExotic(rec) {
  const file = path.join(EXOTIC, rec.date.slice(0, 4), `${rec.id}.json`);
  if (!existsSync(file)) return null;
  try {
    const doc = JSON.parse(await readFile(file, 'utf8'));
    const nums = new Set();
    for (const k of Object.keys(doc.quinella || {})) for (const x of k.split('-')) nums.add(Number(x));
    return nums.size || null;
  } catch {
    return null;
  }
}

const partial = [];
for (const y of (await readdir(HISTORY).catch(() => [])).sort()) {
  for (const f of await readdir(path.join(HISTORY, y)).catch(() => [])) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(HISTORY, y, f);
    const rec = JSON.parse(await readFile(file, 'utf8'));
    if (rec.jump) continue;
    const expected = Math.max((await runnersFromExotic(rec)) || 0, rec.expectedRunners || 0);
    const cov = recordCoverage(rec, expected);
    if (!cov.complete) partial.push({ rec, file, expected, have: cov.have });
  }
}
log(`途中までの記録：${partial.length}件`, partial.map((p) => `${p.rec.id}（${p.have}/${p.expected}頭）`).join(' '));
if (DRY || !partial.length) process.exit(0);

const client = createJraClient({ minIntervalMs: Number(process.env.KEIB_INTERVAL_MS || 1200), cacheDir: path.join(DATA, 'cache'), log });
const todayYm = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7);
// 開催の一覧：直近の結果のページ → なければ月の結果のページ
const meetingsByDate = new Map();
for (const m of await listRecentResultMeetings(client)) (meetingsByDate.get(m.date) || meetingsByDate.set(m.date, []).get(m.date)).push(m);
let fixed = 0;
for (const p of partial) {
  let meetings = meetingsByDate.get(p.rec.date);
  if (!meetings) {
    const ms = await listMonthMeetings(client, p.rec.date.slice(0, 7), todayYm);
    for (const m of ms) (meetingsByDate.get(m.date) || meetingsByDate.set(m.date, []).get(m.date)).push(m);
    meetings = meetingsByDate.get(p.rec.date) || [];
  }
  let done = false;
  for (const m of meetings) {
    const links = await listRaces(client, m, { live: true });
    const link = links.find((l) => l.raceId === p.rec.id);
    if (!link?.resultCname) continue;
    // キャッシュを使わずに取り直す（途中の版がキャッシュに残っていることがある）
    const result = await fetchResult(client, link.resultCname, { live: true, refresh: true });
    const odds = link.oddsCname ? await fetchOdds(client, link.oddsCname, { ttlMs: 0 }) : null;
    const record = resultToRecord(result, odds, raceKeyFromCname(link.resultCname));
    const cov = recordCoverage(record, p.expected);
    if (!cov.complete) {
      log(`まだ途中までです ${p.rec.id}（${cov.have}/${p.expected}頭）`);
      done = true;
      break;
    }
    await writeFile(p.file, JSON.stringify(record));
    fixed++;
    log(`直しました ${p.rec.id}：${p.have} → ${cov.have}頭`);
    done = true;
    break;
  }
  if (!done) log(`結果のページが見つかりません ${p.rec.id}`);
}
log(`直した記録 ${fixed}/${partial.length}（通信 ${client.stats().requests}回）`);
