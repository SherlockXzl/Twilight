# -*- coding: utf-8 -*-
"""期股双面 · 源链用例（离线，不发任何网络请求）

    python3 tools/test_duality_source.py     （退出码 0 = 全通过）

这一层出问题的样子**特别难看**：页面一片空白，而日志里什么都不报；
或者更糟 —— 主源被限流一次之后，从此再也没被用过，而没人知道。

所以这里钉五件事：

  1. **谁通用谁**：主源失败要能自动落到备源，十一只标的互不牵连；
  2. **失败记忆**：主源连续失败后别再每次去撞墙（首屏等着呢）；
  3. **记忆必须会过期**：否则"这次限流"会变成"这辈子都不再用它" ——
     备源一直成功，主源永远等不到清零的那次成功，这是个死锁，不是优化；
  4. **归一化**：涨跌幅要在截断之前算（截断后第一根没有前收，会算出假的 0%），
     而长度要截到 KLINE_LIMIT；
  5. **总市值**（2026-10-08 起）：只有股票有、两个源互为备份、字段位置与单位
     都不能错 —— 它直接决定「区间数据」表的排序，却不会在页面上报任何错。

做法：把 SRC_FUNCS / CAP_FUNCS 换成桩函数，其余走真实代码路径。
"""

import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import duality  # noqa: E402

# ⚠️ 用例**绝不能碰生产那份降级缓存**（data/duality_cache.json）。
#    fetch_all() 成功一次就会落盘，而这个文件跑的是**桩标的**（"测试期货"/"测试股"）——
#    2026-10-12 实测踩到：跑一遍用例，盘上那份缓存被换成 2 条桩数据（数量、名字、日期
#    全是假的）。它平时不显眼，但三个源同时挂掉时页面会把它当"上次成功的行情"端上来，
#    而且红条上写的是"这是 09:48 缓存的数据" —— 看起来无比正常。
#    改成写到临时文件，跑完清掉。
_TMP_CACHE = os.path.join(tempfile.gettempdir(), "duality_source_test_cache.json")
duality.DUALITY_CACHE_PATH = _TMP_CACHE

pass_n = 0
fail_n = 0


def ok(name, cond, extra=None):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print("  \033[32m✓\033[0m " + name)
    else:
        fail_n += 1
        print("  \033[31m✗\033[0m " + name + ("  → %s" % extra if extra is not None else ""))


def section(t):
    print("\n\033[1m" + t + "\033[0m")


def near(a, b, eps=1e-9):
    """浮点比较。涨跌幅是除法算出来的，10.0 实际是 10.000000000000009 ——
    这里要的是"算法对不对"，不是"二进制表示恰好相同"。"""
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(near(x, y, eps) for x, y in zip(a, b))
    return abs(a - b) <= eps


SPEC = {
    "key": "t", "display": "测试标的", "kind": "stock", "unit": "元",
    "market": "测试", "note": "", "group": "gold",
    "sources": [("a", "ARG-A"), ("b", "ARG-B")],
}


def mk_src(tag, ok_flag=True, boom=False):
    """造一个源函数。boom=True 时抛的是**非 DualityError** 的意外异常 ——
    真实世界里那是"上游改了响应结构"，也必须能被兜住并换源。"""
    def fn(arg):
        if boom:
            raise KeyError("结构变了")
        if not ok_flag:
            raise duality.DualityError(tag + " 挂了")
        return ("CODE-" + tag, "NAME-" + tag, ["2026-10-08"], [1.0], [0.0])
    return fn


def reset():
    duality.clear_cache()
    duality.SRC_FUNCS = {"a": mk_src("a"), "b": mk_src("b")}
    duality.INSTRUMENTS = [SPEC]


# ============================================================ 1) 源链
section("源链：谁通用谁")

reset()
r = duality._fetch_one(SPEC)
ok("主源正常时用主源", r[1] == "NAME-a", r[1])
ok("成功后不留失败记忆", duality._SRC_FAIL == {}, duality._SRC_FAIL)

