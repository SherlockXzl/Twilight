/* 带模糊搜索的下拉选择器 —— 原生 <select> 不支持在选项里搜索，只能自己实现。
 *
 * 关键设计
 * --------
 * 1. **匹配逻辑是纯函数 `Combo.match`**，与 DOM 无关，可以单独跑单测。
 *    这很重要：模糊搜索的边界情况（分隔符、大小写、空查询）最容易出错，
 *    混在 DOM 代码里就只能靠手点验证。
 *
 * 2. **归一化后再包含匹配**，而不是逐字符子序列匹配：
 *    把查询词与被搜文本都去掉分隔符并转小写，再做子串判断。
 *    这样「软件应用」能命中「软件·应用」、「SEMI」能命中「Semiconductors」。
 *    没有做拼音首字母（xxjs → 信息技术）—— 那需要一张拼音表，
 *    151 个行业手写不现实；中文用户直接用输入法打「信息」即可命中。
 *
 * 3. 选项对象形如 `{ value, name, en, count }`：
 *    **匹配只看 name 与 en，不匹配 count**（否则搜「3」会命中所有计数为 3 的项）。
 *
 * 4. 实例登记在 `Combo.get(hostId)`，方便测试与外部刷新选项。
 */
(function (w) {
  "use strict";

  var C = {};
  var reg = {};

  /* 归一化：去掉一切非字母数字汉字（空格、括号、·、-、/ 等），并转小写。
     「软件·应用」→「软件应用」    "Semiconductors" → "semiconductors"
     「信息技术 (3)」不会走到这里 —— count 不参与匹配。 */
  function norm(s) {
    return String(s === null || s === undefined ? "" : s)
      .toLowerCase()
      .replace(/[^0-9a-z\u4e00-\u9fff]+/g, "");
  }

  /** 纯函数：单个选项是否命中查询词。空查询一律命中。 */
  C.match = function (opt, query) {
    var q = norm(query);
    if (!q) return true;
    return norm(opt.name).indexOf(q) >= 0 || norm(opt.en).indexOf(q) >= 0;
  };

  /** 纯函数：过滤选项。返回 [{opt, label}]，label 是展示文案（带计数）。 */
  C.filterOptions = function (options, query) {
    return (options || []).filter(function (o) { return C.match(o, query); });
  };

  C.labelOf = function (opt) {
    var n = opt.name || opt.value || "";
    return (opt.count === undefined || opt.count === null) ? n : n + " (" + opt.count + ")";
  };

  C.esc = function (s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  };

  /* ---------------------------------------------------------------- 实例 */

  C.create = function (host, opts) {
    if (!host) return null;
    opts = opts || {};
    var allLabel = opts.allLabel || "全部";
    var placeholder = opts.placeholder || "输入关键字筛选…";
    var options = opts.options || [];
    var value = opts.value || "";
    var onChange = opts.onChange || function () {};
    var open = false;
    var hi = -1;              // 高亮项下标（在"列表项"数组里的位置，含「全部」）

    host.classList.add("combo");
    host.innerHTML =
      '<button type="button" class="combo-btn" aria-haspopup="listbox" aria-expanded="false">' +
        '<span class="combo-txt"></span><span class="combo-ar" aria-hidden="true">▾</span>' +
      "</button>" +
      '<div class="combo-pop" hidden>' +
        '<input type="search" class="combo-q" placeholder="' + C.esc(placeholder) + '">' +
        '<ul class="combo-list" role="listbox"></ul>' +
      "</div>";

    var btn = host.querySelector(".combo-btn");
    var txt = host.querySelector(".combo-txt");
    var pop = host.querySelector(".combo-pop");
    var qEl = host.querySelector(".combo-q");
    var listEl = host.querySelector(".combo-list");

    /** 当前要展示的列表项：「全部」永远排第一，其后是命中的选项。
     *  「全部」常驻是有意的 —— 它同时充当「清除筛选」入口，
     *  否则用户搜到一半就找不到回到全部的路径了。 */
    function items() {
      var q = qEl.value;
      var out = [{ value: "", name: allLabel, _all: true }];
      C.filterOptions(options, q).forEach(function (o) { out.push(o); });
      return out;
    }

    function renderList() {
      var list = items();
      if (hi >= list.length) hi = list.length - 1;
      listEl.innerHTML = list.map(function (o, i) {
        return '<li class="combo-i' + (o.value === value ? " on" : "") +
               (i === hi ? " hi" : "") + '" data-v="' + C.esc(o.value) + '">' +
               C.esc(C.labelOf(o)) + "</li>";
      }).join("") + (list.length === 1 && qEl.value
        ? '<li class="combo-none">无匹配项</li>' : "");
    }

    function renderBtn() {
      var cur = null;
      options.forEach(function (o) { if (o.value === value) cur = o; });
      txt.textContent = cur ? C.labelOf(cur) : allLabel;
      host.classList.toggle("has-val", !!value);
    }

    function setOpen(v) {
      open = v;
      pop.hidden = !v;
      btn.setAttribute("aria-expanded", v ? "true" : "false");
      host.classList.toggle("open", v);
      if (v) {
        qEl.value = "";
        // 打开时把高亮停在当前选中项上（没有选中则停在「全部」）
        var list = items();
        hi = 0;
        for (var i = 0; i < list.length; i++) {
          if (value && list[i].value === value) { hi = i; break; }
        }
        renderList();
        qEl.focus();
      }
    }

    function pick(v) {
      if (v === value) { setOpen(false); return; }
      value = v;
      renderBtn();
      setOpen(false);
      onChange(value);
    }

    btn.addEventListener("click", function () { setOpen(!open); });
    qEl.addEventListener("input", function () {
      // 搜索时高亮跳到第一条「命中项」而不是停在常驻的「全部」——
      // 否则打完字按回车会选中「全部」，等于把刚输入的筛选清掉。
      // 无命中时 renderList 会把越界的 hi 夹回来。
      hi = qEl.value ? 1 : 0;
      renderList();
    });
    qEl.addEventListener("keydown", function (e) {
      var list = items();
      if (e.key === "ArrowDown") { hi = Math.min(hi + 1, list.length - 1); renderList(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { hi = Math.max(hi - 1, 0); renderList(); e.preventDefault(); }
      else if (e.key === "Enter") {
        if (list[hi]) pick(list[hi].value);
        e.preventDefault();
      } else if (e.key === "Escape") { setOpen(false); }
    });
    listEl.addEventListener("click", function (e) {
      var li = e.target.closest ? e.target.closest(".combo-i") : null;
      if (li) pick(li.getAttribute("data-v"));
    });
    document.addEventListener("click", function (e) {
      if (open && !host.contains(e.target)) setOpen(false);
    });

    var api = {
      setOptions: function (list, keep) {
        options = list || [];
        value = keep || "";
        renderBtn();
        if (open) { hi = 0; renderList(); }
      },
      value: function () { return value; },
      /** 当前选项快照（测试与外部检查用） */
      options: function () { return options.slice(); },
      /** 测试与程序化赋值用：等价于用户在列表里点中某一项 */
      select: function (v) { pick(v); },
      isOpen: function () { return open; },
      open: function () { setOpen(true); },
      close: function () { setOpen(false); },
      host: host
    };
    renderBtn();
    reg[host.id] = api;
    return api;
  };

  C.get = function (id) { return reg[id] || null; };

  w.Combo = C;
})(window);
