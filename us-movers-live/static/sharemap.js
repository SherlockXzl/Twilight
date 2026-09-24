/* 「A 股映射」弹窗内容的渲染器 —— 纯函数：aShareMap 数据 → HTML 字符串。
 *
 * 数据由 `us-stock-to-a-share-mapper` skill 的分析结果写入 `data/reasons.json`
 * 的每条原因里（见 README「A 股映射」一节）。
 *
 * 关键设计
 * --------
 * 1. **结构化字段，不是 markdown 原文**。项目的既有约定是「文案字段一律纯文本，
 *    页面用 U.esc 直接渲染」—— 2026-09-24 踩过：驱动原因里写了 `**加粗**`，
 *    页面上原样显示成两个星号。所以这里存的是字段，不是 markdown 表格文本。
 *    顺带的好处是渲染稳定：不依赖任何 markdown 解析器。
 *
 * 2. **宽表改成卡片**。skill 的输出格式是 8 列（代码/名称/关联类型/关联原因/
 *    证据来源/映射强度/业绩弹性/风险）。8 列塞进 900px 的弹窗，每列 110px，
 *    「关联原因」那种长句会折成一堆短行。改成每只票一张卡片 —— 字段一个不少，
 *    但阅读顺序变成了自然的「谁 → 为什么 → 依据是什么 → 有什么风险」。
 *
 * 3. **风险提示与免责声明是固定文案**（来自 skill 原文），不逐股存储 ——
 *    否则每条映射都要复制 5 条一模一样的话，改起来还得全量重写。
 *    放在这里做常量，改一处全站生效。
 *
 * 4. **强度分级必须带说明**。S/A/B/C/D 是 skill 内部的等级，
 *    页面上不解释的话读者只能看到一堆字母。见 STRENGTH_DESC。
 */
