/* 站点外壳 —— 左侧菜单（含站点标） + 页头徽章 + 取数。两个页面共用。
 *
 * 两种模式，由 mount 的 opts.mode 决定：
 *   "live"  （默认，夜盘异动）—— 页头显示 市场状态 / 数据口径 / 取数时间
 *   "daily" （早盘总结）      —— 只读取 /api/morning（每天 06:30 由自动化写入），
 *                                页头显示 市场状态 / 复盘交易日 / 生成时间，**无刷新按钮**
 *
 * **两个模式都不自动更新数据**（2026-09-22 按用户要求，live 模式当天改）。
 * live 原先是"常规时段每 20 秒轮询 /api/movers"，问题在于那份数据与页面口径是矛盾的：
 * 夜盘异动的口径是「最新一个已完成的美股交易日」，而开市期间抓到的是**当日盘中**涨跌幅，
 * 一只票 10:15 涨 4%、收盘可能跌 2%，名单随时作废还会在读者眼皮底下跳。
 * 现在数据由**后端**在报价定型（盘后/休市）时抓，一天一份；前端只在进页面时取一次，
 * 之后靠低频查 /api/status 发现"后端换了快照"才再取 —— 详见下面「不自动取数」一节。
 * 手动「立即刷新」不受影响（那是用户的明确动作，随时可用）。
 *
 * 站点标（logo + 「晨昏线」）在 renderSidebar 里生成，样式见 style.css 的
 * 「站点标」一节；两处都写了为什么这么配 —— 尤其是金色为什么必须比 logo 原色深。
 */
