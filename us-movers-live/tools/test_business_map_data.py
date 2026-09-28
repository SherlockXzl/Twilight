#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""自检 data/us_business_map.json 与目录是否**对得上**（明暗对照页的映射数据）。

用法：python3 tools/test_business_map_data.py     （退出码 0 = 通过）

为什么需要它
------------
`build_us_business_map.py` 在生成时已经做了一轮强校验，但那是**生成的那一刻**。
之后发生的两件事它管不到：

  1. 重跑了 `tools/build_us_catalog.py`（目录换了一批股票），却没重跑映射生成 ——
     新股票在映射数据里查不到，页面上按钮全灰，而**接口照样 200**，
     看不出任何异常。
  2. 手工改了 JSON 里的某个行业 key（大小写、`&`），前端按 key 查不到，
     那一整个行业悄悄退回空态。

这两类问题的共同点是"页面上不报错、只是少了东西"，所以拿用例盯住。

数据文件不在时**跳过**（退出 0）：`data/*.json` 不入库，换台机器就没有，
不能因此判失败 —— 但要明确打印"未检查"，不能让人误以为查过了。
"""

import json
import os
import re
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)

import server  # noqa: E402  过滤口径的唯一来源（与生成脚本、服务端同一份）

MAP_PATH = os.path.join(BASE_DIR, "data", "us_business_map.json")
CATALOG_PATH = os.path.join(BASE_DIR, "data", "us_catalog.json")

failures = []
checks = 0


def check(name, cond, detail=""):
    global checks
    checks += 1
    if not cond:
        failures.append(f"{name}" + (f"\n      {detail}" if detail else ""))


def main():
    if not os.path.exists(MAP_PATH):
        print(f"跳过：{os.path.relpath(MAP_PATH, BASE_DIR)} 不存在"
              f"（data/*.json 不入库，跑 tools/build_us_business_map.py 生成）")
        return 0

    with open(MAP_PATH, encoding="utf-8") as f:
        d = json.load(f)

    rows = d.get("rows") or {}
    industries = d.get("industries") or {}
    overrides = d.get("overrides") or {}
    keys = server._FUND_INDUSTRY_KEYS

    # ---------------------------------------------------------- 1. 结构
    check("rows 非空", bool(rows), "rows 是空的")
    check("industries 非空", bool(industries), "industries 是空的")

    # ---------------------------------------------------------- 2. 与目录同源
    if os.path.exists(CATALOG_PATH):
        with open(CATALOG_PATH, encoding="utf-8") as f:
            cat = json.load(f)
        kept = [r for r in (cat.get("rows") or [])
                if not any(k in (r.get("industry") or "").lower() for k in keys)]
        check("count 等于目录过滤后的家数", d.get("count") == len(kept),
              f"映射 count={d.get('count')}，目录过滤后={len(kept)}"
              " —— 是不是重建了目录但没重跑 build_us_business_map.py？")
        check("rows 覆盖目录里的每个代码",
              all(r["symbol"].upper() in rows for r in kept),
              "有目录里的代码在 rows 里查不到（页面上那几行按钮会点不动）")
        cat_inds = {r.get("industry") or "" for r in kept}
        missing = sorted(i for i in cat_inds if i and i not in industries)
        check("目录用到的行业都有定义", not missing,
              f"缺: {missing[:5]} —— 行业 key 写错会让整个行业静默失效")

    # ---------------------------------------------------------- 3. 引用完整性
    bad_key = [s for s, r in rows.items() if r.get("industryKey") not in industries]
    check("每行的 industryKey 都能在 industries 里查到", not bad_key,
          f"示例: {bad_key[:5]}")

    orphan = sorted(s for s in overrides if s not in rows)
    check("overrides 的代码都在 rows 里", not orphan,
          f"目录里没有: {orphan}（已退市或改了代码？）")

    # ---------------------------------------------------------- 4. peers 内容
    no_desc = sorted(k for k, v in industries.items() if not (v.get("desc") or "").strip())
    check("每个行业都有 desc 说明", not no_desc, f"缺: {no_desc[:5]}")

    code_re = re.compile(r"^\d{6}$")
    bad_code, no_biz, no_name = [], [], []
    total_peers = 0
    for key, ind in industries.items():
        for p in ind.get("peers") or []:
            total_peers += 1
            if not code_re.match(str(p.get("code") or "")):
                bad_code.append(f"{key} → {p.get('code')}")
            if not p.get("name"):
                no_name.append(f"{key} → {p.get('code')}")
            if not p.get("business"):
                no_biz.append(f"{key} → {p.get('code')}")
    for sym, ov in overrides.items():
        if not ov.get("business"):
            check(f"{sym} 有精写业务描述", False, "overrides 里 business 为空")
        for p in ov.get("peers") or []:
            total_peers += 1
            if not p.get("business"):
                no_biz.append(f"{sym} → {p.get('code')}")

    check("peers 的代码都是 6 位数字", not bad_code, f"示例: {bad_code[:5]}")
    check("peers 都有公司名", not no_name, f"示例: {no_name[:5]}")
    check("peers 都有业务描述", not no_biz, f"示例: {no_biz[:5]}")

    # ---------------------------------------------------------- 5. 纯文本约定
    check("文件里没有 markdown 星号（页面按纯文本渲染）",
          "**" not in json.dumps(d, ensure_ascii=False))

    # ---------------------------------------------------------- 6. 覆盖统计自洽
    covered = sum(1 for s, r in rows.items()
                  if overrides.get(s) or (industries.get(r.get("industryKey")) or {}).get("peers"))
    check("covered 与实际计算一致", d.get("covered") == covered,
          f"文件里 {d.get('covered')}，实算 {covered}")
    check("covered 不超过 count", (d.get("covered") or 0) <= (d.get("count") or 0))
    # 全量覆盖的意义就在于"几乎没有点不开的行"——低于 90% 说明行业表漏了
    ratio = (d.get("covered") or 0) / max(1, d.get("count") or 1)
    check("有对标的家数占比 ≥ 90%", ratio >= 0.9, f"实际 {ratio:.1%}")

    # ---------------------------------------------------------- 7. 接口版本握手
    #
    # `schema` 是「前端已是新版、服务进程还跑着旧代码」时**唯一**能认出错配的东西。
    # 2026-09-28 真踩过：响应结构换成引用式三表后服务没重启，接口照样 200、
    # rows 也照样 4279 家，只是缺 industries/overrides —— 页面于是把每一行都渲染成
    # 「这家公司没有映射数据」，一个不报错的谎（数据一份不少地躺在磁盘上）。
    #
    # 这个数字跨三处：server.BUSINESS_MAP_SCHEMA、static/bizmap.js 的 BizMap.SCHEMA、
    # 以及接口返回值。三处不一致时的症状同上（静默变空状态），所以钉住。
    #
    # 常量 2026-09-28 从 linkage.js 搬到了 bizmap.js —— 早盘总结页的悬停提示也要认
    # 这个号（读同一份数据），两处各写一份迟早只剩一处是对的。所以现在除了比数值，
    # 还要确认 linkage.js **没有**偷偷再存一份。
    with open(os.path.join(BASE_DIR, "static", "bizmap.js"), encoding="utf-8") as f:
        bizmap = f.read()
    m = re.search(r"\bSCHEMA\s*=\s*(\d+)", bizmap)
    check("bizmap.js 里定义了 SCHEMA", bool(m), "没找到 `B.SCHEMA = N`")
    if m:
        check("前端 BizMap.SCHEMA 与服务端 BUSINESS_MAP_SCHEMA 一致",
              int(m.group(1)) == server.BUSINESS_MAP_SCHEMA,
              f"前端 {m.group(1)} / 服务端 {server.BUSINESS_MAP_SCHEMA}"
              " —— 改响应结构时两边要一起改")

    with open(os.path.join(BASE_DIR, "static", "linkage.js"), encoding="utf-8") as f:
        lk = f.read()
    check("linkage.js 从 BizMap 取 schema，没有第二份副本",
          "BizMap.SCHEMA" in lk and not re.search(r"\bBIZ_SCHEMA\s*=\s*\d", lk),
          "它自己又写了一个数字 —— 两处独立演进的结果是接口换了版本而只有一处跟上")

    api = server.read_us_business_map()
    check("接口返回里带 schema", api.get("schema") == server.BUSINESS_MAP_SCHEMA,
          f"实际 {api.get('schema')!r}")
    for field in ("rows", "industries", "overrides"):
        check(f"接口透传了 {field}", field in api,
              "少了它前端组不出映射，且**不会报错**（只会静默变成空状态）")

    print(f"检查 {checks} 项：rows {len(rows)} 家 / 行业 {len(industries)} 个 / "
          f"对标条目 {total_peers} 条 / 有对标 {d.get('covered')} 家"
          f"（{ratio:.1%}）")
    if failures:
        print(f"\n{len(failures)} 项未通过 ✗")
        for f in failures:
            print("  ✗ " + f)
        return 1
    print("全部通过 ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main())
