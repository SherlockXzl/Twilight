#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成「期股双面」静态预览页 —— 单文件、可离线打开、不需要重启服务。

为什么要有这个东西
------------------
`/duality` 这个页面**必须重启服务**才会出现（`server.py` 是新代码，nohup 起的
进程不会自己重载，见 tools/start.sh 的说明）。而"改完想看一眼效果"是高频动作，
每次都要求用户"去终端敲一条命令再回来"很别扭。

于是把三样东西打成一个 HTML：
  ① `static/` 下的**真实**前端代码（style.css / util.js / icons.js / duality.js）
  ② `data/duality_cache.json` 的**真实**数据快照（800 根日线，六只标的）
  ③ 两个桩：`Shell`（只渲染侧栏 + 页头，不做任何取数）和 `fetch`（把快照当接口响应）

所以预览页里**图和表的每一条线、每一个数字都是真实数据**，只有"数据是怎么送到
页面上的"这一段是桩。要看真接口，重启服务后开 http://127.0.0.1:8787/duality 。

一个踩过的坑（2026-10-08）
-------------------------
`fetch_all()` 落盘的 payload **不带 `schema`** —— 那个字段是 `server.py` 的
`_duality()` 在返回前补的（前端要靠它做版本握手：对不上就报"服务需要重启"）。
最初生成预览页时直接把 `duality_cache.json` 塞进桩里，结果页面弹出黄条
「服务返回的结构与本页不匹配（页面需要 v1，收到 非 JSON 响应）」——
看起来像"桩写坏了"，实际是**快照少一个字段**。
现在脚本自己补 `schema`，并且会校验 `server.py` 与 `duality.js` 两处的版本号是否一致。

用法
----
    python3 tools/make_duality_preview.py [输出路径]

输出路径缺省为 <项目根>/duality-preview.html。
"""

import base64
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
CACHE = ROOT / "data" / "duality_cache.json"
DEFAULT_OUT = ROOT / "duality-preview.html"

#: 内联进 <script> 的 JSON 里若出现 `</`，浏览器会当成脚本块提前闭合。
#: 日线数据本身不含尖括号，但这里统一处理，免得以后加字段时踩雷。
def js_inline(s):
    return s.replace("</", "<\\/")


def read_text(p):
    return Path(p).read_text(encoding="utf-8")


def grab_schema(path, label):
    m = re.search(r"DUALITY_SCHEMA\s*=\s*(\d+)", read_text(path))
    if not m:
        raise SystemExit("✗ 在 %s 里没找到 DUALITY_SCHEMA（%s）" % (path, label))
    return int(m.group(1))


def grab_nav_labels():
    """从 shell.js 的 NAV 里抽菜单文字，免得这里的桩和真菜单各写一份、以后对不上。"""
    txt = read_text(STATIC / "shell.js")
    block = re.search(r"var NAV = \[(.*?)\];", txt, re.S)
    if not block:
        raise SystemExit("✗ 在 shell.js 里没找到 NAV 数组")
    return re.findall(r'label:\s*"([^"]+)"', block.group(1))


SHELL_STUB = """/* 预览用的壳桩：只把侧栏和页头画出来，不做任何取数。
 *
 * 不直接用真的 shell.js，是因为它 mount() 之后会去查 /api/status 并按模式挂定时器 ——
 * 对一个离线快照页来说，这些全是噪音。这里只还原**版面**：
 * 菜单文字从 shell.js 的 NAV 里抽（见生成脚本），选中态固定在「期股双面」。
 * 页头与真页头一致（见 shell.js 的 renderHeader 的 duality 分支）：
 * **只有「取数时间」一个徽章 + 一个「立即刷新」按钮**。市场状态与「数据截止」
 * 于 2026-10-08 按用户要求去掉；内容区那个「重新取数」同日搬到页头并改名 ——
 * 所以这里必须同时有 `duRefresh` 按钮，否则 duality.js 的 bindHeaderRefresh()
 * 会拿不到元素（桩和真页头不一样，预览就失去意义了）。
 */
(function (w) {
  "use strict";
  var NAV = %(nav)s;
  var ACTIVE = "期股双面";
  w.Shell = {
    state: {},
    mount: function () {
      var sb = document.getElementById("sidebar");
      if (sb) {
        var items = NAV.map(function (n) {
          return '<a class="nav-item' + (n === ACTIVE ? " on" : "") + '" href="#"><span class="nav-text">'
            + n + "</span></a>";
        }).join("");
        sb.innerHTML = '<div class="brand"><img class="brand-img" width="180" height="87" src="'
          + document.getElementById("__logo").textContent + '" alt="晨昏线"></div>'
          + '<nav class="nav">' + items + "</nav>";
      }
      var hd = document.getElementById("pageHeader");
      if (hd) {
        hd.innerHTML = '<div class="top-left"><h1>期股双面</h1></div>'
          + '<div class="badges">'
          + '<span class="badge">取数时间 <b id="duTime">—</b></span>'
          + '<button id="duRefresh" class="primary">立即刷新</button>'
          + "</div>"
          + '<div id="toastBox" class="toast-box"></div>';
      }
      document.title = "期股双面 · 晨昏线";
    }
  };
})(window);
"""

FETCH_STUB = """/* fetch 桩：把快照当成 /api/duality 的响应。
 *
 * 关键点：payload **必须带 schema** —— 前端靠它做版本握手，对不上就会报
 * 「服务需要重启」。快照文件里本来没有这个字段（真接口是 server.py 补的），
 * 生成脚本在这里补上，值取自 duality.js 自己的 DUALITY_SCHEMA。
 *
 * 顺带把 /api/status 也答了：万一日后预览页换成真的 shell.js，这个桩能接住。
 */
