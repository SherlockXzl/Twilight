/* 早盘「个人关注池」自定义增删用例
 *
 *   用法：node tools/test_morning_watchlist.js      （退出码 0 = 全通过）
 *
 * 为什么需要这个用例
 * ------------------
 * 这个功能把**三样容易各自出错、又都不报错的东西**凑在了一起：
 *
 *   1. **增量存储**。清单只有 added / removed 两个数组，最终列表是"默认池 − removed + added"。
 *      写错任何一侧都不报错：漏了 removed，明天数据一刷新被删的票就自己回来了（用户会以为
 *      "删不掉"）；漏了 added 去重，同一只票出现两格。
 *   2. **现场取数**。自选票的行情是异步来的，失败、代码不存在、重复添加三种结局
 *      在页面上长得都很像（都是"没数字"），必须分别断言。
 *   3. **持久化**。localStorage 可能存着坏 JSON、也可能被隐私模式禁用 ——
 *      两种情况下页面都必须照常可用，而不是白屏。
 *
 * 做法与其它用例一致：最小 DOM 桩 + 合成数据 + 桩化的 fetch，不联网、可重复跑。
 */

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..") + "/";

/* ------------------------------------------------------------ localStorage 桩 */
let store = {};
let storeDenied = false;          // 模拟隐私模式：写入直接抛
const LS = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem(k, v) { if (storeDenied) throw new Error("QuotaExceededError"); store[k] = String(v); },
  removeItem(k) { delete store[k]; }
};

/* ------------------------------------------------------------------ DOM 桩 */
const els = {};
const kls = () => {
  const set = {};
  return { add: c => (set[c] = true), remove: c => delete set[c],
           toggle(c, f) { const on = f === undefined ? !set[c] : !!f; if (on) set[c] = true; else delete set[c]; return on; },
           contains: c => !!set[c] };
};
function mk(id) {
  return {
    id, innerHTML: "", textContent: "", value: "", hidden: false, style: {}, _q: {}, _h: {},
    parentNode: null, children: [], classList: kls(),
    addEventListener(t, f) { (this._h[t] = this._h[t] || []).push(f); },
    removeEventListener(t, f) { if (this._h[t]) this._h[t] = this._h[t].filter(x => x !== f); },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; return c; },
    setAttribute(k, v) { this["_a_" + k] = v; },
    getAttribute(k) { return this["_a_" + k]; },
    contains(t) {
      if (t === this) return true;
      return this.children.some(c => c.contains && c.contains(t));
    },
    focus() {},
    querySelector(s) { return this._q[s] || (this._q[s] = mk(id + s)); },
    querySelectorAll() { return []; },
    fire(t, ev) { (this._h[t] || []).slice().forEach(f => f.call(this, ev || {})); }
  };
}

/* #morningHost：渲染入口。innerHTML 一被赋值，真实浏览器里**整棵子树都换成了新节点**，
   旧元素上的监听器随之消失。桩必须照做 —— 否则每次 render 都会往同一批桩元素上再挂一遍
   监听器，一次点击跑两遍处理函数（实测踩到：第二次拿到的是已被清空的输入框，
   于是"已恢复 MMM"当场被改写成空字符串，看着像提示没生效）。
   这里把"子树换新"简化为"清掉所有桩上的监听器"（排除 morningHost 自身的）。
   注意只在 morningHost 重绘时清：renderWatchlist() 只重画 #wlHost，
   方块上的委托监听必须活下来，否则 × 就点不动了。 */
const morningHost = mk("morningHost");
(function () {
  let html = "";
  Object.defineProperty(morningHost, "innerHTML", {
    get() { return html; },
    set(v) {
      html = String(v);
      Object.keys(els).forEach(function (k) {
        if (els[k] !== morningHost && els[k]._h) els[k]._h = {};
      });
      if (els.wlAdd && els.wlAdd.parentNode) els.wlAdd.parentNode._h = {};
    },
    configurable: true
  });
})();
els.morningHost = morningHost;

/* #wlHost：innerHTML 一赋值就把里面的 data-act 按钮解析成对象，
   模拟"重绘后拿到新按钮"。点这些按钮要**走委托**，和真实页面一样。 */
