# 早盘总结 · 数据契约与生成流程

早盘总结页（`/morning`）**不抓行情**，只读取 `data/morning.json`。
这份文件由定时任务在**工作日 06:30（北京时间）**调用 `us-stock-daily-review` 技能生成后写入。

```
06:30 定时任务
  └─ 调用 us-stock-daily-review 技能
       ├─ python3 morning_fetch.py -o /tmp/raw.json   # 机械取数（指数 / 全市场涨幅榜 / 个人关注池）
       ├─ 补驱动原因（news / web_search / agentic_search）
       ├─ 做主线归纳与关联性分析（需要判断，只能由智能体完成）
       └─ 按本文件的结构写入 data/morning.json
            └─ 页面 GET /api/morning 读取并渲染（服务端只读，不做任何抓取）
```

## 为什么要把「取数」和「分析」分开

`morning_fetch.py` 负责**可验证的机械部分**（拉数据、算涨跌幅、解析市值），
它跑得快、结果确定、出错能定位；驱动原因 / 主线归纳 / A 股映射需要判断，交给智能体。
两边混在一起时，一旦某个数据源抖动，很难分清是取数坏了还是判断错了。

## 文件结构

写入 `us-movers-live/data/morning.json`，UTF-8、JSON 对象。**除 `meta` 外所有字段都可缺省**——
页面按「缺就不渲染那一块」处理，绝不让一个空数组把整页搞挂。

```jsonc
{
  "meta": {
    "tradeDate": "2026-09-21",              // 必填。美东交易日 YYYY-MM-DD，服务端用它算 stale
    "tradeDateLabel": "9月21日（周一）",      // 必填。页头徽章直接显示
    "generatedAt": "2026-09-23T06:30:12+08:00",  // 必填。ISO 8601 带时区
    "generatedBy": "us-stock-daily-review",  // 必填。**只进接口，页面上已不展示**
    "sources": ["westock", "finviz", "web_search"],  // 同上：只进接口，页面已无页脚
    "notes": ["生成过程的自我说明"]           // 可选；字段保留但**当前不渲染**
    // ↑ 2026-09-22 按用户要求，早盘页不再显示这块「数据说明」提示条
    //   （shell.js 的 fetchDaily 里注释掉了 msgs.concat(meta.notes)）。
    //   同一天稍后，页脚那条「数据来源 / 生成方式 / 剔除说明」也按同一理由去掉了：
    //   都是生成过程的旁注，不是读者看盘需要的信息。
    //   这三个字段（sources / generatedBy / excludedNote）继续保留在契约里，
    //   定时任务照写，排障时看 JSON 或 /api/morning 即可。
  },

  "indices": [                               // 大盘，ETF 代理口径
    { "code": "usSPY", "name": "标普500（SPY）",
      "close": 773.50, "chgPct": 1.55, "chgAbs": 11.81, "note": "" }
  ],
  "marketComment": "一句话点评当日风格",
  // ↑ 字段保留但**当前不渲染**（2026-09-22 按用户要求移除页面上的「导语」块，
  //   首屏位置改由「主线归纳」承担）。原因：它与「主线归纳」内容重复，
  //   且常引用另一套口径的命中数，与异动榜的双轨制口径不一致。
  //   想放回页面只需恢复 morning.js 里的 leadHtml 并在 render 中调用。

  "movers": [                                // 个股异动榜
    { "symbol": "ARM", "name": "Arm Holdings plc",
      "price": 322.90, "chg": 17.16,         // 字段名与「夜盘异动」同源（finviz → screening.normalize）
      "marketCap": 3.4486e11,                // 市值单位＝**美元**（页面用 U.fCap 换算成「亿美元」显示）
      "sector": "信息技术", "sectorEn": "Technology",       // 中文由 taxonomy_zh 生成
      "industry": "半导体", "industryEn": "Semiconductors",
      "country": "United States", "volume": 1234567, "source": "finviz",
      "driver": "产业因子 · 个股催化剂",       // 这一段由智能体补，取数脚本不管
      "giant": true }                        // true = 巨头异动，页面加星标并高亮
  ],
  // ↑ 价格 / 涨跌幅 / 总市值 / 板块 / 行业 五列与「夜盘异动」**同一套取数管道、同一套字段名**
  //   （morning_fetch.py 的 finviz_rows 直接调 screening.normalize），两页同一只票数值必然一致。
  //   两页差异只剩最后一列：那边是「查原因」外链，这边是写好的「驱动原因」。
  //   历史旧字段名（code / close / chgPct / capYi / tags）在渲染层仍作回退兼容。

  "watchlist": [                             // 个人关注池，全部展示，不论涨跌
    { "code": "usINTC", "name": "Intel 英特尔", "close": 121.78,
      "chgPct": 12.14, "capYi": 6437.4, "keyword": "涨幅关键词" }
  ],
  // ↑ 这是**底稿**。页面还允许用户自己增删（存在浏览器 localStorage，不回写这里），
  //   最终列表 = 底稿 − removed + added。所以这里少一只、多一只都不算错。
  //   生成脚本不必知道用户的增删；用户那边也不会因为这里的每日更新而丢改动。

  "excludedNote": "一句话交代剔除口径",

  "themes": [                                // 主线归纳
    { "name": "主线名", "quality": "高",      // 高 / 中 / 低 → 页面渲染成彩色徽章
      "stocks": ["ARM +17.16%"], "catalyst": "当日催化剂小结" }
  ],

  "linkage": [                               // 关联性深度分析（技能的核心输出）
    { "factor": "关联因子名", "confidence": "高",
      "usStocks": ["ARM +17.16%", "INTC +12.14%"],
      "logic": "为什么这些票一起涨：共同因子 → 传导链",
      "aShareSectors": "精确到二级/三级子赛道",
      "aShareNames": ["浪潮信息 sz000977", "中科曙光 sh603019"] }
  ],

  "aShareHints": ["A 股联动提示，逐条"]       // 字符串数组
}
```

