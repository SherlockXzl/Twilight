#!/usr/bin/env node
/**
 * 站点标用例（左上角 brand.png 完整标识 + favicon logo.png）。
 *
 * 用法：node tools/test_brand.js      （退出码 0 = 全通过）
 *
 * 为什么需要这个用例
 * ------------------
 * 这一块**怎么改都不会报错**，正是本项目反复栽跟头的那类改动：
 *   · 图挂了 / 文件名写错 → 页面上是个破图占位符，但布局照样跑、控制台不一定报错；
 *   · 图是好的但**偏白** → 白侧栏上等于隐形，页面照常渲染、控制台一声不响
 *     （文字版时代本项目真做过一次白字「线」，所以可见性是**算出来的**，不靠肉眼）；
 *   · 图是"原图直接缩" → 四周带一圈透明留白，标识在页面上莫名小一圈、和导航对不齐；
 *   · 换成整图后只删了一半 → HTML 不再有站名文字，CSS 里却留着 `.brand-mark`
 *     的死样式，下次有人翻到会以为还是现行约定。
 *
 * 所以这里钉四件事：
 *   1. **资产本身**是好的 —— 文件在、是真 PNG、带 alpha、无隔行、分辨率够 retina，
 *      而且**内容铺满画布**（解像素算包围盒，专挡"原图直接缩"留下的空白）；
 *   2. **可见性** —— 解出像素算 WCAG 对比度：放在白侧栏上的图，不能大面积偏白；
 *   3. **渲染出来的结构**对 —— img 有 class/src/alt/宽高，且宽高比与实际图片一致；
 *   4. **没有残留** —— 换成整图后不再存在的文字类（`.brand-mark` / `.brand-sub` /
 *      `.brand-tx`）与历史分色类都清干净了，不留死样式。
 *
 * 2026-09-24：站点标从「小图 + 纯文字站名 + 副标题」换成用户给的**完整标识图**
 * （圆形徽标 + 「晨昏线」三字一体）。本用例随之改写：原来的「站点名用正文色、对白侧栏
 * ≥4.5:1」那组断言随文字一起作废，替换成**直接量图本身的对比度** —— 风险没消失，
 * 只是从"CSS 里挑了浅色"变成了"图本身偏白"。
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");   // 用来解 PNG 像素

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

/** 侧栏标识在正常宽度下的显示宽（px），必须和 style.css 的 .brand-img 一致 */
const BRAND_DISPLAY_W = 180;
/** favicon 的显示边长按 16px 算（浏览器标签页），留 2 倍余量即可 */
const FAVICON_DISPLAY = 16;

/* ------------------------------------------------------------ PNG 解码 */

/** 解出 8bit RGBA 像素。只处理无隔行的 colorType 6（本项目的两张图都是）。
 *
 *  为什么要真的解码而不是只看文件头：
 *  最阴的改法是"把设计师给的原图直接缩放塞进来" —— 图是好的、透明底也在、尺寸也够，
 *  唯独**四周留了一整圈空白**，于是标识在页面上看起来莫名其妙地小一圈。
 *  文件头一个字都看不出这件事，只有量出"内容占多大"才知道。Node 自带 zlib，够用。 */
function decodePng(buf) {
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
  return { w, h, bpp, stride, px };
}

/** alph 阈值以上的像素 → 包围盒 + 角落 alpha */
function alphaBBox(d) {
  const { w, h, bpp, stride, px } = d;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (px[y * stride + x * bpp + 3] > 12) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { w, h, x0, y0, x1, y1, cornerA: px[3] };
}

