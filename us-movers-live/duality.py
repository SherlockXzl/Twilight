# -*- coding: utf-8 -*-
"""期股双面 —— 纽约金 × 黄金股 / 纽约银 × 白银股 / 纽约铜 × 铜股 / 沪胶 × 橡胶股
的历史日线。

**这一页要回答的问题**：大宗商品期货在动的时候，对应的矿股跟不跟、跟多少。
所以需要的是**同一时间轴、可以横向对比**的价格序列，而不是某一天的快照。

页面上按**分组**组织（后端 `GROUPS` ↔ 前端顶部 tabs--page），
一组一条期货 + 数只对应股票，各组**互不混画** —— 金和银虽然同涨同跌的日子不少，
但把金价和银矿股放进同一张归一化图里，纵轴上那条 0% 就成了两种基本面的混合物，
读出来的相关性没有意义：

    纽约金 × 黄金股    金价 ↔ 金矿采选 / 综合冶炼 / 珠宝零售
    纽约银 × 白银股    银价 ↔ 白银矿端 / 冶炼回收（2026-10-12 按用户要求新增）
    纽约铜 × 铜股      铜价 ↔ 铜采选冶（2026-10-12 同日按用户要求新增）
    沪胶 × 橡胶股      沪胶 ↔ 天然橡胶种植与贸易（2026-10-12 同日按用户要求新增）

⚠️ **沪胶这一组和上面三组有两个结构性的不同**，改动这块之前先读这两条：

  ① 它是**国内盘**（上期所 RU），不是 COMEX。所以计价单位是**元/吨**，
     时区与 A 股同为北京时间（另外三组是美东，会与 A 股错开一天），
     而且源链也不同 —— 新浪那个接口分内外盘两个域名，不能混用（见 `_src_sina_inner`）。
  ② 它**只有一只股票**（海南橡胶 601118）。这是本页第一次出现"一组一只股票"，
     不是配置写漏了：天然橡胶在 A 股是**独苗**，海南橡胶几乎是唯一的种植端标的
     （其余相关公司的主业是轮胎等下游消费，跟胶价是反向的成本关系，不属这一组）。
     表现上因此是"一对一对画"：图上两条线，一条虚线（胶价）一条实线（股价），
     勾选卡两张 —— 所有渲染都是按 `groupItems()` 长度算的，没有写死 5~6 张。

--------------------------------------------------------------- 数据源：四个，互为备份

标的横跨 COMEX 期货、上期所期货与沪深 A 股，没有任何一个源能让人放心地单点依赖，
所以这里按标的各自排了一条源链，**依次尝试、谁通用谁**：

    纽约金    东方财富(101.GC00Y) → 新浪外盘期货(GC)
    纽约银    东方财富(101.SI00Y) → 新浪外盘期货(SI)
    纽约铜    东方财富(101.HG00Y) → 新浪外盘期货(HG)
    沪胶      东方财富(113.RUM)   → 新浪内盘期货(RU0)
    A 股十四只 东方财富(1.60xxxx / 0.00xxxx) → 腾讯(前复权日线)

⚠️ **外盘与内盘是两个接口、两套 symbol**：外盘 `symbol=GC/SI/HG` 走
`stock2...GlobalFuturesService`，内盘 `symbol=RU0` 走 `stock...InnerFuturesNewService`，
返回的字段名也不一样（外盘 `date/close`，内盘 `d/c`）。**串用只会拿到空数组**，
而空数组在这里的表现是"这个源失败、换下一个"，两个都串错才会报错 ——
所以别靠猜，看 `_SINA_FUT_LABELS` / `_SINA_INNER_LABELS`。

黄金组这五只 A 股不是随便凑的，覆盖了金价往上传导的**三个环节**，横向对比才有意义：
金矿采选（山东黄金 / 赤峰黄金 / 四川黄金）→ 冶炼与综合（紫金矿业，铜金兼营）
→ 珠宝零售（中国黄金，**下游**：金价涨对它是成本压力而非利好）。
2026-10-08 按用户要求加入中国黄金（600916）与四川黄金（001337）—— 新增的这两只
正好把"上游矿端"和"下游零售"补齐，图上出现分化时能直接看出是哪一端在动。
白银组这四只（湖南白银 / 白银有色 / 豫光金铅 / 盛达资源）则几乎全在**上游与冶炼**：
A 股没有一只纯白银矿业标的，这四只的银产量都来自铅锌伴生回收，所以银价传导
比黄金组更"绕"一层 —— 图上真正要看的不是"跟不跟"，而是**跟得有多钝**。
铜组这四只（江西铜业 / 铜陵有色 / 云南铜业 / 北方铜业）是同一个道理的**更极端版本**：
它们的收入大头在**冶炼与加工**，而这一段赚的是**加工费（TC/RC）** ——
铜价上涨对它是原料成本、不是收入，所以铜价与股价的相关性天然被稀释。
图上如果看到"铜价涨、铜股不动"，那不是数据错了，是产业链位置本来就是这么定的。
橡胶组只有海南橡胶一只，但它反而是四组里**传导最直接**的：它是国内唯一以天然橡胶
种植与初加工为主业的上市公司，胶价就是它的售价（不是成本）。代价是**波动来源很杂**——
海南橡胶还背着橡胶木、贸易与土地资产，且 RU 主力合约的持仓更多反映的是轮胎厂与
贸易商的定价博弈，所以"胶价涨、股价未必同步"同样会出现，读图时别急着下结论。

为什么要这么排（都是实测，不是设计洁癖）：
  · **东方财富放前面**：一个请求同时覆盖期货和股票，字段最全（连当日涨跌幅都给），
    正常时一轮取数 2 秒、十八只标的并发完成（黄金 6 + 白银 5 + 铜 5 + 橡胶 2）。
  · 但它是**会限流的**。2026-10-08 调试期间短时间打了三十多次之后，
    整个域名对这台机器连续十几次直接掐连接（`Remote end closed connection`，
    连 HTTP 状态码都没有），而同一时刻新浪、腾讯都正常。
    真实使用不会这么打，但"周五晚上想看两眼"时撞上限流，页面就是一片空白 ——
    所以必须有备源。（2026-10-12 晚上又撞上一次：`push2his` 整域不可用、
    连黄金期货都取不到，四个分组一起落到备源 —— 这正是备源存在的意义。）
  · 腾讯的日线要**前复权**（`qfq`）：金矿股分红除权不罕见，用不复权价画出来的
    "过去 90 天跌了 8%"可能有一半是除权造成的。这一点不能省。
  · 新浪那**两个**期货接口都是一次性返回全量（外盘自 2016 年、内盘更早），
    这里只截尾部 `KLINE_LIMIT` 根。内盘那份略小，但都是几百 KB 级别。

源链上还有一个**失败记忆**（`_SRC_FAIL`）：某个源连续失败后会被排到后面，
免得每次开机都先花几秒去撞一堵已知的墙。见 `_ordered_sources`。

--------------------------------------------------------------- 另外一份数据：总市值

「区间数据」表要按总市值从大到小排（2026-10-08 用户要求），所以除了日线还得取一个
**时点量**。它走的是与上面完全独立的一条链（东财 `push2` / 腾讯 `qt.gtimg.cn`，
日线走的是 `push2his` / `web.ifzq`），但**共用那张失败记忆** —— 实测东财被限流时
是整个域名一起掐，分成两份记忆只会让市值这一步白等 8 秒。见 `fetch_caps`。

市值**只有股票有**：期货（纽约金 / 银 / 铜 / 沪胶）没有市值这回事，payload 里干脆不给它这个字段
（前端缺字段就显示"—"，不会渲染成一个假的 0）。取数失败时会用上一次成功取到的值
顶着（`_CAP_MEMO`），因为市值是慢变量 —— 但记忆有保鲜期，不做无期限兜底。

口径与已知边界（都会原样透传给前端，由页面决定怎么措辞）：
    · 全部为**日线**；COMEX 那三组的"交易日"按美东划分，A 股与**沪胶**按北京时间 ——
      前三组与 A 股偶有错位（画的时候不强行对齐），沪胶这一组则是**同一时区**，
      不存在这个错位问题。
    · **最后一根可能是盘中价**。A 股 15:00 收盘后是收盘价；COMEX 期货是近 24 小时
      电子盘，任何时刻去看，最后一根都是"当前"。
    · 中国商品期货的夜盘（21:00–23:00，沪胶到 23:00）算**下一交易日**，所以盘中
      那根日线的"日期"会是明天 —— 这一点与 A 股的直觉不同，但它不是数据错。
    · ⚠️ 四条期货线走的都是**主力连续**（`GC00Y` / `SI00Y` / `HG00Y` / `RUM`），
      换月时价格会**跳一下**（新旧主力不是同一个合约）。这是主连的固有特性，
      本页**不做换月调整**：抹平它反而会伪造出一段不存在的平滑走势。
      影响程度不一样 —— 外盘三个品种近月/次近月价差小，内盘橡胶的跨期价差
      （1/5/9 月之间）明显更大，所以**沪胶这条线在换月日的单日涨跌幅会比另外三条更夸张**，
      看到"某天忽然 ±5%"时先去核那天是不是换月。
    · 中美假期不同 → 某一天可能只有一边有数据。前端**不补点**：折线直接跨过缺口
      相连（斜率会缓一点，但不会伪造出一个不存在的价）。沪胶与 A 股同为国内假日，
      所以这一组不会出现这种缺口。

与前几页一样：**服务端只负责取数与归一化，不做任何"涨跌幅排名"之类的判断** ——
区间涨跌幅依赖用户选的时间范围，那是展示层（static/duality.js）的活。
"""

