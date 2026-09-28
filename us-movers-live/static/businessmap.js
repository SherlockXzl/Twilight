/* 「A 股公司业务映射」弹窗内容的渲染器 —— 纯函数：数据 → HTML 字符串。
 *
 * 与 sharemap.js 的区别（别把两者合并）
 * ------------------------------------
 *   sharemap.js  夜盘异动页：**事件驱动**的映射。输入是「美股代码 + 驱动原因」，
 *                回答"这个催化剂会传导到谁"，所以在候选里给证据、给强度、
 *                还区分"事实关联"与"市场联想"。
 *   businessmap.js 明暗对照页：**业务相似度**映射。不看涨跌、不看原因，
 *                回答"这家公司做的生意，A 股里谁在做类似的事"。
 * 两者的数据来源、字段、渲染结构都不同，共用一个渲染器只会长出一堆条件分支。
 *
 * 「点击展开」用原生 <details> / <summary>
 * ---------------------------------------
 * 不用自己写 JS 折叠：<details> 自带展开状态、键盘可操作（Enter/Space）、
 * 支持 Ctrl+F 搜索折叠内容，且**不需要维护"哪个展开了"的状态** ——
 * 弹窗是 innerHTML 一次性注入的，自己实现就得额外绑事件、还要处理重绘。
 *
 * 数据由 tools/build_us_business_map.py 生成（内容种子在 tools/bizmap_data.py
 * 与 tools/bizmap_industries.py 里，见那两个文件的注释）。
 *
 * 「业务」那一段有两种来源，靠 entry.scope 区分
 * --------------------------------------------
 *   公司级（scope = "company"）：这家公司自己的业务，人工精写，目前只覆盖少数公司。
 *   行业级（scope = "industry"）：所属行业的说明，**同行业所有美股共用一段**。
 * 全量 4279 家里绝大多数是小盘股，没有可靠的中文资料可写 —— 逐家编造业务描述
 * 比不给更糟，所以行业级是默认值，并在弹窗里明确标注，避免读者把它当成
 * "这家公司自己的业务介绍"（一家小盘股和行业龙头会看到同样一段话）。
 */
(function (w) {
  "use strict";

  var B = {};

  B.esc = function (s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  };

  /** 一家 A 股对标公司 —— 一行可展开的条目。
   *  默认折叠：用户先扫一遍"有哪些公司"，需要时再逐条展开看业务。
   *  全都展开的话，四五家的业务描述堆在一起会比弹窗还长。 */
  function peerHtml(p) {
    p = p || {};
    return '<details class="bm-peer">' +
      "<summary>" +
        '<span class="bm-code">' + B.esc(p.code || "—") + "</span>" +
        '<span class="bm-name">' + B.esc(p.name || "") + "</span>" +
        (p.industry ? '<span class="sm-tag">' + B.esc(p.industry) + "</span>" : "") +
        '<span class="bm-ar" aria-hidden="true">▸</span>' +
      "</summary>" +
      (p.business ? '<p class="bm-biz">' + B.esc(p.business) + "</p>" : "") +
      "</details>";
  }

  /** 数据 → 弹窗 body 的 HTML。
   *  entry.scope 决定「业务」那一段是什么：
   *    company  —— 这家公司自己的业务（人工精写，见 OVERRIDES）
   *    industry —— 行业级说明，**同行业所有美股共用一段**（全量覆盖时的默认值） */
  B.render = function (entry) {
    if (!entry || !entry.business) {
      return '<div class="sm-empty">' +
        "<p>这家公司还没有业务映射数据。</p>" +
        '<p class="hint">目录里的公司都应有行业级说明，出现这一屏通常意味着这家' +
        "不在 <code>data/us_catalog.json</code> 里（例如已退市或改了代码）。" +
        "内容由 <b>tools/build_us_business_map.py</b> 生成后写入 " +
        "<code>data/us_business_map.json</code>。</p>" +
        "</div>";
    }

    var isInd = entry.scope === "industry";
    var out = [];

    out.push('<h3 class="sm-h bm-first">' + (isInd ? "行业定位" : "公司业务") +
      (isInd && entry.industryLabel
        ? '<span class="sm-legend">' + B.esc(entry.industryLabel) + " · 行业级说明</span>"
        : "") +
      "</h3>");
    out.push('<p class="bm-biz-main">' + B.esc(entry.business) + "</p>");

    /* 这句必须写。行业说明是同一行业所有美股共用的一段 —— 一家小盘股和行业龙头
       点开会看到同样的话。不说清楚，读者会把它当成"这家公司自己的业务介绍"。 */
    if (isInd) {
      out.push('<p class="bm-note">以上是该公司<b>所属行业</b>的说明，同行业的美股共用一段，' +
        "不是这家公司自己的业务介绍。</p>");
    }

    var peers = entry.peers || [];
    if (peers.length) {
      out.push('<h3 class="sm-h">业务相似的 A 股公司' +
        '<span class="sm-legend">共 ' + peers.length + " 家 · 点任意一行展开业务描述</span></h3>");
      out.push('<div class="bm-list">' + peers.map(peerHtml).join("") + "</div>");
      /* 这句必须写。列的是「业务相似」，不是供应关系 ——
         两者混看会得出"某某是苹果供应商"这类错误结论，而这个区别
         光看公司名和行业标签是看不出来的。 */
      out.push('<p class="bm-note">以上按「业务相似」筛选，属同赛道对标，' +
        "不代表存在供应链、客户或股权关系。</p>");
    } else if (isInd) {
      out.push('<p class="bm-note">A 股暂无该行业的直接对标标的 —— ' +
        "具体原因已写在上面这段行业说明里，这里不做凑数式的类比。</p>");
    } else {
      out.push('<p class="bm-note">这家公司还没有对标的 A 股公司。</p>');
    }

    return out.join("");
  };

  w.BusinessMap = B;
})(window);