reset()
duality.SRC_FUNCS["a"] = mk_src("a", ok_flag=False)
r = duality._fetch_one(SPEC)
ok("主源失败 → 落到备源", r[1] == "NAME-b", r[1])
ok("备源的成功不会去清主源的失败计数", "a" in duality._SRC_FAIL, duality._SRC_FAIL)

reset()
duality.SRC_FUNCS["a"] = mk_src("a", boom=True)
r = duality._fetch_one(SPEC)
ok("源抛意外异常（不是 DualityError）也能换源", r[1] == "NAME-b", r[1])

reset()
duality.SRC_FUNCS["a"] = mk_src("a", ok_flag=False)
duality.SRC_FUNCS["b"] = mk_src("b", ok_flag=False)
try:
    duality._fetch_one(SPEC)
    ok("全链失败要抛 DualityError", False, "没抛")
except duality.DualityError as e:
    msg = str(e)
    ok("全链失败要抛 DualityError", True)
    ok("错误信息带上每个源的原因（排障要知道是哪一堵墙）",
       "NAME" not in msg and "a 挂了" in msg and "b 挂了" in msg, msg)

# ============================================================ 2) 失败记忆
section("失败记忆：别再每次去撞同一堵墙")

reset()   # a、b 都正常
# 让 a 连失败 3 次
duality.SRC_FUNCS["a"] = mk_src("a", ok_flag=False)
for _ in range(3):
    duality._fetch_one(SPEC)
order = [n for n, _ in duality._ordered_sources(SPEC["sources"])]
ok("主源连失败后，备源被排到前面", order == ["b", "a"], order)

tried = []


def spy_a(arg):
    tried.append("a")
    raise duality.DualityError("a 又挂了")


def spy_b(arg):
    tried.append("b")
    return ("CODE-b", "NAME-b", ["2026-10-08"], [1.0], [0.0])


duality.SRC_FUNCS = {"a": spy_a, "b": spy_b}
duality._fetch_one(SPEC)
ok("有失败记忆时，一次就命中备源（不再先撞主源）", tried == ["b"], tried)

# ============================================================ 3) 记忆必须过期
section("失败记忆会过期（不然就是永久降级）")

ok("保鲜期内仍然是备源优先",
   [n for n, _ in duality._ordered_sources(SPEC["sources"])] == ["b", "a"])
cnt, _ = duality._SRC_FAIL["a"]
duality._SRC_FAIL["a"] = (cnt, time.time() - duality.SRC_MEMORY_TTL - 1)
order = [n for n, _ in duality._ordered_sources(SPEC["sources"])]
ok("过了保鲜期，主源回到原位（会被重新试一次）", order == ["a", "b"], order)

duality.SRC_FUNCS = {"a": mk_src("a"), "b": mk_src("b")}
tried = []
_a = duality.SRC_FUNCS["a"]


def spy_a2(arg):
    tried.append("a")
    return _a(arg)


duality.SRC_FUNCS["a"] = spy_a2
r = duality._fetch_one(SPEC)
ok("恢复后主源重新被使用", tried == ["a"] and r[1] == "NAME-a", tried)
ok("主源成功后失败记忆被清掉", "a" not in duality._SRC_FAIL, duality._SRC_FAIL)

# ============================================================ 4) 归一化
section("归一化：涨跌幅先算、长度后截")

pct = duality._pct_series(None, [100.0, 110.0, 99.0])
ok("逐日涨跌幅正确（首根记 0，因为页面不显示它的单日）",
   near(pct, [0.0, 10.0, -10.0]), pct)

n = duality.KLINE_LIMIT
d, c, p = duality._tail([str(i) for i in range(n + 100)],
                        [float(i) for i in range(n + 100)],
                        [float(i) for i in range(n + 100)])
ok("超长序列截到 KLINE_LIMIT", len(d) == n and len(c) == n and len(p) == n,
   "%d/%d/%d" % (len(d), len(c), len(p)))
ok("截的是**尾部**（保留最新那根）", d[-1] == str(n + 99) and d[0] == str(100),
   d[0] + " → " + d[-1])

