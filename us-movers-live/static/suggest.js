/* 输入建议下拉 —— 给「个人关注池」的代码输入框用。
 *
 * 与 combo.js 的区别（两件事，别合并）
 * ------------------------------------
 *   combo.js  —— 「从一份固定列表里挑一个」：按钮触发、弹层里另有一个搜索框。
 *                 用于板块 / 行业筛选。
 *   本文件    —— 「一边打字一边给建议」：输入框**本身就是要搜的那个词**，
 *                 列表跟着输入走。用于关注池的代码输入。
 *
 * 两件事的交互模型不同（一个先点开再搜，一个边打边搜），硬套在一起只会两头别扭，
 * 所以另做一个组件、复用同一套视觉语言（.sug-* 与 .combo-* 的配色、圆角一致）。
 *
 * 匹配逻辑**不在这里**：全美代码表在服务端（symbols.py），由它按自己的排名返回 top N。
 * 前端只负责交互：防抖、请求竞态、键盘、点击、关窗。
 *
 * 三个容易做错、且做错了不报错的点
 * --------------------------------
 * 1. **竞态**：「AA」和「AAP」两次请求，慢的那个后回来会把结果覆盖成错的。
 *    用自增序号作废过期响应（每次请求记下自己的号，回来时不等于最新号就丢弃）。
 * 2. **回车不该自动选中第一条**。用户打了「NVD」想加 NVD，若回车默认吃下第一条建议
 *    （NVDA），就会静默加错一只票。所以默认**不高亮任何一条**，回车 = 提交输入框里的原文；
 *    要高亮得先按 ↓。多按一次键，换掉一类静默错误。
 * 3. **点选要用 mousedown 而不是 click**：click 之前输入框会先 blur，弹层可能已经关了，
 *    点在空气上。mousedown 里 preventDefault 还能顺手阻止失焦。
 */
