FROM python:3.13-slim
WORKDIR /app
COPY server.py screening.py providers.py ./
COPY static ./static
ENV PORT=8787 SOURCE=finviz REFRESH_SECONDS=60
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8787/healthz',timeout=4)"
CMD ["python", "server.py"]
