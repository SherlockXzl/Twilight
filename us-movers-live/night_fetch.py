"""夜盘（美股 overnight session）—— 时段窗口、域与基准缓存、扫描、收盘快照。

**口径**（用户 2026-09-22 定，来源：富途官方交易时间说明）
    美股夜盘 = 美东 周日至周四 20:00 – 次日 04:00
    夏令时 = 北京时间 周一至周五 08:00–16:00；冬令时 09:00–17:00
    **收盘正好是北京时间下午 4 点**（冬令时 5 点），这就是"夜盘收盘"那一刻。

用户要的两件事在这套口径下分别对应：
    1. 非夜盘时间 → 显示**最近一次夜盘收盘**的快照（冻结在 `data/night_close.json`）
    2. 夜盘时间   → 显示**实时夜盘**数据（每轮扫一次）

**为什么不能沿用原来的 Finviz 筛法**：Finviz 的涨跌幅一律是**常规时段**的
（实测：连 Elite 也只到盘前 04:00–09:30 与盘后 16:00–20:00，夜盘那段 `20:00–04:00`
压根不在它的数据模型里；免费档连扩展时段都没有，`premarket/aftermarket` 开关是 0）。
所以"夜盘异动"必须自己算：**夜盘价 ÷ 前一个常规收盘 − 1**。

**基准（前一个常规收盘）从哪来**：从 Finviz 爬。一次爬同时解决四件事 ——
域（哪些票要扫）、市值、板块/行业、以及基准价。理由见下面 `build_universe` 的说明。
"""

import json
import os
import threading
import time
from datetime import datetime, time as dtime, timedelta, timezone
from zoneinfo import ZoneInfo

import alpaca
import providers

#: 时区表在这里本地定义，不去 import server —— server 会反过来 import 本模块，
#: 互相 import 会绕成死结。两个 ZoneInfo 常量的重复比那个代价小得多。
ET = ZoneInfo("America/New_York")
CST = ZoneInfo("Asia/Shanghai")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")

#: 域与基准缓存。**已加入 .gitignore**（运行产物，不该提交）。
UNIVERSE_PATH = os.path.join(DATA_DIR, "night_universe.json")

#: 夜盘收盘快照。非夜盘时间就显示这一份。
CLOSE_PATH = os.path.join(DATA_DIR, "night_close.json")

#: 夜盘起止（美东，小时）
NIGHT_START_HOUR = 20
NIGHT_HOURS = 8

#: 夜盘的**开始日**在美东的星期几（周日=6 … 周四=3）。
#: 周日 20:00 开始的那一场对应"周一"这个交易日，所以最后一场是周四 20:00（周五凌晨收）。
NIGHT_START_WEEKDAYS = (6, 0, 1, 2, 3)

#: 域缓存多久重建一次。夜盘每天一场，20 小时足以覆盖"每天在收盘后重建一次"。
UNIVERSE_MAX_AGE = 20 * 3600

#: 爬域时的页数上限（安全阀）。按市值降序翻，正常 100 页左右就跌破市值下限。
UNIVERSE_MAX_PAGES = 160

_ulock = threading.Lock()


# ------------------------------------------------------------ 时段窗口

def night_window(now=None):
    """算出**最近一场**夜盘的窗口。

    返回 dict：
        startEt / endEt        美东起止（ISO，带偏移）
        startUtc / endUtc      UTC 起止（**截到秒、不带 Z** —— alpaca.py 的窗口比对用这个格式）
        tradeDate              该场夜盘归属的交易日（美东日期，夜盘开始日的次日）
        inSession              此刻是否仍在场内
        closeCst               收盘那一刻的北京时间（页面上要展示的）

    找不到任何一场（理论上不会）返回 None。

    假期不特判：NYSE 休市前夜不设夜盘，那时扫不到数据，自然会得到一份空名单 ——
    这比按节假日表猜要诚实（猜错了会显示上一场的陈旧数据）。
    """
    now_et = (now or datetime.now(timezone.utc)).astimezone(ET)

    starts = []
    for back in range(0, 6):                    # 往前找 6 天，跨周末也够
        d = now_et.date() - timedelta(days=back)
        if d.weekday() in NIGHT_START_WEEKDAYS:
            starts.append(datetime.combine(d, dtime(NIGHT_START_HOUR, 0), tzinfo=ET))
    starts = [s for s in sorted(starts) if s <= now_et]
    if not starts:
        return None

    start = starts[-1]
    end = start + timedelta(hours=NIGHT_HOURS)

    def utc(dt):
        return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")

    return {
        "startEt": start.isoformat(),
        "endEt": end.isoformat(),
        "startUtc": utc(start),
        "endUtc": utc(end),
        "tradeDate": (start.date() + timedelta(days=1)).isoformat(),
        "inSession": now_et < end,
        "closeCst": end.astimezone(CST).strftime("%m月%d日 %H:%M"),
    }


# ------------------------------------------------------------ 域 / 基准缓存

