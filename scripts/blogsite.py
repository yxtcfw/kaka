#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
论坛式静态站构建：一个长帖，按页连载。

docs/posts/001.md, 002.md, ...
  # 页面标题
  主楼正文……
  ## 2楼 · 阿强 · 10:12
  楼层内容……
  ## 3楼 · 楼主
  ……

产物：
  index.html            第 1 页（首页）
  posts/002.html ...    后续每页
  feed.xml / sitemap.xml / search.html / search.json
"""

import datetime
import email.utils
import html
import json
import os
import re
from urllib.parse import quote

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NAMES_FILE = os.path.join(ROOT, "config", "names.json")
THEME_FILE = os.path.join(ROOT, "config", "theme.json")
ADS_FILE = os.path.join(ROOT, "config", "ads.json")
_NAMES = None

BJT = datetime.timezone(datetime.timedelta(hours=8))
FEED_SIZE = 20
PAGER_SIDE = 2  # 页码条里当前页左右各显示几个

FM_RE = re.compile(r"\A---\r?\n.*?\r?\n---\r?\n?", re.S)


# ---------------------------------------------------------------- markdown

URL_RE = re.compile(r"https?://[^\s<>\"'\u4e00-\u9fff]+")
URL_TAIL = ".,;:!?)]}，。；：！？）】》”’、"


def autolink(t):
    def repl(m):
        url = m.group(0)
        tail = ""
        while url and url[-1] in URL_TAIL:
            tail = url[-1] + tail
            url = url[:-1]
        if len(url) < 12:
            return m.group(0)
        return '<a href="%s" rel="noopener nofollow" target="_blank">%s</a>%s' % (url, url, tail)
    return URL_RE.sub(repl, t)


def inline(t):
    t = html.escape(t, quote=False)
    stash = []

    def hold(frag):
        stash.append(frag)
        return "\x00%d\x00" % (len(stash) - 1)

    t = re.sub(r"`([^`]+)`", lambda m: hold("<code>%s</code>" % m.group(1)), t)
    t = re.sub(r"!\[([^\]]*)\]\(([^)\s]+)\)",
               lambda m: hold('<img src="%s" alt="%s">' % (m.group(2), m.group(1))), t)
    t = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)",
               lambda m: hold('<a href="%s" rel="noopener">%s</a>' % (m.group(2), m.group(1))), t)

    t = autolink(t)

    t = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", t)
    t = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<em>\1</em>", t)

    for i, frag in enumerate(stash):
        t = t.replace("\x00%d\x00" % i, frag)
    return t


BLOCK_START = ("#", ">", "|", "```", "- ", "* ", "+ ")


def md_to_html(md):
    lines = (md or "").replace("\r\n", "\n").split("\n")
    n = len(lines)
    out, i = [], 0
    list_type, list_items = None, []

    def flush_list():
        nonlocal list_type, list_items
        if list_type and list_items:
            out.append("<%s>%s</%s>" % (list_type, "".join("<li>%s</li>" % x for x in list_items), list_type))
        list_type, list_items = None, []

    while i < n:
        s = lines[i].strip()

        if not s:
            flush_list()
            i += 1
            continue

        if s.startswith("```"):
            flush_list()
            i += 1
            buf = []
            while i < n and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            out.append("<pre><code>%s</code></pre>" % html.escape("\n".join(buf)))
            continue

        m = re.match(r"^(#{1,6})\s+(.*)$", s)
        if m:
            flush_list()
            lvl = len(m.group(1))
            if lvl == 1:
                lvl = 2   # 正文里不允许出现 h1，页标题由模板负责
            out.append("<h%d>%s</h%d>" % (lvl, inline(m.group(2)), lvl))
            i += 1
            continue

        if re.match(r"^(-{3,}|\*{3,}|_{3,})$", s):
            flush_list()
            out.append("<hr>")
            i += 1
            continue

        if s.startswith("|") and i + 1 < n and re.match(r"^\|[\s:|\-]+\|$", lines[i + 1].strip()):
            flush_list()
            header = [c.strip() for c in s.strip("|").split("|")]
            i += 2
            rows = []
            while i < n and lines[i].strip().startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            th = "".join("<th>%s</th>" % inline(c) for c in header)
            body = "".join("<tr>%s</tr>" % "".join("<td>%s</td>" % inline(c) for c in r) for r in rows)
            out.append('<div class="table-wrap"><table><thead><tr>%s</tr></thead><tbody>%s</tbody></table></div>' % (th, body))
            continue

        if s.startswith(">"):
            flush_list()
            buf = []
            while i < n and lines[i].strip().startswith(">"):
                buf.append(lines[i].strip()[1:].strip())
                i += 1
            out.append("<blockquote>%s</blockquote>" % md_to_html("\n".join(buf)))
            continue

        m = re.match(r"^[-*+]\s+(.*)$", s)
        if m:
            if list_type != "ul":
                flush_list()
                list_type = "ul"
            list_items.append(inline(m.group(1)))
            i += 1
            continue

        m = re.match(r"^\d+[.)]\s+(.*)$", s)
        if m:
            if list_type != "ol":
                flush_list()
                list_type = "ol"
            list_items.append(inline(m.group(1)))
            i += 1
            continue

        flush_list()
        buf = [s]
        i += 1
        while i < n:
            t = lines[i].strip()
            if (not t) or t.startswith(BLOCK_START) or re.match(r"^\d+[.)]\s", t) or re.match(r"^(-{3,}|\*{3,})$", t):
                break
            buf.append(t)
            i += 1
        out.append("<p>%s</p>" % inline(" ".join(buf)))

    flush_list()
    return "\n".join(out)


# ---------------------------------------------------------------- 工具

def esc(s):
    return html.escape(str(s or ""), quote=True)


def load_theme_slots():
    """读取主站下发的主题 slots，决定广告插入位置"""
    try:
        with open(THEME_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return (data.get("slots") or {}).get("ads") or {}
    except Exception:
        return {}


def load_ads():
    """支持两种写法：数组（每页 1 条），或 {per_page, items}"""
    try:
        with open(ADS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return {"per_page": 0, "items": []}

    if isinstance(data, list):
        items, per = data, 1
    elif isinstance(data, dict):
        items, per = data.get("items") or [], data.get("per_page", 1)
    else:
        return {"per_page": 0, "items": []}

    items = [r for r in items if isinstance(r, dict) and (r.get("text") or "").strip()]
    try:
        per = max(0, int(per))
    except Exception:
        per = 0

    slots = load_theme_slots()
    position = (slots.get("position") or "between_floors").strip()
    if position == "none":
        per = 0
    if slots.get("per_page") is not None:
        try:
            per = max(0, int(slots["per_page"]))
        except Exception:
            pass
    return {"per_page": per, "items": items, "position": position}


def hash_of(key):
    return sum(ord(c) * (i + 7) for i, c in enumerate(str(key)))


def ad_to_floor(ad):
    body = (ad.get("text") or "").strip()
    link = (ad.get("link") or "").strip()
    if link:
        body += "\n\n[%s](%s)" % ((ad.get("link_text") or "了解详情").strip(), link)
    return {
        "nick": (ad.get("nick") or "").strip(),
        "time": "",
        "body": body,
    }


def merge_extra_floors(floors, ads, slug):
    """把额外内容按均匀间隔插进楼层里，位置由页码哈希决定（每次构建结果一致）"""
    items, per = ads["items"], ads["per_page"]
    if not items or per <= 0:
        return floors

    # 优先用正文里没出现过的昵称，避免出现「同一个人连发两条」
    used = {(f.get("nick") or "") for f in floors}
    pool = [a for a in items if (a.get("nick") or "").strip() not in used] or items

    h = hash_of(slug)
    picked = [ad_to_floor(pool[(h + i) % len(pool)]) for i in range(min(per, len(pool)))]

    out = list(floors)
    gap = max(1, (len(floors) + len(picked)) // (len(picked) + 1))
    for i, extra in enumerate(reversed(picked)):
        pos = min(len(out), gap * (len(picked) - i))
        out.insert(pos, extra)
    return out


def md_plain(md):
    """把 markdown 抹成纯文本，给分享卡片用"""
    t = re.sub(r"```.*?```", " ", md or "", flags=re.S)
    t = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", t)
    t = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", t)
    t = re.sub(r"^#{1,6}\s*", "", t, flags=re.M)
    t = re.sub(r"[*_`>]", "", t)
    t = re.sub(r"\s+", " ", t)
    return t.strip()


def names_map():
    """config/names.json → {昵称: 签名}"""
    global _NAMES
    if _NAMES is None:
        rows = []
        try:
            with open(NAMES_FILE, "r", encoding="utf-8") as f:
                rows = json.load(f)
        except Exception:
            rows = []
        _NAMES = {r["nick"]: (r.get("sign") or "") for r in rows if isinstance(r, dict) and r.get("nick")}
    return _NAMES


def strip_fm(text):
    return FM_RE.sub("", text or "", count=1)


def fm_fields(text):
    """读 front matter 里的简单 k: v"""
    m = FM_RE.match(text or "")
    out = {}
    if not m:
        return out
    for line in m.group(0).split("\n"):
        if ":" in line:
            k, v = line.split(":", 1)
            k = k.strip().strip("-").strip()
            if k and k != "":
                out[k] = v.strip()
    return out


def read(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except Exception:
        return ""


def write(path, text):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def abs_url(base, path):
    return (base.rstrip("/") + "/" + path.lstrip("/")) if base else path


def root_url(base):
    return (base.rstrip("/") + "/") if base else "./"


def natural_key(name):
    """001.md 按数字排，没数字的排后面"""
    m = re.match(r"^(\d+)", os.path.basename(name))
    return (0, int(m.group(1)), name) if m else (1, 0, name)


# ---------------------------------------------------------------- 解析一页

FLOOR_AT = re.compile(r"^##\s*@(.+?)(?:\s*[·・]\s*(.*?))?\s*$", re.M)
FLOOR_NUM = re.compile(r"^##\s*(\d+)\s*楼\s*(?:[·・]\s*(.*?))?\s*$", re.M)


def find_floor_marks(text):
    """返回 [(start, end, nick, time)]，两种写法都认"""
    marks = []
    for m in FLOOR_AT.finditer(text):
        marks.append((m.start(), m.end(), m.group(1).strip(), (m.group(2) or "").strip()))
    for m in FLOOR_NUM.finditer(text):
        nick, when = _split_meta(m.group(2))
        marks.append((m.start(), m.end(), nick, when))
    marks.sort()
    return marks


TIME_RE = re.compile(r"^(\d{1,2}:\d{2}(:\d{2})?|\d{4}-\d{2}-\d{2}.*)$")


def _split_meta(meta):
    """"网友·阿强 · 10:12" → ("网友·阿强", "10:12")；作者本身带·也不会切错"""
    meta = (meta or "").strip()
    if not meta:
        return "", ""
    parts = [p.strip() for p in re.split(r"[·・]", meta) if p.strip()]
    if not parts:
        return "", ""
    if len(parts) > 1 and TIME_RE.match(parts[-1]):
        return "·".join(parts[:-1]), parts[-1]
    return "·".join(parts), ""


def parse_page(text, slug):
    meta = fm_fields(text)
    text = strip_fm(text)
    title = meta.get("title") or ""
    date = meta.get("date", "")

    m = re.match(r"^\s*#\s+(.+)$", text, re.M)
    if m:
        title = title or m.group(1).strip()
        text = text[:m.start()] + text[m.end():]

    marks = find_floor_marks(text)

    # 1 楼：优先用标题下方的引言；没有引言就用第一个楼层
    if not marks:
        first = {"nick": "", "time": "", "body": text.strip()}
        rest = []
        intro = ""
    else:
        intro = text[:marks[0][0]].strip()
        if intro:
            first = {"nick": "", "time": "", "body": intro}
            rest = marks
        else:
            m0 = marks[0]
            end = marks[1][0] if len(marks) > 1 else len(text)
            first = {"nick": m0[2], "time": m0[3], "body": text[m0[1]:end].strip()}
            rest = marks[1:]

    floors = []
    for i, mk in enumerate(rest):
        end = rest[i + 1][0] if i + 1 < len(rest) else len(text)
        floors.append({"nick": mk[2], "time": mk[3], "body": text[mk[1]:end].strip()})

    words = len(first["body"]) + sum(len(f["body"]) for f in floors)
    return {"slug": slug, "title": title or slug, "main": first["body"],
            "main_nick": first["nick"], "main_time": first["time"],
            "floors": floors, "words": words, "date": date}


def load_pages(docs_dir):
    pdir = os.path.join(docs_dir, "posts")
    if not os.path.isdir(pdir):
        return []
    files = sorted((f for f in os.listdir(pdir) if f.endswith(".md")), key=natural_key)
    pages = []
    for fn in files:
        slug = fn[:-3]
        p = parse_page(read(os.path.join(pdir, fn)), slug)
        p["md"] = fn
        pages.append(p)
    return pages


# ---------------------------------------------------------------- 渲染

PAGE_TMPL = """<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
{author_meta}
<link rel="stylesheet" href="{rel}style.css">
<link rel="alternate" type="application/rss+xml" title="{site}" href="{rel}feed.xml">
</head>
<body>
<header class="topbar">
  <a class="brand" href="{rel}index.html">{site}</a>
  <span class="board">{tagline}</span>
  <a class="search-ico" href="{rel}search.html" aria-label="搜索">
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M16.5 16.5 L21 21"/></svg>
  </a>
