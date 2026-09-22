# -*- coding: utf-8 -*-
"""数据源适配层。每个 provider 只做一件事：返回一批"原始行"。

原始行结构（交给 screening.classify 归一化）：
    {"symbol","name","price","chg","marketCap","sector","industry","country","volume","source"}
其中 marketCap 必须是 float（单位美元），chg 是百分数数值（如 17.16 表示 +17.16%）。
"""

import html
import json
import random
import re
import time
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


class ProviderError(RuntimeError):
    pass


# ============================================================ Finviz

class FinvizProvider:
    """抓 Finviz 条件筛选页。

    选它的理由：它是少数几个**支持按涨跌幅 + 市值同时筛选**且无需 API Key 的公开源，
    一次请求就能拿到 代码/公司/板块/行业/国家/市值/价格/涨跌幅/成交量 全套字段，
    正好对上本项目的口径。代价是它属于页面抓取，需要自己做节流与失败退避。
    """

    name = "finviz"
    BASE = "https://finviz.com/screener"   # 注意：原 /screener.ashx 已改为 /screener（返回 301）

    #: 筛选条件 —— 三个字段依次为 (筛选表达式, 排序, 最多翻几页)
    #:
    #: 三个已踩过的坑，勿改回去：
    #: 1. 小市值档必须用 cap_smallover（≥$300M）而**不能**用 cap_midover，
    #:    因为 cap_midover 是"$2B 及以上"，会把百亿以上的标的也带进来，
    #:    结果按市值分档后全部落进大市值表，小市值表恒为空。
    #: 2. 小市值档按 **市值降序** 取数（-marketcap），而不是按涨跌幅降序 ——
    #:    涨幅最大的永远是微盘股，按涨跌幅排序会让 15–100 亿的标的沉到十几页之后。
    #:    按市值降序时，目标区间的标的都在前一两页。
    #: 3. **源层筛选要比目标阈值松 1 个百分点**（目标 ≥4% 就用 u3，目标 ≥10% 就用 u9）。
    #:    Finviz 的 ta_change_uN 粒度是 1 个百分点，实测 u3 最小 3.16%、u9 最小 9.84%，
    #:    但**无法确认恰好在阈值上的标的是否被包含**。留 1 个点余量后，由
    #:    screening.classify 用精确的 `>=` 判定 —— 否则收盘正好 4.00% 的票可能被源层漏掉。
    BANDS = {
        # 大市值（Large = $10bln 以上），目标 ≥4%，源层用 u3 留余量，按涨幅降序取全量
        "big_up":    ("cap_largeover,ta_change_u3",  "-change",    6),
        # 下跌档当前默认关闭（SHOW_DOWN=0）。注意它仍是 u4 的紧口径，
        # 若日后启用下跌档并要求「跌幅 ≥4%」，需同样改成 d3 并先验证该信号可用。
        "big_down":  ("cap_largeover,ta_change_d4",  "-change",    3),
        # 小市值以上（≥$300M），目标 ≥10%，源层用 u9 留余量，按市值降序交给 classify 分档
        "mid_up":    ("cap_smallover,ta_change_u9",  "-marketcap", 2),
        "mid_down":  ("cap_smallover,ta_change_d10", "-marketcap", 2),
        # 被剔除对照：全市场（≥$300M）涨幅榜前列，按涨幅降序，取一页作样例
        "excluded":  ("cap_smallover,ta_change_u9",  "-change",    1),
    }

    def __init__(self, page_delay=0.4, timeout=25):
        self.page_delay = page_delay
        self.timeout = timeout
        self.request_count = 0

    # ---------------------------------------------------------- HTTP

    def _get(self, url):
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
        })
        self.request_count += 1
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return resp.read().decode("utf-8", "ignore")
        except urllib.error.HTTPError as e:
            if e.code in (403, 429):
                raise ProviderError(
                    f"Finviz 拒绝了请求（HTTP {e.code}）—— 触发了限流，"
                    f"请把 REFRESH_SECONDS 调大（建议 120~300）后重试") from e
            raise ProviderError(f"Finviz HTTP {e.code}") from e
        except urllib.error.URLError as e:
            raise ProviderError(f"Finviz 网络不可达：{e.reason}") from e

    # ---------------------------------------------------------- 解析

    @staticmethod
    def _parse_page(src):
        rows = []
        for tr in re.findall(r'<tr[^>]*class="[^"]*styled-row[^"]*"[^>]*>(.*?)</tr>', src, re.S):
            cells = []
            for td in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S):
                txt = html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", td))).strip()
                cells.append(txt)
            if len(cells) < 11:
                continue
            m = re.search(r"[?&]t=([A-Za-z0-9.\-]+)", tr)
            symbol = m.group(1).upper() if m else cells[1].split()[-1]
            rows.append({
                "symbol": symbol,
                "name": cells[2],
                "sector": cells[3],
                "industry": cells[4],
                "country": cells[5],
                "marketCap": _cap(cells[6]),
                "price": cells[8],
                "chg": cells[9],
                "volume": cells[10],
                "source": "finviz",
            })
        return rows

    # ---------------------------------------------------------- 对外

    def fetch_band(self, band):
        filters, order, limit = self.BANDS[band]
        out = []
        for page in range(limit):
            url = f"{self.BASE}?v=111&f={filters}&o={order}"
            if page:
                url += f"&r={page * 20 + 1}"
            rows = self._parse_page(self._get(url))
            out.extend(rows)
            if len(rows) < 20:          # 已到最后一页
                break
            if page + 1 < limit:
                time.sleep(self.page_delay)
        return out

    def fetch_all(self, bands=None):
        """返回 {band: [raw_row, ...]}。任一档失败不阻断其它档。

        bands 指定本次要抓的分组（默认全部）。只看上涨时可只传 up 档，
        请求量直接减半 —— 对 60 秒刷新这种高频抓取，这一项很关键。
        """
        result, errors = {}, []
        for band in (bands or list(self.BANDS)):
            if band not in self.BANDS:
                raise ValueError(f"未知分组 {band!r}")
            try:
                result[band] = self.fetch_band(band)
            except ProviderError as e:
                result[band] = []
                errors.append(f"{band}: {e}")
        if not any(result.values()):
            raise ProviderError("；".join(errors) or "所有分组均未取到数据")
        result["_errors"] = errors
        return result

    def fetch_page(self, filters, order, page=0):
        """按筛选条件取**第 page 页**（0 起，每页 20 行）。

        给"爬全市场"用（night_fetch 的域/基准缓存）。之所以不在那边直接调
        `_parse_page(self._get(...))`：跨模块摸私有方法，改了内部实现就容易漏改调用方。
        """
        url = f"{self.BASE}?v=111&f={filters}&o={order}"
        if page:
            url += f"&r={page * 20 + 1}"
        return self._parse_page(self._get(url))

    def fetch_tickers(self, symbols):
        """按代码**精确**查一批票，返回解析后的原始行。用于「个人关注池」里用户自选的票。

        走的是筛选页的 `t=` 参数（不是另找接口）—— 实测 `?v=111&t=AAPL,TSLA` 返回的列
        与筛选结果**完全同构**，所以能复用同一个 _parse_page，也就不存在"两套解析各说各话"。
        好处还是一次请求拿全 名称/板块/行业/市值/价格/涨跌幅，前端不必再接第二个源。

        两个注意点：
        - **不存在的代码会被静默丢掉**，不报错。调用方要自己比对"请求了哪些、回来了哪些"，
          否则会把"代码打错了"当成"取数失败"给用户看。
        - 代码要传 Finviz 认的形态（纯 ticker，不带 `us` 前缀）；前缀由调用方剥。
        """
        symbols = [s for s in (symbols or []) if s]
        if not symbols:
            return []
        return self._parse_page(self._get(f"{self.BASE}?v=111&t={','.join(symbols)}"))


