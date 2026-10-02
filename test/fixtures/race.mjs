// テスト専用の入力データ（アプリの予想には使わない）。エンジンの計算を確かめるための最小限のレース。

import { createRng } from '../../src/engine/rng.js';
import { frameOf } from '../../src/engine/constants.js';
import { baseTime } from '../../src/engine/speed.js';
import { addDays } from '../../src/engine/util.js';

/** 能力値の並びから、前4走つきのレースを作る */
export function makeRace({ id = 'test-1', n = 12, seed = 1, date = '2026-10-04', course = '東京', surface = '芝', distance = 1600, grade = '2勝' } = {}) {
  const rng = createRng(seed).next;
  const ability = Array.from({ length: n }, () => rng() * 2 - 1);
  const order = ability.map((a, i) => [a, i]).sort((x, y) => y[0] - x[0]);
  const rankOf = new Map(order.map(([, i], k) => [i, k]));
  const entries = ability.map((a, i) => {
    const number = i + 1;
    const past = Array.from({ length: 4 }, (_, k) => {
      const field = 14;
      const finish = Math.max(1, Math.min(field, Math.round(7 - a * 5 + (rng() - 0.5) * 6)));
      const base = baseTime(surface, distance, '良', course);
      return {
        date: addDays(date, -28 * (k + 1)),
        course,
        raceName: `テスト${k + 1}`,
        grade,
        surface,
        distance,
        going: '良',
        fieldSize: field,
        number: 1 + ((i + k) % field),
        finish,
        time: Math.round((base + 0.4 - a * 0.6 + rng() * 0.4) * 10) / 10,
        margin: finish === 1 ? -0.1 : Math.round((finish - 1) * 0.15 * 10) / 10,
        last3f: Math.round((34.6 - a * 0.5 + rng() * 0.4) * 10) / 10,
        passing: [1 + ((i * 3) % field), 1 + ((i * 3 + 1) % field)],
        weight: 56,
        jockey: `騎手${i % 6}`,
        popularity: 1 + (rankOf.get(i) % field),
      };
    });
    const pop = rankOf.get(i) + 1;
    return {
      frame: frameOf(number, n),
      number,
      name: `テスト馬${number}`,
      sex: '牡',
      age: 4,
      weight: 56,
      jockey: `騎手${i % 6}`,
      odds: Math.round((1.8 + pop * pop * 0.9) * 10) / 10,
      popularity: pop,
      past,
    };
  });
  return { id, date, course, raceNo: 11, name: 'テストレース', grade, surface, distance, going: '良', entries };
}

/** 結果と払戻つきのレースを count 個（バックテスト用） */
export function makeResultRaces(count = 12, seed = 7) {
  const rng = createRng(seed).next;
  return Array.from({ length: count }, (_, k) => {
    const race = makeRace({ id: `bt-${k}`, seed: seed * 100 + k });
    const nums = race.entries.map((e) => e.number).sort(() => rng() - 0.5);
    const [a, b, c] = nums;
    const pair = (x, y) => [x, y].sort((u, v) => u - v).join('-');
    race.result = nums;
    race.payouts = {
      win: { [a]: 450 },
      place: { [a]: 180, [b]: 240, [c]: 310 },
      quinella: { [pair(a, b)]: 1500 },
      wide: { [pair(a, b)]: 520, [pair(a, c)]: 610, [pair(b, c)]: 880 },
      exacta: { [`${a}>${b}`]: 2900 },
      trio: { [[a, b, c].sort((u, v) => u - v).join('-')]: 6400 },
      trifecta: { [`${a}>${b}>${c}`]: 31000 },
    };
    return race;
  });
}
