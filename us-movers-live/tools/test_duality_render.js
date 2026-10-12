/* 期股双面 · 渲染用例（离线，不联网）

   用法：node tools/test_duality_render.js      （退出码 0 = 全通过）

test_duality.js 测的是**算得对不对**（区间、基准、涨跌），这个文件测的是
**画得出来吗** —— 两者坏掉的样子完全不同：

  算错了 → 图照画，数字有两位小数，只是结论不对（那个由 test_duality.js 钉）。
  画不出来 / 画歪了 → 页面直接崩或一片空白，而 console 里可能什么都有。

SVG 是一条**长字符串拼出来的**，最容易出的三类事都在这里兜住：

  1. **拼接事故**：某个字段是 undefined、某个除法除出了 NaN ——
     它们会原样进 SVG，浏览器默默不画那条线，**不报错**。
     所以每个快照都要扫一遍 "undefined" / "NaN"。
  2. **标签不闭合**：`<g>` 少一个 `</g>`，后面整块内容会不见。
     做法是数一遍开标签 = 闭标签 + 自闭合标签。
  3. **边界场景**：长假后「过去 7 天」里 A 股只有 1 个交易日 ——
     这时折线画不出来（单点），必须退化成圆点 + 一句解释，而不是一条隐形的线。

做法：最小 DOM 桩 + 一份**程序生成**的样本数据（不读外部文件，因此结果可复现），
把 fetch 换成桩返回，跑真实的 renderPanel → paint → paintChart 代码路径。
*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.resolve(__dirname, "..") + "/";

/* ---------------------------------------------------------------- 样本数据 */

/** "YYYY-MM-DD" → 天序号（UTC），用来做日期加减 */
function dayNum(s) { return Math.round(Date.parse(s + "T00:00:00Z") / 86400000); }
function iso(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }

/** 生成 [from, to] 之间的工作日（跳周末）。`holidays` 是额外的休市日集合。 */
function workdays(from, to, holidays) {
  const out = [];
  for (let n = dayNum(from); n <= dayNum(to); n++) {
    const d = iso(n);
    const wd = new Date(n * 86400000).getUTCDay();
    if (wd === 0 || wd === 6) continue;          // 周末
    if (holidays && holidays.indexOf(d) >= 0) continue;
    out.push(d);
  }
  return out;
}

/* 2026 国庆：A 股 10-01 ~ 10-07 休市，10-08 是节后第一个交易日。
   这个日期是刻意挑的 —— 它正好压到"过去 7 天里 A 股只剩 1 个交易日"这个边界。 */
const CN_HOLIDAY = ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"];
const TODAY = "2026-10-08";

/** 确定性价格：一条缓慢的上升趋势 + 周期波动，保证有涨有跌而不是直线 */
function priceAt(i, base) {
  return +(base * (1 + i * 0.0015 + Math.sin(i / 4.2) * 0.035)).toFixed(2);
}

/** 造一只标的。`capYi` 是**总市值（亿元）**，与接口一致 —— 接口给的是元，
 *  这里换算一下，免得用例和真实 payload 用了两套单位还都不报错。
 *  **不传就是不写这个字段**（期货就是这种情况，后端也不给它 marketCap），
 *  于是表格里那一格走 "—"、排序时沉底 —— 这两条都要能测到。 */
function mkItem(key, name, kind, unit, market, code, dates, base, capYi) {
  const closes = dates.map((d, i) => priceAt(i, base));
  const chgs = closes.map((c, i) => (i ? +((c / closes[i - 1] - 1) * 100).toFixed(2) : 0));
  const it = { key, name, kind, unit, market, note: (code + " · 样本"), code,
               dates, closes, chgs };
  if (capYi) it.marketCap = capYi * 1e8;
  return it;
}

const GOLD_D = workdays("2026-07-01", TODAY, null);            // 期货：中国假期照常
const STOCK_D = workdays("2026-07-01", TODAY, CN_HOLIDAY);     // A 股：国庆休市

