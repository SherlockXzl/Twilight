/* 「A 股公司业务映射」的数据装配 + 悬停卡的接线 —— 三个页面共用。
 *
 * 谁在用
 * ------
 * 同一份数据、同一套口径：data/us_business_map.json → 接口 /api/us-business-map
 * 的引用式三表（rows / industries / overrides）。
 *   · 明暗对照页 —— 拿它填最后一列与弹窗（那个弹窗的渲染器是 businessmap.js）；
 *   · 早盘总结页 —— 拿它给「个股异动榜」「个人关注池」的代码/名称做悬停提示；
 *   · 夜盘异动页（2026-09-29 起）—— 同样做成悬停提示，与早盘页同一套。
 *
 * 为什么单独一个文件
 * ------------------
 * 装配逻辑很短，但有两处**写错了也看不出来**的地方，所以不能几处各写一份：
 *   · override（公司级精写）必须优先于行业级 —— 反了不报错，只是七姐妹那种
 *     精写内容会被行业说明整段顶掉；
 *   · industryKey 取不到时要返回 null —— 返回一个空壳，上层会把"不认识这家"
 *     渲染成"这家没有对标"，两句话的含义完全不同（见 of() 的注释）。
 * 悬停的接线（attach / warm / canHover）同理：守卫写漏时也是静默失效。
 * 各写一份的结果，迟早只剩一处是对的。
 *
 * 与 static/mapbtn.js 是同一个理由（那个按钮也是几页共用一份实现）。
 */
(function (w) {
  "use strict";

  var B = {};

  /* /api/us-business-map 响应的版本号，必须与服务端 server.py 的
     BUSINESS_MAP_SCHEMA 一致（tools/test_business_map_data.py 钉住这两处）。
     用途只有一个：认出**旧版服务** —— 前端已是新版、而服务进程还跑着改动前的
     server.py。那种错配下接口照样 200、rows 也一家不少，缺的是
     industries / overrides，而它们正是组装每一条映射所必需的。
     页面的表现会是「每一格都说这家没有映射数据」，一个不抛任何异常的谎。
     2026-09-28 真的踩到过一次，别让它以第二种形态再发生。 */
  B.SCHEMA = 2;

  /** 组装某家美股的映射。
   *  @param {object} biz    接口响应整包（含 rows / industries / overrides）
   *  @param {string} symbol **交易所内的裸代码**（AAPL，不是 usAAPL）
   *
   *  返回 null = 「这家不在目录里 / 映射还没加载」。调用方据此**什么也不显示**，
   *  而不是显示一张空卡或"暂无"。
   *
   *  返回对象里 peers 可能是空的（所属行业在 A 股没有对标，如 REIT 各系列、
   *  烟草专营、博彩）—— 那是"有内容、但确实没对标"，与 null 是两回事，
   *  弹窗与悬停卡都要分别措辞，不能合并成一句。
   *
   *  返回：{ name, scope: "company"|"industry", business, peers, industryLabel? } */
  B.of = function (biz, symbol) {
    if (!biz) return null;
    var sym = String(symbol === null || symbol === undefined ? "" : symbol).toUpperCase();
    if (!sym) return null;
    var row = (biz.rows || {})[sym];
    if (!row) return null;

    var ov = (biz.overrides || {})[sym];
    if (ov) {                        // 公司级精写优先于行业级
      return { name: row.name, scope: "company",
               business: ov.business, peers: ov.peers || [] };
    }
    var ind = (biz.industries || {})[row.industryKey];
    if (!ind) return null;           // 行业没定义 → 当作"不认识"，别返回空壳
    return { name: row.name, scope: "industry",
             business: ind.desc, industryLabel: ind.zh, peers: ind.peers || [] };
  };

  /* ------------------------------------------------ 悬停卡的接线与预热（两页共用）
   *
   * 同一个理由（见文件头）：这几条守卫**写错时都不报错**，只是功能静默失效 ——
   *   · 预热条件写漏 → 要么每轮渲染都重搬 426KB，要么悬停时才开始下载（第一格必然空白）；
   *   · 不认版本号 → 旧服务的半份数据被当成结论渲染出来（见上面的 SCHEMA）；
   *   · 触屏不挡 → 手机白搬 426KB，而那个功能在触屏上根本触发不了。
   * 早盘总结页（个股异动榜 / 个人关注池）与夜盘异动页（2026-09-29 起）要的是
   * **同一套行为**，各写一份照样会漂。
   */

  /** 这台设备有"悬停"这个概念吗。matchMedia 缺失（老浏览器、部分测试桩）时
   *  按"有"处理 —— 宁可多取一次，也不要让桌面端平白少一个功能。 */
  B.canHover = function () {
    try {
      if (!w.matchMedia) return true;
      return w.matchMedia("(hover: hover)").matches;
    } catch (e) { return true; }
  };

  /** 取一次映射数据（整包 426KB，gzip 后约 95KB）。
   *
   *  **预热而不是悬停时再取**：等光标落到格子上才开始下载，第一格必然什么都看不到。
   *  在首屏渲染完之后悄悄取一次即可 —— 不跟首屏那份复盘 JSON 抢带宽。
   *
   *  两个标记各管一件事，缺一个都会有肉眼看不出的浪费：
   *    state.bizLoading —— 请求还在路上时又重跑了一次渲染（切标签页很快），别发第二遍；
   *    state.biz        —— 已经拿到之后每次渲染都别再取（页面还开着就会一直重取）。
   */
  B.warm = function (state) {
    if (state.bizLoading || state.biz || !B.canHover()) return;
    state.bizLoading = true;
    w.fetch("/api/us-business-map", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        // 复位放在最前面：后面一旦抛异常，标志也必须已经清掉，
        // 否则这一页从此再也不取（"只在成功路径复位"是本项目踩过的坑）。
        state.bizLoading = false;
        /* 旧版接口 / 读取失败：**整块不启用**（悬停就当没这个功能）。
           照单全收的话每一格的悬停都会静默变成"这家没有对标"，而数据其实躺在磁盘上。
           这里**不提示** —— 该说的话在明暗对照页的顶部黄条里（那边才是这个功能的归属地），
           少一个悬停提示不该往页面上加噪音。 */
        if (!j || !j.ok || j.schema !== B.SCHEMA) return;
        state.biz = j;
        // 表格与方块都是渲染时一次性拼好的，属性早就写在 HTML 里了，
        // 所以数据到位**什么都不用重画** —— 下一次 mouseover 直接就能取到。
      })
      .catch(function () { state.bizLoading = false; });
  };

  /** 接线 + 预热。**每次渲染都会走到这里**，靠被调用的两方各自幂等：
   *    BizTip.init 重复调用只是返回（接线只做一次，见 biztip.js）；
   *    warm 靠上面两个标记判断要不要真的发请求。
   *  刻意不在外面再套一个"只执行一次"的开关 —— 那样这两个标记就永远走不到，
   *  变成没人能验证的重复防线（用例也没法分辨哪一层在起作用）。
   *
   *  @param {object} state 页面自己的 state，需含 biz / bizLoading 两个字段
   *  @return {boolean} 是否接了线。biztip.js 没引进来时返回 false ——
   *          少一个悬停提示，不该把整页弄挂（调用方据此什么都不做即可）。 */
  B.attach = function (state) {
    if (typeof w.BizTip === "undefined") return false;
    w.BizTip.init({
      // 返回 null = 目录里没有这家 / 映射还没到 → 卡片不出现（见 of() 的注释）
      get: function (sym) { return B.of(state.biz, sym); }
    });
    B.warm(state);
    return true;
  };

  w.BizMap = B;
})(window);
