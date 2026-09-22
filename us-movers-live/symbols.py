#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""美股代码目录 —— 给「个人关注池」的输入建议用。

数据源
------
nasdaqtrader.com 的两份官方符号目录（免费、无需 Key）：

    https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt   # NASDAQ 上市
    https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt    # NYSE / NYSE American 等

合计约 13k 条，含代码与公司全名。两份合计约 890KB、实测下载约 7 秒，
所以**只下这一次**，解析结果缓存到 `data/symbols.json`，7 天过期后重建。

为什么不直接用 westock 的 search 子命令（它确实有 `search`）
------------------------------------------------------------
实测过，三个原因都不合适：

  1. **约 1.5 秒一次**。输入建议是逐字触发的，这个延迟没法用（防抖到 500ms 也还是卡）。
  2. **`--limit` 不生效**：要 5 条给了 10 条。而且结果里混着大量 2 倍做多/做空 ETF ——
     搜 AAPL 时 AAPU / AAPD / AAPB / APLY 全出来了，正是本项目在别处（MORNING.md
     「必须做的过滤」第 1 条）明确要过滤掉的噪音。
  3. **代码形态不一致**：返回 `usAAPL.OQ`（带交易所后缀），内部形态是 `usAAPL`，还得再洗一遍。

本地目录则是一次构建、毫秒级查询，而且**排名规则由我们自己定**：正股排在 ETF 前面，
前缀命中排在包含命中前面。这直接解决了上面第 2 条的噪音问题。