const WLB = {};
const wlHost = mk("wlHost");
(function () {
  let html = "";
  Object.defineProperty(wlHost, "innerHTML", {
    get() { return html; },
    set(v) {
      html = String(v);
      for (const k in WLB) delete WLB[k];
      (html.match(/data-act="(?:del|retry)" data-code="[^"]+"/g) || []).forEach(function (s) {
        const m = s.match(/data-act="(\w+)" data-code="([^"]+)"/);
        const el = mk(m[1] + ":" + m[2]);
        el.getAttribute = a => (a === "data-act" ? m[1] : a === "data-code" ? m[2] : undefined);
        el.closest = () => el;
        WLB[m[1] + ":" + m[2]] = el;
      });
    },
    configurable: true
  });
})();
els.wlHost = wlHost;
els.wlAdd = mk("wlAdd");
els.wlAddBtn = mk("wlAddBtn");
els.wlMsg = mk("wlMsg");
els.wlHidden = mk("wlHidden");
els.wlCount = mk("wlCount");
/* DOM 结构与页面一致：输入框套在 .sug 里（建议下拉的定位容器），
   工具条是 .sug 的父节点。建议组件会把弹层 append 到 .sug 上。 */
els.wlTools = mk("wlTools");
els.wlSug = mk("wlSug");
els.wlSug.parentNode = els.wlTools;
els.wlAdd.parentNode = els.wlSug;

global.window = global;
global.localStorage = LS;
global.document = {
  getElementById: id => els[id] || (els[id] = mk(id)),
  createElement(tag) { const e = mk("new:" + tag); e.tagName = String(tag).toUpperCase(); return e; },
  addEventListener() {}, removeEventListener() {}, title: ""
};
global.scrollTo = function () {};

/* ---------------------------------------------------------------- fetch 桩 */
let fetchHandler = null;
let fetchCalls = [];
global.fetch = function (url) {
  fetchCalls.push(url);
  const payload = fetchHandler ? fetchHandler(url) : { ok: true, quotes: {}, missing: [] };
  return Promise.resolve({ json: () => Promise.resolve(payload) });
};
function tick(n) {
  let p = Promise.resolve();
  for (let i = 0; i < (n || 8); i++) p = p.then(() => new Promise(r => setTimeout(r, 0)));
  return p;
}

let cap = null;
global.Shell = {
  state: {},
  mount(o) { cap = o; },
  syncCountdown() {},
  criteriaValues: () => ({ bigMinCap: 1e10, midMinCap: 1.5e9 })
};

eval(fs.readFileSync(ROOT + "static/util.js", "utf8"));
eval(fs.readFileSync(ROOT + "static/combo.js", "utf8"));
eval(fs.readFileSync(ROOT + "static/suggest.js", "utf8"));
eval(fs.readFileSync(ROOT + "static/morning.js", "utf8"));

/** 模拟**重新打开页面**：重新执行 morning.js。
 *  为什么必须真重跑一遍而不是只改 store：关注池的自定义量（state.wl）是脚本加载时
 *  从 localStorage 读一次、之后一直挂在内存里的 —— 这正是真实行为（数据刷新不会
 *  重读 localStorage），所以"换了 localStorage 就期望渲染跟着变"的断言必须先把页面重开。
 *  直接改 store 就断言，测的其实是不存在的行为。 */
function reloadPage() {
  fetchCalls = [];
  els.wlAdd.value = "";
  eval(fs.readFileSync(ROOT + "static/morning.js", "utf8"));
}

/* ------------------------------------------------------------------ 断言 */
let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  if (ok) { pass++; console.log(`  ✓ ${label}: ${got}`); }
  else { fail++; console.log(`  ✗ ${label}: ${got}   (期望 ${want})`); }
}
function section(t) { console.log("\n" + t); }

/* ------------------------------------------------------------------ 数据 */
function wl(code, chg) {
  return { code: "us" + code, name: code + " 公司", close: 10, chgPct: chg, capYi: 100, keyword: "—" };
}
function basePool() { return [wl("ZZZ", 1), wl("AAA", 2), wl("MMM", 3), wl("NNN", 4)]; }

function feed(watchlist) {
  const d = { ok: true, movers: [], watchlist: watchlist || basePool(),
              indices: [], themes: [], linkage: [], aShareHints: [] };
  global.Shell.state.data = d;
  cap.onData(d);
  return d;
}

