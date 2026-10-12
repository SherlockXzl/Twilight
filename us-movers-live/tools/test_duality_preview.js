/* 「期股双面」静态预览页的验收用例。
 *
 * 背景：/duality 这个路由**要重启服务**才存在，所以另做了个单文件预览页
 * （tools/make_duality_preview.py 生成），把真实前端代码 + 真实数据快照
 * 打成一个 HTML。这个用例就是**代替浏览器**去打开它：抽出页内所有 <script>
 * 按序执行，再看图和表有没有真的出来。
 *
 * 为什么不用无头浏览器：2026-10-08 实测在工具会话里 headless Chrome 会卡死
 * （等了 7 分 49 秒没有任何输出），而 node + DOM 桩几秒钟就能跑完，
 * 而且能断言到 SVG 字符串这一层。（这个坑已记进用户级 MEMORY.md。）
 *
 * 两个容易踩的点，都写在这里免得下次重踩：
 *  ① fetch 桩是 Promise 链（fetch→text→parse→paint，5 跳以上），只等几个
 *     microtask 就检查会早于渲染 → 误报"全挂"。必须用 setTimeout 等一拍。
 *  ② 页内代码有的写 innerHTML、有的写 textContent，而 DOM 桩里两者是**独立字段**
 *     （真实 DOM 会自动联动）。读内容时必须两个都看，否则"黄条明明在"会被判成空。
 *
 * 预览页不存在时**跳过**（退出码 0）—— 它是生成物，不在版本库里，
 * 不能让全量自检因为"没生成过"而变红。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const FILE = process.argv[2] || path.join(ROOT, "duality-preview.html");

if (!fs.existsSync(FILE)) {
  console.log("  （跳过）没有预览页：" + FILE);
  console.log("  需要时用这个生成：python3 tools/make_duality_preview.py");
  process.exit(0);
}

const html = fs.readFileSync(FILE, "utf8");
const scripts = [];
const re = /<script>([\s\S]*?)<\/script>/g;
let m;
while ((m = re.exec(html)) !== null) scripts.push(m[1]);

let unhandled = null;
process.on("unhandledRejection", (e) => { unhandled = (e && e.message) || String(e); });

const els = {};
function mk(id) {
  return { id, innerHTML: "", textContent: "", value: "", disabled: false, style: {}, className: "",
    clientWidth: 1200, offsetWidth: 200, offsetHeight: 90, _h: {}, _a: {},
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    addEventListener(t, f) { this._h[t] = f; }, setAttribute(k, v) { this._a[k] = v; },
    getAttribute(k) { return this._a[k]; }, appendChild(c) { return c; }, removeChild(c) { return c; },
    insertBefore(c) { return c; },
    querySelector(s) { return els[id + "|" + s] || (els[id + "|" + s] = mk(id + s)); },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 400 }; },
    contains() { return false; }, focus() {} };
}
global.window = global;
global.document = {
  readyState: "complete",
  getElementById(id) { return els[id] || (els[id] = mk(id)); },
  createElement(t) { return mk("cr:" + t); },
  addEventListener() {}, title: "", body: mk("body")
};
global.addEventListener = () => {};
global.getComputedStyle = () => ({ getPropertyValue: () => "" });
global.requestAnimationFrame = (f) => setTimeout(f, 0);
global.setInterval = () => 0;

try {
  scripts.forEach((s, i) => vm.runInThisContext(s, { filename: "preview-script-" + i }));
} catch (e) {
  console.log("  ✗ 页内脚本执行时抛异常：" + e.message);
  process.exit(1);
}

/** 读元素内容：innerHTML 与 textContent 都看（DOM 桩里两者不联动） */
const txt = (id) => {
  const el = document.getElementById(id);
  return (el.innerHTML || "") + "\u0000" + (el.textContent || "");
};

