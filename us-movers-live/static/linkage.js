/* 明暗对照 —— 全市场美股目录（代码 / 公司全称 / 板块 / 行业）。
 *
 * 这一页的定位：**不展示任何行情**。它只回答「这个代码是哪家公司、归哪个板块/行业」，
 * 给另两页看到陌生代码时提供一个查归属的地方 —— 所以表格只有四列，
 * 与「个股异动榜」的前四列同源同义，把价格/涨跌幅/市值/驱动原因全留给行情页。
 *
 * 数据由 /api/us-catalog 提供（服务端只读 data/us_catalog.json，不联网、不重抓）。
 * 目录十天半月才重建一次，所以页壳用 catalog 模式：不挂刷新按钮、不轮询行情，
 * 页面自己取一次就够（见 shell.js 的 mount）。
 *
 * 板块/行业的**中文翻译由服务端给**（它与另两页共用 taxonomy_zh，改译名不用重跑抓取），
 * 前端只负责展示；英文原名在接口的 sectorEn / industryEn 里，用作列的 title 与下拉搜索词。
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  //: 每页条数。全量 4279 只一屏滚不完，也没必要 —— 100 条既让「翻着看」有实感，
  //: 页数也不至于太多（43 页）。真要找某家公司，搜索比翻页快得多。
  var PAGE_SIZE = 100;

  var state = { q: "", sector: "", industry: "", rows: [], meta: null, page: 1, biz: {} };

  // ------------------------------------------------------------ 过滤

  function filterRows() {
    var q = state.q.trim().toLowerCase();
    return state.rows.filter(function (r) {
      if (state.sector && (r.sector || "") !== state.sector) return false;
      if (state.industry && (r.industry || "") !== state.industry) return false;
      if (!q) return true;
      // 中文与英文原名都可命中（列里展示中文，英文存于 *En 字段）
      return [r.symbol, r.name, r.sector, r.industry, r.sectorEn, r.industryEn]
        .join(" ").toLowerCase().indexOf(q) >= 0;
    });
  }

  // ------------------------------------------------------------ 渲染

  /* 「A 股公司业务映射」列的数据：GET /api/us-business-map（按需取，见 loadBizMap）。
     键是美股代码，值形如 { name, business, peers: [...] }。 */
  function bizOf(symbol) {
    return state.biz[(symbol || "").toUpperCase()] || null;
  }

  /** 最后一列的按钮 —— 与夜盘页共用 static/mapbtn.js，只差 title 措辞。 */
  function mapBtn(symbol, name) {
    var e = bizOf(symbol);
    var n = (e && e.peers) ? e.peers.length : 0;
    return MapBtn.html(symbol, name, n, {
      title: "查看 " + n + " 家业务相似的 A 股公司",
      empty: "还没有业务映射数据"
    });
  }

  /** 点开某家公司的业务映射弹窗。
   *  内容由 businessmap.js 渲染（与夜盘页的 sharemap.js 是两套口径，见该文件注释）。 */
  function openBizMap(symbol, name) {
    var e = bizOf(symbol);
    var n = (e && e.peers) ? e.peers.length : 0;
    Modal.open({
      title: (name ? name + "（" + symbol + "）" : symbol) + " · A 股公司业务映射",
      subtitle: n ? "业务相似 " + n + " 家 · 点任意一行展开业务描述" : "尚未生成",
      bodyHtml: BusinessMap.render(e)
    });
  }

  /** 五列：代码 / 公司全称 / 板块 / 行业 / A 股公司业务映射。
   *  表格类名用 t-catalog（不是 t-evening）：单元格样式两者共用，但表宽要单独定 ——
   *  t-evening 的 1560px 是给 8 列行情表算的，套在少列表上每列会被拉到近 400px。 */
  function tableHtml(rows) {
    if (!rows.length) return '<div class="empty">当前筛选条件下没有数据</div>';
    var head = "<tr><th>代码</th><th>公司全称</th><th>板块</th><th>行业</th>" +
               '<th class="map">A 股公司业务映射</th></tr>';
    var body = rows.map(function (r) {
      return "<tr>" +
        '<td class="code">' + U.esc(r.symbol) + "</td>" +
        '<td class="name">' + U.esc(r.name) + "</td>" +
        '<td class="sec" title="' + U.esc(r.sectorEn || "") + '">' +
          U.esc(r.sector || "—") + "</td>" +
        '<td class="ind" title="' + U.esc(r.industryEn || "") + '">' +
          U.esc(r.industry || "—") + "</td>" +
        '<td class="map">' + mapBtn(r.symbol, r.name) + "</td>" +
        "</tr>";
    }).join("");
    return '<div class="tblwrap"><table class="t-catalog"><thead>' + head +
           "</thead><tbody>" + body + "</tbody></table></div>";
  }

  function renderBody() {
    var rows = filterRows();
    var total = rows.length;
    var pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    // 筛选后条数变少，当前页可能被"甩"出范围（比如停在第 30 页时改了下拉）。
    // 这里收回最后一页 —— 否则会渲染出空表，看着像数据没了。
    if (state.page > pages) state.page = pages;
    if (state.page < 1) state.page = 1;

    var start = (state.page - 1) * PAGE_SIZE;
    var pageRows = rows.slice(start, start + PAGE_SIZE);

    $("rowInfo").textContent = total
      ? "第 " + (start + 1) + "–" + (start + pageRows.length) + " 条 / 共 " + total + " 条"
      : "共 0 条";
    $("tableHost").innerHTML = tableHtml(pageRows);
    renderPager(total, pages);
  }

  /** 分页条：首页 + 当前页附近 ±2 + 末页，中间用「…」省掉。
   *  没做「跳转到第 N 页」输入框 —— 43 页的量级，点两下就到了，多一个控件反而碍事。 */
  function renderPager(total, pages) {
    var host = $("pager");
    if (!host) return;
    if (pages <= 1) { host.innerHTML = ""; return; }

    var cur = state.page, nums = [];
    for (var i = 1; i <= pages; i++) {
      if (i === 1 || i === pages || Math.abs(i - cur) <= 2) nums.push(i);
      else if (nums[nums.length - 1] !== "…") nums.push("…");
    }

    var html = '<button class="pg" data-p="' + (cur - 1) + '"' +
               (cur === 1 ? " disabled" : "") + ">上一页</button>";
    nums.forEach(function (n) {
      html += n === "…"
        ? '<span class="pg-gap">…</span>'
        : '<button class="pg' + (n === cur ? " on" : "") +
          '" data-p="' + n + '">' + n + "</button>";
    });
    html += '<button class="pg" data-p="' + (cur + 1) + '"' +
            (cur === pages ? " disabled" : "") + ">下一页</button>";
    html += '<span class="pg-info">每页 ' + PAGE_SIZE + " 条</span>";
    host.innerHTML = html;
  }

  /* ------------------------------------------------------------------ 筛选器
     与「夜盘异动」页同一套（组件见 combo.js），三点做法照搬：

     1. **选项从实际数据里生成**，不列 taxonomy_zh 的全集 —— 选了必定空表的选项没意义。
        文案带计数（「半导体 (172)」），计数不参与搜索匹配。
     2. **行业与板块联动**：选了板块后，行业下拉只列该板块下的行业。
     3. 选项里的 en 取英文原名，这样输入 "semi" 能命中「半导体」——
        这份数据本来就是英文的，用户很可能直接打英文。 */
  function renderFilters() {
    function collect(key, enKey, withinSector) {
      var seen = {}, out = [];
      state.rows.forEach(function (r) {
        if (withinSector && (r.sector || "") !== withinSector) return;
        var v = r[key] || "";
        if (!v) return;
        if (seen[v]) { seen[v].count++; return; }
        var o = { value: v, name: v, en: r[enKey] || "", count: 1 };
        seen[v] = o;
        out.push(o);
      });
      // 中文按拼音、英文按字母 —— 这里数据基本是中文（英文只作匹配词），
      // 所以用 zh 排序规则；纯英文的名单也会自然落到字母序。
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

  /* 两个下拉在初始化时建好，之后只更新选项 —— 每次筛选都重建 DOM 会丢焦点与展开状态。 */
  function initFilters() {
    Combo.create($("sectorSel"), {
      allLabel: "全部板块", placeholder: "输入板块名筛选…",
      onChange: function (v) {
        state.sector = v;
        state.industry = "";   // 换了板块，原行业多半不属于新板块，先清掉再重建
        state.page = 1;        // 换了条件就回第一页，别停在旧页码上
        renderFilters();
        renderBody();
      }
    });
    Combo.create($("industrySel"), {
      allLabel: "全部行业", placeholder: "输入行业名筛选…",
      onChange: function (v) { state.industry = v; state.page = 1; renderBody(); }
    });
  }

  // ------------------------------------------------------------ 分页

  /* 事件挂在一个监听器上（委托），不随分页条重绘而重复绑定 ——
     每次 renderPager 都重建那几个按钮，逐个 addEventListener 会越绑越多。 */
  $("pager").addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest("button.pg") : null;
    if (!b || b.disabled) return;
    var p = parseInt(b.getAttribute("data-p"), 10);
    if (!p || p === state.page) return;
    state.page = p;
    renderBody();
    // 翻页后把表格顶部拉回视野：否则从最后一页点「上一页」，视图仍停在页面底部，
    // 看着像"点了没反应"。
    var host = $("tableHost");
    if (host && host.scrollIntoView) host.scrollIntoView({ block: "start" });
  });

  /* 「A 股公司业务映射」按钮 —— **事件委托**，不逐个绑定。
     表格每次翻页 / 筛选 / 刷新都整块重建，逐个 addEventListener 会越绑越多
     （和上面分页器、以及夜盘页是同一个道理）。 */
  $("tableHost").addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest(".map-btn") : null;
    if (!b) return;
    openBizMap(b.getAttribute("data-sym"), b.getAttribute("data-name"));
  });

  // ------------------------------------------------------------ 取数

  /** 搜索输入防抖：每敲一个字都重过滤 + 重画整张表会明显卡手。
   *  150ms 是「感觉不到延迟」和「不等用户打完一句话」之间的折中。 */
  var qTimer = null;
  $("q").addEventListener("input", function () {
    var v = this.value;
    if (qTimer) clearTimeout(qTimer);
    qTimer = setTimeout(function () { state.q = v; state.page = 1; renderBody(); }, 150);
  });

  function setHeader(count, builtAt) {
    var c = $("catCount"), t = $("catTime");
    if (c) c.textContent = count ? count + " 只" : "—";
    if (t) t.textContent = builtAt || "—";
  }

  function showNotice(msg) {
    var n = $("notice");
    if (!n) return;
    n.style.display = "";
    n.innerHTML = U.esc(msg);
  }

  function load() {
    fetch("/api/us-catalog", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) {
          // 后端如实回报「文件没建」，这里照实说，不要装作加载中 ——
          // 目录是要靠 tools/build_us_catalog.py 生成的外部产物，缺了就该提示去建。
          showNotice((j && j.message) ||
            "美股目录尚未生成。先跑 tools/build_us_catalog.py 生成 data/us_catalog.json。");
          $("tableHost").innerHTML = '<div class="empty">暂无数据</div>';
          return;
        }
        state.rows = j.rows || [];
        state.meta = j;
        setHeader(j.count, j.builtAt);
        renderFilters();     // 必须早于 renderBody：板块/行业失效时会在这里回落
        renderBody();
      })
      .catch(function (e) {
        showNotice("无法读取美股目录：" + ((e && e.message) || "未知错误"));
        $("tableHost").innerHTML = '<div class="empty">加载失败</div>';
      });
  }

  /* 「A 股公司业务映射」列的数据 —— 单独一个接口，**与目录分开取**：
     目录有 4279 行（gzip 后仍约 200KB），而这份映射目前只有几家、几 KB。
     合成一个接口会让每次打开页面都多搬一份用不到的数据。
     映射内容的变化比目录慢得多（加了公司才变），所以进页面取一次即可，
     不跟翻页/筛选走。拿不到就整列灰着，不影响目录表本身。 */
  function loadBizMap() {
    return fetch("/api/us-business-map", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) return;
        state.biz = j.rows || {};
        renderBody();     // 按钮态从"灰"变"可点"，需要重画一次
      })
      .catch(function () { /* 静默：这一列不是页面的主体 */ });
  }

  initFilters();     // 下拉先建好；选项由首轮 renderFilters() 填
  Shell.mount({ navKey: "linkage", title: "明暗对照", mode: "catalog" });
  load();
  loadBizMap();      // 映射只在进页面时取一次
})();
