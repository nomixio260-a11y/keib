// 特別登録（出馬表の前の暫定のレース）と、買い目の選定に使う勝率の平らさ（betTemp）

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseRegistrationList, parseRegistration, registrationKeyFromCname } from '../src/collector/jra.js';
import { registrationToRace, addProvisionalRaces, removeProvisionalRaces } from '../src/collector/registrations.js';
import { upsertRace } from '../src/collector/bundle.js';
import { predictRace } from '../src/engine/model.js';
import { recommendBets, betView, BET_TEMP } from '../src/engine/bets.js';
import { raceStatus } from '../src/engine/raceTime.js';
import { makeRace } from './fixtures/race.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('特別登録の CNAME から raceId（出馬表と同じ形）', () => {
  assert.deepEqual(registrationKeyFromCname('pw03tde000504030920261010/7B'), {
    raceId: '202605040309',
    courseCode: '05',
    course: '東京',
    year: 2026,
    kai: 4,
    day: 3,
    raceNo: 9,
    date: '2026-10-10',
  });
  assert.equal(registrationKeyFromCname('pw03tdd00080407112026101801/23').raceId, '202608040711');
  assert.equal(registrationKeyFromCname('pw01dde0105202604021120261004/AA'), null);
});

test('特別登録のレース選択：日付・競馬場・レース名・クラス・距離', () => {
  const list = parseRegistrationList(fixture('jra-registration-list.html'));
  assert.equal(list.length, 19);
  assert.equal(list[0].raceId, '202605040309');
  assert.equal(list[0].name, '陣馬特別');
  assert.equal(list[0].grade, '2勝');
  assert.equal(list[0].distance, 2400);
  assert.equal(list[0].surface, '芝');
  const saudi = list.find((x) => x.raceId === '202605040311');
  assert.equal(saudi.grade, 'G3');
  assert.equal(saudi.surface, '芝');
  assert.equal(list.find((x) => x.name === 'JRA電話50周年').surface, 'ダ');
  // 再来週の G1（早めの登録）も入る
  assert.ok(list.some((x) => x.date === '2026-10-18' && x.grade === 'G1'));
});

test('特別登録の1レース（一覧表示）：見出し・登録頭数・負担重量・馬柱のページ', () => {
  const r = parseRegistration(fixture('jra-registration-race.html'));
  assert.equal(r.date, '2026-10-10');
  assert.equal(r.course, '東京');
  assert.equal(r.name, 'サウジアラビアロイヤルカップ');
  assert.equal(r.grade, 'G3');
  assert.equal(r.distance, 1600);
  assert.equal(r.surface, '芝');
  assert.equal(r.registered, 12);
  assert.equal(r.maxRunners, 18);
  assert.equal(r.horses.length, 12);
  assert.deepEqual(r.horses[0], { name: 'アイファーマーリン', horseId: '2024105215', weight: 56 });
  assert.equal(r.horses.at(-1).weight, 55);
  assert.deepEqual(r.umabashiraCnames, ['pw03tdd00050403112026101001/45']);
});

test('特別登録の馬柱：性齢・厩舎・前4走（JRA は raceId つき、地方は着順と距離だけ、転入の行は飛ばす）', () => {
  const r = parseRegistration(fixture('jra-registration-umabashira.html'));
  assert.equal(r.horses.length, 4);
  for (const h of r.horses) {
    assert.match(h.horseId, /^\d{10}$/);
    assert.ok(['牡', '牝', 'セ'].includes(h.sex));
    assert.ok(h.age >= 2);
    assert.ok(h.trainer.length > 0);
    assert.ok(h.past.length >= 1 && h.past.length <= 4);
  }
  const jra = r.horses[0].past[0];
  assert.match(jra.raceId, /^\d{12}$/);
  assert.ok(jra.finish >= 0 && jra.fieldSize > 0 && jra.distance > 0);
  const local = r.horses.find((h) => h.past.some((p) => p.course === '金沢'));
  assert.ok(local);
  assert.ok(local.past.every((p) => p.raceName !== 'JRAへ転入'));
  const k = local.past.find((p) => p.course === '金沢');
  assert.equal(k.raceId, null);
  assert.equal(k.surface, 'ダ');
  assert.equal(k.distance, 1400);
});

