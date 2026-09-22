"""Alpaca 行情适配 —— 专供「夜盘异动」页（2026-09-22 新增）。

选型背景见 README「夜盘数据源」一节。几条**实测**出来的硬约束，改代码前先读：

1. **两个 feed 分工，不能混用**
   · `feed=overnight` —— 夜盘**进行中**取实时快照（免费档给的是"指示性报价"，
     不是逐笔成交；成交明细延迟 15 分钟）。快照里 `dailyBar` = 整个夜盘时段的
     累计 bar（20:00 ET 起），`prevDailyBar` = **上一个夜盘的** bar。
   · `feed=boats` —— 只用于**历史**。而且实测只有 1Min 及以下的时间粒度能取；
     请求 `timeframe=1Day` 会返回
     `403 subscription does not permit querying recent BOATS data`。
     官方文档也写了：夜盘结束后还用 `feed=overnight` 会直接报错
     （`400 invalid feed: overnight`），历史必须换 `boats`。

2. **⚠️ `feed=overnight` 的 `prevDailyBar` 不是常规收盘价。**
   它指的是**上一个夜盘时段**的收盘。实测佐证：AAPL 在 overnight feed 里
   `prevDailyBar.c = 335.74`，而常规 feed 给的上一常规收盘是 `339`，两者不等。
   所以"夜盘涨跌幅"的基准**必须另找常规收盘**（见 `night_fetch.baseline`）——
   照搬 `prevDailyBar` 会得到一个语义完全错误的涨跌幅，而且不会报错。

3. **批量快照上限约 1000，而且慢**：实测传 500 只要 10~18 秒、1000 只要 44 秒，
   2000 会被拒/超时。所以这里固定 500 一批 + 并发拉，靠并发把全市场扫一遍压到
   一分钟出头。串行扫全市场（约 1.28 万只）要 8 分钟，不可用。

4. **过期成交价是这里最容易犯的静默错误**：夜盘收盘后（或某只票整段没成交），
   快照里仍会带着**上一次夜盘**的 `latestTrade`。直接拿它当"现价"会算出一个
   看起来正常、其实早就作废的涨跌幅。所以取价时必须校验成交时间落在
   **本次夜盘窗口内**（见 `_price_in_window`），校验不过就丢弃该票。
"""

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import settings

settings.load()          # 幂等；让 `.env` 里的密钥在直接 import 本模块时也可用

DATA_BASE = "https://data.alpaca.markets"

#: 每批代码数。实测 1000 可过但明显变慢，500 更稳，也给并发留了余地。
BATCH = 500

#: 并发批数。实测 8 路能把单批延迟从 10s 抬到 27s、但总吞吐翻几倍，是划算的。
WORKERS = 8

#: 单批超时（秒）。全市场约 26 批，8 路并发下最慢单批实测 27s，留足余量。
TIMEOUT = 90

#: 网关偶发 429/5xx 时的退避重试次数
RETRIES = 3


class AlpacaError(RuntimeError):
    pass


#: 累计发起的 HTTP 请求数（含重试）。页头的"累计请求数"用它，便于判断有没有被限流。
_requests = 0


def requests_total():
    return _requests


def key_id():
    return (os.getenv("ALPACA_KEY_ID") or "").strip()


def secret_key():
    return (os.getenv("ALPACA_SECRET_KEY") or "").strip()


def available():
    """密钥齐不齐。**不在这里做任何网络探测** —— 调用方按需回退，启动不该被网络卡住。"""
    return bool(key_id() and secret_key())


#: 类别股写法：Finviz 用连字符（BRK-B / BF-B / AKO-A），Alpaca 用点（BRK.B）。
#: 这个差异和「关注池」那次发现的是同一个坑（见 server.py 的 normalize_symbol）——
#: 传错了 Alpaca 会回 400 invalid symbol，而且**一个坏代码毒死整批**。
_CLASS_SEP = str.maketrans("-", ".")


def to_alpaca_symbol(sym):
    """把代码转成 Alpaca 认的形态（连字符 → 点）。

    只做这一种替换，不做别的猜测：认不出来的代码由 `snapshots()` 的
    "踢掉坏符号重试"兜住，不在这里瞎猜。
    """
    return str(sym or "").strip().upper().translate(_CLASS_SEP)


def _headers():
    if not available():
        raise AlpacaError("未配置 ALPACA_KEY_ID / ALPACA_SECRET_KEY（可写进 .env）")
    return {
        "APCA-API-KEY-ID": key_id(),
        "APCA-API-SECRET-KEY": secret_key(),
        "Accept": "application/json",
    }