/** 从渲染出来的方块里读代码顺序（含"取数中/失败"的占位格） */
function tiles() {
  return (wlHost.innerHTML.match(/<span class="tile-code">([^<]+)<\/span>/g) || [])
    .map(s => s.replace(/^<span class="tile-code">|<\/span>$/g, "")).join(",");
}
/** 面板徽章上的只数 */
function badge() { return els.wlCount.textContent; }
function saved() {
  const raw = LS.getItem("morning.watchlist");
  return raw === null ? "(空)" : JSON.stringify(JSON.parse(raw));
}
function clickTile(act, code) {
  const el = WLB[act + ":" + code];
  if (!el) throw new Error("找不到按钮：" + act + ":" + code + " / 现有 " + Object.keys(WLB).join(" "));
  wlHost.fire("click", { target: el, stopPropagation() {} });
}
function typeAndAdd(v) {
  els.wlAdd.value = v;
  els.wlAddBtn.fire("click");
}

/* 一个正常的 /api/quote 返回体：给定 symbol → 行情 */
function quotePayload(url, map) {
  const codes = decodeURIComponent((url.match(/codes=([^&]*)/) || [])[1] || "").split(",");
  const quotes = {}, missing = [];
  codes.forEach(function (c) {
    const sym = c.replace(/^us(?=[A-Z])/, "");
    if (map[sym]) {
      quotes[sym] = {
        code: "us" + sym, symbol: sym, name: map[sym].name || (sym + " Inc"),
        close: map[sym].close, chgPct: map[sym].chgPct, capYi: map[sym].capYi,
        keyword: map[sym].kw || "信息技术", custom: true
      };
    } else missing.push(sym);
  });
  return { ok: true, quotes, missing, basis: "session", message: "" };
}

/** 只桩 /api/quote */
function quoteOk(map) {
  fetchHandler = (url) => quotePayload(url, map);
}

/** 同时桩 /api/symbols 与 /api/quote —— 测"输入即建议"时页面会同时打这两个接口。
 *  两个接口共用一个 handler，所以必须按 URL 分流：不分流的话建议接口会拿到
 *  行情返回体，items() 永远是空的，而失败表现是"下拉没反应"，很难看出是桩的问题。 */
function bothOk(symbols, map) {
  fetchHandler = function (url) {
    if (url.indexOf("/api/symbols") === 0) {
      return { ok: true, query: "", symbols: symbols || [] };
    }
    return quotePayload(url, map || {});
  };
}

/** 从建议下拉里点第 i 项（走 mousedown 委托，与真实页面一致） */
function pickSuggestion(api, i) {
  const el = {
    getAttribute: (a) => (a === "data-i" ? String(i) : undefined),
    closest: (sel) => (sel === ".sug-i" ? el : null)
  };
  api.pop.fire("mousedown", { target: el, preventDefault() {} });
}
function pressKey(input, k) {
  input.fire("keydown", { key: k, preventDefault() {} });
}

/* ================================================================ 用例 */

