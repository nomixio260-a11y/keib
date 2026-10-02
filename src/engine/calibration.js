// scripts/calibrate.mjs が実際のレース結果（JRA）から生成。手で編集しないでください。
export const CALIBRATION = {
  "coef": {
    "speed": 0.3202,
    "form": 0.5685,
    "closing": 0.0885,
    "jockey": 0.2825,
    "trainer": 0.2478,
    "aptitude": 0.691,
    "pace": 0.04,
    "draw": 0.1126,
    "condition": 0.0651,
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
  "indexScale": 1.0168,
  "trainedOn": 2484,
  "fitLL": {
    "ai": -4.8616,
    "total": -4.481,
    "market": -4.4866
  },
  "period": {
    "stats": "2024-10-05〜2025-09-28",
    "fit": "2025-10-04〜2026-06-28"
  },
  "source": "JRA"
};
