/* 夜盘异动 · 标签页交互与记忆用例

   验两件事：

   A. 点「大市值 / 小市值 / 所有」之后，**下方表格立刻换、标签高亮也立刻跟着走**。
      为什么单独测：这两件事原先被写在了两个地方 ——
      表格由 renderBody() 渲染，高亮却是在 renderTabs() 拼 HTML 字符串时写死的。
      点击的处理里只调了 renderBody()，于是高亮一直停在上一个标签上，
      要等下一轮行情刷新（onData → renderTabs）才纠正。
      改成常规时段外停轮询之后，这一步纠正**永远不会到来**，
      页面上就表现成"点了没反应"——而表格其实早就换好了。
      这个 bug 靠肉眼很难定性（数据是对的，只有选中态是死的），必须用例盯住。

   B. 选中的那一档要**记下来**：切去「早盘总结」再切回「夜盘异动」，
      应该还停在原档。这类"跨页保留状态"改错了同样不报错，
      而且很容易被当成浏览器缓存问题 —— 所以要点两下才发现。
      要防的三种静默失效：写没写进存储、读了但没生效、存储里是脏值/存储不可用。
      夜盘比早盘多一层坑：**分档是后端决定的**（SHOW_DOWN=0 就没有「跌」两档），
      存下来的 key 可能已经不存在了，必须回落而不能把页面搞空。

   做法：最小 DOM 桩加载 util.js + combo.js + evening.js，喂构造数据、手动点按钮。
   标签栏的桩要**忠实**：innerHTML 一旦被赋值，旧按钮就作废、按新 HTML 重建
   （真实浏览器就是这样），否则会拿着上一轮的按钮点，测出假结果。
   用例只断言 DOM（哪个按钮带 .on、表格里有哪些代码、存储里是什么），
   不看内部 state —— 内部变量对了但没画出来，正是 A 要防的失效方式。

   用法：node tools/test_evening_tabs.js      （退出码 0 = 全通过）
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
    id, innerHTML: "", textContent: "", value: "", hidden: false, style: {},
    classList: mkClassList(), _h: {}, _q: {},
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

/* 标签按钮：按 key 建，带真实的 classList（.on 要能被读到） */
function mkTabButton(key) {
  const el = mk("tab:" + key);
  el.getAttribute = function (a) { return a === "data-tab" ? key : undefined; };
  el.getAttribute.dataTab = key;
  return el;
}

const BTN = {};
function mkTabsBox(id) {
  const el = mk(id);
  let html = "";
  Object.defineProperty(el, "innerHTML", {
    get() { return html; },
    set(v) {
      html = String(v);
      // 重建 DOM = 旧按钮全部作废（真实浏览器里它们已经脱离文档、点了也没用）
      for (const k in BTN) delete BTN[k];
      (html.match(/data-tab="([^"]+)"/g) || []).forEach(function (s) {
        BTN[s.slice(10, -1)] = mkTabButton(s.slice(10, -1));
      });
    },
    configurable: true
  });
  el.querySelectorAll = function (sel) {
    if (sel !== ".tab") return [];
    return (html.match(/data-tab="([^"]+)"/g) || []).map(s => BTN[s.slice(10, -1)]);
  };
  return el;
}

/* 表格宿主：数一数 innerHTML 被写了几次 —— 用来断言"点已选中的标签不重绘" */
let tableWrites = 0;

global.window = global;
global.document = {
  getElementById(id) {
    if (id === "tabs") return els.tabs || (els.tabs = mkTabsBox("tabs"));
    if (id === "tableHost") {
      if (!els.tableHost) {
        els.tableHost = mk("tableHost");
        let h = "";
        Object.defineProperty(els.tableHost, "innerHTML", {
          get() { return h; },
          set(v) { h = String(v); tableWrites++; },
          configurable: true
        });
      }
      return els.tableHost;
    }
    return els[id] || (els[id] = mk(id));
  },
  addEventListener() {}, title: ""
};
/* fetch 永不 resolve —— loadReasons 是"进页面取一次原因"，与标签交互无关，
   让它挂着可以避免异步回调在断言中途插进来改 DOM。 */
global.fetch = () => new Promise(() => {});

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
eval(fs.readFileSync(ROOT + "static/evening.js", "utf8"));

/* ------------------------------------------------------------------ 构造数据 */
function row(sym, chg, cap_) {
  return { symbol: sym, name: sym + " Inc.", price: 12.34, chg: chg, marketCap: cap_,
           sector: "信息技术", industry: "半导体", sectorEn: "Technology",
           industryEn: "Semiconductors" };
}
/* 分档内已按涨幅降序（后端 classify 就是这么给的），
   「所有」页会把两档合并后再整体排一遍 —— 断言里的顺序要跟这个口径对得上 */
