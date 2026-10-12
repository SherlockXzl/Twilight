/* 期股双面 · 区间口径用例

   用法：node tools/test_duality.js      （退出码 0 = 全通过）

这一页最容易悄悄坏掉的地方是**区间与基准**，而且坏了页面照样长得像对的：
折线画得出来、数字有两位小数、涨跌幅红绿也对 —— 只是基准取错了日期，
整条线整体平移了一个交易日的幅度。肉眼看不出来，但结论全错。

所以这里钉死三件事：

  1. **区间边界**。「过去 7 天」= 含今天在内的 7 个自然日（不是 7 个交易日）。
     差一天就会把长假前那一天算进来或漏掉，图上的形状跟着变。
  2. **0% 基准取「区间开始前的最后一个交易日」**，不是"区间内第一根"——
     各标的的区间首日未必是同一天（中美假期不同），各拿各的首日当基准，
     各条线的起点就对不齐了，而那正是这一页要横向对比的东西。
  3. **缺数据的标的不造假**。A 股国庆休市时，「过去 7 天」里可能只有一根 K 线，
     那就只画一个点、并在卡片上照常显示它的区间涨跌幅（基于更早的基准），
     而不是补一个"当天没交易却假装有"的价格。

另外两处**跨文件的一致性**也一并钉住（这类错配不会报错，只会让页面显示成
「没有数据」或点了没反应）：
  · duality.js 的 DUALITY_SCHEMA ↔ server.py 的 DUALITY_SCHEMA
  · shell.js 里「期股双面」挂在「明暗对照」之后、且路由已在 PAGE_ROUTES 登记
*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.resolve(__dirname, "..") + "/";

/* ------------------------------------------------------------------ DOM 桩 */
/* 只求"加载不报错"。让 document.readyState 停在 "loading" —— duality.js 那时
   只会挂一个 DOMContentLoaded 监听，不会真的 mount，省掉一整套 UI 桩。 */
global.window = global;
global.document = {
  readyState: "loading",
  addEventListener() {},
  getElementById() { return null; },
  createElement() { return {}; },
  title: ""
};

vm.runInThisContext(fs.readFileSync(ROOT + "static/util.js", "utf8"),
  { filename: "util.js" });
global.Shell = { mount() {}, state: {} };          // 壳在这条路径上用不到，给了就行
vm.runInThisContext(fs.readFileSync(ROOT + "static/duality.js", "utf8"),
  { filename: "duality.js" });

const D = global.Duality;
const S = D.state;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; console.log("  \x1b[31m✗\x1b[0m " + name + (extra !== undefined ? "  → " + extra : "")); }
}
function near(a, b, eps) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return Math.abs(a - b) <= (eps === undefined ? 1e-6 : eps);
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }

/* ------------------------------------------------------------------ 数据 */
/* 「今天」由 payload.generatedAt 决定（页面就是这么取的 —— 不信任浏览器时钟）。
   2026-10-08 是国庆假期后的第一个交易日，这个日期是刻意挑的：
   A 股在 10-01 ~ 10-07 全部休市，正好压到"过去 7 天只有一个点"这个边界。 */
const TODAY = "2026-10-08";
S.payload = { generatedAt: TODAY + " 14:30:00", schema: D.SCHEMA };

// 纽约金：CME 电子盘，中国假期照常交易
const GOLD = {
  key: "gold", name: "纽约金", kind: "future", unit: "美元/盎司",
  market: "COMEX", note: "COMEX 黄金期货主连", code: "GC00Y",
  dates: ["2026-09-24", "2026-09-25", "2026-09-28", "2026-09-29", "2026-09-30",
          "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07",
          "2026-10-08"],
  closes: [4100, 4120, 4110, 4150, 4180, 4170, 4160, 4190, 4200, 4180, 4210],
  chgs: [0.5, 0.49, -0.24, 0.97, 0.72, -0.24, -0.24, 0.72, 0.24, -0.48, 0.72]
};