(async function run() {

  section("1. 首屏：默认池按代码字母序，徽章是只数");
  store = {}; storeDenied = false; fetchHandler = null;
  feed(basePool());
  check("方块顺序", tiles(), "AAA,MMM,NNN,ZZZ");
  check("徽章", badge(), "4 只");
  check("没有自定义时 localStorage 不动", saved(), "(空)");

  section("2. 添加：先出占位格（取数中），取回后填入行情并标「自选」");
  quoteOk({ AAPL: { name: "Apple Inc", close: 338.98, chgPct: 0.85, capYi: 49869 } });
  typeAndAdd("AAPL");
  check("立刻出现占位格（不让点击看起来没反应）", tiles(), "AAA,AAPL,MMM,NNN,ZZZ");
  check("占位格标着取数中", /取数中/.test(wlHost.innerHTML), "true");
  check("徽章先加一位", badge(), "5 只");
  await tick();
  check("取回后仍是同一个位置（按代码插，不是追加到末尾）", tiles(), "AAA,AAPL,MMM,NNN,ZZZ");
  check("填入了公司名", /Apple Inc/.test(wlHost.innerHTML), "true");
  check("带上涨跌幅", /\+0\.85%/.test(wlHost.innerHTML), "true");
  check("标了「自选」", /tile-tag">自选</.test(wlHost.innerHTML), "true");
  check("已写入 localStorage", saved(), '{"added":["usAAPL"],"removed":[]}');
  check("只请求了一次", fetchCalls.length, 1);

  section("3. 输入形态：aapl / usAAPL / $AAPL 都指向同一只，不会重复添加");
  typeAndAdd("aapl");
  check("已在池中 → 给出提示", /已经在关注池里了$/.test(els.wlMsg.textContent), "true");
  check("没有多出一格", tiles(), "AAA,AAPL,MMM,NNN,ZZZ");
  typeAndAdd("$AAPL");
  check("带 $ 也认得出是同一只", tiles(), "AAA,AAPL,MMM,NNN,ZZZ");
  typeAndAdd("usAAPL");
  check("带 us 前缀也认得出", tiles(), "AAA,AAPL,MMM,NNN,ZZZ");
  check("added 里始终只有一条", saved(), '{"added":["usAAPL"],"removed":[]}');

  section("4. 输入不合法：给提示，不进列表");
  typeAndAdd("AA PL");
  check("提示格式不对", els.wlMsg.textContent, "代码格式不对（示例：AAPL / BRK.B）");
  check("列表没变", tiles(), "AAA,AAPL,MMM,NNN,ZZZ");
  typeAndAdd("");
  check("空输入不提示（避免无谓噪音）", els.wlMsg.textContent, "");

  section("5. 移除默认池的票：进 removed，且明天数据刷新也不会回来");
  clickTile("del", "usMMM");
  check("方块里没了", tiles(), "AAA,AAPL,NNN,ZZZ");
  check("徽章减一位", badge(), "4 只");
  check("记进 removed", saved(), '{"added":["usAAPL"],"removed":["usMMM"]}');
  check("提示已移除", els.wlMsg.textContent, "已移除 MMM");
  feed(basePool());          // 模拟第二天自动化重写了 morning.json，MMM 又回来了
  check("数据刷新后被删的票仍不出现", tiles(), "AAA,AAPL,NNN,ZZZ");

  section("6. 移除自选票：从 added 里去掉，不污染 removed");
  clickTile("del", "usAAPL");
  check("方块里没了", tiles(), "AAA,NNN,ZZZ");
  check("只从 added 移除", saved(), '{"added":[],"removed":["usMMM"]}');
  check("徽章", badge(), "3 只");

  section("7. 恢复：清掉 removed，被删的票回来");
  els.wlTools.fire("click", { target: { getAttribute: a => (a === "data-act" ? "restore" : undefined) }, preventDefault() {} });
  check("MMM 回来了", tiles(), "AAA,MMM,NNN,ZZZ");
  check("removed 已清空", saved(), '{"added":[],"removed":[]}');
  check("提示", els.wlMsg.textContent, "已恢复 1 只");

  section("8. 添加一只曾经被移除过的代码 = 撤销那次移除，而不是「再加一只」");
  clickTile("del", "usMMM");                       // 再删掉
  check("先删掉", saved(), '{"added":[],"removed":["usMMM"]}');
  typeAndAdd("MMM");
  check("加回来后池子里有它", tiles(), "AAA,MMM,NNN,ZZZ");
  check("removed 被清掉（没进 added）", saved(), '{"added":[],"removed":[]}');
  /* 提示要**等取数回来之后再读**：早先这里省了这步 await，于是"取数成功的回调把提示
     静默清空"这个真 bug 用例看不见（变异测试发现的）。成功是最平常的路径，最容易漏。 */
  await tick();
  check("取数回来后提示仍在（不被静默清空）", els.wlMsg.textContent, "已恢复 MMM");

  section("9. 代码不存在 → 不可重试的错误格（再点也没用，别诱导点击）");
  quoteOk({});                                     // 空 map：任何代码都查不到
  typeAndAdd("QQQZZ");
  await tick();
  check("占了格子", tiles(), "AAA,MMM,NNN,QQQZZ,ZZZ");
  check("说明是查不到", /查不到这个代码/.test(wlHost.innerHTML), "true");
  check("不给重试按钮", Object.keys(WLB).filter(k => k.indexOf("retry:") === 0).length, 0);
  check("仍然可以从池子里删掉", !!WLB["del:usQQQZZ"], "true");
  clickTile("del", "usQQQZZ");
  check("删掉了", tiles(), "AAA,MMM,NNN,ZZZ");

  section("10. 取数失败 → 可重试；重试会再打一次接口");
  fetchHandler = () => ({ ok: false, quotes: {}, missing: [], message: "取数源均不可用" });
  typeAndAdd("TSLA");
  await tick();
  check("给出失败格", /取数失败/.test(wlHost.innerHTML), "true");
  check("给了重试按钮", !!WLB["retry:usTSLA"], "true");
  {
    const before = fetchCalls.length;
    quoteOk({ TSLA: { name: "Tesla Inc", close: 375.3, chgPct: 3.03, capYi: 14858 } });
    clickTile("retry", "usTSLA");
    await tick();
    check("重试又请求了一次", fetchCalls.length > before, "true");
    check("这次取到了", /Tesla Inc/.test(wlHost.innerHTML), "true");
    check("重试按钮消失", !!WLB["retry:usTSLA"], "false");
  }

  section("11. 存储里是坏 JSON → 重开页面当没有自定义，且不影响后续操作");
  store = { "morning.watchlist": "{这不是 JSON" };
  reloadPage();
  feed(basePool());
  check("照常显示默认池", tiles(), "AAA,MMM,NNN,ZZZ");
  check("徽章正常", badge(), "4 只");
  quoteOk({ AAPL: { name: "Apple Inc", close: 338.98, chgPct: 0.85, capYi: 49869 } });
  typeAndAdd("AAPL");
  await tick();
  check("加一只依然能用（坏数据没把功能弄坏）", tiles(), "AAA,AAPL,MMM,NNN,ZZZ");
  check("并且把存储写回成合法 JSON", saved(), '{"added":["usAAPL"],"removed":[]}');

  section("12. 存储里是脏数据（元素不是代码）→ 只认合法的，不产生幽灵格子");
  store = { "morning.watchlist": JSON.stringify({ added: ["usAAPL", "!!", 123, null], removed: "x" }) };
  quoteOk({ AAPL: { name: "Apple Inc", close: 338.98, chgPct: 0.85, capYi: 49869 } });
  reloadPage();
  feed(basePool());
  check("只留下合法代码", tiles(), "AAA,AAPL,MMM,NNN,ZZZ");
  check("徽章按清理后的算", badge(), "5 只");

  section("13. 存储被禁用（隐私模式）→ 操作照常生效，只是不持久");
  store = {}; storeDenied = true;
  quoteOk({ NVDA: { name: "NVIDIA", close: 227.38, chgPct: 2.3, capYi: 55022 } });
  reloadPage();
  feed(basePool());
  typeAndAdd("NVDA");
  await tick();
  check("页面仍然加上了", tiles(), "AAA,MMM,NNN,NVDA,ZZZ");
  check("写入被拒也不影响渲染", badge(), "5 只");
  check("操作过程没有抛异常挂掉", /NVIDIA/.test(wlHost.innerHTML), "true");
  storeDenied = false;

  section("14. 徽章与方块数始终一致（增删混合后）");
  store = {}; storeDenied = false;
  quoteOk({ AAPL: { name: "Apple Inc", close: 338.98, chgPct: 0.85, capYi: 49869 } });
  reloadPage();
  feed(basePool());
  typeAndAdd("AAPL");
  await tick();
  clickTile("del", "usAAA");
  clickTile("del", "usZZZ");
  check("方块", tiles(), "AAPL,MMM,NNN");
  check("徽章跟着走", badge(), "3 只");
  check("存储同步", saved(), '{"added":["usAAPL"],"removed":["usAAA","usZZZ"]}');

  section("15. 自选过的票后来被上游写进默认池 → 只显示一格，而且删得掉");
  /* 这个场景很现实：用户今天手动加了 BBB，隔天自动化把 BBB 也写进了默认池。
     此时同一个代码同时存在于 added 与默认池两份数据里，两个坑都只在这里会露出来：
       · 不去重 → 池子里出现两个 BBB 方块；
       · 移除时若按"自选票不记 removed"处理 → added 删掉了，默认池那一份立刻顶回来，
         表现为「点了 × 但没反应」。
     变异测试发现上面两处当时的用例都没覆盖，故补这一节。 */
  store = { "morning.watchlist": JSON.stringify({ added: ["usBBB"], removed: [] }) };
  quoteOk({});
  reloadPage();
  feed([wl("AAA", 1), wl("BBB", 2), wl("CCC", 3)]);
  check("同一个代码只出现一格", tiles(), "AAA,BBB,CCC");
  check("徽章不重复计数", badge(), "3 只");
  clickTile("del", "usBBB");
  check("删掉后真的没了（默认池那一份也被挡住）", tiles(), "AAA,CCC");
  check("记进了 removed", saved(), '{"added":[],"removed":["usBBB"]}');

  section("16. 输入即建议：下拉里选一只 = 直接加进关注池");
  store = {}; storeDenied = false;
  bothOk([{ symbol: "NVDA", name: "NVIDIA Corporation", etf: false },
          { symbol: "NVD", name: "GraniteShares 2x Short", etf: true, leveraged: true }],
         { NVDA: { name: "NVIDIA Corporation", close: 227.38, chgPct: 2.3, capYi: 55022 } });
  reloadPage();
  feed(basePool());

  const sug = Suggest.get("wlAdd");
  check("输入框已挂上建议组件", !!sug, true);

  sug.search("nvda");                       // 跳过防抖，直接查一次
  await tick();
  check("弹层打开", sug.isOpen(), true);
  check("建议项来自接口且顺序不变", sug.items().map(i => i.symbol).join(","), "NVDA,NVD");
  check("请求带上了查询词", fetchCalls.some(u => u.indexOf("/api/symbols") === 0 && u.indexOf("q=nvda") >= 0), true);

  pickSuggestion(sug, 0);
  await tick();
  check("选中的票进了关注池", tiles(), "AAA,MMM,NNN,NVDA,ZZZ");
  check("写进了 added（不是 removed）", saved(), '{"added":["usNVDA"],"removed":[]}');
  check("输入框被清空（免得再点一次又加一遍）", els.wlAdd.value, "");
  check("弹层已关", sug.isOpen(), false);
  check("提示没被取数回调清掉", els.wlMsg.textContent, "");

  section("17. 建议的高亮项与「回车」的配合：不按 ↓ 就加原文，按了 ↓ 才加建议");
  bothOk([{ symbol: "AMD", name: "Advanced Micro Devices", etf: false }],
         { AMD: { name: "Advanced Micro Devices", close: 160, chgPct: 9.95, capYi: 26000 },
           TSLA: { name: "Tesla Inc", close: 375.3, chgPct: 3.03, capYi: 14858 } });
  const sug2 = Suggest.get("wlAdd");
  sug2.search("amd");
  await tick();
  els.wlAdd.value = "TSLA";                  // 用户改打了别的（此时列表还是 amd 的建议）
  pressKey(els.wlAdd, "Enter");
  await tick();
  check("没有高亮 → 回车加的是**输入框原文** TSLA", tiles().indexOf("TSLA") >= 0, true);
  check("没有误加高亮项 AMD", tiles().indexOf("AMD"), -1);

  section("18. ↓ 高亮后回车 → 加的是建议项（而不是原文）");
  store = {}; storeDenied = false;
  bothOk([{ symbol: "AMD", name: "Advanced Micro Devices", etf: false }],
         { AMD: { name: "Advanced Micro Devices", close: 160, chgPct: 9.95, capYi: 26000 } });
  reloadPage();
  feed(basePool());
  const sug3 = Suggest.get("wlAdd");
  sug3.search("amd");
  await tick();
  check("高亮起初在 -1", sug3.highlight(), -1);
  pressKey(els.wlAdd, "ArrowDown");
  check("↓ 之后高亮到 0", sug3.highlight(), 0);
  pressKey(els.wlAdd, "Enter");
  await tick();
  check("加进来的是建议项 AMD", tiles(), "AAA,AMD,MMM,NNN,ZZZ");
  check("added 里是 usAMD", saved(), '{"added":["usAMD"],"removed":[]}');

  section("19. 选一只已经在池子里的 → 只提示，不重复");
  bothOk([{ symbol: "AAA", name: "AAA 公司", etf: false }], {});
  const sug4 = Suggest.get("wlAdd");
  sug4.search("aaa");
  await tick();
  pickSuggestion(sug4, 0);
  await tick();
  check("没有多出一格", tiles(), "AAA,AMD,MMM,NNN,ZZZ");
  check("给了「已经在关注池里」提示", /已经在关注池里了$/.test(els.wlMsg.textContent), "true");

  console.log("");
  if (fail === 0) { console.log(`全部通过 ✓  (${pass} 项断言)`); process.exit(0); }
  console.log(`有失败项 ✗  (${fail} 项失败 / ${pass + fail} 项)`);
  process.exit(1);
})();
