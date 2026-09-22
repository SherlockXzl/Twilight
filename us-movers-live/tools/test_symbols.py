#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""个人关注池 · 美股代码目录用例（symbols.py）

验三件事：**解析**（目录文本 → 结构化）、**名称清洗**、**搜索排名**。
全部离线 —— 目录文本用内联样本，不联网、不依赖缓存文件，可重复跑。

为什么值得单独测
----------------
这几条改错了都不会报错，只会让建议列表变得"有点怪"：

  · 不剔 `Test Issue=Y` → 交易所的测试标的（如 ZZZTX）混进建议里，
    用户选中后**永远取不到行情**，而页面只会显示"取数失败"，看不出根因；
  · 不跳页脚（`File Creation Time:`）→ 少一条不多，但解析器一旦因此抛异常，
    整个代码库构建失败，表现是"输入框永远没有建议"；
  · 排名顺序错 → 输入 NVD 时第一条是 2 倍做空 ETF 而不是 NVDA。
    列表本身合法、能点、能加，只是**第一条永远是错的**，肉眼很难判定是 bug。

用法：python3 tools/test_symbols.py      （退出码 0 = 全通过）
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import symbols  # noqa: E402

fails = []


def check(label, got, want):
    ok = got == want
    if not ok:
        fails.append(label)
    print("  %s %s: %s%s" % ("✓" if ok else "✗", label, got,
                             "" if ok else "   (期望 %s)" % (want,)))


def section(t):
    print("\n" + t)


# ------------------------------------------------------------------ 样本

NASDAQ_TXT = "\n".join([
    "Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares",
    "AAPL|Apple Inc. - Common Stock|Q|N|N|100|N|N",
    "ACME|Acme Widgets Inc. - Class A Common Stock|Q|N|N|100|N|N",
    "TESTX|Some Exchange Test Issue|Q|Y|N|100|N|N",
    "SPY|SPDR S&P 500 ETF Trust|P|N|N|100|Y|N",
    "ZZZZZZ|Impossible Symbol|Q|N|N|100|N|N",
    "File Creation Time: 0922202609:46|||||||",
])

OTHER_TXT = "\n".join([
    "ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol",
    "BRK.B|Berkshire Hathaway Inc. New Common Stock|N|BRK.B|N|40|N|BRK.B",
    "F|Ford Motor Company Common Stock|N|F|N|100|N|F",
    "TSTZZ|Test Issue Two Common Stock|N|TSTZZ|N|100|Y|TSTZZ",
    "SOXL|Direxion Daily Semiconductor Bull 3X Shares|P|SOXL|Y|100|N|SOXL",
    "File Creation Time: 0922202609:46|||||||",
])

ALL = (symbols.parse_dir(NASDAQ_TXT, "Symbol", "Security Name", "ETF", "Test Issue")
       + symbols.parse_dir(OTHER_TXT, "ACT Symbol", "Security Name", "ETF", "Test Issue"))
BY = {s: (n, e) for s, n, e in ALL}

# ------------------------------------------------------------------ 解析

section("1. 解析目录文本")
check("两条目录合计条数（6 条有效：AAPL/ACME/SPY/ZZZZZZ + BRK.B/F/SOXL）", len(ALL), 7)
check("跳过了页脚行（否则会多一条或解析崩）", sum(1 for s, _, _ in ALL if "creation" in s), 0)
check("剔除了 Test Issue=Y（nasdaq 那份）", "TESTX" in BY, False)
check("剔除了 Test Issue=Y（other 那份）", "TSTZZ" in BY, False)
check("普通代码保留", "AAPL" in BY, True)
check("类别股的点号形态保留", "BRK.B" in BY, True)
check("代码统一大写", "aapl" in BY, False)
check("ETF 标记正确", BY["SPY"][1], True)
check("正股标记正确", BY["AAPL"][1], False)
check("单字母代码不被丢掉", "F" in BY, True)

section("2. 名称清洗：只剥结尾的证券类型后缀")
check("去掉 ' - Common Stock'", BY["AAPL"][0], "Apple Inc.")
check("去掉 'Common Stock' 但保留 Class A（含原有的连字符）", BY["ACME"][0], "Acme Widgets Inc. - Class A")
check("去掉 ' Common Stock'（无连字符）", BY["F"][0], "Ford Motor Company")
check("去掉 ' New Common Stock'（'New' 是冗余的股份类别说明）", BY["BRK.B"][0], "Berkshire Hathaway Inc.")
check("ETF 名字原样保留", BY["SPY"][0], "SPDR S&P 500 ETF Trust")
check("不会把中间的 Class 削掉（否则 BF.A / BF.B 会同名）",
      symbols.clean_name("Brown Forman Inc Class B Common Stock"), "Brown Forman Inc Class B")