(function (w) {
  "use strict";
  var DU = %(payload)s;
  var STATUS = %(status)s;
  w.fetch = function (url) {
    var isDuality = String(url).indexOf("/api/duality") === 0;
    var body = isDuality ? DU : STATUS;
    return Promise.resolve({
      ok: true,
      status: 200,
      text: function () { return Promise.resolve(JSON.stringify(body)); },
      json: function () { return Promise.resolve(body); }
    });
  };
})(window);
"""


def build():
    schema = grab_schema(STATIC / "duality.js", "前端")
    server_schema = grab_schema(ROOT / "server.py", "服务端")
    if schema != server_schema:
        raise SystemExit(
            "✗ 版本号不一致：duality.js=%d，server.py=%d。\n"
            "  两边必须一起改（见 README「版本握手」一节）。" % (schema, server_schema)
        )

    if not CACHE.exists():
        raise SystemExit("✗ 没有数据快照：%s\n  先在项目里跑一次取数（进 /duality 页或直接调 duality.fetch_all()）。" % CACHE)

    cache = json.loads(read_text(CACHE))
    items = cache.get("items") or []
    if not items:
        raise SystemExit("✗ 快照里没有标的（items 为空），不生成预览页。")

    # 快照 → 接口响应。schema 放最前面，跟 server.py 的 _duality() 一个形状。
    payload = {"schema": schema}
    payload.update({k: v for k, v in cache.items() if k != "schema"})

    generated = cache.get("generatedAt") or "—"
    n_pts = len(items[0].get("dates") or [])

    css = read_text(STATIC / "style.css")
    js_util = read_text(STATIC / "util.js")
    js_icons = read_text(STATIC / "icons.js")
    js_duality = read_text(STATIC / "duality.js")
    logo = base64.b64encode((STATIC / "brand.png").read_bytes()).decode("ascii")

    nav_js = json.dumps(grab_nav_labels(), ensure_ascii=False)
    shell_stub = SHELL_STUB % {"nav": nav_js}
    status_stub = {
        "ok": True,
        "market": {"open": False, "label": "休市中"},
        "generatedAt": generated,
    }
    fetch_stub = FETCH_STUB % {
        "payload": js_inline(json.dumps(payload, ensure_ascii=False)),
        "status": js_inline(json.dumps(status_stub, ensure_ascii=False)),
    }

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>期股双面 · 静态预览</title>
<style>
{css}

/* ---------- 预览页自己的说明条（不属于站点样式，真页面里没有这一段）---------- */
.pv-bar{{position:fixed;right:18px;bottom:18px;z-index:99;max-width:440px;
  background:#fff8ea;border:1px solid #f0dcb4;color:#6b4a00;border-radius:10px;
  padding:10px 14px;font-size:13px;line-height:1.7;box-shadow:0 6px 20px rgba(16,24,40,.12)}}
.pv-bar b{{font-weight:600}}
.pv-bar code{{background:#fff;border:1px solid #f0dcb4;border-radius:4px;padding:0 4px;
  font-size:12px}}
</style>
</head>
<body>
<!-- 站点标内联成 data URI，预览页不依赖任何外部文件 -->
<template id="__logo">data:image/png;base64,{logo}</template>

<div class="app">
  <aside class="sidebar" id="sidebar"></aside>
  <main class="main">
    <header class="top" id="pageHeader"></header>
    <div class="panel" id="notice" style="display:none"></div>
    <div class="tabs tabs--page" id="tabs"></div>
    <div id="dualityHost"><div class="empty">加载中…</div></div>
  </main>
</div>

<div class="pv-bar">
  <b>静态预览</b>　真实页面代码 + {generated} 的数据快照（{len(items)} 只标的 × {n_pts} 根日线）<br>
  正式页面：<b>http://127.0.0.1:8787/duality</b>　需要先重启服务：<code>bash tools/start.sh --restart</code>
</div>

<script>
{js_util}
</script>
<script>
{js_icons}
</script>
<script>
{shell_stub}
</script>
<script>
{fetch_stub}
</script>
<script>
{js_duality}
</script>
</body>
</html>
"""


def main():
    out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_OUT
    html = build()
    out.write_text(html, encoding="utf-8")
    kb = len(html.encode("utf-8")) / 1024
    print("✓ 已生成 %s（%.0f KB）" % (out, kb))


if __name__ == "__main__":
    main()
