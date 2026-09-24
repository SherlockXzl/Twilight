#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""体检：夜盘榜单上的每只票，是否都有驱动原因。

    用法：python3 tools/check_reasons.py
          python3 tools/check_reasons.py --url http://127.0.0.1:8787
          python3 tools/check_reasons.py --all      # 连旧场次的条目一起列出来

为什么值得单独有个工具
--------------------
「驱动原因」是**分析产物**，不是取数产物：行情表每次刷新都有，原因只在有人分析过之后才有。
两者一旦脱节，页面上就是一行「待确认」——**看起来完全正常**（不是报错、不是空白），
所以没人会主动去查。2026-09-24 就发生过：夜盘页出现 U / P 两只新上榜的票，
原因文件还停在前一场次，页面上默默显示「待确认」。

这个脚本不修任何东西，只回答一个问题：**榜单上哪几只还没有原因。**
有它就能在写完之后立刻确认覆盖率，而不用逐行盯着页面看。

退出码：0 = 全覆盖；1 = 有缺口（便于挂进别的检查流程）。
"""

import argparse
import json
import sys
import urllib.error
import urllib.request

DEFAULT_URL = "http://127.0.0.1:8787"


def get_json(url):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read().decode("utf-8", "ignore"))


def board_rows(movers):
    """把 /api/movers 的 tables 摊平成 [{symbol,name,chg,cap}]（各分档合并）。"""
    out = []
    for _, t in (movers.get("tables") or {}).items():
        rows = t if isinstance(t, list) else (t.get("rows") or [])
        out.extend(rows)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--all", action="store_true",
                    help="同时列出原因文件里不在当前榜单上的条目（跨场次累积的正常现象）")
    args = ap.parse_args()

    try:
        movers = get_json(args.url + "/api/movers")
        reasons = get_json(args.url + "/api/reasons")
    except (urllib.error.URLError, OSError) as e:
        print("取数失败（服务在跑吗？）：%s" % e)
        return 2

    snap = (movers.get("meta") or {}).get("snapshot") or {}
    print("场次：%s %s（%s）" % (snap.get("basis"), snap.get("sessionDate"),
                               "夜盘中" if snap.get("inSession") else "已收盘"))

    rows, seen = board_rows(movers), set()
    uniq = []
    for r in rows:
        s = r.get("symbol")
        if s and s not in seen:
            seen.add(s)
            uniq.append(r)

    rm = reasons.get("reasons") or {}
    hit = [r for r in uniq if r["symbol"] in rm]
    miss = [r for r in uniq if r["symbol"] not in rm]

    print("\n榜单 %d 只：有原因 %d / 缺 %d" % (len(uniq), len(hit), len(miss)))
    for r in uniq:
        v = rm.get(r["symbol"])
        mark = "✓" if v else "✗"
        extra = ""
        if v:
            extra = "  [%s %s]" % (v.get("from") or "?", v.get("tradeDate") or "—")
        print("  %s %-6s %-26s %+7.2f%%%s"
              % (mark, r.get("symbol"), (r.get("name") or "")[:26],
                 r.get("chg") or 0, extra))

    if miss:
        print("\n缺原因的代码：%s" % " ".join(r["symbol"] for r in miss))
        print("（写进 data/reasons.json 的 reasons 里，或等智能体分析后补）")

    if args.all:
        board = {r["symbol"] for r in uniq}
        others = [(s, v) for s, v in rm.items() if s not in board]
        print("\n原因文件里不在当前榜单的条目 %d 条（跨场次累积的旧条目，正常）：" % len(others))
        for s, v in sorted(others, key=lambda kv: kv[1].get("tradeDate") or ""):
            print("  %-7s %s  %s" % (s, v.get("tradeDate") or "—", (v.get("driver") or "")[:52]))

    print()
    if miss:
        print("有缺口 ✗")
        return 1
    print("全部覆盖 ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main())
