#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把本次分站运行状态提交回主站仓库 config/status/<id>.json。

需要环境变量：
  MAIN_STATUS_TOKEN  对主站仓库有 contents:write 的 token
  SITE_ID            站点 id，默认 kaka
  RUN_RESULT         success / failed，默认 success
  ERROR_MESSAGE      失败原因（可选）
  AI_CALLS           本次实际模型请求次数，默认 0
  PAGES/FLOORS/WORDS 统计数字（可选）
  MODEL              使用的模型（可选）
  RUN_URL            本次 Actions 运行地址（可选）
"""

import base64
import datetime
import json
import os
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(ROOT, "config")
SITE_ID = os.environ.get("SITE_ID", "kaka").strip() or "kaka"
TOKEN = os.environ.get("MAIN_STATUS_TOKEN", "").strip()
MAIN_REPO = os.environ.get("MAIN_REPO", "yxtcfw/yxtcfw.github.io").strip()
BRANCH = os.environ.get("MAIN_BRANCH", "master").strip()
API = "https://api.github.com/repos/%s/contents/config/status/%s.json" % (MAIN_REPO, SITE_ID)


def log(*a):
    print("[writeback_status]", *a, flush=True)


def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def api_request(method, url, payload=None):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("Authorization", "Bearer " + TOKEN)
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "kaka-status-writeback/1.0")
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read().decode("utf-8"))


def build_status():
    gen = load_json(os.path.join(CONFIG, "generated.json"), {})
    slots = gen.get("slots") or {}
    result = os.environ.get("RUN_RESULT", "success").strip() or "success"
    status = {
        "schema_version": "1.0.0",
        "site_id": SITE_ID,
        "last_run_at": datetime.datetime.now(datetime.timezone.utc)
                       .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "result": result,
        "config_sha256": gen.get("config_sha256", ""),
        "global_sha256": {},
        "theme": gen.get("theme", ""),
        "slots_used": {
            "virtual_users": (slots.get("virtual_users") or {}).get("position", ""),
            "ads": (slots.get("ads") or {}).get("position", ""),
        },
        "ai_calls": int(os.environ.get("AI_CALLS", "0") or 0),
        "pages": int(os.environ.get("PAGES", "0") or 0),
        "floors": int(os.environ.get("FLOORS", "0") or 0),
        "words": int(os.environ.get("WORDS", "0") or 0),
        "model": os.environ.get("MODEL", ""),
        "error": os.environ.get("ERROR_MESSAGE", "") if result == "failed" else "",
        "run_url": os.environ.get("RUN_URL", ""),
    }
    return status


def main():
    if not TOKEN:
        log("MAIN_STATUS_TOKEN 未设置，跳过状态回写")
        return

    status = build_status()
    content = json.dumps(status, ensure_ascii=False, indent=2) + "\n"

    sha = ""
    try:
        current = api_request("GET", API)
        sha = current.get("sha", "")
    except urllib.error.HTTPError as e:
        if e.code != 404:
            log("读取现有状态失败（HTTP %s），尝试直接创建" % e.code)
    except Exception as e:
        log("读取现有状态失败（%r），尝试直接创建" % e)

    payload = {
        "message": "chore: status %s from %s [skip ci]" % (status["result"], SITE_ID),
        "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
        "branch": BRANCH,
    }
    if sha:
        payload["sha"] = sha

    try:
        api_request("PUT", API, payload)
        log("状态已回写：%s / %s" % (status["result"], status["last_run_at"]))
    except Exception as e:
        log("回写失败：%r" % e)
        sys.exit(1)


if __name__ == "__main__":
    main()
