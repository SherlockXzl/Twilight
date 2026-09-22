/* 筛选与下拉搜索用例（夜盘异动 + 早盘总结「个股异动榜」）

   覆盖四层：
     A. Combo.match / filterOptions —— 纯函数，模糊匹配的边界情况都在这里
     B. 下拉组件行为 —— 打开、输入过滤、回车选中、无匹配提示
     C. evening.js 集成 —— 板块/行业联动、60 秒刷新后保持、板块消失回落、与搜索叠加
     D. morning.js 集成 —— 同一套规则，但工具条在面板内部、数据是日更静态 JSON，
        重新加载页面会整体重建面板，重点验状态保住 + Combo 实例跟着换节点

   做法：最小 DOM 桩加载 util.js + combo.js + 对应页面脚本，喂构造数据、手动触发事件。
   用**合成数据**，不依赖实时行情与真实 JSON，结果稳定可重复跑。
   两个页面脚本都 eval 进同一个进程：id 前缀不同（q/sectorSel vs mvQ/mvSectorSel）不会撞，
   C 节跑完再加载 morning.js（它会覆盖 Shell.mount 存下的回调，所以顺序不能颠倒）。

   用法：node tools/test_filters.js      （退出码 0 = 全通过）

   ⚠️ 三个踩过的坑，写用例时别再犯：
   1. 桩必须照真实行为：应用是从 `Shell.state.data` 取数的（不是 onData 的参数），
      真实 shell.js 也是先写 state 再回调。漏了这步渲染会直接 return、断言全假失败。
   2. `ev.target.closest` 之类只在事件处理里用到的 API 不用桩，但**用到的都要有**——
      少一个就抛异常，而异常会被误读成业务逻辑错。
   3. **前置状态要清干净**：D 节里搜索框的「arm」没清掉，就把后面「选医疗保健」的
      断言全带偏了（筛出来 0 只）。断言失败时先怀疑用例的状态污染，再怀疑代码。
*/
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..") + "/";

/* ------------------------------------------------------------------ DOM 桩 */
const els = {};
function mk(id) {
  return {
    id, innerHTML: "", textContent: "", value: "", hidden: false, style: {}, _h: {}, _q: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(t, f) { this._h[t] = f; },
    setAttribute(k, v) { this["_a_" + k] = v; },
    getAttribute(k) { return this["_a_" + k]; },
    contains() { return false; },
    focus() {},
    querySelector(sel) { return this._q[sel] || (this._q[sel] = mk(id + sel)); },
    querySelectorAll() { return []; },
    fire(t, ev) { if (this._h[t]) this._h[t].call(this, ev || {}); }
  };
}
global.window = global;
global.document = {
  getElementById(id) { return els[id] || (els[id] = mk(id)); },
  addEventListener() {}, title: ""
};
global.fetch = () => Promise.resolve({ json: () => Promise.resolve({}) });

let cap = null;
global.Shell = { state: {}, mount(o) { cap = o; }, syncCountdown() {} };
/* 应用从 Shell.state.data 取数；真实 shell 也是先写 state 再回调 */
function feed(d) { global.Shell.state.data = d; cap.onData(d); }

eval(fs.readFileSync(ROOT + "static/util.js", "utf8"));
eval(fs.readFileSync(ROOT + "static/combo.js", "utf8"));
eval(fs.readFileSync(ROOT + "static/evening.js", "utf8"));

