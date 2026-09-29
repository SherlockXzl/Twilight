/* 夜盘异动 · 「驱动原因」跟着行情重取 用例（2026-09-29 加）

   用法：node tools/test_evening_reasons.js      （退出码 0 = 全通过）

   为什么单独测
   ------------
   原先 loadReasons() 只在**进页面时**取一次。起因是补原因的自动化只在工作日 16:40
   收盘后跑一次 —— 那时"取一次"是合理的。2026-09-29 改成自动化盘中每 2 小时也跑
   （10:40/12:40/14:40/16:40），页面这边就必须跟着取：长开的看板停在打开那一刻，
   补进去的原因要手动刷新才看得见，用户看到的就是"驱动原因怎么还是没有"。

   这类改动的失效方式全是**静默**的，所以每条都单独钉：

   · 忘了在 onData 里取 → 页面看着一切正常，只是原因永远停在打开那一刻。
     断言"每轮行情刷新都会重取"。
   · 挡并发时标志只在成功路径复位 → 一次网络抖动之后这一页**再也不取**。
     断言"失败后下一轮仍会取"。
   · 没挡并发 → 心跳一次、手动刷新一次，叠出几份在途请求。断言"在飞时不重发"。
   · 不做"内容有没有变"的判断 → 每轮心跳整块重画表格，读者刚把横向滚动拖到
     「驱动原因」列就被弹回最左边。断言"内容没变时表格只被写一次"。

   做法：最小 DOM 桩加载 util.js + combo.js + evening.js（与 test_evening_tabs.js 同款），
   fetch 桩可控（立刻返回 / 挂起 / 失败），断言只看 DOM 与请求次数，不看内部 state。
*/
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..") + "/";

/* ------------------------------------------------------------------ DOM 桩 */
const els = {};
let tableWrites = 0;

function mkClassList() {
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
    classList: mkClassList(), _h: {}, _q: {}, dataset: {},
    addEventListener(t, f) { this._h[t] = f; },
    setAttribute(k, v) { this["_a_" + k] = v; },
    getAttribute(k) { return this["_a_" + k]; },
    contains() { return false; }, focus() {},
    querySelector(sel) { return this._q[sel] || (this._q[sel] = mk(id + sel)); },
    querySelectorAll() { return []; },
    fire(t, ev) { if (this._h[t]) return this._h[t].call(this, ev || {}); }
  };
}
/* 标签栏：innerHTML 一旦被赋值就重建按钮（真实浏览器就是这样） */
const BTN = {};
function mkTabsBox(id) {
  const el = mk(id);
  let html = "";
  Object.defineProperty(el, "innerHTML", {
    get() { return html; },
    set(v) {
      html = String(v);
      for (const k in BTN) delete BTN[k];
      (html.match(/data-tab="([^"]+)"/g) || []).forEach(function (s) {
        BTN[s.slice(10, -1)] = mk("tab:" + s.slice(10, -1));
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
          set(v) { h = String(v); tableWrites++; },     // 数一数被写了几次
          configurable: true
        });
      }
      return els.tableHost;
    }
    return els[id] || (els[id] = mk(id));
  },
  addEventListener() {}, title: "", createElement: mk,
  body: { style: {}, appendChild() {} }, activeElement: null
};

const store = {};
global.localStorage = {
  getItem(k) { return k in store ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); },
  removeItem(k) { delete store[k]; }
};

/* ------------------------------------------------------------- fetch 桩
   三种模式，由用例切换：
     默认      → 立刻返回当前 payload
     holdMode  → 挂住，等用例拿 pending.res 放行（测并发挡板）
     failOnce  → 这次 reject（测失败后能否恢复） */
let calls = [];
let reasonCalls = 0;
let payload = { ok: true, reasons: {} };
let holdMode = false, failOnce = false, pending = null;

global.fetch = function (url) {
  calls.push(String(url));
  if (String(url).indexOf("/api/reasons") < 0) return new Promise(function () {});   // 其它接口挂着
  reasonCalls++;
  if (holdMode) {
    return new Promise(function (res, rej) { pending.res = res; pending.rej = rej; });
  }
  if (failOnce) { failOnce = false; return Promise.reject(new Error("网络抖动")); }
  return Promise.resolve({ json: function () { return Promise.resolve(payload); } });
};

/* ---------------------------------------------------------------- Shell 桩 */
let cap = null;
global.Shell = { state: {}, mount(o) { cap = o; }, syncCountdown() {} };

eval(fs.readFileSync(ROOT + "static/util.js", "utf8"));
eval(fs.readFileSync(ROOT + "static/combo.js", "utf8"));
eval(fs.readFileSync(ROOT + "static/mapbtn.js", "utf8"));
eval(fs.readFileSync(ROOT + "static/sharemap.js", "utf8"));
eval(fs.readFileSync(ROOT + "static/modal.js", "utf8"));
eval(fs.readFileSync(ROOT + "static/evening.js", "utf8"));

