/* 「A 股公司业务映射」列与弹窗的用例（明暗对照页）
 *
 *   用法：node tools/test_businessmap.js      （退出码 0 = 全通过）
 *
 * 为什么需要它
 * ------------
 * 这一列有四个「改错了页面照常显示」的地方：
 *
 *   1. **那句口径说明不能丢**。「以上按业务相似筛选，不代表供应链／客户／股权关系」——
 *      少一句，读者会把「歌尔股份」直接读成「苹果的供应商」。而这个区别光看
 *      公司名和行业标签是看不出来的，没人会怀疑。
 *   2. **默认必须折叠**。四五个业务描述全展开的话，弹窗比正文还长，
 *      「先扫一遍有哪几家、再挑着看」这个用法就没了。
 *   3. **按钮的两态**（有数据 / 无数据）在两页之间必须一致：
 *      数据在明暗对照页只有 7 家，其余 4000 多行都是灰按钮 ——
 *      如果哪天被改成 disabled，用户就再也看不到"为什么没有、要跑哪个脚本"。
 *   4. **纯文本渲染**。业务描述是中文长句，混进 markdown 星号会原样显示成星号
 *      （今天在驱动原因和这里各踩过一次）。
 *
 * 做法与其它用例一致：合成数据，不依赖浏览器与真实 JSON。
 */

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..") + "/";

// mapbtn.js 与 businessmap.js 都是纯函数（不碰 DOM），所以不必搭 DOM 桩
// window 指向 global 本身，与 test_sharemap.js / test_evening_tabs.js 一致：
// 脚本之间会互相引用裸全局名（浏览器里那就是 window 的属性）。
// 写成 `global.window = {}` 会让 `window.X` 有值、而模块作用域里的 `X` 取不到，
// 报出来的却是 "X is not defined" —— 很容易看糊。
global.window = global;
require(ROOT + "static/mapbtn.js");
require(ROOT + "static/businessmap.js");
const MapBtn = global.window.MapBtn;
const B = global.window.BusinessMap;

let pass = 0;
const fails = [];
function check(name, got, want) {
  if (got === want) pass++;
  else fails.push(`${name}\n      期望 ${JSON.stringify(want)}\n      实际 ${JSON.stringify(got)}`);
}
function checkTrue(name, cond) { check(name, !!cond, true); }
function section(t) { console.log("\n── " + t + " " + "─".repeat(Math.max(0, 58 - t.length))); }

/* ------------------------------------------------------------------ 合成数据 */

function peer(over) {
  return Object.assign({
    code: "002475", name: "立讯精密", industry: "消费电子",
    business: "从连接器起家，现为消费电子精密零组件与整机组装的主要厂商之一。"
  }, over || {});
}

const FULL = {
  symbol: "AAPL", name: "Apple Inc.",
  business: "全球消费电子龙头。硬件是 iPhone / Mac / iPad，服务是 App Store 与 iCloud 等。",
  peers: [
    peer({ code: "002475", name: "立讯精密" }),
    peer({ code: "601138", name: "工业富联", industry: "消费电子" }),
    peer({ code: "002938", name: "鹏鼎控股", industry: "元件" })
  ]
};

/* ================================================================== 1. 按钮 */

section("1. 「点击查看」按钮（两页共用，只差文案）");

{
  const b = MapBtn.html("AAPL", "Apple Inc.", 5, {
    title: "查看 5 家业务相似的 A 股公司", empty: "还没有业务映射数据"
  });
  checkTrue("有条数：不是灰态", b.indexOf("map-btn--none") < 0);
  checkTrue("有条数：文案是「点击查看」", b.indexOf(">点击查看<") > 0);
  checkTrue("有条数：title 用传进来的措辞", b.indexOf("查看 5 家业务相似的 A 股公司") > 0);
  checkTrue("带 data-sym", b.indexOf('data-sym="AAPL"') > 0);
  checkTrue("带 data-name", b.indexOf('data-name="Apple Inc."') > 0);
}

{
  const b = MapBtn.html("MSFT", "Microsoft Corp.", 0, { empty: "还没有业务映射数据" });
  checkTrue("无数据：灰态", b.indexOf("map-btn--none") > 0);
  checkTrue("无数据：仍然可点（不带 disabled）", b.indexOf("disabled") < 0);
  checkTrue("无数据：title 说明状态", b.indexOf("还没有业务映射数据") > 0);
}

checkTrue("count 为 undefined 视作无数据",
  MapBtn.html("X", "X", undefined, {}).indexOf("map-btn--none") > 0);
checkTrue("count 为负数也视作无数据",
  MapBtn.html("X", "X", -1, {}).indexOf("map-btn--none") > 0);
checkTrue("未传 texts 时用默认文案",
  MapBtn.html("X", "X", 3, {}).indexOf("查看 3 条映射") > 0);

