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
 * 数据由 tools/build_us_business_map.py 生成（种子内容在那个脚本里，见其注释）。
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

  /** 数据 → 弹窗 body 的 HTML。 */
  B.render = function (entry) {
    if (!entry || !entry.business) {
      return '<div class="sm-empty">' +
        "<p>这家公司还没有业务映射数据。</p>" +
        '<p class="hint">目前只覆盖了部分美股公司（先做的是「七姐妹」）。' +
        "内容由 <b>tools/build_us_business_map.py</b> 生成后写入 " +
        "<code>data/us_business_map.json</code> —— 要加公司改那个脚本再重跑，" +
        "它会顺带核对 A 股代码与行业。</p>" +
        "</div>";
    }

    var out = [];

    out.push('<h3 class="sm-h bm-first">公司业务</h3>');
    out.push('<p class="bm-biz-main">' + B.esc(entry.business) + "</p>");

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
    } else {
      out.push('<p class="bm-note">这家公司还没有对标的 A 股公司。</p>');
    }

    return out.join("");
  };

  w.BusinessMap = B;
})(window);
