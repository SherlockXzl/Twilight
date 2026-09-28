#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""语法自检：把根目录的 *.py 全部 ast.parse 一遍，**不写任何文件**。

    用法：python3 tools/lint_py_syntax.py

为什么不用 py_compile
--------------------
py_compile 的本职是**生成字节码**，语法检查只是顺带的 —— 它会往仓库里写
__pycache__。两个后果：

  · 一次"只读的语法检查"改了工作区，git status 凭空多出目录；
  · 在受限/只读环境里会直接失败。2026-09-28 在受限沙箱里跑 test_all.sh 就报了
    `Operation not permitted: '__pycache__/alpaca.cpython-313.pyc'` ——
    报出来的样子像"测试挂了"，其实是检查手段本身有副作用。

ast.parse 只解析、不落盘，语义正好是我们要的。

清单**从文件系统推导**，理由同 test_all.sh 里那段注释：硬编码的清单迟早落后于代码
（那边踩过两次：新增模块没进清单，于是从没被检查过）。
排除 build_*.py —— 一次性的数据快照脚本，不进运行时依赖。

退出码：0 = 全部通过；1 = 有文件语法错误或没找到文件。
"""

import ast
import glob
import os
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def targets():
    """根目录下的 *.py，排除 build_*（一次性快照脚本）。"""
    out = []
    for p in sorted(glob.glob(os.path.join(BASE_DIR, "*.py"))):
        if os.path.basename(p).startswith("build_"):
            continue
        out.append(p)
    return out


def main():
    files = targets()
    if not files:
        print("没找到任何 .py 文件，目录：%s" % BASE_DIR)
        return 1

    bad = []
    for p in files:
        try:
            with open(p, encoding="utf-8") as f:
                ast.parse(f.read(), filename=p)
        except SyntaxError as e:
            bad.append("%s:%s: %s" % (os.path.basename(p), e.lineno, e.msg))

    if bad:
        print("语法错误：")
        for b in bad:
            print("  " + b)
        return 1

    print("  Python 语法 OK（%d 个，ast 解析，不写字节码）：%s"
          % (len(files), " ".join(os.path.basename(p) for p in files)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