import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

#: 项目根目录（本文件所在处），与 settings.py 同一种取法
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

#: 落盘缓存。**为什么日线也要落盘**（内存缓存已经能顶 30 分钟）：
#:   ① 服务重启后页面立刻有东西看，不必等一轮取数；
#:   ② 所有源同时不可用（限流叠加网络抖动）时，至少还能按"这是几点几分的数据"
#:      降级显示，而不是给用户一片空白。降级会在 `stale` 上标出来，页面明确告知。
DUALITY_CACHE_PATH = os.path.join(BASE_DIR, "data", "duality_cache.json")

#: 通用请求头两套，按顺序轮换。**不是凑数**：东方财富对「浏览器 UA + 非浏览器 TLS
#: 指纹」的组合会直接把连接掐掉，而交回 urllib 的默认 UA 反而稳定；
#: 新浪/腾讯则带着 Referer 更不容易被当成爬虫。两套轮着试，哪种通就用哪种。
HEADER_VARIANTS = (
    {"User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"),
     "Accept": "application/json, text/plain, */*"},
    {},                                  # 空 dict = 用 urllib 默认头
)

#: 超时。四个源实测都在 1.5 秒内返回，8 秒足够；再久就是真的不通了。
TIMEOUT = 8

#: 单个源的重试次数（含首次）。东方财富的失败是**间歇性**的：同一秒里连着打十次，
#: 会有三五次被掐断、另几次完全正常 —— 退避重试不是"以防万一"，是能不能用的前提。
RETRIES = 3

#: 退避基数（秒）。第 n 次重试前等 n × 这个值。
RETRY_BACKOFF = 0.5

#: 一次取多少根日线。前端最长可选「自定义开始日期」，取 3 年（约 730 个交易日）
#: 足够覆盖任何合理的对比区间；再多就只是白白搬运。
KLINE_LIMIT = 800

#: 缓存存活时间（秒）。日线一天只变一次，但**最后一根在盘中一直在动**，
#: 所以不能缓存一整天。半小时是折中：页面上的数字不会在读者眼皮底下跳，
#: 点页头「立即刷新」随时能拿到最新的一根。
CACHE_TTL = 1800


class DualityError(RuntimeError):
    """取数失败。错误信息会**原样显示给用户看**，所以要能读，不能是堆栈。"""


