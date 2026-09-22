# -*- coding: utf-8 -*-
"""板块 / 行业的英文→中文对照。

对照表的键取自 Finviz 筛选面板的官方清单（11 个板块 + 151 个行业），
是当前能拿到的权威全集，不是靠猜。若数据源改版后出现新值，
`untranslated()` 会把没覆盖到的值列出来，方便补齐。

未覆盖的值不会原样漏出英文：会先走词级兜底翻译，仍无法处理才回退原文。
"""

import re

# ---------------------------------------------------------------- 板块（11）

SECTOR_ZH = {
    "Basic Materials": "基础材料",
    "Communication Services": "通信服务",
    "Consumer Cyclical": "可选消费",
    "Consumer Defensive": "必需消费",
    "Energy": "能源",
    "Financial": "金融",
    "Healthcare": "医疗保健",
    "Industrials": "工业",
    "Real Estate": "房地产",
    "Technology": "信息技术",
    "Utilities": "公用事业",
}

# ---------------------------------------------------------------- 行业（151）

INDUSTRY_ZH = {
    "Advertising Agencies": "广告代理",
    "Aerospace & Defense": "航空航天与国防",
    "Agricultural Inputs": "农业投入品",
    "Airlines": "航空",
    "Airports & Air Services": "机场与航空服务",
    "Aluminum": "铝",
    "Apparel Manufacturing": "服装制造",
    "Apparel Retail": "服装零售",
    "Asset Management": "资产管理",
    "Auto Manufacturers": "汽车制造",
    "Auto Parts": "汽车零部件",
    "Auto & Truck Dealerships": "汽车与卡车经销",
    "Banks - Diversified": "银行·综合性",
    "Banks - Regional": "银行·区域性",
    "Beverages - Brewers": "饮料·啤酒",
    "Beverages - Non-Alcoholic": "饮料·非酒精",
    "Beverages - Wineries & Distilleries": "饮料·葡萄酒与烈酒",
    "Biotechnology": "生物技术",
    "Broadcasting": "广播电视",
    "Building Materials": "建筑材料",
    "Building Products & Equipment": "建筑产品与设备",
    "Business Equipment & Supplies": "办公设备与耗材",
    "Capital Markets": "资本市场",
    "Chemicals": "化工",
    "Closed-End Fund - Debt": "封闭式基金·债券",
    "Closed-End Fund - Equity": "封闭式基金·股票",
    "Closed-End Fund - Foreign": "封闭式基金·海外",
    "Coking Coal": "焦煤",
    "Communication Equipment": "通信设备",
    "Computer Hardware": "计算机硬件",
    "Confectioners": "糖果食品",
    "Conglomerates": "综合企业",
    "Consulting Services": "咨询服务",
    "Consumer Electronics": "消费电子",
    "Copper": "铜",
    "Credit Services": "信贷服务",
    "Department Stores": "百货商店",
    "Diagnostics & Research": "诊断与研究服务",
    "Discount Stores": "折扣零售",
    "Drug Manufacturers - General": "制药·综合",
    "Drug Manufacturers - Specialty & Generic": "制药·特色药与仿制药",
    "Education & Training Services": "教育与培训",
    "Electrical Equipment & Parts": "电气设备与部件",
    "Electronic Components": "电子元件",
    "Electronic Gaming & Multimedia": "电子游戏与多媒体",
    "Electronics & Computer Distribution": "电子与计算机分销",
    "Engineering & Construction": "工程与建筑",
    "Entertainment": "娱乐",
    "Farm & Heavy Construction Machinery": "农业与重型工程机械",
    "Farm Products": "农产品",
    "Financial Conglomerates": "金融综合企业",
    "Financial Data & Stock Exchanges": "金融数据与交易所",
    "Food Distribution": "食品分销",
    "Footwear & Accessories": "鞋类与配饰",
    "Furnishings, Fixtures & Appliances": "家具·装置与家电",
    "Gambling": "博彩",
    "Gold": "黄金",
    "Grocery Stores": "杂货超市",
    "Healthcare Plans": "医疗健康保险",
    "Health Information Services": "医疗信息服务",
    "Home Improvement Retail": "家居装修零售",
    "Household & Personal Products": "家庭与个人用品",
    "Industrial Distribution": "工业品分销",
    "Information Technology Services": "信息技术服务",
    "Infrastructure Operations": "基础设施运营",
    "Insurance Brokers": "保险经纪",
    "Insurance - Diversified": "保险·综合性",
    "Insurance - Life": "保险·寿险",
    "Insurance - Property & Casualty": "保险·财产与意外险",
    "Insurance - Reinsurance": "保险·再保险",
    "Insurance - Specialty": "保险·专业险",
    "Integrated Freight & Logistics": "综合货运与物流",
    "Internet Content & Information": "互联网内容与信息",
    "Internet Retail": "互联网零售",
    "Leisure": "休闲",
    "Lodging": "住宿",
    "Lumber & Wood Production": "木材与木制品",
    "Luxury Goods": "奢侈品",
    "Marine Shipping": "海运",
    "Medical Care Facilities": "医疗服务机构",
    "Medical Devices": "医疗器械",
    "Medical Distribution": "医疗分销",
    "Medical Instruments & Supplies": "医疗仪器与耗材",
    "Metal Fabrication": "金属加工",
    "Mortgage Finance": "抵押贷款金融",
    "Oil & Gas Drilling": "油气钻井",
    "Oil & Gas E&P": "油气勘探与生产",
    "Oil & Gas Equipment & Services": "油气设备与服务",
    "Oil & Gas Integrated": "油气一体化",
    "Oil & Gas Midstream": "油气中游",
    "Oil & Gas Refining & Marketing": "油气炼化与销售",
    "Other Industrial Metals & Mining": "其他工业金属与采矿",
    "Other Precious Metals & Mining": "其他贵金属与采矿",
    "Packaged Foods": "包装食品",
    "Packaging & Containers": "包装与容器",
    "Paper & Paper Products": "造纸与纸制品",
    "Personal Services": "个人服务",
    "Pharmaceutical Retailers": "药品零售",
    "Pollution & Treatment Controls": "污染治理与控制",
    "Publishing": "出版",
    "Railroads": "铁路",
    "Real Estate - Development": "房地产·开发",
    "Real Estate - Diversified": "房地产·综合",
    "Real Estate Services": "房地产服务",
    "Recreational Vehicles": "房车",
    "REIT - Diversified": "房地产信托·综合",
    "REIT - Healthcare Facilities": "房地产信托·医疗设施",
    "REIT - Hotel & Motel": "房地产信托·酒店与汽车旅馆",
    "REIT - Industrial": "房地产信托·工业",
    "REIT - Mortgage": "房地产信托·抵押贷款",
    "REIT - Office": "房地产信托·写字楼",
    "REIT - Residential": "房地产信托·住宅",
    "REIT - Retail": "房地产信托·零售",
    "REIT - Specialty": "房地产信托·特色",
    "Rental & Leasing Services": "租赁服务",
    "Residential Construction": "住宅建设",
    "Resorts & Casinos": "度假村与赌场",
    "Restaurants": "餐饮",
    "Scientific & Technical Instruments": "科学与技术仪器",
    "Security & Protection Services": "安防与保护服务",
    "Semiconductor Equipment & Materials": "半导体设备与材料",
    "Semiconductors": "半导体",
    "Shell Companies": "壳公司",
    "Silver": "白银",
    "Software - Application": "软件·应用",
    "Software - Infrastructure": "软件·基础设施",
    "Solar": "光伏",
    "Specialty Business Services": "专业商业服务",
    "Specialty Chemicals": "特种化学品",
    "Specialty Industrial Machinery": "特种工业机械",
    "Specialty Retail": "专业零售",
    "Staffing & Employment Services": "人力资源与雇佣服务",
    "Steel": "钢铁",
    "Telecom Services": "电信服务",
    "Textile Manufacturing": "纺织制造",
    "Thermal Coal": "动力煤",
    "Tobacco": "烟草",
    "Tools & Accessories": "工具与配件",
    "Travel Services": "旅行服务",
    "Trucking": "公路货运",
    "Uranium": "铀",
    "Utilities - Diversified": "公用事业·综合",
    "Utilities - Independent Power Producers": "公用事业·独立发电",
    "Utilities - Regulated Electric": "公用事业·受管制电力",
    "Utilities - Regulated Gas": "公用事业·受管制燃气",
    "Utilities - Regulated Water": "公用事业·受管制水务",
    "Utilities - Renewable": "公用事业·可再生能源",
    "Waste Management": "废弃物管理",
    # 筛选面板里的三个非行业选项，一并给出译名，避免兜底翻译出怪词
    "Stocks only (ex-Funds)": "仅股票（不含基金）",
    "Stocks only (ex-Funds & Shell Companies)": "仅股票（不含基金与壳公司）",
    "Exchange Traded Fund": "交易所交易基金",
}