</header>
<main class="wrap">
{body}
</main>
<footer class="foot">
  <p>{site}<span class="dot">·</span>{tagline}</p>
  <p class="small"><a href="{rel}feed.xml">RSS</a> · <a href="{rel}search.html">搜索</a> · {footer}</p>
  {copy}
</footer>
</body>
</html>
"""


def page_shell(site, rel, title, desc, body, author=""):
    return PAGE_TMPL.format(
        lang=esc(site.get("lang") or "zh-CN"),
        title=esc(title),
        desc=esc(desc),
        author_meta=('<meta name="author" content="%s">' % esc(author)) if author else "",
        rel=rel,
        site=esc(site.get("name") or ""),
        tagline=esc(site.get("tagline") or ""),
        body=body,
        footer=esc(site.get("footer") or "自动生成"),
        copy=('<p class="small">© %s</p>' % esc(site["author"])) if site.get("author") else "",
    )


AVATAR_COLORS = ["#c0392b", "#2980b9", "#27ae60", "#8e44ad", "#d35400", "#16a085", "#7f8c8d"]


def floor_html(f, is_main=False, rel=""):
    nick = (f.get("nick") or "").strip()
    sign = names_map().get(nick, "") if nick else ""
    when = (f.get("time") or "").strip()

    cls = "floor main" if is_main else "floor"
    if not nick:
        cls += " noname"

    head = []
    if nick:
        head.append('<span class="fnick">%s</span>' % esc(nick))
    if sign:
        head.append('<span class="fsign">%s</span>' % esc(sign))
    # 时间默认不显示（md 里保留，需要时可加回来）
    head = head + ['<button class="fcard" type="button" aria-label="看图">'
                   '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" '
                   'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'
                   '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/>'
                   '<path d="M21 15l-5-5L5 20"/></svg></button>']
    head_html = ('<div class="fhead">%s</div>' % "".join(head)) if head else ""

    avatar = ""
    if nick:
        color = AVATAR_COLORS[sum(map(ord, nick)) % len(AVATAR_COLORS)]
        avatar = '<div class="fav" style="background:%s">%s</div>' % (color, esc(nick[:1]))

    plain = md_plain(f.get("body") or "")
    return ('<article class="%s" data-nick="%s" data-sign="%s" data-text="%s">'
            '%s<div class="fmain">%s'
            '<div class="fbody prose">%s</div></div></article>') % (
        cls, esc(nick), esc(sign), esc(plain[:600]),
        avatar, head_html, md_to_html(f.get("body") or ""))


def pager_html(cur, total, rel, slugs):
    def url(idx):
        return "index.html" if idx == 1 else "posts/%s.html" % slugs[idx - 1]

    def link(idx, text, cls=""):
        c = (' class="%s"' % cls) if cls else ""
        return '<a%s href="%s%s">%s</a>' % (c, rel, url(idx), text)

    parts = ['<nav class="pager">',
             '<div class="pcount">共 %d 页 · 第 %d 页</div>' % (total, cur),
             '<div class="pnav">']

    parts.append(link(1, "« 首页") if cur > 1 else '<span class="off">« 首页</span>')
    parts.append(link(cur - 1, "‹ 上一页") if cur > 1 else '<span class="off">‹ 上一页</span>')

    nums = []
    for i in range(1, total + 1):
        if i == 1 or i == total or abs(i - cur) <= PAGER_SIDE:
            nums.append(i)
    prev = 0
    for i in nums:
        if prev and i - prev > 1:
            parts.append('<span class="gap">…</span>')
        if i == cur:
            parts.append('<em class="cur">%d</em>' % i)
        else:
            parts.append(link(i, str(i)))
        prev = i

    parts.append(link(cur + 1, "下一页 ›") if cur < total else '<span class="off">下一页 ›</span>')
    parts.append(link(total, "末页 »") if cur < total else '<span class="off">末页 »</span>')
    parts.append("</div></nav>")
    return "".join(parts)


def board_intro(docs_dir, rel):
    """每页顶部的站点说明，取自 docs/index.md"""
    text = read(os.path.join(docs_dir, "index.md")).strip()
    if not text:
        return ""
    inner = md_to_html(text)
    if rel:
        # 介绍里的相对链接在子目录页面要补前缀，否则会指错
        inner = re.sub(r'href="(?!https?:|#|/|\.\.?/)', 'href="%s' % rel, inner)
    return '<section class="board-intro prose">%s</section>' % inner


def build(site, docs_dir, base_url=""):
    pages = load_pages(docs_dir)
    base = docs_dir
    slugs = [p["slug"] for p in pages]

    # 清理旧结构留下的页面
    for junk in ("archive.html",):
        fp = os.path.join(base, junk)
        if os.path.exists(fp):
            os.remove(fp)
    for d in ("page", "tags"):
        dp = os.path.join(base, d)
        if os.path.isdir(dp):
            for f in os.listdir(dp):
                if f.endswith(".html") or f == "index.json":
                    os.remove(os.path.join(dp, f))
            try:
                os.rmdir(dp)
            except OSError:
                pass
    # 清掉已删 md 对应的 html
    pdir = os.path.join(base, "posts")
    if os.path.isdir(pdir):
        keep = set(slugs[1:])  # 第 1 页渲染到 index.html
        for f in os.listdir(pdir):
            if f.endswith(".html") and f[:-5] not in keep:
                os.remove(os.path.join(pdir, f))

    total = max(1, len(pages))
    ads = load_ads()

    if not pages:
        # 空站也要有个能打开的首页
        body = board_intro(docs_dir, "")
        body += '<h1 class="page-title">还没有内容</h1>'
        body += '<div class="page-meta">等第一次自动更新，或者手动跑一次 workflow。</div>'
        write(os.path.join(base, "index.html"),
              page_shell(site, "", site.get("name") or "", site.get("description") or "", body))

    for i, p in enumerate(pages):
        cur = i + 1
        rel = "" if cur == 1 else "../"
        out = os.path.join(base, "index.html") if cur == 1 else os.path.join(base, "posts", p["slug"] + ".html")

        body = board_intro(docs_dir, rel)

        # 页面标题只进 <title>，正文直接从 1 楼开始
        body += floor_html({"nick": p.get("main_nick"), "time": p.get("main_time"),
                            "body": p["main"]}, rel=rel)
        # 广告位置由主站主题 slots 决定：论坛插在楼层间；其他主题
        # （after_content / between_items / recommend_block）由各自 renderer 处理，
        # 当前模板统一按楼层间插入作为兼容兜底。
        ad_position = ads.get("position") or "between_floors"
        if ad_position in ("between_floors", "comments", "after_content",
                           "between_items", "recommend_block"):
            extra_floors = merge_extra_floors(p["floors"], ads, p["slug"])
        else:
            extra_floors = p["floors"]
        for f in extra_floors:
            body += floor_html(f, rel=rel)

        body += pager_html(cur, total, rel, slugs)
        body += card_modal(rel)

        write(out, page_shell(
            site, rel,
            "%s · %s" % (p["title"], site.get("name") or ""),
            (p["main"][:80] + "…") if len(p["main"]) > 80 else p["main"],
            body,
        ))

    write(os.path.join(base, "assets", "cards.js"), CARD_JS)

    build_search(site, pages, base, slugs)
    build_feed(site, pages, base, base_url, slugs)
    build_sitemap(site, pages, base, base_url, slugs)

    return {"pages": len(pages), "floors": sum(len(p["floors"]) + 1 for p in pages),
            "words": sum(p["words"] for p in pages)}


# ---------------------------------------------------------------- 附加页

def build_search(site, pages, base, slugs):
    index = []
    for i, p in enumerate(pages):
        cur = i + 1
        url = "index.html" if cur == 1 else "posts/%s.html" % p["slug"]
        text = p["main"] + " " + " ".join(f["body"] for f in p["floors"])
        index.append({
            "title": p["title"],
            "page": cur,
            "url": url,
            "text": re.sub(r"\s+", " ", text)[:1500],
        })

    write(os.path.join(base, "search.json"), json.dumps(index, ensure_ascii=False))

    body = """<h1 class="page-title">搜索</h1>
