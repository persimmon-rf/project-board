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
    r = client.post("/api/auth/login", json={"member_id": member_id, "password": password},
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
        client.post("/api/auth/login", json={"member_id": 1, "password": "bad"}, headers=H)
    r = client.post("/api/auth/login", json={"member_id": 1, "password": "pw1"}, headers=H)
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