// 两页的文案必须真的不同 —— 否则用户分不清自己点的是哪一列
{
  const a = MapBtn.html("AAPL", "A", 3, { title: "查看 3 家业务相似的 A 股公司" });
  const b = MapBtn.html("AAPL", "A", 3, { title: "查看 3 只候选 A 股及其关联依据" });
  checkTrue("两页各自传自己的 title", a !== b);
}

{
  const b = MapBtn.html("Q", 'A"B<C&D', 1, {});
  checkTrue("属性转义：双引号", b.indexOf("&quot;") > 0);
  checkTrue("属性转义：左尖括号", b.indexOf("&lt;") > 0);
  checkTrue("属性转义：与号", b.indexOf("&amp;") > 0);
}

/* ================================================================== 2. 空状态 */

section("2. 没有数据时的弹窗内容");

["null", "空对象", "缺 business"].forEach(function (label, i) {
  const arg = [null, {}, { peers: [peer()] }][i];
  const html = B.render(arg);
  checkTrue(label + "：给出说明而不是空白", html.indexOf("还没有业务映射数据") > 0);
  checkTrue(label + "：指明数据由哪个脚本生成",
    html.indexOf("build_us_business_map.py") > 0);
  checkTrue(label + "：不渲染候选区", html.indexOf("bm-peer") < 0);
});

/* ================================================================== 3. 有数据 */

section("3. 弹窗内容");

const html = B.render(FULL);

checkTrue("有「公司业务」小标题", html.indexOf("公司业务") > 0);
checkTrue("公司业务描述渲染出来", html.indexOf("全球消费电子龙头") > 0);
checkTrue("有「业务相似的 A 股公司」小标题", html.indexOf("业务相似的 A 股公司") > 0);
checkTrue("标题里带家数", html.indexOf("共 3 家") > 0);
checkTrue("提示可以点开", html.indexOf("点任意一行展开") > 0);

check("三家对应三个可展开条目", (html.match(/<details class="bm-peer">/g) || []).length, 3);
checkTrue("条目里带代码", html.indexOf(">002475<") > 0 && html.indexOf(">601138<") > 0);
checkTrue("条目里带名称", html.indexOf("立讯精密") > 0);
checkTrue("条目里带行业标签", html.indexOf('class="sm-tag">消费电子<') > 0);
checkTrue("业务描述在 details 内部（折叠区）",
  /<details class="bm-peer">[\s\S]*?<p class="bm-biz">/.test(html));

/* 默认折叠 —— 靠"不写 open 属性"实现。写了 open 就等于默认全展开，
   四五个业务描述堆在一起会比弹窗还长（用户点开是为了扫一眼有哪几家）。
   这里数的是 `detail` 标签本身带 open 的情况。 */
checkTrue("默认全部折叠（没有任何 details 带 open）",
  !/<details[^>]*\sopen/.test(html));

/* 这句是防误读的关键，必须有 */
checkTrue("带口径说明：业务相似 ≠ 供应关系",
  html.indexOf("不代表存在供应链") > 0 &&
  html.indexOf("业务相似") > 0);

checkTrue("没有 peers 时给出提示而不是空列表",
  B.render({ symbol: "X", business: "某业务" }).indexOf("还没有对标的 A 股公司") > 0);

/* ================================================================== 4. 纯文本与转义 */

section("4. 渲染的转义与纯文本约定");

{
  const risky = B.render({
    symbol: "X", business: '<script>alert(1)</script>',
    peers: [peer({ name: "A<B", business: "<img src=x onerror=y>" })]
  });
  checkTrue("公司业务里的标签被转义", risky.indexOf("<script>") < 0);
  checkTrue("内容仍在（只是转义）", risky.indexOf("alert(1)") > 0);
  checkTrue("对标公司名里的尖括号被转义", risky.indexOf("A&lt;B") > 0);
  checkTrue("对标业务里的标签被转义", risky.indexOf("<img src=x") < 0);
}

/* 文案字段一律纯文本：本项目页面用 esc 后直接渲染，写 **加粗** 会原样显示成星号。
   （写这个文件时我正好在 bm-note 里写错过一次，所以补一条断言盯住。） */
{
  const out = B.render(FULL) + B.render(null);
  checkTrue("渲染结果里没有 markdown 星号", out.indexOf("**") < 0);
  checkTrue("渲染结果里没有反引号", out.indexOf("`") < 0);
}

/* ------------------------------------------------------------------ 汇总 */

console.log("\n" + "─".repeat(64));
if (fails.length) {
  console.log(`${fails.length} 项未通过 ✗\n`);
  fails.forEach((f) => console.log("  ✗ " + f));
  console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
  process.exit(1);
}
console.log(`全部通过 ✓   共 ${pass} 项`);
