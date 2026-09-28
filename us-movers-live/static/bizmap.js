/* 「A 股公司业务映射」的数据装配 —— 明暗对照页与早盘总结页共用。
 *
 * 为什么单独一个文件
 * ------------------
 * 两处用的是**同一份数据、同一套口径**：data/us_business_map.json → 接口
 * /api/us-business-map 的引用式三表（rows / industries / overrides）。
 * 明暗对照页拿它填最后一列与弹窗，早盘总结页拿它给代码/名称做悬停提示。
 *
 * 装配逻辑很短，但有两处**写错了也看不出来**的地方，所以不能两处各写一份：
 *   · override（公司级精写）必须优先于行业级 —— 反了不报错，只是七姐妹那种
 *     精写内容会被行业说明整段顶掉；
 *   · industryKey 取不到时要返回 null —— 返回一个空壳，上层会把"不认识这家"
 *     渲染成"这家没有对标"，两句话的含义完全不同（见 of() 的注释）。
 * 各写一份的结果，迟早只剩一处是对的。所以抽到这里，两边都调 BizMap.of。
 *
 * 与 static/mapbtn.js 是同一个理由（那个按钮也是两页共用一份实现）。
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

  w.BizMap = B;
})(window);
