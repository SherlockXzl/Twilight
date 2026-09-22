#!/usr/bin/env node
/**
 * 站点标（左上角 logo + 「晨昏线」三字）用例。
 *
 * 用法：node tools/test_brand.js      （退出码 0 = 全通过）
 *
 * 为什么需要这个用例
 * ------------------
 * 这一块**怎么改都不会报错**，正是本项目反复栽跟头的那类改动：
 *   · 图挂了 / 名字写错 → 页面上是个破图占位符，但布局照样跑、控制台不一定报错；
 *   · 字色被改成浅色（哪怕只是"顺手调亮点"）→ 白侧栏上的字**直接看不见**，
 *     页面照常渲染、控制台一声不响。本体裁就真做过一次白字，所以颜色是**算对比度**的；
 *   · 回退只做一半 —— 只改了 HTML 没删 CSS，留下一堆不生效的死样式，
 *     下次有人翻到会以为还是现行约定。
 *
 * 所以这里钉四件事：
 *   1. **资产本身**是好的 —— 文件在、是真 PNG、带透明通道、分辨率够 retina 用，
 *      而且**内容铺满画布**（解像素量包围盒，专挡「原图直接缩」留下的空白）；
 *   2. **渲染出来的结构**对 —— img 有 src/alt/宽高，站点名是一整段纯文字没被拆散；
 *   3. **颜色对比度达标** —— 从 CSS 里读出实际色值算，字色压在白侧栏上必须 ≥ 4.5:1；
 *   4. **没有残留** —— 不复存在的分色 / 描边样式与变量都清干净了，不留死样式。
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");   // 用来解 PNG 像素，见下面的 pngAlphaBBox

const ROOT = path.resolve(__dirname, "..") + "/";
const read = p => fs.readFileSync(ROOT + p, "utf8");

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

/* --------------------------------------------- 0. 显示尺寸 → 需要的分辨率 */

/** logo 在正常宽度下的显示边长（px），必须和 style.css 的 .brand-logo 一致 */
const LOGO_DISPLAY = 38;

/* ------------------------------------------------------------ 1. 资产 */

section("1. logo 资产：文件在、是真 PNG、带透明通道、分辨率够用");

const LOGO_PATH = ROOT + "static/logo.png";
const logoOk = fs.existsSync(LOGO_PATH);
checkTrue("static/logo.png 存在", logoOk, logoOk ? "" : "文件缺失 —— 页面上会是个破图");

/** 解出 PNG 的**内容包围盒**（alpha > 12 的范围）。
 *
 *  为什么要真的解码，而不是只看文件头那几个字节：
 *  最阴的一种改法是"把设计师给的原图直接缩放塞进来"。图是好的、透明底也在、
 *  尺寸也够 retina —— 唯独**四周留了一整圈空白**，于是 logo 在页面上看起来
 *  莫名其妙地小一圈，还和文字对不齐。文件头一个字都看不出这件事，
 *  只有量出"内容占画布多少"才知道。Node 自带 zlib，解 PNG 也就二十行。 */
