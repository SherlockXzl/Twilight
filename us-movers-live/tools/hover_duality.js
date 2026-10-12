#!/usr/bin/env node
/* 「期股双面」悬停交互的**真机验证**（headless Chrome + CDP）。
 *
 * 为什么单开一个，不并进 test_duality_*.js
 * ----------------------------------------
 * 那三个用例跑的是 **DOM 桩**，它们**看不见 CSS 层叠**。2026-10-08 踩到的就是这一条：
 * `.dp-tip` 的 CSS 初始态是 `display:none`，JS 却用 `tip.style.display = ""` 去"显示"它 ——
 * 清空 inline 值等于把决定权交回 CSS，于是又变回 none，**提示框从上线起就没显示过**。
 * 而三个桩用例全是绿的（`innerHTML` 有内容就算过），用户提了两次才发现。
 *
 * 所以这一层得用真浏览器补上，而且是**三条一起对**：
 *   DOM 说"有" → 层叠样式说"可见" → **像素说"画了"**。
 * 只看前两条会漏掉"被盖住 / 在视口外 / 祖先有 transform"，只看第三条说不出为什么。
 *
 * 用法
 * ----
 *   node tools/hover_duality.js [url]        默认 http://127.0.0.1:8787/duality
 *   node tools/hover_duality.js file:///.../duality-preview.html
 *
 * 它做四件事：切到 90 天（7 天里 A 股只有 1 个交易日、画不出多条线）→
 * 逐条线**发真实鼠标事件**（CDP `Input.dispatchMouseEvent`，不是页面内 dispatchEvent，
 * 后者绕过浏览器自己的 mouseover 生成逻辑）→ 检查提示框/标签/加粗 → 最后一条线上
 * 做**悬停前后逐像素比对**。
 *
 * 退出码：0 = 全部正常；1 = 有异常；2 = 用法/环境错误。
 * **不进 `tools/test_all.sh`**：它要开真浏览器、十几秒，而且依赖本机装了 Chrome。
 * 改过悬停、标签、提示框、折线样式之后，手动跑一次。
 */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const URL_ = process.argv[2] || "http://127.0.0.1:8787/duality";
const CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error("找不到 Chrome（这个脚本必须有真浏览器）"); process.exit(2); }

const PORT = 9344;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP_BEFORE = path.join(os.tmpdir(), "du_hover_before.png");
const TMP_AFTER = path.join(os.tmpdir(), "du_hover_after.png");

// ---------------------------------------------------------------- PNG 解码
// 只用来做"两张图有没有差异"，犯不上引三方库。
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
  const stride = w * ch, rows = [];
  let prev = Buffer.alloc(stride), i = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[i++];
    const line = Buffer.from(raw.subarray(i, i + stride)); i += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v = (v + a) & 255; else if (f === 2) v = (v + b) & 255;
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
      const ia = x * a.ch, ib = x * b.ch;
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
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); this.events = new Map(); }
  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws 连接失败")); });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = c.pend.get(m.id); c.pend.delete(m.id);
        if (p) m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      } else { const arr = c.events.get(m.method); if (arr) arr.splice(0).forEach((fn) => fn(m.params)); }
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
  once(method, timeout = 20000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("等 " + method + " 超时")), timeout);
      const fn = (p) => { clearTimeout(t); res(p); };
      if (!this.events.has(method)) this.events.set(method, []);
      this.events.get(method).push(fn);
    });
  }
  async evalJS(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  }
  async shot(file) {
    const r = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  }
}