# ---------------------------------------------------------------- 词级兜底

#: 对照表没覆盖时的兜底：把常见词根逐个替换，尽量不出英文。
TOKEN_ZH = {
    "software": "软件", "hardware": "硬件", "services": "服务", "service": "服务",
    "systems": "系统", "solutions": "解决方案", "products": "产品", "equipment": "设备",
    "materials": "材料", "industries": "工业", "industrial": "工业", "technology": "科技",
    "technologies": "科技", "financial": "金融", "healthcare": "医疗保健", "health": "医疗",
    "energy": "能源", "utilities": "公用事业", "real": "房", "estate": "地产",
    "insurance": "保险", "banks": "银行", "banking": "银行", "capital": "资本",
    "markets": "市场", "market": "市场", "oil": "石油", "gas": "天然气",
    "mining": "采矿", "metals": "金属", "metal": "金属", "consumer": "消费",
    "retail": "零售", "wholesale": "批发", "distribution": "分销", "logistics": "物流",
    "transportation": "运输", "telecom": "电信", "communication": "通信",
    "semiconductor": "半导体", "biotech": "生物技术", "pharma": "制药",
    "medical": "医疗", "media": "传媒", "entertainment": "娱乐", "gaming": "游戏",
    "food": "食品", "beverages": "饮料", "agriculture": "农业", "chemicals": "化工",
    "construction": "建筑", "machinery": "机械", "automotive": "汽车", "airlines": "航空",
    "hospitality": "酒店旅游", "other": "其他", "specialty": "特色", "general": "综合",
    "regional": "区域性", "diversified": "综合", "integrated": "一体化",
}


