// scripts/calibrate.mjs が生成（架空の学習用 2000 レースで推定）。手で編集しないでください。
export const CALIBRATION = {
  "coef": {
    "speed": 0.9487,
    "form": 0.1366,
    "closing": 0.06,
    "jockey": 0.4296,
    "aptitude": 0.3511,
    "pace": 0.1638,
    "draw": 0.1049,
    "condition": 0.2763,
    "market": 0.959
  },
  "ref": {
    "speed": 40,
    "form": 5,
    "closing": 5,
    "jockey": 20,
    "aptitude": 5,
    "pace": 10,
    "draw": 5,
    "condition": 10,
    "market": 100
  },
  "popularWeights": {
    "speed": 20,
    "form": 3,
    "closing": 3,
    "jockey": 10,
    "aptitude": 3,
    "pace": 5,
    "draw": 3,
    "condition": 5,
    "market": 50
  },
  "noiseBase": 1.6,
  "indexScale": 0.9359,
  "marketModel": {
    "k": 4.169,
    "residVar": 11.5
  },
  "trainedOn": 2000
};
