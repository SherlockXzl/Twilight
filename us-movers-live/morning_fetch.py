#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""早盘总结 —— 原始素材抓取（机械部分）

把「取数」和「分析」分开：本脚本只负责把可靠的原始素材拉全并打印成 JSON，
驱动原因 / 主线归纳 / 关联性分析这些需要判断的部分交给定时任务里的智能体。

用法：
    python3 morning_fetch.py                 # 打印 JSON 到 stdout
    python3 morning_fetch.py -o raw.json     # 同时写文件

数据来源与分工：
    westock-data-clawhub CLI  —— 三大指数 ETF（SPY/QQQ/DIA）与 个人关注池的日线
    finviz                    —— 全市场涨幅榜，走 providers.FinvizProvider + screening.normalize，
                                 与「夜盘异动」页**同一套抓取、解析与字段口径**（price / chg /
                                 marketCap / sector / industry），两页同一只票的数值必然一致
    （驱动原因不在本脚本范围，交给上层用 news / web_search 补）

已知环境限制（2026-09-22 实测）：
  · 技能文档里的 `westock-data quote` 与 `westock-tool filter` **在本机不可用** ——
    npm 上只有 westock-data-clawhub，它没有 quote/filter 子命令，westock-tool 包不存在。
    因此这里用 kline 的最近两根日线自己算涨跌幅代替 quote；
    全市场筛选改用 finviz（与夜盘异动页同一个已实测可用的引擎）。
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import providers   # 与夜盘异动共用 finviz 抓取与解析
import screening   # 与夜盘异动共用同一套归一化（中文化板块/行业、缺失置空）

ET = ZoneInfo("America/New_York")
CST = ZoneInfo("Asia/Shanghai")

NODE_BIN = os.getenv("NODE_BIN", "/Users/xuzhuoli/.workbuddy/binaries/node/versions/22.22.2/bin")
WESTOCK_PKG = os.getenv("WESTOCK_PKG", "westock-data-clawhub@1.0.4")

#: 注意：finviz 的 UA / 请求头不在这里维护 —— 抓取已交给 providers.FinvizProvider，
#: 两页共用一份，改一处即可（曾经这里也有一份重复的 UA）。

#: 与 个人关注池同源 —— 从技能里读取，避免两处维护
WATCHLIST_MD = os.path.expanduser(
    "~/.workbuddy/skills/us-stock-daily-review/references/ai-watchlist.md")


# ------------------------------------------------------------------ 交易日

def last_completed_session(now=None):
    """上一个已收盘的美股交易日（ET 日期字符串）。

    规则：美东 16:00 收盘。当前 ET 时刻若已过 16:00，则今天就是已收盘日；
    否则退回前一交易日，并跳过周末。节假日未内置 —— 真正的判断交给拿到的
    日线数据：如果算出来的日期没有对应 K 线，会往更早的交易日回退。
    """
    now_et = (now or datetime.now(timezone.utc)).astimezone(ET)
    d = now_et.date()
    if now_et.hour < 16:
        d -= timedelta(days=1)
    while d.weekday() >= 5:          # 5=周六 6=周日
        d -= timedelta(days=1)
    return d


# ------------------------------------------------------------------ westock

def westock(*args, timeout=180):
    """调用 westock-data CLI，返回 stdout 文本。"""
    env = dict(os.environ, PATH=NODE_BIN + os.pathsep + os.environ.get("PATH", ""))
    cmd = ["npx", "-y", WESTOCK_PKG] + list(args)
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
    if p.returncode != 0:
        raise RuntimeError("westock 调用失败：%s\n%s" % (" ".join(cmd), p.stderr[:400]))
    return p.stdout


def parse_md_table(text):
    """解析 CLI 输出的 markdown 表格 → [{列名: 值}]。"""
    rows, header = [], None
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if all(re.fullmatch(r":?-{2,}:?", c) for c in cells if c):
            continue
        if header is None:
            header = cells
            continue
        if len(cells) == len(header):
            rows.append(dict(zip(header, cells)))
    return rows


def kline(codes, limit=4):
    """取日线。返回 {代码: [ {date, last, ...}, ... ]}（按日期降序）。

    注意：批量返回的代码列名是 `symbol`（不是 `code`），单只查询则不返回该列。
    """
    out = {}
    rows = parse_md_table(westock("kline", ",".join(codes), "--period", "day",
                                  "--limit", str(limit)))
    if rows and "symbol" not in rows[0] and "code" not in rows[0]:
        return {codes[0]: rows}
    for r in rows:
        out.setdefault(r.get("symbol") or r.get("code") or "", []).append(r)
    return out


def quote_from_kline(rows, session_date):
    """从日线里算出指定交易日的收盘价与涨跌幅（替代不可用的 quote 命令）。"""
    rows = [r for r in rows if r.get("date")]
    for i, r in enumerate(rows):
        if r["date"] != session_date:
            continue
        if i + 1 >= len(rows):
            return None
        try:
            last = float(r["last"]); prev = float(rows[i + 1]["last"])
        except (KeyError, ValueError):
            return None
        if prev == 0:
            return None
        return {"close": last,
                "chgAbs": round(last - prev, 4),
                "chgPct": round((last - prev) / prev * 100, 2)}
    return None


# ------------------------------------------------------------------ finviz

