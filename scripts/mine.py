#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从已有的 md 页里挖「疑问句 / 痛点句」，当下一轮的选题来源。
纯字符串层面筛选，不调模型。
"""

import json
import os
import random
import re

# 疑问、困惑、纠结的信号词
Q_PAT = re.compile(
    r"[?？]|怎么|如何|为什么|为啥|能不能|可不可以|有没有|是不是|该不该|值不值|要不要|"
    r"值得吗|靠谱吗|难吗|会不会|有没有必要|到底"
)

SKIP_PREFIX = ("#", ">", "```", "- ", "* ", "+ ", "|", "![")
FM_RE = re.compile(r"\A---\r?\n.*?\r?\n---\r?\n?", re.S)


def _sentences(text):
    """按行拆，再按句末标点拆成短句，跳过标题/引用/列表/代码"""
    for line in text.split("\n"):
        s = line.strip()
        if not s or s.startswith(SKIP_PREFIX):
            continue
        for piece in re.split(r"(?<=[。！？!?])", s):
            piece = piece.strip(" \t　-—…")
            if piece:
                yield piece


def extract_from_text(text):
    out = []
    for s in _sentences(text):
        if not (12 <= len(s) <= 90):
            continue
        if Q_PAT.search(s):
            out.append(s)
    return out


def norm(s):
    return re.sub(r"[\s\u3000，。！？、；：\"'（）()【】《》…—·,.!?;:]+", "", s).lower()


def scan_questions(posts_dir, limit=200):
    """扫 posts 下所有 md，返回 [{text, slug, page_title}]，已去重"""
    seen, out = set(), []
    if not os.path.isdir(posts_dir):
        return out

    files = sorted(f for f in os.listdir(posts_dir) if f.endswith(".md"))
    for fn in files:
        path = os.path.join(posts_dir, fn)
        try:
            with open(path, "r", encoding="utf-8") as f:
                text = FM_RE.sub("", f.read(), count=1)
        except Exception:
            continue

        # 取页面标题，用于回指
        m = re.search(r"^#\s+(.+)$", text, re.M)
        page_title = m.group(1).strip() if m else fn[:-3]

        for s in extract_from_text(text):
            k = norm(s)
            if not k or k in seen:
                continue
            seen.add(k)
            out.append({"text": s, "slug": fn[:-3], "page_title": page_title})
            if len(out) >= limit:
                return out
    return out


def latest_next_questions(posts_dir):
    """
    读最新一页里留下的候选问题（next_questions，JSON 数组），
    下一页从里面挑一个来讨论。
    """
    if not os.path.isdir(posts_dir):
        return None
    files = sorted((f for f in os.listdir(posts_dir) if f.endswith(".md")),
                   key=lambda x: (0, int(re.match(r"^(\d+)", x).group(1)), x)
                   if re.match(r"^(\d+)", x) else (1, 0, x))
    for fn in reversed(files):
        try:
            with open(os.path.join(posts_dir, fn), "r", encoding="utf-8") as f:
                head = f.read(800)
        except Exception:
            continue
        m = re.search(r"^next_questions:\s*(.+)$", head, re.M)
        if not m:
            continue
        raw = m.group(1).strip()
        try:
            qs = json.loads(raw)
        except Exception:
            qs = [raw.strip('"').strip("'")]
        qs = [str(q).strip() for q in qs if str(q).strip()]
        if not qs:
            continue
        t = re.search(r"^title:\s*(.+)$", head, re.M)
        return {"questions": qs, "slug": fn[:-3],
                "page_title": t.group(1).strip() if t else fn[:-3]}
    return None


def pick_question(questions, exclude_pages=None, seed=None):
    """随机挑一条，尽量避开最近写过的页"""
    if not questions:
        return None
    pool = questions
    if exclude_pages:
        recent = list(exclude_pages)[-6:]
        filtered = [q for q in questions if q["slug"] not in recent]
        if filtered:
            pool = filtered
    rnd = random.Random(seed) if seed is not None else random
    return rnd.choice(pool)


if __name__ == "__main__":
    import sys
    d = sys.argv[1] if len(sys.argv) > 1 else "docs/posts"
    qs = scan_questions(d)
    print("共挖到 %d 条疑问/痛点：" % len(qs))
    for q in qs[:20]:
        print(" -", q["text"], "（来自 %s）" % q["slug"])
