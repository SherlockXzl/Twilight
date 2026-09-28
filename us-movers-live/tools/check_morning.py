#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""体检：早盘总结（data/morning.json）是**分析完成版**还是**取数草稿**。

    用法：python3 tools/check_morning.py
          python3 tools/check_morning.py --url http://127.0.0.1:8787   # 走接口，验服务读到的那份

为什么值得单独有个工具
--------------------
morning_fetch.py 取完数会先落一份「机械字段真实、分析字段留空」的 morning.json
（降级保险，见 morning_fetch.write_morning）。好处是页面不会停在旧日期；
代价是**草稿与完成版长得几乎一样**：榜单是满的、涨跌幅是真的、指数是真的，
只有驱动原因那列全是「分析未完成」、主线与关联两块是空的。

于是"没写完"和"坏了"在页面上无法区分。2026-09-28 早上就是这样：
用户在页面反复刷新，以为页面坏了，而定时任务其实早已 success 退出、
只完成了取数那一步 —— 没有任何地方提示"这还只是半成品"。

这个脚本不修任何东西，只回答一个问题：**这份复盘写完了吗；没写完，缺哪一块。**
它和服务端 / 页面用的是同一个判定（morning_fetch.assess_morning），
所以不会出现"脚本说完成了、页面上却是空的"这种自相矛盾。

退出码：0 = 完成版；1 = 草稿（有缺口）；2 = 读不到数据。
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

import morning_fetch                          # noqa: E402  复用同一套判定，别再实现一遍

DEFAULT_PATH = os.path.join(BASE_DIR, "data", "morning.json")


def load_local(path):
    if not os.path.exists(path):
        return None, "文件不存在：%s" % path
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f), ""
    except Exception as e:                     # noqa: BLE001
        return None, "无法解析：%s" % e


def load_remote(url):
    """走 /api/morning —— 验的是**服务实际读到的那份**，包含服务端的 draft 判定。"""
    req = urllib.request.Request(url.rstrip("/") + "/api/morning",
                                headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8", "ignore"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", default=DEFAULT_PATH, help="morning.json 路径（默认 data/morning.json）")
    ap.add_argument("--url", help="改为走该服务的 /api/morning（如 http://127.0.0.1:8787）")
    args = ap.parse_args()

    if args.url:
        try:
            doc = load_remote(args.url)
        except (urllib.error.URLError, OSError) as e:
            print("取数失败（服务在跑吗？）：%s" % e)
            return 2
        src = args.url.rstrip("/") + "/api/morning"
    else:
        doc, err = load_local(args.path)
        if doc is None:
            print(err)
            return 2
        src = args.path

    if not doc.get("ok", True):
        print("接口报错：%s" % doc.get("message"))
        return 2

    meta = doc.get("meta") or {}
    st = morning_fetch.morning_stats(doc)
    # 接口回来的那份已带 draft（服务端算过），本地文件则现算 —— 两条路同一判定
    if "draft" in meta:
        draft, why = bool(meta["draft"]), meta.get("draftWhy") or ""
    else:
        draft, why = morning_fetch.assess_morning(doc)

    print("来源：%s" % src)
    print("交易日：%s %s   （数据落盘 %s）"
          % (meta.get("tradeDate") or "—", meta.get("tradeDateLabel") or "",
             meta.get("fileMtime") or meta.get("generatedAt") or "—"))
    print("写入者：%s" % (meta.get("generatedBy") or "—"))
    print("完成度：异动榜 %d 只（有驱动原因 %d）· 主线 %d 条 · 关联分析 %d 条 · A 股提示 %d 条"
          % (st["movers"], st["drivers"], st["themes"], st["linkage"], st["hints"]))

    if meta.get("ageDays") is not None:
        print("场次距今：%s 天%s" % (meta["ageDays"], "（偏旧）" if meta.get("stale") else ""))

    print()
    if draft:
        print("草稿 ✗ —— %s" % why)
        print("（页面会在顶部显示草稿横幅；补齐 driver / themes / linkage 后重跑本脚本应转为完成版）")
        return 1
    print("分析完成版 ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main())