#: 分组。**顺序即页面上 tab 的顺序**，`label` 是那个 tab 的文字（前端不另写一份）。
#:
#: 为什么要有这一层：同一页上放四组期货 × 股票，最省事的做法是"全都画在一张图里"，
#: 但那样纵轴（相对基准的涨跌幅）会把金和银两种基本面混成一条线，读出来的
#: 相关性没有意义。分组之后每组各自归一化，图上的 0% 是**同一个品种**的基准。
#:
#: ⚠️ 每个标的的 `group` 必须精确指向这里的一个 key —— 写错**不会报错**，
#: 前端按当前分组过滤时那只会整个不显示（症状是"某只票不见了"）。
#: tools/test_duality_source.py 里有用例钉着这两边对得上。
GROUPS = [
    {"key": "gold", "label": "纽约金 × 黄金股"},
    {"key": "silver", "label": "纽约银 × 白银股"},
    {"key": "copper", "label": "纽约铜 × 铜股"},
    {"key": "rubber", "label": "沪胶 × 橡胶股"},
]

#: 标的清单。**顺序即页面上的默认顺序**，新增标的改这里一处即可
#: （前端不写死名单，全部按这个列表渲染）。
#:
#: `sources` 是源链，元素为 (源名, 该源的参数)，**按顺序尝试**。
#: `kind` 只有 future / stock 两种，前端据此决定报价小数位与页面上怎么称呼。
#: `group` 见 GROUPS；`note` 里「·」前那段是代码，前端悬停提示按它取标识（别改格式）。
INSTRUMENTS = [
    {
        "key": "gold",
        "display": "纽约金",
        "kind": "future",
        "unit": "美元/盎司",
        "market": "COMEX",
        "note": "COMEX 黄金期货主连",
        "group": "gold",
        "sources": [("em", "101.GC00Y"), ("sina_fut", "GC")],
    },
    {
        "key": "zijin",
        "display": "紫金矿业",
        "kind": "stock",
        "unit": "元",
        "market": "上交所",
        "note": "601899 · 铜金矿龙头",
        "group": "gold",
        "sources": [("em", "1.601899"), ("tencent", "sh601899")],
    },
    {
        "key": "sdgold",
        "display": "山东黄金",
        "kind": "stock",
        "unit": "元",
        "market": "上交所",
        "note": "600547 · A 股纯金标的",
        "group": "gold",
        "sources": [("em", "1.600547"), ("tencent", "sh600547")],
    },
    {
        "key": "cfgold",
        "display": "赤峰黄金",
        "kind": "stock",
        "unit": "元",
        "market": "上交所",
        "note": "600988 · 金矿弹性标的",
        "group": "gold",
        "sources": [("em", "1.600988"), ("tencent", "sh600988")],
    },
    {
        "key": "zggold",
        "display": "中国黄金",
        "kind": "stock",
        "unit": "元",
        "market": "上交所",
        "note": "600916 · 黄金珠宝零售（下游）",
        "group": "gold",
        "sources": [("em", "1.600916"), ("tencent", "sh600916")],
    },
    {
        "key": "scgold",
        "display": "四川黄金",
        "kind": "stock",
        "unit": "元",
        "market": "深交所",
        "note": "001337 · 金矿采选（上游）",
        "group": "gold",
        "sources": [("em", "0.001337"), ("tencent", "sz001337")],
    },

    # ---- 白银组（2026-10-12 按用户要求新增：纽约银 + 四只白银股）----
    # 顺序沿用用户给的顺序（湖南白银 → 白银有色 → 豫光金铅 → 盛达资源）。
    # 与黄金组不同，这四只**没有一只是纯银矿**：白银在 A 股基本都是铅锌冶炼的
    # 伴生回收产物，所以"银价涨多少 → 业绩弹性多少"这条链更长，图上表现为滞后与钝化。
    {
        "key": "silver",
        "display": "纽约银",
        "kind": "future",
        "unit": "美元/盎司",
        "market": "COMEX",
        "note": "COMEX 白银期货主连",
        "group": "silver",
        "sources": [("em", "101.SI00Y"), ("sina_fut", "SI")],
    },
    {
        "key": "hnby",
        "display": "湖南白银",
        "kind": "stock",
        "unit": "元",
        "market": "深交所",
        "note": "002716 · 白银冶炼与综合回收",
        "group": "silver",
        "sources": [("em", "0.002716"), ("tencent", "sz002716")],
    },
    {
        "key": "byys",
        "display": "白银有色",
        "kind": "stock",
        "unit": "元",
        "market": "上交所",
        "note": "601212 · 铜铅锌银综合冶炼",
        "group": "silver",
        "sources": [("em", "1.601212"), ("tencent", "sh601212")],
    },
    {
        "key": "ygjq",
        "display": "豫光金铅",
        "kind": "stock",
        "unit": "元",
        "market": "上交所",
        "note": "600531 · 铅冶炼副产白银",
        "group": "silver",
        "sources": [("em", "1.600531"), ("tencent", "sh600531")],
    },
    {
        "key": "sdzy",
        "display": "盛达资源",
        "kind": "stock",
        "unit": "元",
        "market": "深交所",
        "note": "000603 · 银铅锌矿采选（矿端）",
        "group": "silver",
        "sources": [("em", "0.000603"), ("tencent", "sz000603")],
    },

    # ---- 铜组（2026-10-12 按用户要求新增：纽约铜 + 四只铜股）----
    # 顺序沿用用户给的顺序（江西铜业 → 铜陵有色 → 云南铜业 → 北方铜业）。
    # ⚠️ **计价单位与贵金属不同**：COMEX 铜（HG）报的是**美元/磅**，不是美元/盎司 ——
    # 网上常见的"铜价 9000 多"是伦敦铜的美元/吨，和这一条不是一回事（10600 美元/吨
    # ≈ 4.8 美元/磅）。单位写错的话页面上的价格会显得"离谱"，而没人会去核。
    # 这四只的收入大头都在**冶炼与加工**，而这一段赚的是加工费（TC/RC）：
    # 铜价涨对它是原料成本、不是收入，所以图上多半是"铜价涨、铜股钝"。
    # 江西铜业与北方铜业自有矿山占比相对高一些，弹性通常比纯冶炼端靠前。
    {
        "key": "copper",
        "display": "纽约铜",
        "kind": "future",
        "unit": "美元/磅",
        "market": "COMEX",
        "note": "COMEX 铜期货主连",
        "group": "copper",
        "sources": [("em", "101.HG00Y"), ("sina_fut", "HG")],
    },
    {
        "key": "jxty",
        "display": "江西铜业",
        "kind": "stock",
        "unit": "元",
        "market": "上交所",
        "note": "600362 · 铜采选冶一体（自有矿最多）",
        "group": "copper",
        "sources": [("em", "1.600362"), ("tencent", "sh600362")],
    },
    {
        "key": "tlys",
        "display": "铜陵有色",
        "kind": "stock",
        "unit": "元",
        "market": "深交所",
        "note": "000630 · 铜冶炼为主（含海外矿权）",
        "group": "copper",
        "sources": [("em", "0.000630"), ("tencent", "sz000630")],
    },
    {
        "key": "ynty",
        "display": "云南铜业",
        "kind": "stock",
        "unit": "元",
        "market": "深交所",
        "note": "000878 · 铜采选冶一体（中铝系）",
        "group": "copper",
        "sources": [("em", "0.000878"), ("tencent", "sz000878")],
    },
    {
        "key": "bfty",
        "display": "北方铜业",
        "kind": "stock",
        "unit": "元",
        "market": "深交所",
        "note": "000737 · 华北铜采选冶（中条山）",
        "group": "copper",
        "sources": [("em", "0.000737"), ("tencent", "sz000737")],
    },

    # ---- 橡胶组（2026-10-12 按用户要求新增：沪胶 + 海南橡胶）----
    # 本页**第一次出现"一组只有一只股票"**，不是配置漏了：天然橡胶在 A 股是独苗，
    # 海南橡胶几乎是唯一的种植端标的（其余相关公司主业是轮胎等下游消费，
    # 与胶价是**反向**的成本关系，不属于这一组）。
    # ⚠️ 两条与上面三组都不同的地方：
    #   ① 沪胶是**国内盘**（上期所），单位是**元/吨** —— 抄金银铜那三行的
    #      "美元/盎司""美元/磅"会得到一句显然错误的话，而且不会报错。
    #   ② 备源是新浪的**内盘**接口（`stock...InnerFuturesNewService`），
    #      不是外盘那个（`stock2...GlobalFuturesService`）。两个接口的 symbol
    #      与字段名都不一样，详见 `_src_sina_inner` 的 docstring。
    # 东财代码 `113.RUM` 是「橡胶主连」（113 = 上期所）；实测 `113.RU0` / `113.RU00`
    # 都不是有效代码 —— 东财只认这个 `RUM` 写法，别按"RU+0"的习惯去写。
    {
        "key": "ru",
        "display": "沪胶",
        "kind": "future",
        "unit": "元/吨",
        "market": "上期所",
        "note": "RU · 天然橡胶期货主连",
        "group": "rubber",
        "sources": [("em", "113.RUM"), ("sina_inner", "RU0")],
    },
    {
        "key": "hnxj",
        "display": "海南橡胶",
        "kind": "stock",
        "unit": "元",
        "market": "上交所",
        "note": "601118 · 天然橡胶种植与贸易（上游）",
        "group": "rubber",
        "sources": [("em", "1.601118"), ("tencent", "sh601118")],
    },
]

