/* 早盘「个股异动榜」分档筛选用例
 *
 *   用法：node tools/test_morning_bands.js      （退出码 0 = 全通过）
 *
 * 为什么需要这个用例
 * ------------------
 * 分档的边界值**不在前端**：它来自 /api/status 的 criteriaValues（源头 screening.py 的 CFG）。
 * 这带来两个改错了不会报错的地方：
 *
 *   1. 谁"顺手"在 JS 里补一个默认值以外的硬编码边界，改了 BIG_MIN_CAP_USD 就会出现
 *      「口径行写着 100 亿、分档却按别的数切」——页面照常渲染，只是数字全错。
 *   2. /api/status 与 /api/morning 是两个并行请求，回来顺序不保证。首屏可能先按默认阈值
 *      画完，真值晚到后必须**重画一次**。漏了这一步，本地开发（默认值恰好等于真值）看不出来，
 *      线上改了环境变量才会错。
 *
 * 另外边界语义也要钉：「≥」含等于（恰好 100 亿归大市值、恰好 15 亿归小市值），
 * 以及「没有市值数据的行不归入任何一档」——否则会凭空造出"市值未知的小盘股"。
 *
 * 做法与 test_filters.js / test_evening_tabs.js 一致：最小 DOM 桩 + 合成数据，
 * 不依赖实时行情与真实 JSON。
 */

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..") + "/";

/* ------------------------------------------------------------------ DOM 桩 */
const els = {};

function mkClassList() {
  const set = {};
  return {
    add(c) { set[c] = true; },
    remove(c) { delete set[c]; },
    toggle(c, force) {
      const on = force === undefined ? !set[c] : !!force;
      if (on) set[c] = true; else delete set[c];
      return on;
    },
    contains(c) { return !!set[c]; },
    _all() { return Object.keys(set); }
  };
}

function mk(id) {
  return {
    id, innerHTML: "", textContent: "", value: "", hidden: false, style: {}, _q: {},
    classList: mkClassList(),
    _h: {},
    addEventListener(t, f) { this._h[t] = f; },
    setAttribute(k, v) { this["_a_" + k] = v; },
    getAttribute(k) { return this["_a_" + k]; },
    contains() { return false; },
    focus() {},
    querySelector(sel) { return this._q[sel] || (this._q[sel] = mk(id + sel)); },
    querySelectorAll() { return []; },
    fire(t, ev) { if (this._h[t]) return this._h[t].call(this, ev || {}); }
  };
}

/* 分档 chip：按 band key 建，带真实的 classList（.on 要能被读到） */
const BTN = {};
function mkBandButton(key) {
  const el = mk("band:" + key);
  el.getAttribute = function (a) { return a === "data-band" ? key : undefined; };
  return el;
}

/* #mvBands：innerHTML 一被赋值就重建按钮 —— 和真实浏览器一样，
   重建后旧按钮作废（这一步正是"点了没反应"类 bug 的来源，必须如实模拟）。 */
const bandBox = mk("mvBands");
(function () {
  let html = "";
  Object.defineProperty(bandBox, "innerHTML", {
    get() { return html; },
    set(v) {
      html = String(v);
      for (const k in BTN) delete BTN[k];
      (html.match(/data-band="([^"]+)"/g) || []).forEach(function (s) {
        BTN[s.slice(11, -1)] = mkBandButton(s.slice(11, -1));
      });
    },
    configurable: true
  });
  bandBox.querySelectorAll = function () { return Object.keys(BTN).map(k => BTN[k]); };
})();

/* #mvBandHost：真实浏览器把 bandHtml() 里的 <div id="mvBands"> 解析成子节点；
   桩里把这层"解析"显式做掉，否则 $("mvBands") 拿不到刚渲染的按钮。 */
const bandHost = mk("mvBandHost");
(function () {
  let html = "";
  Object.defineProperty(bandHost, "innerHTML", {
    get() { return html; },
    set(v) {
      html = String(v);
      const m = html.match(/id="mvBands"[^>]*>([\s\S]*?)<\/div>/);
      bandBox.innerHTML = m ? m[1] : "";
    },
    configurable: true
  });
})();

els.mvBandHost = bandHost;
els.mvBands = bandBox;

global.window = global;
global.document = {
  getElementById(id) { return els[id] || (els[id] = mk(id)); },
  addEventListener() {}, title: ""
};
global.fetch = () => Promise.resolve({ json: () => Promise.resolve({}) });
global.scrollTo = function () {};          // 切标签会调它

let cap = null;
let criteria = null;                       // 模拟 Shell 缓存的后端口径数值
global.Shell = {
  state: {},
  mount(o) { cap = o; },
  syncCountdown() {},
  criteriaValues() { return criteria; }
};

eval(fs.readFileSync(ROOT + "static/util.js", "utf8"));
eval(fs.readFileSync(ROOT + "static/combo.js", "utf8"));
eval(fs.readFileSync(ROOT + "static/morning.js", "utf8"));