check("清洗后为空则回退原文", symbols.clean_name("Common Stock"), "Common Stock")
check("空输入不炸", symbols.clean_name(None), "")

section("3. 解析器的容错：坏行跳过、不整批挂掉")
bad_txt = ("Symbol|Security Name|Test Issue\n"
           "|No Symbol Here|N\n"                  # 代码列为空
           "TOOLONGSYMBOLX|Too Long|N\n"          # 超过 10 位，不是合法美股代码
           "AAPL|Apple Inc|N\n")
rows = symbols.parse_dir(bad_txt, "Symbol", "Security Name", "ETF", "Test Issue")
check("无代码列的行被跳过", [r[0] for r in rows], ["AAPL"])
check("缺 ETF/Test 列时不报错（拿不到就不标记）", rows[0][2], False)
check("空文本返回空", symbols.parse_dir("", "Symbol", "Security Name", "ETF", "Test Issue"), [])

# ------------------------------------------------------------------ 搜索

symbols._items = [
    ("AAPL", "Apple Inc.", False),
    ("AAPL", "duplicate should never happen", False),
    ("NVD", "GraniteShares 2x Short NVDL Daily ETF", True),
    ("NVDA", "NVIDIA Corporation", False),
    ("PSI", "Invesco Semiconductors ETF", True),
    ("PSIG", "PS International Group Ltd.", False),
    ("SOXL", "Direxion Daily Semiconductor Bull 3X Shares", True),
    ("MSFT", "Microsoft Corporation", False),
    ("USB", "U.S. Bancorp", False),
    ("USBC", "USBC, Inc.", False),
    ("APPL", "Apple Hospitality Reit Inc", False),
    ("ZZZ", "Zzz Corp", False),
]
items_orig, symbols._items = symbols._items, symbols._items


def syms(q, limit=10):
    return [r["symbol"] for r in symbols.search(q, limit)]


section("4. 排名：匹配档（完全相等 > 前缀 > 包含 > 名称前缀 > 名称包含）")
check("完全相等排最前", syms("AAPL")[0], "AAPL")
check("前缀命中按字母序", syms("USB"), ["USB", "USBC"])
check("名称匹配也能找到（apple）", "AAPL" in syms("apple"), True)
check("大小写不敏感", syms("aapl"), syms("AAPL"))
check("查不到返回空", syms("QQQQQQ"), [])

section("5. 杠杆 / 反向 ETF 沉底（否则输 NVD 第一条是 2 倍做空）")
check("NVD 的第一条是 NVDA 而不是 NVD", syms("NVD")[0], "NVDA")
check("NVD 本身仍在结果里（只是靠后）", "NVD" in syms("NVD"), True)
check("真正想找杠杆 ETF 仍然找得到", syms("SOXL"), ["SOXL"])
check("PSI 仍然排在自己的名字匹配之前", syms("PSI")[0], "PSI")
check("is_leveraged 认得出 2x/Short/Daily", symbols.is_leveraged("GraniteShares 2x Short NVDL Daily ETF"), True)
check("普通 ETF 不算杠杆", symbols.is_leveraged("Invesco Semiconductors ETF"), False)
check("普通正股不算杠杆", symbols.is_leveraged("NVIDIA Corporation"), False)

section("6. 稳定与边界")
check("同一查询跑两次结果一致", syms("apple"), syms("apple"))
check("limit 生效", len(syms("apple", 1)), 1)
check("limit 越界被夹住（不会返回全部）", len(syms("apple", 9999)) <= 50, True)
check("limit 是坏值时回落 10", len(syms("a", "abc")) <= 10, True)
check("空查询返回空（不要把整个目录倒出来）", syms(""), [])
check("纯空白查询返回空", syms("   "), [])
check("None 查询返回空", symbols.search(None), [])

section("7. 没载入代码库时不炸（首次启动的那几秒）")
symbols._items = []
check("返回空列表而不是抛异常", symbols.search("AAPL"), [])
symbols._items = items_orig

print("\n全部通过 ✓" if not fails else "\n%d 项未通过 ✗" % len(fails))
sys.exit(0 if not fails else 1)
