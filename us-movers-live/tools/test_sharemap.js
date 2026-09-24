/* 夜盘「A 股映射」列与弹窗的用例
 *
 *   用法：node tools/test_sharemap.js      （退出码 0 = 全通过）
 *
 * 为什么需要这个用例
 * ------------------
 * 这一列有三个「改错了页面照常显示、只是内容悄悄不对」的地方：
 *
 *   1. **强度徽章的 class 拼接**。写 `'sm-badge--' + k` 是对的；一旦写成
 *      `'sm-S' + k` 就会拼出 `sm-SS` 这种不存在的类名 —— 徽章变成没有底色的空框，
 *      但字还在，看着只是"样式没生效"。（开发这一版时真写错过一次。）
 *   2. **无数据时的按钮态**。这里刻意选了「可点但变灰」而不是禁用：
 *      点开有说明，比一个说不出原因的灰按钮有用。这条是设计决定，必须钉住，
 *      否则很容易被后来的人"顺手"改成 disabled。
 *   3. **渲染的转义**。映射内容来自联网检索的分析文本，直接拼进 innerHTML
 *      而不转义会把内容里的尖括号当标签。用 U.esc 是本项目的一贯做法
 *      （驱动原因踩过 markdown 的坑，见 README）。
 *
 * 另外 Modal 的关闭路径（ESC / 点遮罩 / 关闭按钮）也要盯：
 * 点遮罩误判成"点弹窗内部"会导致关不掉，而这种现象只在真浏览器里才看得出来。
 *
 * 做法与其它用例一致：最小 DOM 桩 + 合成数据，不依赖浏览器与真实 JSON。
 */

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..") + "/";

/* ------------------------------------------------------------------ DOM 桩
 * 只需要支撑 modal.js 实际用到的那几个 API。**不解析 innerHTML** ——
 * modal.js 的所有元素访问都走 querySelector，所以桩按选择器返回占位节点即可。 */
let focused = null;
const documentHandlers = {};

function mkNode(tag) {
  const node = {
    tagName: tag || "div",
    className: "",
    hidden: false,
    innerHTML: "",
    textContent: "",
    dataset: {},
    style: {},
    scrollTop: 0,
    _q: {},
    _h: {},
    classList: {
      add() {}, remove() {},
      toggle() {}, contains() { return false; }
    },
    addEventListener(type, fn) { (node._h[type] = node._h[type] || []).push(fn); },
    appendChild() {},
    focus() { focused = node; },
    querySelector(sel) {
      if (!node._q[sel]) node._q[sel] = mkNode("div");
      return node._q[sel];
    },
    _fire(type, ev) { (node._h[type] || []).forEach((f) => f(ev || {})); }
  };
  return node;
}

global.window = {};
global.document = {
  body: { style: {}, appendChild() {} },
  createElement: mkNode,
  activeElement: null,
  addEventListener(type, fn) { (documentHandlers[type] = documentHandlers[type] || []).push(fn); }
};

require(ROOT + "static/sharemap.js");
require(ROOT + "static/modal.js");
const S = global.window.ShareMap;
const Modal = global.window.Modal;

/* ------------------------------------------------------------------ 断言 */

let pass = 0;
const fails = [];

function check(name, got, want) {
  const ok = got === want;
  if (ok) pass++;
  else fails.push(`${name}\n      期望 ${JSON.stringify(want)}\n      实际 ${JSON.stringify(got)}`);
}
function checkTrue(name, cond) {
  if (cond) pass++;
  else fails.push(name);
}
function section(t) { console.log("\n── " + t + " " + "─".repeat(Math.max(0, 58 - t.length))); }

/* ------------------------------------------------------------------ 合成数据 */

function item(over) {
  return Object.assign({
    code: "600728", name: "佳都科技", type: "股权/生态",
    reason: "参与成立 Unity 中国", evidence: "公司公告",
    strength: "S", elasticity: "中", risk: "收入占比需跟踪"
  }, over || {});
}

const FULL = {
  basis: "us-stock-to-a-share-mapper",
  generatedAt: "2026-09-24T14:05:33+08:00",
  categories: ["硬件发布/销量超预期"],
  driverBreakdown: "Meta 硬件扩容 → 开发者池扩容 → 引擎生态受益",
  rows: [
    item({ code: "600728", name: "佳都科技", strength: "S" }),
    item({ code: "002241", name: "歌尔股份", strength: "A", type: "供应链" }),
    item({ code: "300752", name: "隆利科技", strength: "B", type: "供应链" }),
    item({ code: "000977", name: "浪潮信息", strength: "C", type: "主题映射" }),
    item({ code: "999999", name: "伪映射测试", strength: "D" })
  ],
  logic: ["第一条逻辑", "第二条逻辑"]
};

