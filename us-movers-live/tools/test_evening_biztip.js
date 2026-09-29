/* 夜盘异动「A 股映射悬停提示」的接线用例（2026-09-29 加）
 *
 *   用法：node tools/test_evening_biztip.js      （退出码 0 = 全通过）
 *
 * 背景：夜盘异动页原先最后一列是「A 股映射」（每行一个「点击查看」按钮 → 弹窗，
 * 事件驱动口径，见 sharemap.js）。用户 2026-09-29 要求**去掉那一列**，改成
 * "光标放在代码或公司名称时给出 A 股映射，交互和逻辑同个股异动榜一致" ——
 * 也就是与早盘总结页同一套：同一份数据（/api/us-business-map）、同一个组件
 * （biztip.js）、同一段接线与守卫（bizmap.js 的 attach / warm）。
 *
 * 为什么单独一个文件
 * ----------------
 * tools/test_biztip.js 验的是**组件本身**（渲染 / 定位 / 悬停行为），
 * tools/test_morning_biztip.js 验早盘页的接线。这一份验夜盘页的，且多两件事：
 *
 *   1. **那一列真的没了。** 列头、按钮、事件委托删不干净都不会报错，
 *      只会让表格多一格（或留一堆点了没反应的死按钮）。这里同时钉
 *      「8 列」「末列是驱动原因」「页面上没有 map-btn」。
 *   2. **两张表都要有触发点。** 主表与「被剔除对照表」走的是同一个 tableHtml，
 *      最容易只在其中一处生效 —— 而"另一处没反应"看起来就像数据缺失。
 *
 * 与早盘那份一样，这几节验的都是**能不能出卡**，不验光标：2026-09-28 用户要求
 * 去掉 `cursor:help`（问号），"数据到位"这个中间状态就不该再有断言 ——
 * 断言一个没有画面的类名，只会变成"删了它用例还是绿的"那种假通过。
 *
 * 做法：最小 DOM 桩 + 真实组件（util / combo / bizmap / biztip）+ 桩化 fetch，
 * 喂合成数据。每个环境用重新执行页面脚本的方式模拟（每次 eval 都是全新一份 state）。
 */

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..") + "/";

/* ------------------------------------------------------------------ DOM 桩 */

const els = {};
const store = {};

function mkClassList() {
  const set = {};
  return {
    add(c) { set[c] = true; },
    remove(c) { delete set[c]; },
    toggle(c, f) {
      const on = f === undefined ? !set[c] : !!f;
      if (on) set[c] = true; else delete set[c];
      return on;
    },
    contains(c) { return !!set[c]; }
  };
}

function mk(id) {
  return {
    id, innerHTML: "", textContent: "", value: "", hidden: false, style: {},
    className: "", offsetWidth: 0, offsetHeight: 0,
    classList: mkClassList(), _h: {}, _q: {}, _a: {}, dataset: {},
    addEventListener(t, f) { (this._h[t] = this._h[t] || []).push(f); },
    setAttribute(k, v) { this._a[k] = v; },
    getAttribute(k) { return this._a[k] === undefined ? null : this._a[k]; },
    hasAttribute(k) { return k in this._a; },
    appendChild(c) { c.parentNode = this; return c; },
    contains() { return false; },
    focus() {},
    querySelector(sel) { return this._q[sel] || (this._q[sel] = mk(id + sel)); },
    querySelectorAll() { return []; },
    fire(t, ev) { (this._h[t] || []).forEach(f => f.call(this, ev || {})); }
  };
}

/** 悬停卡那个 div：定位时要量尺寸（biztip.js 用 offsetWidth/Height） */
function mkCard() {
  const n = mk("biztip");
  n.offsetWidth = 300;
  n.offsetHeight = 140;
  return n;
}

