#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从已有页面的「评论 / 楼层 / 短评」里挑下一篇的话题。
纯字符串层面筛选，不调模型。

来源只有一处：历史正文里以 `## @昵称 · 时间` 开头的署名段落。
  - 无主笔（论坛 peers）：这些段落就是讨论楼层本身
  - 有主笔（lead_support）：主笔长文不署名，这些段落就是文末短评
两种角色都从「人真实说的话」里选题，不再依赖结尾特意留的续问。
"""

import os
import random
import re

# 疑问 / 痛点信号（保留作加分项，不再是唯一入口）
Q_PAT = re.compile(
    r"[?？]|怎么|如何|为什么|为啥|能不能|可不可以|有没有|是不是|该不该|值不值|要不要|"
    r"值得吗|靠谱吗|难吗|会不会|有没有必要|到底"
)

SKIP_PREFIX = ("#", ">", "```", "- ", "* ", "+ ", "|", "![")
FM_RE = re.compile(r"\A---\r?\n.*?\r?\n---\r?\n?", re.S)
# 署名段落标题：## @昵称 · 时间（时间部分可缺省）
SPEAKER_RE = re.compile(r"^##\s+@([^\s·]+)[^\n]*$", re.M)

# 具体信息信号：有数字/单位/具体名词的句子更适合当独立话题
UNIT_RE = re.compile(r"\d|[0-9０-９]|(?:GB|G|MB|M|元|块|月|年|天|小时|分钟|%|％|倍)")
CONCRETE_HINT = (
    "卡", "套餐", "流量", "限速", "合约", "注销", "实名", "归属", "客服", "首充",
    "学生", "校园", "异地", "热点", "VoLTE", "APN", "5G", "信号", "优惠", "违约金",
    "销户", "补卡", "物联卡", "双卡", "月租", "宽带", "运营商", "渠道", "客服",
)
CONTRAST_HINT = ("但", "不过", "其实", "反而", "可是", "然而", "问题", "坑", "麻烦",
                 "不支持", "别", "千万", "注意", "先", "再")
VAGUE = ("大家怎么看", "你怎么看", "欢迎补充", "仅供参考", "以上", "谢谢", "学习了",
         "沙发", "顶一下", "蹲一个", "mark", "同问", "求推荐", "怎么选")
LEAD_PRONOUN = ("这", "那", "它", "他", "她", "其", "此", "这个", "那个")


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


def clean_speaker_text(s):
    """清掉句首残留的署名/时间戳，避免把元信息当话题"""
    s = re.sub(r"^@[^\s·]+\s*·?\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}[\s:：\d]*", "", s or "")
    s = re.sub(r"^\d{4}[-/]\d{1,2}[-/]\d{1,2}[\s:：\d]*", "", s)
    return s.strip(" \t　·-—:")


def norm(s):
    return re.sub(r"[\s\u3000，。！？、；：\"'（）()【】《》…—·,.!?;:]+", "", s).lower()


def score_topic(s, compact=False):
    """给一条评论句打话题分。分数越高越适合当下一篇的选题，命中禁词返回 0。

    compact=True 用于文末短评（nav/resource/有主笔的辅助短评）：短评普遍偏短，
    放宽长度下限与加分起点，避免 19 字的具体短评因长度门槛被直接丢弃。
    """
    s = (s or "").strip()
    lo = 10 if compact else 16
    if not (lo <= len(s) <= 100):
        return 0
    if any(v in s for v in VAGUE):
        return 0
    # 孤零零的代词句（"这招对我没用"）缺上下文，单独摆出来读不懂
    if s.startswith(LEAD_PRONOUN) and len(s) < 30:
        return 0
    score = 1
    if (14 if compact else 22) <= len(s) <= 90:
        score += 1
    if UNIT_RE.search(s):
        score += 2
    hits = sum(1 for w in CONCRETE_HINT if w in s)
    score += min(hits, 2)
    if any(w in s for w in CONTRAST_HINT):
        score += 1
    if Q_PAT.search(s):
        score += 1                      # 真疑问仍是好话题，但不再是唯一入口
    if re.search(r"\?\?|\?？|？？$", s):
        score -= 1                      # 泛泛的连续问号
    return score


def extract_from_text(text, speaker="", compact=False):
    """从一个署名段落里抽出可作话题的句子。"""
    out = []
    for s in _sentences(text):
        s = clean_speaker_text(s)
        sc = score_topic(s, compact=compact)
        if sc >= 2:
            out.append({"text": s, "speaker": speaker, "score": sc})
    return out


def scan_comment_topics(posts_dir, exclude_slugs=None, limit=200, compact=False):
    """扫 posts 下所有 md 的署名评论段落，返回话题候选 [{text,speaker,slug,page_title,score}]。

    exclude_slugs 用于排除最近几页，避免连续两页挑同一批评论。
    compact=True 适用于文末短评（item_list 主题 / 有主笔的辅助短评），放宽长度门槛。
    """
    seen, out = set(), []
    if not os.path.isdir(posts_dir):
        return out
    exclude = set(exclude_slugs or [])

    files = sorted(f for f in os.listdir(posts_dir) if f.endswith(".md"))
    for fn in files:
        slug = fn[:-3]
        if slug in exclude:
            continue
        path = os.path.join(posts_dir, fn)
        try:
            with open(path, "r", encoding="utf-8") as f:
                text = FM_RE.sub("", f.read(), count=1)
        except Exception:
            continue

        m = re.search(r"^#\s+(.+)$", text, re.M)
        page_title = m.group(1).strip() if m else slug

        heads = list(SPEAKER_RE.finditer(text))
        for i, h in enumerate(heads):
            speaker = h.group(1)
            end = heads[i + 1].start() if i + 1 < len(heads) else len(text)
            body = text[h.end():end]
            for cand in extract_from_text(body, speaker, compact=compact):
                k = norm(cand["text"])
                if not k or k in seen:
                    continue
                seen.add(k)
                cand.update({"slug": slug, "page_title": page_title})
                out.append(cand)
                if len(out) >= limit:
                    return out
    return out


def pick_topic(candidates, seed=None, top_n=24):
    """从候选中挑一个：先取高分池，再用 seed 随机挑（同 seed 幂等）。"""
    if not candidates:
        return None
    ranked = sorted(candidates, key=lambda c: (-c.get("score", 0), c.get("slug", "")))
    pool = ranked[:max(1, min(top_n, len(ranked)))]
    rnd = random.Random(seed) if seed is not None else random
    return rnd.choice(pool)


if __name__ == "__main__":
    import sys
    d = sys.argv[1] if len(sys.argv) > 1 else "docs/posts"
    qs = scan_comment_topics(d)
    print("共从评论里挖到 %d 条话题：" % len(qs))
    for q in qs[:20]:
        print(" - [%d分 @%s] %s（来自 %s）" %
              (q["score"], q["speaker"], q["text"], q["slug"]))