/* ================================================================== 1. 市场标记 */
section("1. 6 位代码 → 交易所短标");
check("6 开头 = 沪", S.marketOf("600728"), "SH");
check("688 = 沪（科创）", S.marketOf("688608"), "SH");
check("0 开头 = 深", S.marketOf("000977"), "SZ");
check("3 开头 = 深（创业）", S.marketOf("300752"), "SZ");
check("8 开头 = 北", S.marketOf("830799"), "BJ");
check("4 开头 = 北", S.marketOf("430047"), "BJ");
check("美股代码不给标记", S.marketOf("AAPL"), "");
check("空值不给标记", S.marketOf(""), "");
check("位数不足不给标记", S.marketOf("60072"), "");
check("带空格也能识别", S.marketOf(" 600728 "), "SH");

/* ================================================================== 2. 按钮 */
section("2. 映射列的按钮");

{
  const b = S.button("U", "Unity Software", FULL);
  checkTrue("有数据：文案是「点击查看」", b.indexOf(">点击查看<") >= 0);
  checkTrue("有数据：不带 --none 灰化类", b.indexOf("map-btn--none") < 0);
  checkTrue("有数据：class 含 map-btn", /class="map-btn"/.test(b));
  checkTrue("有数据：title 带候选数量", b.indexOf("查看 5 只候选") >= 0);
  checkTrue("有数据：带 data-sym", b.indexOf('data-sym="U"') >= 0);
  checkTrue("有数据：带 data-name", b.indexOf('data-name="Unity Software"') >= 0);
}

{
  const b = S.button("P", "Everpure Inc", null);
  checkTrue("无数据：仍是按钮（不禁用）", b.indexOf("<button") >= 0 && b.indexOf("disabled") < 0);
  checkTrue("无数据：带 --none 灰化类", b.indexOf("map-btn--none") >= 0);
  checkTrue("无数据：title 说明状态", b.indexOf("还没有 A 股映射分析") >= 0);
}

checkTrue("rows 为空数组也算无数据",
  S.button("X", "X", { rows: [] }).indexOf("map-btn--none") >= 0);
checkTrue("map 缺少 rows 也算无数据",
  S.button("X", "X", {}).indexOf("map-btn--none") >= 0);

{
  // 公司名里带引号与尖括号时不能把属性撑破
  const b = S.button("Q", 'A"B<C&D', null);
  checkTrue("属性转义：双引号被转义", b.indexOf("&quot;") >= 0);
  checkTrue("属性转义：左尖括号被转义", b.indexOf("&lt;") >= 0);
  checkTrue("属性转义：与号被转义", b.indexOf("&amp;") >= 0);
  checkTrue("属性转义：没有裸引号漏进属性", b.indexOf('data-name="A"B') < 0);
}

/* ================================================================== 3. 渲染 */
section("3. 弹窗内容渲染");

const empty1 = S.render(null, {});
const empty2 = S.render({}, {});
const empty3 = S.render({ rows: [] }, {});
checkTrue("null → 说明文案", empty1.indexOf("还没有 A 股映射分析") >= 0);
checkTrue("空对象 → 说明文案", empty2.indexOf("还没有 A 股映射分析") >= 0);
checkTrue("空 rows → 说明文案", empty3.indexOf("还没有 A 股映射分析") >= 0);
checkTrue("说明文案里点出数据来源（便于排障）",
  empty1.indexOf("us-stock-to-a-share-mapper") >= 0);
checkTrue("说明文案里不含候选区标题", empty1.indexOf("候选 A 股") < 0);

const html = S.render(FULL, { driver: "Meta Connect 2026 开幕" });

checkTrue("有 driver → 显示「映射依据」", html.indexOf("映射依据") >= 0);
checkTrue("映射依据里带上了驱动原因原文", html.indexOf("Meta Connect 2026 开幕") >= 0);
checkTrue("无 driver → 不显示「映射依据」",
  S.render(FULL, {}).indexOf("映射依据") < 0);