let fail = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  if (!ok) fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}: ${got}${ok ? "" : "   (期望 " + want + ")"}`);
}
function section(t) { console.log("\n" + t); }

/* ---------------------------------------------------------- A. 纯函数匹配 */
section("A. 模糊匹配（Combo.match）");
const OPT = [
  { value: "软件·应用", name: "软件·应用", en: "Software - Application", count: 2 },
  { value: "半导体", name: "半导体", en: "Semiconductors", count: 5 },
  { value: "生物技术", name: "生物技术", en: "Biotechnology", count: 1 }
];
const hits = q => Combo.filterOptions(OPT, q).map(o => o.value).join(",");

check("空查询 → 全部", hits(""), "软件·应用,半导体,生物技术");
check("中文子串「软件」", hits("软件"), "软件·应用");
check("忽略分隔符「软件应用」命中「软件·应用」", hits("软件应用"), "软件·应用");
check("英文小写「semi」命中 Semiconductors", hits("semi"), "半导体");
check("英文大写「SEMI」同样命中", hits("SEMI"), "半导体");
check("英文子串「application」命中「软件·应用」", hits("application"), "软件·应用");
// Biotech**tech**nology 里确实含 "tech" —— 证明是子串匹配而非前缀匹配
check("英文中段子串「tech」命中 Biotechnology", hits("tech"), "生物技术");
check("无命中返回空", Combo.filterOptions(OPT, "zzz").length, 0);
check("count 不参与匹配（搜 5 不应命中任何项）", Combo.filterOptions(OPT, "5").length, 0);
check("带计数展示文案", Combo.labelOf(OPT[0]), "软件·应用 (2)");

/* ------------------------------------------------------- B. 下拉组件行为 */
section("B. 下拉搜索行为");
const tHost = document.getElementById("tCombo");
const tCb = [];
Combo.create(tHost, {
  allLabel: "全部行业", options: OPT, value: "",
  onChange: v => tCb.push(v)
});
const qEl = tHost._q[".combo-q"];
const listEl = tHost._q[".combo-list"];
const txtEl = tHost._q[".combo-txt"];
const items = () => (listEl.innerHTML.match(/>([^<>]+)<\/li>/g) || [])
  .map(s => s.replace(/^>|<\/li>$/g, ""));

check("初始按钮文案", txtEl.textContent, "全部行业");
tCb.length = 0;
Combo.get("tCombo").open();
check("打开后列出「全部」+ 全部选项", items().join("|"), "全部行业|软件·应用 (2)|半导体 (5)|生物技术 (1)");

qEl.value = "软件";
qEl.fire("input");
check("输入「软件」→ 只剩命中项", items().join("|"), "全部行业|软件·应用 (2)");

qEl.fire("keydown", { key: "Enter", preventDefault() {} });
check("回车选中高亮项（不是常驻的「全部」）", tCb.join(","), "软件·应用");
check("选中后按钮文案", txtEl.textContent, "软件·应用 (2)");
check("选中后下拉关闭", Combo.get("tCombo").isOpen(), "false");

Combo.get("tCombo").open();
qEl.value = "zzz";
qEl.fire("input");
check("无匹配时给出提示", items().join("|"), "全部行业|无匹配项");
Combo.get("tCombo").close();

/* ------------------------------------------------------- C. evening 集成 */
section("C. 筛选集成");
function row(symbol, name, sector, industry, chg, sectorEn, industryEn) {
  return { symbol, name, sector, industry, sectorEn: sectorEn || "", industryEn: industryEn || "",
           price: 10, chg, marketCap: 5e9 };
}
const DATA = {
  meta: { criteria: { big: "x", mid: "y", tiny: "z" }, market: {} },
  counts: { total: 5, big_up: 4, mid_up: 1, excluded: 0 },
  tables: {
    big_up: { rows: [
      row("AAA", "甲科技", "信息技术", "软件·应用", 8, "Technology", "Software - Application"),
      row("BBB", "乙电子", "信息技术", "电子元件", 6, "Technology", "Electronic Components"),
      row("CCC", "丙医药", "医疗保健", "生物技术", 5, "Healthcare", "Biotechnology")
    ] },
    mid_up: { rows: [
      row("DDD", "丁软件", "信息技术", "软件·应用", 12, "Technology", "Software - Application"),
      row("EEE", "戊制药", "医疗保健", "制药·特色药与仿制药", 11, "Healthcare", "Drug Manufacturers")
    ] }
  }
};
const shown = () => Number(els["rowInfo"].textContent.match(/显示 (\d+) 条/)[1]);
const rowsInTable = () => (els["tableHost"].innerHTML.match(/<tr>/g) || []).length - 1;
const indOpts = () => Combo.get("industrySel").options().map(o => o.value).join(",");

feed(DATA);
check("首屏显示条数", shown(), 5);
check("行业下拉选项（各标签页并集）", indOpts(), "电子元件,软件·应用,生物技术,制药·特色药与仿制药");

Combo.get("sectorSel").select("信息技术");
check("选板块 → 行业下拉收窄", indOpts(), "电子元件,软件·应用");
check("选板块 → 行数 5→3", shown(), 3);
check("表格行数同步", rowsInTable(), 3);

Combo.get("industrySel").select("软件·应用");
check("再选行业 → 行数 3→2", shown(), 2);

feed(DATA);                       // 模拟 60 秒刷新
check("刷新后板块保持", Combo.get("sectorSel").value(), "信息技术");
check("刷新后行业保持", Combo.get("industrySel").value(), "软件·应用");
check("刷新后行数不变", shown(), 2);

const D2 = JSON.parse(JSON.stringify(DATA));
D2.tables.big_up.rows = [row("ZZZ", "己能源", "能源", "油气勘探", 7, "Energy", "Oil & Gas")];
D2.tables.mid_up.rows = [];
D2.counts = { total: 1, big_up: 1, mid_up: 0, excluded: 0 };
feed(D2);
check("已选板块消失 → 回落到全部", Combo.get("sectorSel").value(), "");
check("已选行业同时回落", Combo.get("industrySel").value(), "");
check("显示条数", shown(), 1);

feed(DATA);
Combo.get("sectorSel").select("医疗保健");
check("选医疗保健 → 2 条", shown(), 2);
els["q"].value = "生物";
els["q"].fire("input");
check("叠加搜索「生物」→ 1 条", shown(), 1);
els["q"].value = "";
els["q"].fire("input");
check("清空搜索 → 回到 2 条", shown(), 2);

/* ------------------------------------------- D. 早盘总结「个股异动榜」集成
   与 C 同一套筛选规则，但容器不同（面板内工具条、id 带 mv 前缀），
   而且数据是日更静态 JSON —— 这里重点验重新渲染后状态是否保住。 */
section("D. 早盘总结 · 个股异动榜");
cap = null;
eval(fs.readFileSync(ROOT + "static/morning.js", "utf8"));

function mrow(symbol, name, sector, industry, chg, sectorEn, industryEn, giant) {
  return { symbol, name, price: 12.5, chg, marketCap: 3e9, sector, industry,
           sectorEn, industryEn, driver: "产业因子 · 个股催化剂", giant: !!giant };
}
const MD = {
  ok: true,
  meta: { tradeDate: "2026-09-21", tradeDateLabel: "9月21日（周一）", sources: ["test"] },
  indices: [], themes: [], linkage: [], aShareHints: [], watchlist: [],
  movers: [
    mrow("ARM",  "Arm Holdings",   "信息技术", "半导体",             17.16, "Technology", "Semiconductors", true),
    mrow("INTC", "Intel",          "信息技术", "半导体",             12.14, "Technology", "Semiconductors", true),
    mrow("META", "Meta Platforms", "通信服务", "互联网内容与信息",   11.43, "Communication Services", "Internet Content & Information", true),
    mrow("MRNA", "Moderna",        "医疗保健", "生物技术",           12.27, "Healthcare", "Biotechnology")
  ]
};
const mvShown  = () => Number(els["mvRowInfo"].textContent.match(/显示 (\d+) 只/)[1]);
const mvRows   = () => (els["mvTableHost"].innerHTML.match(/<tr>/g) || []).length - 1;
const mvHtml   = () => els["morningHost"].innerHTML;
const mvSecOpt = () => Combo.get("mvSectorSel").options().map(o => o.value).join(",");
const mvIndOpt = () => Combo.get("mvIndustrySel").options().map(o => o.value).join(",");

feed(MD);
check("首屏条数", mvShown(), 4);
check("表格行数", mvRows(), 4);
check("计数文案", els["mvRowInfo"].textContent, "显示 4 只 / 共 4 只");
check("两个标签页都在", /id="paneOverview"/.test(mvHtml()) && /id="paneStocks"/.test(mvHtml()), "true");
check("工具条在异动榜面板内", /个股异动榜[\s\S]*id="mvQ"/.test(mvHtml()), "true");
check("板块下拉选项", mvSecOpt(), "通信服务,信息技术,医疗保健");
check("行业下拉（未选板块 = 全部）", mvIndOpt(), "半导体,互联网内容与信息,生物技术");

Combo.get("mvSectorSel").select("信息技术");
check("选板块 → 行业下拉收窄", mvIndOpt(), "半导体");
check("选板块 → 4→2 只", mvShown(), 2);

Combo.get("mvIndustrySel").select("半导体");
check("再选行业 → 仍 2 只（两只都是半导体）", mvShown(), 2);

els["mvQ"].value = "arm";
els["mvQ"].fire("input");
check("叠加搜索「arm」→ 1 只", mvShown(), 1);
check("叠加搜索后表格同步", mvRows(), 1);

els["mvQ"].value = "";
els["mvQ"].fire("input");
check("清空搜索 → 回到 2 只", mvShown(), 2);

/* 重新渲染会整体重建面板：状态要保住，搜索框的文字要写回输入框 */
els["mvQ"].value = "arm";
els["mvQ"].fire("input");
feed(MD);
check("重建后筛选状态保持", mvShown(), 1);
check("重建后搜索框回填（value 属性）", /id="mvQ" value="arm"/.test(mvHtml()), "true");

/* 宿主节点被换掉时（真实浏览器里每次重建都会换），Combo 实例必须跟着换 ——
   否则旧实例指着脱离文档的节点，点开没反应且不报错。
   桩里靠删掉缓存条目来制造"换节点"：删掉后 $() 会返回一个新对象。 */
els["mvQ"].value = "";          // 先清掉搜索，否则「arm」会把医疗保健的行全滤掉
els["mvQ"].fire("input");
Combo.get("mvSectorSel").select("医疗保健");
check("选医疗保健 → 1 只", mvShown(), 1);

delete els["mvSectorSel"];
feed(MD);
check("换节点后下拉实例重建", Combo.get("mvSectorSel").host === els["mvSectorSel"], "true");
check("换节点后已选值保留", Combo.get("mvSectorSel").value(), "医疗保健");
check("换节点后筛选仍生效", mvShown(), 1);

/* 新交易日的数据里没有这个板块 → 回落，不能卡在空表上 */
const MD2 = JSON.parse(JSON.stringify(MD));
MD2.movers = [
  mrow("META", "Meta Platforms", "通信服务", "互联网内容与信息", 11.43,
       "Communication Services", "Internet Content & Information", true),
  mrow("ARM", "Arm Holdings", "信息技术", "半导体", 17.16, "Technology", "Semiconductors", true)
];
feed(MD2);
check("已选板块消失 → 回落全部", Combo.get("mvSectorSel").value(), "");
check("回落后的条数", mvShown(), 2);

feed(MD);
els["mvQ"].value = "zzz";
els["mvQ"].fire("input");
check("无命中 → 0 只", mvShown(), 0);
check("无命中给出提示", /当前筛选条件下没有数据/.test(els["mvTableHost"].innerHTML), "true");
check("无命中时工具条仍在（能撤掉筛选）", /id="mvQ"/.test(mvHtml()), "true");
els["mvQ"].value = "";
els["mvQ"].fire("input");
check("清空搜索恢复 4 只", mvShown(), 4);

console.log(fail === 0 ? "\n全部通过 ✓" : `\n${fail} 项未通过 ✗`);
process.exit(fail === 0 ? 0 : 1);