/** WCAG 相对亮度 */
function lum(r, g, b) {
  const ch = [r, g, b].map(v => v / 255)
    .map(v => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** 不透明像素里，对**白底**对比度 ≥ thr 的占比。
 *
 *  这是本用例的核心价值：站点标贴在白侧栏上，唯一会"静默失败"的方向就是
 *  图本身偏白（浅到看不见）。假想不是空穴来风 —— 文字版时代真做过一次白字，没有
 *  描边时在白底上完全隐形，而页面照常渲染、控制台一声不响。 */
function contrastVsWhite(d, thr) {
  const { w, h, bpp, stride, px } = d;
  let opaque = 0, ok = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * stride + x * bpp;
    if (px[i + 3] <= 12) continue;
    opaque++;
    const L = lum(px[i], px[i + 1], px[i + 2]);
    if (1.05 / (L + 0.05) >= thr) ok++;
  }
  return opaque ? ok / opaque : 0;
}

/* ------------------------------------------------------------ 1. 资产 */

/** 通用的 PNG 资产检查。img 侧栏标与 favicon 走同一套，只有尺寸期望不同。 */
function checkAsset(label, relPath, opts) {
  console.log("\n  —— " + label + "（" + relPath + "）——");
  const full = ROOT + relPath;
  if (!fs.existsSync(full)) {
    checkTrue(relPath + " 存在", false, "文件缺失 —— 页面上会是个破图");
    return null;
  }
  checkTrue(relPath + " 存在", true);
  const buf = fs.readFileSync(full);
  check("PNG 文件头", buf.slice(0, 8).toString("hex"), "89504e470d0a1a0a");
  check("IHDR 块名", buf.slice(12, 16).toString("ascii"), "IHDR");
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const bitDepth = buf[24], colorType = buf[25], interlace = buf[28];
  checkTrue("带 alpha 通道（colorType 6/4）", colorType === 6 || colorType === 4,
    "colorType=" + colorType);
  checkTrue("位深 8", bitDepth === 8, "bitDepth=" + bitDepth);
  checkTrue("无隔行（解码器前提）", interlace === 0, "interlace=" + interlace);
  checkTrue("宽 ≥ 显示宽 ×2（retina 够用）", w >= opts.dispW * 2,
    w + "px ≥ " + (opts.dispW * 2) + "px");
  if (opts.square) {
    checkTrue("是正方形（favicon 画布）", w === h, w + "x" + h);
  } else {
    checkTrue("是横向标识（不是正方形）", w > h, w + "x" + h);
    checkTrue("宽高比 = " + opts.ratioNote, Math.abs(w / h - opts.ratio) < 0.05,
      (w / h).toFixed(3) + " vs " + opts.ratio);
  }
  const kb = Math.round(buf.length / 1024);
  checkTrue("体积合理（< 200KB）", kb < 200, kb + "KB");

  const d = colorType === 6 ? decodePng(buf) : null;
  const bb = d ? alphaBBox(d) : null;
  checkTrue("解出了内容包围盒", !!bb, bb ? JSON.stringify(bb) : "解码失败");
  if (bb) {
    check("左上角是透明的（不是白底图）", bb.cornerA, 0);
    const fx = (bb.x1 - bb.x0 + 1) / bb.w, fy = (bb.y1 - bb.y0 + 1) / bb.h;
    /* 内容要铺满画布：专挡"原图直接缩"—— 那种图四周留一大圈空白。
       实测两张都是 100%。 */
    checkTrue("内容横向铺满画布 ≥ 92%（挡住「原图直接缩」留下的空白）", fx >= 0.92,
      (fx * 100).toFixed(1) + "%");
    checkTrue("内容纵向铺满画布 ≥ 92%", fy >= 0.92, (fy * 100).toFixed(1) + "%");
    const mx = (bb.w - (bb.x1 - bb.x0 + 1)) / 2, my = (bb.h - (bb.y1 - bb.y0 + 1)) / 2;
    checkTrue("内容基本居中（上下/左右留白相差 < 4% 画布）",
      Math.abs(bb.x0 - mx) / bb.w < 0.04 && Math.abs(bb.y0 - my) / bb.h < 0.04,
      "左 " + bb.x0 + " / 右 " + (bb.w - 1 - bb.x1) + " · 上 " + bb.y0 + " / 下 " + (bb.h - 1 - bb.y1));
  }

  /* 可见性：站点标贴在**白侧栏**上。图里至少要有相当一部分墨色（对白底 ≥3:1），
     否则就是"白底上的白图"—— 页面照常渲染，什么错都不报。
     实测 brand.png 53.1% / logo.png 50.6%，门槛留到 40% 以免对配色过敏感。 */
  if (d) {
    const f3 = contrastVsWhite(d, 3.0);
    checkTrue("不透明像素里 ≥40% 对白底达 3:1（否则在白侧栏上等于隐形）", f3 >= 0.40,
      (f3 * 100).toFixed(1) + "%");
  }
  return { w, h };
}

section("1. 标识资产：真 PNG / 带 alpha / 内容铺满 / 在白底上看得见");

const brandSize = checkAsset("侧栏站点标", "static/brand.png",
  { dispW: BRAND_DISPLAY_W, square: false, ratio: 180 / 87, ratioNote: "shell.js 里 width/height 声明的 180:87" });
const favSize = checkAsset("站点图标", "static/logo.png",
  { dispW: FAVICON_DISPLAY, square: true });

/* ------------------------------------------------------ 2. 渲染出的结构 */

section("2. 侧栏渲染：一张整图，不再有站名 / 副标题文字");

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
  checkTrue("带 brand-img 类", /class="brand-img"/.test(img[0]), img[0]);
  checkTrue("src 指向 brand.png", /src="brand\.png"/.test(img[0]), img[0]);
  /* alt 不能空：图挂了时至少要说出这是什么，而不是一片空白 */
  checkTrue("alt 非空", /alt="[^"]+"/.test(img[0]), img[0]);
  /* 宽高写在标签属性上（不只是 CSS）—— 图未解码完时侧栏不会先塌再跳 */
  const mw = img[0].match(/\bwidth="(\d+)"/), mh = img[0].match(/\bheight="(\d+)"/);
  checkTrue("有 width/height 属性（防布局跳动）", !!mw && !!mh, img[0]);
  /* 声明的宽高比必须与实际图片一致，否则浏览器会把图**拉伸变形**
     （只在 CSS 给了固定宽或高时才会暴露，肉眼要盯着看才发现） */
  if (mw && mh && brandSize) {
    const declared = Number(mw[1]) / Number(mh[1]);
    const actual = brandSize.w / brandSize.h;
    checkTrue("声明的宽高比 = 图片实际宽高比（防拉伸变形）",
      Math.abs(declared - actual) < 0.02,
      declared.toFixed(3) + " vs " + actual.toFixed(3));
  }
}