/* ------------------------------------------------------------------ 断言 */
let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  if (ok) { pass++; console.log(`  ✓ ${label}: ${got}`); }
  else { fail++; console.log(`  ✗ ${label}: ${got}   (期望 ${want})`); }
}
function section(t) { console.log("\n" + t); }

/* ------------------------------------------------------------------ 数据 */
const YI = 1e8;
/** capYi 单位是「亿美元」，与 night 页口径一致 */
function row(sym, chg, capYi, sector, industry) {
  return {
    symbol: sym, name: sym + " Inc", price: 10, chg: chg,
    marketCap: capYi === null ? null : capYi * YI,
    sector: sector || "信息技术", industry: industry || "半导体",
    sectorEn: "Technology", industryEn: "Semiconductors"
  };
}

/* 覆盖各边界：
   MEGA 5000 亿  → 大市值
   EDGE100 恰好 100 亿 → 大市值（≥ 含等于）
   JUST100 100.0 亿 上面重复，另造 99.9 亿 → 小市值（差一点点就换档）
   EDGE15 恰好 15 亿 → 小市值（≥ 含等于）
   BELOW 14.9 亿 → 两档都不进（只在「所有」）
   NOCAP 市值缺失 → 两档都不进（只在「所有」）  */
function makeData() {
  return {
    ok: true,
    movers: [
      row("MEGA", 9.0, 5000, "信息技术", "半导体"),
      row("EDGE100", 8.0, 100, "金融", "资本市场"),
      row("JUST99", 7.0, 99.9, "信息技术", "半导体"),
      row("EDGE15", 6.0, 15, "医疗保健", "生物技术"),
      row("BELOW", 5.0, 14.9, "能源", "油气勘探"),
      row("NOCAP", 4.0, null, "公用事业", "受管制电力")
    ],
    watchlist: [],
    themes: [], linkage: [], aShareHints: []
  };
}

function feed(d) { global.Shell.state.data = d; cap.onData(d); }

/** 分档 chip 里显示的计数 */
function chipCounts() {
  const m = bandBox.innerHTML.match(/data-band="(\w+)"[^>]*>[^<]*<span class="n">(\d+)<\/span>/g) || [];
  return m.map(s => s.match(/data-band="(\w+)"/)[1] + ":" + s.match(/<span class="n">(\d+)<\/span>/)[1]).join(",");
}
/** 当前带 .on 的 chip */
function lit() {
  return Object.keys(BTN).filter(k => BTN[k].classList.contains("on")).join(",");
}
/** 表格里出现的代码（按渲染顺序） */
function codes() {
  return (els.mvTableHost.innerHTML.match(/<td class="code">([^<]+)<\/td>/g) || [])
    .map(s => s.replace(/^<td class="code">|<\/td>$/g, "")).join(",");
}
/** 板块下拉的候选项 */
function sectorOpts() {
  const c = Combo.get("mvSectorSel");
  return c ? c.options().map(o => o.value).join(",") : "(无实例)";
}
function clickBand(k) {
  if (!BTN[k]) throw new Error("找不到分档按钮：" + k);
  BTN[k].fire("click");
}
function info() { return els.mvRowInfo.innerHTML || els.mvRowInfo.textContent; }

/* ================================================================ 用例 */

section("1. 首屏：三个分档 chip、计数正确、默认停在「所有」");
criteria = { bigMinCap: 100 * YI, midMinCap: 15 * YI, bigPct: 4, midPct: 10 };
feed(makeData());

check("chip 顺序与计数", chipCounts(), "all:6,big:2,mid:2");
check("默认选中「所有」", lit(), "all");
check("「所有」下 6 只全在", codes(), "MEGA,EDGE100,JUST99,EDGE15,BELOW,NOCAP");
check("计数文案", info(), "显示 6 只 / 共 6 只");

section("2. 口径行写的是**当前生效**的边界值");
{
  /* 2026-09-24：这一段从「分档说明」升级成「入榜口径说明」—— 口径与「夜盘异动」页统一后，
     分档边界 < 入榜阈值 是同一条线：低于 15 亿的票**在取数时就已剔除**，不再"留在「所有」里"。
     本用例的合成数据仍保留 BELOW / NOCAP 两行，是为了继续盯住渲染层的兜底
     （万一旧数据或人工改动带进区间外的行，不能把它们硬塞进某一档）。 */
  const note = (bandHost.innerHTML.match(/<p class="hint band-note">([^<]*)<\/p>/) || [])[1] || "";
  check("含大市值下限 100", /大市值 ≥ 100 亿美元/.test(note), "true");
  check("含小市值区间 15–100", /小市值 15–100 亿美元/.test(note), "true");
  check("含两档各自的涨幅门槛（4% / 10%）",
    /≥ 4%/.test(note) && /≥ 10%/.test(note), "true");
  check("交代了低于下限的去处（口径统一后是「全部剔除」）",
    /低于 15 亿美元的全部剔除/.test(note), "true");
  check("点明与夜盘页同口径（否则读者会以为两页门槛不同）",
    /与「夜盘异动」页一致/.test(note), "true");
}