_CACHE = {"at": 0.0, "payload": None}
_LOCK = threading.Lock()

#: 源名 → `(连续失败次数, 最后一次失败的时刻)`。用于把已知不通的源排到后面
#: （见 `_ordered_sources`）。单个标的的成功会清掉那个源的计数 ——
#: 成功率是按源算的，不按标的。
_SRC_FAIL = {}
_SRC_LOCK = threading.Lock()

#: 失败记忆的保鲜期（秒）。**没有它就会死锁**：主源一旦连失败几次被排到最后，
#: 备源每次都成功，主源就再也没有机会被尝试 —— 也就永远等不到那次"成功清零"，
#: 于是"这次限流"变成了"这辈子都不再用它"。
#: 20 分钟与内存缓存同量级：下一次开页面（通常几小时后）记忆已过期，会重新试主源。
SRC_MEMORY_TTL = 1200


# ------------------------------------------------------------------ 底层 HTTP

def _http_text(url, label, enc="utf-8"):
    """带重试与换头策略的 GET，返回响应文本。

    所有源共用这一条通道，因为"这个环境里怎么把请求发出去"是三家的共性问题，
    各写一份必然出现"某个源忘了带 Referer"这类只有线上才暴露的差异。

    `enc` 目前只有市值那条链要用 —— **腾讯的 `qt.gtimg.cn` 是 GBK**（不是 utf-8，
    用 utf-8 硬解出来是乱码，而且乱码只影响名称，解析市值那几个纯数字字段照样能过，
    所以这种错会在页面上装成一个"名字怎么怪怪的"的小毛病，很难联想到编码）。
    """
    last = None
    for attempt in range(RETRIES):
        if attempt:
            time.sleep(RETRY_BACKOFF * attempt)      # 退避，别把限流打成封禁
        try:
            req = urllib.request.Request(url, headers=HEADER_VARIANTS[attempt % len(HEADER_VARIANTS)])
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return r.read().decode(enc, "replace")
        except (urllib.error.URLError, OSError) as e:
            last = "%s" % e
    raise DualityError("%s：%s" % (label, last or "请求失败"))


def _pct_series(dates, closes):
    """从收盘价算逐日涨跌幅（%）。

    东财直接给涨跌幅，其余源不给 —— 这里统一兜底算一遍。
    序列本身是**前复权**的，所以相邻两根相除就是真实涨跌幅，除权跳空不会混进来。
    第一根没有前收，记 0（它的"单日涨跌"在页面上本来也不显示）。
    """
    out = [0.0]
    for i in range(1, len(closes)):
        prev = closes[i - 1]
        out.append((closes[i] / prev - 1) * 100 if prev else 0.0)
    return out


def _tail(dates, closes, chgs):
    """统一截到最近 KLINE_LIMIT 根。各源的原始长度不同（100 / 800 / 801 / 2589，
    分别对应腾讯 / 新浪内盘 / 新浪外盘 / 东财），
    在这里归一 —— 下游（尤其是 payload 体积）就不用再操心了。"""
    n = len(dates)
    if n <= KLINE_LIMIT:
        return dates, closes, chgs
    k = n - KLINE_LIMIT
    return dates[k:], closes[k:], chgs[k:]


# ------------------------------------------------------------------ 源实现

