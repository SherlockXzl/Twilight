#!/usr/bin/env node
/* 悬停类 UI 的「真实输入 + 截图」校验工具。
 *
 * ⚠️ 这个脚本在用户级技能 `headless-ui-verify` 里还有一份通用版
 *    （`~/.workbuddy/skills/headless-ui-verify/scripts/hover_check.js`，
 *    注释里不带本项目信息）。**改逻辑要两边一起改** —— 只改一份时另一份会静默
 *    停在旧逻辑上，脚本本身照样跑得动、不报错，于是"用它验出来"的结论是错的。
 *    两份的比对办法写在那个技能的 SKILL.md 里。
 *
 * 为什么需要它
 * ------------
 * `visual_check.py shot` 只是 `chrome --screenshot`，它**不会把鼠标放到任何地方**，
 * 所以任何"悬停才出现"的元素（本项目的 .biztip 悬停卡、各种 tooltip）在那张图里
 * 永远是空的。而 `--dump-dom` 只能证明 DOM 生成了，证明不了它被画出来 ——
 * 2026-09-28 就在这个缝里卡了很久：DOM 里卡片内容、位置都对，截图里却什么都没有。
 *
 * 这个脚本用 CDP 把一件事做全：发**真实的鼠标移动事件**（不是页面内 dispatchEvent，
 * 那会绕过浏览器自己的 mouseover 生成逻辑），等一会儿，然后把
 *   「元素的属性 + 层叠样式 + 盒子 + 是否被画出来」
 * 一次性打出来，最后再截一张图。DOM 说"有"、样式说"可见"、像素说"画了"，
 * 三者对得上才算真的好了。
 *
 * 用法
 * ----
 *   node tools/hover_check.js <url> <css选择器> [-o out.png] [--wait 400] [--dpr 2]
 *
 *   例：node tools/hover_check.js http://127.0.0.1:8791/morning \
 *         '.movers td.code[data-biztip]' -o /tmp/hover.png
 *
 * 输出里 `PAINT: 有差异` / `PAINT: 无差异` 是**决定性**的一行：
 * 它把"悬停"与"不悬停"两张图在目标区域内逐像素比了一次。无差异 = 确实没画出来，
 * 此时前面的 DOM/样式诊断会告诉你卡在哪一环。
 *
 * 退出码：0 = 卡片确实被画出来了；1 = 没画出来（上面会说明原因）。
 * 只用 Node 内置能力（global fetch + global WebSocket），无第三方依赖。
 */
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error("找不到 Chrome"); process.exit(2); }

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2);
const pos = [];
const opt = { out: "", wait: 400, dpr: 2, w: 1600, h: 1200, port: 9333, clicks: [], settle: 2500 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-o" || a === "--out") opt.out = argv[++i];
  else if (a === "--wait") opt.wait = Number(argv[++i]);
  else if (a === "--dpr") opt.dpr = Number(argv[++i]);
  else if (a === "--settle") opt.settle = Number(argv[++i]);
  else if (a === "--click") opt.clicks.push(argv[++i]);
  else if (a === "--size") { const s = argv[++i].split("x"); opt.w = +s[0]; opt.h = +s[1]; }
  else if (a === "--port") opt.port = Number(argv[++i]);
  else pos.push(a);
}
const [url, selector] = pos;
if (!url || !selector) {
  console.error("用法: node tools/hover_check.js <url> <css选择器> [-o out.png] [--wait 400] [--click 标签选择器]");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 解码 PNG（只做"两张图有没有差异"，用不着完整解码）
// 直接用 Chrome 的 Page.captureScreenshot 给的 PNG；这里偷懒用 zlib 解回来。
const zlib = require("zlib");
function decodePng(buf) {
  let pos = 8, idat = [], w = 0, h = 0, bd = 0, ct = 0;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const typ = buf.toString("ascii", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (typ === "IHDR") { w = body.readUInt32BE(0); h = body.readUInt32BE(4); bd = body[8]; ct = body[9]; }
    else if (typ === "IDAT") idat.push(body);
    else if (typ === "IEND") break;
    pos += 12 + len;
  }
  if (bd !== 8 || (ct !== 2 && ct !== 6)) throw new Error("只支持 8 位 RGB/RGBA");
  const ch = ct === 2 ? 3 : 4;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const rows = [];
  let prev = Buffer.alloc(stride);
  let i = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[i++];
    const line = Buffer.from(raw.subarray(i, i + stride)); i += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      line[x] = v;
    }
    rows.push(line); prev = line;
  }
  return { w, h, ch, rows };
}