global.window = global;
global.innerWidth = 1200;
global.innerHeight = 800;
global.scrollTo = function () {};
global.matchMedia = function () { return { matches: true }; };   // 默认：有悬停
global.localStorage = {
  getItem(k) { return k in store ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); },
  removeItem(k) { delete store[k]; }
};
global.document = {
  getElementById(id) {
    if (id === "exclHost") return els[id] || (els[id] = mk(id));
    return els[id] || (els[id] = mk(id));
  },
  createElement() { return mkCard(); },
  body: mk("body"),
  addEventListener() {}
};
global.addEventListener = function () {};

/* ------------------------------------------------------------- fetch 桩
   只认映射接口与原因接口，其余一律空 JSON。把调用记下来供断言。 */
let fetchCalls = [];
let bizResponse = null;
let failOnce = false;      // 让下一次映射请求直接 reject（测"失败后还能不能再取"）

global.fetch = function (url) {
  const u = String(url);
  fetchCalls.push(u);
  if (u.indexOf("us-business-map") >= 0) {
    if (failOnce) { failOnce = false; return Promise.reject(new Error("网络抖动")); }
    return Promise.resolve({ json: () => Promise.resolve(bizResponse) });
  }
  if (u.indexOf("/api/reasons") >= 0) {
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, reasons: {} }) });
  }
  return Promise.resolve({ json: () => Promise.resolve({}) });
};

/* ---------------------------------------------------------------- Shell 桩 */
let cap = null;
global.Shell = { state: {}, mount(o) { cap = o; }, syncCountdown() {} };

eval(fs.readFileSync(ROOT + "static/util.js", "utf8"));
eval(fs.readFileSync(ROOT + "static/combo.js", "utf8"));
eval(fs.readFileSync(ROOT + "static/bizmap.js", "utf8"));
eval(fs.readFileSync(ROOT + "static/biztip.js", "utf8"));
BizTip.DELAY = 0;          // 不必为了一格提示去等真实的 120ms