// 紫金矿业：10-01 ~ 10-07 休市，最后一个交易日是 09-30
const ZIJIN = {
  key: "zijin", name: "紫金矿业", kind: "stock", unit: "元",
  market: "上交所", note: "601899 · 铜金矿龙头", code: "601899",
  dates: ["2026-09-24", "2026-09-25", "2026-09-28", "2026-09-29", "2026-09-30",
          "2026-10-08"],
  closes: [29.0, 29.5, 29.2, 29.8, 30.1, 29.6],
  chgs: [1.0, 1.72, -1.02, 2.05, 1.01, -1.66]
};

const CFGOLD = {
  key: "cfgold", name: "赤峰黄金", kind: "stock", unit: "元",
  market: "上交所", note: "600988 · 金矿弹性标的", code: "600988",
  dates: ["2026-09-30", "2026-10-08"],
  closes: [40.0, 42.0],
  chgs: [0.5, 5.0]
};

S.items = [GOLD, ZIJIN, CFGOLD];
S.picked = { gold: true, zijin: true, cfgold: true };

/* ============================================================ 1) 区间边界 */
section("区间边界（自然日，不是交易日）");

S.range = "7";
let b = D.bounds();
ok("过去 7 天 = 含今天的 7 个自然日", b.start === "2026-10-02" && b.end === "2026-10-08",
  b.start + " ~ " + b.end);

S.range = "30";
b = D.bounds();
ok("过去 30 天", b.start === "2026-09-09" && b.end === "2026-10-08", b.start + " ~ " + b.end);

S.range = "90";
b = D.bounds();
ok("过去 90 天", b.start === "2026-07-11" && b.end === "2026-10-08", b.start + " ~ " + b.end);

S.range = "180";
b = D.bounds();
ok("过去 180 天", b.start === "2026-04-12" && b.end === "2026-10-08", b.start + " ~ " + b.end);

S.range = "ytd";
b = D.bounds();
ok("今年至今 = 1 月 1 日起", b.start === "2026-01-01" && b.end === "2026-10-08",
  b.start + " ~ " + b.end);

S.range = "custom";
S.custom = { start: "2026-09-25", end: "2026-10-02" };
b = D.bounds();
ok("自定义区间原样生效", b.start === "2026-09-25" && b.end === "2026-10-02",
  b.start + " ~ " + b.end);

/* ============================================================ 2) 基准与涨跌幅 */
section("0% 基准 = 区间开始前的最后一个交易日");

S.range = "7";
let c = D.compute();
let gold = c.byKey.gold;
ok("纽约金：基准日取到区间外的前一根（10-01）", gold.baseDate === "2026-10-01", gold.baseDate);
ok("纽约金：区间内 5 根（10-02 起）", gold.pts.length === 5, gold.pts.length);
ok("纽约金：首点涨跌幅 = 4160/4170-1",
  near(gold.pts[0].pct, (4160 / 4170 - 1) * 100, 1e-9), gold.pts[0].pct);
ok("纽约金：区间涨跌幅 = 4210/4170-1",
  near(gold.rangePct, (4210 / 4170 - 1) * 100, 1e-9), gold.rangePct);
ok("纽约金：区间最高/最低是价格不是百分比",
  gold.hi === 4210 && gold.lo === 4160, gold.hi + "/" + gold.lo);

let zijin = c.byKey.zijin;
ok("紫金：基准日是长假前最后一天（09-30）", zijin.baseDate === "2026-09-30", zijin.baseDate);
ok("紫金：区间内只剩 1 根（10-08）", zijin.pts.length === 1, zijin.pts.length);
ok("紫金：单点也要有涨跌幅（29.6/30.1-1）",
  near(zijin.rangePct, (29.6 / 30.1 - 1) * 100, 1e-9), zijin.rangePct);

ok("图上只画勾选的标的，且顺序跟标的一致",
  c.list.length === 3 && c.list[0].it.key === "gold" && c.list[2].it.key === "cfgold",
  c.list.map(function (s) { return s.it.key; }).join(","));

/* ============================================================ 3) 勾选 */
section("勾选与取消");

S.picked.zijin = false;
c = D.compute();
ok("取消勾选后不进图", c.list.length === 2 &&
  c.list.every(function (s) { return s.it.key !== "zijin"; }));
