# -*- coding: utf-8 -*-
"""
PJ Board MCP サーバー（依存パッケージなし・標準ライブラリのみ）

MCP (Model Context Protocol) の stdio トランスポートを最小実装し、
PJ Board の REST API をツールとして AI クライアントに公開する。

登録例（Claude Code の .mcp.json）:
{
  "mcpServers": {
    "pjboard": {
      "command": "python",
      "args": ["D:/claude/会社/プロジェクト管理/mcp_server.py"],
      "env": { "PJBOARD_URL": "http://localhost:8100", "PJBOARD_ACTOR_ID": "1" }
    }
  }
}
"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("PJBOARD_URL", "http://localhost:8100").rstrip("/")
ACTOR = os.environ.get("PJBOARD_ACTOR_ID")
TOKEN = os.environ.get("PJBOARD_TOKEN")   # APIトークン（本番で素通しを閉じた場合の認証手段）

PROTOCOL_VERSION = "2024-11-05"


def http(method: str, path: str, body: dict | None = None):
    url = BASE + path
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read().decode()).get("detail", str(e))
        except Exception:
            detail = str(e)
        return {"error": f"HTTP {e.code}: {detail}"}
    except Exception as e:
        return {"error": f"PJ Board に接続できません ({url}): {e}"}


def with_actor(body: dict) -> dict:
    if ACTOR and "actor_id" not in body:
        body["actor_id"] = int(ACTOR)
    return body


# ---------------------------------------------------------------- tools定義

TOOLS = [
    {"name": "list_projects",
     "description": "全プロジェクトの一覧と進捗サマリーを取得する。最初に呼ぶと全体像がわかる。",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "get_project",
     "description": "1プロジェクトの全データ（WBSタスク一覧・ステータス・共有ノート・全コメント）を取得する。",
     "inputSchema": {"type": "object", "required": ["project_id"], "properties": {
         "project_id": {"type": "integer", "description": "プロジェクトID"}}}},
    {"name": "create_task",
     "description": "タスクを作成する。status_id は get_project の statuses から選ぶ（省略時は先頭列）。",
     "inputSchema": {"type": "object", "required": ["project_id", "title"], "properties": {
         "project_id": {"type": "integer"},
         "title": {"type": "string"},
         "description": {"type": "string"},
         "status_id": {"type": "integer"},
         "assignee_id": {"type": "integer", "description": "担当ユーザーID"},
         "parent_id": {"type": "integer", "description": "親タスクID（サブタスクにする場合）"},
         "start_date": {"type": "string", "description": "YYYY-MM-DD"},
         "due_date": {"type": "string", "description": "YYYY-MM-DD"},
         "priority": {"type": "string", "enum": ["highest", "high", "medium", "low"]}}}},
    {"name": "update_task",
     "description": "タスクを部分更新する（渡したフィールドのみ反映）。進捗更新・担当変更・日程変更など。",
     "inputSchema": {"type": "object", "required": ["task_id"], "properties": {
         "task_id": {"type": "integer"},
         "title": {"type": "string"}, "description": {"type": "string"},
         "status_id": {"type": "integer"}, "assignee_id": {"type": ["integer", "null"]},
         "progress": {"type": "integer", "minimum": 0, "maximum": 100},
         "start_date": {"type": ["string", "null"]}, "due_date": {"type": ["string", "null"]},
         "priority": {"type": "string"}, "parent_id": {"type": ["integer", "null"]}}}},
    {"name": "get_task",
     "description": "タスク1件の詳細（コメントスレッド・サブタスク・関連リンク・変更履歴）を取得する。",
     "inputSchema": {"type": "object", "required": ["task_id"], "properties": {
         "task_id": {"type": "integer"}}}},
    {"name": "add_comment",
     "description": "タスクのコメントスレッドに発言を投稿する（イシュー/議論機能と同一データ）。",
     "inputSchema": {"type": "object", "required": ["task_id", "body"], "properties": {
         "task_id": {"type": "integer"},
         "body": {"type": "string", "description": "コメント本文。@名前 でメンション可"}}}},
    {"name": "list_discussions",
     "description": "プロジェクト内のコメントスレッド一覧（どのタスクで議論が起きているか）を取得する。",
     "inputSchema": {"type": "object", "required": ["project_id"], "properties": {
         "project_id": {"type": "integer"}}}},
    {"name": "get_notes",
     "description": "プロジェクトの共有ノート（検証環境・体制・定例ルール・使用ツール等）を取得する。",
     "inputSchema": {"type": "object", "required": ["project_id"], "properties": {
         "project_id": {"type": "integer"}}}},
    {"name": "update_note",
     "description": "共有ノートの内容を更新する。",
     "inputSchema": {"type": "object", "required": ["note_id"], "properties": {
         "note_id": {"type": "integer"},
         "title": {"type": "string"}, "content": {"type": "string"},
         "category": {"type": "string"}}}},
    {"name": "user_overview",
     "description": "指定ユーザー視点の横断サマリー（関与PJ・担当タスク・期限超過）を取得する。",
     "inputSchema": {"type": "object", "required": ["user_id"], "properties": {
         "user_id": {"type": "integer"}}}},
]


def call_tool(name: str, args: dict):
    if name == "list_projects":
        return http("GET", "/api/ai/context")
    if name == "get_project":
        return http("GET", f"/api/ai/context?project_id={args['project_id']}")
    if name == "create_task":
        pid = args.pop("project_id")
        return http("POST", f"/api/projects/{pid}/tasks", with_actor(args))
    if name == "update_task":
        tid = args.pop("task_id")
        return http("PATCH", f"/api/tasks/{tid}", with_actor(args))
    if name == "get_task":
        q = f"?user_id={ACTOR}" if ACTOR else ""
        return http("GET", f"/api/tasks/{args['task_id']}/detail{q}")
    if name == "add_comment":
        tid = args.pop("task_id")
        body = {"body": args["body"]}
        if ACTOR:
            body["author_id"] = int(ACTOR)
        return http("POST", f"/api/tasks/{tid}/comments", body)
    if name == "list_discussions":
        return http("GET", f"/api/projects/{args['project_id']}/discussions")
    if name == "get_notes":
        return http("GET", f"/api/projects/{args['project_id']}/notes")
    if name == "update_note":
        nid = args.pop("note_id")
        return http("PATCH", f"/api/notes/{nid}", with_actor(args))
    if name == "user_overview":
        return http("GET", f"/api/overview?user_id={args['user_id']}")
    return {"error": f"unknown tool: {name}"}


# ---------------------------------------------------------------- JSON-RPC loop

def reply(id_, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": id_}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        line = line.strip().lstrip("﻿")
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        method = req.get("method", "")
        id_ = req.get("id")
        if method == "initialize":
            reply(id_, {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "pjboard", "version": "0.3.0"},
                "instructions": (
                    "PJ Board（社内プロジェクト管理）を操作するツール群。"
                    "まず list_projects で全体像を、get_project で詳細を取得してから操作すること。"
                    "書き込みは PJBOARD_ACTOR_ID のユーザー権限で行われる。"),
            })
        elif method == "notifications/initialized":
            pass
        elif method == "ping":
            reply(id_, {})
        elif method == "tools/list":
            reply(id_, {"tools": TOOLS})
        elif method == "tools/call":
            params = req.get("params", {})
            result = call_tool(params.get("name", ""), dict(params.get("arguments") or {}))
            is_err = isinstance(result, dict) and "error" in result
            reply(id_, {
                "content": [{"type": "text",
                             "text": json.dumps(result, ensure_ascii=False, indent=1)}],
                "isError": is_err,
            })
        elif id_ is not None:
            reply(id_, error={"code": -32601, "message": f"method not found: {method}"})


if __name__ == "__main__":
    main()
