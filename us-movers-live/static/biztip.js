/* 「A 股映射」悬停卡 —— 早盘总结的「个股异动榜」与「个人关注池」共用。
 *
 * 它回答的问题很小：把光标放在某家美股的代码或公司名上，告诉你 A 股里
 * 谁在做类似的生意。**只给代码与名称** —— 业务描述、折叠展开那些留在
 * 明暗对照页的弹窗里（那里才是容得下长文本的地方）。
 *
 * 三条设计约束
 * ------------
 * 1. **数据取不到时什么都不显示。** 不显示空卡、也不显示"加载中"。
 *    悬停是路过的动作，冒出来一张写着"暂无"的卡只会打断；而且
 *    「这家在 A 股没有对标」是**有数据**时才成立的说法（见 bizmap.js 的 of()），
 *    「还没加载 / 服务是旧版」是另一回事，两者不能用同一句话糊过去。
 *
 * 2. **position:fixed + pointer-events:none**（见 style.css 的 .biztip）。
 *    表格外面套着 .tblwrap（横向可滚），absolute 会被那个容器的 overflow 裁掉；
 *    而卡片一旦能接住鼠标，光标从格子移向卡片就会立刻触发 mouseout，
 *    卡片自己把自己关掉，在"显示/隐藏"之间来回闪。
 *
 * 3. **延迟 120ms 再出现。** 用户说的是"光标放置"—— 放置意味着停留。
 *    立即弹的话，扫过一列代码时卡片会一路闪过去。
 *
 * 分工：place() 与 render() 是纯函数，用例直接调；真正碰 DOM 的只有下面薄薄一层。
 */