def _get(path, params, timeout=TIMEOUT):
    """一次带重试的 GET。返回解析后的 JSON。

    错误信息里**不回显密钥**，也不回显完整 URL —— 批量请求的 URL 里塞着几百个代码，
    打进日志会把日志淹掉。只留路径与前 120 字的响应体。
    """
    global _requests
    url = DATA_BASE + path + "?" + urllib.parse.urlencode(params)
    last = None
    _requests += 1
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(url, headers=_headers())
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:120]
            last = f"{path} → HTTP {e.code} {body}"
            # 4xx 里只有 429 值得重试；400/403 是权限或参数问题，重试无用
            if e.code != 429 and e.code < 500:
                raise AlpacaError(last) from None
        except Exception as e:                        # noqa: BLE001 —— 网络类异常统一退避重试
            last = f"{path} → {type(e).__name__}: {str(e)[:120]}"
        time.sleep(0.6 * (attempt + 1))
    raise AlpacaError(last or f"{path} → 未知错误")


# ------------------------------------------------------------------ 快照

def batches(items, size=BATCH):
    seq = list(items)
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def snapshots(symbols, feed="overnight", batch=BATCH, workers=WORKERS):
    """批量取快照，返回 `{symbol: snapshot}`。

    分批并发；**单批失败不拖垮整体** —— 失败的批记在返回值的 `__errors__` 里
    （一个 dict 键不好看，但比让调用方以为"这些票没有数据"要诚实得多）。

    返回值里 `__errors__` 是 list[str]；快照本身按符号名为键。
    """
    # 统一转成 Alpaca 认的形态（连字符 → 点），并去重保序
    syms = list(dict.fromkeys(to_alpaca_symbol(x) for x in symbols if x))
    if not syms:
        return {"__errors__": []}

    groups = list(batches(syms, batch))
    out, errors = {}, []

    bad = set()

    def one(g):
        """取一批。**遇到"invalid symbol"就把那个符号踢掉重试** ——
        实测：一个 BRK-A（Alpaca 认 BRK.A）会让**整批 500 只全部失败**，
        而且表现为"这些票没有数据"，不是"报错"，极易被当成行情源抽风。

        只踢 Alpaca 在错误里**点名**的那个符号，不整批降级 —— 否则一批里
        有个坏代码就白丢 499 只。
        """
        cur = [s for s in g if s not in bad]
        for _ in range(4):                       # 一批里最多容忍 4 个坏符号
            if not cur:
                return {}, None
            try:
                j = _get("/v2/stocks/snapshots", {"symbols": ",".join(cur), "feed": feed})
                return (j if isinstance(j, dict) else {}), None
            except AlpacaError as e:
                m = re.search(r"invalid symbol:\s*([A-Za-z0-9.\-]+)", str(e))
                if not m:
                    return {}, str(e)
                offender = m.group(1).upper()
                bad.add(offender)
                nxt = [s for s in cur if s.upper() != offender]
                if len(nxt) == len(cur):
                    return {}, str(e)            # 点名了但不在本批里，别再空转
                cur = nxt
        return {}, "坏符号太多，本批放弃"

    with ThreadPoolExecutor(max_workers=min(workers, len(groups))) as ex:
        for got, err in ex.map(one, groups):
            out.update(got)
            if err:
                errors.append(err)
    if bad:
        errors.append("数据源不认的代码（已跳过）：" + ",".join(sorted(bad)[:20]))

    out["__errors__"] = errors
    return out


def _norm_ts(ts):
    """把 `2026-09-22T07:59:23.707205806Z` 这类时间戳截到秒并统一成 UTC 字符串。

    Alpaca 给的是纳秒精度；比大小只要到秒，而且截断后更好打日志。
    """
    return (ts or "")[:19]


def _price_in_window(snap, win_start_utc, win_end_utc):
    """从快照里取**落在指定夜盘窗口内**的成交价与成交量。

    窗口校验不是洁癖，是必需：夜盘收盘后快照里仍留着上次夜盘的 `latestTrade`，
    不校验就会把**上一次夜盘**的价格当成今天的"实时价"，页面看起来一切正常。
    返回 `(price, ts, volume)`；不在窗口内则 `(None, ts, None)`。
    """
    tr = snap.get("latestTrade") or {}
    p, ts = tr.get("p"), _norm_ts(tr.get("t"))
    if not p or not ts:
        return None, ts, None
    if win_start_utc and ts < win_start_utc:
        return None, ts, None
    if win_end_utc and ts > win_end_utc:
        return None, ts, None
    bar = snap.get("dailyBar") or {}
    vol = bar.get("v")
    return float(p), ts, (int(vol) if isinstance(vol, (int, float)) else None)


