#!/usr/bin/env node
// JRA の競走馬情報ページから血統（父・母・母の父）と生年月日などを集める。
//   node scripts/collect-horses.mjs            … data/history に出てくる全馬（まだ取っていない馬だけ）
//   node scripts/collect-horses.mjs --limit 500
// 馬ページの CNAME（チェックサムつき）は、キャッシュ済みの結果ページのリンクから拾う（新しい通信は馬ページの分だけ）。
// 保存先：data/horses/{馬ID}.json。取得間隔は 1.2 秒。

import path from 'node:path';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createJraClient } from '../src/collector/client.js';
import { parseHorsePage } from '../src/collector/jra.js';
import { loadHistory, DATA_DIR, CACHE_DIR } from '../src/collector/store.js';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const args = process.argv.slice(2);
const limit = Number(args[args.indexOf('--limit') + 1]) || Infinity;
const OUT = path.join(DATA_DIR, 'horses');
const MAP_FILE = path.join(DATA_DIR, 'horse-cnames.json');
await mkdir(OUT, { recursive: true });

// 馬ID → ページの CNAME（結果ページのキャッシュから）
let map = existsSync(MAP_FILE) ? JSON.parse(await readFile(MAP_FILE, 'utf8')) : {};
const all = await loadHistory();
const ids = new Set();
for (const rec of all) for (const r of rec.runners) if (r.horseId) ids.add(r.horseId);
const missing = [...ids].filter((id) => !map[id]);
if (missing.length) {
  log(`${ids.size}頭のうち ${missing.length}頭のページ CNAME をキャッシュから探す`);
  const files = await readdir(CACHE_DIR);
  let n = 0;
  for (const f of files) {
    if (!f.endsWith('.html.gz')) continue;
    let html;
    try { html = gunzipSync(await readFile(path.join(CACHE_DIR, f))).toString('utf8'); } catch { continue; }
    if (!html.includes('pw01dud')) continue;
    for (const m of html.matchAll(/pw01dud\d0(\d{10})\/([0-9A-F]{2})/g)) if (!map[m[1]]) map[m[1]] = `pw01dud10${m[1]}/${m[2]}`;
    if (++n % 2000 === 0) log(`  ${n}ファイル… ${Object.keys(map).length}頭`);
  }
  await writeFile(MAP_FILE, JSON.stringify(map));
  log(`CNAME が見つかった馬：${Object.keys(map).length}頭`);
}

const todo = [...ids].filter((id) => map[id] && !existsSync(path.join(OUT, `${id}.json`))).slice(0, limit);
log(`取得する馬：${todo.length}頭（取得済み ${ids.size - todo.length}）`);
const client = createJraClient({ minIntervalMs: Number(process.env.KEIB_INTERVAL_MS || 1200), cacheDir: null, log });
let done = 0;
let failed = 0;
for (const id of todo) {
  try {
    const html = await client.page(map[id], { cache: 'none' });
    const info = parseHorsePage(html);
    if (!info.name) throw new Error('解析できない');
    await writeFile(path.join(OUT, `${id}.json`), JSON.stringify({ id, ...info, fetchedAt: new Date().toISOString().slice(0, 10) }));
    done++;
  } catch (e) {
    failed++;
    log(`  失敗 ${id}: ${e.message}`);
  }
  if ((done + failed) % 200 === 0) log(`  ${done + failed}/${todo.length}（失敗 ${failed}、通信 ${client.stats().requests}）`);
}
log(`完了：保存 ${done}・失敗 ${failed}`);
