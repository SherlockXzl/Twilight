/* 早盘总结「A 股映射悬停提示」的接线用例
 *
 *   用法：node tools/test_morning_biztip.js      （退出码 0 = 全通过）
 *
 * 为什么单独一个文件
 * ----------------
 * tools/test_biztip.js 验的是**组件本身**（渲染 / 定位 / 悬停行为），
 * 这一份验的是**接线**——也就是最容易悄悄断掉、断了以后页面还完全正常的那几处：
 *
 *   1. **代码形态。** 映射数据的键是裸代码（AAPL），而关注池里的原始写法带市场
 *      前缀（usAAPL）。属性里忘了剥前缀，悬停会永远空白，**全程没有任何异常**。
 *   2. **两处触发点都要有。** 用户要求"代码或名称"都触发：异动榜是代码格 + 公司名格，
 *      关注池是方块里的代码 + 公司名。少挂一处不会报错，只是那一处没反应。
 *   3. **预热取数只在有悬停的设备上做。** 映射整包 426KB，触屏上这个功能根本
 *      触发不了；不分环境地取，等于让手机白搬一趟。
 *   4. **认版本号。** 服务端换了响应结构而进程没重启时（2026-09-28 真发生过），
 *      接口照样 200、字段却没齐 —— 照单全收的话每一格悬停都静默变空白，
 *      而数据其实躺在磁盘上。这时要整块不启用（悬停就当没这个功能）。
 *   5. **只取一次。** 切标签页、筛选都会重跑 render()，每次都重新取一遍
 *      426KB 是纯粹的浪费。
 *
 * 注意：这几节验的都是**能不能出卡**，不再验光标。2026-09-28 用户要求去掉
 * `cursor:help`（问号），"数据到位"这个中间状态也就不该再有自己的断言 ——
 * 断言一个没有画面的类名，只会变成"删了它用例还是绿的"那种假通过。
 *
 * 做法：最小 DOM 桩 + 真实组件（bizmap/biztip/combo/suggest）+ 桩化 fetch，
 * 喂合成数据。三个环境用重新执行页面脚本的方式模拟（与 test_linkage_bizfilter.js
 * 第 8 节同一手法 —— 每次 eval 都是全新的一份 state）。
 */

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..") + "/";

/* ------------------------------------------------------------------ 桩 */

let store = {};
const LS = {
  getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};