def overnight_prices(symbols, win_start_utc, win_end_utc, **kw):
    """取夜盘实时价：`{symbol: {"price","ts","volume","barOpen","barHigh","barLow"}}`。

    只保留**窗口内**确实有成交的票 —— 夜盘流动性远低于常规时段，大量票整段没成交，
    把它们当成"0% 没动"混进结果里会稀释榜单。调用方按"没有键 = 没成交"处理。
    """
    snap = snapshots(symbols, feed="overnight", **kw)
    errors = snap.pop("__errors__", [])
    out = {}
    for sym, s in snap.items():
        price, ts, vol = _price_in_window(s, win_start_utc, win_end_utc)
        if price is None:
            continue
        bar = s.get("dailyBar") or {}
        out[sym] = {
            "price": price,
            "ts": ts,
            "volume": vol,
            "barOpen": bar.get("o"),
            "barHigh": bar.get("h"),
            "barLow": bar.get("l"),
        }
    out["__errors__"] = errors
    return out


def daily_closes(symbols, days=12, batch=50, workers=WORKERS, max_pages=40):
    """取最近若干个常规交易日的**日线收盘**，返回 `{symbol: [(t, close), ...]}`（按时间升序）。

    ⚠️ **只适合几十只的小批量。全市场拉不动，别拿它当夜盘涨跌的基准来源。**
    实测（2026-09-22）：50 只 13.4s、200 只 31.1s、1000 只直接跑挂；照这个速度
    推全市场（约 1.28 万只）要半小时以上。全市场基准改用 Finviz 的常规收盘（见 night_fetch）。
    本函数留着做**交叉核对** —— 两个独立来源对得上，基准才可信。

    **分页是必须的，而且是这里最容易踩的坑**：`limit` 是**整个请求的 bar 条数上限**，
    不是每只票的条数。所以 8 只 × 11 天的请求只回 2 只票的 bar，剩下的在
    `next_page_token` 里 —— 不翻页就会**静默截断**。实测现场：BRK.B 看着"日线停在 9/11"，
    其实只是被截断，单代码请求它数据是完整的。所以这里翻页翻不完就**直接抛错**，
    绝不返回半份数据（半份会让下游算出看着正常、其实漏了一半标的的榜单）。

    走 `feed=iex`：必须显式给 start/end（不给范围只返回一根）。
    历史日线**不受"最新 15 分钟不给"的限制**，盘中也照取 ——
    这点比快照的 `dailyBar.c` 强：那个在常规时段内是**盘中价**，同一调用一天里含义不同。
    """
    import datetime as _dt

    syms = [s for s in dict.fromkeys(symbols) if s]
    end = _dt.datetime.now(_dt.timezone.utc).date() + _dt.timedelta(days=1)
    start = end - _dt.timedelta(days=days + 3)       # 多留几天，跨周末/假期也够
    out, errors = {}, []

    for g in batches(syms, batch):
        token, pages = None, 0
        while True:
            params = {
                "symbols": ",".join(g), "timeframe": "1Day",
                "start": start.isoformat(), "end": end.isoformat(),
                "limit": min(1000, (days + 3) * len(g)), "adjustment": "raw", "feed": "iex",
            }
            if token:
                params["page_token"] = token
            try:
                j = _get("/v2/stocks/bars", params)
            except AlpacaError as e:
                errors.append(str(e))
                break
            for sym, bars in (j.get("bars") or {}).items():
                out.setdefault(sym, []).extend(bars)
            token = j.get("next_page_token")
            pages += 1
            if not token:
                break
            if pages >= max_pages:
                raise AlpacaError(
                    "日线分页超过 %d 页仍未取完（批 %d 只）—— 拒绝返回半份数据，请调小 batch"
                    % (max_pages, len(g)))

    for sym in list(out):
        bars = sorted(out[sym], key=lambda b: b.get("t") or "")
        out[sym] = [(_norm_ts(b.get("t")), float(b["c"])) for b in bars if b.get("c")]
    out["__errors__"] = errors
    return out


#: 基准最多能容忍几天前。**必须校验**，否则会静默用一个很旧的收盘价 ——
#: 实测踩过：被截断的 BRK.B 日线停在 9/11，拿它当基准算出的涨跌幅完全错。
#: 4 天足够跨周末（周五→周一）与小长假；再长就说明该票确实没有近期数据。
BASE_MAX_AGE_DAYS = 4


