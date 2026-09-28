/* 「A 股映射」悬停卡的用例（早盘总结 · 个股异动榜 / 个人关注池）
 *
 *   用法：node tools/test_biztip.js      （退出码 0 = 全通过）
 *
 * 为什么需要它
 * ------------
 * 这个功能有一堆「坏掉了页面照常显示、只是悄悄不对」的分支，而且
 * **用户很可能根本不会把它们当 bug 报出来** —— 悬停没反应时，人只会觉得
 * "这儿大概本来就没有"：
 *
 *   1. **拿不到数据时必须什么都不显示**，不能显示空卡，也不能拿
 *      「这家在 A 股没有对标」去顶替"还没加载" —— 后者是**有数据**时才成立的
 *      说法（peers 为空 ≠ 没拿到数据），混成一句就是把"不知道"说成"没有"。
 *   2. **组装的优先级不能反。** override（公司级精写）必须压过行业级 ——
 *      反了不报错，只是七姐妹那类精写内容被整段行业说明顶掉，谁都看不出来。
 *   3. **同一格内移动不能重新计时。** 光标在格子里动一下（落到公司名里那个
 *      「★ 巨头」药丸上）就要重算 120ms 的话，卡片会一直出不来。
 *   4. **定位要收在视口内。** 表格最右边几列贴着右沿，卡片不回收就跑出屏幕；
 *      屏幕最下面几行不翻上去，同样看不见。
 *   5. **光标移开要收卡。** fixed 定位的卡片不会跟着内容走 —— 移到价格列、
 *      滚动页面、改窗口大小，不收就会一直挂在半空。
 *
 * 做法与其它用例一致：最小 DOM 桩 + 合成数据，不碰浏览器与真实 JSON。
 * place() / render() 是纯函数直接调；粘合层靠手动触发注册到 document 上的
 * 那几个处理器来验（桩会把它们记下来）。
 */

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..") + "/";

/* 悬停是"等一拍"才发生的，用例里必须能 await —— 顶层 await 与 require 不能混用，
   所以整个用例体包在 async IIFE 里（与 test_linkage_bizfilter.js 同一写法）。 */
