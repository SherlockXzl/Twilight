#!/usr/bin/env python3
"""本地页面的「截图 + 像素级校验」工具。

用途
----
改完版式后，靠肉眼看截图或靠估算 DOM 高度都不够 —— 这个工具把页面真实渲染出来，
再解码 PNG 逐像素分析，直接给出**实测数字**（某块多高、内容到哪结束、哪里是空的）。

本次就是靠它发现「区块两两并排」方案的硬伤：同一行的两块高度差可达 557px
（关联性深度分析 953px vs A 股联动提示 396px），短的那块下方空出一大片。
这个数字估算是得不出来的。

用法
----
  # 1) 渲染（需要本机 Chrome 已启动对应服务）
  python3 tools/visual_check.py shot http://127.0.0.1:8787/morning 2302 7000 -o /tmp/s.png

  # 2) 量页面实际内容高度（后面都是空白）
  python3 tools/visual_check.py bottom /tmp/s.png

  # 3) 列出所有面板的水平边界线（按边框色找），用于判断各区块的上下沿
  python3 tools/visual_check.py edges /tmp/s.png

  # 4) 找纵向空洞（验证布局有没有留出连片空白）
  python3 tools/visual_check.py blank /tmp/s.png

  # 5) 裁一块出来单独看（放大细节）
  python3 tools/visual_check.py crop /tmp/s.png 56 700 212 2302 -o /tmp/top.png

依赖
----
只用标准库（zlib / struct）+ 本机 Google Chrome。
"""
import argparse
import os
import struct
import subprocess
import sys
import zlib

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "google-chrome",
    "chromium",
]

# 站点配色（与 static/style.css 的 :root 一致）
PAGE_BG = (242, 244, 247)      # --bg
BORDER = (227, 231, 236)       # --line