setTimeout(() => {
  const checks = [];
  const add = (n, c) => checks.push([n, !!c]);
  let refreshBtn = null;              //: 页头「立即刷新」，下面交互段赋值、末尾验复位

  // ---------- 骨架 ----------
  add("侧栏渲染出来了", txt("sidebar").indexOf("nav-item") > 0);
  add("页头渲染出来了", txt("pageHeader").indexOf("badges") > 0);
  /* 页头徽章 2026-10-08 按用户要求精简成只有「取数时间」。
     这里验的是生成脚本里那个壳桩 —— 它必须和真页头（shell.js 的 renderHeader）一个样，
     否则预览页会给人一个"页头长这样"的错误印象。 */
  add("页头保留了「取数时间」徽章", txt("pageHeader").indexOf("取数时间") > 0);
  add("页头不再有「数据截止」徽章", txt("pageHeader").indexOf("数据截止") < 0);
  add("页头不再有市场状态徽章", txt("pageHeader").indexOf("mktLabel") < 0);
  /* 取数按钮 2026-10-08 从内容区搬到页头、并改名「立即刷新」。
     桩必须和真页头（shell.js 的 renderHeader）一个样：真页头有 `duRefresh`，
     duality.js 的 bindHeaderRefresh() 也按这个 id 去找 —— 桩里漏了它，
     预览页就只能看到一个点不动的空按钮位。 */
  add("页头有「立即刷新」按钮", txt("pageHeader").indexOf("duRefresh") > 0);
  add("按钮文案是「立即刷新」", txt("pageHeader").indexOf("立即刷新") > 0);
  add("页头「取数时间」已填", document.getElementById("duTime").textContent.length > 5);
  add("没有出现版本握手的黄条", txt("notice").indexOf("结构与本页不匹配") < 0);

  // ---------- 控件 ----------
  const rangeHtml = txt("dpRange");
  add("时间范围有 6 个选项", (rangeHtml.match(/class="tab/g) || []).length === 6);
  ["过去 7 天", "过去 30 天", "过去 90 天", "过去 180 天", "今年至今", "自定义"]
    .forEach((lb) => add("范围里有「" + lb + "」", rangeHtml.indexOf(lb) > 0));
  add("自定义起止日期输入框在", !!els["dpStart"] && !!els["dpEnd"]);
  /* 反过来钉住内容区**已经没有**它了：只加新按钮不删旧按钮是本类改动最常见的疏漏，
     页面上就会同时出现两个入口（一个在内容区、一个在页头），用户不知道该点哪个。 */
  add("内容区已无「重新取数」按钮", txt("dualityHost").indexOf("dpReload") < 0);
  const picksHtml = txt("dpPicks");
  add("标的勾选框有 6 个", (picksHtml.match(/class="dp-pick"/g) || []).length === 6);
  ["纽约金", "紫金矿业", "山东黄金", "赤峰黄金", "中国黄金", "四川黄金"]
    .forEach((nm) => add("可选标的含「" + nm + "」", picksHtml.indexOf(nm) > 0));
  add("六只标的价格都带出来了", (picksHtml.match(/dp-pick-p">[^<]*\d/g) || []).length === 6);

  // ---------- 图 ----------
  const chart = txt("dpChart");
  add("折线图生成了 SVG", chart.indexOf("<svg") === 0);
  add("有折线", (chart.match(/<polyline/g) || []).length >= 1);
  add("有数据点（单点标的用圆点表示）", (chart.match(/<circle/g) || []).length >= 6);
  add("SVG 里没有 undefined / NaN", chart.indexOf("undefined") < 0 && chart.indexOf("NaN") < 0);
  add("纵轴有 0% 基准刻度", chart.indexOf("0%<") > 0 || /(^|>)0%(<|$)/.test(chart));
  add("纵轴刻度不止一条", (chart.match(/class="dp-ax/g) || []).length >= 4);
  // 轴标签不补零（"10/2" 而非 "10/02"）
  add("X 轴有日期刻度", (chart.match(/\d{1,2}\/\d{1,2}/g) || []).length >= 3);
  add("悬停命中层在", !!els["dpHit"]);
  add("悬停提示框在", !!els["dpTip"]);

  // ---------- 期货虚线 + 图例线型 ----------
  /* 期货画虚线是**常驻**的区分：不用动鼠标就看得到，也不依赖颜色。 */
  add("纽约金（期货）画的是虚线", /data-k="gold"[^>]*stroke-dasharray="6 6"/.test(chart));
  const keyHtml = txt("dpPicks");
  add("图例标记是线段（6 个 .dp-key，不再是圆点）",
    (keyHtml.match(/class="dp-key"/g) || []).length === 6);
  add("期货那个图例标记画成虚线（repeating-linear-gradient）",
    /class="dp-key" style="background:repeating-linear-gradient/.test(keyHtml));
  add("图例里不再出现圆点（.dp-dot 只留给提示框）", keyHtml.indexOf("dp-dot") < 0);

  // ---------- 悬停认线 ----------
  /* 六只标的上图后，"我指着的这条线是谁"必须能问出来。这里真的把鼠标移到线上的一点，
     看提示框有没有把**那一行**置顶并高亮 —— 只验"提示框里有名字"不够，
     六行里哪一行对应你指的那条，才是这个功能存在的理由。 */
  const duLine = /<polyline[^>]*data-k="(\w+)"[^>]*points="([^"]+)"/.exec(chart);
  add("图上每条线都带 data-k（悬停靠它认出这条线是谁）", !!duLine);
  const dHit = document.getElementById("dpHit");
  add("悬停命中层绑了 mousemove", !!(dHit && dHit._h && dHit._h.mousemove));
  if (duLine && dHit._h.mousemove) {
    const lpts = duLine[2].trim().split(" ").map((s) => s.split(",").map(Number));
    const mid = lpts[Math.floor(lpts.length / 2)];
    dHit._h.mousemove.call(dHit, { clientX: mid[0], clientY: mid[1] });
    const tipHtml = txt("dpTip");
    add("鼠标指着的那条线被认出来了（该行置顶 + 高亮）",
      /class="dp-tip-r dp-tip-r--on"[\s\S]{0,300}?dp-tip-n">/.test(tipHtml));
    add("提示框给出稳定标识（A 股代码 / 期货市场名）", tipHtml.indexOf("dp-tip-c") > 0);
    add("竖线跟着鼠标画出来了", txt("dpHoverG").indexOf("<line") === 0);
    /* 吸附点旁直接写出这是谁 —— 提示框那是六行里的一行，眼睛得先找到它。 */
    add("线上直接标注了被吸附标的的名称", txt("dpHoverG").indexOf('class="dp-tag"') > 0);
    add("标签的 fill 是该条线的色（不是写死一个色）",
      /class="dp-tag"[^>]*\bfill="#[0-9a-f]{6}"/i.test(txt("dpHoverG")));
    /* display 必须是**具体值**。2026-10-08 真实 Chrome 里逮到的 bug：
       `.dp-tip` 的 CSS 初始态是 display:none，JS 写 "" 等于交回给 CSS → 永远 none。
       症状是内容全对、DOM 齐全、**就是看不见**，而"有内容"的断言照样通过。
       这条是本页唯一能防住它的地方（桩不实现 CSS 层叠，只能查 inline 值）。 */
    add("提示框的 display 给的是具体值 block",
      document.getElementById("dpTip").style.display === "block",
      document.getElementById("dpTip").style.display);
    dHit._h.mouseleave.call(dHit, {});
    add("移出图表后提示框收起",
      document.getElementById("dpTip").style.display === "none");
  }

  // ---------- 页头「立即刷新」真的点得动 ----------
  /* 这一条守的是**静默失败**。bindHeaderRefresh 里有 `var b = $("duRefresh");
     if (!b) return;` —— 哪天 id 写错（比如又改回 dpReload、或者壳桩忘了画按钮），
     它**不会抛异常**，只是"点了没反应"，从外边一点看不出来。
     所以这里直接触发一次点击，看它有没有真的把按钮推进加载态。 */
  refreshBtn = document.getElementById("duRefresh");
  add("页头「立即刷新」绑了点击处理",
    !!(refreshBtn && refreshBtn._h && refreshBtn._h.click));
  if (refreshBtn && refreshBtn._h && refreshBtn._h.click) {
    refreshBtn._h.click.call(refreshBtn);
    add("点下去立刻进加载态（禁用 + 「刷新中…」）",
      refreshBtn.disabled === true && refreshBtn.textContent === "刷新中…");
  }

  // ---------- 长假提示（默认「过去 7 天」）----------
  /* ⚠️ 这里的断言方向**由快照本身决定**，不能写死"必须出现"。
     快照是真实数据：长假后生成时，A 股在"过去 7 天"里只剩一两个交易日，
     黄条该出现；正常交易周生成时每只都够两个点，黄条就该**收起来**。
     写死一个方向的话，这个用例会在换了一份快照之后莫名其妙变红
     （2026-10-12 就是这么红的：缓存从假日那批换成了当天的），
     而红的时候看起来像"页面坏了"，实际只是快照不同。
     两个方向都断：凑不出两个点 → 必须点名并给出路；都够 → 必须没有残留提示。 */
  const warn = txt("dpWarn");
  const thinList = ((global.Duality.compute() || {}).list || [])
    .filter((s) => s.pts.length < 2);
  if (thinList.length) {
    add("长假提示条出现了（快照里确有标的不满 2 个交易日）", warn.indexOf("休市") > 0);
    add("长假提示点名了缺席的标的",
      thinList.some((s) => warn.indexOf(s.it.name) > 0), warn.slice(0, 120));
    add("长假提示给了出路（放宽范围）", warn.indexOf("30 天") > 0);
  } else {
    add("快照不是长假口：7 天里每只都有 ≥2 个交易日（故本条转为守「不出黄条」）", true);
    add("没有多余的长假提示（上一轮的提示必须收起来，不能留在页上）",
      warn.indexOf("休市") < 0, warn.slice(0, 120));
  }

  // ---------- 表 ----------
  const tbl = txt("dpTable");
  add("数据表出来了", tbl.indexOf("<table") >= 0);
  add("表头含「区间涨跌幅」", tbl.indexOf("区间涨跌幅") > 0);
  add("表里 6 只标的都在",
    ["纽约金", "紫金矿业", "山东黄金", "赤峰黄金", "中国黄金", "四川黄金"]
      .every((nm) => tbl.indexOf(nm) > 0));

  // ---------- 切范围：90 天里六条线都该出来 ----------
  const D = global.Duality;
  if (!D || !D.compute || !D.state) {
    add("页面对外暴露了 Duality.compute（可编程验证）", false);
  } else {
    D.state.range = "90";
    D.state.custom = null;
    const list = (D.compute() || {}).list || [];
    add("切 90 天算出了 6 只标的", list.length === 6);
    add("90 天里每只都有 ≥2 个交易日（能画线）", list.every((s) => s.pts.length >= 2));
  }

  // ---------- 切分组：纽约银 × 白银股 / 纽约铜 × 铜股（2026-10-12 新增）----------
  /* 分组是**后端给的**（duality.py 的 GROUPS → payload.groups），页面按它出 tab、
     再按 tab 过滤标的。这一整条链里任何一环断了都不会抛异常 ——
     症状是"某个 tab 点开是空的"或"铜的图里混着银价"，只看金价那组永远正常。
     所以这里把后加的两组**都真的点一次**，看图、表、勾选卡有没有整体换过去。 */
  const tabsHost = document.getElementById("tabs");
  add("分组 tab 有三个（纽约金 × 黄金股 / 纽约银 × 白银股 / 纽约铜 × 铜股）",
    (txt("tabs").match(/class="tab/g) || []).length === 3 &&
    txt("tabs").indexOf("纽约银 × 白银股") > 0 &&
    txt("tabs").indexOf("纽约铜 × 铜股") > 0,
    (txt("tabs").match(/class="tab/g) || []).length);
  add("tab 栏绑了点击处理", !!(tabsHost && tabsHost._h && tabsHost._h.click));
  if (tabsHost && tabsHost._h && tabsHost._h.click) {
    /* 上面那段把 S.custom 置成了 null（那一段只调 compute()，不重画）。
       点 tab 会走完整的 renderPanel → paint → paintRanges，那里要读 custom.start，
       所以先把它还原成对象 —— 否则这里炸的是**前一段留下的状态**，
       报错看着像"切分组崩了"，其实与分组无关。 */
    D.state.custom = { start: "", end: "" };
    const clickTab = (key) => tabsHost._h.click.call(tabsHost, {
      target: { closest: () => ({ getAttribute: () => key }) }
    });
    clickTab("silver");
    const sPicks = txt("dpPicks");
    const sChart = txt("dpChart");
    const sTable = txt("dpTable");
    add("切到白银组后勾选卡只剩 5 只",
      (sPicks.match(/class="dp-pick"/g) || []).length === 5,
      (sPicks.match(/class="dp-pick"/g) || []).length);
    add("四只白银股都在勾选卡上（湖南白银 / 白银有色 / 豫光金铅 / 盛达资源）",
      ["纽约银", "湖南白银", "白银有色", "豫光金铅", "盛达资源"]
        .every((nm) => sPicks.indexOf(nm) > 0));
    add("黄金组的标的没有串到白银组里（勾选卡/图/表三处都要换干净）",
      sPicks.indexOf("紫金矿业") < 0 && sTable.indexOf("紫金矿业") < 0 &&
      sChart.indexOf('data-k="gold"') < 0 && sChart.indexOf('data-k="zijin"') < 0);
    add("纽约银（期货）画的是虚线", /data-k="silver"[^>]*stroke-dasharray="6 6"/.test(sChart));
    add("白银组图里没有 undefined / NaN",
      sChart.indexOf("undefined") < 0 && sChart.indexOf("NaN") < 0);
    add("白银组表里有 5 只标的",
      (sTable.match(/<tr>/g) || []).length === 6,   // 5 行 + 表头
      (sTable.match(/<tr>/g) || []).length);
    add("表脚注按分组改口（说的是「纽约银是期货」而不是纽约金）",
      sTable.indexOf("纽约银是期货") > 0);

    // ---------- 再切到纽约铜 × 铜股（同日追加的第三组）----------
    // 加一组最容易漏的不是配色（配色错了看得见），而是**前后端各改一半**：
    // 后端加了 group、前端忘了配色 → 静默落到回退板（可能两条线同色）；
    // 或者 group 字母写错 → 这一组的标的在页面上**一只都不显示**，
    // 而 tab 是空的还是有的，光看页头看不出来。
    clickTab("copper");
    const cPicks = txt("dpPicks");
    const cChart = txt("dpChart");
    const cTable = txt("dpTable");
    add("切到铜组后勾选卡只剩 5 只",
      (cPicks.match(/class="dp-pick"/g) || []).length === 5,
      (cPicks.match(/class="dp-pick"/g) || []).length);
    add("四只铜股都在勾选卡上（江西铜业 / 铜陵有色 / 云南铜业 / 北方铜业）",
      ["纽约铜", "江西铜业", "铜陵有色", "云南铜业", "北方铜业"]
        .every((nm) => cPicks.indexOf(nm) > 0));
    add("金、银两组的标的都没串到铜组里（勾选卡/图/表三处都要换干净）",
      cPicks.indexOf("紫金矿业") < 0 && cPicks.indexOf("盛达资源") < 0 &&
      cTable.indexOf("紫金矿业") < 0 && cTable.indexOf("盛达资源") < 0 &&
      cChart.indexOf('data-k="gold"') < 0 && cChart.indexOf('data-k="silver"') < 0);
    add("纽约铜（期货）画的是虚线", /data-k="copper"[^>]*stroke-dasharray="6 6"/.test(cChart));
    add("铜组图里没有 undefined / NaN",
      cChart.indexOf("undefined") < 0 && cChart.indexOf("NaN") < 0);
    add("铜组表里有 5 只标的",
      (cTable.match(/<tr>/g) || []).length === 6,   // 5 行 + 表头
      (cTable.match(/<tr>/g) || []).length);
    add("铜组表脚注说的是「纽约铜是期货」",
      cTable.indexOf("纽约铜是期货") > 0);
    add("纽约铜报的是**美元/磅**（沿用金银的美元/盎司就是把单位写错了）",
      cPicks.indexOf("美元/磅") > 0 || cTable.indexOf("美元/磅") > 0);

    clickTab("gold");
    add("切回黄金组恢复 6 只（三组各自独立，不是单向的）",
      (txt("dpPicks").match(/class="dp-pick"/g) || []).length === 6 &&
      txt("dpTable").indexOf("紫金矿业") > 0);
  }

  /* 点了「立即刷新」之后还要确认它**复位**（不卡在「刷新中…」）。
     fetch 桩是同步 resolve 的 Promise，load() 的链是 5+ 跳 microtask ——
     这些在当前 macrotask 里就会跑完，所以挪到下一个 tick 读即可。
     这条不能省：本项目栽过"复位漏了"（取数中标志只在成功路径复位 →
     一次提前 return 就永久不再取数），那是比"点了没反应"更难发现的一种坏。
     注意「没有未捕获的异步异常」也要跟着挪到最后 —— 它本身就是异步事件。 */
  const finish = () => {
    if (refreshBtn) {
      add("取完自动复位（按钮不卡在「刷新中…」）",
        refreshBtn.disabled === false && refreshBtn.textContent === "立即刷新");
    }
    add("没有未捕获的异步异常", !unhandled);

    let bad = 0;
    checks.forEach(([n, c]) => { if (!c) bad++; console.log((c ? "    ✓ " : "    ✗ ") + n); });
    if (bad) {
      console.log("    --- 现场 ---");
      console.log("    notice:", txt("notice").slice(0, 200));
      console.log("    dpWarn:", txt("dpWarn").replace("\u0000", " | text=").slice(0, 200));
      console.log("    chart :", chart.slice(0, 150));
      if (unhandled) console.log("    unhandledRejection:", unhandled);
    }
    console.log("    %d 项检查，%s", checks.length, bad ? bad + " 项失败" : "全部通过");
    process.exit(bad ? 1 : 0);
  };
  if (refreshBtn && refreshBtn._h && refreshBtn._h.click) setTimeout(finish, 0);
  else finish();
}, 120);