function regionDiff(a, b, x0, y0, x1, y1) {
  let n = 0, maxd = 0;
  for (let y = Math.max(0, y0); y < Math.min(a.h, b.h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(a.w, b.w, x1); x++) {
      const ia = x * a.ch, ib = x * b.ch;   // rows 每行是完整 stride
      const d = Math.abs(a.rows[y][ia] - b.rows[y][ib]) + Math.abs(a.rows[y][ia + 1] - b.rows[y][ib + 1]) +
                Math.abs(a.rows[y][ia + 2] - b.rows[y][ib + 2]);
      if (d > 12) n++;
      if (d > maxd) maxd = d;
    }
  }
  return { n, maxd };
}

// ---------------------------------------------------------------- CDP 极简客户端
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); this.events = new Map(); this.buf = []; }
  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error("ws 连接失败")); });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = c.pend.get(m.id); c.pend.delete(m.id);
        if (p) m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      } else {
        const arr = c.events.get(m.method); if (arr) arr.splice(0).forEach((fn) => fn(m.params));
      }
    };
    return c;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pend.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  once(method, timeout = 15000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("等 " + method + " 超时")), timeout);
      const fn = (p) => { clearTimeout(t); res(p); };
      if (!this.events.has(method)) this.events.set(method, []);
      this.events.get(method).push(fn);
    });
  }
  async evalJS(expr) {
    const r = await this.send("Runtime.evaluate", {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
    return r.result.value;
  }
  async shot(file) {
    const r = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  }
}

// ---------------------------------------------------------------- 主流程
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "hovercheck-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    `--remote-debugging-port=${opt.port}`, `--user-data-dir=${profile}`,
    `--window-size=${opt.w},${opt.h}`, `--force-device-scale-factor=${opt.dpr}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  let stderrTail = "";
  chrome.stderr.on("data", (d) => { stderrTail += d.toString(); });

  const base = `http://127.0.0.1:${opt.port}`;
  let target = null;
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(base + "/json/list")).json();
      target = list.find((t) => t.type === "page");
      if (target) break;
    } catch (e) { /* 还没起来 */ }
    await sleep(120);
  }
  if (!target) { chrome.kill(); throw new Error("Chrome 调试端口没起来\n" + stderrTail); }

  const cdp = await CDP.attach(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width: opt.w, height: opt.h, deviceScaleFactor: opt.dpr, mobile: false });

  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url });
  await loaded;
  // 页面自己的取数是异步的（要等 /api 回来才渲染表格）
  await sleep(opt.settle);

  // ---- 先切到目标所在的标签页 / 展开折叠区（否则目标在 display:none 里，矩形是 0×0）----
  for (const sel of opt.clicks) {
    const r = await cdp.evalJS(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return "没找到";
      el.click();
      return "已点击";
    })()`);
    console.log(`预点击      : ${sel} → ${r}`);
    await sleep(600);
  }

  // ---- 找目标、滚到可见处 ----
  const info = await cdp.evalJS(`(() => {
    const all = [...document.querySelectorAll(${JSON.stringify(selector)})];
    if (!all.length) return { err: "选择器没命中任何元素（共 0 个）" };
    const vis = all.find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    if (!vis) return { err: "命中了 " + all.length + " 个元素，但**全部不可见**（宽高为 0）" +
                                 " —— 多半还藏在没打开的标签页/折叠区里，用 --click 先切过去" };
    vis.scrollIntoView({ block: "center" });
    const r = vis.getBoundingClientRect();
    return {
      sym: vis.getAttribute("data-biztip"),
      text: (vis.textContent || "").trim(),
      cx: Math.round(r.left + r.width / 2),
      cy: Math.round(r.top + r.height / 2),
      rect: { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    };
  })()`);
  if (info.err) { console.log("✗ " + info.err); chrome.kill(); process.exit(1); }
  console.log(`目标        : ${selector}  →  ${info.text}（data-biztip=${info.sym}）`);
  console.log(`格子中心    : (${info.cx}, ${info.cy})  盒子 ${info.rect.w}x${info.rect.h}`);

  await sleep(300);

  // ---- 先拍一张"没悬停"的基准图 ----
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5, buttons: 0 });
  await sleep(200);
  const before = path.join(os.tmpdir(), "hover_before.png");
  await cdp.shot(before);

  // ---- 真实鼠标移上去（先到附近再到中心：确保浏览器自己生成 mouseover）----
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: info.cx - 2, y: info.cy - 2, buttons: 0 });
  await sleep(60);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: info.cx, y: info.cy, buttons: 0 });
  await sleep(opt.wait);        // > biztip.DELAY(120ms)

  // ---- 诊断：DOM / 层叠样式 / 盒子 ----
  const diag = await cdp.evalJS(`(() => {
    const n = document.querySelector(".biztip");
    if (!n) return { exists: false };
    const cs = getComputedStyle(n);
    const r = n.getBoundingClientRect();
    return {
      exists: true,
      hidden: n.hidden,
      hasAttr: n.hasAttribute("hidden"),
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      position: cs.position, zIndex: cs.zIndex,
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      inViewport: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth,
      topElement: (() => { const e = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2); return e ? e.className + "/" + e.tagName : null; })(),
      text: (n.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120),
      html: n.outerHTML.slice(0, 300),
    };
  })()`);

  console.log("\n--- .biztip 诊断 ---");
  if (!diag.exists) {
    console.log("DOM 里没有 .biztip 元素 —— 卡片压根没被创建（取数没成功？数据里没这家？）");
  } else {
    console.log(`hidden=${diag.hidden}  display=${diag.display}  visibility=${diag.visibility}  opacity=${diag.opacity}`);
    console.log(`position=${diag.position}  z-index=${diag.zIndex}`);
    console.log(`盒子          : ${diag.rect.w}x${diag.rect.h} @ (${diag.rect.x}, ${diag.rect.y})  在视口内=${diag.inViewport}`);
    console.log(`该处最上层元素: ${diag.topElement}`);
    console.log(`文字          : ${diag.text}`);
  }

  const afterPNG = path.join(os.tmpdir(), "hover_after.png");
  await cdp.shot(afterPNG);

  // ---- 决定性判据：悬停前后，卡片所在区域像素有没有变化 ----
  let verdict = "no-card";
  if (diag.exists && diag.rect.w > 0) {
    const A = decodePng(fs.readFileSync(before));
    const B = decodePng(fs.readFileSync(afterPNG));
    const s = opt.dpr;
    const d = regionDiff(A, B,
      Math.round(diag.rect.x * s) - 4, Math.round(diag.rect.y * s) - 4,
      Math.round((diag.rect.x + diag.rect.w) * s) + 4, Math.round((diag.rect.y + diag.rect.h) * s) + 4);
    console.log(`\n悬停前后卡片区域像素差异: ${d.n} 个像素（最大通道差 ${d.maxd}）`);
    verdict = d.n > 200 ? "painted" : "not-painted";
    console.log(verdict === "painted" ? "PAINT: 有差异 ✓ 卡片确实被画出来了" : "PAINT: 无差异 ✗ 卡片没被画出来");
    if (verdict === "not-painted") {
      console.log("\n可能原因（按常见程度）:");
      console.log("  · 元素带 hidden / display:none / visibility:hidden（看上面的诊断）");
      console.log("  · 被别的元素盖住了（看『该处最上层元素』）");
      console.log("  · z-index 落在某个层叠上下文里（卡片若被放进有 transform/filter 的祖先内会这样）");
      console.log("  · 位置在视口外（inViewport=false）");
    }
  } else {
    console.log("\n没有可测的卡片矩形。");
  }

  if (opt.out) {
    fs.copyFileSync(afterPNG, opt.out);
    console.log(`\n截图: ${opt.out}（悬停后） / ${before}（悬停前基准）`);
  } else {
    console.log(`\n截图: ${afterPNG}（悬停后） / ${before}（悬停前基准）`);
  }

  cdp.ws.close();
  chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  process.exit(verdict === "painted" ? 0 : 1);
})().catch((e) => { console.error("✗ " + e.message); process.exit(2); });
