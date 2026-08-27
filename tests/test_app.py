# -*- coding: utf-8 -*-
"""PJ Board 回帰テスト。実行: python -m pytest tests/ -q
一時DBを使うため既存データには影響しない。"""
import os
import sys
import tempfile

TMP = tempfile.mkdtemp()
os.environ["PJBOARD_DB"] = os.path.join(TMP, "test.db")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402
import app as appmod  # noqa: E402

client = TestClient(appmod.app)
H = {"X-Requested-With": "fetch"}   # CSRFヘッダー（Cookieセッション時に必須）


def login(member_id, password=""):
    # メールログイン化に伴い、シードのダミーメール（user{id}@example.com）で認証する
    r = client.post("/api/auth/login",
                    json={"email": f"user{member_id}@example.com", "password": password},
                    headers=H)
    assert r.status_code == 200, r.text
    return r


def logout():
    client.post("/api/auth/logout", json={}, headers=H)
    client.cookies.clear()


def test_healthz():
    assert client.get("/healthz").json()["ok"] is True


def test_bootstrap_and_seed():
    d = client.get("/api/bootstrap").json()
    assert len(d["projects"]) >= 1
    assert len(d["users"]) >= 4
    assert any(u["org_role"] == "manager" for u in d["users"])


def test_login_flow_and_me():
    assert client.get("/api/auth/me").status_code == 401
    login(1)
    me = client.get("/api/auth/me").json()
    assert me["id"] == 1 and "password_hash" not in me
    logout()
    assert client.get("/api/auth/me").status_code == 401


def test_csrf_required_with_session():
    login(1)
    # ヘッダーなしの書き込みは403
    r = client.post("/api/projects/1/tasks", json={"title": "x"})
    assert r.status_code == 403
    # ヘッダーありは通る
    r = client.post("/api/projects/1/tasks", json={"title": "csrf-ok", "actor_id": 1},
                    headers=H)
    assert r.status_code == 200
    logout()


def test_permission_matrix():
    """member=自分のタスクのみ・日程不可 / 未アサイン社内=閲覧+コメント / manager=暗黙admin"""
    boot = client.get("/api/bootstrap").json()
    users = {u["name"]: u for u in boot["users"]}
    suzuki = users["鈴木 一郎"]["id"]        # PJ1 member
    d = client.get("/api/projects/1/data").json()
    own = next(t for t in d["tasks"] if t["assignee_id"] == suzuki)
    other = next(t for t in d["tasks"] if t["assignee_id"] not in (suzuki, None))

    login(suzuki)
    ok = client.patch(f"/api/tasks/{own['id']}",
                      json={"progress": own["progress"], "actor_id": suzuki}, headers=H)
    assert ok.status_code == 200
    ng = client.patch(f"/api/tasks/{own['id']}",
                      json={"due_date": "2099-01-01", "actor_id": suzuki}, headers=H)
    assert ng.status_code == 403
    ng2 = client.patch(f"/api/tasks/{other['id']}",
                       json={"progress": 1, "actor_id": suzuki}, headers=H)
    assert ng2.status_code == 403
    # 他ユーザーへの偽装は403（一般ユーザー）
    assert client.get("/api/projects/1/data?user_id=1").status_code == 403
    logout()

    # manager（田中）は暗黙admin
    login(1)
    ok2 = client.patch(f"/api/tasks/{own['id']}",
                       json={"due_date": own["due_date"], "actor_id": 1}, headers=H)
    assert ok2.status_code == 200
    logout()


def test_optimistic_lock():
    login(1)
    d = client.get("/api/projects/1/data").json()
    t = d["tasks"][0]
    r = client.patch(f"/api/tasks/{t['id']}",
                     json={"progress": t["progress"], "actor_id": 1,
                           "expected_updated_at": "1999-01-01 00:00:00"}, headers=H)
    assert r.status_code == 409
    logout()


def test_soft_delete_and_restore():
    login(1)
    t = client.post("/api/projects/1/tasks",
                    json={"title": "trash-me", "actor_id": 1}, headers=H).json()
    client.delete(f"/api/tasks/{t['id']}?actor_id=1", headers=H)
    ids = [x["id"] for x in client.get("/api/projects/1/data").json()["tasks"]]
    assert t["id"] not in ids
    trash = client.get("/api/projects/1/trash").json()
    assert any(x["id"] == t["id"] for x in trash["tasks"])
    client.post(f"/api/tasks/{t['id']}/restore", json={"actor_id": 1}, headers=H)
    ids = [x["id"] for x in client.get("/api/projects/1/data").json()["tasks"]]
    assert t["id"] in ids
    logout()


def test_notifications_on_mention_and_assign():
    login(1)
    d = client.get("/api/projects/1/data").json()
    suzuki = next(m for m in d["members"] if "鈴木" in m["name"])
    t = next(x for x in d["tasks"] if x["assignee_id"] == suzuki["id"])
    client.post(f"/api/tasks/{t['id']}/comments",
                json={"body": f"@{suzuki['name'].replace(' ', '')} 確認お願いします",
                      "author_id": 1}, headers=H)
    logout()
    login(suzuki["id"])
    n = client.get(f"/api/notifications?user_id={suzuki['id']}").json()
    assert n["unread"] >= 1
    assert any(x["type"] == "mention" for x in n["items"])
    logout()


def test_search():
    login(1)
    r = client.get("/api/search?q=設計&user_id=1").json()
    assert "tasks" in r and "comments" in r and "notes" in r
    logout()


