#!/usr/bin/env node
// 過去のレースの確定オッズ（馬連・ワイド・3連複）を JRA から集める（検証用）。
//
//   node scripts/collect-exotic.mjs 2026-07-01 2026-09-30
//   環境変数 EXOTIC_KINDS=quinella,wide,trio,exacta（取る券種。既定は4つ）。保存済みのファイルに足りない券種があれば、その分だけ取って書き足す
//
// 単勝・複勝のオッズページ（収集済みでキャッシュにある）から各券種のページへのリンクをたどり、
// data/odds-final/{年}/{レースID}.json に { quinella, wide, trio } を保存する。保存済みは飛ばす。
// 1レースあたり3ページ。1.2秒間隔なので 100レースで約6分。

import path from 'node:path';
import { existsSync } from 'node:fs';
import { createJraClient } from '../src/collector/client.js';
import { listMonthMeetings, listRecentResultMeetings, listRaces } from '../src/collector/collect.js';
import { parseOddsLinks, parseExoticOdds } from '../src/collector/jra.js';
import { DATA_DIR, CACHE_DIR, readJson, writeJson } from '../src/collector/store.js';

const [from, to] = process.argv.slice(2);
if (!from || !to) {
  console.log('使い方: node scripts/collect-exotic.mjs <YYYY-MM-DD> <YYYY-MM-DD>');
  process.exit(1);
}
const KINDS = (process.env.EXOTIC_KINDS || 'quinella,wide,trio,exacta').split(',').filter(Boolean);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const client = createJraClient({ minIntervalMs: Number(process.env.KEIB_INTERVAL_MS || 1200), cacheDir: CACHE_DIR, log });
const todayYm = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7);

const months = [];
for (let d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`); d.toISOString().slice(0, 7) <= to.slice(0, 7); d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.toISOString().slice(0, 7));
const recent = await listRecentResultMeetings(client);
let saved = 0;
let skipped = 0;
for (const ym of months) {
  const seen = new Set();
  const meetings = [...(await listMonthMeetings(client, ym, todayYm)), ...recent.filter((m) => m.date.startsWith(ym))].filter((m) => {
    if (seen.has(m.cname) || m.date < from || m.date > to) return false;
    seen.add(m.cname);
    return true;
  });
  for (const meeting of meetings.sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const races = await listRaces(client, meeting);
    for (const link of races) {
      const file = path.join(DATA_DIR, 'odds-final', link.date.slice(0, 4), `${link.raceId}.json`);
      const existing = existsSync(file) ? await readJson(file) : null;
      // ライブで取った暫定のオッズ（source: 'live'）は公式の確定オッズで取り直す
      const missing = existing?.source === 'live' ? KINDS : KINDS.filter((k) => !existing?.[k]);
      if (existing && !missing.length) {
        skipped++;
        continue;
      }
      if (!link.oddsCname) continue;
      try {
        const tanpuku = await client.page(link.oddsCname, { cache: 'forever' });
        const links = parseOddsLinks(tanpuku);
        const out = existing && existing.source !== 'live' ? existing : { id: link.raceId, date: link.date, course: link.course, raceNo: link.raceNo };
        for (const kind of missing) {
          if (!links[kind]) continue;
          const parsed = parseExoticOdds(await client.page(links[kind], { cache: 'forever' }));
          out[kind] = parsed.odds;
          if (kind === 'wide') out.wideRange = parsed.range;
        }
        await writeJson(file, out);
        saved++;
      } catch (e) {
        log(`失敗 ${link.raceId}: ${e.message}`);
      }
    }
    log(`${meeting.date} ${meeting.course} 保存${saved} 済み${skipped}（通信${client.stats().requests}）`);
  }
}
log('完了', { saved, skipped, ...client.stats() });
