/* 「期股双面」页（static/duality.html 专用）
 *
 * 一页回答一个问题：**同一种商品，期货那一面和股票那一面，走得像不像。**
 * 所以一组里的标的（一条期货 + 数只对应股票）必须画在**同一条时间轴**上。
 *
 * 页面上有**三组**，由顶部 tabs--page 切换（后端 duality.py 的 GROUPS → payload.groups）：
 *
 *    纽约金 × 黄金股    2026-10-08 起
 *    纽约银 × 白银股    2026-10-12 起
 *    纽约铜 × 铜股      2026-10-12 起（同日追加）
 *
 * 各组**绝不混画**：金和银同为贵金属、铜更是宏观顺周期品种，彼此日相关性不低，
 * 但把金价和铜股的归一化涨跌幅放到同一根纵轴上，那条 0% 基准就同时代表两种基本面，
 * 读出来的"相关性"没有意义。
 *
 * ---------------------------------------------------------------- 三个关键取舍
 *
 * ① **归一化，不画绝对价。** 纽约金 4145 美元/盎司、纽约铜 6.7 美元/磅、
 *    紫金矿业 29 元 —— 把这三条原始价格画在同一根 Y 轴上，股票会是一条贴着底边的
 *    直线，图上什么也看不出来。所以 Y 轴一律是**相对区间基准的涨跌幅（%）**，
 *    各条线共用 0% 这条基准线。绝对价不进图，进下面的表格和悬停提示。
 *
 * ② **区间由前端裁，不重新取数。** 后端一次给全部（约 800 根日线 × 16 只），
 *    切 7 天 / 30 天 / 90 天 / 180 天 / 年初至今 / 自定义全在浏览器里完成 ——
 *    点一下标签要等两秒的图，没人会愿意来回切。代价只是首屏多搬十几 KB（gzip 后）。
 *
 * ③ **不补点。** 中美假期不同，某一天可能只有一边有数据。折线**直接跨过去**相连，
 *    不在缺口处伪造一个"当天没交易但假装有"的价格。缺口处的斜率会缓一点，
 *    这是时间轴的正确表现，不是 bug。
 *
 * ---------------------------------------------------------------- 口径（页面上也写了）
 *
 *   · 0% 的基准 = **区间开始前最后一个交易日**的收盘价（拿不到时退化为区间内第一根）。
 *     之所以不取"区间内第一根"：不同标的的区间首日未必是同一天，
 *     各自拿各自的首日当基准，各条线的起点就对不齐了。
 *   · 全部为**前复权**价（除权跳空不参与涨跌幅计算；最后一根仍是真实行情价）。
 *   · 最后一根可能是**盘中价**：A 股 15:00 后是收盘价，COMEX 期货是近 24 小时
 *     电子盘，任何时候看的都是"当前价"。所以页头写的是「取数时间」而不是「数据截止时间」。
 */