/* ------------------------------------------------------------------ 构造数据 */
function row(sym, chg, cap_) {
  return { symbol: sym, name: sym + " Inc.", price: 12.34, chg: chg, marketCap: cap_,
           sector: "信息技术", industry: "半导体", sectorEn: "Technology", industryEn: "Semiconductors" };
}
const BIG = [row("SMMT", 18.14, 1.459e10)];
const MID = [row("NVTS", 11.83, 3.42e9)];
const DATA = {
  ok: true,
  meta: { criteria: { big: "总市值 ≥ 100 亿美元，涨幅 ≥ 4%", mid: "总市值 15–100 亿美元，涨幅 ≥ 10%", tiny: "总市值 < 15 亿美元，全部剔除（仅列对照）" } },
  tables: { big_up: { title: "大市值涨幅 ≥ 4%", rows: BIG }, mid_up: { title: "小市值涨幅 ≥ 10%", rows: MID } },
  counts: { big_up: 1, mid_up: 1, total: 2, excluded: 0 },
  excluded: []
};

const flush = () => new Promise(r => setImmediate(r)).then(() => new Promise(r => setImmediate(r)));
function feed() { global.Shell.state.data = DATA; cap.onData(DATA); }
const html = () => els.tableHost.innerHTML;
/** 表格里出现「待确认」的次数（＝还没原因的行数） */
const pendingCount = () => (html().match(/待确认/g) || []).length;
const has = (s) => html().indexOf(s) >= 0;

/* ------------------------------------------------------------------ 断言 */
let fail = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  if (!ok) fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}: ${got}${ok ? "" : "   (期望 " + want + ")"}`);
}
function section(t) { console.log("\n" + t); }

/* ------------------------------------------------------------------ 用例 */
(async function () {
  section("1. 进页面（还没有行情）不发原因请求 —— 表格没建起来，取了也没处显示");
  check("reasons 请求次数", reasonCalls, 0);

  section("2. 首轮行情：取一次原因，两行都还没原因 → 显示「待确认」");
  payload = { ok: true, reasons: {} };
  let w0 = tableWrites;
  feed(); await flush();
  check("reasons 请求次数", reasonCalls, 1);
  check("「待确认」行数", pendingCount(), 2);
  check("本轮表格被写次数（首轮无原因，不必二次重画）", tableWrites - w0, 1);

  section("3. 第二轮行情：SMMT 的原因已补进文件 → 上屏，NVTS 仍是「待确认」");
  payload = { ok: true, reasons: { SMMT: { driver: "生物技术·阿斯利康 20 亿美元入股（可转换优先股、18.36 美元/股）", from: "reasons", tradeDate: "2026-09-29" } } };
  w0 = tableWrites;
  feed(); await flush();
  check("reasons 请求次数（每轮都重取）", reasonCalls, 2);
  check("SMMT 的原因出现在表格里", has("阿斯利康 20 亿美元入股"), true);
  check("NVTS 仍是「待确认」", pendingCount(), 1);
  check("原因变了 → 多一次重画", tableWrites - w0, 2);

  section("4. 第三轮：内容一模一样 → 不重画（否则横向滚动位置每轮被顶回最左）");
  w0 = tableWrites;
  feed(); await flush();
  check("reasons 请求次数", reasonCalls, 3);
  check("表格只被 onData 写了一次，没有因原因重画", tableWrites - w0, 1);

  section("5. 第四轮：NVTS 也补上了 → 两行都有原因，「待确认」清零");
  payload = { ok: true, reasons: {
    SMMT: { driver: "生物技术·阿斯利康 20 亿美元入股（可转换优先股、18.36 美元/股）", from: "reasons", tradeDate: "2026-09-29" },
    NVTS: { driver: "功率半导体·碳化硅 · 获美陆军 ALATTIS 项目（10kV SiC IGBT）", from: "reasons", tradeDate: "2026-09-29" } } };
  w0 = tableWrites;
  feed(); await flush();
  check("「待确认」行数", pendingCount(), 0);
  check("NVTS 的原因上屏", has("ALATTIS"), true);
  check("原因变了 → 多一次重画", tableWrites - w0, 2);

  section("6. 并发挡板：上一份还在飞时，又来一轮行情 → 不再发第二份");
  holdMode = true; pending = {};
  feed(); await flush();
  const after = reasonCalls;
  feed(); await flush();
  check("在飞期间总请求次数不变", reasonCalls, after);
  pending.res({ json: () => Promise.resolve(payload) });
  await flush();
  holdMode = false;
  check("放行后表格内容仍是两行都有原因", pendingCount(), 0);

  section("7. 一次失败不会让这一页从此不再取原因");
  failOnce = true;
  feed(); await flush();
  check("失败那次算一次请求", reasonCalls, after + 1);
  payload = { ok: true, reasons: { SMMT: { driver: "换了新原因：阿斯利康交易完成交割", from: "reasons", tradeDate: "2026-09-29" },
                                   NVTS: { driver: "功率半导体·碳化硅 · 获美陆军 ALATTIS 项目（10kV SiC IGBT）", from: "reasons", tradeDate: "2026-09-29" } } };
  w0 = tableWrites;
  feed(); await flush();
  check("失败后仍会重取（标志已复位）", reasonCalls, after + 2);
  check("新原因上屏", has("阿斯利康交易完成交割"), true);

  section("8. 后端返回脏数据 / 空响应也不能把页面搞挂");
  payload = null;
  feed(); await flush();
  check("空响应不抛异常，表格照常", html().length > 0, true);
  payload = { ok: true };
  w0 = tableWrites;
  feed(); await flush();
  check("缺 reasons 字段 → 当成空表，行数还在", (html().match(/<td class="code">/g) || []).length, 2);

  console.log("");
  if (fail === 0) console.log("全部通过 ✓");
  else console.log(`有 ${fail} 项失败 ✗`);
  process.exit(fail === 0 ? 0 : 1);
})();
