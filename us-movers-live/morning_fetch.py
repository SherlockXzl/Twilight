#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""早盘总结 —— 原始素材抓取（机械部分）

把「取数」和「分析」分开：本脚本只负责把可靠的原始素材拉全并打印成 JSON，
驱动原因 / 主线归纳 / 关联性分析这些需要判断的部分交给定时任务里的智能体。

用法：
    python3 morning_fetch.py                 # 打印 JSON 到 stdout
    python3 morning_fetch.py -o raw.json     # 同时写文件
    python3 morning_fetch.py --write-morning data/morning.json
                                             # 取数完直接把当日数据落进早盘页（先落草稿，
                                             # 分析成功后再由智能体覆写）
    python3 morning_fetch.py --no-verify     # 跳过全档校验（也不读缓存）

数据来源与分工：
    westock-data-clawhub CLI  —— 三大指数 ETF（SPY/QQQ/DIA）与 个人关注池的日线
    finviz                    —— 全市场涨幅榜，走 providers.FinvizProvider + screening.normalize，
                                 与「夜盘异动」页**同一套抓取、解析与字段口径**（price / chg /
                                 marketCap / sector / industry），两页同一只票的数值必然一致
    （驱动原因不在本脚本范围，交给上层用 news / web_search 补）

异动榜的取数方式是「**全档涨幅降序**」而不是 finviz 的涨幅条件筛（窄筛）——
窄筛少回结果时看不出是"今天确实只有这几只"还是"筛漏了"，全档才能自证完整。
两档合计通常只要 2 次请求 / 4 秒（见 wide_scan 的提前退出条件），并**按交易日缓存**，
所以重跑一次几乎不花时间、也不会因为反复抓取撞上限流。

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

#: 全档校验的缓存目录。缓存键是**交易日** —— 同一交易日重跑任意多次都只抓第一遍，
#: 既省时间，也掐掉「重试 → 再抓 → 再撞限流」的雪崩。缓存可丢，丢了就是重抓一遍。
_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "cache")

#: 异动口径 —— **直接取自 `screening.cfg_from_env()`**，与「夜盘异动」页同一个来源：
#:     大市值：总市值 ≥ 100 亿美元           且 涨幅 ≥ 4%
#:     小市值：15 亿 ≤ 总市值 < 100 亿美元   且 涨幅 ≥ 10%
#:     总市值 < 15 亿美元：一律剔除
#: 阈值全部**含等于**（`classify()` 写的就是 `>=`）。
#:
#: ⚠️ 为什么在这里**再抄一份常量**是错的：两页口径一旦不同，同一个交易日就会给出两份名单，
#:    而且**没有哪一页看得出自己错了** —— 你只会觉得"有一页漏了"。
#:    这不是假设：2026-09-24 之前本页用自己写的「常规 >20亿 & >10% / 巨头 ≥1400亿 & ≥4%」，
#:    那个 1400 亿（≈1万亿人民币）的门槛让 **100–1400 亿区间涨 4%~10% 的中盘股整段落空**。
#:    实测 2026-09-23：本页 4 只 vs 夜盘页 9 只，差的 5 只（VICR/OKTA/IONQ/FORM/DOCU）
#:    全在这一段。现在改为读同一份配置，两边就只能一起变。
#:    （环境变量 BIG_MIN_CAP_USD / MID_MIN_CAP_USD / BIG_PCT / MID_PCT 因此对两页同时生效。）
_CFG = screening.cfg_from_env()
BIG_MIN_CAP, BIG_MIN_CHG = _CFG["big_min_cap"], _CFG["big_pct"]
MID_MIN_CAP, MID_MIN_CHG = _CFG["mid_min_cap"], _CFG["mid_pct"]