# ----------------------------------------------------------------- 解码
def decode_png(path):
    """解码 8 位 RGB/RGBA PNG，返回 (w, h, 通道数, 每行 bytes)。"""
    d = open(path, "rb").read()
    if d[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"不是 PNG: {path}")
    pos, idat = 8, b""
    w = h = bd = ct = None
    while pos < len(d):
        ln, typ = struct.unpack(">I", d[pos:pos + 4])[0], d[pos + 4:pos + 8]
        body = d[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h, bd, ct, _, _, _ = struct.unpack(">IIBBBBB", body)
        elif typ == b"IDAT":
            idat += body
        elif typ == b"IEND":
            break
        pos += 12 + ln
    if bd != 8 or ct not in (2, 6):
        raise SystemExit(f"只支持 8 位 RGB/RGBA，当前 位深={bd} 颜色类型={ct}")
    ch = 3 if ct == 2 else 4
    raw = zlib.decompress(idat)
    stride = w * ch
    prev = bytearray(stride)
    rows = []
    i = 0
    for _ in range(h):
        f = raw[i]
        i += 1
        line = bytearray(raw[i:i + stride])
        i += stride
        if f == 1:                              # Sub
            for x in range(ch, stride):
                line[x] = (line[x] + line[x - ch]) & 255
        elif f == 2:                            # Up
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif f == 3:                            # Average
            for x in range(stride):
                a = line[x - ch] if x >= ch else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:                            # Paeth
            for x in range(stride):
                a = line[x - ch] if x >= ch else 0
                b = prev[x]
                c = prev[x - ch] if x >= ch else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        # f == 0 (None) 无需处理
        rows.append(bytes(line))
        prev = line
    return w, h, ch, rows


def make_px(rows, ch):
    def px(x, y):
        return rows[y][x * ch:x * ch + 3]
    return px


def near(c, t, tol=4):
    return all(abs(c[k] - t[k]) <= tol for k in range(3))


# ----------------------------------------------------------------- 分析
def content_bottom(px, w, h, x0=300, x1=None, step=17, bg=PAGE_BG, tol=5):
    """从底部往上找最后一个「不是页面底色」的行 —— 即页面实际内容底边。"""
    x1 = x1 or w
    for y in range(h - 1, -1, -1):
        if any(not near(px(x, y), bg, tol) for x in range(x0, x1, step)):
            return y
    return None


def panel_edges(px, w, h, x0=None, x1=None, y0=0, y1=None, tol=8, min_px=150):
    """找面板的水平边界线（整行都是边框色）。

    返回 [(y, 该行边框色像素数)]。像素数能区分整行面板（约等于主区宽度）
    与两列并排时的半宽面板（约一半）。
    """
    x0 = 300 if x0 is None else x0
    x1 = (w - 30) if x1 is None else x1
    y1 = h if y1 is None else y1
    hits = []
    for y in range(y0, y1):
        n = sum(1 for x in range(x0, x1, 2) if near(px(x, y), BORDER, tol))
        if n * 2 > min_px:
            hits.append((y, n * 2))
    merged = []
    for y, n in hits:
        if merged and y - merged[-1][1] <= 2:
            merged[-1][1] = y
            merged[-1][2] = max(merged[-1][2], n)
        else:
            merged.append([y, y, n])
    return [(a, n) for a, b, n in merged]


def blank_bands(px, w, h, bands=8, min_h=40, bg=PAGE_BG, tol=6):
    """把图横向切成若干带，找出每带内「纵向连续全是底色」的区间。

    这才是「右侧是不是还空着」的正确判据。
    反例：先写成「整列都是底色才算空白」的写法，对「两列并排、右列面板偏矮」
    这种空洞完全查不出来 —— 那一列里毕竟还有个矮面板撑着，整列并非全空。
    所以必须按带看纵向连续区间：面板下方空出 557px 的那块，就是靠这个抓出来的。
    """
    step = max(1, w // bands)
    out = []
    for b in range(bands):
        x0 = b * step
        x1 = min(w, (b + 1) * step)
        cur = None
        for y in range(h + 1):
            blank = (y < h) and all(near(px(x, y), bg, tol) for x in range(x0, x1, 5))
            if blank and cur is None:
                cur = y
            elif not blank and cur is not None:
                if y - cur >= min_h:
                    out.append((x0, x1 - 1, cur, y - 1))
                cur = None
    return out


# ----------------------------------------------------------------- 输出
def crop_save(px, y0, y1, x0, x1, out):
    cw, chh = x1 - x0, y1 - y0
    orows = []
    for j in range(chh):
        r = bytearray([0])
        for i in range(cw):
            r += px(x0 + i, y0 + j)
        orows.append(bytes(r))

    def ck(t, dd):
        return (struct.pack(">I", len(dd)) + t + dd +
                struct.pack(">I", zlib.crc32(t + dd) & 0xffffffff))

    png = (b"\x89PNG\r\n\x1a\n" +
           ck(b"IHDR", struct.pack(">IIBBBBB", cw, chh, 8, 2, 0, 0, 0)) +
           ck(b"IDAT", zlib.compress(b"".join(orows), 6)) +
           ck(b"IEND", b""))
    open(out, "wb").write(png)
    print(f"  {out}  {cw}x{chh}")


def cmd_shot(a):
    chrome = next((c for c in CHROME_CANDIDATES if os.path.exists(c) or "/" not in c), None)
    if not chrome:
        raise SystemExit("找不到 Chrome，请手动指定 CHROME_CANDIDATES")
    # --dpr 2/3 用来模拟 Retina —— **细线、描边、小字号必须用 dpr≥2 看**。
    # 1 倍下抗锯齿会把不足 1px 的线渲染成灰色，容易误判成"太淡/太糊"。
    # 本项目实测踩过：站点标「线」字的 1.75px 黑描边，在 1x 截图里看着像黑疙瘩，
    # 2x 下其实是干净的白底黑边 —— 差点因为看错采样率把宽度改小。
    # 像素分析同理：要让数字对得上实际观感，采样率就得和屏幕一致。
    cmd = [chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
           f"--window-size={a.width},{a.height}", f"--force-device-scale-factor={a.dpr}",
           "--virtual-time-budget=9000", f"--screenshot={a.out}", a.url]
    subprocess.run(cmd, capture_output=True)
    if not os.path.exists(a.out):
        raise SystemExit("截图失败：" + a.url)
    w, h, _, _ = decode_png(a.out)
    extra = f"  (dpr={a.dpr} → CSS 尺寸 {w // a.dpr}x{h // a.dpr})" if a.dpr != 1 else ""
    print(f"  {a.out}  {w}x{h}{extra}")


def cmd_bottom(a):
    w, h, ch, rows = decode_png(a.png)
    px = make_px(rows, ch)
    b = content_bottom(px, w, h)
    print(f"  图片 {w}x{h}   内容底边 y = {b}   （其后 {h - 1 - b}px 是空白）")
    if b and h - 1 - b > 40:
        print("  提示：截得比页面高很多，可用 --height 调小以省时间")


def cmd_edges(a):
    w, h, ch, rows = decode_png(a.png)
    px = make_px(rows, ch)
    print(f"  图片 {w}x{h}   （主区宽约 {w - 242}px）")
    print(f"  {'y':>6}  {'边框像素':>8}   推断")
    for y, n in panel_edges(px, w, h):
        kind = "整行面板" if n > (w - 242) * 0.75 else "半宽 / 卡内边框"
        print(f"  {y:>6}  {n:>8}   {kind}")


def cmd_blank(a):
    w, h, ch, rows = decode_png(a.png)
    px = make_px(rows, ch)
    bands = blank_bands(px, w, h, bands=a.bands, min_h=a.min_h)
    # 截得比页面高时，内容底边以下全是空白，会一直空到图片底部 ——
    # 那不是版式问题，滤掉。（早盘页原本还有一条透明底的页脚，同样是这种情况；
    # 页脚已于 2026-09-22 去掉，这条判据留着仍然有用。）
    bands = [b for b in bands if b[3] < h - 1]
    cb = content_bottom(px, w, h)
    print(f"  {a.png}  {w}x{h}   横向分 {a.bands} 带，找高度 ≥ {a.min_h}px 的空白区"
          f"（内容底边 y={cb}）")
    if not bands:
        print("    版式内没有任何纵向空白区 ✓")
        return
    print(f"    {'x 范围':>14}  {'y 范围':>14}  {'尺寸':>10}")
    for x0, x1, y0, y1 in sorted(bands, key=lambda r: -(r[3] - r[2])):
        print(f"    {x0:>6}..{x1:<6}  {y0:>6}..{y1:<6}  {x1-x0+1:>4}x{y1-y0+1:<5}")
    print(f"    共 {len(bands)} 处；最宽 {max(r[1]-r[0]+1 for r in bands)}px，"
          f"最高 {max(r[3]-r[2]+1 for r in bands)}px")


def cmd_crop(a):
    w, h, ch, rows = decode_png(a.png)
    px = make_px(rows, ch)
    x1 = a.x1 if a.x1 is not None else w
    crop_save(px, a.y0, a.y1, a.x0, x1, a.out)


def main():
    ap = argparse.ArgumentParser(description="本地页面截图 + 像素级校验")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("shot", help="用无头 Chrome 渲染并截图")
    p.add_argument("url")
    p.add_argument("width", type=int)
    p.add_argument("height", type=int)
    p.add_argument("-o", "--out", required=True)
    p.add_argument("--dpr", type=int, default=1,
                   help="设备像素比，2/3 = 模拟 Retina。看描边、细线、小字号时必须用")
    p.set_defaults(func=cmd_shot)

    p = sub.add_parser("bottom", help="量页面实际内容底边")
    p.add_argument("png")
    p.set_defaults(func=cmd_bottom)

    p = sub.add_parser("edges", help="列出面板水平边界线")
    p.add_argument("png")
    p.set_defaults(func=cmd_edges)

    p = sub.add_parser("blank", help="找纵向空白区（验证布局是否留出大面积空洞）")
    p.add_argument("png")
    p.add_argument("--bands", type=int, default=8, help="横向切几带（默认 8）")
    p.add_argument("--min-h", type=int, default=40, help="只报高度 ≥ 该值的空白（默认 40）")
    p.set_defaults(func=cmd_blank)

    p = sub.add_parser("crop", help="裁一块出来单独看")
    p.add_argument("png")
    p.add_argument("y0", type=int)
    p.add_argument("y1", type=int)
    p.add_argument("x0", type=int)
    p.add_argument("x1", type=int, nargs="?")
    p.add_argument("-o", "--out", required=True)
    p.set_defaults(func=cmd_crop)

    a = ap.parse_args()
    a.func(a)


if __name__ == "__main__":
    sys.exit(main())
