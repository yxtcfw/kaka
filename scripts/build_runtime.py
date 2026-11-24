#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
站点自包含运行配置构建器：只读本站 config/，不联网、不拉主站配置。

输入（全部在站点仓库内）：
  config/site.json          基础配置 + composition + ai + shared + gateway
  config/keywords.json      关键词（picked 为冻结选题锚）
  config/sources.json       信源清单
  config/names.json         虚拟人名单
  config/ads.json           广告
  config/modules/*.json     模块契约
  config/tree.json          内容树（阶段3起参与选题，这里只校验存在）

输出：
  config/generated.json     运行时配置（generate.py / compositor.py 读取）
  config/writing.json       从 site.ai.writing 物化，兼容现有 generate.py
  config/keywords.txt       从 keywords.json 物化，兼容旧读取路径

设计约束：站点仓库自包含；主站不再下发配置；本地校验失败直接退出，不用旧配置兜底。
"""

import hashlib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(ROOT, "config")


def log(*a):
    print("[build_runtime]", *a, flush=True)


def die(msg):
    log("ERROR:", msg)
    sys.exit(1)


def load_json(name, default):
    path = os.path.join(CONFIG, name)
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        die("读取 config/%s 失败：%r" % (name, e))


def write_json(name, data):
    path = os.path.join(CONFIG, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    log("写入 config/%s" % name)


def write_text(name, text):
    path = os.path.join(CONFIG, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text if text.endswith("\n") else text + "\n")
    log("写入 config/%s" % name)


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def config_digest(rel_files):
    h = hashlib.sha256()
    for rel in sorted(rel_files):
        path = os.path.join(CONFIG, rel)
        if not os.path.exists(path):
            die("配置指纹缺少文件：config/%s" % rel)
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        with open(path, "rb") as f:
            h.update(f.read())
        h.update(b"\0")
    return h.hexdigest()


def validate(site, keywords, sources, names, ads, modules, comp):
    if not site.get("id"):
        die("site.json 缺少 id")
    if not (keywords.get("picked") or []):
        die("keywords.json 的 picked 不能为空（冻结选题锚）")
    if (keywords.get("policy") or "picked_only") != "picked_only":
        die("keywords.json 只支持 policy=picked_only")
    usable = [s for s in (sources.get("sources") or [])
              if s.get("enabled") and s.get("server_fetchable", True)]
    if not usable:
        die("sources.json 至少要有 1 条 enabled 且 server_fetchable 的信源")
    nicks = [r.get("nick") for r in names if isinstance(r, dict) and r.get("nick")]
    if not nicks:
        die("names.json 不能为空")
    if len(nicks) != len(set(nicks)):
        die("names.json 存在重复 nick")
    if not any(r.get("active", True) for r in names if isinstance(r, dict)):
        die("names.json 至少要有 1 个 active 成员")
    ad_nicks = [a.get("nick") for a in (ads.get("items") or []) if a.get("nick")]
    unknown = [n for n in ad_nicks if n not in nicks]
    if unknown:
        die("ads.json 出现名单外 nick：%s" % ", ".join(unknown))
    per_page = (site.get("shared") or {}).get("ads_per_page", 0)
    if not isinstance(per_page, int) or per_page < 0:
        die("site.json shared.ads_per_page 必须是非负整数")
    mod_ids = comp.get("modules") or []
    if not mod_ids or "blog" not in mod_ids:
        die("composition.modules 不能为空且必须包含 blog")
    missing = [m for m in mod_ids if not (modules.get(m) or {}).get("system_role")]
    if missing:
        die("模块契约缺少 system_role：%s" % ", ".join(missing))
    if not os.path.exists(os.path.join(CONFIG, "tree.json")):
        die("缺少 config/tree.json")


def merge_modules(comp, modules):
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
    blog = modules.get("blog") or {}
    merged["role_model"] = blog.get("role_model", "lead_support")
    merged["persona_default"] = blog.get("persona_default", "")
    merged["extra_rules_default"] = blog.get("extra_rules_default", "")
    merged["keyword_policy"] = blog.get("keyword_policy") or {
        "anchor": True, "scope": "same_article", "term_source": "picked_only"}
    merged["editable"] = blog.get("editable") or {}
    return merged


def load_modules():
    mod_dir = os.path.join(CONFIG, "modules")
    if not os.path.isdir(mod_dir):
        die("缺少 config/modules/ 目录")
    modules, hashes = {}, {}
    for name in sorted(os.listdir(mod_dir)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(mod_dir, name)
        with open(path, "rb") as f:
            raw = f.read()
        doc = json.loads(raw.decode("utf-8"))
        mid = doc.get("module") or name[:-5]
        modules[mid] = doc
        hashes["modules/%s" % name] = sha256_bytes(raw)
    return modules, hashes


def main():
    site = load_json("site.json", {})
    keywords = load_json("keywords.json", {})
    sources = load_json("sources.json", {})
    names = load_json("names.json", [])
    ads = load_json("ads.json", {})
    modules, module_hashes = load_modules()
    comp = site.get("composition") or {}

    validate(site, keywords, sources, names, ads, modules, comp)

    ai = site.get("ai") or {}
    writing = ai.get("writing") or {}
    if not writing:
        die("site.json ai.writing 不能为空")
    comp["modules"] = comp.get("modules") or []
    comp["order"] = comp.get("order") or comp["modules"]
    comp.setdefault("render", "both")

    digest_files = [
        "site.json", "keywords.json", "sources.json", "names.json", "ads.json",
        "tree.json", "persona.md", "editorial.md",
    ]
    digest_files += ["modules/" + n for n in sorted(os.listdir(os.path.join(CONFIG, "modules")))
                     if n.endswith(".json")]
    config_sha = config_digest([p for p in digest_files if os.path.exists(os.path.join(CONFIG, p))])

    merged = merge_modules(comp, modules)
    # 不写时间戳：generated.json 必须可重复生成，否则 config/** 触发 rebuild 会自我循环。
    runtime = {
        "site_id": site.get("id") or os.environ.get("SITE_ID", "kaka"),
        "config_sha256": config_sha,
        "composition": comp,
        "module_sha256": module_hashes,
        "renderer": "compositor.py",
        "content": merged,
        "request_policy": ai.get("request_policy") or {},
        "writing": writing,
        "keyword_anchor": bool(ai.get("keyword_anchor",
                                      merged.get("keyword_policy", {}).get("anchor", True))),
        "ads_per_page": (site.get("shared") or {}).get("ads_per_page", 0),
        "template": site.get("template", "default"),
    }

    write_json("writing.json", writing)
    lines = ["# 由 config/keywords.json 生成，请勿手动编辑",
             "# frozen_at: %s" % keywords.get("frozen_at", "")]
    lines += [k if isinstance(k, str) else k.get("keyword", "")
              for k in (keywords.get("cores") or []) + (keywords.get("picked") or [])]
    write_text("keywords.txt", "\n".join(x for x in lines if x))
    write_json("generated.json", runtime)
    log("站点配置构建完成：%d 个模块，config_sha256=%s" % (len(comp["modules"]), config_sha[:12]))


if __name__ == "__main__":
    main()
