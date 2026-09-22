"""本地 `.env` 加载。

项目原本只认环境变量（见 `.env.example`），每次开服务都要 `KEY=... python3 server.py`。
Alpaca 要一对密钥，天天手打太容易出错，所以支持一个 `.env` 文件。

**优先级：真实环境变量 > `.env` > 代码默认值。**
真实环境变量优先是刻意的 —— 容器 / 云上（`render.yaml`、`Dockerfile`）注入的值
不该被仓库里的文件悄悄改掉；反过来，`.env` 只是本地开发的便利层。

`.env` 已在 `.gitignore` 里。**别把它提交上去。**
"""

import os

#: 项目根目录（本文件所在处）
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

#: 每次进程只读一次盘
_loaded = False


def _parse(text):
    """极简 .env 解析：`KEY=value`，支持 # 注释、引号、`export ` 前缀。

    不引入第三方依赖（python-dotenv）—— 项目全程零 pip 依赖（只用标准库），
    为了读几行配置破这个例不值得。也不做任何转义展开：密钥里出现 `$` 之类的
    字符时，展开反而会把密钥改坏。
    """
    out = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        if k:
            out[k] = v
    return out


def load(path=None):
    """把 `.env` 里的键灌进 `os.environ`（已存在的键不动）。返回注入的键名集合。"""
    global _loaded
    if _loaded:
        return set()
    _loaded = True

    p = path or os.path.join(BASE_DIR, ".env")
    try:
        with open(p, encoding="utf-8") as f:
            kv = _parse(f.read())
    except OSError:
        return set()                     # 没有 .env 是正常情况，不是错误

    injected = set()
    for k, v in kv.items():
        if k not in os.environ:          # 真实环境变量优先
            os.environ[k] = v
            injected.add(k)
    return injected