def test_api_token_auth():
    login(1)
    tok = client.post("/api/tokens", json={"label": "test"}, headers=H).json()["token"]
    logout()
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {tok}"})
    assert me.status_code == 200 and me.json()["id"] == 1


def test_login_throttle():
    login(1)
    client.post("/api/auth/password", json={"current_password": "", "new_password": "pw1"},
                headers=H)
    logout()
    for _ in range(5):
        client.post("/api/auth/login",
                    json={"email": "user1@example.com", "password": "bad"}, headers=H)
    r = client.post("/api/auth/login",
                    json={"email": "user1@example.com", "password": "pw1"}, headers=H)
    assert r.status_code == 429
    # 後始末（DBを直接触ってロック解除・パスワード解除）
    with appmod.db() as conn:
        conn.execute("DELETE FROM login_logs")
        conn.execute("UPDATE members SET password_hash=NULL WHERE id=1")


def test_metrics_and_baseline():
    login(1)
    m = client.get("/api/projects/1/metrics").json()
    assert len(m["burndown"]) == 30 and "effort" in m and "risks" in m
    r = client.post("/api/projects/1/baselines", json={"actor_id": 1}, headers=H)
    assert r.status_code == 200
    b = client.get("/api/projects/1/baseline").json()
    assert b["exists"] is True and len(b["snapshot"]) > 0
    logout()


def test_export_endpoints():
    for ext in ("csv", "xlsx", "html", "json"):
        assert client.get(f"/api/projects/1/export.{ext}").status_code == 200
    assert client.get("/api/projects/1/calendar.ics").status_code == 200


def test_email_login_and_debug_login():
    # 存在しないメールは401（存在有無を悟らせない共通メッセージ）
    r = client.post("/api/auth/login", json={"email": "nobody@example.com"}, headers=H)
    assert r.status_code == 401
    # デバッグログインは未ログイン＋名前指定で可（開発時のみ）
    r = client.post("/api/auth/debug-login", json={"name": "田中 太郎"}, headers=H)
    assert r.status_code == 200 and r.json()["user"]["name"] == "田中 太郎"
    logout()


def test_parent_progress_autocalc():
    """サブタスクを持つタスクの進捗は子の平均から自動算出（直接指定は無視）。"""
    login(1)
    mk = lambda body: client.post("/api/projects/1/tasks",
                                  json={**body, "actor_id": 1}, headers=H).json()
    parent = mk({"title": "進捗自動テスト親"})
    c1 = mk({"title": "子1", "parent_id": parent["id"]})
    mk({"title": "子2", "parent_id": parent["id"]})
    client.patch(f"/api/tasks/{c1['id']}",
                 json={"progress": 100, "actor_id": 1}, headers=H)
    d = client.get(f"/api/tasks/{parent['id']}/detail").json()
    assert d["task"]["progress"] == 50          # (100 + 0) / 2
    # 親タスクへの直接指定は無視され自動算出値が維持される
    r = client.patch(f"/api/tasks/{parent['id']}",
                     json={"progress": 10, "actor_id": 1}, headers=H)
    assert r.status_code == 200
    d = client.get(f"/api/tasks/{parent['id']}/detail").json()
    assert d["task"]["progress"] == 50
    logout()


def test_status_progress_sync():
    """進捗0=未着手 / 1-99=進行中 / 100=完了 の双方向連動。"""
    login(1)
    t = client.post("/api/projects/1/tasks",
                    json={"title": "連動テスト", "actor_id": 1}, headers=H).json()
    sts = client.get("/api/projects/1/data").json()["statuses"]
    first = sts[0]
    mid = next(s for s in sts if "進行" in s["name"])
    done = next(s for s in sts if s["is_done"])
    patch = lambda body: client.patch(f"/api/tasks/{t['id']}",
                                      json={**body, "actor_id": 1}, headers=H).json()
    assert patch({"progress": 40})["status_id"] == mid["id"]
    assert patch({"progress": 100})["status_id"] == done["id"]
    assert patch({"status_id": first["id"]})["progress"] == 0
    assert patch({"status_id": mid["id"]})["progress"] == 50
    r = patch({"progress": 0})
    assert r["status_id"] == first["id"] and r["progress"] == 0
    # 中間ステータス（レビュー中等）は 1-99 の進捗変更で上書きしない
    review = next((s for s in sts if not s["is_done"] and s["id"] != first["id"]
                   and "進行" not in s["name"]), None)
    if review:
        patch({"status_id": review["id"]})
        assert patch({"progress": 80})["status_id"] == review["id"]
    logout()


def test_view_xlsx_export():
    login(1)
    for view in ("table", "wbs", "board", "calendar"):
        r = client.post("/api/projects/1/export/view.xlsx",
                        json={"view": view}, headers=H)
        assert r.status_code == 200 and len(r.content) > 2000, view
    logout()


def test_member_email_required_and_unique():
    login(1)
    base = {"name": "メール必須テスト", "role": "", "color": "#111111"}
    r = client.post("/api/members", json={**base, "email": ""}, headers=H)
    assert r.status_code == 400
    r = client.post("/api/members", json={**base, "email": "user1@example.com"}, headers=H)
    assert r.status_code == 400          # 既存と重複
    r = client.post("/api/members", json={**base, "email": "New.User@Example.com"},
                    headers=H)
    assert r.status_code == 200 and r.json()["email"] == "new.user@example.com"
    logout()
