/* ================= API client ================= */
const API = {
  async _req(method, url, body) {
    // X-Requested-With は CSRF 防御（サーバー側で書き込み時に必須）
    const opt = { method, headers: { 'X-Requested-With': 'fetch' } };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const res = await fetch(url, opt);
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).detail || msg; } catch (e) { /* noop */ }
      throw new Error(msg);
    }
    return res.status === 204 ? null : res.json();
  },
  get: (u) => API._req('GET', u),
  post: (u, b) => API._req('POST', u, b),
  patch: (u, b) => API._req('PATCH', u, b),
  del: (u) => API._req('DELETE', u),

  authUsers: () => API.get('/api/auth/users'),
  login: (member_id, password) => API.post('/api/auth/login', { member_id, password }),
  logout: () => API.post('/api/auth/logout', {}),
  debugLogin: (member_id) => API.post('/api/auth/debug-login', { member_id }),
  me: () => API.get('/api/auth/me'),
  changePassword: (current_password, new_password) =>
    API.post('/api/auth/password', { current_password, new_password }),
  resetPassword: (mid, new_password) =>
    API.post(`/api/members/${mid}/reset-password`, { new_password }),
  bootstrap: (uid) => API.get(`/api/bootstrap${uid ? '?user_id=' + uid : ''}`),
  projectData: (pid, uid) => API.get(`/api/projects/${pid}/data${uid ? '?user_id=' + uid : ''}`),
  createProject: (b) => API.post('/api/projects', b),
  updateProject: (pid, b, actor) =>
    API.patch(`/api/projects/${pid}${actor ? '?actor_id=' + actor : ''}`, b),
  applyNoteTemplate: (pid, actor) =>
    API.post(`/api/projects/${pid}/notes/apply-template`, { actor_id: actor }),
  deleteProject: (pid) => API.del(`/api/projects/${pid}`),
  createOrg: (b) => API.post('/api/orgs', b),
  updateOrg: (oid, b) => API.patch(`/api/orgs/${oid}`, b),
  deleteOrg: (oid) => API.del(`/api/orgs/${oid}`),
  assignMember: (pid, b) => API.post(`/api/projects/${pid}/members`, b),
  unassignMember: (pid, mid) => API.del(`/api/projects/${pid}/members/${mid}`),
  updateProjectMember: (pid, mid, b) => API.patch(`/api/projects/${pid}/members/${mid}`, b),
  overview: (uid) => API.get(`/api/overview${uid ? '?user_id=' + uid : ''}`),
  listNotes: (pid) => API.get(`/api/projects/${pid}/notes`),
  createNote: (pid, b) => API.post(`/api/projects/${pid}/notes`, b),
  updateNote: (nid, b) => API.patch(`/api/notes/${nid}`, b),
  deleteNote: (nid, actor) => API.del(`/api/notes/${nid}${actor ? '?actor_id=' + actor : ''}`),
  discussions: (pid, uid) => API.get(`/api/projects/${pid}/discussions${uid ? '?user_id=' + uid : ''}`),
  createMember: (b) => API.post('/api/members', b),
  updateMember: (mid, b) => API.patch(`/api/members/${mid}`, b),
  deleteMember: (mid) => API.del(`/api/members/${mid}`),
  createStatus: (pid, b) => API.post(`/api/projects/${pid}/statuses`, b),
  updateStatus: (sid, b) => API.patch(`/api/statuses/${sid}`, b),
  deleteStatus: (sid) => API.del(`/api/statuses/${sid}`),
  createTask: (pid, b) => API.post(`/api/projects/${pid}/tasks`, b),
  updateTask: (tid, b) => API.patch(`/api/tasks/${tid}`, b),
  deleteTask: (tid, actor) => API.del(`/api/tasks/${tid}${actor ? '?actor_id=' + actor : ''}`),
  taskDetail: (tid, uid) => API.get(`/api/tasks/${tid}/detail${uid ? '?user_id=' + uid : ''}`),
  addComment: (tid, b) => API.post(`/api/tasks/${tid}/comments`, b),
  deleteComment: (cid, actor) => API.del(`/api/comments/${cid}${actor ? '?actor_id=' + actor : ''}`),
  addLink: (tid, b) => API.post(`/api/tasks/${tid}/links`, b),
  deleteLink: (lid) => API.del(`/api/links/${lid}`),
  reorder: (items) => API.post('/api/tasks/reorder', { items }),

  /* ---- 通知・ウォッチ ---- */
  notifications: (uid, unreadOnly) =>
    API.get(`/api/notifications?user_id=${uid}${unreadOnly ? '&unread_only=1' : ''}`),
  readNotifications: (uid, ids) => API.post('/api/notifications/read', { user_id: uid, ids }),
  watchTask: (tid, uid) => API.post(`/api/tasks/${tid}/watch`, { user_id: uid }),
  unwatchTask: (tid, uid) => API.del(`/api/tasks/${tid}/watch?user_id=${uid}`),

  /* ---- 添付 ---- */
  async upload(targetType, targetId, file, actor) {
    const url = `/api/upload?target_type=${targetType}&target_id=${targetId}` +
      `&filename=${encodeURIComponent(file.name)}${actor ? '&actor_id=' + actor : ''}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-Requested-With': 'fetch',
                 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).detail || msg; } catch (e) { /* noop */ }
      throw new Error(msg);
    }
    return res.json();
  },
  deleteAttachment: (aid, actor) =>
    API.del(`/api/attachments/${aid}${actor ? '?actor_id=' + actor : ''}`),

  /* ---- 検索・ゴミ箱・インポート ---- */
  search: (q, uid) => API.get(`/api/search?q=${encodeURIComponent(q)}${uid ? '&user_id=' + uid : ''}`),
  trash: (pid) => API.get(`/api/projects/${pid}/trash`),
  restoreTask: (tid, actor) => API.post(`/api/tasks/${tid}/restore`, { actor_id: actor }),
  restoreNote: (nid, actor) => API.post(`/api/notes/${nid}/restore`, { actor_id: actor }),
  importTasks: (pid, rows, actor) =>
    API.post(`/api/projects/${pid}/import`, { rows, actor_id: actor }),

  /* ---- トークン・監査 ---- */
  listTokens: () => API.get('/api/tokens'),
  createToken: (label) => API.post('/api/tokens', { label }),
  deleteToken: (id) => API.del(`/api/tokens/${id}`),
  loginLogs: () => API.get('/api/login-logs'),

  /* ---- コメント編集・リアクション・リレーション ---- */
  editComment: (cid, body, actor) =>
    API.patch(`/api/comments/${cid}`, { body, actor_id: actor }),
  react: (cid, emoji, uid) =>
    API.post(`/api/comments/${cid}/react`, { emoji, user_id: uid }),
  addRelation: (tid, otherId, kind) =>
    API.post(`/api/tasks/${tid}/relations`, { other_id: otherId, kind }),
  deleteRelation: (rid) => API.del(`/api/relations/${rid}`),

  /* ---- PJ複製・フィルタ・ベースライン・メトリクス・サマリー ---- */
  duplicateProject: (pid, name, withTasks, actor) =>
    API.post(`/api/projects/${pid}/duplicate`, { name, with_tasks: withTasks, actor_id: actor }),
  listFilters: (pid, uid) => API.get(`/api/projects/${pid}/filters?user_id=${uid}`),
  saveFilter: (pid, name, filters, uid) =>
    API.post(`/api/projects/${pid}/filters`, { name, filters, user_id: uid }),
  deleteFilter: (fid, uid) => API.del(`/api/filters/${fid}?user_id=${uid}`),
  saveBaseline: (pid, name, actor) =>
    API.post(`/api/projects/${pid}/baselines`, { name, actor_id: actor }),
  latestBaseline: (pid) => API.get(`/api/projects/${pid}/baseline`),
  metrics: (pid) => API.get(`/api/projects/${pid}/metrics`),
  weeklySummary: (pid, actor) => API.post(`/api/projects/${pid}/summary`, { actor_id: actor }),
};

/* ================= 共有ユーティリティ ================= */
const U = {
  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
  todayStr() { return new Date().toISOString().slice(0, 10); },
  fmtDate(s) {
    if (!s) return '—';
    const [y, m, d] = s.split('-');
    return `${Number(m)}/${Number(d)}`;
  },
  initials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/[\s　]+/);
    return parts.length >= 2 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  },
  dueClass(t, statusMap) {
    if (!t.due_date) return '';
    const st = statusMap && statusMap[t.status_id];
    if (st && st.is_done) return '';
    const today = U.todayStr();
    if (t.due_date < today) return 'overdue';
    const diff = (new Date(t.due_date) - new Date(today)) / 86400000;
    return diff <= 3 ? 'soon' : '';
  },
  avatarHtml(member, extra = '') {
    if (!member) return `<span class="avatar unassigned ${extra}" title="未割当">–</span>`;
    return `<span class="avatar ${extra}" style="background:${U.esc(member.color)}" title="${U.esc(member.name)}">${U.esc(U.initials(member.name))}</span>`;
  },
  prioLabel: { highest: '最優先', high: '高', medium: '中', low: '低' },
  prioHtml(p) {
    return `<span class="prio ${U.esc(p)}">${U.esc(U.prioLabel[p] || p)}</span>`;
  },
  debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  },
};
