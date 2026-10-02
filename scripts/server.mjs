#!/usr/bin/env node
// リアルタイム版のサーバー：JRAの出馬表・オッズ・結果を定期的に取り直し、アプリ（dist/）と最新データを配信する。
//
//   npm run server                      … http://localhost:8080
//   PORT=3000 HOST=0.0.0.0 npm run server
//
// 画面は data.json（= /api/bundle）を1分ごとに読み直す。JRAへのアクセスは1.2秒に1回までで、
// 出馬表は発走が近いほど短い間隔（2分〜30分）で取り直す。個人で使うためのものです。

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createJraClient } from '../src/collector/client.js';
import { emptyBundle, addPastDaysFromHistory, mergeBundle, refreshLive, pruneBundle, attachDayVariants, compactBundle, jstParts } from '../src/collector/bundle.js';
import { REAL_STATS } from '../src/engine/realStats.js';
import { loadHistory, saveRecord, readJson, writeJson, BUNDLE_FILE, CACHE_DIR, ROOT } from '../src/collector/store.js';
import { indexHistory } from '../src/data/history.js';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const KEEP_PAST = Number(process.env.KEIB_PAST_DAYS || 4);
const LOOP_MS = 60 * 1000;
const dist = path.join(ROOT, 'dist');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const client = createJraClient({ minIntervalMs: Number(process.env.KEIB_INTERVAL_MS || 1200), cacheDir: CACHE_DIR, log });

let bundle = emptyBundle();
let records = [];
let body = JSON.stringify({ ...bundle, live: true });
let lastError = null;

async function initial() {
  records = await loadHistory();
  if (records.length) {
    const today = jstParts().date;
    const dates = [...new Set(records.filter((r) => r.date < today).map((r) => r.date))].sort().slice(-KEEP_PAST);
    addPastDaysFromHistory(bundle, records, indexHistory(records), dates);
    log(`過去の開催日 ${dates.length}日分を data/history から読み込みました`);
  }
  const prev = await readJson(BUNDLE_FILE);
  if (prev) mergeBundle(bundle, prev);
  attachDayVariants(bundle, records, REAL_STATS);
  compactBundle(bundle);
  body = JSON.stringify({ ...bundle, live: true });
}

let running = false;
async function refresh() {
  if (running) return;
  running = true;
  try {
    const { cards, results } = await refreshLive(client, bundle, {
      log,
      onRecord: async (rec) => {
        if (await saveRecord(rec)) records.push(rec);
      },
    });
    pruneBundle(bundle, { keepPast: KEEP_PAST });
    if (results) attachDayVariants(bundle, records, REAL_STATS);
    compactBundle(bundle);
    body = JSON.stringify({ ...bundle, live: true });
    lastError = null;
    if (cards || results) {
      await writeJson(BUNDLE_FILE, bundle);
      log(`更新：出馬表 ${cards}件・結果 ${results}件（通信 累計${client.stats().requests}回）`);
    }
  } catch (e) {
    lastError = e.message;
    log(`更新に失敗：${e.message}`);
  } finally {
    running = false;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/bundle' || url.pathname === '/data.json') {
    res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store', 'X-Keib-Error': lastError ? encodeURIComponent(lastError) : '' });
    res.end(body);
    return;
  }
  try {
    let file = path.normalize(path.join(dist, decodeURIComponent(url.pathname)));
    if (!file.startsWith(dist)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if ((await stat(file).catch(() => null))?.isDirectory()) file = path.join(file, 'index.html');
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('見つかりません。先に npm run build を実行してください。');
  }
});

await initial();
server.listen(PORT, HOST, () => log(`KEIB リアルタイム版: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/`));
await refresh();
setInterval(refresh, LOOP_MS);
