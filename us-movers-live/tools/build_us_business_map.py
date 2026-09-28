#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成「明暗对照」页的 A 股公司业务映射数据（data/us_business_map.json）。

用法：python3 tools/build_us_business_map.py

这份数据的定位
--------------
回答的是「**这家美股公司的业务，A 股里谁在做类似的事**」——
看的是主营业务本身，与「涨了没有、为什么涨」无关。
（夜盘异动页那一列「A 股映射」是另一回事：那边是**事件驱动**的映射，
输入是代码 + 驱动原因，产出解释"这个催化剂会传导到谁"。两列的口径不同，
所以数据分开存、渲染器也分开。别把它们合并成一套。）

⚠️ 列出来的是**业务相似**（同赛道对标），**不是供应链或股权关系**。
两者混看会得出错误结论，弹窗里也写明了这一点。

内容从哪来
----------
本脚本只管**逻辑**，内容种子在两个文件里（`data/*.json` 不入库，
只留 JSON 的话换台机器就没了，所以种子必须进仓库）：

    tools/bizmap_data.py        A_POOL：A 股公司池（代码 → 业务描述）
    tools/bizmap_industries.py  INDUSTRIES：Finviz 行业 → 行业说明 + A 股对标
                                OVERRIDES：个别公司的人工精写（七姐妹）

层级：OVERRIDES（公司级） > INDUSTRIES（行业级）。
4279 家里绝大多数是小盘股，没有可靠的中文资料，逐家编造业务描述比不给更糟；
所以行业级说明是**预期行为**，弹窗里会标明这一点。要精写某家公司，加进 OVERRIDES。

校验（不合格就不写文件）
------------------------
1. A 股代码 ↔ 名称 ↔ 行业 一律以 `data/a_share_sectors.json`（东财导出）为准 ——
   池子里的代码在这份清单里查不到就报错，绝不"看着对就写"。
2. INDUSTRIES / OVERRIDES 引用的每个代码，必须先在 A_POOL 里注册过。
3. `data/us_catalog.json` 里出现过的行业，INDUSTRIES 必须全部覆盖 ——
   key 写错（大小写、`&`、连字符）不会报错，只会让整个行业的公司悄悄退回"没有映射"，
   页面上看不出任何异常，所以这里**直接报错退出**，不允许静默漏掉。