#: 「★」标记的门槛：市值 ≥ 1400 亿美元（≈1 万亿人民币）。
#: ⚠️ 它**不是筛选条件** —— 名单只由上面两组阈值决定。这只是在大市值档里给
#:    万亿级公司加一个视觉强调（沿用技能里"万亿巨头"的说法），
#:    去掉它不会改变任何一只票的入选与否。夜盘页没有这一列，所以不构成两页冲突。
GIANT_MARK_CAP = 1400e8

#: 全档校验的两档：**只带市值门槛**、按涨幅降序，本地再套阈值。
#:
#: ⚠️ 不要改回 finviz 的涨幅条件筛（`ta_change_uN`）当唯一来源：那是「窄筛」，
#:    它少回结果时**看不出**是"今天确实只有这几只"还是"筛漏了"。全档降序才能判明。
#:
#: 两档的 finviz 筛选项与阈值的关系（测过再改）：
#:   · `cap_largeover` 恰好就是「≥100 亿美元」，与 big 的市值下限重合，本地不必再卡下界；
#:   · `cap_smallover` 是「≥3 亿美元」，比 mid 的 15 亿下界宽 —— 靠本地卡到 [15亿, 100亿)。
#:     它同时**天然包含大盘股**，所以按涨幅降序时第 1 页往往已经跨到很低涨幅就停下
#:     （2026-09-23 实测：第 1 页 15.34%~4.97%，一页就够）。
_WIDE_BANDS = (
    {"key": "big", "label": "大市值", "filters": "cap_largeover",
     "min_chg": BIG_MIN_CHG, "min_cap": BIG_MIN_CAP, "max_cap": None,
     "chg_strict": False, "cap_strict": False, "max_pages": 6},
    {"key": "mid", "label": "小市值", "filters": "cap_smallover",
     "min_chg": MID_MIN_CHG, "min_cap": MID_MIN_CAP, "max_cap": BIG_MIN_CAP,
     "chg_strict": False, "cap_strict": False, "max_pages": 6},
)


def criteria_text():
    """当前生效的口径文案。同样**取自 screening**，与夜盘页逐字相同 ——
    展示与逻辑同源，不在两处各写一份会让它们漂移的字符串。"""
    return screening.criteria_text(_CFG, show_down=False)


def _chg_of(raw_row):
    """finviz 原始行的 chg 是 '13.69%' 这种字符串；取不到返回 None。"""
    try:
        return float(str(raw_row.get("chg") or "").replace("%", "").replace("+", ""))
    except ValueError:
        return None


def _get_page(url, tries=3, base=2.0):
    """带**有界**退避的取页。

    ⚠️ 退避必须是有界的，这条是踩过坑写下的：2026-09-24 早盘任务超时（超时上限
    90 分钟，写死在应用里），主因之一就是当晚临时脚本用「多页 × 递增退避重试」
    抓全档，撞上限流后一路睡下去，单次调用烧掉 1.9 分钟 + 15.9 分钟。
    宁可**少抓几页并如实报告**，也不要在一个页面上重试到成功 ——
    完整性由 wide_scan 的提前退出条件负责证明，不需要靠重试。
    """
    last = None
    for i in range(tries):
        try:
            return _FINVIZ._parse_page(_FINVIZ._get(url))
        except Exception as e:            # noqa: BLE001 —— 网络层什么都能抛
            last = e
            if i < tries - 1:
                time.sleep(base * (i + 1))
    raise last


