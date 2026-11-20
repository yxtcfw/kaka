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
    head_html = ('<div class="fhead">%s</div>' % "".join(head)) if head else ""

    avatar = ""
    if nick:
        color = AVATAR_COLORS[sum(map(ord, nick)) % len(AVATAR_COLORS)]
        avatar = '<div class="fav" style="background:%s">%s</div>' % (color, esc(nick[:1]))

    return ('<article class="%s">%s<div class="fmain">%s'
            '<div class="fbody prose">%s</div></div></article>') % (
        cls, avatar, head_html, md_to_html(f.get("body") or ""))


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
    """首页顶部的站点说明，取自 docs/index.md"""
    text = read(os.path.join(docs_dir, "index.md")).strip()
    if not text:
        return ""
    return '<section class="board-intro prose">%s</section>' % md_to_html(text)


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

        body = ""
        if cur == 1:
            body += board_intro(docs_dir, rel)

        # 页面标题只进 <title>，正文直接从 1 楼开始
        body += floor_html({"nick": p.get("main_nick"), "time": p.get("main_time"),
                            "body": p["main"]}, is_main=True, rel=rel)
        for f in p["floors"]:
            body += floor_html(f, rel=rel)

        body += pager_html(cur, total, rel, slugs)

        write(out, page_shell(
            site, rel,
            "%s · %s" % (p["title"], site.get("name") or ""),
            (p["main"][:80] + "…") if len(p["main"]) > 80 else p["main"],
            body,
        ))

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
<div class="page-meta">全站 %d 页</div>
<form class="search-box" onsubmit="return false;">
  <input id="q" type="search" placeholder="输入关键词，比如：小程序、自动化、备份" autocomplete="off" autofocus>
</form>
<p id="hint" class="site-tagline">输入关键词开始搜。</p>
<ul id="results" class="list"></ul>
<script>
(function(){
  var data = %s, q = document.getElementById('q'),
      out = document.getElementById('results'), hint = document.getElementById('hint');
  function run(){
    var kw = q.value.trim().toLowerCase();
    if(!kw){ out.innerHTML=''; hint.textContent='输入关键词开始搜。'; return; }
    var hits = data.filter(function(p){
      return (p.title+' '+p.text).toLowerCase().indexOf(kw) > -1;
    }).slice(0, 40);
    hint.textContent = '找到 ' + hits.length + ' 页';
    out.innerHTML = hits.map(function(p){
      var t = p.text.replace(/</g,'&lt;');
      var idx = t.toLowerCase().indexOf(kw);
      var snip = idx > -1 ? t.slice(Math.max(0, idx-40), idx+80) : t.slice(0, 80);
      return '<li class="card"><a href="'+p.url+'"><h2>第 '+p.page+' 页 · '+p.title+'</h2>'+
             '<p>…'+snip+'…</p></a></li>';
    }).join('');
  }
  q.addEventListener('input', run);
})();
</script>""" % (len(pages), json.dumps(index, ensure_ascii=False))

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