基金 / SPAC 空壳的过滤口径**复用 server._FUND_INDUSTRY_KEYS**，不另抄一份 ——
两处各存一份，改了一处另一处不动，页面上显示的家数就会和这里对不上。
"""

import json
import os
import sys
from datetime import datetime, timezone, timedelta

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import server            # noqa: E402  只复用 _FUND_INDUSTRY_KEYS（过滤口径的唯一来源）
import taxonomy_zh       # noqa: E402
from bizmap_data import A_POOL            # noqa: E402
from bizmap_industries import INDUSTRIES, OVERRIDES   # noqa: E402

CST = timezone(timedelta(hours=8))
OUT = os.path.join(BASE_DIR, "data", "us_business_map.json")
A_SHARE_PATH = os.path.join(BASE_DIR, "data", "a_share_sectors.json")
CATALOG_PATH = os.path.join(BASE_DIR, "data", "us_catalog.json")

#: 每家美股最多列几个 A 股对标。超过就截断 —— 弹窗是"扫一眼"的地方，
#: 列十几个会让人干脆不看了。目前手工挑的都在这条线以内。
MAX_PEERS = 6


def _load_json(path, what):
    if not os.path.exists(path):
        print(f"  ✗ 缺少 {os.path.relpath(path, BASE_DIR)}（{what}），先跑生成它的脚本")
        sys.exit(1)
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_a_share():
    """A 股清单：代码 → {name, industry}。名称与行业只信这一份，不手写。"""
    d = _load_json(A_SHARE_PATH, "东财导出的 A 股行业／概念数据")
    return {r["symbol"]: r for r in (d.get("rows") or [])}


def load_catalog_rows():
    """读全市场美股目录，套用与 server.read_us_catalog 相同的过滤口径。

    过滤条件不在这里写死，而是从 server 模块取常量 —— 见模块开头说明。
    """
    d = _load_json(CATALOG_PATH, "Finviz 全市场美股目录")
    keys = server._FUND_INDUSTRY_KEYS
    rows, skipped = [], 0
    for r in d.get("rows") or []:
        if any(k in (r.get("industry") or "").lower() for k in keys):
            skipped += 1
            continue
        rows.append(r)
    return rows, skipped


def norm_spec(spec):
    """把一条 peer 声明归一化成 (代码, 自定义描述或 None)。

    两种写法都支持：
        "300308"                       → 描述从 A_POOL 取
        ["300308", "针对该场景的补充"]  → 用自定义描述（覆盖 A_POOL）
    """
    if isinstance(spec, (list, tuple)):
        code, note = spec[0], spec[1] if len(spec) > 1 else None
        return str(code), (str(note) if note else None)
    return str(spec), None


def build_peer(spec, a_index, where):
    """一条 peer 声明 → 完整的 A 股公司对象（名称与行业来自东财清单）。"""
    code, note = norm_spec(spec)
    if code not in A_POOL:
        print(f"  ✗ {where} 引用了 {code}，但它没有登记在 bizmap_data.A_POOL 里")
        return None
    ref = a_index.get(code)
    if ref is None:
        print(f"  ✗ {where} 引用了 {code}，但 A 股清单（a_share_sectors.json）里查不到")
        return None
    return {"code": code, "name": ref["name"], "industry": ref["industry"],
            "business": note or A_POOL[code]}


def build_industry_peers(key, a_index):
    """某个行业的 A 股对标列表。返回 (列表, 出错数)。"""
    out, bad = [], 0
    for spec in INDUSTRIES[key].get("peers") or []:
        p = build_peer(spec, a_index, f"行业 {key}")
        if p is None:
            bad += 1
        else:
            out.append(p)
    return out[:MAX_PEERS], bad


def main():
    a_index = load_a_share()
    catalog, skipped = load_catalog_rows()
    problems = 0

    print("① 核对 A 股公司池（代码必须存在于东财清单）：")
    missing = [c for c in A_POOL if c not in a_index]
    for c in missing:
        print(f"  ✗ {c}：a_share_sectors.json 里没有这个代码")
    problems += len(missing)
    print(f"  池内 {len(A_POOL)} 家，" +
          ("全部对得上 ✓" if not missing else f"{len(missing)} 家对不上 ✗"))

    print("② 覆盖目录出现过的全部行业（key 写错会让整行业静默失效）：")
    used = sorted({r["industry"] for r in catalog if r.get("industry")})
    absent = [i for i in used if i not in INDUSTRIES]
    for i in absent:
        n = sum(1 for r in catalog if r["industry"] == i)
        print(f"  ✗ 行业「{i}」（{n} 家）在 INDUSTRIES 里没有定义")
    problems += len(absent)
    for k in [k for k in INDUSTRIES if k not in set(used)]:
        print(f"  ⚠ INDUSTRIES 里的「{k}」在目录中没出现过（可能已被上游改名）")
    print(f"  目录用到 {len(used)} 个行业，" +
          ("全部有定义 ✓" if not absent else f"{len(absent)} 个缺失 ✗"))

    print("③ 展开各行业的 A 股对标（引用必须先在池里注册）：")
    industries = {}
    for key in INDUSTRIES:
        peers, bad = build_industry_peers(key, a_index)
        problems += bad
        industries[key] = {
            "zh": taxonomy_zh.industry_zh(key),
            "desc": INDUSTRIES[key]["desc"],
            "peers": peers,
        }
    covered_ind = sum(1 for v in industries.values() if v["peers"])
    print(f"  {len(industries)} 个行业，其中 {covered_ind} 个有 A 股对标、"
          f"{len(industries) - covered_ind} 个如实留空（原因写在各自 desc 里）")

    print("④ 展开人工精写（OVERRIDES）：")
    overrides = {}
    for sym, ov in OVERRIDES.items():
        peers = []
        for spec in ov.get("peers") or []:
            p = build_peer(spec, a_index, sym)
            if p is None:
                problems += 1
            else:
                peers.append(p)
        overrides[sym.upper()] = {"business": ov["business"], "peers": peers[:MAX_PEERS]}
    print(f"  {len(overrides)} 家精写：" + "、".join(sorted(overrides)))

    if problems:
        print(f"\n✗ 共 {problems} 处问题，未写入文件。修好再跑一次。")
        sys.exit(1)

    # ------------------------------------------------------------------ 组装
    # rows 只存「这家美股是谁、归哪个行业」，行业说明与对标列表放在 industries 里共享 ——
    # 4279 份一模一样的行业说明会把 JSON 撑到十几 MB，而它们本来就只有 144 种。
    rows = {}
    for r in catalog:
        rows[r["symbol"].upper()] = {
            "name": r.get("name") or "",
            "industryKey": r.get("industry") or "",
        }
    for sym in overrides:
        if sym not in rows:
            print(f"  ⚠ OVERRIDES 里的 {sym} 不在目录中（可能已退市或改代码），仍会写入")

    covered = sum(1 for sym, r in rows.items()
                  if overrides.get(sym) or industries.get(r["industryKey"], {}).get("peers"))

    out = {
        "builtAt": datetime.now(CST).isoformat(timespec="seconds"),
        "source": "行业级业务说明 + A 股业务相似对标；A 股代码／名称／行业经 "
                  "data/a_share_sectors.json（东财）核对，行业分类来自 Finviz 目录",
        "note": "列出的是业务相似（同赛道对标），不是供应链或股权关系 —— 两者不要混看。",
        "count": len(rows),
        "covered": covered,
        "industryCount": len(industries),
        "rawCount": len(catalog) + skipped,
        "skippedFund": skipped,
        "overrides": overrides,
        "industries": industries,
        "rows": rows,
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, OUT)

    print(f"\n已写入 {os.path.relpath(OUT, BASE_DIR)}："
          f"{len(rows)} 家美股 / {len(industries)} 个行业 / {len(overrides)} 家精写")
    print(f"  有 A 股对标的 {covered} 家（{covered / max(1, len(rows)) * 100:.0f}%），"
          f"其余所属行业在 A 股本身无对标")
    print(f"  文件 {os.path.getsize(OUT) / 1024:.0f} KB（行业说明按行业共享，未逐家冗余）")
    txt = open(OUT, encoding="utf-8").read()
    print(f"  markdown 星号自检：{txt.count('**')} 处（应为 0 —— 页面按纯文本渲染）")


if __name__ == "__main__":
    main()
