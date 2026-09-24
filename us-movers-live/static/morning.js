/* 早盘总结 —— 渲染每天 06:30 由 us-stock-daily-review 生成的复盘数据。
 *
 * 数据来源：GET /api/morning（服务端只读 data/morning.json，不抓行情）。
 * 页面本身**不做任何抓取**，所以 shell 以 mode:"daily" 挂载，不轮询。
 *
 * 数据结构见 us-movers-live/MORNING.md。所有字段都按"可能缺失"处理：
 * 缺就不渲染那一块，绝不让整页因为一个空数组而挂掉。
 *
 * 排版取向：**列表类内容与「夜盘异动」共用同一套组件，其余用卡片流。**
 * 两页是同一个产品的两个视图，列表若各做一套，读者要重新学一遍怎么读。
 * 所以「个股异动榜」直接用 .tblwrap + table（等宽代码列、数字右对齐、吸顶表头、
 * .band 状态药丸），与夜盘异动完全一致；差异只在列 —— 那边是 Finviz 的板块/行业/国家，
 * 这边是业务标签 + 驱动原因。
 * 而「个人关注池」是数量多、每项字段少的内容，用自适应方块网格比表格好读，故保留卡片。
 *
 * 分三个标签页（2026-09-22 按用户要求）：
 *   「总览」大盘表现 → 主线归纳 → 关联性深度分析 → A 股联动提示
 *   「个股」个股异动榜
 *   「关注」个人关注池
 * 分栏依据是**读法不同**：总览是读结论（今天什么风格、哪条主线、对应 A 股哪条线），
 * 个股是查行情（谁涨了、涨多少、什么原因），关注是看自己攒的那份固定清单。
 * 三者互不搭界，混在一页里读者要不停在几套读法之间切换。
 * 「关注」原先跟异动榜同挤在「个股」页（2026-09-22 按用户要求挪出来单独成页）：
 * 池子里大半是**没涨甚至下跌**的票，跟异动榜放一起会被读成"当日异动的一部分"，
 * 而它其实跟今天涨了什么毫无关系。
 * 标签之外原本还有一条页脚（数据来源 / 生成方式 / 剔除说明），
 * 已于 2026-09-22 按用户要求去掉。
 * 切换用 hidden 属性显隐，不重渲染 —— 数据是静态 JSON，重建 DOM 只会丢滚动位置。
 * **选中的是哪一页会记在 localStorage 里**（见 TAB_STORE），
 * 切到「夜盘异动」再切回来时还停在原处，不会被重置回「总览」。
 *
 * 两张表的排序（2026-09-22 按用户要求）：
 *   个股异动榜 = 涨跌幅降序；个人关注池 = 股票代码字母序。见下面「排序」一节。
 * 注意排序**不能只放在生成脚本里**：morning.json 每天 06:30 才更新，
 * 页面读到的可能还是旧顺序那份，所以渲染层自己也排一遍。
 *
 * 「个股异动榜」带筛选（2026-09-22 按用户要求）：**分档 chip（所有 / 大市值 / 小市值）
 * + 搜索框 + 板块/行业两个带模糊搜索的下拉**，规则与控件与「夜盘异动」同一套
 * （见下面 filterRows / 筛选一节）。
 * 分档的边界值**不写在前端**，从 /api/status 的 criteriaValues 取（源头是 screening.py 的 CFG）——
 * 与夜盘异动页共用同一组「大市值 / 小市值」定义，同一个词在两页是同一个意思。
 * 工具条放在**面板内部**（标题下方）——它是这张榜的筛选器，摆在面板外会被读成"筛整页"。
 * （原先「个股」页里还有「个人关注池」，这条理由更强；2026-09-22 关注池挪去「关注」页后，
 *   面板内部依然是它的归属位置，不必挪。）
 * 分档 chip 排在最前、其余筛选跟在后面：先分档（粗），再细筛。
 *
 * 宽屏（≥1660px）：主区不限宽，**每个区块独占整行，靠区块内部横向铺开**。
 * 「并列的卡片组」在宽屏下内部改排 3 列 —— 主线归纳、关联性分析用 .cardgrid 包一层，
 * 大盘表现用 .idxrow，A 股提示用 .hints，关注池用 .tiles，都在 style.css 的宽屏一节里。
 * 表格与方块网格本来就是自适应的，不需要处理。
 *
 * 为什么不把区块两两并排（曾这么做过，已回退）：实测同一行的两块高度差可达 557px
 * （关联性分析 953px vs A 股联动 396px），短的那块下方会空出一大片，
 * 比单列更难看。数据见 .workbuddy/memory/2026-09-22.md。
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  /** 标签页定义。数组顺序即按钮顺序，key 同时决定面板 id（paneOverview / paneStocks / paneWatch）。
   *
   *  三页的分栏依据是**读法不同**，不是内容多少：
   *    「总览」读结论 —— 今天什么风格、哪条主线、对应 A 股哪条线，是纵向推理；
   *    「个股」查行情 —— 谁涨了、涨多少、什么原因，是横向比对；
   *    「关注」看自己的池子 —— 固定清单，天天同一批票，按代码找。
   *  三种读法互不搭界，混在一页里只会让人不停折返。
   *
   *  关注池 2026-09-22 从「个股」页挪出来单独成页（按用户要求）：它是**自己攒的清单**，
   *  和"今天市场涨了什么"没有关系 —— 池子里大半是没涨甚至下跌的票。
   *  跟异动榜挤在一页时，读者会以为那一块也是当日异动的一部分。 */
  var TABS = [
    { key: "overview", label: "总览" },
    { key: "stocks", label: "个股" },
    { key: "watch", label: "关注" }
  ];

  /* 标签页记忆（2026-09-22 按用户要求）：从「总览/个股/关注」切到夜盘异动、再切回早盘总结，
     应该还停在上次看的那一页，而不是被重置回「总览」。
     用 localStorage 而不是 URL hash —— 左侧菜单的链接指向 `/morning`（不带 hash），
     跨页跳转时 hash 根本不会跟过来，只有存储能"记得"。
     存的是 **key 而不是下标**：以后调整标签顺序也不会串页
     （2026-09-22 新增「关注」页时正是靠这一点，老用户的记忆值依然有效）。 */
  var TAB_STORE = "morning.tab";

  /* 关注池自定义增量（added / removed）的存储键。
     ⚠️ **必须声明在这里**，不能跟下面「关注池的自定义增删」那一节放一起 ——
     `var state = { wl: wlLoad() }` 在本文件靠前处就执行了，而 `var` 的赋值是按源码顺序走的：
     键名若写在 state 之后，wlLoad() 执行时读到的是 undefined，getItem(undefined) 永远返回 null，
     自定义清单**刷新一次就全部消失**（且不报任何错）。
     2026-09-22 踩过，由 tools/test_morning_watchlist.js 第 12 节抓住 ——
     那一节是唯一"必须真的从 localStorage 读回来"的用例，其余用例都在同一个会话里增删，
     内存里的 state 够用，所以全都看不出这个错。 */
  var WL_STORE = "morning.watchlist";

  /** 上次选中的标签；没存过、存的值已失效（如标签被改名）、或存储不可用（隐私模式）时
   *  一律回落到第一个标签 —— 取不到记忆不该让页面出问题。 */
  function savedTab() {
    try {
      var v = localStorage.getItem(TAB_STORE);
      for (var i = 0; i < TABS.length; i++) {
        if (TABS[i].key === v) return v;
      }
    } catch (e) { /* localStorage 被禁用：当作没有记忆 */ }
    return TABS[0].key;
  }

  function rememberTab(key) {
    try { localStorage.setItem(TAB_STORE, key); } catch (e) { /* 存不了就算了 */ }
  }

  var state = {
    tab: savedTab(), q: "", sector: "", industry: "", band: "all",
    /** 关注池的用户增量（见「关注池的自定义增删」一节），启动时从 localStorage 读回 */
    wl: wlLoad(),
    /** 自选票现场取到的行情（键＝usXXX）。**不持久化** —— 行情会过期，
     *  存下来只会让下次打开先看到一堆旧数字再跳变。 */
    wlQuotes: {},
    /** 自选取数失败原因（键＝usXXX）。空串＝还没取过（当作"取数中"） */
    wlErrors: {},
    /** 工具条上的即时提示（"已移除 AAPL" / 取数失败原因），不进 localStorage */
    wlMsg: ""
  };

  /** 当前已加载的复盘数据。壳（shell.js）在调 onData 之前就写好了 state.data，
   *  所以筛选回调里可以直接取 —— 不必把 d 一路传下去。 */
  function data() { return Shell.state.data; }

  /* 两个下拉组件的宿主节点（见 ensureFilters 为什么按节点身份记录而不是"建过没有"） */
  var comboHosts = { sector: null, industry: null };

  // ------------------------------------------------------------ 小工具

  /** 市值（亿美元）→ $884亿 / $1.25万亿（带币种，用于卡片） */
  function capYi(v) {
    if (v === null || v === undefined || isNaN(v)) return "—";
    if (v >= 10000) return "$" + (v / 10000).toFixed(2) + " 万亿";
    if (v >= 1000) return "$" + Math.round(v) + " 亿";
    return "$" + v.toFixed(1) + " 亿";
  }

  /** 市值（亿美元）→ 884.0 / 1.25 万亿（不带币种，用于表格 ——
   *  列头已写「总市值(亿美元)」，格子里再带一次 $ 是重复的。
   *  格式与「夜盘异动」的 U.fCap 保持一致，两页表体看起来才是一套。 */
  function capNum(v) {
    if (v === null || v === undefined || isNaN(v)) return "—";
    if (v >= 10000) return (v / 10000).toFixed(2) + " 万亿";
    return Number(v).toFixed(1);
  }

  function fNum(v) {
    if (v === null || v === undefined || isNaN(v)) return "—";
    return Number(v).toFixed(2);
  }

  function dirOf(v) { return (v === null || v === undefined || isNaN(v)) ? "" : (v >= 0 ? "up" : "down"); }

  function pct(v) {
    if (v === null || v === undefined || isNaN(v)) return "—";
    return (v > 0 ? "+" : "") + Number(v).toFixed(2) + "%";
  }

  /** 涨跌迷你条：按本组内最大绝对涨幅归一化，让幅度可比较 */
  function bar(v, maxAbs, cls) {
    if (v === null || v === undefined || isNaN(v) || !maxAbs) return "";
    var w = Math.max(3, Math.round(Math.abs(v) / maxAbs * 100));
    return '<div class="bar"><i class="' + (cls || dirOf(v)) + '" style="width:' + w + '%"></i></div>';
  }

  function maxAbs(arr, pick) {
    var m = 0;
    (arr || []).forEach(function (x) {
      var v = Math.abs(pick(x));
      if (!isNaN(v) && v > m) m = v;
    });
    return m;
  }

  function list(v, sep) {
    if (!v) return "—";
    if (Object.prototype.toString.call(v) === "[object Array]") {
      return v.length ? v.join(sep || "、") : "—";
    }
    return String(v);
  }

  /** 统一的区块外壳：标题（可带计数徽章）+ 内容。
   *  cls 是可选的修饰类（`.panel` 支持 warn / err 之类，见 shell.js 的用法）；
   *  目前早盘总结没有区块用到它，保留是为了与全站的 panel 约定一致。 */
  function panel(title, inner, count, cls, countId) {
    return '<section class="panel' + (cls ? " " + cls : "") + '">' +
      (title ? '<h2 class="sec">' + U.esc(title) +
        (count ? '<span class="sec-n"' + (countId ? ' id="' + countId + '"' : "") + ">" +
          U.esc(count) + "</span>" : "") + "</h2>" : "") +
      inner + "</section>";
  }

  function qualityCls(q) {
    if (!q) return "q-low";
    if (q.indexOf("高") >= 0) return "q-high";
    if (q.indexOf("中") >= 0) return "q-mid";
    return "q-low";
  }

  // ------------------------------------------------------------ 各区块

  /* 原「导语」块（渲染 marketComment）已于 2026-09-22 按用户要求移除，
     首屏位置改由「大盘表现」承担（见 render 里的顺序）。

     为什么可以安全删：那段点评的正文与「主线归纳」高度重复
     （都在讲当日是 AI/半导体单向行情），而且它引用的「命中 97 只」
     是本项目 9/21 静态报告的口径；本页异动榜用的是技能的双轨制口径
     （涨幅>10% 且市值>20亿 / 涨幅≥4% 且市值>1400亿），两者数字并不相等，
     并排显示反而会让读者以为其中一个是错的。

     marketComment 字段仍保留在 data/morning.json 与 MORNING.md 的数据契约里，
     只是不再渲染 —— 想放回来只需恢复这个函数并在 render 里调用。 */

  function indicesHtml(d) {
    var arr = d.indices || [];
    if (!arr.length) return "";
    var mx = maxAbs(arr, function (x) { return x.chgPct; });
    var cards = arr.map(function (x) {
      var cls = dirOf(x.chgPct);
      return '<div class="idx">' +
        '<div class="idx-k">' + U.esc(x.name || x.code || "—") + "</div>" +
        '<div class="idx-v">' + fNum(x.close) + "</div>" +
        '<div class="idx-d ' + cls + '">' + pct(x.chgPct) +
          (x.chgAbs !== undefined && x.chgAbs !== null
            ? '<span class="idx-abs">' + (x.chgAbs >= 0 ? "+" : "") + fNum(x.chgAbs) + "</span>" : "") +
        "</div>" +
        bar(x.chgPct, mx, cls) +
        (x.note ? '<div class="idx-n">' + U.esc(x.note) + "</div>" : "") +
        "</div>";
    }).join("");
    return panel("大盘表现", '<div class="idxrow">' + cards + "</div>");
  }

  /** 异动榜取值：优先用新字段（与「夜盘异动」同源同名的 price / chg / marketCap / sector / industry），
   *  回退到早期 morning.json 的旧字段（close / chgPct / capYi），免得历史数据渲染成空白。
   *  市值对外统一按「亿美元」显示，与夜盘异动一致。 */
  function mvPrice(r) {
    return (r.price !== undefined && r.price !== null) ? r.price : r.close;
  }
  function mvChg(r) {
    return (r.chg !== undefined && r.chg !== null) ? r.chg : r.chgPct;
  }
  function mvCapUsd(r) {
    if (r.marketCap !== undefined && r.marketCap !== null) return r.marketCap;
    if (r.capYi !== undefined && r.capYi !== null) return r.capYi * 1e8;  // 旧字段单位是「亿美元」
    return null;
  }

  /* ------------------------------------------------------------------ 分档
     异动榜按**总市值**分档，与「夜盘异动」页同一组边界（大市值 / 小市值），
     所以两页的「大市值」是同一个意思，读者不用记两套数。

     边界值**从后端拿**（/api/status 的 criteriaValues，源头是 screening.py 的 CFG），
     不在 JS 里写死：写死的话改了 BIG_MIN_CAP_USD 就会变成
     「页面说明写着 100 亿、分档却按别的数切」。拿不到时才回落到默认值。 */
  var BANDS = [
    { key: "all", label: "所有" },
    { key: "big", label: "大市值" },
    { key: "mid", label: "小市值" }
  ];

  function bandCfg() {
    var c = Shell.criteriaValues && Shell.criteriaValues();
    return {
      bigMin: (c && c.bigMinCap) || 1e10,   // 默认 100 亿美元
      midMin: (c && c.midMinCap) || 1.5e9   // 默认 15 亿美元
    };
  }

  /** 边界值按「亿美元」显示，整数就不带小数（100 而不是 100.0） */
  function yi(v) {
    var n = v / 1e8;
    return String(Math.round(n * 100) / 100);
  }

  /** 该行属不属于某一档。**没有市值数据的不归入任何一档** —— 只留在「所有」里，
   *  不硬塞进小市值（那会凭空造出一个"市值未知的小盘股"）。 */
  function inBand(r, key) {
    if (key === "all") return true;
    var c = mvCapUsd(r);
    if (c === null || c === undefined || isNaN(c)) return false;
    var cfg = bandCfg();
    if (key === "big") return c >= cfg.bigMin;
    return c >= cfg.midMin && c < cfg.bigMin;
  }

  function bandCounts() {
    var rows = (data() && data().movers) || [];
    var n = { all: rows.length, big: 0, mid: 0 };
    rows.forEach(function (r) {
      if (inBand(r, "big")) n.big++;
      else if (inBand(r, "mid")) n.mid++;
    });
    return n;
  }

  /* 这一段同时是**分档说明**和**入榜口径说明** —— 2026-09-24 起两者是同一组数字：
     名单只收「大市值 ≥100亿 & 涨幅 ≥4%」和「小市值 15–100亿 & 涨幅 ≥10%」，
     低于 15 亿的全部剔除，所以分档按钮切出来的就是这两段，不会出现"某行不在任何档里"。

     数字**从 /api/status 的 criteriaValues 拿**（源头 screening.py 的 CFG，与夜盘页同一份），
     不写死 100/15 —— 写死就会出现「页面写着 100 亿、逻辑却按别的数切」。
     改口径时要一起看的是 screening.py 的 cfg_from_env（night 页与 morning_fetch 都读它）。 */
  function bandHtml() {
    var rows = (data() && data().movers) || [];
    if (!rows.length) return "";
    var n = bandCounts(), cfg = bandCfg();
    var chips = BANDS.map(function (b) {
      return '<button class="tab" data-band="' + b.key + '">' + U.esc(b.label) +
             '<span class="n">' + n[b.key] + "</span></button>";
    }).join("");
    return '<div class="tabs tabs--filter" id="mvBands">' + chips + "</div>" +
      '<p class="hint band-note">入榜口径与「夜盘异动」页一致：大市值 ≥ ' + yi(cfg.bigMin) +
      ' 亿美元且涨幅 ≥ 4%；小市值 ' + yi(cfg.midMin) + "–" + yi(cfg.bigMin) +
      " 亿美元且涨幅 ≥ 10%；低于 " + yi(cfg.midMin) +
      " 亿美元的全部剔除（入榜前已排除，两档计数之和即总数）。上方按钮用于只看其中某一档。</p>";
  }

  function bandButtons() { return $("mvBands").querySelectorAll(".tab"); }

  /** 选中态只由这里涂 —— 点击时涂一次，数据重画后再涂一次。
   *  （夜盘异动页踩过的坑：把 on 写死在 HTML 字符串里，点击时没人重涂，
   *   在「非交易时段停轮询」之后就成了永久错。） */
  function paintBands() {
    Array.prototype.forEach.call(bandButtons(), function (b) {
      b.classList.toggle("on", b.getAttribute("data-band") === state.band);
    });
  }

  function renderBands() {
    var host = $("mvBandHost");
    if (!host) return;
    host.innerHTML = bandHtml();
    paintBands();
    bindBands();
  }

  function bindBands() {
    var box = $("mvBands");
    if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll(".tab"), function (b) {
      b.addEventListener("click", function () {
        var k = b.getAttribute("data-band");
        if (state.band === k) return;      // 点的就是当前档，不必重画
        state.band = k;
        paintBands();
        /* 板块 / 行业的候选项是跟着分档走的（见 collectOpts），所以要重建一次；
           已选值在新档里可能根本不存在，由 renderFilters 里的 findOpt 兜住回落。 */
        renderFilters();
        renderMoversTable();
      });
    });
  }

  /* ------------------------------------------------------------------ 筛选
     板块 / 行业两个带搜索的下拉 + 搜索框 + 分档，规则与「夜盘异动」完全一致
     （那边是 evening.js 的同名函数），两页读法一致。
     差异只有一处：这边数据是**日更的静态 JSON**，没有 60 秒轮询，
     所以不存在「刷新把已选值冲掉」的问题；但重新加载页面可能拿到新交易日的数据，
     已选项失效时仍要回落（见 renderFilters 里的两处 findOpt 判断）。 */

  function filterRows(rows) {
    var q = state.q.trim().toLowerCase();
    return (rows || []).filter(function (r) {
      // 分档：先按市值粗筛，再做细条件
      if (!inBand(r, state.band)) return false;
      // 板块/行业是等值匹配 —— 选项本身就来自数据，不存在近似值
      if (state.sector && (r.sector || "") !== state.sector) return false;
      if (state.industry && (r.industry || "") !== state.industry) return false;
      if (!q) return true;
      // 中文与英文原名都可命中（板块/行业展示中文，英文存于 *En 字段）
      return [r.symbol || r.code, r.name, r.sector, r.industry, r.sectorEn, r.industryEn]
        .join(" ").toLowerCase().indexOf(q) >= 0;
    });
  }

  /* 工具条放在**面板内部**（标题下方），而不是像夜盘异动那样放在面板外面。
     原因：它筛的就是这张榜；摆在面板外面会被读成"筛整页"。
     （原先「个股」页里还并排放着「个人关注池」，而关注池数据里没有板块/行业字段、
       根本筛不动，那时这条理由更硬。2026-09-22 关注池搬到「关注」页后不再有这个问题，
       但放在面板内部仍是它该在的位置，没必要跟着挪。）
     分档 chip 排在最前（#mvBandHost），与夜盘异动页的位置一致：先分档，再细筛。 */
  function toolbarHtml() {
    return '<div id="mvBandHost"></div>' +
      '<div class="toolbar">' +
      '<input type="search" id="mvQ" value="' + U.esc(state.q) + '" ' +
        'placeholder="搜索代码 / 公司 / 板块 / 行业…">' +
      '<div id="mvSectorSel" class="combo"></div>' +
      '<div id="mvIndustrySel" class="combo"></div>' +
      '<span class="hint" id="mvRowInfo"></span>' +
      "</div>";
  }

  /** 异动榜表格：与「夜盘异动」共用同一套表格组件（.tblwrap + table + .band 药丸），
   *  并且**列与取值口径也与之完全一致**：价格 / 涨跌幅 / 总市值 / 板块 / 行业
   *  都来自同一套取数管道（finviz → screening.normalize），数值格式走同一个 U.fPrice / U.fPct / U.fCap。
   *  两页差异只剩最后一列：那边是「查原因」外链，这边是写好的「驱动原因」整句话，
   *  所以给它单独一列并放开宽度（td.why），而不是塞进标签列。 */
  function moversTableHtml(rows) {
    if (!rows.length) return '<div class="empty">当前筛选条件下没有数据</div>';
    var head = "<tr><th>代码</th><th>公司全称</th><th class=\"num\">价格(USD)</th>" +
               "<th class=\"num\">涨跌幅</th><th class=\"num\">总市值(亿美元)</th>" +
               "<th>板块</th><th>行业</th><th>驱动原因</th></tr>";
    var body = rows.map(function (r) {
      var chg = mvChg(r);
      var dir = dirOf(chg);
      return "<tr>" +
        '<td class="code">' + U.esc(codeText(r.symbol || r.code)) + "</td>" +
        '<td class="name">' +
          (r.giant ? '<span class="band ' + dir + '">★ 巨头</span> ' : "") +
          U.esc(r.name || "—") + "</td>" +
        '<td class="num">' + U.fPrice(mvPrice(r)) + "</td>" +
        '<td class="num"><span class="chg ' + dir + '">' + U.fPct(chg) + "</span></td>" +
        '<td class="num">' + U.fCap(mvCapUsd(r)) + "</td>" +
        '<td class="sec" title="' + U.esc(r.sectorEn || "") + '">' + U.esc(r.sector || "—") + "</td>" +
        '<td class="ind" title="' + U.esc(r.industryEn || "") + '">' + U.esc(r.industry || "—") + "</td>" +
        '<td class="why">' + U.esc(r.driver || "待确认") + "</td>" +
        "</tr>";
    }).join("");
    return '<div class="tblwrap"><table class="t-movers"><thead>' + head +
           "</thead><tbody>" + body + "</tbody></table></div>";
  }

  /** 异动榜面板。工具条与表格分开：
   *  表格单独放进 #mvTableHost，筛选时只换这一块，不重建工具条 ——
   *  重建会丢掉搜索框的焦点（打字打一半就被抢走）。 */
  function moversHtml(d) {
    var arr = d.movers || [];
    if (!arr.length) {
      return panel("个股异动榜", '<div class="empty">本交易日无符合条件的异动标的</div>');
    }
    var giants = arr.filter(function (r) { return r.giant; }).length;
    var cnt = arr.length + " 只" + (giants ? " · " + giants + " 只巨头" : "");
    return panel("个股异动榜", toolbarHtml() + '<div id="mvTableHost"></div>', cnt);
  }

  /* ------------------------------------------------------------------ 排序
     两处排序（2026-09-22 按用户要求）：

       个股异动榜 —— 按涨跌幅**从大到小**，涨得最多的在最上面。
       个人关注池 —— 按**股票代码字母序**。

     为什么排序放在渲染层、而不只交给生成脚本（morning_fetch.py 也同步改了）：
     数据文件是每天 06:30 由自动化写进去的，页面读到的可能还是**按旧规则排的**那份。
     渲染层自己排一遍，口径当天就改得动，也不依赖生成脚本是否已更新。
     两边都改是刻意的：生成脚本保证 JSON 自洽，渲染层保证页面上看到的一定是对的。 */

  /** 涨跌幅降序；缺涨跌幅的垫底。并列时按代码升序兜底 ——
   *  否则同样一份数据可能给出两种顺序（排序不稳定），上下两次刷新看着像"数据变了"。 */
  function sortMovers(rows) {
    return (rows || []).slice().sort(function (a, b) {
      var ca = mvChg(a), cb = mvChg(b);
      if (ca === null || ca === undefined || isNaN(ca)) ca = -Infinity;
      if (cb === null || cb === undefined || isNaN(cb)) cb = -Infinity;
      if (cb !== ca) return cb - ca;
      return cmpCode(a.symbol || a.code, b.symbol || b.code);
    });
  }

  /* 关注池为什么改成按代码排（原先按涨幅降序）：关注池是「我关心的票」的固定清单，
     不是异动榜。按涨幅排会让同一只票的格子天天换位置 —— 想找某只票得先知道它今天
     涨了多少，等于每次都要从头扫一遍。代码是稳定键，今天见过、明天还在原地。

     比较用纯 ASCII 顺序而不是 localeCompare：股票代码只有数字与字母，
     走本地化比较会引入"看起来随机"的顺序（数字与字母的先后依 locale 而变）。
     locales 里代码可能带市场前缀（usAXTI），按**页面显示的形态**（去掉前缀）排，
     所见即所排；codeText 对无前缀的代码是恒等变换，两种形态结果一致。 */
  function cmpCode(a, b) {
    var x = String(codeText(a) || ""), y = String(codeText(b) || "");
    if (x < y) return -1;
    if (x > y) return 1;
    return 0;
  }

  /* 关注池的排序不再单独成函数（原先有 sortWatchlist）：清单现在还要并进
     用户自选的票，统一由 wlEffective() 一次性排好，避免"合并前先排一次、
     合并后又排一次"这种两处排序各说各话的写法。 */

  /** 只重绘表格与计数。标题上的计数徽章是**全量**，这里显示的是**筛选后**的 —
   *  两个数各有用处：前者说明这一天有多少异动，后者说明当前条件筛出了多少。 */
  function renderMoversTable() {
    var host = $("mvTableHost");
    if (!host) return;
    var all = (data() && data().movers) || [];
    var rows = sortMovers(filterRows(all));
    var info = $("mvRowInfo");
    if (info) info.textContent = "显示 " + rows.length + " 只 / 共 " + all.length + " 只";
    host.innerHTML = moversTableHtml(rows);
  }

  /* 收集选项：{value, name, en, count}。en 取该中文名下第一次出现的英文原名，
     供搜索用（输入 semi 能命中「半导体」）。选项带计数，但**计数不参与匹配**。
     只在**当前分档内**收集 —— 否则选了「小市值」还能在下拉里挑到只有大市值才有的
     板块，选完就是一张空表，正是本节开头要避免的"死选项"。 */
  function collectOpts(key, enKey, withinSector) {
    var seen = {}, out = [];
    ((data() && data().movers) || []).forEach(function (r) {
      if (!inBand(r, state.band)) return;
      if (withinSector && (r.sector || "") !== withinSector) return;
      var v = r[key] || "";
      if (!v) return;
      if (seen[v]) { seen[v].count++; return; }
      var o = { value: v, name: v, en: r[enKey] || "", count: 1 };
      seen[v] = o;
      out.push(o);
    });
    out.sort(function (a, b) { return a.name.localeCompare(b.name, "zh"); });
    return out;
  }

  function findOpt(list, v) {
    for (var i = 0; i < list.length; i++) if (list[i].value === v) return true;
    return false;
  }

  /* 选项从**当前数据里实际出现的值**生成，而不是列出 taxonomy_zh 的全部
     11 板块 + 151 行业 —— 后者绝大多数选了就是空表，属于死选项。
     行业与板块联动：选了板块后，行业下拉只列该板块下的行业。 */
  function renderFilters() {
    var secs = collectOpts("sector", "sectorEn");
    if (state.sector && !findOpt(secs, state.sector)) state.sector = "";

    var inds = collectOpts("industry", "industryEn", state.sector);
    if (state.industry && !findOpt(inds, state.industry)) {
      state.industry = "";
      inds = collectOpts("industry", "industryEn", state.sector);
    }

    var s = Combo.get("mvSectorSel"), i = Combo.get("mvIndustrySel");
    if (s) s.setOptions(secs, state.sector);
    if (i) i.setOptions(inds, state.industry);
  }

  /* 两个下拉组件的宿主节点判断用**节点身份**，而不是"建过没有"：
     面板是随 morningHost.innerHTML 整体重建的（首次渲染、以及重新加载页面），
     重建后旧 Combo 实例还指着已脱离文档的节点 —— 点开没反应，而且不报错。
     所以每次渲染后比一次节点是不是同一个，不是就重建实例。 */
  function ensureFilters() {
    var sh = $("mvSectorSel"), ih = $("mvIndustrySel");
    if (!sh || !ih) return;
    if (comboHosts.sector !== sh) {
      Combo.create(sh, {
        allLabel: "全部板块", placeholder: "输入板块名筛选…",
        onChange: function (v) {
          state.sector = v;
          state.industry = "";   // 换了板块，原行业多半不属于新板块，先清掉再重建
          renderFilters();
          renderMoversTable();
        }
      });
      comboHosts.sector = sh;
    }
    if (comboHosts.industry !== ih) {
      Combo.create(ih, {
        allLabel: "全部行业", placeholder: "输入行业名筛选…",
        onChange: function (v) { state.industry = v; renderMoversTable(); }
      });
      comboHosts.industry = ih;
    }
  }

  /** 绑工具条。**每次 render 后都要调用**（元素随面板重建，事件要重新挂）。
   *  数据为空时面板里没有工具条，$() 取不到就直接返回。 */
  function bindMoversTools() {
    var qEl = $("mvQ");
    if (!qEl) return;
    qEl.addEventListener("input", function () { state.q = this.value; renderMoversTable(); });
    renderBands();          // 分档 chip 先就位：它决定下面两个下拉的候选项
    ensureFilters();
    renderFilters();
    renderMoversTable();
  }

  /** 展示用代码：行情接口给的是带市场前缀的写法（usAXTI），
   *  读者只需要交易所内的代码，前缀去掉。数据层保留原样，不改取数脚本。
   *  只剥**小写 us + 其后跟大写字母**这种前缀 —— 否则会误伤 USB（美国合众银行）这类
   *  本身就长这样的代码。表格与方块共用这一个函数，两处口径一致。 */
  function codeText(code) {
    if (!code) return "—";
    return String(code).replace(/^us(?=[A-Z])/, "");
  }

  /* ------------------------------------------------------- 关注池的自定义增删
     （2026-09-22 按用户要求）

     清单存**浏览器 localStorage**，只存"增量"，不存整份列表：
       added   —— 用户自己加的代码（如 usAAPL）
       removed —— 用户从默认池里删掉的代码
     为什么存增量而不是整份快照：池子的底稿是 data/morning.json 的 watchlist，
     每天 06:30 由自动化重写一次。存整份的话，自动化第二天加了新票，用户这边
     还是昨天那份，等于把上游的更新永久屏蔽掉 —— 那是"编辑"变成了"分叉"。
     存增量则两头都对：上游改了自动跟上，用户的增删照样生效。

     被删掉的代码要留在这个列表里，否则明天数据一刷新它又冒出来了。

     自选票的行情不在 morning.json 里（那是每天 06:30 的快照，不知道用户加了什么），
     得现场向 /api/quote 要一次 —— 这是全站唯一由页面发起的取数，理由见 README。

     存储键 WL_STORE 声明在文件上方（挨着 TAB_STORE），**不要挪到这里** ——
     state 在本文件靠前处就用它了，挪下来会导致刷新后自定义清单全部丢失。 */

  /** localStorage 里存的代码形态与数据文件一致（us + 纯 ticker）。
   *  规则与 server.py 的 normalize_symbol、以及本文件的 codeText 保持一致：
   *  **只剥 `us` 加紧跟大写字母**，别把 USB（美国合众银行）这类代码削掉两个字符。 */
  function wlCode(v) {
    var raw = String(v == null ? "" : v).trim().replace(/^\$/, "");
    if (/^us[A-Z]/.test(raw)) raw = raw.slice(2);
    var s = raw.trim().toUpperCase();
    return /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s) ? "us" + s : "";
  }

  function wlLoad() {
    try {
      var o = JSON.parse(localStorage.getItem(WL_STORE) || "{}") || {};
      var pick = function (v) {
        return (Array.isArray(v) ? v : [])
          .map(wlCode).filter(Boolean)
          .filter(function (c, i, a) { return a.indexOf(c) === i; });   // 去重，存坏了也不重复
      };
      return { added: pick(o.added), removed: pick(o.removed) };
    } catch (e) {
      // 存储里是坏 JSON / 被禁用（隐私模式）→ 当没存过，页面照常可用，只是改不持久
      return { added: [], removed: [] };
    }
  }

  function wlSave() {
    try {
      localStorage.setItem(WL_STORE, JSON.stringify({
        added: state.wl.added, removed: state.wl.removed
      }));
    } catch (e) { /* 存不了就只在本次会话内有效，不打断操作 */ }
  }

  /** 有效清单 = 默认池（剔除被删的） + 自选（补进还没出现过的）。
   *  返回的是"视图行"：{row, custom, pending, err, mx}，
   *  **不直接改 data().watchlist 里的行** —— 那是要反复重绘的共享数据。 */
  function wlEffective() {
    var d = data() || {};
    var base = (d.watchlist || []).filter(function (r) {
      return state.wl.removed.indexOf(String(r.code)) < 0;
    });
    var seen = {}, items = [];
    base.forEach(function (r) {
      seen[String(r.code)] = true;
      items.push({ row: r, custom: false, pending: false, err: "" });
    });
    state.wl.added.forEach(function (code) {
      if (seen[code]) return;      // 池子里已经有了 → 不产生第二格
      seen[code] = true;
      var q = state.wlQuotes[code];
      if (q) return items.push({ row: q, custom: true, pending: false, err: "" });
      // 还没取到 / 取数失败也要占一格 —— 否则用户点完"添加"页面像没反应
      var err = state.wlErrors[code] || null;
      items.push({ row: { code: code }, custom: true, pending: !err, err: err });
    });
    // 排序沿用"按股票代码字母序"：自选票按代码落到各自位置上，不另起一段
    items.sort(function (a, b) { return cmpCode(a.row.code, b.row.code); });
    var mx = maxAbs(items.map(function (i) { return i.row; }),
                    function (r) { return r.chgPct; });
    items.forEach(function (i) { i.mx = mx; });
    return items;
  }

  function wlTileHtml(it) {
    var r = it.row || {};
    var full = String(r.code || "");
    var del = '<button class="tile-del" data-act="del" data-code="' + U.esc(full) +
              '" title="从关注池移除" aria-label="移除">×</button>';
    if (it.pending) {
      return '<div class="tile is-pending">' + del +
        '<div class="tile-t"><span class="tile-code">' + U.esc(codeText(full)) + "</span></div>" +
        '<div class="tile-n">取数中…</div></div>';
    }
    if (it.err) {
      // err 是 {msg, retry}：**能不能重试是不一样的** —— "取数失败"值得再点一次，
      // "查不到这个代码"再点一百次也没用，只该提示去核对拼写或删掉它。
      var r = it.err;
      return '<div class="tile is-err' + (r.retry ? " is-retry" : "") +
          '"' + (r.retry ? ' data-act="retry" data-code="' + U.esc(full) + '"' : "") + ">" + del +
        '<div class="tile-t"><span class="tile-code">' + U.esc(codeText(full)) + "</span></div>" +
        '<div class="tile-n">' + U.esc(r.msg) + "</div>" +
        '<div class="tile-k">' + (r.retry ? "点击重试" : "换个代码，或点右上角移除") + "</div></div>";
    }
    var cls = dirOf(r.chgPct);
    /* 「自选」标放在**最后一行**（跟板块同行），不放顶部：
       顶部一行放着 代码 + 涨跌幅 + 移除按钮，170px 的格子塞不下第三个元素，
       实测会把"自选"两个字折行，看着像排版坏了。 */
    var kw = (r.keyword && r.keyword !== "—") ? r.keyword : "";
    var foot = (it.custom || kw)
      ? '<div class="tile-k">' + (it.custom ? '<i class="tile-tag">自选</i>' : "") +
        (kw ? U.esc(kw) : "") + "</div>"
      : "";
    return '<div class="tile' + (it.custom ? " is-custom" : "") + '">' + del +
      '<div class="tile-t"><span class="tile-code">' + U.esc(codeText(full)) + "</span>" +
        '<span class="tile-chg ' + cls + '">' + pct(r.chgPct) + "</span></div>" +
      '<div class="tile-n">' + U.esc(r.name || "—") + "</div>" +
      '<div class="tile-p">$' + fNum(r.close) +
        (r.capYi ? '<span class="tile-cap"> · ' + capYi(r.capYi) + "</span>" : "") + "</div>" +
      bar(r.chgPct, it.mx, cls) + foot +
      "</div>";
  }

  /** 关注池面板。工具条与方块网格**分开**：网格单独放进 #wlHost，
   *  增删后只重绘这一块 —— 重建工具条会把用户正在输入的代码和焦点一起弄丢
   *  （与「个股异动榜」把表格单独放 #mvTableHost 是同一个理由）。
   *
   *  **面板恒渲染**（不像其它区块那样"没数据就不出现"）：它是唯一能"往池子里加票"
   *  的入口，默认池为空的日子也必须留着，否则用户无从下手。 */
  function watchlistHtml(d) {
    var items = wlEffective();
    return panel("个人关注池",
      '<p class="hint sub">覆盖关注池全部标的，不论当日涨幅多少均列出，按股票代码字母序。' +
        "点方块右上角的 × 可移除；移除后可用「恢复」找回。</p>" +
      '<div class="wl-tools">' +
        /* 输入框外面套一层 .sug：建议下拉要绝对定位在输入框正下方，
           需要一个 position:relative 的容器（见 suggest.js 与 style.css）。 */
        '<span class="sug" id="wlSug">' +
          '<input type="text" id="wlAdd" class="wl-add" maxlength="12" ' +
            'placeholder="代码或公司名，如 AAPL / 苹果 / apple" ' +
            'autocomplete="off" spellcheck="false">' +
        "</span>" +
        '<button id="wlAddBtn" class="wl-add-btn primary">添加</button>' +
        '<span class="hint" id="wlMsg"></span>' +
        '<span class="hint wl-hidden" id="wlHidden"></span>' +
      "</div>" +
      '<div class="tiles" id="wlHost"></div>',
      items.length + " 只", null, "wlCount");
  }

  /** 只重绘方块 + 徽章 + 状态文案，不碰输入框 */
  function renderWatchlist() {
    var host = $("wlHost");
    if (!host) return;
    var items = wlEffective();
    host.innerHTML = items.map(wlTileHtml).join("");
    var cnt = $("wlCount");
    if (cnt) cnt.textContent = items.length + " 只";
    var msg = $("wlMsg");
    if (msg) msg.textContent = state.wlMsg || "";
    var hid = $("wlHidden");
    if (hid) {
      var n = state.wl.removed.length;
      hid.innerHTML = n
        ? "已移除 " + n + " 只，<a href=\"#\" data-act=\"restore\">恢复</a>"
        : "";
    }
  }

  /** 给自选票取行情。批量一次请求，失败可重试（见接口 /api/quote）。 */
  function wlFetch(codes) {
    if (!codes || !codes.length) return;
    codes.forEach(function (c) { delete state.wlErrors[c]; });
    renderWatchlist();                       // 先切成"取数中…"，让点击有反馈
    fetch("/api/quote?codes=" + encodeURIComponent(codes.join(",")), { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var quotes = (j && j.quotes) || {};
        Object.keys(quotes).forEach(function (sym) {
          var row = quotes[sym];
          if (row && row.code) state.wlQuotes[row.code] = row;
        });
        var missing = (j && j.missing) || [];
        codes.forEach(function (c) {
          if (state.wlQuotes[c]) return;
          // 区分"代码查不到"和"取数失败"：前者让用户核对拼写，后者值得再试一次
          state.wlErrors[c] = missing.indexOf(codeText(c)) >= 0
            ? { msg: "查不到这个代码", retry: false }
            : { msg: "取数失败", retry: true };
        });
        /* 只在服务端**真的给了话术**时才动这行提示。
           早先这里写成"没话术就置空"，结果是刚点完"已恢复 MMM"、取数一回来提示就没了
           —— 用户看到的是"点了没反应"。取数成功本来就是最平常的情况，它不该有话语权。 */
        if (j && j.message) state.wlMsg = j.message;
      })
      .catch(function (e) {
        codes.forEach(function (c) {
          if (!state.wlQuotes[c]) state.wlErrors[c] = { msg: "取数失败", retry: true };
        });
        state.wlMsg = "无法连接取数服务：" + e.message;
      })
      .then(function () { renderWatchlist(); });
  }

  /** 把一只代码加进池子（code 必须是内部形态 usXXX）。返回 true = 确实加/恢复了。
   *
   *  与"读输入框"分开，是因为有**两个入口**：手动打字后点「添加」/回车，
   *  以及从建议下拉里点一只（suggest.js 的 onPick，它给的是纯 ticker，需要补 us 前缀）。
   *  两条路必须走同一套判定，否则"已存在怎么提示""被删过的算不算恢复"会出现两套行为。 */
  function wlAddCode(code) {
    if (state.wl.removed.indexOf(code) >= 0) {
      // 加回来等于撤销之前的删除，而不是"再加一只"
      state.wl.removed = state.wl.removed.filter(function (c) { return c !== code; });
      state.wlMsg = "已恢复 " + codeText(code);
      wlSave();
      wlFetch([code]);
      return true;
    }
    if (state.wl.added.indexOf(code) >= 0) {
      state.wlMsg = codeText(code) + " 已经在关注池里了";
      renderWatchlist();
      return false;
    }
    var inBase = ((data() && data().watchlist) || []).some(function (r) {
      return String(r.code) === code;
    });
    if (inBase) {
      state.wlMsg = codeText(code) + " 已经在关注池里了";
      renderWatchlist();
      return false;
    }
    state.wl.added.push(code);
    state.wlMsg = "";
    wlSave();
    wlFetch([code]);
    return true;
  }

  /** 读输入框、加一只。输入不合法只提示，不进列表 */
  function wlAdd() {
    var el = $("wlAdd");
    if (!el) return;
    var raw = el.value;
    var code = wlCode(raw);
    if (!code) {
      state.wlMsg = raw.trim() ? "代码格式不对（示例：AAPL / BRK.B）" : "";
      return renderWatchlist();
    }
    if (wlAddCode(code)) el.value = "";
  }

  /** 输入建议的数据源。查不到 / 接口没就绪 / 网络抖动都只是"没有建议"，
   *  **不弹错也不打断打字** —— 用户完全可以继续手打代码再点添加。 */
  function fetchSymbols(q) {
    return fetch("/api/symbols?limit=8&q=" + encodeURIComponent(q), { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) { return (j && j.ok && j.symbols) || []; })
      .catch(function () { return []; });
  }

  /** 移除一只：一律先从 added 里去掉；只要它**也存在于默认池**，就记进 removed。
   *
   *  判据是"在不在默认池"，**不是"是不是自选"** —— 这一点曾经写错过。
   *  想象这只票既被用户手动加过、又被自动化写进了默认池（完全可能：用户先加，
   *  隔天上游把同一只票加进池子）：若按"自选票不记 removed"处理，那么删掉它以后，
   *  默认池那一份会立刻把它顶回来 —— 用户看到的是「删了还在」，而且不报任何错。
   *  改成看 inBase 就没有这个例外：源里有它就记一笔，删除才真的生效。 */
  function wlRemove(code) {
    state.wl.added = state.wl.added.filter(function (c) { return c !== code; });
    delete state.wlQuotes[code];
    delete state.wlErrors[code];
    var inBase = ((data() && data().watchlist) || []).some(function (r) {
      return String(r.code) === code;
    });
    if (inBase && state.wl.removed.indexOf(code) < 0) {
      state.wl.removed.push(code);
    }
    state.wlMsg = "已移除 " + codeText(code);
    wlSave();
    renderWatchlist();
  }

  function wlRestoreAll() {
    if (!state.wl.removed.length) return;
    var n = state.wl.removed.length;
    state.wl.removed = [];
    state.wlMsg = "已恢复 " + n + " 只";
    wlSave();
    renderWatchlist();
  }

  /** 挂事件。工具条元素**不随网格重绘**，所以这里每次整页 render 后挂一次即可；
   *  方块里的 × 用事件委托挂在 #wlHost 上，重绘不会丢监听。 */
  function bindWatchlistTools() {
    var input = $("wlAdd"), btn = $("wlAddBtn"), host = $("wlHost");
    if (!input || !btn || !host) return;
    btn.addEventListener("click", wlAdd);
    /* 输入框的键盘（回车 / 上下键 / Esc）**全部交给 suggest.js 处理** ——
       它需要在"回车该提交原文还是该选中高亮项"这件事上做唯一决定。
       两个地方各挂一个 keydown 会互相打架（一个阻止默认、另一个照样执行 → 一次回车加两只）。
       组件不可用时（脚本没加载等）保留一个只认回车的兜底，不让输入框变成摆设。 */
    if (window.Suggest) {
      Suggest.create(input, {
        source: fetchSymbols,
        // 下拉里点一只 = 直接加进去，不必再点「添加」；它给的是纯 ticker，补上内部前缀
        onPick: function (it) {
          if (it && it.symbol) {
            input.value = "";
            wlAddCode("us" + it.symbol);
          }
        },
        onSubmit: function () { wlAdd(); }
      });
    } else {
      input.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") { ev.preventDefault(); wlAdd(); }
      });
    }
    host.addEventListener("click", function (ev) {
      var t = ev.target;
      var box = t.closest ? t.closest("[data-act]") : null;
      if (!box) return;
      var act = box.getAttribute("data-act"), code = box.getAttribute("data-code");
      if (act === "del") { ev.stopPropagation(); wlRemove(code); }
      else if (act === "retry") { wlFetch([code]); }
    });
    // 「恢复」链接由 renderWatchlist 重写（在 #wlHidden 里），**不能直接挂监听**
    // —— 重写后那个节点就没了。改为委托在工具条容器上。
    var tools = input.parentNode && input.parentNode.parentNode;
    if (tools) {
      tools.addEventListener("click", function (ev) {
        var a = ev.target;
        if (a && a.getAttribute && a.getAttribute("data-act") === "restore") {
          ev.preventDefault();
          wlRestoreAll();
        }
      });
    }
  }

  function themesHtml(d) {
    var ts = d.themes || [];
    if (!ts.length) return "";
    var cards = ts.map(function (t) {
      return '<div class="theme ' + qualityCls(t.quality) + '">' +
        '<div class="card-h"><b>' + U.esc(t.name || "—") + "</b>" +
          (t.quality ? '<span class="q ' + qualityCls(t.quality) + '">信号 ' +
            U.esc(t.quality) + "</span>" : "") + "</div>" +
        (t.stocks && t.stocks.length
          ? '<div class="card-s"><span class="lbl">上榜</span>' + U.esc(list(t.stocks)) + "</div>" : "") +
        (t.catalyst ? '<div class="card-s"><span class="lbl">催化</span>' + U.esc(t.catalyst) + "</div>" : "") +
        "</div>";
    }).join("");
    // cardgrid：宽屏下这组卡片内部改排 3 列（见 style.css 的宽屏一节）
    return panel("主线归纳", '<div class="cardgrid">' + cards + "</div>", ts.length + " 条");
  }

  function linkageHtml(d) {
    var ls = d.linkage || [];
    if (!ls.length) return "";
    var cards = ls.map(function (l, i) {
      var rows = "";
      if (l.usStocks && l.usStocks.length) rows += "<dt>美股标的</dt><dd>" + U.esc(list(l.usStocks)) + "</dd>";
      if (l.logic) rows += "<dt>共同逻辑</dt><dd>" + U.esc(l.logic) + "</dd>";
      if (l.aShareSectors) rows += "<dt>A 股子赛道</dt><dd>" + U.esc(l.aShareSectors) + "</dd>";
      if (l.aShareNames && l.aShareNames.length) {
        rows += "<dt>A 股标的</dt><dd>" + (l.aShareNames || []).map(function (n) {
          return '<span class="chip chip-as">' + U.esc(n) + "</span>";
        }).join("") + "</dd>";
      }
      return '<div class="theme ' + qualityCls(l.confidence) + '">' +
        '<div class="card-h"><b>关联因子 ' + (i + 1) + "：" + U.esc(l.factor || "—") + "</b>" +
          (l.confidence ? '<span class="q ' + qualityCls(l.confidence) + '">置信度 ' +
            U.esc(l.confidence) + "</span>" : "") + "</div>" +
        '<dl class="kv">' + rows + "</dl>" +
        "</div>";
    }).join("");
    // cardgrid：宽屏下这组卡片内部改排 3 列（见 style.css 的宽屏一节）
    return panel("关联性深度分析", '<div class="cardgrid">' + cards + "</div>", ls.length + " 个因子");
  }

  function hintsHtml(d) {
    var hs = d.aShareHints || [];
    if (!hs.length) return "";
    return panel("A 股联动提示",
      '<ol class="hints">' + hs.map(function (h) {
        return "<li>" + U.esc(typeof h === "string" ? h : (h.text || JSON.stringify(h))) + "</li>";
      }).join("") + "</ol>" +
      '<p class="hint sub">以上为基于公开数据的客观梳理，不构成投资建议。</p>');
  }

  /* 原本这里还有一条页脚（数据来源 / 生成方式 / 剔除说明），已于 2026-09-22
     按用户要求去掉 —— 那是生成过程的旁注，不是读者看盘需要的信息。
     相关字段（meta.sources、meta.generatedBy、excludedNote）仍保留在
     data/morning.json 与 MORNING.md 的数据契约里，接口随时能看到，排障不受影响。 */

  // ------------------------------------------------------------ 标签页

  /** 面板 id 由 tab.key 推导：overview → paneOverview */
  function paneId(key) { return "pane" + key.charAt(0).toUpperCase() + key.slice(1); }

  /* 按钮不带数量徽章 —— 夜盘异动的标签都挂在表格上，「数字 = 行数」有明确含义；
     这里「总览」是四个区块的合集、「个股」是一张榜、「关注」是一份清单，
     数字含义各不相同，硬塞一个反而要读者去猜它在数什么。
     （「关注」页里那只数已经由面板标题的徽章给了。） */
  function renderTabs() {
    var box = $("tabs");
    if (!box) return;
    box.innerHTML = TABS.map(function (t) {
      return '<button class="tab" data-tab="' + t.key + '">' + U.esc(t.label) + "</button>";
    }).join("");
    Array.prototype.forEach.call(box.querySelectorAll(".tab"), function (b) {
      b.addEventListener("click", function () {
        if (state.tab === b.getAttribute("data-tab")) return;
        state.tab = b.getAttribute("data-tab");
        rememberTab(state.tab);      // 记下来，跳去别的页面再回来还停在这一页
        applyTab();
        // 换页等于换了整屏内容，滚到顶部，否则停在上一页的中段会看到一片空。
        window.scrollTo(0, 0);
      });
    });
  }

  /** 只切显隐与按钮态，不重建 DOM —— 数据是静态 JSON，重建只会丢滚动位置 */
  function applyTab() {
    TABS.forEach(function (t) {
      var el = $(paneId(t.key));
      if (el) el.hidden = (state.tab !== t.key);
    });
    var box = $("tabs");
    if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll(".tab"), function (b) {
      var on = b.getAttribute("data-tab") === state.tab;
      if (on) b.classList.add("on"); else b.classList.remove("on");
    });
  }

  // ------------------------------------------------------------ 入口

  function render(d) {
    var host = $("morningHost");
    if (!host) return;
    if (!d || !d.ok) {
      host.innerHTML = panel("早盘总结",
        '<div class="empty">' + U.esc((d && d.message) || "复盘数据尚未生成") + "</div>");
      var box0 = $("tabs");
      if (box0) box0.innerHTML = "";
      return;
    }
    // 面板内区块顺序即版面顺序，分三段：
    //   「总览」首块是「大盘表现」——先给基准，读者知道今天是普涨还是单边，
    //     再往下读主线与映射才有个参照系（涨 10% 在普跌日和在普涨日不是一回事）；
    //     接着主线归纳 → 关联性深度分析 → A 股联动提示，三块是同一条推理链
    //     （今天涨了什么 → 为什么一起涨 → 对应 A 股哪条线），连在一起读才顺。
    //   「个股」是纯行情：个股异动榜（谁涨了、什么原因）。
    //   「关注」是自己的池子（关注池 2026-09-22 从「个股」挪到独立一页）。
    // 面板之外原本还有一条页脚（数据来源 / 生成方式），已于 2026-09-22 去掉。
    host.innerHTML =
      '<div id="' + paneId("overview") + '">' +
        indicesHtml(d) + themesHtml(d) + linkageHtml(d) + hintsHtml(d) +
      "</div>" +
      '<div id="' + paneId("stocks") + '">' +
        moversHtml(d) +
      "</div>" +
      '<div id="' + paneId("watch") + '">' +
        watchlistHtml(d) +
      "</div>";
    renderTabs();
    applyTab();
    // 必须放在最后：筛选控件是随面板一起生成的，要在 DOM 就位后才挂事件、填选项
    bindMoversTools();
    bindWatchlistTools();          // 关注池是独立面板，各自判断元素在不在，互不牵连
    renderWatchlist();
    // 自选票的行情不在日更数据里，进页面时补取一次。
    // 只取**还没拿到**的：服务端有 120 秒缓存，重复取也只是打缓存，但少一轮往返总是好的。
    var pending = state.wl.added.filter(function (c) { return !state.wlQuotes[c]; });
    if (pending.length) wlFetch(pending);
  }

  Shell.mount({
    navKey: "morning",
    title: "早盘总结",
    mode: "daily",
    onData: render,
    /* 口径数值（/api/status）与首屏数据是**两个并行请求**，回来顺序不保证。
       若数值晚到且与默认值不同，仅重画分档与表格，**不整页重建** ——
       整页重建会把搜索框里已输入的内容和滚动位置弄丢。 */
    onCriteria: function () {
      if (!$("mvBands")) return;
      renderBands();
      renderFilters();
      renderMoversTable();
    }
  });
})();
