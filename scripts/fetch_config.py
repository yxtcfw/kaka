#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从主站拉取站群配置，校验后 materialize 到本仓库 config/。

流程：manifest → 站点配置 → 主题配置 → 全局 names/ads → 校验 → 落盘。
任何一步失败都直接退出，绝不使用本地旧配置兜底。

环境变量：
  SITE_ID           站点 id，默认 kaka
  MAIN_CONFIG_BASE  主站配置根地址，默认 raw.githubusercontent.com/.../docs/config
"""

import datetime
import hashlib
import json
import os
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(ROOT, "config")
SITE_ID = os.environ.get("SITE_ID", "kaka").strip() or "kaka"
BASE = os.environ.get(
    "MAIN_CONFIG_BASE",
    "https://raw.githubusercontent.com/yxtcfw/yxtcfw.github.io/master/docs/config",
).rstrip("/")
TIMEOUT = 25


def log(*a):
    print("[fetch_config]", *a, flush=True)


def die(msg):
    log("FAILED:", msg)
    sys.exit(1)


def fetch_json(rel):
    # 加时间戳绕过 raw.githubusercontent.com 的 CDN 缓存，确保 dispatch 后立即拿到最新配置
    url = "%s/%s?t=%d" % (BASE, rel.lstrip("/"), int(time.time()))
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "kaka-config-fetch/1.0"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            raw = r.read()
    except Exception as e:
        die("下载 %s 失败: %r" % (rel, e))
    try:
        return json.loads(raw.decode("utf-8")), hashlib.sha256(raw).hexdigest()
    except Exception as e:
        die("解析 %s 失败: %r" % (rel, e))


def write_json(name, data):
    path = os.path.join(CONFIG, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    log("写入 config/%s" % name)


def validate(cfg, theme, names, ads, digests):
    if cfg.get("schema_version") != "1.0.0":
        die("站点配置 schema_version 不匹配")

    kw = cfg.get("keywords") or {}
    if not kw.get("picked"):
        die("keywords.picked 为空，禁止运行")
    if kw.get("policy") != "picked_only":
        die("keywords.policy 不是 picked_only")

    sources = [s for s in (cfg.get("sources") or [])
               if s.get("enabled") and s.get("server_fetchable")]
    if not sources:
        die("没有 enabled && server_fetchable 的信源")

    runtime = cfg.get("runtime") or {}
    if runtime.get("forbid_browser_cache") and any(
        "GM_" in json.dumps(s, ensure_ascii=False) for s in sources
    ):
        die("信源里疑似含浏览器缓存字段")

    if not isinstance(names, list) or not names:
        die("全局虚拟用户名单为空")
    nicks = [u.get("nick") for u in names if isinstance(u, dict) and u.get("nick")]
    if len(nicks) != len(set(nicks)):
        die("虚拟用户名单 nick 重复")
    if len(nicks) < 5:
        log("警告：虚拟用户不足 5 个")

    ads_items = (ads or {}).get("items") or []
    for a in ads_items:
        nick = (a.get("nick") or "").strip()
        if nick and nick not in nicks:
            die("广告 nick <%s> 不在虚拟用户名单中" % nick)

    shared = cfg.get("shared") or {}
    if shared.get("names"):
        expected = digests.get(shared["names"])
        if expected and digests.get("_names") and expected != digests["_names"]:
            die("names.json sha256 不匹配")
    if shared.get("ads"):
        expected = digests.get(shared["ads"])
        if expected and digests.get("_ads") and expected != digests["_ads"]:
            die("ads.json sha256 不匹配")

    log("校验通过：%d 个冻结关键词 / %d 条信源 / %d 个虚拟用户 / %d 条广告" %
        (len(kw["picked"]), len(sources), len(nicks), len(ads_items)))


def materialize(cfg, theme, names, ads, config_sha):
    site = cfg.get("site") or {}
    write_json("site.json", {
        "name": site.get("name", ""),
        "tagline": site.get("tagline", ""),
        "description": site.get("description", ""),
        "author": site.get("author", ""),
        "footer": site.get("footer", ""),
        "lang": site.get("lang", "zh-CN"),
        "base_url": "",
    })

    write_json("sources.json", {
        "window_hours": cfg.get("window_hours", 48),
        "max_candidates": 24,
        "sources": cfg.get("sources") or [],
        "search": cfg.get("search") or {},
    })

    ai = cfg.get("ai") or {}
    write_json("writing.json", ai.get("writing") or {})

    kw = cfg.get("keywords") or {}
    lines = ["# 由主站配置生成，请勿手动编辑",
             "# frozen_at: %s" % kw.get("frozen_at", "")]
    lines += list(kw.get("cores") or [])
    lines += list(kw.get("picked") or [])
    path = os.path.join(CONFIG, "keywords.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    log("写入 config/keywords.txt（%d 条）" % (len(lines) - 2))

    write_json("names.json", names)
    write_json("ads.json", ads)
    write_json("theme.json", theme)

    runtime_cfg = {
        "site_id": SITE_ID,
        "fetched_at": datetime.datetime.now(datetime.timezone.utc)
                      .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "config_sha256": config_sha,
        "theme": theme.get("theme", ""),
        "slots": theme.get("slots") or {},
        "request_policy": ai.get("request_policy") or {},
        "keyword_anchor": bool((ai.get("constraints") or {}).get("keyword_anchor")),
    }
    write_json("generated.json", runtime_cfg)


def main():
    log("SITE_ID=%s  BASE=%s" % (SITE_ID, BASE))

    manifest, _ = fetch_json("manifest.json")
    mine = next((s for s in (manifest.get("sites") or []) if s.get("id") == SITE_ID), None)
    if not mine:
        die("manifest 里找不到 site_id=%s" % SITE_ID)
    if not mine.get("enabled"):
        die("站点 %s 已被主站禁用" % SITE_ID)

    cfg, cfg_sha = fetch_json(mine["config"])
    if cfg_sha != mine.get("sha256"):
        die("站点配置 sha256 不匹配（期望 %s，实际 %s）" % (mine.get("sha256"), cfg_sha))

    theme_rel = "themes/%s.json" % ((cfg.get("theme") or {}).get("id") or "forum")
    theme, _ = fetch_json(theme_rel)

    shared = cfg.get("shared") or {}
    names_rel = shared.get("names") or "global/names.json"
    ads_rel = shared.get("ads") or "global/ads.json"
    names, names_sha = fetch_json(names_rel)
    ads, ads_sha = fetch_json(ads_rel)

    digests = {}
    for entry in (manifest.get("global") or []):
        if entry.get("file"):
            digests[entry["file"]] = entry.get("sha256", "")
    digests["_names"] = names_sha
    digests["_ads"] = ads_sha

    validate(cfg, theme, names, ads, digests)

    materialize(cfg, theme, names, ads, cfg_sha)
    log("完成：配置已就绪，可以开始生成")


if __name__ == "__main__":
    main()
