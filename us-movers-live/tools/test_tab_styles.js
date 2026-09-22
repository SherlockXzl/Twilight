#!/usr/bin/env node
/**
 * 两组「标签」必须是两种控件 —— 子页面切换 vs 分档筛选。
 *
 * 用法：node tools/test_tab_styles.js      （退出码 0 = 全通过）
 *
 * 为什么需要这个用例
 * ------------------
 * 这两组标签的**行为**已经各有用例盯着（test_evening_tabs.js / test_morning_tabs.js），
 * 但它们**长得像不像**没人管。而恰恰是"长得像"会造成真实误判：
 * 两者样式一样时，读者会把「所有 / 大市值」也当成换页控件，点下去发现只是筛行、
 * 视野没动，就会认为"点了没反应"。
 *
 * 这类问题改错了**不会报任何错**：把 HTML 上的修饰类删掉，页面照样渲染、点击照样生效，
 * 只是又变回两组一模一样的药丸。靠肉眼要在两个页面之间来回切才看得出来，极易漏掉。
 *
 * 所以这里钉三件事：
 *   1. 两侧 HTML 各自挂着**对应**的修饰类，且**只有一个**（不能同时挂、也不能挂错）；
 *   2. style.css 里两个修饰类**都有**规则块（不能只定义一边）；
 *   3. 两边的视觉参数**确实不同** —— 圆角、选中态底色、选中态字重至少各差一处，
 *      防止哪天有人"顺手统一一下样式"把它们又合并回去。
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = p => fs.readFileSync(path.join(ROOT, p), "utf8");

let pass = 0, fail = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log("  \u2713 " + label + ": " + JSON.stringify(got)); }
  else { fail++; console.log("  \u2717 " + label + "\n      实际: " + JSON.stringify(got) + "\n      期望: " + JSON.stringify(want)); }
}

function checkTrue(label, cond, detail) {
  if (cond) { pass++; console.log("  \u2713 " + label + (detail ? ": " + detail : "")); }
  else { fail++; console.log("  \u2717 " + label + (detail ? "  (" + detail + ")" : "")); }
}

function section(t) { console.log("\n" + t); }

/* ---------------------------------------------------------------- 读文件 */

const eveningHtml = read("static/index.html");
const morningHtml = read("static/morning.html");
const css = read("static/style.css");

/** 取某页 #tabs 容器上的全部 class */
function tabsClasses(html, file) {
  const m = html.match(/<div\s+class="([^"]*)"\s+id="tabs"/);
  if (!m) { console.log("  ✗ " + file + " 里找不到 class 在 id 之前的 #tabs 容器"); fail++; return []; }
  return m[1].split(/\s+/).filter(Boolean);
}