const BIG = [row("VICR", 9.1, 1.2e10), row("SOFI", 6.4, 3.2e10), row("GME", 4.2, 1.6e10)];
const MID = [row("VKTX", 18.3, 4.0e9), row("MTX", 11.5, 2.1e9)];
const DATA = {
  ok: true,
  meta: { criteria: { big: "总市值 ≥ 100 亿美元，涨幅 ≥ 4%", mid: "总市值 15–100 亿美元，涨幅 ≥ 10%", tiny: "总市值 < 15 亿美元，全部剔除（仅列对照）" } },
  tables: { big_up: { title: "大市值涨幅 ≥ 4%", rows: BIG },
            mid_up: { title: "小市值涨幅 ≥ 10%", rows: MID } },
  counts: { big_up: BIG.length, mid_up: MID.length, total: BIG.length + MID.length, excluded: 0 },
  excluded: []
};
function feed(d) { global.Shell.state.data = d; cap.onData(d); }

/** 模拟一次真实的"重新打开页面"（等价于切去早盘总结、再切回夜盘异动）：
 *  清空按钮、清空搜索框、重新 eval evening.js（IIFE 重建内部 state）、再喂一份数据。 */
function reload(d) {
  for (const k in BTN) delete BTN[k];
  els.tabs.innerHTML = "";      // 真实重载后标签栏是空的，等数据来了才由 renderTabs 建
  els.q.value = "";             // 新页面的搜索框也是空的（别把上一节留下的 "vicr" 带过来）
  eval(fs.readFileSync(ROOT + "static/evening.js", "utf8"));
  feed(d || DATA);
}
const stored = () => localStorage.getItem("evening.tab");

/* ------------------------------------------------------------------ 读 DOM */
/** 当前带 .on 的标签（从 DOM 读，不看 state） */
function lit() {
  return Object.keys(BTN).filter(k => BTN[k].classList.contains("on")).join(",");
}
/** 标签栏里的 (key, 文案, 计数) */
function tabList() {
  const html = els.tabs.innerHTML;
  return (html.match(/data-tab="([^"]+)">([^<]*)<span class="n">(\d+)</g) || [])
    .map(s => {
      const m = s.match(/data-tab="([^"]+)">([^<]*)<span class="n">(\d+)/);
      return m[1] + ":" + m[2] + ":" + m[3];
    }).join(" | ");
}
/** 表格里的股票代码，按出现顺序 */
function codes() {
  return (els.tableHost.innerHTML.match(/<td class="code">([^<]+)<\/td>/g) || [])
    .map(s => s.replace(/<td class="code">|<\/td>/g, "")).join(",");
}
const rowInfo = () => els.rowInfo.textContent;