/* ---------------------------------------------------------------- 工具 */
let fail = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  if (!ok) fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}: ${got}${ok ? "" : "   (期望 " + want + ")"}`);
}
function ok(label, cond, why) {
  if (!cond) fail++;
  console.log(`  ${cond ? "✓" : "✗"} ${label}${cond ? "" : (why ? "   (" + why + ")" : "")}`);
}
function section(t) { console.log("\n" + t); }
const tick = () => new Promise(r => setTimeout(r, 2));
const count = (hay, needle) => hay.split(needle).length - 1;
const ths = (html) => (html.match(/<th[^>]*>([^<]*)<\/th>/g) || [])
  .map(s => s.replace(/<[^>]+>/g, ""));

/** 重新加载页面脚本 = 全新一份 state（模拟"再打开一次页面"或换一台设备）。
 *
 *  biztip.js 也要跟着换一份：它的 getter 是 init 时闭包捕获的**那一个** state，
 *  只重跑 evening.js 的话，后面的小节会拿着上一节的数据去断言 ——
 *  恰恰会变成"该静默的时候反而出了卡"这种假通过。 */
function reloadPage() {
  eval(fs.readFileSync(ROOT + "static/biztip.js", "utf8"));
  BizTip.DELAY = 0;
  eval(fs.readFileSync(ROOT + "static/evening.js", "utf8"));
}

/** 悬停目标：只需这几个方法（与 test_biztip.js 的格子桩同形） */
function hvCell(sym) {
  return {
    parentNode: null,
    _a: sym ? { "data-biztip": sym } : {},
    getAttribute(k) { return this._a[k] === undefined ? null : this._a[k]; },
    contains() { return false; },
    getBoundingClientRect() { return { left: 100, top: 200, right: 200, bottom: 220 }; }
  };
}

/* ------------------------------------------------------------ 合成数据 */

/* 公司名照实写（不用 sym+" Inc." 那种凑数写法）：下面有一处断言直接找
   "Apple Inc."，凑出来的名字会让那条断言以"像是渲染坏了"的样子失败。 */
function row(sym, name, chg, cap_) {
  return { symbol: sym, name: name, price: 12.34, chg: chg, marketCap: cap_,
           sector: "信息技术", industry: "半导体",
           sectorEn: "Technology", industryEn: "Semiconductors" };
}
const DATA = {
  ok: true,
  meta: { criteria: { big: "总市值 ≥ 100 亿美元，涨幅 ≥ 4%",
                      mid: "总市值 15–100 亿美元，涨幅 ≥ 10%",
                      tiny: "总市值 < 15 亿美元，全部剔除（仅列对照）" } },
  tables: {
    big_up: { title: "大市值涨幅 ≥ 4%", rows: [row("AAPL", "Apple Inc.", 5.2, 3.8e12)] },
    mid_up: { title: "小市值涨幅 ≥ 10%",
              rows: [row("AAT", "American Assets Trust", 11.1, 1.5e9),
                     row("ZZZZ", "ZZZZ Holdings", 12.0, 1.2e9)] }
  },
  counts: { big_up: 1, mid_up: 2, total: 3, excluded: 1 },
  excluded: [row("MSFT", "Microsoft", 9.9, 5.0e8)]   // 「被剔除对照表」也走同一个 tableHtml
};
function feed(d) { global.Shell.state.data = d; cap.onData(d); }

/* 与 tools/build_us_business_map.py 产出的结构一致（引用式三表）。
   版本号取 bizmap.js 里那一份，不在这里抄一个常量 —— 抄的那份迟早和
   server.py / bizmap.js 对不上，而"版本号该是多少"另有 tools/test_business_map_data.py 钉着。 */
const SCHEMA = BizMap.SCHEMA;
const BIZ = {
  ok: true, schema: SCHEMA, count: 3, covered: 2,
  rows: {
    AAPL: { name: "Apple Inc.", industryKey: "Consumer Electronics" },
    AAT: { name: "American Assets Trust", industryKey: "REIT - Diversified" },
    MSFT: { name: "Microsoft", industryKey: "Software" }
  },
  industries: {
    "Consumer Electronics": { zh: "消费电子", desc: "消费电子行业说明。",
      peers: [{ code: "002475", name: "立讯精密", business: "连接器与组装。" }] },
    "REIT - Diversified": { zh: "房地产信托-综合", desc: "REIT 行业说明。", peers: [] },
    "Software": { zh: "软件", desc: "软件行业说明。",
      peers: [{ code: "600588", name: "用友网络", business: "企业软件。" }] }
  },
  overrides: {}
};

(async function () {

/* ==================================================== 1. 表格形态与触发点 */

section("1. 表格形态（列已移除）与触发点（两张表都要有）");

bizResponse = BIZ;
fetchCalls = [];
reloadPage();
feed(DATA);

const html = els.tableHost.innerHTML;
const excl = els.exclHost.innerHTML;

check("表头列数", ths(html).length, 8);
check("末列是「驱动原因」", ths(html)[ths(html).length - 1], "驱动原因");
check("页面上没有「A 股映射」按钮列", count(html, 'class="map-btn'), 0);
check("表头里也没有「A 股映射」", count(html, "A 股映射"), 0);

check("主表每行的代码格与公司名格都挂了触发点（一行两处）",
      count(html, 'data-biztip="AAPL"'), 2);
ok("触发点放在 td 上（格子整块可触发）",
   html.indexOf('<td class="code" data-biztip="AAPL"') > 0 &&
   html.indexOf('<td class="name" data-biztip="AAPL"') > 0);
check("被剔除对照表同样挂了（走的是同一个 tableHtml）",
      count(excl, 'data-biztip="MSFT"'), 2);
check("属性里放的是**裸代码**（带市场前缀会查不到，且全程不报错）",
      count(html + excl, 'data-biztip="us'), 0);

/* ==================================================== 2. 预热与取数 */

section("2. 预热取数：只取一次");

check("首轮行情到达后取了一次映射", count(fetchCalls.join(" "), "us-business-map"), 1);

/* 请求还在路上时就又刷了一轮行情（心跳 60 秒，这样的事必然发生）——
   靠 bizLoading 挡住，别再发一遍。 */
feed(DATA);
check("请求还没回来时重刷 → 不重复发请求",
      count(fetchCalls.join(" "), "us-business-map"), 1);

await tick(); await tick();

/* 数据已经到手之后再刷 —— 这一次靠 biz 挡住。两层守卫各管一种时序，
   两处都要各自验一遍（只验一层，另一层被删掉也看不出来）。 */
fetchCalls = [];
feed(DATA);
check("映射到手后重刷 → 也不再取（426KB 不该反复搬）",
      count(fetchCalls.join(" "), "us-business-map"), 0);

/* ==================================================== 3. 悬停链路 */

section("3. 悬停：整条链路真的走通（属性只能证明「挂上了」）");

BizTip.onOver({ target: hvCell("AAPL") });
await tick();
ok("悬停代码格 → 弹出 A 股对标", BizTip.node().hidden === false);
ok("卡片里是这家公司的对标公司", BizTip.node().innerHTML.indexOf("立讯精密") > 0);
ok("带上了 A 股代码", BizTip.node().innerHTML.indexOf("002475") > 0);
ok("带上了那句口径说明（少了会让人读成供应链关系）",
   BizTip.node().innerHTML.indexOf("不代表存在供应链") > 0);

BizTip.onOver({ target: hvCell("AAT") });
await tick();
ok("所属行业在 A 股没有对标 → 如实说明，而不是空白",
   BizTip.node().innerHTML.indexOf("A 股暂无该行业的直接对标标的") > 0);

BizTip.onOver({ target: hvCell("ZZZZ") });
await tick();
ok("目录外的代码 → 不弹卡（不是弹一张空卡）", BizTip.node().hidden === true);

/* 「被剔除对照表」里的行也真的能出卡 —— 上面只验了属性在，这里验证它接得上 */
BizTip.onOver({ target: hvCell("MSFT") });
await tick();
ok("被剔除对照表的行同样能出卡", BizTip.node().innerHTML.indexOf("用友网络") > 0);

/* ==================================================== 4. 触屏不白搬数据 */

section("4. 触屏（hover:none）：不取这份数据");

global.matchMedia = function () { return { matches: false }; };
fetchCalls = [];
reloadPage();
feed(DATA);
await tick();

check("hover:none 下**不**请求映射", count(fetchCalls.join(" "), "us-business-map"), 0);

/* 触屏上这个功能不存在，所以数据永远是空 —— 悬停（如果真的发生）应当什么都不出，
   **不是**一张写着"暂无"的空卡。 */
BizTip.onOver({ target: hvCell("AAPL") });
await tick();
ok("没有数据 → 什么都不出（不是一张写着「暂无」的空卡）", BizTip.node().hidden === true);
ok("页面主体照常渲染（少一个悬停提示不该影响这张表）",
   els.tableHost.innerHTML.indexOf("Apple Inc.") > 0);

/* ==================================================== 5. 旧版服务 */

section("5. 旧版服务（响应结构对不上）：整块不启用");

global.matchMedia = function () { return { matches: true }; };
// 旧版响应：rows 逐家展开、没有 schema / industries / overrides
bizResponse = { ok: true, count: 1, rows: { AAPL: { name: "Apple Inc.", peers: [] } } };
fetchCalls = [];
reloadPage();
feed(DATA);
await tick(); await tick();

check("仍会去取（新旧服务端都得先拿到响应才能判断）",
      count(fetchCalls.join(" "), "us-business-map"), 1);

/* 旧结构的 rows 里也有 AAPL、也有一堆字段，照单全收的话用户会看到一份
   "这家公司没有对标"的结论 —— 而那只是服务没重启，不是事实。 */
BizTip.onOver({ target: hvCell("AAPL") });
await tick();
ok("版本对不上 → 悬停静默无反应", BizTip.node().hidden === true,
   "宁可什么都不给，也不能把半份数据当成完整结论渲染出来");

/* 上一条只说明"没出卡" —— 旧结构的 of() 恰好也返回 null，所以它还证明不了
   那个半份的响应**没被当成有效数据存下来**。再看一眼：真没存下来的话，
   重刷时会因为 state.biz 仍为空而再取一次。 */
fetchCalls = [];
feed(DATA);
check("半份响应没有被当成有效数据存下（重刷仍会去取）",
      count(fetchCalls.join(" "), "us-business-map"), 1);

/* 结构齐全、只是版本号不符：同样整块不启用。
   （这条与上面那条防的是两件事：那边是"字段没齐"，这边是"字段齐了但不是这一版"。） */
bizResponse = Object.assign({}, BIZ, { schema: SCHEMA + 1 });
fetchCalls = [];
reloadPage();
feed(DATA);
await tick(); await tick();
BizTip.onOver({ target: hvCell("AAPL") });
await tick();
ok("版本号不符 → 也不启用", BizTip.node().hidden === true);
ok("页面主体不受影响", els.tableHost.innerHTML.indexOf("Apple Inc.") > 0);

/* ==================================================== 6. 取数失败后还能再取 */

section("6. 取数失败（网络抖动）：标志要复位，下一轮还能再取");

/* 这条守卫在 bizmap.js 里（两页共用）：「复位放在最前面」和 catch 里的复位
   是同一条要求 —— bizLoading 若只在**成功**路径复位，一次抖动之后这一页
   就**再也不取**映射数据了：悬停永远空白，而全程没有任何异常，
   也没有任何界面提示。本项目在 other 处踩过同一个坑（见 evening.js 的 loadReasons）。

   ⚠️ 这条原先两个用例都没盯住（2026-09-29 用变异验证发现的：把 catch 里的复位
   删掉，两边的用例照样全绿）。守卫既然抽到了 bizmap.js，就由这一处统一盯住。 */

global.matchMedia = function () { return { matches: true }; };
bizResponse = BIZ;
failOnce = true;
fetchCalls = [];
reloadPage();
feed(DATA);
await tick(); await tick();

check("失败那一轮算一次请求", count(fetchCalls.join(" "), "us-business-map"), 1);

BizTip.onOver({ target: hvCell("AAPL") });
await tick();
ok("失败后悬停什么都不出（不是一张空卡）", BizTip.node().hidden === true);

fetchCalls = [];
feed(DATA);
check("失败后下一轮仍会重取（标志已复位）",
      count(fetchCalls.join(" "), "us-business-map"), 1);

await tick(); await tick();
BizTip.onOver({ target: hvCell("AAPL") });
await tick();
ok("重取成功后悬停恢复出卡", BizTip.node().innerHTML.indexOf("立讯精密") > 0);

/* ==================================================== 7. 脚本没引进来 */

section("7. 页面忘了引 bizmap.js：安静跳过，不把整页搞挂");

const savedBizMap = global.BizMap;
delete global.BizMap;              // 模拟 index.html 漏了 <script src="bizmap.js">
reloadPage();
fetchCalls = [];
feed(DATA);
await tick();

ok("表格照常渲染（少一个悬停提示不该把夜盘这张表弄挂）",
   els.tableHost.innerHTML.indexOf("Apple Inc.") > 0);
check("也没有去取那份 426KB", count(fetchCalls.join(" "), "us-business-map"), 0);
ok("触发点仍在（数据永远不会到，于是什么都不显示）",
   els.tableHost.innerHTML.indexOf("data-biztip") > 0);
global.BizMap = savedBizMap;

/* ---------------------------------------------------------------- 汇总 */

console.log("\n" + "─".repeat(64));
if (fail) {
  console.log(`${fail} 项未通过 ✗`);
  process.exit(1);
}
console.log("全部通过 ✓");
process.exit(0);

})();
