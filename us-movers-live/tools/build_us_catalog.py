# -*- coding: utf-8 -*-
"""建一份全市场美股目录：代码 / 公司全称 / 板块 / 行业。给「明暗对照」页用。

**为什么数据源是 Finviz 而不是 nasdaqtrader 的官方目录**：
`symbols.py` 用的官方符号目录确实更全（约 13k 条），但它**只有代码和名称**，
没有板块/行业 —— 而这张表要的正是这两列。Finviz 的筛选页一次请求就能给出
代码/公司名/Sector/Industry 全套，是本项目已经在用（`night_fetch.build_universe`）
且验证可行的路子，这里只是把市值门槛去掉，从「建夜盘扫描域」变成「建全市场目录」。

**为什么不用 night_fetch.build_universe 改参数**：那个函数的职责是「夜盘要扫哪些票」，
它按市值降序翻页、跌破下限即停，还顺带算基准价 —— 这些都不该出现在「目录」里。
两个函数目的不同，宁可各写一遍循环，也不要为了省代码把它们耦上。

用法：
    HTTPS_PROXY=http://127.0.0.1:7897 python3 tools/build_us_catalog.py
    python3 tools/build_us_catalog.py --min-cap 0 --max-pages 700   # 参数可调
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone, timedelta

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)

import providers  # noqa: E402

OUT = os.path.join(BASE_DIR, "data", "us_catalog.json")

#: Finviz 筛选条件。`cap_nanoover` = 市值 ≥ $50M。
#: 不设下限会把这个星球上的仙股也拖进来（几万条），而它们既没有可用的板块/行业，
#: 也不是这张表的读者会去找的东西。
FILTERS = "cap_nanoover"
ORDER = "-marketcap"

#: 每页间隔。Finviz 是页面抓取，快到会被 403 —— night_fetch 实测 0.4s 能撑 117 页，
#: 这个量级（数百页）保守取 0.6s。
PAGE_DELAY = 0.6

#: Finviz 的类别股写连字符（BRK-B、AKO-A），本项目内部一律用点号形态（BRK.B）——
#: 与 symbols.py、alpaca.to_alpaca_symbol 同一约定。两边形态不一致的话，
#: 同一个代码在这张目录里和在行情里会长得不一样，对不上。
_CLASS_SEP = str.maketrans("-", ".")


def _norm_symbol(raw):
    """代码归一化：去空格、转大写、连字符 → 点号。"""
    return str(raw or "").strip().upper().translate(_CLASS_SEP)


CST = timezone(timedelta(hours=8))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-cap", type=float, default=50e6, help="市值下限（美元），默认 50M")
    ap.add_argument("--max-pages", type=int, default=700, help="翻页上限（安全阀）")
    ap.add_argument("--delay", type=float, default=PAGE_DELAY)
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()

    # 市值下限交给 Finviz 的筛选词；这里只做兜底二次过滤（源层偶有越界）。
    filters = FILTERS
    prov = providers.FinvizProvider(page_delay=args.delay)

    rows, seen, dropped = [], set(), 0
    t0 = time.time()
    errors = []

    for page in range(args.max_pages):
        try:
            page_rows = prov.fetch_page(filters, ORDER, page)
        except providers.ProviderError as e:
            # 单页失败不致命：记下来继续翻，最后如实报出有多少页没取到。
            errors.append(f"第 {page + 1} 页：{e}")
            print(f"  第 {page + 1} 页失败：{e}", flush=True)
            time.sleep(2.0)
            continue

        if not page_rows:
            print(f"  第 {page + 1} 页起无数据 → 结束（共 {len(rows)} 只）", flush=True)
            break

        for r in page_rows:
            sym = _norm_symbol(r.get("symbol"))
            if not sym or sym in seen:
                continue
            cap = r.get("marketCap")
            if cap is not None and cap < args.min_cap:
                continue
            sector = (r.get("sector") or "").strip()
            industry = (r.get("industry") or "").strip()
            # 注意：Finviz 给 ETF / 封闭式基金 / SPAC 空壳也**照给** sector 与 industry
            # （ETF 的 industry 恒为 "Exchange Traded Fund"，空壳是 "Shell Companies"），
            # 所以「没有板块也没有行业就跳过」这条**过滤不掉它们**。
            # 这里刻意**不过滤**：这一页叫「所有美股」，用户要的就是全量清单，
            # 想只看经营性公司用行业下拉筛一下即可（或按下面的 etfCount / fundCount 取数）。
            # 真正无分类的（极少）才丢，那种行留着只会让人以为数据缺了。
            if not sector and not industry:
                dropped += 1
                continue
            seen.add(sym)
            rows.append({
                "symbol": sym,
                "name": (r.get("name") or "").strip(),
                "sector": sector,
                "industry": industry,
                "marketCap": cap,
                "country": (r.get("country") or "").strip(),
            })

        if (page + 1) % 20 == 0 or page < 3:
            print(f"  第 {page + 1} 页 → 累计 {len(rows)} 只 "
                  f"（{time.time() - t0:.0f}s）", flush=True)
        if page + 1 < args.max_pages:
            time.sleep(args.delay)

    if not rows:
        raise SystemExit("没抓到任何数据 —— 检查网络/代理，或 Finviz 是否改版")

    rows.sort(key=lambda r: r["symbol"])      # 目录按代码字母序，便于查找

    sectors = sorted({r["sector"] for r in rows if r["sector"]})
    industries = sorted({r["industry"] for r in rows if r["industry"]})

    # 非经营性标的的构成。这一页收的是**全量**清单，但得让人一眼看出里面有多少不是公司：
    # ETF → industry 恒为 "Exchange Traded Fund"；各类基金（含封闭式）名字里带 Fund；
    # SPAC 空壳 → "Shell Companies"。一律按 industry 判定，**不另设 flag 字段** ——
    # 前端要只看公司时按 industry 排掉即可，多一套标记就多一套会漂移的口径。
    etf_count = sum(1 for r in rows if r["industry"] == "Exchange Traded Fund")
    fund_count = sum(1 for r in rows if "Fund" in r["industry"])
    shell_count = sum(1 for r in rows if r["industry"] == "Shell Companies")

    out = {
        "builtAt": datetime.now(CST).isoformat(timespec="seconds"),
        "source": "finviz screener（%s，按市值降序翻页）" % filters,
        "count": len(rows),
        "sectorCount": len(sectors),
        "industryCount": len(industries),
        "droppedNoSector": dropped,
        "etfCount": etf_count,
        "fundCount": fund_count,
        "shellCount": shell_count,
        "errors": errors,
        "sectors": sectors,
        "industries": industries,
        "rows": rows,
    }

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    os.replace(tmp, args.out)     # 原子替换：半截文件比没有文件更危险

    print(f"\n完成：{len(rows)} 只 / 板块 {len(sectors)} 种 / 行业 {len(industries)} 种")
    print(f"  跳过无板块无行业的 {dropped} 条（ETF、优先股等）")
    if errors:
        print(f"  ⚠️ 有 {len(errors)} 页未取到，明细见文件 errors 字段")
    print(f"  已写入 {args.out}（{os.path.getsize(args.out) / 1024 / 1024:.2f} MB）")


if __name__ == "__main__":
    main()