d2, c2, p2 = duality._tail(["a", "b"], [1.0, 2.0], [0.0, 1.0])
ok("没超长时原样返回", d2 == ["a", "b"] and c2 == [1.0, 2.0])

# 桩源返回的涨跌幅由 _pct_series 算，必须和"截断后第一根"错开
reset()
long_src = lambda arg: ("C", "N",       # noqa: E731
                        [str(i) for i in range(n + 5)],
                        [float(i + 100) for i in range(n + 5)],
                        [0.0] * (n + 5))
duality.SRC_FUNCS["a"] = lambda arg: (
    "C", "N",
    ["2026-10-07", "2026-10-08"], [100.0, 110.0],
    duality._pct_series(None, [100.0, 110.0]))
r = duality._fetch_one(SPEC)
ok("源函数自算的涨跌幅首根是 0、次根是真实涨跌",
   near(r[4], [0.0, 10.0]), r[4])

# ============================================================ 5) 总市值
#
# 「区间数据」表按市值从大到小排（2026-10-08 用户要求），市值于是成了**能影响页面
# 结论**的一份数据。它出问题的样子很难看：整列变「—」、顺序悄悄退回原样，
# 页面不报任何错。所以这一节把它单独钉住。

section("总市值：只有股票有、两个源互为备份")

CAP_SPECS = [
    {"key": "a", "kind": "stock", "sources": [("em", "1.601899"), ("tencent", "sh601899")]},
    {"key": "b", "kind": "stock", "sources": [("em", "0.001337"), ("tencent", "sz001337")]},
]

duality.clear_cache()
duality.CAP_FUNCS = {"em": lambda specs: {"a": 7.8e11, "b": 1.8e10},
                     "tencent": lambda specs: {}}
caps = duality.fetch_caps(CAP_SPECS)
ok("主源正常时用主源", caps == {"a": 7.8e11, "b": 1.8e10}, caps)


def cap_dead(specs):
    raise duality.DualityError("市值源挂了")


duality.clear_cache()
duality.CAP_FUNCS = {"em": cap_dead, "tencent": lambda specs: {"a": 1.0}}
ok("主源失败 → 落到备源", duality.fetch_caps(CAP_SPECS) == {"a": 1.0},
   duality.fetch_caps(CAP_SPECS))

duality.clear_cache()
duality.CAP_FUNCS = {"em": lambda specs: {}, "tencent": lambda specs: {"b": 2.0}}
ok("主源返回空也算失败 → 继续试备源", duality.fetch_caps(CAP_SPECS) == {"b": 2.0},
   duality.fetch_caps(CAP_SPECS))

duality.clear_cache()
duality.CAP_FUNCS = {"em": cap_dead, "tencent": cap_dead}
try:
    empty = duality.fetch_caps(CAP_SPECS)
    ok("全链失败**不抛异常**、返回空字典（市值只是一列，不该拖垮日线那次取数）",
       empty == {}, empty)
except Exception as e:                                # noqa: BLE001
    ok("全链失败**不抛异常**、返回空字典", False, "抛了 %r" % e)

ok("期货不进市值请求（没有市值这回事）", duality.fetch_caps([]) == {})

section("总市值：解析（喂固定响应，判字段位置对不对）")

# 同 `_src_em` 的真实响应形状，但**顺序刻意打乱**、并且混进一只期货（f20=0）——
# 若实现是按下标去对 secids，这两件事都会让它当场露馅。
EM_TEXT = json.dumps({"rc": 0, "data": {"total": 3, "diff": [
    {"f12": "001337", "f13": 0, "f14": "四川黄金", "f20": 18463200000},
    {"f12": "GC00Y", "f13": 101, "f14": "COMEX黄金", "f20": 0},
    {"f12": "601899", "f13": 1, "f14": "紫金矿业", "f20": 780971744338},
]}})


def tx_line(sym, name, yi):
    """造一行腾讯行情。**总市值必须落在 `~` 分隔后的第 46 个字段（索引 45）** ——
    这个位置是实测钉下来的，换个位置解析就会静默取到别的数（比如流通市值）。"""
    p = ["1", name, sym[2:]] + ["0"] * 50
    p[45] = str(yi)
    return 'v_%s="%s";' % (sym, "~".join(p))