def _cap(s):
    """"344.86B" -> 344.86e9"""
    if not s:
        return None
    s = str(s).strip().replace(",", "").replace("$", "")
    m = re.match(r"^-?([\d.]+)\s*([KMBT]?)$", s)
    if not m:
        return None
    return float(m.group(1)) * {"": 1, "K": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}[m.group(2)]


# ============================================================ Mock

class MockProvider:
    """离线/演示用 —— 不联网，生成结构合法的假数据，便于在没有网络或被限流时验证前后端。"""

    name = "mock"
    _NAMES = [
        ("ARM", "Arm Holdings Plc ADR", "Technology", "Semiconductors"),
        ("INTC", "Intel Corp", "Technology", "Semiconductors"),
        ("META", "Meta Platforms Inc", "Communication Services", "Internet Content & Information"),
        ("WBD", "Warner Bros Discovery Inc", "Communication Services", "Entertainment"),
        ("NVO", "Novo Nordisk ADR", "Healthcare", "Drug Manufacturers - General"),
        ("VLO", "Valero Energy Corp", "Energy", "Oil & Gas Refining & Marketing"),
        ("GRAL", "Grail Inc", "Healthcare", "Diagnostics & Research"),
        ("FSLY", "Fastly Inc", "Technology", "Software - Infrastructure"),
        ("CRML", "Critical Metals Corp", "Basic Materials", "Other Industrial Metals & Mining"),
    ]

    def __init__(self, seed=20260921):
        self.rnd = random.Random(seed)

    def _rows(self, n, sign):
        out = []
        for i in range(n):
            sym, nm, sec, ind = self._NAMES[i % len(self._NAMES)]
            sym = f"{sym}{'' if i < len(self._NAMES) else i}"
            chg = round(sign * self.rnd.uniform(4, 18), 2)
            cap = self.rnd.choice([344.9e9, 643.7e9, 1.888e12, 77.2e9,
                                   1.76e11, 1.13e11, 4.82e9, 4.37e9, 1.37e9, 8.9e8])
            out.append({
                "symbol": sym, "name": nm, "sector": sec, "industry": ind,
                "country": "USA", "marketCap": cap,
                "price": round(self.rnd.uniform(10, 800), 2),
                "chg": f"{chg:+.2f}%",
                "volume": f"{self.rnd.randint(100000, 50000000):,}",
                "source": "mock",
            })
        return out

    def fetch_all(self):
        return {
            "big_up": self._rows(12, 1),
            "big_down": self._rows(5, -1),
            "mid_up": self._rows(7, 1),
            "mid_down": self._rows(3, -1),
            "excluded": self._rows(6, 1),
            "_errors": [],
        }


# ============================================================ 工厂

_PROVIDERS = {"finviz": FinvizProvider, "mock": MockProvider}


def build(name):
    name = (name or "finviz").lower()
    if name not in _PROVIDERS:
        raise ValueError(f"未知数据源 {name!r}，可选：{', '.join(_PROVIDERS)}")
    return _PROVIDERS[name]()