## 异动口径（技能的「双轨制」定义）

| 类型 | 条件 |
|---|---|
| 常规异动 | 涨幅 **> 10%** 且 市值 **> 20 亿美元** |
| 巨头异动 | 涨幅 **≥ 4%** 且 市值 **> 1400 亿美元**（≈ ¥1 万亿） |

市值 **≤ 20 亿美元**的微盘股一律舍弃（流动性差、数据失真、无 A 股映射价值）。

### 输出顺序（2026-09-22 按用户要求改）

| 数组 | 顺序 |
|---|---|
| `movers`（个股异动榜） | **涨跌幅降序**，涨得最多的在最上面；并列按代码升序兜底 |
| `watchlist`（个人关注池） | **股票代码字母序**（按页面显示的形态，即去掉 `us` 前缀后比较） |

原先 `movers` 是「巨头优先，其次按涨幅降序」—— 那会把一只涨 4.1% 的巨头排到涨 12% 的
常规异动前面，名次和"涨得多少"脱钩。现在巨头身份只由名称列的「★ 巨头」徽章表达，不占排序位。
`watchlist` 原先按涨幅降序：关注池是固定清单，按涨幅排会让同一只票天天换位置，
想找某只票得先知道它今天涨了多少，等于每次重扫一遍；代码是稳定键。

> 排序在**两处**都做了，是刻意的：`morning_fetch.py` 保证写出的 JSON 自洽，
> 渲染层（`morning.js` 的 `sortMovers` / `sortWatchlist`）保证页面上看到的一定是对的
> —— 数据文件每天 06:30 才更新，改了排序规则当天读到的还是旧顺序的那份。
> 两处顺序**必须一致**，由 `tools/test_morning_order.js` 盯住。

## 必须做的过滤

1. 杠杆 / 反向 ETF —— 按**名称**判断（含 `2X`/`3X`/`Daily`/`Direxion`/`Proshares`/`Ultra` 等），
   不要凭代码前缀批量删，正股代码常是 ETF 代码的前缀（如 AXTI 正股 → AXTU/AXTC 杠杆 ETF）。
2. 权证（`C/Wts`/`Wt`/`Warrant`）、SPAC Units（名称含 `Units`）。
3. 仙股 / 粉单 / 退市整理股（价格 <$5 且单日涨幅 100%+）。
4. 流动性极差的 OTC（成交量 <1 万股却涨幅异常）。
5. 同公司多类别股票的流动性伪影（如 MKC.V）。