def wide_scan(band, session, use_cache=True):
    """抓一档的「全档涨幅降序」→ 本地判定达标标的，并给出完整性结论。

    提前退出条件（这是把耗时从十几分钟压到几秒的关键）
    ------------------------------------------------
    按涨幅降序时，一旦**已抓到的行里的最低涨幅已掉到阈值以下 1 个百分点**，
    后面任何一页只可能更低、不可能再有达标的 —— 立刻停。
    留 1 个百分点余量是为了容忍 finviz 跨页排序不严格
    （`&r=` 与 `o=-change` 组合时顺序不保证，见 SKILL.md「已知坑位」）。
    实测 2026-09-24：两档**各只需 1 页**（常规档第 1 页 13.69%~3.74%，
    巨头档第 1 页 5.52%~2.94%），合计 2 次请求 / 3.7 秒；
    而固定翻 6~8 页的旧写法在同一份数据上要 12+ 次请求并撞限流。

    没降到阈值以下时**如实标注** `verdict` 为 incomplete，不假装完整。

    `use_cache=False` 只表示**不读**缓存（强制重抓）；抓到的新结果仍会写回缓存 ——
    这样手工重扫一次能顺带把当天缓存刷新，下次自动跑就用新的。
    缓存**按交易日分文件**：不按日分的话，第二天会读到昨天的榜单，
    表现是「榜单一整天是空的」，而且没有任何报错。
    """
    cache_path = os.path.join(_CACHE_DIR, "wide_%s_%s.json" % (band["key"], session))

    if use_cache and os.path.exists(cache_path):
        try:
            with open(cache_path, encoding="utf-8") as f:
                cached = json.load(f)
            cached["fromCache"] = True
            return cached
        except (OSError, ValueError):
            pass                          # 缓存坏了就重抓，不因缓存文件把整件事搞挂

    rows, pages, exhausted, note = [], 0, False, ""
    chg_op = ">" if band["chg_strict"] else ">="   # 常规档是严格 >，巨头档含等于
    for page in range(band["max_pages"]):
        url = "%s?v=111&f=%s&o=-change" % (providers.FinvizProvider.BASE, band["filters"])
        if page:
            url += "&r=%d" % (page * 20 + 1)
        try:
            page_rows = _get_page(url)
        except Exception as e:            # noqa: BLE001
            note = "第 %d 页取数失败（%s），结论基于前 %d 页" % (page + 1, type(e).__name__, page)
            break
        pages = page + 1
        rows.extend(page_rows)
        if len(page_rows) < 20:           # 已到最后一页
            exhausted = True
            break
        chgs = [c for c in (_chg_of(r) for r in page_rows) if c is not None]
        if chgs and min(chgs) <= band["min_chg"] - 1.0:
            break                         # 已降到阈值以下，后面不可能再有达标的
        time.sleep(0.4)

    norm = []
    for r in rows:
        n = screening.normalize(r)
        if n["chg"] is None or n["price"] is None:
            continue
        norm.append(n)

    qualified = []
    for n in norm:
        cap = n["marketCap"] or 0
        chg_ok = (n["chg"] > band["min_chg"]) if band["chg_strict"] \
            else (n["chg"] >= band["min_chg"])
        cap_ok = (cap > band["min_cap"]) if band["cap_strict"] \
            else (cap >= band["min_cap"])
        # 分档是**互斥**的两段：小市值 [15亿, 100亿)、大市值 [100亿, ∞)。
        # 上界写成 `>= max_cap 就跳过`（即 `< max_cap` 才要），与 screening.classify 一致；
        # 阈值不重叠，所以同一只票不可能同时落进两档 —— 若哪天改成重叠，wide_scan_all
        # 的去重会兜住重复，但两档的"哪档算对"就没法判了，所以别改成重叠。
        if band["max_cap"] is not None and cap >= band["max_cap"]:
            continue
        if not (chg_ok and cap_ok):
            continue
        qualified.append(n)
    qualified.sort(key=lambda r: (-(r["chg"] or 0), r["symbol"] or ""))

    all_chgs = [n["chg"] for n in norm if n["chg"] is not None]
    min_chg = min(all_chgs) if all_chgs else None

    if not norm:
        verdict = "未取到任何行，无法判定完整性"
    elif min_chg is not None and min_chg <= band["min_chg"] - 1.0:
        verdict = ("已抓 %d 页、最低涨幅降到 %.2f%%（低于判定线 %s%.1f%%），"
                   "说明达标线以上的标的都在已抓范围内 —— 判定无遗漏"
                   % (pages, min_chg, chg_op, band["min_chg"]))
    elif exhausted:
        verdict = ("已抓到源站最后一页（共 %d 页），最低涨幅 %.2f%% —— 判定无遗漏"
                   % (pages, min_chg if min_chg is not None else 0))
    else:
        verdict = ("抓满 %d 页仍未降到阈值 %.1f%% 以下（最低 %.2f%%），"
                   "**本次完整性未获证明**，达标名单可能不全"
                   % (pages, band["min_chg"], min_chg if min_chg is not None else 0))

    result = {
        "key": band["key"],
        "label": band["label"],
        "filters": band["filters"],
        "order": "-change",
        "pages": pages,
        "rowCount": len(norm),
        "maxChg": max(all_chgs) if all_chgs else None,
        "minChg": min_chg,
        "threshold": {"chg": band["min_chg"],
                      "chgOp": chg_op,
                      "cap": band["min_cap"],
                      "capOp": ">" if band["cap_strict"] else ">=",
                      "maxCap": band["max_cap"]},
        "qualified": qualified,
        "verdict": verdict,
        "note": note,
        "sessionDate": session,
        "fetchedAt": datetime.now(CST).isoformat(timespec="seconds"),
        "fromCache": False,
    }

    try:
        os.makedirs(_CACHE_DIR, exist_ok=True)
        tmp = cache_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=1)
        os.replace(tmp, cache_path)
    except OSError:
        pass                              # 缓存写不进去不影响本次结果

    return result


