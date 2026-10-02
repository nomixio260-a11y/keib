// データ画面：CSV / JSON の取り込みと書き出し

import { COURSE_NAMES, GOINGS, GRADES, gradeLabel } from '../engine/constants.js';
import { REAL_STATS } from '../engine/realStats.js';
import { CALIBRATION } from '../engine/calibration.js';
import { esc } from './format.js';
import { dayLabel } from './timeline.js';

const stamp = (iso) => {
  if (!iso) return '—';
  const d = new Date(Date.parse(iso) + 9 * 3600 * 1000).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)}`;
};

/** 実データの出どころと更新状況 */
function sourcePanel(ctx) {
  const { bundle, loadState, loadError, lastFetch, live } = ctx;
  const days = bundle?.days || [];
  const rows = days
    .map((d) => {
      const res = d.races.filter((r) => r.status === 'result').length;
      return `<tr><td class="num">${esc(dayLabel(d.date))}</td><td>${esc((d.venues || []).join('・'))}</td><td class="num">${d.races.length}</td><td class="num">${res}</td></tr>`;
    })
    .join('');
  const state =
    loadState === 'ok'
      ? `<p class="src-state is-ok"><span class="live-dot${live ? ' is-live' : ''}"></span>JRA公式サイトのデータ（${esc(stamp(bundle.generatedAt))} 時点・${esc(stamp(bundle.checkedAt || bundle.generatedAt))} 確認）${live ? '・1分ごとに自動更新' : ''}</p>`
      : loadState === 'loading'
        ? '<p class="src-state">読み込み中…</p>'
        : `<p class="src-state is-bad">実データを読み込めませんでした。${esc(loadError || '')}</p>`;
  return `<section class="panel source-panel">
    <header class="panel-head"><h2>実データ</h2><span class="panel-sub">出馬表・オッズ・結果・払戻（JRA）</span></header>
    ${state}
    ${rows ? `<div class="table-scroll"><table class="col-table src-table"><thead><tr><th>開催日</th><th>競馬場</th><th>レース</th><th>確定</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
    <dl class="bet-stats src-stats">
      <div><dt>統計の元データ</dt><dd class="num">${REAL_STATS.races ? `${REAL_STATS.races.toLocaleString('ja-JP')}レース` : '—'}</dd></div>
      <div><dt>期間</dt><dd class="num">${REAL_STATS.from ? `${esc(REAL_STATS.from)}〜${esc(REAL_STATS.to)}` : '—'}</dd></div>
      <div><dt>重みの学習</dt><dd class="num">${CALIBRATION.trainedOn ? `${CALIBRATION.trainedOn.toLocaleString('ja-JP')}レース` : '—'}</dd></div>
      <div><dt>最終確認</dt><dd class="num">${esc(lastFetch ? stamp(lastFetch) : '—')}</dd></div>
    </dl>
    <div class="panel-actions wrap">
      <button type="button" class="btn" data-action="reload-data">最新にする</button>
      <label class="file-btn">バンドル（JSON）を開く<input type="file" accept=".json,application/json" data-bundle-file></label>
    </div>
    <p class="panel-note">基準タイム・騎手成績・枠順傾向などの統計と、予想の重みは、すべて実際のレース結果から計算しています。架空のデータは使っていません。</p>
  </section>`;
}

const CARD_COLS = [
  ['馬番', '必須。1〜18'],
  ['馬名', '必須'],
  ['枠', '省略すると頭数から自動で付けます'],
  ['性齢', '牡4・牝3・セ5 など'],
  ['斤量', 'kg'],
  ['騎手', ''],
  ['馬体重', '480 または 480(+4)'],
  ['増減', '+4 / -2'],
  ['単勝オッズ', '期待値の計算に使います'],
  ['父', '省略可'],
  ['騎手勝率・騎手複勝率', '15.2% または 0.152。省略すると平均値'],
  ['取消', '1 または 取消 で出走取消'],
];

const PAST_COLS = [
  ['馬番（または馬名）', '必須。出馬表の馬と結び付けます'],
  ['日付', '必須。2026-09-06 / 2026/9/6'],
  ['距離', '必須。1600 または 芝1600'],
  ['競馬場', 'JRA10場（東京・中山・京都・阪神・中京・新潟・福島・小倉・札幌・函館）'],
  ['クラス', '新馬・未勝利・1勝・2勝・3勝・OP・L・G3・G2・G1'],
  ['芝ダ', '芝 / ダ'],
  ['馬場', '良・稍重・重・不良'],
  ['頭数・着順', ''],
  ['タイム', '1:34.5 または 94.5'],
  ['着差', '勝ち馬との差（秒）。勝ち馬はマイナス'],
  ['上がり3F・上がり順位', ''],
  ['通過順', '3-3-2-2'],
  ['斤量・騎手', ''],
];

function colTable(cols) {
  return `<table class="col-table"><tbody>${cols.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table>`;
}

