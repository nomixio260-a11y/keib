// ロジック画面：予想の仕組みの説明

import { PAYOUT_RATE, BET_LABEL } from '../engine/constants.js';
import { FACTORS, PRESETS, DEFAULT_PRESET, tempsFor, VOLATILITY_CUTS } from '../engine/model.js';
import { CALIBRATION } from '../engine/calibration.js';
import { REAL_STATS } from '../engine/realStats.js';
import { GBDT_READY, GBDT_INFO } from '../engine/gbdt.js';
import { FEATURE_NAMES } from '../engine/features.js';
import { esc, pct } from './format.js';
import { REAL_BACKTEST } from '../data/realBacktest.js';

/** 機械学習（勾配ブースティング）の説明。モデルがあるときだけ */
function mlSection() {
  if (!GBDT_READY || !GBDT_INFO) return '';
  const t = GBDT_INFO.test || {};
  const tr = GBDT_INFO.trainedOn || {};
  const pctOf = (v) => `${((v || 0) * 100).toFixed(1)}%`;
  return `<section class="logic-sec">
        <h2>7. 機械学習（決定木のブースティング）</h2>
        <p>「機械学習」の重み付けでは、単勝オッズの対数確率を出発点にして、<strong>オッズにまだ織り込まれていない分だけ</strong>を決定木の集まり（勾配ブースティング）が学びます。特徴量は上のファクターに加えて、前走までのスピード指数の推移、通算成績、対戦成績の評価（相手の強さを考慮した着順の評価）、複勝オッズと単勝オッズのずれなど ${FEATURE_NAMES.length}項目で、すべて発走前にわかる情報です。設定（木の深さ・学習率・正則化・使う特徴量）は学習期間の中の交差検証で選び、検証期間の成績は最後に一度だけ確認しています。</p>
        <p>学習 ${esc(tr.from || '')}〜${esc(tr.to || '')}（${(tr.races || 0).toLocaleString('ja-JP')}レース）、木 ${esc(GBDT_INFO.params?.rounds || 0)}本。学習に使っていない ${esc(t.from || '')} 以降の ${esc(t.races || 0)}レースでは、勝ち馬の対数損失が単勝オッズだけの ${(-(t.baseLL || 0)).toFixed(3)} から ${(-(t.ll || 0)).toFixed(3)} に、◎の勝率が ${pctOf(t.baseTop1)} から ${pctOf(t.top1)} になりました。差はわずかです。オッズには大勢の予想がすでに織り込まれていて、公開情報から上積みできる分は小さいためです。</p>
      </section>`;
}