(function (w) {
  "use strict";

  /* 与后端 server.py 的 DUALITY_SCHEMA 成对。改响应结构时两边一起改 ——
     对不上时页面要能**认出来并直说**，而不是把缺字段渲染成"这页没数据"。
     参考同一个坑：明暗对照页的 BUSINESS_MAP_SCHEMA。

     v2（2026-10-08）：item 上多了 `marketCap`（总市值，单位元；**期货没有这个字段**），
     表格据此多一列并重排。**正因为是"多了一个字段"才要升版本** ——
     旧服务的响应里没有它，页面不会报错，只会把整列画成"—"、排序也退回原顺序，
     看上去像"这只票没有市值数据"，而实际要做的是重启服务。
     版本号对不上时页头会直接给出那句重启命令（见 load()）。

     v3（2026-10-12）：页面上多了「纽约银 × 白银股」分组。item 上多了 `group`、
     顶层多了 `groups`，页面据此出 tab 并按组过滤标的。**同样必须升版本** ——
     旧服务的响应里两个字段都没有，新页面会一个分组都凑不出来，
     图和表全空，而它只是需要重启一下服务。

     v4（2026-10-12，同日）：又多了「纽约铜 × 铜股」。**这一次字段没变，照样升版本** ——
     结构没变不等于结果一样：旧服务的 groups 里没有铜组，页面会安安静静地只画出
     两个 tab，看不出"第三次改动没生效"。版本号是**内容契约**的一部分，
     加一组也是改契约（不然用户会以为是页面写错了）。
     加一组的分工只有两步：duality.py 的 GROUPS + 每条新标的的 group，以及
     下面 PALETTE 的配色。 */
  var DUALITY_SCHEMA = 4;

  /* 页面级 tab（.tabs--page）的**兜底**定义。
     **正常情况下这份不用** —— 分组由后端给（duality.py 的 GROUPS → payload.groups），
     后端加一组 = 页面上多一个 tab，这里不必动。留着它是为了"响应里没有 groups"
     时页面别整个空掉（那属于版本不匹配，load() 会先拦下来并给出重启命令）。
     ⚠️ 新增分组时**别只改这里**：真正要改的是 duality.py 的 GROUPS 与 INSTRUMENTS，
     以及下面 PALETTE 的配色（后端加了标的而前端没配色**不报错**，
     会静默落到 PALETTE_FALLBACK，可能出现两条线同色）。 */
  var PAGE_TABS_FALLBACK = [
    { key: "gold", label: "纽约金 × 黄金股" }
  ];

  /* 时间范围。`days` 是**自然日**（不是交易日）—— 用户说的"过去 7 天"就是 7 天。
     代价是长假期间区间里可能只有一两个交易日（国庆、春节尤其明显），
     那样折线几乎画不出来。页面不替用户改口径，但会把
     「区间内有几个交易日」写在图上方，让人一眼知道为什么线这么短。 */
  var RANGES = [
    { key: "7",   label: "过去 7 天" },
    { key: "30",  label: "过去 30 天" },
    { key: "90",  label: "过去 90 天" },
    { key: "180", label: "过去 180 天" },
    { key: "ytd", label: "今年至今" },
    { key: "custom", label: "自定义" }
  ];

  /* 系列配色。按标的 key 固定，不按勾选顺序 —— 否则取消一个再勾回来，
     颜色会跟着换位置，读图的人会以为换了一只票。
     这几个色刻意避开 --red / --green：那两个是**涨跌语义色**，
     拿来当系列色会让"这条线是红的"和"这只票在涨"混成一件事。
     金色取 #c97600（站内那个压深的金色，原金 #fcb13a 在白底对比度不够）。 */
  var PALETTE = {
    gold: "#c97600",
    zijin: "#1554b0",
    sdgold: "#7b4bbf",
    cfgold: "#0f8b8d",
    // 2026-10-08 新增：中国黄金 / 四川黄金。玫红与橄榄绿在色相环上与原有四色
    // 各隔 60° 以上，六条线同时出现也分得开（橄榄绿偏黄，与 A 股"跌"的翠绿不是一回事）。
    zggold: "#c2185b",
    scgold: "#7a8c00",
    // 2026-10-12 新增：白银组（纽约银 + 四只白银股）。白银本来该用灰，但灰在白底上
    // 与网格线抢视觉，这里改用**石板蓝**（冷色、低饱和，与黄金组的暖金呼应又分得开）。
    // 四只股票两两相隔 90° 以上，五条线同图不撞色。
    silver: "#5b6b8c",
    hnby: "#d4562a",
    byys: "#1f7a4d",
    ygjq: "#8e44ad",
    sdzy: "#a8761c",
    // 2026-10-12 追加：铜组（纽约铜 + 四只铜股）。期货那条直接用**金属本身的颜色**
    // （铜锈棕橙 #a3562b），四只股票分布在色相环的四个象限（蓝 / 紫 / 青绿 / 玫红），
    // 彼此相隔 45° 以上，五条线同图不撞色。
    // 同一档色相在不同组里重复**不算问题**：两组从不同框出现，读者不会同时看着它们；
    // 组内分得开才是唯一的要求。
    copper: "#a3562b",
    jxty: "#1d6fa5",
    tlys: "#7d3f98",
    ynty: "#0e8c66",
    bfty: "#a0365f"
  };
  //: 后端若新增了标的面这里没配到色，按顺序取这个回退板
  var PALETTE_FALLBACK = ["#b5307a", "#4d7a12", "#0b6ea8", "#8a5a00"];

  var PAD = { l: 60, r: 22, t: 18, b: 36 };   //: 绘图区四周留白（左要给 Y 轴标签留位）
  var CHART_H = 400;                          //: 绘图区固定高；宽随容器（响应式）
  /* 悬停时"鼠标算贴着这条线"的纵向像素半径。五条线同图后，
     光靠提示框里的色点已经认不出自己指的是哪条，所以加线吸附。
     太小（<10）点不中，尤其触控板；太大（>35）在两条线挨得近时会认错。 */
  var LINE_SNAP = 22;

  var $ = function (id) { return document.getElementById(id); };

  var S = {
    payload: null,
    items: [],
    picked: {},                     //: key -> bool。用户勾选状态，跨"立即刷新"保留
    range: "7",                     //: 默认 7 天（用户对这个页面的原始描述就是"过去 7 天"）
    custom: { start: "", end: "" },
    tab: PAGE_TABS_FALLBACK[0].key, //: 当前分组（tabs--page）。默认第一组
    busy: false,
    resizeTimer: null
  };

  // ------------------------------------------------------------ 小工具

  /** 分组定义（tab 的顺序与文字）。**以后端为准**，只在响应里没有时用兜底那份。 */
  function groupTabs() {
    var g = (S.payload && S.payload.groups) || [];
    return g.length ? g : PAGE_TABS_FALLBACK;
  }

  /** 当前分组下的标的。**所有渲染都走这里** —— 别直接读 S.items：
      不同分组的标的不该同框（见 duality.py 里 GROUPS 的说明）。
      标的没有 group 字段时（旧服务）归第一组，免得页面整个空掉还看不出原因。 */
  function groupItems() {
    var first = groupTabs()[0].key;
    var cur = S.tab || first;
    return (S.items || []).filter(function (it) {
      return (it.group || first) === cur;
    });
  }

  /** 当前分组里那条期货的名字（"纽约金" / "纽约银" / "纽约铜"）。
      图注与表脚注要按它说事 —— 写死"纽约金"的话，切到银、铜组后那句话就是错的，
      而错的方式很隐蔽（读者不会去核对图上画的到底是金、银还是铜）。 */
  function futureName() {
    var f = groupItems().filter(function (it) { return it.kind === "future"; })[0];
    return f ? f.name : "期货";
  }

  /** 当前分组的 tab 文字（空态文案要用） */
  function groupLabel() {
    var tabs = groupTabs();
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].key === S.tab) return tabs[i].label;
    }
    return tabs[0].label;
  }

  /** 标的配色。key 对不上就按索引取回退板 —— 后端加标的时页面不会渲染成灰色 */
  function colorOf(key, i) {
    return PALETTE[key] || PALETTE_FALLBACK[i % PALETTE_FALLBACK.length];
  }

  /** "YYYY-MM-DD" → 天序号（UTC 零点起算）。用它做日期加减与排序，避开本地时区。 */
  function dayNum(s) { return Math.round(Date.parse(s + "T00:00:00Z") / 86400000); }

  function shiftDays(s, n) {
    return new Date((dayNum(s) + n) * 86400000).toISOString().slice(0, 10);
  }

  function fmtMD(s) { var p = String(s).split("-"); return (+p[1]) + "/" + (+p[2]); }
  function fmtMDCN(s) { var p = String(s).split("-"); return (+p[1]) + "月" + (+p[2]) + "日"; }

  /** 价格小数位：期货给 1 位（4145.5），股价给 2 位 —— 与各自市场的报价习惯一致 */
  function priceDec(kind) { return kind === "future" ? 1 : 2; }

  function fmtPrice(v, kind) {
    if (v === null || v === undefined || isNaN(v)) return "—";
    return Number(v).toFixed(priceDec(kind));
  }

  /** 涨跌幅文本，带符号；涨跌配色交给 U.dirClass（涨=红、跌=绿） */
  function fmtPct(v) {
    if (v === null || v === undefined || isNaN(v)) return "—";
    return (v > 0 ? "+" : "") + Number(v).toFixed(2) + "%";
  }

  function dirClass(v) { return (v || 0) >= 0 ? "up" : "down"; }

  /** 千分位。自己写而不用 toLocaleString：后者在不同运行时的默认 locale 下
      分隔符可能是 `，` 或空格（小程序 webview 上就撞过），表格里要的是稳定。 */
  function thousands(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  /** 总市值。后端给的是**元**，这里换算成「亿 / 万亿」——
     读 A 股市值默认就是看亿，把 780971744338 原样摆进表格没人能一眼读出量级。
      四舍五入到整亿：这一列的用处是**看量级、看谁比谁大**，不是精算到小数点后两位。
      没有市值（期货）或取数失败 → "—"（缺字段与 null 都走这里，不写成 0 亿）。 */
  function fmtCap(v) {
    if (typeof v !== "number" || !isFinite(v) || v <= 0) return "—";
    var yi = v / 1e8;
    if (yi >= 10000) return (yi / 10000).toFixed(2) + " 万亿";
    return thousands(Math.round(yi)) + " 亿";
  }

  /** 排序键：总市值（元）。拿不到返回 null —— 期货本来就没有市值，
      取数失败时也是这个值。**这类一律沉到表尾**：让它在中间会把"从大到小"读断。 */
  function capOf(it) {
    var v = it && it.marketCap;
    return (typeof v === "number" && isFinite(v) && v > 0) ? v : null;
  }

  /** 悬停提示里那个"具体是哪个"的标识。**不能用 `it.code`** —— 那个字段是
   *  数据源给的，同一只票走东财是 `601899`、走腾讯是 `sh601899`，会随当天
   *  哪条源通而换写法（缓存里现在就是后者）。`note` 则是写死在 duality.py 的
   *  INSTRUMENTS 里的，形如 `601899 · 铜金矿龙头`，取「·」前那段即代码。
   *  期货没有证券代码（note 是 `COMEX 黄金期货主连`），退回到市场名 ——
   *  显示 `COMEX` 反而正好说明它不是 A 股。 */
  function secOf(it) {
    var m = /^(\d{6})\s*·/.exec(it.note || "");
    if (m) return m[1];
    return it.market || "";
  }

  // ------------------------------------------------------------ 启动

  function mount() {
    // duality 模式：壳给骨架 + 取数时间徽章 + 页头「立即刷新」按钮；数据由本文件自己取（见 load）。
    w.Shell.mount({ mode: "duality", navKey: "duality", title: "期股双面" });
    // 必须在 Shell.mount 之后 —— 页头 DOM 是那一步渲染的（见 bindHeaderRefresh 的时序说明）
    bindHeaderRefresh();
    renderPageTabs();
    // 事件只在挂载时绑一次。**不能**放进 renderPageTabs —— 那个函数每次切 tab 都会重画
    // DOM，跟着再 bind 一次会让监听器越积越多（点一次触发两次、三次…）。
    var tabsHost = $("tabs");
    if (tabsHost) {
      tabsHost.addEventListener("click", function (e) {
        var b = e.target && e.target.closest ? e.target.closest(".tab") : null;
        if (!b) return;
        S.tab = b.getAttribute("data-k");
        renderPageTabs();
        renderPanel();
      });
    }
    load(false);

    /* 窗口宽度变了要重画 SVG —— 图是按容器像素宽现算的，不重画就会在窄窗口里
       横向溢出（或宽窗口里留一条空白）。防抖 150ms：拖动窗口时不必每一帧都重绘。 */
    w.addEventListener("resize", function () {
      if (S.resizeTimer) clearTimeout(S.resizeTimer);
      S.resizeTimer = setTimeout(function () { paintChart(); }, 150);
    });
  }

  /** 页面级 tab 栏 —— 一个 tab 一个分组（期货 × 对应股票），文字与顺序都来自后端。
   *
   *  只在 load() 拿到响应之后调用（分组定义在 payload 里）；挂载时先调一次是为了
   *  首屏不至于没有 tab（那时用的是兜底那份）。 */
  function renderPageTabs() {
    var host = $("tabs");
    if (!host) return;
    host.innerHTML = groupTabs().map(function (t) {
      return '<button class="tab' + (t.key === S.tab ? " on" : "") +
        '" data-k="' + U.esc(t.key) + '">' + U.esc(t.label) + "</button>";
    }).join("");
  }

  // ------------------------------------------------------------ 取数

  function load(force) {
    if (S.busy) return;
    S.busy = true;
    paintHeaderRefresh(true);
    fetch("/api/duality" + (force ? "?force=1" : ""), { cache: "no-store" })
      .then(function (r) {
        return r.text().then(function (txt) {
          var j = null;
          try { j = JSON.parse(txt); } catch (e) { j = null; }
          return { ok: r.ok, json: j };
        });
      })
      .then(function (res) {
        var j = res.json;
        /* 拿不到结构 = 服务还是旧代码（这条路由还没上），或者根本不是本项目的服务。
           这种情况**不能**渲染成"没有数据" —— 那会让人去翻数据文件，
           而真正要做的是重启服务。所以这里直接把话说明白。 */
        if (!j || j.schema !== DUALITY_SCHEMA) {
          shellNotice("服务返回的结构与本页不匹配（页面需要 v" + DUALITY_SCHEMA +
            "，收到 " + (j && j.schema !== undefined ? "v" + j.schema : "非 JSON 响应") +
            "）。服务很可能还跑着旧代码 —— 加接口后需要重启：" +
            "在项目目录执行 bash tools/start.sh --restart", true);
          $("dualityHost").innerHTML =
            '<div class="empty">接口不可用：服务需要重启（见上方黄条）。</div>';
          return;
        }
        S.payload = j;
        S.items = j.items || [];

        /* 分组以**响应**为准。后端加/删一组时，当前选中的 tab 可能已经不存在 ——
           这时退到第一组，而不是把 S.tab 留成一个空分组（那样页面会是"一片空白"，
           看不出是"这个分组没了"还是"数据没取到"）。 */
        var tabs = groupTabs();
        if (!tabs.some(function (t) { return t.key === S.tab; })) S.tab = tabs[0].key;
        renderPageTabs();

        /* 首次取数：默认全选。之后（「立即刷新」）保留用户的选择 ——
           用户特地把某只票取消掉，刷新一次又全勾上，是会被骂的。 */
        if (!Object.keys(S.picked).length) {
          S.items.forEach(function (it) { S.picked[it.key] = true; });
        }
        // 标的清单变了（后端增删）：新标的补上、已消失的清掉
        var alive = {};
        S.items.forEach(function (it) {
          alive[it.key] = true;
          if (S.picked[it.key] === undefined) S.picked[it.key] = true;
        });
        Object.keys(S.picked).forEach(function (k) { if (!alive[k]) delete S.picked[k]; });

        // 自定义范围的默认值：没填过就用 30 天前 ~ 今天，省得用户从头选
        var today = todayStr();
        if (!S.custom.end) S.custom.end = today;
        if (!S.custom.start) S.custom.start = shiftDays(today, -29);

        paintHeaderBadges();
        // 降级（显示的是盘上缓存）用红条，其余（部分失败 / 口径说明）用黄条。
        shellNotice(noticeText(j), !!j.stale);
        renderPanel();
      })
      .catch(function (e) {
        shellNotice("无法连接后端服务：" + ((e && e.message) || "未知错误"), true);
        var host = $("dualityHost");
        if (host && !host.getAttribute("data-built")) {
          host.innerHTML = '<div class="empty">无法连接后端服务。</div>';
        }
      })
      .finally(function () {
        S.busy = false;
        paintHeaderRefresh(false);
      });
  }

  /** 这一页的「今天」。取 **max(后端取数时间, 数据里的最后一天)**，三者都不是浏览器时钟。
   *
   *  为什么不直接读 `new Date()`：
   *    · 机器时钟快一天 → 区间整体右移，"过去 7 天"里有一半是未来，图上右侧空一块；
   *      而且页面上一切正常，看不出来。
   *    · 落盘缓存降级时（见 duality.py 的 stale），后端给的是**那份缓存的取数时间**，
   *      用它可以保证图上时间和黄条里说的"这是 X 时刻的数据"对得上。
   *  取 max 是为了兜住"缓存是昨天的、但数据里有今天"这种边界：宁可区间右边界晚，
   *  也不要让已经到手的最新一根掉在区间外。 */
  function todayStr() {
    var best = "";
    var g = (S.payload && S.payload.generatedAt) || "";
    if (/^\d{4}-\d{2}-\d{2}/.test(g)) best = g.slice(0, 10);
    (S.items || []).forEach(function (it) {
      var d = it.dates && it.dates[it.dates.length - 1];
      if (d && d > best) best = d;
    });
    if (best) return best;
    // 两条路都没有（接口异常/空数据）时的兜底，至少别让页面崩
    var d2 = new Date();
    return d2.getFullYear() + "-" +
      ("0" + (d2.getMonth() + 1)).slice(-2) + "-" + ("0" + d2.getDate()).slice(-2);
  }

  /** 取数失败/部分失败/降级/盘中价——这些都要说，但**不要每次都弹一堆**。
   *  正常情况（都取到了）返回空数组，不显示那个面板。 */
  function noticeText(j) {
    var msgs = [];
    if (j.stale) {
      /* 降级：本次没取到，显示的是盘上最后一次成功的那份。
         这种情况**必须排在最前面且说清时间** —— 否则用户拿着几小时前的价格当现在的看，
         而页面上一切正常（图有、数字有、配色也对）。 */
      msgs.push("本次取数失败，下面是 " + (j.generatedAt || "（未知时间）") +
        " 缓存的行情（不是最新的）。原因：" + ((j.errors || []).join("；") || j.message || "未知") +
        "。可点右上角「立即刷新」再试一次。");
    } else if (j.errors && j.errors.length) {
      msgs.push("有 " + j.errors.length + " 只标的没取到：" + j.errors.join("；") +
        "。其余标的照常显示，可点右上角「立即刷新」再试一次。");
    }
    if (j.ok && j.items && j.items.length) {
      msgs.push("价格与涨跌幅一律按「前复权」计算（除权跳空不进涨跌幅）；" +
        "最后一根可能是当日盘中价 —— 该品种当天还没收盘。");
    }
    return msgs;
  }

  function shellNotice(msgs, isErr) {
    if (typeof msgs === "string") msgs = [msgs];
    if (!msgs || !msgs.length) {
      var el0 = $("notice");
      if (el0) { el0.style.display = "none"; }
      return;
    }
    var el = $("notice");
    if (!el) return;
    el.style.display = "";
    el.className = "panel" + (isErr ? " err" : " warn");
    el.innerHTML = msgs.map(U.esc).join("<br>");
  }

  /** 页头徽章：**只有「取数时间」**。
   *
   *  2026-10-08 按用户要求精简（原来还有「数据截止」与市场状态，见 shell.js 的 renderHeader）。
   *  顺带说明：读元素的写法一律是 `var el = $("x"); if (el) el.textContent = ...`，
   *  元素被删掉时**不能**直接 `$("x").textContent = ...` —— $() 返回 null，
   *  赋属性当场抛 TypeError，后面整段都跑不到。
   */
  function paintHeaderBadges() {
    var j = S.payload || {};
    var b = $("duTime");
    // 只截字符串，不要 new Date() 再格式化 —— 这个字段不带时区标记，见 shell.js 同一处说明
    if (b) {
      b.textContent = (j.generatedAt ? String(j.generatedAt).slice(0, 16) : "—") +
        (j.stale ? "（缓存）" : "");
    }
  }

  // ------------------------------------------------------------ 面板骨架（只建一次）

  function renderPanel() {
    var host = $("dualityHost");
    if (!host) return;

    if (!S.items.length) {
      host.innerHTML = '<div class="empty">' +
        U.esc((S.payload && S.payload.message) || "没有取到任何标的的数据。") + "</div>";
      return;
    }

    if (host.getAttribute("data-built") !== "1") {
      host.setAttribute("data-built", "1");
      host.innerHTML =
        '<div class="dp-bar">' +
          '<div class="dp-ranges" id="dpRange"></div>' +
          '<div class="dp-custom" id="dpCustom">' +
            '<label>从 <input type="date" id="dpStart"></label>' +
            '<label>到 <input type="date" id="dpEnd"></label>' +
          "</div>" +
        "</div>" +
        '<div class="dp-picks" id="dpPicks"></div>' +
        '<div class="panel dp-chartbox">' +
          '<h2 class="sec">区间走势对比 <span class="sec-n" id="dpChartMeta"></span></h2>' +
          /* 交易日太少的提醒。2026-10-08（国庆后第一个交易日）实测踩到的：
             「过去 7 天」里 A 股只有 10-08 一天有数据，三条金矿股在图上各是一个孤点。
             这不是 bug，但读者只会看到"线呢？"—— 所以要把原因和出路写在图上。 */
          '<div class="dp-warn" id="dpWarn" style="display:none"></div>' +
          '<div class="dp-chart" id="dpChart"></div>' +
          '<div class="dp-tip" id="dpTip"></div>' +
          '<p class="dp-note" id="dpNote"></p>' +
        "</div>" +
        '<div class="panel">' +
          '<h2 class="sec">区间数据 <span class="sec-n" id="dpTableMeta"></span></h2>' +
          '<div id="dpTable"></div>' +
        "</div>";
      bindPanel();
    }
    paint();
  }

  function bindPanel() {
    // 范围 chip：事件委托，chips 每次 paint 都会重写 innerHTML
    $("dpRange").addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest(".tab") : null;
      if (!t) return;
      S.range = t.getAttribute("data-k");
      paint();
    });

    ["dpStart", "dpEnd"].forEach(function (id) {
      $(id).addEventListener("change", function () {
        var v = this.value;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
        S.custom[id === "dpStart" ? "start" : "end"] = v;
        // 起止颠倒时自动纠正，而不是弹一句"开始日期不能晚于结束日期"。
        normalizeCustom();
        paint();
      });
    });

    $("dpPicks").addEventListener("change", function (e) {
      var cb = e.target;
      if (!cb || cb.type !== "checkbox") return;
      S.picked[cb.getAttribute("data-k")] = cb.checked;
      paint();
    });
  }

  /** 页头那个「立即刷新」的绑定（id = duRefresh，由 shell.js 的 renderHeader 渲染）。
   *
   *  为什么不放在 bindPanel 里：**页头不是面板的一部分** —— 面板是首次渲染时建的
   *  （`data-built` 那把锁），而页头在 Shell.mount 里就已经画好了。更关键的是一旦
   *  日后面板重建（renderPanel 会重写 host.innerHTML），面板里的绑定会跟着重绑，
   *  而页头元素自始至终没被重建过，绑在它身上的监听器必须**只挂一次**，
   *  否则点一下触发两次、两次 force=1 并发打向外部源（东财对密集请求是直接掐连接的）。
   *
   *  ⚠️ 时序：必须在 `Shell.mount(...)` **之后**调用 —— 页头 DOM 是那一步渲染的，
   *  提前调用时 `$("duRefresh")` 返回 null，addEventListener 当场抛 TypeError。
   *  （同一类坑本项目栽过三次：删按钮忘删绑定、挂不存在的 btnRefresh。）
   */
  function bindHeaderRefresh() {
    var b = $("duRefresh");
    if (!b) return;                    // 页头没渲染出来（不该发生）就别硬挂
    b.addEventListener("click", function () {
      if (S.busy) return;              // 并发保护：取数中重复点直接忽略
      load(true);                      // force=1，穿透服务端 30 分钟缓存
    });
  }

  /** 页头按钮的加载态。取数进行中禁用 + 换文案，取完复位。
   *
   *  为什么必须有这一步：一轮取数是 6 只标的并发走源链（含重试与退避），
   *  最坏情况要十几秒。按钮不置灰的话，用户会以为没反应而反复点，
   *  每一次都是一轮完整的外部请求 —— 那正好是最容易被源限流的打法。 */
  function paintHeaderRefresh(busy) {
    var b = $("duRefresh");
    if (!b) return;
    b.disabled = !!busy;
    b.textContent = busy ? "刷新中…" : "立即刷新";
  }

  // ------------------------------------------------------------ 画

  function paint() {
    // 区间计算**只做一次**，三处共用 —— 勾选卡、图、表各算一遍的话，
    // 万一哪天改了口径只改了其中一处，页面上就会出现"卡片说 +3%、表格说 +3.2%"。
    var c = compute();
    paintRanges();
    paintPicks(c);
    paintChart(c);
    paintTable(c);
  }

  /** 自定义起止**颠倒时自动对调**，而不是弹一句"开始日期不能晚于结束日期"。
   *
   *  抽成独立函数是为了能被用例直接调：它原本写在日期框的 change 回调里，
   *  只有真的在浏览器里把日期选反一次才会执行到 —— 属于"改坏了也没人知道"的那一类。
   *  对调用方来说，纠正总比报错好：日期选反太常见，多一次弹窗就多一步操作。 */
  function normalizeCustom() {
    if (dayNum(S.custom.start) > dayNum(S.custom.end)) {
      var t = S.custom.start;
      S.custom.start = S.custom.end;
      S.custom.end = t;
    }
  }

  /** 当前生效的区间 [start, end]（"YYYY-MM-DD"）。 */
  function bounds() {
    var today = todayStr();
    var r = S.range;
    if (r === "custom") {
      var st = S.custom.start || shiftDays(today, -29);
      var en = S.custom.end || today;
      return { start: st, end: en };
    }
    if (r === "ytd") return { start: today.slice(0, 4) + "-01-01", end: today };
    var n = parseInt(r, 10);
    if (!isFinite(n) || n < 1) n = 7;
    return { start: shiftDays(today, -(n - 1)), end: today };
  }

  function paintRanges() {
    var host = $("dpRange");
    if (!host) return;
    host.innerHTML = RANGES.map(function (r) {
      return '<button class="tab' + (r.key === S.range ? " on" : "") +
        '" data-k="' + r.key + '">' + U.esc(r.label) + "</button>";
    }).join("");

    var cus = $("dpCustom");
    if (cus) cus.style.display = S.range === "custom" ? "" : "none";
    var si = $("dpStart"), ei = $("dpEnd");
    if (si) si.value = S.custom.start || "";
    if (ei) ei.value = S.custom.end || "";
  }

  /** 标的勾选卡。它同时充当图例 —— 色点、名称、最新价、**区间涨跌幅**都在这里，
   *  所以图上不再单独画一套图例（两张表说同一件事，读者还得自己对色）。
   *  代价是勾选状态一变这四个数字要跟着重算，见 paintPicks 里对 compute() 的复用。 */
  function paintPicks(c) {
    var host = $("dpPicks");
    if (!host) return;
    c = c || compute();

    host.innerHTML = groupItems().map(function (it, i) {
      var col = colorOf(it.key, i);
      var on = !!S.picked[it.key];
      /* 图例的标记用**小线段**而不是圆点：图上期货是虚线、股票是实线，
         图例里若还是一个圆点，线型这件事就只存在于图上，看的人得自己回图里猜。
         虚线段用 repeating-linear-gradient 拼（实心色块当"实线"）——
         比 border-style:dashed 可控，段长与间隙都是能写死的数。 */
      var swatch = it.kind === "future"
        ? "background:repeating-linear-gradient(90deg," + col + " 0 5px,rgba(0,0,0,0) 5px 9px)"
        : "background:" + col;
      // 最新价 = 全量最后一根（与区间无关）；区间涨跌幅来自当前区间
      var last = it.closes && it.closes.length ? it.closes[it.closes.length - 1] : null;
      var ser = c.byKey[it.key];
      var rp = ser && ser.pts.length ? ser.pts[ser.pts.length - 1].pct : null;
      return '<label class="dp-pick' + (on ? "" : " off") + '">' +
        '<input type="checkbox" data-k="' + U.esc(it.key) + '"' + (on ? " checked" : "") + ">" +
        '<span class="dp-key" style="' + swatch + '"></span>' +
        '<span class="dp-pick-n">' + U.esc(it.name) + "</span>" +
        '<span class="dp-pick-p">' + fmtPrice(last, it.kind) + " " + U.esc(it.unit) + "</span>" +
        '<span class="dp-pick-c chg ' + dirClass(rp) + '">' + fmtPct(rp) + "</span>" +
        "</label>";
    }).join("");
  }

  // ------------------------------------------------------------ 区间计算

  /** 把每只标的裁到当前区间，并算出相对基准的涨跌幅。**唯一的口径来源** ——
      图、勾选卡、表格三处都吃这一份结果，免得三处各算一遍、算法悄悄漂移。
      **只算当前分组**（groupItems()），另一组的标的连区间涨跌幅都不算 ——
      它不该出现在这一组的图上、表上、也不该参与纵轴范围。 */
  function compute() {
    var b = bounds();
    var out = { bounds: b, list: [], byKey: {}, lo: 0, hi: 0, anyPts: false };

    groupItems().forEach(function (it, i) {
      var ser = {
        it: it, color: colorOf(it.key, i), pts: [],
        last: it.closes.length ? it.closes[it.closes.length - 1] : null,
        lastDate: it.dates.length ? it.dates[it.dates.length - 1] : ""
      };
      out.byKey[it.key] = ser;

      var idx = [];
      for (var j = 0; j < it.dates.length; j++) {
        if (it.dates[j] >= b.start && it.dates[j] <= b.end) idx.push(j);
      }

      /* 基准：区间开始**之前**的最后一个交易日。这样同一组里各条线的 0% 都落在
         同一个交易日上，起点可比。找不到（区间早于全部数据）就退化为区间内第一根。 */
      var bi = -1;
      for (var k = idx.length ? idx[0] - 1 : it.dates.length - 1; k >= 0; k--) {
        if (it.dates[k] < b.start) { bi = k; break; }
      }
      var base = bi >= 0 ? it.closes[bi] : (idx.length ? it.closes[idx[0]] : null);
      ser.baseIdx = bi;
      ser.baseDate = bi >= 0 ? it.dates[bi] : (idx.length ? it.dates[idx[0]] : "");

      if (base) {
        var hi = null, lo = null, hiP = null, loP = null;
        for (var m = 0; m < idx.length; m++) {
          var j2 = idx[m];
          var pct = (it.closes[j2] / base - 1) * 100;
          ser.pts.push({ d: it.dates[j2], c: it.closes[j2], chg: it.chgs[j2], pct: pct, idx: j2 });
          if (hi === null || it.closes[j2] > hi) { hi = it.closes[j2]; hiP = pct; }
          if (lo === null || it.closes[j2] < lo) { lo = it.closes[j2]; loP = pct; }
        }
        ser.hi = hi; ser.lo = lo; ser.hiPct = hiP; ser.loPct = loP;
        ser.rangePct = ser.pts.length ? ser.pts[ser.pts.length - 1].pct : null;
      }

      /* **没勾选的标的也算完整**（区间涨跌幅、最高最低都有），只是不进图 ——
         勾选卡上那四个数字要一直看得到，取消勾选后变成"—"会让人以为数据没了。 */
      if (!S.picked[it.key]) return;

      if (ser.pts.length) {
        out.anyPts = true;
        for (var n2 = 0; n2 < ser.pts.length; n2++) {
          if (ser.pts[n2].pct > out.hi) out.hi = ser.pts[n2].pct;
          if (ser.pts[n2].pct < out.lo) out.lo = ser.pts[n2].pct;
        }
      }
      out.list.push(ser);
    });
    return out;
  }

  /** 区间内有几个交易日（取各标的里的最大值 —— 美股/期货与 A 股假期不同，
      这个数字只是让人知道"线为什么这么短"，不做精确对齐）。 */
  function maxPts(c) {
    var n = 0;
    c.list.forEach(function (s) { if (s.pts.length > n) n = s.pts.length; });
    return n;
  }

  // ------------------------------------------------------------ 折线图

  function niceScale(lo, hi, ticks) {
    if (!isFinite(lo) || !isFinite(hi)) { lo = -1; hi = 1; }
    if (hi - lo < 1e-9) { lo -= 0.5; hi += 0.5; }
    // 上下各留 8% 余量，最高/最低点不贴边（贴边的点会被坐标轴压掉一半）
    var pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;
    var raw = (hi - lo) / ticks;
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step: step };
  }

  function paintChart(c) {
    var host = $("dpChart");
    if (!host) return;
    c = c || compute();
    var b = c.bounds;

    var W = Math.max(360, host.clientWidth || 880);
    var H = CHART_H;
    var pw = W - PAD.l - PAD.r;
    var ph = H - PAD.t - PAD.b;

    // 区间跨度（天）。跨度为 0（起止同一天）时强制按 1 天画，避免除零
    var d0 = dayNum(b.start), d1 = dayNum(b.end);
    var span = Math.max(1, d1 - d0);

    var meta = $("dpChartMeta");
    var nPts = maxPts(c);
    if (meta) {
      meta.textContent = b.start + " ~ " + b.end +
        "（" + (d1 - d0 + 1) + " 个自然日 · 区间内最多 " + nPts + " 个交易日）";
    }

    /* 有标的在区间里凑不出两个点（长假是唯一常见原因）→ 直说，并给出出路。
       注意只在**勾选了**的标的里找：没勾的本来就不进图，不该为它弹提示。 */
    var warn = $("dpWarn");
    if (warn) {
      var thin = c.list.filter(function (s) { return s.pts.length < 2; });
      if (thin.length) {
        var few = Math.min.apply(null, thin.map(function (s) { return s.pts.length; }));
        warn.style.display = "";
        warn.textContent = "「" + thin.map(function (s) { return s.it.name; }).join("、") +
          "」在所选区间内" + (few ? "只有 " + few + " 个交易日" : "没有交易日") +
          "（该市场休市），图上" + (few ? "只能画成一个点" : "什么都画不出来") +
          "。把时间范围放宽（如「过去 30 天」或更长）即可看到完整走势。";
      } else {
        warn.style.display = "none";
        warn.textContent = "";
      }
    }

    var note = $("dpNote");
    if (note) {
      var baseTxt = "";
      for (var q = 0; q < c.list.length; q++) {
        if (c.list[q].baseDate) { baseTxt = c.list[q].baseDate; break; }
      }
      /* 品种名按当前分组取（"纽约金" / "纽约银"），**不要写死** ——
         切到银、铜组后那句"纽约金与金矿股量纲不同"就成了一句错话，
         而它读起来毫无破绽，没有人会去核对面。 */
      note.textContent = "纵轴是相对基准的涨跌幅（%），不是绝对价格 —— " +
        futureName() + "与股价量纲不同，只有归一化后才能同图比较。" +
        "0% 取「区间开始前最后一个交易日」的收盘价（" + (baseTxt || "—") + "）；" +
        "价格均已前复权。折线在缺口处直接相连（中美假期不同），未做补点。";
    }

    if (!c.anyPts) {
      /* 三种"图是空的"，原因完全不同，说错了会把人引到错的方向：
         ① 当前分组一只标的都没有（后端没取到，或服务是旧代码）；
         ② 有标的但全被取消勾选；
         ③ 勾了，但所选区间内确实没有交易日。 */
      var empty = !groupItems().length
        ? "「" + groupLabel() + "」这一组没有可用标的 —— 本次可能没取到，可点右上角「立即刷新」再试。"
        : (c.list.length ? "" : "上面没有勾选任何标的。") +
          "所选区间内没有可用数据 —— 请换一个时间范围" +
          (S.range === "7" ? "（长假期间 7 个自然日里可能只有一两个交易日）" : "") + "。";
      host.innerHTML = '<div class="dp-empty">' + U.esc(empty) + "</div>";
      var g0 = $("dpHoverG");
      if (g0) g0.innerHTML = "";
      return;
    }

    var sc = niceScale(c.lo, c.hi, 5);
    var yOf = function (pct) {
      return PAD.t + ph - (pct - sc.lo) / (sc.hi - sc.lo) * ph;
    };
    var xOf = function (d) {
      return PAD.l + (dayNum(d) - d0) / span * pw;
    };

    var parts = [];

    // --- 网格与 Y 轴刻度。用**整数计数**推进，不要 `v += step` ——
    //     step 常常是 0.5 / 0.2 这类二进制除不尽的数，累加到最后一条刻度
    //     会差之毫厘（比如 +3.0000000000000004%）。
    var step = sc.step;
    var dec = step >= 1 ? 0 : (step >= 0.1 ? 1 : 2);
    var nTick = Math.round((sc.hi - sc.lo) / step);
    for (var ti = 0; ti <= nTick; ti++) {
      var v = sc.lo + ti * step;
      var y = yOf(v);
      var isZero = Math.abs(v) < step / 1000;
      parts.push('<line x1="' + PAD.l + '" y1="' + y.toFixed(1) + '" x2="' + (W - PAD.r) +
        '" y2="' + y.toFixed(1) + '" stroke="' + (isZero ? "#c3ccd6" : "#eef1f5") +
        '" stroke-width="1"' + (isZero ? ' stroke-dasharray="4 3"' : "") + "/>");
      parts.push('<text x="' + (PAD.l - 9) + '" y="' + (y + 4).toFixed(1) +
        '" text-anchor="end" class="dp-ax"' +
        (isZero ? ' font-weight="600"' : "") + ">" +
        (v > 0 ? "+" : "") + v.toFixed(dec) + "%</text>");
    }

    // --- X 轴刻度：按跨度取 5~7 个，落在整日期上
    var xTicks = 6;
    for (var t = 0; t <= xTicks; t++) {
      var day = d0 + Math.round(span * t / xTicks);
      var ds = new Date(day * 86400000).toISOString().slice(0, 10);
      var x = xOf(ds);
      parts.push('<line x1="' + x.toFixed(1) + '" y1="' + PAD.t + '" x2="' + x.toFixed(1) +
        '" y2="' + (PAD.t + ph) + '" stroke="#f4f6f9" stroke-width="1"/>');
      parts.push('<text x="' + x.toFixed(1) + '" y="' + (PAD.t + ph + 21) +
        '" text-anchor="middle" class="dp-ax">' + fmtMD(ds) + "</text>");
    }

    // --- 序列
    c.list.forEach(function (s) {
      if (!s.pts.length) return;
      /* data-k 是悬停时"认出这条线是谁"的唯一抓手：折线是字符串拼出来的，
         没有别的东西能把一条 polyline 和一只标的对应起来（见 bindHover）。 */
      var k = ' data-k="' + U.esc(s.it.key) + '"';
      /* 期货画**虚线**（2026-10-08 用户要求）。它解决的不只是"哪条是期货"：
         这一页的两面本来就是**期货**和**股票**，而六条线里只有一条不是股票 ——
         用线型把这一面标出来，比再塞一套图例省地方，而且不依赖颜色（色盲也分得清）。
         关键是它**常驻**：悬停提示要动鼠标才看得到，线型一眼就在。 */
      var dash = s.it.kind === "future" ? ' stroke-dasharray="6 6"' : "";
      var pts = s.pts.map(function (p) {
        return xOf(p.d).toFixed(1) + "," + yOf(p.pct).toFixed(1);
      }).join(" ");
      // 单点画不出来（polyline 只有一个点等于不可见）→ 退化成一个小圆
      if (s.pts.length === 1) {
        var p0 = s.pts[0];
        parts.push('<circle class="dp-line"' + k + ' cx="' + xOf(p0.d).toFixed(1) +
          '" cy="' + yOf(p0.pct).toFixed(1) + '" r="3.5" fill="' + s.color + '"/>');
      } else {
        parts.push('<polyline class="dp-line"' + k + ' points="' + pts + '" fill="none" stroke="' +
          s.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"' + dash + "/>");
      }
      // 末点加实心圆：一眼看到"这条线现在到哪"
      var pe = s.pts[s.pts.length - 1];
      parts.push('<circle class="dp-cap"' + k + ' cx="' + xOf(pe.d).toFixed(1) +
        '" cy="' + yOf(pe.pct).toFixed(1) + '" r="3.2" fill="' + s.color + '"/>');
    });

    // --- 悬停层（竖线 + 高亮点），由 onMove 填
    parts.push('<g id="dpHoverG"></g>');
    // 透明的捕获层放最后 → 它在最上层，鼠标事件不会被折线抢走
    parts.push('<rect id="dpHit" x="' + PAD.l + '" y="' + PAD.t + '" width="' + pw +
      '" height="' + ph + '" fill="transparent" style="cursor:crosshair"/>');

    host.innerHTML = '<svg class="dp-svg" width="' + W + '" height="' + H +
      '" viewBox="0 0 ' + W + " " + H + '">' + parts.join("") + "</svg>";

    bindHover(c, W, ph, xOf, yOf, d0, span);
  }

  /** 悬停：竖线跟着鼠标，提示框列出各标的在**该日期或之前最近一个交易日**的价格与涨跌幅。
   *
   *  两条线索帮人认出"我指着的这条线是谁"（2026-10-08 加到六只标的之后，
   *  光靠提示框里的色点去反查已经不好使了）：
   *    · **线吸附** —— 鼠标纵向 `LINE_SNAP` 像素内最近的那条线加粗、其余压暗；
   *    · **提示框** —— 被吸附的那一行**置顶**并加底色，其余行照常列出（对比信息不能丢）。
   *  鼠标离所有线都远时（大片空白处）不吸附，就是一张全表 —— 加吸附之前本来也是这样。
   *
   *  为什么每行要带自己的日期：中美假期不同，鼠标停的那天可能某只根本没有数据；
   *  显示前一个交易日的值比显示空白好 —— 但那样各行的日期就不一样了，得标出来，
   *  否则会让人以为图上那个点就是当天的。 */
  function bindHover(c, W, ph, xOf, yOf, d0, span) {
    var svg = $("dpHit");
    var g = $("dpHoverG");
    var tip = $("dpTip");
    var host = $("dpChart");
    if (!svg || !g || !tip || !host) return;

    var innerW = W - PAD.l - PAD.r;
    var curKey = null;                       //: 当前被吸附的标的 key；用来免掉每帧重复刷属性

    /** 把非吸附的线压暗、吸附的那条加粗；key 为 null 时全部复原。
     *  只能逐元素改属性，不能用 CSS：折线是字符串拼进 innerHTML 的，
     *  没有可供样式钩子命中的 class，而 SVG 子元素也不继承父级的 opacity。 */
    function emphasize(key) {
      if (key === curKey) return;
      curKey = key;
      var nodes = host.querySelectorAll("[data-k]");
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var on = !!key && el.getAttribute("data-k") === key;
        el.setAttribute("opacity", key ? (on ? "1" : "0.15") : "1");
        // 只有折线值得加粗；末点/单点是小圆，本来就是小色块
        if (el.tagName === "polyline") el.setAttribute("stroke-width", on ? "3.4" : "2");
      }
    }

    function at(ev) {
      var rect = host.getBoundingClientRect();
      /* 容器比 SVG 窄时（`.dp-svg` 有 max-width:100%）整幅图被等比缩小，
         鼠标坐标要先折回 SVG 内部坐标，否则窄窗口上竖线会整体偏移。 */
      var kx = rect.width ? W / rect.width : 1;
      var ky = rect.height ? (PAD.t + ph + PAD.b) / rect.height : 1;
      var x = (ev.clientX - rect.left) * kx;
      var y = (ev.clientY - rect.top) * ky;
      if (x < PAD.l - 6 || x > W - PAD.r + 6) return null;
      var day = d0 + Math.round((x - PAD.l) / innerW * span);
      var ds = new Date(day * 86400000).toISOString().slice(0, 10);
      var rows = [], xs = [];
      c.list.forEach(function (s) {
        var pick = null;
        for (var i = s.pts.length - 1; i >= 0; i--) {
          if (s.pts[i].d <= ds) { pick = s.pts[i]; break; }
        }
        if (!pick) return;
        rows.push({ s: s, p: pick });
        xs.push(xOf(pick.d));
      });
      if (!rows.length) return null;

      /* 横向已经由竖线吸到日期格上了，纵向再吸到最近的那条线 ——
         两者合起来就是"鼠标指着这一条线上的这一个点"。 */
      var near = null, best = LINE_SNAP;
      rows.forEach(function (r) {
        var dy = Math.abs(yOf(r.p.pct) - y);
        if (dy <= best) { best = dy; near = r; }
      });

      return { ds: ds, rows: rows, xs: xs, near: near };
    }

    function move(ev) {
      var hit = at(ev);
      if (!hit) { leave(); return; }
      var nearKey = hit.near ? hit.near.s.it.key : null;
      emphasize(nearKey);

      var xa = xOf(hit.ds);
      var gs = ['<line x1="' + xa.toFixed(1) + '" y1="' + PAD.t + '" x2="' + xa.toFixed(1) +
        '" y2="' + (PAD.t + ph) + '" stroke="#9aa4b1" stroke-width="1" stroke-dasharray="3 3"/>'];
      hit.rows.forEach(function (r) {
        var on = nearKey && r.s.it.key === nearKey;
        gs.push('<circle cx="' + xOf(r.p.d).toFixed(1) + '" cy="' + yOf(r.p.pct).toFixed(1) +
          '" r="' + (on ? "5.5" : "4.5") + '" fill="#fff" stroke="' + r.s.color +
          '" stroke-width="' + (on ? "2.5" : "2") + '"/>');
      });
      /* 在吸附点旁**直接写出这是谁**。提示框里虽然也有名称，但名称只是六行里的一行，
         眼睛得先在那儿找到它；标签贴在线本身上，视线不用离开图。
         只有一个字：名字。价格和涨跌幅留给提示框 —— 那才是需要比对的数字，
         挤到线上会盖住线、也会盖住别的线的点。
         右侧放不下就翻到左边（text-anchor 换 end），免得贴着图右缘被裁掉。 */
      if (hit.near) {
        var np = hit.near.p;
        var nx = xOf(np.d), ny = yOf(np.pct);
        var roomRight = nx < W - PAD.r - 76;
        gs.push('<text class="dp-tag" x="' + (roomRight ? nx + 10 : nx - 10).toFixed(1) +
          '" y="' + Math.max(PAD.t + 12, ny - 11).toFixed(1) + '"' +
          (roomRight ? "" : ' text-anchor="end"') +
          ' fill="' + hit.near.s.color + '">' + U.esc(hit.near.s.it.name) + "</text>");
      }

      g.innerHTML = gs.join("");

      /* 吸附的那行置顶 —— 鼠标指着哪条，那一行的名字就永远在第一行。
         `sort` 是稳定的（ES2019 起），所以其余行保持原顺序不乱跳。 */
      var rows = hit.rows.slice();
      if (nearKey) {
        rows.sort(function (a, b) {
          return (a.s.it.key === nearKey ? 0 : 1) - (b.s.it.key === nearKey ? 0 : 1);
        });
      }

      tip.innerHTML = '<div class="dp-tip-d">' + U.esc(fmtMDCN(hit.ds)) + "</div>" +
        rows.map(function (r) {
          var on = nearKey && r.s.it.key === nearKey;
          /* 行日期 ≠ 标题日期 = 这只标的当天休市，用的是更早一个交易日的数据 */
          var own = r.p.d !== hit.ds
            ? '<span class="dp-tip-when">' + U.esc(fmtMD(r.p.d)) + "</span>" : "";
          return '<div class="dp-tip-r' + (on ? " dp-tip-r--on" : "") + '">' +
            '<span class="dp-dot" style="background:' + r.s.color + '"></span>' +
            '<span class="dp-tip-n">' + U.esc(r.s.it.name) + own +
              '<span class="dp-tip-c">' + U.esc(secOf(r.s.it)) + "</span></span>" +
            '<span class="dp-tip-v">' + fmtPrice(r.p.c, r.s.it.kind) + "</span>" +
            '<span class="dp-tip-p chg ' + dirClass(r.p.pct) + '">' + fmtPct(r.p.pct) + "</span>" +
            "</div>";
        }).join("");
      /* 显示要写 "block"，**不能写 ""**。这里踩过一个极隐蔽的坑：
         `.dp-tip` 的 CSS 初始态就是 `display:none`，把 inline 值清成 `""`
         等于"交回给 CSS 决定"，于是又变回 none。
         症状：内容算得完全正确、DOM 里一应俱全，**就是永远看不见**；
         而所有基于 DOM 桩的用例照样全绿 —— 桩不实现 CSS 层叠。
         2026-10-08 用真实 Chrome 发鼠标事件才逮到（computed display = none）。
         判断依据是真实像素，不是元素存不存在。 */
      tip.style.display = "block";

      // 提示框贴着鼠标走；靠近右边界时翻到左侧，免得被容器裁掉
      var rect = host.getBoundingClientRect();
      var left = (ev.clientX - rect.left) + 16;
      if (left + tip.offsetWidth > rect.width - 4) left = (ev.clientX - rect.left) - tip.offsetWidth - 16;
      tip.style.left = Math.max(4, left) + "px";
      tip.style.top = Math.max(4, Math.min(rect.height - tip.offsetHeight - 4,
        (ev.clientY - rect.top) - 10)) + "px";
    }

    function leave() {
      g.innerHTML = "";
      emphasize(null);
      tip.style.display = "none";
    }

    svg.addEventListener("mousemove", move);
    svg.addEventListener("mouseleave", leave);
  }

  // ------------------------------------------------------------ 区间数据表

  /** 这张表**只按总市值从大到小排**（用户 2026-10-08 的要求）。
   *
   *  刻意**不动**图与勾选卡的顺序：那两处按 duality.py 的 INSTRUMENTS 顺序，
   *  是"先期货、后上游矿端→下游零售"的固定读法，跟着市值重排会让人以为
   *  连图的语义也变了。所以表里必须**把市值这一列标出来**，否则会以为顺序乱了。
   *
   *  没市值的（纽约金是期货，或市值取数失败）**排在最后**。
   */
  function orderByCap(picked) {
    return picked.slice().sort(function (a, b) {
      var x = capOf(a.it), y = capOf(b.it);
      if (x === null && y === null) return 0;   // 都是"没有市值" → 保持原序（sort 稳定）
      if (x === null) return 1;
      if (y === null) return -1;
      return y - x;                            // 从大到小
    });
  }

  function paintTable(c) {
    var host = $("dpTable");
    if (!host) return;
    c = c || compute();
    var b = c.bounds;

    var picked = c.list;
    var rows = orderByCap(picked);
    var meta = $("dpTableMeta");
    if (meta) {
      meta.textContent = b.start + " ~ " + b.end +
        // 一个市值都没取到时不要声称"按总市值降序"—— 那与实际行序不符
        (rows.some(function (s) { return capOf(s.it) !== null; })
          ? " · 按总市值从大到小" : "");
    }

    if (!picked.length) {
      host.innerHTML = '<div class="empty">' +
        (groupItems().length ? "上面没有勾选任何标的。"
                             : U.esc("「" + groupLabel() + "」这一组没有可用标的。")) +
        "</div>";
      return;
    }

    var body = rows.map(function (s) {
      var it = s.it;
      var lastPct = it.chgs && it.chgs.length ? it.chgs[it.chgs.length - 1] : null;
      if (!s.pts.length) {
        return "<tr>" +
          '<td><span class="dp-dot" style="background:' + s.color + '"></span>' +
            U.esc(it.name) + "</td>" +
          '<td class="dp-sub">' + U.esc(it.note || it.market || "") + "</td>" +
          '<td class="num">—</td><td class="num">' + fmtCap(it.marketCap) + "</td>" +
          '<td class="num">—</td><td class="num">—</td>' +
          '<td class="num">—</td><td class="num">—</td><td class="num">0</td></tr>';
      }
      return "<tr>" +
        '<td><span class="dp-dot" style="background:' + s.color + '"></span>' +
          U.esc(it.name) + "</td>" +
        '<td class="dp-sub">' + U.esc(it.note || it.market || "") + "</td>" +
        '<td class="num">' + fmtPrice(s.last, it.kind) +
          ' <span class="dp-sub">' + U.esc(it.unit) + "</span></td>" +
        '<td class="num">' + fmtCap(it.marketCap) + "</td>" +
        '<td class="num"><span class="chg ' + dirClass(lastPct) + '">' + fmtPct(lastPct) + "</span></td>" +
        '<td class="num"><span class="chg ' + dirClass(s.rangePct) + '">' + fmtPct(s.rangePct) + "</span></td>" +
        '<td class="num">' + fmtPrice(s.hi, it.kind) + "</td>" +
        '<td class="num">' + fmtPrice(s.lo, it.kind) + "</td>" +
        '<td class="num">' + s.pts.length + "</td>" +
        "</tr>";
    }).join("");

    host.innerHTML = '<div class="tblwrap"><table class="t-dual"><thead><tr>' +
      "<th>标的</th><th>说明</th>" +
      '<th class="num">最新价</th>' +
      '<th class="num">总市值</th>' +
      '<th class="num">最新单日</th>' +
      '<th class="num">区间涨跌幅</th>' +
      '<th class="num">区间最高</th>' +
      '<th class="num">区间最低</th>' +
      '<th class="num">区间交易日</th>' +
      "</tr></thead><tbody>" + body + "</tbody></table></div>" +
      (picked.some(function (s) { return !s.pts.length; })
        ? '<p class="dp-note">有标的在当前区间内没有任何交易日（可能是长假）—— ' +
          "它不会出现在图上，换一个时间范围即可。</p>" : "") +
      // 期货本来就没有市值；市值取数也偶有失败。这一列出现"—"时要说清是哪种，
      // 否则读者会以为"纽约金的市值漏取了"。（品种名同样按分组取，不写死。）
      (rows.some(function (s) { return capOf(s.it) === null; })
        ? '<p class="dp-note">总市值一列：' + U.esc(futureName()) + "是期货，没有市值；" +
          "若 A 股那几只也是「—」，是本次市值取数失败，点右上角「立即刷新」再试。</p>" : "");
  }

  // ------------------------------------------------------------ 启动

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  w.Duality = {
    state: S,
    compute: compute,
    bounds: bounds,
    normalizeCustom: normalizeCustom,
    //: 分组相关也导出：用例要能直接问"这一组是哪几只"，而不是去 DOM 里数
    groups: groupTabs,
    groupItems: groupItems,
    futureName: futureName,
    SCHEMA: DUALITY_SCHEMA
  };
})(window);
