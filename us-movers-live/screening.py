# -*- coding: utf-8 -*-
"""统一筛选口径 —— 全项目唯一真源。

任何地方需要判断"什么算大市值异动、什么算小市值异动"，都调用 classify()，
不要在别处重复写阈值，否则口径会漂移。
"""

import os
import re

import taxonomy_zh

# ---------------------------------------------------------------- 配置


def cfg_from_env():
    """阈值全部可用环境变量覆盖，默认值 = 用户既定口径。"""
    return {
        # 大市值：总市值 >= 100 亿美元
        "big_min_cap": float(os.getenv("BIG_MIN_CAP_USD", 10_000_000_000)),
        # 小市值：15 亿 <= 市值 < 100 亿
        "mid_min_cap": float(os.getenv("MID_MIN_CAP_USD", 1_500_000_000)),
        # 涨跌幅阈值（绝对值）
        "big_pct": float(os.getenv("BIG_PCT", 4)),
        "mid_pct": float(os.getenv("MID_PCT", 10)),
    }


# ---------------------------------------------------------------- 解析

_CAP_UNITS = {"K": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}


def parse_cap(s):
    """"344.86B" -> 3.4486e11；"-" / "" -> None"""
    if not s:
        return None
    s = str(s).strip().replace(",", "")
    if s in ("-", "--", "N/A", ""):
        return None
    m = re.match(r"^-?\$?([\d.]+)\s*([KMBT]?)$", s)
    if not m:
        return None
    return float(m.group(1)) * _CAP_UNITS.get(m.group(2), 1)


def parse_pct(s):
    """"+17.16%" -> 17.16；"-4.02%" -> -4.02"""
    if not s:
        return None
    s = str(s).strip().replace("%", "").replace("+", "").replace(",", "")
    if s in ("-", "--", "N/A", ""):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parse_num(s):
    """'1,234.5' -> 1234.5"""
    if s is None:
        return None
    s = str(s).strip().replace(",", "")
    if s in ("-", "--", "N/A", ""):
        return None
    try:
        return float(s)
    except ValueError:
        return None


# ---------------------------------------------------------------- 归一化


def normalize(row):
    """把各数据源的原始行统一成内部结构。缺失字段一律 None，绝不猜。

    板块 / 行业输出中文（`sector` / `industry`），同时保留英文原文
    （`sectorEn` / `industryEn`）供前端做检索与悬浮提示。
    """
    sector_en = (row.get("sector") or "").strip()
    industry_en = (row.get("industry") or "").strip()
    return {
        "symbol": (row.get("symbol") or "").upper(),
        "name": row.get("name") or "",
        "price": parse_num(row.get("price")),
        "chg": parse_pct(row.get("chg")),
        "marketCap": row.get("marketCap"),
        "sector": taxonomy_zh.sector_zh(sector_en),
        "sectorEn": sector_en,
        "industry": taxonomy_zh.industry_zh(industry_en),
        "industryEn": industry_en,
        "country": row.get("country") or "",
        "volume": parse_num(row.get("volume")),
        "source": row.get("source") or "",
    }


def _band_label(cap, cfg):
    if cap is None:
        return "unknown"
    if cap >= cfg["big_min_cap"]:
        return "big"
    if cap >= cfg["mid_min_cap"]:
        return "mid"
    return "tiny"


# ---------------------------------------------------------------- 分类


def classify(rows, cfg):
    """按分档阈值把归一化后的行分成四张表 + 一张被剔除对照表。

    规则（与用户口径一一对应，阈值均为**含等于**）：
      big  : 市值 >= big_min_cap 且 |涨跌幅| >= big_pct
      mid  : mid_min_cap <= 市值 < big_min_cap 且 |涨跌幅| >= mid_pct
      tiny : 市值 < mid_min_cap → 一律剔除；若 |涨跌幅| >= mid_pct 则进对照表

    注意边界是 `>=` 而不是 `>`：用户 2026-09-22 明确要求「涨幅大于等于 4% / 10%」。
    数据源（Finviz）的筛选信号无法确认是否包含恰好在阈值上的标的，因此取数时
    在源层留了 1 个百分点的余量，由这里做精确判定 —— 两者缺一不可，见 providers.py。
    """
    out = {
        "big_up": [], "big_down": [],
        "mid_up": [], "mid_down": [],
        "excluded": [],
        "counts": {},
    }
    seen = set()

    for raw in rows:
        r = normalize(raw)
        sym, chg, cap = r["symbol"], r["chg"], r["marketCap"]
        if not sym or chg is None:
            continue
        if sym in seen:
            continue
        seen.add(sym)

        band = _band_label(cap, cfg)
        if band == "unknown":
            continue

        if band == "big" and abs(chg) >= cfg["big_pct"]:
            (out["big_up"] if chg > 0 else out["big_down"]).append(r)
        elif band == "mid" and abs(chg) >= cfg["mid_pct"]:
            (out["mid_up"] if chg > 0 else out["mid_down"]).append(r)
        elif band == "tiny" and abs(chg) >= cfg["mid_pct"]:
            out["excluded"].append(r)

    out["big_up"].sort(key=lambda r: -r["chg"])
    out["big_down"].sort(key=lambda r: r["chg"])
    out["mid_up"].sort(key=lambda r: -r["chg"])
    out["mid_down"].sort(key=lambda r: r["chg"])
    out["excluded"].sort(key=lambda r: -abs(r["chg"]))

    out["counts"] = {
        "big_up": len(out["big_up"]),
        "big_down": len(out["big_down"]),
        "mid_up": len(out["mid_up"]),
        "mid_down": len(out["mid_down"]),
        "excluded": len(out["excluded"]),
        "total": sum(len(out[k]) for k in ("big_up", "big_down", "mid_up", "mid_down")),
    }
    return out


def criteria_text(cfg, show_down=True):
    """给前端展示的口径说明，保证页面显示的条件和实际逻辑同源。

    show_down=False（只看上涨）时阈值描述要去掉「绝对」二字 —— 否则页面写着
    「涨跌幅绝对值 > 4%」而实际只收上涨的票，展示与逻辑不符。
    """
    pc = "涨跌幅绝对值" if show_down else "涨幅"
    return {
        "big": f"总市值 ≥ {cfg['big_min_cap'] / 1e8:,.0f} 亿美元，{pc} ≥ {cfg['big_pct']:g}%",
        "mid": f"总市值 {cfg['mid_min_cap'] / 1e8:,.0f}–{cfg['big_min_cap'] / 1e8:,.0f} 亿美元，{pc} ≥ {cfg['mid_pct']:g}%",
        "tiny": f"总市值 < {cfg['mid_min_cap'] / 1e8:,.0f} 亿美元，全部剔除（仅列对照）",
    }


def criteria_values(cfg):
    """口径的**数值**形式，与 criteria_text 同源，供前端做筛选。

    为什么文案之外还要单独给一份数字：页面上「大市值 / 小市值」两个筛选项要按
    同一组边界切分数据。若前端自己写死 100 亿 / 15 亿，哪天改了 BIG_MIN_CAP_USD，
    就会出现「说明文字写着 100 亿、筛选却按另一个数切」—— 正是本文件要杜绝的口径漂移。
    所以数字也必须从这里出。
    """
    return {
        "bigMinCap": cfg["big_min_cap"],
        "midMinCap": cfg["mid_min_cap"],
        "bigPct": cfg["big_pct"],
        "midPct": cfg["mid_pct"],
    }