checkTrue("显示驱动归类", html.indexOf("驱动归类") >= 0);
checkTrue("归类标签内容正确", html.indexOf("硬件发布/销量超预期") >= 0);
checkTrue("显示驱动拆解", html.indexOf("驱动拆解") >= 0);
checkTrue("拆解内容正确", html.indexOf("开发者池扩容") >= 0);

checkTrue("有「候选 A 股」小标题", html.indexOf("候选 A 股") >= 0);
checkTrue("带强度图例（解释 S/A/B/C）", html.indexOf("直接股权/独家") >= 0);

// 强度徽章：每一级都要拼出正确的类名（这里最容易出现 sm-SS 这类错拼）
["S", "A", "B", "C", "D"].forEach((k) => {
  checkTrue("徽章类名 sm-badge--" + k + " 正确",
    html.indexOf("sm-badge--" + k) >= 0);
  checkTrue("左侧竖条类名 sm-item--" + k + " 正确",
    html.indexOf("sm-item--" + k) >= 0);
});
checkTrue("没有拼错的 sm-badge--S S 之类",
  html.indexOf("sm-badge--SS") < 0 && html.indexOf("sm-badge--AA") < 0);

// 按竖条类计数 —— 不能用 /class="sm-item/，那会把 sm-item-hd（卡片内的头行）也数进去
checkTrue("五只候选都渲染了", (html.match(/sm-item--/g) || []).length === 5);
checkTrue("代码渲染正确", html.indexOf("600728") >= 0 && html.indexOf("999999") >= 0);
checkTrue("交易所短标渲染正确", html.indexOf(">SH<") >= 0 && html.indexOf(">SZ<") >= 0);
checkTrue("关联类型作为标签渲染", html.indexOf("股权/生态") >= 0);
checkTrue("业绩弹性渲染", html.indexOf("业绩弹性 中") >= 0);
checkTrue("证据字段渲染", html.indexOf("证据") >= 0 && html.indexOf("公司公告") >= 0);
/* 个股风险行 2026-09-24 按用户要求去掉。注意测试数据里**仍带着** risk 字段
   （合成数据没删），所以这条真正验证的是"有数据也不渲染"，
   而不是"数据里没有所以没渲染"—— 后者等于没测。 */
checkTrue("不再渲染个股风险行", html.indexOf("<b>风险</b>") < 0);
checkTrue("个股风险的文案也不出现", html.indexOf("收入占比需跟踪") < 0);

checkTrue("有「核心映射逻辑」", html.indexOf("核心映射逻辑") >= 0);
checkTrue("逻辑条目都渲染", html.indexOf("第一条逻辑") >= 0 && html.indexOf("第二条逻辑") >= 0);

/* 2026-09-24 按用户要求：弹窗里不再显示这三块 —— 风险提示（5 条）、免责声明、
   「映射生成于 …」。每个弹窗都重复一遍同样的话，把候选列表压到了折叠线以下。
   下面刻意断言的是「**不再出现**」而不是删掉测试：它们出现过，也随时可能被
   谁"顺手加回来"（文案和样式都还在文件里留着）。 */
checkTrue("不再显示「风险提示」标题", html.indexOf("风险提示") < 0);
checkTrue("不再渲染固定风险条目",
  !S.constants.RISK_ITEMS.some((t) => html.indexOf(t) >= 0));
checkTrue("不再显示免责声明", html.indexOf("不构成证券投资咨询") < 0);
checkTrue("不再显示「不构成投资建议」", html.indexOf("不构成任何投资建议") < 0);
checkTrue("不再显示生成时间",
  html.indexOf("映射生成于") < 0 && html.indexOf("2026-09-24T14:05") < 0);

// 常量本身要留着 —— 它们属于 skill 口径，将来若改在别处统一展示可直接取用
checkTrue("风险条目常量仍保留（5 条）", S.constants.RISK_ITEMS.length === 5);
checkTrue("免责声明常量仍保留", S.constants.DISCLAIMER.length > 0);
checkTrue("常量里没有 markdown 星号（它们可能被直接渲染）",
  !S.constants.RISK_ITEMS.some((t) => t.indexOf("**") >= 0) &&
  S.constants.DISCLAIMER.indexOf("**") < 0);

// 未知强度不能产生野类名，也不能让整个渲染崩掉
{
  const odd = S.render({ rows: [item({ strength: "X", code: "000001" })] }, {});
  checkTrue("未知强度不生成徽章", odd.indexOf("sm-badge") < 0);
  checkTrue("未知强度不生成竖条类", odd.indexOf("sm-item--X") < 0);
  checkTrue("未知强度仍然渲染该行", odd.indexOf("000001") >= 0);
}

