#!/usr/bin/env python3
"""校验表格「表头 ↔ 数值」是否对齐。

为什么需要它
------------
数值列的表头必须和单元格里的数字同一种对齐方式（都右对齐），否则
表头的右边缘与数字的右边缘会差 30~50px —— 肉眼看就是"表格没对齐"，
但很难一眼指出是哪个属性写错了。这个脚本把页面渲染出来、逐像素量文字范围，
直接给出「差几 px」的结论。

本项目踩过的坑
--------------
数值列单元格一直是 `td.num{text-align:right}`，但表头是全局 `thead th{text-align:left}`，
两种对齐方式并存了很久才被发现。

⚠️ 另一个坑在脚本本身：第一版按「文案分行后第 0 段就是表头」取值，
抓到的其实是工具条那一行，于是算出"差 164px / 差 1867px"这种荒唐结论并误报错位。
**表头行必须用表头背景色区间定位，不能靠顺序假设。**

用法
----
  python3 tools/align_check.py                       # 默认查夜盘异动
  python3 tools/align_check.py http://127.0.0.1:8787/morning

注意：早盘总结的表格在「个股」标签页里，默认是隐藏的，截图取不到表头。
那种情况请改用 DOM 核对（确认数值列的 `<th>` 都带 `class="num"`），
CSS 是两页共用的，夜盘页量通了早盘页就一致。
"""
import argparse
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "google-chrome",
    "chromium",
]

HEAD_BG = (238, 241, 245)   # #eef1f5 表头底色
PAGE_BG = (242, 244, 247)   # #f2f4f7 页面底色（只差 2~4 个色阶，必须严判据）
NUM_COLS = (2, 3, 4)        # 价格 / 涨跌幅 / 总市值 在 8 列中的下标（0 起）


def is_head_bg(c):
    return all(abs(c[k] - HEAD_BG[k]) <= 1 for k in range(3))


def dark(c, th=200):
    return (c[0] + c[1] + c[2]) / 3 < th


def clusters(px, w, y0, y1, gap=20):
    cols = [x for x in range(212, w)
            if any(dark(px(x, y)) for y in range(y0, y1 + 1))]
    out = []
    for x in cols:
        if out and x - out[-1][1] <= gap:
            out[-1][1] = x
        else:
            out.append([x, x])
    return [(s, e) for s, e in out if e - s > 3]


def main():
    ap = argparse.ArgumentParser(description="校验表格表头与数值是否对齐")
    ap.add_argument("url", nargs="?", default="http://127.0.0.1:8787/")
    ap.add_argument("--width", type=int, default=2302)
    ap.add_argument("--height", type=int, default=900)
    ap.add_argument("--png", default="/tmp/align_check.png")
    a = ap.parse_args()

    chrome = next((c for c in CHROME_CANDIDATES if os.path.exists(c) or "/" not in c), None)
    if not chrome:
        raise SystemExit("找不到 Chrome")

    subprocess.run([chrome, "--headless=new", "--disable-gpu", "--no-sandbox",
                    "--hide-scrollbars", f"--window-size={a.width},{a.height}",
                    "--force-device-scale-factor=1", "--virtual-time-budget=12000",
                    f"--screenshot={a.png}", a.url], capture_output=True)
    if not os.path.exists(a.png):
        raise SystemExit("截图失败")

    from visual_check import decode_png, make_px
    w, h, ch, rows = decode_png(a.png)
    px = make_px(rows, ch)

    hb = [y for y in range(h)
          if sum(1 for x in range(400, 2200, 10) if is_head_bg(px(x, y))) > 80]
    if not hb:
        print("  未找到表头背景色 —— 表格可能没渲染，或处在隐藏的标签页里")
        return 1
    hb0, hb1 = min(hb), max(hb)

    segs, cur = [], None
    for y in range(max(0, hb0 - 60), min(h, hb1 + 240)):
        has = sum(1 for x in range(212, w, 3) if dark(px(x, y))) > 2
        if has and cur is None:
            cur = y
        if not has and cur is not None:
            segs.append((cur, y - 1))
            cur = None
    if cur is not None:
        segs.append((cur, min(h, hb1 + 240) - 1))

    # 用「中点落在表头背景区间内」认定表头，不要取第 0 段
    hdr_seg = next((s for s in segs if hb0 <= (s[0] + s[1]) // 2 <= hb1), None)
    if hdr_seg is None:
        print("  未定位到表头文字行")
        return 1
    data_segs = [s for s in segs if s[0] > hdr_seg[1]][:3]

    print(f"  {a.url}")
    print(f"  表头背景 y {hb0}..{hb1}   表头文字行 y {hdr_seg[0]}..{hdr_seg[1]}")
    hdr = clusters(px, w, *hdr_seg)
    print(f"  表头文字簇: " + "  ".join(f"[{s}..{e}]" for s, e in hdr))
    for i, s in enumerate(data_segs, 1):
        c = clusters(px, w, *s)
        print(f"  数据{i} 文字簇: " + "  ".join(f"[{x}..{y}]" for x, y in c))

    print()
    print("  对齐判定（数值列比右边缘，文本列比左边缘；容差 3px）：")
    ok = True
    for i, s in enumerate(data_segs, 1):
        val = clusters(px, w, *s)
        bad = []
        for j in range(min(len(hdr), len(val))):
            numeric = j in NUM_COLS
            hh = hdr[j][1] if numeric else hdr[j][0]
            vv = val[j][1] if numeric else val[j][0]
            if abs(hh - vv) > 3:
                bad.append((j + 1, hh, vv))
        if bad:
            ok = False
            print(f"    数据{i}: 错位 → "
                  + ", ".join(f"第{j}列 表头{h} vs 数值{v}" for j, h, v in bad))
        else:
            print(f"    数据{i}: 全部对齐 ✓")
    print()
    print("  结论:", "表头与内容对齐 ✓" if ok else "存在错位 ✗")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
