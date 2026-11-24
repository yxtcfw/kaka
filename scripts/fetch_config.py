#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从主站拉取站群配置，校验后 materialize 到本仓库 config/。

流程：manifest → 站点配置 → 模块契约（按 composition.modules 拉取并合并）→ 全局 names/ads → 校验 → 落盘。
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


def validate(cfg, modules, names, ads, digests):
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

    # v0.8：只校验 active 名单可用；tier / 全局 role_policy 已废弃
    active = [u for u in names if isinstance(u, dict) and u.get("active", True)
              and u.get("nick")]
    if not active:
        die("全局名单没有 active=true 的虚拟用户")
    # v0.8：tier 与全局 role_policy 已废弃；主笔策略下沉站点 writing，
    # fixed_lead 合法性在 generate.py 用 active 名单兜底（不在名单则回退随机）。

    ads_items = (ads or {}).get("items") or []
    for a in ads_items:
        nick = (a.get("nick") or "").strip()
        if nick and nick not in nicks:
            die("广告 nick <%s> 不在虚拟用户名单中" % nick)
    # v0.9：广告条数下沉站点 settings，global/ads.json 只放内容
    app = (cfg.get("shared") or {}).get("ads_per_page")
    if app is not None:
        try:
            if int(app) < 0:
                die("shared.ads_per_page 不能为负")
        except (TypeError, ValueError):
            die("shared.ads_per_page 不是整数")

    shared = cfg.get("shared") or {}
    if shared.get("names"):
        expected = digests.get(shared["names"])
        if expected and digests.get("_names") and expected != digests["_names"]:
            die("names.json sha256 不匹配")
    if shared.get("ads"):
        expected = digests.get(shared["ads"])
        if expected and digests.get("_ads") and expected != digests["_ads"]:
            die("ads.json sha256 不匹配")

    # 模块契约校验：composition.modules 必须非空，且每个模块契约要有 system_role
    comp = cfg.get("composition") or {}
    mod_ids = comp.get("modules") or []
    if not mod_ids:
        die("站点配置缺少 composition.modules")
    if "blog" not in mod_ids:
        die("composition.modules 必须包含 blog（正文模块是合集枢纽）")
    for mid in mod_ids:
        mdoc = modules.get(mid)
        if not mdoc:
            die("模块 <%s> 的契约未拉到" % mid)
        if not (mdoc.get("system_role") or "").strip():
            die("模块 <%s> 契约缺 system_role" % mid)

    log("校验通过：%d 个冻结关键词 / %d 条信源 / %d 个虚拟用户 / %d 条广告 / 模块 <%s>" %
        (len(kw["picked"]), len(sources), len(nicks), len(ads_items), ",".join(mod_ids)))


