// 発走時刻と、レースの状態（発売中・締切間近・発走済み・確定）。ブラウザとサーバーの両方で使う。

import { addDays } from './util.js';

/** 日本時間の 'YYYY-MM-DD' と 'HH:MM' */
export function jstParts(ms = Date.now()) {
  const iso = new Date(ms + 9 * 3600 * 1000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), ym: iso.slice(0, 7) };
}

/** 発走時刻（日本時間）→ UTC ミリ秒 */
export function startMs(race) {
  if (!race?.date || !race.startTime) return null;
  return Date.parse(`${race.date}T${race.startTime}:00+09:00`);
}

/** result（確定）・live（発走済みで結果待ち）・closing（締切間近）・open（発売中） */
export function raceStatus(race, now = Date.now()) {
  if (race?.result?.length) return 'result';
  // 特別登録の暫定のレース（出馬表の前）
  if (race?.provisional) return 'registration';
  const st = startMs(race);
  if (!st) return 'open';
  if (now >= st) return 'live';
  if (st - now <= 3 * 60 * 1000) return 'closing';
  return 'open';
}

export const STATUS_LABEL = { result: '確定', live: '結果待ち', closing: '締切間近', open: '発売中', registration: '特別登録' };

/** 'あと1時間5分' のような表記 */
export function untilText(ms) {
  if (ms <= 0) return '';
  const m = Math.ceil(ms / 60000);
  if (m < 60) return `あと${m}分`;
  const h = Math.floor(m / 60);
  if (h < 24) return `あと${h}時間${m % 60 ? `${m % 60}分` : ''}`;
  return `あと${Math.floor(h / 24)}日`;
}

/** 画面に出す過去の開催日：今日の7日前から（それより前は「過去の開催日」のアーカイブから読む） */
export const RECENT_DAYS = 7;

/**
 * 画面に出す開催日。特別登録の暫定のレース（出馬表の前）は出さない：今日以降の予想は、出馬表（枠順・騎手）が出てから
 * （利用者の依頼 2026-10-05）。過去の開催日は直近 RECENT_DAYS 日だけ（アーカイブから読み込んだ日 archived は残す）。
 */
export function visibleDays(days, today, recent = RECENT_DAYS) {
  const from = addDays(today, -recent);
  const out = [];
  for (const d of days || []) {
    if (!d.archived && d.date < from) continue;
    const races = (d.races || []).filter((r) => !r.provisional);
    if (!races.length) continue;
    out.push(races.length === d.races.length ? d : { ...d, races, venues: [...new Set(races.map((r) => r.course))] });
  }
  return out;
}
