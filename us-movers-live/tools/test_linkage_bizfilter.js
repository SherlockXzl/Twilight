/* 「只看有 A 股映射」筛选的用例（明暗对照页）
 *
 *   用法：node tools/test_linkage_bizfilter.js      （退出码 0 = 全通过）
 *
 * 为什么需要它
 * ------------
 * 这个勾选框看起来是一行 filter，但有四个「改错了页面照常显示、只是悄悄不对」的点：
 *
 *   1. **口径是"在 A 股有对标公司"，不是"有映射数据"。** 全市场 4279 家都有行业说明，
 *      随便点开都看得到内容；但其中两百多家所属行业在 A 股没有对标（REIT 各系列、
 *      烟草专营、博彩…），点开一个 A 股公司都没有。若用例就是"有数据"，
 *      那勾上等于没筛 —— 恰好把最该隐藏的一批留下了。
 *   2. **映射数据还没到时不许渲染成"共 0 条"。** 目录 202KB、映射 95KB，谁先回不确定。
 *      报 0 条是把"还没加载"说成"没有"，用户会以为筛选坏了或数据没了。这里要
 *      如实显示"载入中"，并且在映射到达后自动筛出正确结果（不能停在提示上）。
 *   3. **下拉里的计数要跟着变。** 勾上之后板块下拉若还写着「工业 (812)」，
 *      选进去只剩几十条，用户会以为页面算错了 —— 而不会想到是自己多勾了一个条件。
 *      被整个滤空的板块还应该从下拉里消失、选中项回落。
 *   4. **override（公司级精写）与行业级两条路径都要算数。** 公司级精写的公司，
 *      即使它的行业在 A 股没有对标，也算"有 A 股映射"。
 *
 * 做法与 tools/test_filters.js 一致：最小 DOM 桩 + 合成数据，不碰浏览器与真实 JSON。
 * 目录与映射两个请求的**到达顺序在这里是可控的**（这是第 2 条唯一能测的办法）。
 */

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..") + "/";

/* ------------------------------------------------------------------ DOM 桩 */

const els = {};
function mk(id) {
  return {
    id, innerHTML: "", textContent: "", value: "", checked: false,
    hidden: false, style: {}, _h: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(t, f) { this._h[t] = f; },
    setAttribute(k, v) { this["_a_" + k] = v; },
    getAttribute(k) { return this["_a_" + k]; },
    focus() {},
    fire(t, ev) { if (this._h[t]) this._h[t].call(this, ev || {}); }
  };
}
global.window = global;
global.document = {
  getElementById(id) { return els[id] || (els[id] = mk(id)); },
  addEventListener() {}, title: ""
};

/* ------------------------------------------------------------------ 组件桩 */

global.Shell = { mount(o) { global.__cap = o; } };          // 页壳：linkage.js 会调 mount

const combos = {};
global.Combo = {                                            // 记下每次 setOptions 的选项
  create(el, opts) {
    const c = {
      el, opts, options: [], value: "",
      setOptions(o, v) { this.options = o; this.value = v || ""; }
    };
    combos[el.id] = c;
    return c;
  },
  get(id) { return combos[id]; }
};

let openedModal = null;
global.Modal = { open(o) { openedModal = o; } };

/* ------------------------------------------------------------------ 合成数据 */

function peer(code, name) {
  return { code, name, industry: "消费电子", business: name + "的业务描述。" };
}

/* 五行覆盖四条判定路径：
     AAPL / HIT —— 行业级有对标          → 有映射
     OVR        —— 行业无定义但有 override → 有映射（第 4 条）
     NOP        —— 行业说明存在但 peers 空 → **没有**映射（第 1 条，最容易做错的一类）
     NUL        —— 行业无定义且无 override → 没有映射
   NOP/NUL 的板块「工业」在勾选后会被整个滤空，用来验第 3 条的回落。 */
const CATALOG = {
  ok: true, count: 5, builtAt: "2026-09-28 10:00:00",
  rows: [
    { symbol: "AAPL", name: "Apple Inc.", sector: "信息科技", sectorEn: "Technology",
      industry: "消费电子", industryEn: "Consumer Electronics" },
    { symbol: "HIT", name: "Hit Co.", sector: "信息科技", sectorEn: "Technology",
      industry: "半导体", industryEn: "Semiconductors" },
    { symbol: "OVR", name: "Override Co.", sector: "信息科技", sectorEn: "Technology",
      industry: "未定义行业甲", industryEn: "Undefined A" },
    { symbol: "NOP", name: "No Peer Co.", sector: "工业", sectorEn: "Industrials",
      industry: "电气设备", industryEn: "Electrical Equipment" },
    { symbol: "NUL", name: "Null Co.", sector: "工业", sectorEn: "Industrials",
      industry: "未定义行业乙", industryEn: "Undefined B" }
  ]
};

