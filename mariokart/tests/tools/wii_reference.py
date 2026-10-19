# Python mirror of js/vision.js steps 1-3 (crop, straighten, pass-1 OCR) — used to
# evaluate the pipeline on real photos with desktop Tesseract.
import csv, io, json, re, subprocess, sys
import numpy as np, cv2

ORD = re.compile(r'^(1[0-2]|[1-9])(st|nd|rd|th)$', re.I)


def tess(img, psm, extra=()):
    ok, png = cv2.imencode('.png', img)
    tsv = subprocess.run(['tesseract', 'stdin', 'stdout', '--psm', str(psm), *extra, 'tsv'], input=png.tobytes(), capture_output=True).stdout.decode()
    out = []
    for r in csv.DictReader(io.StringIO(tsv), delimiter='\t', quoting=csv.QUOTE_NONE):
        if r['level'] == '5' and r['text'].strip():
            x, y, w, h = int(r['left']), int(r['top']), int(r['width']), int(r['height'])
            out.append({'text': r['text'], 'confidence': float(r['conf']), 'bbox': {'x0': x, 'y0': y, 'x1': x + w, 'y1': y + h}})
    return out


def screen_crop(bgr):
    """Find the TV picture: the largest bright/saturated region. Returns crop + offset."""
    h, w = bgr.shape[:2]
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    m = (((hsv[..., 1] > 90) & (hsv[..., 2] > 90)) | (hsv[..., 2] > 215)).astype(np.uint8) * 255
    k = max(5, w // 60)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((k, k), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m)
    if n <= 1:
        return bgr, (0, 0)
    i = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    x, y, ww, hh, area = stats[i]
    if area < 0.08 * w * h:
        return bgr, (0, 0)
    pad = int(0.02 * max(ww, hh))
    x0, y0 = max(0, x - pad), max(0, y - pad)
    x1, y1 = min(w, x + ww + pad), min(h, y + hh + pad)
    return bgr[y0:y1, x0:x1], (x0, y0)


def deskew_angle(gray):
    edges = cv2.Canny(gray, 60, 160)
    h, w = gray.shape
    lines = cv2.HoughLinesP(edges, 1, np.pi / 720, threshold=120, minLineLength=int(0.3 * w), maxLineGap=8)
    if lines is None:
        return 0.0
    angs, wts = [], []
    for x1, y1, x2, y2 in lines.reshape(-1, 4):
        a = np.degrees(np.arctan2(y2 - y1, x2 - x1))
        if abs(a) < 15:
            angs.append(a); wts.append(np.hypot(x2 - x1, y2 - y1))
    if not angs:
        return 0.0
    order = np.argsort(angs); angs = np.array(angs)[order]; wts = np.array(wts)[order]
    c = np.cumsum(wts); return float(angs[np.searchsorted(c, c[-1] / 2)])


def rotate(img, ang):
    h, w = img.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2, h / 2), ang, 1.0)
    return cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def variants(bgr):
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    white = ((hsv[..., 1] < 85) & (hsv[..., 2] > 175)).astype(np.uint8) * 255
    white = cv2.morphologyEx(white, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    eq = cv2.createCLAHE(2.0, (8, 8)).apply(gray)
    return {'white': 255 - white, 'inv': 255 - eq}


def prepare(path, width=2000, hires_path=None, hires_width=None):
    """Geometry (screen crop + deskew) is found on a 1600px copy; it can then be
    applied to the full-resolution original for sharper cell crops."""
    bgr = cv2.imread(path)
    s0 = 1600 / max(bgr.shape[:2]); small = cv2.resize(bgr, None, fx=s0, fy=s0, interpolation=cv2.INTER_AREA)
    crop, (ox, oy) = screen_crop(small)
    s = width / crop.shape[1]
    crop = cv2.resize(crop, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
    ang = deskew_angle(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY))
    out = rotate(crop, ang)
    if not hires_path:
        return out, ang
    big = cv2.imread(hires_path)
    k = big.shape[1] / small.shape[1]
    x0, y0 = int(ox * k), int(oy * k)
    bc = big[y0:y0 + int(crop.shape[0] / s * k), x0:x0 + int(crop.shape[1] / s * k)]
    bc = cv2.resize(bc, (hires_width, int(round(hires_width * out.shape[0] / out.shape[1]))), interpolation=cv2.INTER_AREA)
    return out, ang, rotate(bc, ang)




def tophat_mask(bgr):
    """Bright text on a busy background: white top-hat on HSV value, then Otsu."""
    v = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)[..., 2]
    k = max(9, bgr.shape[0] // 35) | 1
    th = cv2.morphologyEx(v, cv2.MORPH_TOPHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    _, m = cv2.threshold(th, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return m
