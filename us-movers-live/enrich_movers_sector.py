#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一次性回填工具：给 data/morning.json 的 movers 补「板块 / 行业」（中文），
并把字段名迁移到与夜盘异动同源的命名。

为什么需要它：早盘页的异动榜历史上用的是另一套字段（code / close / chgPct / capYi / tags），
没有板块与行业。现改为与夜盘异动共用口径后，历史那份 9/21 数据需要补齐这两列，
否则页面会出现两列空值。板块/行业不随交易日变化，用当前值回填是安全的；
价格 / 涨幅 / 市值保持 9/21 原值，只做单位换算（capYi「亿美元」→ marketCap「美元」）。

数据源：finviz screener 的 ticker 批量查询（v=111&t=ARM,INTC,…），
比逐只抓 quote 页快一个数量级（实测 6 只/6.5 秒 vs 单只 8 秒）。
"""
import json
import pathlib
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import providers   # 复用夜盘异动的抓取与解析，避免再写一份（含 symbol 清洗）
import screening   # 复用同一套归一化：中文板块/行业、缺失置空
import taxonomy_zh  # noqa: E402

DATA = ROOT / "data" / "morning.json"
BATCH = 6            # screener 一次放几只（实测 6 只返回稳定）
SLEEP = 1.0          # 批间隔，避免触发限流

#: 场外代码（OTC/ADR）finviz 一律不收录 —— 用同一公司在美股的主代码代查
ALIAS = {"BABAF": "BABA"}   # 阿里巴巴场外 → BABA

#: 连主代码也查不到的（多半是亚太票的场外 ADR），按公司主业人工归类。
#: 键是英文的 finviz 官方口径，中文仍由 taxonomy_zh 生成，保证与自动取到的行同体系；
#: 写入时打 sectorSource = "manual" 标记，页面与文档都能看出这几行不是抓来的。
MANUAL = {
    "TCTZF": ("Communication Services", "Internet Content & Information"),  # 腾讯
    "SFTBY": ("Communication Services", "Telecom Services"),                 # 软银集团
    "ATEYY": ("Technology", "Semiconductor Equipment & Materials"),          # 爱德万测试
    "AMSSY": ("Technology", "Semiconductors"),                               # ams-OSRAM
    "ZTCOF": ("Technology", "Communication Equipment"),                      # 中兴通讯
    "AUOTY": ("Technology", "Electronic Components"),                        # 友达光电
    "HOKCY": ("Utilities", "Utilities - Regulated Gas"),                     # 香港中华煤气
}

_P = providers.FinvizProvider()


def fetch_batch(symbols):
    """一次取多只的板块 / 行业 / 国家，返回 {symbol: normalized_row}

    用 finviz screener 的 ticker 批量查询（v=111&t=ARM,INTC,…）——
    比逐只抓 quote 页快一个数量级（实测 6 只/2~6 秒 vs 单只 8 秒）。
    行结构经 screening.normalize 归一化，与夜盘异动页完全一致。
    """
    url = "%s?v=111&t=%s&o=-change" % (providers.FinvizProvider.BASE, ",".join(symbols))
    rows = providers.FinvizProvider._parse_page(_P._get(url))
    return {r["symbol"]: screening.normalize(r) for r in rows}


def main():
    d = json.loads(DATA.read_text(encoding="utf-8"))
    movers = d.get("movers") or []

    # 1) 字段名迁移（旧 → 新）
    for r in movers:
        if r.get("code") and not r.get("symbol"):
            r["symbol"] = r["code"]
        if r.get("close") is not None and r.get("price") is None:
            r["price"] = r["close"]
        if r.get("chgPct") is not None and r.get("chg") is None:
            r["chg"] = r["chgPct"]
        if r.get("capYi") is not None and r.get("marketCap") is None:
            r["marketCap"] = round(float(r["capYi"]) * 1e8, 1)
        r["source"] = "finviz"

    # 2) 批量补板块 / 行业 / 国家
    todo = [r["symbol"] for r in movers if not r.get("sectorEn")]
    print("待补板块/行业的标的：%d 只" % len(todo))
    # 场外代码先换成可查的主代码，结果再映射回原代码
    query = {ALIAS.get(s, s): s for s in todo}
    profiles = {}
    keys = list(query.keys())
    for i in range(0, len(keys), BATCH):
        chunk = keys[i:i + BATCH]
        try:
            got = fetch_batch(chunk)
            for k, v in got.items():
                if k in query:
                    profiles[query[k]] = v
            print("  批次 %d：%s ✓ %d 条" % (i // BATCH + 1, ",".join(chunk), len(got)))
        except Exception as e:
            print("  批次 %d：%s ✗ %s" % (i // BATCH + 1, ",".join(chunk), str(e)[:80]))
        time.sleep(SLEEP)

    filled, manual_filled, missing = 0, 0, []
    for r in movers:
        if r.get("sectorEn"):
            # 已有值：可能是本轮抓到的，也可能是上一轮已写入的（脚本可重复运行）
            if not r.get("sectorSource"):
                r["sectorSource"] = "finviz"
            filled += 1
            continue
        p = profiles.get(r["symbol"])
        if p:
            # p 已由 screening.normalize 归一化，中文板块/行业直接取
            r["sectorEn"] = p["sectorEn"]
            r["sector"] = p["sector"]
            r["industryEn"] = p["industryEn"]
            r["industry"] = p["industry"]
            r["country"] = p["country"]
            r["sectorSource"] = "finviz"
            filled += 1
            continue
        if r["symbol"] in MANUAL:
            sec_en, ind_en = MANUAL[r["symbol"]]
            r["sectorEn"] = sec_en
            r["sector"] = taxonomy_zh.sector_zh(sec_en)
            r["industryEn"] = ind_en
            r["industry"] = taxonomy_zh.industry_zh(ind_en)
            r["sectorSource"] = "manual"        # finviz 查不到，按公司主业人工归类
            manual_filled += 1
            continue
        missing.append(r["symbol"])

    DATA.write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("\n抓取补齐 %d 只，人工归类 %d 只，合计 %d / %d"
          % (filled, manual_filled, filled + manual_filled, len(movers)))
    if missing:
        print("仍未取到：%s" % ", ".join(missing))
    for r in movers[:8]:
        print("  %-6s %-8s / %-14s (%s)" % (r["symbol"], r.get("sector") or "—",
                                            r.get("industry") or "—", r.get("sectorSource") or "—"))


if __name__ == "__main__":
    main()
