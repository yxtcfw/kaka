#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
每日自动连载 pipeline（论坛式，一页多楼层）

  1. 挖题：从已有 md 里捞「疑问 / 痛点」句子，随机挑一条
  2. 取材：按关键词从 config/sources.json 的信源抓最近内容
  3. 写作：模型带着素材，写「主楼长文 + 若干楼层」，输出楼层结构的 markdown
  4. 落盘：写成 docs/posts/00N.md，追加到 .topics.json
  5. 建站：交给 blogsite.build 重新生成整站

用法：
  python scripts/generate.py               # 挖题 → 取材 → 写作 → 建站
  python scripts/generate.py --probe       # 只测采集源
  python scripts/generate.py --rebuild     # 只重建整站
  python scripts/generate.py -k 某个主题    # 指定主题，跳过挖题
  python scripts/generate.py --force       # 今天写过也再写一页
"""

import argparse
import datetime
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sources as src        # noqa: E402
import mine                  # noqa: E402
import blogsite as sitebuilder  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")
POSTS = os.path.join(DOCS, "posts")
CONFIG = os.path.join(ROOT, "config")
HISTORY = os.path.join(DOCS, ".topics.json")

BJT = datetime.timezone(datetime.timedelta(hours=8))
API_URL = "https://openrouter.ai/api/v1/chat/completions"


def log(*a):
    print("[daily]", *a, flush=True)


# ---------------------------------------------------------------- 配置

def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def load_text(path, default=""):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip() or default
    except Exception:
        return default


def load_site():
    site = load_json(os.path.join(CONFIG, "site.json"), {})
    site.setdefault("name", "每日一篇")
    site.setdefault("tagline", "")
    site.setdefault("description", "")
    site.setdefault("author", "")
    site.setdefault("footer", "由 GitHub Actions 每天自动生成")
    site.setdefault("lang", "zh-CN")
    site.setdefault("base_url", "")
    for k, env in (("name", "SITE_NAME"), ("tagline", "SITE_TAGLINE"), ("author", "SITE_AUTHOR"),
                   ("description", "SITE_DESCRIPTION"), ("footer", "SITE_FOOTER")):
        if os.environ.get(env):
            site[k] = os.environ[env]

    site["base_url"] = (os.environ.get("SITE_BASE_URL") or site["base_url"]).strip().rstrip("/")
    if not site["base_url"]:
        repo = os.environ.get("GITHUB_REPOSITORY", "")
        if "/" in repo:
            owner, name = repo.split("/", 1)
            site["base_url"] = ("https://%s.github.io" % owner) if name == owner + ".github.io" \
                else ("https://%s.github.io/%s" % (owner, name))
    return site


def load_keywords():
    items = []
    with open(os.path.join(CONFIG, "keywords.txt"), "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "|" in line:
                kw, note = line.split("|", 1)
                items.append({"keyword": kw.strip(), "note": note.strip()})
            else:
                items.append({"keyword": line, "note": ""})
    return items


def load_history():
    h = load_json(HISTORY, {"items": []})
    if not isinstance(h, dict) or not isinstance(h.get("items"), list):
        h = {"items": []}
    return h


# ---------------------------------------------------------------- 排序

def human_age(ts, now):
    if not ts:
        return "时间不明"
    h = (now - ts).total_seconds() / 3600.0
    if h < 1:
        return "%d分钟前" % max(1, int(h * 60))
    if h < 24:
        return "%d小时前" % int(h)
    return "%d天前" % int(h / 24)


def rank_candidates(items, keywords, now):
    for it in items:
        hay = (it["title"] + " " + (it.get("summary") or "")).lower()
        hits = [k["keyword"] for k in keywords if k["keyword"].lower() in hay]
        s = len(hits) * 3.0 + float(it.get("weight", 1.0))
        age_h = (now - it["ts"]).total_seconds() / 3600.0 if it.get("ts") else 99
        s += 3.0 if age_h <= 6 else 2.0 if age_h <= 24 else 1.0 if age_h <= 48 else 0.0
        if len(it["title"]) < 10:
            s -= 1.5
        if len(it["title"]) > 50:
            s -= 0.5
        it["hits"] = hits
        it["score"] = round(s, 2)
        it["age"] = human_age(it.get("ts"), now)
    items.sort(key=lambda x: x["score"], reverse=True)
    return items


# ---------------------------------------------------------------- 模型

DEFAULT_MODEL = "google/gemini-3.5-flash-lite"
MODELS_URL = "https://openrouter.ai/api/v1/models"
FREE_BOOST = ("gemma", "nemotron-3-ultra", "dots", "ling", "ernie", "inkling", "particle")

FALLBACK_FREE = [
    "google/gemma-4-31b-it:free",
    "google/gemma-4-26b-a4b-it:free",
    "inclusionai/ling-3.2-flash:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "baidu/ernie-5.5-flash-preview:free",
    "dots-studio/dots-3-note-preview:free",
    "openrouter/free",
]

_CATALOG = None

_PREFERRED = None
_SESSION_BAD = set()
_WALL_DEADLINE = None
REQUEST_TIMEOUT = 120
WRITE_TIMEOUT = 180
MAX_ATTEMPTS = 1

BADLIST = os.path.join(DOCS, ".model_badlist.json")
BAD_TTL = 7 * 86400


def load_badlist():
    data = load_json(BADLIST, {})
    if not isinstance(data, dict):
        return {}
    now = time.time()
    return {m: v for m, v in data.items()
            if isinstance(v, dict) and now - float(v.get("ts") or 0) < BAD_TTL}


def mark_bad(model, reason):
    if model == "openrouter/free":
        return
    data = load_json(BADLIST, {})
    if not isinstance(data, dict):
        data = {}
    data[model] = {"reason": str(reason)[:300], "ts": time.time()}
    try:
        os.makedirs(DOCS, exist_ok=True)
        with open(BADLIST, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
    except Exception:
        pass


def free_only_enabled():
    return os.environ.get("FREE_ONLY", "1").strip().lower() not in ("0", "false", "no", "off")


def model_catalog():
    global _CATALOG
    if _CATALOG is not None:
        return _CATALOG
    cat = {}
    try:
        with urllib.request.urlopen(MODELS_URL, timeout=30) as r:
            data = json.loads(r.read().decode("utf-8"))
        for m in data.get("data", []):
            pr = m.get("pricing") or {}
            cat[m.get("id", "")] = {
                "free": str(pr.get("prompt")) == "0" and str(pr.get("completion")) == "0",
                "ctx": m.get("context_length") or 0,
                "name": (m.get("name") or "").strip(),
            }
    except Exception as e:
        log("拉模型表失败（改用内置免费列表）：%r" % e)
        cat = {}
    _CATALOG = cat
    return cat


def is_free(model_id, cat):
    if cat.get(model_id):
        return bool(cat[model_id]["free"])
    return model_id.endswith(":free") or model_id == "openrouter/free"


def model_display_name(mid):
    info = model_catalog().get(mid) or {}
    name = re.sub(r"\s+", " ", info.get("name") or "").strip()
    if ":" in name:
        name = name.split(":", 1)[1].strip()
    return name or mid


def fetch_free_models():
    cat = model_catalog()
    rows = []
    for mid, meta in cat.items():
        if not meta["free"] or not mid:
            continue
        if "image" in mid or "lyria" in mid:
            continue
        rows.append((sum(1 for k in FREE_BOOST if k in mid), meta["ctx"], mid))
    rows.sort(reverse=True)
    ids = [x[2] for x in rows if x[2] != "openrouter/free"]
    if any(x[2] == "openrouter/free" for x in rows):
        ids.append("openrouter/free")
    return ids


def resolve_models(spec, free_only=None):
    if free_only is None:
        free_only = free_only_enabled()
    spec = (spec or "").strip()
    if not spec:
        spec = "free" if free_only else DEFAULT_MODEL

    models = []
    for part in [p.strip() for p in spec.split(",") if p.strip()]:
        if part.lower() in ("free", "all-free", "freeall", "*"):
            free = fetch_free_models()
            models.extend(free if free else list(FALLBACK_FREE))
        else:
            models.append(part)

    seen, uniq = set(), []
    for m in models:
        if m not in seen:
            seen.add(m)
            uniq.append(m)

    if free_only:
        cat = model_catalog()
        uniq = [m for m in uniq if is_free(m, cat)]
        if not uniq:
            uniq = list(FALLBACK_FREE)

    bad = load_badlist()
    if bad:
        keep = [m for m in uniq if m == "openrouter/free" or m not in bad]
        if keep:
            if len(keep) < len(uniq):
                log("跳过 %d 个最近不可用的模型" % (len(uniq) - len(keep)))
            uniq = keep
        else:
            log("候选全在黑名单里，本次忽略黑名单重试")
            try:
                os.remove(BADLIST)
            except Exception:
                pass

    try:
        with open(os.path.join(DOCS, ".model_used"), "r", encoding="utf-8") as f:
            last = f.read().strip()
        if last in uniq:
            uniq.remove(last)
            uniq.insert(0, last)
    except Exception:
        pass

    return uniq or list(FALLBACK_FREE)


def extract_text(resp):
    try:
        msg = resp["choices"][0]["message"]
    except Exception:
        raise RuntimeError("返回结构异常: " + json.dumps(resp, ensure_ascii=False)[:500])
    content = msg.get("content")
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return content or ""


def call_openrouter(messages, models, temperature=0.8, retries=None, timeout=None):
    global _PREFERRED
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        sys.exit("缺少环境变量 OPENROUTER_API_KEY")
    if isinstance(models, str):
        models = [models]
    if retries is None:
        retries = MAX_ATTEMPTS

    models = list(models)
    if _PREFERRED and _PREFERRED in models:
        models.remove(_PREFERRED)
        models.insert(0, _PREFERRED)
    if _SESSION_BAD:
        kept = [m for m in models if m not in _SESSION_BAD]
        if kept:
            models = kept

    headers = {
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
        "HTTP-Referer": os.environ.get("SITE_BASE_URL") or "https://github.com",
        "X-Title": "daily-blog",
    }

    last_err = ""
    for idx, model in enumerate(models):
        payload = {"model": model, "messages": messages, "temperature": temperature,
                   "response_format": {"type": "json_object"}}
        for attempt in range(retries):
            if _WALL_DEADLINE and time.time() > _WALL_DEADLINE:
                sys.exit("模型调用超出总时长预算，放弃本次生成（已试 %d 个模型）" % (idx + 1))
            req = urllib.request.Request(API_URL, data=json.dumps(payload).encode("utf-8"),
                                         headers=headers, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=(timeout or REQUEST_TIMEOUT)) as r:
                    resp = json.loads(r.read().decode("utf-8"))
                resp["_used_model"] = model
                _PREFERRED = model
                if idx > 0:
                    log("换到第 %d 个模型成功：%s" % (idx + 1, model))
                return resp
            except urllib.error.HTTPError as e:
                body = e.read().decode("utf-8", errors="replace")
                msg = ""
                try:
                    msg = ((json.loads(body) or {}).get("error") or {}).get("message") or ""
                except Exception:
                    msg = body[:200].replace("\n", " ")
                last_err = "HTTP %s: %s" % (e.code, msg or body[:200])

                if e.code == 400 and "response_format" in payload:
                    payload.pop("response_format", None)
                    continue

                if e.code == 401 or (e.code == 403 and re.search(
                        r"(api key|no auth|unauthor|invalid.{0,20}key|key.{0,20}(disabl|invalid))",
                        msg, re.I)):
                    sys.exit("Key 无效或没权限（HTTP %s）：%s" % (e.code, msg or body[:200]))

                if e.code in (403, 404):
                    mark_bad(model, "HTTP %s %s" % (e.code, msg))
                _SESSION_BAD.add(model)

                log("  %s → HTTP %s %s" % (model, e.code, (msg or "")[:120]))
                break
            except Exception as e:
                last_err = repr(e)
                log("  %s → %r" % (model, e))
                _SESSION_BAD.add(model)
                break
        else:
            log("  %s 重试后仍失败，换下一个" % model)

    sys.exit("模型链全部失败（共 %d 个，最后错误：%s）" % (len(models), last_err))


def parse_json_reply(text):
    t = (text or "").strip()
    t = re.sub(r"^```(?:json)?\s*", "", t)
    t = re.sub(r"\s*```$", "", t)
    try:
        return json.loads(t)
    except Exception:
        pass
    start, end = t.find("{"), t.rfind("}")
    if start >= 0 and end > start:
        return json.loads(t[start:end + 1])
    raise ValueError("模型没吐出合法 JSON：\n" + text[:400])


def ask_json(messages, models, temperature=0.7, timeout=None):
    resp = call_openrouter(messages, models, temperature, timeout=timeout)
    return parse_json_reply(extract_text(resp)), resp


def set_budget(seconds):
    global _WALL_DEADLINE
    _WALL_DEADLINE = time.time() + max(60, int(seconds))


# ---------------------------------------------------------------- 取材

def render_material(cands, limit=8):
    lines = []
    for i, it in enumerate(cands[:limit]):
        lines.append("[%d] %s · %s\n    标题：%s\n    摘要：%s" % (
            i, it["source"], it["age"], it["title"], (it.get("summary") or "（无摘要）")[:260]))
    return "\n".join(lines) or "（这次没抓到外部素材）"


def search_web(query, cfg, keywords):
    """
    搜索接口（预留）。provider=none 时返回空，调用方退回信源素材。
    以后部署了 SearXNG 就把 config/sources.json 里 search.provider 改成 searxng。
    """
    provider = (cfg.get("provider") or "none").lower()
    if provider == "none":
        return []
    if provider == "searxng":
        base = (cfg.get("searxng_url") or "").rstrip("/")
        if not base:
            log("search.provider=searxng 但没填 searxng_url，跳过")
            return []
        url = "%s/search?q=%s&format=json" % (base, urllib.request.quote(query))
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                data = json.loads(r.read().decode("utf-8"))
            out = []
            for item in (data.get("results") or [])[: int(cfg.get("max_results", 8))]:
                out.append({
                    "title": item.get("title", ""),
                    "url": item.get("url", ""),
                    "summary": (item.get("content") or "")[:400],
                    "source": item.get("engine") or "searxng",
                    "age": "搜索结果",
                })
            log("搜索到 %d 条" % len(out))
            return out
        except Exception as e:
            log("搜索失败：%r" % e)
            return []
    log("未知的 search.provider：%s" % provider)
    return []


# ---------------------------------------------------------------- 写作

def next_page_no(posts_dir):
    nums = []
    if os.path.isdir(posts_dir):
        for f in os.listdir(posts_dir):
            m = re.match(r"^(\d+)\.md$", f)
            if m:
                nums.append(int(m.group(1)))
    return (max(nums) + 1) if nums else 1


def step_write_page(site, persona, editorial, seed, material_block, history, models):
    recent = history["items"][-10:]
    recent_block = "\n".join("- 第 %s 页：%s" % (it.get("slug", ""), it.get("title", ""))
                             for it in recent) or "（这是第一页）"

    if seed.get("kind") == "question":
        seed_block = ('读者在旧帖里问过一句：\n「%s」\n（来自第 %s 页《%s》）\n'
                      '这一页就回答它。不要只给结论，要给过程、给取舍。'
                      % (seed["text"], seed.get("from", "?"), seed.get("from_title", "")))
    else:
        seed_block = "本轮主题：%s" % seed.get("text", "")

    avoid = ("\n\n【不要写这些】" + editorial[:400]) if editorial else ""

    system = (persona + avoid +
              "\n\n你在维护一个论坛式连载帖，每天更新一页。"
              "\n这一页由「1 楼主贴 + 若干楼层」组成，只输出 JSON。")

    user = """今天是 {today}。这是帖子的下一轮更新。