const BIZ = {
  ok: true, count: 5,
  rows: {
    AAPL: { name: "Apple Inc.", industryKey: "消费电子" },
    HIT: { name: "Hit Co.", industryKey: "半导体" },
    OVR: { name: "Override Co.", industryKey: "未定义行业甲" },
    NOP: { name: "No Peer Co.", industryKey: "电气设备" },
    NUL: { name: "Null Co.", industryKey: "未定义行业乙" }
  },
  industries: {
    "消费电子": { zh: "消费电子", desc: "消费电子的行业级说明。", peers: [peer("002475", "立讯精密")] },
    "半导体": { zh: "半导体", desc: "半导体的行业级说明。", peers: [peer("688981", "中芯国际")] },
    "电气设备": { zh: "电气设备", desc: "电气设备的行业级说明。", peers: [] }
  },
  overrides: {
    OVR: { business: "公司级精写的业务描述。", peers: [peer("600519", "贵州茅台")] }
  }
};

/* 目录立刻返回；映射**先挂起**，由后面手动放行 —— 这样才能测到「勾了但数据没到」。 */
let releaseBiz = null;
global.fetch = function (url) {
  const u = String(url);
  if (u.indexOf("us-catalog") >= 0) {
    return Promise.resolve({ json: () => Promise.resolve(CATALOG) });
  }
  if (u.indexOf("us-business-map") >= 0) {
    return new Promise(function (res) {
      releaseBiz = function () { res({ json: () => Promise.resolve(BIZ) }); };
    });
  }
  return Promise.resolve({ json: () => Promise.resolve({}) });
};

/* ------------------------------------------------------------------ 加载页面 */

eval(fs.readFileSync(ROOT + "static/util.js", "utf8"));
eval(fs.readFileSync(ROOT + "static/mapbtn.js", "utf8"));
global.BusinessMap = { render() { return "<div>渲染结果</div>"; } };   // 弹窗正文另有用例
eval(fs.readFileSync(ROOT + "static/linkage.js", "utf8"));

/* ------------------------------------------------------------------ 断言工具 */

let pass = 0;
const fails = [];
function check(name, got, want) {
  if (String(got) === String(want)) pass++;
  else fails.push(`${name}\n      期望 ${JSON.stringify(String(want))}\n      实际 ${JSON.stringify(String(got))}`);
}
function checkTrue(name, cond) { check(name, !!cond, true); }
function section(t) { console.log("\n── " + t + " " + "─".repeat(Math.max(0, 58 - t.length))); }

const tick = () => new Promise((r) => setTimeout(r, 0));
const bizOnly = () => els.bizOnly;
const table = () => els.tableHost.innerHTML;
const info = () => els.rowInfo.textContent;
const rowCount = () => (table().match(/<tr>/g) || []).length - 1;   // 减去表头那一行

function setBizOnly(on) {                   // 模拟用户点复选框
  bizOnly().checked = on;
  bizOnly().fire("change");
}
function sectorOptions() { return (combos.sectorSel.options || []).map((o) => o.value + "(" + o.count + ")"); }
function industryOptions() { return (combos.industrySel.options || []).map((o) => o.value + "(" + o.count + ")"); }
function clickMapBtn(sym, name) {           // 模拟点某行的「点击查看」
  els.tableHost.fire("click", { target: { closest: () => ({ getAttribute: (k) => (k === "data-sym" ? sym : name) }) } });
}

/* ------------------------------------------------------------------ 走一遍 */

