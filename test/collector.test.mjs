// JRA ページの解析。入力は JRA のページ構造をまねて手で書いた最小限の HTML（実際のページの写しではない）

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRaceTime,
  parseJpDate,
  raceKeyFromCname,
  meetingKeyFromCname,
  normalizeGrade,
  parseCourse,
  parseRaceCard,
  parseRaceResult,
  parseOdds,
  parseMeetingLinks,
  parseRaceLinks,
  parseMonthParams,
  parseOddsLinks,
  parseExoticOdds,
} from '../src/collector/jra.js';
import { pathForCname } from '../src/collector/client.js';
import { cardToRace, resultToRecord, finishingOrder } from '../src/collector/collect.js';

const HEADER = `<div class="race_header">
  <div class="date_line"><div class="date">2026年10月4日（日曜） 4回東京2日</div><div class="time">発走時刻：15時45分</div></div>
  <ul class="baba"><li><span class="cap">天候</span><span class="txt">晴</span></li><li><span class="cap">芝</span><span class="txt">良</span></li><li><span class="cap">ダート</span><span class="txt">稍重</span></li></ul>
  <div class="race_number"><img alt="11レース"></div>
  <h2 class="race_name">テスト記念<span class="grade_icon"><img alt="GⅡ"></span></h2>
  <div class="type"><div class="category">3歳以上</div><div class="class">オープン</div><div class="rule">（国際）（指定）</div><div class="weight">別定</div><div class="course">コース：1,800メートル（芝・左）</div></div>
</div>`;

const PAST = `<td class="past p1">
  <div class="date_line"><div class="date">2026年9月6日</div><div class="rc">中山</div></div>
  <div class="race_line"><div class="name"><a href="/JRADB/accessS.html?CNAME=pw01sde1006202604010120260906/5A">テストステークス</a></div><div class="r_class"><span class="grade_icon"><img alt="GⅢ"></span></div></div>
  <div class="place_line"><span class="place">2着</span><span class="num"><span class="max">16頭</span><span class="gate">5番</span><span class="pop">3番人気</span></span></div>
  <div class="info_line1"><span class="jockey">騎手 一郎</span><span class="weight">56.0kg</span></div>
  <div class="info_line2"><span class="dist">1800芝</span><span class="time">1:46.8</span><span class="condition">良</span></div>
  <div class="info_line3"><span class="h_weight">482kg</span><ul class="corner_list"><li>5</li><li>5</li><li>4</li><li>3</li></ul><span class="f3">3F 34.6</span></div>
  <div class="fin">テストウィナー<span class="time">(0.1)</span></div>
</td>`;

const CARD = `<html><body>${HEADER}
<div id="syutsuba"><table><tbody>
<tr>
  <td class="waku"><img alt="枠1白"></td>
  <td class="num">1</td>
  <td class="horse">
    <div class="name"><a href="/JRADB/accessU.html?CNAME=pw01dud102021101234/AB">テストホース</a></div>
    <div class="odds"><span class="num">３．４</span><span class="pop_rank">(1番人気)</span></div>
    <p class="result_line"><span class="result">3戦2勝</span></p>
    <p class="trainer"><a>調教師 太郎</a><span class="division">(美浦)</span></p>
    <ul class="family_line"><li class="sire">父：テストサイアー</li><li class="mare">母：テストメア<span class="bloodmare">（母の父：テストダムサイアー）</span></li></ul>
    <div class="h_weight">486(+4)</div>
  </td>
  <td class="jockey"><p class="age">牡4/鹿毛</p><p class="weight">57.0kg</p><p class="jockey"><a onclick="return doAction('/JRADB/accessK.html', 'pw04kmk001234/56');">騎手 一郎</a></p></td>
  ${PAST}
</tr>
<tr>
  <td class="waku"><img alt="枠2黒"></td>
  <td class="num">2</td>
  <td class="horse"><div class="name"><a href="/JRADB/accessU.html?CNAME=pw01dud102022105678/CD">テストセカンド</a></div><div class="odds">取消</div></td>
  <td class="jockey"><p class="age">せん5/栗毛</p><p class="weight">57.0kg</p><p class="jockey"><a>騎手 二郎</a></p></td>
</tr>
</tbody></table></div>
<div id="race_related_link"><div class="odds"><a onclick="return doAction('/JRADB/accessO.html', 'pw151ouS305202604021120261004Z/AB');">オッズ</a></div></div>
</body></html>`;

