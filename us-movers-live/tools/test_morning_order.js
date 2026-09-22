/* 早盘总结页的**排序**用例：个股异动榜按涨跌幅降序、个人关注池按股票代码字母序
 *
 *   用法：node tools/test_morning_order.js      （退出码 0 = 全通过）
 *
 * 为什么需要这个用例
 * ------------------
 * 排序改错了**永远不会报错**：表格照常渲染、数字都对，只是顺序不对 ——
 * 而顺序恰恰是这张表的主要信息（"今天最猛的是谁"）。并且这类错误有个隐蔽之处：
 *
 *   1. 异动榜原先的规则是「巨头优先，其次按涨幅降序」。它和"纯涨幅降序"在前几名
 *      **长得一模一样**（涨得最猛的多半就是巨头），只看截图发现不了 ——
 *      要构造"巨头涨得少、常规票涨得多"的数据才能把两者分开。
 *   2. 排序在两处（生成脚本 + 渲染层）都做了。渲染层这份是页面实际吃到的，
 *      测试必须打在渲染层上，否则"生成脚本改对了、页面没改"照样漏。
 *   3. 关注池的排序基准写错（比如仍按 chgPct）时，只要当天的关注池恰好是按代码
 *      命中的顺序，看起来也是对的 —— 必须喂**乱序**输入才验得出来。
 *
 * 做法与其它用例一致：最小 DOM 桩 + 合成数据，不依赖实时行情与真实 JSON。
 */

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..") + "/";

/* ------------------------------------------------------------------ DOM 桩 */
const els = {};

function mkClassList() {
  const set = {};
  return {
    add(c) { set[c] = true; }, remove(c) { delete set[c]; },
    toggle(c, force) {
      const on = force === undefined ? !set[c] : !!force;
      if (on) set[c] = true; else delete set[c];
      return on;
    },
    contains(c) { return !!set[c]; }
  };
}

function mk(id) {
  return {
    id, innerHTML: "", textContent: "", value: "", hidden: false, style: {}, _q: {},
    classList: mkClassList(), _h: {},
    addEventListener(t, f) { this._h[t] = f; },
    setAttribute(k, v) { this["_a_" + k] = v; },
    getAttribute(k) { return this["_a_" + k]; },
    contains() { return false; }, focus() {},
    querySelector(sel) { return this._q[sel] || (this._q[sel] = mk(id + sel)); },
    querySelectorAll() { return []; },
    fire(t, ev) { if (this._h[t]) return this._h[t].call(this, ev || {}); }
  };
}

/* 分档 chip 容器：本用例不测分档，但 morning.js 渲染时会写到它，得给个能接住的对象 */
const BTN = {};
const bandBox = mk("mvBands");
(function () {
  let html = "";
  Object.defineProperty(bandBox, "innerHTML", {
    get() { return html; },
    set(v) {
      html = String(v);
      for (const k in BTN) delete BTN[k];
      (html.match(/data-band="([^"]+)"/g) || []).forEach(function (s) {
        const el = mk("band:" + s.slice(11, -1));
        const key = s.slice(11, -1);
        el.getAttribute = a => (a === "data-band" ? key : undefined);
        BTN[key] = el;
      });
    },
    configurable: true
  });
  bandBox.querySelectorAll = function () { return Object.keys(BTN).map(k => BTN[k]); };
})();

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

/* 关注池的方块现在渲染进独立的 #wlHost（增删功能要单独重绘它，不能连工具条一起重建）。
   本用例只关心顺序，所以给一个能接住 innerHTML 的普通桩即可。 */
const wlHost = mk("wlHost");
els.wlHost = wlHost;

global.window = global;
global.document = {
  getElementById(id) { return els[id] || (els[id] = mk(id)); },
  addEventListener() {}, title: ""
};
global.fetch = () => Promise.resolve({ json: () => Promise.resolve({}) });
global.scrollTo = function () {};

