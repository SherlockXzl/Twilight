#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""早盘「全档校验」用例（morning_fetch.py 的 wide_scan / wide_scan_all）

验六件事：**提前退出**、**完整性结论的措辞**、**阈值边界与两档互斥**、**按日缓存**、
**口径与夜盘页同源**、**两档合并后的标记与排序**。
全部离线 —— 用合成页替换取页函数，不联网、不写真实缓存，可重复跑。

为什么值得单独测
----------------
这一段的失败方式都是「不报错，只是名单悄悄变了」：

  · 提前退出条件写松（比如把 1 个百分点余量去掉）→ 少抓一页，恰好卡在阈值上的票
    **静默消失**。页面照常渲染，只是少一行，没人会注意到；
  · 阈值边界搞错（`>` 写成 `>=`）→ 收盘正好 4.00% 的票入榜或落榜，这类票几乎每天都有几只；
  · 两档**上界写重**（小市值也收了 ≥100 亿）→ 同一只票出现在两档里，
    「大市值 7 只 + 小市值 4 只 = 11 只」而总数只有 9 —— 数字对不上，但没人会去加；
  · **口径被抄成两份常量** → 两页给出不同名单，且**没有哪一页看得出自己错了**。
    2026-09-24 之前就是这样：早盘页自带一份「巨头 ≥1400 亿」，让 100–1400 亿区间
    涨 4%~10% 的中盘股整段落空（实测 9/23 早盘 4 只 vs 夜盘 9 只）。
    现在两边都读 screening.cfg_from_env()，第 9 节把这个不变量钉住；
  · 结论措辞搞错（没降到阈值以下却说"无遗漏"）→ 把**没验证**冒充**已验证**。
    这比少一只票更糟：它让人停止怀疑；
  · 缓存键用错（不按交易日分）→ 第二天的榜单一整天是空的，因为读到了前一天的缓存；
  · 退避没有上界 → 撞限流后一路睡下去。2026-09-24 早盘任务就是这样烧掉
    1.9 分钟 + 15.9 分钟，最后撞上应用里写死的 90 分钟硬超时。

