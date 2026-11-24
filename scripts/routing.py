#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""统一路由层：所有页面路径、相对路径、canonical、面包屑只在这里计算。

设计目的：URL 层级（flat / topic / hybrid）由配置驱动，渲染器与模板不再手写
../../ 或拼 URL，改 URL 结构只需改本文件，调用点自动跟随。

url_style:
  flat   - posts/<slug>/index.html（当前线上形态，零迁移）
  topic  - posts/<node_path>/<slug>/index.html（树节点语义目录）
  hybrid - 有 node_path 的走 topic，没有的（老文章）保持 flat
"""

import json
import os

DEFAULT_DIRS = {"blog": "posts", "nav": "nav", "resource": "resource"}
VALID_STYLES = ("flat", "topic", "hybrid")


def log(*a):
    print("[routing]", *a, flush=True)


def _load_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def load_node_paths(config_dir):
    """从 config/tree.json 读 id -> path 映射，供 hybrid 判定文章归属。"""
    data = _load_json(os.path.join(config_dir, "tree.json"), {}) or {}
    out = {}
    for n in data.get("nodes") or []:
        if not isinstance(n, dict):
            continue
        nid, path = str(n.get("id") or "").strip(), str(n.get("path") or "").strip()
        if nid and path:
            out[nid] = path
    return out


def _safe_path(value):
    """URL 片段：只留安全字符，防止路径穿越与中文编码问题。"""
    s = str(value or "").strip().strip("/")
    out = []
    for part in s.split("/"):
        clean = "".join(ch for ch in part if ch.isalnum() or ch in "-_")
        if clean:
            out.append(clean)
    return "/".join(out[:4])


class Routes:
    """一次构建，整站复用。dirs 可由 composition 覆盖模块目录。"""

    def __init__(self, site=None, config_dir=None, dirs=None, style=None):
        site = site or {}
        self.base_url = str(site.get("base_url") or "").rstrip("/")
        self.site_name = str(site.get("name") or "")
        self.dirs = dict(DEFAULT_DIRS)
        for k, v in (dirs or {}).items():
            if k in DEFAULT_DIRS and v:
                self.dirs[k] = str(v).strip("/")
        want = str(style or site.get("url_style") or "flat").strip().lower()
        self.style = want if want in VALID_STYLES else "flat"
        self.node_paths = load_node_paths(config_dir) if config_dir else {}

    def _topic_seg(self, d):
        """文章是否走语义目录：直接 path 字段优先，其次按 node_id 查树。"""
        if self.style == "flat":
            return ""
        d = d or {}
        path = _safe_path(d.get("path") or "")
        if not path:
            nid = str(d.get("node_id") or d.get("tree_node") or "").strip()
            path = _safe_path(self.node_paths.get(nid, ""))
        if not path:
            return ""
        if self.style == "topic" or (self.style == "hybrid" and path):
            return path
        return ""

    def segments(self, d, mod):
        """页面在站点根下的路径片段，如 ['posts', 'apply-flow', '006']。"""
        out = [self.dirs.get(mod, mod)]
        topic = self._topic_seg(d)
        if topic:
            out.append(topic)
        out.append(str((d or {}).get("slug") or ""))
        return [x for x in out if x]

    def rel_root(self, d, mod):
        """当前页回到站点根的相对路径，如 '../../' / '../../../'。"""
        return "../" * len(self.segments(d, mod))

    def out(self, docs_dir, d, mod):
        """合集页物理落点。"""
        return os.path.join(docs_dir, *self.segments(d, mod), "index.html")

    def web(self, d, mod):
        """站点根相对 URL，如 posts/006/index.html。"""
        return "/".join(self.segments(d, mod)) + "/index.html"

    def abs_url(self, d, mod):
        """canonical / feed / sitemap 用的绝对 URL。"""
        path = self.web(d, mod)
        return (self.base_url + "/" + path) if self.base_url else path

    def sibling(self, d, from_mod, to_mod, anchor=""):
        """兄弟合集页链接（带模块锚点）。"""
        href = self.rel_root(d, from_mod) + "/".join(self.segments(d, to_mod)) + "/index.html"
        return href + ("#" + anchor if anchor else "")

    def from_aggregate(self, d, kind, mod):
        """聚合页 /<kind>/index.html 指向合集页的链接。"""
        prefix = "" if kind == self.dirs.get(mod, mod) else "../"
        return prefix + "/".join(self.segments(d, mod)) + "/index.html"

    def from_home(self, d, mod):
        """首页（站点根）指向合集页的链接。"""
        return self.web(d, mod)

    def breadcrumb(self, d, mod, title=""):
        """面包屑数据：首页 -> 模块聚合 -> 文章。模板可自行渲染。"""
        topic = self._topic_seg(d)
        rows = [{"title": self.site_name or "首页", "url": "index.html"}]
        if not topic:
            rows.append({"title": "全部文章" if mod == "blog" else mod,
                         "url": mod + "/index.html"})
        if title:
            rows.append({"title": title, "url": ""})
        return rows

    def article_dir(self, mod):
        """模块的文章根目录（聚合页所在目录）。"""
        return self.dirs.get(mod, mod)

    def cleanup(self, docs_dir, valid_slugs):
        """清理已删除文章的合集页目录，兼容 flat 与 topic 两种落点。"""
        removed = 0
        for mod, mdir_name in self.dirs.items():
            mdir = os.path.join(docs_dir, mdir_name)
            if not os.path.isdir(mdir):
                continue
            for name in os.listdir(mdir):
                full = os.path.join(mdir, name)
                if not os.path.isdir(full):
                    continue
                if name in valid_slugs:  # flat: <dir>/<slug>/
                    continue
                # topic: <dir>/<path>/<slug>/，只清第二层，保留分组目录
                nested = [x for x in os.listdir(full)
                          if os.path.isdir(os.path.join(full, x))]
                if nested:
                    for sub in nested:
                        subfull = os.path.join(full, sub)
                        if sub in valid_slugs:
                            continue
                        for f in os.listdir(subfull):
                            os.remove(os.path.join(subfull, f))
                        os.rmdir(subfull)
                        removed += 1
                    continue
                for f in os.listdir(full):
                    os.remove(os.path.join(full, f))
                os.rmdir(full)
                removed += 1
        return removed