#: 与「夜盘异动」共用同一个 provider —— HTTP 头、节流、限流报错、HTML 解析都在那里，
#: 不再自己写一份。**别改回自解析**：finviz 表格里代码那一格实际是「交易所标记 + 代码」
#: （如 "I INTC"），自己按单元格下标取会写出脏 symbol；provider 是从行内链接的 `t=` 参数取，
#: 才拿得到干净的 "INTC"。
_FINVIZ = providers.FinvizProvider()


def finviz_rows(filters, pages=3, order="-change"):
    """finviz 筛选结果 → 结构化行（字段与「夜盘异动」完全同源）。

    筛选条件仍按本页的双轨制口径传入（与夜盘异动的四档口径不同），但**取数管道与字段**
    共用同一套：providers.FinvizProvider 抓取 + screening.normalize 归一化
    （中文板块行业、缺失置空）。市值单位是**美元**，前端用 U.fCap 换算显示。
    """
    raw = []
    for page in range(pages):
        url = "%s?v=111&f=%s&o=%s" % (providers.FinvizProvider.BASE, filters, order)
        if page:
            url += "&r=%d" % (page * 20 + 1)
        rows = providers.FinvizProvider._parse_page(_FINVIZ._get(url))
        raw.extend(rows)
        if len(rows) < 20:          # 已到最后一页
            break
        time.sleep(0.4)
    out = []
    for r in raw:
        norm = screening.normalize(r)
        if norm["chg"] is None or norm["price"] is None:
            continue
        out.append(norm)
    return out


# ------------------------------------------------------------------ 关注股池

def watchlist_codes():
    if not os.path.exists(WATCHLIST_MD):
        return []
    codes, seen = [], set()
    for line in open(WATCHLIST_MD, encoding="utf-8"):
        m = re.match(r"\|\s*(us[A-Z.\-]+)\s*\|", line)
        if m and m.group(1) not in seen:
            seen.add(m.group(1))
            codes.append(m.group(1))
    return codes


# ------------------------------------------------------------------ 主流程

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--out", help="同时把结果写到该文件")
    args = ap.parse_args()

    session = last_completed_session()
    # 允许用环境变量覆盖，便于补跑历史
    session = os.getenv("SESSION_DATE", session.isoformat())
    report = {"generatedAt": datetime.now(CST).isoformat(timespec="seconds"),
              "sessionDate": session, "errors": []}

    # 1) 三大指数（ETF 代理）
    idx_map = [("usSPY", "标普500"), ("usQQQ", "纳斯达克100"), ("usDIA", "道琼斯")]
    try:
        kl = kline([c for c, _ in idx_map])
        idx = []
        for code, name in idx_map:
            rows = kl.get(code) or kl.get(code.upper()) or []
            q = quote_from_kline(rows, session)
            if q:
                idx.append(dict(code=code, name=name, **q))
            else:
                report["errors"].append("指数 %s 未取到 %s 的日线" % (code, session))
        report["indices"] = idx
    except Exception as e:
        report["errors"].append("指数取数失败：%s" % e)

    # 2) 全市场涨幅榜（finviz）
    #    常规异动：市值 ≥ $2B(=20 亿美元) + 价格 > $5 + 涨幅 > 10%
    #    巨头异动：市值 ≥ $10B + 涨幅 > 4%，再在本地卡到 > $140B(1400 亿美元)
    try:
        reg = finviz_rows("cap_midover,sh_price_o5,ta_change_u10", pages=2)
        big = [r for r in finviz_rows("cap_largeover,ta_change_u4", pages=3)
               if (r["marketCap"] or 0) >= 1400e8]
        merged, seen = [], set()
        for r in big + reg:
            if r["symbol"] in seen:
                continue
            seen.add(r["symbol"])
            r["giant"] = (r["marketCap"] or 0) >= 1400e8
            merged.append(r)
        # 涨跌幅降序（越大越上）。**不再把巨头排到前面**（2026-09-22 按用户要求）——
        # 原先的 (not giant, -chg) 会把一只涨 4.1% 的巨头排在涨 12% 的常规异动之前，
        # 榜单名次和"涨得多少"脱钩。巨头身份改由名称列的「★ 巨头」徽章表达，不占排序位。
        # 并列按代码升序兜底，保证顺序稳定可复现。
        merged.sort(key=lambda r: (-(r["chg"] or 0), r["symbol"] or ""))
        report["movers"] = merged
    except Exception as e:
        report["errors"].append("全市场涨幅榜取数失败：%s" % e)

    # 3) 个人关注池（全部展示，不论涨跌）
    try:
        codes = watchlist_codes()
        if codes:
            kl = kline(codes, limit=4)
            wl = []
            for code in codes:
                q = quote_from_kline(kl.get(code) or [], session)
                if q:
                    wl.append(dict(code=code, **q))
            # 按股票代码字母序（2026-09-22 按用户要求）。原先按 -chgPct ——
            # 关注池是固定清单，按涨幅排会让同一只票天天换位置，找票得先知道它今天涨多少。
            wl.sort(key=lambda r: r["code"] or "")
            report["watchlist"] = wl
            report["watchlistMissing"] = [c for c in codes
                                          if c not in {w["code"] for w in wl}]
    except Exception as e:
        report["errors"].append("个人关注池取数失败：%s" % e)

    txt = json.dumps(report, ensure_ascii=False, indent=2)
    print(txt)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(txt)
    return 0


if __name__ == "__main__":
    sys.exit(main())