const PAYLOAD = {
  ok: true, stale: false, schema: 0,     //: schema 稍后从 Duality.SCHEMA 取（见下）
  generatedAt: TODAY + " 14:30:00",
  source: "样本数据（用例内置）",
  count: 6, errors: [],
  items: [
    mkItem("gold", "纽约金", "future", "美元/盎司", "COMEX", "GC00Y", GOLD_D, 4100),
    // 市值取自 2026-10-08 实际收盘（亿元）。刻意让「中国黄金 < 四川黄金」——
    // 这两个数字接近，是唯一能验出"排序真的在按市值排、不是恰好凑巧"的一对。
    mkItem("zijin", "紫金矿业", "stock", "元", "上交所", "601899", STOCK_D, 29, 7809.72),
    mkItem("sdgold", "山东黄金", "stock", "元", "上交所", "600547", STOCK_D, 26, 1218.40),
    mkItem("cfgold", "赤峰黄金", "stock", "元", "上交所", "600988", STOCK_D, 39, 742.49),
    mkItem("zggold", "中国黄金", "stock", "元", "上交所", "600916", STOCK_D, 7, 120.12),
    mkItem("scgold", "四川黄金", "stock", "元", "深交所", "001337", STOCK_D, 44, 184.63)
  ]
};

/* ---------------------------------------------------------------- DOM 桩 */
const els = {};
function mkCL() {
  const s = {};
  return { add: c => (s[c] = 1), remove: c => delete s[c], contains: c => !!s[c],
           toggle: (c, f) => { if (f) s[c] = 1; else delete s[c]; } };
}
function mk(id) {
  const el = {
    id, innerHTML: "", textContent: "", value: "", hidden: false, className: "",
    style: {}, clientWidth: 1200, offsetWidth: 200, offsetHeight: 90,
    _h: {}, _a: {}, _kids: [], parentNode: null, classList: mkCL(),
    addEventListener(t, f) { this._h[t] = f; },
    removeEventListener() {},
    setAttribute(k, v) { this._a[k] = v; },
    getAttribute(k) { return this._a[k]; },
    appendChild(c) { c.parentNode = el; el._kids.push(c); return c; },
    removeChild(c) { const i = el._kids.indexOf(c); if (i >= 0) el._kids.splice(i, 1); return c; },
    querySelector(sel) { return els[id + "|" + sel] || (els[id + "|" + sel] = mk(id + sel)); },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 400 }; },
    contains() { return false; },
    focus() {},
    fire(t, ev) { if (this._h[t]) return this._h[t].call(this, ev || {}); }
  };
  return el;
}
global.window = global;
global.document = {
  readyState: "complete",
  getElementById(id) { return els[id] || (els[id] = mk(id)); },
  createElement(tag) { return mk("cr:" + tag); },
  addEventListener() {}, title: ""
};
global.addEventListener = () => {};

let fail = 0, pass = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; console.log("  \x1b[31m✗\x1b[0m " + name + (extra !== undefined ? "  → " + extra : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------- 桩：Shell / fetch / 定时器 */
global.Shell = { mount(o) { global.__mounted = o; }, state: {} };
global.fetch = function (url) {
  global.__fetchUrl = url;
  return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify(PAYLOAD)) });
};

vm.runInThisContext(fs.readFileSync(ROOT + "static/util.js", "utf8"), { filename: "util.js" });
vm.runInThisContext(fs.readFileSync(ROOT + "static/duality.js", "utf8"), { filename: "duality.js" });

/* schema 从页面自己那儿取，不在这里写死一份。写死的话，升版本时这个文件会
   先崩成"版本不匹配"（而不是"用例挂了"）—— 那看起来像页面坏了。
   时序上没问题：mount() 虽然在这一行之前就跑了，但 fetch 桩是**在 microtask 里**
   才把 PAYLOAD 序列化的（见 global.fetch），而这里还在同一个 macrotask 上。 */
PAYLOAD.schema = global.Duality.SCHEMA;

/* 检查一段 HTML/SVG 拼接里有没有"安静的错误" */
function scan(name, html) {
  ok(name + "：没有 undefined", html.indexOf("undefined") < 0, near(html, "undefined"));
  ok(name + "：没有 NaN", html.indexOf("NaN") < 0, near(html, "NaN"));
}
function near(html, needle) {
  const i = html.indexOf(needle);
  return i < 0 ? "" : html.slice(Math.max(0, i - 70), i + 30).replace(/\s+/g, " ");
}

