#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
多模块合集渲染器（compositor）

一篇结构化产物（posts/NNN.data.json）拆成正文/站点/资源三个原子模块，
按 composition 生成：
  - 每篇 3 个合集页：文章页 / 导航页 / 资源页
    各自"主模块"完整展开 + 该模块专属评论；另两个模块折叠成摘要卡，
    点击跳到兄弟合集页的对应锚点（#body / #nav / #resource）。
    外链只出现在导航页、资源页的主模块区（rel=nofollow noopener）。
  - 3 个聚合页：/nav/ /resource/ /blog/，跨文章汇总，条目指回对应合集页。

无兼容兜底：只读 .data.json，缺数据视为空模块，不回退旧论坛渲染。
"""

import json
import os
import re

import blogsite as B

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS_DEFAULT = os.path.join(ROOT, "docs")
POSTS_DIRNAME = "posts"

# 模块元信息：标签、锚点、兄弟页目录、H1/名片文案（渲染器固定生成，不占 AI 字段）
MODULE_META = {
    "blog": {
        "label": "正文", "anchor": "body", "dir": "posts", "n": "01",
        "h1": "正文内容", "hero": "这篇文章讲了什么",
        "intro": "本篇简述、金句与全文，围绕关键词展开。",
    },
    "nav": {
        "label": "站点导航", "anchor": "nav", "dir": "nav", "n": "02",
        "h1": "站点导航", "hero": "这篇涉及的站点",
        "intro": "均来自本篇信源素材，链接直达官方页面（新窗口打开）。",
    },
    "resource": {
        "label": "资源下载", "anchor": "resource", "dir": "resource", "n": "03",
        "h1": "资源下载", "hero": "这篇收录的资源",
        "intro": "含适用场景与已知限制，链接直达原页面（新窗口打开）。",
    },
}

# 合集页里模块的展示顺序（固定：正文→站点→资源），order 只影响"哪个为主"
CANON_ORDER = ["blog", "nav", "resource"]


def log(*a):
    print("[compositor]", *a, flush=True)


def load_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def load_data_pages(docs_dir):
    """读所有 .data.json，返回按页号排序的列表；没有 sidecar 的 md 会被忽略。"""
    pdir = os.path.join(docs_dir, POSTS_DIRNAME)
    out = []
    if not os.path.isdir(pdir):
        return out
    for fn in os.listdir(pdir):
        if not fn.endswith(".data.json"):
            continue
        d = load_json(os.path.join(pdir, fn), None)
        if isinstance(d, dict) and d.get("slug"):
            d["_file"] = fn
            out.append(d)
    out.sort(key=lambda x: (int(x.get("page") or 0), x.get("slug", "")))
    return out


# ---------------------------------------------------------------- 片段渲染

def comments_block(items, title="网友短评"):
    if not items:
        return ""
    parts = ['<section class="comments mod-comments"><h2>%s</h2>' % B.esc(title)]
    for c in items:
        if not isinstance(c, dict) or not c.get("text"):
            continue
        parts.append(B.floor_html({"nick": c.get("nick", ""), "body": c.get("text", "")}))
    parts.append("</section>")
    return "".join(parts)


def body_block(d, summary_on=False):
    """正文主模块：简述 + 金句 + 正文全文 + 正文专属评论。"""
    parts = []
    if summary_on and d.get("summary"):
        parts.append('<section class="summary-box"><h2>本篇简述</h2><div class="prose">%s</div></section>'
                     % B.md_to_html(d["summary"]))
    quotes = d.get("quotes") or []
    if quotes:
        parts.append('<section class="quotes"><h2>金句</h2><ul>')
        for q in quotes:
            parts.append("<li>%s</li>" % B.esc(q))
        parts.append("</ul></section>")
    if d.get("content_md"):
        parts.append('<div class="prose article-body">%s</div>' % B.md_to_html(d["content_md"]))
    parts.append(comments_block((d.get("comments") or {}).get("body"), "正文短评"))
    return "".join(parts)


def links_block(items, with_external):
    """站点/资源主模块：序号卡 + 完整点评 + 专属评论。外链仅当 with_external=True 时出现。"""
    items = [x for x in (items or []) if isinstance(x, dict) and x.get("name")]
    if not items:
        return '<p class="page-meta">这一篇没有收录相关条目。</p>'
    parts = ['<div class="mod-list">']
    for i, it in enumerate(items, 1):
        name = B.esc(it.get("name", ""))
        desc = B.esc(it.get("desc", ""))
        detail = B.esc(it.get("detail", ""))
        url = (it.get("url") or "").strip() if with_external else ""
        parts.append('<article class="mod-item">')
        parts.append('<div class="mod-item-top"><span class="mod-index">%02d</span>' % i)
        if url:
            parts.append('<h3 class="mod-item-name"><a href="%s" target="_blank" '
                         'rel="nofollow noopener noreferrer">%s<span class="mod-out" aria-hidden="true">↗</span></a></h3>'
                         % (B.esc(url), name))
        else:
            parts.append('<h3 class="mod-item-name">%s<span class="mod-only">仅名称</span></h3>' % name)
        parts.append('</div>')
        if desc:
            parts.append('<p class="mod-desc">%s</p>' % desc)
        if detail and detail != desc:
            # 无链接条目里 AI 常写一句"未提供链接，仅作名称展示"的元信息话术，
            # 已有"仅名称"徽章表达，去掉这类空话，保留真正的点评内容。
            filler = ("素材未提供可用链接，仅作名称展示", "未提供可用链接", "仅作名称展示")
            if not url and any(f in detail for f in filler):
                detail = ""
            if detail:
                parts.append('<p class="mod-detail">%s</p>' % detail)
        parts.append("</article>")
    parts.append("</div>")
    return "".join(parts)


def folded_card(mod, d):
    """辅模块的折叠摘要卡：标题 + 一句话 + 跳兄弟页锚点。"""
    meta = MODULE_META[mod]
    if mod == "blog":
        title = d.get("title", "")
        brief = (d.get("summary") or "").strip()[:60]
        count = len(d.get("quotes") or [])
        sub = ("%d 条金句" % count) if count else "点击查看全文"
    elif mod == "nav":
        sites = (d.get("links") or {}).get("sites") or []
        title = "相关站点"
        brief = "、".join(x.get("name", "") for x in sites[:3] if isinstance(x, dict))
        sub = "%d 个站点" % len(sites)
    else:
        res = (d.get("links") or {}).get("resources") or []
        title = "相关资源"
        brief = "、".join(x.get("name", "") for x in res[:3] if isinstance(x, dict))
        sub = "%d 个资源" % len(res)
    brief = brief or "点击查看该模块的完整内容"
    # 兄弟页：合集页在 /<dir>/<slug>/ 下，回根需 ../../
    href = "../../%s/%s/index.html#%s" % (meta["dir"], d.get("slug", ""), meta["anchor"])
    return ('<a class="fold-card fold-%s" href="%s">'
            '<span class="fold-tag">%s · %s</span>'
            '<span class="fold-title">%s</span>'
            '<span class="fold-brief">%s</span>'
            '<span class="fold-more">%s →</span></a>') % (
        mod, B.esc(href), meta["n"], meta["label"],
        B.esc(title[:40]), B.esc(brief[:80]), B.esc(sub))


def module_switch(mod, d, all_mods, enabled_mods):
    """当前页顶部模块切换条：高亮主模块，其余可点到兄弟页。"""
    parts = ['<nav class="mod-switch">']
    for m in CANON_ORDER:
        if m not in enabled_mods:
            continue
        meta = MODULE_META[m]
        if m == mod:
            parts.append('<span class="ms-cur">%s %s</span>' % (meta["n"], meta["label"]))
        else:
            href = "../../%s/%s/index.html#%s" % (meta["dir"], d.get("slug", ""), meta["anchor"])
            parts.append('<a href="%s">%s %s</a>' % (B.esc(href), meta["n"], meta["label"]))
    parts.append("</nav>")
    return "".join(parts)


def tags_block(tags):
    """文章级标签 chip：三页共用同一组，属元信息不算正文重复。"""
    tags = [str(t).strip() for t in (tags or []) if str(t).strip()]
    if not tags:
        return ""
    parts = ['<div class="mod-tags">']
    for t in tags[:8]:
        parts.append('<span class="mod-tag">%s</span>' % B.esc(t))
    parts.append("</div>")
    return "".join(parts)


def module_hero(mod, d):
    """模块名片：模块专属标题（含条目数）+ 渲染器固定简介。"""
    meta = MODULE_META[mod]
    links = d.get("links") or {}
    count = 0
    if mod == "nav":
        count = len(links.get("sites") or [])
    elif mod == "resource":
        count = len(links.get("resources") or [])
    hero = meta["hero"]
    if mod in ("nav", "resource"):
        hero = "%s %d 个" % (hero, count) if count else hero
    return ('<div class="mod-hero"><h2 class="mod-hero-title">%s</h2>'
            '<p class="mod-hero-intro">%s</p></div>') % (B.esc(hero), B.esc(meta["intro"]))


def collection_body(mod, d, enabled_mods):
    """一个合集页的完整 body：模块 H1 + 文章副题/标签 + 模块切换 + 模块名片 + 主模块 + 辅模块折叠卡。"""
    meta = MODULE_META[mod]
    parts = []
    parts.append('<h1 class="page-title">%s</h1>' % B.esc(meta["h1"]))
    if d.get("title"):
        parts.append('<p class="page-article">本文：《%s》</p>' % B.esc(d["title"]))
    parts.append(tags_block(d.get("tags")))
    parts.append(module_switch(mod, d, enabled_mods, enabled_mods))
    parts.append('<section id="%s" class="mod-main mod-main-%s">' % (meta["anchor"], mod))
    parts.append(module_hero(mod, d))
    if mod == "blog":
        parts.append(body_block(d, summary_on=True))
    elif mod == "nav":
        parts.append(links_block((d.get("links") or {}).get("sites"), with_external=True))
        parts.append(comments_block((d.get("comments") or {}).get("site"), "站点短评"))
    else:
        parts.append(links_block((d.get("links") or {}).get("resources"), with_external=True))
        parts.append(comments_block((d.get("comments") or {}).get("resource"), "资源短评"))
    parts.append("</section>")

    others = [m for m in enabled_mods if m != mod]
    if others:
        parts.append('<section class="fold-grid"><h2>同一篇的其他内容</h2><div class="fold-row">')
        for m in others:
            parts.append(folded_card(m, d))
        parts.append("</div></section>")

    parts.append(B.card_modal("../../"))
    return "".join(parts)


# ---------------------------------------------------------------- 页面写入

def out_path(docs_dir, mod, slug):
    """合集页落点：文章页 posts/<slug>/index.html，导航/资源页 nav/<slug>/index.html ..."""
    meta = MODULE_META[mod]
    return os.path.join(docs_dir, meta["dir"], slug, "index.html")


def rel_prefix(mod):
    """合集页在 <dir>/<slug>/ 下，回到站点根的相对路径。"""
    return "../../"


def build_collection_pages(site, docs_dir, pages, enabled_mods, runtime):
    base_url = site.get("base_url", "")
    for d in pages:
        slug = d.get("slug", "")
        if not slug:
            continue
        for mod in enabled_mods:
            if mod not in MODULE_META:
                continue
            if mod == "nav" and not (d.get("links") or {}).get("sites"):
                # 没有站点条目时仍出页（显示空态），保证兄弟页链接不 404
                pass
            body = collection_body(mod, d, enabled_mods)
            meta = MODULE_META[mod]
            html = B.page_shell(
                site, rel_prefix(mod),
                "%s · %s · %s" % (meta["h1"], d.get("title", ""), site.get("name", "")),
                ("%s：%s" % (meta["h1"], d.get("summary") or d.get("title") or ""))[:120],
                body, author=d.get("author", ""))
            B.write(out_path(docs_dir, mod, slug), html)


def aggregate_body(kind, pages, site_name):
    """聚合页：跨文章汇总，条目指回对应合集页。"""
    mod = {"nav": "nav", "resource": "resource", "blog": "blog"}[kind]
    meta = MODULE_META[mod]
    parts = ['<h1 class="page-title">%s</h1>' % {
        "blog": "全部文章", "nav": "站点导航索引", "resource": "资源下载索引"}[kind]]
    parts.append('<p class="page-meta">按篇汇总，点条目进入合集页查看完整内容。</p>')
    for d in pages:
        slug = d.get("slug", "")
        # 聚合页位于 /<kind>/index.html；blog 聚合指向 /posts/，需跨目录
        if kind == "blog":
            href = "../%s/%s/index.html" % (meta["dir"], slug)
        else:
            href = "%s/index.html" % slug
        if kind == "blog":
            lines = d.get("quotes") or []
            brief = lines[0] if lines else (d.get("summary") or "")[:80]
        elif kind == "nav":
            sites = (d.get("links") or {}).get("sites") or []
            brief = "、".join(x.get("name", "") for x in sites[:4] if isinstance(x, dict))
        else:
            res = (d.get("links") or {}).get("resources") or []
            brief = "、".join(x.get("name", "") for x in res[:4] if isinstance(x, dict))
        parts.append('<article class="agg-item">'
                     '<h2><a href="%s">%s</a></h2>'
                     '<p class="page-meta">%s</p></article>' % (
                         B.esc(href), B.esc(d.get("title", "")), B.esc(brief[:120])))
    if not pages:
        parts.append('<p class="page-meta">还没有内容，等第一次自动更新。</p>')
    return "".join(parts)


def build_aggregates(site, docs_dir, pages, enabled_mods):
    for kind in ("blog", "nav", "resource"):
        if kind not in enabled_mods:
            continue
        body = aggregate_body(kind, pages, site.get("name", ""))
        # 聚合页在 /<kind>/ 下，静态资源与 feed/search 在根，rel 用 ../
        html = B.page_shell(site, "../", "%s · %s" % (
            {"blog": "全部文章", "nav": "站点导航", "resource": "资源下载"}[kind], site.get("name", "")),
            site.get("description", ""), body)
        B.write(os.path.join(docs_dir, kind, "index.html"), html)


def build_home(site, docs_dir, pages, enabled_mods):
    """首页：入口目录，指向各聚合页与最新合集页。"""
    parts = ['<h1 class="page-title">%s</h1>' % B.esc(site.get("name", ""))]
    if site.get("tagline"):
        parts.append('<p class="page-meta">%s</p>' % B.esc(site["tagline"]))
    parts.append('<nav class="home-mods">')
    for m in CANON_ORDER:
        if m not in enabled_mods:
            continue
        meta = MODULE_META[m]
        parts.append('<a class="home-mod" href="%s/index.html">%s</a>' % (m, meta["label"]))
    parts.append("</nav>")
    latest = pages[-6:][::-1]
    if latest:
        parts.append('<section class="home-latest"><h2>最近更新</h2>')
        for d in latest:
            parts.append('<article class="agg-item"><h3><a href="posts/%s/index.html">%s</a></h3>'
                         '<p class="page-meta">%s</p></article>' % (
                             B.esc(d.get("slug", "")), B.esc(d.get("title", "")),
                             B.esc((d.get("summary") or "")[:100])))
        parts.append("</section>")
    B.write(os.path.join(docs_dir, "index.html"),
            B.page_shell(site, "", site.get("name", ""), site.get("description", ""),
                         "".join(parts)))


def _abs(base, path):
    return (base.rstrip("/") + "/" + path.lstrip("/")) if base else path


def build_feed(site, docs_dir, pages, base_url, enabled):
    """RSS 指向每篇的文章合集页（正文主）。"""
    import datetime
    import email.utils

    def pubdate(d):
        try:
            return email.utils.format_datetime(
                datetime.datetime.strptime(d, "%Y-%m-%d").replace(
                    tzinfo=datetime.timezone(datetime.timedelta(hours=8))))
        except Exception:
            return ""

    items = []
    for d in reversed(pages[-20:]):
        link = _abs(base_url, "posts/%s/index.html" % d.get("slug", ""))
        desc = (d.get("summary") or d.get("title") or "")[:300]
        items.append(
            "<item><title>%s</title><link>%s</link><guid>%s</guid>%s<description>%s</description></item>"
            % (B.esc(d.get("title", "")), B.esc(link), B.esc(link),
               ("<pubDate>%s</pubDate>" % pubdate(d.get("date", ""))) if d.get("date") else "",
               B.esc(desc)))
    xml = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>%s</title><link>%s</link><description>%s</description><language>zh-CN</language>
<lastBuildDate>%s</lastBuildDate>
%s
</channel></rss>
""" % (B.esc(site.get("name", "")), B.esc(base_url or ""),
       B.esc(site.get("tagline", "")),
       email.utils.format_datetime(datetime.datetime.now(
           datetime.timezone(datetime.timedelta(hours=8)))), "\n".join(items))
    B.write(os.path.join(docs_dir, "feed.xml"), xml)