def _src_em(secid):
    """东方财富历史 K 线。返回 `(code, sourceName, dates, closes, chgs)`。"""
    qs = urllib.parse.urlencode({
        "secid": secid,
        "fields1": "f1,f2,f3,f4,f5,f6",     # 元信息（代码 / 名称 / 小数位）
        "fields2": "f51,f53,f59",           # 只要 日期 / 收盘 / 涨跌幅
        "klt": "101",                       # 日线
        "fqt": "1",                         # 前复权
        "end": "20500101",
        "lmt": str(KLINE_LIMIT),
    }, quote_via=urllib.parse.quote, safe=",")   # 逗号**不能**编码成 %2C（实测会被拒）
    txt = _http_text("https://push2his.eastmoney.com/api/qt/stock/kline/get?" + qs,
                     "东方财富 " + secid)
    try:
        data = (json.loads(txt) or {}).get("data") or {}
    except ValueError:
        raise DualityError("东方财富 %s：返回内容不是 JSON" % secid)
    klines = data.get("klines") or []
    if not klines:
        raise DualityError("东方财富 %s：接口没返回K线数据" % secid)

    dates, closes, chgs = [], [], []
    for line in klines:
        p = line.split(",")
        if len(p) < 3:
            continue
        try:
            dates.append(p[0])
            closes.append(float(p[1]))
            chgs.append(float(p[2]))
        except ValueError:
            continue                        # 个别行坏掉就跳过，不让一行毁掉整条序列
    if not dates:
        raise DualityError("东方财富 %s：K线解析后为空" % secid)
    d, c, p = _tail(dates, closes, chgs)
    return data.get("code") or "", data.get("name") or "", d, c, p


def _src_tencent(symbol):
    """腾讯前复权日线（A 股）。`symbol` 形如 `sh601899`。

    响应里带复权时键名是 `qfqday`、不带时是 `day` —— **两个都要认**，
    不然后端哪天不返回复权序列，这里会静默变成空。
    数组格式：`[日期, 开, 收, 高, 低, 量]`（注意收盘在**第 3 位**，不是第 2 位）。
    """
    url = ("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=" +
           urllib.parse.quote(symbol + ",day,,," + str(KLINE_LIMIT) + ",qfq", safe=","))
    txt = _http_text(url, "腾讯 " + symbol)
    try:
        node = ((json.loads(txt) or {}).get("data") or {}).get(symbol) or {}
    except ValueError:
        raise DualityError("腾讯 %s：返回内容不是 JSON" % symbol)
    arr = node.get("qfqday") or node.get("day") or []
    if not arr:
        raise DualityError("腾讯 %s：接口没返回K线数据" % symbol)

    dates, closes = [], []
    for row in arr:
        if len(row) < 3:
            continue
        try:
            dates.append(str(row[0]))
            closes.append(float(row[2]))
        except ValueError:
            continue
    if not dates:
        raise DualityError("腾讯 %s：K线解析后为空" % symbol)
    # ⚠️ 顺序不能反：涨跌幅要**在截断之前**算完 —— 截断后第一根没有前收，
    #    再算只会得到一个假的 0%。
    d, c, p = _tail(dates, closes, _pct_series(dates, closes))
    return node.get("code") or symbol, symbol.upper(), d, c, p


#: 新浪外盘的那个接口**按代码取品种**，黄金 `GC`、白银 `SI`、铜 `HG`，字段结构完全相同 ——
#: 所以一个函数供三个品种用，只是把返回的源名说准（它会被原样写进 payload 的
#: `sourceName`）。**不要在这里写死"黄金"**：白银那只会顶着黄金的名字走一路，
#: 而且不报错。查不到映射时退回 `"COMEX " + 代码`（能看出是哪个品种，不会张冠李戴）。
_SINA_FUT_LABELS = {"GC": "COMEX 黄金", "SI": "COMEX 白银", "HG": "COMEX 铜"}


def _src_sina_fut(symbol):
    """新浪外盘期货日线（COMEX 黄金 `GC` / 白银 `SI` / 铜 `HG`）。

    这个接口返回的是 **JSONP**（`/*<script>...</script>*/ var t=([...]);`），
    所以要先从文本里切出最外层的方括号再解析 —— 不要用正则去抠每个字段，
    字段顺序会变。它一次给 2016 年至今的全部（约 390KB），这里截尾部。
    """
    url = ("https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/"
           "GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=" +
           urllib.parse.quote(symbol))
    txt = _http_text(url, "新浪外盘 " + symbol)
    a, b = txt.find("["), txt.rfind("]")
    if a < 0 or b <= a:
        raise DualityError("新浪外盘 %s：响应里找不到数据数组" % symbol)
    try:
        arr = json.loads(txt[a:b + 1])
    except ValueError:
        raise DualityError("新浪外盘 %s：数据数组解析失败" % symbol)
    if not arr:
        raise DualityError("新浪外盘 %s：数据为空" % symbol)

    dates, closes = [], []
    for row in arr:
        if not isinstance(row, dict):
            continue
        try:
            d = str(row.get("date") or "")
            c = float(row.get("close"))
        except (TypeError, ValueError):
            continue
        if d and c:
            dates.append(d)
            closes.append(c)
    if not dates:
        raise DualityError("新浪外盘 %s：解析后为空" % symbol)
    # 同腾讯：先算涨跌幅再截断
    d, c, p = _tail(dates, closes, _pct_series(dates, closes))
    return symbol, _SINA_FUT_LABELS.get(symbol, "COMEX " + symbol), d, c, p


#: 新浪**内盘**期货的品种名。与外盘那份 `_SINA_FUT_LABELS` **分开维护** ——
#: 两个接口认的是两套 symbol，合在一起迟早会在某个品种上互相串名。
_SINA_INNER_LABELS = {"RU0": "上期所 沪胶"}


