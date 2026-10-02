#!/usr/bin/env node
// 学習に使っていない架空レースでバックテストし、予想と買い方の成績を表示する。
//   npm run evaluate            … 300レース
//   RACES=1000 npm run evaluate

import { generateBacktestRaces } from '../src/data/generator.js';
import { SIRE_MAP } from '../src/data/names.js';
import { DEFAULT_WEIGHTS, PRESETS } from '../src/engine/model.js';
import { runBacktest } from '../src/engine/backtest.js';

const RACES = Number(process.env.RACES || 300);
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const races = generateBacktestRaces(RACES, 777);

for (const [key, preset] of Object.entries({ balance: { label: 'バランス', weights: DEFAULT_WEIGHTS }, popular: PRESETS.popular })) {
  const res = await runBacktest(races, { weights: preset.weights, sires: SIRE_MAP }, { sims: 3000 });
  console.log(`\n■ ${preset.label}（${res.races}レース）`);
  console.log(`  ◎      勝率 ${pct(res.ai.winRate)}  連対率 ${pct(res.ai.top2Rate)}  複勝率 ${pct(res.ai.top3Rate)}  対数損失 ${res.ai.logLoss.toFixed(3)}`);
  console.log(`  1番人気 勝率 ${pct(res.fav.winRate)}  連対率 ${pct(res.fav.top2Rate)}  複勝率 ${pct(res.fav.top3Rate)}  対数損失 ${res.fav.logLoss.toFixed(3)}`);
  for (const s of res.strategies) {
    console.log(`  ${s.label.padEnd(18, '　')} 購入 ${String(s.bets).padStart(4)}点  的中率 ${pct(s.hitRate).padStart(6)}  回収率 ${pct(s.roi).padStart(6)}`);
  }
  if (key === 'balance') {
    console.log('  キャリブレーション（予測勝率 → 実際の勝率）');
    for (const b of res.calibration.ai) if (b.n) console.log(`    ${pct(b.lo)}〜${pct(Math.min(1, b.hi))}: 予測 ${pct(b.sumP / b.n)} 実際 ${pct(b.wins / b.n)} (${b.n}頭)`);
  }
}
