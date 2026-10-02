// 収集した実データ（data/）の読み書き（Node 専用）

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA_DIR = process.env.KEIB_DATA_DIR || path.join(ROOT, 'data');
export const HISTORY_DIR = path.join(DATA_DIR, 'history');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const BUNDLE_FILE = path.join(DATA_DIR, 'bundle.json');
export const ODDS_DIR = path.join(DATA_DIR, 'odds');

/** data/history の全レース記録（日付順） */
export async function loadHistory(dir = HISTORY_DIR) {
  const records = [];
  for (const year of await readdir(dir).catch(() => [])) {
    for (const f of await readdir(path.join(dir, year)).catch(() => [])) {
      if (f.endsWith('.json')) records.push(JSON.parse(await readFile(path.join(dir, year, f), 'utf8')));
    }
  }
  records.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id.localeCompare(b.id)));
  return records;
}

/** レース記録を1件保存（すでにあれば上書きしない） */
export async function saveRecord(record, dir = HISTORY_DIR) {
  const file = path.join(dir, record.date.slice(0, 4), `${record.id}.json`);
  if (existsSync(file)) return false;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(record));
  return true;
}

export async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data));
}

/**
 * オッズの推移を記録する（data/odds/{年}/{レースID}.json）。
 * 発売中のオッズは時間とともに動き、締切直前の動きには情報があると言われる。
 * 学習に使えるのは記録をためてからなので、今は集めるだけ（リアルタイム版で動かしている間に貯まる）。
 */
export async function appendOddsSnapshot(race, dir = ODDS_DIR) {
  if (!race?.id || !race.oddsAt || !race.entries?.some((e) => e.odds > 1)) return false;
  const file = path.join(dir, String(race.date || '').slice(0, 4) || 'unknown', `${race.id}.json`);
  const doc = (await readJson(file)) || { id: race.id, date: race.date, course: race.course, raceNo: race.raceNo, startTime: race.startTime, snapshots: [] };
  const snap = {
    at: race.oddsAt,
    win: Object.fromEntries(race.entries.filter((e) => e.odds > 1).map((e) => [e.number, e.odds])),
    place: Object.fromEntries(race.entries.filter((e) => e.placeMin > 1).map((e) => [e.number, [e.placeMin, e.placeMax]])),
  };
  const last = doc.snapshots.at(-1);
  // 同じ時刻、またはオッズがまったく同じなら記録しない（キャッシュから読み直しただけのとき）
  if (last && (last.at === snap.at || (JSON.stringify(last.win) === JSON.stringify(snap.win) && JSON.stringify(last.place) === JSON.stringify(snap.place)))) return false;
  doc.snapshots.push(snap);
  await writeJson(file, doc);
  return true;
}
