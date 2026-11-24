#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
每日自动连载 pipeline（论坛式，一页多楼层）

  1. 挖题：从历史页面的评论段落里挑一条（无主笔=讨论楼层 / 有主笔=短评）
  2. 取材：按关键词从 config/sources.json 的信源抓最近内容
  3. 写作：模型带着素材，写「主楼长文 + 若干楼层」，输出楼层结构的 markdown
  4. 落盘：写成 docs/posts/00N.md，追加到 .topics.json
  5. 建站：交给 blogsite.build 重新生成整站

  结尾不再留续问钩子：话题全部来自已写过的真实评论，不会为了"下一页"硬抛问题。

用法：
  python scripts/generate.py               # 挖题 → 取材 → 写作 → 建站
  python scripts/generate.py --probe       # 只测采集源
  python scripts/generate.py --rebuild     # 只重建整站
  python scripts/generate.py -k 某个主题    # 指定主题，跳过挖题
  python scripts/generate.py --force       # 今天写过也再写一页
"""

import argparse
import datetime
import hashlib
import random
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sources as src        # noqa: E402
import mine                  # noqa: E402
import tree as treeutil      # noqa: E402  内容树：gate 准入 / 状态流转 / prune
import blogsite as sitebuilder  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")
POSTS = os.path.join(DOCS, "posts")
CONFIG = os.path.join(ROOT, "config")
HISTORY = os.path.join(DOCS, ".topics.json")
GENERATED = os.path.join(CONFIG, "generated.json")

# 单次 AI 请求的计数器，writeback 会读取
AI_CALLS = 0

BJT = datetime.timezone(datetime.timedelta(hours=8))
API_URL = "https://openrouter.ai/api/v1/chat/completions"


def log(*a):
    print("[daily]", *a, flush=True)


# ---------------------------------------------------------------- 配置

def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def load_text(path, default=""):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip() or default
    except Exception:
        return default


def load_site():
    site = load_json(os.path.join(CONFIG, "site.json"), {})
    site.setdefault("name", "每日一篇")
    site.setdefault("tagline", "")
    site.setdefault("description", "")
    site.setdefault("author", "")
    site.setdefault("footer", "由 GitHub Actions 每天自动生成")
    site.setdefault("lang", "zh-CN")
    site.setdefault("base_url", "")
    site.setdefault("notice", "")             # 站点公告：渲染在顶栏下方，可留空
    site.setdefault("main_url", "https://yxtcfw.cn")  # 顶栏「主站 ↗」入口
    for k, env in (("name", "SITE_NAME"), ("tagline", "SITE_TAGLINE"), ("author", "SITE_AUTHOR"),
                   ("description", "SITE_DESCRIPTION"), ("footer", "SITE_FOOTER"),
                   ("notice", "SITE_NOTICE"), ("main_url", "SITE_MAIN_URL")):
        if os.environ.get(env):
            site[k] = os.environ[env]

    site["base_url"] = (os.environ.get("SITE_BASE_URL") or site["base_url"]).strip().rstrip("/")
    if not site["base_url"]:
        repo = os.environ.get("GITHUB_REPOSITORY", "")
        if "/" in repo:
            owner, name = repo.split("/", 1)
            site["base_url"] = ("https://%s.github.io" % owner) if name == owner + ".github.io" \
                else ("https://%s.github.io/%s" % (owner, name))
    return site


def _tokens_css(tokens):
    """把 manifest.tokens 渲染成 CSS 变量覆盖层；tokens.css 在 style.css 之后加载。"""
    if not isinstance(tokens, dict):
        return ""
    lines = ["/* 由 templates/<id>/manifest.json tokens 生成，勿手改 */"]
    groups = [(":root", tokens.get("light") or {})]
    dark = tokens.get("dark") or {}
    if dark:
        groups.append(('html[data-theme="dark"]', dark))
        groups.append(('@media (prefers-color-scheme: dark) {\n  html:not([data-theme])', dark))
    blocks = []
    for selector, values in groups:
        body = "\n".join("  --%s: %s;" % (k, v) for k, v in values.items()
                         if isinstance(v, str) and re.fullmatch(r"#[0-9a-fA-F]{3,8}|[a-zA-Z]+|\d+px", v))
        if not body:
            continue
        if selector.startswith("@media"):
            blocks.append("%s {\n%s\n  }\n}" % (selector, body))
        else:
            blocks.append("%s {\n%s\n}" % (selector, body))
    return "\n\n".join(blocks) + "\n" if blocks else ""


def apply_template(site):
    """按 site.json.template 物化 style.css、tokens.css 到 docs/。

    style.css 提供结构与兜底变量，tokens.css 只覆盖颜色，两者解耦：
    换配色只需改 manifest.tokens，不必改整份 CSS。
    """
    tid = re.sub(r"[^A-Za-z0-9_-]", "", str(site.get("template") or "default"))
    tid = tid or "default"
    tdir = os.path.join(ROOT, "templates", tid)
    src = os.path.join(tdir, "style.css")
    if not os.path.exists(src):
        log("模板 %s 不存在，沿用现有 docs/style.css" % tid)
        return
    try:
        def write_if_changed(path, content, label):
            old = ""
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8") as f:
                    old = f.read()
            if content != old:
                with open(path, "w", encoding="utf-8") as f:
                    f.write(content)
                log("已应用模板 %s：%s" % (tid, label))

        with open(src, "r", encoding="utf-8") as f:
            write_if_changed(os.path.join(DOCS, "style.css"), f.read(), "→ docs/style.css")
        manifest = load_json(os.path.join(tdir, "manifest.json"), {}) or {}
        css = _tokens_css(manifest.get("tokens") or {})
        write_if_changed(os.path.join(DOCS, "tokens.css"), css, "→ docs/tokens.css")
    except Exception as e:
        log("应用模板失败（沿用现有样式）：%r" % e)


def load_keywords():
    """优先读站点本地 keywords.json；keywords.txt 仅作旧格式兜底。"""
    data = load_json(os.path.join(CONFIG, "keywords.json"), {})
    rows = (data.get("picked") or []) + (data.get("cores") or [])
    items = []
    for row in rows:
        if isinstance(row, str):
            items.append({"keyword": row.strip(), "note": ""})
        elif isinstance(row, dict) and row.get("keyword"):
            items.append({"keyword": row["keyword"].strip(),
                          "note": str(row.get("note", "")).strip()})
    if items:
        return items
    for line in load_text(os.path.join(CONFIG, "keywords.txt"), "").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "|" in line:
            kw, note = line.split("|", 1)
            items.append({"keyword": kw.strip(), "note": note.strip()})
        else:
            items.append({"keyword": line, "note": ""})
    return items


DEFAULT_WRITING = {
    "main_words": 300,
    "floor_count": [4, 6],
    "floor_words": [40, 100],
    "query_terms": "auto",        # auto=脚本优先，命中不够再问模型；script=只脚本；model=只模型
    "extra_rules": "",
    # v0.8：主笔/评论/主题约束。旧配置无这些字段时由下面逻辑兜底。
    "lead_mode": "",              # none=无主笔 / random=按seed抽 / fixed=指定；空=按主题默认
    "fixed_lead": "",             # lead_mode=fixed 时指定的昵称
    "lead_words": [300, 600],     # 主笔长文字数范围
    "content_requirements": "",   # 本篇内容硬性要求（站点可编辑；旧名 topic_constraint 兼容）
}


def load_names(active_only=True):
    rows = load_json(os.path.join(CONFIG, "names.json"), [])
    out = [r for r in rows if isinstance(r, dict) and r.get("nick")]
    if active_only:
        # v0.7：active=false 的人不出场；旧名单无 active 字段视为 true（兼容）
        out = [r for r in out if r.get("active", True)]
    return out


def load_runtime_config():
    """读取本站 build_runtime.py 落盘的运行配置（模块组合 / 请求策略 / 合并内容契约）"""
    cfg = load_json(GENERATED, {})
    return {
        "site_id": cfg.get("site_id", os.environ.get("SITE_ID", "kaka")),
        "composition": cfg.get("composition") or {},
        "module_sha256": cfg.get("module_sha256") or {},
        "renderer": cfg.get("renderer") or "compositor.py",
        "request_policy": cfg.get("request_policy") or {},
        "keyword_anchor": bool(cfg.get("keyword_anchor")),
        "content": cfg.get("content") or {},
    }


# 模块内容契约的兜底值。主站 modules/*.json 合并后的 content 会整体覆盖这里。
# 测试项目无兼容负担，这里只作为契约字段缺失时的最小占位。
DEFAULT_CONTENT = {
    "page_desc": "新的一篇内容",
    "system_role": "你在写一篇围绕本篇问题展开的内容。只输出 JSON。",
    "virtual_user_hint": "【身份】名单里的人以评论区网友身份出现。",
    "structure_block": "",
    "format_block": "",
    "role_model": "lead_support",
    "persona_default": "",
    "extra_rules_default": "",
    "keyword_policy": {},
    "editable": {},
    "module_fields": {},
    "output_fields": {
        "title": "页面标题，20字以内",
        "question": "这篇讨论的问题（一句话）",
        "author": "主笔昵称；无主笔时输出空字符串",
        "tags": "3~5 个标签词组成的字符串数组",
        "content_md": "正文全文，不含一级标题",
    },
}


def content_contract(runtime_cfg):
    """合并主题内容契约：契约字段覆盖兜底值，保证新增主题零改脚本"""
    out = dict(DEFAULT_CONTENT)
    c = runtime_cfg.get("content") or {}
    if isinstance(c, dict):
        out.update({k: v for k, v in c.items() if v not in (None, "")})
    return out


def persona_block(persona_text, runtime_cfg):
    """旧入口：仅拼人设段（不含分工）。v0.7 主流程改用 assign_roles()。
    v0.12：多人场景评论人设一律取签名（sign），persona 只留给主笔。"""
    c = runtime_cfg.get("content") or {} if isinstance(runtime_cfg, dict) else {}
    mode = (c.get("role_model") or c.get("persona_mode") or "single").lower() if isinstance(c, dict) else "single"
    multi = mode in ("multi", "peers", "discussion", "lead_support", "item_list")
    if multi:
        rows = load_names()
        lines = []
        for r in rows:
            p = (r.get("sign") or "").strip() or (r.get("persona") or "").strip()
            lines.append("- %s：%s" % (r["nick"], p) if p else "- %s" % r["nick"])
        if lines:
            return ("【人设】每个出场角色按自己的人设说话，语气与立场可不同：\n" + "\n".join(lines))
    return (persona_text or "").strip()


def _lead_persona(row):
    """主笔：只把完整人设(persona)交给 AI，旧配置无 persona 时退到签名。"""
    return (row.get("persona") or "").strip() or (row.get("sign") or "").strip()


def _comment_persona(row):
    """评论/短评/讨论：人设直接使用签名(sign)，旧配置缺 sign 时退到人设。"""
    return (row.get("sign") or "").strip() or (row.get("persona") or "").strip()


def _named_line(row, persona_text):
    """名单里的一行：昵称 + 人设。没有人设时只列昵称。"""
    return ("%s：%s" % (row["nick"], persona_text)) if persona_text else row["nick"]


def has_lead(runtime_cfg, writing=None):
    """是否启用主笔（无副作用）：主题 role_model 给能力边界，站点 writing.lead_mode 给取值。
    挖题阶段用它决定话题语义（有主笔=从短评选，无主笔=从讨论选），与 assign_roles 同源。
    """
    c = runtime_cfg.get("content") or {} if isinstance(runtime_cfg, dict) else {}
    model = (c.get("role_model") or "").strip() or (
        "peers" if (c.get("persona_mode") or "single") == "multi" else "single")
    lead_allowed = model in ("lead_support", "item_list")
    if not lead_allowed:
        return False
    mode = (((writing or {}).get("lead_mode") or "").strip().lower())
    if not mode:
        mode = "random" if model == "lead_support" else "none"
    return mode != "none"


def comment_kind_of(runtime_cfg, writing=None):
    """署名评论段落的语义标签，决定挖题放宽程度：
    - item_list（导航/资源）无论有无主笔，都是文末短评 → 短评
    - 有主笔的长文主题，署名段落是辅助短评 → 短评
    - 论坛 peers 无主笔，署名段落就是讨论楼层 → 讨论
    只影响提示措辞与打分阈值，抽取逻辑统一靠 `## @昵称` 识别。
    """
    c = runtime_cfg.get("content") or {} if isinstance(runtime_cfg, dict) else {}
    if (c.get("role_model") or "").strip() == "item_list":
        return "短评"
    return "短评" if has_lead(runtime_cfg, writing) else "讨论"


def assign_roles(runtime_cfg, seed_text, site_persona="", writing=None):
    """v0.8 角色分工核心：主题 role_model 决定"能否有主笔"，站点 writing.lead_mode 决定"要不要主笔/谁主笔"。

    返回 dict：
      lead       主笔 nick（有主笔时）；无主笔为 None
      supports   辅助 nick 列表
      names_block 出场名单（带人设）
      role_block  角色分工说明（注入 user prompt）
      fields_check 必填字段约束（导航/资源）
      model      role_model 名

    主笔随机用 seed 文本的 sha256 取模——同一个问题永远抽到同一主笔，保证
    --rebuild 与同日多次运行幂等（不会因随机导致内容抖动）。
    v0.8 去掉全局 role_policy.json 与名单 tier：主笔策略全部下沉到站点 writing。
    """
    c = runtime_cfg.get("content") or {} if isinstance(runtime_cfg, dict) else {}
    model = (c.get("role_model") or "").strip() or (
        "peers" if (c.get("persona_mode") or "single") == "multi" else "single")
    rows = load_names(active_only=True)
    w = writing or {}

    # 站点主笔策略：none=不设主笔 / random=按 seed 抽 / fixed=指定
    lead_mode = (w.get("lead_mode") or "").strip().lower()
    fixed_lead = (w.get("fixed_lead") or "").strip()
    # 主题能力：peers 主题禁用主笔（论坛）；lead_support/item_list 才允许
    lead_allowed = model in ("lead_support", "item_list")
    if not lead_mode:
        # 兜底：旧配置无 lead_mode，按主题默认（lead_support 才有主笔）
        lead_mode = "random" if model == "lead_support" else "none"
    if not lead_allowed:
        lead_mode = "none"

    lead = None
    supports = []
    parts = []

    if lead_mode != "none" and rows:
        # 一主多辅 / 条目+主笔导语：主笔从全体 active 人里抽
        if lead_mode == "fixed" and fixed_lead:
            pick = next((r for r in rows if r["nick"] == fixed_lead), None)
        else:
            pick = None
        if pick is None:
            digest = hashlib.sha256((seed_text or "").encode("utf-8")).hexdigest()
            pick = rows[int(digest[:8], 16) % len(rows)]
        lead = pick["nick"]
        sup_pool = [r for r in rows if r["nick"] != lead]
        supports = [r["nick"] for r in sup_pool]
        parts.append("【角色分工：一主多辅】")
        parts.append("- 主笔：%s" % _named_line(pick, _lead_persona(pick)))
        parts.append("  主笔写作时严格遵循上面给出的人设（persona），正文只用这一种口吻。")
        if model == "item_list":
            parts.append("  主笔只写一段导语（说明这批条目的主题与筛选标准），正文条目列表不得用人物署名。")
        else:
            parts.append("  只有主笔写正文长文（完整论证、带细节和边界），正文用普通段落，不署名楼层。")
        if supports:
            parts.append("- 辅助短评：以下人物各写一条短评，人设直接使用各自签名，每条只讲一个点：")
            for r in sup_pool:
                parts.append("  · %s" % _named_line(r, _comment_persona(r)))
            parts.append("  短评用「## @昵称 · 时间」开头，附在正文之后。")
    elif model == "item_list":
        # 条目为主体、无主笔：正文条目列表 + 文末短评（用户确认维持此模式）
        supports = [r["nick"] for r in rows]
        parts.append("【角色分工：条目为主体】")
        parts.append("- 正文是条目列表本身，不写长文导语，不得用虚拟人物署名条目。")
        if supports:
            parts.append("- 文末必须附 2~3 条虚拟人物短评（「## @昵称 · 时间」开头），从名单里选人、按各自签名，每条只讲一个点；这是固定的收尾部分，不要省略。")
            for r in rows:
                parts.append("  · %s" % _named_line(r, _comment_persona(r)))
    else:
        # peers / discussion / single（论坛）：不分主次，全员按签名讨论，无主笔
        supports = [r["nick"] for r in rows]
        parts.append("【角色分工：不分主次】")
        parts.append("- 所有出场人物地位平等，各按自己签名发言，不设主笔、不写长文主导。")
        for r in rows:
            parts.append("  · %s" % _named_line(r, _comment_persona(r)))
        if model == "single" and site_persona:
            parts.append("- 站点通用基调：%s" % site_persona.strip())

    # 出场名单段：lead_support 时列全体（主笔+辅助），其余列全体
    name_lines = ["- %s（%s）" % (r["nick"], r.get("sign") or "") for r in rows]
    names_block = "\n".join(name_lines) or "- 阿强\n- 小北"

    # 必填字段约束（导航/资源）
    fields_check = ""
    required = c.get("required_fields") or []
    if required:
        fields_check = ("【条目完整性（硬要求）】正文每个条目必须完整包含：%s。"
                        "缺少任意一项的条目视为无效，宁可少列也不要凑数。" % " / ".join(required))

    return {
        "lead": lead,
        "supports": supports,
        "names_block": names_block,
        "role_block": "\n".join(parts),
        "fields_check": fields_check,
        "model": model,
    }


def local_validate_fields(content_md, runtime_cfg):
    """v0.7 本地校验：导航/资源条目完整性。纯字符串检查，不发 AI 请求。
    对缺必填字段的条目做提示性统计（不擅自删正文，避免破坏排版）；返回报告 dict。"""
    c = runtime_cfg.get("content") or {} if isinstance(runtime_cfg, dict) else {}
    required = c.get("required_fields") or []
    if not required or not content_md:
        return {"checked": False, "items": 0, "incomplete": 0}
    # 条目以 ## 小标题分隔
    blocks = re.split(r"(?m)^##\s+", content_md)
    items = [b for b in blocks[1:] if b.strip()] if len(blocks) > 1 else []
    incomplete = 0
    for b in items:
        # 链接用 markdown 行内链接判定；名称=小标题本身；简述/缺点看是否有文字段落
        has_link = bool(re.search(r"\[[^\]]+\]\([^)]+\)", b))
        body = re.sub(r"\[[^\]]+\]\([^)]+\)", "", b).strip()
        has_text = len(body) >= 8
        miss = []
        if "链接" in required and not has_link:
            miss.append("链接")
        if ("简述" in required or "缺点" in required) and not has_text:
            miss.append("简述")
        if miss:
            incomplete += 1
    report = {"checked": True, "items": len(items), "incomplete": incomplete}
    if incomplete:
        log("本地校验：%d/%d 个条目可能缺必填字段（%s）" %
            (incomplete, len(items), "/".join(required)))
    return report


def keyword_anchor_block(runtime_cfg, seed_text, keywords):
    """关键词锚点段：把篇幅/话题锁死在本篇问题与冻结关键词内，防抽词续问偏题。
    旧配置无 keyword_policy 时返回空串，行为不变。"""
    c = runtime_cfg.get("content") or {} if isinstance(runtime_cfg, dict) else {}
    kp = c.get("keyword_policy") or {} if isinstance(c, dict) else {}
    if not isinstance(kp, dict) or not kp.get("anchor"):
        return ""
    words = []
    for k in (keywords or []):
        w = (k.get("keyword") or "").strip()
        if w and w not in words:
            words.append(w)
    hint = (kp.get("hint") or "").strip()
    scope = (kp.get("scope") or "same_article").strip()
    parts = ["【主题锚点（最高优先级）】"]
    if seed_text:
        parts.append("本篇只讨论这个问题：%s" % seed_text.strip())
    if words:
        parts.append("必须围绕这些关键词及其衍生：%s" % "、".join(words[:12]))
    if hint:
        parts.append(hint)
    parts.append("结尾就本篇自然收束，不要把话题甩向无关方向，也不要留续问钩子。")
    return "\n".join(parts)


def identity_hint(runtime_cfg):
    """虚拟用户身份提示：有内容契约就用契约，否则按旧 slots.position 兜底"""
    raw = (runtime_cfg or {}).get("content") or {}
    if isinstance(raw, dict) and (raw.get("virtual_user_hint") or "").strip():
        return raw["virtual_user_hint"].strip()
    # 旧版兜底：只有 slots、没有 content 契约的分站（fetch 未下发新契约时）
    pos = (((runtime_cfg or {}).get("slots") or {}).get("virtual_users") or {}).get("position", "")
    if pos == "comments":
        return "【身份】名单里的人以评论区网友身份出现，不要写成论坛楼层。"
    if pos == "floor":
        return "【身份】名单里的人以跟帖楼层用户身份出现。"
    return ""


PROMPT_DIR = os.path.join(CONFIG, "prompts")

# 通用骨架：正文/站点/资源/评论各模块的结构由 modules/*.json 合并后注入 {{structure_block}}。
# 一次请求产出全部字段，脚本按字段分发给各模块，不再有第二次请求。
DEFAULT_WRITE_PROMPT = """今天是 {{today}}。这是{{page_desc}}。

