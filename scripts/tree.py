#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
内容树：节点状态流转、gate 准入、prune 剪枝。

纯标准库，不联网、不调模型，只读写 config/tree.json。

选题优先级（由 generate.py 调用）：
    手动 keyword  >  内容树通过 gate 的节点  >  历史署名评论  >  信源热点回退

gate 三指标（全部基于节点检索词在素材池里的命中）：
    min_keywords  节点有效检索词数
    min_sources   命中素材覆盖的信源数（按启用信源数自适应封顶，避免单源站永远不通过）
    min_hits      检索词在素材标题/摘要里的命中总次数（词频，不是素材条数）

节点状态机：
    proposed/planned（可选题） --选中并写完--> done
    proposed/planned --连续 idle_rounds 轮未被选中--> archived（prune）
"""

import datetime
import json
import os
import random

BJT = datetime.timezone(datetime.timedelta(hours=8))

VALID_STATUS = ("proposed", "planned", "done", "archived")
SELECTABLE = ("proposed", "planned")

DEFAULT_GATE = {"enabled": True, "min_keywords": 2, "min_sources": 2, "min_hits": 15}
DEFAULT_PRUNE = {"enabled": True, "idle_rounds": 3, "to": "archived", "scope": "proposed"}

# 节点运行态字段：旧版本 tree.json 缺这些字段时由 load_tree 补齐
NODE_EXTRA = {
    "idle_rounds": 0,
    "written_count": 0,
    "last_written_at": "",
    "last_slug": "",
    "last_title": "",
}


def _num(value, default):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def load_tree(config_dir):
    """读取并规范化 tree.json；结构不合法时返回 None（调用方回退原选题链路）。"""
    path = os.path.join(config_dir, "tree.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return None
    if not isinstance(data, dict) or not isinstance(data.get("nodes"), list):
        return None

    data.setdefault("schema_version", "1.1.0")
    data.setdefault("round", 0)
    data.setdefault("last_updated_at", "")

    gate = dict(DEFAULT_GATE)
    gate.update(data.get("gate") or {})
    data["gate"] = gate
    prune = dict(DEFAULT_PRUNE)
    prune.update(data.get("prune") or {})
    data["prune"] = prune

    for node in data["nodes"]:
        if not isinstance(node, dict):
            continue
        node.setdefault("status", "proposed")
        node.setdefault("keywords", [])
        for key, value in NODE_EXTRA.items():
            node.setdefault(key, value)
    return data


def save_tree(data, config_dir):
    """原子写回 tree.json，避免并发读时读到半截 JSON。"""
    if not data:
        return False
    path = os.path.join(config_dir, "tree.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)
    return True


def enabled_source_count(sources_cfg):
    """启用信源数，用于 min_sources 自适应封顶。"""
    rows = (sources_cfg or {}).get("sources") or []
    return sum(1 for s in rows if isinstance(s, dict) and s.get("enabled", True))


def node_terms(node, keywords, term_fn=None):
    """节点检索词：优先节点专属 keywords，否则交给脚本抽词函数。"""
    explicit = [w.strip() for w in (node.get("keywords") or [])
                if isinstance(w, str) and w.strip()]
    if explicit:
        return explicit[:8]
    if term_fn:
        return term_fn(node.get("title", ""), keywords, anchors_only=True) or []
    return [k.get("keyword", "") for k in (keywords or [])
            if k.get("keyword") and k["keyword"] in (node.get("title") or "")]


def gate_check(node, cands, keywords, gate, term_fn=None, max_sources=None):
    """校验单个节点的素材是否够格，返回 (passed, stat)。"""
    terms = node_terms(node, keywords, term_fn)
    gate = gate or {}
    min_kw = _num(gate.get("min_keywords"), 2)
    min_src = _num(gate.get("min_sources"), 2)
    if max_sources is not None:
        # 单源站若要求 2 个信源会永远不通过：按实际启用信源数封顶
        min_src = min(min_src, max(1, int(max_sources)))
    min_hits = _num(gate.get("min_hits"), 15)

    related, hits = [], 0
    for it in (cands or []):
        hay = ((it.get("title") or "") + " " + (it.get("summary") or "")).lower()
        matched = [t for t in terms if t and t.lower() in hay]
        if matched:
            related.append(it)
            hits += len(matched)
    sources = {it.get("source") or "?" for it in related}
    stat = {
        "terms": terms,
        "keywords": len(terms),
        "sources": len(sources),
        "hits": hits,
        "related": len(related),
        "need": {"keywords": min_kw, "sources": min_src, "hits": min_hits},
    }
    passed = (len(terms) >= min_kw and len(sources) >= min_src and hits >= min_hits)
    return passed, stat


def pick_topic(data, cands, keywords, seed_key=None, term_fn=None, max_sources=None):
    """从通过 gate 的节点里挑一个：优先 idle 最久，再按 seed 幂等随机。

    返回 (node, stat, info)；没选中时 node/stat 为 None，info 带逐节点诊断。
    """
    if not data or not data.get("gate", {}).get("enabled", True):
        return None, None, {"enabled": False}

    pool, info = [], []
    for node in data.get("nodes") or []:
        if not isinstance(node, dict) or node.get("status") not in SELECTABLE:
            continue
        passed, stat = gate_check(node, cands, keywords, data.get("gate"),
                                  term_fn=term_fn, max_sources=max_sources)
        info.append({
            "id": node.get("id"), "title": node.get("title"),
            "status": node.get("status"), "passed": passed, "stat": stat,
        })
        if passed:
            pool.append((node, stat))
    if not pool:
        return None, None, {"enabled": True, "pool": 0, "checked": info}

    max_idle = max(int(n.get("idle_rounds") or 0) for n, _ in pool)
    top = [(n, s) for n, s in pool if int(n.get("idle_rounds") or 0) == max_idle]
    chosen = top[0] if len(top) == 1 else random.Random(str(seed_key)).choice(top)
    return chosen[0], chosen[1], {"enabled": True, "pool": len(pool), "checked": info}


def commit_topic(data, node, meta, date_str=None):
    """写后回填：选中节点置 done，其余可选节点 idle+1，按 prune 剪枝。

    返回被剪枝的节点 id 列表。meta 至少含 slug / title。
    """
    if not data:
        return []
    date_str = date_str or datetime.datetime.now(BJT).strftime("%Y-%m-%d")
    data["round"] = int(data.get("round") or 0) + 1
    data["last_updated_at"] = date_str

    chosen_id = node.get("id") if node else None
    pr = data.get("prune") or {}
    limit = _num(pr.get("idle_rounds"), 3)
    to_status = pr.get("to") or "archived"
    if to_status not in VALID_STATUS:
        to_status = "archived"
    # 默认只剪未确认的 proposed 节点；planned 是站点确认的路线图，不该被误杀。
    # 需要连 planned 一起淘汰时把 scope 设为 "all"。
    scope = pr.get("scope") or "proposed"

    archived = []
    for n in data.get("nodes") or []:
        if not isinstance(n, dict):
            continue
        if node is not None and n.get("id") == chosen_id:
            n["status"] = "done"
            n["idle_rounds"] = 0
            n["written_count"] = int(n.get("written_count") or 0) + 1
            n["last_written_at"] = date_str
            n["last_slug"] = meta.get("slug", "")
            n["last_title"] = meta.get("title", "")
            continue
        if n.get("status") in SELECTABLE:
            n["idle_rounds"] = int(n.get("idle_rounds") or 0) + 1
            eligible = (scope == "all" or n.get("status") == "proposed")
            if pr.get("enabled", True) and eligible and n["idle_rounds"] >= limit:
                n["status"] = to_status
                archived.append(n.get("id"))
    return archived