ok("但 byKey 里它的区间涨跌幅仍在（卡片要显示）",
  c.byKey.zijin && near(c.byKey.zijin.rangePct, (29.6 / 30.1 - 1) * 100, 1e-9),
  c.byKey.zijin && c.byKey.zijin.rangePct);
ok("Y 轴范围只由图上这几条线决定（没勾的紫金 -1.66% 不该拉低下界）",
  near(c.hi, 5, 1e-9) && near(c.lo, (4160 / 4170 - 1) * 100, 1e-9),
  c.lo + " ~ " + c.hi);

S.picked.zijin = true;

/* 全部取消：不是报错，是画一块提示 —— 所以 anyPts 要为 false、list 为空 */
S.picked = { gold: false, zijin: false, cfgold: false };
c = D.compute();
ok("全部取消 → 不进图、anyPts 为 false", c.list.length === 0 && c.anyPts === false);
S.picked = { gold: true, zijin: true, cfgold: true };

/* ============================================================ 4) 区间不含任何数据 */
section("区间里没有任何交易日（例如区间早于全部数据）");

S.range = "custom";
S.custom = { start: "2020-01-01", end: "2020-01-31" };
c = D.compute();
ok("没有任何点 → anyPts 为 false（页面据此出提示，而不是画一张空图）",
  c.anyPts === false && c.list.every(function (s) { return s.pts.length === 0; }));

/* 区间晚于全部数据：基准拿不到比 start 更早的以外，还要保证不抛异常 */
S.custom = { start: "2027-01-01", end: "2027-02-01" };
c = D.compute();
ok("区间晚于全部数据时不抛异常、也不产生假点",
  c.anyPts === false && c.byKey.gold.pts.length === 0);

/* ============================================================ 5) 自定义起止颠倒 */
section("自定义区间：起止颠倒自动对调");

S.custom = { start: "2026-10-08", end: "2026-09-25" };
D.normalizeCustom();
ok("对调后 start < end",
  S.custom.start === "2026-09-25" && S.custom.end === "2026-10-08",
  S.custom.start + " ~ " + S.custom.end);

S.custom = { start: "2026-09-01", end: "2026-09-30" };
D.normalizeCustom();
ok("本来就正常的不动它",
  S.custom.start === "2026-09-01" && S.custom.end === "2026-09-30",
  S.custom.start + " ~ " + S.custom.end);

/* ============================================================ 6) 「今天」的取法 */
section("『今天』不取浏览器时钟");

S.range = "7";
S.custom = { start: "", end: "" };
/* 取数时间比数据晚（正常情况下两者同一天）；故意让它早一天，
   验的是"区间右边界不能把已经到手的最新一根关在外面" */
S.payload.generatedAt = "2026-10-07 09:00:00";
b = D.bounds();
ok("取数时间早于数据最后一天 → 右边界跟数据走（2026-10-08）",
  b.end === "2026-10-08", b.end);

/* 反过来：数据只到 10-07、取数时间是 10-08（例如源只更新到前一天），
   右边界应该取 10-08 —— 区间是"过去 7 天"，不是"数据覆盖的 7 天" */
S.items = [Object.assign({}, GOLD, {
  dates: GOLD.dates.slice(0, 10), closes: GOLD.closes.slice(0, 10), chgs: GOLD.chgs.slice(0, 10)
}), ZIJIN, CFGOLD];
S.payload.generatedAt = "2026-10-08 14:30:00";
b = D.bounds();
ok("取数时间晚于数据最后一天 → 右边界跟取数时间走（2026-10-08）",
  b.end === "2026-10-08", b.end);
S.items = [GOLD, ZIJIN, CFGOLD];

/* ============================================================ 7) 跨文件一致性 */
section("跨文件一致性（这几处对不上时页面不会报错，只会显示成『没数据』）");

const py = fs.readFileSync(ROOT + "server.py", "utf8");
const m = py.match(/^DUALITY_SCHEMA\s*=\s*(\d+)/m);
ok("server.py 有 DUALITY_SCHEMA", !!m);
ok("两端 schema 版本一致（服务端 " + (m ? m[1] : "?") + " ↔ 前端 " + D.SCHEMA + "）",
  !!m && Number(m[1]) === D.SCHEMA);