const els = {};
function mk(id) {
  return {
    id, innerHTML: "", textContent: "", value: "", hidden: false, style: {}, className: "",
    _a: {}, _h: {}, _q: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(t, f) { this._h[t] = f; },
    setAttribute(k, v) { this._a[k] = v; },
    getAttribute(k) { return this._a[k] === undefined ? null : this._a[k]; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    contains(t) { return this.children.some(c => c === t || (c.contains && c.contains(t))); },
    focus() {},
    querySelector(sel) { return this._q[sel] || (this._q[sel] = mk(id + sel)); },
    querySelectorAll() { return []; },
    fire(t, ev) { if (this._h[t]) this._h[t].call(this, ev || {}); }
  };
}
const mkCard = () => Object.assign(mk("card"), { offsetWidth: 300, offsetHeight: 140 });

global.window = global;
global.innerWidth = 1000;
global.innerHeight = 800;
global.localStorage = LS;
global.scrollTo = function () {};
global.matchMedia = function () { return { matches: true }; };   // 默认：有悬停
global.document = {
  getElementById(id) { return els[id] || (els[id] = mk(id)); },
  createElement() { return mkCard(); },
  body: mk("body"),
  addEventListener() {}
};
global.addEventListener = function () {};

let cap = null;
global.Shell = { state: {}, mount(o) { cap = o; }, syncCountdown() {} };

/* fetch 桩：只认两个地址，其余一律空 JSON。把调用记下来供断言。 */
let fetchCalls = [];
let bizResponse = null;
global.fetch = function (url) {
  const u = String(url);
  fetchCalls.push(u);
  if (u.indexOf("us-business-map") >= 0) {
    return Promise.resolve({ json: () => Promise.resolve(bizResponse) });
  }
  return Promise.resolve({ json: () => Promise.resolve({}) });
};

eval(fs.readFileSync(ROOT + "static/util.js", "utf8"));
eval(fs.readFileSync(ROOT + "static/combo.js", "utf8"));
eval(fs.readFileSync(ROOT + "static/suggest.js", "utf8"));
eval(fs.readFileSync(ROOT + "static/bizmap.js", "utf8"));
eval(fs.readFileSync(ROOT + "static/biztip.js", "utf8"));
BizTip.DELAY = 0;

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

/** 重新加载页面脚本 = 全新一份 state（模拟"再打开一次页面"或换一台设备）。
 *
 *  biztip.js 也要跟着换一份：它的 getter 是 init 时闭包捕获的**那一个** state，
 *  只重跑 morning.js 的话，第 3、4 节会拿着第 1 节的数据去断言 —— 恰恰会变成
 *  "该静默的时候反而出了卡"这种假通过。 */
function reloadPage() {
  eval(fs.readFileSync(ROOT + "static/biztip.js", "utf8"));
  BizTip.DELAY = 0;
  eval(fs.readFileSync(ROOT + "static/morning.js", "utf8"));
}

function feed(d) { global.Shell.state.data = d; cap.onData(d); }

/** 悬停目标：只需这几个方法（与 test_biztip.js 的格子桩同形） */
function hvCell(sym) {
  return {
    parentNode: null, children: [],
    _a: sym ? { "data-biztip": sym } : {},
    getAttribute(k) { return this._a[k] === undefined ? null : this._a[k]; },
    contains() { return false; },
    getBoundingClientRect() { return { left: 100, top: 200, right: 200, bottom: 220 }; }
  };
}

(async function () {

/* ------------------------------------------------------------ 合成数据 */

const MOVERS = [
  { symbol: "AAPL", name: "Apple Inc.", price: 250.1, chg: 5.2, marketCap: 3.8e12,
    sector: "信息技术", industry: "消费电子", driver: "新品发布", giant: true },
  { symbol: "AAT", name: "American Assets Trust", price: 20.1, chg: 4.4, marketCap: 1.5e9,
    sector: "房地产", industry: "房地产信托-综合", driver: "被纳入指数" }
];
const WATCHLIST = [
  { code: "usAAPL", name: "Apple Inc.", chgPct: 5.2, close: 250.1 },
  { code: "usMSFT", name: "Microsoft", chgPct: -0.4, close: 500.2 }
];
const MORNING = { ok: true, movers: MOVERS, watchlist: WATCHLIST };

/* 与 tools/build_us_business_map.py 产出的结构一致（引用式三表） */
const BIZ = {
  ok: true, schema: 2, count: 3, covered: 2,
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

/* ==================================================== 1. 触发点与代码形态 */

section("1. 两处触发点 + 代码形态（最易悄悄失效的一节）");

bizResponse = BIZ;
fetchCalls = [];
reloadPage();
feed(MORNING);

const mvHtml = els["mvTableHost"].innerHTML;
const wlHtml = els["wlHost"].innerHTML;

check("异动榜每行的代码格与公司名格都挂了触发点（一行两处）",
      count(mvHtml, 'data-biztip="AAPL"'), 2);
ok("异动榜的触发点放在 td 上（格子整块可触发）",
   mvHtml.indexOf('<td class="code" data-biztip="AAPL"') > 0 &&
   mvHtml.indexOf('<td class="name" data-biztip="AAPL"') > 0);
check("关注池的代码与公司名同样各挂一处",
      count(wlHtml, 'data-biztip="AAPL"'), 2);
ok("关注池里带市场前缀的原始代码也挂上了", wlHtml.indexOf('data-biztip="MSFT"') > 0);
check("属性里放的是**裸代码**（usAAPL → AAPL）",
      count(wlHtml, 'data-biztip="us'), 0);
ok("原始代码仍留在移除按钮上（数据层不改）", wlHtml.indexOf('data-code="usAAPL"') > 0);

/* ==================================================== 2. 预热与取数 */

section("2. 预热取数：只取一次，且只在会触发它的设备上");

check("进页面后取了一次映射", count(fetchCalls.join(" "), "us-business-map"), 1);

/* 请求还在路上时就重跑一次 render（切标签页/刷新很快，这样的事会发生）——
   靠 bizLoading 挡住，别再发一遍。 */
feed(MORNING);
check("请求还没回来时重跑 render → 不重复发请求",
      count(fetchCalls.join(" "), "us-business-map"), 1);

await tick(); await tick();

/* 数据已经到手之后再重跑 render —— 这一次靠 biz 挡住。
   两层守卫各管一种时序，所以两处都要各自验一遍（只验一层，另一层被删掉
   也看不出来）。 */
fetchCalls = [];
feed(MORNING);
check("映射到手后重跑 render → 也不再取（426KB 不该反复搬）",
      count(fetchCalls.join(" "), "us-business-map"), 0);

/* 真的走一遍悬停：属性只说明"挂上了"，这一步验的是整条链路
   （属性值 → morning.js 的 getter → BizMap 组装 → 卡片内容）。
   这也是"数据到位"唯一值得断言的口径 —— 数据到了就该出卡。 */
BizTip.onOver({ target: hvCell("AAPL") });
await tick();
ok("悬停代码格 → 弹出 A 股对标", BizTip.node().hidden === false);
ok("卡片里是这家公司的对标公司", BizTip.node().innerHTML.indexOf("立讯精密") > 0);
ok("带上了 A 股代码", BizTip.node().innerHTML.indexOf("002475") > 0);

BizTip.onOver({ target: hvCell("AAT") });
await tick();
ok("行业在 A 股没有对标的公司 → 如实说明，而不是空白",
   BizTip.node().innerHTML.indexOf("A 股暂无该行业的直接对标标的") > 0);

BizTip.onOver({ target: hvCell("ZZZZ") });
await tick();
ok("目录外的代码 → 不弹卡（不是弹一张空卡）", BizTip.node().hidden === true);

/* ==================================================== 3. 触屏不白搬数据 */

section("3. 触屏（hover:none）：不取这份数据");

global.matchMedia = function () { return { matches: false }; };
fetchCalls = [];
reloadPage();
feed(MORNING);
await tick();

check("hover:none 下**不**请求映射", count(fetchCalls.join(" "), "us-business-map"), 0);

/* 触屏上这个功能不存在，所以数据永远是空 —— 悬停（如果真的发生）应当什么都不出，
   **不是**一张写着"暂无"的空卡。 */
BizTip.onOver({ target: hvCell("AAPL") });
await tick();
ok("没有数据 → 什么都不出（不是一张写着「暂无」的空卡）", BizTip.node().hidden === true);
ok("页面主体照常渲染（少一个悬停提示不该影响复盘）",
   els["mvTableHost"].innerHTML.indexOf("Apple Inc.") > 0);

/* ==================================================== 4. 旧版服务 */

section("4. 旧版服务（没重启 / 响应结构对不上）：整块不启用");

global.matchMedia = function () { return { matches: true }; };
// 旧版响应：rows 逐家展开、没有 schema / industries / overrides
bizResponse = { ok: true, count: 1, rows: { AAPL: { name: "Apple Inc.", peers: [] } } };
fetchCalls = [];
reloadPage();
feed(MORNING);
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
   重跑 render 时会因为 state.biz 仍为空而再取一次。
   （这条断言的是"没接受"，不是"重试很好"—— 旧版服务只能靠重启解决，
   取多少次都一样；只是它顺带把这个证据暴露了出来。） */
fetchCalls = [];
feed(MORNING);
check("半份响应没有被当成有效数据存下（重跑 render 仍会去取）",
      count(fetchCalls.join(" "), "us-business-map"), 1);

ok("页面主体不受影响", els["mvTableHost"].innerHTML.indexOf("Apple Inc.") > 0);

/* ---------------------------------------------------------------- 汇总 */

console.log("\n" + "─".repeat(64));
if (fail) {
  console.log(`${fail} 项未通过 ✗`);
  process.exit(1);
}
console.log("全部通过 ✓");
process.exit(0);

})();
