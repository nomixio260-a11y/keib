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
