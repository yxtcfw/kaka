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
import random
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


DEFAULT_WRITING = {
    "main_words": 300,
    "floor_count": [4, 6],
    "floor_words": [40, 100],
    "query_terms": "auto",        # auto=脚本优先，命中不够再问模型；script=只脚本；model=只模型
    "auto_next_question": True,   # 结尾没留问题时，是否补一次小请求
    "extra_rules": "",
}


def load_names():
    rows = load_json(os.path.join(CONFIG, "names.json"), [])
    return [r for r in rows if isinstance(r, dict) and r.get("nick")]


PROMPT_DIR = os.path.join(CONFIG, "prompts")

DEFAULT_WRITE_PROMPT = """今天是 {{today}}。这是连载帖子的新一页。

{{seed}}

【可用的信源素材】（只能引用这里的事实）
{{material}}

【最近写过的页】
{{recent}}

【篇幅】1 楼 {{mw}} 字以内，{{fc_min}}~{{fc_max}} 个楼层，每层 {{fw_min}}~{{fw_max}} 字。
{{extra}}

【出场的人】
{{names}}

【格式】楼层用 ## @昵称 · 时间；不要一级标题；标题放 JSON 的 title。
【输出 JSON】{"title":"...","question":"...","next_questions":["..."],"content_md":"..."}"""

DEFAULT_TERMS_PROMPT = """从这句问题里抽出 3~5 个搜索关键词，实体词优先。
问题：「{{question}}」
【输出 JSON】{"terms": ["词1", "词2"]}"""

DEFAULT_QUESTION_PROMPT = """根据下面这页内容，提出 1~2 个下一页值得讨论的新问题，每条 30 字以内。
【页面内容】
{{content}}
【输出 JSON】{"next_questions": ["问题1"]}"""


def load_prompt(name, fallback, **vars):
    """从 config/prompts/{name}.md 读模板，用 {{var}} 占位替换；文件缺失时用内置兜底"""
    path = os.path.join(PROMPT_DIR, name + ".md")
    tpl = load_text(path) or fallback
    for k, v in vars.items():
        tpl = tpl.replace("{{%s}}" % k, str(v))
    return tpl


def load_writing():
    w = dict(DEFAULT_WRITING)
    cfg = load_json(os.path.join(CONFIG, "writing.json"), {})
    if isinstance(cfg, dict):
        w.update({k: v for k, v in cfg.items() if v not in (None, "")})
    # 环境变量还能临时覆盖
    if os.environ.get("WORD_COUNT", "").strip().isdigit():
        w["main_words"] = int(os.environ["WORD_COUNT"].strip())
    try:
        w["main_words"] = max(200, int(w["main_words"]))
        w["floor_count"] = [int(x) for x in w["floor_count"]]
        w["floor_words"] = [int(x) for x in w["floor_words"]]
    except Exception:
        w = dict(DEFAULT_WRITING)
    return w


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
    codes = []
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

                codes.append(e.code)
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

    hint = ""
    if codes and all(c in (429, 402) for c in codes):
        hint = ("\n提示：整条链都是 429/402，通常是今天的免费额度用完了"
                "（OpenRouter 免费模型：未充值账户每天 50 次，充值过 $10 是 1000 次）。"
                "额度每天重置，明天会自动恢复；也可以减少手动测试次数。")
    sys.exit("模型链全部失败（共 %d 个，最后错误：%s）%s" % (len(models), last_err, hint))


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

STOP_GRAMS = {"怎么", "什么", "如何", "为什", "么办", "可以", "能不", "不能", "值不", "不值",
              "该不", "不该", "有没", "没有", "到底", "是什", "的话", "这个", "那个", "一个",
              "要不", "不要", "多少", "多久", "是不", "不是", "哪些", "哪个", "么样", "什么"}


BAD_CHARS = "怎什么如何为吗呢吧啊的了是在有和就都也还"


def script_terms(text, keywords):
    """
    纯脚本抽检索词，不调模型：
    1. 关键词池里出现的词优先（你自己定的词最准）
    2. 英文/数字整体当一个词（GitHub、Actions、3.5）
    3. 中文按 2-gram 切，剔掉带虚词的组合
    """
    out, seen = [], set()

    def add(w):
        k = w.lower()
        if w and k not in seen and len(out) < 8:
            seen.add(k)
            out.append(w)

    for k in keywords:
        kw = (k.get("keyword") or "").strip()
        if kw and kw in text:
            add(kw)

    for tok in re.findall(r"[A-Za-z][A-Za-z0-9.\-]{1,}", text):
        add(tok)

    for seg in re.findall(r"[\u4e00-\u9fff]+", text):
        for i in range(len(seg) - 1):
            g = seg[i:i + 2]
            if g in STOP_GRAMS or any(c in BAD_CHARS for c in g):
                continue
            add(g)

    return out[:6]