// 转义：分析文本是从联网检索里来的，不能当 HTML 拼
{
  const risky = S.render({
    rows: [item({ reason: '<script>alert(1)</script>', name: 'A<B' })]
  }, { driver: '<img src=x onerror=y>' });
  checkTrue("关联原因里的标签被转义", risky.indexOf("<script>") < 0);
  checkTrue("关联原因内容仍在（只是转义）", risky.indexOf("alert(1)") >= 0);
  checkTrue("公司名里的尖括号被转义", risky.indexOf("A&lt;B") >= 0);
  checkTrue("驱动原因里的标签被转义", risky.indexOf("<img src=x") < 0);
}

/* ================================================================== 4. Modal */
section("4. 弹窗开关");

const el = Modal.node();
check("初始未打开", Modal.isOpen(), false);
check("初始是隐藏的", el.hidden, true);

global.document.activeElement = mkNode("button");
Modal.open({ title: "标题", subtitle: "副标题", bodyHtml: "<p>正文</p>" });
check("open 后 isOpen", Modal.isOpen(), true);
check("open 后不再 hidden", el.hidden, false);
check("打开时锁住页面滚动", global.document.body.style.overflow, "hidden");
check("标题写入", el.querySelector(".modal-title").textContent, "标题");
check("副标题写入", el.querySelector(".modal-sub").textContent, "副标题");
check("正文写入", el.querySelector(".modal-bd").innerHTML, "<p>正文</p>");
check("正文滚动位置归零", el.querySelector(".modal-bd").scrollTop, 0);
check("焦点移到关闭按钮", focused, el.querySelector(".modal-x"));

Modal.close();
check("close 后 isOpen 为假", Modal.isOpen(), false);
check("close 后恢复隐藏", el.hidden, true);
check("关闭时还原滚动", global.document.body.style.overflow, "");
check("关闭后焦点归还触发元素", focused, global.document.activeElement);

// 没有副标题时应当收起那一行，否则标题下会留一条空白
Modal.open({ title: "只有标题", bodyHtml: "" });
check("无副标题时隐藏副标题行", el.querySelector(".modal-sub").hidden, true);
Modal.close();

// ESC
Modal.open({ title: "ESC 测试" });
(documentHandlers.keydown || []).forEach((f) => f({ key: "Escape" }));
check("ESC 能关闭", Modal.isOpen(), false);
check("ESC 大小写无关（Escape 是标准键名）", el.hidden, true);

// 非 ESC 键不该关
Modal.open({ title: "其他键" });
(documentHandlers.keydown || []).forEach((f) => f({ key: "a" }));
check("按其它键不会关闭", Modal.isOpen(), true);

// 点遮罩关、点内部不关
el._fire("click", { target: el.querySelector(".modal-bd") });
check("点弹窗内部不关闭", Modal.isOpen(), true);
el._fire("click", { target: el });
check("点遮罩关闭", Modal.isOpen(), false);

// 单例：多次 open 不会叠出第二个遮罩
Modal.open({ title: "第一次" });
Modal.open({ title: "第二次" });
check("重复 open 仍是同一个实例", Modal.node(), el);
check("重复 open 后标题是最后一次的",
  el.querySelector(".modal-title").textContent, "第二次");
check("重复 open 后仍然处于打开态", Modal.isOpen(), true);
Modal.close();

// 关闭后再打开：overflow 不能"锁死"（原值被记成 hidden 是典型 bug）
Modal.open({ title: "A" });
Modal.close();
check("关闭后 overflow 回到空", global.document.body.style.overflow, "");
Modal.open({ title: "B" });
Modal.close();
check("二次开关后 overflow 仍能还原", global.document.body.style.overflow, "");

// 调用方原本设过内联 overflow 时要还原成原值，而不是空串
global.document.body.style.overflow = "auto";
Modal.open({ title: "C" });
Modal.close();
check("还原为调用方原本的 overflow", global.document.body.style.overflow, "auto");
global.document.body.style.overflow = "";

/* ------------------------------------------------------------------ 汇总 */

console.log("\n" + "─".repeat(64));
if (fails.length) {
  console.log(`${fails.length} 项未通过 ✗\n`);
  fails.forEach((f) => console.log("  ✗ " + f));
  console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
  process.exit(1);
}
console.log(`全部通过 ✓   共 ${pass} 项`);