代码形态
--------
目录里 `otherlisted` 用 `ACT Symbol` 列、类别股写成点号形态（`BRK.B`、`BF.B`），
与 westock 一致（finviz 用连字符，那是另一处的事，见 server.py 的说明）。
本模块对外给纯 ticker（`BRK.B`），`us` 前缀由调用方按内部约定补。
"""

import json
import os
import re
import threading
import urllib.request
from datetime import datetime, timedelta

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_PATH = os.path.join(BASE_DIR, "data", "symbols.json")

SOURCES = [
    # (地址, 代码列, 名称列, ETF 列, Test Issue 列)
    ("https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt",
     "Symbol", "Security Name", "ETF", "Test Issue"),
    ("https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt",
     "ACT Symbol", "Security Name", "ETF", "Test Issue"),
]

#: 缓存多久重建一次。目录本身是「上市清单」，变动很慢，一周足够。
MAX_AGE = timedelta(days=7)

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0 Safari/537.36")

_lock = threading.Lock()
_items = []          # [(symbol, name, is_etf)]，按下载顺序
_meta = {}           # {fetchedAt, count}
_building = False


# ------------------------------------------------------------------ 名称清洗

#: 目录里的名称带着证券类型后缀（「Apple Inc. Common Stock」）。
#: 只剥**结尾**这几个最常见的词，不做更激进的清洗 —— 目录格式不保证，
#: 猜多了容易把公司名本身削掉。
#:
#: 注意**不要**把 `Class A/B/C` 一起剥掉：同一家公司的不同类别股会因此变成同名。
#: 例如 Brown-Forman 的 BF.A / BF.B，剥掉后两条建议都叫「Brown Forman Inc」，
#: 在下拉里根本分不出谁是谁。留着 "Class B" 才是有信息量的。
_NAME_TAIL = re.compile(
    r"\s*(?:[-–—]\s*)?(?:Common Stock|Common Shares|Ordinary Shares|"
    r"Capital Stock|Depositary Shares|American Depositary Shares|"
    r"New Common Stock)\s*$", re.I)


def clean_name(name):
    """去掉结尾的证券类型后缀，让下拉里的名称短一些。"""
    s = str(name or "").strip()
    for _ in range(3):                      # 可能连着两三层（"... Class A Common Stock"）
        n = _NAME_TAIL.sub("", s).strip()
        if n == s:
            break
        s = n
    return s or str(name or "").strip()


# ------------------------------------------------------------------ 解析

def parse_dir(text, sym_col, name_col, etf_col, test_col):
    """把一份 `|` 分隔的目录文本解析成 [(symbol, name, is_etf)]。

    目录的坑：
      · 最后一行是 `File Creation Time: ...` 这种页脚，必须跳过（没有表头列数）；
      · `Test Issue = Y` 的是交易所的测试标的（如 ZZZTX），必须剔除 ——
        它们占着真实代码的位置，被用户选中会一直取不到行情。
    """
    rows, header = [], None
    for line in str(text or "").splitlines():
        line = line.strip()
        if not line or "|" not in line:
            continue
        cells = [c.strip() for c in line.split("|")]
        if header is None:
            header = cells
            continue
        if cells[:1] and cells[0].lower().startswith("file creation time"):
            continue
        col = {name: i for i, name in enumerate(header)}
        try:
            sym = cells[col[sym_col]]
            name = cells[col[name_col]]
        except (KeyError, IndexError):
            continue
        if not sym or not re.fullmatch(r"[A-Za-z][A-Za-z0-9.\-]{0,9}", sym):
            continue
        if test_col in col and col[test_col] < len(cells) and cells[col[test_col]].upper() == "Y":
            continue
        etf = (etf_col in col and col[etf_col] < len(cells)
               and cells[col[etf_col]].upper() == "Y")
        rows.append((sym.upper(), clean_name(name), bool(etf)))
    return rows


# ------------------------------------------------------------------ 构建 / 载入

def _download(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "ignore")


def build():
    """下载两份目录、解析、写缓存、更新内存。失败时返回 (False, 原因)。"""
    global _items, _meta
    try:
        merged, seen = [], set()
        for url, sym_col, name_col, etf_col, test_col in SOURCES:
            for sym, name, etf in parse_dir(_download(url), sym_col, name_col, etf_col, test_col):
                if sym in seen:
                    continue
                seen.add(sym)
                merged.append((sym, name, etf))
        if not merged:
            return False, "目录解析结果为空"
        merged.sort()                       # 稳定顺序，便于对比缓存差异
        os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
        tmp = CACHE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"fetchedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                       "count": len(merged),
                       "symbols": merged}, f, ensure_ascii=False)
        os.replace(tmp, CACHE_PATH)         # 原子替换：中途失败不会留下半截缓存
        _items = merged
        _meta = {"fetchedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "count": len(merged)}
        return True, ""
    except Exception as e:                  # noqa: BLE001 —— 网络问题不该让服务起不来
        return False, "%s: %s" % (type(e).__name__, e)


def _load_cache():
    global _items, _meta
    if not os.path.exists(CACHE_PATH):
        return False, "无缓存"
    try:
        with open(CACHE_PATH, encoding="utf-8") as f:
            d = json.load(f)
        items = [(r[0], r[1], bool(r[2])) for r in d.get("symbols") or [] if len(r) >= 2]
        if not items:
            return False, "缓存为空"
        _items = items
        _meta = {"fetchedAt": d.get("fetchedAt"), "count": len(items)}
        return True, ""
    except Exception as e:                  # noqa: BLE001
        return False, "缓存损坏：%s" % e


def _stale():
    ts = (_meta or {}).get("fetchedAt")
    if not ts:
        return True
    try:
        return datetime.now() - datetime.strptime(ts, "%Y-%m-%d %H:%M:%S") > MAX_AGE
    except ValueError:
        return True


def _build_async():
    global _building
    with _lock:
        if _building:
            return
        _building = True
    def run():
        global _building
        try:
            ok, err = build()
            if not ok:
                print("  [symbols] 构建失败，沿用现有数据：%s" % err)
        finally:
            with _lock:
                _building = False
    threading.Thread(target=run, daemon=True).start()


def ensure():
    """保证有一份可用目录。**非阻塞**：内存没有就先读缓存，缓存也没有才去后台下载。

    返回 (ready, 说明)。ready=False 时调用方应告诉前端"正在准备"，
    而不是报错 —— 首次启动的几秒里这个接口本来就该是空的。
    """
    if _items:
        if _stale():
            _build_async()
        return True, ""
    ok, err = _load_cache()
    if ok:
        if _stale():
            _build_async()
        return True, ""
    _build_async()
    return False, err


def status():
    return {"ready": bool(_items), "count": len(_items),
            "fetchedAt": (_meta or {}).get("fetchedAt"),
            "cachePath": CACHE_PATH, "stale": _stale() if _items else True,
            "building": _building}


# ------------------------------------------------------------------ 搜索

#: 排名序号（小者优先）。
_R_EXACT, _R_PREFIX, _R_SUBSTR, _R_NAME_PREFIX, _R_NAME = 0, 1, 2, 3, 4
_MAX_LIMIT = 50

#: 杠杆 / 反向 ETF 的名称特征 —— 与 MORNING.md「必须做的过滤」第 1 条**同一套关键词**，
#: 那边是把它们从异动榜里剔除，这里只是让它们在搜索建议里**沉底**（不删）。
#: 为什么需要这一条：目录里这类 ETF 极多，且常常**恰好占着某个短代码**。
#: 实测「NVD」这个词，按匹配档排的话第一是 NVD（GraniteShares 2x Short NVDL Daily ETF），
#: 而用户十有八九想打的是 NVDA。把它们沉底后 NVDA 就上来了，
#: 同时不影响真正想找 ETF 的人（搜 SOXL / PSI 时它们仍是唯一或最靠前的命中）。
_LEV_HINTS = ("2x", "3x", "1.5x", "2.5x", "bull", "bear", "short", "inverse",
              "ultra", "direxion", "proshares", "daily", "leverage")


def is_leveraged(name):
    n = str(name or "").lower()
    return any(h in n for h in _LEV_HINTS)


def search(q, limit=10):
    """模糊搜索，排序规则（三级，全部可复现）：

      1. **杠杆 / 反向 ETF 沉底**（名称特征见 _LEV_HINTS）—— 让正常人输代码时不被打扰；
      2. 匹配档：代码完全相等 > 代码前缀 > 代码包含 > 名称前缀 > 名称包含；
      3. 同档内正股优先于 ETF，再按代码字母序（保证两次搜索不会换顺序）。

    只做**子串**匹配，不做逐字符子序列（与 combo.js 的 Combo.match 同一套语义，
    全站的「模糊」是一个意思）。名称也参与匹配，所以打 "apple" 能找到 AAPL。
    """
    key = str(q or "").strip().lower()
    if not key or not _items:
        return []
    try:
        limit = max(1, min(int(limit or 10), _MAX_LIMIT))
    except (TypeError, ValueError):
        limit = 10

    hits = []
    for sym, name, etf in _items:
        s, n = sym.lower(), name.lower()
        if s == key:
            rank = _R_EXACT
        elif s.startswith(key):
            rank = _R_PREFIX
        elif key in s:
            rank = _R_SUBSTR
        elif n.startswith(key):
            rank = _R_NAME_PREFIX
        elif key in n:
            rank = _R_NAME
        else:
            continue
        hits.append((is_leveraged(name), rank, etf, sym, name))
    hits.sort(key=lambda t: (t[0], t[1], t[2], t[3]))
    return [{"symbol": t[3], "name": t[4], "etf": bool(t[2]),
             "leveraged": bool(t[0])} for t in hits[:limit]]


if __name__ == "__main__":
    import sys
    if "--rebuild" in sys.argv:
        ok, err = build()
        print("构建%s %s" % ("成功" if ok else "失败", err))
        if ok:
            print("  共 %d 条，缓存于 %s" % (len(_items), CACHE_PATH))
    else:
        ready, msg = ensure()
        print("ready=%s %s" % (ready, msg), status())
        for k in (sys.argv[1:] or ["AAPL", "BRK.B", "apple", "semi"]):
            print("  %-8s → %s" % (k, [r["symbol"] for r in search(k, 5)]))
