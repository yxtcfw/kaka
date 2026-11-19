#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
每日自动博客 pipeline
  1. 采集：config/sources.json 里配的源，抓最近 N 小时热点
  2. 排序：关键词命中 + 时效 + 源权重打分，取前 N 条候选
  3. 选题：模型分析候选，挑素材、定角度、给理由
  4. 写作：模型带着素材写一篇长文（事实来自素材，观点自己给）
  5. 构建：写出 md + 更新 docs/.topics.json，交给 site.build 生成整站

用法：
  python scripts/generate.py              # 采集 → 选题 → 写作 → 建站
  python scripts/generate.py --probe      # 只测采集源
  python scripts/generate.py --rebuild    # 不写作，只按现有 md 重建整站（换模板后用）
  python scripts/generate.py -k 某个主题   # 指定主题，跳过选题分析
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
import sources as src      # noqa: E402
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
    site.setdefault("author", "")
    site.setdefault("base_url", "")
    for k, env in (("name", "SITE_NAME"), ("tagline", "SITE_TAGLINE"), ("author", "SITE_AUTHOR")):
        if os.environ.get(env):
            site[k] = os.environ[env]
    site["base_url"] = (os.environ.get("SITE_BASE_URL") or site["base_url"]).strip().rstrip("/")

    # 都没配时，按 Pages 的默认地址推：https://<owner>.github.io/<repo>
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


def render_candidates(cands, limit=24):
    lines = []
    for i, it in enumerate(cands[:limit]):
        hit = (" · 命中:" + ",".join(it["hits"])) if it["hits"] else ""
        lines.append("[%d] %s · %s%s\n    标题：%s\n    摘要：%s" % (
            i, it["source"], it["age"], hit, it["title"], (it.get("summary") or "（无摘要）")[:200]))
    return "\n".join(lines)


# ---------------------------------------------------------------- 模型

def extract_text(resp):
    try:
        msg = resp["choices"][0]["message"]
    except Exception:
        raise RuntimeError("返回结构异常: " + json.dumps(resp, ensure_ascii=False)[:500])
    content = msg.get("content")
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return content or ""