(function (w) {
  "use strict";

  var S = {};

  S.esc = function (s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  };

  /** 映射强度分级 —— 文案取自 skill 的「第五步：映射强度分级」。 */
  var STRENGTH_DESC = {
    S: "直接股权/合资/独家核心供应商，事件直接驱动业绩",
    A: "核心供应链/生态合作/已量产/官方认证",
    B: "同赛道对标/技术储备/潜在合作",
    C: "主题概念/情绪映射/弱关联",
    D: "仅名称相似/伪映射"
  };

  /** 候选区顶部的一行图例。只列 S/A/B —— C 级按 skill 要求需明确标注「主题映射」，
   *  所以把它写进图例而不是让读者去猜字母含义。 */
  var STRENGTH_LEGEND = "S 直接股权/独家 · A 核心供应/生态 · B 同赛道 · C 主题映射";

  /* 风险提示（5 条）与免责声明 —— 取自 skill 的「风险提示」/「免责声明」两节。
     ⚠️ 这两个常量**当前不在弹窗里渲染**：2026-09-24 按用户要求移除
     （理由见 S.render 末尾的注释）。留着的理由是它们是 skill 口径的组成部分 ——
     将来若改成「在页面底部统一展示一次」，直接取用即可，不必重新找文案。 */
  var RISK_ITEMS = [
    "关联逻辑可能不成立或已被市场充分定价。",
    "A 股公司相关业务收入占比可能很低。",
    "事件落地节奏、订单、合作存在不确定性。",
    "市场情绪变化可能导致股价大幅波动。",
    "本分析不构成任何投资建议。"
  ];

  var DISCLAIMER = "本内容仅用于信息梳理与逻辑推演，不构成证券投资咨询、买卖建议或收益承诺。"
    + "使用者应自行核实信息，并结合自身风险承受能力独立决策。";

  /** 6 位 A 股代码 → 交易所短标。规则稳定（6=沪、0/3=深、4/8=北），
   *  用于让读者一眼知道该去哪儿找这只票 —— 不显示的话 6 位数字无从分辨市场。 */
  S.marketOf = function (code) {
    var c = String(code || "").trim();
    if (!/^\d{6}$/.test(c)) return "";
    var h = c.charAt(0);
    if (h === "6" || h === "9") return "SH";
    if (h === "0" || h === "2" || h === "3") return "SZ";
    if (h === "4" || h === "8") return "BJ";
    return "";
  };

  function strengthClass(s) {
    var k = String(s || "").trim().toUpperCase();
    return STRENGTH_DESC[k] ? " sm-item--" + k : "";
  }

  function strengthBadge(s) {
    var k = String(s || "").trim().toUpperCase();
    if (!STRENGTH_DESC[k]) return "";
    return '<span class="sm-badge sm-badge--' + k + '" title="' +
           S.esc(k + " · " + STRENGTH_DESC[k]) + '">' + S.esc(k) + "</span>";
  }

  /** 一只候选股 → 一个卡片。字段按 skill 的输出列一一对应。 */
  function itemHtml(r) {
    r = r || {};
    var mk = S.marketOf(r.code);
    var tags = [];
    if (r.type) tags.push('<span class="sm-tag">' + S.esc(r.type) + "</span>");
    if (r.elasticity) tags.push('<span class="sm-tag">业绩弹性 ' + S.esc(r.elasticity) + "</span>");

    /* 卡片底部只留「证据」。
       ⚠️ 这里原本还有一行「风险」（r.risk），2026-09-24 按用户要求去掉 ——
       数据里的 risk 字段仍在（分析时照写），只是不再渲染；将来想恢复这一行，
       把它加回来即可，同时记得把 style.css 里的 .sm-m:last-child 一并恢复
       （那条规则是给"风险"降色用的，没了风险它会落到"证据"上）。 */
    var meta = [];
    if (r.evidence) meta.push('<span class="sm-m"><b>证据</b>' + S.esc(r.evidence) + "</span>");

    return '<div class="sm-item' + strengthClass(r.strength) + '">' +
      '<div class="sm-item-hd">' +
        strengthBadge(r.strength) +
        (mk ? '<span class="sm-mk">' + S.esc(mk) + "</span>" : "") +
        '<span class="sm-code">' + S.esc(r.code || "—") + "</span>" +
        '<span class="sm-name">' + S.esc(r.name || "") + "</span>" +
        tags.join("") +
      "</div>" +
      (r.reason ? '<p class="sm-reason">' + S.esc(r.reason) + "</p>" : "") +
      (meta.length ? '<div class="sm-meta">' + meta.join("") + "</div>" : "") +
      "</div>";
  }

  /** 「A 股映射」列的按钮（表格单元格里的那个）。
   *  没有分析结果时**按钮仍然可点**，只是样式变灰 —— 点开是一段说明，
   *  比一个灰按钮更有信息量：灰按钮说不出"为什么点不了、要等什么"。
   *  放在这里而不是 evening.js，是因为「什么算有数据、有数据长什么样」
   *  本来就该由这一列的渲染器决定，顺便也让这条规则可以被单测钉住。 */
  S.button = function (symbol, name, map) {
    var n = (map && map.rows && map.rows.length) ? map.rows.length : 0;
    var title = n ? "查看 " + n + " 只候选 A 股及其关联依据" : "还没有 A 股映射分析";
    return '<button type="button" class="map-btn' + (n ? "" : " map-btn--none") +
      '" data-sym="' + S.esc(symbol) + '" data-name="' + S.esc(name || "") +
      '" title="' + S.esc(title) + '">点击查看</button>';
  };

  /** aShareMap → 弹窗 body 的 HTML。
   *  map 为空/结构不全时返回一句可读的说明，而不是空白弹窗 ——
   *  「点开了但什么都没有」是最难判断的一种状态（不知道是没分析还是加载失败）。 */
  S.render = function (map, ctx) {
    ctx = ctx || {};
    if (!map || typeof map !== "object" || !(map.rows && map.rows.length)) {
      return '<div class="sm-empty">' +
        "<p>这只票还没有 A 股映射分析。</p>" +
        '<p class="hint">映射内容由 <b>us-stock-to-a-share-mapper</b> 技能生成后写入 ' +
        "<code>data/reasons.json</code>，与「驱动原因」同一节奏 —— " +
        "行情每次刷新都有，分析结果只在分析过之后才有。</p>" +
        "</div>";
    }

    var out = [];

    /* 输入回显：skill 的输入是「美股标的 + 上涨原因」，
       弹窗里把它显示出来，读者才能判断后面的映射是不是回答了这个原因。
       driver 由调用方从该行的驱动原因传进来（ctx.driver）。 */
    if (ctx.driver) {
      out.push('<div class="sm-in">' +
        '<div class="sm-in-h">映射依据</div>' +
        '<p class="sm-in-b">' + S.esc(ctx.driver) + "</p></div>");
    }

    if (map.categories && map.categories.length) {
      out.push('<div class="sm-cats"><b>驱动归类</b>' +
        map.categories.map(function (c) {
          return '<span class="sm-cat">' + S.esc(c) + "</span>";
        }).join("") + "</div>");
    }

    if (map.driverBreakdown) {
      out.push('<p class="sm-break"><b>驱动拆解</b>' + S.esc(map.driverBreakdown) + "</p>");
    }

    out.push('<h3 class="sm-h">候选 A 股 <span class="sm-legend">' +
      S.esc(STRENGTH_LEGEND) + "</span></h3>");
    out.push('<div class="sm-list">' + map.rows.map(itemHtml).join("") + "</div>");

    if (map.logic && map.logic.length) {
      out.push('<h3 class="sm-h">核心映射逻辑</h3><ul class="sm-logic">' +
        map.logic.map(function (t) { return "<li>" + S.esc(t) + "</li>"; }).join("") +
        "</ul>");
    }

    /* 这里原本还有三块：风险提示（5 条）、免责声明、底部的「映射生成于 …」。
       2026-09-24 按用户要求**从弹窗里全部去掉** —— 每个弹窗都重复一遍一模一样的话，
       把真正有信息量的候选列表压到了折叠线以下。
       RISK_ITEMS / DISCLAIMER 两个常量**保留在文件顶部**：它们是 skill 口径的一部分，
       将来若改成「在页面底部统一展示一次」之类的做法，直接取用即可，不必重新找文案。
       对应样式（.sm-risks / .sm-note / .sm-gen）也一并留着，同理。 */
    return out.join("");
  };

  /** 供测试断言用的常量快照 */
  S.constants = {
    STRENGTH_DESC: STRENGTH_DESC,
    RISK_ITEMS: RISK_ITEMS,
    DISCLAIMER: DISCLAIMER
  };

  w.ShareMap = S;
})(window);