// ---------------------------------------------------------------- 主流程
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "duhover-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    "--window-size=1600,1200", "--force-device-scale-factor=2", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  let target = null;
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === "page");
      if (target) break;
    } catch (e) { /* 还没起来 */ }
    await sleep(120);
  }
  if (!target) { chrome.kill(); throw new Error("Chrome 调试端口没起来"); }

  const cdp = await CDP.attach(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width: 1600, height: 1200, deviceScaleFactor: 2, mobile: false });

  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: URL_ });
  await loaded;
  await sleep(3500);   // 真实接口要跑源链取数，别急着断言

  // ---- 切到 90 天：7 天里 A 股只有 1 个交易日，其余五条退化成单点、画不出 polyline ----
  const clicked = await cdp.evalJS(`(() => {
    const b = document.querySelector('.dp-ranges [data-k="90"]');
    if (!b) return "没找到 90 天标签";
    b.click(); return "已点 90 天";
  })()`);
  console.log("切范围      :", clicked);
  await sleep(700);

  console.log("\n=== 期货虚线 / 图例线型 ===");
  const dash = await cdp.evalJS(`(() => {
    const out = { lines: [] };
    document.querySelectorAll('#dpChart svg polyline[data-k]').forEach(p => {
      out.lines.push({ k: p.getAttribute('data-k'), dash: p.getAttribute('stroke-dasharray') || '(实线)' });
    });
    out.legend = [...document.querySelectorAll('.dp-pick')].map(l => {
      const key = l.querySelector('.dp-key');
      return {
        n: l.querySelector('.dp-pick-n').textContent,
        bg: key ? getComputedStyle(key).backgroundImage.slice(0, 46) : '无 .dp-key',
      };
    });
    out.dotLeft = document.querySelectorAll('.dp-picks .dp-dot').length;
    return out;
  })()`);
  if (!dash.lines.length) { console.log("✗ 图上没有折线，后面的悬停验证没有意义"); cdp.ws.close(); chrome.kill(); process.exit(1); }
  dash.lines.forEach(l => console.log("  " + l.k.padEnd(8) + " " + l.dash));
  console.log("  图例（.dp-dot 残留数应为 0，实际 " + dash.dotLeft + "）:");
  dash.legend.forEach(l => console.log("    " + l.n.padEnd(6) + " " + l.bg));

  // ---- 取每条线一个真实数据点的屏幕坐标 ----
  // 坐标必须用 getScreenCTM() 换算：SVG 有 viewBox 且会被 max-width 缩，手算必错。
  const marks = await cdp.evalJS(`(() => {
    const out = [];
    document.querySelectorAll('#dpChart svg polyline[data-k]').forEach(p => {
      const pts = (p.getAttribute('points')||'').split(' ').filter(Boolean);
      if (pts.length < 2) return;
      const xy = pts[Math.floor(pts.length * 0.55)].split(',').map(Number);
      const svg = p.ownerSVGElement;
      const pt = svg.createSVGPoint(); pt.x = xy[0]; pt.y = xy[1];
      const sp = pt.matrixTransform(p.getScreenCTM());
      out.push({ k: p.getAttribute('data-k'), x: Math.round(sp.x), y: Math.round(sp.y), n: pts.length });
    });
    return out;
  })()`);
  console.log("\n=== 各线取样点（屏幕坐标）===");
  marks.forEach(m => console.log("  " + m.k.padEnd(8) + " (" + m.x + "," + m.y + ") 点数=" + m.n));

  // ---- 基准图：鼠标先挪到角落，确保"没有任何悬停" ----
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5, buttons: 0 });
  await sleep(250);
  await cdp.shot(TMP_BEFORE);

  let pass = 0, fail = 0;
  for (const m of marks) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5, buttons: 0 });
    await sleep(150);
    // 两次移动（先到附近再到中心）：确保浏览器自己生成完整的 mouseover 链
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: m.x - 2, y: m.y - 2, buttons: 0 });
    await sleep(60);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: m.x, y: m.y, buttons: 0 });
    await sleep(450);

    const st = await cdp.evalJS(`(() => {
      const tip = document.getElementById('dpTip');
      const g = document.getElementById('dpHoverG');
      const cs = getComputedStyle(tip);
      const r = tip.getBoundingClientRect();
      const lines = [...document.querySelectorAll('#dpChart svg polyline[data-k]')].map(p => ({
        k: p.getAttribute('data-k'), op: p.getAttribute('opacity'), sw: p.getAttribute('stroke-width') }));
      const tag = document.querySelector('#dpHoverG .dp-tag');
      return {
        disp: cs.display, vis: cs.visibility, opa: cs.opacity,
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        text: tip.textContent.replace(/\\s+/g,' ').trim(),
        firstOn: tip.querySelector('.dp-tip-r--on') ? tip.querySelector('.dp-tip-r--on').textContent.replace(/\\s+/g,' ').trim() : null,
        hoverLen: g.innerHTML.length,
        tag: tag ? { t: tag.textContent, fill: getComputedStyle(tag).fill, stroke: getComputedStyle(tag).stroke } : null,
        lines: lines,
      };
    })()`);

    const emph = st.lines.find(l => l.op === '1' && l.sw === '3.4');
    const checks = {
      "提示框可见(display≠none)": st.disp !== 'none' && st.vis !== 'hidden' && st.opa !== '0',
      "提示框有尺寸": st.rect.w > 100 && st.rect.h > 40,
      "竖线/高亮点已画": st.hoverLen > 0,
      "该线加粗压暗": !!emph && emph.k === m.k,
      "指着的那行置顶": !!st.firstOn,
      "线上有名称标签": !!st.tag,
      "标签是白描边(六色靠 fill 区分)": !!st.tag && st.tag.stroke === 'rgb(255, 255, 255)',
    };
    const allOk = Object.values(checks).every(Boolean);
    allOk ? pass++ : fail++;
    console.log("\n--- 指向 " + m.k + " --- " + (allOk ? "✓" : "✗"));
    console.log("  display=" + st.disp + " visibility=" + st.vis + " opacity=" + st.opa +
                "  盒子 " + st.rect.w + "x" + st.rect.h + " @(" + st.rect.x + "," + st.rect.y + ")");
    console.log("  加粗的线 :", emph ? emph.k : "无");
    console.log("  置顶行   :", st.firstOn || "无");
    console.log("  线上标签 :", st.tag ? '"' + st.tag.t + '" fill=' + st.tag.fill + ' stroke=' + st.tag.stroke : "无");
    console.log("  提示框文字:", st.text.slice(0, 130));
    console.log("  各项     :", Object.entries(checks).map(([k, v]) => (v ? "✓" : "✗") + k).join("  "));

    // ---- 像素判据：只在最后一条线上做（省一次全图解码）----
    // 这是**决定性**的一条：元素存在 + 样式可见，都不等于它被画出来了。
    if (m === marks[marks.length - 1] && st.rect.w > 0) {
      await cdp.shot(TMP_AFTER);
      const A = decodePng(fs.readFileSync(TMP_BEFORE)), B = decodePng(fs.readFileSync(TMP_AFTER));
      const s = 2;   // dpr
      const d = regionDiff(A, B, (st.rect.x - 4) * s, (st.rect.y - 4) * s,
        (st.rect.x + st.rect.w + 4) * s, (st.rect.y + st.rect.h + 4) * s);
      console.log("  【像素】提示框区域悬停前后差异: " + d.n + " 像素（最大通道差 " + d.maxd + "）→ " +
        (d.n > 200 ? "PAINT: 确实画出来了 ✓" : "PAINT: 没画出来 ✗"));
      d.n > 200 ? pass++ : fail++;
    }
  }

  console.log("\n=== 结论 ===");
  console.log(pass + " 项通过，" + fail + " 项异常");
  console.log("截图: " + TMP_AFTER + "（悬停后） / " + TMP_BEFORE + "（悬停前基准）");
  cdp.ws.close();
  chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("✗ " + e.message); process.exit(2); });