def close_before(daily, cutoff_utc, max_age_days=BASE_MAX_AGE_DAYS):
    """从 `daily_closes` 的结果里挑出**截止 `cutoff_utc` 之前最近一根**的收盘。

    `cutoff_utc` 传夜盘时段的**开始时刻**（UTC 字符串）。日线 `t` 是各交易日 00:00 ET
    （= 04:00Z），所以"夜盘开始那天"的日线会被自然排除，取到的正是
    **夜盘开始前刚收盘的那一个常规交易日** —— 周末与假期都不用特判：

        夜盘 2026-09-22T00:00Z 开始（= ET 9/21 20:00）
        → 9/21 日线 t=…-21T04:00Z ≤ cutoff ✓ 取到
        → 9/22 日线 t=…-22T04:00Z >  cutoff ✗ 排除（那是夜盘之后的常规时段）

    `max_age_days` 之外的**视为没有基准**（返回 None）：宁可少几只票，
    也不要拿过期的收盘价算出一个看起来很正常的错误涨跌幅。
    """
    import datetime as _dt

    def _naive(s):
        """统一成"无时区"的 datetime 再相减。

        日线的 `t` 经 `_norm_ts` 截断后是 `2026-09-21T04:00:00`（无时区），
        而调用方传的 `cutoff_utc` 常带尾随 `Z` —— 直接相减会抛
        `can't subtract offset-naive and offset-aware datetimes`。
        两者本来就都是 UTC，剥掉标记最省事。
        """
        return _dt.datetime.fromisoformat(str(s).replace("Z", "").replace("+00:00", ""))

    best = None
    for t, c in (daily or []):
        if t and t <= cutoff_utc and (best is None or t > best[0]):
            best = (t, c)
    if best is None:
        return None
    try:
        age = _naive(cutoff_utc) - _naive(best[0])
    except ValueError:
        return best
    return None if age.days > max_age_days else best

#: 基准最多能容忍几天前（天）。夜盘开始前最近一个常规交易日通常就在 0–3 天内
#: （周五→周一 / 小长假），更旧说明该票确实没有近期数据，宁可不要基准。
REF_MAX_AGE_DAYS = 5


def ref_closes(symbols, before_utc, max_age_days=REF_MAX_AGE_DAYS, **kw):
    """取**指定时刻之前最近一个常规交易日**的收盘价，作为夜盘涨跌幅的基准。

    返回 `{symbol: {"close": float, "date": str}}`，外加 `__errors__`。

    **一次快照就够，而且与"现在几点"无关** —— 这是它比 Finviz 强的地方：
    快照里同时带着 `dailyBar`（当天/最近一个常规日）与 `prevDailyBar`（再前一个），
    两个都按时间戳比一下 `before_utc`，取**最新的那个不晚于它的**。
    于是：
      · 常规时段内调用 → 两个 bar 里"当天那根"还在进行中，会被时间戳筛掉，
        自动落到 `prevDailyBar`（真正已收盘的那天）✓
      · 常规时段之外调用 → `dailyBar` 就是刚收盘那天 ✓
    不需要调用方判断时段，也就不存在"同一调用在一天里含义不同"的陷阱
    （Finviz 的 Price 正相反：常规时段内它是**盘中价**，拿它当收盘价会静默算错）。

    另外抽了**时间戳新鲜度**守卫：挑出来的那根若比 `before_utc` 早太多天，
    就视为没有基准而丢弃 —— 宁可在榜上少几只，也不要拿一个过期收盘价
    算出一个看起来完全正常的错误涨跌幅。
    """
    import datetime as _dt

    def _naive(x):
        return _dt.datetime.fromisoformat(str(x).replace("Z", "").replace("+00:00", ""))

    snap = snapshots(symbols, feed="iex", **kw)
    errors = snap.pop("__errors__", [])
    out = {}
    for sym, s in snap.items():
        best = None
        for key in ("dailyBar", "prevDailyBar"):
            bar = s.get(key) or {}
            t, c = _norm_ts(bar.get("t")), bar.get("c")
            if not t or not c or t > before_utc:
                continue
            if best is None or t > best[0]:
                best = (t, float(c))
        if best is None:
            continue
        try:
            if (_naive(before_utc) - _naive(best[0])).days > max_age_days:
                continue
        except ValueError:
            pass
        out[sym] = {"close": best[1], "date": best[0]}
    out["__errors__"] = errors
    return out

