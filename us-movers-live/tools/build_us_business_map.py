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

为什么内容硬编码在脚本里
------------------------
data/*.json 不入库（.gitignore），所以只留 JSON 的话换台机器就没了。
把种子内容放在这个脚本里，仓库就自带可重建的内容源；
后续要加公司，改这里的 PEERS 再重跑即可（也可以在 JSON 上手改，
但那样下次重跑会被覆盖 —— 以 JSON 为准时请同步更新本脚本）。

A 股公司的行业分类与代码都经过 data/a_share_sectors.json（东财导出）核对：
清单里查不到的代码一律不用 —— 那种"看着对"的代码最容易悄悄写错。
"""

import json
import os
from datetime import datetime, timezone, timedelta

CST = timezone(timedelta(hours=8))
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "data", "us_business_map.json")

# ---------------------------------------------------------------- 七姐妹（用户指定先试这 7 家）

ROWS = {
    "AAPL": {
        "name": "Apple Inc.",
        "business": "全球消费电子龙头。硬件是 iPhone / Mac / iPad / Apple Watch / AirPods，"
                    "服务是 App Store、iCloud、Apple Music 等订阅与抽成；自研 M 系与 A 系芯片、"
                    "把 AI 能力放到端侧运行，是它区别于纯代工组装厂商的地方。",
        "peers": [
            {"code": "002475", "name": "立讯精密", "industry": "消费电子",
             "business": "从连接器起家，现为消费电子精密零组件与整机组装的主要厂商之一，"
                         "业务覆盖连接器、声学器件、无线充电、可穿戴设备组装等。"},
            {"code": "601138", "name": "工业富联", "industry": "消费电子",
             "business": "通信及电子设备的智能制造代工龙头，业务含消费电子精密结构件"
                         "与云／AI 服务器整机代工，是产业链里体量最大的制造环节。"},
            {"code": "002241", "name": "歌尔股份", "industry": "消费电子",
             "business": "声学器件与智能硬件厂商，业务含智能声学整机、VR/AR 整机代工"
                         "与精密零组件，智能硬件已占其营收近半。"},
            {"code": "300433", "name": "蓝思科技", "industry": "消费电子",
             "business": "消费电子外观结构件与功能件厂商，主营玻璃盖板、金属中框、"
                         "蓝宝石与陶瓷部件。"},
            {"code": "002938", "name": "鹏鼎控股", "industry": "元件",
             "business": "全球主要的 PCB（印制电路板）厂商之一，产品覆盖消费电子用软板、"
                         "类载板与高密度互连板。"},
        ],
    },
    "MSFT": {
        "name": "Microsoft Corp.",
        "business": "企业软件与云计算。核心是 Azure 公有云、Microsoft 365 订阅、"
                    "Windows 与服务器软件，外带 LinkedIn 与游戏业务。作为 OpenAI 的主要投资方，"
                    "它把 Copilot 系列嵌进全线产品 —— 商业模式是「软件订阅 + 云算力」两层收费。",
        "peers": [
            {"code": "600588", "name": "用友网络", "industry": "软件开发",
             "business": "国内企业管理软件（ERP／财务／人力）的主要厂商之一，"
                         "近年从卖 License 转向云订阅模式。"},
            {"code": "688111", "name": "金山办公", "industry": "软件开发",
             "business": "办公软件与云文档厂商，WPS 系列覆盖桌面与移动端，"
                         "订阅制收入占比持续提升。"},
            {"code": "002230", "name": "科大讯飞", "industry": "软件开发",
             "business": "智能语音与人工智能厂商，业务覆盖教育、医疗、办公等场景的"
                         "语音识别与行业大模型。"},
            {"code": "600845", "name": "宝信软件", "industry": "IT服务Ⅱ",
             "business": "工业软件与数据中心业务并重，源自钢铁行业信息化，"
                         "IDC 业务是另一条主要收入线。"},
            {"code": "300454", "name": "深信服", "industry": "软件开发",
             "business": "企业级网络安全与云计算基础设施厂商，产品含防火墙、"
                         "上网行为管理与超融合一体机。"},
        ],
    },
    "GOOGL": {
        "name": "Alphabet Inc.",
        "business": "全球最大的搜索与数字广告平台（Google Search、YouTube）。"
                    "另有两块：Google Cloud 云业务，以及 Android 生态与自研 TPU 芯片。"
                    "Gemini 大模型是它把 AI 重新塞回搜索与广告库存的抓手。",
        "peers": [
            {"code": "601360", "name": "三六零", "industry": "软件开发",
             "business": "国内以搜索与网络安全为主业的互联网公司，业务含搜索引擎、"
                         "安全软件与政企安全服务。"},
            {"code": "002230", "name": "科大讯飞", "industry": "软件开发",
             "business": "智能语音与人工智能厂商，在大模型与行业应用上投入较大。"},
            {"code": "300058", "name": "蓝色光标", "industry": "广告营销",
             "business": "数字营销服务商，业务含品牌营销、效果广告代理与出海营销。"},
            {"code": "300308", "name": "中际旭创", "industry": "通信设备",
             "business": "全球主要的高速光模块厂商，产品用于数据中心与电信网络的互联。"},
        ],
    },
    "AMZN": {
        "name": "Amazon.com Inc.",
        "business": "全球最大的电商平台，加上全球份额第一的公有云 AWS，"
                    "以及增长很快的广告业务。三块里云的利润率最高，"
                    "是市场给它估值的核心；电商是它的规模与现金流底盘。",
        "peers": [
            {"code": "000977", "name": "浪潮信息", "industry": "计算机设备",
             "business": "国内服务器与存储整机的主要厂商之一，AI 服务器出货量居前。"},
            {"code": "603019", "name": "中科曙光", "industry": "计算机设备",
             "business": "高端计算与存储基础设施厂商，业务含服务器、存储与"
                         "数据中心整体解决方案。"},
            {"code": "300785", "name": "值得买", "industry": "数字媒体",
             "business": "以导购与比价为核心的电商内容平台，收入主要来自"
                         "电商平台的导流分成与广告。"},
            {"code": "002315", "name": "焦点科技", "industry": "互联网电商",
             "business": "B2B 外贸电商平台（中国制造网），为出口企业提供撮合与配套服务。"},
        ],
    },
    "NVDA": {
        "name": "NVIDIA Corp.",
        "business": "全球 AI 算力的核心供应商。数据中心 GPU（含整机与网络互联）是主要收入来源，"
                    "CUDA 软件生态构成护城河；此外还有游戏显卡与汽车／机器人芯片。"
                    "卖的不只是芯片，而是「芯片 + 互联 + 软件栈」的一整套。",
        "peers": [
            {"code": "688256", "name": "寒武纪", "industry": "半导体",
             "business": "国内 AI 芯片设计公司，产品含云端训练／推理加速卡与边缘智能芯片。"},
            {"code": "688041", "name": "海光信息", "industry": "半导体",
             "business": "国产 CPU 与加速卡（DCU）设计厂商，面向服务器与数据中心场景。"},
            {"code": "300308", "name": "中际旭创", "industry": "通信设备",
             "business": "高速光模块厂商 —— AI 集群里算力卡之间靠它做光互联，"
                         "与算力芯片是配套关系而非竞争关系。"},
            {"code": "300474", "name": "景嘉微", "industry": "军工电子Ⅱ",
             "business": "国产图形处理（GPU）芯片设计公司，早期以军用图形显控为主，"
                         "近年拓展通用 GPU。"},
            {"code": "601138", "name": "工业富联", "industry": "消费电子",
             "business": "AI 服务器整机代工的主要厂商之一，处在算力硬件从芯片到机柜的"
                         "组装环节。"},
        ],
    },
    "META": {
        "name": "Meta Platforms Inc.",
        "business": "全球最大的社交媒体公司（Facebook / Instagram / WhatsApp / Messenger，"
                    "约 40 亿月活），收入几乎全部来自数字广告。Reality Labs 做 VR/AR 硬件"
                    "（目前仍在亏损），Llama 系列开源大模型是它在 AI 上的主要投入方向。",
        "peers": [
            {"code": "300058", "name": "蓝色光标", "industry": "广告营销",
             "business": "数字营销服务商，业务覆盖品牌与效果广告代理 —— 对应 Meta 的广告变现侧。"},
            {"code": "300308", "name": "中际旭创", "industry": "通信设备",
             "business": "高速光模块厂商。超大规模数据中心的持续建设会带动其需求，"
                         "与 Meta 的 AI 基础设施投入是上下游关系。"},
            {"code": "002241", "name": "歌尔股份", "industry": "消费电子",
             "business": "VR/AR 整机代工与声学器件厂商，对应 Meta 的硬件（Reality Labs）侧。"},
            {"code": "002273", "name": "水晶光电", "industry": "光学光电子",
             "business": "光学元件厂商，产品含光学薄膜、AR 光波导与半导体光学元件。"},
        ],
    },
    "TSLA": {
        "name": "Tesla Inc.",
        "business": "电动车龙头（Model 3/Y 为主），加上储能业务（Megapack），"
                    "以及自动驾驶（FSD）与人形机器人（Optimus）两块期权。"
                    "电池、电驱、软件与超充网络的垂直整合，是它成本控制的来源。",
        "peers": [
            {"code": "002594", "name": "比亚迪", "industry": "乘用车",
             "business": "国内新能源车龙头，整车与电池、电驱等核心零部件垂直整合，"
                         "同时对外供应动力电池。"},
            {"code": "300750", "name": "宁德时代", "industry": "电池",
             "business": "全球动力电池份额第一，业务含动力电池系统与储能电池系统。"},
            {"code": "601127", "name": "赛力斯", "industry": "乘用车",
             "business": "新能源乘用车厂商，与华为在智能座舱与智能驾驶上深度合作。"},
            {"code": "300124", "name": "汇川技术", "industry": "自动化设备",
             "business": "工业自动化与新能源汽车电驱／电控系统厂商。"},
            {"code": "002050", "name": "三花智控", "industry": "家电零部件Ⅱ",
             "business": "制冷部件与汽车热管理系统厂商，新能源车热管理是其主要增长线。"},
        ],
    },
}


def verify_against_a_shares(rows):
    """用 A 股板块数据核对每个候选的代码 ↔ 名称 ↔ 行业。

    这一步是防「代码写错但看着像对的」：清单里查不到、或名称/行业对不上就报出来。
    数据文件不存在时跳过（只警告，不阻止生成）。
    """
    path = os.path.join(os.path.dirname(OUT), "a_share_sectors.json")
    if not os.path.exists(path):
        print("  ⚠️ 缺少 data/a_share_sectors.json，跳过核对（建议先跑 import_a_share_sectors.py）")
        return 0
    with open(path, encoding="utf-8") as f:
        index = {r["symbol"]: r for r in (json.load(f).get("rows") or [])}

    bad = 0
    for us, row in rows.items():
        for p in row["peers"]:
            ref = index.get(p["code"])
            if ref is None:
                print(f"  ✗ {us} → {p['code']} {p['name']}：A 股清单里没有这个代码")
                bad += 1
            elif ref["name"] != p["name"]:
                print(f"  ✗ {us} → {p['code']}：名称不符，应为 {ref['name']}（写的是 {p['name']}）")
                bad += 1
            elif ref["industry"] != p["industry"]:
                print(f"  ⚠ {us} → {p['code']} {p['name']}：行业不符，"
                      f"清单里是「{ref['industry']}」（写的是「{p['industry']}」）")
                bad += 1
    return bad


def main():
    rows = {}
    for sym, r in ROWS.items():
        rows[sym] = {
            "symbol": sym,
            "name": r["name"],
            "business": r["business"],
            "peers": r["peers"],
        }

    print("核对 A 股代码 / 名称 / 行业：")
    bad = verify_against_a_shares(rows)
    print("  " + ("全部一致 ✓" if bad == 0 else f"{bad} 处不一致 ✗"))

    out = {
        "builtAt": datetime.now(CST).isoformat(timespec="seconds"),
        "source": "主营业务描述 + A 股业务相似对标；A 股代码／行业经 data/a_share_sectors.json（东财）核对",
        "note": "列出的是业务相似（同赛道对标），不是供应链或股权关系 —— 两者不要混看。",
        "count": len(rows),
        "rows": rows,
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    os.replace(tmp, OUT)

    n = sum(len(r["peers"]) for r in rows.values())
    print(f"\n已写入 {os.path.relpath(OUT)}：{len(rows)} 家美股 / {n} 条 A 股对标"
          f"（{os.path.getsize(OUT) / 1024:.1f} KB）")
    txt = open(OUT, encoding="utf-8").read()
    print(f"markdown 星号自检：{txt.count('**')} 处（应为 0 —— 页面纯文本渲染）")


if __name__ == "__main__":
    main()
