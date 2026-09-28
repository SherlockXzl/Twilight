/* 明暗对照 —— 全市场美股目录（代码 / 公司全称 / 板块 / 行业 / A 股公司业务映射）。
 *
 * 这一页的定位：**不展示任何行情**。它只回答「这个代码是哪家公司、归哪个板块/行业」，
 * 给另两页看到陌生代码时提供一个查归属的地方 —— 所以前四列与「个股异动榜」的
 * 前四列同源同义，把价格/涨跌幅/市值/驱动原因全留给行情页；第五列是业务对标
 * （与夜盘页那列同名但不是一回事，见 businessmap.js 的注释）。
 *
 * 数据由 /api/us-catalog 提供（服务端只读 data/us_catalog.json，不联网、不重抓）。
 * 目录十天半月才重建一次，所以页壳用 catalog 模式：不挂刷新按钮、不轮询行情，
 * 页面自己取一次就够（见 shell.js 的 mount）。
 *
 * 三个筛选条件：搜索 / 板块+行业 / 只看有 A 股映射（勾选，判据见 hasPeers）。
 * 它们**全部在前端做** —— 4279 行本来就整包在浏览器里，过滤再走一趟服务端
 * 只会多一次往返，还会把「选项计数」这类联动逻辑撕成两半。
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

  /* state 里三个「是否已就绪」的标志值得说明，它们都对应一个会骗人的默认值：

       catalogReady —— 目录到了没有。它在 renderBody 里做了守卫：目录是 202KB、
                        映射是 95KB，两个请求谁先回不确定；映射先回时若直接重画，
                        会用「暂无数据」盖掉页面的「加载中…」，看着像目录空了。
       biz          —— 映射数据（三张引用表）。null = 没拿到，非 null = 拿到了。
                        注意它**不是**「有没有 A 股映射」的判据，见 hasPeers。
       bizErr       —— 映射是不是"读取失败"。和"还在载入中"要分开说，
                        否则失败时会一直显示"载入中"，用户会一直等。 */
  var state = { q: "", sector: "", industry: "", rows: [], meta: null, page: 1,
                biz: null, bizErr: "", bizOnly: false, catalogReady: false };

  // ------------------------------------------------------------ 过滤

  /** 这家美股**在 A 股有没有对标公司**（而不是"有没有映射数据"）。
   *
   *  两者必须分开：全市场 4279 家都已覆盖，人人都有一段行业说明可以看，
   *  但其中两百多家所属行业在 A 股没有对标（REIT 各系列、烟草专营、博彩…），
   *  弹窗里只有一个 peer 都没有的说明。用户勾「只看有 A 股映射」想要的是
   *  「点开能看到 A 股公司」这一档 —— 按"有数据"来判会把那两百多家一起留下，
   *  恰好是勾这个选项最想筛掉的一批。 */
  function hasPeers(symbol) {
    var e = bizOf(symbol);
    return !!(e && e.peers.length);
  }

  /** 「只看有 A 股映射」当前是否真的在生效。
   *  映射数据没到就判不了 —— 这时候当作"没开"，表格照常显示，另给一条载入提示
   *  （见 renderBody）。若这时候就按它过滤，会把 4279 家全滤成 0 条，
   *  而"0 条"和"还没加载"是两件事。 */
  function bizFilterActive() {
    return state.bizOnly && !!state.biz;
  }

  function filterRows() {
    var q = state.q.trim().toLowerCase();
    return state.rows.filter(function (r) {
      if (bizFilterActive() && !hasPeers(r.symbol)) return false;
      if (state.sector && (r.sector || "") !== state.sector) return false;
      if (state.industry && (r.industry || "") !== state.industry) return false;
      if (!q) return true;
      // 中文与英文原名都可命中（列里展示中文，英文存于 *En 字段）
      return [r.symbol, r.name, r.sector, r.industry, r.sectorEn, r.industryEn]
        .join(" ").toLowerCase().indexOf(q) >= 0;
    });
  }

  // ------------------------------------------------------------ 渲染

  /* 「A 股公司业务映射」列的数据：GET /api/us-business-map（进页面取一次，见 loadBizMap）。

     接口给的是**三张引用式表**，不是逐家展开的完整对象：
       rows       { 美股代码: { name, industryKey } }   4279 家
       industries { 行业名:   { zh, desc, peers } }     144 条
       overrides  { 美股代码: { business, peers } }     个别精写
     同一条行业说明只存一份。组装放在前端做 —— 服务端替前端展开的话，
     144 条说明会被复制成 4279 份，接口体积从几百 KB 涨到十几 MB。

     返回 null = 目录里没有这家。返回对象里 peers 可能为空（所属行业在 A 股
     没有对标），那种情况弹窗**仍有内容**（行业说明），所以按钮不该画成灰的。 */
  function bizOf(symbol) {
    var b = state.biz;
    if (!b) return null;
    var sym = (symbol || "").toUpperCase();
    var row = (b.rows || {})[sym];
    if (!row) return null;

    var ov = (b.overrides || {})[sym];
    if (ov) {                        // 公司级精写优先于行业级
      return { name: row.name, scope: "company",
               business: ov.business, peers: ov.peers || [] };
    }
    var ind = (b.industries || {})[row.industryKey];
    if (!ind) return null;
    return { name: row.name, scope: "industry",
             business: ind.desc, industryLabel: ind.zh, peers: ind.peers || [] };
  }

  /** 最后一列的按钮 —— 与夜盘页共用 static/mapbtn.js，只差 title 措辞。
   *  注意 has 单独传：peers 为 0 但行业说明存在时，按钮仍应是可点的正常态。 */
  function mapBtn(symbol, name) {
    var e = bizOf(symbol);
    var n = e ? e.peers.length : 0;
    var label = (e && e.industryLabel) ? e.industryLabel : "该行业";
    return MapBtn.html(symbol, name, n, {
      has: !!e,
      title: n ? "查看 " + n + " 家业务相似的 A 股公司"
               : "查看行业说明（" + label + "在 A 股无直接对标）",
      empty: "还没有业务映射数据"
    });
  }

  /** 点开某家公司的业务映射弹窗。
   *  内容由 businessmap.js 渲染（与夜盘页的 sharemap.js 是两套口径，见该文件注释）。 */
  function openBizMap(symbol, name) {
    var e = bizOf(symbol);
    var n = e ? e.peers.length : 0;
    Modal.open({
      title: (name ? name + "（" + symbol + "）" : symbol) + " · A 股公司业务映射",
      subtitle: !e ? "尚未生成"
              : (n ? "业务相似 " + n + " 家 · 点任意一行展开业务描述"
                   : "所属行业在 A 股无直接对标"),
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
    // 目录还没到：保持页面的「加载中…」。两个接口谁先回不确定，映射先回时
    // 若直接往下渲染，会用一张空表盖掉「加载中…」，看着像目录里什么都没有。
    if (!state.catalogReady) return;

    /* 勾了「只看有 A 股映射」但映射数据还没到 —— 如实说"载入中"，
       不要渲染成"共 0 条"。那 4047 家是存在的，只是这份数据还没到手，
       报成 0 条会把"没加载"说成"没有"。 */
    if (state.bizOnly && !state.biz) {
      $("tableHost").innerHTML = '<div class="empty">' + (state.bizErr
        ? "A 股映射数据读取失败，无法按此条件筛选：" + U.esc(state.bizErr)
        : "A 股映射数据载入中…") + "</div>";
      $("rowInfo").textContent = "—";
      $("pager").innerHTML = "";
      return;
    }

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
        这份数据本来就是英文的，用户很可能直接打英文。
     4. **计数跟着所有生效的条件走**，包括「只看有 A 股映射」。否则勾上之后
        下拉里写着「工业 (812)」，选进去却只剩几十条 —— 计数和结果对不上时，
        用户会以为是页面算错了（而不是自己多勾了一个条件）。
        某板块因此被整个滤空时它就从下拉里消失，选中的那个会由下面的
        回落逻辑清掉。 */
  function renderFilters() {
    function collect(key, enKey, withinSector) {
      var seen = {}, out = [];
      state.rows.forEach(function (r) {
        if (withinSector && (r.sector || "") !== withinSector) return;
        if (bizFilterActive() && !hasPeers(r.symbol)) return;
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

  /* 三个筛选器在初始化时建好，之后只更新选项 —— 每次筛选都重建 DOM 会丢焦点与展开状态。
     （前两个是自己实现的下拉，第三个是原生 checkbox：页面唯一的开关型条件，
     为它套一层组件不划算。） */
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

    /* 「只看有 A 股映射」的勾选状态由 linkage.html 那个 <label class="chk"> 持有
       （用原生 checkbox，不是自绘控件）—— 它是这个页面唯一的开关型筛选，
       为它套一个组件不划算。 */
    $("bizOnly").addEventListener("change", function () {
      state.bizOnly = !!this.checked;
      state.page = 1;
      renderFilters();     // 选项计数要跟着变，某板块被滤空时这里会清掉选中项
      renderBody();
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
        state.catalogReady = true;   // 从这里开始 renderBody 才算数（见其开头的守卫）
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
     两者的更新节奏不同（目录十天半月重建一次，映射要改脚本才变），用途也不同
     （目录是页面主体，映射除了画按钮，还是「只看有 A 股映射」这个筛选的判据）。
     合成一个接口会让每次打开页面都多搬一份用不到的数据。
     进页面取一次即可，不跟翻页 / 筛选走。

     失败时**不留空**：把原因写进 state.bizErr。页面主体照常显示（这一列灰着即可），
     但如果用户勾了「只看有 A 股映射」，表格会如实说是"读取失败"还是"载入中" ——
     两者的等待方式不一样，混成一个"载入中"会让人一直等下去。 */
  function loadBizMap() {
    return fetch("/api/us-business-map", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) {
          state.bizErr = (j && j.message) || "接口未返回数据";
          renderBody();
          return;
        }
        state.biz = j;    // 三张表整包存下，展开成单条交给 bizOf
        state.bizErr = "";
        renderFilters();  // 板块/行业的计数要跟着"只看有 A 股映射"重算
        renderBody();     // 按钮态从"灰"变"可点"，勾选时到这里才真正筛出结果
      })
      .catch(function (e) {
        state.bizErr = (e && e.message) || "未知错误";
        renderBody();     // 只在勾了那个条件时才看得到（renderBody 里的分支）
      });
  }

  initFilters();     // 下拉先建好；选项由首轮 renderFilters() 填
  Shell.mount({ navKey: "linkage", title: "明暗对照", mode: "catalog" });
  load();
  loadBizMap();      // 映射只在进页面时取一次
})();