ok("PAGE_ROUTES 登记了 /duality",
  py.indexOf('"/duality": "/duality.html"') >= 0);
ok("do_GET 里接了 /api/duality",
  py.indexOf('path == "/api/duality"') >= 0);

const shell = fs.readFileSync(ROOT + "static/shell.js", "utf8");
const iLink = shell.indexOf('key: "linkage"');
const iDual = shell.indexOf('key: "duality"');
ok("菜单里有「期股双面」", iDual >= 0);
ok("且排在「明暗对照」之后", iLink >= 0 && iDual > iLink);
ok("页头有 duality 模式（否则页头拿不到取数时间徽章）",
  shell.indexOf('mode === "duality"') >= 0);

/* 下面这几条钉的是源码本身，而不是渲染结果。为什么必须这样：
   删按钮 / 删徽章最典型的失败不是"没删干净"，而是**删了 DOM、忘了删那次绑定** ——
   `$("dpReload").addEventListener(...)` 里 $() 返回 null，当场抛 TypeError，
   后面的初始化全被跳过（本项目在这上面踩过三次）。所以两头都要守。
   而断言"某段源码里没有 X"之前必须先**剔掉注释**：注释里写到这个词会让断言假失败
   （踩过：注释写了"不启动 statusTimer"，`indexOf < 0` 当场挂掉）。
   也**不要**用 `[\s\S]{0,N}` 这类魔法数字框范围 —— 注释一长（改文案很容易）
   窗口就兜不住、用例无声失效。改成先切片、再剔注释、再判。 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
}
const iDualBranch = shell.indexOf('mode === "duality"');
const dualBranch = stripComments(shell.slice(iDualBranch, shell.indexOf("} else {", iDualBranch)));
ok("duality 页头保留了「取数时间」徽章", dualBranch.indexOf('id="duTime"') >= 0);
ok("duality 页头不再有「数据截止」徽章", dualBranch.indexOf("duLatest") < 0);
ok("duality 页头不再有市场状态元素（mktDot / mktLabel）",
  dualBranch.indexOf("mktDot") < 0 && dualBranch.indexOf("mktLabel") < 0);

/* 取数按钮 2026-10-08 从内容区搬到页头，并改名「立即刷新」（见 shell.js 同一处注释）。
   它**长得像 live 那个按钮**（同文案、同 .primary），但 id 必须是 `duRefresh` ——
   若图省事复用 btnRefresh，shell 那套"只在夜盘进行中可用"的逻辑一旦扩到 duality，
   就会把这个按钮悄悄灰掉（它明明随时可用）。 */
ok("duality 页头有取数按钮", dualBranch.indexOf('id="duRefresh"') >= 0);
ok("按钮文案是「立即刷新」（与页头其它按钮同一套措辞）",
  /id="duRefresh"[^>]*>立即刷新</.test(dualBranch));
ok("没有复用 live 的 btnRefresh（两个按钮行为不同，id 必须隔离）",
  dualBranch.indexOf("btnRefresh") < 0);

/* 页头都没有市场状态元素了，那个 60 秒心跳就只剩白打 /api/status，所以一并去掉。
   截到 duality 分支自己的 return 为止，别把后面 daily 分支的 statusTimer 算进来。 */
const iDualMount = shell.indexOf('if (state.mode === "duality")');
const dualMountBody = stripComments(shell.slice(iDualMount, shell.indexOf("return;", iDualMount)));
ok("duality 模式不启动 statusTimer（页头已无市场状态可刷）",
  dualMountBody.indexOf("statusTimer") < 0);
ok("duality 模式**不挂 btnRefresh**（那是 live 的按钮，挂了会抛 TypeError 断掉 mount）",
  dualMountBody.indexOf("btnRefresh") < 0);

/* 内容区那个按钮必须**两头都删干净**：DOM 不拼了，bindPanel 里的绑定也不能留 ——
   只删 DOM 的话，`$("dpReload")` 返回 null，addEventListener 当场抛 TypeError，
   面板初始化中断（页面只剩时间范围，图和表都不出来），而且**从外面看不出原因**。 */
