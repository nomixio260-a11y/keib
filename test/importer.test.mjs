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
  CARD_HEADER,
  PAST_HEADER,
} from '../src/engine/importer.js';
import { predictRace } from '../src/engine/model.js';

const INFO = { date: '2026-10-04', course: '中山', raceNo: 11, name: 'テスト記念', grade: 'G3', surface: '芝', distance: 1800, going: '良' };

// テスト専用の入力（アプリでは使わない）
const CARD_TEMPLATE = `${CARD_HEADER}
1,1,テストアロー,牡4,58,騎手A,486,+4,3.6,,15.2%,38.0%
2,2,テストルミナス,牝5,56,騎手B,452,-2,8.9,,8.1%,24.5%
3,3,テストノヴァ,牡4,58,騎手C,470,0,5.1,,11.0%,30.2%
4,4,テストスター,セ6,58,騎手D,498,+8,24.5,,5.5%,18.0%
5,5,テストブレイヴ,牡3,56,騎手E,462,-4,4.4,,12.4%,33.1%
6,6,テストオーロラ,牝4,56,騎手F,440,+2,15.8,,6.9%,21.7%`;

const PAST_TEMPLATE = `${PAST_HEADER}
1,2026-09-06,中山,テスト特別,3勝,芝,1800,良,14,2,1:46.8,0.1,34.6,2,5-5-4-3,58,騎手A
1,2026-07-20,新潟,テストS,3勝,芝,1800,良,16,1,1:45.9,-0.2,33.9,1,8-8,58,騎手A
2,2026-08-30,新潟,テスト記念,3勝,芝,2000,稍重,12,4,2:00.4,0.5,35.0,5,3-3-3-4,56,騎手B
3,2026-09-13,中京,テスト特別,3勝,芝,1600,良,16,3,1:33.5,0.3,34.1,3,9-8,58,騎手C
4,2026-06-01,東京,テストS,3勝,芝,1800,重,15,9,1:48.9,1.6,36.0,10,2-2-3-6,58,騎手D
5,2026-09-20,中山,テストカップ,3勝,芝,1800,良,13,1,1:47.0,-0.1,34.3,1,2-2-2-1,56,騎手E
6,2026-09-06,中山,テスト特別,3勝,芝,1800,良,14,7,1:47.5,0.8,35.1,6,10-10-9-8,56,騎手F`;

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
  assert.equal(e1.name, 'テストアロー');
  assert.equal(e1.sex, '牡');
  assert.equal(e1.age, 4);
  assert.equal(e1.bodyWeightDiff, 4);
  assert.equal(e1.frame, 1);
  // 人気はオッズから付く
  assert.equal(r.entries.find((e) => e.odds === 3.6).popularity, 1);
  assert.ok(Math.abs(r.jockeys['騎手A'].winRate - 0.152) < 1e-9);
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
