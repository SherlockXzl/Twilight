/* 早盘「个人关注池」输入建议下拉（suggest.js）用例
 *
 *   用法：node tools/test_suggest.js      （退出码 0 = 全通过）
 *
 * 为什么需要这个用例
 * ------------------
 * 这个组件全是**时序**和**事件顺序**上的坑，全都不会报错、只在特定操作下表现异常：
 *
 *   1. **竞态**：连着打三个字母发三次请求，若慢的那次后回来，列表会显示上一个词的
 *      结果 —— 而它是"合法"的列表，看不出错，只是不对。
 *   2. **回车不该自动吃下第一条建议**：用户打「NVD」按回车是想加 NVD，
 *      若默认高亮第一条（NVDA），会静默加错一只票，而且看起来"成功了"。
 *   3. **点选必须用 mousedown**：用 click 的话，输入框会先 blur、弹层先关，
 *      点在空气上 —— 表现是"点了没反应"。
 *   4. **组件重挂**：同一输入框挂两次会有两份监听，一次回车加两只。
 *
 * 做法：最小 DOM 桩（含 createElement / appendChild / closest），
 * 桩化 source 返回可控的 Promise，手动推进微任务队列。
 */

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..") + "/";

/* ------------------------------------------------------------------ DOM 桩 */
const els = [];
function mk(id) {
  return {
    id: id || "", tagName: "", innerHTML: "", textContent: "", value: "", hidden: false,
    parentNode: null, children: [], style: {}, _h: {}, _q: {},
    className: "",
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(t, f) { (this._h[t] = this._h[t] || []).push(f); },
    removeEventListener(t, f) {
      if (this._h[t]) this._h[t] = this._h[t].filter(x => x !== f);
    },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; return c; },
    setAttribute(k, v) { this["_a_" + k] = v; },
    getAttribute(k) { return this["_a_" + k]; },
    contains(t) {
      if (t === this) return true;
      return this.children.some(c => c.contains && c.contains(t));
    },
    focus() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    fire(t, ev) { (this._h[t] || []).slice().forEach(f => f.call(this, ev || {})); }
  };
}

const doc = {
  _h: {},
  addEventListener(t, f) { (this._h[t] = this._h[t] || []).push(f); },
  removeEventListener(t, f) { if (this._h[t]) this._h[t] = this._h[t].filter(x => x !== f); },
  createElement(tag) { const e = mk(""); e.tagName = tag.toUpperCase(); els.push(e); return e; },
  getElementById() { return null; }
};
global.window = global;
global.document = doc;

eval(fs.readFileSync(ROOT + "static/suggest.js", "utf8"));