function pngAlphaBBox(buf) {
  let off = 8, ihdr = null; const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString("ascii");
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === "IHDR") ihdr = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (!ihdr) return null;
  const w = ihdr.readUInt32BE(0), h = ihdr.readUInt32BE(4);
  const bpp = 4;                                    // 只处理 8bit RGBA
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const px = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {                     // 逐扫描线反滤波
    const ft = raw[p++];
    const line = raw.slice(p, p + stride); p += stride;
    const cur = px.slice(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (ft === 1) v = (v + a) & 255;
      else if (ft === 2) v = (v + b) & 255;
      else if (ft === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (ft === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[i] = v;
    }
  }
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (px[y * stride + x * bpp + 3] > 12) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { w, h, x0, y0, x1, y1, cornerA: px[3] };
}

let w = 0, h = 0, colorType = -1, bitDepth = -1;
if (logoOk) {
  const buf = fs.readFileSync(LOGO_PATH);
  const magic = buf.slice(0, 8).toString("hex");
  check("PNG 文件头", magic, "89504e470d0a1a0a");
  check("IHDR 块名", buf.slice(12, 16).toString("ascii"), "IHDR");
  w = buf.readUInt32BE(16);
  h = buf.readUInt32BE(20);
  bitDepth = buf[24];
  colorType = buf[25];          // 6 = RGBA，4 = 灰度+alpha
  const interlace = buf[28];    // 解码器只处理 0（无隔行）
  checkTrue("带 alpha 通道（colorType 6/4）", colorType === 6 || colorType === 4,
    "colorType=" + colorType);
  checkTrue("位深 8", bitDepth === 8, "bitDepth=" + bitDepth);
  checkTrue("无隔行（解码器前提）", interlace === 0, "interlace=" + interlace);
  checkTrue("是正方形", w === h, w + "x" + h);
  checkTrue("分辨率够 retina（≥ 显示尺寸的 2 倍）", w >= LOGO_DISPLAY * 2,
    w + "px ≥ " + (LOGO_DISPLAY * 2) + "px");
  const kb = Math.round(buf.length / 1024);
  checkTrue("体积合理（< 120KB）", kb < 120, kb + "KB");

  const bb = colorType === 6 ? pngAlphaBBox(buf) : null;
  checkTrue("解出了内容包围盒", !!bb, bb ? JSON.stringify(bb) : "解码失败");
  if (bb) {
    /* 站点标背景是**白色侧栏**，图必须透明底 —— 白底图将来换主题/贴到有色底上
       会露出一块白方块，且和文字基线对不齐。这里直接读像素，不靠"声明了 alpha"。 */
    check("左上角是透明的（不是白底图）", bb.cornerA, 0);
    const fx = (bb.x1 - bb.x0 + 1) / bb.w, fy = (bb.y1 - bb.y0 + 1) / bb.h;
    /* 内容要铺满画布：这一条专门挡"原图直接缩放"—— 那种图四周留一大圈空白，
       logo 在页面上会莫名其妙地小一圈。实测裁边版两轴都 ≥ 92%。 */
    checkTrue("内容横向铺满画布 ≥ 88%（挡住「原图直接缩」留下的空白）", fx >= 0.88,
      (fx * 100).toFixed(1) + "%");
    checkTrue("内容纵向铺满画布 ≥ 88%", fy >= 0.88, (fy * 100).toFixed(1) + "%");
    /* 四周留白要大致均匀，否则贴着文字的边会看着"偏" */
    const mx = (bb.w - (bb.x1 - bb.x0 + 1)) / 2, my = (bb.h - (bb.y1 - bb.y0 + 1)) / 2;
    checkTrue("内容基本居中（上下/左右留白相差 < 4% 画布）",
      Math.abs(bb.x0 - mx) / bb.w < 0.04 && Math.abs(bb.y0 - my) / bb.h < 0.04,
      "左 " + bb.x0 + " / 右 " + (bb.w - 1 - bb.x1) + " · 上 " + bb.y0 + " / 下 " + (bb.h - 1 - bb.y1));
  }
}

/* ------------------------------------------------------ 2. 渲染出的结构 */

section("2. 侧栏渲染：img 挂在左侧，站点名是一整段纯文字");

/* DOM 桩：字段齐全一点，因为 shell.js 的 mount() 会顺路调页头、状态检查等，
   只要有一个元素 stub 少方法就会中途抛错、renderSidebar 的产物看不到。 */
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
global.setInterval = function () { return 0; };
global.clearInterval = function () {};
global.fetch = function () { return Promise.resolve({ json: () => Promise.resolve({}) }); };

const Shell = (function () {
  eval(fs.readFileSync(ROOT + "static/util.js", "utf8"));
  eval(fs.readFileSync(ROOT + "static/icons.js", "utf8"));
  eval(fs.readFileSync(ROOT + "static/shell.js", "utf8"));
  return global.Shell;
})();

Shell.mount({ navKey: "evening", title: "夜盘异动", mode: "live", onData() {} });

const sidebar = els["sidebar"] ? els["sidebar"].innerHTML : "";
checkTrue("侧栏渲染出了内容", sidebar.length > 0, sidebar.length + " 字符");

const img = sidebar.match(/<img\b[^>]*>/);
checkTrue("有 <img>", !!img, img ? img[0] : "找不到");
if (img) {
  /* 用 <img> 而不是 CSS 背景图：背景图打印/另存不会跟着走，这是全站唯一品牌资产。 */
  checkTrue("带 brand-logo 类", /class="brand-logo"/.test(img[0]), img[0]);
  checkTrue("src 指向 logo.png", /src="logo\.png"/.test(img[0]), img[0]);
  /* alt 不能空：图挂了时至少要说出这是什么，而不是一片空白 */
  checkTrue("alt 非空", /alt="[^"]+"/.test(img[0]), img[0]);
  /* 宽高写在标签属性上（不只是 CSS）—— 图未解码完时侧栏不会先塌再跳 */
  checkTrue("有 width/height 属性（防布局跳动）",
    /\bwidth="\d+"/.test(img[0]) && /\bheight="\d+"/.test(img[0]), img[0]);
}
checkTrue("img 在文字之前（logo 在左）",
  sidebar.indexOf("<img") < sidebar.indexOf("brand-mark"), "位置正确");

const mark = sidebar.match(/<div class="brand-mark">([\s\S]*?)<\/div>/);
checkTrue("有 brand-mark", !!mark, mark ? mark[1] : "找不到");
if (mark) {
  const inner = mark[1];
  /* 站点名是**一整段纯文字**（2026-09-22 从"三字三种处理"改回常规）。
     这条同时挡两件事：
       ① 有 span/别的标签混进来（比如又按字位拆成分色）；
       ② 名字本身掉了字或带上了多余空白。 */
  check("站点名是纯文字、一整段", inner, "晨昏线");
  checkTrue("没有按字位拆成多个 span（拆了就得靠「名字正好 3 字」这个隐含前提）",
    inner.indexOf("<") < 0, inner.indexOf("<") < 0 ? "无标签" : "出现了标签：" + inner);
}
checkTrue("副标题仍在", sidebar.indexOf("brand-sub") >= 0);

/* ------------------------------------------------------------ 3. 颜色 */

section("3. 站点名用常规正文色，且必须够黑（白底上不能隐形）");

const css = read("static/style.css");

function cssVar(name) {
  const m = css.match(new RegExp("--" + name + "\\s*:\\s*(#[0-9a-fA-F]{3,8})\\s*;"));
  return m ? m[1].toLowerCase() : null;
}
/** WCAG 相对亮度 / 对比度 */
function lum(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  const ch = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrast(a, b) {
  const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** 取某选择器的规则体（同 test_tab_styles.js 的做法） */
function ruleBody(selector) {
  const re = new RegExp("(?:^|[,{])\\s*" + selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*(?:,[^{]*)?\\{([^}]*)\\}", "m");
  const m = css.match(re);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}
function prop(body, name) {
  if (!body) return null;
  const m = body.match(new RegExp("(?:^|;)\\s*" + name + "\\s*:([^;]+)"));
  return m ? m[1].trim() : null;
}

const MARK = ruleBody(".brand-mark");
checkTrue(".brand-mark 有规则块", !!MARK, MARK ? "OK" : "缺失");

check("字号挂全站变量（不写裸 px）", prop(MARK, "font-size"), "var(--fs-6)");
check("字重回到常规的 600", String(prop(MARK, "font-weight")), "600");
check("字距 1.5px", String(prop(MARK, "letter-spacing")), "1.5px");
check("颜色用全站正文色 --ink", prop(MARK, "color"), "var(--ink)");

/* 站点名压在**白侧栏**上，这里唯一会"静默失败"的方向就是字色太浅（浅到看不见）。
   不是假想 —— 本轮就真做过一次白字「线」，没有描边时在白底上完全隐形。
   所以颜色不能只查"写没写"，要算出来。 */
const INK = cssVar("ink");
checkTrue("--ink 解析得到", !!INK, String(INK));
if (INK) {
  const crInk = contrast(INK, "#ffffff");
  checkTrue("正文色对白侧栏 ≥ 4.5:1（浅色字会静默隐形）", crInk >= 4.5,
    INK + " = " + crInk.toFixed(2) + ":1");
}

/* 不写 font-family = 继承 body 的系统字体栈，这就是"正常的字体"。
   写成某个字体名（宋体之类）反而会变成特例。 */
checkTrue("不单独指定字体（继承 body 的系统栈 = 正常字体）",
  prop(MARK, "font-family") === null, String(prop(MARK, "font-family")));

/* ------------------------------- 4. 分色 / 描边的残留要清干净 */

section("4. 三个分色类是历史产物，改回常规后必须清干净（半途回退最丑）");

/* 曾经有 .bd（晨金）/ .bn（昏蓝）/ .bo（线 白底黑描边）三个按字位分色的类。
   回退后它们都该消失 —— 留着就是死样式：不生效，但下次有人翻到会以为还有用，
   或者只删了 HTML 没删 CSS，日后被当成"现行约定"照抄。 */
[".brand-mark .bd", ".brand-mark .bn", ".brand-mark .bo"].forEach(function (sel) {
  const r = ruleBody(sel);
  checkTrue("CSS 里不再有 " + sel + " 规则", r === null, r === null ? "已清" : "残留：" + r);
});
checkTrue("--brand-dawn 变量已移除", cssVar("brand-dawn") === null, String(cssVar("brand-dawn")));
checkTrue("--brand-night 变量已移除", cssVar("brand-night") === null, String(cssVar("brand-night")));
checkTrue("白字用的 @supports 兜底描边块也一并移除（没有白字了）",
  css.indexOf("@supports not (-webkit-text-stroke") < 0, "已清");

/* ------------------------------------------------------ 5. 尺寸与窄屏 */

section("5. 尺寸：常态 38px、窄屏收小（不是漏配）");

const LOGO_RULE = ruleBody(".brand-logo");
checkTrue(".brand-logo 有规则块", !!LOGO_RULE, LOGO_RULE ? "OK" : "缺失");
check("常态宽度与断言里的假设一致", prop(LOGO_RULE, "width"), LOGO_DISPLAY + "px");
check("常态高度", prop(LOGO_RULE, "height"), LOGO_DISPLAY + "px");
checkTrue("flex:0 0 auto（不被长文字挤扁）", /0 0 auto/.test(String(prop(LOGO_RULE, "flex"))),
  String(prop(LOGO_RULE, "flex")));

/* 窄屏：顶部横条里 logo 要收小，否则整条被撑高 */
const narrow = css.slice(css.indexOf("@media(max-width:760px)"));
checkTrue("窄屏媒体查询里覆盖了 .brand-logo 尺寸",
  /\.brand-logo\s*\{[^}]*width/.test(narrow), "找到覆盖规则");
checkTrue("窄屏里也覆盖了 .brand-mark 字号（收小到 18px）",
  /\.brand-mark\s*\{[^}]*font-size/.test(narrow), "找到覆盖规则");
checkTrue("窄屏副标题让位（display:none）",
  /\.brand-sub\s*\{[^}]*display\s*:\s*none/.test(narrow), "找到覆盖规则");

console.log("");
if (fail === 0) { console.log("全部通过 \u2713  (" + pass + " 项断言)"); process.exit(0); }
console.log("有失败项 \u2717  (" + fail + " 项失败 / " + (pass + fail) + " 项)"); process.exit(1);