const RESULT = `<html><body>${HEADER}
<div id="race_result"><table><tbody>
<tr><td class="place">1</td><td class="waku"><img alt="枠3赤"></td><td class="num">5</td><td class="horse"><a href="/x?CNAME=pw01dud102021105555/11">テストウィナー</a></td><td class="age">牡4</td><td class="weight">57.0</td><td class="jockey"><a onclick="doAction('/JRADB/accessK.html','pw04kmk001111/22')">騎手 一郎</a></td><td class="time">1:45.2</td><td class="margin"></td><td class="corner"><ul><li>3</li><li>3</li></ul></td><td class="f_time">33.9</td><td class="h_weight">480(+2)</td><td class="trainer"><a>調教師 太郎</a></td><td class="pop">2</td></tr>
<tr><td class="place">2</td><td class="waku"><img alt="枠1白"></td><td class="num">2</td><td class="horse"><a href="/x?CNAME=pw01dud102021106666/11">テストセカンド</a></td><td class="age">牝3</td><td class="weight">54.0</td><td class="jockey"><a>騎手 二郎</a></td><td class="time">1:45.4</td><td class="margin">1 1/4</td><td class="corner"><ul><li>8</li><li>7</li></ul></td><td class="f_time">33.6</td><td class="h_weight">450(-4)</td><td class="trainer"><a>調教師 花子</a></td><td class="pop">5</td></tr>
<tr><td class="place">3</td><td class="waku"><img alt="枠4青"></td><td class="num">7</td><td class="horse"><a href="/x?CNAME=pw01dud102021107777/11">テストサード</a></td><td class="age">牡5</td><td class="weight">57.0</td><td class="jockey"><a>騎手 三郎</a></td><td class="time">1:45.5</td><td class="margin">1/2</td><td class="corner"><ul><li>1</li><li>1</li></ul></td><td class="f_time">34.4</td><td class="h_weight">500(0)</td><td class="trainer"><a>調教師 次郎</a></td><td class="pop">1</td></tr>
<tr><td class="place">取消</td><td class="waku"><img alt="枠5黄"></td><td class="num">9</td><td class="horse"><a href="/x?CNAME=pw01dud102021109999/11">テストキャンセル</a></td><td class="age">牡4</td><td class="weight">57.0</td><td class="jockey"><a>騎手 四郎</a></td><td class="time"></td><td class="margin"></td><td class="corner"></td><td class="f_time"></td><td class="h_weight"></td><td class="trainer"><a>調教師 三郎</a></td><td class="pop"></td></tr>
</tbody></table></div>
<div class="refund_area"><ul>
  <li class="win"><div class="line"><div class="num">5</div><div class="yen">450円</div></div></li>
  <li class="place"><div class="line"><div class="num">5</div><div class="yen">150円</div></div><div class="line"><div class="num">2</div><div class="yen">210円</div></div><div class="line"><div class="num">7</div><div class="yen">120円</div></div></li>
  <li class="umaren"><div class="line"><div class="num">5-2</div><div class="yen">1,230円</div></div></li>
  <li class="wide"><div class="line"><div class="num">2-5</div><div class="yen">400円</div></div></li>
  <li class="umatan"><div class="line"><div class="num">5-2</div><div class="yen">2,340円</div></div></li>
  <li class="trio"><div class="line"><div class="num">5-2-7</div><div class="yen">1,560円</div></div></li>
  <li class="tierce"><div class="line"><div class="num">5-2-7</div><div class="yen">9,870円</div></div></li>
</ul></div>
<a onclick="return doAction('/JRADB/accessO.html', 'pw151ou1005202604021120261004Z/99')">オッズ</a>
</body></html>`;

