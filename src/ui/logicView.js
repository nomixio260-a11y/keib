// ロジック画面：予想の仕組みの説明

import { PAYOUT_RATE, BET_LABEL } from '../engine/constants.js';
import { FACTORS, NOISE_BASE, PRESETS, DEFAULT_PRESET } from '../engine/model.js';
import { CALIBRATION } from '../engine/calibration.js';
import { REAL_STATS } from '../engine/realStats.js';
import { esc } from './format.js';

export function renderLogic(ctx) {
  const { state } = ctx;
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
      <li><b>AI指数にまとめる</b><span>重み付けして1つの能力スコアに</span></li>
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
        <p>各馬の当日の走りを「能力スコア + 正規分布の揺らぎ」として、設定した回数（既定2万回）レースを走らせます。揺らぎの大きさは、過去走の成績が安定している馬ほど小さく、出走数が少ない馬・初めての芝ダートの馬ほど大きくしています（基準 ${esc(NOISE_BASE)}）。着順の集計から勝率・連対率・複勝率、そして馬連や三連単などすべての組み合わせの確率がまとめて出ます。</p>
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
      <section class="logic-sec">
        <h2>7. データと更新</h2>
        <p>出馬表・オッズ・結果・払戻は JRA 公式サイトの公開情報です。リアルタイム版（<code>npm run server</code>）は、発走が近いレースほど短い間隔（2分〜30分）で出馬表とオッズを取り直し、発走から10分ほどで結果と払戻を取り込みます。画面は1分ごとに最新のデータを読み直します。確定したレースは、予想と実際の着順・払戻を並べて答え合わせできます。</p>
      </section>
    </div>
    <section class="note-box">
      <h2>ご注意</h2>
      <ul>
        <li>予想は参考情報です。的中や利益を保証するものではありません。馬券の購入は20歳になってから、無理のない範囲で楽しみましょう。</li>
        <li>データは JRA 公式サイトの公開情報を個人の分析用に取得したものです。オッズは取得した時点の値で、発売中の最新オッズや確定オッズとは異なることがあります。馬券を買う前に必ず公式の情報を確認してください。</li>
        <li>単勝以外の推定オッズは単勝オッズからの推定値で、実際のオッズとは異なります。</li>
      </ul>
    </section>`;
}
