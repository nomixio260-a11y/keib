#!/usr/bin/env node
// 学習に使っていない直近の実レース（JRA）で、予想と買い方の成績を検証する。払戻は実際の金額。
//
//   npm run evaluate            … 結果を表示し、src/data/realBacktest.js（画面のバックテスト用）を更新
//   npm run evaluate -- --dry   … 表示だけ
//
// 統計（基準タイム・騎手成績など）も検証期間より前のデータだけで作り直すので、未来の情報は混ざらない。

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHistory, statsForEngine, usable, PERIODS, horseInfoOnce } from './calibrate.mjs';
import { attachFinalExoticOdds } from '../src/collector/store.js';
import { indexHistory, preRaceCard, attachCareer } from '../src/data/history.js';
import { GBDT_READY } from '../src/engine/gbdt.js';
import { runBacktest } from '../src/engine/backtest.js';
import { PRESETS } from '../src/engine/model.js';
import { AUTO_STAKE } from '../src/engine/bets.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pct = (v) => `${(v * 100).toFixed(1)}%`;

const all = await loadHistory();
const index = indexHistory(all);
const horseInfo = await horseInfoOnce();
const stats = statsForEngine(
  all.filter((r) => r.date < PERIODS.testStart),
  all,
);
const test = all.filter((r) => r.date >= PERIODS.testStart && usable(r)).map((r) => preRaceCard(r, index));
if (!test.length) {
  console.error('検証用のレースがありません');
  process.exit(1);
}
const withExotic = await attachFinalExoticOdds(test);
// 機械学習の特徴量用：各馬の通算要約（そのレースより前の出走だけ）
attachCareer(test, index, { stats });
const period = `${test[0].date}〜${test[test.length - 1].date}`;
console.log(`検証期間 ${period}（${test.length}レース、平地のみ。馬連・ワイド・3連複の確定オッズあり ${withExotic}レース）`);

const out = { period, races: test.length, withExotic, source: 'JRA', generatedAt: new Date().toISOString().slice(0, 10), presets: {} };
for (const key of GBDT_READY ? ['ml', 'balance', 'ai'] : ['balance', 'ai']) {
  const preset = PRESETS[key];
  const res = await runBacktest(test, { weights: preset.weights, noise: preset.noise, stats, ml: !!preset.ml, mlAi: !!preset.mlAi, blend: process.env.EVAL_BLEND != null ? Number(process.env.EVAL_BLEND) : undefined }, { sims: 0 });
  console.log(`\n■ ${preset.label}`);
  console.log(`  ◎      勝率 ${pct(res.ai.winRate)}  連対率 ${pct(res.ai.top2Rate)}  複勝率 ${pct(res.ai.top3Rate)}  対数損失 ${res.ai.logLoss.toFixed(3)}`);
  console.log(`  1番人気 勝率 ${pct(res.fav.winRate)}  連対率 ${pct(res.fav.top2Rate)}  複勝率 ${pct(res.fav.top3Rate)}  対数損失 ${res.fav.logLoss.toFixed(3)}`);
  for (const s of res.strategies) {
    console.log(`  ${s.label.padEnd(18, '　')} 購入 ${String(s.bets).padStart(5)}点  的中率 ${pct(s.hitRate).padStart(6)}  回収率 ${pct(s.roi).padStart(6)}  最高払戻 ${s.maxPay.toLocaleString('ja-JP')}円`);
  }
  console.log('  自信度ごとの◎（レース数・勝率・複勝率・単勝回収率・複勝回収率）');
  for (const [g, v] of Object.entries(res.byGrade)) if (v.n) console.log(`    ${g}: ${String(v.n).padStart(4)}R  ${pct(v.winRate).padStart(6)}  ${pct(v.top3Rate).padStart(6)}  ${pct(v.winRoi).padStart(6)}  ${pct(v.placeRoi).padStart(6)}`);
  console.log('  荒れ度ごと（レース数・予測した人気3頭以外の勝率 → 実際・1番人気の勝率・◎の勝率・単勝◎の回収率・勝ち馬の単勝払戻の平均）');
  for (const [g, v] of Object.entries(res.byVolatility || {})) if (v.n) console.log(`    ${g}: ${String(v.n).padStart(4)}R  ${pct(v.predUpsetRate).padStart(6)} → ${pct(v.upsetRate).padStart(6)}  1番人気 ${pct(v.favWinRate).padStart(6)}  ◎ ${pct(v.winRate).padStart(6)}  単勝◎ ${pct(v.winRoi).padStart(6)}  払戻 ${Math.round(v.meanWinnerPay).toLocaleString('ja-JP')}円`);
  if (key === 'ml' || (key === 'balance' && !GBDT_READY)) {
    console.log('  キャリブレーション（予測勝率 → 実際の勝率）');
    for (const b of res.calibration.ai) if (b.n) console.log(`    ${pct(b.lo)}〜${pct(Math.min(1, b.hi))}: 予測 ${pct(b.sumP / b.n)} 実際 ${pct(b.wins / b.n)} (${b.n}頭)`);
  }
  // 画面用：曲線は間引いて保存
  const step = Math.max(1, Math.ceil(res.races / 200));
  out.presets[key] = {
    label: preset.label,
    ai: res.ai,
    fav: res.fav,
    byGrade: res.byGrade,
    byVolatility: res.byVolatility,
    calibration: res.calibration,
    strategies: res.strategies.map((s) => ({ ...s, curve: s.curve.filter((_, i) => i % step === step - 1 || i === s.curve.length - 1) })),
    curveStep: step,
  };
}

