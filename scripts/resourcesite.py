"""资源分享主题渲染器（themes/resource.json → renderer: resourcesite.py）

复用 blogsite 的全部基础设施，只把正文渲染成「资源条目」卡片列表
（每条含名称 / 链接 / 简介 / 适合谁 / 缺点），并把广告插在条目之间
（主题 slots.ads.position=between_items）。

对外契约与 blogsite.build 一致：build(site, docs_dir, base_url, runtime=None) -> stat。
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blogsite as base  # noqa: E402

esc = base.esc
md_to_html = base.md_to_html
write = base.write
page_shell = base.page_shell
board_intro = base.board_intro
pager_html = base.pager_html
card_modal = base.card_modal
floor_html = base.floor_html
header_html = base.header_html
build_search = base.build_search
build_feed = base.build_feed
build_sitemap = base.build_sitemap
load_pages = base.load_pages
load_ads = base.load_ads
pick_ads = base.pick_ads

CARD_JS = base.CARD_JS

# 资源专属样式，走同源 CSS 变量自动适配暗色主题
RES_STYLE = """<style>
.res-list{display:grid; gap:16px; margin:18px 0}
.res-item{border:1px solid var(--line); border-radius:10px; background:var(--card); padding:18px 20px}
.res-item>h2{margin:0 0 10px; font-size:18px; line-height:1.5}
.res-item>h2:before{content:"▸ "; color:var(--accent)}
.res-item .prose{margin:0}
.res-lead{margin:6px 0 4px}
.res-ad{border:1px dashed var(--line); border-radius:10px; padding:12px 16px; background:var(--card)}
.res-ad .fhead{margin-bottom:4px}
.comments{margin-top:26px; padding-top:14px; border-top:1px solid var(--line)}
.comments>h2{margin:0 0 8px; font-size:15px; color:var(--muted); font-weight:400}
</style>"""

# ------------------------------------------------------------------ 解析

def split_sections(main):
    """把正文拆成 (导语, [(资源名, 资源正文), ...])"""
    parts = re.split(r"(?m)^##\s+(.+?)\s*$", main)
    intro = parts[0].strip()
    items = []
    for i in range(1, len(parts), 2):
        items.append({
            "title": parts[i].strip(),
            "body": (parts[i + 1].strip() if i + 1 < len(parts) else ""),
        })
    return intro, items


def item_html(item):
    """一个资源条目：名称小标题 + markdown 正文（含链接/简介/适合谁/缺点）"""
    return ('<article class="res-item"><h2>%s</h2><div class="prose">%s</div></article>') % (
        esc(item["title"]), md_to_html(item["body"]))


def ad_item_html(ad, rel=""):
    """广告伪装成虚拟用户的一条推荐，插在资源条目之间"""
    return ('<div class="res-ad">%s</div>') % floor_html(ad, rel=rel)


def interleave(items, picked, rel=""):
    """把广告均匀插进条目列表（between_items），位置由页码哈希决定、构建可复现。"""
    if not picked:
        return "".join(item_html(it) for it in items)
    out = []
    total = len(items) + len(picked)
    gap = max(1, total // (len(picked) + 1))
    # 先算出每个广告插入点（按条目索引），与 blogsite.merge_extra_floors 同思路
    insert_at = {}
    for i in range(len(picked)):
        pos = min(len(items), gap * (i + 1))
        insert_at.setdefault(pos, []).append(i)
    chunks = []
    for idx in range(len(items) + 1):
        for ai in insert_at.get(idx, []):
            chunks.append(ad_item_html(picked[ai], rel))
        if idx < len(items):
            chunks.append(item_html(items[idx]))
    return "".join(chunks)


# ------------------------------------------------------------------ 清理

def cleanup(docs_dir, slugs):
    for junk in ("archive.html",):
        fp = os.path.join(docs_dir, junk)
        if os.path.exists(fp):
            os.remove(fp)
    for d in ("page", "tags"):
        dp = os.path.join(docs_dir, d)
        if os.path.isdir(dp):
            for f in os.listdir(dp):
                if f.endswith(".html") or f == "index.json":
                    os.remove(os.path.join(dp, f))
            try:
                os.rmdir(dp)
            except OSError:
                pass
    pdir = os.path.join(docs_dir, "posts")
    if os.path.isdir(pdir):
        keep = set(slugs[1:])
        for f in os.listdir(pdir):
            if f.endswith(".html") and f[:-5] not in keep:
                os.remove(os.path.join(pdir, f))


# ------------------------------------------------------------------ 构建

def build(site, docs_dir, base_url="", runtime=None):
    pages = load_pages(docs_dir)
    slugs = [p["slug"] for p in pages]
    cleanup(docs_dir, slugs)
    ads = load_ads()
    total = max(1, len(pages))

    if not pages:
        body = RES_STYLE + board_intro(docs_dir, "")
        body += '<h1 class="page-title">还没有内容</h1>'
        body += '<div class="page-meta">等第一次自动更新，或者手动跑一次 workflow。</div>'
        write(os.path.join(docs_dir, "index.html"),
              page_shell(site, "", site.get("name") or "", site.get("description") or "", body))
        write(os.path.join(docs_dir, "assets", "cards.js"), CARD_JS)
        return {"pages": 0, "floors": 0, "words": 0}

    for i, p in enumerate(pages):
        cur = i + 1
        rel = "" if cur == 1 else "../"
        out = os.path.join(docs_dir, "index.html") if cur == 1 else \
            os.path.join(docs_dir, "posts", p["slug"] + ".html")

        intro, items = split_sections(p["main"])
        body = RES_STYLE + board_intro(docs_dir, rel)
        body += header_html(p, runtime)
        if intro:
            body += '<div class="prose res-lead">%s</div>' % md_to_html(intro)

        # 广告：主题 slots.ads.position=between_items → 均匀插进资源条目之间。
        position = (ads.get("position") or "between_items").strip()
        if position in ("between_items", "between_floors", "recommend_block") and \
                ads.get("per_page", 0) > 0 and ads.get("items"):
            picked = pick_ads(ads, p["slug"], p["floors"])
        else:
            picked = []
        if items or picked:
            body += '<div class="res-list">%s</div>' % interleave(items, picked, rel)
        # 兼容 after_content / comments：追加到末尾
        if position in ("after_content", "comments") and \
                ads.get("per_page", 0) > 0 and ads.get("items"):
            for ad in pick_ads(ads, p["slug"], p["floors"]):
                body += ad_item_html(ad, rel)

        # 文末虚拟用户短评
        if p["floors"]:
            body += '<section class="comments"><h2>网友短评</h2>'
            for f in p["floors"]:
                body += floor_html(f, rel=rel)
            body += '</section>'

        body += pager_html(cur, total, rel, slugs)
        body += card_modal(rel)

        write(out, page_shell(
            site, rel,
            "%s · %s" % (p["title"], site.get("name") or ""),
            (p["main"][:80] + "…") if len(p["main"]) > 80 else p["main"],
            body,
            author=p.get("author", ""),
        ))

    write(os.path.join(docs_dir, "assets", "cards.js"), CARD_JS)
    build_search(site, pages, docs_dir, slugs)
    build_feed(site, pages, docs_dir, base_url, slugs)
    build_sitemap(site, pages, docs_dir, base_url, slugs)

    return {
        "pages": len(pages),
        "floors": sum(len(split_sections(p["main"])[1]) + len(p["floors"]) for p in pages),
        "words": sum(p["words"] for p in pages),
    }
