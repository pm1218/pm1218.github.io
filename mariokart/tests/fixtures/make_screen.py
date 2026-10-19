# Synthesises Mario Kart Wii-style result screens (layout only; icons are plain
# coloured shapes, not game art), "photographs" them (perspective warp, blur,
# glare, noise), preprocesses exactly like vision.js (gray -> CLAHE -> invert
# -> blur), runs Tesseract 5 with PSM 11, and writes word boxes in the
# Tesseract.js JSON shape for the Node parser test.
import csv, io, json, subprocess, sys
import numpy as np, cv2
from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
ICON_COLORS = {"Mario": (220, 40, 40), "Luigi": (40, 170, 70), "Peach": (235, 90, 160),
               "Yoshi": (90, 200, 80), "Toad": (60, 90, 220), "Bowser": (240, 120, 30),
               "Daisy": (245, 170, 30), "Wario": (250, 210, 40), "Waluigi": (140, 70, 200),
               "Rosalina": (40, 150, 250), "Birdo": (230, 60, 140), "King Boo": (160, 160, 170)}

def screen(rows, gained=None):
    W, H = 1280, 720
    img = Image.new("RGB", (W, H), (20, 30, 80))
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(FONT, 34)
    top, rh = 40, 54
    for i, (name, char, pts) in enumerate(rows):
        y = top + i * rh
        band = (230, 190, 40) if i % 2 == 0 else (60, 110, 210)
        d.rounded_rectangle([140, y, 1140, y + rh - 6], 14, fill=band)
        kw = dict(font=f, fill="white", stroke_width=3, stroke_fill="black")
        d.text((160, y + 6), str(i + 1), **kw)
        c = ICON_COLORS[char]
        d.ellipse([230, y + 2, 274, y + 46], fill=c, outline="white", width=3)
        d.rectangle([244, y + 16, 260, y + 32], fill=tuple(255 - v for v in c))
        d.text((300, y + 6), name, **kw)
        if gained:
            d.text((860, y + 6), f"+{gained[i]}", **kw)
        d.text((1040, y + 6), str(pts), **kw)
    return np.array(img)

def photograph(arr, seed):
    rng = np.random.default_rng(seed)
    h, w = arr.shape[:2]
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    j = lambda: rng.uniform(-25, 25)
    dst = np.float32([[40 + j(), 30 + j()], [w - 40 + j(), 20 + j()], [w - 30 + j(), h - 30 + j()], [30 + j(), h - 20 + j()]])
    M = cv2.getPerspectiveTransform(src, dst)
    out = cv2.warpPerspective(arr, M, (w, h), borderValue=(10, 10, 10))
    out = cv2.GaussianBlur(out, (3, 3), 0.8)
    yy, xx = np.mgrid[0:h, 0:w]
    glare = 40 * np.exp(-(((xx - w * 0.7) ** 2) + ((yy - h * 0.3) ** 2)) / (2 * 250 ** 2))
    out = np.clip(out.astype(float) + glare[..., None] + rng.normal(0, 6, out.shape), 0, 255).astype(np.uint8)
    return out

def preprocess(rgb):
    scale = 1400 / rgb.shape[1]
    rgb = cv2.resize(rgb, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    eq = cv2.createCLAHE(2.5, (8, 8)).apply(gray)
    inv = cv2.GaussianBlur(255 - eq, (3, 3), 0)
    return [inv, eq]

def ocr(gray):
    ok, png = cv2.imencode(".png", gray)
    tsv = subprocess.run(["tesseract", "stdin", "stdout", "--psm", "11", "tsv"], input=png.tobytes(), capture_output=True).stdout.decode()
    words = []
    for r in csv.DictReader(io.StringIO(tsv), delimiter="\t", quoting=csv.QUOTE_NONE):
        if r["level"] == "5" and r["text"].strip():
            x, y, w, h = int(r["left"]), int(r["top"]), int(r["width"]), int(r["height"])
            words.append({"text": r["text"], "confidence": float(r["conf"]), "bbox": {"x0": x, "y0": y, "x1": x + w, "y1": y + h}})
    return words

if __name__ == "__main__":
    out_dir = sys.argv[1]
    players = [("Prateek", "Yoshi", 52), ("Mario", "Mario", 47), ("Anya", "Peach", 41), ("Luigi", "Luigi", 36),
               ("Dev", "Bowser", 33), ("Toad", "Toad", 27), ("Daisy", "Daisy", 22), ("Wario", "Wario", 17),
               ("Waluigi", "Waluigi", 12), ("Rosalina", "Rosalina", 9), ("Birdo", "Birdo", 5), ("King Boo", "King Boo", 2)]
    cases = {"final_clean": (screen(players), None), "final_photo": (photograph(screen(players), 7), None)}
    race = [("Anya", "Peach", 15), ("Prateek", "Yoshi", 12), ("Mario", "Mario", 10), ("Dev", "Bowser", 8)] + players[5:]
    race = [(n, c, p) for n, c, p in race][:12]
    gained = [15, 12, 10, 8, 7, 6, 5, 4, 3, 2, 1, 0]
    cases["race_photo"] = (photograph(screen(race, gained), 11), None)
    for name, (arr, _) in cases.items():
        cv2.imwrite(f"{out_dir}/{name}.jpg", cv2.cvtColor(arr, cv2.COLOR_RGB2BGR))
        variants = preprocess(arr)
        json.dump([ocr(v) for v in variants], open(f"{out_dir}/{name}.words.json", "w"))
    print("ok", list(cases))