/* ------------------------------------------------------------------ 断言 */
let fail = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  if (!ok) fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}: ${got}${ok ? "" : "   (期望 " + want + ")"}`);
}
function section(t) { console.log("\n" + t); }

/* ------------------------------------------------------------------ 用例 */
section("1. 首屏：默认停在「所有」，三档标签都在");
feed(DATA);
check("标签栏", tabList(), "all:所有:5 | big_up:大市值 · 涨:3 | mid_up:小市值 · 涨:2");
check("首屏高亮的标签", lit(), "all");
check("表格是全部两档合并（按涨幅降序）", codes(), "VKTX,MTX,VICR,SOFI,GME");
check("行数说明", rowInfo(), "显示 5 条 / 全部共 5 条");

section("2. 点「大市值」→ 表格与高亮**同时**变化（本次回归点）");
BTN.big_up.fire("click");
check("高亮立刻跟到大市值", lit(), "big_up");
check("表格只剩大市值档", codes(), "VICR,SOFI,GME");
check("行数说明", rowInfo(), "显示 3 条 / 该分档共 3 条");

section("3. 点「小市值」");
BTN.mid_up.fire("click");
check("高亮跟到小市值", lit(), "mid_up");
check("表格只剩小市值档", codes(), "VKTX,MTX");
check("行数说明", rowInfo(), "显示 2 条 / 该分档共 2 条");

section("4. 点回「所有」");
BTN.all.fire("click");
check("高亮回到所有", lit(), "all");
check("表格恢复合并", codes(), "VKTX,MTX,VICR,SOFI,GME");

section("5. 点已选中的标签 → 不重绘（避免白刷掉滚动位置）");
const before = tableWrites;
BTN.all.fire("click");
check("表格没有被重写", tableWrites - before, 0);
check("高亮仍在所有", lit(), "all");

section("6. 行情刷新后仍停在用户选的标签，高亮不被重置回「所有」");
BTN.big_up.fire("click");
feed(DATA);
check("高亮还在大市值", lit(), "big_up");
check("表格仍是大市值档", codes(), "VICR,SOFI,GME");
feed(DATA);
check("再刷一轮仍在", lit(), "big_up");

section("7. 后端收掉小市值档：当前正选着它 → 回落「所有」，高亮跟着走");
BTN.mid_up.fire("click");
check("先停在小市值", lit(), "mid_up");
feed({
  ok: true, meta: DATA.meta,
  tables: { big_up: { title: "大市值涨幅 ≥ 4%", rows: BIG } },
  counts: { big_up: BIG.length, total: BIG.length, excluded: 0 },
  excluded: []
});
check("失效标签已从栏里消失", tabList(), "all:所有:3 | big_up:大市值 · 涨:3");
check("高亮回落到所有（不是留在已消失的按钮上）", lit(), "all");
check("表格恢复全部", codes(), "VICR,SOFI,GME");

section("8. 搜索框与标签叠加时，切换标签仍然生效");
reload(DATA);                     // 重新打开页面（顺带把搜索框清空）
BTN.all.fire("click");            // 上一节留下了记忆，本节的起点固定在「所有」档
els.q.value = "vicr";
els.q.fire("input");
check("搜索命中 1 条", codes(), "VICR");
BTN.mid_up.fire("click");
check("切到小市值（该档无 VICR）", lit(), "mid_up");
check("结果为空", rowInfo(), "显示 0 条 / 该分档共 2 条");
els.q.value = "";
els.q.fire("input");
check("清空搜索后小市值档 2 条", codes(), "VKTX,MTX");

/* ---------------------------------------------------------- B. 跨页保留 */
section("9. 选中「小市值」→ 切走再切回，仍停在小市值");
delete store["evening.tab"];       // 先清掉上一节留下的记忆，从"没存过"这个起点开始
reload(DATA);
check("没存过时默认在「所有」", lit(), "all");
BTN.mid_up.fire("click");
check("点击已写入存储", stored(), "mid_up");
reload();                          // ← 等价于：点「早盘总结」，再点回「夜盘异动」
check("切回来后高亮还在小市值", lit(), "mid_up");
check("表格也是小市值档", codes(), "VKTX,MTX");
check("行数说明", rowInfo(), "显示 2 条 / 该分档共 2 条");

section("10. 「所有」同样会被记住（不是只有非默认档才记）");
BTN.all.fire("click");
check("点击已写入存储", stored(), "all");
reload();
check("切回来后仍是所有", lit(), "all");
check("表格是全部两档合并", codes(), "VKTX,MTX,VICR,SOFI,GME");

section("11. 存的是后端起已经取消的档（如关掉下跌档后的 big_down）→ 回落「所有」");
BTN.big_up.fire("click");
store["evening.tab"] = "big_down";   // 模拟"上次看的档，这次后端不返回了"
reload();
check("高亮回落到所有", lit(), "all");
check("表格是全部", codes(), "VKTX,MTX,VICR,SOFI,GME");
check("存储保留用户原本的偏好（不写回 all）", stored(), "big_down");
check("标签栏里没有这个档", tabList().indexOf("big_down"), -1);

section("12. 存的是垃圾值 → 回落「所有」，不崩");
store["evening.tab"] = "'; not a tab";
reload();
check("高亮回落到所有", lit(), "all");
check("表格正常", codes(), "VKTX,MTX,VICR,SOFI,GME");

section("13. 存储不可用（隐私模式）→ 不崩，默认「所有」，点击仍然能用");
storageOk = false;
delete store["evening.tab"];
reload();
check("默认在所有", lit(), "all");
BTN.big_up.fire("click");
check("点击仍然生效（只是记不住）", lit(), "big_up");
check("表格跟着换", codes(), "VICR,SOFI,GME");
reload();
check("重开后回到默认（记不住是预期行为）", lit(), "all");
storageOk = true;

section("14. 不串页：脏改夜盘的记忆不会动到早盘页的键");
store["morning.tab"] = "stocks";
reload();
BTN.mid_up.fire("click");
check("夜盘的键已更新", stored(), "mid_up");
check("早盘页的键没被动过", localStorage.getItem("morning.tab"), "stocks");

console.log(fail === 0 ? "\n全部通过 ✓" : `\n${fail} 项未通过 ✗`);
process.exit(fail === 0 ? 0 : 1);