section("3. 点「大市值」→ 表格与高亮同时变化（本次回归点）");
clickBand("big");
check("只看大市值", codes(), "MEGA,EDGE100");
check("高亮立刻跟上（不等重画）", lit(), "big");
check("计数文案", info(), "显示 2 只 / 共 6 只");
check("★ 恰好 100 亿（含等于）被收进来", codes().indexOf("EDGE100") >= 0, "true");

section("4. 点「小市值」→ 15 亿 ≤ cap < 100 亿");
clickBand("mid");
check("只看小市值", codes(), "JUST99,EDGE15");
check("高亮跟着走", lit(), "mid");
check("恰好 99.9 亿落在小市值（差 0.1 就没换档）", codes().indexOf("JUST99") >= 0, "true");
check("恰好 15 亿（含等于）落在小市值", codes().indexOf("EDGE15") >= 0, "true");
check("14.9 亿不进小市值", codes().indexOf("BELOW"), -1);
check("市值缺失的行不进小市值", codes().indexOf("NOCAP"), -1);

section("5. 两档之和 ≠ 全部：差额正是「不计入分档」的那些");
clickBand("all");
check("「所有」把不计入分档的也列出来", codes(), "MEGA,EDGE100,JUST99,EDGE15,BELOW,NOCAP");
check("6 只 = 大 2 + 小 2 + 2 只不计入分档", chipCounts(), "all:6,big:2,mid:2");

section("6. 边界值来自后端：把大市值下限改成 200 亿，同一份数据的分档立刻变");
criteria = { bigMinCap: 200 * YI, midMinCap: 15 * YI, bigPct: 4, midPct: 10 };
cap.onCriteria(global.Shell.state.data);       // 模拟 /api/status 晚到
check("大市值只剩 MEGA", (clickBand("big"), codes()), "MEGA");
check("恰好 100 亿的掉到小市值", (clickBand("mid"), codes()), "EDGE100,JUST99,EDGE15");
check("chip 计数跟着重算", chipCounts(), "all:6,big:1,mid:3");
{
  const note = (bandHost.innerHTML.match(/<p class="hint band-note">([^<]*)<\/p>/) || [])[1] || "";
  check("口径行同步改成 200", /大市值 ≥ 200 亿美元/.test(note), "true");
}
check("改完仍停在用户选的档（不被踢回「所有」）", lit(), "mid");

section("7. 阈值拿不到时回落默认值（100 亿 / 15 亿），不是崩掉");
criteria = null;
cap.onCriteria(global.Shell.state.data);
check("回落到默认边界，分档照常工作", (clickBand("big"), codes()), "MEGA,EDGE100");

section("8. 板块下拉的候选跟着分档走（不会留下「选了必空」的死选项）");
criteria = { bigMinCap: 100 * YI, midMinCap: 15 * YI, bigPct: 4, midPct: 10 };
feed(makeData());
clickBand("all");
check("「所有」下板块候选 = 全部（按拼音序）", sectorOpts(), "公用事业,金融,能源,信息技术,医疗保健");
clickBand("big");
check("「大市值」下只剩 金融 / 信息技术", sectorOpts(), "金融,信息技术");
clickBand("mid");
check("「小市值」下只剩 信息技术 / 医疗保健", sectorOpts(), "信息技术,医疗保健");

section("9. 已选板块在新档里不存在 → 回落，不留下空表");
clickBand("all");
Combo.get("mvSectorSel").select("金融");        // 金融只有大市值里有
check("先确认选上了", Combo.get("mvSectorSel").value(), "金融");
clickBand("mid");
check("切到小市值后「金融」被清掉", Combo.get("mvSectorSel").value(), "");
check("表格回到小市值全部（没被空筛选卡住）", codes(), "JUST99,EDGE15");

section("10. 分档与搜索叠加");
feed(makeData());
clickBand("big");
els.mvQ.value = "edge";
els.mvQ.fire("input");
check("大市值 ∩ 搜「edge」", codes(), "EDGE100");
els.mvQ.value = "";
els.mvQ.fire("input");
check("清空搜索 → 回到大市值全部", codes(), "MEGA,EDGE100");

section("11. 点已选中的档不重画（避免白刷）");
{
  const before = Object.keys(BTN).map(k => BTN[k]).join();
  clickBand("big");
  const after = Object.keys(BTN).map(k => BTN[k]).join();
  check("按钮实例没被重建", before === after, "true");
  check("高亮仍在 big", lit(), "big");
}

console.log("");
if (fail === 0) { console.log(`全部通过 ✓  (${pass} 项断言)`); process.exit(0); }
console.log(`有失败项 ✗  (${fail} 项失败 / ${pass + fail} 项)`);
process.exit(1);