/* ---------------------------------------------------------------- 跑 */
Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve()).then(() => {

  section("挂载");
  ok("用 duality 模式挂壳", global.__mounted && global.__mounted.mode === "duality",
    JSON.stringify(global.__mounted));
  ok("只请求 /api/duality", global.__fetchUrl === "/api/duality", global.__fetchUrl);
  ok("页面级 tab 渲染了 1 个", ($("tabs").innerHTML.match(/class="tab/g) || []).length === 1);
  /* 页头徽章 2026-10-08 按用户要求精简成只有「取数时间」，「数据截止」那条断言随之删掉。
     这里**不**改成"断言 duLatest 为空"—— 本用例的 Shell 是桩、页头从不真渲染，
     而 $() 是懒创建的（永远返回一个空元素），拿它判"元素不存在"是假命题。
     真正守这件事的是 test_duality.js 里读源码的那三条。 */
  ok("页头「取数时间」有值", $("duTime").textContent.length >= 16, $("duTime").textContent);

  section("控件");
  ok("6 个时间范围", ($("dpRange").innerHTML.match(/class="tab/g) || []).length === 6);
  ok("默认高亮「过去 7 天」", /class="tab on" data-k="7"/.test($("dpRange").innerHTML));
  ok("自定义起止默认收起", $("dpCustom").style.display === "none");
  ok("6 张标的卡", ($("dpPicks").innerHTML.match(/<label class="dp-pick/g) || []).length === 6);
  ok("默认全勾选（没有 off）", $("dpPicks").innerHTML.indexOf("dp-pick off") < 0);
  /* 图例的标记是**线段**（.dp-key），不是圆点 —— 图上期货虚线、股票实线，
     图例若还是圆点，"线型"这件事就只存在于图上，看的人得自己回图里猜。 */
  ok("图例标记是线段（6 个 .dp-key，不再是圆点）",
    ($("dpPicks").innerHTML.match(/class="dp-key"/g) || []).length === 6);
  ok("期货那个图例标记画成虚线（repeating-linear-gradient）",
    /class="dp-key" style="background:repeating-linear-gradient/.test($("dpPicks").innerHTML));
  ok("图例里不再出现圆点（.dp-dot 只留给悬停提示框）",
    $("dpPicks").innerHTML.indexOf("dp-dot") < 0);

  section("折线图（默认 7 天 · 长假后）");
  const svg = $("dpChart").innerHTML;
  ok("生成了 svg 且闭合", svg.indexOf("<svg") === 0 && svg.indexOf("</svg>") > 0);
  ok("有折线（纽约金区间内多天）", (svg.match(/<polyline/g) || []).length >= 1,
    (svg.match(/<polyline/g) || []).length);
  /* A 股在 7 天里只剩 10-08 一天 → 五条线退化成"单点"（圆），
     所以这里按**点标记**数，而不是按 polyline 数 */
  ok("每只标的在图上都有标记", (svg.match(/<circle/g) || []).length >= 6,
    (svg.match(/<circle/g) || []).length);
  ok("Y 轴刻度带百分号", svg.indexOf("%</text>") > 0);
  /* 精确到值：0% 基准线是 "4 3"，期货线是 "6 6"（见下面 90 天段）。
     只写 /stroke-dasharray/ 的话，期货一旦也画虚线，这条就变成永远成立的空断言。 */
  ok("0% 基准线是虚线", svg.indexOf('stroke-dasharray="4 3"') > 0);
  ok("有悬停层（捕获矩形 + 高亮组）",
    svg.indexOf('id="dpHit"') > 0 && svg.indexOf('id="dpHoverG"') > 0);
  ok("标签数量自洽（开 = 闭 + 自闭合）", (function () {
    const open = (svg.match(/<(?!\/)[a-z]+/g) || []).length;
    const close = (svg.match(/<\/[a-z]+>/g) || []).length;
    const self = (svg.match(/\/>/g) || []).length;
    return open === close + self;
  })(), (function () {
    const open = (svg.match(/<(?!\/)[a-z]+/g) || []).length;
    const close = (svg.match(/<\/[a-z]+>/g) || []).length;
    return "open=" + open + " close=" + close;
  })());
  scan("折线图", svg);

  section("交易日太少的提醒（长假后 7 个自然日只剩 1 个交易日）");
  ok("出了提示", $("dpWarn").style.display !== "none");
  ok("提示里说明了原因（休市）", $("dpWarn").textContent.indexOf("休市") > 0,
    $("dpWarn").textContent);
  ok("点名了是哪几只", $("dpWarn").textContent.indexOf("紫金矿业") > 0,
    $("dpWarn").textContent);
  ok("给了出路（放宽范围）", $("dpWarn").textContent.indexOf("30 天") > 0,
    $("dpWarn").textContent);

  section("区间数据表");
  const tbl = $("dpTable").innerHTML;
  ok("有表格且闭合", tbl.indexOf("<table") > 0 && tbl.indexOf("</table>") > 0);
  ok("6 行数据（+1 行表头）", (tbl.match(/<tr>/g) || []).length === 7,
    (tbl.match(/<tr>/g) || []).length);
  ok("9 列 × 6 行 = 54 个单元格", (tbl.match(/<td/g) || []).length === 54,
    (tbl.match(/<td/g) || []).length);
  ok("涨跌幅带正负号", /[+-]\d+\.\d\d%/.test(tbl));
  ok("有「总市值」列", tbl.indexOf(">总市值<") > 0);

  /* ---- 按总市值从大到小排（2026-10-08 用户要求）----
     这里**逐行取名称**再比对整串顺序，而不是检查"某一行的市值比另一行大" ——
     后者在行序完全没动的时候也可能通过。市值取自 2026-10-08 的真实收盘，
     其中「四川黄金(185 亿) > 中国黄金(120 亿)」是关键的一对：它俩在
     INSTRUMENTS 里是**反着**的（中国黄金在前），所以只有真按市值排才会换过来。 */
  const order = [];
  const reRow = /<td><span class="dp-dot"[^>]*><\/span>([^<]+)<\/td>/g;
  let rm;
  while ((rm = reRow.exec(tbl))) order.push(rm[1]);
  ok("表是按总市值从大到小排的（期货没有市值 → 沉到最后）",
    order.join(" > ") === "紫金矿业 > 山东黄金 > 赤峰黄金 > 四川黄金 > 中国黄金 > 纽约金",
    order.join(" > "));
  ok("市值按亿显示、带千分位", tbl.indexOf("7,810 亿") > 0);
  ok("期货那一格是「—」而不是 0 亿", /纽约金[\s\S]{0,400}?<td class="num">—<\/td>/.test(tbl));
  ok("表头下说明了「—」是为什么", tbl.indexOf("纽约金是期货") > 0);
  ok("小节标题标出了排序依据", $("dpTableMeta").textContent.indexOf("按总市值从大到小") > 0,
    $("dpTableMeta").textContent);
  scan("数据表", tbl);

  section("切到 90 天");
  const before = $("dpChart").innerHTML;
  $("dpRange").fire("click", { target: { closest: () => ({ getAttribute: () => "90" }) } });
  const after = $("dpChart").innerHTML;
  ok("图表重画了", before !== after);
  ok("6 条线都在", (after.match(/<polyline/g) || []).length === 6,
    (after.match(/<polyline/g) || []).length);
  ok("图上方报出区间与交易日数",
    $("dpChartMeta").textContent.indexOf("2026-07-11 ~ 2026-10-08") === 0,
    $("dpChartMeta").textContent);
  ok("90 天里交易日够了 → 提示自己收起", $("dpWarn").style.display === "none",
    $("dpWarn").style.display);
  ok("表格跟着换了区间", $("dpTableMeta").textContent.indexOf("2026-07-11") >= 0,
    $("dpTableMeta").textContent);
  scan("90 天折线图", after);

  /* 期货画虚线 —— 线型是**常驻**的区分，不用动鼠标就看得到。
     这里把值写死成 "6 6"：它必须和 0% 基准线的 "4 3" 分开，
     否则上面那条"0% 基准线是虚线"就跟着失去意义了。 */
  ok("纽约金（期货）画的是虚线",
    /data-k="gold"[^>]*stroke-dasharray="6 6"/.test(after),
    (/<polyline[^>]*data-k="gold"[^>]*/.exec(after) || [""])[0].slice(0, 170));
  ok("A 股画实线（不带 stroke-dasharray）",
    !/data-k="zijin"[^>]*stroke-dasharray/.test(after));

  /* ---------------------------------------------------------------- 悬停认线
     六只标的上图后，"这条线是谁"必须能问出来。这里真的把鼠标移到线上的某一点，
     检查提示框把**那一行**置顶并高亮 —— 光验"提示框有内容"是没用的，
     六行里哪一行对应你指的那条，才是这个功能存在的理由。 */
  section("悬停到线上");
  const lineM = /<polyline[^>]*data-k="(gold|zijin)"[^>]*points="([^"]+)"/.exec(after);
  ok("能从图上按 data-k 取到某条线的数据点", !!lineM);
  const linePts = lineM[2].trim().split(" ").map(function (s) {
    return s.split(",").map(Number);
  });
  const midPt = linePts[Math.floor(linePts.length / 2)];
  const wantName = lineM[1] === "gold" ? "纽约金" : "紫金矿业";
  $("dpHit").fire("mousemove", { clientX: midPt[0], clientY: midPt[1] });
  const tip = $("dpTip").innerHTML;
  ok("鼠标指着的那条线被认出来了（该行置顶 + 高亮）",
    new RegExp('class="dp-tip-r dp-tip-r--on"[\\s\\S]{0,300}?dp-tip-n">' + wantName).test(tip),
    tip.slice(0, 220));
  ok("该行是提示框里的**第一**行（不然还得靠色点反查）",
    tip.indexOf("dp-tip-r--on") < tip.indexOf('class="dp-tip-r"'),
    tip.slice(0, 220));
  ok("提示框给出稳定标识（A 股代码 / 期货市场名）", tip.indexOf("dp-tip-c") >= 0,
    tip.slice(0, 220));
  ok("竖线画出来了", $("dpHoverG").innerHTML.indexOf("<line") === 0);
  /* 吸附点旁直接写出这是谁。提示框里虽然也有名称，但那是六行里的一行，
     眼睛得先找到它；标签贴在线本身上，视线不用离开图。 */
  ok("线上直接标注了被吸附标的的名称",
    new RegExp('<text class="dp-tag"[^>]*>' + wantName + "</text>").test($("dpHoverG").innerHTML),
    $("dpHoverG").innerHTML.slice(-180));
  ok("标签的 fill 是**该条线**的色（不是写死的一个色）",
    /class="dp-tag"[^>]*\bfill="#[0-9a-f]{6}"/i.test($("dpHoverG").innerHTML));
  /* 这条守的是 2026-10-08 在真实 Chrome 里逮到的 bug（CDP 实测）：
     `.dp-tip` 的 CSS 初始态是 display:none，JS 必须给 "block" 才显示；
     写 "" 会回落到 none —— 提示框**永远不出现**，而"有内容"的断言照样通过。
     详见 test_duality.js 同一处的完整说明。 */
  ok("提示框的 display 给的是具体值 block（不是空串）",
    $("dpTip").style.display === "block", $("dpTip").style.display);
  $("dpHit").fire("mouseleave", {});
  ok("移出图表后提示框收起", $("dpTip").style.display === "none",
    $("dpTip").style.display);

  section("取消一个标的");
  $("dpPicks").fire("change", { target: { type: "checkbox", checked: false, getAttribute: () => "zijin" } });
  ok("图上剩 5 条线", ($("dpChart").innerHTML.match(/<polyline/g) || []).length === 5,
    ($("dpChart").innerHTML.match(/<polyline/g) || []).length);
  ok("表格剩 5 行 + 表头", ($("dpTable").innerHTML.match(/<tr>/g) || []).length === 6,
    ($("dpTable").innerHTML.match(/<tr>/g) || []).length);
  ok("卡片变暗（不是消失，位置不能跳）", $("dpPicks").innerHTML.indexOf("dp-pick off") > 0);

  section("全部取消");
  ["gold", "cfgold", "sdgold", "zggold", "scgold"].forEach(k =>
    $("dpPicks").fire("change", { target: { type: "checkbox", checked: false, getAttribute: () => k } }));
  ok("给的是提示而不是一张空白图", $("dpChart").innerHTML.indexOf("dp-empty") > 0,
    $("dpChart").innerHTML.slice(0, 100));
  ok("表格也说明是没勾选", $("dpTable").innerHTML.indexOf("没有勾选") > 0,
    $("dpTable").innerHTML.slice(0, 100));

  console.log("\n" + (fail === 0
    ? "\x1b[32m全部通过 ✓\x1b[0m  (" + pass + " 项)"
    : "\x1b[31m有失败项 ✗\x1b[0m  通过 " + pass + "，失败 " + fail));
  process.exit(fail === 0 ? 0 : 1);

}).catch(function (e) {
  console.log("\n\x1b[31m渲染过程抛异常：\x1b[0m\n" + ((e && e.stack) || e));
  process.exit(1);
});
