/* 映射列的「点击查看」按钮 —— 夜盘异动页与明暗对照页共用。
 *
 * 为什么单独一个文件
 * ------------------
 * 两个页面的这一列长得一样、行为一样（有数据是蓝的、没数据是灰的但**仍可点**），
 * 只有 title 的措辞不同。各自实现一份必然会慢慢漂移 ——
 * 而"按钮态不一致"这种事没人会当成 bug 报出来，只会觉得某页怪。
 *
 * 无数据时**不禁用**是刻意的：点开能看到一段说明（数据从哪来、要跑哪个脚本），
 * 比一个说不出原因的灰按钮有用。这条在 tools/test_sharemap.js 里有断言盯着。
 */
(function (w) {
  "use strict";

  var M = {};

  M.esc = function (s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  };

  /** 生成按钮 HTML。
   *  @param {string} symbol  美股代码（点击时据此取数据）
   *  @param {string} name    公司名（弹窗标题用）
   *  @param {number} count   已有映射条数；0 或缺失 = 尚无分析
   *  @param {object} [texts] 可选文案 { title, empty }，两处措辞不同
   *  data-sym / data-name 供事件委托读取 —— 表格每次刷新都整块重建，
   *  不给每个按钮单独绑监听（见 evening.js / linkage.js 的委托注释）。 */
  M.html = function (symbol, name, count, texts) {
    texts = texts || {};
    var n = count > 0 ? count : 0;
    var title = n ? (texts.title || ("查看 " + n + " 条映射"))
                  : (texts.empty || "还没有映射数据");
    return '<button type="button" class="map-btn' + (n ? "" : " map-btn--none") +
      '" data-sym="' + M.esc(symbol) + '" data-name="' + M.esc(name || "") +
      '" title="' + M.esc(title) + '">点击查看</button>';
  };

  w.MapBtn = M;
})(window);