export function renderLogic(ctx) {
  const { state } = ctx;
  const vb = REAL_BACKTEST?.presets?.[DEFAULT_PRESET] || REAL_BACKTEST?.presets?.balance || null;
  const nStats = REAL_STATS.races ? REAL_STATS.races.toLocaleString('ja-JP') : '—';
  const nFit = CALIBRATION.trainedOn ? CALIBRATION.trainedOn.toLocaleString('ja-JP') : '—';
  const statsPeriod = REAL_STATS.from ? `${REAL_STATS.from}〜${REAL_STATS.to}` : '';
  const fitPeriod = CALIBRATION.period?.fit || '';
  const factorRows = FACTORS.map(
    (f) =>
      `<tr><th>${esc(f.label)}</th><td>${esc(f.desc)}</td><td class="num">${esc(state.weights[f.key])}</td><td class="num">${esc(PRESETS.balance.weights[f.key])}</td><td class="num">${esc(PRESETS.ai.weights[f.key])}</td></tr>`,
  ).join('');
  const rateRows = Object.entries(PAYOUT_RATE)
    .map(([k, v]) => `<tr><th>${esc(BET_LABEL[k])}</th><td class="num">${(v * 100).toFixed(1)}%</td></tr>`)
    .join('');
  return `<div class="view-intro">
      <h1 class="view-title">予想のしくみ</h1>
      <p>KEIB は、JRAの出馬表（前4走の馬柱・騎手・斤量・単勝オッズ）から能力と適性を数値にし、レースを何万回もシミュレーションして各馬の勝率を出します。そのうえで、オッズと比べて「期待値」の高い馬券を選びます。基準タイム・騎手成績・枠順傾向・予想の重みは、すべて実際のレース結果（JRA ${esc(nStats)}レース${statsPeriod ? `、${esc(statsPeriod)}` : ''}）から計算しています。架空のデータは使っていません。</p>
    </div>
    <ol class="flow">
      <li><b>出馬表を読む</b><span>前4走の走破タイム・着順・着差・上がり・通過順・騎手・馬場など</span></li>
      <li><b>ファクターを計算</b><span>スピード指数や適性など9項目</span></li>
      <li><b>能力スコアにまとめる</b><span>重み付けして1つに（AI指数はオッズを使わない評価）</span></li>
      <li><b>シミュレーション</b><span>揺らぎを加えて何万回も走らせる</span></li>
      <li><b>期待値で買い目を選ぶ</b><span>確率 × オッズで判断</span></li>
    </ol>
    <div class="logic-grid">
      <section class="logic-sec">
        <h2>1. スピード指数</h2>
        <p>走破タイムを、競馬場・芝ダート・距離・馬場状態ごとの基準タイムと比べて数値にします。基準タイムは実際のレース結果から、条件ごとに「2勝クラス・良馬場の勝ち時計」に相当する値を推定したもので（競馬場×距離の基準・馬場差・クラス差を同時に当てはめ）、80 が2勝クラスの勝ち馬の水準です。地方・海外のレースは馬場が違うため指数を出しません。</p>
        <pre class="formula">指数 = 80 + 1000 ×（基準タイム − 走破タイム）÷ 基準タイム
      + 2 ×（斤量 − 55）</pre>
        <p>1600m なら 0.1秒 ≒ 1ポイントです。芝は道悪で時計がかかり、ダートは雨で速くなるので、馬場差も実データから推定しています。予想では、条件（芝ダ・距離）が近い走と直近の走を重く見て平均し、今回の斤量に合わせて直します。上がり3ハロンも、同じ条件の上がりの中央値と比べて評価します。</p>
      </section>
      <section class="logic-sec">
        <h2>2. ファクターと重み</h2>
        <div class="table-scroll"><table class="col-table factor-table">
          <thead><tr><th>ファクター</th><th>内容</th><th>現在</th><th>総合</th><th>AI単独</th></tr></thead>
          <tbody>${factorRows}</tbody>
        </table></div>
        <p>各ファクターはレース内で中心化し、全レース共通の物差しで標準化してから重みを掛けて足します。既定の重みは、実際のレース（JRA）${esc(nFit)}レース${fitPeriod ? `（${esc(fitPeriod)}）` : ''}で「1〜3着の順番を最もよく説明する」ように推定したものです（プラケット・ルース尤度の最大化）。学習では各レースの時点で手に入る情報だけを使い、統計もそのレースより前のデータで作っています。</p>
        <p>「総合」はAIの各ファクターと単勝オッズを同時に当てはめた重みで、オッズにまだ織り込まれていない情報だけがAI側の重みとして残ります。「AI単独」はオッズを使わない重みです。既定は${esc(PRESETS[DEFAULT_PRESET].label)}です。</p>
      </section>
      <section class="logic-sec">
        <h2>3. 展開予想</h2>
        <p>過去走の通過順から脚質（逃げ・先行・差し・追込）と先行力を推定し、逃げ・先行馬の数からペースを予想します。速いペースなら差し・追込、遅いペースなら前に行く馬が有利です。直線の短いコース（中山・小倉・福島など）は先行有利、長いコース（東京・新潟外回りなど）は末脚のある馬に向きます。逃げ馬が1頭だけのときは「単騎逃げ」として加点します。</p>
      </section>
      <section class="logic-sec">
        <h2>4. モンテカルロ・シミュレーション</h2>
        <p>重みを推定したのと同じプラケット・ルース（多項ロジット）モデルで、1着から順に着順を引いてレースを設定した回数（既定2万回）走らせます。1着になる確率は「exp(能力スコア ÷ 温度)」に比例し、2着・3着は残りの馬で同じように決めます。着順ごとの温度（紛れの大きさ）も実際のレースで推定していて、2着・3着は1着より紛れが大きく出ます（いまの設定では ${tempsFor(state.weights, state.noise).map((t) => t.toFixed(2)).join(' / ')}）。着順の集計から勝率・連対率・複勝率、そして馬連や三連単などすべての組み合わせの確率がまとめて出ます。</p>
      </section>
      <section class="logic-sec">
        <h2>5. 期待値と推定オッズ</h2>
        <pre class="formula">期待値 = 的中確率 × オッズ</pre>
        <p>期待値が1.0を超える馬券は、理論上は長く買い続けるとプラスになります。単勝は入力されたオッズをそのまま使い、複勝・馬連・ワイド・馬単・三連複・三連単は、単勝オッズから割引ハーヴィル式で市場の確率を推定し、JRAの払戻率で割って「推定オッズ」を出します。</p>
        <div class="table-scroll"><table class="col-table rate-table"><thead><tr><th>券種</th><th>払戻率</th></tr></thead><tbody>${rateRows}</tbody></table></div>
      </section>
      <section class="logic-sec">
        <h2>6. 買い目と資金配分</h2>
        <p>「的中重視」は当たりやすい買い目を選び、どれが当たっても払戻がそろうように配分します。「バランス」と「高配当」は期待値の条件を満たす買い目から選び、ケリー基準（有利さに比例）で配分します。どの戦略でも、シミュレーションの全結果に買い目を当てはめて、的中率・期待回収率・プラス収支になる確率を計算しています。</p>
      </section>
      ${mlSection()}
      <section class="logic-sec">
        <h2>${GBDT_READY ? 8 : 7}. データと更新</h2>
        <p>出馬表・オッズ・結果・払戻は JRA 公式サイトの公開情報です。リアルタイム版（<code>npm run server</code>）は、発走が近いレースほど短い間隔（2分〜30分）で出馬表とオッズを取り直し、発走から10分ほどで結果と払戻を取り込みます。画面は1分ごとに最新のデータを読み直します。確定したレースは、予想と実際の着順・払戻を並べて答え合わせできます。</p>
      </section>
    </div>
    <section class="note-box">
      <h2>荒れ度（堅い・普通・荒れ）</h2>
      <p>レースごとに「人気3頭（単勝オッズ順）以外が勝つ確率」をモデルの勝率から計算し、学習期間の3分位（${(VOLATILITY_CUTS[0] * 100).toFixed(0)}%・${(VOLATILITY_CUTS[1] * 100).toFixed(0)}%）で 堅い・普通・荒れ に分けています。検証期間（887レース）では、この確率は実際の頻度とよく合い（堅い：予測 20% → 実際 18%、荒れ：47% → 42%）、1番人気の勝率は 堅い 50%・荒れ 26% と大きく違います。市場（オッズだけ）から同じ確率を出すより当てはまりがわずかに良く（二値の対数損失 0.600 対 0.602）、「荒れ」のレースで無理に単勝を買わない、といった使い方を想定しています。レースの条件（頭数・クラス・距離・馬場・人気の散らばりなど）からレースごとの「温度」を推定してモデルの確率を伸縮させる案も試しましたが、確率はすでに合っていて効果がありませんでした（<code>scripts/race-temp.mjs</code>）。</p>
    </section>
    <section class="note-box">
      <h2>◎の勝率はなぜ 4割弱なのか</h2>
      <p>競馬は1レースに10頭以上が走り、いちばん人気の馬でも勝つのは3回に1回ほどです（JRA 全体でおよそ33%${vb ? `。検証期間の${REAL_BACKTEST.races}レースでは ${pct(vb.fav.winRate)}` : ''}）。単勝オッズには大勢の人の予想が織り込まれていて、公開されている情報だけでそれを大きく上回ることはできません。KEIB の◎も学習に使っていない期間で${vb ? ` ${pct(vb.ai.winRate)}` : ''}と、1番人気と同じ水準です${vb && vb.ai.logLoss < vb.fav.logLoss ? `（勝ち馬の確率の当てはまり＝対数損失では ${vb.ai.logLoss.toFixed(3)} と、オッズだけの ${vb.fav.logLoss.toFixed(3)} をわずかに上回ります）` : ''}。</p>
      <p>ですから「勝率を上げる」より、<strong>どのレースなら当たりやすいかを見分ける</strong>ことに意味があります。自信度（S/A/B/C）は◎の勝率と2番手との差から決めていて、同じ自信度のときに実際に◎がどれだけ勝ったか（複勝率も）を本命のタイルに表示しています。自信度が高いレースだけに絞れば的中率は上がりますが、その分オッズも低く、長期的に回収率100%を超えるのは難しいことに変わりはありません。</p>
    </section>
    <section class="note-box">
      <h2>ご注意</h2>
      <ul>
        <li>予想は参考情報です。的中や利益を保証するものではありません。馬券の購入は20歳になってから、無理のない範囲で楽しみましょう。</li>
        <li>データは JRA 公式サイトの公開情報を個人の分析用に取得したものです。オッズは取得した時点の値で、発売中の最新オッズや確定オッズとは異なることがあります。馬券を買う前に必ず公式の情報を確認してください。</li>
        <li>単勝以外の推定オッズは単勝オッズからの推定値で、実際のオッズとは異なります。</li>
      </ul>
    </section>`;
}
