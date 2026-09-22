#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""夜盘异动「驱动原因」—— 素材抓取（机械部分）

和 morning_fetch.py 是同一个分工：本脚本只负责把**可验证的原始素材**拉全
（当前榜单 + 每只票的近期新闻标题），判断留给智能体 —— 原因是一句话的结论，
不能由脚本猜。智能体据此写 data/reasons.json（页面 GET /api/reasons 读取）。

用法：
    python3 reason_fetch.py                      # 榜单代码自动从本地服务取
    python3 reason_fetch.py --symbols FCNCA,VICR # 指定代码
    python3 reason_fetch.py -o /tmp/raw.json     # 同时写文件
    python3 reason_fetch.py --server http://127.0.0.1:8787   # 自定义服务地址

为什么新闻用 finviz 的个股页：它与行情同源（同一个站），无需 Key，且标题就是
"Vicor Shares Jump Nearly 9.9% After Company Raises Third-Quarter Revenue Outlook"
这类**直接点明催化剂**的写法，比通用搜索更省事。
"""
import argparse
import html
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
CST = ZoneInfo("Asia/Shanghai")

DEFAULT_SERVER = "http://127.0.0.1:8787"
NEWS_LIMIT = 6
SLEEP = 0.6


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA,
                                               "Accept-Language": "en-US,en;q=0.9"})
    return urllib.request.urlopen(req, timeout=25).read().decode("utf-8", "ignore")


def board_symbols(server):
    """从本地服务取当前榜单的代码 + 行情（已按口径分档、已剔除噪声）"""
    d = json.loads(get(server.rstrip("/") + "/api/movers"))
    out = {}
    for t in (d.get("tables") or {}).values():
        for r in t.get("rows") or []:
            sym = r.get("symbol")
            if sym and sym not in out:
                out[sym] = {k: r.get(k) for k in
                            ("symbol", "name", "price", "chg", "marketCap",
                             "sector", "industry", "country")}
    return out


def news_titles(symbol, limit=NEWS_LIMIT):
    """个股页的新闻标题 —— 标题里往往直接写着催化剂"""
    src = get("https://finviz.com/quote.ashx?t=" + urllib.parse.quote(symbol))
    m = re.search(r"fullview-news-outer(.*?)</table>", src, re.S)
    if not m:
        return []
    out = []
    for t in re.findall(r'class="tab-link-news"[^>]*>(.*?)</a>', m.group(1), re.S):
        title = html.unescape(re.sub(r"<[^>]+>", "", t)).strip()
        if title:
            out.append(title)
        if len(out) >= limit:
            break
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", help="逗号分隔的代码；不给则自动取当前榜单")
    ap.add_argument("--server", default=DEFAULT_SERVER)
    ap.add_argument("-o", "--out")
    args = ap.parse_args()

    if args.symbols:
        rows = {s.strip().upper(): {"symbol": s.strip().upper()}
                for s in args.symbols.split(",") if s.strip()}
    else:
        try:
            rows = board_symbols(args.server)
        except Exception as e:
            print(json.dumps({"error": "取榜单失败：%s" % e,
                              "hint": "本地服务没起？用 --symbols 指定代码可绕过"},
                             ensure_ascii=False, indent=2))
            return 1

    report = {"generatedAt": datetime.now(CST).isoformat(timespec="seconds"),
              "server": args.server,
              "count": len(rows),
              "symbols": {}}
    for sym, meta in rows.items():
        try:
            news = news_titles(sym)
            report["symbols"][sym] = dict(meta, news=news)
        except Exception as e:
            report["symbols"][sym] = dict(meta, news=[], error=str(e)[:80])
        time.sleep(SLEEP)

    txt = json.dumps(report, ensure_ascii=False, indent=2)
    print(txt)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(txt)
    return 0


if __name__ == "__main__":
    sys.exit(main())