def extract_query_terms(text, models, keywords=None):
    """让模型从选题里抽出用于检索的关键词；失败就用 2-gram 兜底"""
    try:
        data, _ = ask_json([
            {"role": "system", "content": "只输出 JSON，不要解释。"},
            {"role": "user", "content": load_prompt("terms", DEFAULT_TERMS_PROMPT, question=text)},
        ], models, temperature=0.2, timeout=60)
        terms = data.get("terms") or []
        terms = [str(t).strip() for t in terms if str(t).strip()]
        return terms[:5] or script_terms(text, keywords or [])
    except BaseException as e:
        log("抽检索词失败（%r），用脚本切分兜底" % (e,))
        return script_terms(text, keywords or [])


def rank_by_terms(items, terms):
    """按命中选题关键词的数量重排，命中越多越靠前"""
    tl = [t.lower() for t in terms]
    for it in items:
        hay = (it["title"] + " " + (it.get("summary") or "")).lower()
        it["hit_terms"] = [t for t in terms if t.lower() in hay]
        it["rel"] = len(it["hit_terms"])
    items.sort(key=lambda x: (x["rel"], x.get("score", 0)), reverse=True)
    return items


def render_material(cands, limit=8):
    lines = []
    for i, it in enumerate(cands[:limit]):
        lines.append("[%d] %s · %s\n    标题：%s\n    摘要：%s" % (
            i, it["source"], it["age"], it["title"], (it.get("summary") or "（无摘要）")[:260]))
    return "\n".join(lines) or "（这次没抓到外部素材）"


def search_web(query, cfg):
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

def tail_questions(content_md, limit=3):
    """模型没给 next_questions 时，从最后几层里抠带问号的句子"""
    parts = re.split(r"^##\s*\d+\s*楼.*$", content_md, flags=re.M)
    segs = parts[-3:] if len(parts) > 3 else parts[1:]
    qs, seen = [], set()
    for seg in segs:
        for x in re.split(r"(?<=[。！？!?])", seg):
            x = x.strip()
            if (("？" in x) or ("?" in x)) and 8 <= len(x) <= 90 and x not in seen:
                seen.add(x)
                qs.append(x)
    return qs[:limit]


def ensure_next_questions(content_md, models):
    """兜底：单独补一次小请求，只要 1~2 个给下一页的问题"""
    tail = content_md[-1500:]
    try:
        data, _ = ask_json([
            {"role": "system", "content": "你是论坛帖的楼主。只输出 JSON。"},
            {"role": "user", "content": load_prompt("question", DEFAULT_QUESTION_PROMPT, content=tail)},
        ], models, temperature=0.8, timeout=REQUEST_TIMEOUT)
        qs = data.get("next_questions") or []
        if isinstance(qs, str):
            qs = [qs]
        return [str(x).strip()[:100] for x in qs if str(x).strip()][:3]
    except BaseException as e:
        log("补问题失败（%r）" % (e,))
        return []


def next_page_no(posts_dir):
    nums = []
    if os.path.isdir(posts_dir):
        for f in os.listdir(posts_dir):
            m = re.match(r"^(\d+)\.md$", f)
            if m:
                nums.append(int(m.group(1)))
    return (max(nums) + 1) if nums else 1