def call_openrouter(messages, model, temperature=0.8, retries=3):
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        sys.exit("缺少环境变量 OPENROUTER_API_KEY")

    payload = {"model": model, "messages": messages, "temperature": temperature,
               "response_format": {"type": "json_object"}}
    headers = {
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
        "HTTP-Referer": os.environ.get("SITE_BASE_URL") or "https://github.com",
        "X-Title": "daily-blog",
    }

    last_err = None
    for attempt in range(retries):
        req = urllib.request.Request(API_URL, data=json.dumps(payload).encode("utf-8"),
                                     headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            last_err = "HTTP %s: %s" % (e.code, body[:400])
            log("调用失败", e.code, body[:200].replace("\n", " "))
            if e.code == 400 and "response_format" in payload:
                payload.pop("response_format", None)
                continue
            if e.code in (401, 402, 403):
                sys.exit("鉴权/额度问题，停止：" + last_err)
            time.sleep(4 * (attempt + 1))
        except Exception as e:
            last_err = repr(e)
            log("调用异常", last_err)
            time.sleep(4 * (attempt + 1))
    sys.exit("多次重试仍失败：" + str(last_err))


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


def ask_json(messages, model, temperature=0.7):
    resp = call_openrouter(messages, model, temperature)
    return parse_json_reply(extract_text(resp)), resp


# ---------------------------------------------------------------- 选题

def step_pick(site, persona, editorial, keywords, history, cands, model):
    recent = []
    for it in history["items"][-15:]:
        angle = it.get("angle") or ""
        recent.append("- %s%s" % (it.get("title", ""), ("（角度：" + angle + "）") if angle else ""))
    recent_block = "\n".join(recent) or "（暂无，这是第一篇）"

    kw_block = "\n".join(
        "- %s%s" % (k["keyword"], ("：" + k["note"]) if k["note"] else "") for k in keywords
    )

    system = persona + "\n\n你现在是站点「%s」的选题编辑。只输出 JSON，不要任何解释文字。" % site["name"]

    user = """今天是 {today}。下面是最近抓到的热点候选，已经按相关度排好序。

【关键词池】
{kw}

【编辑偏好】
{ed}

【已经写过的选题（不要重复角度）】
{recent}

【候选素材】
{cands}

【任务】
挑 1-3 条能撑起一个选题的素材（也可以只挑 1 条），然后定一个选题。
判断标准：
1. 和关键词池沾边，是读者关心的；
2. 有信息增量，不是纯通稿；
3. 能写出你自己的判断，而不只是转述新闻；
4. 和已写过的角度明显不同。
如果这批候选全都不值得写，就把 picks 留空、topic 写空字符串。

【输出 JSON】
{{
  "picks": [候选序号, ...],
  "topic": "选题名称，一句话",
  "angle": "切入角度，具体到你会怎么展开，40字内",
  "why": "为什么是现在写这个，30字内",
  "keyword": "对应的关键词池里的词",
  "facts": ["从素材里能确认的关键事实，最多5条，不要编"]
}}""".format(
        today=datetime.datetime.now(BJT).strftime("%Y-%m-%d"),
        kw=kw_block,
        ed=editorial or "（无）",
        recent=recent_block,
        cands=render_candidates(cands),
    )

    data, _ = ask_json([
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ], model, temperature=0.5)

    picks = [int(p) for p in (data.get("picks") or []) if str(p).isdigit() and 0 <= int(p) < len(cands)]
    return data, picks


# ---------------------------------------------------------------- 写作

def step_write(site, persona, editorial, keywords, history, topic, picks, cands, model):
    material = []
    for i in picks:
        it = cands[i]
        material.append("《%s》\n来源：%s（%s）\n链接：%s\n摘要：%s" % (
            it["title"], it["source"], it["age"], it["url"], (it.get("summary") or "无")[:400]))
    material_block = "\n\n".join(material) or "（本次没有外部素材，靠你自己的知识写，但不要编具体的数字和事件）"

    recent = "\n".join("- " + it.get("title", "") for it in history["items"][-15:])

    avoid = ("\n\n【不要写这些】" + editorial[:400]) if editorial else ""
    system = persona + avoid + "\n\n你现在在给站点「%s」写今天的文章。只输出 JSON，不要任何解释文字。" % site["name"]

    user = """【今天的选题】
{topic}
切入角度：{angle}
为什么现在写：{why}

【素材】
{material}

【关键词池（可选，用来组织内容）】
{kw}

【最近写过的（不要重复同样的观点和例子）】
{recent}

【写作要求】
1. 全文 {wc} 字左右（中文）。口语化，像跟人聊天，不用"首先其次最后"这种作文结构。
2. 素材里的事实必须准确引用，不要衍生、不要编造数字、人名、机构、价格。素材没提到的具体数据，就别写。
3. 不要复述新闻。素材只是个起点，你要给判断、给方法、给能落地的建议。
4. 用 markdown：3-5 个二级标题（##），可以有小列表，少用表格。
5. 开头 2-3 句抓住人，结尾给一个具体可执行的动作，不要"综上所述"。
6. 不要在正文里写"参考资料""来源"这类区块，程序会自动加。
7. 不要出现"作为AI""以下是文章"这类元话语。

【输出 JSON】
{{
  "title": "标题，20字以内，有点击欲但不标题党",
  "slug": "英文小写连字符，如 ai-note-tools",
  "summary": "60字以内摘要",
  "tags": ["3到5个中文标签"],
  "content_md": "完整 markdown 正文"
}}""".format(
        topic=topic.get("topic", ""),
        angle=topic.get("angle", ""),
        why=topic.get("why", ""),
        material=material_block,
        kw="、".join(k["keyword"] for k in keywords),
        recent=recent or "（暂无）",
        wc=os.environ.get("WORD_COUNT", "1600"),
    )

    return ask_json([
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ], model, temperature=0.85)


def step_write_fallback(site, persona, keywords, history, forced, model):
    """没抓到素材时的兜底：纯关键词写作"""
    recent = "\n".join("- " + it.get("title", "") for it in history["items"][-20:]) or "（暂无）"
    kw_block = "\n".join("- %s%s" % (k["keyword"], ("（" + k["note"] + "）") if k["note"] else "") for k in keywords)

    system = persona + "\n\n只输出 JSON，不要任何解释文字。"
    user = """今天是 {today}。今天没抓到外部素材，从关键词池里自己找一个角度写。

【关键词池】
{kw}

【已经写过（不要重复）】
{recent}

【要求】
1. {wc} 字左右中文，口语化，有观点，别写通用清单文。
2. 不要编造具体的新闻、数字、人名。拿不准就写"我猜""没验证"。
3. 3-5 个二级标题（##），开头抓人，结尾给可执行建议。

【输出 JSON】
{{"keyword":"选中的词","title":"标题","slug":"english-slug","summary":"60字摘要","tags":["标签"],"content_md":"markdown 正文"}}""".format(
        today=datetime.datetime.now(BJT).strftime("%Y-%m-%d"),
        kw=kw_block, recent=recent,
        wc=os.environ.get("WORD_COUNT", "1600"),
    )

    data, resp = ask_json([
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ], model, temperature=0.85)
    if forced:
        data["keyword"] = forced
    return data, resp


# ---------------------------------------------------------------- 采集自检

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
    ap.add_argument("-k", "--keyword", default="", help="指定主题，跳过选题分析")
    ap.add_argument("--force", action="store_true", help="今天发过了也再写一篇（本地测试用）")
    args = ap.parse_args()

    site = load_site()

    if args.rebuild:
        stat = sitebuilder.build(site, DOCS, site["base_url"])
        log("重建完成：%d 篇 / %d 页 / %d 个标签" % (stat["posts"], stat["pages"], stat["tags"]))
        return

    sources_cfg = load_json(os.path.join(CONFIG, "sources.json"), {"sources": []})
    if args.probe:
        probe(sources_cfg)
        return

    persona = load_text(os.path.join(CONFIG, "persona.md"), "你是一位中文写作好手。")
    editorial = load_text(os.path.join(CONFIG, "editorial.md"), "")
    keywords = load_keywords()
    history = load_history()
    model = os.environ.get("OPENROUTER_MODEL", "google/gemini-3.5-flash-lite").strip()
    forced = args.keyword.strip() or os.environ.get("FORCE_KEYWORD", "").strip()

    now = datetime.datetime.now(BJT)
    date_str = now.strftime("%Y-%m-%d")
    if any(it.get("date") == date_str for it in history["items"]) and not forced and not args.force:
        log("今天已经发过了（%s），只重建站点。想补发请手动触发并指定关键词。" % date_str)
        sitebuilder.build(site, DOCS, site["base_url"])
        return

    # 1. 采集
    items = [] if forced else src.collect(
        sources_cfg.get("sources", []),
        window_hours=sources_cfg.get("window_hours", 48),
    )
    cands = rank_candidates(items, keywords, now)[:int(sources_cfg.get("max_candidates", 24))]

    # 2. 选题
    topic, picks = {}, []
    if forced:
        topic = {"topic": forced, "angle": "", "why": "手动指定", "keyword": forced}
        log("手动指定主题：" + forced)
    elif len(cands) >= 3:
        log("候选 %d 条，开始选题分析" % len(cands))
        topic, picks = step_pick(site, persona, editorial, keywords, history, cands, model)
        log("选题：%s | picks=%s" % (topic.get("topic") or "（模型认为都不值得写）", picks))
    else:
        log("候选太少（%d 条），走纯关键词兜底" % len(cands))

    # 3. 写作
    if topic.get("topic"):
        data, resp = step_write(site, persona, editorial, keywords, history, topic, picks, cands, model)
        used = [{"title": cands[i]["title"], "url": cands[i]["url"], "source": cands[i]["source"]} for i in picks]
    else:
        data, resp = step_write_fallback(site, persona, keywords, history, forced, model)
        used = []
        topic = {"angle": "", "why": "无外源素材，纯关键词生成", "keyword": data.get("keyword", forced)}

    title = (data.get("title") or "").strip()
    content_md = (data.get("content_md") or data.get("content") or "").strip()
    if not title or len(content_md) < 200:
        sys.exit("产出不完整：title=%r 正文%d字" % (title, len(content_md)))

    slug = re.sub(r"[^a-z0-9\-]+", "-", (data.get("slug") or "").strip().lower()).strip("-")
    if not slug:
        slug = "post-" + str(abs(hash(title)) % 100000)

    meta = {
        "date": date_str,
        "title": title,
        "slug": "%s-%s" % (date_str, slug),
        "summary": (data.get("summary") or content_md[:60]).strip(),
        "keyword": (topic.get("keyword") or data.get("keyword") or "").strip(),
        "angle": (topic.get("angle") or "").strip(),
        "why": (topic.get("why") or "").strip(),
        "tags": [str(t).strip() for t in (data.get("tags") or []) if str(t).strip()][:5],
        "sources": used,
        "model": model,
    }

    # 4. 落盘：md + 历史
    os.makedirs(POSTS, exist_ok=True)
    with open(os.path.join(POSTS, meta["slug"] + ".md"), "w", encoding="utf-8") as f:
        f.write("---\ntitle: %s\ndate: %s\ntags: %s\nsummary: %s\n---\n\n" % (
            title, date_str, ", ".join(meta["tags"]), meta["summary"]))
        f.write(content_md + "\n")
        if used:
            f.write("\n## 参考资料\n\n")
            for i, s in enumerate(used, 1):
                f.write("%d. [%s](%s) — %s\n" % (i, s["title"], s["url"], s["source"]))

    history["items"].append(meta)
    with open(HISTORY, "w", encoding="utf-8") as f:
        json.dump(history, f, ensure_ascii=False, indent=2)
    with open(os.path.join(DOCS, "index.json"), "w", encoding="utf-8") as f:
        json.dump(history["items"], f, ensure_ascii=False, indent=2)

    # 5. 建站
    stat = sitebuilder.build(site, DOCS, site["base_url"])

    u = resp.get("usage") or {}
    log("完成：《%s》 %d 字 | 素材 %d 条 | tokens %s | 站内 %d 篇 / %d 页" % (
        title, len(content_md), len(used), u.get("total_tokens", "?"), stat["posts"], stat["pages"]))


if __name__ == "__main__":
    main()