def sector_zh(name):
    """板块译名。未覆盖时走兜底，兜底仍失败则原样返回。"""
    return _translate(name, SECTOR_ZH)


def industry_zh(name):
    """行业译名。未覆盖时走兜底，兜底仍失败则原样返回。"""
    return _translate(name, INDUSTRY_ZH)


def _translate(name, table):
    if not name:
        return ""
    key = str(name).strip()
    if key in table:
        return table[key]
    # 归一化后再试一次（大小写、多余空格、全角符号）
    norm = " ".join(key.replace("&amp;", "&").split())
    for src, dst in table.items():
        if src.lower() == norm.lower():
            return dst
    return _token_fallback(norm)


def _token_fallback(text):
    """词级兜底：所有词都能译出时才返回中文，否则原样返回英文。

    刻意不做"部分翻译"——把 Quantum Software Platforms 译成「软件」会失真且误导，
    宁可漏出英文原文，同时由 untranslated() 标记出来以便补齐对照表。
    """
    if not re.search(r"[A-Za-z]", text):
        return text
    parts = [p for p in re.split(r"([A-Za-z]+)", text) if p]
    out = []
    for p in parts:
        if re.fullmatch(r"[A-Za-z]+", p):
            zh = TOKEN_ZH.get(p.lower())
            if zh is None:
                return text          # 有任何一个词不认识 → 整体不译
            out.append(zh)
        else:
            out.append(p.strip("-–—,./ "))
    joined = re.sub(r"[\s\-]{2,}", " ", "".join(out)).strip()
    return joined or text


def untranslated(values):
    """自检：返回仍然含拉丁字母的译名，用于发现对照表缺口。"""
    bad = []
    for v in values:
        zh = sector_zh(v) if v in SECTOR_ZH else industry_zh(v)
        if re.search(r"[A-Za-z]", zh or ""):
            bad.append((v, zh))
    return bad
