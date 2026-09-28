/* 早盘总结（daily）「草稿 / 偏旧」提示用例

   为什么值得单独测
   ----------------
   2026-09-28 的故障不是"数据算错了"，而是"页面什么都没说"：
   那天 06:30 的调度因电脑休眠被跳过，09:16 App 起来后补跑，agent 只做完取数
   就 success 退出了 —— 留下一份 meta.draft = true 的复盘。页面上榜单是满的、
   涨跌幅是真的，只有驱动原因那列写着「分析未完成」、主线与关联是空的；
   而 stale 只按"交易日期距今 > 4 天"判，那天只差 3 天，不触发。
   于是半成品的页面上**一条提示都没有**，读者只能猜是没写完还是坏了。

   这个用例把"该提示时必须提示、且要说清缺什么"钉住；
   同时也钉住反向：**完成版不能无缘无故弹黄条** —— 天天挂一条会让人对提示免疫，
   真出事时反而不看了。

   用法：node tools/test_morning_draft.js      （退出码 0 = 全通过）
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
    if (id === "btnRefresh") return els["btnRefresh"] || null;   // daily 模式没有这个按钮
    return els[id] || (els[id] = mk(id));
  },
  addEventListener() {}, title: ""
};

/* ---------------------------------------------------------------- fetch 桩 */
const market = { open: false, phase: "premarket", label: "盘前", nextChangeEt: null };

/** 每轮用例替换它，再由 mount 触发 fetchDaily 读走 */
let MORNING = null;
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
function checkHas(label, hay, needle) {
  const ok = String(hay).indexOf(needle) >= 0;
  if (!ok) fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}: 含「${needle}」`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 跑一轮：喂一份 morning 数据，等 fetchDaily 落定，返回 #notice 的状态 */
async function run(morning) {
  MORNING = morning;
  if (!els["notice"]) els["notice"] = mk("notice");
  els["notice"].innerHTML = "";
  els["notice"].style = { display: "none" };
  els["notice"].className = "panel";
  Shell.mount({ navKey: "morning", title: "早盘总结", mode: "daily", onData: function () {} });
  await sleep(60);
  const el = els["notice"];
  return { shown: el.style.display !== "none", cls: el.className, html: el.innerHTML };
}

function done() {
  console.log(fail === 0 ? "\n全部通过 ✓" : `\n${fail} 项未通过 ✗`);
  process.exit(fail === 0 ? 0 : 1);
}

/* 一份"完成版"的底稿 —— 各用例只改 meta */
function base(meta) {
  return {
    ok: true,
    meta: Object.assign({
      tradeDate: "2026-09-25", tradeDateLabel: "9月25日（周五）",
      generatedAt: "2026-09-28T09:50:22+08:00", generatedBy: "us-stock-daily-review",
      draft: false, stale: false, ageDays: 3,
      coverage: { movers: 32, drivers: 32, themes: 7, linkage: 3, hints: 4 }
    }, meta),
    indices: [], movers: [], watchlist: [], themes: [], linkage: [], aShareHints: []
  };
}

(async function main() {
  console.log("\n早盘总结（daily）草稿 / 偏旧提示");

  /* ① 草稿：必须提示，且要说清"哪些是真的、缺哪一块、缺多少" */
  console.log("\n① 草稿（draft = true）");
  var d1 = await run(base({
    draft: true, draftWhy: "分析未写入（meta.generatedBy 是 morning_fetch.py）",
    coverage: { movers: 32, drivers: 27, themes: 0, linkage: 0, hints: 0 }
  }));
  check("提示条显示出来了", d1.shown, "true");
  checkHas("底色是 warn（黄）", d1.cls, "warn");
  checkHas("说清这是草稿", d1.html, "草稿");
  checkHas("给出榜单只数（读者知道行情是真的）", d1.html, "32 只");
  checkHas("点明缺的量（5 只）", d1.html, "驱动原因缺 5/32 只");
  checkHas("点明主线为空", d1.html, "主线归纳为空");
  checkHas("点明关联分析为空", d1.html, "关联性分析为空");
  checkHas("给出判定依据（排障有抓手）", d1.html, "generatedBy 是 morning_fetch.py");
  checkHas("提示去看定时任务", d1.html, "请检查定时任务");

  /* ② 完成版：**不能**弹提示 —— 天天一条会让人对提示免疫 */
  console.log("\n② 完成版（draft = false, 不旧）");
  var d2 = await run(base({}));
  check("提示条不显示", d2.shown, "false");
  check("底色回到普通 panel", d2.cls, "panel");

  /* ③ 偏旧：仍要提示（这是原有行为，不能被本次改动弄丢） */
  console.log("\n③ 偏旧（stale = true）");
  var d3 = await run(base({ stale: true, ageDays: 6, tradeDate: "2026-09-19" }));
  check("提示条显示出来了", d3.shown, "true");
  checkHas("底色是 warn", d3.cls, "warn");
  checkHas("说清不是最新交易日", d3.html, "不是最新交易日");
  checkHas("带上实际数据日期", d3.html, "2026-09-19");

  /* ④ 数据没生成：ok=false 时仍走原有提示，不能被草稿逻辑吃掉 */
  console.log("\n④ 数据未生成（ok = false）");
  var d4 = await run({ ok: false, message: "早盘总结数据尚未生成。", meta: {} });
  check("提示条显示出来了", d4.shown, "true");
  checkHas("底色是 warn", d4.cls, "warn");
  checkHas("原文照出", d4.html, "早盘总结数据尚未生成");

  /* ⑤ 草稿字段缺失时的兜底：老接口（没有 draft 字段）不该被当成草稿 */
  console.log("\n⑤ 老接口无 draft 字段（向后兼容）");
  var d5 = await run({
    ok: true,
    meta: { tradeDate: "2026-09-25", tradeDateLabel: "9月25日（周五）",
            generatedAt: "2026-09-28T09:50:22+08:00", generatedBy: "us-stock-daily-review" },
    movers: [], watchlist: [], themes: [], linkage: [], aShareHints: []
  });
  check("不显示提示（undefined 不等于草稿）", d5.shown, "false");

  /* ⑥ 草稿但 coverage 缺失：不能抛异常，仍要给出提示 */
  console.log("\n⑥ 草稿但 coverage 缺失（防御性）");
  var err = null, d6 = null;
  try {
    d6 = await run(base({ draft: true, draftWhy: "主线归纳（themes）为空", coverage: undefined }));
  } catch (e) { err = e.message; }
  check("未抛异常", err || "无", "无");
  check("提示条仍显示", d6 && d6.shown, "true");
  checkHas("缺 coverage 时退回泛称", d6.html, "分析字段");
  checkHas("仍给出判定依据", d6.html, "themes）为空");

  done();
})();
