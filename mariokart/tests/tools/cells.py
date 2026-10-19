# Writes, for every planned cell, the binarised images the browser builds with
# OpenCV.js (vision.js → cellImages): 3 name variants, 6 digit masks, plus the
# row bar colour. PGM files so the Node harness can read them without libraries.
import json, os, sys, cv2, numpy as np

def pgm(path, a):
    h, w = a.shape
    with open(path, 'wb') as f: f.write(b'P5\n%d %d\n255\n' % (w, h)); f.write(a.astype(np.uint8).tobytes())

def name_variants(c):
    hsv = cv2.cvtColor(c, cv2.COLOR_BGR2HSV); H, S, V = cv2.split(hsv)
    gray = cv2.cvtColor(c, cv2.COLOR_BGR2GRAY)
    white = ((S < 85) & (V > 175)).astype(np.uint8) * 255
    k = max(7, int(c.shape[0] * 0.35)) | 1
    th = cv2.morphologyEx(V, cv2.MORPH_TOPHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    _, top = cv2.threshold(th, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return {'white': 255 - white, 'top': 255 - top, 'otsu': 255 - otsu}

def digit_masks(c):
    hsv = cv2.cvtColor(c, cv2.COLOR_BGR2HSV); H, S, V = cv2.split(hsv)
    gray = cv2.cvtColor(c, cv2.COLOR_BGR2GRAY)
    blk = int(c.shape[0] * 0.9) | 1
    adapt = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, blk, -12)
    k = max(7, int(c.shape[0] * 0.35)) | 1
    th = cv2.morphologyEx(V, cv2.MORPH_TOPHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    _, top = cv2.threshold(th, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    ms = {
        'adapt': adapt,
        'blue2': ((H > 88) & (H < 140) & (S > 60) & (V > 120)).astype(np.uint8) * 255,
        'white': ((S < 85) & (V > 175)).astype(np.uint8) * 255,
        'loose': ((S < 120) & (V > 150)).astype(np.uint8) * 255,
        'blue': ((H > 95) & (H < 135) & (S > 110) & (V > 110)).astype(np.uint8) * 255,
        'top': top,
    }
    k2 = np.ones((2, 2), np.uint8)
    return {n: cv2.morphologyEx(m, cv2.MORPH_OPEN, k2) for n, m in ms.items()}

def crop(img, b, k, target):
    x0, y0, x1, y1 = [int(round(b[q] * k)) for q in ('x0', 'y0', 'x1', 'y1')]
    c = img[max(0, y0):y1, max(0, x0):x1]
    f = target / max(1, c.shape[0])
    return cv2.resize(c, None, fx=f, fy=f, interpolation=cv2.INTER_CUBIC)

def bar_hsv(hsv, s, th):
    r, n = s['row'], s['name']
    yc = (n['y0'] + n['y1']) / 2; x0 = int(max(r['x0'], n['x0'])); x1 = int(min(r['x1'], n['x1']))
    bands = [hsv[max(0, int(yc - 0.62 * th)):max(1, int(yc - 0.42 * th)), x0:x1], hsv[int(yc + 0.42 * th):int(yc + 0.62 * th), x0:x1]]
    px = np.concatenate([b.reshape(-1, 3) for b in bands])
    return [float(v) for v in np.median(px, axis=0)] if len(px) else [0, 0, 0]

if __name__ == '__main__':
    root = sys.argv[1]; plans = json.load(open(f'{root}/plans.json'))
    for id, p in plans.items():
        d = f'{root}/cells/{id}'; os.makedirs(d, exist_ok=True)
        lo = cv2.imread(f'{root}/dump/{id}.png'); hi = cv2.imread(f'{root}/dump/{id}.hi.png')
        k = hi.shape[1] / lo.shape[1]; hsv = cv2.cvtColor(lo, cv2.COLOR_BGR2HSV)
        bars = {}
        for s in p['slots']:
            for n, v in name_variants(crop(hi, s['name'], k, 64)).items():
                pgm(f'{d}/{s["place"]}_name_{n}.pgm', cv2.copyMakeBorder(v, 12, 12, 12, 12, cv2.BORDER_CONSTANT, value=255))
            for n, m in digit_masks(crop(hi, s['points'], k, 80)).items():
                pgm(f'{d}/{s["place"]}_pts_{n}.pgm', m)
            bars[s['place']] = bar_hsv(hsv, s, p['textH'])
        json.dump(bars, open(f'{d}/bars.json', 'w'))
    print('ok')