def wide_scan_all(session, use_cache=True):
    """两档全档校验 → (movers, 校验说明)。

    movers 直接由**全档结果本地判定**而来 —— 不再另打一轮窄筛。
    这一改动同时消掉两件事：一是窄筛那 5 次请求，二是"窄筛结果与全档结果不一致时
    该信谁"的老问题。数值管道没变（同样是 FinvizProvider + screening.normalize），
    所以与「夜盘异动」页同一只票的取值仍然完全一致。

    两档的阈值**与夜盘页逐字相同**（见文件上方 BIG_*/MID_* 的说明），
    所以同一个交易日两页给出的是同一份名单 —— 只是本页多写了驱动原因与 A 股映射。
    """
    movers, seen, checks = [], set(), []
    for band in _WIDE_BANDS:
        res = wide_scan(band, session, use_cache=use_cache)
        checks.append({k: res[k] for k in
                       ("key", "label", "filters", "pages", "rowCount", "maxChg", "minChg",
                        "threshold", "qualified", "verdict", "note", "fromCache")})
        for row in res["qualified"]:
            if row["symbol"] in seen:
                continue
            seen.add(row["symbol"])
            row = dict(row)
            # 「★」只做视觉强调（≥1400 亿 = ≈1 万亿人民币），**不参与筛选**。
            # 它不占排序位（2026-09-22 按用户要求），排序仍是纯涨跌幅降序。
            row["giant"] = (row["marketCap"] or 0) >= GIANT_MARK_CAP
            row["driver"] = ""            # 这一段由智能体补，取数脚本不管
            movers.append(row)
    # 涨跌幅降序，并列按代码升序兜底 —— 与 MORNING.md 的排序契约一致
    movers.sort(key=lambda r: (-(r["chg"] or 0), r["symbol"] or ""))
    return movers, checks


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


# ------------------------------------------------------------------ 指数

#: 三大指数用 ETF 代理（`usIXIC`/`usINX`/`usDJI` 的行情接口持续空数据）。
#: 第三个元素是给 finviz 兜底用的裸代码 —— 它认 finviz 的形态，不带 `us` 前缀。
_INDEX_MAP = (("usSPY", "SPY", "标普500（SPY）"),
              ("usQQQ", "QQQ", "纳斯达克100（QQQ）"),
              ("usDIA", "DIA", "道琼斯（DIA）"))