(async function () {

/* ------------------------------------------------------------------ DOM 桩 */

function mk(id) {
  return {
    id, innerHTML: "", textContent: "", hidden: false, style: {}, className: "",
    _a: {}, _h: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(t, f) { this._h[t] = f; },
    setAttribute(k, v) { this._a[k] = v; },
    getAttribute(k) { return this._a[k] === undefined ? null : this._a[k]; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    contains(t) { return this.children.some(c => c === t || (c.contains && c.contains(t))); },
    fire(t, ev) { if (this._h[t]) this._h[t].call(this, ev || {}); }
  };
}

/* 卡片尺寸在桩里给固定值，定位断言才算得准（真实浏览器量的是 offsetWidth/Height） */
const CARD_W = 300, CARD_H = 140;
const mkCard = () => Object.assign(mk("card"), { offsetWidth: CARD_W, offsetHeight: CARD_H });

/** 被悬停的格子。rect 用视口坐标（与 position:fixed 配套）。 */
function cell(sym, rect) {
  const n = {
    parentNode: null, children: [],
    _a: sym ? { "data-biztip": sym } : {},
    getAttribute(k) { return this._a[k] === undefined ? null : this._a[k]; },
    setAttribute(k, v) { this._a[k] = v; },
    contains(t) { return this.children.some(c => c === t || (c.contains && c.contains(t))); },
    getBoundingClientRect() { return rect; }
  };
  n.add = (child) => { n.children.push(child); child.parentNode = n; return child; };
  return n;
}
const RECT = { left: 100, top: 200, right: 200, bottom: 220 };

const docH = {};          // 应用是事件委托挂在 document 上的，桩把处理器记下来
const winH = {};
global.window = global;
global.innerWidth = 1000;
global.innerHeight = 800;
global.document = {
  getElementById(id) { return mk(id); },      // 这个用例不碰页面上的节点
  createElement() { return mkCard(); },
  body: Object.assign(mk("body"), {
    classList: {
      _s: {},
      add(c) { this._s[c] = true; }, remove(c) { delete this._s[c]; },
      contains(c) { return !!this._s[c]; }
    }
  }),
  addEventListener(t, f) { (docH[t] = docH[t] || []).push(f); }
};
global.addEventListener = function (t, f) { (winH[t] = winH[t] || []).push(f); };

function fireDoc(t, ev) { (docH[t] || []).forEach(f => f(ev || {})); }

/* ------------------------------------------------------------------ 组件 */

eval(fs.readFileSync(ROOT + "static/util.js", "utf8"));
eval(fs.readFileSync(ROOT + "static/bizmap.js", "utf8"));
eval(fs.readFileSync(ROOT + "static/biztip.js", "utf8"));

BizTip.DELAY = 0;          // 不为了一格提示去等真实的 120ms

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
const tick = () => new Promise(r => setTimeout(r, 1));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------- 0. BizMap.of（两页共用） */

/* 组装逻辑从 linkage.js 抽到 bizmap.js 之后，[明暗对照]与[早盘总结]两页走的
   就是同一条路径 —— 这一节钉住两页共同依赖的那几条契约。 */

const BIZ = {
  schema: 2,
  rows: {
    AAPL: { name: "Apple Inc.", industryKey: "Consumer Electronics" },
    NOPE: { name: "行业没定义的公司", industryKey: "没有这个行业" },
    AAT: { name: "American Assets Trust", industryKey: "REIT - Diversified" }
  },
  industries: {
    "Consumer Electronics": {
      zh: "消费电子", desc: "消费电子行业说明。",
      peers: [{ code: "002475", name: "立讯精密", business: "连接器与组装。" },
              { code: "002241", name: "歌尔股份", business: "声学器件。" }]
    },
    // 这个行业在 A 股没有对标：**有数据**，只是 peers 为空
    "REIT - Diversified": { zh: "房地产信托-综合", desc: "REIT 行业说明。", peers: [] }
  },
  overrides: {
    AAPL: { business: "苹果自己的业务（精写）。",
            peers: [{ code: "601138", name: "工业富联", business: "服务器代工。" }] }
  }
};

section("0. BizMap.of —— 组装与优先级（两页共用）");

ok("映射整包还没到 → null", BizMap.of(null, "AAPL") === null,
   "返回空壳会让上层说出「这家没有对标」这句它并不知道的话");
ok("目录里没有这家 → null", BizMap.of(BIZ, "ZZZZ") === null);
ok("空代码 → null", BizMap.of(BIZ, "") === null);

const eAapl = BizMap.of(BIZ, "AAPL");
ok("公司级精写优先于行业级", eAapl.scope === "company", "实际 " + eAapl.scope);
ok("公司级用的是 override 的业务描述", eAapl.business === "苹果自己的业务（精写）。");
ok("公司级用的是 override 的对标（不是行业池）", eAapl.peers.map(p => p.code).join(","), "601138");

const eInd = BizMap.of(BIZ, "NOPE");
ok("行业 key 取不到 → null，不给一个「有数据但没对标」的空壳", eInd === null,
   "空壳会让上层说出「这家在 A 股没有对标」——而真相是这行的行业没定义");

const eAat = BizMap.of(BIZ, "AAT");
ok("行业在 A 股没有对标 → 仍是**有效**对象（peers 为空）", !!eAat && eAat.peers.length === 0,
   "这与 null 是两回事，卡片要分别措辞");
check("带上行业中文名（卡片要靠它说明为什么一家也没列）", eAat.industryLabel, "房地产信托-综合");

/* ------------------------------------------------------------------ 1. 渲染 */

section("1. 渲染 —— 只给代码与名称，外加必须说清的口径");

const html = BizTip.render("AAPL", eAapl);
ok("列出 A 股代码", html.indexOf("601138") > 0);
ok("列出 A 股名称", html.indexOf("工业富联") > 0);
ok("不夹带业务描述（那是明暗对照页弹窗的内容）", html.indexOf("服务器代工") < 0);
ok("标明这是公司级对标", html.indexOf("公司级对标") > 0);
ok("写明业务相似 ≠ 供应链/客户/股权关系",
   html.indexOf("供应链") > 0 && html.indexOf("股权") > 0,
   "少了它，读者会把「立讯精密」读成苹果的供应商");

const eIndEntry = {
  scope: "industry", industryLabel: "消费电子", business: "消费电子行业说明。",
  peers: [{ code: "002475", name: "立讯精密" }]
};
const htmlInd = BizTip.render("MSFT", eIndEntry);
ok("行业级标明行业名", htmlInd.indexOf("消费电子") > 0);
ok("行业级标明是行业级（同行业所有美股共用一段说明）",
   htmlInd.indexOf("行业级对标") > 0);

const htmlNone = BizTip.render("AAT", eAat);
ok("没有对标时说清是「这个行业在 A 股没有标的」",
   htmlNone.indexOf("A 股暂无该行业的直接对标标的") > 0);
ok("没有对标时不画对标列表", htmlNone.indexOf("bt-list") < 0);
ok("没有对标时不出现「业务相似对标…」那句（没有对象可说）",
   htmlNone.indexOf("供应链") < 0);
ok("指路到明暗对照页看完整行业说明", htmlNone.indexOf("明暗对照") > 0);

check("entry 为 null → 空串（调用方据此不显示卡片）", BizTip.render("AAPL", null), "");
ok("空串不是「暂无」这类占位（那会把还没加载说成没有）",
   BizTip.render("AAPL", null).indexOf("暂无") < 0);

/* -------------------------------------------------------------- 2. 纯文本 */

section("2. 转义与纯文本（页面按文本渲染）");

const htmlEsc = BizTip.render("X<Y", {
  scope: "company", business: "b",
  peers: [{ code: "000001", name: '<b>甲</b> & "乙"' }]
});
ok("公司名里的尖括号被转义", htmlEsc.indexOf("&lt;b&gt;甲&lt;/b&gt;") > 0 && htmlEsc.indexOf("<b>甲") < 0);
ok("& 被转义", htmlEsc.indexOf("&amp;") > 0);
ok("代码里的尖括号也过转义", htmlEsc.indexOf("X&lt;Y") > 0);
ok("渲染结果里没有 markdown 星号", htmlEsc.indexOf("**") < 0);
ok("渲染结果里没有反引号", htmlEsc.indexOf("`") < 0);

/* ---------------------------------------------------------------- 3. 定位 */

section("3. 定位（视口坐标，与 position:fixed 配套）");

const vp = { w: 1000, h: 800 };
const size = { w: CARD_W, h: CARD_H };

const p1 = BizTip.place({ left: 100, top: 200, right: 200, bottom: 220 }, size, vp);
check("默认贴在格子下方", p1.top, 228);
check("左端与格子对齐", p1.left, 100);
check("默认不翻到上方", p1.above, "false");

const p2 = BizTip.place({ left: 900, top: 200, right: 990, bottom: 220 }, size, vp);
check("右边放不下 → 往左收，不越出视口", p2.left, 1000 - 8 - CARD_W);

const p3 = BizTip.place({ left: 2, top: 200, right: 60, bottom: 220 }, size, vp);
check("左边放不下 → 收进视口内", p3.left, 8);

const p4 = BizTip.place({ left: 100, top: 700, right: 200, bottom: 720 }, size, vp);
check("下方放不下且上方放得下 → 翻到上方", p4.above, "true");
check("翻上去时贴着格子上沿", p4.top, 700 - 8 - CARD_H);

const p5 = BizTip.place({ left: 100, top: 2, right: 200, bottom: 780 }, size, vp);
check("上下都放不下 → 贴住上沿，不滑出屏幕", p5.top, 8);

/* ---------------------------------------------------------- 4. 悬停交互 */

section("4. 悬停交互");

/* getter 读一个可变的 holder —— 与 morning.js 一致（那边读 state.biz），
   这样"数据还没到"与"数据到了"能在同一个实例上分别验。 */
let bizData = null;
BizTip.init({ get: sym => BizMap.of(bizData, sym) });

/* 早盘总结是**每次 render 都调一次 init**（不另设"只执行一次"的开关），
   幂等这件事必须由组件自己保证 —— 重复挂监听会让一次悬停触发 N 遍。 */
BizTip.init({ get: sym => BizMap.of(bizData, sym) });
check("重复 init 不重复挂监听", (docH["mouseover"] || []).length, 1);
check("重复 init 也不重复挂 mouseout", (docH["mouseout"] || []).length, 1);

const cNull = cell("ZZZZ", RECT);
const cAapl = cell("AAPL", RECT);
const plain = cell(null, { left: 400, top: 200, right: 500, bottom: 220 });   // 价格列那样的格子

BizTip.onOver({ target: cAapl });
await tick();
ok("映射还没到时什么都不显示（不是显示一张空卡）", BizTip.node().hidden === true);
check("没有留下「当前代码」这种半状态", BizTip.sym(), "");

bizData = BIZ;                     // 预热取数回来了

BizTip.onOver({ target: cAapl });
await tick();
ok("有映射 → 卡片显示", BizTip.node().hidden === false);
ok("内容是这家公司的 A 股对标", BizTip.node().innerHTML.indexOf("工业富联") > 0);
check("记录当前代码（同一格内移动时靠它判断要不要重来）", BizTip.sym(), "AAPL");
check("左端按格子定位", BizTip.node().style.left, RECT.left + "px");
check("贴在格子下方", BizTip.node().style.top, (RECT.bottom + 8) + "px");

/* 光标落到公司名里的「★ 巨头」药丸上时，事件目标是那个 span 而不是带属性的 td */
const badge = cAapl.add(cell(null, RECT));
BizTip.hide();
BizTip.onOver({ target: badge });
await tick();
ok("从格子内部的子元素进入也能认出这一格（往上找属性）", BizTip.node().hidden === false);
check("认出的仍是外层那一格", BizTip.sym(), "AAPL");

const before = BizTip.node().innerHTML;
BizTip.onOver({ target: badge });
ok("同一格内再移动不重画", BizTip.node().innerHTML === before);
ok("并且仍然显示着", BizTip.node().hidden === false);

/* 「不重置计时」必须用**真实的延迟**才验得出来：DELAY=0 时"重置了"和"没重置"
   看起来完全一样（都不需要等），上面那条是抓不住这个 bug 的。
   让时间真的流过去：40ms 的等待，中途在同一格里动一下，累计 50ms 后卡片该出现。 */
BizTip.DELAY = 40;
BizTip.hide();
BizTip.onOver({ target: cAapl });
await sleep(20);
BizTip.onOver({ target: badge });        // 同格内移动 —— 不许把等待重新计一遍
await sleep(30);                          // 距第一次已 50ms > 40ms
ok("同一格内移动不重置计时（重置的话卡片永远差这 20ms 出不来）",
   BizTip.node().hidden === false);
BizTip.DELAY = 0;

BizTip.onOver({ target: plain });
ok("移到没有映射的格子（价格 / 驱动原因列）→ 收卡", BizTip.node().hidden === true);
check("当前代码一并清空（下次回到格子能重新显示）", BizTip.sym(), "");

BizTip.onOver({ target: cell("AAT", { left: 100, top: 300, right: 200, bottom: 320 }) });
await tick();
ok("换一格 → 内容跟着换",
   BizTip.node().innerHTML.indexOf("A 股暂无该行业的直接对标标的") > 0);
ok("上一格的内容确实被替换掉了", BizTip.node().innerHTML.indexOf("工业富联") < 0);

/* mouseout：走到同一格内部不算离开，真的走远才收卡 */
BizTip.onOut({ target: cAapl, relatedTarget: badge });
ok("光标在同一格内移动 → 不收卡", BizTip.node().hidden === false);
BizTip.onOut({ target: cAapl, relatedTarget: plain });
ok("光标离开这一格 → 收卡", BizTip.node().hidden === true);

/* 同一行的两格（代码 ⇄ 公司名）挂的是**同一个代码**，卡片内容一模一样；
   光标沿一行横向划过时它们之间会走一次 mouseout。按"离开"处理的话卡片会
   闪一下，而且等待的 120ms 会从头再计一遍。所以 out 到"同一代码的另一格"
   不算离开。
   用真实延迟验：DELAY=40，从代码格横移到公司名格，累计 50ms 后卡片必须已在。 */
const cAapl2 = cell("AAPL", { left: 260, top: 200, right: 420, bottom: 220 });
BizTip.DELAY = 40;
BizTip.hide();
BizTip.onOver({ target: cAapl });
await sleep(20);
BizTip.onOut({ target: cAapl, relatedTarget: cAapl2 });
BizTip.onOver({ target: cAapl2 });          // 落在同行的公司名格上
await sleep(30);                            // 距第一次已 50ms > 40ms
ok("代码格 → 同行公司名格：不收卡、也不重置计时（否则沿一行划过会闪）",
   BizTip.node().hidden === false);
BizTip.DELAY = 0;

/* 反例：走到**另一个代码**的格子仍按离开处理 —— 判据是"代码相同"，
   不能宽成"都是表格里的数据格"。 */
BizTip.onOut({ target: cAapl, relatedTarget: cell("AAT", RECT) });
ok("走到另一个代码的格子 → 仍按离开处理", BizTip.node().hidden === true);

/* fixed 定位的卡片不会跟着内容走，所以滚动 / 改窗口 / 按下鼠标都要收 */
BizTip.onOver({ target: cAapl });
await tick();
ok("（前置）卡片已显示", BizTip.node().hidden === false);
fireDoc("scroll", {});
ok("页面滚动 → 收卡（否则卡片会留在原地飘着）", BizTip.node().hidden === true);

BizTip.onOver({ target: cAapl });
await tick();
fireDoc("mousedown", {});
ok("按下鼠标 → 收卡", BizTip.node().hidden === true);

BizTip.onOver({ target: cAapl });
await tick();
(winH["resize"] || []).forEach(f => f({}));
ok("改变窗口大小 → 收卡", BizTip.node().hidden === true);

/* 一条只能靠读 CSS 才验得到的约定：卡片必须不吃鼠标事件。
   一旦能吃，光标从格子移向卡片就会触发 mouseout，卡片自己把自己关掉、来回闪。 */
ok("样式里保留 pointer-events:none",
   fs.readFileSync(ROOT + "static/style.css", "utf8").indexOf("pointer-events:none") > 0);

/* ---------------------------------------------------------------- 汇总 */

console.log("\n" + "─".repeat(64));
if (fail) {
  console.log(`${fail} 项未通过 ✗`);
  process.exit(1);
}
console.log("全部通过 ✓");
process.exit(0);

})();
