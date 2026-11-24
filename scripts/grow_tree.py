#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
内容树自动生长：采集候选词 → 规则分类 → 追加 proposed 节点。

候选来源（按优先级）：
  1. config/candidates.json —— 油猴在本地浏览器采集并写入的联想词 / 评论话题；
  2. 内置 suggest 接口 —— 百度 / Google，作为无本地候选时的服务端回退。

设计约束：
- 纯标准库，不调写作模型（不增加 AI 请求）。本地候选完全离线，回退才走 HTTP。
- 只追加 source=suggest 的节点，不改动任何人工节点；节点 id 由词指纹生成，重复运行幂等。
- 节点关键词必须来自当轮真实素材，保证能被现有 gate 判定通过，不产生永远闲置的死节点。
- 所有候选源都失败时静默退出（返回 0），不阻断每日发文。

candidates.json 格式（由油猴写入，字段均可缺省）：
  {"items": [
    {"text": "流量卡怎么办理", "seed": "流量卡", "kind": "suggest|comment",
     "source": "baidu", "url": "https://...", "weight": 1.0}
  ]}

用法：
  python scripts/grow_tree.py
"""

import collections
import datetime
import hashlib
import json
import os
import re
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mine                  # noqa: E402  norm() 去重
import sources as src        # noqa: E402  复用信源采集
import tree as treeutil      # noqa: E402  复用 tree.json 读写

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(ROOT, "config")
BJT = datetime.timezone(datetime.timedelta(hours=8))

MAX_NEW = 8
MAX_TOTAL_SUGGEST = 24
PER_SEED = 6
MAX_SEEDS = 6
TIMEOUT = 8

STOP_CHARS = set("的了在是和与及或我你他她它们这那有无不没很就都还也把被从对为以之其于而")
STOP_GRAMS = ("怎么", "什么", "如何", "可以", "是否", "有没有", "哪些", "哪个", "一下", "不了")
# 语义去重：去掉疑问/语气/虚词后留下的实词字符，用于识别同义标题变体
SEMANTIC_STOP = set("怎么什么如何哪里哪儿多少才是的了啊吗呢呀着过把被在从对为以之其于而并及或与哦嗯吗")
SIMILARITY = 0.68

INTENT_RULES = (
    ("how", ("怎么", "如何", "流程", "办理", "方法", "步骤", "申请", "开通",
             "补卡", "在哪里", "去哪里")),
    ("problem", ("限速", "失败", "不能", "为什么", "坑", "问题", "不支持",
                 "销户", "注销", "停用", "封号", "解除")),
    ("price", ("多少钱", "资费", "划算", "便宜", "价格", "费用", "月租", "优惠", "元")),
    ("compare", ("对比", "排行", "哪个好", "推荐", "测评", "比较", "区别", "评测")),
)


def log(*a):
    print("[grow_tree]", *a, flush=True)


def load_json(name, default):
    path = os.path.join(CONFIG, name)
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        log("读取 config/%s 失败：%r" % (name, e))
        return default


def seed_rows(keywords_cfg):
    """冻结种子词：picked + cores，去重保序。"""
    out, seen = [], set()
    for row in (keywords_cfg.get("picked") or []) + (keywords_cfg.get("cores") or []):
        w = row.get("keyword") if isinstance(row, dict) else row
        w = str(w or "").strip()
        if w and w not in seen:
            seen.add(w)
            out.append(w)
    return out[:MAX_SEEDS]


def seed_chars(seeds):
    chars = set("".join(seeds))
    return chars - STOP_CHARS


def fetch_suggest(word, timeout=TIMEOUT):
    """依次试百度 / Google suggest，返回联想词列表。两者都失败返回空。"""
    q = urllib.parse.quote(word)
    endpoints = (
        ("baidu", "https://suggestion.baidu.com/su?wd=%s&cb=cb" % q),
        ("google", "https://suggestqueries.google.com/complete/search?client=firefox&hl=zh-CN&q=%s" % q),
    )
    for name, url in endpoints:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                text = raw.decode("gbk", errors="ignore")
            if name == "baidu":
                # 百度返回 {q:"...",p:false,s:[...]}：key 无引号，不是合法 JSON。
                # 只取 s:[...] 数组部分（数组内字符串是标准双引号）再解析。
                m = re.search(r"\bs\s*:\s*(\[.*?\])\s*[,}]", text, re.S)
                if not m:
                    continue
                obj = json.loads(m.group(1))
                return [str(x).strip() for x in obj if str(x).strip()]
            obj = json.loads(text)
            if isinstance(obj, list) and len(obj) > 1 and isinstance(obj[1], list):
                return [str(x).strip() for x in obj[1] if str(x).strip()]
        except Exception as e:
            log("%s suggest 失败（%s）：%s" % (name, word, type(e).__name__))
            continue
    return []


def collect_suggestions(seeds, per_seed=PER_SEED):
    """遍历种子词采集联想词（服务端回退路径），保序去重。"""
    out, seen = [], set()
    for seed in seeds:
        got = fetch_suggest(seed)
        log("种子「%s」采集到 %d 条" % (seed, len(got)))
        for w in got:
            k = mine.norm(w)
            if not k or k in seen:
                continue
            seen.add(k)
            out.append({"text": w, "seed": seed, "kind": "suggest", "source": "suggest-api"})
            if sum(1 for x in out if x["seed"] == seed) >= per_seed:
                break
    return out


def load_local_candidates(seeds):
    """读取油猴写入的 config/candidates.json，归一成本模块候选结构。

    返回 [] 表示没有可用本地候选（文件不存在 / 格式不对 / 全部非法），
    调用方据此回退到 suggest 采集。字段容错：text 必须有，其余缺省补值。
    """
    data = load_json("candidates.json", None)
    if not isinstance(data, dict):
        return []
    rows = data.get("items")
    if not isinstance(rows, list):
        return []
    out, seen = [], set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        text = str(row.get("text") or "").strip()
        k = mine.norm(text)
        if not k or k in seen:
            continue
        seen.add(k)
        seed = str(row.get("seed") or "").strip()
        # seed 必须是已知冻结词，否则 gate 相关性校验会用它做过滤，给未知词等于放任跑题
        if seed and seed not in seeds:
            seed = ""
        try:
            weight = max(0.0, min(2.0, float(row.get("weight", 1.0))))
        except (TypeError, ValueError):
            weight = 1.0
        kind = str(row.get("kind") or "suggest")
        if kind not in ("suggest", "comment"):
            kind = "suggest"
        out.append({
            "text": text,
            "seed": seed,
            "kind": kind,
            "source": str(row.get("source") or "local"),
            "url": str(row.get("url") or ""),
            "weight": weight,
        })
    return out


def relevance(text, seed):
    """联想词与种子的中文字符重叠率，过滤掉同字不同义的跑题长尾。"""
    a = set(re.findall(r"[\u4e00-\u9fff]", text))
    b = set(re.findall(r"[\u4e00-\u9fff]", seed))
    if not a or not b:
        return 0.0
    return len(a & b) / float(len(a))


def lcs_len(text, seed):
    """中文字符序列的最长公共连续子串长度，比字符重叠率更能识别跑题。"""
    a = re.findall(r"[\u4e00-\u9fff]", text)
    b = re.findall(r"[\u4e00-\u9fff]", seed)
    prev = [0] * (len(b) + 1)
    best = 0
    for ca in a:
        cur = [0] * (len(b) + 1)
        for j, cb in enumerate(b, 1):
            if ca == cb:
                cur[j] = prev[j - 1] + 1
                if cur[j] > best:
                    best = cur[j]
        prev = cur
    return best


def semantic_key(text):
    """标题实词字符集合：剥离疑问/语气/虚词，供同义变体去重。"""
    chars = set(re.findall(r"[\u4e00-\u9fff]", text)) - SEMANTIC_STOP
    return chars


def similar(a_title, b_title):
    """两个标题的实词 Jaccard 相似度，判同义变体（如「怎么选最划算」/「怎么买最划算」）。"""
    a, b = semantic_key(a_title), semantic_key(b_title)
    if not a or not b:
        return False
    return len(a & b) / float(len(a | b)) >= SIMILARITY


def classify_intent(text):
    for intent, words in INTENT_RULES:
        if any(w in text for w in words):
            return intent
    return "general"


def material_terms(cands, chars, top=40):
    """从当轮素材里提取可命中的高频词（含核心单字），作为节点检索词候选池。"""
    counter = collections.Counter()
    for it in (cands or []):
        text = (it.get("title") or "") + " " + (it.get("summary") or "")
        for seg in re.findall(r"[\u4e00-\u9fff]+", text):
            for ch in seg:
                if ch in chars:
                    counter[ch] += 1
            for n in (2, 3, 4):
                for i in range(len(seg) - n + 1):
                    gram = seg[i:i + n]
                    if any(ch in chars for ch in gram):
                        counter[gram] += 1
    return [g for g, _ in counter.most_common(top)]


def build_terms(text, pool, seeds):
    """节点关键词 = 联想词 ∩ 素材高频词；长词优先并剔除被包含的单字噪声。"""
    matched = [g for g in pool if g in text]
    matched.sort(key=lambda g: (-len(g), pool.index(g)))
    terms = []
    for g in matched:
        # 「流」被「流量」包含时不再单列，避免关键词退化成单字噪声
        if any(g != kept and g in kept for kept in terms):
            continue
        terms.append(g)
    for s in seeds:
        if s in text and s not in terms:
            terms.append(s)
    # 兜底：只有一个词时过不了 gate.min_keywords，从种子里补一个出现在联想词中的片段
    if len(terms) < 2:
        for s in seeds:
            for n in (4, 3, 2):
                for i in range(len(s) - n + 1):
                    g = s[i:i + n]
                    if (g in text and g not in terms
                            and not any(ch in STOP_CHARS for ch in g)
                            and not any(sg in g for sg in STOP_GRAMS)):
                        terms.append(g)
                        break
                if len(terms) >= 2:
                    break
            if len(terms) >= 2:
                break
    return terms[:6]


def main():
    kw_cfg = load_json("keywords.json", {})
    sources_cfg = load_json("sources.json", {})
    seeds = seed_rows(kw_cfg)
    if not seeds:
        log("keywords.json 没有种子词，跳过")
        return
    chars = seed_chars(seeds)

    cands = src.collect(sources_cfg.get("sources", []),
                        window_hours=sources_cfg.get("window_hours", 48))
    pool = material_terms(cands, chars)
    log("素材 %d 条，可命中词候选 %d 个" % (len(cands), len(pool)))

    suggestions = load_local_candidates(seeds)
    if suggestions:
        n_sug = sum(1 for x in suggestions if x["kind"] == "suggest")
        n_com = sum(1 for x in suggestions if x["kind"] == "comment")
        log("用本地油猴候选 %d 条（联想词 %d / 评论话题 %d）" % (len(suggestions), n_sug, n_com))
    else:
        log("本地无候选，回退服务端 suggest 采集")
        suggestions = collect_suggestions(seeds)
    if not suggestions:
        log("本地候选与联想词接口都不可用，本轮跳过（不影响发文）")
        return

    td = treeutil.load_tree(CONFIG)
    if not td:
        log("tree.json 结构不合法，本轮跳过")
        return

    existing = {mine.norm(n.get("title", "")) for n in td["nodes"] if isinstance(n, dict)}
    existing_titles = [n.get("title", "") for n in td["nodes"] if isinstance(n, dict)]
    auto_count = sum(1 for n in td["nodes"]
                     if isinstance(n, dict) and n.get("source") == "suggest")
    if auto_count >= MAX_TOTAL_SUGGEST:
        log("自动节点已达上限 %d，本轮跳过" % MAX_TOTAL_SUGGEST)
        return

    # 领域字 = 种子字 ∩ 素材高频字；「限速拍照」这类跨义词不含领域字，直接挡掉
    domain_chars = chars & set("".join(pool))
    today = datetime.datetime.now(BJT).strftime("%Y-%m-%d")
    added = []
    for item in suggestions:
        if len(added) >= MAX_NEW or auto_count + len(added) >= MAX_TOTAL_SUGGEST:
            break
        text = str(item["text"]).strip()
        if not (4 <= len(text) <= 24):
            continue
        # 联想词有 seed：用字符重叠 + LCS 过滤跑题长尾；
        # 评论话题无 seed：靠领域字 + 后续 gate 素材命中兜底，不在此处误杀。
        seed = item.get("seed") or ""
        if seed and (relevance(text, seed) < 0.6 or lcs_len(text, seed) < 3):
            continue
        if not any(ch in text for ch in domain_chars):
            continue
        k = mine.norm(text)
        if not k or k in existing:
            continue
        # 同义变体去重：「怎么选最划算」/「怎么买最划算」/「怎么办才最划算」视为同一主题
        if any(similar(text, old) for old in existing_titles):
            continue
        terms = build_terms(text, pool, seeds)
        if not terms:
            continue
        nid = "sug-" + hashlib.sha1(k.encode("utf-8")).hexdigest()[:8]
        if any(n.get("id") == nid for n in td["nodes"]):
            continue
        node = {
            "id": nid,
            "title": text,
            "intent": classify_intent(text),
            "status": "proposed",
            "parent": None,
            "keywords": terms,
            "source": "suggest",
            "origin_seed": seed,
            "harvest_kind": item.get("kind", "suggest"),
            "harvest_source": item.get("source", ""),
            "harvest_url": item.get("url", ""),
            "collected_at": today,
            "idle_rounds": 0,
            "written_count": 0,
            "last_written_at": "",
            "last_slug": "",
            "last_title": "",
        }
        td["nodes"].append(node)
        existing.add(k)
        existing_titles.append(text)
        added.append(node)

    if not added:
        log("没有合格的新节点（去重/素材命中/限量后）")
        return

    treeutil.save_tree(td, CONFIG)
    log("新增 %d 个 proposed 节点：" % len(added))
    for n in added:
        log("  · [%s] %s | 关键词=%s" % (n["intent"], n["title"], "/".join(n["keywords"])))


if __name__ == "__main__":
    main()