const ODDS = `<html><body>${HEADER}<table class="tanpuku"><tbody>
<tr><td class="num">5</td><td class="horse">テストウィナー</td><td class="odds_tan">4.5</td><td class="odds_fuku"><span class="min">1.4</span>-<span class="max">1.9</span></td></tr>
<tr><td class="num">9</td><td class="horse">テストキャンセル</td><td class="odds_tan">取消</td><td class="odds_fuku"></td></tr>
</tbody></table></body></html>`;

test('タイム・日付・CNAME の解釈', () => {
  assert.equal(parseRaceTime('1:35.5'), 95.5);
  assert.equal(parseRaceTime('５９．３'), 59.3);
  assert.equal(parseRaceTime(''), null);
  assert.equal(parseJpDate('2026年7月11日（土曜）'), '2026-07-11');
  const key = raceKeyFromCname('pw01dde0105202604021120261004/C3');
  assert.deepEqual(key, { raceId: '202605040211', courseCode: '05', course: '東京', year: 2026, kai: 4, day: 2, raceNo: 11, date: '2026-10-04' });
  assert.equal(raceKeyFromCname('pw151ouS305202604021120261004Z/AB').raceId, '202605040211');
  assert.equal(raceKeyFromCname('nothing'), null);
  assert.deepEqual(meetingKeyFromCname('pw01srl10082026040120261003/7E'), { courseCode: '08', course: '京都', year: 2026, kai: 4, day: 1, date: '2026-10-03' });
  assert.equal(pathForCname('pw01dde0105202604021120261004/C3'), '/JRADB/accessD.html');
  assert.equal(pathForCname('pw151ouS305202604021120261004Z/AB'), '/JRADB/accessO.html');
  assert.equal(pathForCname('pw01sde1005202604021120261004/D4'), '/JRADB/accessS.html');
});

test('クラスとコースの表記', () => {
  assert.equal(normalizeGrade('GⅠ'), 'G1');
  assert.equal(normalizeGrade('', '3歳以上2勝クラス'), '2勝');
  assert.equal(normalizeGrade('メイクデビュー東京'), '新馬');
  assert.equal(normalizeGrade('リステッド'), 'L');
  assert.equal(normalizeGrade('1000万下'), '2勝');
  assert.deepEqual(
    { ...parseCourse('コース：1,600メートル（ダート・左）'), detail: undefined },
    { distance: 1600, surface: 'ダ', direction: '左', lane: '', detail: undefined },
  );
  const jump = parseCourse('コース：3,000メートル（障害・芝→ダート）');
  assert.equal(jump.surface, '障');
  assert.equal(parseCourse('コース：1,200メートル（芝・右・外）').lane, '外');
});