(function (w) {
  "use strict";

  var T = {};

  //: 悬停多久才出现（毫秒）。用例里设成 0，免得为了一格提示去等真实时间。
  T.DELAY = 120;

  var card = null;        // 卡片（单例：同一时刻只可能悬停在一格上）
  var timer = null;
  var curSym = "";        // 当前显示的代码 —— 同一格内移动时不重画，避免闪烁
  var curEl = null;
  var getter = null;
  var bound = false;

  T.esc = function (s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  };

  /* ------------------------------------------------------------ 纯函数部分 */

  /** 从事件目标往上找带 data-biztip 的元素。
   *  返回 { el, sym }；没找到时 el 为 null、sym 为空串。
   *
   *  为什么要往上找、而不是只看 e.target：公司名那一格里还嵌着「★ 巨头」药丸，
   *  光标落在那上面时 target 是那个 span 而不是带属性的 td。往上走几层能兜住，
   *  而 DOM 深度有限（td > span），走 6 层足够、也不必死循环。 */
  T.find = function (target) {
    var n = target;
    for (var i = 0; n && i < 6; i++) {
      if (n.getAttribute) {
        var v = n.getAttribute("data-biztip");
        if (v) return { el: n, sym: String(v) };
      }
      n = n.parentNode;
    }
    return { el: null, sym: "" };
  };

  /** 定位（纯函数，坐标系是视口 —— 与 position:fixed 配套）。
   *  @param {{left,top,right,bottom}} r    被悬停格子的位置
   *  @param {{w,h}} size                   卡片尺寸
   *  @param {{w,h}} vp                     视口尺寸
   *  @return {{left,top,above}}            above=true 表示翻到了格子**上方**
   *
   *  规则：默认贴在格子下方、左端对齐；右边超出视口就往左收，左边也不许越界；
   *  下方放不下且上方放得下就翻上去。都放不下时（极少：格子占满整屏）
   *  贴着视口上沿显示 —— 宁可盖住一点内容，也不能跑出屏幕外面看不见。
   */
  T.place = function (r, size, vp) {
    var gap = 8, pad = 8;
    var left = r.left;
    if (left + size.w > vp.w - pad) left = vp.w - pad - size.w;
    if (left < pad) left = pad;

    var below = r.bottom + gap;
    var above = false;
    var top;
    if (below + size.h <= vp.h - pad) {
      top = below;                                   // 常规：贴在格子下方
    } else if (r.top - gap - size.h >= pad) {
      above = true;                                  // 下方不够、上方放得下 → 翻上去
      top = r.top - gap - size.h;
    } else {
      top = pad;      // 上下都放不下（极高的行 / 极矮的窗口）→ 贴住视口上沿。
                      // 宁可盖住一点内容，也不能让卡片滑到屏幕外面看不见。
    }
    return { left: left, top: top, above: above };
  };

  /** 卡片 HTML。**没有内容就返回空串**（调用方据此不显示），
   *  不返回"暂无数据"之类的占位 —— 那种占位会把"没加载"说成"没有"。
   *
   *  @param {string} symbol 裸代码（AAPL）
   *  @param {object} entry  BizMap.of() 的返回值；null 一律返回空串 */
  T.render = function (symbol, entry) {
    if (!entry) return "";
    var sym = T.esc(symbol || "");
    var peers = entry.peers || [];
    var out = [];

    // 行业级还是公司级要标出来：行业说明是**同行业所有美股共用**的一段，
    // 不标的话，一家小盘股和行业龙头看起来像是各自精写过。
    var scope = entry.scope === "industry"
      ? (entry.industryLabel ? T.esc(entry.industryLabel) + " · 行业级对标" : "行业级对标")
      : "公司级对标";

    out.push('<div class="bt-hd"><b class="bt-sym">' + sym + "</b>" +
      '<span class="bt-scope">' + scope + "</span></div>");

    if (peers.length) {
      out.push('<ul class="bt-list">' + peers.map(function (p) {
        p = p || {};
        return "<li>" +
          '<span class="bt-code">' + T.esc(p.code || "—") + "</span>" +
          '<span class="bt-name">' + T.esc(p.name || "") + "</span>" +
          "</li>";
      }).join("") + "</ul>");
      /* 这句必须写，与弹窗里那句同义。列的是「业务相似」，不是供应关系 ——
         混看会得出"某某是苹果的供应商"这类结论，而这个区别光看公司名
         和行业标签是看不出来的。悬停卡篇幅小，压成一行，但一个字都不能省。 */
      out.push('<p class="bt-note">业务相似对标，不代表存在供应链、客户或股权关系</p>');
    } else {
      /* 有数据、但对标池是空的。要写清是"这个行业在 A 股没有"，而不是
         "没查到这家" —— 后者会让读者以为数据缺了一块。 */
      out.push('<p class="bt-none">A 股暂无该行业的直接对标标的</p>');
      out.push('<p class="bt-note">看完整说明请点明暗对照页那一列的「点击查看」</p>');
    }
    return out.join("");
  };

  /* -------------------------------------------------------------- 粘合层 */

  function ensure() {
    if (card) return card;
    card = document.createElement("div");
    card.className = "biztip";
    card.hidden = true;
    card.setAttribute("role", "tooltip");
    document.body.appendChild(card);
    return card;
  }

  /** 量卡片尺寸。用 offsetWidth/Height 而不是 getBoundingClientRect：
   *  前者是整数、不受 transform 影响，量的是"布局尺寸"，正好是定位要的。 */
  function sizeOf(n) {
    return { w: n.offsetWidth || 280, h: n.offsetHeight || 120 };
  }

  function show(sym, el) {
    // 数据取不到 → 什么也不显示（见文件头第 1 条）
    var html = T.render(sym, getter ? getter(sym) : null);
    if (!html) { T.hide(); return; }

    var n = ensure();
    n.innerHTML = html;
    n.hidden = false;
    /* 先归零再量：卡片内容长短不一，上一次的 left/top 若留着，
       量出来的位置会受上一次摆位影响（大卡片残留的偏移）。 */
    n.style.left = "0px";
    n.style.top = "0px";
    n.className = "biztip";

    var r = (el && el.getBoundingClientRect) ? el.getBoundingClientRect() : null;
    if (!r) r = { left: 0, top: 0, right: 0, bottom: 0 };
    /* place() 还返回一个 above —— 那只是它自己的判断依据（翻上去与贴下方的
       区别**已经体现在 top 里**）。卡片没有小箭头，所以上面/下面看起来一样，
       不需要再加一个类名去区分；这里曾经挂过 `is-above`，但样式表里从头到尾
       没有它的规则，是个只会让人以为"有用"的死钩子。 */
    var p = T.place(r, sizeOf(n),
      { w: w.innerWidth || 1024, h: w.innerHeight || 768 });
    n.style.left = p.left + "px";
    n.style.top = p.top + "px";
    curSym = sym;
    curEl = el;
  }

  T.hide = function () {
    if (timer) { clearTimeout(timer); timer = null; }
    if (card) card.hidden = true;
    curSym = "";
    curEl = null;
  };

  /** 光标进入某个元素。调用方传事件对象即可（用例里传 {target} 也行）。 */
  T.onOver = function (e) {
    var f = T.find(e && e.target);
    if (!f.sym) {
      /* 移到非目标区域（价格列、驱动原因列…）就把卡片收掉。
         注意：只在这个分支里收，不在无目标时"什么都不做" —— 否则从代码格
         移开卡片会一直挂在那里，跟着鼠标飘到别处。 */
      T.hide();
      return;
    }
    /* 同一格**内部**移动（td → 里面的「★ 巨头」药丸）直接返回，不重新计时 ——
       否则光标在格子里动一下，120ms 的等待就从头开始，卡片永远出不来。
       卡片被 hide() 收掉时 curSym 会清空，所以"离开再回来"仍能重新显示。 */
    if (f.sym === curSym) return;
    curSym = f.sym;
    curEl = f.el;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      show(f.sym, f.el);
    }, T.DELAY);
  };

  /** 光标离开某个元素。只有"离开的那个目标"是当前悬停格、且真的走远了才收卡。 */
  T.onOut = function (e) {
    var f = T.find(e && e.target);
    if (!f.el) return;
    var to = e && e.relatedTarget;
    if (!to) { T.hide(); return; }
    if (f.el.contains && f.el.contains(to)) return;   // 还在同一格内

    /* 走到**同一行的另一格**（代码 ⇄ 公司名）也当没离开：这两格的 data-biztip
       是同一个代码，卡片内容一模一样。按"离开"处理的话，光标沿一行横向划过
       会看到卡片闪一下（收掉 → 重新等 120ms → 再弹出来）。
       注意判据是"**代码相同**"而不是"是不是同一个格子"：换到别的票仍要收卡。 */
    var g = T.find(to);
    if (g.sym && g.sym === f.sym) return;

    T.hide();
  };

  /** 接线。opts.get(symbol) → entry | null（一般是 BizMap.of 的偏函数）。 */
  T.init = function (opts) {
    if (bound) return;
    bound = true;
    getter = (opts && opts.get) || null;
    /* mouseover/mouseout 会冒泡，挂 document 即可 —— 表格与方块网格都是
       整块重建的（筛选、增删都会），给每个格子单独绑监听必然漏。 */
    document.addEventListener("mouseover", T.onOver);
    document.addEventListener("mouseout", T.onOut);
    // 滚动/改窗口大小时卡片会留在原地飘着（它是 fixed，不跟着内容走）→ 直接收掉
    document.addEventListener("scroll", T.hide, true);
    w.addEventListener("resize", T.hide);
    document.addEventListener("mousedown", T.hide, true);
  };

  /** 卡片 DOM（用例用；业务代码不需要）。首次调用会创建。 */
  T.node = function () { return ensure(); };
  T.sym = function () { return curSym; };
  T.el = function () { return curEl; };

  w.BizTip = T;
})(window);
