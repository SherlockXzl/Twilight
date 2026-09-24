# -*- coding: utf-8 -*-
"""把外部导出的 A 股「行业板块 + 概念题材」清单，导入成本项目格式的 data/a_share_sectors.json。

**为什么不在这里现抓**：这份数据的上游是 levistock（封装东方财富）——
先用 `stocks_all_em()` 拿全量 A 股，再 `sector_stock_belong_em()` 批量补行业板块，
最后遍历 `sector_em(sector_type="concept")` 的每个概念板块、用 `sector_stocks_em()`
取成分股反查出每只票的题材。

但其中 `stocks_all_em` / `sector_em` / `sector_stocks_em` **三个都走东财的 `clist`
接口**，而该接口在部分网络环境下会被服务器直接断开（同一域名同端口的 `ulist.np`
却正常，所以不是网络不通）。因此本项目不在此处重跑抓取，而是接收一台能跑通的机器
导出的 JSON —— 只要那份 JSON 还在，本脚本就能离线把它转成本项目的格式。

上游导出脚本（Windows 侧）与本脚本的输入结构一致：
    {"count": N, "updated": "YYYY-MM-DD HH:MM:SS",
     "stocks": [{"code","name","industry","concepts":[...]}, ...]}

用法：
    python3 tools/import_a_share_sectors.py                      # 用默认源路径
    python3 tools/import_a_share_sectors.py --src /path/x.json   # 指定源文件
    python3 tools/import_a_share_sectors.py --out /path/y.json   # 指定输出
"""

import argparse
import json
import os
from datetime import datetime, timezone, timedelta

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SRC = os.path.expanduser("~/Downloads/stock/stocks_data.json")
DEFAULT_OUT = os.path.join(BASE_DIR, "data", "a_share_sectors.json")

CST = timezone(timedelta(hours=8))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=DEFAULT_SRC, help="上游导出的 stocks_data.json")
    ap.add_argument("--out", default=DEFAULT_OUT, help="输出路径")
    args = ap.parse_args()

    with open(args.src, encoding="utf-8") as f:
        raw = json.load(f)

    stocks = raw.get("stocks") or []
    if not stocks:
        raise SystemExit(f"源文件里没有 stocks 数据：{args.src}")

    rows, industries, concepts = [], set(), set()
    for s in stocks:
        code = (s.get("code") or "").strip()
        if not code:
            continue
        ind = (s.get("industry") or "").strip()
        cps = [c for c in (s.get("concepts") or []) if c]
        # 字段名沿用 night_universe.json 的写法（symbol / name），
        # 这样前端和下游脚本不必为 A 股另写一套取值逻辑；值就是 6 位 A 股代码。
        rows.append({
            "symbol": code,
            "name": (s.get("name") or "").strip(),
            "industry": ind,
            "concepts": cps,
        })
        if ind and ind != "-":
            industries.add(ind)
        concepts.update(cps)

    # 排序沿用上游的口径：题材多的在前，同数量按代码升序。
    # 保持与源文件一致，免得两边顺序不同、对比时以为是数据变了。
    rows.sort(key=lambda r: (-len(r["concepts"]), r["symbol"]))

    out = {
        # 本文件生成时间（= 导入时间）
        "builtAt": datetime.now(CST).isoformat(timespec="seconds"),
        # 上游那份清单自己的更新时间 —— 两个时间要分开，
        # 否则「数据是 9/3 抓的、今天导入的」这件事会被抹掉。
        "dataUpdated": raw.get("updated") or "",
        "source": "levistock（东方财富）导出 → 外部 stocks_data.json 导入",
        "count": len(rows),
        "industryCount": len(industries),
        "conceptCount": len(concepts),
        "emptyConceptCount": sum(1 for r in rows if not r["concepts"]),
        "rows": rows,
    }

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    os.replace(tmp, args.out)          # 原子替换：半截文件比没有文件更危险

    size = os.path.getsize(args.out) / 1024 / 1024
    avg = sum(len(r["concepts"]) for r in rows) / max(len(rows), 1)
    print(f"源文件      : {args.src}")
    print(f"已写入      : {args.out}（{size:.2f} MB）")
    print(f"股票 {len(rows)} 只 / 行业板块 {len(industries)} 种 / 题材 {len(concepts)} 种")
    print(f"平均每只 {avg:.1f} 个题材；无题材 {out['emptyConceptCount']} 只")
    print(f"上游数据时间: {out['dataUpdated'] or '(源文件未提供)'}")


if __name__ == "__main__":
    main()
