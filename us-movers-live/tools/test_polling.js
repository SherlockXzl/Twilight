/* 夜盘异动 · 前端心跳用例（2026-09-22 口径换成夜盘后重写）
 *
 *   用法：node tools/test_polling.js      （退出码 0 = 全通过）
 *
 * 口径变了，心跳规则也跟着变，**三个方向都会悄悄坏掉且不报错**：
 *
 *   · 坏在"该刷不刷"：夜盘进行中却按"快照身份变没变"判断 —— 场内 basis 和
 *     sessionDate 都不变，身份永远不变，页面会冻在进页面那一刻。
 *     表现是"数字看着挺正常"，只是一直不动。
 *   · 坏在"不该刷还刷"：夜盘已收盘却还在取 → 白白打数据源，而且页面会闪。
 *   · 坏在"复位漏了"：取数中标志只在成功路径复位 → 一次提前 return 就永久不再取数。
 *
 * 做法：setInterval 换成记录器（不真跑），手动触发心跳 —— 测的是真实代码路径，
 * 又不依赖墙上时钟。fetch 桩可分别控制「后端手上那份快照」与「行情响应里带的那份」。
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
  getElementById(id) { return els[id] || (els[id] = mk(id)); },
  addEventListener() {}, title: ""
};

/* ---------------------------------------------------------------- 定时器桩 */
/* 只记录、不执行：轮询类 bug 的断言要确定性，不能靠等真实时间。
   用例自己决定什么时候触发哪一次检查。 */
const timers = [];
global.setInterval = function (fn, ms) {
  const t = { fn, ms, id: timers.length + 1, dead: false, kind: "interval" };
  timers.push(t);
  return t.id;
};
global.clearInterval = function (id) {
  const t = timers.find(x => x.id === id);
  if (t) t.dead = true;
};
global.setTimeout = global.setTimeout;      // 真实 setTimeout 保留给用例自己用

/* ---------------------------------------------------------------- fetch 桩 */
let market = { open: false, phase: "closed", label: "休市", nextChangeEt: null };
/** 后端此刻**手上**那份快照（/api/status 与 /api/movers 一起给）。
 *  basis 只有两种：night_live（夜盘进行中，实时）/ night_close（夜盘已收盘，冻结）。 */
let held = { basis: "night_close", sessionDate: "2026-09-22", inSession: false,
             current: true, closeCst: "09月22日 16:00" };