(function (w) {
  "use strict";

  var S = {};
  var reg = {};                       // input.id → api，用于防止同一输入框重复挂载

  S.esc = function (s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  };

  S.create = function (input, opts) {
    if (!input) return null;
    if (input.id && reg[input.id]) reg[input.id].destroy();   // 重挂前先拆旧的，免得双份监听
    opts = opts || {};
    var host = input.parentNode || input;
    var source = opts.source || function () { return Promise.resolve([]); };
    var onPick = opts.onPick || function () {};
    var onSubmit = opts.onSubmit || function () {};
    var debounceMs = opts.debounceMs === undefined ? 180 : opts.debounceMs;
    var minLength = opts.minLength === undefined ? 1 : opts.minLength;

    var pop = document.createElement("div");
    pop.className = "sug-pop";
    pop.hidden = true;
    if (host.appendChild) host.appendChild(pop);

    var items = [];
    var hi = -1;              // -1 = 没有高亮（回车提交原文）
    var seq = 0;              // 请求序号，用于作废过期响应
    var timer = null;
    var loading = false;
    var closed = false;

    function close() {
      pop.hidden = true;
      hi = -1;
      items = [];
      loading = false;
    }

    function render() {
      if (!items.length) {
        pop.innerHTML = '<div class="sug-none">' +
          S.esc(loading ? (opts.loadingText || "查询中…")
                        : (opts.emptyText || "没有匹配的代码")) + "</div>";
        return;
      }
      pop.innerHTML = items.map(function (it, i) {
        return '<div class="sug-i' + (i === hi ? " hi" : "") + '" data-i="' + i + '">' +
          '<span class="sug-code">' + S.esc(it.symbol) + "</span>" +
          (it.etf ? '<span class="sug-tag">ETF</span>' : "") +
          '<span class="sug-name">' + S.esc(it.name || "") + "</span>" +
          "</div>";
      }).join("");
    }

    function run(q) {
      var my = ++seq;
      loading = true;
      if (!pop.hidden) render();          // 已经开着就先显示"查询中…"，别让列表停在旧结果上
      Promise.resolve(source(q)).then(function (list) {
        if (my !== seq || closed) return; // 过期响应：期间又打了字 / 组件已销毁
        loading = false;
        items = list || [];
        hi = -1;                          // 不自动高亮，见文件头第 2 条
        if (!items.length) { pop.hidden = false; render(); return; }
        pop.hidden = false;
        render();
      }).catch(function () {
        if (my !== seq || closed) return;
        loading = false;
        close();
      });
    }

    function schedule() {
      var q = String(input.value || "").trim();
      if (timer) { clearTimeout(timer); timer = null; }
      if (q.length < minLength) { seq++; close(); return; }
      timer = setTimeout(function () { timer = null; run(q); }, debounceMs);
    }

    function pick(it) {
      close();
      onPick(it);
    }

    function onPopDown(ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest(".sug-i") : null;
      if (!el) return;
      if (ev.preventDefault) ev.preventDefault();      // 别让输入框失焦
      var i = parseInt(el.getAttribute("data-i"), 10);
      if (items[i]) pick(items[i]);
    }

    /** 点到组件之外就关窗。弹层内部的 mousedown 已由 onPopDown 处理掉了，
     *  这里只兜"落在别处"的情况。 */
    function onDocDown(ev) {
      if (closed || pop.hidden) return;
      var t = ev.target;
      if (t === input) return;
      if (host.contains && host.contains(t)) return;
      close();
    }

    function onKey(ev) {
      ev = ev || {};
      if (ev.key === "ArrowDown") {
        if (!items.length) return;
        hi = Math.min(hi + 1, items.length - 1);
        render();
        if (ev.preventDefault) ev.preventDefault();
      } else if (ev.key === "ArrowUp") {
        if (!items.length) return;
        hi = Math.max(hi - 1, -1);
        render();
        if (ev.preventDefault) ev.preventDefault();
      } else if (ev.key === "Enter") {
        if (ev.preventDefault) ev.preventDefault();
        if (!pop.hidden && hi >= 0 && items[hi]) pick(items[hi]);
        else { close(); onSubmit(input.value); }
      } else if (ev.key === "Escape") {
        close();
      }
    }

    function onBlur() { setTimeout(close, 120); }

    input.addEventListener("input", schedule);
    input.addEventListener("keydown", onKey);
    /* 失焦后延迟关窗：点选走的是 mousedown（早于 blur），这里只是兜住"点到别处"的情况。
       延迟是为了不抢在 mousedown 之前把弹层关掉。 */
    input.addEventListener("blur", onBlur);

    pop.addEventListener("mousedown", onPopDown);

    /* 点到别处关窗。挂在 document 上，所以 destroy 时必须摘掉 ——
       否则每次重挂都会多留一个闭包在 document 上，越积越多。 */
    document.addEventListener("mousedown", onDocDown);

    var api = {
      close: close,
      isOpen: function () { return !pop.hidden; },
      items: function () { return items.slice(); },
      highlight: function () { return hi; },
      /** 测试用：跳过防抖直接查一次 */
      search: function (q) {
        if (q !== undefined) input.value = q;
        run(String(input.value || "").trim());
      },
      destroy: function () {
        closed = true;
        if (timer) clearTimeout(timer);
        /* 必须逐个摘掉监听：同一个输入框可能被重挂（render 之后又挂一次），
           不摘的话一次回车会跑两遍 onSubmit —— 表现是"加了两只"。
           document 上那个尤其要摘，它是全局的，漏一个就永远留在那儿。 */
        if (input.removeEventListener) {
          input.removeEventListener("input", schedule);
          input.removeEventListener("keydown", onKey);
          input.removeEventListener("blur", onBlur);
        }
        if (pop.removeEventListener) pop.removeEventListener("mousedown", onPopDown);
        if (document.removeEventListener) document.removeEventListener("mousedown", onDocDown);
        if (host.removeChild && pop.parentNode === host) host.removeChild(pop);
        if (input.id && reg[input.id] === api) delete reg[input.id];
      },
      input: input,
      pop: pop
    };
    if (input.id) reg[input.id] = api;
    return api;
  };

  S.get = function (id) { return reg[id] || null; };

  w.Suggest = S;
})(window);
