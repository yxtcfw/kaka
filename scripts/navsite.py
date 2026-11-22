"""网址导航主题渲染器（themes/nav.json → renderer: navsite.py）

复用 blogsite 的全部基础设施（Markdown 渲染 / 广告分派 / 暗色主题脚本 /
搜索 / RSS / sitemap / 形象图弹窗），只把正文渲染成「分类 + 链接条目」卡片列表，
并把广告放进主题 slots.ads.position=recommend_block 指定的「推荐区块」。

对外契约与 blogsite.build 一致：build(site, docs_dir, base_url, runtime=None) -> stat。
build_dispatch 会动态加载本模块；缺失或异常时才回退内置论坛渲染器。
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blogsite as base  # noqa: E402

# 直接复用 blogsite 的基础设施，避免重复实现
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

# 导航专属样式，走同源 CSS 变量，自动适配暗色主题；只作用于本主题生成的页面
NAV_STYLE = """<style>
.nav-list{display:grid; gap:14px; margin:18px 0}
.nav-group{border:1px solid var(--line); border-radius:10px; background:var(--card); padding:16px 18px}
.nav-group h2{margin:0 0 10px; font-size:17px; line-height:1.5}
.nav-group h2:before{content:"# "; color:var(--muted); font-weight:400}
.nav-group .prose{margin:0}
.nav-lead{margin:6px 0 4px}
.recommend{border:1px dashed var(--line); border-radius:10px; padding:12px 16px; margin:20px 0; background:var(--card)}
.recommend>h2{margin:0 0 6px; font-size:14px; color:var(--muted); font-weight:400}
.comments{margin-top:26px; padding-top:14px; border-top:1px solid var(--line)}
.comments>h2{margin:0 0 8px; font-size:15px; color:var(--muted); font-weight:400}
</style>"""

# ------------------------------------------------------------------ 解析

def split_sections(main):
    """把正文拆成 (导语, [(分类名, 条目正文), ...])。

    导航主题里 `## 分类名` 是分组标题（不是 `@昵称` 楼层），
    blogsite.parse_page 已把它们留在 main、把文末 `## @昵称` 短评拆进 floors。
    """
    parts = re.split(r"(?m)^##\s+(.+?)\s*$", main)
    intro = parts[0].strip()
    items = []
    for i in range(1, len(parts), 2):
        items.append({
            "title": parts[i].strip(),
            "body": (parts[i + 1].strip() if i + 1 < len(parts) else ""),
        })
    return intro, items


def group_html(item):
    """一个分类：标题 + markdown 链接列表"""
    return ('<section class="nav-group"><h2>%s</h2><div class="prose">%s</div></section>') % (
        esc(item["title"]), md_to_html(item["body"]))


# ------------------------------------------------------------------ 清理

def cleanup(docs_dir, slugs):
    """清掉旧结构/已删 md 对应的 html，避免从别的主题切过来时残留"""
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
        body = NAV_STYLE + board_intro(docs_dir, "")
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
        body = NAV_STYLE + board_intro(docs_dir, rel)
        body += header_html(p, runtime)
        if intro:
            body += '<div class="prose nav-lead">%s</div>' % md_to_html(intro)
        if items:
            body += '<div class="nav-list">'
            for it in items:
                body += group_html(it)
            body += '</div>'

        # 广告：按主题 slots.ads.position=recommend_block 放进独立推荐区块。
        # 若站点换成别的主题但误用了本渲染器，也兼容 after_content/comments 的追加语义。
        position = (ads.get("position") or "recommend_block").strip()
        if position in ("recommend_block", "after_content", "comments") and \
                ads.get("per_page", 0) > 0 and ads.get("items"):
            picked = pick_ads(ads, p["slug"], p["floors"])
            if picked:
                body += '<section class="recommend"><h2>大家还在看</h2>'
                for ad in picked:
                    body += floor_html(ad, rel=rel)
                body += '</section>'

        # 文末虚拟用户短评（评论区）
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