<div class="page-meta">全站 __TOTAL__ 页</div>
<form class="search-box" onsubmit="return false;">
  <input id="q" type="search" placeholder="输入关键词，比如：小程序、自动化、备份" autocomplete="off" autofocus>
</form>
<p id="hint" class="site-tagline">正在加载搜索索引…</p>
<ul id="results" class="list"></ul>
<script>
(function(){
  var q = document.getElementById('q'), out = document.getElementById('results'),
      hint = document.getElementById('hint'), data = null;

  fetch('search.json').then(function(r){ return r.json(); }).then(function(d){
    data = d;
    hint.textContent = '共 ' + d.length + ' 页，输入关键词开始搜。';
  }).catch(function(){
    hint.textContent = '索引加载失败。用 file:// 直接打开会有这个限制，请通过 http 访问。';
  });

  function run(){
    if (!data) return;
    var kw = q.value.trim().toLowerCase();
    if (!kw){ out.innerHTML = ''; hint.textContent = '共 ' + data.length + ' 页，输入关键词开始搜。'; return; }
    var hits = data.filter(function(p){
      return (p.title + ' ' + p.text).toLowerCase().indexOf(kw) > -1;
    }).slice(0, 40);
    hint.textContent = '找到 ' + hits.length + ' 页';
    out.innerHTML = hits.map(function(p){
      var t = p.text.replace(/</g, '&lt;');
      var i = t.toLowerCase().indexOf(kw);
      var snip = i > -1 ? t.slice(Math.max(0, i - 40), i + 80) : t.slice(0, 80);
      return '<li class="card"><a href="' + p.url + '"><h2>第 ' + p.page + ' 页 · ' + p.title +
             '</h2><p>…' + snip + '…</p></a></li>';
    }).join('');
  }
  q.addEventListener('input', run);
})();
</script>""".replace("__TOTAL__", str(len(pages)))

    write(os.path.join(base, "search.html"),
          page_shell(site, "", "搜索 · " + (site.get("name") or ""), "站内搜索", body))


def build_feed(site, pages, base, base_url, slugs):
    def pubdate(d):
        try:
            return email.utils.format_datetime(
                datetime.datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=BJT))
        except Exception:
            return ""

    items = []
    for i, p in enumerate(reversed(pages[-FEED_SIZE:])):
        cur = len(pages) - i
        link = abs_url(base_url, "index.html" if cur == 1 else "posts/%s.html" % p["slug"])
        desc = re.sub(r"\s+", " ", p["main"])[:300]
        items.append(
            "<item><title>%s</title><link>%s</link><guid>%s</guid>%s<description>%s</description></item>"
            % (esc("第 %d 页 · %s" % (cur, p["title"])), esc(link), esc(link),
               ("<pubDate>%s</pubDate>" % pubdate(p.get("date", ""))) if p.get("date") else "",
               esc(desc)))

    xml = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>%s</title>
<link>%s</link>
<description>%s</description>
<language>zh-CN</language>
<lastBuildDate>%s</lastBuildDate>
%s
</channel></rss>
""" % (esc(site.get("name") or ""), esc(root_url(base_url)), esc(site.get("tagline") or ""),
       email.utils.format_datetime(datetime.datetime.now(BJT)), "\n".join(items))
    write(os.path.join(base, "feed.xml"), xml)