TX_TEXT = tx_line("sh601899", "紫金矿业", 7809.72) + "\n" + tx_line("sz001337", "四川黄金", 184.63)

real_http = duality._http_text
seen = []


def fake_http(url, label, enc="utf-8"):
    seen.append((url, label, enc))
    if "push2" in url:
        return EM_TEXT
    if "qt.gtimg" in url:
        return TX_TEXT
    raise AssertionError("不该请求这个地址：" + url)


duality._http_text = fake_http
try:
    em = duality._cap_em(CAP_SPECS)
    ok("东财：按 f13.f12 认标的（响应顺序打乱也不受影响）",
       near(em.get("a"), 780971744338.0) and near(em.get("b"), 18463200000.0), em)
    ok("东财：f20=0 的（期货 / 停牌）不收 —— 收了会显示成「0 亿」",
       len(em) == 2, em)
    ok("东财：secids 用逗号拼接，且逗号没被编码成 %2C（编码了会被接口拒）",
       "secids=1.601899,0.001337" in seen[-1][0], seen[-1][0])

    tx = duality._cap_tencent(CAP_SPECS)
    ok("腾讯：取到总市值并换算成元（接口给的是亿元）",
       near(tx.get("a"), 780972000000.0) and near(tx.get("b"), 18463000000.0), tx)
    ok("腾讯：按 GBK 解码（默认 utf-8 会把中文名解成乱码，而数字照样能过）",
       seen[-1][2] == "gbk", seen[-1])
finally:
    duality._http_text = real_http

section("总市值：记忆（取不到时别整列变「—」）")

duality.clear_cache()
duality._CAP_MEMO["x"] = (1.0, time.time())
ok("新鲜记忆会被取出来兜底", duality._memo_caps() == {"x": 1.0}, duality._memo_caps())
duality._CAP_MEMO["y"] = (2.0, time.time() - duality.CAP_MEMO_TTL - 1)
ok("过期记忆被丢弃，且顺手从字典里删掉（不然它会一直躺着等哪天顶上一个旧数字）",
   duality._memo_caps() == {"x": 1.0} and "y" not in duality._CAP_MEMO,
   sorted(duality._CAP_MEMO))

section("总市值：接进 fetch_all 之后落在 item 上")

duality.clear_cache()
# 盘上那份真缓存里也有 marketCap（生产数据），不清掉的话下面的断言会**看运气**
duality._read_disk = lambda: None
#: `group` 是**必填**的（fetch_all 会读它，缺了会在子线程里 KeyError ——
#: 那只标的静默消失，页面只是"少一只"，日志也就一行 traceback）。
#: 桩标的照真实配置写全，别让用例的字段集比生产少一块。
STOCK_SPEC = {"key": "t", "display": "测试股", "kind": "stock", "unit": "元",
              "market": "测试", "note": "000001 · 测试", "group": "gold",
              "sources": [("em", "1.000001"), ("tencent", "sz000001")]}
FUT_SPEC = {"key": "f", "display": "测试期货", "kind": "future", "unit": "美元/盎司",
            "market": "COMEX", "note": "测试主连", "group": "gold",
            "sources": [("em", "101.XX00Y"), ("tencent", "xxXX00Y")]}
duality.INSTRUMENTS = [FUT_SPEC, STOCK_SPEC]
duality.SRC_FUNCS = {"em": mk_src("em"), "tencent": mk_src("tencent")}
duality.CAP_FUNCS = {"em": lambda specs: {"t": 123456789.0}, "tencent": lambda specs: {}}
by = {it["key"]: it for it in duality.fetch_all(force=True)["items"]}
ok("股票那只带上了 marketCap", by["t"].get("marketCap") == 123456789.0,
   by["t"].get("marketCap"))
ok("期货那只**没有**这个字段（缺字段 → 页面显示「—」，而不是 0 亿）",
   "marketCap" not in by["f"], sorted(by["f"]))