def step_write_page(site, persona, editorial, seed, material_block, history, models, writing):
    recent = history["items"][-10:]
    recent_block = "\n".join("- 第 %s 页：%s" % (it.get("slug", ""), it.get("title", ""))
                             for it in recent) or "（这是第一页）"

    seed_block = ('这一页要讨论的问题：\n「%s」\n（来自第 %s 页《%s》）\n'
                  '**1 楼必须原样提出这句话，一个字都不要改**，后面所有楼层都围绕它讨论。'
                  % (seed.get("text", ""), seed.get("from", "?"), seed.get("from_title", "")))

    names_block = "\n".join("- %s（%s）" % (r["nick"], r.get("sign") or "") for r in load_names()) or "- 阿强\n- 小北"

    mw = writing["main_words"]
    fc_min, fc_max = writing["floor_count"]
    fw_min, fw_max = writing["floor_words"]
    page_max = mw + fc_max * fw_max
    extra = writing.get("extra_rules") or ""

    avoid = ("\n\n【不要写这些】\n" + editorial[:1500]) if editorial else ""

    system = (persona + avoid +
              "\n\n你在维护一个论坛式连载帖，每天更新一页。"
              "\n这一页由「1 楼提出问题 + 若干楼层讨论」组成，只输出 JSON。")

    user = load_prompt(
        "write", DEFAULT_WRITE_PROMPT,
        today=datetime.datetime.now(BJT).strftime("%Y-%m-%d"),
        seed=seed_block,
        material=material_block,
        recent=recent_block,
        mw=mw, fc_min=fc_min, fc_max=fc_max,
        fw_min=fw_min, fw_max=fw_max,
        page_max=page_max,
        names=names_block,
        extra=extra,
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
    writing = load_writing()
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
        # 首选：从上一页楼层里留下的候选问题中挑一个
        lq = mine.latest_next_questions(POSTS)
        if lq:
            pick = random.choice(lq["questions"])
            seed = {"kind": "question", "text": pick, "from": lq["slug"],
                    "from_title": lq["page_title"]}
            log("第 %s 页留下 %d 个候选，选中：%s"
                % (lq["slug"], len(lq["questions"]), pick[:60]))
        else:
            # 退路：从旧帖里随机挖
            questions = mine.scan_questions(POSTS)
            recent_slugs = [it.get("slug") for it in history["items"][-6:]]
            q = mine.pick_question(questions, recent_slugs)
            if q:
                seed = {"kind": "question", "text": q["text"], "from": q["slug"],
                        "from_title": q["page_title"]}
                log("上一页没留问题，从旧帖挖到 %d 条疑问，选中：%s" % (len(questions), q["text"][:60]))
            else:
                log("旧帖里没挖到疑问（%d 条），走热点选题" % len(questions))

    # ---- 2. 取材
    items = src.collect(sources_cfg.get("sources", []),
                        window_hours=sources_cfg.get("window_hours", 48))
    cands = rank_candidates(items, keywords, now)

    set_budget(int(os.environ.get("MODEL_BUDGET_SECONDS", "600")))
    log("模型总时长预算：%d 秒" % int(os.environ.get("MODEL_BUDGET_SECONDS", "600")))

    if not seed:
        if not cands:
            sys.exit("没挖到疑问，也没抓到任何素材，本轮跳过")
        seed = {"kind": "topic", "text": cands[0]["title"], "from": cands[0]["source"]}
        log("用热点当主题：" + seed["text"])

    # ---- 2b. 按选题检索：先用脚本抽词，命中不够再让模型抽
    search_cfg = sources_cfg.get("search") or {}
    extra = search_web(seed["text"], search_cfg)   # 元搜索没配时返回空
    if extra:
        cands = extra + cands

    mode = (writing.get("query_terms") or "auto").lower()
    terms = script_terms(seed["text"], keywords) if mode != "model" else []
    cands = rank_by_terms(cands, terms) if terms else cands
    hits = [c for c in cands if c.get("rel", 0) > 0]

    if mode == "model" or (mode == "auto" and len(hits) < 2):
        if mode == "auto":
            log("脚本抽词只命中 %d 条，改用模型抽词" % len(hits))
        terms = extract_query_terms(seed["text"], models, keywords)
        cands = rank_by_terms(cands, terms)
        hits = [c for c in cands if c.get("rel", 0) > 0]

    relevant = hits[:6]
    log("检索词：%s%s ｜ 命中 %d 条相关素材（信源共 %d 条）"
        % ("、".join(terms[:3]), "…" if len(terms) > 3 else "", len(relevant), len(cands)))

    if relevant:
        for c in relevant[:3]:
            log("   · [%s] %s" % (",".join(c.get("hit_terms", [])) or "-", c["title"][:40]))
        material_block = render_material(relevant, 6)
    else:
        material_block = ("（信源里没有和这个问题直接相关的内容。"
                          "可以基于你已有的知识回答，但不要编造具体数字、价格、时间和人名。）")

    # ---- 3. 写作
    data, resp = step_write_page(site, persona, editorial, seed, material_block, history, models, writing)

    content_md = (data.get("content_md") or data.get("content") or "").strip()

    # 正文不许有一级标题：模型要是写了就剥掉，标题统一用 JSON 里的
    title = (data.get("title") or "").strip()
    m = re.match(r"\A\s*#\s+(.+?)\s*\n", content_md)
    if m:
        title = title or m.group(1).strip()
        content_md = content_md[m.end():].lstrip()
    if not title:
        title = (seed.get("text") or "无题")[:20]

    min_words = max(150, int(writing["main_words"] * 0.5))
    if len(content_md) < min_words:
        sys.exit("产出太短（%d 字，阈值 %d），判定失败" % (len(content_md), min_words))

    # 落盘时把标题补回去，md 里保持 # 标题 + 正文
    content_md = "# " + title + "\n\n" + content_md

    question = (seed["text"] if seed.get("kind") == "question" else (data.get("question") or "")).strip()
    next_qs = data.get("next_questions")
    if isinstance(next_qs, str):
        next_qs = [next_qs]
    next_qs = [str(x).strip()[:100] for x in (next_qs or []) if str(x).strip()][:4]
    if not next_qs:
        next_qs = tail_questions(content_md, 3)
    if not next_qs and writing.get("auto_next_question", True):
        log("楼层里没抠到新问题，补问一次…")
        next_qs = ensure_next_questions(content_md, models)
    log("留给下一页的候选问题：%s" % (" ｜ ".join(next_qs) or "（没有，下一页随机挖）"))

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
        "next_questions: %s" % json.dumps(next_qs, ensure_ascii=False),
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
        "next_questions": next_qs,
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