/* 换成整图后，站名与副标题都在图里了。HTML 里再冒出文字节点，就是"图 + 重复文字"。 */
section("3. 站名/副标题必须只存在于图里（HTML 里不该再有第二份）");
/* 只看**属性形态**，不看注释 —— shell.js 的注释里正当地提到了这些已删除的类名。 */
["brand-mark", "brand-sub", "brand-tx"].forEach(function (cls) {
  checkTrue("侧栏 HTML 里不再有 " + cls, sidebar.indexOf('class="' + cls) < 0,
    sidebar.indexOf('class="' + cls) < 0 ? "已清" : "又出现了");
});
checkTrue("侧栏里没有裸的中文站名文本节点（重复）",
  !/<div class="brand">[\s\S]*?[\u4e00-\u9fa5]+[\s\S]*?<\/div>/.test(sidebar.replace(/alt="[^"]*"/g, "")),
  "已清");

/* ------------------------------------------------------ 4. 样式 */

section("4. 样式：.brand-img 与窄屏覆盖");

const css = read("static/style.css");

/** 取某选择器的规则体 */
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
function cssVar(name) {
  const m = css.match(new RegExp("--" + name + "\\s*:\\s*(#[0-9a-fA-F]{3,8})\\s*;"));
  return m ? m[1].toLowerCase() : null;
}

const IMG_RULE = ruleBody(".brand-img");
checkTrue(".brand-img 有规则块", !!IMG_RULE, IMG_RULE ? "OK" : "缺失");
if (IMG_RULE) {
  check("display:block（去掉行内基线的额外行高）", prop(IMG_RULE, "display"), "block");
  check("height:auto（按图片自身比例，不硬拉）", prop(IMG_RULE, "height"), "auto");
  check("max-width 与断言里的显示宽一致", prop(IMG_RULE, "max-width"), BRAND_DISPLAY_W + "px");
}

const narrow = css.slice(css.indexOf("@media(max-width:760px)"));
checkTrue("窄屏媒体查询里覆盖了 .brand-img 宽度（顶部横条高度有限）",
  /\.brand-img\s*\{[^}]*width/.test(narrow), "找到覆盖规则");
checkTrue("窄屏 .brand 去掉了内边距",
  /\.brand\s*\{[^}]*padding\s*:\s*0/.test(narrow), "找到覆盖规则");

/* ------------------------------- 5. 换整图后的残留要清干净 */

section("5. 文字版留下的类与历史分色类都必须清干净（半途回退最丑）");

/* 曾经有 .brand-logo / .brand-mark / .brand-sub（小图 + 站名 + 副标题的 lockup），
   更早还有 .bd / .bn / .bo 三个按字位分色的类。换整图后这些都该消失 ——
   留着就是死样式：不生效，但下次有人翻到会以为还有用。
   注意 ruleBody 只认 `selector {` 形态，注释里提到的类名不会误报。 */
[".brand-logo", ".brand-mark", ".brand-sub", ".brand-tx",
 ".brand-mark .bd", ".brand-mark .bn", ".brand-mark .bo"].forEach(function (sel) {
  const r = ruleBody(sel);
  checkTrue("CSS 里不再有 " + sel + " 规则", r === null, r === null ? "已清" : "残留：" + r);
});
checkTrue("--brand-dawn 变量已移除", cssVar("brand-dawn") === null, String(cssVar("brand-dawn")));
checkTrue("--brand-night 变量已移除", cssVar("brand-night") === null, String(cssVar("brand-night")));
checkTrue("白字用的 @supports 兜底描边块也一并移除（没有白字了）",
  css.indexOf("@supports not (-webkit-text-stroke") < 0, "已清");

console.log("");
if (fail === 0) { console.log("全部通过 \u2713  (" + pass + " 项断言)"); process.exit(0); }
console.log("有失败项 \u2717  (" + fail + " 项失败 / " + (pass + fail) + " 项)"); process.exit(1);
