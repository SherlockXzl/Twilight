/* 通用格式化与小工具 —— 无依赖，供各页面共用 */
(function (w) {
  "use strict";

  var U = {};

  /** HTML 转义，所有插入 DOM 的动态文本都要过这一层 */
  U.esc = function (s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  };

  /** 总市值：美元 → 亿美元（过万亿时切成「万亿」） */
  U.fCap = function (v) {
    if (v === null || v === undefined || isNaN(v)) return "—";
    var yi = v / 1e8;
    if (yi >= 10000) return (yi / 10000).toFixed(2) + " 万亿";
    return yi.toFixed(1);
  };

  U.fPrice = function (v) {
    if (v === null || v === undefined || isNaN(v)) return "—";
    return v.toFixed(2);
  };

  U.fPct = function (v) {
    if (v === null || v === undefined || isNaN(v)) return "—";
    return (v > 0 ? "+" : "") + v.toFixed(2) + "%";
  };

  /** 涨=红、跌=绿（A 股惯例） */
  U.dirClass = function (chg) { return chg >= 0 ? "up" : "down"; };

  w.U = U;
})(window);
