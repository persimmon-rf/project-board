/* ================= app.js — 状態管理・ルーティング・モーダル ================= */

const State = {
  projects: [], users: [], orgs: [],
  members: [],           // 現在のプロジェクトのメンバー（担当者候補はここから）
  projectMembers: [],    // 全PJのメンバーシップ {project_id, member_id, role, ...}
  myRole: null,          // 現在PJでの自分のロール（admin/member/viewer/external/null）
  myFlags: { can_view_comments: 1, can_view_detail: 1 },
  pid: null, project: null, statuses: [], tasks: [], activities: [],
  view: 'home',
  boardGroup: 'status',
  currentUserId: null,
  filters: { keyword: '', assignee: '', priority: '', tag: '', hideDone: false },
  tableSort: { key: null, dir: 'asc' },
  ganttCollapsed: new Set(),
};

function statusMap() { return Object.fromEntries(State.statuses.map(s => [s.id, s])); }
// 表示名の解決は全ユーザー辞書で行う（PJから外れた担当者の名前も出せるように）
function memberMap() { return Object.fromEntries(State.users.map(m => [m.id, m])); }
function orgMap() { return Object.fromEntries(State.orgs.map(o => [o.id, o])); }

/* ---------------- 権限（UI側。最終判定はサーバー） ---------------- */
// 【2層モデル】組織ロール（マネージャー/プロ職は全PJの暗黙管理者）× PJロール
const ROLE_LABEL = { leader: 'リーダー', member: 'メンバー', advisor: 'ご意見番', external: '外部' };
const EFF_LABEL = { admin: '管理者', member: 'メンバー', advisor: 'ご意見番', viewer: '閲覧', external: '外部' };
const ORG_ROLE_LABEL = { manager: 'マネージャー', site_admin: 'サイト管理者',
                         professional: 'プロ職', staff: '一般' };
const ORG_RANK = { manager: 4, site_admin: 3, professional: 2, staff: 1 };
function loginRank() {
  return State.loginUser ? (ORG_RANK[State.loginUser.org_role] || 1) : 0;
}
// 右上=ログイン完全切替（開発時専用・全ユーザーに表示。本番は PJBOARD_DEBUG=0 で消える）
// 左下=表示のみ切替（マネージャー専用・本番でも残る運用想定）
function canDebugLogin() {
  return !!State.loginUser && State.loginUser.debug_enabled !== false;
}
function canImpersonate() {
  return State.loginUser && State.loginUser.account_type !== 'external' && loginRank() >= 4;
}
function isImpersonating() {
  return State.loginUser && State.currentUserId !== State.loginUser.id;
}
const MEMBER_FIELDS = new Set(['status_id', 'progress', 'actual_h', 'description',
                               'tags', 'custom_values', 'title']);
const MEMBER_SCHEDULE_FIELDS = new Set(['start_date', 'due_date', 'estimate_h']);

function currentUser() { return memberMap()[State.currentUserId]; }
// プロジェクト設定の取得（既定値はサーバー側でマージ済み）
function pset(key) {
  return State.project && State.project.settings ? State.project.settings[key] : undefined;
}
function canManageProject() { return State.myRole === 'admin'; }
function canCreateTask() {
  if (State.myRole === 'admin') return true;
  return State.myRole === 'member' && pset('member_can_create_tasks') !== false;
}
function canEditTask(t) {
  if (State.myRole === 'admin') return true;
  if (State.myRole === 'member') return t.assignee_id === State.currentUserId;
  return false;
}
function canEditField(t, field) {
  if (State.myRole === 'admin') return true;
  if (State.myRole === 'member') {
    if (t.assignee_id === State.currentUserId) {
      if (MEMBER_FIELDS.has(field)) return true;
      return pset('member_can_edit_own_schedule') === true && MEMBER_SCHEDULE_FIELDS.has(field);
    }
    // 未割当タスクを自分で拾う（セルフアサイン）だけは許可
    return field === 'assignee_id' && t.assignee_id == null;
  }
  return false;
}
// コメント可否はサーバーが実効権限＋PJ設定から計算した値を使う
function canComment() { return !!State.myCanComment; }
function canViewComments() {
  if (State.myRole === 'external') return !!State.myFlags.can_view_comments;
  return true;
}
function canEditNotes() {
  if (State.myRole === 'admin') return true;
  return State.myRole === 'member' && pset('member_can_edit_notes') !== false;
}
function canSchedule() { return State.myRole === 'admin'; }
function fieldVisible(key) { return pset('show_' + key) !== false; }

function filteredTasks() {
  const f = State.filters;
  const smap = statusMap();
  const kw = f.keyword.toLowerCase();
  return State.tasks.filter(t => {
    if (kw && !(t.title.toLowerCase().includes(kw) ||
                (t.description || '').toLowerCase().includes(kw) ||
                t.tags.some(tg => tg.toLowerCase().includes(kw)))) return false;
    if (f.assignee === 'none' && t.assignee_id) return false;
    if (f.assignee && f.assignee !== 'none' && t.assignee_id !== Number(f.assignee)) return false;
    if (f.priority && t.priority !== f.priority) return false;
    if (f.tag && !t.tags.includes(f.tag)) return false;
    if (f.hideDone && smap[t.status_id] && smap[t.status_id].is_done) return false;
    return true;
  });
}

/* ---------------- toast ---------------- */
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ---------------- 通知センター ---------------- */
async function refreshNotifications() {
  if (!State.loginUser) return;
  try {
    State.notifs = await API.notifications(State.currentUserId);
  } catch (e) { return; }
  const badge = document.getElementById('notif-badge');
  const n = State.notifs.unread;
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.classList.toggle('hidden', !n);
}

const NOTIF_ICON = { mention: '💬', assign: '📌', comment: '🗨', status: '🔄',
                     due: '⏰', watch: '👁', system: 'ℹ' };

