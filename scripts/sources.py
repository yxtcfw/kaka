#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
多源热点采集：RSS / Atom / JSON 接口 / 列表页 HTML
纯标准库，返回统一的 item 结构：
{"title","url","summary","source","ts"(datetime|None)}
"""

import datetime
import email.utils
import gzip
import html
import json
import re
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

BJT = datetime.timezone(datetime.timedelta(hours=8))

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")

TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")


def clean(s, limit=None):
    if not s:
        return ""
    s = TAG_RE.sub(" ", str(s))
    s = html.unescape(s)
    s = WS_RE.sub(" ", s).strip()
    if limit:
        s = s[:limit]
    return s


def fetch_bytes(url, timeout=25):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "*/*",
        "Accept-Encoding": "identity",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        if raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        return raw


def fetch_text(url, timeout=25):
    raw = fetch_bytes(url, timeout)
    for enc in ("utf-8", "gb18030", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


# ------------------------------------------------------------------ 时间

def parse_time(v):
    if not v:
        return None
    if isinstance(v, (int, float)):
        try:
            return datetime.datetime.fromtimestamp(float(v), BJT)
        except Exception:
            return None
    s = str(v).strip()
    # 纯数字时间戳
    if s.isdigit() and len(s) in (10, 13):
        ts = int(s) / (1000 if len(s) == 13 else 1)
        return datetime.datetime.fromtimestamp(ts, BJT)
    # ISO 8601
    try:
        iso = s.replace("Z", "+00:00")
        dt = datetime.datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=BJT)
        return dt.astimezone(BJT)
    except Exception:
        pass
    # RFC 822 (RSS pubDate)
    try:
        dt = email.utils.parsedate_to_datetime(s)
        if dt and dt.tzinfo is None:
            dt = dt.replace(tzinfo=datetime.timezone.utc)
        return dt.astimezone(BJT) if dt else None
    except Exception:
        return None


# ------------------------------------------------------------------ RSS / Atom

def _local(tag):
    return tag.rsplit("}", 1)[-1]


def _text(node, names):
    for ch in node:
        if _local(ch.tag) in names and (ch.text or "").strip():
            return (ch.text or "").strip()
    return ""


def parse_feed(data, source):
    items = []
    try:
        root = ET.fromstring(data)
    except Exception:
        # 有些源前面有 BOM/空白/多余内容
        try:
            start = data.find(b"<")
            root = ET.fromstring(data[start:])
        except Exception:
            return items

    for node in root.iter():
        if _local(node.tag) not in ("item", "entry"):
            continue

        title = clean(_text(node, ("title",)))
        if not title:
            continue

        url = ""
        # Atom: <link rel="alternate" href="...">
        for ch in node:
            if _local(ch.tag) == "link":
                href = ch.get("href")
                rel = ch.get("rel", "alternate")
                if href and rel in ("alternate", ""):
                    url = href
                    break
                if href and not url:
                    url = href
        if not url:
            url = clean(_text(node, ("link",)))

        summary = clean(_text(node, ("description", "summary", "content")), 400)
        ts = parse_time(_text(node, ("pubDate", "published", "updated", "date")))

        items.append({
            "title": title,
            "url": url,
            "summary": summary,
            "source": source,
            "ts": ts,
        })
    return items


# ------------------------------------------------------------------ JSON 接口

def _dig(obj, path):
    cur = obj
    for part in path.split("."):
        if not part:
            continue
        if isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except Exception:
                return None
        elif isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return None
    return cur


def parse_json_api(text, cfg):
    data = json.loads(text)
    rows = _dig(data, cfg.get("items_path", "")) or []
    if not isinstance(rows, list):
        return []

    fields = cfg.get("fields", {})
    tpl = cfg.get("url_template", "")
    id_field = cfg.get("id_field", "id")

    out = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        title = clean(_dig(row, fields.get("title", "title")) or "")
        if not title:
            continue
        url = ""
        if fields.get("url"):
            url = _dig(row, fields["url"]) or ""
        if not url and tpl:
            url = tpl.replace("{" + id_field + "}", str(row.get(id_field, "")))
        out.append({
            "title": title,
            "url": url or cfg.get("url", ""),
            "summary": clean(_dig(row, fields.get("summary", "summary")) or "", 400),
            "source": cfg.get("name", "json"),
            "ts": parse_time(_dig(row, fields.get("date", "date"))),
        })
    return out


# ------------------------------------------------------------------ 列表页 HTML

A_RE = re.compile(r'<a\s[^>]*href="([^"]+)"[^>]*>(.*?)</a>', re.I | re.S)
NAV_WORDS = ("登录", "注册", "首页", "更多", "下载", "关于", "联系", "返回",
             "上一页", "下一页", "隐私", "协议", "广告", "投稿", "RSS")


def parse_html_list(text, cfg):
    base = cfg.get("base", "")
    must_include = cfg.get("must_include", "")
    out, seen = [], set()

    for href, inner in A_RE.findall(text):
        title = clean(inner)
        if not (8 <= len(title) <= 60):
            continue
        if any(w in title for w in NAV_WORDS):
            continue
        if must_include and must_include not in href:
            continue
        url = urllib.request.urljoin(base or cfg.get("url", ""), href)
        if url in seen:
            continue
        seen.add(url)
        out.append({
            "title": title,
            "url": url,
            "summary": "",
            "source": cfg.get("name", "html"),
            "ts": None,
        })
        if len(out) >= int(cfg.get("limit", 30)):
            break
    return out


# ------------------------------------------------------------------ 主入口

def collect_one(cfg, timeout=25):
    """抓单个源，失败返回空列表，不抛异常"""
    name = cfg.get("name", cfg.get("url", "?"))
    kind = cfg.get("type", "rss")
    try:
        if kind in ("rss", "atom", "feed"):
            return parse_feed(fetch_bytes(cfg["url"], timeout), name)
        if kind == "json":
            return parse_json_api(fetch_text(cfg["url"], timeout), cfg)
        if kind == "html":
            return parse_html_list(fetch_text(cfg["url"], timeout), cfg)
        return []
    except urllib.error.HTTPError as e:
        print("[collect] %s HTTP %s" % (name, e.code), flush=True)
    except Exception as e:
        print("[collect] %s 失败: %r" % (name, e), flush=True)
    return []


def norm_title(t):
    t = re.sub(r"[\s\u3000]+", "", t or "")
    t = re.sub(r"[，。！？、：；“”‘’（）()《》\-—…,.!?:;\"'|/\\\[\]]", "", t)
    return t.lower()


def collect(sources, window_hours=48, timeout=25):
    """抓全部源 → 时间窗过滤 → 标题/URL 去重 → 按时间倒序"""
    now = datetime.datetime.now(BJT)
    horizon = now - datetime.timedelta(hours=float(window_hours))

    all_items, seen_title, seen_url = [], set(), set()
    for cfg in sources:
        if cfg.get("enabled", True) is False:
            continue
        got = collect_one(cfg, timeout)
        kept = 0
        for it in got:
            if it["ts"] and it["ts"] < horizon:
                continue
            nt = norm_title(it["title"])
            if not nt or nt in seen_title:
                continue
            if it["url"] and it["url"] in seen_url:
                continue
            seen_title.add(nt)
            if it["url"]:
                seen_url.add(it["url"])
            it["weight"] = float(cfg.get("weight", 1.0))
            all_items.append(it)
            kept += 1
        print("[collect] %-12s 抓到 %3d，入库 %3d" % (name_of(cfg), len(got), kept), flush=True)

    all_items.sort(key=lambda x: (x["ts"] or horizon), reverse=True)
    return all_items


def name_of(cfg):
    return str(cfg.get("name", "?"))[:12]