test('出馬表：見出し・馬・前走', () => {
  const card = parseRaceCard(CARD);
  assert.equal(card.date, '2026-10-04');
  assert.equal(card.course, '東京');
  assert.equal(card.kai, 4);
  assert.equal(card.day, 2);
  assert.equal(card.startTime, '15:45');
  assert.equal(card.raceNo, 11);
  assert.equal(card.name, 'テスト記念');
  assert.equal(card.grade, 'G2');
  assert.equal(card.surface, '芝');
  assert.equal(card.distance, 1800);
  assert.equal(card.going, '良');
  assert.equal(card.weather, '晴');
  assert.equal(card.goings['ダ'], '稍重');
  assert.equal(card.oddsCname, 'pw151ouS305202604021120261004Z/AB');
  const [a, b] = card.entries;
  assert.equal(a.frame, 1);
  assert.equal(a.number, 1);
  assert.equal(a.name, 'テストホース');
  assert.equal(a.horseId, '2021101234');
  assert.equal(a.odds, 3.4);
  assert.equal(a.popularity, 1);
  assert.equal(a.sex, '牡');
  assert.equal(a.age, 4);
  assert.equal(a.weight, 57);
  assert.equal(a.jockey, '騎手 一郎');
  assert.equal(a.jockeyId, '1234');
  assert.equal(a.trainer, '調教師 太郎');
  assert.equal(a.trainerArea, '美浦');
  assert.equal(a.sire, 'テストサイアー');
  assert.equal(a.dam, 'テストメア');
  assert.equal(a.damSire, 'テストダムサイアー');
  assert.equal(a.bodyWeight, 486);
  assert.equal(a.bodyWeightDiff, 4);
  assert.equal(a.scratched, false);
  assert.equal(a.past.length, 1);
  const p = a.past[0];
  assert.equal(p.date, '2026-09-06');
  assert.equal(p.course, '中山');
  assert.equal(p.grade, 'G3');
  assert.equal(p.raceId, '202606040101');
  assert.equal(p.finish, 2);
  assert.equal(p.fieldSize, 16);
  assert.equal(p.number, 5);
  assert.equal(p.popularity, 3);
  assert.equal(p.weight, 56);
  assert.equal(p.distance, 1800);
  assert.equal(p.surface, '芝');
  assert.equal(p.time, 106.8);
  assert.equal(p.going, '良');
  assert.deepEqual(p.passing, [5, 5, 4, 3]);
  assert.equal(p.last3f, 34.6);
  assert.equal(p.margin, 0.1);
  assert.equal(p.winner, 'テストウィナー');
  assert.equal(b.scratched, true);
  assert.equal(b.odds, null);
  assert.equal(b.sex, 'セ');

  const race = cardToRace(card, raceKeyFromCname('pw01dde0105202604021120261004/C3'));
  assert.equal(race.id, '202605040211');
  assert.equal(race.source, 'JRA');
  assert.equal(race.entries[0].past[0].time, 106.8);
});

test('レース結果と払戻', () => {
  const res = parseRaceResult(RESULT);
  assert.equal(res.rows.length, 4);
  const [w, s, , x] = res.rows;
  assert.equal(w.finish, 1);
  assert.equal(w.number, 5);
  assert.equal(w.horseId, '2021105555');
  assert.equal(w.jockeyId, '1111');
  assert.equal(w.time, 105.2);
  assert.deepEqual(w.passing, [3, 3]);
  assert.equal(w.last3f, 33.9);
  assert.equal(w.bodyWeightDiff, 2);
  assert.equal(s.marginText, '1 1/4');
  assert.equal(s.sex, '牝');
  assert.equal(x.finish, 0);
  assert.equal(x.status, '取消');
  assert.deepEqual(res.payouts.win, { 5: 450 });
  assert.deepEqual(res.payouts.place, { 5: 150, 2: 210, 7: 120 });
  assert.deepEqual(res.payouts.quinella, { '2-5': 1230 });
  assert.deepEqual(res.payouts.exacta, { '5>2': 2340 });
  assert.deepEqual(res.payouts.trio, { '2-5-7': 1560 });
  assert.deepEqual(res.payouts.trifecta, { '5>2>7': 9870 });
  assert.equal(res.oddsCname, 'pw151ou1005202604021120261004Z/99');

  const odds = parseOdds(ODDS);
  assert.deepEqual(odds.odds[0], { number: 5, name: 'テストウィナー', odds: 4.5, status: '', placeMin: 1.4, placeMax: 1.9 });
  assert.equal(odds.odds[1].odds, null);
  assert.equal(odds.odds[1].status, '取消');

  const rec = resultToRecord(res, odds, raceKeyFromCname('pw01sde1005202604021120261004/D4'));
  assert.equal(rec.id, '202605040211');
  assert.equal(rec.fieldSize, 3);
  const r5 = rec.runners.find((r) => r.number === 5);
  assert.equal(r5.margin, -0.2); // 勝ち馬は2着との差をマイナスで
  assert.equal(r5.odds, 4.5);
  assert.equal(r5.placeMin, 1.4);
  assert.equal(rec.runners.find((r) => r.number === 7).margin, 0.3);
  assert.equal(rec.runners.find((r) => r.number === 2).last3fRank, 1);
  assert.deepEqual(finishingOrder(rec), [5, 2, 7]);
});

