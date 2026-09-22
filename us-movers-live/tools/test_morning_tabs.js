/* 早盘总结 · 标签页记忆用例

   验的是：「总览 / 个股 / 关注」选中哪一页要**记下来** ——
   切到「夜盘异动」再切回「早盘总结」，应该还停在上次那一页，而不是被重置回「总览」。

   为什么单独测：这类"跨页保留状态"改错了不会报任何错 ——
   点两下页面才发现"咦怎么回到总览了"，而且很容易被当成浏览器缓存问题。
   真正要防的是三种静默失效：
     · 写没写进存储（少调一次 rememberTab），
     · 读了但没生效（state.tab 初始化没走 savedTab），
     · 存储里是脏值 / 存储不可用（隐私模式）时把页面搞挂。

   做法：最小 DOM 桩 + localStorage 桩，**反复 eval morning.js 来模拟"重新打开页面"**
   （IIFE 每次都会重建内部 state，等价于一次真实的整页刷新）。

   用法：node tools/test_morning_tabs.js      （退出码 0 = 全通过）
*/
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..") + "/";

/* ------------------------------------------------------------------ DOM 桩 */
const els = {};
/** 真实的 classList 桩：applyTab 是"重涂高亮"，用空实现的话相关断言恒为假，测不出问题 */
function mkCL() {
  const set = {};
  return {
    add(c) { set[c] = true; }, remove(c) { delete set[c]; },
    toggle(c, f) { const on = f === undefined ? !set[c] : !!f; if (on) set[c] = true; else delete set[c]; return on; },
    contains(c) { return !!set[c]; }
  };
}
function mk(id) {
  return {
    id, innerHTML: "", textContent: "", value: "", hidden: false, style: {},
    _h: {}, _q: {}, classList: mkCL(),
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

/* 标签栏要能"点"：从 innerHTML 里解析出按钮并返回**稳定的**对象
   （同一 key 每次返回同一个实例，否则 renderTabs 挂的监听和后面点的不是同一个东西）。
   每次模拟刷新会清空重建，跟真实页面一致。 */
const BTN = {};
function mkTabsBox(id) {
  const el = mk(id);
  el.querySelectorAll = function (sel) {
    if (sel !== ".tab") return [];
    return (this.innerHTML.match(/data-tab="[^"]+"/g) || []).map(function (s) {
      const k = s.slice(10, -1);              // 去掉 data-tab=" 与结尾的 "
      if (!BTN[k]) {
        BTN[k] = mk(id + ":" + k);
        BTN[k].getAttribute = function (a) { return a === "data-tab" ? k : undefined; };
      }
      return BTN[k];
    });
  };
  return el;
}
global.window = global;
global.scrollTo = function () {};             // 切标签会调它；桩里没有会抛 TypeError
global.document = {
  getElementById(id) {
    if (id === "tabs") return els["tabs"] || (els["tabs"] = mkTabsBox("tabs"));
    return els[id] || (els[id] = mk(id));
  },
  addEventListener() {}, title: ""
};

/* ------------------------------------------------------- localStorage 桩 */
const store = {};
let storageOk = true;
global.localStorage = {
  getItem(k) { if (!storageOk) throw new Error("storage disabled"); return k in store ? store[k] : null; },
  setItem(k, v) { if (!storageOk) throw new Error("storage disabled"); store[k] = String(v); },
  removeItem(k) { delete store[k]; }
};

/* ---------------------------------------------------------------- Shell 桩 */
let cap = null;
global.Shell = { state: {}, mount(o) { cap = o; }, syncCountdown() {} };

eval(fs.readFileSync(ROOT + "static/util.js", "utf8"));
eval(fs.readFileSync(ROOT + "static/combo.js", "utf8"));

const DATA_OK = {
  ok: true, meta: { tradeDate: "2026-09-21", tradeDateLabel: "9月21日（周一）" },
  indices: [], themes: [], linkage: [], aShareHints: [],
  // 给一条 mover：异动榜在"没有数据"时渲染的是空态面板，不会输出 #mvTableHost，
  // 那样第 9 节想验"表格挂在个股页"就没有可验的标记了
  movers: [{ symbol: "AAA", name: "AAA 公司", chg: 5, marketCap: 2e10, sector: "信息技术" }],
  watchlist: []
};

/** 读取标签栏按钮（供点击用）。必须在 feed 之后调 —— 那时按钮才被创建。 */
const tab = k => BTN[k];
/** 当前显示的是哪个面板（黑盒断言：不看内部 state，只看 DOM 的 hidden）。 */
function shownPane() {
  const order = [["paneOverview", "overview"], ["paneStocks", "stocks"], ["paneWatch", "watch"]];
  for (const [id, key] of order) {
    const el = els[id];
    if (el && !el.hidden) return key;
  }
  return "?";
}
/** 页面上实际渲染出来的标签（按顺序） */
function tabLabels() {
  return (els["tabs"].innerHTML.match(/data-tab="[^"]+"[^>]*>([^<]*)</g) || [])
    .map(s => s.replace(/^.*>/, "").replace(/<$/, "")).join(",");
}
/** 某个 id 的标记出现在第几个面板里（用来验"关注池搬到了哪一页"） */
function paneOf(markupId) {
  const html = els["morningHost"].innerHTML;
  const order = ["paneOverview", "paneStocks", "paneWatch"];
  const at = html.indexOf('id="' + markupId + '"');
  if (at < 0) return "没有渲染出来";
  let hit = "?";
  order.forEach(function (p) {
    const i = html.indexOf('id="' + p + '"');
    if (i >= 0 && i < at) hit = p;
  });
  return hit;
}
/** 模拟一次真实的"重新打开页面"：清空按钮、重新 eval morning.js、再喂一份数据。 */
function reload(data) {
  for (const k in BTN) delete BTN[k];
  eval(fs.readFileSync(ROOT + "static/morning.js", "utf8"));
  Shell.state.data = data || DATA_OK;
  cap.onData(Shell.state.data);
}

/* ------------------------------------------------------------------ 断言 */
let fail = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  if (!ok) fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}: ${got}${ok ? "" : "   (期望 " + want + ")"}`);
}
function section(t) { console.log("\n" + t); }

/* ------------------------------------------------------------------ 用例 */
section("1. 没有记忆时 → 默认停在「总览」");
reload();
check("显示的面板", shownPane(), "overview");
check("存储里还没有值", localStorage.getItem("morning.tab"), "null");

section("2. 点「个股」→ 写进存储");
tab("stocks").fire("click");
check("显示的面板", shownPane(), "stocks");
check("存储已更新", localStorage.getItem("morning.tab"), "stocks");

section("3. 重新打开页面（模拟切去夜盘异动再切回来）→ 仍停在「个股」");
reload();
check("显示的面板", shownPane(), "stocks");

section("4. 再点回「总览」→ 存储跟着改");
tab("overview").fire("click");
check("显示的面板", shownPane(), "overview");
check("存储已更新", localStorage.getItem("morning.tab"), "overview");
reload();
check("重新打开后仍是「总览」", shownPane(), "overview");

section("5. 存储里是无效值 → 回落第一个标签，不崩");
store["morning.tab"] = "不存在的标签";
reload();
check("显示的面板", shownPane(), "overview");

section("6. 存储不可用（隐私模式）→ 不崩，按默认走");
storageOk = false;
reload();
check("显示的面板", shownPane(), "overview");
tab("stocks").fire("click");
check("点标签仍然可用", shownPane(), "stocks");
storageOk = true;

section("7. 清掉记忆后重开 → 回到默认");
delete store["morning.tab"];
reload();
check("显示的面板", shownPane(), "overview");

section("8. 三个标签（总览 / 个股 / 关注），顺序即定义顺序");
delete store["morning.tab"];
reload();
check("标签栏", tabLabels(), "总览,个股,关注");

section("9. 关注池在「关注」页，不在「个股」页（本次改动核心）");
check("关注池挂在哪一面板下", paneOf("wlHost"), "paneWatch");
check("异动榜仍在「个股」页", paneOf("mvTableHost"), "paneStocks");
check("「个股」页里没有关注池", els["morningHost"].innerHTML.indexOf('id="paneStocks"') >= 0
      && paneOf("wlHost") !== "paneStocks", true);

section("10. 点「关注」→ 显示关注面板并写进存储");
tab("watch").fire("click");
check("显示的面板", shownPane(), "watch");
check("存储已更新", localStorage.getItem("morning.tab"), "watch");
check("高亮的按钮", Object.keys(BTN).filter(k => BTN[k].classList.contains("on")).join(","), "watch");

section("11. 重开后仍停在「关注」");
reload();
check("显示的面板", shownPane(), "watch");

section("12. 老记忆值仍然有效（新增标签不会让已存的 key 失效）");
store["morning.tab"] = "stocks";
reload();
check("存 stocks → 开在「个股」", shownPane(), "stocks");

console.log(fail === 0 ? "\n全部通过 ✓" : `\n${fail} 项未通过 ✗`);
process.exit(fail === 0 ? 0 : 1);