(async function () {

  section("0. 目录到达、映射仍挂起");

  await tick();
  check("初始 5 行", rowCount(), 5);
  checkTrue("未勾选时显示条数", info().indexOf("共 5 条") >= 0);
  checkTrue("映射没到也不影响目录表", table().indexOf("Apple Inc.") > 0);

  section("1. 映射未就绪时勾选：如实说「载入中」，不许报 0 条");

  setBizOnly(true);
  checkTrue("提示是「载入中」", table().indexOf("载入中") > 0);
  checkTrue("**不是**「当前筛选条件下没有数据」", table().indexOf("没有数据") < 0);
  checkTrue("**不是**「共 0 条」", info().indexOf("共 0 条") < 0);
  check("条数位置显示占位符", info(), "—");
  checkTrue("分页条清空（页数无从谈起）", els.pager.innerHTML === "");

  // 未就绪时不参与过滤：取消勾选应立刻回到全量，而不是筛出一堆 0
  setBizOnly(false);
  check("取消勾选后回到 5 行", rowCount(), 5);

  section("2. 映射到达后自动筛出结果（不用用户再点一次）");

  setBizOnly(true);              // 先在"载入中"状态下勾上
  releaseBiz();                  // 再放行映射
  await tick();
  check("自动筛出 3 行", rowCount(), 3);
  checkTrue("有 A 股对标的留下：AAPL", table().indexOf("AAPL") > 0);
  checkTrue("有 A 股对标的留下：HIT", table().indexOf(">HIT<") > 0);
  checkTrue("公司级精写的也算（override）", table().indexOf(">OVR<") > 0);
  checkTrue("**行业无对标（peers 空）被滤掉**", table().indexOf("NOP") < 0);
  checkTrue("**行业在映射表里查不到的被滤掉**", table().indexOf(">NUL<") < 0);
  checkTrue("行数提示是 3 条", info().indexOf("共 3 条") >= 0);
  checkTrue("按钮不是灰的（有 A 股公司可看）",
    table().indexOf("map-btn--none") < 0);

  section("3. 下拉选项与计数跟着变");

  check("板块下拉只剩信息科技，且计数为 3",
    sectorOptions().join(","), "信息科技(3)");
  checkTrue("被整个滤空的板块（工业）从下拉里消失",
    sectorOptions().join(",").indexOf("工业") < 0);
  check("行业下拉的计数也按生效条件重算",
    industryOptions().join(","),
    ["半导体(1)", "消费电子(1)", "未定义行业甲(1)"].sort((a, b) => a.localeCompare(b, "zh")).join(","));

  section("4. 与搜索、板块筛选叠加");

  els.q.value = "apple";
  els.q.fire("input");
  await new Promise((r) => setTimeout(r, 220));      // 搜索有 150ms 防抖
  check("勾选 + 搜索命中 1 行", rowCount(), 1);
  checkTrue("命中的是 AAPL", table().indexOf("AAPL") > 0);

  els.q.value = "";
  els.q.fire("input");
  await new Promise((r) => setTimeout(r, 220));
  check("清空搜索后回到 3 行", rowCount(), 3);

  // 先选「工业」（勾选前它有 2 家），再勾上 —— 「工业」应被滤空并回落
  setBizOnly(false);
  combos.sectorSel.opts.onChange("工业");
  check("先选工业：2 行", rowCount(), 2);
  setBizOnly(true);
  check("勾上后工业被滤空：回落到全部 3 行", rowCount(), 3);
  check("选中的板块被清空（没有工业这个选项了）", combos.sectorSel.value, "");
  check("行业下拉此时不带板块限制",
    industryOptions().length, 3);

  section("5. 取消勾选恢复全量");

  setBizOnly(false);
  check("回到 5 行", rowCount(), 5);
  check("板块下拉恢复两个板块",
    sectorOptions().sort().join(","), ["信息科技(3)", "工业(2)"].sort().join(","));

  section("6. 弹窗副标题区分「有几家」与「无对标」");

  clickMapBtn("AAPL", "Apple Inc.");
  checkTrue("有对标的：副标题给家数",
    openedModal && openedModal.subtitle.indexOf("业务相似 1 家") >= 0);
  checkTrue("有对标的：标题带公司名与代码",
    openedModal.title.indexOf("Apple Inc.（AAPL）") >= 0);

  clickMapBtn("NOP", "No Peer Co.");
  checkTrue("行业无对标的：副标题说明原因，而不是「0 家」",
    openedModal.subtitle.indexOf("无直接对标") >= 0);
  checkTrue("行业无对标的：不写成「业务相似 0 家」",
    openedModal.subtitle.indexOf("业务相似 0 家") < 0);

  section("7. 纯文本约定");

  checkTrue("渲染结果里没有 markdown 星号", table().indexOf("**") < 0);
  checkTrue("渲染结果里没有反引号", table().indexOf("`") < 0);

  /* ---------------------------------------------------------------- 汇总 */

  console.log("\n" + "─".repeat(64));
  if (fails.length) {
    console.log(`${fails.length} 项未通过 ✗\n`);
    fails.forEach((f) => console.log("  ✗ " + f));
    console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
    process.exit(1);
  }
  console.log(`全部通过 ✓   共 ${pass} 项`);
  process.exit(0);
})();