test('開催・レースの一覧と月別ページの CNAME', () => {
  const html = `<a onclick="doAction('/JRADB/accessD.html','pw01drl00052026040220261004/AB')">東京</a>
    <a onclick="doAction('/JRADB/accessS.html','pw01srl10082026040120261003/7E')">京都</a>
    <a onclick="doAction('/JRADB/accessS.html','pw01srl10082026040120261003/7E')">重複</a>`;
  const ms = parseMeetingLinks(html);
  assert.equal(ms.length, 2);
  assert.equal(ms[0].type, 'card');
  assert.equal(ms[0].course, '東京');
  assert.equal(ms[1].type, 'result');
  const list = `pw01dde0105202604021220261004/C1 pw01dde0105202604021120261004/C3 pw01sde1005202604021120261004/D4 pw151ouS305202604021120261004Z/E5`;
  const races = parseRaceLinks(list);
  assert.deepEqual(
    races.map((r) => r.raceNo),
    [11, 12],
  );
  assert.equal(races[0].cardCname, 'pw01dde0105202604021120261004/C3');
  assert.equal(races[0].resultCname, 'pw01sde1005202604021120261004/D4');
  assert.equal(races[0].oddsCname, 'pw151ouS305202604021120261004Z/E5');
  assert.deepEqual(parseMonthParams('objParam["2609"]="7F"; objParam["2610"] = "0A";'), { 2609: '7F', 2610: '0A' });
});

test('馬連・ワイド・3連複のオッズページ', () => {
  const links = parseOddsLinks(
    `doAction('/JRADB/accessO.html','pw153ou1005202604011120261003Z/30') pw154ou1005202604011120261003Z/B4 pw155ou1005202604011120261003Z/38 pw156ou1005202604011120261003Z/BC pw157ou1005202604011120261003Z99/A2 pw157ou1005202604011120261003Z01/BB pw158ou1005202604011120261003Z/C4`,
  );
  assert.deepEqual(links, {
    bracket: 'pw153ou1005202604011120261003Z/30',
    quinella: 'pw154ou1005202604011120261003Z/B4',
    wide: 'pw155ou1005202604011120261003Z/38',
    exacta: 'pw156ou1005202604011120261003Z/BC',
    trio: 'pw157ou1005202604011120261003Z99/A2',
  });
  const umaren = parseExoticOdds(`<h3>馬連オッズ（馬番順）</h3>
    <table class="basic narrow-xy umaren"><caption>1</caption><tbody><tr><th>2</th><td>170.8</td></tr><tr><th>3</th><td><strong class="red">38.6</strong></td></tr><tr><th>4</th><td>&nbsp;</td></tr></tbody></table>
    <table class="basic narrow-xy umaren"><caption>2</caption><tbody><tr><th>3</th><td>12.0</td></tr></tbody></table>
    <table class="basic narrow auto"><caption>発売票数</caption><tbody><tr><th>馬連</th><td>3,534,076</td></tr></tbody></table>`);
  assert.equal(umaren.type, 'quinella');
  assert.deepEqual(umaren.odds, { '1-2': 170.8, '1-3': 38.6, '2-3': 12 });
  const wide = parseExoticOdds(`<h3>ワイドオッズ（馬番順）</h3>
    <table class="basic narrow-xy wide"><caption>1</caption><tbody><tr><th>2</th><td class="odds"><span class="inner"><span class="min">55.5</span><span class="cap">-</span><span class="max">60.8</span></span></td></tr></tbody></table>`);
  assert.equal(wide.type, 'wide');
  assert.deepEqual(wide.odds, { '1-2': 55.5 });
  assert.deepEqual(wide.range, { '1-2': [55.5, 60.8] });
  const trio = parseExoticOdds(`<h3>3連複オッズ（馬番順）</h3>
    <table class="basic narrow-xy fuku3"><caption>1-2</caption><tbody><tr><th>3</th><td>940.0</td></tr><tr><th>4</th><td>550.1</td></tr></tbody></table>
    <table class="basic narrow-xy fuku3"><caption>2-3</caption><tbody><tr><th>4</th><td>3382.1</td></tr></tbody></table>`);
  assert.equal(trio.type, 'trio');
  assert.deepEqual(trio.odds, { '1-2-3': 940, '1-2-4': 550.1, '2-3-4': 3382.1 });
});

