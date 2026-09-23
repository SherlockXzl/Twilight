#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""美股夜盘异动 —— 后端服务（仅用标准库，零依赖）

    python3 server.py                 # 默认 http://127.0.0.1:8787
    SOURCE=mock python3 server.py     # 离线演示

环境变量：
    PORT                 监听端口，默认 8787
    SOURCE               数据源：finviz（默认，无需 Key）/ mock
    BIG_MIN_CAP_USD      大市值档下限，默认 1e10
    MID_MIN_CAP_USD      小市值档下限，默认 1.5e9
    BIG_PCT / MID_PCT    涨跌幅阈值，默认 4 / 10

本页口径是**美股夜盘**（美东周日至周四 20:00–04:00 = 北京 08:00–16:00，夏令时），
由 `night_fetch.py` 负责时段窗口与扫描：
    · 夜盘进行中 —— 按 `NIGHT_POLL_SECONDS` 轮询，显示**实时**夜盘数据
    · 夜盘已收盘 —— 冻结一份收盘快照（`data/night_close.json`），非夜盘时间就显示它
需要手动取一轮可调 `GET /api/refresh`（页面上的「立即刷新」）。

数据源是 Alpaca（免费 Paper 账号即可，见 README「夜盘数据源」）——
Finviz 的涨跌幅一律是**常规时段**的，与夜盘无关，连它的 Elite 档也不覆盖
美东 20:00–04:00 那段（实测结论见 README）。
"""

import json
import os
import re
import threading
import time
import traceback
import urllib.parse
from datetime import datetime, time as dtime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo

import alpaca
import morning_fetch          # 只为复用 last_completed_session()，别让"上一个已完成交易日"出现第二套算法
import night_fetch
import providers
import screening
import settings
import symbols

settings.load()               # 让 .env 里的密钥/口径在 server 启动时生效（幂等）

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

#: 早盘总结的数据文件。由定时任务（每天 06:30）调用 us-stock-daily-review 生成后写入，
#: 服务端只读不写 —— 抓取与生成属于那个定时任务的职责，页面不做任何行情抓取。
MORNING_PATH = os.path.join(BASE_DIR, "data", "morning.json")

#: 夜盘异动「驱动原因」列的数据文件，结构与生成方式见 README 的「驱动原因从哪来」一节。
#: 同样只读：由智能体在盘后分析写入，页面不自己抓新闻。
REASONS_PATH = os.path.join(BASE_DIR, "data", "reasons.json")

ET = ZoneInfo("America/New_York")
CST = ZoneInfo("Asia/Shanghai")

PORT = int(os.getenv("PORT", 8787))
SOURCE = os.getenv("SOURCE", "finviz")

#: 是否同时看下跌档。默认只看上涨（SHOW_DOWN=1 可恢复）。
#: 关掉下跌档不只是隐藏前端 —— 会**真的少抓两档**，请求量约减半，
#: 对 60 秒刷新这种高频抓取是实打实的减压。
SHOW_DOWN = os.getenv("SHOW_DOWN", "0").strip().lower() not in ("0", "", "false", "no")

CFG = screening.cfg_from_env()
CRITERIA = screening.criteria_text(CFG, show_down=SHOW_DOWN)
#: 口径的数值版，与 CRITERIA 同源。前端（早盘页的「大市值 / 小市值」筛选项）按它分档，
#: 免得在 JS 里另写一份边界值。
CRITERIA_VALUES = screening.criteria_values(CFG)

TITLES = {
    "big_up":   (f"大市值涨幅 ≥ {CFG['big_pct']:g}%", "big"),
    "big_down": (f"大市值跌幅 ≥ {CFG['big_pct']:g}%", "big"),
    "mid_up":   (f"小市值涨幅 ≥ {CFG['mid_pct']:g}%", "mid"),
    "mid_down": (f"小市值跌幅 ≥ {CFG['mid_pct']:g}%", "mid"),
}

#: 本次生效的分档（决定抓哪几档、以及前端出几个标签页）
TAB_KEYS = (("big_up", "big_down", "mid_up", "mid_down") if SHOW_DOWN
            else ("big_up", "mid_up"))


#: 页面短路由 —— 左侧菜单用干净路径，同时保留直接访问 .html 的方式。
#: 新增页面时在这里登记，并同步 static/shell.js 里的 NAV。
PAGE_ROUTES = {
    "/": "/index.html",
    "/evening": "/index.html",      # 夜盘异动
    "/morning": "/morning.html",    # 早盘总结
}


# ---------------------------------------------------------------- 早盘总结

def read_morning():
    """读取早盘总结数据。

    文件不存在或损坏时返回 ok=False 并给出可操作的中文原因，
    不返回空结构让前端白屏。交易日距今超过 4 天（含周末）即标记 stale，
    提示"自动更新可能没跑起来"。
    """
    if not os.path.exists(MORNING_PATH):
        return {"ok": False,
                "message": "早盘总结数据尚未生成。定时任务（工作日 06:30）会调用 "
                           "us-stock-daily-review 生成并写入 data/morning.json。"}
    try:
        with open(MORNING_PATH, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        return {"ok": False, "message": "早盘总结数据文件无法解析：%s" % e}

    data["ok"] = True
    meta = data.setdefault("meta", {})
    td = meta.get("tradeDate")
    if td:
        try:
            days = (datetime.now(CST).date() - datetime.strptime(td, "%Y-%m-%d").date()).days
            meta["ageDays"] = days
            meta["stale"] = days > 4
        except ValueError:
            pass
    meta["fileMtime"] = datetime.fromtimestamp(
        os.path.getmtime(MORNING_PATH), CST).strftime("%Y-%m-%d %H:%M:%S")
    return data


# ---------------------------------------------------------------- 驱动原因

def read_reasons():
    """夜盘异动「驱动原因」列的数据。

    取数分两层，**口径与早盘页的「个股异动榜 · 驱动原因」完全一致**（都是分析后的整句话）：

    1. `data/reasons.json` —— 夜盘自己的原因文件，由智能体在盘后分析写入（主来源）；
    2. 回退到最近一份 `data/morning.json` 的 `movers[].driver` —— 同一只票若在最近的
       早盘复盘里已经写过原因，夜盘页直接复用，两页显示同一句话，不会各说各的。

    都找不到就没有这个代码的键，前端显示「待确认」（与早盘页同一写法），
    不编造。文件不存在/损坏只影响这一列，不影响行情表。
    """
    out, meta = {}, {}

    if os.path.exists(REASONS_PATH):
        try:
            with open(REASONS_PATH, encoding="utf-8") as f:
                data = json.load(f)
            meta = data.get("meta") or {}
            for sym, v in (data.get("reasons") or {}).items():
                text = v.get("driver") if isinstance(v, dict) else v
                if text:
                    out[sym.upper()] = {
                        "driver": text,
                        "from": "reasons",
                        # 日期优先用**条目自己**的场次：原因文件会跨场次累积，而 meta 只有一个
                        # sessionDate，拿它去标注旧条目会不准。
                        # ⚠️ 原先这里写的是 meta.get("tradeDate") —— meta 里压根没有这个键
                        #（只有 sessionDate），所以恒为 None，前端悬停提示的日期一直是「—」。
                        "tradeDate": (v.get("sessionDate") if isinstance(v, dict) else None)
                                     or meta.get("sessionDate"),
                        "basis": (v.get("basis") if isinstance(v, dict) else None),
                    }
        except Exception as e:  # noqa: BLE001 —— 原因文件坏了不能让行情表也挂掉
            meta = {"error": "reasons.json 无法解析：%s" % e}

    try:
        if os.path.exists(MORNING_PATH):
            with open(MORNING_PATH, encoding="utf-8") as f:
                m = json.load(f)
            td = (m.get("meta") or {}).get("tradeDate")
            for r in (m.get("movers") or []):
                sym = (r.get("symbol") or r.get("code") or "").upper()
                if sym and sym not in out and r.get("driver"):
                    out[sym] = {"driver": r["driver"], "from": "morning", "tradeDate": td}
    except Exception:  # noqa: BLE001
        pass

    return {"ok": True,
            "reasons": out,
            "meta": dict(meta, count=len(out),
                         generatedAt=datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S"))}


# ---------------------------------------------------------------- 交易时段

def current_snapshot():
    """把「场上这份数据代表什么」算出来给前端看。

    - basis=night_live ：夜盘进行中，值是**实时**的
    - basis=night_close：夜盘已收盘，这一份是**该场夜盘的收盘快照**，不再变

    两者必须分清，否则读者会把实时值当成收盘值（或反过来）。
    `sessionDate` 是夜盘归属的**交易日**（美东日期）——
    需求里说的"最近一次夜盘收盘"就是指这一场。

    这里**以刷新时算好的为准**（存在 `CACHE.snapshot_info`），而不是用"此刻"重新推：
    服务器若跨了场次，重新推会说"现在是收盘口径"，而手上那份其实是上一场的实时值。
    `current` 字段专门回答"这份在不在最新一场上"。
    """
    info = CACHE.snapshot_info or {}
    win = night_fetch.night_window() or {}
    sess = info.get("sessionDate")
    return {
        "basis": info.get("basis") or ("night_live" if win.get("inSession") else "night_close"),
        "sessionDate": sess or win.get("tradeDate"),
        "closeCst": win.get("closeCst"),
        "inSession": bool(win.get("inSession")),
        "current": sess == win.get("tradeDate"),
        "phase": market_state()["phase"],
    }


def snapshot_info_for(win):
    """刷新时算一次并存下 —— 见 current_snapshot 的说明。"""
    return {
        "basis": "night_live" if win.get("inSession") else "night_close",
        "sessionDate": win.get("tradeDate"),
    }


def market_state(now=None):
    """判断美股处在哪个时段，并给出下一次状态切换时间。

    **夜盘要放在最前面判**：夜盘从美东**周日** 20:00 开始，那天 `weekday()` 是 6，
    先判 `wd >= 5` 的话整场夜盘都会被算成"周末休市" —— 而它其实是开市的。
    """
    now_et = (now or datetime.now(timezone.utc)).astimezone(ET)
    win = night_fetch.night_window(now)
    if win and win["inSession"]:
        return {
            "open": True,
            "phase": "night",
            "label": "夜盘（开市中）",
            "nowEt": now_et.isoformat(),
            "nextChangeEt": win["endEt"],
        }

    wd = now_et.weekday()
    t = now_et.time()
    if wd >= 5:
        return {
            "open": False,
            "phase": "weekend",
            "label": "周末休市",
            "nowEt": now_et.isoformat(),
            "nextChangeEt": _next_weekday_open(now_et).isoformat(),
        }
    if dtime(4, 0) <= t < dtime(9, 30):
        phase, label = "premarket", "盘前"
    elif dtime(9, 30) <= t < dtime(16, 0):
        phase, label = "regular", "常规时段（开市中）"
    elif dtime(16, 0) <= t < dtime(20, 0):
        phase, label = "afterhours", "盘后"
    else:
        phase, label = "closed", "休市"

    nxt = (now_et.replace(hour=20, minute=0, second=0, microsecond=0)
           if phase == "afterhours" else _next_weekday_open(now_et))
    return {
        "open": phase == "regular",
        "phase": phase,
        "label": label,
        "nowEt": now_et.isoformat(),
        "nextChangeEt": nxt.isoformat(),
    }


def _next_weekday_open(dt_et):
    """下一个工作日 09:30 ET（不处理交易所节假日，见 README 说明）。"""
    d = dt_et
    probe = d.replace(hour=9, minute=30, second=0, microsecond=0)
    if d >= probe:
        probe += timedelta(days=1)
    while probe.weekday() >= 5:
        probe += timedelta(days=1)
    return probe


# ------------------------------------------------------------ 自选行情
#
# 「个人关注池」允许用户自己增删，清单存在**浏览器 localStorage** 里，不回写服务端
# （见 README「关注池的自定义增删」）。新增的代码不在 data/morning.json 里，
# 只能现场取一次行情 —— 这是**全站唯一**由页面发起、服务端代为抓取的地方，
# 早盘页其余部分一律只读日更 JSON。
#
# 取数分两路，合并成一行：
#   1. finviz 的 `t=` 精确查询 → 公司名 / 板块 / 行业 / 市值（这些字段跟交易日无关）
#   2. westock 日线 → 收盘价与涨跌幅，**取"上一个已收盘交易日"**
# 第 2 步必须与 morning_fetch.py 用同一套口径。否则盘中新增一只票，它显示的是
# **今天盘中**的涨跌幅，而池子里原有的票显示的是**上一交易日**的 —— 同一排格子两套
# 时间基准，直接比大小就是错的。westock 拿不到时才回落到 finviz 的盘中价，并标
# `basis:"intraday"` 让前端把这个差异显示出来，而不是混在一起装作一样。

QUOTE_TTL = int(os.getenv("QUOTE_TTL_SECONDS", "120"))    # 同一只票多久内不重复抓
QUOTE_MAX = int(os.getenv("QUOTE_MAX_CODES", "40"))       # 单次最多查多少只

_quote_cache = {}          # {"AAPL": (时间戳, 行情 dict)}
_quote_lock = threading.Lock()


def normalize_symbol(code):
    """把用户手输的代码规整成 Finviz 认的纯 ticker。

    接受 `AAPL` / `aapl` / `usAAPL` / `$AAPL` / `" AAPL "` —— 用户不会有耐心去记
    我们内部的 `us` 前缀。**只剥 `us` + 紧跟大写字母**这种写法，别误伤 USB（美国合众银行）
    这类本身就长这样的代码；前端 morning.js 的 codeText 是同一条规则，两边必须一致。

    不合法就返回空串（**不猜**，不做"是不是拼错了"的纠正）。
    """
    raw = str(code or "").strip().lstrip("$")
    if re.match(r"^us[A-Z]", raw):
        raw = raw[2:]
    s = raw.strip().upper()
    return s if re.fullmatch(r"[A-Z][A-Z0-9.\-]{0,9}", s) else ""


def fetch_quotes(codes):
    """按需取行情。返回 (quotes, missing, basis, error)。

    - quotes : {symbol: 关注池行}，行结构与 data/morning.json 的 watchlist 一致，
               前端方块渲染器不用为"自选"另写一套
    - missing: 请求了但源里查不到的代码（多半是拼错了），与"取数失败"是两回事
    - basis  : "session"（与池内其它票同一交易日）或 "intraday"（盘中价，仅回落时）
    - error  : 取数源本身失败时的中文原因；非空时前端应提示"可重试"而非"代码不存在"
    """
    want = []
    for c in codes:
        s = normalize_symbol(c)
        if s and s not in want:
            want.append(s)
        if len(want) >= QUOTE_MAX:
            break
    if not want:
        return {}, [], "session", "没有可用的股票代码"

    now = time.time()
    out, need = {}, []
    with _quote_lock:
        for s in want:
            hit = _quote_cache.get(s)
            if hit and now - hit[0] < QUOTE_TTL:
                out[s] = hit[1]
            else:
                need.append(s)

    basis = "session"
    error = ""
    if need:
        fp = providers.FinvizProvider()
        profile, perr = {}, ""
        try:
            rows = fp.fetch_tickers(need)
            # 二次尝试：finviz 的类别股写法是连字符（BRK-B），而用户习惯写 BRK.B。
            # 只为第一轮**没认出来的、且带点的**代码补一次请求 —— 不做预先改写，
            # 否则等于凭空发明一种我们并不确定的代码写法（BF.B 与 BF-B 之外还有别的可能）。
            got = {r.get("symbol") for r in rows}
            retry = [s for s in need if s not in got and "." in s]
            if retry:
                rows = rows + fp.fetch_tickers([s.replace(".", "-") for s in retry])
            for r in rows:
                n = screening.normalize(r)
                sym = n.get("symbol") or ""
                if not sym:
                    continue
                # 结果要挂回**用户实际请求的那个写法**上：请求的是 BRK.B，finviz 回的是 BRK-B，
                # 后面按 need 里的键取用，不映射回去就会整条丢掉。
                for k in {sym, sym.replace("-", ".")} & set(need):
                    profile[k] = n
        except Exception as e:                       # noqa: BLE001 —— 取不到就退化成"只有价格"
            perr = "Finviz 取数失败：%s" % e

        live, lerr = {}, ""
        # 只给 finviz 认得的代码查日线：finviz 查不到的，westock 基本也查不到，
        # 而 npx 那一趟实测要十几秒 —— 用户输错一个代码就白等这么久不值得。
        # 判据留了两个"不省"的分支：finviz 整体失败（perr）、或一个都没认出（profile 空）
        # 时照旧全查，避免把"源抽风"误判成"代码不存在"。
        ask = need if (perr or not profile) else [s for s in need if s in profile]
        if ask:
            try:
                import morning_fetch as mf        # 只为复用 kline / quote_from_kline，避免第二套口径
                session = mf.last_completed_session().isoformat()
                # ⚠️ 类别股的写法两个源**正好相反**，别"顺手统一"：
                #     finviz 用连字符（BRK-B），westock 用点（usBRK.B）。
                #     这里传的 "us" + s 用的是**用户请求时的写法**（通常是 BRK.B），
                #     恰好是 westock 认的那个；finviz 那一侧由上面的二次尝试补。
                #     实测：usBRK.B → 有数据；usBRK-B → 完全查不到。
                kl = mf.kline(["us" + s for s in ask], limit=4)
                for s in ask:
                    # 注意 kline 批量返回的键带 us 前缀（内部代码形态），这里要换回纯 ticker 比对
                    q = mf.quote_from_kline(kl.get("us" + s) or kl.get(s) or [], session)
                    if q:
                        live[s] = q
            except Exception as e:                   # noqa: BLE001
                lerr = "westock 取数失败：%s" % e

        if not profile and not live:
            # 两个源都**正常应答**、只是都没有这些代码 → 是"代码查不到"，不是"取数失败"。
            # 这个区分必须做：前者该提示用户核对代码，后者该提示稍后重试，
            # 混成一句"取数失败"会让用户对着一个拼错的代码反复重试。
            #
            # 另外：这里**不能直接扔掉 out** —— 里面可能有命中的缓存。
            # 曾经的写法是 `return {}, need, ...`，结果是"新加了一只拼错的代码"
            # 会让整池已经取到的票一起变成空白。
            broke = perr or lerr
            return out, [s for s in want if s not in out], basis, broke

        fresh = {}
        for s in need:
            p, q = profile.get(s), live.get(s)
            if not p and not q:
                continue                              # 该代码两路都查不到 → 进 missing
            if q:
                close, chg = q.get("close"), q.get("chgPct")
            else:
                # 只拿到 finviz 时用盘中价 —— 记下 basis 差异，别让用户以为两排数字同源
                close, chg = (p or {}).get("price"), (p or {}).get("chg")
                basis = "intraday"
            cap = (p or {}).get("marketCap")
            fresh[s] = {
                "code": "us" + s,
                "symbol": s,
                "name": (p or {}).get("name") or s,
                "close": close,
                "chgPct": chg,
                # 那一行原先放智能体写的"涨幅关键词"；自选票没有分析结论，
                # 用板块顶上（至少是有信息量的），不编造原因。
                "keyword": (p or {}).get("sector") or "—",
                "capYi": round(cap / 1e8, 1) if cap else None,
                "sector": (p or {}).get("sector"),
                "industry": (p or {}).get("industry"),
                "source": "finviz+westock" if q else "finviz",
                "custom": True,
            }
        with _quote_lock:
            for s, row in fresh.items():
                _quote_cache[s] = (time.time(), row)
        out.update(fresh)

    missing = [s for s in want if s not in out]
    return out, missing, basis, error


# ---------------------------------------------------------------- 缓存

class Cache:
    def __init__(self):
        self.lock = threading.Lock()
        self.payload = None
        self.fetched_at = 0.0
        self.duration_ms = 0
        self.last_requests = 0
        self.requests_total = 0
        self.errors = []
        self.refreshing = False
        #: 这份缓存代表哪个交易日的什么口径（current_snapshot() 的结果）。
        #: refresh_loop 与 loadStatus 都靠它判断"要不要换一份"。
        #: ⚠️ 名字不能叫 snapshot —— 本类已有一个 `snapshot()` 方法（读 payload），
        #: 实例属性会把那个方法整个遮住，`CACHE.snapshot()` 当场 TypeError。
        self.snapshot_info = None

    def snapshot(self):
        with self.lock:
            return self.payload


CACHE = Cache()


def _log(msg):
    """后台线程的日志。带时间戳 + flush —— 服务在后台跑，只能 tail 日志看进度；
    不 flush 的话缓冲会把进度憋住，看起来像卡死。"""
    print("[%s] %s" % (datetime.now(CST).strftime("%H:%M:%S"), msg), flush=True)


def _fetch_rows():
    """取一轮原始行。返回 `(rows, errors, requests, ok)`。

    `ok=False` 表示**这一轮根本没跑成**（没有域缓存、没密钥、或夜盘压根没数据），
    而不是"跑了但一只都没动"。两者必须分开 —— 见 do_refresh 里为什么。

    两个数据源，**必须显式指定、不做静默回退**：
      · `SOURCE=mock` —— 离线演示，走 MockProvider（不联网）
      · 其它（默认）  —— 走 Alpaca 的**夜盘**口径

    为什么不"取不到夜盘就自动退回 Finviz 常规口径"：那会让页面显示一份**常规时段**的
    涨跌幅、却顶着"夜盘"的标题 —— 数值看着正常、含义完全错。宁可空着并说明原因。
    """
    if SOURCE == "mock":
        prov = providers.build("mock")
        raw = prov.fetch_all(bands=list(TAB_KEYS) + ["excluded"])
        errs = raw.pop("_errors", [])
        rows = []
        for band_rows in raw.values():
            rows.extend(band_rows)
        return rows, errs, getattr(prov, "request_count", 0), True

    if not alpaca.available():
        raise RuntimeError(
            "未配置 ALPACA_KEY_ID / ALPACA_SECRET_KEY —— 夜盘口径需要 Alpaca（免费 Paper 账号即可）。"
            "密钥可写进项目根目录的 .env，见 README「夜盘数据源」")

    rows, scan_meta = night_fetch.scan(CFG, show_down=SHOW_DOWN, log=_log)
    # scan 在"没域缓存/算不出窗口/夜盘无成交"时会带 reason 回来 —— 那是没跑成，不是空榜单
    ok = not scan_meta.get("reason")
    if not ok:
        _log("  本轮跳过：" + str(scan_meta.get("reason")))
    return rows, scan_meta.get("errors") or [], alpaca.requests_total(), ok


def do_refresh():
    """抓一轮数据并写入缓存。返回是否成功写入。失败时保留上一份，只更新错误信息。

    **一轮没跑成时绝不冻结收盘快照**（`_fetch_rows` 的 `ok`）：
    否则一次"正好在常规时段重启、域缓存又缺失"就会把上一份**好的**收盘快照
    用一张空表覆盖掉，而且事后完全看不出来 —— 页面只是变成"今天没有异动"。
    """
    if CACHE.refreshing:
        return False
    CACHE.refreshing = True
    t0 = time.time()
    try:
        win = night_fetch.night_window() or {}
        merged, errors, requests, ok = _fetch_rows()

        result = screening.classify(merged, CFG)

        counts = {k: result["counts"][k] for k in TAB_KEYS}
        counts["total"] = sum(counts.values())
        counts["excluded"] = result["counts"]["excluded"]

        payload = {
            "tables": {k: {"title": TITLES[k][0], "rows": result[k]} for k in TAB_KEYS},
            "counts": counts,
            "excluded": result["excluded"][:40],
            "excludedTruncated": len(result["excluded"]) > 40,
        }
        with CACHE.lock:
            CACHE.payload = payload
            CACHE.snapshot_info = snapshot_info_for(win)
            CACHE.fetched_at = time.time()
            CACHE.duration_ms = int((time.time() - t0) * 1000)
            CACHE.last_requests = requests
            CACHE.requests_total += requests
            CACHE.errors = errors
        # 夜盘**已收盘**时把这一份落盘冻结 —— 它就成为"最近一次夜盘收盘"，
        # 非夜盘时间一直显示它（重启后也会在启动时被读回来）。
        if not win.get("inSession") and ok:
            night_fetch.save_close(payload, {
                "sessionDate": win.get("tradeDate"),
                "closeCst": win.get("closeCst"),
                "universe": len(merged),
            })
        return ok
    except Exception as e:  # noqa: BLE001 —— 任何取数失败都不能让服务挂掉
        with CACHE.lock:
            CACHE.errors = [f"{type(e).__name__}: {e}"]
        print("[refresh-failed]", traceback.format_exc(limit=2))
        return False
    finally:
        CACHE.refreshing = False


#: 夜盘进行中的轮询间隔（秒）。一轮全市场扫描实测 20~90 秒（取决于有多少票有夜盘成交），
#: 所以间隔不能太短 —— 太短会变成"上一轮还没跑完就排下一轮"。可用环境变量覆盖。
NIGHT_POLL_SECONDS = int(os.getenv("NIGHT_POLL_SECONDS", 180))

#: 循环心跳（秒）。只用于判断"到点该扫了吗""夜盘收了吗"，秒级足够。
NIGHT_TICK_SECONDS = 15


def refresh_loop():
    """后台循环 —— **夜盘实时轮询 + 收盘冻结**（2026-09-22 按用户要求）。

    规则两条：
      · **夜盘进行中** —— 每 `NIGHT_POLL_SECONDS` 扫一轮，页面显示实时值
      · **夜盘已收盘** —— 补扫最后一轮并落盘冻结；之后到下一场夜盘开始前都不再抓

    **收盘后那一轮补扫是必须的**：轮询是离散的，最后一次轮询可能落在收盘前几十秒；
    收盘后再扫一次才能拿到真正的收盘价（`feed=overnight` 在收盘后仍返回该场数据）。
    少了这一步，冻结下来的就是"收盘前 N 秒"的值 —— 而且看不出来。

    冷启动由 `main()` 先把 `data/night_close.json` 读进缓存，页面立刻有东西看。
    """
    frozen_for = None
    fails, retry_at = 0, 0.0

    while True:
        now = time.time()
        win = night_fetch.night_window() or {}

        if win.get("inSession"):
            due = CACHE.payload is None or (now - CACHE.fetched_at) >= NIGHT_POLL_SECONDS
            if due and now >= retry_at:
                if do_refresh():
                    fails, retry_at = 0, 0.0
                else:
                    fails += 1
                    retry_at = now + min(30 * fails, 300)      # 失败退避，最多 5 分钟
            frozen_for = None            # 在场内：收盘快照随时会被最新一轮覆盖
        else:
            trade = win.get("tradeDate")
            if frozen_for != trade and now >= retry_at:
                if do_refresh():
                    frozen_for = trade
                    _log(f"  夜盘收盘快照已冻结（场次 {trade}）")
                else:
                    # 没跑成（比如域缓存还没建好）→ 退避重试，别空转打爆数据源
                    fails += 1
                    retry_at = now + min(30 * fails, 300)
        time.sleep(NIGHT_TICK_SECONDS)


# ---------------------------------------------------------------- HTTP

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC_DIR, **kw)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        """静态资源禁用浏览器缓存 —— 否则改了 app.js/style.css 后页面不生效。"""
        if self.path.split("?")[0].endswith((".html", ".js", ".css")):
            self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/movers":
            return self._movers()
        if path == "/api/morning":
            return self._json(read_morning())
        if path == "/api/quote":
            return self._quote()
        if path == "/api/symbols":
            return self._symbols()
        if path == "/api/reasons":
            return self._json(read_reasons())
        if path == "/api/status":
            return self._json({"ok": True, "market": market_state(),
                               "source": SOURCE, "criteria": CRITERIA,
                               "criteriaValues": CRITERIA_VALUES,
                               # ⚠️ 必须给 `current_snapshot()` 的**完整**结果，不能只给
                               # CACHE.snapshot_info 那两个字段（basis/sessionDate）——
                               # 前端的"场内每次都取数"靠的是 `inSession`，缺了它前端永远
                               # 不认为在场内，**夜盘就不会自动刷新**，而且页面看着一切正常。
                               "snapshot": current_snapshot()})
        if path == "/api/refresh":
            # ⚠️ do_refresh() **有返回值**（本轮是否成功写入），以前这里是直接丢掉、
            # 只回一份行情，导致前端根本无从判断"这次刷新到底成没成" ——
            # 它只能看 _movers 的 ok，而那个 ok 的含义是"缓存里有没有数据"，
            # 刷新失败但缓存还有旧数据时它照样是 true，前端会误报"刷新成功"。
            ok = do_refresh()
            return self._movers(refresh_ok=ok)
        if path == "/healthz":
            return self._json({"ok": True})
        # 页面路由（左侧菜单用短链接；直接访问 .html 也照常可用）
        if path in PAGE_ROUTES:
            self.path = PAGE_ROUTES[path]
        return super().do_GET()

    def _symbols(self):
        """`GET /api/symbols?q=AAP&limit=8` —— 「个人关注池」输入框的即时建议。

        代码库没准备好时**不报错**，返回 `ok:false` + 正在准备的中文说明：
        首次启动要下载两份目录（约 7 秒），这几秒里前端只要不下拉就行，不是故障。
        """
        qs = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
        q = (qs.get("q") or [""])[0]
        try:
            limit = int((qs.get("limit") or ["10"])[0])
        except ValueError:
            limit = 10
        ready, msg = symbols.ensure()
        if not ready:
            return self._json({"ok": False, "message": "代码库正在准备，稍后重试（%s）" % msg,
                               "symbols": []})
        return self._json({"ok": True, "query": q, "symbols": symbols.search(q, limit)})

    def _quote(self):
        """`GET /api/quote?codes=AAPL,TSLA` —— 给「个人关注池」里用户自选的票按需取行情。

        用户自选的清单存在浏览器里，服务端不知道有哪些，所以只能由页面点名要。
        返回体始终 200：取数失败也放在 `ok:false` + `message` 里 ——
        前端是 fetch()，非 2xx 要走 catch 分支，反而不好区分"网络断了"和"源限流了"。
        """
        qs = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
        codes = [c for raw in qs.get("codes", []) for c in raw.split(",")]
        if not codes:
            return self._json({"ok": False, "message": "缺少 codes 参数", "quotes": {}})
        try:
            quotes, missing, basis, error = fetch_quotes(codes)
        except Exception as e:                        # noqa: BLE001
            return self._json({"ok": False, "message": "取行情出错：%s" % e,
                               "quotes": {}, "missing": [], "basis": "session"})
        if error and not quotes:
            return self._json({"ok": False, "message": error, "quotes": {},
                               "missing": missing, "basis": basis})
        return self._json({"ok": True, "quotes": quotes, "missing": missing, "basis": basis,
                           "message": error})

    def _movers(self, refresh_ok=None):
        """行情体。`refresh_ok` 只有 `/api/refresh` 会传 —— 表示**本轮刷新**的成败，
        与 `ok`（缓存里有没有数据）是两件事，见那处注释。"""
        snap = CACHE.snapshot()
        st = market_state()
        now_et = datetime.now(ET)
        age = int(time.time() - CACHE.fetched_at) if CACHE.fetched_at else None
        meta = {
            "source": SOURCE,
            "criteria": CRITERIA,
            "market": st,
            "fetchedAt": (datetime.fromtimestamp(CACHE.fetched_at, CST).strftime("%Y-%m-%d %H:%M:%S")
                          if CACHE.fetched_at else None),
            "fetchedAtEt": (datetime.fromtimestamp(CACHE.fetched_at, ET).strftime("%Y-%m-%d %H:%M:%S")
                            if CACHE.fetched_at else None),
            "nowEt": now_et.strftime("%Y-%m-%d %H:%M:%S"),
            "nowCst": datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S"),
            "ageSeconds": age,
            "durationMs": CACHE.duration_ms,
            "lastRequests": CACHE.last_requests,
            "requestsTotal": CACHE.requests_total,
            # 同上：给完整快照对象（前端要用 inSession / closeCst / current）
            "snapshot": current_snapshot(),
            # 是否处于常规时段。**前端已经不靠它做任何调度了**（2026-09-22 起夜盘页
            # 完全不自动取数，见 static/shell.js 的「不自动取数」一节）——
            # 这个字段现在只用于页头的市场状态展示与排障。
            "autoRefresh": st["open"],
            "errors": CACHE.errors,
        }
        if refresh_ok is not None:
            # `errors` 是给页面常驻区看的分组级失败原因；`refresh` 是给"刚刚那次点击"
            # 看的结论。形状固定成 {ok, errors}，前端只认这一个来源，不去猜。
            meta["refresh"] = {
                "ok": bool(refresh_ok),
                "errors": [str(x) for x in (CACHE.errors or [])],
            }
        if snap is None:
            return self._json({"ok": False, "meta": meta,
                               "message": "首轮数据尚未就绪，请稍候几秒后刷新"}, 503)
        out = {"ok": True, "meta": meta}
        out.update(snap)
        return self._json(out)


def main():
    if not os.path.isdir(STATIC_DIR):
        raise SystemExit(f"缺少静态目录：{STATIC_DIR}")
    win = night_fetch.night_window() or {}
    print("美股夜盘异动")
    print(f"  数据源        : {'mock（离线演示）' if SOURCE == 'mock' else 'alpaca（夜盘口径）'}"
          + ("" if SOURCE == "mock" or alpaca.available() else "  ⚠️ 未配置密钥"))
    print(f"  监听          : http://127.0.0.1:{PORT}")
    print(f"  本场夜盘      : {win.get('tradeDate')} "
          f"（{win.get('startUtc')} → {win.get('endUtc')} UTC，北京 {win.get('closeCst')} 收盘）")
    print(f"  当前状态      : {'场内 · 实时刷新' if win.get('inSession') else '场外 · 显示最近一场收盘快照'}"
          f"，轮询间隔 {NIGHT_POLL_SECONDS}s")
    print(f"  分档          : {'上涨 + 下跌' if SHOW_DOWN else '仅上涨（SHOW_DOWN=0）'}")
    print(f"  筛选口径      : 大市值 {CRITERIA['big']}；小市值 {CRITERIA['mid']}")

    # 冷启动：先把上一次冻结的收盘快照读进缓存 —— 服务重启时页面立刻有东西看，
    # 不必等循环觉醒（场外时循环也不会去抓）。
    frozen = night_fetch.load_close()
    if frozen and frozen.get("payload"):
        with CACHE.lock:
            CACHE.payload = frozen["payload"]
            m = frozen.get("meta") or {}
            CACHE.snapshot_info = {"basis": "night_close", "sessionDate": m.get("sessionDate")}
            CACHE.fetched_at = time.time()
        print(f"  载入收盘快照  : 场次 {m.get('sessionDate')}（冻结于 {frozen.get('savedAt')}）")
    else:
        print("  载入收盘快照  : 无（首轮扫描后会写入 data/night_close.json）")
    # 代码目录（关注池输入建议用）在**后台**准备：首次要下载约 890KB（实测 7 秒），
    # 不能卡在启动路径上。没准备好的那几秒里 /api/symbols 返回"正在准备"，不是故障。
    symbols.ensure()
    print(f"  代码目录      : {symbols.status()['count'] or '准备中'} 条")
    threading.Thread(target=refresh_loop, daemon=True).start()
    # 域缓存（哪些票要扫 + 市值/板块）由独立线程维护：一次爬取实测约 6 分钟
    # （被限速时更久），**不能**塞进取数路径，否则那一轮轮询会卡住。
    threading.Thread(target=night_fetch.universe_loop, args=(CFG, _log), daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