const dualityCode = stripComments(fs.readFileSync(ROOT + "static/duality.js", "utf8"));
ok("duality.js 已无内容区取数按钮残留（dpReload / dp-reload 都清掉）",
  dualityCode.indexOf("dpReload") < 0 && dualityCode.indexOf("dp-reload") < 0);
ok("页头按钮由 duality.js 自己绑（谁管数据谁绑事件）",
  dualityCode.indexOf('$("duRefresh")') >= 0);
ok("且绑的是 force 取数（load(true)，穿透服务端 30 分钟缓存）",
  /bindHeaderRefresh[\s\S]{0,400}?load\(true\)/.test(dualityCode));

const icons = fs.readFileSync(ROOT + "static/icons.js", "utf8");
ok("icons.js 里有 chart 图标", icons.indexOf("I.chart") >= 0);
ok("chart 图标不写死颜色（必须走 currentColor）",
  /I\.chart[\s\S]*?currentColor/.test(icons) && !/I\.chart[\s\S]*?#[0-9a-f]{3,6}/i.test(icons));

const html = fs.readFileSync(ROOT + "static/duality.html", "utf8");
ok("duality.html 有挂载点 #dualityHost", html.indexOf('id="dualityHost"') >= 0);
ok("duality.html 有页面级标签容器 #tabs", html.indexOf('id="tabs"') >= 0);
ok("duality.html 引入了 duality.js 与 util.js/icons.js/shell.js",
  ["duality.js", "util.js", "icons.js", "shell.js"].every(function (f) {
    return html.indexOf(f) >= 0;
  }));

const js = fs.readFileSync(ROOT + "static/duality.js", "utf8");
ok("duality.js 从 payload.groups 取分组定义（后端加一组 = 页面多一个 tab）",
  js.indexOf("payload.groups") >= 0 && js.indexOf("PAGE_TABS_FALLBACK") >= 0);
ok("tab 栏由 groupTabs() 驱动（分组顺序与文字都不写死在前端）",
  /function renderPageTabs\(\)[\s\S]{0,400}?groupTabs\(\)/.test(js));
ok("勾选卡与区间计算都走 groupItems()，不直接读 S.items（两组标的不能同框）",
  /function paintPicks\(c\)[\s\S]{0,700}?groupItems\(\)/.test(js) &&
  /function compute\(\)[\s\S]{0,700}?groupItems\(\)/.test(js));
/* 与上面 shell.js 那三条配对：DOM 里没了「数据截止」，写入那边也必须一起删干净。 */
ok("duality.js 不再去写「数据截止」元素（duLatest）", js.indexOf("duLatest") < 0);

/* —— 标的清单：后端 INSTRUMENTS ↔ 前端 PALETTE ——
   后端加了标的、前端忘了配色**不会崩**，会静默落到 PALETTE_FALLBACK ——
   于是可能出现"两条线一个颜色"，而图上看起来就像同一只票。
   这类静默错只能靠对齐两边的 key 集合来守（2026-10-08 加中国黄金 / 四川黄金时立的）。

   ⚠️ 2026-10-12：清单必须**从 INSTRUMENTS 那一块**里抽。原来是在整个文件里扫
   `"key": "..."`，加上 GROUPS（分组也有一对 key）之后，分组名会被一起扫进来，
   于是"调色板里没有多余的色"变成一条**永远失败**的断言 —— 而它想守的其实是
   "后端加了标的、前端有没有配色"。 */
const dsPy = fs.readFileSync(ROOT + "duality.py", "utf8");
const insBlock = /^INSTRUMENTS = \[([\s\S]*?)^\]/m.exec(dsPy);
const pyKeys = insBlock
  ? (insBlock[1].match(/"key":\s*"([a-z0-9_]+)"/g) || [])
    .map(function (s) { return s.replace(/.*"([a-z0-9_]+)"$/, "$1"); })
  : [];
const palBlock = js.match(/var PALETTE = \{([\s\S]*?)\};/);
const palKeys = palBlock
  ? (palBlock[1].match(/^\s*([a-z0-9_]+):\s*"#/gm) || [])
    .map(function (s) { return s.trim().replace(/:.*$/, ""); })
  : [];
ok("抓到了标的清单（正则若失配，下面两条会变成永远为真）", pyKeys.length >= 16,
  pyKeys.join(","));
ok("后端每只标的都在前端调色板里有固定色",
  pyKeys.every(function (k) { return palKeys.indexOf(k) >= 0; }),
  "后端 [" + pyKeys.join(",") + "] ↔ 调色板 [" + palKeys.join(",") + "]");
ok("调色板里没有多余的色（删标的时要连色一起删）",
  palKeys.length === pyKeys.length, palKeys.join(","));

const css = fs.readFileSync(ROOT + "static/style.css", "utf8");
ok("style.css 有这一页的样式（.dp-*）", css.indexOf(".dp-pick") >= 0 &&
  css.indexOf(".dp-tip") >= 0 && css.indexOf("table.t-dual") >= 0);
ok("没有误用 .tabs--filter（它会给范围选择器硬加一个「分档」前缀）",
  js.indexOf("tabs--filter") < 0);

/* ============================================================ 悬停认线
   六只标的上图之后，"这条线是谁"成了真问题（四只时还能靠色点数出来）。
   两条线索都要守，少一条就退回到"自己猜"：
     ① 线吸附 —— 靠 data-k 把每个 SVG 元素和标的 key 对应起来；
     ② 提示框 —— 被吸附的那行置顶并加底色。
   ↓ 全部读**剔过注释**的源码。上一条 statusTimer 的教训：断言 indexOf < 0
     时，同一次改动里写的注释自己就会把断言顶掉（守的是注释不是代码）。 */
ok("悬停识别用的 key 挂在每个 SVG 序列元素上（polyline / 单点圆 / 末点圆）",
  /var k = ' data-k="' \+ U\.esc\(s\.it\.key\)/.test(dualityCode) &&
  dualityCode.indexOf("'<polyline class=\"dp-line\"' + k") >= 0 &&
  dualityCode.indexOf("'<circle class=\"dp-line\"' + k") >= 0 &&
  dualityCode.indexOf("'<circle class=\"dp-cap\"' + k") >= 0);

/* 折线是字符串拼进 innerHTML 的，没有 CSS 钩子可挂 —— 只能逐元素改属性。
   所以"压暗其余"这一步必须走 querySelectorAll，而不是加个 class 了事。 */
ok("压暗/加粗是逐元素改属性（字符串拼出的折线没有 CSS 钩子）",
  /function emphasize\(key\)[\s\S]{0,600}?querySelectorAll\("\[data-k\]"\)/.test(dualityCode) &&
  /function emphasize\(key\)[\s\S]{0,900}?setAttribute\("opacity"/.test(dualityCode));
ok("吸附半径是具名常量，不写魔数（两级都靠它，改一处即可）",
  /var LINE_SNAP = \d+/.test(dualityCode) && /best = LINE_SNAP/.test(dualityCode));
ok("被吸附的那一行会置顶（否则还是得拿色点去反查）",
  /if \(nearKey\) \{\s*rows\.sort/.test(dualityCode));

/* ⚠️ 这一条守的是"别走回头路"：`it.code` 是**数据源**给的，同一只票走东财是
   `601899`、走腾讯是 `sh601899` —— 拿它当标识，换个源页面上的代码就变了样。
   写死在 duality.py 的 `note` 才稳定（形如 `601899 · 铜金矿龙头`）。 */
const secFn = /function secOf\(it\)\s*\{([\s\S]*?)\n  \}/.exec(dualityCode);
ok("悬停标识取自写死的 note，而不是随数据源变的 it.code",
  !!secFn && secFn[1].indexOf("code") < 0 && secFn[1].indexOf("note") >= 0,
  secFn ? secFn[1].replace(/\s+/g, " ").slice(0, 90) : "没抓到 secOf 函数体");

ok("style.css 有「当前吸附行」的样式（.dp-tip-r--on）", css.indexOf(".dp-tip-r--on") >= 0);
ok("高亮行 padding 与 margin 相抵（不然六行的圆点会错开一列）",
  /\.dp-tip-r--on\{[^}]*padding:0 5px;margin:0 -5px/.test(css));
ok("提示框里给出稳定标识的样式（.dp-tip-c）", css.indexOf(".dp-tip-c") >= 0);

/* ============================================================ 悬停提示「看得见」
 * ⚠️ 2026-10-08 在**真实 Chrome** 里逮到的 bug，两个 DOM 桩用例都是绿的：
 *
 *   `.dp-tip` 的 CSS 初始态就是 `display:none`，而 JS 用 `tip.style.display = ""`
 *   去"显示"它 —— 清空 inline 值等于把决定权交回 CSS，于是又变回 none。
 *   症状极具欺骗性：内容算得**完全正确**、DOM 里一应俱全、**就是永远看不见**。
 *   （桩不实现 CSS 层叠，所以 `innerHTML` 有内容就算过。）
 *
 * 两条是**配对**的，单独任何一条都不成立：CSS 保留初始隐藏 + JS 给具体值。
 * 只守一条的话，改掉另一条时这条会静静地失去意义。 */
ok("显示提示框给的是具体值 block（写 \"\" 会回落到 CSS 的 display:none）",
  /tip\.style\.display = "block"/.test(dualityCode));
ok("style.css 里 .dp-tip 仍是初始隐藏（display:none）",
  /\.dp-tip\{[^}]*display:none/.test(css));

/* ============================================================ 悬停提示「认得准」
 * 线上的名称标签：吸附点旁直接写出这是谁。提示框里虽然也有名称，但那是六行里的一行，
 * 眼睛得先找到它；标签贴在线本身上，视线不用离开图。 */
ok("吸附点旁直接标注标的名称（.dp-tag，两端都要有）",
  dualityCode.indexOf('class="dp-tag"') >= 0 && css.indexOf(".dp-tag") >= 0);
/* 标签的颜色靠 SVG 的 fill **属性**传（每条线一个色）。
   CSS 声明压得过 SVG 呈现属性 —— 一旦在 .dp-tag 里写 fill，六个标签全变同一个色，
   而且不会报错、不会崩，只是"看着怪"。 */
const tagRule = /\.dp-tag\{([^}]*)\}/.exec(css);
ok("`.dp-tag` 的 CSS 里不写 fill（CSS 会压过 SVG 的 fill 属性，六色会全变一色）",
  !!tagRule && tagRule[1].indexOf("fill") < 0,
  tagRule ? tagRule[1].replace(/\s+/g, " ") : "没抓到 .dp-tag 规则");

/* ============================================================ 期货用虚线
 * 这一页的两面本来就是**期货**和**股票**，六条线里只有一条不是股票。
 * 用线型标出这一面，比再塞一套图例省地方，也不依赖颜色（色盲也分得清）。
 * 关键是它**常驻** —— 悬停提示要动鼠标才看得到，线型一眼就在。 */
ok("期货画虚线、股票实线（按 kind 判，不靠名字里有没有「金」）",
  /s\.it\.kind === "future" \? ' stroke-dasharray=/.test(dualityCode));
ok("图例的标记是线段（.dp-key）不是圆点 —— 图例得能解释线型",
  dualityCode.indexOf('class="dp-key"') >= 0 && css.indexOf(".dp-key") >= 0);
ok("图例里的虚线段用 repeating-linear-gradient 拼（段长与间隙是写死的数，可控）",
  /repeating-linear-gradient\(90deg,/.test(dualityCode));

/* ============================================================ 分组（2026-10-12）
 *
 * 页面上多了「纽约银 × 白银股」，同日又加了「纽约铜 × 铜股」。这一改动的
 * **失败形态特别隐蔽**：分组 key 写错一个字母、或者某一组压根没有期货，
 * 都不会抛异常 —— 前端按当前分组过滤，结果是"这一组少了一只 / 少了一条线"，
 * 而图、表、勾选卡全都长得像正常的。
 *
 * 分两层守：① 读源码，三组定义与标的归属对得上；
 *          ② 真的调一次 groupItems()，看过滤是不是按 payload.groups 走的。 */
const groupBlock = /^GROUPS = \[([\s\S]*?)^\]/m.exec(dsPy);
const groupKeys = groupBlock
  ? (groupBlock[1].match(/"key":\s*"([a-z0-9_]+)"/g) || [])
    .map(function (s) { return s.replace(/.*"([a-z0-9_]+)"$/, "$1"); })
  : [];
ok("duality.py 里定义了分组（金 / 银 / 铜三组）", groupKeys.length >= 3, groupKeys.join(","));

const itemGroups = (insBlock
  ? (insBlock[1].match(/"group":\s*"([a-z0-9_]+)"/g) || []) : [])
  .map(function (s) { return s.replace(/.*"([a-z0-9_]+)"$/, "$1"); });
ok("每只标的都挂在一个**已定义**的分组上（写错会静默少一只）",
  itemGroups.length === pyKeys.length && itemGroups.every(function (g) {
    return groupKeys.indexOf(g) >= 0;
  }),
  itemGroups.join(","));

/* 每组都要有且只有一个期货 —— 这一页就叫"期股双面"，一组里没有期货就只是一张
   普通的多股对比图；有两个则两条虚线在图上没法区分。 */
const pyFutures = insBlock
  ? (insBlock[1].match(/"key":\s*"[a-z0-9_]+"[\s\S]*?"kind":\s*"future"/g) || []).length
  : 0;
ok("每组一条期货（组数 = 期货数 = 3，一条线一个品种）",
  pyFutures === groupKeys.length && pyFutures === 3, pyFutures);

/* —— 真的过滤一次（读源码守不住"过滤写错了"这类事）—— */
const SAVED = { payload: S.payload, items: S.items, tab: S.tab };
S.payload = {
  generatedAt: TODAY + " 14:30:00",
  groups: [{ key: "gold", label: "纽约金 × 黄金股" },
           { key: "silver", label: "纽约银 × 白银股" },
           { key: "copper", label: "纽约铜 × 铜股" }]
};
S.items = [
  { key: "gold", name: "纽约金", kind: "future", group: "gold", dates: [], closes: [], chgs: [] },
  { key: "zijin", name: "紫金矿业", kind: "stock", group: "gold", dates: [], closes: [], chgs: [] },
  { key: "silver", name: "纽约银", kind: "future", group: "silver", dates: [], closes: [], chgs: [] },
  { key: "sdzy", name: "盛达资源", kind: "stock", group: "silver", dates: [], closes: [], chgs: [] },
  { key: "copper", name: "纽约铜", kind: "future", group: "copper", dates: [], closes: [], chgs: [] },
  { key: "jxty", name: "江西铜业", kind: "stock", group: "copper", dates: [], closes: [], chgs: [] }
];
S.tab = "silver";
ok("切到白银组时只留白银组的三只（金价不会混进银的图里）",
  D.groupItems().map(function (it) { return it.key; }).join(",") === "silver,sdzy",
  D.groupItems().map(function (it) { return it.key; }).join(","));
ok("白银组的期货名按分组取（图注里那句「纽约银与股价量纲不同」）",
  D.futureName() === "纽约银", D.futureName());
ok("组数就是 tab 数（后端加一组 = 页面多一个 tab）", D.groups().length === 3,
  D.groups().length);
S.tab = "copper";
ok("切到铜组后金、银两组的标的都不见了（三组互不串台）",
  D.groupItems().map(function (it) { return it.key; }).join(",") === "copper,jxty",
  D.groupItems().map(function (it) { return it.key; }).join(","));
ok("铜组的期货名按分组取（「纽约铜与股价量纲不同」，不是写死的金/银）",
  D.futureName() === "纽约铜", D.futureName());
S.tab = "gold";
ok("切回黄金组只留黄金组（三组互不串台）",
  D.groupItems().map(function (it) { return it.key; }).join(",") === "gold,zijin",
  D.groupItems().map(function (it) { return it.key; }).join(","));
S.payload = SAVED.payload; S.items = SAVED.items; S.tab = SAVED.tab;

/* ============================================================ 汇总 */
console.log("\n" + (fail === 0
  ? "\x1b[32m全部通过 ✓\x1b[0m  (" + pass + " 项)"
  : "\x1b[31m有失败项 ✗\x1b[0m  通过 " + pass + "，失败 " + fail));
process.exit(fail === 0 ? 0 : 1);