def _src_sina_inner(symbol):
    """新浪**内盘**期货日线（上期所天然橡胶主连 `RU0`）。

    与 `_src_sina_fut` 是**两个不同的接口**，别互抄（抄错的症状很隐蔽）：
      · 域名/路径不同 —— 内盘 `stock.finance.sina.com.cn/...InnerFuturesNewService`，
        外盘 `stock2.finance.sina.com.cn/...GlobalFuturesService`；
      · symbol 不同 —— 内盘是「品种码 + 0」＝主力连续（`RU0`），外盘是纯品种码（`GC`）；
      · **字段名不同** —— 内盘是单字母 `d/o/h/l/c/v/p/s`（`c` = 收盘、`d` = 日期，
        `s` = 结算价），外盘是 `date` / `close`。

    拿外盘那套去解析内盘响应，不会抛异常，只会安静地得到空数组 —— 然后被源链
    当成"这个源失败、换下一个"，于是变成一次看不见的降级。这也是为什么
    两者各留一个函数、各带一份品种名映射。
    """
    url = ("https://stock.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/"
           "InnerFuturesNewService.getDailyKLine?symbol=" +
           urllib.parse.quote(symbol))
    txt = _http_text(url, "新浪内盘 " + symbol)
    a, b = txt.find("["), txt.rfind("]")
    if a < 0 or b <= a:
        raise DualityError("新浪内盘 %s：响应里找不到数据数组" % symbol)
    try:
        arr = json.loads(txt[a:b + 1])
    except ValueError:
        raise DualityError("新浪内盘 %s：数据数组解析失败" % symbol)
    if not arr:
        raise DualityError("新浪内盘 %s：数据为空" % symbol)

    dates, closes = [], []
    for row in arr:
        if not isinstance(row, dict):
            continue
        try:
            d = str(row.get("d") or "")
            c = float(row.get("c"))
        except (TypeError, ValueError):
            continue
        if d and c:
            dates.append(d)
            closes.append(c)
    if not dates:
        raise DualityError("新浪内盘 %s：解析后为空" % symbol)
    # 同其余源：先算涨跌幅再截断
    d, c, p = _tail(dates, closes, _pct_series(dates, closes))
    return symbol, _SINA_INNER_LABELS.get(symbol, "内盘 " + symbol), d, c, p


SRC_FUNCS = {"em": _src_em, "tencent": _src_tencent,
             "sina_fut": _src_sina_fut, "sina_inner": _src_sina_inner}


# ------------------------------------------------------------------ 总市值
#
# 「区间数据」表要按市值从大到小排（用户 2026-10-08 的要求），所以除了日线还得
# 拿一个**时点量**：总市值。它跟日线不是一回事 —— 日线是历史序列、一次取 800 根，
# 市值只有"现在"这一个值，而且**只有股票有**（期货没有市值这回事）。
#
# 两个源，都支持**一次请求拿全部**（十四只票逐个取要十四个请求，既慢又更容易被限流）：
#
#   东方财富  push2 的 ulist 接口，secid 与日线完全同一套（1.601899 / 0.001337）
#   腾讯      qt.gtimg.cn 的批量行情，返回 GBK、字段用 `~` 分隔
#
# 为什么不用日线那个源链直接复用：日线走 `push2his`、市值走 `push2`，是同家的
# 两个域名。实测两者基本同进退（整个域名被掐），所以**共用 `_SRC_FAIL` 那张失败记忆**
# 是合适的 —— 东财刚被限流时，市值这一步就不必再花 8 秒去撞一次。

#: 市值源链，依次尝试。**只有两个源**：市值只是一列辅助信息，不值得为它排第四条链。
CAP_SOURCES = ("em", "tencent")

#: 市值记忆的保鲜期（秒）。市值是慢变量：股价翻倍才可能让排序变，而那一天里
#: `CACHE_TTL` 早就过期重取好几轮了。所以取不到时拿上次的值顶着是安全的 ——
#: 但**不能永远顶着**：真放了两个月不管，它会变成一个没人察觉的假数字。
CAP_MEMO_TTL = 7 * 86400


def _cap_secid(spec):
    """这只标的在东财的 secid（`1.601899`）。取不到返回空串（期货就没有）。"""
    for name, arg in spec["sources"]:
        if name == "em":
            return arg
    return ""


def _cap_symbol(spec):
    """这只标的在腾讯的代码（`sh601899`）。取不到返回空串。"""
    for name, arg in spec["sources"]:
        if name == "tencent":
            return arg
    return ""


def _cap_em(specs):
    """东方财富批量行情 → `{key: 总市值(元)}`。`f20` 就是总市值，单位元。

    响应里认的是 `f13.f12`（市场.代码），正好和我们传的 secid 同构 ——
    不要按数组下标去对（`diff` 的顺序不保证与 `secids` 一致，而且期货会返回 `f20=0`）。
    """
    want = {}
    for s in specs:
        sid = _cap_secid(s)
        if sid:
            want[sid] = s["key"]
    if not want:
        return {}

    qs = urllib.parse.urlencode({
        "fltt": "2",
        "secids": ",".join(want),
        "fields": "f12,f13,f14,f20",
    }, quote_via=urllib.parse.quote, safe=",")     # 同 _src_em：逗号不能编码
    txt = _http_text("https://push2.eastmoney.com/api/qt/ulist.np/get?" + qs,
                     "东方财富 市值")
    try:
        diff = ((json.loads(txt) or {}).get("data") or {}).get("diff") or []
    except ValueError:
        raise DualityError("东方财富 市值：返回内容不是 JSON")

    out = {}
    for d in diff:
        if not isinstance(d, dict):
            continue
        key = want.get("%s.%s" % (d.get("f13"), d.get("f12")))
        v = d.get("f20")
        # 期货（f20 返回 0）与停牌无市值的都落在这里，直接不收 ——
        # 收了 0 会让前端把它当成"市值 0 亿"，排序时排到最后但显示"0 亿"。
        if key and isinstance(v, (int, float)) and v > 0:
            out[key] = float(v)
    return out