// 発走前のオッズで選んだ場合（推定）：上の検証は確定オッズ（発走後に決まる）で買い目を選んでいる。実際に買う時点のオッズは
// 確定オッズからずれるので、記録したオッズの推移（data/odds）から取った「その時点 → 確定」のずれを確定オッズに足して予想し直し、
// 乱数を変えて EVAL_DRIFT_SEEDS 回。精算は実際の払戻（払戻は確定オッズで決まる）。買う時刻ごとに（EVAL_DRIFT_TIMES、分）：
// 1 = 発走1分前より前の最後の更新（「直前」。画面の買い目と発走前の記録はこの時点）、10 = 発走10分前、60 = 発走60分前（早めに買う場合）。
// 10・60 は画面では買い目を出さない時刻（発走 freshMin 分前より古いオッズ）なので、古いオッズでも買った場合の推定
{
  const { loadDrift } = await import('./lib/drift.mjs');
  const { makePerturber, driftSummary } = await import('../src/engine/oddsDrift.js');
  const times = (process.env.EVAL_DRIFT_TIMES || process.env.EVAL_DRIFT_MIN || '1,10,60').split(',').map(Number).filter((m) => m > 0);
  const seeds = Number(process.env.EVAL_DRIFT_SEEDS || 3);
  const key = out.presets.ml ? 'ml' : 'balance';
  const label = (m) => (m <= 1 ? '直前（発走前の最後の更新）' : `発走${m}分前`);
  const sumDaily = (daily) => {
    const bet = daily.filter((d) => d.races > 0);
    const t = (k) => bet.reduce((a, d) => a + d[k], 0);
    return { races: t('races'), hits: t('hits'), stake: t('stake'), pay: t('pay'), days: daily.length, betDays: bet.length, loseDays: bet.filter((d) => d.pay < d.stake).length, worst: bet.length ? Math.min(...bet.map((d) => d.pay - d.stake)) : 0 };
  };
  const pack = (r) => ({ ...r, profit: r.pay - r.stake, roi: r.stake ? r.pay / r.stake : null, hitRate: r.races ? r.hits / r.races : null });
  const line = (name, r) => `  ${name}：買ったレース ${Math.round(r.races)}・的中率 ${pct(r.hitRate)}・回収率 ${pct(r.roi)}・収支 ${Math.round(r.profit).toLocaleString('ja-JP')}円・負けた日 ${r.loseDays.toFixed?.(1) ?? r.loseDays}/${Math.round(r.betDays)}日`;
  const finalAi = out.presets[key]?.strategies.find((x) => x.key === 'ai');
  const fin = finalAi ? pack(sumDaily(finalAi.daily || [])) : null;
  const byTime = [];
  for (const minutes of times) {
    const drift = await loadDrift(all, index, minutes);
    if (drift.near < drift.races * 0.8) console.log(`\n注意：発走${minutes}分前の30分以内の記録があるのは ${drift.near}/${drift.races}レースだけです（data/odds が古い。data ブランチの odds/ を data/odds にコピーするか KEIB_ODDS_DIR で指定）`);
    if (!(drift.samples.length >= 100 && drift.near >= drift.races * 0.8 && out.presets[key])) {
      console.log(`\n（${label(minutes)}：オッズの推移の記録が少ないので省略：${drift.samples.length}頭）`);
      continue;
    }
    const perturb = makePerturber(drift.samples);
    const preset = PRESETS[key];
    const runs = [];
    for (let k = 1; k <= seeds; k++) {
      // oddsBefore：発走の何分前のオッズか（参加の買い目は、発走 freshMin 分前より後のオッズのときだけ。bets.js の oddsFresh）。
      // 画面は発走 freshMin 分前より古いオッズでは買い目を「仮」にして金額を出さない（AUTO_STAKE.freshOnly）。その時刻の行は、
      // 古いオッズでも買った場合（freshOnly なし）の推定（古いオッズで買わない理由を示すため）
      const cards = test.map((c) => ({ ...perturb(c, `${c.id}|${k}`), oddsBefore: minutes }));
      const stale = minutes > AUTO_STAKE.freshMin;
      const res = await runBacktest(cards, { weights: preset.weights, noise: preset.noise, stats, ml: !!preset.ml, mlAi: !!preset.mlAi, ...(stale ? { rule: { ...AUTO_STAKE, freshOnly: false } } : {}) }, { sims: 0 });
      const ai = res.strategies.find((x) => x.key === 'ai');
      runs.push(sumDaily(ai.daily || []));
    }
    const avg = (f) => runs.reduce((a, r) => a + f(r), 0) / runs.length;
    const est = pack({ races: avg((r) => r.races), hits: avg((r) => r.hits), stake: avg((r) => r.stake), pay: avg((r) => r.pay), days: runs[0].days, betDays: avg((r) => r.betDays), loseDays: avg((r) => r.loseDays), worst: avg((r) => r.worst) });
    byTime.push({ minutes, label: label(minutes), stale: minutes > AUTO_STAKE.freshMin, seeds, drift: { ...driftSummary(drift.samples), races: drift.races, days: drift.days }, final: fin, estimate: est, runs: runs.map(pack) });
    console.log(`\n■ ${label(minutes)}のオッズで選んだ場合（推定。オッズの推移 ${drift.races}レース・${drift.days}日・${drift.samples.length}頭のずれ、乱数 ${seeds}通り）`);
    if (fin) console.log(line('確定オッズ（上の検証）', fin));
    for (const [k, r] of runs.entries()) console.log(line(`${label(minutes)}（乱数${k + 1}）`, pack(r)));
    console.log(line(`${label(minutes)}（平均）`, est));
  }
  // 画面の「発走前のオッズで選んだ場合」：直前を先頭に（なければ最初の時刻）
  if (byTime.length) {
    const main = byTime.find((x) => x.minutes <= 1) || byTime[0];
    out.realistic = main;
    out.realisticByTime = byTime;
  }
}

