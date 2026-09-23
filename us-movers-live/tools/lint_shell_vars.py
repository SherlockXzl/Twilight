#!/usr/bin/env python3
"""shell 变量多字节陷阱检查（回归用）。

    python3 tools/lint_shell_vars.py

背景（2026-09-23 踩到）：
macOS 自带的是 **bash 3.2**（GPLv2 之后 Apple 没再升级），它不是多字节安全的。
`$VAR` 后面**直接跟一个中文字符**时，bash 3.2 会把那个字符的字节并进变量名，
于是 `$HOST」...` 被解析成变量 `HOST<乱码>`；配合脚本开头的 `set -u`，
直接报 `line N: HOST?: unbound variable` 并中断。

    bad :  bad "「$HOST」不是完整域名"
    good :  bad "「${HOST}」不是完整域名"     # 加花括号，明确变量边界

这个错误只在**运行到那一行**时才炸，静态看很难发现 —— 所以固化成检查。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# $NAME 后面紧跟非 ASCII 字节。已经写成 ${NAME} 的不会命中（因为中间是 '}'）。
PATTERN = re.compile(rb"\$([A-Za-z_][A-Za-z0-9_]*)(?=[^\x00-\x7f])")

# 允许显式跳过的行：实在需要这种写法时，在行尾加这个标记并说明原因。
ALLOW = "# lint:allow-multibyte-var"


def scan(path: Path) -> list[tuple[int, str, str]]:
    raw = path.read_bytes()
    lines = raw.split(b"\n")
    hits: list[tuple[int, str, str]] = []
    for m in PATTERN.finditer(raw):
        lineno = raw.count(b"\n", 0, m.start()) + 1
        text = lines[lineno - 1].decode("utf-8", "replace")
        if ALLOW in text:
            continue
        hits.append((lineno, m.group(1).decode(), text.strip()))
    return hits


def main() -> int:
    targets = sorted(
        p
        for p in (list((ROOT / "tools").glob("*.sh")))
        if p.is_file()
    )
    if not targets:
        print("没有找到 .sh 脚本")
        return 0

    total = 0
    for path in targets:
        for lineno, name, text in scan(path):
            total += 1
            rel = path.relative_to(ROOT)
            print(f"✗ {rel}:{lineno}  ${name} 后面紧跟非 ASCII 字符 —— 改成 ${{{name}}}")
            print(f"    {text}")

    if total:
        print(f"\n共 {total} 处。这个写法在 macOS bash 3.2 + `set -u` 下会报 unbound variable。")
        return 1

    print(f"✓ 检查了 {len(targets)} 个脚本，没有 $VAR 紧跟多字节字符的写法")
    return 0


if __name__ == "__main__":
    sys.exit(main())