/** 取 CSS 里某个选择器开头的规则块的声明部分（取首个匹配，够用） */
function ruleBody(selector) {
  // 选择器里的 . 要转义；允许选择器出现在逗号组里（如 ".a .b.on,\n.a .b.on:hover{"）
  const re = new RegExp("(?:^|[,{])\\s*" + selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*(?:,[^{]*)?\\{([^}]*)\\}", "m");
  const m = css.match(re);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

/** 从声明里读某个属性值 */
function prop(body, name) {
  if (!body) return null;
  const m = body.match(new RegExp("(?:^|;)\\s*" + name + "\\s*:([^;]+)"));
  return m ? m[1].trim() : null;
}

/* ---------------------------------------------------- 1. HTML 挂对了类 */

section("1. 两侧 HTML 挂的是各自对应的修饰类，且只有一个");

const EV_CLASSES = tabsClasses(eveningHtml, "static/index.html");
const MO_CLASSES = tabsClasses(morningHtml, "static/morning.html");

const evMods = EV_CLASSES.filter(c => c.startsWith("tabs--"));
const moMods = MO_CLASSES.filter(c => c.startsWith("tabs--"));

check("夜盘异动 #tabs 的基础类", EV_CLASSES.includes("tabs"), true);
check("早盘总结 #tabs 的基础类", MO_CLASSES.includes("tabs"), true);
check("夜盘异动 #tabs 的修饰类", evMods, ["tabs--filter"]);
check("早盘总结 #tabs 的修饰类", moMods, ["tabs--page"]);
checkTrue("两侧修饰类确实不同", evMods[0] !== moMods[0], evMods[0] + " ≠ " + moMods[0]);
checkTrue("没有页面同时挂两个修饰类", evMods.length === 1 && moMods.length === 1);

/* -------------------------------------------------- 2. CSS 两边都有块 */

section("2. style.css 里两个修饰类都有规则块（只定义一边 = 另一边退回默认药丸）");

const PAGE_BLOCK = ruleBody(".tabs--page");
const FILTER_BLOCK = ruleBody(".tabs--filter");
const PAGE_ON = ruleBody(".tabs--page .tab.on");
const FILTER_ON = ruleBody(".tabs--filter .tab.on");
const PAGE_TAB = ruleBody(".tabs--page .tab");
const FILTER_TAB = ruleBody(".tabs--filter .tab");

checkTrue(".tabs--page 有规则块", !!PAGE_BLOCK, PAGE_BLOCK ? PAGE_BLOCK.slice(0, 46) + "…" : "缺失");
checkTrue(".tabs--filter 有规则块", !!FILTER_BLOCK, FILTER_BLOCK ? FILTER_BLOCK.slice(0, 46) + "…" : "缺失");
checkTrue(".tabs--page .tab 有规则块", !!PAGE_TAB, PAGE_TAB ? "OK" : "缺失");
checkTrue(".tabs--filter .tab 有规则块", !!FILTER_TAB, FILTER_TAB ? "OK" : "缺失");
checkTrue(".tabs--page .tab.on 有规则块", !!PAGE_ON, PAGE_ON ? "OK" : "缺失");
checkTrue(".tabs--filter .tab.on 有规则块", !!FILTER_ON, FILTER_ON ? "OK" : "缺失");

/* ------------------------------------------- 3. 三个视觉维度必须都不同 */

section("3. 两边的视觉参数必须真的有差别（防「顺手统一一下」）");

const pageR = prop(PAGE_TAB, "border-radius");
const filtR = prop(FILTER_TAB, "border-radius");
checkTrue("圆角不同 —— 分段控件是圆角矩形、筛选项是胶囊",
  !!pageR && !!filtR && pageR !== filtR, "page=" + pageR + "  filter=" + filtR);
checkTrue("筛选项是胶囊形（999px）", String(filtR).indexOf("999") >= 0, String(filtR));

const pageOnBg = prop(PAGE_ON, "background");
const filtOnBg = prop(FILTER_ON, "background");
checkTrue("选中态底色不同 —— 一个白色凸起、一个实心填充",
  !!pageOnBg && !!filtOnBg && pageOnBg !== filtOnBg, "page=" + pageOnBg + "  filter=" + filtOnBg);
checkTrue("子页面选中态是白色凸起", /#fff|#ffffff|white/i.test(String(pageOnBg)), String(pageOnBg));
checkTrue("筛选选中态是实心站点蓝", String(filtOnBg).indexOf("var(--blue)") >= 0, String(filtOnBg));

const pageOnFw = prop(PAGE_ON, "font-weight");
const filtOnFw = prop(FILTER_ON, "font-weight");
checkTrue("选中态字重不同 —— 页面级更重",
  !!pageOnFw && !!filtOnFw && pageOnFw !== filtOnFw, "page=" + pageOnFw + "  filter=" + filtOnFw);
checkTrue("子页面选中态加粗到 600", String(pageOnFw) === "600", String(pageOnFw));

checkTrue("分档筛选有「分档」前置标签（帮读者认出这是筛选不是换页）",
  css.indexOf('.tabs--filter:not(:empty)::before') >= 0, "找到了 ::before 规则");

/* ------------------------------------------------------------------ 结果 */

console.log("");
if (fail === 0) { console.log("全部通过 \u2713  (" + pass + " 项断言)"); process.exit(0); }
console.log("有失败项 \u2717  (" + fail + " 项失败 / " + (pass + fail) + " 项)"); process.exit(1);