test('競走馬情報ページから血統・生年月日・出走履歴を読む', async () => {
  const { parseHorsePage } = await import('../src/collector/jra.js');
  const html = `<html><body><h2>競走馬情報 テストホース Test Horse（JPN） 抹消年月日 2026年8月20日</h2>
  <div class="profile"><div class="data"><ul>
    <li><dl><dt>父</dt><dd>テストサイアー</dd></dl></li>
    <li><dl><dt>性別</dt><dd>牝</dd></dl></li>
    <li><dl><dt>母</dt><dd><a href="#">テストダム</a><span class="sanku"><a href="#">産駒</a></span></dd></dl></li>
    <li><dl><dt>調教師名</dt><dd><a href="#">中竹 和也</a>（栗東）</dd></dl></li>
    <li><dl><dt>母の父</dt><dd><a href="#">テストダムサイアー</a></dd></dl></li>
    <li><dl><dt>生年月日</dt><dd>2023年4月1日</dd></dl></li>
  </ul></div></div>
  <table><tbody><tr>
    <td class="date">2026年8月15日</td><td>中京</td><td class="race"><a href="/JRADB/accessS.html?CNAME=pw01sde1007202602071220260815/5D">3歳未勝利</a></td>
    <td>ダ1200</td><td>良</td><td>16</td><td>9</td><td>6</td><td class="jockey"><a href="#">柴田 裕一郎</a></td><td>53.0</td><td>484</td><td>1:13.0</td><td class="rate"></td><td class="horse">ゴールドアーチ</td>
  </tr></tbody></table></body></html>`;
  const info = parseHorsePage(html);
  assert.equal(info.name, 'テストホース');
  assert.equal(info.sire, 'テストサイアー');
  assert.equal(info.dam, 'テストダム');
  assert.equal(info.damSire, 'テストダムサイアー');
  assert.equal(info.trainer, '中竹 和也');
  assert.equal(info.birth, '2023-04-01');
  assert.equal(info.runs.length, 1);
  assert.equal(info.runs[0].raceId, '202607020712');
  assert.equal(info.runs[0].finish, 6);
  assert.equal(info.runs[0].time, 73);
});

test('当日のレース結果の開催（pw01srl00）と結果ページ（pw01sde01）のリンクも拾う', async () => {
  const { parseMeetingLinks, parseRaceLinks } = await import('../src/collector/jra.js');
  const list = `<a onclick="return doAction('/JRADB/accessS.html', 'pw01srl00082026040120261003/86');">4回東京1日</a>
    <a onclick="return doAction('/JRADB/accessS.html', 'pw01srl10062026040920260927/11');">4回中山9日</a>
    <a onclick="return doAction('/JRADB/accessD.html', 'pw01drl00052026040120261003/EC');">4回東京1日</a>`;
  const meetings = parseMeetingLinks(list);
  assert.deepEqual(meetings.map((m) => [m.type, m.date, m.course]), [['result', '2026-10-03', '京都'], ['result', '2026-09-27', '中山'], ['card', '2026-10-03', '東京']]);
  const races = parseRaceLinks(`doAction('/JRADB/accessD.html', 'pw01dde0105202604010120261003/AA'); doAction('/JRADB/accessS.html', 'pw01sde0105202604010120261003/BB'); doAction('/JRADB/accessO.html', 'pw151ouS305202604010120261003Z/CC');`);
  assert.equal(races.length, 1);
  assert.equal(races[0].resultCname, 'pw01sde0105202604010120261003/BB');
  assert.equal(races[0].cardCname, 'pw01dde0105202604010120261003/AA');
  assert.equal(races[0].oddsCname, 'pw151ouS305202604010120261003Z/CC');
});