duality.CAP_FUNCS = {"em": lambda specs: {}, "tencent": lambda specs: {}}
by2 = {it["key"]: it for it in duality.fetch_all(force=True)["items"]}
ok("市值全取不到时用上一次的值顶着（而不是整列变「—」）",
   by2["t"].get("marketCap") == 123456789.0, by2["t"].get("marketCap"))

section("分组随 payload 一起下发")

pl = duality.fetch_all(force=True)
ok("每只标的都带上了自己的 group（前端据此分组，缺了会一组都凑不出来）",
   all(it.get("group") for it in pl["items"]),
   [(it.get("key"), it.get("group")) for it in pl["items"]])
ok("payload 里带分组定义（tab 的顺序与文字都来自后端，前端不另写一份）",
   [g["key"] for g in (pl.get("groups") or [])] == [g["key"] for g in duality.GROUPS],
   pl.get("groups"))

# ============================================================ 6) 配置自检
section("标的配置自检")

duality.INSTRUMENTS = []
duality.SRC_FUNCS = {}
import importlib  # noqa: E402
importlib.reload(duality)      # 还原真实配置

real = duality.INSTRUMENTS
ok("黄金组 6 只 + 白银组 5 只 + 铜组 5 只 = 16 只", len(real) == 16, len(real))

# ---------------------------------------------------------------- 分组（2026-10-12）
#
# 分组的失败形态是**静默少一只 / 少一组**：key 写错一个字母不抛异常，
# 前端按当前分组过滤时那只会被丢掉，图、表看起来都正常。
# 所以这里把三个方向都钉住：① 每只都属于一个已定义的分组；
# ② 每组有且只有一个期货；③ 银组 / 铜组的成员就是用户点名的那几只（代码别改错）。
group_keys = [g["key"] for g in duality.GROUPS]
ok("每组标的都挂在一个已定义的分组上",
   all(x["group"] in group_keys for x in real),
   [(x["key"], x["group"]) for x in real if x["group"] not in group_keys])
ok("分组顺序 = tab 顺序（金 → 银 → 铜，后来的排在后面）",
   group_keys == ["gold", "silver", "copper"], group_keys)
for gk in group_keys:
    grp = [x for x in real if x["group"] == gk]
    ok("「%s」组有且只有一个期货（两条虚线在图上分不出来）" % gk,
       len([x for x in grp if x["kind"] == "future"]) == 1,
       [x["key"] for x in grp])
    ok("「%s」组的期货排在该组第一位（勾选卡与图例按这个顺序读）" % gk,
       grp[0]["kind"] == "future", [x["key"] for x in grp])

silver = [x for x in real if x["group"] == "silver"]
ok("白银组就是用户指定的那四只（湖南白银 / 白银有色 / 豫光金铅 / 盛达资源）",
   [x["display"] for x in silver[1:]] == ["湖南白银", "白银有色", "豫光金铅", "盛达资源"],
   [x["display"] for x in silver[1:]])
ok("纽约银走的是 COMEX 白银（101.SI00Y / SI），不是黄金那套代码",
   silver[0]["sources"] == [("em", "101.SI00Y"), ("sina_fut", "SI")],
   silver[0]["sources"])

copper = [x for x in real if x["group"] == "copper"]
ok("铜组就是用户指定的那四只（江西铜业 / 铜陵有色 / 云南铜业 / 北方铜业）",
   [x["display"] for x in copper[1:]] == ["江西铜业", "铜陵有色", "云南铜业", "北方铜业"],
   [x["display"] for x in copper[1:]])
ok("纽约铜走的是 COMEX 铜（101.HG00Y / HG），不是金银那套代码",
   copper[0]["sources"] == [("em", "101.HG00Y"), ("sina_fut", "HG")],
   copper[0]["sources"])