let cap = null;
global.Shell = {
  state: {},
  mount(o) { cap = o; },
  syncCountdown() {},
  criteriaValues() { return { bigMinCap: 1e10, midMinCap: 1.5e9 }; }
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

/* ------------------------------------------------------------------ 读取 */
const YI = 1e8;

/** 异动榜当前显示顺序 */
function mvOrder() {
  return (els.mvTableHost.innerHTML.match(/<td class="code">([^<]+)<\/td>/g) || [])
    .map(s => s.replace(/^<td class="code">|<\/td>$/g, "")).join(",");
}
/** 关注池每个方块：按 <div class="tile"> 切开取，不用带前瞻的正则 ——
 *  最后一个方块后面接的是容器闭合标签，前瞻式写法会把它漏掉。
 *  注意读的是 #wlHost（关注池方块自己的宿主），不是 morningHost。 */
function wlTiles() {
  return wlHost.innerHTML.split('<div class="tile">').slice(1);
}
/** 关注池当前显示顺序（按方块里的 tile-code） */
function wlOrder() {
  return wlTiles()
    .map(b => (b.match(/<span class="tile-code">([^<]+)<\/span>/) || [])[1]).join(",");
}
/** 关注池每格的振幅条宽度，形如 "AAA:100,BBB:10" */
function wlBars() {
  return wlTiles().map(function (b) {
    const c = (b.match(/<span class="tile-code">([^<]+)<\/span>/) || [])[1];
    const w = (b.match(/style="width:(\d+)%"/) || [])[1];
    return c + ":" + w;
  }).join(",");
}

function mv(sym, chg, capYi, giant) {
  return {
    symbol: sym, name: sym + " Inc", price: 10, chg: chg,
    marketCap: capYi * YI, sector: "信息技术", industry: "半导体",
    sectorEn: "Technology", industryEn: "Semiconductors",
    giant: !!giant, driver: "—"
  };
}
function wl(code, chgPct) {
  return { code: "us" + code, name: code + " 公司", close: 10, chgPct: chgPct, capYi: 100, keyword: "—" };
}

function feed(movers, watchlist) {
  const d = { ok: true, movers: movers || [], watchlist: watchlist || [],
              indices: [], themes: [], linkage: [], aShareHints: [] };
  global.Shell.state.data = d;
  cap.onData(d);
  return d;
}

/** 点某个分档 chip（本用例只在第 5 节用，用来确认"筛选后仍保持降序"） */
function clickBand(k) {
  if (!BTN[k]) throw new Error("找不到分档按钮：" + k);
  BTN[k].fire("click");
}

/* ================================================================ 用例 */

section("1. 个股异动榜：按涨跌幅从大到小");
feed([mv("LOW", 4.5, 20), mv("HIGH", 18.2, 20), mv("MID", 9.9, 20), mv("TOP", 25.4, 20)]);
check("输入乱序 → 输出降序", mvOrder(), "TOP,HIGH,MID,LOW");

section("2. 不再「巨头优先」—— 巨头涨得少也要排在后面（本次的核心回归点）");
/* 这段数据是关键：一只涨 4.2% 的巨头 + 一只涨 12% 的常规票。
   旧的 (not giant, -chg) 规则会把巨头 CLOUD 排到 PROTO 前面；纯涨幅降序则相反。
   前几名的截图上两种规则看不出差别，必须这样构造才验得出来。 */
feed([mv("CLOUD", 4.2, 5000, true), mv("PROTO", 12.0, 30, false), mv("MIDCAP", 7.0, 200, true)]);
check("涨 4.2% 的巨头排在涨 12% 的常规票之后", mvOrder(), "PROTO,MIDCAP,CLOUD");

section("3. 并列涨跌幅 → 按代码升序，顺序稳定可复现");
feed([mv("ZZZ", 8.0, 20), mv("AAA", 8.0, 20), mv("MMM", 8.0, 20)]);
check("三个 8.00% 按代码升序", mvOrder(), "AAA,MMM,ZZZ");

section("4. 缺涨跌幅的行垫底，不插到中间（也不能变成 NaN 让整段顺序崩掉）");
feed([mv("NODATA", null, 20), mv("SMALL", 1.0, 20), mv("BIG", 15.0, 20)]);
check("NaN 垫底", mvOrder(), "BIG,SMALL,NODATA");

section("5. 分档筛选之后仍然保持降序");
/* 大市值 = 市值 ≥ 100 亿美元，所以只有 BIGA / BIGB / BIGC 进得了那一档；
   SMALLCAP 是 30 亿，只出现在「所有」里。 */
feed([mv("SMALLCAP", 22.0, 30), mv("BIGA", 5.0, 200), mv("BIGB", 19.0, 300), mv("BIGC", 11.0, 150)]);
clickBand("big");
check("大市值档内仍是降序（SMALLCAP 被筛掉）", mvOrder(), "BIGB,BIGC,BIGA");
clickBand("all");
check("回到「所有」也是降序", mvOrder(), "SMALLCAP,BIGB,BIGC,BIGA");

section("6. 个人关注池：按股票代码字母序（喂乱序，防「恰好是对的」）");
feed([], [wl("NVDA", 2.3), wl("AMD", 9.95), wl("AXTI", 14.14), wl("MRVL", 5.38), wl("INTC", 12.14)]);
check("乱序输入 → 代码升序输出", wlOrder(), "AMD,AXTI,INTC,MRVL,NVDA");

section("7. 关注池里涨跌混杂时也按代码排（不按涨跌幅、不按正负分组）");
feed([], [wl("ZZZ", -3.0), wl("AAA", 1.0), wl("MMM", -0.5), wl("BBB", 8.0)]);
check("跌的也在自己代码的位置上", wlOrder(), "AAA,BBB,MMM,ZZZ");

section("8. 换排序不改振幅条：最长的一根仍属于 |涨跌幅| 最大的那只");
/* 数据要挑得**故意不巧**：按代码排完序后，第一根（AAA）必须是绝对值最小的那只。
   早先用的是 [CCC +5, AAA −20, BBB +2]，排序后第一根恰好就是最大值（−20），
   于是"基准取排序后第一根"这个错误写法算出来的结果和正确写法一模一样，用例看不出问题
   （变异测试发现的）。现在最大的是 BBB（排在中间），两种写法必然算出不同结果。 */
feed([], [wl("AAA", 2.0), wl("BBB", -20.0), wl("CCC", 5.0)]);
check("按代码排", wlOrder(), "AAA,BBB,CCC");
check("基准取全量 |−20|，不是排序后的第一根 |+2|", wlBars(), "AAA:10,BBB:100,CCC:25");

section("9. 排序不就地改动传入的数组（面板重建时读的是同一份数据）");
{
  const original = [mv("X", 3.0, 20), mv("Y", 9.0, 20)];
  const d = feed(original, []);
  check("data().movers 顺序未被写回", d.movers.map(r => r.symbol).join(","), "X,Y");
  check("页面上是降序", mvOrder(), "Y,X");
}

console.log("");
if (fail === 0) { console.log(`全部通过 ✓  (${pass} 项断言)`); process.exit(0); }
console.log(`有失败项 ✗  (${fail} 项失败 / ${pass + fail} 项)`);
process.exit(1);