def _cap_tencent(specs):
    """腾讯批量行情 → `{key: 总市值(元)}`。

    返回形如 `v_sh601899="1~紫金矿业~601899~29.37~...~";`，用 `~` 分隔，
    **索引 45 是总市值、单位亿元**（44 是流通市值）。索引位置是实测钉下来的，
    所以解析前先判长度：上游哪天加了字段，末尾追加不影响，但**中间插一个就会全错**，
    这时 `len(p) <= 45` 也拦不住 —— 所以与东财对得上这件事由用例钉（见
    tools/test_duality_source.py 的市值一节）。
    """
    want = {}
    for s in specs:
        sym = _cap_symbol(s)
        if sym:
            want[sym] = s["key"]
    if not want:
        return {}

    txt = _http_text("https://qt.gtimg.cn/q=" + ",".join(want), "腾讯 市值", enc="gbk")
    out = {}
    for chunk in txt.split(";"):
        chunk = chunk.strip()
        eq = chunk.find("=")
        if eq < 0:
            continue
        var = chunk[:eq].strip()                   # v_sh601899
        if not var.startswith("v_"):
            continue
        key = want.get(var[2:])
        if not key:
            continue
        p = chunk[eq + 1:].strip().strip('"').split("~")
        if len(p) <= 45:
            continue
        try:
            yi = float(p[45])                      # 总市值（亿元）
        except ValueError:
            continue
        if yi > 0:
            out[key] = yi * 1e8
    return out


CAP_FUNCS = {"em": _cap_em, "tencent": _cap_tencent}

#: 上一次成功取到的市值：`key -> (元, 时刻)`。只在**本轮没取到时**顶上，
#: 所以它不会掩盖"市值接口一直在更新"这件事，只兜住那一次抖动。
_CAP_MEMO = {}
_CAP_LOCK = threading.Lock()


def _memo_caps():
    """把记忆里没过期的市值取出来。过期的**顺手删掉**（不然它会一直躺在那里，
    等哪天需要兜底时正好顶上一个上个月的数字）。"""
    now = time.time()
    out = {}
    with _CAP_LOCK:
        for k, (v, at) in list(_CAP_MEMO.items()):
            if (now - at) > CAP_MEMO_TTL:
                del _CAP_MEMO[k]
            else:
                out[k] = v
    return out


def _seed_cap_memo():
    """服务刚起来、记忆是空的 → 从盘上那份缓存把市值捡回来。

    没有这一步的话，重启后的第一次取数只要市值接口抽风，十四只票的市值会**集体变"—"**
    —— 而且页面一切正常，只是那一列空了，很容易被当成"这页本来就不显示市值"。
    """
    with _CAP_LOCK:
        if _CAP_MEMO:
            return
    disk = _read_disk()
    if not disk:
        return
    got = {it.get("key"): float(it["marketCap"]) for it in (disk.get("items") or [])
           if isinstance(it.get("marketCap"), (int, float)) and it["marketCap"] > 0}
    if got:
        now = time.time()
        with _CAP_LOCK:
            for k, v in got.items():
                _CAP_MEMO.setdefault(k, (v, now))


def fetch_caps(specs):
    """按源链取总市值，返回 `{key: 元}`。**取不到的标的直接不在字典里**。

    它**不抛异常**：市值只是表格里的一列，为它把整次取数变成失败是本末倒置
    （日线才是这一页的主体）。全链断掉时返回空字典，交给调用方用记忆兜底。
    """
    if not specs:
        return {}
    for name, _ in _ordered_sources([(n, None) for n in CAP_SOURCES]):
        fn = CAP_FUNCS.get(name)
        if not fn:
            continue
        try:
            out = fn(specs)
        except Exception:                            # noqa: BLE001
            # 与 _fetch_one 一致：源的意外错误也换源继续，不往上抛
            _mark_src(name, False)
            continue
        if out:
            _mark_src(name, True)
            return out
        _mark_src(name, False)                       # 返回空 = 这个源没给出东西
    return {}


# ------------------------------------------------------------------ 取数

def _ordered_sources(sources):
    """按"连续失败次数"把源链排一遍（次数少的在前），**过期的记忆当没有**。

    为什么需要它：主源被限流时，每个标的都要先花一次超时去撞那堵墙，
    十八只标的并发下来首屏就多等好几秒 —— 而这段时间注定是白等的。

    为什么必须带保鲜期（`SRC_MEMORY_TTL`）：排序一旦把主源压到备源后面，
    备源就会一直成功，主源永远拿不到那次"成功"来清零计数 ——
    限流结束时它也没机会被选上，成了一次性的永久降级。
    到点了就重新把它放回原位试一次，试通了自然就清零。
    """
    now = time.time()

    def weight(name):
        rec = _SRC_FAIL.get(name)
        if not rec:
            return 0
        cnt, at = rec
        return 0 if (now - at) > SRC_MEMORY_TTL else cnt

    with _SRC_LOCK:
        return sorted(sources, key=lambda s: weight(s[0]))


def _mark_src(name, ok):
    with _SRC_LOCK:
        if ok:
            _SRC_FAIL.pop(name, None)
        else:
            prev = _SRC_FAIL.get(name)
            _SRC_FAIL[name] = ((prev[0] if prev else 0) + 1, time.time())


def _fetch_one(spec):
    """按源链取一个标的。返回 `(code, sourceName, dates, closes, chgs)`。

    只有**全链都失败**才抛错；中间某个源失败是正常的（限流 / 单点故障），
    换个源接着来。
    """
    errs = []
    for name, arg in _ordered_sources(spec["sources"]):
        fn = SRC_FUNCS.get(name)
        if not fn:
            continue
        try:
            out = fn(arg)
        except DualityError as e:
            _mark_src(name, False)
            errs.append(str(e))
            continue
        except Exception as e:                       # noqa: BLE001
            # 源实现里的意外错误（解析结构变了之类）也不要吃掉 —— 但**换源继续**，
            # 只有整条链都断了才把原因汇总抛出去。
            _mark_src(name, False)
            errs.append("%s：%s" % (name, e))
            continue
        _mark_src(name, True)
        return out
    raise DualityError("；".join(errs) or (spec["display"] + "：没有可用数据源"))


def _align_stale_items(items):
    """把盘上那份 items 按**当前** INSTRUMENTS 对齐，返回一份新的列表。

    降级显示时用的是 `data/duality_cache.json` —— 而那个文件是**上一次成功取数时
    的代码**写的，可能是旧版本。两件事必须在这一层做完，不能让前端去猜：

      · **补 `group`**：旧版本落盘的 item 里没有这个字段。前端按当前分组过滤时
        会把它们全部滤掉，页面看起来像"这一组没有数据"，实际是缓存的锅。
        （症状最坏的一种：页面不报错、红条上写的还是"取数失败"，用户会以为是网络问题。）
      · **丢掉已删除的标的**：INSTRUMENTS 里删掉一只，旧缓存里那只会继续出现在
        图上和表里（连配色都是回退板的），没人会想到去看缓存文件。

    认不出的 key 一律丢掉，宁可少一行，也不要端上一只"当前配置里不存在"的标的。
    """
    spec = {s["key"]: s for s in INSTRUMENTS}
    out = []
    for it in items or []:
        s = spec.get(it.get("key"))
        if not s:
            continue
        it = dict(it)
        it["group"] = s["group"]
        out.append(it)
    return out


