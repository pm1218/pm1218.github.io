# Produce, per photo, exactly what the browser pipeline will have: the prepared
# (cropped + deskewed) image and Tesseract word boxes for each binarisation.
import json, os, sys, cv2, numpy as np
import wii_reference as w

def variants(img):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    white = ((hsv[..., 1] < 85) & (hsv[..., 2] > 175)).astype(np.uint8) * 255
    white = cv2.morphologyEx(white, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    top = w.tophat_mask(img)
    top = cv2.morphologyEx(top, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    gray = cv2.createCLAHE(2.0, (8, 8)).apply(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))
    return {'white': 255 - white, 'tophat': 255 - top, 'gray': 255 - gray}

os.makedirs('dump', exist_ok=True)
# usage: python3 pass1.py PHOTO_DIR ID...   (photos named IMG_<ID>.jpg, any size)
src = sys.argv[1]
for f in sys.argv[2:]:
    img, ang, hi = w.prepare(f'{src}/IMG_{f}.jpg', 1600, f'{src}/IMG_{f}.jpg', 3200)
    cv2.imwrite(f'dump/{f}.png', img)
    cv2.imwrite(f'dump/{f}.hi.png', hi)
    out = {'width': img.shape[1], 'height': img.shape[0], 'angle': ang, 'variants': {}}
    for name, v in variants(img).items():
        out['variants'][name] = w.tess(v, 11)
    json.dump(out, open(f'dump/{f}.json', 'w'))
    print(f, {k: len(v) for k, v in out['variants'].items()}, flush=True)