用法：python3 tools/test_wide_scan.py      （退出码 0 = 全通过）
"""

import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import morning_fetch  # noqa: E402
import providers      # noqa: E402
import screening      # noqa: E402

fails = []


def check(label, got, want):
    ok = got == want
    if not ok:
        fails.append(label)
    print("  %s %s: %s%s" % ("✓" if ok else "✗", label, got,
                             "" if ok else "   (期望 %s)" % (want,)))


def check_true(label, got):
    check(label, bool(got), True)


def section(t):
    print("\n" + t)


# ------------------------------------------------------------------ 桩

#: 缓存写到临时目录，绝不碰 data/cache（否则用例会污染真实取数结果，
#: 且第二次跑就变成"读缓存"而测不到抓取路径）
_TMP_CACHE = tempfile.mkdtemp(prefix="wide_scan_test_")
morning_fetch._CACHE_DIR = _TMP_CACHE

YI = 1e8


def yi(n):
    """**亿美元** → finviz 的市值字符串。

    ⚠️ 单位陷阱，务必用这个函数、不要手写 `"100B"`：
    finviz 的 `B` 是 **10 亿美元**（"1B" = $1,000,000,000 = 10 亿美元），
    所以「100 亿」要写成 `"10B"` 而不是 `"100B"` —— 后者是 1000 亿，差一个数量级。
    这个错误在 2026-09-24 真犯过一次：边界用例全挂，而实现是对的，
    浪费了一轮排查。以后凡是涉及市值的地方都走 yi()。
    """
    return "%gB" % (n / 10.0)


def raw(symbol, chg, cap="5B", price="30.00"):
    """合成一行 finviz 原始数据。

    ⚠️ 形态必须与 providers.FinvizProvider._parse_page 的产出**完全一致** ——
    真实管道里 marketCap 已经被 `_cap()` 转成了 float，而 screening.normalize
    是**直接透传**这个字段的（不再二次解析）。这里如果图省事写字符串，
    测的就不是真实路径了。
    """
    return {
        "symbol": symbol,
        "name": symbol + " Corp",
        "sector": "Technology",
        "industry": "Semiconductors",
        "country": "USA",
        "marketCap": providers._cap(cap),
        "price": price,
        "chg": ("%+.2f%%" % chg) if chg is not None else "",
        "volume": "1,000,000",
        "source": "finviz",
    }


def page(chgs, cap="5B", price="30.00", prefix="S"):
    return [raw("%s%02d" % (prefix, i), c, cap, price) for i, c in enumerate(chgs)]


def lin(hi, lo, n=20):
    """生成 n 个从 hi 线性降到 lo 的涨幅，模拟「按涨幅降序」的一页。"""
    if n == 1:
        return [hi]
    step = (hi - lo) / (n - 1)
    return [round(hi - step * i, 2) for i in range(n)]


#: 两档的 finviz 筛选项（与 _WIDE_BANDS 里一致；改名时这里也要改）
F_MID = "cap_smallover"     # 小市值档
F_BIG = "cap_largeover"     # 大市值档


def fake_fetch(mapping):
    """把 _get_page 换成查表。mapping: {筛选条件: [第0页, 第1页, ...]}"""
    calls = {"n": 0, "urls": []}

    def get(url, tries=3, base=2.0):
        calls["n"] += 1
        calls["urls"].append(url)
        m = re.search(r"[?&]r=(\d+)", url)
        pgno = (int(m.group(1)) - 1) // 20 if m else 0
        for filters, pages in mapping.items():
            if "f=%s&" % filters in url or url.endswith("f=%s" % filters):
                return pages[pgno] if pgno < len(pages) else []
        return []

    return get, calls


def band_of(key, **over):
    b = dict(next(x for x in morning_fetch._WIDE_BANDS if x["key"] == key))
    b.update(over)
    return b


def scan(key, mapping, session="2026-09-23", cache=False, **over):
    get, calls = fake_fetch(mapping)
    orig = morning_fetch._get_page
    morning_fetch._get_page = get
    try:
        res = morning_fetch.wide_scan(band_of(key, **over), session, use_cache=cache)
    finally:
        morning_fetch._get_page = orig
    return res, calls


def syms(res):
    return [r["symbol"] for r in res["qualified"]]


# ------------------------------------------------------------------ 1

section("1. 提前退出：涨幅降到阈值以下就停（这是把耗时压到几秒的关键）")

res, calls = scan("mid", {F_MID: [page(lin(13.69, 3.74)), page(lin(3.0, 1.0))]})
check("只抓了 1 页", res["pages"], 1)
check("只发了 1 次请求", calls["n"], 1)
check("未去抓第 2 页", any("r=21" in u for u in calls["urls"]), False)
# lin(13.69, 3.74) 里 >= 10% 的有 8 个（13.69 起每档约 0.52）
check("达标名单长度正确", len(syms(res)), 8)
check_true("结论写明判定无遗漏", "判定无遗漏" in res["verdict"])
check_true("结论里带上实际最低涨幅", "3.74" in res["verdict"])

# 阈值正好卡在退出线上：min_chg = 阈值 - 1.0 就该停（≤ 而非 <）
res2, _ = scan("mid", {F_MID: [page(lin(13.69, 9.00)), page(lin(8.0, 1.0))]})
check("最低涨幅 = 阈值-1.0 时停下", res2["pages"], 1)

# 差一点：min_chg = 阈值 - 0.9，不该停
res3, _ = scan("mid", {F_MID: [page(lin(13.69, 9.10)), page(lin(8.0, 1.0))]})
check("最低涨幅 = 阈值-0.9 时继续抓", res3["pages"], 2)

# 大市值档的阈值是 4%，退出线更松 —— 单页跨到 4% 以下就停
res_b, _ = scan("big", {F_BIG: [page(lin(9.0, 2.5), cap="200B", prefix="B")]})
check("大市值档：单页已降到 2.5% → 1 页即停", res_b["pages"], 1)
check_true("大市值档结论也写明无遗漏", "判定无遗漏" in res_b["verdict"])

# ------------------------------------------------------------------ 2

section("2. 结论措辞：没验证完就说没验证完，不冒充完整")

res4, _ = scan("mid", {F_MID: [page(lin(13.69, 11.5)), page(lin(11.4, 10.2))]},
               max_pages=2)
check("抓满上限 2 页", res4["pages"], 2)
check_true("结论含『未获证明』", "未获证明" in res4["verdict"])
check_true("不谎称无遗漏", "判定无遗漏" not in res4["verdict"])

res5, _ = scan("mid", {F_MID: [page(lin(20.0, 12.0, n=5), prefix="A")]})
check("源站最后一页（不足 20 行）", res5["pages"], 1)
check_true("翻到底也算判定无遗漏", "最后一页" in res5["verdict"])

res6, _ = scan("mid", {F_MID: [[]]})
check("请求了一次但源站返回空页", res6["pages"], 1)
check("行数为 0", res6["rowCount"], 0)
check_true("结论写『无法判定』", "无法判定" in res6["verdict"])

# ------------------------------------------------------------------ 3

section("3. 阈值边界（大市值 ≥100亿 & ≥4%；小市值 15–100亿 & ≥10%；全部含等于）")

# —— 大市值档 ——
page_big = [
    raw("BIG_AT4", 4.00, cap=yi(2000)),       # 恰好 4.00% → 入（含等于）
    raw("BIG_399", 3.99, cap=yi(2000)),       # 差 0.01 → 不入
    raw("BIG_CAP100", 6.00, cap=yi(100)),     # 市值恰好 100 亿 → 入
    raw("BIG_CAP99", 6.00, cap=yi(99)),       # 99 亿 → 不进大市值（若涨幅够应归小市值）
    raw("BIG_LOW", 1.00, cap=yi(2000)),       # 触发提前退出
]
res7, _ = scan("big", {F_BIG: [page_big]})
got = set(syms(res7))
check("大市值：恰好 4.00% 入榜", "BIG_AT4" in got, True)
check("大市值：3.99% 不入榜", "BIG_399" in got, False)
check("大市值：市值恰好 100 亿入榜", "BIG_CAP100" in got, True)
check("大市值：市值 99 亿不入榜", "BIG_CAP99" in got, False)

# —— 小市值档 ——
page_mid = [
    raw("MID_AT10", 10.00, cap=yi(50)),      # 恰好 10.00% → 入（含等于）
    raw("MID_999", 9.99, cap=yi(50)),        # 差 0.01 → 不入
    raw("MID_CAP15", 12.00, cap=yi(15)),     # 市值恰好 15 亿 → 入
    raw("MID_CAP149", 12.00, cap=yi(14.9)),  # 14.9 亿 → 剔除
    raw("MID_CAP100", 12.00, cap=yi(100)),   # 市值恰好 100 亿 → **不进小市值**（上界是 <）
    raw("MID_CAP99", 12.00, cap=yi(99)),     # 99 亿 → 入
    raw("MID_LOW", 1.00, cap=yi(50)),
]
res8, _ = scan("mid", {F_MID: [page_mid]})
got8 = set(syms(res8))
check("小市值：恰好 10.00% 入榜", "MID_AT10" in got8, True)
check("小市值：9.99% 不入榜", "MID_999" in got8, False)
check("小市值：市值恰好 15 亿入榜", "MID_CAP15" in got8, True)
check("小市值：市值 14.9 亿被剔除", "MID_CAP149" in got8, False)
check("小市值：市值恰好 100 亿不进小市值（上界开区间）", "MID_CAP100" in got8, False)
check("小市值：市值 99 亿入榜", "MID_CAP99" in got8, True)
check("小市值档阈值含上界字段", res8["threshold"]["maxCap"], morning_fetch.BIG_MIN_CAP)
check("大市值档没有上界", res7["threshold"]["maxCap"], None)

# ------------------------------------------------------------------ 4

section("4. 排序：涨跌幅降序，并列按代码升序")

res9, _ = scan("mid", {F_MID: [[
    raw("ZZZ", 15.00, cap=yi(50)), raw("AAA", 15.00, cap=yi(50)),
    raw("MMM", 20.00, cap=yi(50)), raw("LOW", 1.00, cap=yi(50)),
]]})
check("顺序稳定可复现", syms(res9), ["MMM", "AAA", "ZZZ"])

# ------------------------------------------------------------------ 5

section("5. 按交易日缓存（重跑不再抓取，也不跨日串味）")

# 用一个前面几节没碰过的交易日：wide_scan 即使 use_cache=False 也会把结果写回缓存
# （手工重扫一次顺带刷新当天缓存），所以复用 2026-09-23 会直接命中前面写下的缓存。
DAY_A, DAY_B, DAY_BAD = "2026-11-07", "2026-11-08", "2026-11-09"

mapping = {F_MID: [page(lin(13.69, 3.74))]}
get, calls = fake_fetch(mapping)
orig = morning_fetch._get_page
morning_fetch._get_page = get
try:
    r1 = morning_fetch.wide_scan(band_of("mid"), DAY_A, use_cache=True)
    n_after_first = calls["n"]
    r2 = morning_fetch.wide_scan(band_of("mid"), DAY_A, use_cache=True)
    n_after_second = calls["n"]
    morning_fetch.wide_scan(band_of("mid"), DAY_B, use_cache=True)
    n_after_otherday = calls["n"]
finally:
    morning_fetch._get_page = orig

check("首次抓取", n_after_first, 1)
check("首次结果 fromCache=False", r1["fromCache"], False)
check("第二次不再发请求", n_after_second, n_after_first)
check("第二次标记 fromCache=True", r2["fromCache"], True)
check("换交易日会重新抓（不串味）", n_after_otherday > n_after_second, True)

# 缓存文件坏了应当重抓而不是抛异常
b = band_of("mid")
bad_path = os.path.join(_TMP_CACHE, "wide_%s_%s.json" % (b["key"], DAY_BAD))
with open(bad_path, "w", encoding="utf-8") as f:
    f.write("{ 这不是 JSON")
get2, calls2 = fake_fetch({F_MID: [page(lin(13.69, 3.74))]})
morning_fetch._get_page = get2
try:
    r4 = morning_fetch.wide_scan(b, DAY_BAD, use_cache=True)
finally:
    morning_fetch._get_page = orig
check("缓存损坏时正常重抓", calls2["n"], 1)
check("且结果可用", len(syms(r4)), 8)

# ------------------------------------------------------------------ 6

section("6. 取页失败要如实记录，不能崩、也不能假装拿到数据")


def boom(url, tries=3, base=2.0):
    raise RuntimeError("Finviz 拒绝了请求（HTTP 429）")


morning_fetch._get_page = boom
try:
    r5 = morning_fetch.wide_scan(band_of("mid"), "2026-09-30", use_cache=False)
finally:
    morning_fetch._get_page = orig
check("没有崩", r5["pages"], 0)
check("达标名单为空", syms(r5), [])
check_true("note 里写明取数失败", "取数失败" in (r5["note"] or ""))
check_true("结论不冒充完整", "无法判定" in r5["verdict"])

# ------------------------------------------------------------------ 7

section("7. 缺涨跌幅的行跳过（不参与达标判定，也不进 rowCount）")

res10, _ = scan("mid", {F_MID: [[
    raw("NOCHG", None, cap=yi(50)),
    raw("OK", 15.00, cap=yi(50)),
    raw("LOW", 1.00, cap=yi(50)),
]]})
check("缺 chg 的行已跳过", "NOCHG" in syms(res10), False)
check("rowCount 只算可用行", res10["rowCount"], 2)

# ------------------------------------------------------------------ 8

section("8. wide_scan_all：两档合并、去重、★ 标记、两档互斥")

mapping_all = {
    F_MID: [[raw("MID", 12.00, cap=yi(30)), raw("EDGE", 11.00, cap=yi(100)),
             raw("LOW", 1.00, cap=yi(30))]],
    F_BIG: [[raw("EDGE", 5.00, cap=yi(100)), raw("GIA", 4.50, cap=yi(3000)),
             raw("LOW", 1.00, cap=yi(3000))]],
}
get3, _ = fake_fetch(mapping_all)
morning_fetch._get_page = get3
try:
    movers, checks = morning_fetch.wide_scan_all("2026-10-01", use_cache=False)
finally:
    morning_fetch._get_page = orig

names = [m["symbol"] for m in movers]
check("两档合并后按涨幅降序", names, ["MID", "EDGE", "GIA"])
check("跨档重复的代码只出现一次", names.count("EDGE"), 1)
check("校验说明两档各一条", [c["key"] for c in checks], ["big", "mid"])
giant_map = {m["symbol"]: m["giant"] for m in movers}
check("3000 亿（≥1400 亿）标 ★", giant_map["GIA"], True)
check("100 亿级不标 ★（★ 只看 1400 亿）", giant_map["EDGE"], False)
check_true("movers 带 driver 占位字段（交给智能体补）", "driver" in movers[0])

# 两档互斥：市值恰好 100 亿的票只能出现在**大市值**档里
check("市值恰好 100 亿只在大市值档（小市值上界是开区间）",
      "EDGE" in {r["symbol"] for r in checks[0]["qualified"]}, True)
check("且不在小市值档里",
      "EDGE" in {r["symbol"] for r in checks[1]["qualified"]}, False)

# ★ 标记的边界单独验一次（1400 亿）
get4, _ = fake_fetch({F_BIG: [[raw("HUGE", 5.00, cap=yi(1400)),
                               raw("NEAR", 5.00, cap=yi(1399)),
                               raw("LOW", 1.00, cap=yi(1400))]]})
morning_fetch._get_page = get4
try:
    mv2, _ = morning_fetch.wide_scan_all("2026-10-02", use_cache=False)
finally:
    morning_fetch._get_page = orig
star = {m["symbol"]: m["giant"] for m in mv2}
check("市值恰好 1400 亿 → ★", star["HUGE"], True)
check("市值 1399 亿 → 不标 ★", star["NEAR"], False)

# ------------------------------------------------------------------ 9

section("9. 口径必须与「夜盘异动」页同源（不许在本文件里再抄一份常量）")

cfg = screening.cfg_from_env()
check("大市值市值下限取自 screening", morning_fetch.BIG_MIN_CAP, cfg["big_min_cap"])
check("大市值涨幅阈值取自 screening", morning_fetch.BIG_MIN_CHG, cfg["big_pct"])
check("小市值市值下限取自 screening", morning_fetch.MID_MIN_CAP, cfg["mid_min_cap"])
check("小市值涨幅阈值取自 screening", morning_fetch.MID_MIN_CHG, cfg["mid_pct"])

# 文案也必须逐字相同（口径行显示的和实际筛的要是同一件事）
check("口径文案与 screening.criteria_text 逐字一致",
      morning_fetch.criteria_text(), screening.criteria_text(cfg, show_down=False))

# 两档的市值边界要**首尾相接**：小市值上界 == 大市值下界。
# 断掉的话会出现「100 亿整谁的档都不收」这类空隙，而名单只会少一只，不会报错。
WIDE = {b["key"]: b for b in morning_fetch._WIDE_BANDS}
check("小市值上界 == 大市值下界（不留空隙）",
      WIDE["mid"]["max_cap"], WIDE["big"]["min_cap"])
check_true("大市值档没有上界（1500 亿以上也要收）", WIDE["big"]["max_cap"] is None)
check("阈值都是含等于（与 classify 一致）",
      [WIDE["big"]["chg_strict"], WIDE["big"]["cap_strict"],
       WIDE["mid"]["chg_strict"], WIDE["mid"]["cap_strict"]],
      [False, False, False, False])

print("\n全部通过 ✓" if not fails else "\n%d 项未通过 ✗" % len(fails))
sys.exit(0 if not fails else 1)