def fetch_all(force=False):
    """取全部标的，返回可直接 `json.dumps` 的 payload。

    带内存缓存（`CACHE_TTL`），`force=True` 绕过。

    **十八只标的并发取，不是排队取**：单只最坏要跑满源链 × 重试，
    串行下来首屏能等到十几秒 —— 而这是一个一进来就要看数的页面。
    """
    with _LOCK:
        if (_CACHE["payload"] is not None and not force
                and (time.time() - _CACHE["at"]) < CACHE_TTL):
            return _CACHE["payload"]

    out, errors = {}, []
    lock = threading.Lock()

    def work(spec):
        try:
            code, src_name, dates, closes, chgs = _fetch_one(spec)
        except DualityError as e:
            with lock:
                errors.append("%s：%s" % (spec["display"], e))
            return
        with lock:
            out[spec["key"]] = {
                "key": spec["key"],
                "name": spec["display"],
                "kind": spec["kind"],
                "unit": spec["unit"],
                "market": spec["market"],
                "note": spec["note"],
                # 分组：前端按它把标的切到各自的 tab 上（见 GROUPS）。
                # **必须透传**，前端不按 note 或 key 去猜自己属于哪一组。
                "group": spec["group"],
                "code": code,
                "sourceName": src_name,
                # 三个并行数组比分对象数组小一圈（800 根 × 11 只，省下的是实打实的传输量）
                "dates": dates,
                "closes": closes,
                "chgs": chgs,
            }

    threads = [threading.Thread(target=work, args=(s,), daemon=True) for s in INSTRUMENTS]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # 按 INSTRUMENTS 的顺序还原（并发完成先后不可控，页面上标的前后顺序必须固定）
    items = [out[s["key"]] for s in INSTRUMENTS if s["key"] in out]

    # --- 总市值：一个批量请求补齐（只有股票有；期货不进 spec，也就不会有这个字段）
    #
    # 取数在日线**之后**、串行等待：它只打一个请求（1 秒内），
    # 而并发进 work() 里会让每只票各自记住一份"我拿到的市值"，反而要额外去重。
    _seed_cap_memo()
    stock_specs = [s for s in INSTRUMENTS if s["kind"] == "stock"]
    caps = fetch_caps(stock_specs)
    now_cap = time.time()
    with _CAP_LOCK:
        for k, v in caps.items():
            _CAP_MEMO[k] = (v, now_cap)              # 取到了就刷新记忆
    for k, v in _memo_caps().items():                # 本轮没取到的用记忆顶上
        caps.setdefault(k, v)
    for it in items:
        if it["key"] in caps:
            it["marketCap"] = caps[it["key"]]

    # 一个都没取到 → 不清内存缓存（那会把这半小时全锁死），改为退回**盘上**
    # 最后一次成功的那份，并明确标 `stale`。页面见到 stale 会直说"这是几点几分的
    # 数据、本次取数失败"，而不是把旧数字当新的端上来。
    if not items:
        disk = _read_disk()
        if disk and disk.get("items"):
            disk = dict(disk)
            disk["ok"] = True
            disk["stale"] = True
            disk["errors"] = errors
            disk["message"] = ("本次取数失败，显示的是 " + str(disk.get("generatedAt"))
                               + " 缓存的行情：" + "；".join(errors or ["未知原因"]))
            # 盘上那份可能是**旧代码**写的（没有 group、甚至还有已经删掉的标的），
            # 直接端给前端会静默少一行/少一组 —— 见 _align_stale_items。
            disk["items"] = _align_stale_items(disk.get("items"))
            disk["count"] = len(disk["items"])
            disk["groups"] = GROUPS
            return disk

    payload = {
        "ok": bool(items),
        "stale": False,
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "source": "东方财富 / 腾讯 / 新浪（日线，前复权）",
        "count": len(items),
        # 分组定义随数据一起下发：前端据此出 tab（顺序与文字都不再写死在前端），
        # 后端加一组 = 页面上多一个 tab，不必动 static/duality.js。
        "groups": GROUPS,
        "errors": errors,
        "items": items,
    }

    if items:
        with _LOCK:
            _CACHE["at"] = time.time()
            _CACHE["payload"] = payload
        _save_disk(payload)
    return payload


# ------------------------------------------------------------------ 落盘缓存

def _save_disk(payload):
    """先写临时文件再 rename —— 断电/被杀时不会留下半个 JSON。

    盘上的东西只用来"降级显示"，所以这里**吞掉所有写失败**：
    写不进去（只读挂载、磁盘满）不该让一次成功的取数变成失败。
    """
    try:
        d = os.path.dirname(DUALITY_CACHE_PATH)
        if d and not os.path.isdir(d):
            os.makedirs(d, exist_ok=True)
        tmp = DUALITY_CACHE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp, DUALITY_CACHE_PATH)
    except OSError:
        pass


def _read_disk():
    try:
        with open(DUALITY_CACHE_PATH, encoding="utf-8") as f:
            obj = json.load(f)
    except (OSError, ValueError):
        return None
    return obj if isinstance(obj, dict) and obj.get("items") else None


def clear_cache():
    """丢内存缓存与源失败记忆。测试用（生产路径靠 TTL 自然过期）。
    **不动盘上的那份** —— 那是降级用的最后一手。"""
    with _LOCK:
        _CACHE["at"] = 0.0
        _CACHE["payload"] = None
    with _SRC_LOCK:
        _SRC_FAIL.clear()
    with _CAP_LOCK:
        # 市值记忆也清掉。否则用例换一批桩标的跑，上一批的市值会从记忆里漏进来 ——
        # 那是"测试之间互相污染"，比测试失败更难查。
        _CAP_MEMO.clear()