{{seed}}

{{anchor}}

【可用的信源素材】（只能引用这里的事实，站点与资源的 url 只能从这里取）
{{material}}

【最近写过的页】
{{recent}}

【篇幅】正文 {{mw}} 字以内，{{fc_min}}~{{fc_max}} 组要点，每组 {{fw_min}}~{{fw_max}} 字。
{{extra}}

{{structure_block}}

【出场的人】（nick 只能从这份名单里选）
{{names}}

{{role_block}}

{{identity_hint}}

{{fields_check}}

{{format_block}}

【链接真实性（强制）】
正文里提到的外部站点与下载资源，一律写进 links.sites / links.resources 字段，不要混进正文段落。
每条的 url 必须是【可用的信源素材】里真实出现的完整地址；素材里没有的，url 留空字符串 ""，绝不拼凑或编造。

【输出 JSON（严格按此结构，全部字段都要有）】
{
 "title": "{{f_title}}",
 "question": "{{f_question}}",
 "author": "{{f_author}}",
 "tags": {{f_tags}},
 "summary": "两三句简述，概括结论与适用边界",
 "content_md": "{{f_content_md}}",
 "quotes": ["正文里逐字出现的金句原句1", "金句原句2"],
 "links": {
   "sites": [{"name": "站点名", "url": "素材里的真实地址或空串", "desc": "一句话说明", "detail": "完整点评/适用场景/限制"}],
   "resources": [{"name": "资源名", "url": "素材里的真实地址或空串", "desc": "一句话简介", "detail": "详情/适合谁/一个明确缺点"}]
 },
 "comments": {
   "body": [{"nick": "名单里的昵称", "text": "正文专属短评，## @昵称 署名那种文字内容，不要带 ## 前缀"}],
   "site": [{"nick": "名单里的昵称", "text": "站点专属短评文字"}],
   "resource": [{"nick": "名单里的昵称", "text": "资源专属短评文字"}]
 }
}"""

DEFAULT_TERMS_PROMPT = """从这句问题里抽出 3~5 个搜索关键词，实体词优先。
问题：「{{question}}」
【输出 JSON】{"terms": ["词1", "词2"]}"""

def load_prompt(name, fallback, **vars):
    """从 config/prompts/{name}.md 读模板，用 {{var}} 占位替换；文件缺失时用内置兜底"""
    path = os.path.join(PROMPT_DIR, name + ".md")
    tpl = load_text(path) or fallback
    for k, v in vars.items():
        tpl = tpl.replace("{{%s}}" % k, str(v))
    return tpl


def load_writing():
    w = dict(DEFAULT_WRITING)
    cfg = load_json(os.path.join(CONFIG, "writing.json"), {})
    if isinstance(cfg, dict):
        w.update({k: v for k, v in cfg.items() if v not in (None, "")})
    # 环境变量还能临时覆盖
    if os.environ.get("WORD_COUNT", "").strip().isdigit():
        w["main_words"] = int(os.environ["WORD_COUNT"].strip())
    try:
        w["main_words"] = max(200, int(w["main_words"]))
        # 兼容中性字段：unit_count/unit_words 与旧名 floor_count/floor_words 双向同步
        if "unit_count" in w and w["unit_count"] not in (None, ""):
            w["floor_count"] = [int(x) for x in w["unit_count"]]
        if "unit_words" in w and w["unit_words"] not in (None, ""):
            w["floor_words"] = [int(x) for x in w["unit_words"]]
        w["floor_count"] = [int(x) for x in w["floor_count"]]
        w["floor_words"] = [int(x) for x in w["floor_words"]]
        w.setdefault("unit_count", w["floor_count"])
        w.setdefault("unit_words", w["floor_words"])
    except Exception:
        w = dict(DEFAULT_WRITING)
    return w


def load_history():
    h = load_json(HISTORY, {"items": []})
    if not isinstance(h, dict) or not isinstance(h.get("items"), list):
        h = {"items": []}
    return h


# ---------------------------------------------------------------- 排序

def human_age(ts, now):
    if not ts:
        return "时间不明"
    h = (now - ts).total_seconds() / 3600.0
    if h < 1:
        return "%d分钟前" % max(1, int(h * 60))
    if h < 24:
        return "%d小时前" % int(h)
    return "%d天前" % int(h / 24)


def rank_candidates(items, keywords, now):
    for it in items:
        hay = (it["title"] + " " + (it.get("summary") or "")).lower()
        hits = [k["keyword"] for k in keywords if k["keyword"].lower() in hay]
        s = len(hits) * 3.0 + float(it.get("weight", 1.0))
        age_h = (now - it["ts"]).total_seconds() / 3600.0 if it.get("ts") else 99
        s += 3.0 if age_h <= 6 else 2.0 if age_h <= 24 else 1.0 if age_h <= 48 else 0.0
        if len(it["title"]) < 10:
            s -= 1.5
        if len(it["title"]) > 50:
            s -= 0.5
        it["hits"] = hits
        it["score"] = round(s, 2)
        it["age"] = human_age(it.get("ts"), now)
    items.sort(key=lambda x: x["score"], reverse=True)
    return items


# ---------------------------------------------------------------- 模型

DEFAULT_MODEL = "google/gemini-3.5-flash-lite"
MODELS_URL = "https://openrouter.ai/api/v1/models"
FREE_BOOST = ("gemma", "nemotron-3-ultra", "dots", "ling", "ernie", "inkling", "particle")

FALLBACK_FREE = [
    "google/gemma-4-31b-it:free",
    "google/gemma-4-26b-a4b-it:free",
    "inclusionai/ling-3.2-flash:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "baidu/ernie-5.5-flash-preview:free",
    "dots-studio/dots-3-note-preview:free",
    "openrouter/free",
]

_CATALOG = None

_PREFERRED = None
_SESSION_BAD = set()
_WALL_DEADLINE = None
REQUEST_TIMEOUT = 120
WRITE_TIMEOUT = 180
MAX_ATTEMPTS = 1

BADLIST = os.path.join(DOCS, ".model_badlist.json")
BAD_TTL = 7 * 86400


def load_badlist():
    data = load_json(BADLIST, {})
    if not isinstance(data, dict):
        return {}
    now = time.time()
    return {m: v for m, v in data.items()
            if isinstance(v, dict) and now - float(v.get("ts") or 0) < BAD_TTL}


def mark_bad(model, reason):
    if model == "openrouter/free":
        return
    data = load_json(BADLIST, {})
    if not isinstance(data, dict):
        data = {}
    data[model] = {"reason": str(reason)[:300], "ts": time.time()}
    try:
        os.makedirs(DOCS, exist_ok=True)
        with open(BADLIST, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
    except Exception:
        pass


def free_only_enabled():
    return os.environ.get("FREE_ONLY", "1").strip().lower() not in ("0", "false", "no", "off")


def model_catalog():
    global _CATALOG
    if _CATALOG is not None:
        return _CATALOG
    cat = {}
    try:
        with urllib.request.urlopen(MODELS_URL, timeout=30) as r:
            data = json.loads(r.read().decode("utf-8"))
        for m in data.get("data", []):
            pr = m.get("pricing") or {}
            cat[m.get("id", "")] = {
                "free": str(pr.get("prompt")) == "0" and str(pr.get("completion")) == "0",
                "ctx": m.get("context_length") or 0,
                "name": (m.get("name") or "").strip(),
            }
    except Exception as e:
        log("拉模型表失败（改用内置免费列表）：%r" % e)
        cat = {}
    _CATALOG = cat
    return cat


def is_free(model_id, cat):
    if cat.get(model_id):
        return bool(cat[model_id]["free"])
    return model_id.endswith(":free") or model_id == "openrouter/free"


def model_display_name(mid):
    info = model_catalog().get(mid) or {}
    name = re.sub(r"\s+", " ", info.get("name") or "").strip()
    if ":" in name:
        name = name.split(":", 1)[1].strip()
    return name or mid


def fetch_free_models():
    cat = model_catalog()
    rows = []
    for mid, meta in cat.items():
        if not meta["free"] or not mid:
            continue
        if "image" in mid or "lyria" in mid:
            continue
        rows.append((sum(1 for k in FREE_BOOST if k in mid), meta["ctx"], mid))
    rows.sort(reverse=True)
    ids = [x[2] for x in rows if x[2] != "openrouter/free"]
    if any(x[2] == "openrouter/free" for x in rows):
        ids.append("openrouter/free")
    return ids


def resolve_models(spec, free_only=None):
    if free_only is None:
        free_only = free_only_enabled()
    spec = (spec or "").strip()
    if not spec:
        spec = "free" if free_only else DEFAULT_MODEL

    models = []
    for part in [p.strip() for p in spec.split(",") if p.strip()]:
        if part.lower() in ("free", "all-free", "freeall", "*"):
            free = fetch_free_models()
            models.extend(free if free else list(FALLBACK_FREE))
        else:
            models.append(part)

    seen, uniq = set(), []
    for m in models:
        if m not in seen:
            seen.add(m)
            uniq.append(m)

    if free_only:
        cat = model_catalog()
        uniq = [m for m in uniq if is_free(m, cat)]
        if not uniq:
            uniq = list(FALLBACK_FREE)

    bad = load_badlist()
    if bad:
        keep = [m for m in uniq if m == "openrouter/free" or m not in bad]
        if keep:
            if len(keep) < len(uniq):
                log("跳过 %d 个最近不可用的模型" % (len(uniq) - len(keep)))
            uniq = keep
        else:
            log("候选全在黑名单里，本次忽略黑名单重试")
            try:
                os.remove(BADLIST)
            except Exception:
                pass

    try:
        with open(os.path.join(DOCS, ".model_used"), "r", encoding="utf-8") as f:
            last = f.read().strip()
        if last in uniq:
            uniq.remove(last)
            uniq.insert(0, last)
    except Exception:
        pass

    return uniq or list(FALLBACK_FREE)


def extract_text(resp):
    try:
        msg = resp["choices"][0]["message"]
    except Exception:
        raise RuntimeError("返回结构异常: " + json.dumps(resp, ensure_ascii=False)[:500])
    content = msg.get("content")
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return content or ""


def gateway_enabled():
    """是否走集中式写作网关。需要账号级 ACCOUNT_TOKEN 或旧 GATEWAY_TOKEN。"""
    return os.environ.get("GATEWAY_MODE", "central").strip().lower() not in (
        "local", "off", "0", "false", "no") and bool(
        os.environ.get("ACCOUNT_TOKEN", "").strip()
        or os.environ.get("GATEWAY_TOKEN", "").strip())


def _new_request_id():
    """唯一请求 id：时间戳 + 站点 + 随机串，避免并发串号。"""
    raw = "%s|%s|%s|%s" % (time.time(), os.getpid(), random.random(),
                           os.environ.get("SITE_ID", "kaka"))
    return datetime.datetime.now(BJT).strftime("%Y%m%d%H%M%S") + "-" + hashlib.sha1(
        raw.encode("utf-8")).hexdigest()[:10]


def _gateway_dispatch(request_id, messages, base_url=""):
    """dispatch 主站 gateway.yml，只传 prompt 与回写坐标，不传业务数据。"""
    token = (os.environ.get("ACCOUNT_TOKEN", "").strip()
             or os.environ.get("GATEWAY_TOKEN", "").strip())
    repo = os.environ.get("GATEWAY_REPO", "yxtcfw/yxtcfw.github.io").strip()
    event = os.environ.get("GATEWAY_EVENT", "writing_request").strip()
    if "/" not in repo:
        sys.exit("GATEWAY_REPO 格式错误：%s" % repo)
    payload = {
        "event_type": event,
        "client_payload": {
            "request_id": request_id,
            "site_id": os.environ.get("SITE_ID", "kaka").strip(),
            "site_repo": os.environ.get("SITE_REPO", "yxtcfw/kaka").strip(),
            "site_branch": os.environ.get("SITE_BRANCH", "main").strip(),
            "base_url": base_url or os.environ.get("SITE_BASE_URL", ""),
            "messages": messages,
        },
    }
    api = "https://api.github.com/repos/%s/dispatches" % repo
    req = urllib.request.Request(
        api, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), method="POST")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "site-model-gateway-client/1.0")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            if r.status not in (200, 201, 204):
                raise RuntimeError("dispatch 返回 HTTP %s" % r.status)
        log("已 dispatch 写作请求：%s → %s" % (request_id, repo))
    except Exception as e:
        sys.exit("dispatch 主站网关失败：%r" % e)


def _gateway_wait(request_id, timeout=None):
    """轮询主站跨仓回写的结果文件（GitHub Contents API 直读，不依赖本地工作区）。"""
    import base64
    timeout = int(timeout or os.environ.get("GATEWAY_POLL_TIMEOUT", "600"))
    interval = 15
    deadline = time.time() + timeout
    repo = os.environ.get("SITE_REPO", "yxtcfw/kaka").strip()
    token = (os.environ.get("ACCOUNT_TOKEN", "").strip()
             or os.environ.get("GATEWAY_TOKEN", "").strip()
             or os.environ.get("GITHUB_TOKEN", "").strip())
    branch = os.environ.get("SITE_BRANCH", "main").strip()
    api = ("https://api.github.com/repos/%s/contents/config/.gateway-result/%s.json"
           "?ref=%s" % (repo, request_id, branch))
    if not token:
        sys.exit("缺少 ACCOUNT_TOKEN / GATEWAY_TOKEN / GITHUB_TOKEN，无法读取网关回写")
    log("等待网关回写：%s（最多 %ds）" % (request_id, timeout))
    while time.time() < deadline:
        try:
            req = urllib.request.Request(api)
            req.add_header("Accept", "application/vnd.github+json")
            req.add_header("Authorization", "Bearer " + token)
            req.add_header("User-Agent", "site-model-gateway-client/1.0")
            with urllib.request.urlopen(req, timeout=20) as r:
                data = json.loads(r.read().decode("utf-8"))
            content = base64.b64decode(data.get("content") or "").decode("utf-8")
            result = json.loads(content)
            log("收到网关回写：ok=%s provider=%s model=%s" % (
                result.get("ok"), result.get("provider"), result.get("used_model")))
            return result
        except urllib.error.HTTPError as e:
            if e.code != 404:
                log("读取回写文件 HTTP %s，稍后重试" % e.code)
        except Exception as e:
            log("读取回写文件失败：%r，稍后重试" % e)
        time.sleep(interval)
    sys.exit("等待网关回写超时（%ds，request_id=%s）" % (timeout, request_id))


def call_gateway(messages, models=None, temperature=0.85, timeout=None):
    """集中式网关调用：dispatch → 等待回写 → 返回与 call_openrouter 同结构的 resp。"""
    request_id = _new_request_id()
    _gateway_dispatch(request_id, messages)
    result = _gateway_wait(request_id, timeout=timeout)
    if not result.get("ok"):
        attempts = result.get("attempts") or []
        detail = "; ".join("%s/%s:%s" % (a.get("provider"), a.get("model"), a.get("reason"))
                           for a in attempts[:6])
        sys.exit("网关调用失败：%s；尝试明细：%s" % (result.get("error", "?"), detail or "无"))
    # 构造与现有 extract_text() 兼容的响应结构，下游解析零改动
    content = result.get("content") or ""
    resp = {
        "choices": [{"message": {"content": content}}],
        "usage": result.get("usage") or {},
        "_used_model": result.get("used_model") or (models or ["gateway"])[0],
        "_gateway_provider": result.get("provider", ""),
        "_gateway_request_id": request_id,
    }
    return resp


def call_openrouter(messages, models, temperature=0.8, retries=None, timeout=None):
    global _PREFERRED, AI_CALLS
    AI_CALLS += 1
    if gateway_enabled():
        return call_gateway(messages, models, temperature=temperature, timeout=timeout)
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        sys.exit("缺少环境变量 OPENROUTER_API_KEY（本地直连模式）")
    if isinstance(models, str):
        models = [models]
    if retries is None:
        retries = MAX_ATTEMPTS

    models = list(models)
    if _PREFERRED and _PREFERRED in models:
        models.remove(_PREFERRED)
        models.insert(0, _PREFERRED)
    if _SESSION_BAD:
        kept = [m for m in models if m not in _SESSION_BAD]
        if kept:
            models = kept

    headers = {
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
        "HTTP-Referer": os.environ.get("SITE_BASE_URL") or "https://github.com",
        "X-Title": "daily-blog",
    }

    last_err = ""
    codes = []
    for idx, model in enumerate(models):
        payload = {"model": model, "messages": messages, "temperature": temperature,
                   "response_format": {"type": "json_object"}}
        for attempt in range(retries):
            if _WALL_DEADLINE and time.time() > _WALL_DEADLINE:
                sys.exit("模型调用超出总时长预算，放弃本次生成（已试 %d 个模型）" % (idx + 1))
            req = urllib.request.Request(API_URL, data=json.dumps(payload).encode("utf-8"),
                                         headers=headers, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=(timeout or REQUEST_TIMEOUT)) as r:
                    resp = json.loads(r.read().decode("utf-8"))
                resp["_used_model"] = model
                _PREFERRED = model
                if idx > 0:
                    log("换到第 %d 个模型成功：%s" % (idx + 1, model))
                return resp
            except urllib.error.HTTPError as e:
                body = e.read().decode("utf-8", errors="replace")
                msg = ""
                try:
                    msg = ((json.loads(body) or {}).get("error") or {}).get("message") or ""
                except Exception:
                    msg = body[:200].replace("\n", " ")
                last_err = "HTTP %s: %s" % (e.code, msg or body[:200])

                if e.code == 400 and "response_format" in payload:
                    payload.pop("response_format", None)
                    continue

                if e.code == 401 or (e.code == 403 and re.search(
                        r"(api key|no auth|unauthor|invalid.{0,20}key|key.{0,20}(disabl|invalid))",
                        msg, re.I)):
                    sys.exit("Key 无效或没权限（HTTP %s）：%s" % (e.code, msg or body[:200]))

                codes.append(e.code)
                if e.code in (403, 404):
                    mark_bad(model, "HTTP %s %s" % (e.code, msg))
                _SESSION_BAD.add(model)

                log("  %s → HTTP %s %s" % (model, e.code, (msg or "")[:120]))
                break
            except Exception as e:
                last_err = repr(e)
                log("  %s → %r" % (model, e))
                _SESSION_BAD.add(model)
                break
        else:
            log("  %s 重试后仍失败，换下一个" % model)

    hint = ""
    if codes and all(c in (429, 402) for c in codes):
        hint = ("\n提示：整条链都是 429/402，通常是今天的免费额度用完了"
                "（OpenRouter 免费模型：未充值账户每天 50 次，充值过 $10 是 1000 次）。"
                "额度每天重置，明天会自动恢复；也可以减少手动测试次数。")
    sys.exit("模型链全部失败（共 %d 个，最后错误：%s）%s" % (len(models), last_err, hint))


def parse_json_reply(text):
    t = (text or "").strip()
    t = re.sub(r"^```(?:json)?\s*", "", t)
    t = re.sub(r"\s*```$", "", t)
    try:
        return json.loads(t)
    except Exception:
        pass
    start, end = t.find("{"), t.rfind("}")
    if start >= 0 and end > start:
        return json.loads(t[start:end + 1])
    raise ValueError("模型没吐出合法 JSON：\n" + text[:400])


def ask_json(messages, models, temperature=0.7, timeout=None):
    resp = call_openrouter(messages, models, temperature, timeout=timeout)
    return parse_json_reply(extract_text(resp)), resp


def set_budget(seconds):
    global _WALL_DEADLINE
    _WALL_DEADLINE = time.time() + max(60, int(seconds))


# ---------------------------------------------------------------- 取材

STOP_GRAMS = {"怎么", "什么", "如何", "为什", "么办", "可以", "能不", "不能", "值不", "不值",
              "该不", "不该", "有没", "没有", "到底", "是什", "的话", "这个", "那个", "一个",
              "要不", "不要", "多少", "多久", "是不", "不是", "哪些", "哪个", "么样", "什么"}


BAD_CHARS = "怎什么如何为吗呢吧啊的了是在有和就都也还"


def script_terms(text, keywords, anchors_only=True):
    """
    纯脚本抽检索词，不调模型。
    anchors_only=True（v0.6 默认，防偏题）：只围绕冻结关键词池衍生，
      2-gram/英文词必须与某个锚点有交集才收，杜绝「流量卡」「划算」这类泛词。
    anchors_only=False：旧行为（英文/2-gram 全收），仅旧配置兜底用。
    """
    out, seen = [], set()

    def add(w):
        k = w.lower()
        if w and k not in seen and len(out) < 8:
            seen.add(k)
            out.append(w)

    pool = []
    for k in (keywords or []):
        kw = (k.get("keyword") or "").strip()
        if kw:
            pool.append(kw)

    # 1. 关键词池里出现在问题里的，最优先（人工冻结的锚点最准）
    for kw in pool:
        if kw in text:
            add(kw)

    if anchors_only and pool:
        # 2. 衍生词必须与锚点有交集（子串关系或共用字），不收无关泛词
        for tok in re.findall(r"[A-Za-z][A-Za-z0-9.\-]{1,}", text):
            if any(tok.lower() in p.lower() or p.lower() in tok.lower() for p in pool):
                add(tok)
        for seg in re.findall(r"[\u4e00-\u9fff]+", text):
            for i in range(len(seg) - 1):
                g = seg[i:i + 2]
                if g in STOP_GRAMS or any(c in BAD_CHARS for c in g):
                    continue
                if any(g in p for p in pool):
                    add(g)
    else:
        # 旧行为：英文/中文 2-gram 全收
        for tok in re.findall(r"[A-Za-z][A-Za-z0-9.\-]{1,}", text):
            add(tok)
        for seg in re.findall(r"[\u4e00-\u9fff]+", text):
            for i in range(len(seg) - 1):
                g = seg[i:i + 2]
                if g in STOP_GRAMS or any(c in BAD_CHARS for c in g):
                    continue
                add(g)

    # 3. 兜底：一个都没命中（问题措辞和关键词完全不重合）时，用锚点自身拆词组
    if not out and pool:
        for kw in pool[:6]:
            add(kw)
    return out[:6]


def extract_query_terms(text, models=None, keywords=None, terms_mode="script", anchors_only=True):
    """
    抽检索词。默认 script：纯脚本切分，不发 AI 请求（省资源契约）。
    anchors_only=True（v0.6）：只围绕冻结关键词池衍生，防话题漂移。
    terms_mode=model 才走模型；那是旧行为，主站配置不应开启。
    """
    if terms_mode == "model":
        try:
            data, _ = ask_json([
                {"role": "system", "content": "只输出 JSON，不要解释。"},
                {"role": "user", "content": load_prompt("terms", DEFAULT_TERMS_PROMPT, question=text)},
            ], models or [], temperature=0.2, timeout=60)
            terms = data.get("terms") or []
            terms = [str(t).strip() for t in terms if str(t).strip()]
            return terms[:5] or script_terms(text, keywords or [], anchors_only)
        except BaseException as e:
            log("抽检索词失败（%r），用脚本切分兜底" % (e,))
            return script_terms(text, keywords or [], anchors_only)
    return script_terms(text, keywords or [], anchors_only)


def rank_by_terms(items, terms):
    """按命中选题关键词的数量重排，命中越多越靠前"""
    tl = [t.lower() for t in terms]
    for it in items:
        hay = (it["title"] + " " + (it.get("summary") or "")).lower()
        it["hit_terms"] = [t for t in terms if t.lower() in hay]
        it["rel"] = len(it["hit_terms"])
    items.sort(key=lambda x: (x["rel"], x.get("score", 0)), reverse=True)
    return items


def render_material(cands, limit=8):
    lines = []
    for i, it in enumerate(cands[:limit]):
        tier = it.get("tier") or "L3"
        caps = "、".join(it.get("capabilities") or []) or "未声明"
        not_for = "、".join(it.get("not_for") or []) or "无"
        lines.append(
            "[%d] %s（%s）· %s\n    可证明：%s\n    不可用于：%s\n    标题：%s\n    摘要：%s" % (
                i, it["source"], tier, it["age"], caps, not_for,
                it["title"], (it.get("summary") or "（无摘要）")[:260]))
    return "\n".join(lines) or "（这次没抓到外部素材）"


def search_web(query, cfg):
    """
    搜索接口（预留）。provider=none 时返回空，调用方退回信源素材。
    以后部署了 SearXNG 就把 config/sources.json 里 search.provider 改成 searxng。
    """
    provider = (cfg.get("provider") or "none").lower()
    if provider == "none":
        return []
    if provider == "searxng":
        base = (cfg.get("searxng_url") or "").rstrip("/")
        if not base:
            log("search.provider=searxng 但没填 searxng_url，跳过")
            return []
        url = "%s/search?q=%s&format=json" % (base, urllib.request.quote(query))
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                data = json.loads(r.read().decode("utf-8"))
            out = []
            for item in (data.get("results") or [])[: int(cfg.get("max_results", 8))]:
                out.append({
                    "title": item.get("title", ""),
                    "url": item.get("url", ""),
                    "summary": (item.get("content") or "")[:400],
                    "source": item.get("engine") or "searxng",
                    "age": "搜索结果",
                })
            log("搜索到 %d 条" % len(out))
            return out
        except Exception as e:
            log("搜索失败：%r" % e)
            return []
    log("未知的 search.provider：%s" % provider)
    return []


def clean_tags(value, keywords=None):
    """清洗模型产出的标签（本地处理，不消耗 AI 请求）。

    模型给的可能是数组、逗号串或带 # 的字符串；统一去符号、去重、限 5 个。
    没产出时用冻结关键词 picked 兜底，保证头部标签栏永远有内容可渲染。
    """
    tags = []
    raw = [value] if isinstance(value, str) else (value or [])
    for x in raw:
        s = str(x).strip().strip("[]").strip()
        s = re.sub(r"^[#＃]+", "", s).strip().strip("\"' ").strip()
        if s and len(s) <= 12 and s not in tags:
            tags.append(s)
        if len(tags) >= 5:
            break
    if not tags:
        for k in (keywords or []):
            s = ((k.get("keyword") or "").strip() if isinstance(k, dict) else str(k).strip())
            if s and s not in tags:
                tags.append(s[:12])
            if len(tags) >= 3:
                break
    return tags


# ---------------------------------------------------------------- 写作
# v0.11：续问留钩机制已移除。选题只来自历史评论（mine.scan_comment_topics），
# 结尾由主题 structure_block 要求自然收束，不再生成/校验/补问 next_questions。

def next_page_no(posts_dir):
    nums = []
    if os.path.isdir(posts_dir):
        for f in os.listdir(posts_dir):
            m = re.match(r"^(\d+)\.md$", f)
            if m:
                nums.append(int(m.group(1)))
    return (max(nums) + 1) if nums else 1


# ---------------------------------------------------------------- 结构化产物解析

URL_IN_MATERIAL = re.compile(r"https?://[^\s<>\"'）)】]+")


def _clean_item(raw, fields=("name", "url", "desc", "detail")):
    """把模型给的一条站点/资源字典规整成统一结构，url 非法则清空。"""
    if not isinstance(raw, dict):
        return None
    name = str(raw.get("name") or raw.get("title") or "").strip()
    if not name:
        return None
    url = str(raw.get("url") or "").strip()
    if url and not re.match(r"^https?://", url):
        url = ""   # 非 http(s) 一律不给链接
    return {
        "name": name,
        "url": url,
        "desc": str(raw.get("desc") or raw.get("summary") or "").strip(),
        "detail": str(raw.get("detail") or raw.get("desc") or "").strip(),
    }


def parse_structured(data, content_md, material_block, names, keywords, max_links=6):
    """解析 AI 的 9 字段输出，做链接真实性校验与字段兜底，返回可落盘的结构化 dict。

    护栏：
    - links 里 url 必须出现在信源素材里（命中才保留，否则清空为 ""，只留名称文字）
    - quotes 必须是正文里逐字出现的句子（不命中则丢弃）
    - comments 的 nick 必须在名单里，且 text 去掉模型可能误带的 ## 前缀
    """
    sites = []
    resources = []
    links = data.get("links") or {}
    if isinstance(links, dict):
        material_urls = set(URL_IN_MATERIAL.findall(material_block or ""))
        for raw in (links.get("sites") or [])[:max_links]:
            it = _clean_item(raw)
            if not it:
                continue
            if it["url"] and material_urls and it["url"] not in material_urls:
                # 精确命中失败再做一次"去尾斜杠/查询串"的宽松匹配
                base = it["url"].rstrip("/").split("?")[0]
                if not any(base == u.rstrip("/").split("?")[0] for u in material_urls):
                    it["url"] = ""   # 防失真：素材里没有就不给链接
            sites.append(it)
        for raw in (links.get("resources") or [])[:max_links]:
            it = _clean_item(raw)
            if not it:
                continue
            if it["url"] and material_urls and it["url"] not in material_urls:
                base = it["url"].rstrip("/").split("?")[0]
                if not any(base == u.rstrip("/").split("?")[0] for u in material_urls):
                    it["url"] = ""
            resources.append(it)

    quotes = []
    for q in (data.get("quotes") or []):
        q = str(q).strip().strip("\"“”")
        if q and q in content_md and q not in quotes:
            quotes.append(q)

    valid_nicks = {r.get("nick") for r in names if r.get("nick")}
    comments = {}
    raw_comments = data.get("comments") or {}
    if isinstance(raw_comments, dict):
        for key in ("body", "site", "resource"):
            arr = []
            for c in (raw_comments.get(key) or [])[:3]:
                if not isinstance(c, dict):
                    continue
                nick = str(c.get("nick") or "").strip().lstrip("@")
                text = re.sub(r"^\s*##\s*@?[^\s·]*[^\n]*\n?", "", str(c.get("text") or "")).strip()
                if nick in valid_nicks and text:
                    arr.append({"nick": nick, "text": text})
            comments[key] = arr

    tags = clean_tags(data.get("tags"), keywords)
    return {
        "summary": str(data.get("summary") or "").strip(),
        "quotes": quotes,
        "links": {"sites": sites, "resources": resources},
        "comments": comments,
        "tags": tags,
    }


def comments_to_md(comments):
    """把三类专属评论渲染成署名段落，追加到 md 正文末尾，供 mine.py 挖题与阅读。
    正文评论→正文区；站点/资源评论统一作为文末短评。"""
    parts = []
    body = comments.get("body") or []
    site = comments.get("site") or []
    resource = comments.get("resource") or []
    if body:
        parts.append("\n\n### 读者短评\n")
        for c in body:
            parts.append("\n## @%s · %s\n%s\n" % (
                c["nick"], datetime.datetime.now(BJT).strftime("%Y-%m-%d %H:%M"), c["text"]))
    extra = site + resource
    if extra:
        parts.append("\n\n### 站点与资源短评\n")
        for c in extra:
            parts.append("\n## @%s · %s\n%s\n" % (
                c["nick"], datetime.datetime.now(BJT).strftime("%Y-%m-%d %H:%M"), c["text"]))
    return "".join(parts)


def step_write_page(site, persona, editorial, seed, material_block, history, models, writing,
                    runtime_cfg=None, keywords=None):
    contract = content_contract(runtime_cfg or {})
    first_unit = contract.get("first_unit", "1 楼")
    unit_label = contract.get("unit_label", "楼层")

    recent = history["items"][-10:]
    recent_block = "\n".join("- 第 %s 页：%s" % (it.get("slug", ""), it.get("title", ""))
                             for it in recent) or "（这是第一页）"

    # v0.11：话题来自历史评论（无主笔=讨论楼层 / 有主笔=短评），措辞按来源走。
    if seed.get("kind") == "comment":
        origin = "（摘自第 %s 页《%s》里 @%s 的%s）" % (
            seed.get("from", "?"), seed.get("from_title", ""),
            seed.get("speaker", ""), seed.get("comment_kind", "评论"))
        label = "这一页要接着讨论的话题"
    else:
        origin = "（来自 %s）" % seed.get("from", "?")
        label = "这一页要讨论的问题"
    seed_block = ('%s：\n「%s」\n%s\n'
                  '**%s 必须原样摆出这句话，一个字都不要改**，后面所有%s都围绕它讨论。'
                  % (label, seed.get("text", ""), origin, first_unit, unit_label))

    # v0.8：角色分工由站点 writing.lead_mode 决定（主题 role_model 锁定能力边界），
    # 主笔随机按 seed 幂等。names_block/role_block/fields_check 都来自它。
    roles = assign_roles(runtime_cfg or {}, seed.get("text", ""), persona, writing)
    names_block = roles["names_block"]
    role_block = roles["role_block"]
    fields_check = roles["fields_check"]
    if roles.get("lead"):
        log("角色分配：主笔=%s 辅助=%d人（模型 %s）" %
            (roles["lead"], len(roles["supports"]), roles["model"]))

    # 篇幅字段泛化：unit_count/unit_words 优先，回落 floor_count/floor_words。
    # lead_support/item_list 里 fc_range 表示"辅助条数"（短评数/条目数），语义复用。
    fc_range = writing.get("unit_count") or writing["floor_count"]
    fw_range = writing.get("unit_words") or writing["floor_words"]
    # v0.10：主笔字数取站点 lead_words 上限；旧配置没有时用 main_words 兜底
    lw = writing.get("lead_words") or []
    mw = int(lw[1]) if len(lw) > 1 and lw[1] else int(writing.get("main_words") or 300)
    fc_min, fc_max = fc_range
    fw_min, fw_max = fw_range
    page_max = mw + fc_max * fw_max
    # v0.10：通用编辑规则由主题契约给默认，站点填写才覆盖
    extra = (writing.get("extra_rules") or "").strip() or \
            (contract.get("extra_rules_default") or "").strip()

    # system = 写死的通用约束 + 站点基调 + 主题系统角色。
    # v0.8：通用约束（关键词锚点 + 信源事实 + 不跑题）是框架级护栏，站点配置不再能改。
    system = ("【通用写作约束（框架强制，不可覆盖）】\n"
              "1. 只能围绕本篇问题和冻结关键词展开，不得跑题或另起话题。\n"
              "2. 所有事实性内容只能来自提供的信源素材；素材没有的不要编造、不要补充记忆里的细节。\n"
              "3. 不确定就说不确定，宁可少写也不要虚构数据、功能或来源。\n"
              "4. 素材标注的 tier 决定证据强度：L1 可陈述为事实；L2 只能作为线索/趋势；L3 只能作为问题线索，不能写成结论。\n\n")
    # v0.10：写作风格默认收进主题契约 persona_default；站点 persona.md 非空时优先覆盖。
    style = (persona or "").strip() or (contract.get("persona_default") or "").strip()
    if style:
        system += style + "\n\n"
    system += contract["system_role"]

    # 内容硬性要求：站点 writing.content_requirements 可编辑（旧名 topic_constraint 兼容）
    topic_req = (writing.get("content_requirements") or writing.get("topic_constraint") or "").strip()
    if topic_req:
        system += "\n\n【本主题的硬性要求（必须满足）】\n" + topic_req

    anchor = keyword_anchor_block(runtime_cfg or {}, seed.get("text", ""), keywords)
    fields = contract.get("output_fields") or {}
    skeleton = contract.get("skeleton") or DEFAULT_WRITE_PROMPT   # 骨架来自主题契约
    user = load_prompt(
        "write", skeleton,
        today=datetime.datetime.now(BJT).strftime("%Y-%m-%d"),
        seed=seed_block,
        anchor=anchor,
        material=material_block,
        recent=recent_block,
        mw=mw, fc_min=fc_min, fc_max=fc_max,
        fw_min=fw_min, fw_max=fw_max,
        page_max=page_max,
        names=names_block,
        role_block=role_block,
        fields_check=fields_check,
        identity_hint=identity_hint(runtime_cfg or {}),
        extra=extra,
        page_desc=contract.get("page_desc", "连载帖子的新一页"),
        first_unit=contract.get("first_unit", "1 楼"),
        unit_label=contract.get("unit_label", "楼层"),
        structure_block=contract.get("structure_block", ""),
        format_block=contract.get("format_block", ""),
        f_title=fields.get("title", "页面标题，20字以内"),
        f_question=fields.get("question", "这一页要讨论的问题（一句话）"),
        # 作者是脚本按 seed 幂等分配的主笔，直接写死进 prompt，不让模型自创署名
        f_author=(roles.get("lead") or ""),
        f_tags=json.dumps(fields.get("tags", "3~5 个标签词组成的字符串数组"), ensure_ascii=False),
        # 兼容旧缓存 prompt 里的 {{f_next_questions}} 占位符：填空，避免模型再产出续问字段
        f_next_questions="[]",
        f_content_md=fields.get("content_md", "正文内容，不含一级标题"),
    )

    return ask_json([
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ], models, temperature=0.85, timeout=WRITE_TIMEOUT)


# ---------------------------------------------------------------- 自检

def probe(sources_cfg):
    print("== 采集自检 ==")
    total = 0
    for cfg in sources_cfg.get("sources", []):
        if cfg.get("enabled", True) is False:
            print("-- %-12s 已禁用" % cfg.get("name"))
            continue
        got = src.collect_one(cfg)
        total += len(got)
        print("-- %-12s %3d 条" % (cfg.get("name"), len(got)))
        for it in got[:2]:
            print("     ·", (it.get("ts") and it["ts"].strftime("%m-%d %H:%M")) or "--", "|", it["title"][:44])
    print("合计 %d 条" % total)


# ---------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", action="store_true", help="只测采集")
    ap.add_argument("--rebuild", action="store_true", help="只按现有 md 重建整站")
    ap.add_argument("-k", "--keyword", default="", help="指定主题，跳过挖题")
    ap.add_argument("--force", action="store_true", help="今天写过也再写一页")
    args = ap.parse_args()

    site = load_site()
    runtime_cfg = load_runtime_config()
    apply_template(site)

    if args.rebuild:
        stat = sitebuilder.build_dispatch(site, DOCS, site["base_url"], runtime_cfg)
        log("重建完成：%d 页 / %d 层 / %d 字" % (stat["pages"], stat["floors"], stat["words"]))
        try:
            with open(os.path.join(DOCS, ".run_stat.json"), "w", encoding="utf-8") as f:
                json.dump({"pages": stat["pages"], "floors": stat.get("floors", 0),
                           "words": stat.get("words", 0), "model": "", "ai_calls": 0}, f)
        except Exception:
            pass
        return

    sources_cfg = load_json(os.path.join(CONFIG, "sources.json"), {"sources": []})
    if args.probe:
        probe(sources_cfg)
        return

    policy = runtime_cfg.get("request_policy") or {}
    terms_mode = (policy.get("terms_mode") or "script").lower()

    # 留空时由主题契约 persona_default 接管，不再用通用兜底压过主题风格
    persona = load_text(os.path.join(CONFIG, "persona.md"), "")
    editorial = load_text(os.path.join(CONFIG, "editorial.md"), "")
    writing = load_writing()
    # 省资源契约：脚本抽词（v0.11 起补问机制已整体移除，不再有额外请求分支）
    if terms_mode != "model":
        writing["query_terms"] = "script"
    keywords = load_keywords()
    history = load_history()
    models = resolve_models(os.environ.get("OPENROUTER_MODEL", ""))
    forced = args.keyword.strip() or os.environ.get("FORCE_KEYWORD", "").strip()

    log("模型链（%s，共 %d 个）：%s%s" % (
        "只允许免费" if free_only_enabled() else "允许付费", len(models),
        " → ".join(models[:5]), " …" if len(models) > 5 else ""))

    now = datetime.datetime.now(BJT)
    date_str = now.strftime("%Y-%m-%d")
    force_run = args.force or str(os.environ.get("FORCE_RUN", "")).lower() in ("1", "true", "yes")
    if any(it.get("date") == date_str for it in history["items"]) and not forced and not force_run:
        log("今天已经更新过（%s），只重建站点。想再写一页用 --force 或 Actions 的 force 开关。" % date_str)
        sitebuilder.build_dispatch(site, DOCS, site["base_url"], runtime_cfg)
        return

    # ---- 1. 取材（提前：内容树 gate 需要基于真实素材池判定节点是否够格）
    items = src.collect(sources_cfg.get("sources", []),
                        window_hours=sources_cfg.get("window_hours", 48))
    cands = rank_candidates(items, keywords, now)

    set_budget(int(os.environ.get("MODEL_BUDGET_SECONDS", "600")))
    log("模型总时长预算：%d 秒" % int(os.environ.get("MODEL_BUDGET_SECONDS", "600")))

    # ---- 2. 选题：手动 > 内容树 > 历史署名评论 > 信源热点
    seed = None
    # 手动指定时不加载树，避免测试/补写污染节点状态
    tree_data = None if forced else treeutil.load_tree(CONFIG)
    tree_node = None
    if forced:
        seed = {"kind": "topic", "text": forced, "from": "手动指定"}
        log("手动指定主题：" + forced)
    else:
        # 2a. 内容树：节点通过 gate 才接管选题
        if tree_data:
            term_fn = None
            if terms_mode != "model":
                term_fn = lambda text, kws, anchors_only=True: script_terms(
                    text, kws, anchors_only=anchors_only)
            tree_node, tree_stat, tree_info = treeutil.pick_topic(
                tree_data, cands, keywords, seed_key=date_str, term_fn=term_fn,
                max_sources=treeutil.enabled_source_count(sources_cfg))
            if tree_node:
                seed = {"kind": "tree", "text": tree_node["title"],
                        "from": "tree:" + str(tree_node.get("id")),
                        "node_id": tree_node.get("id"),
                        "intent": tree_node.get("intent", "")}
                log("内容树选中节点 %s《%s》：词=%d/源=%d/命中=%d（门槛 %s）"
                    % (tree_node.get("id"), tree_node["title"],
                       tree_stat["keywords"], tree_stat["sources"], tree_stat["hits"],
                       json.dumps(tree_stat["need"], ensure_ascii=False)))
            elif tree_info.get("enabled"):
                log("内容树无节点通过 gate（检查 %d 个），回退原选题链路"
                    % len(tree_info.get("checked") or []))

        # 2b. 历史署名评论（话题只来自真实评论，不再读结尾续问）
        if not seed:
            comment_kind = comment_kind_of(runtime_cfg, writing)
            compact = comment_kind == "短评"   # 文末短评偏短，放宽长度门槛
            recent_slugs = [it.get("slug") for it in history["items"][-6:]]
            topics = mine.scan_comment_topics(POSTS, exclude_slugs=recent_slugs, compact=compact)
            if not topics and recent_slugs:
                # 历史不足 6 页时排除会清空候选池；回退到全量历史，保证站群冷启动能选题
                topics = mine.scan_comment_topics(POSTS, compact=compact)
                log("排除最近页后无候选，回退到全量历史评论（%d 条）" % len(topics))
            pick = mine.pick_topic(topics, seed=date_str)
            if pick:
                seed = {"kind": "comment", "text": pick["text"], "from": pick["slug"],
                        "from_title": pick["page_title"], "speaker": pick["speaker"],
                        "comment_kind": comment_kind}
                log("从历史%s里挖到 %d 条话题（排除最近 %d 页），选中 @%s：%s"
                    % (comment_kind, len(topics), len(recent_slugs),
                       pick["speaker"], pick["text"][:60]))
            else:
                log("历史评论里没挖到话题（%d 条），走热点选题" % len(topics))

        # 2c. 热点回退
        if not seed:
            if not cands:
                sys.exit("没挖到疑问，也没抓到任何素材，本轮跳过")
            seed = {"kind": "topic", "text": cands[0]["title"], "from": cands[0]["source"]}
            log("用热点当主题：" + seed["text"])

    # ---- 3. 按选题检索：脚本抽词，不发模型请求
    search_cfg = sources_cfg.get("search") or {}
    extra = search_web(seed["text"], search_cfg)   # 元搜索没配时返回空
    if extra:
        cands = extra + cands

    # v0.6：关键词锚定策略从主题契约读取，term_source=picked_only 时抽词只围绕冻结词衍生
    kp = content_contract(runtime_cfg).get("keyword_policy") or {}
    term_source = (kp.get("term_source") or "picked_only").lower() if isinstance(kp, dict) else "picked_only"
    anchors_only = term_source == "picked_only"
    terms = extract_query_terms(seed["text"], models, keywords, terms_mode=terms_mode,
                                anchors_only=anchors_only)
    cands = rank_by_terms(cands, terms) if terms else cands
    hits = [c for c in cands if c.get("rel", 0) > 0]
    if terms_mode == "script" and len(hits) < 2:
        log("脚本抽词只命中 %d 条，按省资源契约不追加模型请求" % len(hits))

    relevant = hits[:6]
    log("检索词：%s%s ｜ 命中 %d 条相关素材（信源共 %d 条）"
        % ("、".join(terms[:3]), "…" if len(terms) > 3 else "", len(relevant), len(cands)))

    if relevant:
        for c in relevant[:3]:
            log("   · [%s] %s" % (",".join(c.get("hit_terms", [])) or "-", c["title"][:40]))
        material_block = render_material(relevant, 6)
    else:
        material_block = ("（信源里没有和这个问题直接相关的内容。"
                          "可以基于你已有的知识回答，但不要编造具体数字、价格、时间和人名。）")

    # ---- 4. 写作：唯一一次 AI 请求，一次产出全部字段
    data, resp = step_write_page(site, persona, editorial, seed, material_block, history,
                                 models, writing, runtime_cfg, keywords=keywords)

    content_md = (data.get("content_md") or data.get("content") or "").strip()

    # 标题不许出现在正文：剥掉模型可能写的一级标题，统一用 JSON 的 title
    title = (data.get("title") or "").strip()
    m = re.match(r"\A\s*#\s+(.+?)\s*\n", content_md)
    if m:
        title = title or m.group(1).strip()
        content_md = content_md[m.end():].lstrip()
    if not title:
        title = (seed.get("text") or "无题")[:20]

    _lw = writing.get("lead_words") or []
    _mw = int(_lw[1]) if len(_lw) > 1 and _lw[1] else int(writing.get("main_words") or 300)
    min_words = max(150, int(_mw * 0.5))
    if len(content_md) < min_words:
        sys.exit("产出太短（%d 字，阈值 %d），判定失败" % (len(content_md), min_words))

    # 结构化字段解析 + 链接真实性校验（站点/资源 url 必须来自信源素材）
    names_rows = load_names(active_only=True)
    comp = runtime_cfg.get("composition") or {}
    opts = comp.get("module_options") or {}
    max_links = 6
    try:
        max_links = max(1, int((opts.get("resource") or {}).get("max", 6)))
    except Exception:
        pass
    structured = parse_structured(data, content_md, material_block, names_rows, keywords,
                                  max_links=max_links)
    log("结构化：简述 %d 字 / 金句 %d 条 / 站点 %d 条(有效链接 %d) / 资源 %d 条(有效链接 %d)" % (
        len(structured["summary"]), len(structured["quotes"]),
        len(structured["links"]["sites"]),
        sum(1 for x in structured["links"]["sites"] if x["url"]),
        len(structured["links"]["resources"]),
        sum(1 for x in structured["links"]["resources"] if x["url"])))

    # md 正文：# 标题 + 正文 + 三类专属评论的署名段落（供 mine 挖题与直接阅读）
    md_body = "# " + title + "\n\n" + content_md + comments_to_md(structured["comments"])

    question = (seed["text"] if seed.get("kind") in ("question", "comment")
                else (data.get("question") or "")).strip()
    log("本篇话题：%s" % (question[:60] or "（模型自拟）"))

    roles_final = assign_roles(runtime_cfg, seed.get("text", ""), persona, writing)
    author = (roles_final.get("lead") or "").strip()
    tags = structured["tags"]
    log("头部信息：作者=%s 标签=%s" % (author or "（无主笔）", "、".join(tags) or "（无）"))

    # ---- 5. 落盘
    os.makedirs(POSTS, exist_ok=True)
    no = next_page_no(POSTS)
    slug = "%03d" % no
    used_model = resp.get("_used_model") or models[0]

    front = [
        "---",
        "title: %s" % title,
        "date: %s" % date_str,
        "page: %d" % no,
        "question: %s" % (question or ""),
        "author: %s" % author,
        "tags: %s" % json.dumps(tags, ensure_ascii=False),
        "model: %s" % used_model,
        "model_name: %s" % model_display_name(used_model),
        "---",
        "",
    ]
    with open(os.path.join(POSTS, slug + ".md"), "w", encoding="utf-8") as f:
        f.write("\n".join(front) + md_body + "\n")

    # sidecar 结构化产物：compositor 读它渲染合集页/聚合页，md 仅作正文源与挖题源
    # node_id/path 来自内容树：路由层据此把新文章放进语义目录；老文章无此字段保持 flat。
    sidecar = {
        "slug": slug,
        "page": no,
        "date": date_str,
        "title": title,
        "question": question,
        "author": author,
        "tags": tags,
        "node_id": str((tree_node or {}).get("id") or ""),
        "path": re.sub(r"[^A-Za-z0-9_-]", "", str((tree_node or {}).get("path") or "")),
        "summary": structured["summary"],
        "content_md": content_md,
        "quotes": structured["quotes"],
        "links": structured["links"],
        "comments": structured["comments"],
        "model": used_model,
        "words": len(content_md),
    }
    with open(os.path.join(POSTS, slug + ".data.json"), "w", encoding="utf-8") as f:
        json.dump(sidecar, f, ensure_ascii=False, indent=2)

    meta = {
        "date": date_str,
        "slug": slug,
        "page": no,
        "title": title,
        "question": question,
        "author": author,
        "tags": tags,
        "words": len(content_md),
        "model": used_model,
        "model_name": model_display_name(used_model),
        "seed_kind": seed.get("kind"),
    }
    history["items"].append(meta)
    with open(HISTORY, "w", encoding="utf-8") as f:
        json.dump(history, f, ensure_ascii=False, indent=2)

    try:
        with open(os.path.join(DOCS, ".model_used"), "w", encoding="utf-8") as f:
            f.write(used_model)
    except Exception:
        pass

    # ---- 5b. 内容树状态流转：回填选中节点，其余可选节点推进 prune 计数
    if tree_data:
        archived = treeutil.commit_topic(
            tree_data, tree_node, {"slug": slug, "title": title}, date_str)
        treeutil.save_tree(tree_data, CONFIG)
        log("内容树：第 %d 轮，%s，剪枝 %s"
            % (tree_data["round"],
               ("节点 %s → done" % tree_node.get("id")) if tree_node else "本轮非树选题",
               ",".join(archived) or "无"))

    # ---- 6. 建站（compositor 按模块组合渲染合集页与聚合页）
    stat = sitebuilder.build_dispatch(site, DOCS, site["base_url"], runtime_cfg)

    u = resp.get("usage") or {}
    log("完成：第 %d 页《%s》 %d 字 | 站内共 %d 页 | tokens %s | AI 请求 %d 次" % (
        no, title, len(content_md), stat["pages"], u.get("total_tokens", "?"), AI_CALLS))

    # 供 workflow 回写状态使用
    run_stat = {
        "pages": stat["pages"],
        "floors": stat.get("floors", 0),
        "words": stat.get("words", 0),
        "model": used_model,
        "ai_calls": AI_CALLS,
    }
    try:
        with open(os.path.join(DOCS, ".run_stat.json"), "w", encoding="utf-8") as f:
            json.dump(run_stat, f, ensure_ascii=False)
    except Exception:
        pass


def _dump_error(msg):
    try:
        with open("/tmp/daily_error.txt", "w", encoding="utf-8") as f:
            f.write(str(msg)[:500])
    except Exception:
        pass


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        if e.code not in (0, None):
            _dump_error(e.code)
        raise
    except Exception as e:
        _dump_error(repr(e))
        raise
