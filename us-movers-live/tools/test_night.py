#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""夜盘口径用例 —— 时段窗口、基准守卫、扫描、收盘冻结。

用法：python3 tools/test_night.py      （退出码 0 = 全通过）

为什么需要它
------------
夜盘口径（美东周日至周四 20:00–04:00 = 北京 08:00–16:00）踩过的几个坑
**全都是静默的**：算错一场的边界不会报错，只会让页面显示另一场的数据；
用错基准价不会报错，只会算出一个看着正常的错误涨跌幅；
没跑成却照样冻结不会报错，只会把上一份**好的**收盘快照覆盖成空表。
所以这里集中钉住这几件事：
  1. 窗口边界（尤其是**周日 20:00 那一场** —— 那天 weekday 是 6，处理不当会被算成周末）
  2. 基准价的**新鲜度守卫**（过期收盘价宁可不要）
  3. 扫描：涨跌幅怎么算、窗口外的陈旧成交价要被丢掉
  4. `do_refresh` 在"这一轮没跑成"时**不许冻结**收盘快照
"""

import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import alpaca          # noqa: E402
import night_fetch     # noqa: E402
import server          # noqa: E402

pass_n, fail_n = 0, 0


def check(label, got, want):
    global pass_n, fail_n
    if got == want:
        pass_n += 1
        print("  \u2713 %s: %r" % (label, got))
    else:
        fail_n += 1
        print("  \u2717 %s\n      实际: %r\n      期望: %r" % (label, got, want))


def check_true(label, cond, detail=""):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print("  \u2713 %s%s" % (label, (": " + str(detail)) if detail else ""))
    else:
        fail_n += 1
        print("  \u2717 %s  (%s)" % (label, detail))


def section(t):
    print("\n" + t)


# --------------------------------------------------------------- 1. 窗口

section("1. 夜盘窗口：美东周日至周四 20:00–04:00（北京 08:00–16:00 夏令时）")

# 2026-09-22 是周二。往前推：9/20 周日、9/19 周六、9/21 周一。
w = night_fetch.night_window(datetime(2026, 9, 22, 14, 0, tzinfo=timezone.utc))   # 北京 9/22 22:00
check("北京 9/22 22:00（场外）→ 场次", w["tradeDate"], "2026-09-22")
check("  收盘时刻（北京）", w["closeCst"], "09月22日 16:00")
check("  在场内", w["inSession"], False)

w = night_fetch.night_window(datetime(2026, 9, 23, 1, 0, tzinfo=timezone.utc))    # 北京 9/23 09:00
check("北京 9/23 09:00（场内）→ 场次", w["tradeDate"], "2026-09-23")
check("  在场内", w["inSession"], True)
check("  窗口开始(UTC)", w["startUtc"], "2026-09-23T00:00:00")
check("  窗口结束(UTC)", w["endUtc"], "2026-09-23T08:00:00")

w = night_fetch.night_window(datetime(2026, 9, 23, 8, 30, tzinfo=timezone.utc))   # 北京 9/23 16:30
check("北京 9/23 16:30（刚收盘）→ 场次", w["tradeDate"], "2026-09-23")
check("  在场内", w["inSession"], False)

# ⚠️ 核心回归点：周日 20:00 那一场。ET 周日 20:00 = UTC 周一 00:00。
# 那天 ET 的 weekday 是 6（周日）—— 若先判"周末休市"，整场夜盘都会被吞掉。
w = night_fetch.night_window(datetime(2026, 9, 21, 0, 30, tzinfo=timezone.utc))   # ET 9/20 周日 20:30
check("ET 周日 20:30 → 场次（= 周一那天）", w["tradeDate"], "2026-09-21")
check("  ET 周日 20:30 在场内", w["inSession"], True)

ms = server.market_state(datetime(2026, 9, 21, 0, 30, tzinfo=timezone.utc))
check("market_state 在周日 20:30 判为夜盘（不是周末）", ms["phase"], "night")
check("  且视为开市", ms["open"], True)

ms2 = server.market_state(datetime(2026, 9, 20, 12, 0, tzinfo=timezone.utc))      # ET 周日 08:00
check("ET 周日白天的确是周末休市", ms2["phase"], "weekend")


# --------------------------------------------------------- 2. 基准新鲜度

section("2. 基准价：过期收盘价宁可不要（否则会算出看着正常的错误涨跌幅）")

check("截止 9/22，最近一根是 9/21 → 取到",
      alpaca.close_before([("2026-09-18T04:00:00", 100.0), ("2026-09-21T04:00:00", 110.0)],
                          "2026-09-22T00:00:00"),
      ("2026-09-21T04:00:00", 110.0))
check("截止 9/22，只有 9/01 的日线（过期）→ 丢弃",
      alpaca.close_before([("2026-09-01T04:00:00", 100.0)], "2026-09-22T00:00:00"),
      None)
check("截止 9/22，只有 9/23 的日线（晚于截止）→ 丢弃",
      alpaca.close_before([("2026-09-23T04:00:00", 100.0)], "2026-09-22T00:00:00"),
      None)
check("空列表 → None", alpaca.close_before([], "2026-09-22T00:00:00"), None)


# ------------------------------------------------------------ 3. 扫描

section("3. 扫描：涨跌幅 = 夜盘价 / 前一个常规收盘 − 1，且窗口外的陈旧成交价要丢掉")

cfg = {"big_min_cap": 1e10, "mid_min_cap": 1.5e9, "big_pct": 4.0, "mid_pct": 10.0}

# 造一份域缓存 + 桩掉两个网络函数
real_universe, real_ref, real_over = night_fetch.universe, alpaca.ref_closes, alpaca.overnight_prices

night_fetch.universe = lambda *a, **k: {
    "rows": [
        {"symbol": "BIG", "name": "Big Co", "sector": "Technology", "industry": "Chips",
         "country": "USA", "marketCap": 2e11, "volume": 1e6},
        {"symbol": "MID", "name": "Mid Co", "sector": "Industrials", "industry": "Tools",
         "country": "USA", "marketCap": 5e9, "volume": 1e5},
        {"symbol": "TINY", "name": "Tiny Co", "sector": "Energy", "industry": "Oil",
         "country": "USA", "marketCap": 5e8, "volume": 1e4},
        {"symbol": "FLAT", "name": "Flat Co", "sector": "Utilities", "industry": "Power",
         "country": "USA", "marketCap": 3e10, "volume": 1e5},
    ],
    "count": 4,
}

# 基准：BIG 100 / MID 20 / TINY 2 / FLAT 50
alpaca.ref_closes = lambda syms, before, **k: {
    "BIG": {"close": 100.0, "date": "2026-09-21T04:00:00"},
    "MID": {"close": 20.0, "date": "2026-09-21T04:00:00"},
    "TINY": {"close": 2.0, "date": "2026-09-21T04:00:00"},
    "FLAT": {"close": 50.0, "date": "2026-09-21T04:00:00"},
    "__errors__": [],
}

# 夜盘价：BIG +5%（进大市值表）、MID +12%（进小市值表）、TINY +30%（只进剔除对照）、
# FLAT +0.5%（低于任何阈值，不该出现）
alpaca.overnight_prices = lambda syms, a, b, **k: {
    "BIG": {"price": 105.0, "ts": "2026-09-22T07:59:00", "volume": 1000},
    "MID": {"price": 22.4, "ts": "2026-09-22T07:58:00", "volume": 2000},
    "TINY": {"price": 2.6, "ts": "2026-09-22T07:57:00", "volume": 3000},
    "FLAT": {"price": 50.25, "ts": "2026-09-22T07:56:00", "volume": 4000},
    "__errors__": [],
}

try:
    rows, meta = night_fetch.scan(cfg, log=lambda *_: None)
    by = {r["symbol"]: r for r in rows}
    check("命中的票（FLAT 未达阈值，不该出现）", sorted(by), ["BIG", "MID", "TINY"])
    check("BIG 夜盘涨跌幅", by["BIG"]["chg"], "+5.00%")
    check("BIG 显示的价 = 夜盘价（不是常规收盘价）", by["BIG"]["price"], "105.00")
    check_true("行结构与 Finviz 同构（symbol/name/sector/industry/marketCap/price/chg/volume/source 齐）",
               all(k in by["BIG"] for k in
                   ("symbol", "name", "sector", "industry", "marketCap", "price", "chg",
                    "volume", "source")),
               sorted(by["BIG"]))
    # 市值要按"股数不变、价格变"实时折算：TINY 从 5 亿涨 30% → 6.5 亿
    check("TINY 市值随夜盘价折算（5 亿 × 1.30）", round(by["TINY"]["marketCap"] / 1e8, 2), 6.5)
    check("meta 里带上场次", meta["session"]["tradeDate"], night_fetch.night_window()["tradeDate"])

    # 把来源数据喂给真正的分档逻辑 —— 验证"只换涨跌幅来源、下游一行不改"
    import screening
    res = screening.classify(rows, cfg)
    check("下游分档：大市值表", [r["symbol"] for r in res["big_up"]], ["BIG"])
    check("下游分档：小市值表", [r["symbol"] for r in res["mid_up"]], ["MID"])
    check("下游分档：被剔除对照（市值 < 15 亿）", [r["symbol"] for r in res["excluded"]], ["TINY"])

    # 没有域缓存时必须**明说没跑成**，而不是回一个空榜单
    night_fetch.universe = lambda *a, **k: None
    rows2, meta2 = night_fetch.scan(cfg, log=lambda *_: None)
    check("无域缓存 → 空结果", rows2, [])
    check_true("  且带回 reason（`ok` 判定靠它）", bool(meta2.get("reason")), meta2.get("reason"))
finally:
    night_fetch.universe, alpaca.ref_closes, alpaca.overnight_prices = \
        real_universe, real_ref, real_over


# -------------------------------------------------- 4. 没跑成不许冻结

section("4. 这一轮没跑成时**不许**冻结收盘快照（否则空表会盖掉好的那一份）")

saved = []
real_save = night_fetch.save_close
real_win = night_fetch.night_window
night_fetch.save_close = lambda payload, meta: saved.append((payload, meta))

# 造一个"已收盘"的场次（否则 do_refresh 本来就不会冻结）
closed = {"tradeDate": "2026-09-22", "closeCst": "09月22日 16:00", "inSession": False,
          "startUtc": "2026-09-22T00:00:00", "endUtc": "2026-09-22T08:00:00"}
night_fetch.night_window = lambda now=None: closed

real_fetch = server._fetch_rows
try:
    server.CACHE.payload = None
    server._fetch_rows = lambda: ([], ["模拟：没有域缓存"], 0, False)      # ok=False
    ret = server.do_refresh()
    check("do_refresh 返回 False", ret, False)
    check("  没有写冻结文件（关键）", saved, [])

    server._fetch_rows = lambda: ([], [], 0, True)                          # 跑了，只是没异动
    ret2 = server.do_refresh()
    check("真跑成、只是没异动 → 返回 True", ret2, True)
    check("  且确实冻结了一份（空榜单也是合法结果）", len(saved), 1)
finally:
    server._fetch_rows = real_fetch
    night_fetch.save_close = real_save
    night_fetch.night_window = real_win
    server.CACHE.payload = None



# ------------------------------------------------ 5. 成交价窗口校验

section("5. 成交价必须是**本次夜盘窗口内**的（夜盘收盘后快照里还留着上次的成交）")

W0, W1 = "2026-09-22T00:00:00", "2026-09-22T08:00:00"

# 窗口内的正常成交
snap_in = {"latestTrade": {"p": 105.0, "t": "2026-09-22T07:59:23.707205806Z"},
           "dailyBar": {"v": 12345}}
p_in, ts_in, v_in = alpaca._price_in_window(snap_in, W0, W1)
check("窗口内 → 取到价", p_in, 105.0)
check("  成交量也带出", v_in, 12345)
check("  时间戳截到秒（纳秒被去掉，便于比对）", ts_in, "2026-09-22T07:59:23")

# ⚠️ 核心回归点：夜盘**收盘之后**快照里仍是**上一次夜盘**的成交。
# 不校验就会把昨天的价当"实时价"，页面看起来一切正常。
snap_old = {"latestTrade": {"p": 99.0, "t": "2026-09-19T07:59:00.000000000Z"},
            "dailyBar": {"v": 1}}
p_old, _, _ = alpaca._price_in_window(snap_old, W0, W1)
check("窗口**之前**的陈旧成交 → 丢弃（不许当成实时价）", p_old, None)

# 晚于窗口（理论上不该有，但也要挡）
snap_future = {"latestTrade": {"p": 200.0, "t": "2026-09-23T09:00:00.000000000Z"},
               "dailyBar": {"v": 1}}
p_fut, _, _ = alpaca._price_in_window(snap_future, W0, W1)
check("窗口**之后**的成交 → 丢弃", p_fut, None)

# 没有成交（夜盘流动性低，很多票整段没成交）
p_none, _, _ = alpaca._price_in_window({"dailyBar": {"v": 0}}, W0, W1)
check("没有 latestTrade → None", p_none, None)

# 整只票被筛掉的效果：overnight_prices 用的是同一个函数
real_snapshots = alpaca.snapshots
alpaca.snapshots = lambda syms, feed="overnight", **k: {
    "A": snap_in, "B": snap_old, "__errors__": []}
try:
    q = alpaca.overnight_prices(["A", "B"], W0, W1)
    q.pop("__errors__", None)
    check("overnight_prices 只留下窗口内有成交的票", sorted(q), ["A"])
finally:
    alpaca.snapshots = real_snapshots


# ------------------------------------------------------------ 结果

print("")
if fail_n == 0:
    print("全部通过 \u2713  (%d 项断言)" % pass_n)
    sys.exit(0)
print("有失败项 \u2717  (%d 项失败 / %d 项)" % (fail_n, pass_n + fail_n))
sys.exit(1)
