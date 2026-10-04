// 過去の開催日のアーカイブ：開催日ごとのファイル（1日分のバンドル：出馬表・結果・払戻・確定オッズ・各馬の通算要約）と一覧（index.json）。
// 画面は data.json（直近の開催日）に加えて、選んだ日だけをここから読み込む。結果の出そろった日はあとから変わらないので、1回作れば使い続けられる。

import path from 'node:path';
import { mkdir, readdir } from 'node:fs/promises';
import { readJson, writeJson } from './store.js';

/** 1日分をファイルに書く（中身が同じなら書かない）。書いたら true */
export async function writeArchiveDay(dir, day, { generatedAt = new Date().toISOString(), version = 1 } = {}) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${day.date}.json`);
  const prev = await readJson(file);
  const body = { version, source: 'JRA', archive: true, days: [day] };
  if (prev && JSON.stringify({ ...prev, generatedAt: undefined }) === JSON.stringify({ ...body, generatedAt: undefined })) return false;
  await writeJson(file, { ...body, generatedAt });
  return true;
}

/** 一覧を作り直す：{ generatedAt, days: [{ date, venues, races, results }] }（新しい日から） */
export async function rebuildArchiveIndex(dir) {
  const files = (await readdir(dir).catch(() => [])).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  const days = [];
  for (const f of files) {
    const doc = await readJson(path.join(dir, f));
    const d = doc?.days?.[0];
    if (!d) continue;
    days.push({ date: d.date, venues: d.venues || [...new Set(d.races.map((r) => r.course))], races: d.races.length, results: d.races.filter((r) => r.status === 'result').length });
  }
  days.sort((a, b) => (a.date < b.date ? 1 : -1));
  const index = { generatedAt: new Date().toISOString(), days };
  await writeJson(path.join(dir, 'index.json'), index);
  return index;
}

/** アーカイブにある日付（Set） */
export async function archiveDates(dir) {
  const files = await readdir(dir).catch(() => []);
  return new Set(files.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)));
}

/** 1日分を読む（なければ null） */
export async function readArchiveDay(dir, date) {
  const doc = await readJson(path.join(dir, `${date}.json`));
  return doc?.days?.[0] || null;
}