const calls = [];
function jsonRes(obj) { return Promise.resolve({ ok: true, json: () => Promise.resolve(obj) }); }
global.fetch = function (url) {
  calls.push(url);
  if (url === "/api/status") return jsonRes({ ok: true, market, snapshot: held });
  if (url === "/api/movers" || url === "/api/refresh") {
    return jsonRes({
      ok: true,
      meta: { market, snapshot: held, criteria: {}, fetchedAtEt: "2026-09-22 10:15:26",
              source: "test", refreshSeconds: 60 },
      tables: {}, counts: {}, excluded: []
    });
  }
  return jsonRes({});
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
function checkTrue(label, ok, extra) {
  if (!ok) fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : "   (" + extra + ")"}`);
}
function section(t) { console.log("\n" + t); }
const tick = () => new Promise(r => setTimeout(r, 30));
const countOf = u => calls.filter(x => x === u).length;
const snapBadge = () => (els["snapshotLabel"] ? els["snapshotLabel"].textContent : "?");
const noticeText = () => (els["notice"] ? els["notice"].innerHTML : "");
/** 触发那一次低频状态检查（真实代码里由 setInterval 每 5 分钟调） */
function runStatusCheck() {
  const t = timers.filter(x => !x.dead && x.kind === "interval");
  if (!t.length) throw new Error("没有在跑的状态定时器");
  t.forEach(x => x.fn());
}

(async function main() {

  section("1. 进页面：取一次数据，只建一个心跳定时器，**没有任何取数定时器**");
  Shell.mount({ navKey: "evening", title: "夜盘异动", onData: function () {} });
  await tick();
  check("首屏取了一次数据（否则页面空白）", countOf("/api/movers"), 1);
  check("在跑的定时器数量（只该有心跳那一个）", timers.filter(x => !x.dead).length, 1);
  check("它的间隔是 60 秒（夜盘要实时，心跳比原来密）", timers[0].ms, 60000);
  check("没有 paused / nextFetchAt 这类轮询遗留状态", typeof Shell.state.paused, "undefined");

  section("2. 夜盘已收盘：连查三次心跳，一个数据请求都不多发");
  const before = countOf("/api/movers");
  runStatusCheck(); await tick();
  runStatusCheck(); await tick();
  runStatusCheck(); await tick();
  check("心跳查了至少三次", countOf("/api/status") >= 3, true);
  check("行情一次都没再取（场外这份是冻结的）", countOf("/api/movers") - before, 0);

  section("3. 场外的徽章与提示，说清「这份是夜盘收盘」");
  check("徽章文案", snapBadge(), "夜盘 9月22日 收盘");
  check("提示里写明是「最近一次夜盘收盘」", /最近一次夜盘收盘/.test(noticeText()), true);
  check("提示里写明下一场夜盘开始前不会变", /不会变/.test(noticeText()), true);
  check("提示里写明与白天看到的涨跌幅无关", /无关/.test(noticeText()), true);

  section("4. 换了场次（9/23 的收盘）→ 心跳发现并取一次");
  market = { open: false, phase: "closed", label: "休市", nextChangeEt: null };
  held = { basis: "night_close", sessionDate: "2026-09-23", inSession: false,
           current: true, closeCst: "09月23日 16:00" };
  const before2 = countOf("/api/movers");
  runStatusCheck(); await tick();
  check("取了一次新场次的快照", countOf("/api/movers") - before2, 1);
  check("徽章跟着变成新场次", snapBadge(), "夜盘 9月23日 收盘");

  section("5. 同一场次的收盘反复来 → 不再重复取");
  const before3 = countOf("/api/movers");
  runStatusCheck(); await tick();
  runStatusCheck(); await tick();
  check("没有重复取数", countOf("/api/movers") - before3, 0);

  section("6. ⚠️ 夜盘**进行中** → 每次心跳都要取（本轮最关键的回归点）");
  /* 这里最容易写错：场内 basis 与 sessionDate 都不变，若还按"快照身份变没变"
     判断，身份永远不变 → 页面冻在进页面那一刻。表现是"数字看着正常，只是不动"。 */
  market = { open: true, phase: "night", label: "夜盘（开市中）", nextChangeEt: null };
  held = { basis: "night_live", sessionDate: "2026-09-23", inSession: true,
           current: true, closeCst: "09月23日 16:00" };
  const before4 = countOf("/api/movers");
  runStatusCheck(); await tick();
  runStatusCheck(); await tick();
  check("两次心跳取了两次（实时）", countOf("/api/movers") - before4, 2);
  check("徽章标明是实时", snapBadge(), "夜盘 9月23日 实时");
  check("提示里写明夜盘开市中、会持续刷新", /夜盘开市中/.test(noticeText()), true);

  section("7. 场内 → 刚收盘：冻结那一份只取一次，之后停手");
  held = { basis: "night_close", sessionDate: "2026-09-23", inSession: false,
           current: true, closeCst: "09月23日 16:00" };
  const before5 = countOf("/api/movers");
  runStatusCheck(); await tick();
  check("收盘后取了最后一次（把收盘价冻住）", countOf("/api/movers") - before5, 1);
  const before6 = countOf("/api/movers");
  runStatusCheck(); await tick();
  runStatusCheck(); await tick();
  check("之后不再取", countOf("/api/movers") - before6, 0);

  section("8. 页头不再有「暂停自动」与倒计时（已经没有自动可取暂停）");
  check("btnPause 未被创建", els["btnPause"], undefined);
  check("countdown 未被创建", els["countdown"], undefined);
  check("页头里有「数据」徽章", els["pageHeader"].innerHTML.indexOf('id="snapshotLabel"') >= 0, true);

  section("9. 「立即刷新」仅在**夜盘进行中**可用；可用时走 /api/refresh");
  held = { basis: "night_live", sessionDate: "2026-09-23", inSession: true,
           current: true, closeCst: "09月23日 16:00" };
  runStatusCheck(); await tick();
  check("场内 → 按钮可用", els["btnRefresh"].disabled, false);
  const before7 = countOf("/api/refresh");
  els["btnRefresh"].fire("click");
  await tick();
  check("触发了一次强制取数", countOf("/api/refresh") - before7, 1);
  check("手动刷新不会顺带把定时器搞乱", timers.filter(x => !x.dead).length, 1);

  section("10. 手上那份不是最新一场 → 提示必须说出来（别让人当成最新的）");
  held = { basis: "night_close", sessionDate: "2026-09-18", inSession: false,
           current: false, closeCst: "09月18日 16:00" };
  runStatusCheck(); await tick();
  check("提示里点了出来", /不是最新一场/.test(noticeText()), true);

  section("11. ⚠️ 非夜盘时间「立即刷新」必须置灰（本轮改动核心）");
  /* 场外这一页显示的是**冻结的收盘快照**，刷新拿不到新东西 —— 按钮亮着会让人
     以为"点一下有新数据"，点完数字纹丝不动，反过来怀疑是坏了。 */
  held = { basis: "night_close", sessionDate: "2026-09-23", inSession: false,
           current: true, closeCst: "09月23日 16:00" };
  runStatusCheck(); await tick();
  check("场外 → 按钮禁用", els["btnRefresh"].disabled, true);
  check("悬停提示说清原因（别只灰着，要能问出为什么）",
    /夜盘已收盘/.test(String(els["btnRefresh"].title)), true);

  const before8 = countOf("/api/refresh");
  els["btnRefresh"].fire("click");
  await tick();
  /* 浏览器本就不会给 disabled 的按钮派发 click，这条断言防的是**另一种错位**：
     属性/样式没生效但按钮其实还能点 —— 用户看到的是灰按钮，却真的刷新了。 */
  check("置灰时点击不发请求", countOf("/api/refresh") - before8, 0);

  /* 心跳必须能自动点亮/灰掉：夜盘 08:00 开始、16:00 收盘，
     不该让用户"自己知道要重开页面"。 */
  held = { basis: "night_live", sessionDate: "2026-09-23", inSession: true,
           current: true, closeCst: "09月23日 16:00" };
  runStatusCheck(); await tick();
  check("心跳发现进入夜盘 → 自动点亮", els["btnRefresh"].disabled, false);

  held = { basis: "night_close", sessionDate: "2026-09-23", inSession: false,
           current: true, closeCst: "09月23日 16:00" };
  runStatusCheck(); await tick();
  check("心跳发现夜盘收盘 → 自动灰掉", els["btnRefresh"].disabled, true);

  section("12. 状态未知时**不许锁死**（探测失败不能连手动入口一起没）");
  /* 判据刻意是 `inSession !== false` 而不是 `=== true`：/api/status 抽风时状态未知，
     这时候把唯一的手动入口也锁死，就真的没有任何补救手段了 ——
     宁可让人多试一次，也不要"因为探测失败所以彻底锁死"。 */
  held = { basis: "night_close", sessionDate: "2026-09-23", closeCst: "09月23日 16:00" };
  runStatusCheck(); await tick();
  check("inSession 缺失 → 按钮仍可用", els["btnRefresh"].disabled, false);

  section("13. 置灰还要在**样式层**真的灰掉（属性对了但样子没变，用户照样以为能点）");
  /* 光设 `disabled` 是不够的：`.primary` 的蓝底还在的话，按钮看着仍是那个醒目的蓝按钮，
     只是点不动 —— 反而更像"坏了"。这几条盯住样式真的盖住了。 */
  const css = fs.readFileSync(ROOT + "static/style.css", "utf8");
  const at = css.indexOf("button:disabled");
  checkTrue("CSS 里有 button:disabled 规则", at >= 0, "没找到");

  const blk = css.slice(at, css.indexOf("}", at) + 1);
  checkTrue("规则里改了背景色（只写 cursor 不算灰）", /background/.test(blk), blk);
  checkTrue("规则里改了文字色（否则灰底浅字几乎看不见）", /color:/.test(blk), blk);
  checkTrue("光标写成 not-allowed", /not-allowed/.test(blk), blk);
  /* .primary 是蓝底白字，优先级和 button:disabled 一样（都是 0-1-1）——
     不专门为它写更高优先级的选择器，同优先级下先写的会被后写的盖掉，
     结果就是"只有非 primary 按钮灰了，蓝的那个没灰"。 */
  checkTrue("专门压掉了 primary 的蓝底（否则它仍是蓝的，只是点不动）",
    /button\.primary:disabled/.test(css), "缺 button.primary:disabled");
  /* button:hover 会改描边，不压掉的话鼠标划过灰按钮会"亮"一下，又像可点的。 */
  checkTrue("压掉了 hover 态（不然划过会亮一下）",
    /button:disabled:hover/.test(css), "缺 button:disabled:hover");

  console.log(fail === 0 ? "\n全部通过 \u2713" : `\n${fail} 项未通过 \u2717`);
  process.exit(fail === 0 ? 0 : 1);
})();