def load_universe():
    try:
        with open(UNIVERSE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def save_universe(obj):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = UNIVERSE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, UNIVERSE_PATH)          # 原子替换：半截文件比没有文件更危险


def build_universe(cfg, provider=None, max_pages=UNIVERSE_MAX_PAGES, log=print):
    """爬 Finviz 建域与基准缓存。按**市值降序**翻页，跌破下限即停。

    为什么用 Finviz 而不是 Alpaca 的历史日线取基准：Alpaca 的历史**太慢**。
    实测 50 只 13.4s、200 只 31.1s、1000 只直接跑挂 —— 推全市场要半小时以上，
    完全不可用。Finviz 一次爬完顺带把市值/板块/行业也拿了，反而更省。

    ⚠️ **别在美股常规时段（美东 09:30–16:00）重建**：那时 Finviz 的 Price 是
    盘中价，拿它当"前一个常规收盘"是错的，而且错得看不出来。调用方负责把关
    （`universe()` 里有判断，见下）。

    市值下限取 `min(big_min_cap, mid_min_cap)` —— 比它小的票就算涨到天上也进不了
    任何一张表（只会进剔除对照），不值得扫。**注意剔除对照表会因此少一批极小的票**，
    这是刻意取舍：夜盘扫全市场的代价远大于对照表的完整性。
    """
    prov = provider or providers.FinvizProvider()
    floor = min(cfg["big_min_cap"], cfg["mid_min_cap"])

    rows, seen = [], set()
    for page in range(max_pages):
        page_rows = prov.fetch_page("cap_smallover", "-marketcap", page)
        if not page_rows:
            break
        stop = False
        for r in page_rows:
            cap = r.get("marketCap")
            if cap is None or cap < floor:
                stop = True                 # 已按市值降序 → 后面只会更小
                break
            # Finviz 的类别股写连字符（BRK-B），Alpaca 认点（BRK.B）——
            # 在这里一次转好，后面域、缓存、展示、入参全都是同一形态，不用来回换。
            sym = alpaca.to_alpaca_symbol(r.get("symbol"))
            if not sym or sym in seen:
                continue
            seen.add(sym)
            rows.append({
                "symbol": sym,
                "name": r.get("name") or "",
                "sector": r.get("sector") or "",
                "industry": r.get("industry") or "",
                "country": r.get("country") or "",
                "marketCap": cap,
                # 注意：**这里不存价格** —— 基准价一律由 alpaca.ref_closes 现取。
                # 曾经在这里存过 Finviz 的 Price，那是个陷阱：常规时段内它是盘中价。
                "volume": screening_num(r.get("volume")),
            })
        log(f"  域爬取 第 {page + 1} 页 → 累计 {len(rows)} 只")
        if stop:
            break
        if page + 1 < max_pages:
            time.sleep(prov.page_delay)

    return {
        "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "floorCap": floor,
        "count": len(rows),
        "rows": rows,
    }


def screening_num(s):
    """把 Finviz 的字符串数字转成 float（`1.23M` / `4,567` / `1.2%`）。

    刻意不复用 screening.parse_num —— 那个服务于"涨跌幅/成交量"的语义，
    这里只要一个宽松的数字解析。宁可重复十行，也不要为了省十行把两个模块耦上。
    """
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return float(s)
    t = str(s).replace(",", "").replace("%", "").strip()
    if not t:
        return None
    mult = 1.0
    if t[-1:].upper() in ("K", "M", "B", "T"):
        mult = {"K": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}[t[-1].upper()]
        t = t[:-1]
    try:
        return float(t) * mult
    except ValueError:
        return None


def _mtime(path):
    """文件修改时间；文件不存在返回 0（= 一定算"过期"）。"""
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0.0


def universe(cfg, log=print):
    """**只读**域缓存。没有 / 过期就返回 None，并把重建交给 `universe_loop`。

    刻意**不在这里惰性重建**：一次爬取实测约 6 分钟（117 页 / 2329 只，约 3.1 秒/页），
    塞进任何一次"取行情"里都会让那一轮卡半小时，还会占着缓存锁。
    重建是独立后台线程的事，取数只管用现成的。
    """
    cached = load_universe()
    if not cached or not cached.get("rows"):
        return None
    return cached


def universe_stale():
    """缓存是否该重建（不存在、或超过 UNIVERSE_MAX_AGE）。"""
    if not os.path.exists(UNIVERSE_PATH):
        return True
    return (time.time() - _mtime(UNIVERSE_PATH)) >= UNIVERSE_MAX_AGE


