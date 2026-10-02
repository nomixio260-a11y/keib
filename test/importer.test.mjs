import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCSV,
  parseRaceCard,
  parsePastRuns,
  buildImportedRace,
  parseRacesJSON,
  raceToJSON,
  normGrade,
  normDate,
  normSurface,
  normCourse,
  CARD_TEMPLATE,
  PAST_TEMPLATE,
} from '../src/engine/importer.js';
import { predictRace } from '../src/engine/model.js';

const INFO = { date: '2026-10-04', course: '中山', raceNo: 11, name: 'テスト記念', grade: 'G3', surface: '芝', distance: 1800, going: '良' };

test('CSV：クォート・改行・BOM・タブ区切り', () => {
  assert.deepEqual(parseCSV('﻿a,b\r\n"x,1","he said ""hi"""\n'), [
    ['a', 'b'],
    ['x,1', 'he said "hi"'],
  ]);
  assert.deepEqual(parseCSV('a\tb\n1\t2'), [
    ['a', 'b'],
    ['1', '2'],
  ]);
  assert.deepEqual(parseCSV('a,b\n\n1,2\n'), [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

test('表記ゆれの正規化', () => {
  assert.equal(normGrade('ＧⅠ'), 'G1');
  assert.equal(normGrade('2勝クラス'), '2勝');
  assert.equal(normGrade('オープン'), 'OP');
  assert.equal(normGrade('1000万下'), '2勝');
  assert.equal(normGrade('なにか'), null);
  assert.equal(normDate('2026/9/6'), '2026-09-06');
  assert.equal(normDate('2026年9月6日'), '2026-09-06');
  assert.equal(normDate('2026-13-01'), null);
  assert.equal(normSurface('ダート'), 'ダ');
  assert.equal(normCourse('東京競馬場'), '東京');
  assert.equal(normCourse('大井'), null);
});

test('出馬表テンプレートを読み込める', () => {
  const r = parseRaceCard(CARD_TEMPLATE);
  assert.deepEqual(r.errors, []);
  assert.equal(r.entries.length, 6);
  const e1 = r.entries[0];
  assert.equal(e1.name, 'サンプルアロー');
  assert.equal(e1.sex, '牡');
  assert.equal(e1.age, 4);
  assert.equal(e1.bodyWeightDiff, 4);
  assert.equal(e1.frame, 1);
  // 人気はオッズから付く
  assert.equal(r.entries.find((e) => e.odds === 3.6).popularity, 1);
  assert.ok(Math.abs(r.jockeys['青木'].winRate - 0.152) < 1e-9);
});

test('出馬表のエラーは行番号つき', () => {
  const r = parseRaceCard('馬番,馬名\n1,アー\n1,イー\n20,ウー\n3,');
  assert.equal(r.entries.length, 1);
  assert.match(r.errors.join('\n'), /3行目：馬番1が重複/);
  assert.match(r.errors.join('\n'), /4行目：馬番「20」/);
  assert.match(r.errors.join('\n'), /5行目：馬名が空/);
  assert.match(parseRaceCard('名前,番号\nあ,1').errors[0], /馬番/);
});

test('過去走テンプレートを読み込める', () => {
  const r = parsePastRuns(PAST_TEMPLATE);
  assert.deepEqual(r.errors, []);
  assert.equal(r.count, 7);
  const runs = r.byKey.get(1);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].date, '2026-09-06', '新しい順に並ぶ');
  assert.equal(runs[0].time, 106.8);
  assert.deepEqual(runs[0].passing, [5, 5, 4, 3]);
  assert.equal(runs[1].margin, -0.2);
});

test('過去走：「芝1600」形式の距離と不正な日付', () => {
  const r = parsePastRuns('馬番,日付,距離,着順\n1,2026-09-01,ダ1400,3\n2,9月1日,1600,1');
  assert.equal(r.byKey.get(1)[0].surface, 'ダ');
  assert.equal(r.byKey.get(1)[0].distance, 1400);
  assert.match(r.errors[0], /3行目：日付/);
});

test('取り込んだレースで予想できる', () => {
  const { race, errors, warnings } = buildImportedRace(INFO, CARD_TEMPLATE, PAST_TEMPLATE);
  assert.deepEqual(errors, []);
  assert.ok(Array.isArray(warnings));
  assert.equal(race.entries.length, 6);
  assert.equal(race.entries[0].past.length, 2);
  const pred = predictRace(race, { sims: 3000 });
  assert.equal(pred.n, 6);
  assert.ok(Math.abs(pred.rows.reduce((a, r) => a + r.pWin, 0) - 1) < 1e-9);
  assert.equal(pred.placeCount, 2, '7頭以下は複勝2着まで');
});

test('レース情報の不足はエラー', () => {
  const { race, errors } = buildImportedRace({ ...INFO, course: '', distance: 50 }, CARD_TEMPLATE, '');
  assert.equal(race, null);
  assert.ok(errors.some((e) => /競馬場/.test(e)));
  assert.ok(errors.some((e) => /距離/.test(e)));
});

test('JSON の書き出しと読み込み', () => {
  const { race } = buildImportedRace(INFO, CARD_TEMPLATE, PAST_TEMPLATE);
  const text = raceToJSON(race);
  const back = parseRacesJSON(text);
  assert.deepEqual(back.errors, []);
  assert.equal(back.races.length, 1);
  assert.equal(back.races[0].entries.length, 6);
  assert.equal(back.races[0].entries[0].past.length, 2);
  assert.match(parseRacesJSON('{oops').errors[0], /JSON/);
  assert.match(parseRacesJSON('{"date":"2026-10-04","course":"東京","surface":"芝","distance":1600,"grade":"G1","entries":[]}').errors[0], /2頭以上/);
});