# ⚠️ 计价单位：COMEX 铜报的是**美元/磅**，不是美元/盎司 —— 抄金银那一行最容易错，
# 而且错了页面不会报错，只会把 6.7 显示成"6.7 美元/盎司"（没人会去核）。
ok("纽约铜的单位是 美元/磅（不是沿用金银的 美元/盎司）",
   copper[0]["unit"] == "美元/磅", copper[0]["unit"])
ok("期货的单位都不为空（页面直接把它印在价格后面）",
   all(x["unit"] for x in real if x["kind"] == "future"),
   [x["unit"] for x in real if x["kind"] == "future"])


def _same_stock(x):
    """同一条源链上的两个源必须指向**同一只票** —— 市场前缀要配套、代码要一致。

    这类错**不会抛异常**：东财 `1.001337` 只会回一句"没有K线"，腾讯 `sh001337`
    也只会返回空数组，最后表现为"这只票取不到"。排查时容易去怀疑网络，
    而其实是配置里少改了一位市场前缀（2026-10-08 加四川黄金时就要判它属深市）。
    期货不适用（纽约金 / 银 / 铜走的是新浪外盘 sina_fut，没有 tencent 源），直接放过。"""
    em = [s[1] for s in x["sources"] if s[0] == "em"]
    tx = [s[1] for s in x["sources"] if s[0] == "tencent"]
    if not em or not tx:
        return x["kind"] != "stock"
    em_id, sym = em[0], tx[0]
    market_ok = (em_id.startswith("1.") and sym.startswith("sh")) or \
                (em_id.startswith("0.") and sym.startswith("sz"))
    return market_ok and em_id.split(".")[-1] == sym[2:]


ok("每只 A 股的两个源指向同一只票（市场前缀配套 + 代码一致）",
   all(_same_stock(x) for x in real),
   [(x["key"], x["sources"]) for x in real if not _same_stock(x)])
ok("每只标的都至少有一条备源（单点依赖是会出事的）",
   all(len(x["sources"]) >= 2 for x in real),
   [(x["key"], len(x["sources"])) for x in real])

# ---------------------------------------------------------------- 降级缓存的 group 对齐
#
# `data/duality_cache.json` 是**上一次成功取数时的代码**写的。旧版本落盘的 item
# 里没有 group，直接端给前端会被按分组过滤整片滤掉 —— 页面看着像"这一组没有数据"，
# 而它对着一份其实有数据的缓存报"取数失败"。见 duality._align_stale_items。
section("落盘缓存降级：按当前配置对齐")

old_items = [
    {"key": "gold", "name": "纽约金", "dates": [], "closes": [], "chgs": []},
    {"key": "silver", "name": "纽约银", "dates": [], "closes": [], "chgs": []},
    {"key": "copper", "name": "纽约铜", "dates": [], "closes": [], "chgs": []},
    {"key": "早就删掉的", "name": "X"},
]
al = duality._align_stale_items(old_items)
ok("旧缓存（没有 group）补上各自的分组",
   [x.get("group") for x in al] == ["gold", "silver", "copper"], al)
ok("配置里已经没有的标的从降级数据里剔掉（不然它会带着回退色出现在图上）",
   [x["key"] for x in al] == ["gold", "silver", "copper"], [x["key"] for x in al])
ok("补的是**当前**配置里的分组，不是照抄缓存",
   all(x["group"] == next(s["group"] for s in real if s["key"] == x["key"]) for x in al))

ok("源名都在 SRC_FUNCS 里（写错了不会报错，只会在运行时静默跳过这个源）",
   all(s[0] in duality.SRC_FUNCS for x in real for s in x["sources"]),
   sorted({s[0] for x in real for s in x["sources"]}))
ok("标的 key 唯一", len({x["key"] for x in real}) == len(real))

# 收尾：临时缓存不留（下次跑会重写）。生产那份**从始至终没被碰过**。
try:
    os.remove(_TMP_CACHE)
except OSError:
    pass

print("\n" + ("\033[32m全部通过 ✓\033[0m  (%d 项)" % pass_n if fail_n == 0
              else "\033[31m有失败项 ✗\033[0m  通过 %d，失败 %d" % (pass_n, fail_n)))
sys.exit(0 if fail_n == 0 else 1)
