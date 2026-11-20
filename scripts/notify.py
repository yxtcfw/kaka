#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把本次运行结果推到企业微信群机器人。
没配 WECOM_WEBHOOK 就静默跳过，不影响主流程。

用法（workflow 里）：
  WECOM_WEBHOOK=... STATUS=success|fail RUN_URL=... python scripts/notify.py
"""

import datetime
import json
import os
import sys
import urllib.request

BJT = datetime.timezone(datetime.timedelta(hours=8))


def load_today(docs="docs"):
    """从 .topics.json 找今天那条，找到说明今天发成功了"""
    try:
        with open(os.path.join(docs, ".topics.json"), encoding="utf-8") as f:
            items = json.load(f).get("items", [])
    except Exception:
        return None

    today = datetime.datetime.now(BJT).strftime("%Y-%m-%d")
    for it in reversed(items):
        if it.get("date") == today:
            return it
    return None


def post(url, payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read().decode("utf-8", "replace")


def main():
    webhook = os.environ.get("WECOM_WEBHOOK", "").strip()
    if not webhook:
        print("[notify] 未配置 WECOM_WEBHOOK，跳过推送")
        return 0

    site = os.environ.get("SITE_NAME") or "每日一篇"
    base = (os.environ.get("SITE_BASE_URL") or "").rstrip("/")
    status = (os.environ.get("STATUS") or "success").strip()
    run_url = os.environ.get("RUN_URL", "").strip()

    item = load_today()

    if item and status == "success":
        article = ("%s/posts/%s.html" % (base, item["slug"])) if base else ""
        lines = [
            "**%s · 今日已更新**" % site,
            "> 标题：%s" % item.get("title", ""),
        ]
        if item.get("keyword"):
            lines.append("> 板块：%s" % item["keyword"])
        stat = []
        if item.get("words"):
            stat.append("%s 字" % item["words"])
        if item.get("model_name") or item.get("model"):
            stat.append("模型 %s" % (item.get("model_name") or item.get("model")))
        if stat:
            lines.append("> %s" % " · ".join(stat))
        if article:
            lines.append("[查看文章](%s)" % article)
        content = "\n".join(lines)
    else:
        reason = ""
        try:
            with open("/tmp/daily_error.txt", encoding="utf-8") as f:
                reason = f.read().strip()[:300]
        except Exception:
            pass
        content = "**<font color=\"warning\">%s · 今天没生成文章</font>**\n> 原因：%s" % (
            site, reason or "任务失败，详情看运行日志")
        if run_url:
            content += "\n[打开运行日志](%s)" % run_url

    try:
        resp = post(webhook, {"msgtype": "markdown", "markdown": {"content": content}})
        print("[notify] 已推送：", resp[:160])
    except Exception as e:
        # 通知失败不该让整个任务变红
        print("[notify] 推送失败（不影响主流程）：%r" % e)
    return 0


if __name__ == "__main__":
    sys.exit(main())