function renderNotifMenu() {
  const menu = document.getElementById('notif-menu');
  const items = (State.notifs && State.notifs.items) || [];
  menu.innerHTML = `
    <div class="notif-head">🔔 通知
      <span class="spacer"></span>
      <button class="btn sm ghost" id="notif-readall">すべて既読</button></div>
    ${items.map(nf => `
      <div class="notif-item ${nf.read ? '' : 'unread'}" data-nid="${nf.id}"
           data-pid="${nf.project_id || ''}" data-tid="${nf.task_id || ''}">
        <span class="notif-ic">${NOTIF_ICON[nf.type] || 'ℹ'}</span>
        <div class="notif-body">
          <div>${U.esc(nf.message)}</div>
          <div class="notif-meta">${U.esc(nf.project_name || '')} ・ ${U.esc((nf.created_at || '').slice(5, 16))}</div>
        </div>
      </div>`).join('') ||
      '<div class="empty-note" style="padding:14px">通知はありません</div>'}`;
  document.getElementById('notif-readall').onclick = async (e) => {
    e.stopPropagation();
    await API.readNotifications(State.currentUserId);
    await refreshNotifications();
    renderNotifMenu();
  };
  menu.querySelectorAll('.notif-item').forEach(el => {
    el.onclick = async () => {
      await API.readNotifications(State.currentUserId, [Number(el.dataset.nid)]);
      refreshNotifications();
      document.getElementById('notif-dd').classList.remove('open');
      const pid = Number(el.dataset.pid), tid = Number(el.dataset.tid);
      if (pid) {
        if (State.pid !== pid) await loadProject(pid);
        if (['home', 'admin'].includes(State.view)) State.view = 'board';
        render();
        if (tid) openDetail(tid);
      }
    };
  });
}

/* ---------------- SSE（簡易リアルタイム） ---------------- */
let sseSeq = null, sseTimer = null;
function startSSE() {
  try {
    const es = new EventSource('/api/events');
    es.onmessage = (e) => {
      const d = JSON.parse(e.data);
      if (sseSeq !== null && d.seq > sseSeq) {
        refreshNotifications();
        // 自分以外の更新で、モーダル等を開いていなければ静かに再読込
        if (d.project_id === State.pid && d.actor_id !== State.currentUserId) {
          const busy = detailTaskId ||
            !document.getElementById('modal-overlay').classList.contains('hidden') ||
            ['settings', 'thread'].includes(State.view);
          clearTimeout(sseTimer);
          sseTimer = setTimeout(async () => {
            if (busy) { toast('他のユーザーがこのプロジェクトを更新しました'); return; }
            await refresh();
          }, 800);
        }
      }
      sseSeq = d.seq;
    };
  } catch (e) { /* SSE非対応環境では無視 */ }
}

/* ---------------- 横断検索 (Ctrl+K) ---------------- */
function openSearch() {
  document.getElementById('search-overlay').classList.remove('hidden');
  const inp = document.getElementById('search-input');
  inp.value = '';
  document.getElementById('search-results').innerHTML =
    '<div class="empty-note" style="padding:14px">キーワードを入力してください</div>';
  inp.focus();
}
function closeSearch() {
  document.getElementById('search-overlay').classList.add('hidden');
}

async function runSearch(q) {
  const box = document.getElementById('search-results');
  if (!q.trim()) { box.innerHTML = ''; return; }
  let d;
  try { d = await API.search(q, State.currentUserId); }
  catch (e) { box.innerHTML = `<div class="empty-note">${U.esc(e.message)}</div>`; return; }
  const sec = (title, rows) => rows.length
    ? `<div class="sr-head">${title}（${rows.length}）</div>` + rows.join('') : '';
  box.innerHTML =
    sec('📋 タスク', d.tasks.map(t => `
      <div class="sr-item" data-kind="task" data-pid="${t.project_id}" data-tid="${t.id}">
        <b>${U.esc(t.title)}</b><span class="sr-sub">${U.esc(t.project_name)}</span></div>`)) +
    sec('💬 コメント', d.comments.map(c => `
      <div class="sr-item" data-kind="comment" data-pid="${c.project_id}" data-tid="${c.task_id}">
        ${U.esc(c.body.length > 70 ? c.body.slice(0, 70) + '…' : c.body)}
        <span class="sr-sub">${U.esc(c.task_title)} / ${U.esc(c.author_name || '')}</span></div>`)) +
    sec('📖 ノート', d.notes.map(n => `
      <div class="sr-item" data-kind="note" data-pid="${n.project_id}">
        <b>${U.esc(n.title)}</b><span class="sr-sub">${U.esc(n.project_name)} / ${U.esc(n.category)}</span></div>`)) ||
    '<div class="empty-note" style="padding:14px">該当なし</div>';
  box.querySelectorAll('.sr-item').forEach(el => {
    el.onclick = async () => {
      closeSearch();
      const pid = Number(el.dataset.pid);
      if (State.pid !== pid) await loadProject(pid);
      const kind = el.dataset.kind;
      if (kind === 'note') { State.view = 'notes'; render(); return; }
      if (kind === 'comment') { openThread(Number(el.dataset.tid)); return; }
      if (['home', 'admin'].includes(State.view)) State.view = 'board';
      render();
      openDetail(Number(el.dataset.tid));
    };
  });
}

/* ---------------- 保存フィルタ ---------------- */
function renderSavedFilters() {
  const sel = document.getElementById('f-saved');
  if (!sel) return;
  const fs = State.savedFilters || [];
  sel.innerHTML = '<option value="">★ 保存フィルタ</option>' +
    fs.map(f => `<option value="${f.id}">${U.esc(f.name)}</option>`).join('') +
    (fs.length ? '<option value="__manage">🗑 フィルタを削除…</option>' : '');
}

async function bindSavedFilterEvents() {
  const sel = document.getElementById('f-saved');
  const btn = document.getElementById('f-save');
  if (!sel || sel.dataset.bound) return;
  sel.dataset.bound = '1';
  sel.onchange = async () => {
    if (sel.value === '__manage') {
      const fs = State.savedFilters || [];
      const name = prompt('削除するフィルタ名を入力:\n' + fs.map(f => '・' + f.name).join('\n'));
      const f = fs.find(x => x.name === name);
      if (f) {
        await API.deleteFilter(f.id, State.currentUserId);
        State.savedFilters = await API.listFilters(State.pid, State.currentUserId);
      }
      sel.value = '';
      renderSavedFilters();
      return;
    }
    const f = (State.savedFilters || []).find(x => x.id === Number(sel.value));
    if (!f) return;
    State.filters = { keyword: '', assignee: '', priority: '', tag: '', hideDone: false,
                      ...f.filters };
    document.getElementById('f-keyword').value = State.filters.keyword;
    document.getElementById('f-priority').value = State.filters.priority;
    document.getElementById('f-hide-done').checked = State.filters.hideDone;
    render();
  };
  btn.onclick = async () => {
    const name = prompt('このフィルタ条件に名前を付けて保存:', '');
    if (!name) return;
    await API.saveFilter(State.pid, name, State.filters, State.currentUserId);
    State.savedFilters = await API.listFilters(State.pid, State.currentUserId);
    renderSavedFilters();
    toast(`フィルタ「${name}」を保存しました`);
  };
}