def universe_loop(cfg, log=print):
    """后台线程：域缓存过期就重建。

    为什么单独开线程而不是在 `scan()` 里顺手建：一次爬取实测**约 6 分钟**
    （117 页 / 2329 只，约 3.1 秒/页；也见过被限速到十几秒一页的情况）。
    放在取数路径里会让那一轮轮询卡住好几分钟甚至更久；放在这里则完全不影响实时性 ——
    没缓存期间 `scan()` 会如实报"无域缓存"，页面显示等待，而不是假装没异动。

    失败不影响服务：保留上一份缓存，退避后重试。
    """
    fails = 0
    while True:
        if universe_stale():
            log("  域缓存过期/缺失 → 后台重建（实测约 6 分钟，期间夜盘页显示等待）")
            try:
                obj = build_universe(cfg, log=log)
                if obj["count"]:
                    save_universe(obj)
                    fails = 0
                    log(f"  域缓存完成：{obj['count']} 只（市值 ≥ {obj['floorCap'] / 1e8:.0f} 亿美元）")
                else:
                    raise RuntimeError("Finviz 没回数据")
            except Exception as e:                       # noqa: BLE001
                fails += 1
                log(f"  域缓存重建失败（第 {fails} 次）：{type(e).__name__}: {e}")
            # 成功则 20 小时后再来；失败则退避（5 分钟起，最多 30 分钟）
            time.sleep(300 * min(fails, 6) if fails else UNIVERSE_MAX_AGE)
        else:
            time.sleep(600)


# ------------------------------------------------------------ 扫描

#: 预筛余量（百分点）。阈值本身在 screening.classify 里用精确 `>=` 判定，
#: 这里只是为了少算几只票而留一点余量，不能反过来把边界票筛掉。
PREFILTER_MARGIN = 0.1


def scan(cfg, show_down=False, log=print):
    """扫一轮夜盘，返回**与 Finviz 同结构**的原始行，可直接喂 `screening.classify`。

    同结构是刻意的：下游的分档、剔除、口径行、前端渲染一行都不用改 ——
    只把"谁涨了"的来源从 Finviz 的常规涨跌幅换成夜盘涨跌幅。

    涨跌幅 = 夜盘最新成交价 ÷ 前一个常规收盘 − 1。
    **注意不是用夜盘快照里的 `prevDailyBar`** —— 那是**上一个夜盘**的收盘，
    不是常规收盘（实测 AAPL overnight prevDailyBar=335.74 vs 常规 339，不等）。
    """
    uni = universe(cfg, log=log)
    if not uni or not uni.get("rows"):
        return [], {"reason": "无域/基准缓存"}

    win = night_window()
    if not win:
        return [], {"reason": "算不出夜盘窗口"}

    syms = [r["symbol"] for r in uni["rows"]]
    by_sym = {r["symbol"]: r for r in uni["rows"]}

    # 基准价**走 Alpaca 快照，不用域缓存里的 Finviz Price**：
    # Finviz 在常规时段内给的是盘中价，拿它当"夜盘前一个常规收盘"会静默算错；
    # 而 Alpaca 快照里两根日线按时间戳挑，无论什么时候调都对（见 alpaca.ref_closes）。
    log(f"  取基准价（{len(syms)} 只，截止 {win['startUtc']}）…")
    bases = alpaca.ref_closes(syms, win["startUtc"])
    base_err = bases.pop("__errors__", [])
    log(f"  拿到基准 {len(bases)} 只")

    log(f"  夜盘扫描：{len(syms)} 只（窗口 {win['startUtc']} → {win['endUtc']}）…")
    q = alpaca.overnight_prices(syms, win["startUtc"], win["endUtc"])
    errors = q.pop("__errors__", [])
    if not q:
        return [], {"reason": "夜盘无成交数据（可能是假期或刚开盘）", "errors": errors}

    floor = min(cfg["big_pct"], cfg["mid_pct"]) - PREFILTER_MARGIN
    rows, no_base, dropped = [], 0, 0

    for sym, v in q.items():
        base = by_sym.get(sym) or {}
        ref = (bases.get(sym) or {}).get("close")
        if not ref:
            no_base += 1
            continue
        chg = (v["price"] / ref - 1) * 100
        if chg < floor and not (show_down and chg <= -floor):
            continue
        # 市值按"股数不变、价格变"实时折算：夜盘涨 50% 的票市值也该涨 50%，
        # 否则一只从 14 亿涨到 21 亿的票会被市值门槛错误地剔除。
        cap = base.get("marketCap")
        if cap:
            cap = cap * v["price"] / ref
        rows.append({
            "symbol": sym,
            "name": base.get("name") or "",
            "sector": base.get("sector") or "",
            "industry": base.get("industry") or "",
            "country": base.get("country") or "",
            "marketCap": cap,
            "price": f"{v['price']:.2f}",
            "chg": f"{chg:+.2f}%",
            "volume": v.get("volume"),
            "source": "alpaca-overnight",
        })

    meta = {
        "session": win,
        "universe": len(syms),
        "quoted": len(q),
        "noBaseline": no_base,
        "dropped": dropped,
        "errors": errors + base_err,
        "candidates": len(rows),
    }
    log(f"  夜盘命中 {len(rows)} 只（有报价 {len(q)}／无基准 {no_base}）")
    return rows, meta


# ------------------------------------------------------------ 收盘快照

def save_close(payload, meta):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = CLOSE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"savedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                   "meta": meta, "payload": payload}, f, ensure_ascii=False)
    os.replace(tmp, CLOSE_PATH)


def load_close():
    try:
        with open(CLOSE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None
