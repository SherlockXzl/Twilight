/* 早盘总结（daily）页头用例

   为什么单独测它
   --------------
   「删掉一个 DOM 元素、却忘了删引用它的那行 JS」在本项目已经踩过两次
   （删页脚 footMeta、删「只看非美国本土公司」勾选）。
   这一次的现场是：`mount()` 的 daily 分支里有一行
       $("btnRefresh").addEventListener("click", ...)
   按钮一删，`$()` 返回 null，addEventListener 立刻抛 TypeError，
   **mount() 当场中断** —— 后面的 fetchDaily() 根本不会执行，页面只剩空壳。
   而浏览器控制台的报错很容易被当成"后端挂了"，回头白查半天。

   所以这里要断言的不是"按钮没了"，而是**mount 走完了、数据确实渲染出来了**。

   另外还验页头的时间徽章：时间**只保留一个「生成时间」**（用户 2026-09-22 定的），
   它来自 `meta.generatedAt`，是数据文件实际被写出的那一刻。

   用法：node tools/test_daily_header.js      （退出码 0 = 全通过）
*/
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..") + "/";

/* ------------------------------------------------------------------ DOM 桩 */
const els = {};
function mk(id) {
  return {
    id, innerHTML: "", textContent: "", value: "", hidden: false, style: {},
    _h: {}, _q: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
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
global.window = global;
global.document = {
  getElementById(id) {
    // 特别处理：daily 模式**不应该**存在「重新读取」按钮。
    // 这里返回 undefined 会绕过"桩总是自动创建元素"的宽容性 ——
    // 正是这种宽容让真实浏览器里的 null 崩溃测不出来。
    if (id === "btnRefresh") return els["btnRefresh"] || null;
    return els[id] || (els[id] = mk(id));
  },
  addEventListener() {}, title: ""
};

/* ---------------------------------------------------------------- fetch 桩 */
const market = { open: false, phase: "premarket", label: "盘前", nextChangeEt: null };
const MORNING = {
  ok: true,
  meta: { tradeDate: "2026-09-21", tradeDateLabel: "9月21日（周一）",
          generatedAt: "2026-09-22T17:38:52", generatedBy: "us-stock-daily-review" },
  indices: [{ code: "usSPY", name: "标普500（SPY）", close: 773.5, chgPct: 1.55 }],
  movers: [], watchlist: [], themes: [], linkage: [], aShareHints: []
};
global.fetch = function (url) {
  if (url === "/api/status") return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, market }) });
  if (url === "/api/morning") return Promise.resolve({ ok: true, json: () => Promise.resolve(MORNING) });
  return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
};

eval(fs.readFileSync(ROOT + "static/util.js", "utf8"));
eval(fs.readFileSync(ROOT + "static/icons.js", "utf8"));
eval(fs.readFileSync(ROOT + "static/shell.js", "utf8"));

/* ------------------------------------------------------------------ 断言 */
let fail = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  if (!ok) fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}: ${got}${ok ? "" : "   (期望 " + want + ")"}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const headerHtml = () => els["pageHeader"].innerHTML;
/* fetchDaily 没跑起来时这些元素压根没被创建，取值要容忍缺失 ——
   否则出问题时报的是"测试崩了"，而不是哪一条断言没过。 */
const val = id => (els[id] ? els[id].textContent : "(元素不存在)");

(async function main() {
  console.log("\n早盘总结（daily）页头");

  let onDataCalled = false;
  let threw = null;
  try {
    Shell.mount({
      navKey: "morning", title: "早盘总结", mode: "daily",
      onData: function () { onDataCalled = true; }
    });
  } catch (e) {
    threw = e.message;
  }
  await sleep(60);

  check("mount 未抛异常（删按钮不能再留着它的绑定）", threw || "无", "无");
  check("onData 被调用（说明 mount 走完了）", onDataCalled, "true");
  check("页头含生成时间徽章", /id="genTime"/.test(headerHtml()), "true");
  check("页头已无「重新读取」按钮", /重新读取|btnRefresh/.test(headerHtml()), "false");
  check("页头已无「读取时间」徽章", /读取时间|readAt/.test(headerHtml()), "false");
  check("生成时间已填入", /^\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}:\d{2}$/.test(val("genTime")), "true");
  check("复盘交易日已填入", val("tradeDate"), "9月21日（周一）");
  /* 2026-09-22：live 模式已改成"完全不自动取数"，daily 模式更不该有任何轮询。
     断言从"pollTimer 为 null"改成"根本没有定时器状态"—— 后者不依赖具体字段名，
     以后再有定时器相关的重构也不会让这条断言变成恒真。 */
  check("daily 模式不建任何取数定时器", typeof Shell.state.pollTimer, "undefined");
  /* daily 模式**确实**有一个定时器，但它只刷市场状态徽章（/api/status），不重读复盘数据。
     这条断言把"有定时器"这件事写明白，免得以后有人看到 statusTimer 非空就以为漏了清理。 */
  check("只有一个状态刷新定时器（用于市场状态徽章）", !!Shell.state.statusTimer, true);

  console.log(fail === 0 ? "\n全部通过 ✓" : `\n${fail} 项未通过 ✗`);
  process.exit(fail === 0 ? 0 : 1);
})();
