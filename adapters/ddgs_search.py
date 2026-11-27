#!/usr/bin/env python3
"""DDG 搜索适配器（无需 API key），供 Node 侧经 fetch-guard 限速后调用。

Termux 安装：
  pkg install python
  pip install ddgs        # 旧包名 duckduckgo-search 也兼容

用法：
  python3 adapters/ddgs_search.py "流量卡资费" 5 duckduckgo

输出：JSON 数组 [{"url", "title", "snippet", "provider"}] 到 stdout；
失败时输出 {"error": "..."} 并以非零码退出，由 Node 侧显式降级，不静默伪造。
"""
import json
import os
import sys


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: ddgs_search.py QUERY [MAX_RESULTS]"}, ensure_ascii=False))
        sys.exit(2)
    query = sys.argv[1]
    try:
        max_results = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    except ValueError:
        max_results = 5

    try:
        try:
            from ddgs import DDGS
        except ImportError:
            from duckduckgo_search import DDGS

        rows = []
        if len(sys.argv) > 3:
            backends = [sys.argv[3]]
        else:
            backends = [b.strip() for b in os.environ.get(
                "DDGS_BACKENDS", "duckduckgo,html,lite,brave,mojeek,google"
            ).split(",") if b.strip()]
        errors = []
        for backend in backends:
            try:
                rows = []
                with DDGS() as ddg:
                    for item in ddg.text(query, max_results=max_results, backend=backend):
                        url = item.get("href") or item.get("url") or ""
                        if not url:
                            continue
                        rows.append({
                            "url": url,
                            "title": item.get("title") or url,
                            "snippet": item.get("body") or item.get("snippet") or item.get("content") or "",
                            "provider": "ddgs",
                        })
                if rows:
                    break
                errors.append(f"{backend}: no results")
            except Exception as exc:
                errors.append(f"{backend}: {type(exc).__name__}: {exc}")
        if not rows:
            print(json.dumps({"error": " | ".join(errors)[:400]}, ensure_ascii=False))
            sys.exit(1)
        print(json.dumps(rows, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
