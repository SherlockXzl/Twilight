/* 图标集 —— 全部内联 SVG，颜色一律走 currentColor，随所在元素的文字色自动变化。
   好处：无需为每个状态写配色规则，也能任意缩放不糊（位图缩到 20px 会发虚）。
   新增图标：在这里加一条，键名即调用名，不要写死颜色。 */
(function (w) {
  "use strict";

  var I = {};

  /* 「走势」图标，来自用户提供的 stock.png（选中）/ stock(1).png（未选中）。
     原始位图为 280x200 透明底，图形占 x15..264 / y5..195。
     这里把图形左上角对齐到原点，得到 250x191 的画布，并改用矢量重绘：
       - 折线顶点由位图光栅化回比对拟合得到（IoU 0.966，残差主要是边缘抗锯齿）
       - 线宽 22 来自实测：45 度斜线的逐列竖直厚度恒为 31px，31/√2 ≈ 22
       - 横条实测 x0..249 / y169..190，圆角约 3
     选中与未选中两态的形状完全相同，差别只在颜色，所以这里不写任何颜色。 */
  I.trend =
    '<svg class="icon" viewBox="0 0 250 191" aria-hidden="true" focusable="false">' +
      '<polyline points="27,130 106,52 143,90 223,10" fill="none" stroke="currentColor"' +
        ' stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<rect x="0" y="169" width="250" height="22" rx="3" fill="currentColor"/>' +
    '</svg>';

  /* 「太阳」图标，来自用户提供的 sun.png（选中）/ sun (1).png（未选中）。
     原始位图 200x200 透明底，实测几何（中心 99.5,99.5）：
       - 圆环：径向 r 25.5..41.5 被填充 => 中线半径 33.5、线宽 16
       - 8 根射线，45 度均分，带圆头；**正交与对角并不对称**：
           正交(上下左右)：径向外沿 50..83  => 线段 r 58 -> 75
           对角(四个斜角)：径向外沿 67..91  => 线段 r 75 -> 84
         这不是测量误差：把两种假设各自回光栅化比对，非对称版 IoU 0.983，
         八根等长版仅 0.788，所以非对称是原图刻意为之，不要"顺手改对称"。
       - 线宽统一 16
     裁掉四周 16.5 的留白后画布为 166x166，中心落在 (83,83)，图形正好贴满不留空隙。
     两态形状相同、只有颜色不同，所以这里同样不写颜色。 */
  I.sun =
    '<svg class="icon" viewBox="0 0 166 166" aria-hidden="true" focusable="false">' +
      '<circle cx="83" cy="83" r="33.5" fill="none" stroke="currentColor" stroke-width="16"/>' +
      '<line x1="141" y1="83" x2="158" y2="83" stroke="currentColor" stroke-width="16" stroke-linecap="round"/>' +
      '<line x1="136.03" y1="136.03" x2="142.4" y2="142.4" stroke="currentColor" stroke-width="16" stroke-linecap="round"/>' +
      '<line x1="83" y1="141" x2="83" y2="158" stroke="currentColor" stroke-width="16" stroke-linecap="round"/>' +
      '<line x1="29.97" y1="136.03" x2="23.6" y2="142.4" stroke="currentColor" stroke-width="16" stroke-linecap="round"/>' +
      '<line x1="25" y1="83" x2="8" y2="83" stroke="currentColor" stroke-width="16" stroke-linecap="round"/>' +
      '<line x1="29.97" y1="29.97" x2="23.6" y2="23.6" stroke="currentColor" stroke-width="16" stroke-linecap="round"/>' +
      '<line x1="83" y1="25" x2="83" y2="8" stroke="currentColor" stroke-width="16" stroke-linecap="round"/>' +
      '<line x1="136.03" y1="29.97" x2="142.4" y2="23.6" stroke="currentColor" stroke-width="16" stroke-linecap="round"/>' +
    '</svg>';

  /* 「月亮」图标，来自用户提供的 moon (1).png（选中）/ moon.png（未选中）。
     ⚠ 注意这两个文件的命名顺序与上一套相反：带 (1) 的才是选中态。
     原始位图 200x200 透明底，实测几何：
       - 造型是「月牙轮廓描边」而非填充月牙：绿色是沿月牙闭合边界描的一条带，月牙内部是白的。
       - 月牙由两个**等半径**圆相减构成（这是关键，两圆半径差仅 0.3px）：
           外圆 圆心 (99.47, 99.53)  R 84.28
           内圆 圆心 (51.54, 41.71)  R 84.59
         两圆交点即月牙的两个尖：(133.94, 22.61) 与 (17.50, 119.15)
       - 描边宽度 14.19，圆头圆角
       - 外弧跨 232.4 度（长弧，大弧标志=1）、内弧跨 126.8 度（短弧，大弧标志=0）
         写 A 命令时内弧必须从 B 回到 A 且 sweep=0，否则会描成 233 度的长弧，
         整个图形会多出一大圈、IoU 从 0.97 掉到 0.65。
       - 星星是四角星：二次贝塞尔，外接半径 19、控制点偏移 2
         但**尖端是圆的（圆角半径 2）**，纯填充的尖角模型只有 IoU 0.901，
         加上圆角后到 0.974。SVG 里的等价写法 = 内缩 2 的星形「填充 + 同色描边 4、圆角连接」。
     整体回光栅化比对 IoU 0.9735（误差 2.7%，主要是边缘抗锯齿）。
     两态形状相同、只有颜色不同，所以这里同样不写颜色。 */
  I.moon =
    '<svg class="icon" viewBox="10 14 182 177" aria-hidden="true" focusable="false">' +
      '<path d="M133.94 22.61A84.28 84.28 0 1 1 17.5 119.15A84.59 84.59 0 0 0 133.94 22.61Z"' +
        ' fill="none" stroke="currentColor" stroke-width="14.19"' +
        ' stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M56.5 31.5Q58.29 46.71 73.5 48.5Q58.29 50.29 56.5 65.5Q54.71 50.29 39.5 48.5Q54.71 46.71 56.5 31.5Z"' +
        ' fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>' +
    '</svg>';

  /* 「太极」图标，来自用户提供的 太极.png（已选中）/ 太极 (1).png（未选中）。
     ⚠ 这一套的命名顺序：**不带 (1) 的才是选中态** —— 与月亮那套一致，与太阳那套相反。
     三套图标里已经出现两种相反的约定，换图时务必先看清是哪一态，不要凭文件名猜。

     原始位图 200x200 透明底。实测几何（逐像素扫描 + 按区域做 IoU 拟合，最终 0.963，
     与 trend 的 0.966、moon 的 0.9735 同一水平；残差主要是边缘抗锯齿）：
       - 大圆：圆心 (99.5, 99.5)，外沿半径 99.75；描边宽约 2（与填充同色，不是双色描边）
       - S 曲线由**两个等半径半圆**拼成，半径 49.5 = 大圆中线半径的一半：
           上半：圆心 (99.5, 49.5)，弧向右凸
           下半：圆心 (99.5, 149.5)，弧向左凸
         这是太极图的标准构造 —— 两个半圆半径必须相等，否则阴阳两半不成 50:50。
         实测实色面积正好占圆的 50.3%，可以印证。
       - 两只「眼」半径 13（≈ 大圆半径的 1/7.7），眼心距大圆圆心 54
       - **上半那只眼是实色**（它落在透明的一侧），**下半那只眼是挖空的**（落在实色里）
     这里按 200x200 画布重绘（圆心从 99.5 取整到 100，坐标整体 +0.5）。
     两态形状完全相同、只有颜色不同，所以这里同样不写颜色。 */
  I.taiji =
    '<svg class="icon" viewBox="0 0 200 200" aria-hidden="true" focusable="false">' +
      '<circle cx="100" cy="100" r="98.75" fill="none" stroke="currentColor" stroke-width="2"/>' +
      /* 实色的那一半（鱼形）：大圆右半弧 → 下半 S 曲线 → 上半 S 曲线，收尾闭合。
         第二条子路径是下半那只眼，靠 fill-rule="evenodd" 把它从鱼形里掏空 ——
         比用 mask 简单，也不必依赖背景色（图标要能放在任何底色上）。 */
      '<path fill-rule="evenodd" fill="currentColor" d="M100 0.25' +
        'A99.75 99.75 0 0 1 100 199.75' +
        'A49.5 49.5 0 0 1 100 100' +
        'A49.5 49.5 0 0 0 100 0.25Z' +
        'M100 154m-13 0a13 13 0 1 0 26 0a13 13 0 1 0-26 0Z"/>' +
      /* 上半那只眼：落在透明的一侧，所以要单独填成实色 */
      '<circle cx="100" cy="46" r="13" fill="currentColor"/>' +
    '</svg>';

  /** 取图标 SVG 字符串；未知键名返回空串，避免因拼错键名而渲染出 undefined */
  I.get = function (name) { return I[name] || ""; };

  w.Icons = I;
})(window);