/* 通用弹窗 —— 原生 <dialog> 的样式在各浏览器里差异太大，自己搭一层最省事。
 *
 * 关键设计
 * --------
 * 1. **单例**：同一时刻只存在一个弹窗。再 open 一次是「换内容」而不是叠一层 ——
 *    叠层会带来"按 ESC 该关哪一层"的问题，而这个项目里没有嵌套弹窗的场景。
 *
 * 2. **HTML 由调用方传入**（`bodyHtml`），组件只负责外框、关闭与滚动锁。
 *    不给它加"字段配置"式的接口 —— 每个弹窗的内容结构天生不同，
 *    硬套一套字段只会让调用方为了填字段而扭曲内容。
 *
 * 3. **关闭后焦点还给触发元素**。用键盘 Tab 浏览时，弹窗关掉后焦点若不归还，
 *    会掉回 <body>，下次 Tab 得从头走一遍整页。
 *
 * 4. **锁 body 滚动**。弹窗背后的长表格跟着一起滚，会让人分不清滚的是哪一层。
 *    复原时要写回**原值**而不是空串 —— 否则会把调用方原本的内联样式抹掉。
 */
(function (w) {
  "use strict";

  var M = {};
  var el = null;          // 遮罩层（同时是唯一实例的容器）
  var lastFocus = null;

  M.esc = function (s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  };

  function build() {
    var d = document.createElement("div");
    d.className = "modal-mask";
    d.hidden = true;
    d.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">' +
        '<header class="modal-hd">' +
          '<div class="modal-hd-tx">' +
            '<h2 class="modal-title" id="modalTitle"></h2>' +
            '<p class="modal-sub"></p>' +
          "</div>" +
          '<button type="button" class="modal-x" aria-label="关闭">✕</button>' +
        "</header>" +
        '<div class="modal-bd"></div>' +
      "</div>";

    // 点遮罩关闭；点弹窗本体不关（内容里的文字是可以选中复制的，误触到遮罩才关）
    d.addEventListener("click", function (e) { if (e.target === d) M.close(); });
    d.querySelector(".modal-x").addEventListener("click", function () { M.close(); });
    document.body.appendChild(d);
    return d;
  }

  /** 打开弹窗。opts: { title, subtitle, bodyHtml }。
   *  title / subtitle 走 textContent（不需要调用方转义）；
   *  bodyHtml 是**已经拼好的 HTML**，动态文本由调用方自己转义。 */
  M.open = function (opts) {
    opts = opts || {};
    if (!el) el = build();

    lastFocus = document.activeElement;

    el.querySelector(".modal-title").textContent = opts.title || "";
    var sub = el.querySelector(".modal-sub");
    sub.textContent = opts.subtitle || "";
    sub.hidden = !opts.subtitle;

    var bd = el.querySelector(".modal-bd");
    bd.innerHTML = opts.bodyHtml || "";
    bd.scrollTop = 0;

    // 只在「关闭 → 打开」这一跳里记原值；重复 open 记的会是 "hidden" 自己
    if (el.hidden) el.dataset.prevOverflow = document.body.style.overflow || "";
    el.hidden = false;
    document.body.style.overflow = "hidden";
    el.querySelector(".modal-x").focus();
  };

  M.close = function () {
    if (!el || el.hidden) return;
    el.hidden = true;
    document.body.style.overflow = el.dataset.prevOverflow || "";
    delete el.dataset.prevOverflow;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  };

  M.isOpen = function () { return !!el && !el.hidden; };

  /** 取弹窗 DOM（测试用；正常业务代码不需要）。首次调用会创建。 */
  M.node = function () { if (!el) el = build(); return el; };

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && M.isOpen()) M.close();
  });

  w.Modal = M;
})(window);