def build_sitemap(site, pages, base, base_url, slugs):
    today = datetime.date.today().isoformat()
    locs = ["index.html", "search.html"]
    for i, p in enumerate(pages):
        if i == 0:
            continue
        locs.append("posts/%s.html" % p["slug"])

    rows = ["<url><loc>%s</loc><lastmod>%s</lastmod></url>" % (esc(abs_url(base_url, u)), today) for u in locs]
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n%s\n</urlset>\n') % "\n".join(rows)
    write(os.path.join(base, "sitemap.xml"), xml)


# ---------------------------------------------------------------- 分享卡片

CARD_MODAL = """<div class="viewer" id="viewer" data-cards="__CARDS_JSON__">
  <button class="viewer-close" id="viewerClose" type="button" aria-label="退出">
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
  </button>
  <a class="viewer-dl" id="viewerDownload" download aria-label="下载">
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/></svg>
  </a>
  <div class="viewer-stage"><canvas id="viewerCanvas"></canvas></div>
  <div class="viewer-count" id="viewerCount"></div>
</div>
<script src="__REL__assets/cards.js" defer></script>"""

CARD_JS = r"""(function(){
  var viewer = document.getElementById('viewer');
  if (!viewer) return;

  var canvas = document.getElementById('viewerCanvas');
  var ctx = canvas.getContext('2d');
  var closeBtn = document.getElementById('viewerClose');
  var dl = document.getElementById('viewerDownload');
  var counter = document.getElementById('viewerCount');

  var CARDS = {};
  try { CARDS = JSON.parse(viewer.getAttribute('data-cards') || '{}'); } catch (e) {}

  var floors = [], idx = 0, cache = {};

  function load(src){
    return new Promise(function(res){
      if (!src) return res(null);
      if (cache[src] !== undefined) return res(cache[src]);
      var im = new Image();
      im.onload = function(){ cache[src] = im; res(im); };
      im.onerror = function(){ cache[src] = null; res(null); };
      im.src = src;
    });
  }

  function wrap(text, maxW){
    var lines = [], line = '';
    for (var i = 0; i < text.length; i++){
      var ch = text.charAt(i);
      var t = line + ch;
      if (ctx.measureText(t).width > maxW && line){ lines.push(line); line = ch; }
      else line = t;
    }
    if (line) lines.push(line);
    return lines;
  }

  function paint(nick, sign, text, img){
    var W = img ? img.naturalWidth : 1080;
    var H = img ? img.naturalHeight : 1440;
    canvas.width = W; canvas.height = H;

    if (img) {
      ctx.drawImage(img, 0, 0, W, H);
    } else {
      var gr = ctx.createLinearGradient(0, 0, W, H);
      gr.addColorStop(0, '#2a251f'); gr.addColorStop(1, '#443a2e');
      ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
    }

    var pad = Math.round(W * 0.08);
    var maxW = W - pad * 2;
    var y = Math.round(H * 0.18);

    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,.4)';
    ctx.shadowBlur = Math.round(W * 0.012);

    ctx.font = 'bold ' + Math.round(W * 0.052) + 'px "Songti SC","Noto Serif SC",serif';
    ctx.fillText(nick || '匿名', pad, y);
    y += Math.round(W * 0.08);

    if (sign){
      ctx.globalAlpha = 0.72;
      ctx.font = Math.round(W * 0.028) + 'px "Songti SC","Noto Serif SC",serif';
      ctx.fillText(sign, pad, y);
      ctx.globalAlpha = 1;
      y += Math.round(W * 0.062);
    }

    var fs = W * 0.036, lines = [], lh = 0;
    for (var k = 0; k < 5; k++){
      ctx.font = Math.round(fs) + 'px "Songti SC","Noto Serif SC",serif';
      lines = wrap(text || '（这一层没有正文）', maxW);
      lh = Math.round(fs * 1.75);
      if (y + lines.length * lh <= H - pad) break;
      fs *= 0.87;
    }

    var maxLines = Math.floor((H - pad - y) / lh);
    if (maxLines > 0 && lines.length > maxLines){
      lines = lines.slice(0, maxLines);
      lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1) + '\u2026';
    }

    for (var j = 0; j < lines.length; j++){
      ctx.fillText(lines[j], pad, y);
      y += lh;
    }
    ctx.shadowBlur = 0;

    prepareDownload();
  }

  function prepareDownload(){
    var f = floors[idx];
    var nick = f ? (f.getAttribute('data-nick') || 'card') : 'card';
    if (canvas.toBlob){
      canvas.toBlob(function(blob){
        if (!blob) return;
        if (dl.dataset.url) URL.revokeObjectURL(dl.dataset.url);
        var u = URL.createObjectURL(blob);
        dl.dataset.url = u;
        dl.href = u;
        dl.download = nick + '.png';
      }, 'image/png');
    } else {
      dl.href = canvas.toDataURL('image/png');
      dl.download = nick + '.png';
    }
  }

  function renderCurrent(){
    var f = floors[idx];
    if (!f) return;
    var nick = f.getAttribute('data-nick') || '匿名';
    var sign = f.getAttribute('data-sign') || '';
    var text = f.getAttribute('data-text') || '';
    counter.textContent = (idx + 1) + ' / ' + floors.length;

    load(CARDS[nick]).then(function(img){
      paint(nick, sign, text, img);
      canvas.style.animation = 'none';
      void canvas.offsetWidth;
      canvas.style.animation = 'viewerIn .2s ease';
    });
  }

  function go(step){
    var n = idx + step;
    if (n < 0 || n >= floors.length) return;
    idx = n;
    renderCurrent();
  }

  function open(startFloor){
    floors = Array.prototype.slice.call(document.querySelectorAll('.floor[data-nick]'));
    idx = Math.max(0, floors.indexOf(startFloor));
    viewer.classList.add('on');
    document.body.style.overflow = 'hidden';
    renderCurrent();
  }

  function close(){
    viewer.classList.remove('on');
    document.body.style.overflow = '';
    var f = floors[idx];
    if (f && f.scrollIntoView){
      setTimeout(function(){ f.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 40);
    }
  }

  document.addEventListener('click', function(e){
    var t = e.target;
    if (!t || !t.closest) return;
    var btn = t.closest('.fcard');
    if (btn) open(btn.closest('.floor'));
  });

  closeBtn.addEventListener('click', close);

  var startY = 0, tracking = false;
  viewer.addEventListener('touchstart', function(e){
    if (e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    tracking = true;
  }, { passive: true });

  viewer.addEventListener('touchmove', function(e){
    if (tracking && e.cancelable) e.preventDefault();
  }, { passive: false });

  viewer.addEventListener('touchend', function(e){
    if (!tracking) return;
    tracking = false;
    var dy = e.changedTouches[0].clientY - startY;
    if (dy < -50) go(1);
    else if (dy > 50) go(-1);
  });

  var lock = false;
  viewer.addEventListener('wheel', function(e){
    if (lock || Math.abs(e.deltaY) < 15) return;
    lock = true;
    setTimeout(function(){ lock = false; }, 280);
    go(e.deltaY > 0 ? 1 : -1);
  }, { passive: true });

  document.addEventListener('keydown', function(e){
    if (!viewer.classList.contains('on')) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown' || e.key === 'PageDown') go(1);
    else if (e.key === 'ArrowUp' || e.key === 'PageUp') go(-1);
  });
})();
"""


def cards_json(rel):
    """{昵称: 背景图地址}，只包含配了 card 的"""
    out = {}
    for r in load_names_rows():
        card = (r.get("card") or "").strip()
        if card:
            # 形象图只在主站存一份，分站用根相对路径同源直引
            out[r["nick"]] = "/assets/cards/" + quote(card)
    # JSON 里的双引号必须转义，否则会把 HTML 属性截断
    return html.escape(json.dumps(out, ensure_ascii=False), quote=True)


def load_names_rows():
    try:
        with open(NAMES_FILE, "r", encoding="utf-8") as f:
            return [r for r in json.load(f) if isinstance(r, dict) and r.get("nick")]
    except Exception:
        return []


def card_modal(rel):
    return (CARD_MODAL
            .replace("__CARDS_JSON__", cards_json(rel))
            .replace("__REL__", rel))