{seed}

【可用的信源素材】（只能引用这里的事实，不要编造）
{material}

【最近写过的页】（不要重复同样的话题）
{recent}

【写作要求】
1. 主楼（1 楼）{wc} 字左右中文，回答上面那个问题或展开主题。要有判断、有具体做法，不要通稿。
2. 后面接 3-5 个楼层，每层 60~200 字，模拟真实网友讨论：
   - 有人补充自己的经验
   - 有人提出反对或质疑
   - 有人追问细节
   - 楼主可以出来回一两条
   不要全是附和，要有分歧，读起来像真在讨论。
3. 楼层作者用化名，如「网友·阿强」「网友·小北」「路人」，楼主写「楼主」。
4. 事实只用素材里的，素材没提到的具体数字、价格、人名不要写。观点可以自己给。
5. 第一个 `#` 是页面标题（20 字内），主楼正文紧跟其后。

【输出格式（严格按这个结构，楼层必须是 "## N楼 · 作者 · 时间"）】
# 页面标题

主楼正文……

## 2楼 · 网友·阿强 · 10:12
楼层内容……

## 3楼 · 网友·小北 · 10:20
楼层内容……

## 4楼 · 楼主 · 10:35
楼主回复……

【输出 JSON】
{{"title": "页面标题", "question": "这一页要回答的问题（一句话）", "content_md": "完整的 markdown，从 # 标题开始"}}""".format(
        today=datetime.datetime.now(BJT).strftime("%Y-%m-%d"),
        seed=seed_block,
        material=material_block,
        recent=recent_block,
        wc=os.environ.get("WORD_COUNT", "1000"),
    )

    return ask_json([
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ], models, temperature=0.85, timeout=WRITE_TIMEOUT)


# ---------------------------------------------------------------- 自检

def probe(sources_cfg):
    print("== 采集自检 ==")
    total = 0
    for cfg in sources_cfg.get("sources", []):
        if cfg.get("enabled", True) is False:
            print("-- %-12s 已禁用" % cfg.get("name"))
            continue
        got = src.collect_one(cfg)
        total += len(got)
        print("-- %-12s %3d 条" % (cfg.get("name"), len(got)))
        for it in got[:2]:
            print("     ·", (it.get("ts") and it["ts"].strftime("%m-%d %H:%M")) or "--", "|", it["title"][:44])
    print("合计 %d 条" % total)


# ---------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", action="store_true", help="只测采集")
    ap.add_argument("--rebuild", action="store_true", help="只按现有 md 重建整站")
    ap.add_argument("-k", "--keyword", default="", help="指定主题，跳过挖题")
    ap.add_argument("--force", action="store_true", help="今天写过也再写一页")
    args = ap.parse_args()

    site = load_site()

    if args.rebuild:
        stat = sitebuilder.build(site, DOCS, site["base_url"])
        log("重建完成：%d 页 / %d 层 / %d 字" % (stat["pages"], stat["floors"], stat["words"]))
        return

    sources_cfg = load_json(os.path.join(CONFIG, "sources.json"), {"sources": []})
    if args.probe:
        probe(sources_cfg)
        return

    persona = load_text(os.path.join(CONFIG, "persona.md"), "你是一位中文写作好手。")
    editorial = load_text(os.path.join(CONFIG, "editorial.md"), "")
    keywords = load_keywords()
    history = load_history()
    models = resolve_models(os.environ.get("OPENROUTER_MODEL", ""))
    forced = args.keyword.strip() or os.environ.get("FORCE_KEYWORD", "").strip()

    log("模型链（%s，共 %d 个）：%s%s" % (
        "只允许免费" if free_only_enabled() else "允许付费", len(models),
        " → ".join(models[:5]), " …" if len(models) > 5 else ""))

    now = datetime.datetime.now(BJT)
    date_str = now.strftime("%Y-%m-%d")
    if any(it.get("date") == date_str for it in history["items"]) and not forced and not args.force:
        log("今天已经更新过（%s），只重建站点。想再写一页用 --force。" % date_str)
        sitebuilder.build(site, DOCS, site["base_url"])
        return

    # ---- 1. 挖题
    seed = None
    if forced:
        seed = {"kind": "topic", "text": forced, "from": "手动指定"}
        log("手动指定主题：" + forced)
    else:
        questions = mine.scan_questions(POSTS)
        recent_slugs = [it.get("slug") for it in history["items"][-6:]]
        q = mine.pick_question(questions, recent_slugs)
        if q:
            seed = {"kind": "question", "text": q["text"], "from": q["slug"],
                    "from_title": q["page_title"]}
            log("从旧帖挖到 %d 条疑问，选中：%s" % (len(questions), q["text"][:60]))
        else:
            log("旧帖里没挖到疑问（%d 条），走热点选题" % len(questions))

    # ---- 2. 取材
    items = src.collect(sources_cfg.get("sources", []),
                        window_hours=sources_cfg.get("window_hours", 48))
    cands = rank_candidates(items, keywords, now)[:24]

    search_cfg = sources_cfg.get("search") or {}
    if seed:
        extra = search_web(seed["text"], search_cfg, keywords)
        if extra:
            cands = extra + cands

    material_block = render_material(cands, 8)

    set_budget(int(os.environ.get("MODEL_BUDGET_SECONDS", "600")))
    log("模型总时长预算：%d 秒" % int(os.environ.get("MODEL_BUDGET_SECONDS", "600")))

    if not seed:
        if not cands:
            sys.exit("没挖到疑问，也没抓到任何素材，本轮跳过")
        seed = {"kind": "topic", "text": cands[0]["title"], "from": cands[0]["source"]}
        log("用热点当主题：" + seed["text"])

    # ---- 3. 写作
    data, resp = step_write_page(site, persona, editorial, seed, material_block, history, models)

    content_md = (data.get("content_md") or data.get("content") or "").strip()
    if len(content_md) < 300:
        sys.exit("产出太短（%d 字），判定失败" % len(content_md))

    # 标题：优先 content_md 里的 # 行
    m = re.match(r"^\s*#\s+(.+)$", content_md, re.M)
    title = (m.group(1).strip() if m else (data.get("title") or "").strip()) or seed.get("text", "")[:20]
    if not content_md.lstrip().startswith("#"):
        content_md = "# " + title + "\n\n" + content_md

    question = (data.get("question") or (seed["text"] if seed["kind"] == "question" else "")).strip()

    # ---- 4. 落盘
    os.makedirs(POSTS, exist_ok=True)
    no = next_page_no(POSTS)
    slug = "%03d" % no
    used_model = resp.get("_used_model") or models[0]

    front = [
        "---",
        "title: %s" % title,
        "date: %s" % date_str,
        "page: %d" % no,
        "question: %s" % (question or ""),
        "model: %s" % used_model,
        "model_name: %s" % model_display_name(used_model),
        "---",
        "",
    ]
    with open(os.path.join(POSTS, slug + ".md"), "w", encoding="utf-8") as f:
        f.write("\n".join(front) + content_md + "\n")

    meta = {
        "date": date_str,
        "slug": slug,
        "page": no,
        "title": title,
        "question": question,
        "words": len(content_md),
        "model": used_model,
        "model_name": model_display_name(used_model),
        "seed_kind": seed.get("kind"),
    }
    history["items"].append(meta)
    with open(HISTORY, "w", encoding="utf-8") as f:
        json.dump(history, f, ensure_ascii=False, indent=2)

    try:
        with open(os.path.join(DOCS, ".model_used"), "w", encoding="utf-8") as f:
            f.write(used_model)
    except Exception:
        pass

    # ---- 5. 建站
    stat = sitebuilder.build(site, DOCS, site["base_url"])

    u = resp.get("usage") or {}
    log("完成：第 %d 页《%s》 %d 字 | 站内共 %d 页 | tokens %s" % (
        no, title, len(content_md), stat["pages"], u.get("total_tokens", "?")))


def _dump_error(msg):
    try:
        with open("/tmp/daily_error.txt", "w", encoding="utf-8") as f:
            f.write(str(msg)[:500])
    except Exception:
        pass


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        if e.code not in (0, None):
            _dump_error(e.code)
        raise
    except Exception as e:
        _dump_error(repr(e))
        raise
