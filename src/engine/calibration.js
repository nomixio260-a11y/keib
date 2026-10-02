// scripts/calibrate.mjs が実際のレース結果（JRA）から生成。手で編集しないでください。
export const CALIBRATION = {
  "coef": {
    "speed": 0.3281,
    "form": 0.5384,
    "closing": 0.0616,
    "jockey": 0.2583,
    "trainer": 0.2335,
    "aptitude": 0.7401,
    "pace": 0.04,
    "draw": 0.1616,
    "condition": 0.0623,
    "market": 0.9066
  },
  "ref": {
    "speed": 25,
    "form": 35,
    "closing": 5,
    "jockey": 15,
    "trainer": 10,
    "aptitude": 5,
    "pace": 5,
    "draw": 5,
    "condition": 5,
    "market": 100
  },
  "combinedWeights": {
    "speed": 7,
    "form": 0,
    "closing": 3,
    "jockey": 0,
    "trainer": 1,
    "aptitude": 1,
    "pace": 0,
    "draw": 1,
    "condition": 4,
    "market": 94
  },
  "temps": {
    "ai": [
      0.94,
      1.04,
      1.1
    ],
    "total": [
      0.9,
      1.06,
      1.16
    ],
    "market": [
      0.9,
      1.06,
      1.16
    ]
  },
  "marketBeta": 0.9066,
  "defaultPreset": "balance",
  "indexScale": 1.0204,
  "trainedOn": 1131,
  "fitLL": {
    "ai": -4.8428,
    "total": -4.469,
    "market": -4.4772
  },
  "period": {
    "stats": "2025-10-04〜2026-02-28",
    "fit": "2026-03-01〜2026-06-28"
  },
  "source": "JRA"
};