// README 用の表（Markdown）
{
  const b = out.presets.ml || out.presets.balance;
  const mainLabel = out.presets.ml ? '機械学習（既定）' : '総合（既定）';
  const lines = [];
  lines.push(`検証期間 ${period}・${test.length.toLocaleString('ja-JP')}レース（平地。モデルの学習にも統計にも使っていない期間）。払戻は実際の金額、1点100円。`, '');
  lines.push('| | ◎の勝率 | ◎の複勝率 | 勝ち馬の対数損失（小さいほど良い） |', '| --- | --- | --- | --- |');
  if (out.presets.ml) lines.push(`| 機械学習（AI＋人気、既定） | ${pct(out.presets.ml.ai.winRate)} | ${pct(out.presets.ml.ai.top3Rate)} | ${out.presets.ml.ai.logLoss.toFixed(3)} |`);
  lines.push(`| 総合（線形モデル、AI＋人気） | ${pct(out.presets.balance.ai.winRate)} | ${pct(out.presets.balance.ai.top3Rate)} | ${out.presets.balance.ai.logLoss.toFixed(3)} |`);
  lines.push(`| AI単独（オッズを使わない） | ${pct(out.presets.ai.ai.winRate)} | ${pct(out.presets.ai.ai.top3Rate)} | ${out.presets.ai.ai.logLoss.toFixed(3)} |`);
  lines.push(`| 1番人気（単勝オッズ） | ${pct(b.fav.winRate)} | ${pct(b.fav.top3Rate)} | ${b.fav.logLoss.toFixed(3)} |`, '');
  lines.push(`| 自信度（${mainLabel}） | レース数 | ◎の勝率（予測 → 実際） | ◎の複勝率（予測 → 実際） | 単勝◎の回収率 | 複勝◎の回収率 |`, '| --- | --- | --- | --- | --- | --- |');
  for (const [g, v] of Object.entries(b.byGrade)) if (v.n) lines.push(`| ${g} | ${v.n} | ${pct(v.predWinRate || 0)} → ${pct(v.winRate)} | ${pct(v.predPlaceRate || 0)} → ${pct(v.top3Rate)} | ${pct(v.winRoi)} | ${pct(v.placeRoi)} |`);
  lines.push('');
  lines.push(`| 荒れ度（${mainLabel}） | レース数 | 人気3頭以外が勝つ確率（予測 → 実際） | 1番人気の勝率 | ◎の勝率 | 単勝◎の回収率 | 勝ち馬の単勝払戻（平均） |`, '| --- | --- | --- | --- | --- | --- | --- |');
  for (const [g, v] of Object.entries(b.byVolatility || {})) if (v.n) lines.push(`| ${g} | ${v.n} | ${pct(v.predUpsetRate)} → ${pct(v.upsetRate)} | ${pct(v.favWinRate)} | ${pct(v.winRate)} | ${pct(v.winRoi)} | ${Math.round(v.meanWinnerPay).toLocaleString('ja-JP')}円 |`);
  lines.push('');
  lines.push(`| 買い方（${mainLabel}） | 購入点数 | 的中率 | 回収率 |`, '| --- | --- | --- | --- |');
  for (const st of b.strategies) lines.push(`| ${st.label} | ${st.bets.toLocaleString('ja-JP')} | ${pct(st.hitRate)} | ${pct(st.roi)} |`);
  console.log(`\n--- README 用 ---\n${lines.join('\n')}\n--- ここまで ---`);
}

if (!process.argv.includes('--dry')) {
  const header = '// scripts/evaluate.mjs が実際のレース結果（JRA）で検証した結果。手で編集しないでください。\n';
if (process.env.EVAL_NO_WRITE === '1') {
  console.log('EVAL_NO_WRITE=1：src/data/realBacktest.js は書き換えません');
} else {
  await writeFile(path.join(root, 'src/data/realBacktest.js'), `${header}export const REAL_BACKTEST = ${JSON.stringify(out)};\n`);
  console.log('\n書き出しました：src/data/realBacktest.js');
}
}
