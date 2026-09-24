#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""驱动原因 / A 股映射的读取用例 —— 字段透传与「有映射无原因」的边界。

用法：python3 tools/test_reasons.py      （退出码 0 = 全通过）

为什么需要它
------------
`read_reasons()` 是逐字段**手工挑选**向外输出的（不是把 JSON 原样抛出去），
所以每加一个字段，都可能忘了在服务端加一行透传 —— 症状是**前端拿不到数据、
但不报任何错**：按钮点了弹窗里说「还没有分析」，而文件里明明写着。
2026-09-24 加 A 股映射时就踩在这个点上（服务端只挑 4 个字段）。

另外这条边界必须钉住：**只有映射、还没有驱动原因的条目也要保留**。
两者是各自独立的产物，映射生成得更晚，「有原因、还没映射」或反过来的中间态
都会真实出现。原先的实现写着 `if text:`，一条只有映射的记录会被整个丢掉。

做法：把 server 的路径常量指向临时文件，不碰真实数据。
"""

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import server  # noqa: E402

pass_n, fail_n = 0, 0


def check(name, got, want):
    global pass_n, fail_n
    if got == want:
        pass_n += 1
    else:
        fail_n += 1
        print("  ✗ %s\n      期望 %r\n      实际 %r" % (name, want, got))


def check_true(name, cond):
    global pass_n, fail_n
    if cond:
        pass_n += 1
    else:
        fail_n += 1
        print("  ✗ %s" % name)


def section(t):
    print("\n── %s %s" % (t, "─" * max(0, 58 - len(t))))


TMP = tempfile.mkdtemp(prefix="reasons_test_")
REASONS = os.path.join(TMP, "reasons.json")
MORNING = os.path.join(TMP, "morning.json")

# 指向临时文件；早盘那份默认不存在，只有需要时才建
server.REASONS_PATH = REASONS
server.MORNING_PATH = MORNING


def write_reasons(obj):
    with open(REASONS, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)


def clear_morning():
    if os.path.exists(MORNING):
        os.remove(MORNING)


# ================================================================== 1. 字段透传
section("1. 字段透传（每加一个字段都要在这儿露面）")

MAP = {
    "basis": "us-stock-to-a-share-mapper",
    "generatedAt": "2026-09-24T14:05:33+08:00",
    "categories": ["硬件发布/销量超预期"],
    "driverBreakdown": "硬件扩容 → 开发者池扩容",
    "rows": [{"code": "600728", "name": "佳都科技", "type": "股权/生态",
              "reason": "参与成立 Unity 中国", "evidence": "公司公告",
              "strength": "S", "elasticity": "低", "risk": "占比小"}],
    "logic": ["第一条"],
}

clear_morning()
write_reasons({
    "meta": {"sessionDate": "2026-09-24", "generatedBy": "test"},
    "reasons": {
        "U": {"driver": "Meta Connect 开幕", "basis": "night", "sessionDate": "2026-09-24",
              "aShareMap": MAP},
    },
})
out = server.read_reasons()["reasons"]["U"]
check("driver 透传", out["driver"], "Meta Connect 开幕")
check("from 标记", out["from"], "reasons")
check("tradeDate 取条目自己的 sessionDate", out["tradeDate"], "2026-09-24")
check("basis 透传", out["basis"], "night")
check("aShareMap 被透传", out["aShareMap"] is not None, True)
check("aShareMap 是原样搬运（不裁字段）", out["aShareMap"], MAP)
check("rows 里的字段一个不少", sorted(out["aShareMap"]["rows"][0].keys()),
      sorted(["code", "name", "type", "reason", "evidence", "strength", "elasticity", "risk"]))

# ================================================================== 2. 只有映射 / 只有原因
section("2. 「有原因无映射」与「有映射无原因」都要保留")

write_reasons({
    "meta": {"sessionDate": "2026-09-24"},
    "reasons": {
        "AONLY": {"driver": "只有原因", "sessionDate": "2026-09-24"},
        "MONLY": {"aShareMap": MAP, "sessionDate": "2026-09-24"},
    },
})
r2 = server.read_reasons()["reasons"]
check_true("只有原因 → 有条目", "AONLY" in r2)
check("只有原因 → aShareMap 为 None", r2["AONLY"]["aShareMap"], None)
check_true("只有映射 → 条目也在（原先会整条丢掉）", "MONLY" in r2)
check("只有映射 → driver 给空串而不是缺键", r2["MONLY"]["driver"], "")
check_true("只有映射 → aShareMap 可用", r2["MONLY"]["aShareMap"] is not None)
check("两个条目都算进 count", server.read_reasons()["meta"]["count"], 2)

# 空条目（既无原因也无映射）不该占位
write_reasons({"meta": {}, "reasons": {"EMPTY": {}, "NIL": None}})
check("空条目被跳过", server.read_reasons()["meta"]["count"], 0)

# 旧格式：值直接是字符串
write_reasons({"meta": {}, "reasons": {"OLD": "老格式的一句话原因"}})
r3 = server.read_reasons()["reasons"]
check("兼容旧格式（值是字符串）", r3["OLD"]["driver"], "老格式的一句话原因")
check("旧格式 aShareMap 为 None", r3["OLD"]["aShareMap"], None)

# 代码统一转大写，前端按 symbol 查得中
write_reasons({"meta": {}, "reasons": {"aapl": {"driver": "x"}}})
check_true("代码转大写", "AAPL" in server.read_reasons()["reasons"])

# ================================================================== 3. 早盘回退
section("3. 早盘复盘的回退")

write_reasons({"meta": {}, "reasons": {"U": {"driver": "夜盘的原因"}}})
with open(MORNING, "w", encoding="utf-8") as f:
    json.dump({
        "meta": {"tradeDate": "2026-09-23"},
        "movers": [
            {"symbol": "U", "driver": "早盘也写了这只（不应覆盖夜盘）"},
            {"symbol": "P", "driver": "早盘的原因", "aShareMap": MAP},
            {"symbol": "NODRV"},
        ],
    }, f, ensure_ascii=False)

r4 = server.read_reasons()["reasons"]
check("夜盘已有的不被早盘覆盖", r4["U"]["driver"], "夜盘的原因")
check("夜盘没有的从早盘补", r4["P"]["driver"], "早盘的原因")
check("早盘条目标记为 morning", r4["P"]["from"], "morning")
check("早盘的 tradeDate 用早盘那份", r4["P"]["tradeDate"], "2026-09-23")
check_true("早盘若带映射也一起透传（面向将来早盘加同一列）",
           r4["P"]["aShareMap"] is not None)
check_true("早盘里没有 driver 的行不建条目", "NODRV" not in r4)
clear_morning()

# ================================================================== 4. 坏文件
section("4. 文件损坏时不能连累行情表")
with open(REASONS, "w", encoding="utf-8") as f:
    f.write("{ 这不是 JSON")
try:
    bad = server.read_reasons()
    check_true("坏文件不抛异常且 ok=True", bad["ok"] is True)
    check("坏文件时条目为空", bad["meta"]["count"], 0)
    check_true("坏文件写进 meta.error 便于排障", "error" in bad["meta"])
except Exception as e:  # noqa: BLE001
    check("坏文件不应抛出异常", "抛出了 %s" % type(e).__name__, "不抛")

os.remove(REASONS)
nofile = server.read_reasons()
check_true("文件不存在也不抛异常", nofile["ok"] is True)
check("文件不存在时条目为空", nofile["meta"]["count"], 0)

# ------------------------------------------------------------------ 汇总
print("\n" + "─" * 64)
if fail_n:
    print("通过 %d 项，失败 %d 项 ✗" % (pass_n, fail_n))
    sys.exit(1)
print("全部通过 ✓   共 %d 项" % pass_n)