def build_sitemap(site, docs_dir, pages, base_url, enabled):
    """sitemap 收录：首页/聚合页 + 每篇的 3 个合集页。"""
    import datetime
    today = datetime.date.today().isoformat()
    locs = ["index.html", "search.html"]
    for kind in enabled:
        locs.append("%s/index.html" % kind)
    for d in pages:
        slug = d.get("slug", "")
        for mod in enabled:
            locs.append("%s/%s/index.html" % (MODULE_META[mod]["dir"], slug))
    rows = ["<url><loc>%s</loc><lastmod>%s</lastmod></url>" % (
        B.esc(_abs(base_url, u)), today) for u in locs]
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n%s\n</urlset>\n') % "\n".join(rows)
    B.write(os.path.join(docs_dir, "sitemap.xml"), xml)


def build(site, docs_dir, base_url="", runtime=None):
    runtime = runtime or {}
    comp = runtime.get("composition") or {}
    enabled = [m for m in (comp.get("modules") or ["blog", "nav", "resource"]) if m in MODULE_META]
    if "blog" not in enabled:
        enabled.insert(0, "blog")

    pages = load_data_pages(docs_dir)

    # 清理旧论坛结构留下的 html（md 保留作挖题源，data.json 是产物源）
    for fn in os.listdir(docs_dir):
        if fn.endswith(".html") and fn not in ("index.html", "search.html"):
            os.remove(os.path.join(docs_dir, fn))
    pdir = os.path.join(docs_dir, POSTS_DIRNAME)
    if os.path.isdir(pdir):
        for fn in os.listdir(pdir):
            if fn.endswith(".html"):
                os.remove(os.path.join(pdir, fn))
    # 清理已删除文章残留的合集页目录（/<dir>/<slug>/index.html）
    valid_slugs = {d.get("slug") for d in pages}
    for mod in MODULE_META.values():
        mdir = os.path.join(docs_dir, mod["dir"])
        if not os.path.isdir(mdir):
            continue
        for name in os.listdir(mdir):
            full = os.path.join(mdir, name)
            if os.path.isdir(full) and name not in valid_slugs:
                for f in os.listdir(full):
                    os.remove(os.path.join(full, f))
                os.rmdir(full)

    build_collection_pages(site, docs_dir, pages, enabled, runtime)
    build_aggregates(site, docs_dir, pages, enabled)
    build_home(site, docs_dir, pages, enabled)

    # 搜索页走通用构建（读 md）；feed/sitemap 用合集页的真实 URL 结构
    md_pages = B.load_pages(docs_dir)
    slugs = [p["slug"] for p in md_pages]
    B.build_search(site, md_pages, docs_dir, slugs)
    base = base_url or site.get("base_url", "")
    build_feed(site, docs_dir, pages, base, enabled)
    build_sitemap(site, docs_dir, pages, base, enabled)

    # 看图功能：复制 CARD_JS（合集页的 card_modal 用到）
    B.write(os.path.join(docs_dir, "assets", "cards.js"), B.CARD_JS)

    stat = {
        "pages": len(pages) * len(enabled),
        "articles": len(pages),
        "floors": sum(len((d.get("comments") or {}).get(k, []))
                      for d in pages for k in ("body", "site", "resource")),
        "words": sum(int(d.get("words") or 0) for d in pages),
    }
    log("渲染完成：%d 篇 × %d 模块 = %d 合集页 + %d 聚合页" % (
        len(pages), len(enabled), stat["pages"], len(enabled)))
    return stat