(function (w) {
  "use strict";

  //: 站点名称。改这里一处即可全局生效。
  var SITE = {
    name: "晨昏线",
    tagline: "美股隔夜与开盘"
  };

  //: 左侧菜单。新增页面时在这里加一项，并新建对应 HTML。
  //: icon  取 Icons 里的键名（见 icons.js）。
  //: accent 可选，覆盖「选中时」的图标颜色；不写则跟菜单项文字一样是站点蓝。
  //:        太阳与月亮都取用户给定图选中态的亮绿 #75c82b（两张图本来就是同色）。
  var NAV = [
    { key: "morning", label: "早盘总结", href: "/morning", icon: "sun",  accent: "#75c82b" },
    { key: "evening", label: "夜盘异动", href: "/",        icon: "moon", accent: "#75c82b" }
  ];

  /* 2026-09-22 起：**夜盘页不再自动更新数据**（按用户要求）。
     页面显示的是一份固定的「收盘快照」——最新一个已完成交易日的收盘口径名单，
     开市期间它不该变（口径本来就是「最新一个已完成的美股交易日」，不是实时行情）。
     所以这里没有任何"取数定时器"：进页面取一次，之后只在**快照换了**的时候才再取一次。

     怎么知道快照换了：低频查 /api/status（很轻，本地接口），比对后端给的
     `snapshot`（basis + sessionDate）。开市期间这个值不动 → 一次数据请求都不会发；
     收盘后后端生成新的收盘快照 → 值变了 → 取一次（每天最多一次）。
     这条检查不放在数据轮询里，正是因为"随时可能变"和"一天最多变一次"是两回事。 */
  /* 心跳间隔。**夜盘进行中要"实时"，心跳就得密** —— 但心跳只查 /api/status（本地、
     极轻），取不取行情由下面的逻辑决定。60 秒足够：后端夜盘每 NIGHT_POLL_SECONDS 才扫一轮。 */
  var STATUS_MS = 60000;
  //: 页头「下次刷新」这类文案已废弃；这里只留一个常量供测试与排查引用
  var LIVE_BASIS = "night_live";

  var state = {
    mode: "live",
    data: null,
    /** 后端给的交易时段对象（market_state()）。null 表示还不知道。 */
    market: null,
    /** 后端给的口径数值（criteria_values()）。null 表示还没拿到 —— 页面要用它分档，
     *  拿不到时页面回落到自己的默认值（见 morning.js 的 bandCfg）。
     *  **只有 /api/status 会给**，晚于首屏数据是正常的，所以页面要能被事后重画一次。 */
    criteriaValues: null,
    /** 当前页面上这份数据的"身份"：basis + sessionDate。变了才重新取数。 */
    snapshotKey: null,
    statusTimer: null,
    onData: null,
    /** 口径数值变化时回调（参数是最近一份数据）。页面用它重画分档。 */
    onCriteria: null
  };

  var $ = function (id) { return document.getElementById(id); };

  // ------------------------------------------------------------ 骨架渲染

  function renderSidebar(activeKey) {
    var host = $("sidebar");
    if (!host) return;
    var items = NAV.map(function (it) {
      // accent 只在选中时生效，写成内联自定义属性交给 CSS 决定怎么用；
      // 仅接受十六进制色值，避免把任意字符串拼进属性里。
      var style = /^#[0-9a-f]{3,8}$/i.test(it.accent || "")
        ? ' style="--icon-accent:' + it.accent + '"' : "";
      return '<a class="nav-item' + (it.key === activeKey ? " on" : "") +
        '" href="' + it.href + '"' + style + '>' + Icons.get(it.icon) +
        '<span class="nav-text">' + U.esc(it.label) + '</span></a>';
    }).join("");
    host.innerHTML =
      '<div class="brand">' +
        /* 站点标：整个页面最左上角。用 <img> 而不是 CSS 背景图 —— 背景图在
           打印 / 右键另存时不会跟着走，而这是全站唯一的品牌资产，值得是个真元素。
           width/height 写在标签上（不只是 CSS）：图还没解码完时侧栏也不会先塌一下再跳。
           —— 2026-09-22 按用户要求加。 */
        '<img class="brand-logo" src="logo.png" alt="' + U.esc(SITE.name) + '" width="38" height="38">' +
        '<div class="brand-tx">' +
          /* 站点名：**一整段纯文字**（2026-09-22 按用户要求从"三字三种处理"改回常规）。
             曾经拆成 .bd / .bn / .bo 三个 span 做过金-蓝分色 + 第三字白底黑描边，
             现在退回单色 + 系统字体。
             ⚠️ 别再按字位拆 span —— 拆了就又要靠"站点名正好 3 个字"这个隐含前提，
             改个名字就会静默错位；纯文字没有这个约束。
             需要重新上分色时的取值与踩过的坑见 README「站点标」一节。 */
          '<div class="brand-mark">' + U.esc(SITE.name) + "</div>" +
          '<div class="brand-sub">' + U.esc(SITE.tagline) + "</div>" +
        "</div>" +
      "</div>" +
      '<nav class="nav">' + items + "</nav>";
  }

  var DOT_BADGE = '<span class="badge"><span class="dot" id="mktDot"></span><span id="mktLabel">—</span></span>';

  function renderHeader(title, mode) {
    var host = $("pageHeader");
    if (!host) return;
    var badges;
    // 「数据源」徽章已去掉（2026-09-22 按用户要求，两个页面都是）。
    // 它是给开发排查用的内部信息，不是读者看盘需要的东西：
    // 早盘页显示的是技能名（us-stock-daily-review），夜盘页更是恒为「—」（接口没给这个字段）。
    // 数据来源现在只存在于接口返回里（页面上的页脚也已去掉），排障时直接看 /api/morning。
      if (mode === "daily") {
        // 「重新读取」按钮与「读取时间」徽章都已去掉（2026-09-22 按用户要求）。
        // 时间只保留「生成时间」—— 它是**真实值**（数据文件实际被写出的那一刻，
        // 来自 meta.generatedAt），而"每日 06:30"只是个名义上的课表时刻；
        // 正常情况下两者相差几分钟，留着两个几乎一样的数字只会让人犹豫该信哪个。
        // 想拿最新数据就重新加载页面（或等 06:30 的定时任务写入后重开）。
        badges = DOT_BADGE +
          '<span class="badge">复盘交易日 <b id="tradeDate">—</b></span>' +
          '<span class="badge">生成时间 <b id="genTime">—</b></span>';
      } else {
      badges = DOT_BADGE +
        // 「数据」= 这份快照代表哪个交易日的什么口径（收盘 / 盘中）。**没有倒计时** ——
        // 页面本来就不再自动更新了，显示"下次刷新"只会误导。
        '<span class="badge">数据 <b id="snapshotLabel">—</b></span>' +
        '<span class="badge">取数时间 <b id="dataTime">—</b></span>' +
        '<button id="btnRefresh" class="primary">立即刷新</button>';
    }
    host.innerHTML =
      '<div class="top-left"><h1>' + U.esc(title) + '</h1></div>' +
      '<div class="badges">' + badges + '</div>';
    document.title = title + " · " + SITE.name;
  }

  // ------------------------------------------------------------ 页头状态

  /** 市场状态徽章由 /api/status 驱动，两种模式共用 */
  function renderMarket(m) {
    var dot = $("mktDot"), label = $("mktLabel");
    if (dot) dot.className = "dot " + (m.open ? "live" : "off");
    var txt = m.label || "—";
    if (!m.open && m.nextChangeEt) {
      txt += " · 下次开市 " + new Date(m.nextChangeEt).toLocaleString("zh-CN", { hour12: false });
    }
    if (label) label.textContent = txt;
  }

  /** 记录并渲染后端给的交易时段。这里**只更新徽章** —— 不再有任何"因为开盘/休市
   *  而切换取数定时器"的逻辑，因为夜盘页已经完全不自动取数了（见文件上方说明）。
   *  两条来源都会调它：`/api/status` 与 `/api/movers` 的 meta。 */
  function setMarket(m) {
    if (!m) return;
    state.market = m;
    renderMarket(m);
  }

  /** 快照身份：basis + sessionDate。用字符串比较，变了才重取。 */
  function snapKey(o) {
    if (!o) return null;
    return String(o.basis || "?") + "@" + String(o.sessionDate || "?");
  }

  function loadStatus() {
    return fetch("/api/status", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j) return;
        if (j.market) setMarket(j.market);
        /* 口径数值要单独盯一眼：首屏数据可能先到（/api/morning 与 /api/status 是两个
           并行请求，回来顺序不保证），此时页面已经按默认阈值画完了分档。
           等真值到了如果和之前不一样，就让页面重画一次 —— 否则改了
           BIG_MIN_CAP_USD 会出现「说明文字变了、分档没变」的静默不一致。 */
        if (j.criteriaValues) {
          var changed = JSON.stringify(state.criteriaValues) !== JSON.stringify(j.criteriaValues);
          state.criteriaValues = j.criteriaValues;
          if (changed && state.onCriteria && state.data) state.onCriteria(state.data);
        }
        if (state.mode !== "live") return;
        var snap = j.snapshot || {};
        /* 按钮可用性跟着心跳走：夜盘 08:00 开始那一刻会自动亮起来，
           16:00 收盘后自动灰掉 —— 不必让用户重新打开页面。 */
        paintRefreshBtn(snap.inSession);

        /* 取不取数，分两种情况（2026-09-22 口径换成夜盘后重写）：
             · 夜盘**进行中** → 每次都取。后端每 NIGHT_POLL_SECONDS 扫一轮，数字在动，
               心跳就该跟着取 —— 否则页面会冻在进页面那一刻。
               （注意：不能只比"快照身份变没变" —— 场内 basis 和 sessionDate 都不变，
                身份没变但数据一直在变，那样比会让页面永远不刷新。）
             · 夜盘**已收盘** → 只在换了场次时取一次，之后一动不动。 */
        if (snap.inSession) { fetchLive(false); return; }

        var k = "close|" + (snap.sessionDate || "?");
        if (state.snapshotKey && k !== state.snapshotKey) fetchLive(false);
        state.snapshotKey = k;
      })
      .catch(function () { /* 状态拉不到不影响正文，静默 */ });
  }

  /* ------------------------------------------------------------------ 不自动取数
     **夜盘页没有任何取数定时器**（2026-09-22 按用户要求）。

     上一版是"常规时段每 20 秒轮询一次"，理由是"开市中行情在变"。但那份数据本身就与
     页面的口径矛盾：夜盘异动的口径是「最新一个已完成的美股交易日」，而开市期间抓到的是
     **当日盘中**的涨跌幅 —— 同一只票 10:15 涨 4%、收盘可能跌 2%，那份名单随时作废。
     所以现在改成：数据只在**报价定型之后**取（后端负责，见 refresh_loop），
     页面只负责显示这份快照，并在它换掉之后再取一次。

     唯一的"定时"是这个低频状态检查：它不取行情（/api/status 纯本地、极轻），
     只回答两个问题 —— 市场现在什么状态、后端手上那份快照还是不是原来那份。
     两个答案都没变，就一个请求都不发。 */
  function applyStatusWatch() {
    if (state.mode !== "live") return;
    if (state.statusTimer) return;      // 已经在看，别叠第二个
    state.statusTimer = setInterval(loadStatus, STATUS_MS);
  }

  /** 「立即刷新」按钮什么时候可用：**只在夜盘进行中**（2026-09-23 按用户要求）。
   *
   *  为什么非夜盘要禁掉：这一页在场外显示的是**冻结的收盘快照**，手动刷新也拿不到
   *  新东西 —— 那一场夜盘的收盘价早就定型了。按钮亮着会让人以为"点一下有新数据"，
   *  点完发现数字纹丝不动，反而怀疑是坏了。灰掉 + 光标 + 悬停提示，一次说清。
   *
   *  ⚠️ **未知时保持可用**（传 undefined 不置灰）：`/api/status` 拿不到时状态是未知的，
   *  那种情况下把唯一的手动入口也锁死，就真的没有任何补救手段了 ——
   *  宁可让人多试一次，也不要"因为探测失败所以彻底锁死"。
   *  所以判据是 `inSession !== false`（只有**明确**是场外才灰），不是 `=== true`。
   */
  function paintRefreshBtn(inSession) {
    var b = $("btnRefresh");
    if (!b) return;                     // daily 模式没有这个按钮
    var usable = inSession !== false;
    b.disabled = !usable;
    b.title = usable
      ? "立刻取一轮当前夜盘行情"
      : "夜盘已收盘：本页显示的是一份冻结的收盘快照，非夜盘时间无需刷新";
  }

  /** 页头「数据」徽章：说清这份数据**是什么**，而不是"下次什么时候刷"。
   *  这是本次改动的重点之一 —— 页面不再自己变，读者更需要知道手上的数字截止到哪。 */
  function renderSnapshotBadge(meta) {
    var el = $("snapshotLabel");
    if (!el) return;
    /* 注意层级：sessionDate 在 meta.snapshot 里，**不在 meta 上** ——
       早先这里写成 meta.sessionDate，条件恒假，徽章永远显示「—」（用例抓到的）。 */
    var snap = (meta && meta.snapshot) || {};
    var sess = snap.sessionDate;
    if (!sess) { el.textContent = "—"; return; }
    var d = String(sess).split("-");
    var day = d.length === 3 ? (+d[1] + "月" + +d[2] + "日") : sess;

    /* 口径是**夜盘**（美东 20:00–04:00 = 北京 08:00–16:00），两种状态：
         night_live  —— 夜盘进行中，数字在动
         night_close —— 夜盘已收盘，这一份冻结不动（非夜盘时间一直显示它）
       旧的 close / intraday 文案已随口径更换废弃（2026-09-22）。 */
    if (snap.basis === "night_live") {
      el.textContent = "夜盘 " + day + " 实时";
    } else if (snap.basis === "night_close") {
      el.textContent = "夜盘 " + day + " 收盘";
    } else {
      el.textContent = day + "（未知口径）";
    }
  }

  function renderNotice(meta) {
    var msgs = [];
    if (meta.errors && meta.errors.length) {
      msgs.push("部分分组取数失败：" + meta.errors.join("；"));
    }
    /* 两句话必须说清，否则读者会以为"页面卡住了"：
       ① 开市期间不动是**设计如此**，不是坏了；
       ② 手上这份若不是收盘口径，得讲明白它是什么、什么时候会变成收盘口径。 */
    var snap = meta.snapshot || {};
    var when = snap.closeCst ? "（北京 " + snap.closeCst + " 收盘）" : "";
    if (snap.basis === "night_live") {
      msgs.push("夜盘开市中，本页按固定间隔自动刷新 —— 数字是夜盘实时行情。"
        + "收盘后会自动冻结成当场的收盘快照。");
    } else if (snap.basis === "night_close") {
      msgs.push("本页显示的是最近一次夜盘收盘的固定快照" + when
        + "，在下一场夜盘开始前不会变 —— 夜盘异动的口径是按夜盘价算的，"
        + "白天（美股常规时段）看到的涨跌幅与它无关。想手动取一轮，点右上角「立即刷新」。");
    }
    if (snap.basis && snap.current === false && snap.sessionDate) {
      msgs.push("注意：手上这份是 " + snap.sessionDate + " 那一场的，不是最新一场"
        + "（可能是服务刚起来、或域缓存还没建好）。");
    }
    setNotice(msgs);
  }
  function setNotice(msgs, cls) {
    var el = $("notice");
    if (!el) return;
    if (!msgs.length) { el.style.display = "none"; el.className = "panel"; return; }
    el.style.display = "";
    el.className = "panel" + (cls ? " " + cls : "");
    el.innerHTML = msgs.map(U.esc).join("<br>");
  }

  function showError(msg) {
    var el = $("notice");
    if (!el) return;
    el.style.display = "";
    el.className = "panel err";
    el.textContent = msg;
  }

  // ------------------------------------------------------------ 取数

  /** 拿数中标志。心跳 60 秒一跳，而一轮取数可能更久 —— 不加保护会叠出并发请求。 */
  var liveFetching = false;

  /** live 模式：行情接口；force=true 时走 /api/refresh 强制重抓 */
  function fetchLive(force) {
    if (liveFetching) return;
    liveFetching = true;
    var url = force ? "/api/refresh" : "/api/movers";
    return fetch(url, { cache: "no-store" })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (!res.body || !res.body.meta) return;
        var meta = res.body.meta;
        state.data = res.body;
        /* 交易时段以 /api/status 为准，但每份行情也自带一份 ——
           用它兜底，这样即使状态接口出问题，也不会一直按错误的时段跑。
           setMarket 只在状态翻转时才动定时器（休市 → 停轮询，开盘 → 启轮询）。 */
        setMarket(meta.market);
        /* 记下这份数据的身份：下游的 loadStatus 靠它判断"后端是否已经换了新快照"。
           必须在调 onData 之前写，否则页面还没画、状态检查就来了会重复取数。 */
        var s2 = meta.snapshot || {};
        /* 行情自带快照身份与 inSession —— 用它先画一次按钮。首屏时它通常比
           /api/status 先到，不画的话按钮会停在"未知"态（可用），
           场外进来会看到几秒的亮按钮。 */
        state.snapshotKey = (s2.inSession ? "live" : "close") + "|" + (s2.sessionDate || "?");
        paintRefreshBtn(s2.inSession);
        renderSnapshotBadge(meta);
        /* 取数时间：接口给的 fetchedAtEt 就是「这份数据对应的美东时刻」。
           原本这个徽章一直显示「—」—— 声明了 <b id="dataTime"> 却没人赋值，
           看着像坏了；这里补上（只取到分钟，秒级对看盘没意义）。 */
        var dt = $("dataTime");
        if (dt) dt.textContent = meta.fetchedAtEt
          ? String(meta.fetchedAtEt).slice(0, 16) + " ET" : "—";
        renderNotice(meta);
        if (state.onData) state.onData(res.body);
        if (!res.ok) showError(res.body.message || "数据尚未就绪");
      })
      .catch(function (e) { showError("无法连接后端服务：" + e.message); })
      /* ⚠️ 这个复位**必须有**：上面成功分支里有一处提前 return（body/meta 缺失），
         只在成功路径末尾复位会漏掉它 —— 标志一旦卡在 true 就永久不再取数，
         页面看着正常，其实再也不会更新。用 finally 覆盖所有出口。 */
      .finally(function () { liveFetching = false; });
  }

  /** daily 模式：只读当天那份复盘 JSON，不做任何抓取 */
  function fetchDaily() {
    return fetch("/api/morning", { cache: "no-store" })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        var body = res.body || {};
        state.data = body;
        var meta = body.meta || {};
        var td = $("tradeDate");
        if (td) td.textContent = meta.tradeDateLabel || meta.tradeDate || "—";
        var gt = $("genTime");
        if (gt) gt.textContent = meta.generatedAt
          ? new Date(meta.generatedAt).toLocaleString("zh-CN", { hour12: false }) : "—";

        var msgs = [];
        if (!body.ok) {
          msgs.push(body.message || "复盘数据尚未生成。");
        }
        if (meta.stale) {
          msgs.push("这份复盘不是最新交易日的（数据日期 " + (meta.tradeDate || "—")
            + "），自动更新可能没有成功，请检查定时任务。");
        }
        // 原「数据说明」块（渲染 meta.notes）已于 2026-09-22 按用户要求从早盘页移除。
        // 那几条是生成时的自我说明（首次手动生成 / 指数走 ETF 代理 / finviz 取数局限），
        // 属于生成过程的旁注，不是读者看盘需要的信息。
        // 同一天稍后，页脚的数据来源 / 生成方式也是按同一理由去掉的。
        // meta.notes 字段仍保留在 data/morning.json 与 MORNING.md 的数据契约里，
        // 定时任务写入的排障信息不会丢，想放回来只需恢复 msgs = msgs.concat(meta.notes)。
        setNotice(msgs, body.ok ? "" : "warn");

        if (state.onData) state.onData(body);
      })
      .catch(function (e) { showError("无法连接后端服务：" + e.message); });
  }

  // ------------------------------------------------------------ 挂载

  function mount(opts) {
    opts = opts || {};
    state.mode = opts.mode === "daily" ? "daily" : "live";
    state.onData = opts.onData || null;
    state.onCriteria = opts.onCriteria || null;
    // 重挂载时清掉上一页的口径缓存，避免 A 页拿到 B 页残留的值
    state.criteriaValues = null;

    renderSidebar(opts.navKey);
    renderHeader(opts.title || SITE.name, state.mode);
    loadStatus();

    if (state.mode === "daily") {
      // 这里原有一行 `$("btnRefresh").addEventListener(...)` 给「重新读取」按钮挂事件。
      // 按钮已随读取时间徽章一起移除 —— **这行必须同时删掉**：
      // 元素不存在时 $() 返回 null，addEventListener 立刻抛 TypeError，
      // mount() 会在这里中断，后面的 fetchDaily() 根本不会执行，页面就只剩空壳。
      // （同类坑本项目已踩过两次：删页脚 footMeta、删「只看非美国本土公司」勾选。）
      state.statusTimer = setInterval(loadStatus, STATUS_MS);   // 只刷市场状态徽章，不重读数据
      fetchDaily();
      return;
    }

    $("btnRefresh").addEventListener("click", function () {
      /* 置灰时浏览器本就不会派发 click，这里再挡一道 —— 防的是
         "样式/属性没生效但按钮其实还能点"这类错位：用户看到的是灰按钮，却真的刷新了。 */
      if (this.disabled) return;
      fetchLive(true);
    });
    // 没有「暂停自动」按钮了：本来就没有东西在自动跑，留个按钮只会让人以为有。
    // 也没有取数定时器 —— 只在进页面时取一次，之后靠 loadStatus 发现"快照换了"再取。
    applyStatusWatch();

    fetchLive(false);
  }

  w.Shell = {
    SITE: SITE,
    mount: mount,
    state: state,
    /** 当前页面手上这份数据的身份（basis@sessionDate）。测试与排查用。 */
    snapshotKey: function () { return state.snapshotKey; },
    /** 后端口径的数值版。拿不到时返回 null，调用方自己回落到默认值 ——
     *  这里**不要**替调用方兜默认值：默认值属于「分档」这件事的知识，
     *  该由用它的页面（morning.js）持有，壳只负责转达后端说了什么。 */
    criteriaValues: function () {
      return state.criteriaValues;
    }
  };
})(window);