/* ---------------- modal ---------------- */
function showModal(html) {
  const ov = document.getElementById('modal-overlay');
  document.getElementById('modal').innerHTML = html;
  ov.classList.remove('hidden');
  document.querySelectorAll('#modal [data-close]').forEach(b => b.onclick = closeModal);
}
function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

/* ---------------- URLハッシュ（ビュー・タスクの共有リンク） ---------------- */
function currentHash() {
  if (State.view === 'home') return '#/home';
  if (State.view === 'admin') return '#/admin';
  if (!State.pid) return '#/';
  if (State.view === 'thread') return `#/p/${State.pid}/thread/${State.threadTaskId || 0}`;
  let h = `#/p/${State.pid}/${State.view}`;
  if (typeof detailTaskId === 'number' && detailTaskId) h += `/t/${detailTaskId}`;
  return h;
}

function syncHash() {
  const h = currentHash();
  // replaceState なら hashchange は発火せず、履歴も汚さない
  if (location.hash !== h) history.replaceState(null, '', h);
}

async function applyHash() {
  if (location.hash.startsWith('#/home')) {
    State.view = 'home';
    render();
    return true;
  }
  if (location.hash.startsWith('#/admin')) {
    State.view = 'admin';
    render();
    return true;
  }
  const th = location.hash.match(/^#\/p\/(\d+)\/thread\/(\d+)/);
  if (th) {
    const pid = Number(th[1]);
    if (!State.projects.some(p => p.id === pid)) return false;
    if (State.pid !== pid) await loadProject(pid);
    State.view = 'thread';
    State.threadTaskId = Number(th[2]);
    render();
    return true;
  }
  const m = location.hash.match(/^#\/p\/(\d+)\/(dashboard|board|table|gantt|calendar|issues|notes|settings)(?:\/t\/(\d+))?/);
  if (!m) return false;
  const pid = Number(m[1]);
  if (!State.projects.some(p => p.id === pid)) return false;
  if (State.pid !== pid) await loadProject(pid);
  State.view = m[2];
  render();
  if (m[3]) openDetail(Number(m[3]));
  return true;
}

/* ---------------- data load ---------------- */
async function loadBootstrap() {
  const d = await API.bootstrap(State.currentUserId);
  State.projects = d.projects;
  State.users = d.users;
  State.orgs = d.orgs;
  State.projectMembers = d.project_members;
}

async function loadProject(pid) {
  const d = await API.projectData(pid, State.currentUserId);
  State.pid = pid;
  State.project = d.project;
  State.statuses = d.statuses;
  State.tasks = d.tasks;
  State.members = d.members;
  State.activities = d.activities;
  State.myRole = d.my_role;
  State.myProjectRole = d.my_project_role;
  State.myFlags = d.my_flags || { can_view_comments: 1, can_view_detail: 1 };
  State.myCanComment = d.my_can_comment !== false;
  try {
    State.savedFilters = await API.listFilters(pid, State.currentUserId);
  } catch (e) { State.savedFilters = []; }
  localStorage.setItem('pjboard.pid', pid);
}

async function refresh({ keepView = true } = {}) {
  if (State.pid) await loadProject(State.pid);
  render();
}

/* ---------------- render ---------------- */
function render() {
  renderSidebar();
  renderTopbar();
  const c = document.getElementById('view-container');
  const noFilter = ['home', 'admin', 'issues', 'notes', 'settings', 'thread'].includes(State.view);
  document.getElementById('filterbar').classList.toggle('hidden', noFilter);
  if (State.view === 'home') { renderHome(c); syncHash(); return; }
  if (State.view === 'admin') { renderAdminPage(c); syncHash(); return; }
  renderFilterOptions();
  if (!State.project) {
    c.innerHTML = '<div class="empty-note">プロジェクトを選択、または「＋」で新規作成してください。</div>';
    syncHash();
    return;
  }
  document.getElementById('board-group-toggle').classList.toggle('hidden', State.view !== 'board');
  switch (State.view) {
    case 'dashboard': renderDashboard(c); break;
    case 'board': renderBoard(c); break;
    case 'table': renderTable(c); break;
    case 'gantt': renderGantt(c); break;
    case 'calendar': renderCalendar(c); break;
    case 'issues': renderIssues(c); break;
    case 'notes': renderNotes(c); break;
    case 'settings': renderSettingsPage(c); break;
    case 'thread': renderThread(c); break;
  }
  if (!noFilter) {
    const n = filteredTasks().length;
    document.getElementById('f-count').textContent =
      n === State.tasks.length ? `${n} 件` : `${n} / ${State.tasks.length} 件`;
  }
  syncHash();
}

function renderSidebar() {
  const imp = isImpersonating();
  document.getElementById('nav-home').classList.toggle('active', State.view === 'home');
  document.getElementById('nav-org-admin').classList.toggle('active', State.view === 'admin');
  // 表示のみ切替中は「プロジェクト」「プロジェクトメンバー」だけ残す（footerの切替UIは残る）
  document.getElementById('nav-home').closest('.side-section')
    .classList.toggle('hidden', imp);
  // 組織・ユーザー管理はサイト管理者以上のみ（切替中は非表示）
  document.getElementById('nav-org-admin').closest('.side-section')
    .classList.toggle('hidden', imp || loginRank() < 3);
  document.getElementById('btn-assign-member').classList.toggle('hidden', !canManageProject());

  const pl = document.getElementById('project-list');
  pl.innerHTML = State.projects.map(p => `
    <li class="${p.id === State.pid && State.view !== 'home' ? 'active' : ''}" data-pid="${p.id}">
      <span class="proj-dot" style="background:${U.esc(p.color)}"></span>
      <span style="overflow:hidden;text-overflow:ellipsis">${U.esc(p.name)}</span></li>`).join('');
  pl.querySelectorAll('li').forEach(li => {
    li.onclick = async () => {
      await loadProject(Number(li.dataset.pid));
      State.ganttCollapsed.clear();
      // プロジェクトに紐づかない画面（ホーム・組織管理・設定・議論）からはボードへ遷移
      if (['home', 'admin', 'settings', 'thread'].includes(State.view)) {
        State.view = 'board';
      }
      render();
    };
  });

  // 現在のプロジェクトのメンバー一覧（組織名つき）
  const omap = orgMap();
  const ml = document.getElementById('member-list');
  if (State.project) {
    const roleOf = (mid) => {
      const pm = State.projectMembers.find(
        x => x.project_id === State.pid && x.member_id === mid);
      return pm ? pm.role : 'member';
    };
    ml.innerHTML = State.members.map(m => `
      <li class="member-row" data-mid="${m.id}" title="${U.esc((omap[m.org_id] || {}).name || '無所属')}">
        ${U.avatarHtml(m)}<span>${U.esc(m.name)}</span>
        <span class="member-role role-${U.esc(roleOf(m.id))}">${U.esc(ROLE_LABEL[roleOf(m.id)] || '')}</span></li>`).join('') ||
      '<li style="cursor:default;color:#8fa0c5">メンバー未アサイン</li>';
    ml.querySelectorAll('li[data-mid]').forEach(li => {
      li.onclick = () => {
        if (canManageProject()) openAssignModal();
      };
    });
  } else {
    ml.innerHTML = '<li style="cursor:default;color:#8fa0c5">プロジェクト未選択</li>';
  }

  // ---- ログインユーザー表示（本番機能）とデバッグ切替（サイト管理者以上）は別管理
  const lu = State.loginUser;
  const box = document.getElementById('login-user-box');
  if (lu) {
    box.innerHTML = `
      <div class="login-user-row">
        ${U.avatarHtml(memberMap()[lu.id] || lu)}
        <div style="flex:1;min-width:0">
          <div class="lu-name">${U.esc(lu.name)}</div>
          <div class="lu-role">${U.esc(ORG_ROLE_LABEL[lu.org_role] || '一般')}${lu.account_type === 'external' ? ' / 外部' : ''}</div>
        </div>
        <button class="icon-btn" id="btn-password" title="パスワード変更">🔑</button>
        <button class="icon-btn" id="btn-logout" title="ログアウト">🚪</button>
      </div>
      ${isImpersonating() ? `<div class="debug-badge">🔧 デバッグ表示中: ${U.esc((memberMap()[State.currentUserId] || {}).name || '')}
        <button class="icon-btn" id="btn-unimpersonate" style="color:#fff">解除</button></div>` : ''}`;
    document.getElementById('btn-logout').onclick = async () => {
      await API.logout();
      location.reload();
    };
    document.getElementById('btn-password').onclick = openPasswordModal;
    const un = document.getElementById('btn-unimpersonate');
    if (un) un.onclick = () => switchViewUser(lu.id);
  }

  const dbgBox = document.getElementById('debug-user-box');
  dbgBox.classList.toggle('hidden', !canImpersonate());
  if (canImpersonate()) {
    const cu = document.getElementById('current-user');
    cu.innerHTML = State.users.map(m =>
      `<option value="${m.id}" ${m.id === State.currentUserId ? 'selected' : ''}>${U.esc(m.name)}${m.id === lu.id ? '（自分）' : ''}</option>`).join('');
    cu.onchange = () => switchViewUser(Number(cu.value));
  }
}

// デバッグ用: 表示ユーザーを切り替えて全データを取り直す（権限・見えるPJが変わる）
async function switchViewUser(uid) {
  State.currentUserId = uid;
  try {
    await loadBootstrap();
    if (State.pid && !State.projects.some(p => p.id === State.pid)) {
      State.pid = null; State.project = null; State.tasks = [];
      State.view = 'home';
    } else if (State.pid) {
      await loadProject(State.pid);
    }
  } catch (err) { toast(err.message); }
  closeDetail();
  render();
}

function openPasswordModal() {
  showModal(`
    <h2>🔑 アカウント設定</h2>
    <h3 style="font-size:14px;margin:0 0 8px">パスワード変更</h3>
    <div class="form-row"><label>現在のパスワード（未設定なら空欄）</label>
      <input type="password" id="pw-cur"></div>
    <div class="form-row"><label>新しいパスワード（空欄で未設定に戻す）</label>
      <input type="password" id="pw-new"></div>
    <button class="btn primary sm" id="pw-save">パスワードを変更</button>
    <p class="comment-hint">変更すると他の端末のセッションはログアウトされます。</p>
    <h3 style="font-size:14px;margin:18px 0 8px">APIトークン（自動化・MCP用）</h3>
    <div id="tok-list" class="empty-note" style="padding:8px;font-size:12.5px">読み込み中…</div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <input id="tok-label" placeholder="用途メモ（例: MCP用）" style="flex:1;border:1px solid var(--line);border-radius:6px;padding:6px 8px">
      <button class="btn sm" id="tok-create">＋ 発行</button>
    </div>
    <div id="tok-new" style="margin-top:8px"></div>
    <div class="modal-actions">
      <button class="btn primary" data-close>閉じる</button>
    </div>`);
  document.getElementById('pw-save').onclick = async () => {
    try {
      await API.changePassword(
        document.getElementById('pw-cur').value,
        document.getElementById('pw-new').value);
      toast('パスワードを変更しました');
      document.getElementById('pw-cur').value = '';
      document.getElementById('pw-new').value = '';
    } catch (err) { toast(err.message); }
  };
  const loadTokens = async () => {
    const box = document.getElementById('tok-list');
    try {
      const toks = await API.listTokens();
      box.classList.remove('empty-note');
      box.innerHTML = toks.map(t => `
        <div class="status-edit-row">
          <span>🎫</span>
          <span style="flex:1">${U.esc(t.label || '（無題）')}
            <span style="color:var(--muted);font-size:11px">発行 ${U.esc((t.created_at || '').slice(0, 10))}
            ${t.last_used ? ' / 最終使用 ' + U.esc(t.last_used.slice(0, 10)) : ' / 未使用'}</span></span>
          <button class="btn sm danger" data-del-tok="${t.id}">失効</button>
        </div>`).join('') ||
        '<div style="color:var(--muted);font-size:12.5px">トークンはありません</div>';
      box.querySelectorAll('[data-del-tok]').forEach(b => {
        b.onclick = async () => {
          if (!confirm('このトークンを失効させますか？（使用中の自動化は動かなくなります）')) return;
          await API.deleteToken(Number(b.dataset.delTok));
          loadTokens();
        };
      });
    } catch (err) { box.textContent = err.message; }
  };
  loadTokens();
  document.getElementById('tok-create').onclick = async () => {
    try {
      const r = await API.createToken(document.getElementById('tok-label').value.trim());
      document.getElementById('tok-new').innerHTML = `
        <div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:8px 12px;font-size:12.5px">
          ⚠ このトークンは今しか表示されません。コピーして保管してください:<br>
          <code style="user-select:all;word-break:break-all">${U.esc(r.token)}</code>
        </div>`;
      document.getElementById('tok-label').value = '';
      loadTokens();
    } catch (err) { toast(err.message); }
  };
}

function renderTopbar() {
  const p = State.project;
  const global = State.view === 'home' || State.view === 'admin';
  document.getElementById('proj-name').textContent =
    State.view === 'home' ? 'マイダッシュボード' :
    State.view === 'admin' ? '組織・ユーザー管理' :
    State.view === 'settings' ? `${p ? p.name : ''} — 設定` :
    (p ? p.name : 'プロジェクト未選択');
  document.getElementById('proj-color-dot').style.background =
    global ? '#4f6ef7' : (p ? p.color : '#cbd5e1');
  document.getElementById('btn-proj-settings').classList.toggle(
    'hidden', global || !canManageProject());
  const exportBlocked = State.myRole === 'external' && pset('external_can_export') !== true;
  document.getElementById('export-dd').classList.toggle('hidden', global || exportBlocked);
  document.getElementById('btn-new-task').classList.toggle(
    'hidden', global || !canCreateTask());
  // イシュー/コメントを閲覧できない外部ユーザーにはイシュータブを隠す
  const issuesTab = document.querySelector('#view-tabs button[data-view="issues"]');
  if (issuesTab) issuesTab.classList.toggle('hidden', !canViewComments());
  document.querySelectorAll('#view-tabs button').forEach(b => {
    const v = State.view === 'thread' ? 'issues' : State.view;   // 議論ページ中はコメント一覧タブを点灯
    b.classList.toggle('active', !global && b.dataset.view === v);
  });

  // 右上: デバッグ用ログイン完全切替（サイト管理者以上）
  const dlb = document.getElementById('debug-login-box');
  dlb.classList.toggle('hidden', !canDebugLogin());
  if (canDebugLogin()) {
    const sel = document.getElementById('debug-login-user');
    sel.innerHTML = State.users.map(u =>
      `<option value="${u.id}" ${u.id === State.loginUser.id ? 'selected' : ''}>${U.esc(u.name)}${u.id === State.loginUser.id ? '（現在）' : ''}</option>`).join('');
    sel.onchange = async () => {
      const uid = Number(sel.value);
      if (uid === State.loginUser.id) return;
      try {
        await API.debugLogin(uid);
        location.reload();   // セッションが切り替わったので全体を再読込
      } catch (err) {
        toast(err.message);
        sel.value = String(State.loginUser.id);
      }
    };
  }
  if (p) {
    document.getElementById('exp-html').href = `/api/projects/${p.id}/export.html`;
    document.getElementById('exp-xlsx').href = `/api/projects/${p.id}/export.xlsx`;
    document.getElementById('exp-csv').href = `/api/projects/${p.id}/export.csv`;
    document.getElementById('exp-json').href = `/api/projects/${p.id}/export.json`;
  }
}

function renderFilterOptions() {
  const fa = document.getElementById('f-assignee');
  const cur = State.filters.assignee;
  fa.innerHTML = `<option value="">担当者: 全員</option><option value="none">未割当</option>` +
    State.members.map(m => `<option value="${m.id}">${U.esc(m.name)}</option>`).join('');
  fa.value = cur;

  const ft = document.getElementById('f-tag');
  const curTag = State.filters.tag;
  const tags = [...new Set(State.tasks.flatMap(t => t.tags))].sort();
  ft.innerHTML = `<option value="">タグ: すべて</option>` +
    tags.map(t => `<option value="${U.esc(t)}">${U.esc(t)}</option>`).join('');
  ft.value = tags.includes(curTag) ? curTag : '';
  renderSavedFilters();
  bindSavedFilterEvents();
}

/* ---------------- modals: task ---------------- */
function openTaskModal(preset = {}) {
  if (!State.project) { toast('先にプロジェクトを選択してください'); return; }
  showModal(`
    <h2>タスクを追加</h2>
    <div class="form-row"><label>タスク名 *</label><input id="nt-title" autofocus></div>
    <div class="form-cols">
      <div class="form-row"><label>ステータス</label>
        <select id="nt-status">${State.statuses.map(s =>
          `<option value="${s.id}" ${s.id === preset.status_id ? 'selected' : ''}>${U.esc(s.name)}</option>`).join('')}</select></div>
      <div class="form-row"><label>担当者</label>
        <select id="nt-assignee"><option value="">未割当</option>${State.members.map(m =>
          `<option value="${m.id}" ${m.id === preset.assignee_id ? 'selected' : ''}>${U.esc(m.name)}</option>`).join('')}</select></div>
      <div class="form-row"><label>優先度</label>
        <select id="nt-priority">
          <option value="highest">最優先</option><option value="high">高</option>
          <option value="medium" selected>中</option><option value="low">低</option></select></div>
      <div class="form-row"><label>親タスク</label>
        <select id="nt-parent"><option value="">（なし）</option>${State.tasks.map(t =>
          `<option value="${t.id}" ${t.id === preset.parent_id ? 'selected' : ''}>${U.esc(t.title)}</option>`).join('')}</select></div>
      <div class="form-row"><label>開始日</label><input type="date" id="nt-start" value="${U.esc(preset.start_date || '')}"></div>
      <div class="form-row"><label>期限</label><input type="date" id="nt-due" value="${U.esc(preset.due_date || '')}"></div>
      <div class="form-row"><label>見積 (h)</label><input type="number" id="nt-est" min="0" step="0.5"></div>
      <div class="form-row"><label>タグ（カンマ区切り）</label><input id="nt-tags" placeholder="フェーズ1, 設計"></div>
    </div>
    <div class="form-row"><label>説明</label><textarea id="nt-desc"></textarea></div>
    <div class="form-row"><label class="chk" style="display:inline-flex"><input type="checkbox" id="nt-ms"> マイルストーンにする</label></div>
    <div class="modal-actions">
      <button class="btn" data-close>キャンセル</button>
      <button class="btn primary" id="nt-save">作成</button>
    </div>`);
  const save = async () => {
    const title = document.getElementById('nt-title').value.trim();
    if (!title) { toast('タスク名を入力してください'); return; }
    const v = (id) => document.getElementById(id).value;
    try {
      const t = await API.createTask(State.pid, {
        title,
        description: v('nt-desc'),
        status_id: Number(v('nt-status')),
        assignee_id: v('nt-assignee') ? Number(v('nt-assignee')) : null,
        priority: v('nt-priority'),
        parent_id: v('nt-parent') ? Number(v('nt-parent')) : null,
        start_date: v('nt-start') || null,
        due_date: v('nt-due') || null,
        estimate_h: v('nt-est') ? Number(v('nt-est')) : null,
        milestone: document.getElementById('nt-ms').checked,
        tags: v('nt-tags').split(',').map(s => s.trim()).filter(Boolean),
        actor_id: State.currentUserId,
      });
      closeModal();
      await refresh();
      toast(`「${t.title}」を作成しました`);
      if (detailTaskId) reloadDetail();
    } catch (err) { toast('作成に失敗: ' + err.message); }
  };
  document.getElementById('nt-save').onclick = save;
  document.getElementById('nt-title').onkeydown = (e) => { if (e.key === 'Enter') save(); };
  document.getElementById('nt-title').focus();
}

/* ---------------- modals: project ---------------- */
const PALETTE = ['#4f6ef7', '#ec4899', '#22c55e', '#f59e0b', '#8b5cf6', '#06b6d4', '#ef4444', '#64748b'];

function colorSwatches(id, selected) {
  return `<div class="color-swatches" id="${id}">${PALETTE.map(c =>
    `<span style="background:${c}" data-color="${c}" class="${c === selected ? 'sel' : ''}"></span>`).join('')}</div>`;
}
function bindSwatches(id) {
  const box = document.getElementById(id);
  box.querySelectorAll('span').forEach(s => {
    s.onclick = () => {
      box.querySelectorAll('span').forEach(x => x.classList.remove('sel'));
      s.classList.add('sel');
    };
  });
}
function swatchValue(id) {
  const sel = document.querySelector(`#${id} span.sel`);
  return sel ? sel.dataset.color : PALETTE[0];
}

function openProjectModal() {
  showModal(`
    <h2>新規プロジェクト</h2>
    <div class="form-row"><label>プロジェクト名 *</label><input id="np-name"></div>
    <div class="form-row"><label>説明</label><textarea id="np-desc"></textarea></div>
    <div class="form-cols">
      <div class="form-row"><label>開始日</label><input type="date" id="np-start"></div>
      <div class="form-row"><label>終了予定日</label><input type="date" id="np-end"></div>
    </div>
    <div class="form-row"><label>カラー</label>${colorSwatches('np-colors', PALETTE[0])}</div>
    <div class="modal-actions">
      <button class="btn" data-close>キャンセル</button>
      <button class="btn primary" id="np-save">作成</button>
    </div>`);
  bindSwatches('np-colors');
  document.getElementById('np-save').onclick = async () => {
    const name = document.getElementById('np-name').value.trim();
    if (!name) { toast('プロジェクト名を入力してください'); return; }
    const p = await API.createProject({
      name,
      description: document.getElementById('np-desc').value,
      start_date: document.getElementById('np-start').value || null,
      end_date: document.getElementById('np-end').value || null,
      color: swatchValue('np-colors'),
      member_ids: State.currentUserId ? [State.currentUserId] : [],
    });
    closeModal();
    await loadBootstrap();
    await loadProject(p.id);
    if (State.view === 'home') State.view = 'board';
    render();
    toast(`プロジェクト「${p.name}」を作成しました`);
  };
}

function cfRowHtml(f, i) {
  return `<div class="cf-row" data-key="${U.esc(f.key)}">
    <input data-f="label" placeholder="表示名" value="${U.esc(f.label)}">
    <select data-f="type">
      <option value="text" ${f.type === 'text' ? 'selected' : ''}>テキスト</option>
      <option value="number" ${f.type === 'number' ? 'selected' : ''}>数値</option>
      <option value="date" ${f.type === 'date' ? 'selected' : ''}>日付</option>
      <option value="select" ${f.type === 'select' ? 'selected' : ''}>選択肢</option>
    </select>
    <input data-f="options" placeholder="選択肢（カンマ区切り）" value="${U.esc((f.options || []).join(', '))}"
      ${f.type === 'select' ? '' : 'style="visibility:hidden"'}>
    <button class="icon-btn" data-del-cf>🗑</button>
  </div>`;
}
function bindCfRowEvents() {
  document.querySelectorAll('#ps-cfs .cf-row').forEach(row => {
    row.querySelector('[data-f=type]').onchange = (e) => {
      row.querySelector('[data-f=options]').style.visibility =
        e.target.value === 'select' ? 'visible' : 'hidden';
    };
    row.querySelector('[data-del-cf]').onclick = () => row.remove();
  });
}

/* ---------------- modals: user（組織所属） ---------------- */
function openUserModal(mid = null, { defaultOrgId = null, onSaved = null } = {}) {
  const m = mid ? State.users.find(x => x.id === mid) : null;
  const orgSel = m ? m.org_id : defaultOrgId;
  showModal(`
    <h2>${m ? 'ユーザー編集' : 'ユーザー追加'}</h2>
    <div class="form-row"><label>名前 *</label><input id="nm-name" value="${U.esc(m ? m.name : '')}"></div>
    <div class="form-cols">
      <div class="form-row"><label>役割</label><input id="nm-role" value="${U.esc(m ? m.role : '')}" placeholder="PM / エンジニア / デザイナー など"></div>
      <div class="form-row"><label>所属組織</label>
        <select id="nm-org">
          <option value="">（無所属）</option>
          ${State.orgs.map(o => `<option value="${o.id}" ${o.id === orgSel ? 'selected' : ''}>${U.esc(o.name)}</option>`).join('')}
        </select></div>
      <div class="form-row"><label>メールアドレス（SSO連携用・任意）</label>
        <input id="nm-email" type="email" value="${U.esc(m ? (m.email || '') : '')}" placeholder="taro@example.com"></div>
      <div class="form-row"><label>アカウント種別</label>
        <select id="nm-acct">
          <option value="internal" ${(!m || m.account_type === 'internal') ? 'selected' : ''}>社内</option>
          <option value="external" ${m && m.account_type === 'external' ? 'selected' : ''}>外部（見えるPJを参加分のみに制限）</option>
        </select></div>
    </div>
    <div class="form-row"><label>カラー</label>${colorSwatches('nm-colors', m ? m.color : PALETTE[1])}</div>
    <div class="modal-actions">
      ${m ? '<button class="btn danger left" id="nm-delete">無効化</button>' : ''}
      ${m && loginRank() >= 3 ? '<button class="btn left" id="nm-resetpw">🔑 パスワードリセット</button>' : ''}
      <button class="btn" data-close>キャンセル</button>
      <button class="btn primary" id="nm-save">${m ? '保存' : '追加'}</button>
    </div>`);
  const rp = document.getElementById('nm-resetpw');
  if (rp) rp.onclick = async () => {
    const nw = prompt(`「${m.name}」の新しいパスワードを入力（空欄で未設定に戻す）:`, '');
    if (nw === null) return;
    try {
      await API.resetPassword(m.id, nw);
      toast('パスワードをリセットしました（既存セッションは無効化）');
    } catch (err) { toast(err.message); }
  };
  bindSwatches('nm-colors');
  const done = async () => {
    closeModal();
    await loadBootstrap();
    await refresh();
    if (onSaved) onSaved();
  };
  document.getElementById('nm-save').onclick = async () => {
    const name = document.getElementById('nm-name').value.trim();
    if (!name) { toast('名前を入力してください'); return; }
    const orgVal = document.getElementById('nm-org').value;
    const body = {
      name, role: document.getElementById('nm-role').value.trim(),
      color: swatchValue('nm-colors'),
      org_id: orgVal ? Number(orgVal) : null,
      account_type: document.getElementById('nm-acct').value,
      email: document.getElementById('nm-email').value.trim() || null,
    };
    if (m) await API.updateMember(m.id, body);
    else await API.createMember(body);
    await done();
  };
  if (m) {
    document.getElementById('nm-delete').onclick = async () => {
      if (!confirm(`「${m.name}」を無効化しますか？（担当タスクは残ります）`)) return;
      await API.deleteMember(m.id);
      await done();
    };
  }
}

/* ---------------- modals: プロジェクトへのメンバーアサイン ---------------- */
function openAssignModal() {
  const p = State.project;
  if (!p) { toast('先にプロジェクトを選択してください'); return; }
  const memberIds = new Set(State.members.map(m => m.id));
  const omap = orgMap();
  const candidates = State.users.filter(u => !memberIds.has(u.id));

  // 組織ごとにグルーピングして表示
  const byOrg = new Map();
  for (const u of candidates) {
    const key = u.org_id ?? 0;
    if (!byOrg.has(key)) byOrg.set(key, []);
    byOrg.get(key).push(u);
  }
  const candHtml = candidates.length ? [...byOrg.entries()].map(([oid, users]) => `
    <div style="margin-bottom:10px">
      <div style="font-size:12px;color:var(--muted);margin-bottom:4px">
        🏢 ${U.esc(oid ? (omap[oid] || {}).name || '?' : '無所属')}</div>
      ${users.map(u => `
        <div class="status-edit-row">
          ${U.avatarHtml(u)}
          <span style="flex:1">${U.esc(u.name)}
            <span style="color:var(--muted);font-size:12px">${U.esc(u.role)}
            ${u.account_type === 'external' ? ' <span class="ext-chip">外部</span>' : ''}</span></span>
          <button class="btn sm primary" data-assign="${u.id}">アサイン</button>
        </div>`).join('')}
    </div>`).join('')
    : '<div class="empty-note" style="padding:10px">アサイン可能なユーザーはいません（全員アサイン済み）</div>';

  const pmOf = (mid) => State.projectMembers.find(
    x => x.project_id === p.id && x.member_id === mid) || {};

  showModal(`
    <h2>メンバーとロール — ${U.esc(p.name)}</h2>
    <p style="color:var(--muted);font-size:12px;margin:0 0 10px">
      リーダー=PJ内の全操作 ／ メンバー=自分の担当タスクのみ変更可 ／ ご意見番=閲覧＋コメント
      ／ 外部=閲覧範囲も制限可。組織のマネージャー・プロ職はアサイン不要で全PJの管理者です。
      未アサインの社内ユーザーも全PJを閲覧・コメントできます。</p>
    <div class="form-row"><label>現在のメンバー（${State.members.length}名）</label>
      ${State.members.map(m => {
        const pm = pmOf(m.id);
        const isExt = pm.role === 'external';
        const roleOpts = m.account_type === 'external' ? ['external'] : ['leader', 'member', 'advisor'];
        return `
        <div class="status-edit-row" data-pm="${m.id}">
          ${U.avatarHtml(m)}
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${U.esc(m.name)}
            ${m.account_type === 'external' ? '<span class="ext-chip">外部</span>' : ''}</span>
          <select data-role="${m.id}" style="width:100px" ${roleOpts.length === 1 ? 'disabled title="外部アカウントはexternal固定"' : ''}>
            ${roleOpts.map(r =>
              `<option value="${r}" ${pm.role === r ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}
          </select>
          <label class="chk ext-flag" title="コメントの閲覧・投稿" style="${isExt ? '' : 'display:none'}">
            <input type="checkbox" data-flag-c="${m.id}" ${pm.can_view_comments ? 'checked' : ''}>💬</label>
          <label class="chk ext-flag" title="タスク詳細の閲覧" style="${isExt ? '' : 'display:none'}">
            <input type="checkbox" data-flag-d="${m.id}" ${pm.can_view_detail ? 'checked' : ''}>📄</label>
          <button class="btn sm danger" data-unassign="${m.id}">外す</button>
        </div>`;
      }).join('') || '<div style="color:var(--muted);font-size:13px">まだメンバーがいません</div>'}
    </div>
    <div class="form-row"><label>ユーザーを追加アサイン（外部ユーザーは自動的に「外部」ロール・閲覧制限つき）</label>${candHtml}</div>
    <div class="modal-actions">
      <button class="btn left" id="am-new-user">＋ 新規ユーザー作成</button>
      <button class="btn primary" data-close>閉じる</button>
    </div>`);

  document.querySelectorAll('#modal [data-assign]').forEach(btn => {
    btn.onclick = async () => {
      await API.assignMember(p.id, { member_id: Number(btn.dataset.assign), actor_id: State.currentUserId });
      await loadBootstrap();
      await refresh();
      openAssignModal();   // モーダルを開いたまま更新
    };
  });
  document.querySelectorAll('#modal [data-unassign]').forEach(btn => {
    btn.onclick = async () => {
      const u = memberMap()[Number(btn.dataset.unassign)];
      const n = State.tasks.filter(t => t.assignee_id === Number(btn.dataset.unassign)).length;
      if (!confirm(`「${u ? u.name : '?'}」をこのプロジェクトから外しますか？` +
                   (n ? `\n（担当中の ${n} 件のタスクはそのまま残ります）` : ''))) return;
      await API.unassignMember(p.id, Number(btn.dataset.unassign));
      await loadBootstrap();
      await refresh();
      openAssignModal();
    };
  });
  const patchPm = async (mid, body) => {
    try {
      await API.updateProjectMember(p.id, mid, { ...body, actor_id: State.currentUserId });
      await loadBootstrap();
      await refresh();
      openAssignModal();
    } catch (err) { toast(err.message); }
  };
  document.querySelectorAll('#modal [data-role]').forEach(sel => {
    sel.onchange = () => patchPm(Number(sel.dataset.role), { role: sel.value });
  });
  document.querySelectorAll('#modal [data-flag-c]').forEach(cb => {
    cb.onchange = () => patchPm(Number(cb.dataset.flagC), { can_view_comments: cb.checked ? 1 : 0 });
  });
  document.querySelectorAll('#modal [data-flag-d]').forEach(cb => {
    cb.onchange = () => patchPm(Number(cb.dataset.flagD), { can_view_detail: cb.checked ? 1 : 0 });
  });
  document.getElementById('am-new-user').onclick = () => {
    openUserModal(null, { onSaved: openAssignModal });
  };
}

/* ---------------- login ---------------- */
async function renderLoginScreen() {
  const scr = document.getElementById('login-screen');
  document.getElementById('app').classList.add('hidden');
  scr.classList.remove('hidden');
  let users = [];
  try { users = await API.authUsers(); } catch (e) { /* noop */ }
  scr.innerHTML = `
    <div class="login-card">
      <div class="brand" style="justify-content:center;font-size:22px;color:#1f2937">
        <span class="brand-logo">▦</span> PJ Board
      </div>
      <p style="color:var(--muted);font-size:13px;text-align:center;margin:4px 0 18px">
        ユーザーを選択してログインしてください</p>
      <div class="form-row"><label>ユーザー</label>
        <select id="li-user">${users.map(u => `
          <option value="${u.id}">${U.esc(u.name)}（${U.esc(u.org_name || '無所属')}${u.account_type === 'external' ? '・外部' : ''}）</option>`).join('')}
        </select></div>
      <div class="form-row"><label>パスワード</label>
        <input type="password" id="li-pass" placeholder="未設定の場合は空欄のまま">
        <div id="li-hint" style="color:var(--muted);font-size:11.5px;margin-top:4px"></div></div>
      <button class="btn primary" id="li-login" style="width:100%;padding:10px">ログイン</button>
      <div id="li-error" style="color:var(--danger);font-size:13px;margin-top:10px;text-align:center"></div>
    </div>`;
  const sel = document.getElementById('li-user');
  const hint = () => {
    const u = users.find(x => x.id === Number(sel.value));
    document.getElementById('li-hint').textContent =
      u && !u.has_password ? 'このユーザーはパスワード未設定です（ログイン後に🔑から設定できます）' : '';
  };
  sel.onchange = hint;
  hint();
  const doLogin = async () => {
    try {
      await API.login(Number(sel.value), document.getElementById('li-pass').value);
      location.reload();
    } catch (err) {
      document.getElementById('li-error').textContent = err.message;
    }
  };
  document.getElementById('li-login').onclick = doLogin;
  document.getElementById('li-pass').onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
}

/* ---------------- init / events ---------------- */
async function init() {
  // ログイン確認（Cookieセッション）
  try {
    State.loginUser = await API.me();
  } catch (e) {
    await renderLoginScreen();
    return;
  }
  State.currentUserId = State.loginUser.id;
  await loadBootstrap();
  const savedPid = Number(localStorage.getItem('pjboard.pid'));
  const target = State.projects.find(p => p.id === savedPid) || State.projects[0];
  if (target) await loadProject(target.id);
  // URLハッシュ（共有リンク）があればそのビュー・タスクを復元、無ければホーム
  if (!(await applyHash())) render();
  window.addEventListener('hashchange', applyHash);

  // ビュータブ
  document.querySelectorAll('#view-tabs button').forEach(b => {
    b.onclick = () => { State.view = b.dataset.view; render(); };
  });
  // ホーム（プロジェクト横断ダッシュボード）
  document.getElementById('nav-home').onclick = () => { State.view = 'home'; render(); };
  document.getElementById('nav-org-admin').onclick = () => { State.view = 'admin'; render(); };
  // ボードのグルーピング切替
  document.querySelectorAll('#board-group-toggle button').forEach(b => {
    b.onclick = () => {
      State.boardGroup = b.dataset.group;
      document.querySelectorAll('#board-group-toggle button').forEach(x =>
        x.classList.toggle('active', x === b));
      render();
    };
  });
  // フィルター
  document.getElementById('f-keyword').addEventListener('input',
    U.debounce((e) => { State.filters.keyword = e.target.value; render(); }, 250));
  document.getElementById('f-assignee').onchange = (e) => { State.filters.assignee = e.target.value; render(); };
  document.getElementById('f-priority').onchange = (e) => { State.filters.priority = e.target.value; render(); };
  document.getElementById('f-tag').onchange = (e) => { State.filters.tag = e.target.value; render(); };
  document.getElementById('f-hide-done').onchange = (e) => { State.filters.hideDone = e.target.checked; render(); };

  // ボタン類
  document.getElementById('btn-new-task').onclick = () => openTaskModal();
  document.getElementById('btn-new-project').onclick = openProjectModal;
  document.getElementById('btn-assign-member').onclick = openAssignModal;
  document.getElementById('btn-proj-settings').onclick = () => {
    State.view = 'settings';
    render();
  };

  // 通知ベル
  const ndd = document.getElementById('notif-dd');
  document.getElementById('btn-notif').onclick = (e) => {
    e.stopPropagation();
    ndd.classList.toggle('open');
    if (ndd.classList.contains('open')) renderNotifMenu();
  };
  refreshNotifications();
  setInterval(refreshNotifications, 60000);
  startSSE();

  // 横断検索
  document.getElementById('btn-search').onclick = openSearch;
  const sInput = document.getElementById('search-input');
  sInput.addEventListener('input', U.debounce((e) => runSearch(e.target.value), 300));
  document.getElementById('search-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'search-overlay') closeSearch();
  });

  // エクスポートドロップダウン
  const dd = document.getElementById('export-dd');
  document.getElementById('btn-export').onclick = (e) => {
    e.stopPropagation();
    dd.classList.toggle('open');
  };
  document.addEventListener('click', () => {
    dd.classList.remove('open');
    ndd.classList.remove('open');
  });

  // 詳細パネル
  document.getElementById('detail-overlay').onclick = closeDetail;
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'modal-overlay') closeModal();
  });

  // キーボードショートカット
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      openSearch();
      return;
    }
    if (e.key === 'Escape') {
      if (!document.getElementById('search-overlay').classList.contains('hidden')) closeSearch();
      else if (!document.getElementById('modal-overlay').classList.contains('hidden')) closeModal();
      else closeDetail();
    }
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === 'n') openTaskModal();
    if (e.key === 'h' || e.key === '0') { State.view = 'home'; render(); }
    if (e.key === '1') { State.view = 'dashboard'; render(); }
    if (e.key === '2') { State.view = 'board'; render(); }
    if (e.key === '3') { State.view = 'table'; render(); }
    if (e.key === '4') { State.view = 'gantt'; render(); }
    if (e.key === '5') { State.view = 'calendar'; render(); }
  });
}

init().catch(err => {
  document.getElementById('view-container').innerHTML =
    `<div class="empty-note">初期化に失敗しました: ${U.esc(err.message)}</div>`;
});