/* ------------------------------------------------------------------ 断言 */
let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  if (ok) { pass++; console.log(`  ✓ ${label}: ${got}`); }
  else { fail++; console.log(`  ✗ ${label}: ${got}   (期望 ${want})`); }
}
function section(t) { console.log("\n" + t); }
const tick = (n) => {
  let p = Promise.resolve();
  for (let i = 0; i < (n || 6); i++) p = p.then(() => new Promise(r => setTimeout(r, 0)));
  return p;
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/** 造一个可控的 source：记下每次查询，并允许手动决定何时 resolve 哪一个 */
function mkSource() {
  const calls = [];
  const src = function (q) {
    return new Promise(function (resolve) {
      calls.push({ q: q, resolve: resolve });
    });
  };
  src.calls = calls;
  return src;
}
function item(sym, name, etf) { return { symbol: sym, name: name || sym + " Inc", etf: !!etf }; }

/** 造一个挂好组件的输入框 */
function setup(opts) {
  const host = mk("sug");
  const input = mk("in");
  input.id = "in" + (setup._n = (setup._n || 0) + 1);       // 每次新 id，避免组件登记表串场
  host.appendChild(input);
  const picked = [], submitted = [];
  const src = mkSource();
  const api = Suggest.create(input, Object.assign({
    source: src,
    onPick: (it) => picked.push(it.symbol),
    onSubmit: (t) => submitted.push(t),
    debounceMs: 0
  }, opts || {}));
  return { host, input, api, picked, submitted, src };
}
/** 模拟用户在输入框里打字 */
function type(input, v, fireInput) {
  input.value = v;
  if (fireInput !== false) input.fire("input", {});
}
function key(input, k) {
  const ev = { key: k, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  input.fire("keydown", ev);
  return ev;
}
/** 列表里点第 i 项（走 mousedown 委托） */
function clickItem(api, i) {
  const el = mk("");
  el.setAttribute("data-i", String(i));
  el.closest = (sel) => (sel === ".sug-i" ? el : null);
  const ev = { target: el, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  api.pop.fire("mousedown", ev);
  return ev;
}

/* ================================================================ 用例 */

(async function run() {

  section("1. 打字才查：一个字都没打就不发请求");
  let s = setup();
  check("初始是关的", s.api.isOpen(), false);
  check("没有请求", s.src.calls.length, 0);

  section("2. 打了就查，返回后弹层打开、按后端给的顺序展示");
  type(s.input, "aapl");
  await wait(5);
  check("发出了查询", s.src.calls.map(c => c.q).join(","), "aapl");
  s.src.calls[0].resolve([item("AAPL", "Apple Inc."), item("AAPW", "Roundhill AAPL ETF", true)]);
  await tick();
  check("弹层打开", s.api.isOpen(), true);
  check("条数", s.api.items().length, 2);
  check("顺序按后端返回（不在前端重排）", s.api.items().map(i => i.symbol).join(","), "AAPL,AAPW");
  check("列表渲染出了代码", /sug-code">AAPL</.test(s.api.pop.innerHTML), "true");
  check("ETF 带标签", /sug-tag">ETF</.test(s.api.pop.innerHTML), "true");

  section("3. 默认**不高亮**任何一条（回车不会静默吃下第一条建议）");
  check("高亮 = -1", s.api.highlight(), -1);

  section("4. 回车：没有任何高亮时提交输入框原文，不选中建议");
  s = setup();
  type(s.input, "NVD");
  await wait(5);
  s.src.calls[0].resolve([item("NVDA", "NVIDIA Corporation"), item("NVDW")]);
  await tick();
  const ev = key(s.input, "Enter");
  check("提交的是原文 NVD", s.submitted.join(","), "NVD");
  check("没有误选第一条", s.picked.length, 0);
  check("阻止了默认行为", ev.defaultPrevented, true);
  check("顺手关窗", s.api.isOpen(), false);

  section("5. ↓ 高亮第一条，再回车才选中它");
  s = setup();
  type(s.input, "NVD");
  await wait(5);
  s.src.calls[0].resolve([item("NVDA"), item("NVDW")]);
  await tick();
  key(s.input, "ArrowDown");
  check("高亮到 0", s.api.highlight(), 0);
  check("渲染里带 hi 类", /class="sug-i hi"/.test(s.api.pop.innerHTML), "true");
  key(s.input, "Enter");
  check("选中了 NVDA", s.picked.join(","), "NVDA");
  check("没有走提交原文那条路", s.submitted.length, 0);

  section("6. ↑↓ 边界：不能越界，也能退回「无高亮」");
  s = setup();
  type(s.input, "a");
  await wait(5);
  s.src.calls[0].resolve([item("A"), item("AA"), item("AAA")]);
  await tick();
  key(s.input, "ArrowUp");
  check("在 -1 上按 ↑ 仍是 -1", s.api.highlight(), -1);
  for (let i = 0; i < 5; i++) key(s.input, "ArrowDown");
  check("一直按 ↓ 停在最后一条", s.api.highlight(), 2);
  for (let i = 0; i < 5; i++) key(s.input, "ArrowUp");
  check("一直按 ↑ 回到 -1（不是 0）", s.api.highlight(), -1);

  section("7. 点选走 mousedown，并且阻止失焦");
  s = setup();
  type(s.input, "aapl");
  await wait(5);
  s.src.calls[0].resolve([item("AAPL"), item("AAPW")]);
  await tick();
  const mev = clickItem(s.api, 1);
  check("选中第二项", s.picked.join(","), "AAPW");
  check("阻止了默认（避免输入框先失焦）", mev.defaultPrevented, true);
  check("选完关窗", s.api.isOpen(), false);

  section("8. 竞态：先发的慢响应不能覆盖后发的快响应");
  s = setup();
  type(s.input, "aa");
  await wait(5);
  type(s.input, "aapl");                    // 第二个查询
  await wait(5);
  check("两次请求都发出去了", s.src.calls.map(c => c.q).join(","), "aa,aapl");
  s.src.calls[1].resolve([item("AAPL")]);   // 后发的先回
  await tick();
  s.src.calls[0].resolve([item("AA"), item("AAC"), item("AAL")]);   // 先发的后回
  await tick();
  check("列表是 aapl 的结果，不是 aa 的", s.api.items().map(i => i.symbol).join(","), "AAPL");

  section("9. 查询期间继续打字，旧结果作废（同一次竞态的另一种时序）");
  s = setup();
  type(s.input, "app");
  await wait(5);
  type(s.input, "appl");
  await wait(5);
  s.src.calls[0].resolve([item("APP"), item("APPF")]);   // 旧的后回
  await tick();
  check("旧结果被丢弃", s.api.items().length, 0);
  s.src.calls[1].resolve([item("AAPL")]);
  await tick();
  check("新结果生效", s.api.items().map(i => i.symbol).join(","), "AAPL");

  section("10. 清空输入 → 关窗，且不显示「没有匹配」的空列表");
  s = setup();
  type(s.input, "aapl");
  await wait(5);
  s.src.calls[0].resolve([item("AAPL")]);
  await tick();
  check("先开着", s.api.isOpen(), true);
  type(s.input, "");
  await wait(5);
  check("清空就关", s.api.isOpen(), false);

  section("11. 查不到 → 给出明确文案，而不是空白弹层");
  s = setup();
  type(s.input, "zzzzzz");
  await wait(5);
  s.src.calls[0].resolve([]);
  await tick();
  check("弹层开着", s.api.isOpen(), true);
  check("有「没有匹配的代码」文案", /没有匹配的代码/.test(s.api.pop.innerHTML), "true");
  check("没有可选项", s.api.items().length, 0);
  key(s.input, "Enter");
  check("此时回车仍然是提交原文", s.submitted.join(","), "zzzzzz");

  section("12. 数据源报错 → 静默关窗，不打断打字");
  s = setup();
  type(s.input, "aapl");
  await wait(5);
  s.src.calls[0].resolve(Promise.reject(new Error("网络断了")));
  await tick();
  check("关窗", s.api.isOpen(), false);
  check("没有抛出到外面", s.api.items().length, 0);

  section("13. Esc 关窗");
  s = setup();
  type(s.input, "aapl");
  await wait(5);
  s.src.calls[0].resolve([item("AAPL")]);
  await tick();
  key(s.input, "Escape");
  check("关了", s.api.isOpen(), false);

  section("14. 同一输入框重挂：旧监听必须拆掉（否则一次回车加两只）");
  s = setup();
  const before = s.input._h.keydown.length;
  check("第一次挂载后有监听", before, 1);
  const api2 = Suggest.create(s.input, {
    source: mkSource(), onPick: function () {}, onSubmit: function () {}, debounceMs: 0
  });
  check("重挂后仍只有一个 keydown 监听", s.input._h.keydown.length, 1);
  check("登记表里换成了新实例", Suggest.get(s.input.id) === api2, true);

  section("15. ← ↓ 在空列表上按键不炸");
  s = setup();
  check("没查过就按 ↓", (key(s.input, "ArrowDown"), s.api.highlight()), -1);
  check("没查过就按 ↑", (key(s.input, "ArrowUp"), s.api.highlight()), -1);
  check("没查过就按回车（提交空串）", (key(s.input, "Enter"), s.submitted.length), 1);

  console.log("");
  if (fail === 0) { console.log(`全部通过 ✓  (${pass} 项断言)`); process.exit(0); }
  console.log(`有失败项 ✗  (${fail} 项失败 / ${pass + fail} 项)`);
  process.exit(1);
})();
