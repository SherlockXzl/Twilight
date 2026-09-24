/* 夜盘异动 —— 分档表格页。外壳（菜单/页头/轮询）由 shell.js 提供。 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  /* 标签页记忆（2026-09-22 按用户要求）：选中「所有 / 大市值 / 小市值」后切去「早盘总结」、
     再切回「夜盘异动」，应该还停在上次那一档，而不是被重置回「所有」。
     与早盘页同一套做法（见 morning.js 的 TAB_STORE）：用 localStorage 而不是 URL hash ——
     左侧菜单的链接指向 `/`（不带 hash），跨页跳转时 hash 根本不会跟过来，只有存储能"记得"。
     存的是 **key 而不是下标**：以后调整分档顺序也不会串档。 */
  var TAB_STORE = "evening.tab";

  /* 上次选中的标签。这里**只取值，不判断这一档此刻还有没有** ——
     夜盘的分档是后端决定的（SHOW_DOWN=0 时压根没有「跌」两档，某一档当天为空时
     整个键也可能不在 tables 里），要等第一份数据到了才知道哪些标签存在。
     所以"存下来的标签是否还有效"由 onData 里已有的那条回落统一兜住（见 onData 注释）。
     取不到、或存储不可用（隐私模式）时回落到「所有」。 */
  function savedTab() {
    try {
      var v = localStorage.getItem(TAB_STORE);
      if (v) return v;
    } catch (e) { /* localStorage 被禁用：当作没有记忆 */ }
    return "all";
  }

  function rememberTab(key) {
    try { localStorage.setItem(TAB_STORE, key); } catch (e) { /* 存不了就算了 */ }
  }

  var state = { tab: savedTab(), q: "", sector: "", industry: "", reasons: {} };

  //: 分档的固定顺序与名称。实际出几个标签页由**后端返回的 tables 决定** ——
  //: 后端关掉下跌档（SHOW_DOWN=0）时，这里不会凭空造出「跌」的标签。
  var TAB_ORDER = ["big_up", "big_down", "mid_up", "mid_down"];
  var TAB_LABEL = {
    big_up: "大市值 · 涨", big_down: "大市值 · 跌",
    mid_up: "小市值 · 涨", mid_down: "小市值 · 跌"
  };

  function data() { return Shell.state.data; }

  /** 当前可用的标签页：固定的「所有」+ 后端实际返回的分档 */
  function activeTabs() {
    var t = (data() && data().tables) || {};
    var out = [{ key: "all", label: "所有" }];
    TAB_ORDER.forEach(function (k) {
      if (t[k]) out.push({ key: k, label: TAB_LABEL[k] });
    });
    return out;
  }

  // ------------------------------------------------------------ 渲染

  function renderCriteria(meta) {
    var c = meta.criteria || {};
    $("criteriaLine").innerHTML =
      "大市值：" + U.esc(c.big || "—") + " ｜ 小市值：" + U.esc(c.mid || "—") + " ｜ " + U.esc(c.tiny || "—");
  }

  function tabButtons() { return $("tabs").querySelectorAll(".tab"); }

  /* 选中态（.on）只由这里涂 —— 点击时涂一次、数据刷新重建 DOM 后再涂一次。
     原先是在 renderTabs 拼 HTML 时把 on 写死在字符串里，**点击时没人重涂**：
     点「大市值」表格确实换成了 7 条，但高亮仍停在「所有」上，
     要等下一轮行情刷新（onData → renderTabs）才会纠正。
     而前端现在**任何时段都不轮询**（见 shell.js 的「不自动取数」一节），
     这一步纠正永远不会到来 —— 页面上就表现成「点了没反应」。
     （2026-09-22 修：把"写死在字符串里"改成"照着 state.tab 统一涂"。） */
  function paintTabs() {
    Array.prototype.forEach.call(tabButtons(), function (b) {
      b.classList.toggle("on", b.getAttribute("data-tab") === state.tab);
    });
  }

  function renderTabs(counts) {
    $("tabs").innerHTML = activeTabs().map(function (t) {
      var n = t.key === "all" ? (counts.total || 0) : (counts[t.key] || 0);
      return '<button class="tab" data-tab="' + t.key + '">' + U.esc(t.label) +
             '<span class="n">' + n + '</span></button>';
    }).join("");
    paintTabs();
    Array.prototype.forEach.call(tabButtons(), function (b) {
      b.addEventListener("click", function () {
        var k = b.getAttribute("data-tab");
        if (state.tab === k) return;          // 点的就是当前标签，不必重绘
        state.tab = k;
        rememberTab(k);                       // 记下来，跳去别的页面再回来还停在这一档
        paintTabs();                          // ← 立刻反馈，不等下一轮刷新
        renderBody();
      });
    });
  }

  /** 「所有」标签页：把当前可用的分档表合并，按涨幅降序（最猛的排最前） */
  function allRows() {
    var d = data();
    if (!d || !d.tables) return [];
    var out = [], seen = {};
    TAB_ORDER.forEach(function (k) {
      if (!d.tables[k]) return;          // 该分档未启用
      (d.tables[k].rows || []).forEach(function (r) {
        if (seen[r.symbol]) return;      // 同代码只保留首次出现的分档
        seen[r.symbol] = true;
        // 只读渲染，直接引用即可 —— 原先这里拷贝一份是为了挂 _band 标记，
        // 那个标记随「分档」列一起删掉了（分档信息由上方标签页承担）。
        out.push(r);
      });
    });
    out.sort(function (a, b) { return b.chg - a.chg; });
    return out;
  }

  function filterRows(rows) {
    var q = state.q.trim().toLowerCase();
    return rows.filter(function (r) {
      if (state.sector && (r.sector || "") !== state.sector) return false;
      if (state.industry && (r.industry || "") !== state.industry) return false;
      if (!q) return true;
      // 中文与英文原名都可命中（板块/行业展示中文，英文存于 *En 字段）
      return [r.symbol, r.name, r.sector, r.industry, r.sectorEn, r.industryEn]
        .join(" ").toLowerCase().indexOf(q) >= 0;
    });
  }

  /* ------------------------------------------------------------------ 筛选器
     板块 / 行业两个带搜索的下拉（组件见 combo.js）。三个设计决定：

     1. **选项从当前数据里实际出现的值生成**，而不是列出 taxonomy_zh 的全部
        11 板块 + 151 行业 —— 后者绝大多数的选项选了就是空表，属于死选项。
        选项文案带计数（「信息技术 (3)」），但**计数不参与搜索匹配**，
        否则搜「3」会命中所有计数为 3 的项。
     2. **选项取自 allRows()（全部标签页的并集）**，不是当前标签页。
        否则切标签页时下拉内容会变、已选值会被清掉，很跳。
        代价是某个板块在当前标签页下可能 0 条 —— 这时 rowInfo 会显示
        「显示 0 条 / 该分档共 N 条」，能看出是筛选造成的，不是数据缺失。
     3. **行业与板块联动**：选了板块后，行业下拉只列该板块下的行业。

     行情每 60 秒刷一次，榜单会变，所以重建选项时必须**保留仍然有效的已选值**，
     失效才回落（下面两处 findOpt 判断）。 */
  function renderFilters() {
    var rows = allRows();

    /** 收集去重选项：{value, name, en, count}。
     *  en 取该中文名下第一次出现的英文原名，供搜索用（输入 semi 能命中「半导体」）。 */
    function collect(key, enKey, withinSector) {
      var seen = {}, out = [];
      rows.forEach(function (r) {
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

    var secs = collect("sector", "sectorEn");
    if (state.sector && !findOpt(secs, state.sector)) state.sector = "";

    var inds = collect("industry", "industryEn", state.sector);
    if (state.industry && !findOpt(inds, state.industry)) {
      state.industry = "";
      inds = collect("industry", "industryEn", state.sector);
    }

    Combo.get("sectorSel").setOptions(secs, state.sector);
    Combo.get("industrySel").setOptions(inds, state.industry);
  }

  function findOpt(list, v) {
    for (var i = 0; i < list.length; i++) if (list[i].value === v) return true;
    return false;
  }

  /* 两个下拉在初始化时就建好，之后只更新选项 ——
     每次刷新都重建 DOM 会丢掉焦点与展开状态（行情 60 秒一刷，很扰人）。 */
  function initFilters() {
    Combo.create($("sectorSel"), {
      allLabel: "全部板块", placeholder: "输入板块名筛选…",
      onChange: function (v) {
        state.sector = v;
        state.industry = "";   // 换了板块，原行业多半不属于新板块，先清掉再重建
        renderFilters();
        renderBody();
      }
    });
    Combo.create($("industrySel"), {
      allLabel: "全部行业", placeholder: "输入行业名筛选…",
      onChange: function (v) { state.industry = v; renderBody(); }
    });
  }

  /* 「驱动原因」列的数据：GET /api/reasons（服务端只读 data/reasons.json + 最近一份
     早盘复盘的 driver），口径与早盘页「个股异动榜 · 驱动原因」完全一致 —— 都是分析后的一句话。
     原因比行情变得慢得多，只在进页面时取一次，不跟着 60 秒的行情轮询走。 */
  function loadReasons() {
    return fetch("/api/reasons", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        state.reasons = (j && j.reasons) || {};
        renderBody();
        renderExcluded();
      })
      .catch(function () { /* 拿不到就整列显示「待确认」，不影响行情表 */ });
  }

  /** 该代码在原因文件里的原始条目。 */
  function entryOf(symbol) {
    return state.reasons[(symbol || "").toUpperCase()] || null;
  }

  /** 「驱动原因」列要的条目：**必须有 driver**。 */
  function reasonOf(symbol) {
    var r = entryOf(symbol);
    return (r && r.driver) ? r : null;
  }

  /* 「A 股映射」列要的条目：必须有非空的映射候选。
     ⚠️ 与 driver 分开判断，不要合并成一个检查：aShareMap 是独立字段，
     某条完全可能只有原因没有映射（正常，映射是后补的、更慢的产物），
     那时原因列照常显示，映射按钮显示成「未分析」态。 */
  function mapOf(symbol) {
    var r = entryOf(symbol);
    var m = r && r.aShareMap;
    return (m && m.rows && m.rows.length) ? m : null;
  }

  /** A 股映射列的按钮 —— 生成逻辑在 sharemap.js（那一列的渲染器），这里只做取数。 */
  function mapBtn(symbol, name) {
    return ShareMap.button(symbol, name, mapOf(symbol));
  }

  /** 点开某只票的 A 股映射弹窗。
   *  内容由 sharemap.js 渲染 —— 把「数据 → HTML」抽出去是为了能单独单测，
   *  也为了早盘页将来要用时不必复制一遍。 */
  function openMap(symbol, name) {
    var r = entryOf(symbol);
    var m = mapOf(symbol);
    Modal.open({
      title: (name ? name + "（" + symbol + "）" : symbol) + " · A 股映射",
      subtitle: m ? "共 " + m.rows.length + " 只候选 · 按关联强度排序"
                  : "尚未生成",
      // 驱动原因作为「映射依据」回显在弹窗顶部 —— skill 的输入就是它
      bodyHtml: ShareMap.render(m, { driver: r ? r.driver : "" })
    });
  }

  /* 列与早盘页「个股异动榜」对齐：代码/公司全称/价格/涨跌幅/总市值/板块/行业 + 驱动原因，
     再加夜盘独有的「A 股映射」（早盘页还没有这一列，见 README）。
     原先的最后两列（「分档」药丸、「查原因」外链）已去掉 —— 分档信息由上方标签页承担，
     原因改成一整句话直接写出来，与早盘页同一口径。
     「国家」列也去掉了（用户 2026-09-22 要求）：宽屏下每列更宽松。
     与之配套的「只看非美国本土公司」勾选也一并去掉 —— 判断依据那一列不显示了，
     留着一个看不见依据的过滤器只会让人以为数据缺失。

     「A 股映射」放在驱动原因**之后**：阅读顺序是「涨了多少 → 为什么涨 → 这逻辑对应 A 股谁」，
     反过来的话读者要先看到结果再去找依据。 */
  function tableHtml(rows) {
    if (!rows.length) return '<div class="empty">当前筛选条件下没有数据</div>';
    var head = "<tr><th>代码</th><th>公司全称</th><th class=\"num\">价格(USD)</th>" +
               "<th class=\"num\">涨跌幅</th><th class=\"num\">总市值(亿美元)</th>" +
               "<th>板块</th><th>行业</th><th>驱动原因</th><th class=\"map\">A 股映射</th></tr>";
    var body = rows.map(function (r) {
      var dir = U.dirClass(r.chg);
      var reason = reasonOf(r.symbol);
      var whyTitle = reason
        ? (reason.from === "morning" ? "来自早盘复盘 " : "来自夜盘原因文件 ")
          + (reason.tradeDate || "—")
        : "暂无分析结果";
      return "<tr>" +
        '<td class="code">' + U.esc(r.symbol) + "</td>" +
        '<td class="name">' + U.esc(r.name) + "</td>" +
        '<td class="num">' + U.fPrice(r.price) + "</td>" +
        '<td class="num"><span class="chg ' + dir + '">' + U.fPct(r.chg) + "</span></td>" +
        '<td class="num">' + U.fCap(r.marketCap) + "</td>" +
        '<td class="sec" title="' + U.esc(r.sectorEn || "") + '">' + U.esc(r.sector || "—") + "</td>" +
        '<td class="ind" title="' + U.esc(r.industryEn || "") + '">' + U.esc(r.industry || "—") + "</td>" +
        '<td class="why" title="' + U.esc(whyTitle) + '">' +
          U.esc(reason ? reason.driver : "待确认") + "</td>" +
        '<td class="map">' + mapBtn(r.symbol, r.name) + "</td>" +
        "</tr>";
    }).join("");
    return '<div class="tblwrap"><table class="t-evening"><thead>' + head + "</thead><tbody>" + body + "</tbody></table></div>";
  }

  function renderBody() {
    var d = data();
    if (!d || !d.tables) return;
    var isAll = state.tab === "all";
    var base = isAll ? allRows() : ((d.tables[state.tab] && d.tables[state.tab].rows) || []);
    var rows = filterRows(base);
    $("rowInfo").textContent = "显示 " + rows.length + " 条 / " +
      (isAll ? "全部共 " : "该分档共 ") + base.length + " 条";
    $("tableHost").innerHTML = tableHtml(rows);
  }

  function renderExcluded() {
    var d = data();
    if (!d || !d.excluded || !d.excluded.length) { $("exclPanel").style.display = "none"; return; }
    $("exclPanel").style.display = "";
    $("exclSummary").textContent = "被“市值 ≤ 15 亿美元”门槛剔除的异动（"
      + d.excluded.length + " 条" + (d.excludedTruncated ? "，仅显示前 40 条" : "") + "，仅供对照）";
    $("exclHost").innerHTML = tableHtml(d.excluded);
  }

  function onData(d) {
    if (!d.meta) return;
    /* 后端可能关掉了某些分档（SHOW_DOWN=0）或某档这次一条都没有；
       当前选中项若已失效，回落到「所有」。这条也是**标签记忆的兜底**：
       savedTab() 只取值不判有效性，存下来的 key 到这一步才第一次被核对。
       注意回落时**不写回存储** —— 让 storage 保留用户原本的偏好：
       分档只是这一次没返回（取数抖动、或某天该档为空），下次回来还能自动恢复；
       写回「所有」等于把这个偏好悄悄抹掉了。 */
    if (state.tab !== "all" && !(d.tables && d.tables[state.tab])) state.tab = "all";
    renderCriteria(d.meta);
    renderTabs(d.counts || {});
    renderFilters();     // 必须早于 renderBody：板块/行业失效时会在这里回落
    renderBody();
    renderExcluded();
  }

  $("q").addEventListener("input", function () { state.q = this.value; renderBody(); });

  /* 「A 股映射」按钮 —— **事件委托**，不逐个绑定。
     表格每次行情刷新都整块重建（夜盘中 3~4 分钟一次），逐个绑监听会越绑越多，
     内存和响应都会慢慢退化。页里的分页器出于同样理由用了委托（见 linkage.js）。
     两个 host 都要挂：主表和被剔除对照表用的是同一个 tableHtml，按钮形态一致，
     少挂一个会出现"这儿的按钮点了没反应"。 */
  function bindMapButtons(hostId) {
    var host = $(hostId);
    if (!host) return;
    host.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest(".map-btn") : null;
      if (!b) return;
      openMap(b.getAttribute("data-sym"), b.getAttribute("data-name"));
    });
  }
  bindMapButtons("tableHost");
  bindMapButtons("exclHost");

  initFilters();     // 下拉先建好；选项由首轮 renderFilters() 填
  Shell.mount({ navKey: "evening", title: "夜盘异动", onData: onData });
  loadReasons();     // 原因只在进页面时取一次，不跟着行情轮询
})();