def materialize(cfg, modules, module_meta, names, ads, config_sha):
    site = cfg.get("site") or {}
    # base_url 由主站站点配置给出（自定义域名后为 https://yxtcfw.cn/kaka/）。
    # 它决定 sitemap/feed 里的绝对链接；留空会退化成相对路径。
    base_url = (site.get("base_url") or "").strip()
    write_json("site.json", {
        "name": site.get("name", ""),
        "tagline": site.get("tagline", ""),
        "description": site.get("description", ""),
        "author": site.get("author", ""),
        "footer": site.get("footer", ""),
        "lang": site.get("lang", "zh-CN"),
        "base_url": base_url,
        "notice": site.get("notice", ""),
        "main_url": (site.get("main_url") or "").strip() or "https://yxtcfw.cn",
    })

    write_json("sources.json", {
        "window_hours": cfg.get("window_hours", 48),
        "max_candidates": 24,
        "sources": cfg.get("sources") or [],
        "search": cfg.get("search") or {},
    })

    ai = cfg.get("ai") or {}
    write_json("writing.json", ai.get("writing") or {})

    # 兼容旧配置：新版把完整提示词模板放在 ai.persona/editorial/prompts，
    # 老配置可能只在 ai.prompt_* 里，统一在这里归一。
    if not ai.get("persona") and ai.get("prompt_role"):
        ai["persona"] = ai["prompt_role"]

    kw = cfg.get("keywords") or {}
    lines = ["# 由主站配置生成，请勿手动编辑",
             "# frozen_at: %s" % kw.get("frozen_at", "")]
    lines += list(kw.get("cores") or [])
    lines += list(kw.get("picked") or [])
    path = os.path.join(CONFIG, "keywords.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    log("写入 config/keywords.txt（%d 条）" % (len(lines) - 2))

    # 提示词 md：主站配置里的 ai.persona / ai.editorial / ai.prompts 是唯一事实来源，
    # 每次拉取都覆盖到 config/，分站不再依赖仓库里手写的静态 md。
    def write_text(name, text):
        path = os.path.join(CONFIG, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text if text.endswith("\n") else text + "\n")
        log("写入 config/%s" % name)

    prompts = ai.get("prompts") or {}
    # 空值不落盘：让 generate.py 用它自己的内置兜底，避免写出空模板反而坏掉
    if (ai.get("persona") or "").strip():
        write_text("persona.md", ai["persona"])
    if (ai.get("editorial") or "").strip():
        write_text("editorial.md", ai["editorial"])
    for key in ("write", "terms", "question"):
        body = prompts.get(key) or ""
        if body.strip():
            write_text("prompts/%s.md" % key, body)

    write_json("names.json", names)
    write_json("ads.json", ads)

    # 模块契约整份落盘（供 compositor / 调试读取）
    for mid, doc in modules.items():
        write_json("modules/%s.json" % mid, doc)

    # 合并各模块契约 → 一次请求的 prompt。顺序跟随 composition.modules。
    comp = cfg.get("composition") or {}
    mod_ids = comp.get("modules") or []
    merged = {
        "system_role": "\n\n".join(
            "[%s] %s" % (mid, modules[mid].get("system_role", ""))
            for mid in mod_ids if modules.get(mid, {}).get("system_role")),
        "structure_block": "\n\n".join(
            modules[mid].get("structure_block", "")
            for mid in mod_ids if modules.get(mid, {}).get("structure_block")),
        "format_block": "\n\n".join(
            modules[mid].get("format_block", "")
            for mid in mod_ids if modules.get(mid, {}).get("format_block")),
        "module_fields": {mid: modules[mid].get("fields", {}) for mid in mod_ids},
    }
    # 正文模块提供角色模型/风格默认（主笔策略仍由站点 writing 决定）
    blog = modules.get("blog") or {}
    merged["role_model"] = blog.get("role_model", "lead_support")
    merged["persona_default"] = blog.get("persona_default", "")
    merged["extra_rules_default"] = blog.get("extra_rules_default", "")
    merged["keyword_policy"] = blog.get("keyword_policy") or {}
    merged["editable"] = blog.get("editable") or {}

    runtime_cfg = {
        "site_id": SITE_ID,
        "fetched_at": datetime.datetime.now(datetime.timezone.utc)
                      .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "config_sha256": config_sha,
        "composition": comp,
        "module_sha256": module_meta,
        "renderer": "compositor.py",
        "content": merged,
        "request_policy": ai.get("request_policy") or {},
        "writing": ai.get("writing") or {},
        "keyword_anchor": bool(merged["keyword_policy"].get("anchor")),
        "ads_per_page": (cfg.get("shared") or {}).get("ads_per_page", 0),
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

    # 按 composition.modules 拉取模块契约，逐份校验 sha256
    comp = cfg.get("composition") or {}
    mod_ids = comp.get("modules") or []
    if not mod_ids:
        die("站点配置缺少 composition.modules")
    mod_meta = {}
    for entry in (manifest.get("modules") or []):
        if entry.get("file"):
            mod_meta[entry["file"]] = entry.get("sha256", "")
    modules = {}
    for mid in mod_ids:
        rel = "modules/%s.json" % mid
        doc, sha = fetch_json(rel)
        expected = mod_meta.get(rel)
        if expected and expected != sha:
            die("模块 %s sha256 不匹配（期望 %s，实际 %s）" % (mid, expected, sha))
        modules[mid] = doc

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

    validate(cfg, modules, names, ads, digests)

    materialize(cfg, modules, mod_meta, names, ads, cfg_sha)
    log("完成：配置已就绪（%d 个模块），可以开始生成" % len(modules))


if __name__ == "__main__":
    main()
