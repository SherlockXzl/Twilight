#!/bin/bash
# 解析域名到**真实 IP** —— 给 share-url.sh / tunnel-setup.sh 共用。
#
#   source tools/lib-doh.sh
#   IP=$(doh_resolve_ip twilight-market.trade)            # 拿到 IP 或空串
#   IP=$(doh_resolve_ip_retry twilight-market.trade 3 15) # 带重试
#
# 为什么不能直接用 `curl https://域名/...`：
# 本机 DNS 被代理接管成 **fake-ip**（`198.18.x.x`），域名 curl 永远不通，
# 会被误判成"隧道坏了"。必须先拿到真实 IP 再 `curl --resolve`。
#
# 为什么不用系统解析器（nslookup/dig）：
# 它走的也是那个被接管的解析器；而且**刚新建的记录**本地还缓存着旧的 NXDOMAIN。
# 所以直接问 DoH。
#
# 为什么要多放几个源、还专门放国内源：
# 实测这台机器上 `1.1.1.1` / `8.8.8.8` / `dns.google` **都不通**
#（`dns.google` 连 `example.com` 都返回空响应），只信一个源会误报。
# 先后顺序：国内源在前（这台机器上稳），国外源兜底。
#
# 只认 IPv4：返回里的 CNAME 记录 type 是 5，不能拿；顺带校验一下点号数量，
# 免得把某些解析器返回的奇怪字符串当成 IP。

# 注意：调用方普遍开了 `set -u`，所以这里不要引用未定义的变量。
DOH_ENDPOINTS=(
  "https://dns.alidns.com/resolve?name=%s&type=A"
  "https://doh.pub/dns-query?name=%s&type=A"
  "https://1.1.1.1/dns-query?name=%s&type=A"
  "https://8.8.8.8/dns-query?name=%s&type=A"
  "https://dns.google/resolve?name=%s&type=A"
)

DOH_PY="${DOH_PY:-/Users/xuzhuoli/.workbuddy/binaries/python/versions/3.13.12/bin/python3}"

# 返回第一个解析出 IPv4 的源给出的地址；全失败则输出空串。
# 进度信息走 **stderr**（调用方用 $(...) 接 stdout，不会把日志混进 IP）。
doh_resolve_ip() {
  local host="$1" tpl url label ip
  for tpl in "${DOH_ENDPOINTS[@]}"; do
    url=$(printf "$tpl" "$host")
    label=$(printf '%s' "$url" | sed -E 's#https://([^/]+)/.*#\1#')
    ip=$(curl -s --noproxy '*' --max-time 10 \
           -H 'accept: application/dns-json' "$url" 2>/dev/null \
         | "$DOH_PY" -c "
import sys, json
try:
    d = json.load(sys.stdin)
    for a in d.get('Answer', []):
        # 只要 A 记录（type 1）；CNAME 是 5，拿来当 IP 用会炸
        if a.get('type') == 1:
            data = a.get('data', '')
            if data.count('.') == 3:
                print(data)
                break
except Exception:
    pass" 2>/dev/null)
    if [ -n "$ip" ]; then
      printf '  \033[33m·\033[0m 解析源 %s → %s\n' "$label" "$ip" >&2
      printf '%s' "$ip"
      return 0
    fi
    printf '  \033[33m·\033[0m 解析源 %s 没给出结果，换下一个\n' "$label" >&2
  done
  return 1
}

# 带重试版：刚写入的 DNS 记录要等一会儿才可见，所以隔一会儿再问一轮。
#   $1 主机名   $2 轮数（默认 3）   $3 每轮间隔秒（默认 15）
doh_resolve_ip_retry() {
  local host="$1" rounds="${2:-3}" gap="${3:-15}" i ip
  for i in $(seq 1 "$rounds"); do
    if ip=$(doh_resolve_ip "$host") && [ -n "$ip" ]; then
      printf '%s' "$ip"
      return 0
    fi
    if [ "$i" -lt "$rounds" ]; then
      printf '  \033[33m·\033[0m 都拿不到，等 %s 秒再试（第 %s/%s 轮）…\n' "$gap" "$i" "$rounds" >&2
      sleep "$gap"
    fi
  done
  return 1
}
