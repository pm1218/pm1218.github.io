# Prototype of the layout-aware pipeline (to be ported 1:1 to OpenCV.js):
#   1. find wide text lines (Sobel-x edges -> threshold -> horizontal dilation -> contours)
#   2. OCR each row crop on its own as a single line (PSM 7)
# Emits, per image, a list of Tesseract.js-style word lists, one per detected row,
# with boxes translated back to full-image coordinates.
import csv, io, json, subprocess, sys
import numpy as np, cv2

def find_rows(gray):
    h, w = gray.shape
    gx = cv2.Sobel(gray, cv2.CV_16S, 1, 0, ksize=3)
    gx = cv2.convertScaleAbs(gx)
    _, bw = cv2.threshold(gx, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (max(15, w // 40), 3))
    closed = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, k)
    k2 = cv2.getStructuringElement(cv2.MORPH_RECT, (max(25, w // 15), 1))
    closed = cv2.dilate(closed, k2)
    k3 = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 3))
    closed = cv2.erode(closed, k3)
    cnts, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = [cv2.boundingRect(c) for c in cnts]
    boxes = [b for b in boxes if 0.02 * h < b[3] < 0.12 * h and b[2] > 0.05 * w]
    boxes.sort(key=lambda b: b[1] + b[3] / 2)
    groups = []
    for b in boxes:
        for g in groups:
            ov = min(g[1] + g[3], b[1] + b[3]) - max(g[1], b[1])
            if ov >= 0.5 * min(g[3], b[3]):
                x0, y0 = min(g[0], b[0]), min(g[1], b[1])
                x1, y1 = max(g[0] + g[2], b[0] + b[2]), max(g[1] + g[3], b[1] + b[3])
                g[:] = [x0, y0, x1 - x0, y1 - y0]
                break
        else:
            groups.append(list(b))
    groups = [g for g in groups if g[2] > 0.35 * w]
    if not groups:
        return []
    med = sorted(g[3] for g in groups)[len(groups) // 2]
    groups = [g for g in groups if 0.5 * med < g[3] < 1.8 * med]
    return sorted(groups, key=lambda g: g[1])[:12]

def ocr_line(img):
    ok, png = cv2.imencode(".png", img)
    tsv = subprocess.run(["tesseract", "stdin", "stdout", "--psm", "7", "tsv"], input=png.tobytes(), capture_output=True).stdout.decode()
    out = []
    for r in csv.DictReader(io.StringIO(tsv), delimiter="\t", quoting=csv.QUOTE_NONE):
        if r["level"] == "5" and r["text"].strip():
            x, y, ww, hh = int(r["left"]), int(r["top"]), int(r["width"]), int(r["height"])
            out.append({"text": r["text"], "confidence": float(r["conf"]), "bbox": {"x0": x, "y0": y, "x1": x + ww, "y1": y + hh}})
    return out

def variants(rgb_crop):
    f = 64 / rgb_crop.shape[0]
    big = cv2.resize(rgb_crop, None, fx=f, fy=f, interpolation=cv2.INTER_CUBIC)
    hsv = cv2.cvtColor(big, cv2.COLOR_RGB2HSV)
    gray = cv2.cvtColor(big, cv2.COLOR_RGB2GRAY)
    white = ((hsv[..., 1] < 70) & (hsv[..., 2] > 170)).astype(np.uint8) * 255
    white = cv2.morphologyEx(white, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return f, [255 - white, 255 - otsu, 255 - gray]

def order_quad(pts):
    pts = pts.reshape(4, 2).astype(np.float32)
    s = pts.sum(1); d = np.diff(pts, axis=1).ravel()
    return np.float32([pts[s.argmin()], pts[d.argmin()], pts[s.argmax()], pts[d.argmax()]])

def find_screen(rgb):
    h, w = rgb.shape[:2]
    gray = cv2.GaussianBlur(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY), (5, 5), 0)
    cands = []
    edges = cv2.dilate(cv2.Canny(gray, 40, 120), np.ones((3, 3), np.uint8))
    _, th = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    th = cv2.morphologyEx(th, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    for mask in (th, edges):
        cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in sorted(cnts, key=cv2.contourArea, reverse=True)[:5]:
            hull = cv2.convexHull(c)
            approx = cv2.approxPolyDP(hull, 0.02 * cv2.arcLength(hull, True), True)
            area = cv2.contourArea(approx)
            if len(approx) == 4 and 0.3 * w * h < area < 0.98 * w * h:
                cands.append((area, approx))
    if not cands:
        return None
    q = order_quad(max(cands, key=lambda t: t[0])[1])
    c = q.mean(0)
    q = c + (q - c) * 1.03
    q[:, 0] = q[:, 0].clip(0, w - 1); q[:, 1] = q[:, 1].clip(0, h - 1)
    return q.astype(np.float32)

def rectify(rgb):
    q = find_screen(rgb)
    if q is None:
        return rgb, False
    wt = max(np.linalg.norm(q[1] - q[0]), np.linalg.norm(q[2] - q[3]))
    ht = max(np.linalg.norm(q[3] - q[0]), np.linalg.norm(q[2] - q[1]))
    W = 1400; H = int(W * ht / wt)
    M = cv2.getPerspectiveTransform(q, np.float32([[0, 0], [W, 0], [W, H], [0, H]]))
    return cv2.warpPerspective(rgb, M, (W, H)), True

def run(path):
    rgb = cv2.cvtColor(cv2.imread(path), cv2.COLOR_BGR2RGB)
    scale = 1400 / rgb.shape[1]
    rgb = cv2.resize(rgb, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    clahe = cv2.createCLAHE(2.5, (8, 8))
    options = [rgb]
    warped, ok = rectify(rgb)
    if ok: options.insert(0, warped)
    best = None
    for o in options:
        e = clahe.apply(cv2.cvtColor(o, cv2.COLOR_RGB2GRAY))
        r = find_rows(e)
        if best is None or len(r) > len(best[2]): best = (o, e, r)
    rgb, eq, rows = best
    cv2.imwrite(path.replace(".jpg", ".rect.png"), cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
    result = []
    for (x, y, w, h) in rows:
        pad = int(h * 0.1)
        y0, y1 = max(0, y - pad), min(eq.shape[0], y + h + pad)
        x0, x1 = max(0, x - pad), min(eq.shape[1], x + w + pad)
        f, vs = variants(rgb[y0:y1, x0:x1])
        best = None
        for vi, v in enumerate(vs):
            words = ocr_line(v)
            score = sum(w["confidence"] for w in words if w["confidence"] > 30)
            if best is None or score > best[0]:
                best = (score, words, vi)
        words = [{**w, "bbox": {"x0": int(x0 + w["bbox"]["x0"] / f), "x1": int(x0 + w["bbox"]["x1"] / f),
                                 "y0": int(y0 + w["bbox"]["y0"] / f), "y1": int(y0 + w["bbox"]["y1"] / f)}} for w in best[1]]
        result.append({"box": [x, y, w, h], "words": words, "variant": best[2]})
    return result

if __name__ == "__main__":
    d = sys.argv[1]
    for name in ["final_clean", "final_photo", "race_photo"]:
        json.dump(run(f"{d}/{name}.jpg"), open(f"{d}/{name}.rows.json", "w"))
    print("ok")
