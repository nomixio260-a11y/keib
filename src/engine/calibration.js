// scripts/calibrate.mjs が実際のレース結果（JRA）から生成。手で編集しないでください。
export const CALIBRATION = {
  "coef": {
    "speed": 0.3213,
    "form": 0.5775,
    "closing": 0.0881,
    "jockey": 0.2648,
    "trainer": 0.2214,
    "aptitude": 0.6973,
    "pace": 0.04,
    "draw": 0.1298,
    "condition": 0.0735,
    "market": 0.9141
  },
  "ref": {
    "speed": 25,
    "form": 30,
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
    "speed": 6,
    "form": 0,
    "closing": 1,
    "jockey": 0,
    "trainer": 0,
    "aptitude": 0,
    "pace": 0,
    "draw": 0,
    "condition": 2,
    "market": 96
  },
  "temps": {
    "ai": [
      0.96,
      1,
      1.12
    ],
    "total": [
      0.9,
      1.02,
      1.18
    ],
    "market": [
      0.9,
      1.02,
      1.18
    ]
  },
  "marketBeta": 0.9141,
  "defaultPreset": "balance",
  "indexScale": 1.0216,
  "trainedOn": 2484,
  "fitLL": {
    "ai": -4.8566,
    "total": -4.4812,
    "market": -4.4866
  },
  "period": {
    "stats": "2023-10-01〜2025-09-28",
    "fit": "2025-10-04〜2026-06-28"
  },
  "source": "JRA"
};