def fetch_indices(session, report):
    """三大指数的收盘与涨跌幅。

    主路是 westock 的 kline（自己算涨跌幅，因为本机没有 `quote` 子命令）；
    但实测它会**整天缺某一日的行** —— 2026-09-23 那次三只全空，脚本只报错、指数块留白，
    当晚是人工用 finviz 补上的。

    指数本来就只是 **ETF 代理**口径，而 finviz 的筛选页带得动 `?t=SPY,QQQ,DIA`
    （与筛选结果同构，复用同一个解析器），所以主路失败时直接用 finviz 兜同一只 ETF，
    不必再接第三个数据源。兜底取到的行与异动榜同管道，口径不会打架。
    """
    idx, missing = [], []
    try:
        kl = kline([c for c, _, _ in _INDEX_MAP])
    except Exception as e:
        kl, _ = {}, report["errors"].append("指数 kline 取数失败：%s" % e)

    for code, bare, name in _INDEX_MAP:
        q = quote_from_kline(kl.get(code) or kl.get(code.upper()) or [], session)
        if q:
            idx.append(dict(code=code, name=name, note="", **q))
        else:
            missing.append((code, bare, name))

    if missing:
        # finviz 兜底：一次请求取三只，失败就整体放弃（不在指数上做重试）
        try:
            rows = _FINVIZ.fetch_tickers([bare for _, bare, _ in missing])
            got = {r["symbol"].upper(): r for r in rows}
            for code, bare, name in missing:
                r = got.get(bare)
                pct = _chg_of(r) if r else None
                close = screening.parse_num(r.get("price")) if r else None
                if pct is None or close is None:
                    report["errors"].append(
                        "指数 %s 未取到 %s 的日线，finviz 兜底也没拿到" % (code, session))
                    continue
                # finviz 只给收盘与涨跌幅，涨跌额按二者反推（前收 = 收盘 / (1 + pct)）
                prev = close / (1 + pct / 100.0) if pct != -100 else close
                idx.append(dict(code=code, name=name, close=close, chgPct=round(pct, 2),
                                chgAbs=round(close - prev, 2), note="finviz 兜底"))
                report["errors"].append(
                    "指数 %s 的 %s 日线缺失，已用 finviz 兜底（来源与非 ETF 口径略有差异）"
                    % (code, session))
        except Exception as e:
            report["errors"].append("指数 finviz 兜底失败：%s" % e)

    order = {c: i for i, (c, _, _) in enumerate(_INDEX_MAP)}
    idx.sort(key=lambda x: order.get(x["code"], 99))
    return idx


# ------------------------------------------------------------------ 落盘

_WEEKDAY_ZH = ("周一", "周二", "周三", "周四", "周五", "周六", "周日")


def date_label(d):
    """`date(2026,9,23)` → `9月23日（周三）`（页头徽章直接显示这个）。"""
    return "%d月%d日（%s）" % (d.month, d.day, _WEEKDAY_ZH[d.weekday()])


