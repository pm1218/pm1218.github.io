# Minimal HEIC (iPhone) → JPEG converter: parses the HEIF container in Python,
# decodes the HEVC grid tiles with ffmpeg, stitches, applies rotation.
import os, struct, subprocess, sys
import numpy as np, cv2


def boxes(buf, start, end):
    i = start
    while i < end:
        size, typ = struct.unpack('>I4s', buf[i:i + 8])
        hdr = 8
        if size == 1:
            size = struct.unpack('>Q', buf[i + 8:i + 16])[0]; hdr = 16
        elif size == 0:
            size = end - i
        yield typ.decode('latin1'), i + hdr, i + size
        i += size


def uint(b, o, n):
    return int.from_bytes(b[o:o + n], 'big') if n else 0


def parse(path):
    buf = open(path, 'rb').read()
    meta = next((s, e) for t, s, e in boxes(buf, 0, len(buf)) if t == 'meta')
    items, iloc, refs, props, assoc = {}, {}, {}, [], {}
    primary = None
    idat = 0
    for t, s, e in boxes(buf, meta[0] + 4, meta[1]):
        if t == 'pitm':
            primary = struct.unpack('>H', buf[s + 4:s + 6])[0]
        elif t == 'iinf':
            v = buf[s]; off = s + 4 + (2 if v == 0 else 4)
            for tt, ss, ee in boxes(buf, off, e):
                iv = buf[ss]
                if iv >= 2:
                    if iv == 2: iid = struct.unpack('>H', buf[ss + 4:ss + 6])[0]; o = ss + 8
                    else: iid = struct.unpack('>I', buf[ss + 4:ss + 8])[0]; o = ss + 10
                    items[iid] = buf[o:o + 4].decode('latin1')
        elif t == 'iloc':
            v = buf[s]; o = s + 4
            osz, lsz = buf[o] >> 4, buf[o] & 15; bsz = buf[o + 1] >> 4; isz = buf[o + 1] & 15 if v in (1, 2) else 0; o += 2
            cnt = uint(buf, o, 2 if v < 2 else 4); o += 2 if v < 2 else 4
            for _ in range(cnt):
                iid = uint(buf, o, 2 if v < 2 else 4); o += 2 if v < 2 else 4
                cm = uint(buf, o, 2) & 15 if v in (1, 2) else 0
                if v in (1, 2): o += 2
                o += 2
                base = uint(buf, o, bsz); o += bsz
                ec = uint(buf, o, 2); o += 2
                ext = []
                for _ in range(ec):
                    o += isz
                    eo = uint(buf, o, osz); o += osz
                    el = uint(buf, o, lsz); o += lsz
                    ext.append((base + eo, el))
                iloc[iid] = (cm, ext)
        elif t == 'idat':
            idat = s
        elif t == 'iref':
            v = buf[s]; n = 2 if v == 0 else 4
            for tt, ss, ee in boxes(buf, s + 4, e):
                frm = uint(buf, ss, n); c = uint(buf, ss + n, 2)
                refs.setdefault(tt, {})[frm] = [uint(buf, ss + n + 2 + k * n, n) for k in range(c)]
        elif t == 'iprp':
            for tt, ss, ee in boxes(buf, s, e):
                if tt == 'ipco':
                    props = [(t3, s3, e3) for t3, s3, e3 in boxes(buf, ss, ee)]
                elif tt == 'ipma':
                    v = buf[ss]; fl = uint(buf, ss + 1, 3); o = ss + 4
                    cnt = uint(buf, o, 4); o += 4
                    for _ in range(cnt):
                        iid = uint(buf, o, 2 if v < 1 else 4); o += 2 if v < 1 else 4
                        n = buf[o]; o += 1
                        lst = []
                        for _ in range(n):
                            if fl & 1: x = uint(buf, o, 2) & 0x7fff; o += 2
                            else: x = buf[o] & 0x7f; o += 1
                            lst.append(x)
                        assoc[iid] = lst
    def data(iid):
        cm, ext = iloc[iid]
        base = idat if cm == 1 else 0
        return b''.join(buf[base + a:base + a + l] for a, l in ext)
    prop = lambda iid, name: next(((s, e) for k in assoc.get(iid, []) for (t, s, e) in [props[k - 1]] if t == name), None)
    return buf, primary, items, refs, data, prop


def hvcc_to_annexb(buf, s, e):
    o = s + 21; nl = (buf[o] & 3) + 1; o += 1
    narr = buf[o]; o += 1; out = b''
    for _ in range(narr):
        o += 1; n = uint(buf, o, 2); o += 2
        for _ in range(n):
            l = uint(buf, o, 2); o += 2
            out += b'\x00\x00\x00\x01' + buf[o:o + l]; o += l
    return out, nl


def to_annexb(d, nl):
    out, o = b'', 0
    while o < len(d):
        l = uint(d, o, nl); o += nl
        out += b'\x00\x00\x00\x01' + d[o:o + l]; o += l
    return out


def decode(path):
    buf, prim, items, refs, data, prop = parse(path)
    if items[prim] == 'grid':
        g = data(prim); big = g[1] & 1
        rows, cols = g[2] + 1, g[3] + 1
        W, H = uint(g, 4, 4 if big else 2), uint(g, 4 + (4 if big else 2), 4 if big else 2)
        tiles = refs['dimg'][prim]
    else:
        tiles = [prim]; rows = cols = 1; W = H = None
    stream = b''
    for t in tiles:
        ps, nl = hvcc_to_annexb(buf, *prop(t, 'hvcC'))
        stream += ps + to_annexb(data(t), nl)
    s, _ = prop(tiles[0], 'ispe'); tw, th = struct.unpack('>II', buf[s + 4:s + 12])
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-f', 'hevc', '-i', '-', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], input=stream, capture_output=True).stdout
    frames = np.frombuffer(raw, np.uint8).reshape(-1, th, tw, 3)
    img = np.zeros((rows * th, cols * tw, 3), np.uint8)
    for i, f in enumerate(frames[:rows * cols]):
        r, c = divmod(i, cols); img[r * th:(r + 1) * th, c * tw:(c + 1) * tw] = f
    if W: img = img[:H, :W]
    rot = prop(prim, 'irot')
    if rot:
        k = buf[rot[0]] & 3
        img = np.rot90(img, k)  # irot is anti-clockwise in 90° steps
    return np.ascontiguousarray(img)


if __name__ == '__main__':
    src, dst = sys.argv[1], sys.argv[2]
    os.makedirs(dst, exist_ok=True)
    for f in sorted(os.listdir(src)):
        p = os.path.join(src, f); base = os.path.splitext(f)[0]
        bgr = cv2.cvtColor(decode(p), cv2.COLOR_RGB2BGR) if f.lower().endswith('.heic') else cv2.imread(p)
        s = min(1, 2000 / max(bgr.shape[:2])); bgr = cv2.resize(bgr, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        cv2.imwrite(os.path.join(dst, base + '.jpg'), bgr, [cv2.IMWRITE_JPEG_QUALITY, 88])
        print(f, bgr.shape)
