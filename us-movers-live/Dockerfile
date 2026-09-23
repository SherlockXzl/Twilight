FROM python:3.13-slim

WORKDIR /app

# 运行时需要的模块。**注意这张清单必须跟着代码走**：
# 2026-09-23 之前这里只 COPY 了 server/screening/providers 三个，
# 而 server.py 后来加了 alpaca / night_fetch / settings / symbols / morning_fetch，
# screening 又依赖 taxonomy_zh —— 缺任何一个，容器起来就 ImportError，
# 而且是在 Render 上才暴露（本地直接跑源码不会碰 Dockerfile）。
COPY server.py \
     screening.py \
     taxonomy_zh.py \
     providers.py \
     symbols.py \
     morning_fetch.py \
     night_fetch.py \
     alpaca.py \
     settings.py \
     ./

COPY static ./static

# 口径默认值。密钥**不在这里**（见 render.yaml 的 sync:false，由 Render 后台注入）。
# REFRESH_SECONDS 已废弃（旧的"常规时段每 60 秒抓一次"口径），现在是 NIGHT_POLL_SECONDS。
ENV PORT=8787 \
    SOURCE=alpaca \
    SHOW_DOWN=0 \
    NIGHT_POLL_SECONDS=180

EXPOSE 8787

# data/ 不 COPY（在 .gitignore 里）：目录由代码自己 makedirs；
# 代码目录缓存（symbols.json）会自己下载，夜盘域缓存（night_universe.json）会自己爬。
HEALTHCHECK --interval=60s --timeout=5s --start-period=90s \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8787/healthz',timeout=4)"

CMD ["python", "server.py"]