def write_morning(path, session, report):
    """把机械字段落成一份**结构完整**的 morning.json（分析字段留空/占位）。

    为什么取数脚本要自己写这个文件
    ----------------------------
    改之前只有「分析全部成功」才会更新 morning.json。一旦分析环节出问题 ——
    超时、模型流中断 —— 文件就停在旧日期，而页面照旧渲染：**读者看到的是前一天的
    行情，且没有任何提示**（`meta.tradeDate` 超过 4 天才标 stale，中间这几天是沉默的）。
    2026-09-24 就是这样：任务 06:55 开跑、流中断两次、08:25 撞 90 分钟硬超时被杀，
    页面停留在 09-23 的复盘。

    现在取数一跑完就先落一份：指数 / 异动榜 / 关注池三个**机械块全部是当日真实数据**，
    驱动原因统一标「分析未完成」，主线与关联性留空数组
    （MORNING.md 的契约允许除 meta 外任何字段缺省，页面按"缺就不渲染那一块"处理）。
    分析成功后智能体覆写它；分析失败也只是少了几段文字，不会整页过期。

    `meta.generatedBy` 写脚本名而不是技能名 —— 排障时一眼能分清这份是**草稿**
    还是分析完成的版本。
    """
    sources = ["finviz"]
    notes = ["本文件由 morning_fetch.py 直接落盘：机械字段（指数 / 异动榜 / 关注池）为当日真实数据，"
             "驱动原因、主线归纳、关联性分析尚未写入 —— 等智能体分析后覆写。"]
    if report.get("errors"):
        notes.append("取数期错误：" + "；".join(report["errors"]))

    doc = {
        "meta": {
            "tradeDate": session,
            "tradeDateLabel": date_label(datetime.strptime(session, "%Y-%m-%d").date()),
            "generatedAt": datetime.now(CST).isoformat(timespec="seconds"),
            "generatedBy": "morning_fetch.py",
            "sources": sources,
            "notes": notes,
        },
        "indices": report.get("indices") or [],
        "marketComment": "",
        "movers": [dict(m, driver=m.get("driver") or "分析未完成 · 待补充") for m in
                   (report.get("movers") or [])],
        "watchlist": report.get("watchlist") or [],
        # 口径文案**从阈值常量生成**，不手写 —— 手写的数字迟到会漂：
        # 2026-09-24 改口径时，这里还写着旧的「市值 ≤ 20 亿美元」，而代码已经在按 15 亿切。
        "excludedNote": ("已剔除杠杆/反向 ETF、权证、SPAC Units、仙股与流动性极差的 OTC；"
                         "市值 < %.0f 亿美元的微盘股不入榜（口径与「夜盘异动」页一致）。"
                         % (MID_MIN_CAP / 1e8)),
        "criteria": criteria_text(),
        "themes": [],
        "linkage": [],
        "aShareHints": [],
    }
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)          # 原子替换：页面永远读不到写了一半的文件
    return doc


# ------------------------------------------------------------------ 主流程

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--out", help="同时把结果写到该文件")
    ap.add_argument("--write-morning", metavar="PATH",
                    help="取数完直接落一份可用（但分析字段未填）的 morning.json")
    ap.add_argument("--no-verify", action="store_true",
                    help="跳过全档校验，也不读缓存（离线排障用）")
    args = ap.parse_args()

    session = last_completed_session()
    # 允许用环境变量覆盖，便于补跑历史
    session = os.getenv("SESSION_DATE", session.isoformat())
    report = {"generatedAt": datetime.now(CST).isoformat(timespec="seconds"),
              "sessionDate": session, "errors": []}

    # 1) 三大指数（ETF 代理）
    try:
        report["indices"] = fetch_indices(session, report)
    except Exception as e:
        report["errors"].append("指数取数失败：%s" % e)

    # 2) 个股异动榜 —— 由「全档涨幅降序」本地判定
    #    口径与「夜盘异动」页**逐字相同**（见文件上方 BIG_*/MID_* 的说明）：
    #      大市值：市值 ≥ 100 亿美元 且 涨幅 ≥ 4%
    #      小市值：15 亿 ≤ 市值 < 100 亿美元 且 涨幅 ≥ 10%
    #      市值 < 15 亿美元：一律剔除
    if args.no_verify:
        report["movers"] = []
        report["errors"].append("已按 --no-verify 跳过全档校验，异动榜为空")
    else:
        try:
            movers, checks = wide_scan_all(session)
            report["movers"] = movers
            report["wideScreen"] = checks
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

    # 4) 先落一份可渲染的 morning.json（降级保险，见 write_morning 的说明）
    if args.write_morning:
        try:
            write_morning(args.write_morning, session, report)
            report["wroteMorning"] = args.write_morning
        except Exception as e:
            report["errors"].append("落 morning.json 失败：%s" % e)

    txt = json.dumps(report, ensure_ascii=False, indent=2)
    print(txt)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(txt)
    return 0


if __name__ == "__main__":
    sys.exit(main())
