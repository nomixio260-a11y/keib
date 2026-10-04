// scripts/fit-confidence.mjs が分割外の予測から作る。手で編集しないでください。
// legacy: true … 自信度の区切りは従来の決め方（◎の勝率 42% 以上で S、30% 以上かつ2番手との差 8pt 以上で A、20% 以上で B、それ未満で C）。
// ◎が勝つ確率・複勝圏の確率は校正せずにそのまま表示する（分割外の検証で校正しても良くならなかった）
export const CONFIDENCE_MODEL = {"version":2,"legacy":true,"win":{"raw":true},"place":{"raw":true},"cuts":[0.42,0.3,0.2]};