test('特別登録 → 暫定のレース：仮の馬番・枠なし、過去走は収集済みの結果で詳しくする', () => {
  const list = parseRegistrationList(fixture('jra-registration-list.html'));
  const top = parseRegistration(fixture('jra-registration-race.html'));
  const ub = parseRegistration(fixture('jra-registration-umabashira.html'));
  // 馬柱のフィクスチャは別のレースなので、一覧表示に馬柱の馬を足した形で確かめる
  const horse = ub.horses[0];
  const past0 = horse.past[0];
  const rec = { id: past0.raceId, date: past0.date, course: '中山', name: 'テスト', grade: '2勝', surface: '芝', distance: 2000, going: '良', fieldSize: 12, runners: [{ horseId: horse.horseId, number: 3, finish: 2, time: 120.5, last3f: 34.1, passing: [3, 3], weight: 57, jockey: '騎手A', popularity: 4 }, { horseId: 'x', number: 1, finish: 1, name: '勝ち馬' }] };
  const key = list.find((x) => x.raceId === '202605040311');
  const race = registrationToRace({ key, top: { ...top, horses: [...top.horses, { name: horse.name, horseId: horse.horseId, weight: 57 }] }, horses: [horse] }, { recById: new Map([[rec.id, rec]]) });
  assert.equal(race.id, '202605040311');
  assert.equal(race.status, 'registration');
  assert.equal(race.provisional, true);
  assert.equal(race.registered, 12);
  assert.equal(race.maxRunners, 18);
  assert.equal(race.entries.length, 13);
  assert.deepEqual(race.entries.map((e) => e.number), Array.from({ length: 13 }, (_, i) => i + 1));
  assert.ok(race.entries.every((e) => e.frame === null && e.provisionalNumber && e.odds === null && e.jockey === ''));
  const e = race.entries.at(-1);
  assert.equal(e.sex, horse.sex);
  assert.equal(e.trainer, horse.trainer);
  assert.equal(e.past[0].time, 120.5);
  assert.equal(e.past[0].winner, '勝ち馬');
  assert.equal(e.past.length, horse.past.length);
  assert.equal(raceStatus(race), 'registration');

  // 予想：オッズなし → AI単独。荒れ度（人気3頭以外が勝つ確率）は出さない。枠順は見ない
  const pred = predictRace(race, { sims: 0 });
  assert.equal(pred.aiOnly, true);
  assert.equal(pred.confidence.volatility, null);
  assert.ok(pred.rows.every((r) => r.raw.draw === 0));
  assert.ok(Math.abs(pred.rows.reduce((a, r) => a + r.pWin, 0) - 1) < 1e-9);
  assert.equal(recommendBets(pred, { budget: 1000 }).tickets.length, 0);
});

test('暫定のレースは出馬表のあるレース・開催日には入れず、毎回作り直す', () => {
  const bundle = { days: [{ date: '2026-10-10', races: [{ id: 'A', date: '2026-10-10', course: '東京', raceNo: 1, entries: [] }] }] };
  const prov = (id, date) => ({ id, date, course: '東京', raceNo: 11, provisional: true, status: 'registration', entries: [] });
  const n = addProvisionalRaces(bundle, [prov('A', '2026-10-10'), prov('B', '2026-10-10'), prov('C', '2026-10-11')], { upsert: upsertRace });
  assert.equal(n, 1);
  assert.deepEqual(bundle.days.map((d) => d.date).sort(), ['2026-10-10', '2026-10-11']);
  const removed = removeProvisionalRaces(bundle);
  assert.deepEqual(removed.map((r) => r.id), ['C']);
  assert.deepEqual(bundle.days.map((d) => d.date), ['2026-10-10']);
});