function select(id, name, options, value) {
  return `<select id="${id}" name="${name}">${options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
}

export function renderData(ctx) {
  const { state, dataView, imported } = ctx;
  const f = dataView.form;
  const msgs = dataView.messages;
  const msgBox = msgs
    ? `<div class="msg-box ${msgs.errors.length ? 'is-error' : 'is-ok'}" role="${msgs.errors.length ? 'alert' : 'status'}">
        ${msgs.errors.length ? `<p><b>取り込めませんでした。</b>次の点を直してください。</p><ul>${msgs.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : `<p><b>${esc(msgs.okText)}</b></p>`}
        ${msgs.warnings.length ? `<ul class="warn-list">${msgs.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      </div>`
    : '';
  const list = imported.length
    ? `<ul class="imp-list">${imported
        .map(
          (r) => `<li>
            <button type="button" class="link-btn" data-open-race="${esc(r.id)}">${esc(r.date)} ${esc(r.course)}${esc(r.raceNo)}R ${esc(r.name)}</button>
            <span class="muted">${esc(r.surface)}${esc(r.distance)}・${r.entries.length}頭</span>
            <button type="button" class="ghost-btn danger" data-delete-race="${esc(r.id)}" aria-label="${esc(r.name)}を削除">削除</button>
          </li>`,
        )
        .join('')}</ul>`
    : '<p class="muted">まだありません。</p>';

  return `<div class="view-intro">
      <h1 class="view-title">データ</h1>
      <p>予想に使う実データの状況です。JRAの出馬表・オッズ・結果を使います。自分で用意した実際の出馬表と過去走（馬柱）を CSV / JSON で取り込んで予想することもできます（取り込んだデータはこのブラウザの中だけで処理され、外部には送信されません）。</p>
    </div>
    ${sourcePanel(ctx)}
    <div class="data-grid">
      <form class="panel import-form" id="import-form" novalidate>
        <header class="panel-head"><h2>CSVで取り込む</h2></header>
        <fieldset class="race-info">
          <legend>レース情報</legend>
          <div class="form-grid">
            <label>開催日<input id="f-date" name="date" type="date" value="${esc(f.date)}" required></label>
            <label>競馬場${select('f-course', 'course', COURSE_NAMES.map((c) => ({ value: c, label: c })), f.course)}</label>
            <label>レース番号<input id="f-raceNo" name="raceNo" type="number" min="1" max="12" value="${esc(f.raceNo)}"></label>
            <label class="span2">レース名<input id="f-name" name="name" type="text" value="${esc(f.name)}" placeholder="出馬表のレース名"></label>
            <label>クラス${select('f-grade', 'grade', GRADES.map((g) => ({ value: g, label: gradeLabel(g) })), f.grade)}</label>
            <label>芝・ダート${select('f-surface', 'surface', [{ value: '芝', label: '芝' }, { value: 'ダ', label: 'ダート' }], f.surface)}</label>
            <label>距離（m）<input id="f-distance" name="distance" type="number" min="800" max="4000" step="100" value="${esc(f.distance)}"></label>
            <label>馬場${select('f-going', 'going', GOINGS.map((g) => ({ value: g, label: g })), f.going)}</label>
          </div>
        </fieldset>
        <div class="csv-block">
          <div class="csv-head">
            <label for="f-card">出馬表（CSV）</label>
            <span class="csv-actions">
              <label class="file-btn">ファイルを選ぶ<input type="file" accept=".csv,.tsv,.txt,text/csv" data-file-for="f-card"></label>
              <button type="button" class="mini-btn" data-template="card">列名を入れる</button>
            </span>
          </div>
          <textarea id="f-card" name="card" rows="7" spellcheck="false" placeholder="1行目に列名、2行目から1頭ずつ">${esc(f.card)}</textarea>
        </div>
        <div class="csv-block">
          <div class="csv-head">
            <label for="f-past">過去走（CSV・省略可）</label>
            <span class="csv-actions">
              <label class="file-btn">ファイルを選ぶ<input type="file" accept=".csv,.tsv,.txt,text/csv" data-file-for="f-past"></label>
              <button type="button" class="mini-btn" data-template="past">列名を入れる</button>
            </span>
          </div>
          <textarea id="f-past" name="past" rows="7" spellcheck="false" placeholder="1行に1走。馬番で出馬表と結び付けます">${esc(f.past)}</textarea>
        </div>
        ${msgBox}
        <div class="panel-actions"><button type="submit" class="btn">取り込んで予想する</button></div>
      </form>
      <div class="data-side">
        <section class="panel">
          <header class="panel-head"><h2>取り込んだレース</h2></header>
          ${list}
        </section>
        <section class="panel">
          <header class="panel-head"><h2>JSONで取り込む・書き出す</h2></header>
          <p class="panel-note">表示中のレースをJSONにして保存したり、別のブラウザに移したりできます。複数レースの配列も読み込めます。</p>
          <textarea id="f-json" rows="8" spellcheck="false" aria-label="JSON" placeholder='{"date":"…","course":"…", … ,"entries":[…]}'>${esc(dataView.json)}</textarea>
          ${dataView.jsonMessage ? `<p class="msg-inline ${dataView.jsonMessage.error ? 'tx-bad' : 'tx-good'}" role="status">${esc(dataView.jsonMessage.text)}</p>` : ''}
          <div class="panel-actions wrap">
            <button type="button" class="btn" data-action="import-json">JSONを取り込む</button>
            <button type="button" class="ghost-btn" data-action="export-json">表示中のレースを書き出す</button>
            <button type="button" class="ghost-btn" data-action="copy-json">コピー</button>
          </div>
        </section>
      </div>
    </div>
    <section class="bt-section">
      <h2 class="section-title">CSVの列</h2>
      <p class="muted">列名は下の名前（または一般的な別名）で書いてください。列の順番は自由です。全角数字・タブ区切りも読めます。</p>
      <div class="col-grid">
        <div><h3>出馬表</h3>${colTable(CARD_COLS)}</div>
        <div><h3>過去走</h3>${colTable(PAST_COLS)}</div>
      </div>
    </section>`;
}