## 本机环境的已知限制（2026-09-22 实测，重要）

技能文档写的两条数据命令**在本机不可用**：

| 技能期望的命令 | 实际情况 |
|---|---|
| `westock-data quote ...` | npm 上只有 `westock-data-clawhub`，它**没有 `quote` 子命令** → 用 `kline <代码> --period day --limit 4` 取最近两根日线自己算涨跌幅（`morning_fetch.py` 已实现） |
| `westock-tool filter "..."` | **该包在 npm 上不存在**，技能市场里也没有 → 全市场筛选改用 **finviz**（与夜盘异动页同一引擎，已实测可用） |

另外两点：

- **finviz 的地址已从 `/screener.ashx` 迁到 `/screener`** 并返回 301。用 urllib 会自动跟随，
  但显式写 `/screener` 可以少一跳。`providers.py` 与 `morning_fetch.py` 都已改。
- **finviz 的 `filter` 结果不完整**（技能自己也警告过）：实测当日 INTC +12.14%、MRNA +12.27%
  这类大盘涨股没有被收录。**必须用 `web_search` 补一轮**（搜 "S&P 500 top gainers <日期>" 或
  第三方涨幅排行），再用 kline 逐一验证涨幅与市值，否则会系统性漏股。

> 如果想彻底解决：把「腾讯自选股」连接器连上，它提供 `tool_filter` / `data_quote`，
> 就是技能原本依赖的那套接口。连上后 `morning_fetch.py` 里 finviz 那一段可以换回 connector。

## 页面侧的行为

- **个股异动榜的列与「夜盘异动」一致**（2026-09-22 按用户要求）：
  代码 / 公司全称 / 价格(USD) / 涨跌幅 / 总市值(亿美元) / 板块 / 行业 —— 取值与格式全部共通，
  两页差异只剩最后一列（那边是「查原因」外链，这边是写好的「驱动原因」）。
  取数上也同源：`morning_fetch.py` 的 `finviz_rows()` 走 `providers.FinvizProvider` 抓取 +
  `screening.normalize` 归一化，不再自己写一套解析。
  提示：场外代码（OTC/ADR）finviz 不收录板块行业，历史数据里这 8 只由人工归类，
  并在 JSON 中标 `sectorSource: "manual"`（其余为 `"finviz"`）。
- **分三个标签页**（2026-09-22 按用户要求；「关注」是当天后加的）：
  - 「总览」= `indices` + `themes` + `linkage` + `aShareHints`（大盘表现 → 主线归纳 → 关联性深度分析 → A 股联动提示）
  - 「个股」= `movers`（个股异动榜）
  - 「关注」= `watchlist`（个人关注池；原先并排在「个股」页，同日挪出独立成页）
  标签之外原本还有一条页脚（数据来源 / 剔除口径），已于 2026-09-22 按用户要求去掉。
  分栏依据是读法不同：总览纵向读结论，个股横向比对行情，关注是看自己攒的固定清单
  （池子里大半是没涨甚至下跌的票，跟异动榜放一起会被误读成"当日异动的一部分"）。
  切换只切 `hidden`，不重渲染（数据是静态 JSON，重建 DOM 只会丢滚动位置）。
  选中哪一页记在 localStorage，**存的是 key 不是下标**，所以加标签不会让老记忆失效。
- 服务端 `GET /api/morning`：文件不存在 / 解析失败时返回 `{ok:false, message:"…"}`，
  页面渲染空状态而不是白屏。
- `meta.tradeDate` 距今天数 **> 4**（含周末）时自动标 `stale`，页面提示「自动更新可能没跑起来」。
- 页面用 `mode:"daily"` 挂载：**不轮询**，页头显示 市场状态 / 复盘交易日 / 生成时间 / 数据源，
  只有一个「重新读取」按钮。日更数据挂轮询纯属白烧请求，且倒计时会误导。

## 手动补跑

```bash
cd us-movers-live
SESSION_DATE=2026-09-21 python3 morning_fetch.py -o /tmp/raw.json   # 覆盖交易日
```
