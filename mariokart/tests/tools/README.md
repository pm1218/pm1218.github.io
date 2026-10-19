# Evaluating the photo reader on your own photos

Desktop mirror of the browser pipeline, for measuring accuracy and making
regression fixtures. Needs Python 3 with `opencv-python` + `numpy`, the
`tesseract` CLI (v5), `ffmpeg` (for iPhone HEIC photos) and Node 20+.

```bash
cd mariokart/tests/tools
mkdir -p work/jpg && cd work
python3 ../heic2jpg.py "/path/to/photos" jpg       # HEIC/PNG/JPG → JPG
cp ../../fixtures/wii-truth.example.json gt.json     # then edit: one entry per photo
mkdir -p dump && python3 ../pass1.py jpg $(node -e "console.log(Object.keys(require("./gt.json")).join(' '))")
node ../plan.mjs . && python3 ../cells.py .
node ../evaluate.mjs .                               # FIXTURES=../../fixtures/wii to refresh fixtures
```

`gt.json`: `{ "<id>": { "kind": "standings" | "final", "humans": [places], "rows": [["Mario", 46], …12 rows] } }`.
Steps 1-3 run in Python here, the layout/decoding steps are the app's own
`js/wii-layout.js`, so results match what phones produce (up to Tesseract
version differences).