test('買い目は勝率を少し平らにして選ぶ（予想の勝率そのものは変えない）', () => {
  const race = makeRace({ seed: 11 });
  const pred = predictRace(race, { sims: 0 });
  const view = betView(pred, 1.2);
  assert.notEqual(view, pred);
  assert.equal(betView(pred, 1.2), view, 'キャッシュする');
  assert.equal(betView(pred, 1), pred);
  // 本命の勝率は下がり、合計は1のまま。予想（pred）の勝率は変わらない
  const top = pred.order[0].i;
  assert.ok(view.rows[top].pWin < pred.rows[top].pWin);
  assert.ok(Math.abs(view.rows.reduce((a, r) => a + r.pWin, 0) - 1) < 1e-9);
  // 既定（BET_TEMP）で選んだ買い目は、勝率全体を BET_TEMP で平らにした予想から温度1で選んだものと同じ
  const flat = predictRace(race, { sims: 0, noise: BET_TEMP });
  const a = recommendBets(pred, { budget: 3000 }).tickets.map((t) => `${t.type}:${t.idx.join('-')}:${t.stake}`);
  const b = recommendBets(flat, { budget: 3000, betTemp: 1 }).tickets.map((t) => `${t.type}:${t.idx.join('-')}:${t.stake}`);
  assert.deepEqual(a, b);
});

test('2段目：決めた買い目から当たる確率が下限以上のものだけ買う', () => {
  let both = false;
  for (let seed = 1; seed <= 40; seed++) {
    const pred = predictRace(makeRace({ seed }), { sims: 0 });
    const all = recommendBets(pred, { budget: 3000, keep: 0 });
    const kept = recommendBets(pred, { budget: 3000 });
    assert.equal(kept.keepMinP, 0.5, '的中重視の標準は 50%');
    for (const t of kept.tickets) assert.ok(t.pHit >= 0.5, `${t.type} ${t.pHit}`);
    for (const t of kept.dropped) assert.ok(t.pHit < 0.5 && t.stake === 0);
    assert.equal(kept.tickets.length + kept.dropped.length, all.tickets.length);
    if (kept.tickets.length) assert.equal(kept.tickets.reduce((a, t) => a + t.stake, 0), 3000);
    if (kept.tickets.length && kept.dropped.length) both = true;
  }
  assert.ok(both, '残す買い目と外す買い目の両方があるレースがある');
  // 30% にゆるめると残る買い目は増える（同じか多い）
  const pred = predictRace(makeRace({ seed: 7 }), { sims: 0 });
  assert.ok(recommendBets(pred, { budget: 3000, keep: 0.3 }).tickets.length >= recommendBets(pred, { budget: 3000, keep: 0.5 }).tickets.length);
});

test('レース分析：結論（買い・見送り・待ち）、有力馬、AI と人気のずれ、コースの傾向', async () => {
  const { raceAnalysis, valueLabel } = await import('../src/engine/analysis.js');
  const { COURSE_STATS } = await import('../src/engine/courseStats.js');
  assert.equal(valueLabel(1.4).key, 'over');
  assert.equal(valueLabel(0.7).key, 'under');
  assert.equal(valueLabel(1.0).key, 'fair');
  assert.equal(valueLabel(null), null);
  const kinds = new Set();
  for (let seed = 1; seed <= 30; seed++) {
    const race = { ...makeRace({ seed }), course: '東京', surface: '芝', distance: 1600 };
    const pred = predictRace(race, { sims: 0 });
    const rec = recommendBets(pred, { budget: 1000 });
    const a = raceAnalysis(pred, rec);
    kinds.add(a.verdict.kind);
    assert.ok(['buy', 'skip'].includes(a.verdict.kind));
    if (a.verdict.kind === 'buy') assert.ok(a.verdict.tickets.length > 0);
    assert.equal(a.top.length, Math.min(5, pred.rows.length));
    assert.ok(a.top[0].row.pWin >= a.top[1].row.pWin);
    for (const o of a.overlays) assert.ok(o.ratio >= 1.15);
    for (const u of a.underlays) assert.ok(u.ratio <= 0.88 && u.row.entry.popularity <= 4);
    assert.ok(a.outlook.length > 0);
    if (COURSE_STATS.courses['東京|芝|1600']) assert.equal(a.course.key, '東京|芝|1600');
  }
  assert.ok(kinds.size >= 1);
  // オッズのないレース（暫定のレース）は「待ち」、ずれは出さない
  const race = makeRace({ seed: 4 });
  race.entries.forEach((e) => {
    e.odds = null;
    e.popularity = null;
  });
  const pred = predictRace({ ...race, provisional: true }, { sims: 0 });
  const a = raceAnalysis(pred, recommendBets(pred, { budget: 1000 }));
  assert.equal(a.verdict.kind, 'wait');
  assert.equal(a.overlays.length + a.underlays.length, 0);
  assert.ok(a.top.every((h) => h.ratio == null));
});
