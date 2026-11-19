#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
站点构建层：从 docs/.topics.json + docs/posts/*.md 生成整站。

产物：
  index.html, page/N/index.html      首页分页
  posts/{slug}.html                  文章（含上下篇、标签、参考资料）
  archive.html                       按年月归档
  tags/index.html, tags/{tag}.html   标签总览与标签页
  search.html + search.json          站内搜索
  feed.xml                           RSS 2.0
  sitemap.xml

一切相对路径都是相对站点根，靠 rel 前缀拼。
"""

import datetime
import email.utils
import html
import json
import math
import os
import re
from urllib.parse import quote

BJT = datetime.timezone(datetime.timedelta(hours=8))
PER_PAGE = 12
FEED_SIZE = 20

FM_RE = re.compile(r"\A---\r?\n.*?\r?\n---\r?\n?", re.S)


# ---------------------------------------------------------------- markdown

# 裸链接：模型经常直接吐 https://... 不套 markdown 语法
URL_RE = re.compile(r"https?://[^\s<>\"'\u4e00-\u9fff]+")
# URL 尾部的标点不算链接的一部分
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

    # 先把已生成的标签挖成占位符，避免自动链接把它们再包一层
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


def tag_file(tag):
    """标签 → 文件名（中文直接当文件名，链接里再编码）"""
    t = re.sub(r'[/\\:*?"<>|#?%]', "", str(tag)).strip().replace(" ", "-")
    return t or "untagged"


def tag_href(tag):
    return "tags/" + quote(tag_file(tag)) + ".html"


def pretty_model(mid):
    """google/gemma-4-31b-it:free → Gemma 4 31B（免费）"""
    s = (mid or "").strip()
    if not s:
        return ""
    is_free = s.endswith(":free")
    if is_free:
        s = s[:-5]
    s = s.split("/")[-1]
    parts = [p for p in s.replace("_", "-").split("-") if p]
    out = []
    for p in parts:
        if p.isdigit():
            out.append(p)
        elif re.fullmatch(r"\d+[bm]", p):
            out.append(p.upper())
        elif p in ("it", "instruct"):
            continue
        else:
            out.append(p[:1].upper() + p[1:])
    name = " ".join(out) or s
    return name + ("（免费）" if is_free else "")


def strip_fm(text):
    return FM_RE.sub("", text or "", count=1)


def read(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except Exception:
        return ""


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def root_url(base):
    return (base.rstrip("/") + "/") if base else "./"


def abs_url(base, path):
    return (base.rstrip("/") + "/" + path.lstrip("/")) if base else path


# ---------------------------------------------------------------- 页面骨架

def page(site, rel, title, desc, body, klass="", base="", author=""):
    home = rel or "./"
    author_meta = ('<meta name="author" content="%s">' % esc(author)) if author else ""
    nav = (
        '<nav class="nav">'
        '<a href="{h}">首页</a>'
        '<a href="{r}archive.html">归档</a>'
        '<a href="{r}tags/">标签</a>'
        '<a href="{r}search.html">搜索</a>'
        '</nav>'
    ).format(h=home, r=rel)

    return """<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
{author_meta}
<link rel="stylesheet" href="{r}style.css">
<link rel="alternate" type="application/rss+xml" title="{site}" href="{r}feed.xml">
</head>
<body>
<header class="topbar">
  <a class="brand" href="{home}">{site}</a>
  {nav}
</header>
<main class="wrap {klass}">
{body}
</main>
<footer class="foot">
  <p>{site}{tagline}</p>
  <p class="small"><a href="{r}feed.xml">RSS</a> · {footer}</p>
  <p class="small">{copy}</p>
</footer>
</body>
</html>
""".format(
        title=esc(title),
        desc=esc(desc),
        author_meta=author_meta,
        r=rel,
        home=home,
        site=esc(site["name"]),
        lang=esc(site.get("lang") or "zh-CN"),
        footer=esc(site.get("footer") or "由 GitHub Actions 每天自动生成"),
        copy=("© " + esc(site["author"])) if site.get("author") else "",
        nav=nav,
        body=body,
        klass=klass,
        tagline=(" · " + esc(site["tagline"])) if site.get("tagline") else "",
    )


def card_html(it, rel):
    return (
        '<li class="card"><a href="{r}posts/{slug}.html">'
        '<h2>{title}</h2><p>{summary}</p>'
        '<div class="meta">{date} · {kw}</div></a></li>'
    ).format(
        r=rel,
        slug=esc(it["slug"]),
        title=esc(it["title"]),
        summary=esc(it.get("summary", "")),
        date=esc(it["date"]),
        kw=esc(it.get("keyword", "")),
    )


# ---------------------------------------------------------------- 各页面

def render_post(site, it, prev_it, next_it, img_count):
    rel = "../"
    tags = "".join(
        '<a class="tag" href="{r}{href}">{t}</a>'.format(r=rel, href=tag_href(t), t=esc(t))
        for t in it.get("tags", [])
    )
    why = ('<p class="why">选题来源：%s</p>' % esc(it["why"])) if it.get("why") else ""

    refs = ""
    if it.get("sources"):
        lis = "".join(
            '<li><a href="%s" rel="noopener nofollow" target="_blank">%s</a> <span class="src">%s</span></li>'
            % (esc(s.get("url", "")), esc(s.get("title", "")), esc(s.get("source", "")))
            for s in it["sources"]
        )
        refs = '<section class="refs"><h3>参考资料</h3><ol>%s</ol></section>' % lis

    pager = '<nav class="post-pager">'
    pager += ('<a class="pv" href="../posts/%s.html"><span>更新一篇</span>%s</a>' % (esc(next_it["slug"]), esc(next_it["title"]))
              ) if next_it else '<span></span>'
    pager += ('<a class="nx" href="../posts/%s.html"><span>更早一篇</span>%s</a>' % (esc(prev_it["slug"]), esc(prev_it["title"]))
              ) if prev_it else '<span></span>'
    pager += "</nav>"

    author = it.get("model_name") or pretty_model(it.get("model"))
    who = ('<span class="who">作者 %s</span>' % esc(author)) if author else ""

    body = (
        '<h1>%s</h1><div class="meta">%s %s%s</div>%s'
        '<article class="prose">%s</article>'
        '<p class="back"><a href="../">← 全部文章</a></p>'
        '%s%s'
    ) % (esc(it["title"]), esc(it["date"]), tags, who, why, it["_html"], refs, pager)

    return page(site, rel, "%s · %s" % (it["title"], site["name"]),
                it.get("summary", ""), body, author=author)


def render_index_pages(site, items, base):
    total = max(1, math.ceil(len(items) / PER_PAGE))
    paths = []
    for p in range(1, total + 1):
        chunk = items[(p - 1) * PER_PAGE: p * PER_PAGE]
        rel = "" if p == 1 else "../../"
        out_rel = "index.html" if p == 1 else "page/%d/index.html" % p

        head = '<h1 class="site-title">%s</h1>' % esc(site["name"])
        if site.get("tagline") and p == 1:
            head += '<p class="site-tagline">%s</p>' % esc(site["tagline"])

        cards = "".join(card_html(it, rel) for it in chunk) or '<li class="card"><p>还没有文章。</p></li>'

        pager = '<nav class="pagination">'
        if p > 1:
            prev_url = "./" if p == 2 else "page/%d/" % (p - 1)
            pager += '<a href="%s">← 上一页</a>' % prev_url
        else:
            pager += "<span></span>"
        pager += '<span class="pinfo">%d / %d</span>' % (p, total)
        if p < total:
            pager += '<a href="page/%d/">下一页 →</a>' % (p + 1)
        else:
            pager += "<span></span>"
        pager += "</nav>"

        body = head + '<ul class="list">%s</ul>' % cards + (pager if total > 1 else "")
        desc = site.get("description") or site.get("tagline", "")
        write(os.path.join(base, out_rel), page(site, rel, site["name"], desc, body, klass="home"))
        paths.append(out_rel)
    return paths


def render_archive(site, items, base):
    groups = {}
    for it in items:
        groups.setdefault(it["date"][:7], []).append(it)

    blocks = []
    for ym in sorted(groups, reverse=True):
        rows = "".join(
            '<li><time>%s</time><a href="posts/%s.html">%s</a></li>'
            % (esc(it["date"][5:]), esc(it["slug"]), esc(it["title"]))
            for it in groups[ym]
        )
        blocks.append('<section class="year-block"><h2>%s <span>%d 篇</span></h2><ul>%s</ul></section>' % (
            esc(ym), len(groups[ym]), rows))

    body = '<h1 class="site-title">归档</h1><p class="site-tagline">共 %d 篇</p>%s' % (len(items), "".join(blocks))
    write(os.path.join(base, "archive.html"), page(site, "", "归档 · " + site["name"], "全部文章归档", body))


def render_tags(site, items, base):
    groups = {}
    for it in items:
        for t in it.get("tags", []):
            groups.setdefault(t, []).append(it)

    lis = "".join(
        '<li><a href="../%s">%s</a><span>%d</span></li>' % (tag_href(t), esc(t), len(groups[t]))
        for t in sorted(groups, key=lambda x: -len(groups[x]))
    )
    body = '<h1 class="site-title">标签</h1><p class="site-tagline">%d 个标签</p><ul class="tag-list">%s</ul>' % (
        len(groups), lis or "<li><p>还没有标签。</p></li>")
    write(os.path.join(base, "tags/index.html"), page(site, "../", "标签 · " + site["name"], "按标签浏览", body))

    for t, its in groups.items():
        cards = "".join(card_html(it, "../") for it in its)
        b = '<h1 class="site-title">#%s</h1><p class="site-tagline">%d 篇</p><ul class="list">%s</ul>' % (
            esc(t), len(its), cards)
        write(os.path.join(base, "tags", tag_file(t) + ".html"),
              page(site, "../", "%s · %s" % (t, site["name"]), "标签：" + t, b))


def render_search(site, items, base):
    index = []
    for it in items:
        text = re.sub(r"<[^>]+>", " ", it.get("_html", ""))
        index.append({
            "title": it["title"],
            "summary": it.get("summary", ""),
            "tags": it.get("tags", []),
            "date": it["date"],
            "url": "posts/%s.html" % it["slug"],
            "text": re.sub(r"\s+", " ", text)[:1200],
        })
    write(os.path.join(base, "search.json"), json.dumps(index, ensure_ascii=False))

    body = """<h1 class="site-title">搜索</h1>
<p class="site-tagline">共 %d 篇</p>
<form class="search-box" onsubmit="return false;">
  <input id="q" type="search" placeholder="输入关键词，比如：小程序、自动化、笔记" autocomplete="off" autofocus>
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
      return (p.title+' '+p.summary+' '+p.tags.join(' ')+' '+p.text).toLowerCase().indexOf(kw) > -1;
    }).slice(0, 40);
    hint.textContent = '找到 ' + hits.length + ' 篇';
    out.innerHTML = hits.map(function(p){
      return '<li class="card"><a href="'+p.url+'"><h2>'+p.title+'</h2><p>'+(p.summary||'')+'</p>'+
             '<div class="meta">'+p.date+' · '+(p.tags||[]).join(' / ')+'</div></a></li>';
    }).join('');
  }
  q.addEventListener('input', run);
})();
</script>""" % (len(items), json.dumps(index, ensure_ascii=False))

    write(os.path.join(base, "search.html"), page(site, "", "搜索 · " + site["name"], "站内搜索", body))


def render_feed(site, items, base, base_url):
    def pubdate(d):
        try:
            dt = datetime.datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=BJT)
            return email.utils.format_datetime(dt)
        except Exception:
            return ""

    entries = []
    for it in items[:FEED_SIZE]:
        link = abs_url(base_url, "posts/%s.html" % it["slug"])
        entries.append(
            "<item><title>%s</title><link>%s</link><guid>%s</guid>"
            "<pubDate>%s</pubDate><description>%s</description></item>"
            % (esc(it["title"]), esc(link), esc(link), pubdate(it["date"]), esc(it.get("summary", "")))
        )

    xml = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>%s</title>
<link>%s</link>
<description>%s</description>
<language>zh-CN</language>
<lastBuildDate>%s</lastBuildDate>
%s
</channel></rss>
""" % (
        esc(site["name"]),
        esc(root_url(base_url)),
        esc(site.get("tagline", "")),
        email.utils.format_datetime(datetime.datetime.now(BJT)),
        "\n".join(entries),
    )
    write(os.path.join(base, "feed.xml"), xml)


def render_sitemap(site, items, base, base_url, pages):
    urls = [""] + [u for u in (["archive.html", "tags/", "search.html"] + pages) if u != "index.html"]
    empty = datetime.date.today().isoformat()
    rows = []
    for p in urls:
        rows.append("<url><loc>%s</loc><lastmod>%s</lastmod></url>" % (esc(abs_url(base_url, p)), empty))
    for it in items:
        rows.append("<url><loc>%s</loc><lastmod>%s</lastmod></url>" % (
            esc(abs_url(base_url, "posts/%s.html" % it["slug"])), esc(it["date"])))
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n%s\n</urlset>\n') % "\n".join(rows)
    write(os.path.join(base, "sitemap.xml"), xml)


# ---------------------------------------------------------------- 主入口

def build(site, docs_dir, base_url=""):
    topics = {"items": []}
    tp = os.path.join(docs_dir, ".topics.json")
    if os.path.exists(tp):
        with open(tp, "r", encoding="utf-8") as f:
            topics = json.load(f)

    items = [it for it in topics.get("items", []) if it.get("slug") and it.get("title")]
    items.sort(key=lambda x: (x["date"], x.get("title", "")), reverse=True)

    for it in items:
        md = strip_fm(read(os.path.join(docs_dir, "posts", it["slug"] + ".md")))
        it["_html"] = md_to_html(md)

    base = docs_dir
    os.makedirs(os.path.join(base, "posts"), exist_ok=True)
    os.makedirs(os.path.join(base, "tags"), exist_ok=True)
    # 清掉旧页面，避免标签改名后留孤儿文件
    for d in ("page", "tags"):
        p = os.path.join(base, d)
        if os.path.isdir(p):
            for f in os.listdir(p):
                if f.endswith(".html"):
                    os.remove(os.path.join(p, f))

    # 清掉索引里已不存在的旧文章页
    keep = {it["slug"] for it in items}
    pdir = os.path.join(base, "posts")
    for f in os.listdir(pdir):
        if f.endswith(".html") and f[:-5] not in keep:
            os.remove(os.path.join(pdir, f))

    for i, it in enumerate(items):
        prev_it = items[i + 1] if i + 1 < len(items) else None
        next_it = items[i - 1] if i > 0 else None
        write(os.path.join(base, "posts", it["slug"] + ".html"),
              render_post(site, it, prev_it, next_it, 0))

    pages = render_index_pages(site, items, base)
    render_archive(site, items, base)
    render_tags(site, items, base)
    render_search(site, items, base)
    render_feed(site, items, base, base_url)
    render_sitemap(site, items, base, base_url, pages)

    return {
        "posts": len(items),
        "pages": len(pages),
        "tags": len({t for it in items for t in it.get("tags", [])}),
    }
