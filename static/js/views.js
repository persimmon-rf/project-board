/* ================= views.js — dashboard / board / table / gantt ================= */

/* ---------- WBS 構築（親子ツリー → 番号付きフラット配列） ---------- */
function buildWbs(tasks) {
  const children = new Map();
  for (const t of tasks) {
    const key = t.parent_id ?? null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(t);
  }
  for (const arr of children.values()) arr.sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id));
  const out = [];
  const walk = (pid, prefix, depth) => {
    (children.get(pid) || []).forEach((t, i) => {
      const num = `${prefix}${i + 1}`;
      out.push({ ...t, wbs: num, depth });
      walk(t.id, num + '.', depth + 1);
    });
  };
  walk(null, '', 0);
  const seen = new Set(out.map(t => t.id));
  for (const t of tasks) if (!seen.has(t.id)) out.push({ ...t, wbs: '-', depth: 0 });
  return out;
}

function hasChildren(tid) {
  return State.tasks.some(t => t.parent_id === tid);
}

/* ---------- WBS番号の参照（State.tasks が入れ替わったら再計算） ---------- */
let _wbsCache = { src: null, map: {} };
function wbsOf(tid) {
  if (_wbsCache.src !== State.tasks) {
    _wbsCache = { src: State.tasks, map: {} };
    for (const t of buildWbs(State.tasks)) _wbsCache.map[t.id] = t.wbs;
  }
  return _wbsCache.map[tid] || '';
}
/* タスク名の表示用ラベル（頭にWBS番号を付ける） */
function taskLabel(t) {
  const w = wbsOf(t.id);
  return (w && w !== '-') ? `${w} ${t.title}` : t.title;
}

/* =====================================================================
 *  ボードビュー
 * =================================================================== */
function renderBoard(container) {
  // サブタスクを持つ親タスクは表示しない（実作業の単位＝子タスクのみを扱う）
  const tasks = filteredTasks().filter(t => !hasChildren(t.id));
  const smap = statusMap();
  const byStatus = State.boardGroup === 'status';

  let cols;
  if (byStatus) {
    cols = State.statuses.map(s => ({
      key: `s${s.id}`, id: s.id, name: s.name, color: s.color,
      head: `<span class="proj-dot" style="background:${U.esc(s.color)}"></span>${U.esc(s.name)}`,
      tasks: tasks.filter(t => t.status_id === s.id),
    }));
  } else {
    cols = [
      ...State.members.map(m => ({
        key: `m${m.id}`, id: m.id, name: m.name, color: m.color,
        head: `${U.avatarHtml(m)}${U.esc(m.name)}`,
        tasks: tasks.filter(t => t.assignee_id === m.id),
      })),
      ...virtualAssignees().map(l => ({
        key: `v:${l}`, id: null, name: l, color: '#64748b',
        head: `${virtualAvatarHtml(l)}${U.esc(l)}`,
        tasks: tasks.filter(t => !t.assignee_id && t.assignee_label === l),
      })),
      {
        key: 'm-none', id: null, name: '未割当', color: '#94a3b8',
        head: `${U.avatarHtml(null)}未割当`,
        tasks: tasks.filter(t => !t.assignee_id && !t.assignee_label),
      },
    ];
  }

  container.innerHTML = `<div class="board">${cols.map(col => `
    <div class="board-col" data-col="${col.key}">
      <div class="board-col-head" style="border-color:${U.esc(col.color)}">
        ${col.head}<span class="cnt">${col.tasks.length}</span>
      </div>
      <div class="board-col-body" data-col="${col.key}">
        ${col.tasks.map(t => cardHtml(t, smap, byStatus)).join('') ||
          '<div class="empty-note" style="padding:14px;font-size:12px">タスクなし</div>'}
      </div>
      ${canCreateTask() ? `<button class="board-col-add" data-col="${col.key}">＋ タスク追加</button>` : ''}
    </div>`).join('')}</div>`;

  // カードクリック → 詳細
  container.querySelectorAll('.card').forEach(el => {
    el.addEventListener('click', () => openDetail(Number(el.dataset.id)));
  });
  // 列内の追加ボタン
  container.querySelectorAll('.board-col-add').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.col;
      const preset = {};
      if (key.startsWith('s')) preset.status_id = Number(key.slice(1));
      else if (key.startsWith('m') && key !== 'm-none') preset.assignee_id = Number(key.slice(1));
      openTaskModal(preset);
    });
  });
  setupBoardDnD(container, byStatus);
}

function cardHtml(t, smap, byStatus) {
  const m = memberMap()[t.assignee_id];
  const st = smap[t.status_id];
  const dueCls = U.dueClass(t, smap);
  const draggable = byStatus ? canEditField(t, 'status_id') : canEditField(t, 'assignee_id');
  return `<div class="card ${dueCls === 'overdue' ? 'overdue' : ''} ${draggable ? '' : 'no-drag'}" draggable="${draggable}" data-id="${t.id}">
    <div class="card-title">${t.milestone ? '<span class="msdiamond">◆</span> ' : ''}${U.esc(taskLabel(t))}
      ${t.issue_count ? `<span class="issue-chip" title="オープンの関連課題 ${t.issue_count} 件">📌${t.issue_count}</span>` : ''}</div>
    <div class="card-meta">
      ${fieldVisible('priority') ? U.prioHtml(t.priority) : ''}
      ${!byStatus && st ? `<span class="badge" style="background:${U.esc(st.color)}">${U.esc(st.name)}</span>` : ''}
      ${t.due_date ? `<span class="due ${dueCls}">📅 ${U.fmtDate(t.due_date)}</span>` : ''}
      ${fieldVisible('tags') ? t.tags.map(tg => `<span class="tag-chip">${U.esc(tg)}</span>`).join('') : ''}
    </div>
    ${t.progress > 0 ? `<div class="card-progress"><div style="width:${t.progress}%"></div></div>` : ''}
    <div class="card-foot">
      <span class="card-icons">
        ${t.comment_count ? `💬 ${t.comment_count}` : ''}
        ${t.link_count ? `🔗 ${t.link_count}` : ''}
        ${hasChildren(t.id) ? `⧉ ${State.tasks.filter(x => x.parent_id === t.id).length}` : ''}
      </span>
      <span class="spacer"></span>
      ${taskAvatarHtml(t)}
    </div>
  </div>`;
}

function setupBoardDnD(container, byStatus) {
  let dragId = null;
  container.querySelectorAll('.card').forEach(card => {
    card.addEventListener('dragstart', (e) => {
      dragId = Number(card.dataset.id);
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      container.querySelectorAll('.board-col').forEach(c => c.classList.remove('drag-over'));
    });
  });
  container.querySelectorAll('.board-col').forEach(col => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', (e) => {
      if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over');
    });
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      if (dragId == null) return;
      const key = col.dataset.col;
      const t = State.tasks.find(x => x.id === dragId);
      if (!t) return;
      try {
        if (byStatus) {
          const sid = Number(key.slice(1));
          if (t.status_id === sid) return;
          const patch = { status_id: sid, actor_id: State.currentUserId };
          const st = statusMap()[sid];
          if (st && st.is_done) patch.progress = 100;   // 完了列へ移動したら進捗100%
          await API.updateTask(dragId, patch);
          toast(`「${t.title}」→ ${st ? st.name : ''}`);
        } else if (key.startsWith('v:')) {
          const label = key.slice(2);
          if (!t.assignee_id && t.assignee_label === label) return;
          await API.updateTask(dragId, { assignee_id: null, assignee_label: label,
                                         actor_id: State.currentUserId });
          toast(`「${t.title}」の担当 → ${label}`);
        } else {
          const mid = key === 'm-none' ? null : Number(key.slice(1));
          if (t.assignee_id === mid && !t.assignee_label) return;
          await API.updateTask(dragId, { assignee_id: mid, assignee_label: null,
                                         actor_id: State.currentUserId });
          const m = memberMap()[mid];
          toast(`「${t.title}」の担当 → ${m ? m.name : '未割当'}`);
        }
        await refresh();
      } catch (err) { toast('更新に失敗: ' + err.message); }
      dragId = null;
    });
  });
}

/* =====================================================================
 *  テーブルビュー
 * =================================================================== */
function renderTable(container) {
  const smap = statusMap();
  const mmap = memberMap();
  const filtered = new Set(filteredTasks().map(t => t.id));
  let rows = buildWbs(State.tasks).filter(t => filtered.has(t.id));

  const { key, dir } = State.tableSort;
  if (key) {
    const val = (t) => {
      switch (key) {
        case 'title': return t.title;
        case 'status': return smap[t.status_id] ? smap[t.status_id].sort_order : 99;
        case 'assignee': return assigneeName(t) || 'んんん';
        case 'priority': return { highest: 0, high: 1, medium: 2, low: 3 }[t.priority] ?? 9;
        case 'start_date': return t.start_date || '9999';
        case 'due_date': return t.due_date || '9999';
        case 'progress': return t.progress;
        case 'estimate_h': return t.estimate_h ?? -1;
        default: return t.wbs;
      }
    };
    rows = [...rows].sort((a, b) => {
      const va = val(a), vb = val(b);
      const c = va < vb ? -1 : va > vb ? 1 : 0;
      return dir === 'asc' ? c : -c;
    });
  }

  const cfDefs = fieldVisible('custom_fields') ? (State.project.custom_fields || []) : [];
  const vis = { prio: fieldVisible('priority'), est: fieldVisible('estimate'),
                tags: fieldVisible('tags') };
  const arrow = (k) => key === k ? `<span class="arrow">${dir === 'asc' ? '▲' : '▼'}</span>` : '';
  const th = (k, label, w) =>
    `<th data-sort="${k}" ${w ? `style="width:${w}"` : ''}>${label} ${arrow(k)}</th>`;

  const bulk = canManageProject();
  container.innerHTML = `
  <div class="table-toolbar">
    <span class="spacer"></span>
    ${bulk ? '<button class="btn sm" id="tbl-imp" title="エクスポートしたExcelを取り込んで更新・追加（ID列で突合、ID空行は新規）">📥 Excel取込</button>' : ''}
    <button class="btn sm" id="tbl-exp" title="整形済みテーブルExcelを出力（取込での往復に対応）">📗 Excel出力</button>
  </div>
  ${bulk ? `<div id="bulk-bar" class="bulk-bar hidden">
      <b><span id="bulk-count">0</span> 件選択中</b>
      <select id="bulk-status"><option value="">ステータス変更…</option>
        ${State.statuses.map(st => `<option value="${st.id}">${U.esc(st.name)}</option>`).join('')}</select>
      <select id="bulk-assignee"><option value="">担当者変更…</option>
        <option value="null">未割当にする</option>
        ${State.members.map(m2 => `<option value="${m2.id}">${U.esc(m2.name)}</option>`).join('')}</select>
      <select id="bulk-priority"><option value="">優先度変更…</option>
        ${['highest', 'high', 'medium', 'low'].map(pr => `<option value="${pr}">${U.prioLabel[pr]}</option>`).join('')}</select>
      <button class="btn sm" id="bulk-clear">選択解除</button>
    </div>` : ''}
  <div class="table-wrap"><table class="task-table">
    <thead><tr>
      ${bulk ? '<th style="width:30px"><input type="checkbox" id="bulk-all"></th>' : ''}
      ${th('wbs', 'WBS', '58px')}${th('title', 'タスク名')}
      ${th('status', 'ステータス', '120px')}${th('assignee', '担当者', '130px')}
      ${vis.prio ? th('priority', '優先度', '90px') : ''}${th('start_date', '開始', '112px')}
      ${th('due_date', '期限', '112px')}${th('progress', '進捗', '130px')}
      ${vis.est ? th('estimate_h', '見積h', '70px') : ''}${vis.tags ? '<th>タグ</th>' : ''}
      ${cfDefs.map(f => `<th>${U.esc(f.label)}</th>`).join('')}
      <th style="width:50px">💬</th>
    </tr></thead>
    <tbody>${rows.map(t => tableRowHtml(t, smap, mmap, cfDefs, vis, bulk)).join('')}</tbody>
  </table>
  ${rows.length === 0 ? '<div class="empty-note">条件に合うタスクがありません</div>' : ''}
  </div>`;

  const tblImp = container.querySelector('#tbl-imp');
  if (tblImp) tblImp.onclick = () => importViewXlsx('tasks');
  container.querySelector('#tbl-exp').onclick = () => exportViewXlsx('table');
  container.querySelectorAll('th[data-sort]').forEach(el => {
    el.addEventListener('click', () => {
      const k = el.dataset.sort;
      if (State.tableSort.key === k) {
        State.tableSort.dir = State.tableSort.dir === 'asc' ? 'desc' : 'asc';
      } else State.tableSort = { key: k, dir: 'asc' };
      renderTable(container);
    });
  });

  // ---- 一括編集
  if (bulk) {
    const selected = () => [...container.querySelectorAll('.bulk-chk:checked')]
      .map(cb => Number(cb.dataset.bulk));
    const updateBar = () => {
      const n = selected().length;
      container.querySelector('#bulk-bar').classList.toggle('hidden', n === 0);
      container.querySelector('#bulk-count').textContent = n;
    };
    container.querySelectorAll('.bulk-chk').forEach(cb => cb.onchange = updateBar);
    const all = container.querySelector('#bulk-all');
    if (all) all.onchange = () => {
      container.querySelectorAll('.bulk-chk').forEach(cb => { cb.checked = all.checked; });
      updateBar();
    };
    container.querySelector('#bulk-clear').onclick = () => {
      container.querySelectorAll('.bulk-chk').forEach(cb => { cb.checked = false; });
      if (all) all.checked = false;
      updateBar();
    };
    const bulkApply = async (field, raw) => {
      if (raw === '') return;
      const value = raw === 'null' ? null :
        (field === 'priority' ? raw : Number(raw));
      const ids = selected();
      for (const id of ids) {
        try {
          await API.updateTask(id, { [field]: value, actor_id: State.currentUserId });
        } catch (err) { toast(err.message); }
      }
      toast(`${ids.length} 件を更新しました`);
      await refresh();
    };
    container.querySelector('#bulk-status').onchange = (e) => bulkApply('status_id', e.target.value);
    container.querySelector('#bulk-assignee').onchange = (e) => bulkApply('assignee_id', e.target.value);
    container.querySelector('#bulk-priority').onchange = (e) => bulkApply('priority', e.target.value);
  }

  // 行クリック → 詳細（編集コントロール上のクリックは除外）
  container.querySelectorAll('tbody tr').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('select, input, a, .bulk-chk')) return;
      openDetail(Number(tr.dataset.id));
    });
  });

  // インライン編集
  container.querySelectorAll('[data-edit]').forEach(el => {
    el.addEventListener('change', async () => {
      const tid = Number(el.closest('tr').dataset.id);
      const field = el.dataset.edit;
      let value = el.value === '' ? null : el.value;
      let patchBody;
      if (field === 'assignee_id') {
        patchBody = assigneePatch(el.value);
      } else {
        if (field === 'progress' || field === 'status_id') {
          value = value === null ? null : Number(value);
        }
        if (field === 'estimate_h') value = value === null ? null : Number(value);
        patchBody = { [field]: value };
      }
      try {
        await API.updateTask(tid, { ...patchBody, actor_id: State.currentUserId });
        await refresh();
      } catch (err) { toast('更新に失敗: ' + err.message); }
    });
  });
}

function tableRowHtml(t, smap, mmap, cfDefs, vis, bulk) {
  const dueCls = U.dueClass(t, smap);
  const pad = t.depth * 20;
  const dis = (f) => canEditField(t, f) ? '' : 'disabled';
  return `<tr data-id="${t.id}">
    ${bulk ? `<td><input type="checkbox" class="bulk-chk" data-bulk="${t.id}"></td>` : ''}
    <td class="t-wbs">${U.esc(t.wbs)}</td>
    <td style="padding-left:${pad + 10}px" class="t-title">
      ${t.milestone ? '<span style="color:#a855f7">◆</span> ' : ''}${U.esc(t.title)}</td>
    <td><select data-edit="status_id" ${dis('status_id')}>
      ${State.statuses.map(s => `<option value="${s.id}" ${s.id === t.status_id ? 'selected' : ''}>${U.esc(s.name)}</option>`).join('')}
    </select></td>
    ${hasChildren(t.id)
      ? `<td class="assignee-cell parent-cell" title="下位タスクで担当を管理します"><span class="no-assignee">—</span></td>`
      : `<td class="assignee-cell" ${assigneeColorOf(t) ? `style="box-shadow:inset 3px 0 0 ${assigneeColorOf(t)}"` : ''}>
      ${(t.assignee_id || t.assignee_label) ? `<span class="a-dot" style="background:${assigneeColorOf(t)}"></span>` : ''}<select data-edit="assignee_id" ${dis('assignee_id')}>
      ${assigneeOptionsHtml(t)}
    </select></td>`}
    ${vis.prio ? `<td><select data-edit="priority" ${dis('priority')}>
      ${['highest', 'high', 'medium', 'low'].map(p => `<option value="${p}" ${p === t.priority ? 'selected' : ''}>${U.prioLabel[p]}</option>`).join('')}
    </select></td>` : ''}
    <td><input type="date" data-edit="start_date" value="${U.esc(t.start_date || '')}" ${dis('start_date')}></td>
    <td class="${dueCls ? 'due ' + dueCls : ''}"><input type="date" data-edit="due_date" value="${U.esc(t.due_date || '')}" ${dis('due_date')}></td>
    <td><span class="mini-pbar"><div style="width:${t.progress}%"></div></span>${t.progress}%</td>
    ${vis.est ? `<td><input type="number" data-edit="estimate_h" value="${t.estimate_h ?? ''}" min="0" step="0.5" style="width:56px" ${dis('estimate_h')}></td>` : ''}
    ${vis.tags ? `<td>${t.tags.map(tg => `<span class="tag-chip">${U.esc(tg)}</span>`).join(' ')}</td>` : ''}
    ${cfDefs.map(f => `<td>${U.esc(t.custom_values[f.key] ?? '')}</td>`).join('')}
    <td>${t.comment_count ? `💬${t.comment_count}` : ''}
      ${t.issue_count ? `<span class="issue-chip" title="オープンの関連課題 ${t.issue_count} 件">📌${t.issue_count}</span>` : ''}</td>
  </tr>`;
}

/* =====================================================================
 *  WBS / ガントビュー
 * =================================================================== */
const DAY = 86400000;

function ganttPrefs() {
  if (!State.gantt) State.gantt = { dayW: 24, nameW: 300, edit: false };
  return State.gantt;
}

function renderGantt(container) {
  const G = ganttPrefs();
  const smap = statusMap();
  const mmap = memberMap();
  const filtered = new Set(filteredTasks().map(t => t.id));
  let rows = buildWbs(State.tasks).filter(t => filtered.has(t.id));

  // 折りたたみ処理
  const collapsed = State.ganttCollapsed;
  const hiddenIds = new Set();
  const markHidden = (pid) => {
    for (const t of State.tasks) {
      if (t.parent_id === pid) { hiddenIds.add(t.id); markHidden(t.id); }
    }
  };
  collapsed.forEach(pid => markHidden(pid));
  rows = rows.filter(t => !hiddenIds.has(t.id));

  // 期間レンジ
  const dates = [];
  for (const t of State.tasks) {
    if (t.start_date) dates.push(t.start_date);
    if (t.due_date) dates.push(t.due_date);
  }
  if (State.project.start_date) dates.push(State.project.start_date);
  if (State.project.end_date) dates.push(State.project.end_date);
  dates.push(U.todayStr());
  const minD = new Date(dates.reduce((a, b) => a < b ? a : b));
  const maxD = new Date(dates.reduce((a, b) => a > b ? a : b));
  const start = new Date(minD.getTime() - 5 * DAY);
  const end = new Date(maxD.getTime() + 10 * DAY);
  const nDays = Math.round((end - start) / DAY) + 1;
  const dayW = G.dayW;
  const chartW = nDays * dayW;
  const rowH = 34, headH = 46;
  const x = (d) => Math.round((new Date(d) - start) / DAY) * dayW;
  const dateAt = (px) => new Date(start.getTime() + Math.floor(px / dayW) * DAY)
    .toISOString().slice(0, 10);

  const editable = canSchedule();
  if (!editable) G.edit = false;

  // ヘッダー2段（月／週の開始日）— 重なり防止のため行を分離
  let months = '', dayMarks = '', grid = '', weekend = '';
  const cur = new Date(start);
  while (cur <= end) {
    const iso = cur.toISOString().slice(0, 10);
    const px = x(iso);
    if (cur.getDate() === 1 || iso === start.toISOString().slice(0, 10)) {
      months += `<div class="g-month" style="left:${px}px">${cur.getFullYear()}/${cur.getMonth() + 1}</div>`;
    }
    const dow = cur.getDay();
    if (dow === 1 && dayW >= 8) {
      dayMarks += `<div class="g-day-num" style="left:${px}px;width:${dayW * 7}px">${cur.getMonth() + 1}/${cur.getDate()}</div>`;
    }
    if ((dow === 0 || dow === 6) && dayW >= 8) {
      weekend += `<div class="g-weekend" style="left:${px}px;width:${dayW}px"></div>`;
    }
    if (dow === 1) grid += `<div class="g-grid-day g-grid-week" style="left:${px}px"></div>`;
    else if (dayW >= 14) grid += `<div class="g-grid-day" style="left:${px}px"></div>`;
    cur.setDate(cur.getDate() + 1);
  }
  const todayX = x(U.todayStr());

  // 依存線
  const rowIndex = new Map(rows.map((t, i) => [t.id, i]));
  let depLines = '';
  for (const t of rows) {
    if (!t.start_date) continue;
    for (const depId of t.deps || []) {
      const dep = State.tasks.find(d => d.id === depId);
      if (!dep || !dep.due_date || !rowIndex.has(depId)) continue;
      const x1 = x(dep.due_date) + dayW, y1 = rowIndex.get(depId) * rowH + 17;
      const x2 = x(t.start_date), y2 = rowIndex.get(t.id) * rowH + 17;
      depLines += `<path d="M ${x1} ${y1} L ${x1 + 6} ${y1} L ${x1 + 6} ${y2} L ${x2 - 4} ${y2} M ${x2 - 4} ${y2} l -5 -4 m 5 4 l -5 4"
        fill="none" stroke="#94a3b8" stroke-width="1.4"/>`;
    }
  }

  const fmtShort = (s) => s ? `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}` : '';
  const leftRows = rows.map(t => {
    const kids = hasChildren(t.id);
    const isCollapsed = collapsed.has(t.id);
    const aname = hasChildren(t.id) ? null : assigneeName(t);
    const aColor = assigneeColorOf(t);
    const dueCls2 = U.dueClass(t, smap);
    return `<div class="g-row ${G.edit ? 'g-editable-row' : ''}" data-row="${t.id}" ${G.edit ? 'draggable="true"' : ''}>
      <span class="g-wbs">${G.edit ? '<span class="g-grip" title="ドラッグで並べ替え">⠿</span>' : ''}${U.esc(t.wbs)}</span>
      <div class="g-cell-name" style="width:${G.nameW}px;min-width:${G.nameW}px;padding-left:${8 + t.depth * 14}px">
        ${kids ? `<button class="g-toggle" data-toggle="${t.id}">${isCollapsed ? '▶' : '▼'}</button>` : '<span style="width:18px;flex-shrink:0"></span>'}
        <span class="t" data-open="${t.id}" title="${U.esc(t.title)}">${t.milestone ? '◆ ' : ''}${U.esc(t.title)}</span>
        ${G.edit ? `<span class="g-rowtools">
          <button class="g-tool" data-addsub="${t.id}" title="サブタスクを追加">＋</button>
          <button class="g-tool" data-indent="${t.id}" title="1階層下げる（直前のタスクの子にする）">⭢</button>
          <button class="g-tool" data-outdent="${t.id}" title="1階層上げる">⭠</button>
        </span>` : ''}
      </div>
      <span class="g-cell-sm g-col-a" title="${aname ? U.esc(aname) : ''}"
        ${aname && aColor ? `style="color:${aColor};font-weight:600"` : ''}>${aname
          ? `<span class="a-dot" style="background:${aColor}"></span>` + U.esc(aname.split(/[\s　]/)[0]) : '—'}</span>
      <span class="g-cell-sm g-col-d ${dueCls2 ? 'g-due-' + dueCls2 : ''}">${fmtShort(t.start_date)}${(t.start_date || t.due_date) ? '〜' : ''}${fmtShort(t.due_date)}${dueCls2 === 'overdue' ? ' ⚠' : ''}</span>
      <span class="g-cell-sm g-col-p">${t.progress}%</span>
    </div>`;
  }).join('');

  // 基準線（保存時点の計画）を細い灰色バーで重ねる
  const bl = State.baseline || {};
  const blBars = rows.map((t, i) => {
    const b = bl[t.id] || bl[String(t.id)];
    if (!b || !b.start || !b.due) return '';
    const left = x(b.start);
    const w = Math.max(dayW, x(b.due) - left + dayW);
    return `<div class="g-blbar" style="left:${left}px;top:${i * rowH + 27}px;width:${w}px" title="基準線: ${b.start}〜${b.due}"></div>`;
  }).join('');

  const bars = rows.map((t, i) => {
    // バーは担当者の表示色で塗る（未割当はグレー、親タスクは中立色）
    const color = hasChildren(t.id) ? '#8b95a7'
      : (assigneeColorOf(t) || '#94a3b8');
    const y = i * rowH;
    if (t.milestone && t.due_date) {
      return `<div class="g-ms" data-open="${t.id}" style="left:${x(t.due_date) + dayW / 2 - 7}px;top:${y + 10}px" title="${U.esc(t.title)} (${t.due_date})"></div>`;
    }
    if (!t.start_date && !t.due_date) return '';
    const s = t.start_date || t.due_date, e = t.due_date || t.start_date;
    const left = x(s);
    const w = Math.max(dayW, x(e) - left + dayW);
    const parent = hasChildren(t.id);
    return `<div class="g-bar ${parent ? 'parent' : ''} ${G.edit && !parent ? 'editable' : ''}" data-bar="${t.id}"
        style="left:${left}px;top:${y + (parent ? 13 : 8)}px;width:${w}px;background:${U.esc(color)}"
        title="${U.esc(t.wbs)} ${U.esc(t.title)}  ${s} 〜 ${e}  進捗${t.progress}%">
      <div class="fill" style="width:${t.progress}%"></div>
      ${!parent && w > 80 ? `<span class="g-bar-label">${U.esc(t.wbs)} ${U.esc(t.title)}</span>` : ''}
      ${G.edit && !parent ? `<div class="g-resize-l" data-resize-l="${t.id}" title="開始日のみ変更"></div>
        <div class="g-resize" data-resize="${t.id}" title="期限のみ変更"></div>` : ''}
    </div>`;
  }).join('');

  // 編集モード時: 最下段に「ドラッグで新規作成」レーン
  const bodyH = (rows.length + (G.edit ? 1 : 0)) * rowH;
  const newLaneLeft = G.edit
    ? `<div class="g-row g-newlane-label"><span class="g-wbs"></span>
        <div class="g-cell-name" style="width:${G.nameW}px;min-width:${G.nameW}px;padding-left:26px">＋ 右のチャートをドラッグして新規タスク</div>
        <span class="g-cell-sm g-col-a"></span><span class="g-cell-sm g-col-d"></span><span class="g-cell-sm g-col-p"></span></div>`
    : '';

  container.innerHTML = `
  <div class="gantt-toolbar">
    ${editable
      ? `<button class="btn sm ${G.edit ? 'primary' : ''}" id="g-edit-toggle">${G.edit ? '✏ 編集モード中（クリックで終了）' : '✏ 編集'}</button>`
      : '<span class="tag-chip">閲覧モード（日程の編集は管理者ロールのみ）</span>'}
    <span class="spacer"></span>
    <span style="color:var(--muted);font-size:12px">日幅 ${dayW}px</span>
    <button class="btn sm" id="g-zoom-out" title="縮小">－</button>
    <button class="btn sm" id="g-zoom-in" title="拡大">＋</button>
    <button class="btn sm" id="g-zoom-fit">全体表示</button>
    ${editable ? '<button class="btn sm" id="g-baseline" title="現在の日程を基準線として保存">📏 基準線保存</button>' : ''}
    ${editable ? '<button class="btn sm" id="g-import" title="WBSガントExcelを取り込み（ID列で突合・ID空行は新規追加）">📥 取込</button>' : ''}
    <button class="btn sm" id="g-export" title="Excelガントチャートを出力（取込での往復に対応）">📗 出力</button>
    ${State.baseline && Object.keys(State.baseline).length ? '<span class="tag-chip" title="灰色の細いバーが基準線（保存時点の計画）">基準線表示中</span>' : ''}
    ${G.edit ? `<span class="g-help" title="バー中央ドラッグ＝日程移動
左端＝開始日のみ・右端＝期限のみ変更
左の行を⠿でドラッグ＝並べ替え
⭢⭠＝階層変更 ／ ＋＝サブタスク追加
最下段レーンをドラッグ＝新規タスク作成">❓ 操作方法</span>` : ''}
  </div>
  <div class="gantt-wrap" id="gantt-wrap">
    <div style="display:flex;min-width:fit-content">
      <div class="gantt-left">
        <div class="g-row g-head" style="height:${headH}px">
          <span class="g-wbs">WBS</span>
          <div class="g-cell-name" style="width:${G.nameW}px;min-width:${G.nameW}px">タスク名
            <span class="g-name-resizer" id="g-name-resizer" title="ドラッグで列幅変更"></span></div>
          <span class="g-cell-sm g-col-a">担当</span>
          <span class="g-cell-sm g-col-d">期間</span>
          <span class="g-cell-sm g-col-p">進捗</span>
        </div>
        ${leftRows}${newLaneLeft}
      </div>
      <div class="gantt-chart" style="width:${chartW}px">
        <div class="g-timehead" style="height:${headH}px">
          <div class="g-mrow">${months}</div>
          <div class="g-drow">${dayMarks}
            <div class="g-today-chip" style="left:${todayX}px">今日</div></div>
        </div>
        <div class="g-gbody" id="g-body" style="height:${bodyH}px">
          ${weekend}${grid}
          <div class="g-today" style="left:${todayX}px"></div>
          <svg class="g-dep" width="${chartW}" height="${bodyH}">${depLines}</svg>
          ${blBars}${bars}
        </div>
      </div>
    </div>
  </div>`;

  // ガント領域を画面の高さに収め、ツールバーと横スクロールバーを常に見える位置に固定する
  const wrapEl = container.querySelector('#gantt-wrap');
  const fitWrap = () => {
    if (!wrapEl.isConnected) return;
    const top = wrapEl.getBoundingClientRect().top;
    wrapEl.style.height = `${Math.max(240, window.innerHeight - top - 18)}px`;
  };
  fitWrap();
  if (State._ganttFit) window.removeEventListener('resize', State._ganttFit);
  State._ganttFit = fitWrap;
  window.addEventListener('resize', State._ganttFit);

  container.querySelectorAll('[data-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.toggle);
      if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
      renderGantt(container);
    });
  });
  container.querySelectorAll('.g-cell-name [data-open], .g-ms').forEach(el => {
    el.addEventListener('click', () => openDetail(Number(el.dataset.open)));
  });

  // ---- 編集モード: 行ツール（サブタスク追加・階層変更）と行の並べ替えDnD
  if (G.edit) {
    const patch = async (tid, body) => {
      try {
        await API.updateTask(tid, { ...body, actor_id: State.currentUserId });
        await refresh();
      } catch (err) { toast(err.message); }
    };
    container.querySelectorAll('[data-addsub]').forEach(b => {
      b.onclick = (e) => { e.stopPropagation(); openTaskModal({ parent_id: Number(b.dataset.addsub) }); };
    });
    container.querySelectorAll('[data-indent]').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        const t = State.tasks.find(x => x.id === Number(b.dataset.indent));
        const sibs = State.tasks.filter(x => x.parent_id === t.parent_id)
          .sort((a, c) => (a.sort_order - c.sort_order) || (a.id - c.id));
        const idx = sibs.findIndex(x => x.id === t.id);
        if (idx <= 0) { toast('直前に同階層のタスクがないため下げられません'); return; }
        patch(t.id, { parent_id: sibs[idx - 1].id, sort_order: 9999 });
      };
    });
    container.querySelectorAll('[data-outdent]').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        const t = State.tasks.find(x => x.id === Number(b.dataset.outdent));
        if (t.parent_id == null) { toast('すでに最上位です'); return; }
        const parent = State.tasks.find(x => x.id === t.parent_id);
        patch(t.id, { parent_id: parent ? parent.parent_id : null,
                      sort_order: (parent ? parent.sort_order : 0) + 1 });
      };
    });
    // 行の並べ替え（ドロップ先の直後・同じ親の兄弟として挿入）
    let dragRowId = null;
    container.querySelectorAll('.gantt-left [data-row]').forEach(row => {
      row.addEventListener('dragstart', (e) => {
        dragRowId = Number(row.dataset.row);
        e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('g-drop-target'); });
      row.addEventListener('dragleave', () => row.classList.remove('g-drop-target'));
      row.addEventListener('drop', async (e) => {
        e.preventDefault();
        row.classList.remove('g-drop-target');
        const targetId = Number(row.dataset.row);
        if (dragRowId == null || dragRowId === targetId) return;
        const dragged = State.tasks.find(x => x.id === dragRowId);
        const target = State.tasks.find(x => x.id === targetId);
        if (!dragged || !target) return;
        if (isDescendant(targetId, dragRowId)) { toast('自分の子孫の下には移動できません'); return; }
        const sibs = State.tasks
          .filter(x => x.parent_id === target.parent_id && x.id !== dragged.id)
          .sort((a, c) => (a.sort_order - c.sort_order) || (a.id - c.id));
        const idx = sibs.findIndex(x => x.id === targetId);
        sibs.splice(idx + 1, 0, dragged);
        try {
          await API.reorder(sibs.map((x, i) => ({ id: x.id, sort_order: i, parent_id: target.parent_id })));
          await refresh();
          toast('並び順を変更しました');
        } catch (err) { toast(err.message); }
        dragRowId = null;
      });
    });
  }

  const rerender = () => renderGantt(container);
  const et = container.querySelector('#g-edit-toggle');
  if (et) et.onclick = () => { G.edit = !G.edit; rerender(); };
  const gi = container.querySelector('#g-import');
  if (gi) gi.onclick = () => importViewXlsx('tasks');
  container.querySelector('#g-export').onclick = () => exportViewXlsx('gantt');
  container.querySelector('#g-zoom-out').onclick = () => { G.dayW = Math.max(6, G.dayW - 4); rerender(); };
  container.querySelector('#g-zoom-in').onclick = () => { G.dayW = Math.min(48, G.dayW + 4); rerender(); };
  // 基準線の遅延読込・保存
  if (State.baselinePid !== State.pid) {
    State.baselinePid = State.pid;
    State.baseline = null;
    API.latestBaseline(State.pid).then(b => {
      State.baseline = b.exists ? b.snapshot : {};
      if (State.view === 'gantt') renderGantt(container);
    }).catch(() => {});
  }
  const blBtn = container.querySelector('#g-baseline');
  if (blBtn) blBtn.onclick = async () => {
    if (!confirm('現在の全タスクの日程を基準線として保存しますか？（以前の基準線より新しいものが表示されます）')) return;
    await API.saveBaseline(State.pid, null, State.currentUserId);
    State.baselinePid = null;
    toast('基準線を保存しました');
    rerender();
  };
  container.querySelector('#g-zoom-fit').onclick = () => {
    const wrap = container.querySelector('#gantt-wrap');
    const leftW = container.querySelector('.gantt-left').offsetWidth;
    G.dayW = Math.max(4, Math.floor((wrap.clientWidth - leftW - 20) / nDays));
    rerender();
  };

  // タスク名列のリサイズ（Excel風）
  container.querySelector('#g-name-resizer').addEventListener('mousedown', (e) => {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, orig = G.nameW;
    const move = (ev) => {
      G.nameW = Math.max(140, Math.min(600, orig + ev.clientX - startX));
      container.querySelectorAll('.g-cell-name').forEach(el => {
        el.style.width = G.nameW + 'px'; el.style.minWidth = G.nameW + 'px';
      });
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      rerender();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  setupGanttInteractions(container, { G, rows, rowH, dayW, dateAt });
}

function setupGanttInteractions(container, ctx) {
  const { G, rows, rowH, dayW, dateAt } = ctx;
  const body = container.querySelector('#g-body');
  let drag = null;

  const shift = (dstr, days) => {
    if (!dstr) return dstr;
    const d = new Date(dstr);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };

  // バー: 編集モードなら移動/リサイズ、閲覧モード・クリックは詳細表示
  container.querySelectorAll('.g-bar').forEach(bar => {
    bar.addEventListener('mousedown', (e) => {
      const tid = Number(bar.dataset.bar);
      const t = State.tasks.find(x => x.id === tid);
      if (!t) return;
      if (!G.edit || bar.classList.contains('parent')) {
        drag = { tid, mode: 'click' };
        e.preventDefault();
        return;
      }
      const resizeL = e.target.closest('[data-resize-l]');
      const resize = e.target.closest('[data-resize]');
      drag = { tid, bar,
               mode: resizeL ? 'resize-start' : resize ? 'resize' : 'move',
               startX: e.clientX,
               orig: { start: t.start_date, due: t.due_date },
               origLeft: parseInt(bar.style.left), origW: parseInt(bar.style.width),
               moved: false, days: 0 };
      e.preventDefault();
      e.stopPropagation();
    });
  });

  // 空きエリアのドラッグ（編集モード）: 新規作成レーン or 日付なしタスクの期間設定
  if (G.edit) {
    body.addEventListener('mousedown', (e) => {
      if (e.target.closest('.g-bar') || e.target.closest('.g-ms')) return;
      const rect = body.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      const rowIdx = Math.floor(py / rowH);
      let target = null;   // null → 新規作成レーン
      if (rowIdx < rows.length) {
        const t = rows[rowIdx];
        if (t.start_date || t.due_date || t.milestone) return;
        target = t;
      } else if (rowIdx !== rows.length) {
        return;
      }
      const ghost = document.createElement('div');
      ghost.className = 'g-bar g-ghost';
      ghost.style.top = (rowIdx * rowH + 8) + 'px';
      body.appendChild(ghost);
      drag = { mode: 'create', target, anchor: px, ghost, moved: false };
      e.preventDefault();
    });
  }

  const onMove = (e) => {
    if (!drag || drag.mode === 'click') return;
    if (drag.mode === 'create') {
      const rect = body.getBoundingClientRect();
      const px = Math.max(0, e.clientX - rect.left);
      const a = Math.min(drag.anchor, px), b = Math.max(drag.anchor, px);
      const left = Math.floor(a / dayW) * dayW;
      const w = Math.max(dayW, (Math.floor(b / dayW) - Math.floor(a / dayW) + 1) * dayW);
      drag.ghost.style.left = left + 'px';
      drag.ghost.style.width = w + 'px';
      drag.moved = true;
      drag.range = [dateAt(a), dateAt(b)];
      return;
    }
    const dx = e.clientX - drag.startX;
    const days = Math.round(dx / dayW);
    if (Math.abs(dx) > 3) drag.moved = true;
    if (drag.mode === 'move') {
      drag.bar.style.left = (drag.origLeft + days * dayW) + 'px';
    } else if (drag.mode === 'resize-start') {
      // 開始日のみ移動: 左端を動かし、右端（期限）は固定
      const capped = Math.min(days, Math.round((drag.origW - dayW) / dayW));
      drag.bar.style.left = (drag.origLeft + capped * dayW) + 'px';
      drag.bar.style.width = (drag.origW - capped * dayW) + 'px';
      drag.days = capped;
      return;
    } else {
      drag.bar.style.width = Math.max(dayW, drag.origW + days * dayW) + 'px';
    }
    drag.days = days;
  };

  const onUp = async () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.mode === 'click' ||
        (['move', 'resize', 'resize-start'].includes(d.mode) && !d.moved)) {
      if (d.ghost) d.ghost.remove();
      if (d.tid) openDetail(d.tid);
      return;
    }
    try {
      if (d.mode === 'create') {
        d.ghost.remove();
        if (!d.moved || !d.range) return;
        const [s, e2] = d.range;
        if (d.target) {
          await API.updateTask(d.target.id,
            { start_date: s, due_date: e2, actor_id: State.currentUserId });
          await refresh();
          toast(`「${d.target.title}」の期間を設定しました`);
        } else {
          openTaskModal({ start_date: s, due_date: e2 });
        }
        return;
      }
      const days = d.days || 0;
      if (!days) { render(); return; }
      const patch = { actor_id: State.currentUserId };
      if (d.mode === 'move') {
        patch.start_date = shift(d.orig.start, days);
        patch.due_date = shift(d.orig.due, days);
      } else if (d.mode === 'resize-start') {
        patch.start_date = shift(d.orig.start || d.orig.due, days);
      } else {
        patch.due_date = shift(d.orig.due || d.orig.start, days);
      }
      await API.updateTask(d.tid, patch);
      await refresh();
      toast('日程を更新しました');
    } catch (err) { toast('更新に失敗: ' + err.message); render(); }
  };

  document.onmousemove = onMove;
  document.onmouseup = onUp;
}

/* =====================================================================
 *  ダッシュボード
 * =================================================================== */
/* =====================================================================
 *  ダッシュボード（ウィジェット方式・ユーザーごとに表示/配置をカスタマイズ可能）
 * =================================================================== */
/* [id, ラベル, 既定幅(12分割グリッドのカラム数), 既定高さ(1行=40pxのユニット数)] */
const DASH_WIDGETS = [
  ['stat_total', '📋 タスク総数', 3, 3], ['stat_done', '✅ 完了', 3, 3],
  ['stat_overdue', '⚠ 期限超過', 3, 3], ['stat_avg', '📈 平均進捗', 3, 3],
  ['status_donut', '🍩 ステータス別', 4, 7], ['member_bar', '👥 担当者別残タスク', 4, 7],
  ['priority_bar', '🔺 優先度別', 4, 7], ['week_load', '📅 週別負荷', 8, 6],
  ['deadlines', '⏰ 期限が近いタスク', 4, 8], ['mini_board', '🗂 簡易ボード', 8, 7],
  ['activity', '📰 アクティビティ', 4, 8], ['burndown', '📉 バーンダウン', 6, 7],
  ['risks', '🚨 リスクタスク', 6, 7], ['effort', '⏱ 工数', 6, 7], ['report', '📄 レポート', 6, 4],
];
const DASH_CELL = 40;   // 1行の高さ(px)

/* 位置未指定のウィジェット列を左上から順に空きへ配置（初期配置・旧形式の移行用） */
function packDash(list) {
  const colY = Array(12).fill(0);
  return list.map(it => {
    let best = { x: 0, y: Infinity };
    for (let x = 0; x <= 12 - it.w; x++) {
      const y = Math.max(...colY.slice(x, x + it.w));
      if (y < best.y) best = { x, y };
    }
    for (let x = best.x; x < best.x + it.w; x++) colY[x] = best.y + it.h;
    return { ...it, x: best.x, y: best.y };
  });
}

/* レイアウト＝ [{id, x(0-11), y(行), w(2-12), h(行数)}] の自由配置。
   旧形式（id文字列の配列 / {id,w,h} で h=''|s|m|l|px）は初回に自動移行する */
function dashLayoutItems() {
  const meta = Object.fromEntries(DASH_WIDGETS.map(([id, label, w, h]) => [id, { label, w, h }]));
  const saved = State.prefs.dash_layout;
  const normW = (w, def) => {
    const n = Math.round(Number(w));
    return (Number.isFinite(n) && n >= 2 && n <= 12) ? n : def;
  };
  const normH = (h, def) => {
    if (h === 's') return 5;
    if (h === 'm') return 8;
    if (h === 'l') return 12;
    const n = Number(h);
    if (!Number.isFinite(n) || n <= 0) return def;
    // 旧形式はpx、新形式は行数（30以下は行数とみなす）
    return Math.max(2, Math.min(24, n > 30 ? Math.round(n / DASH_CELL) : Math.round(n)));
  };
  let items;
  if (Array.isArray(saved) && saved.length) {
    const arr = saved.map(it => (typeof it === 'string' ? { id: it } : { ...it }))
      .filter(it => meta[it.id]);
    if (arr.length && arr.every(it => Number.isFinite(Number(it.x)) && Number.isFinite(Number(it.y)))) {
      items = arr.map(it => {
        const w = normW(it.w, meta[it.id].w);
        return { id: it.id, w, h: normH(it.h, meta[it.id].h),
          x: Math.max(0, Math.min(12 - w, Math.round(Number(it.x)))),
          y: Math.max(0, Math.min(500, Math.round(Number(it.y)))) };
      });
    } else {
      items = packDash(arr.map(it => ({ id: it.id, w: normW(it.w, meta[it.id].w),
        h: normH(it.h, meta[it.id].h) })));
    }
  } else {
    items = packDash(DASH_WIDGETS.map(([id, , w, h]) => ({ id, w, h })));
  }
  // 優先度を非表示にしたPJでは優先度ウィジェットを出さない
  if (!fieldVisible('priority')) items = items.filter(it => it.id !== 'priority_bar');
  return items;
}

async function saveDashLayout(items) {
  State.prefs.dash_layout = items;
  try {
    await API.setPref(State.currentUserId, 'dash_layout', items);
  } catch (e) { toast(e.message); }
}

function renderDashboard(container) {
  // 親タスク（サブタスクあり）は進捗・ステータスが自動算出のため、
  // ダッシュボードの集計・一覧（残タスク・簡易ボード等）には実作業タスクのみを使う
  const tasks = State.tasks.filter(t => !hasChildren(t.id));
  const smap = statusMap();
  const today = U.todayStr();
  const total = tasks.length;
  const done = tasks.filter(t => smap[t.status_id] && smap[t.status_id].is_done).length;
  const overdue = tasks.filter(t => t.due_date && t.due_date < today &&
    !(smap[t.status_id] && smap[t.status_id].is_done)).length;
  const avg = total ? Math.round(tasks.reduce((a, t) => a + t.progress, 0) / total) : 0;

  const statusItems = State.statuses.map(st => ({
    label: st.name, color: st.color,
    value: tasks.filter(t => t.status_id === st.id).length,
  }));
  const ov = (State.prefs && State.prefs.assignee_colors) || {};
  const memberItems = [
    ...State.members.map(m => ({
      label: m.name.split(/[\s　]/)[0], color: ov['u:' + m.id] || m.color,
      value: tasks.filter(t => t.assignee_id === m.id &&
        !(smap[t.status_id] && smap[t.status_id].is_done)).length,
    })),
    ...virtualAssignees().map(l => ({
      label: l, color: ov['v:' + l] || '#64748b',
      value: tasks.filter(t => !t.assignee_id && t.assignee_label === l &&
        !(smap[t.status_id] && smap[t.status_id].is_done)).length,
    })),
    { label: '未割当', color: '#cbd5e1',
      value: tasks.filter(t => !t.assignee_id && !t.assignee_label).length },
  ];
  const prioColors = { highest: '#ef4444', high: '#f97316', medium: '#6366f1', low: '#94a3b8' };
  const prioItems = ['highest', 'high', 'medium', 'low'].map(pr => ({
    label: U.prioLabel[pr], color: prioColors[pr],
    value: tasks.filter(t => t.priority === pr).length,
  }));
  const weeks = [];
  const wkStart = new Date();
  wkStart.setDate(wkStart.getDate() - wkStart.getDay() + 1 - 14);
  for (let i = 0; i < 10; i++) {
    const sd = new Date(wkStart.getTime() + i * 7 * DAY);
    const ed = new Date(sd.getTime() + 6 * DAY);
    const si = sd.toISOString().slice(0, 10), ei = ed.toISOString().slice(0, 10);
    weeks.push({
      label: `${sd.getMonth() + 1}/${sd.getDate()}`,
      value: tasks.filter(t => t.due_date && t.due_date >= si && t.due_date <= ei).length,
    });
  }
  const upcoming = tasks
    .filter(t => t.due_date && !(smap[t.status_id] && smap[t.status_id].is_done))
    .sort((a, b) => a.due_date < b.due_date ? -1 : 1).slice(0, 8);
  const legendHtml = (items) => `<div class="legend">${items.map(i => `
    <div class="row"><span class="dot" style="background:${i.color}"></span>
    ${U.esc(i.label)}<span class="val">${i.value}</span></div>`).join('')}</div>`;

  // ---- ウィジェット定義（id → HTML）
  const W = {};
  W.stat_total = `<div class="dash-card span3 clickable" data-go="" title="クリックで全タスクの一覧へ">
    <h3>タスク総数</h3><div class="stat-num">${total}</div><div class="stat-sub">実作業タスク（親を除く）・クリックで一覧</div></div>`;
  W.stat_done = `<div class="dash-card span3 clickable" data-go="done" title="クリックで完了タスクの一覧へ">
    <h3>完了</h3><div class="stat-num green">${done}</div>
    <div class="stat-sub">${total ? Math.round(done / total * 100) : 0}% 完了・クリックで一覧</div></div>`;
  W.stat_overdue = `<div class="dash-card span3 clickable" data-go="overdue" title="クリックで期限超過の一覧へ">
    <h3>期限超過</h3><div class="stat-num ${overdue ? 'red' : ''}">${overdue}</div>
    <div class="stat-sub">クリックで一覧表示</div></div>`;
  W.stat_avg = `<div class="dash-card span3"><h3>平均進捗</h3>
    <div class="stat-num">${avg}%</div><div class="stat-sub">全タスク平均</div></div>`;
  W.status_donut = `<div class="dash-card span4"><h3>ステータス別</h3>
    <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;justify-content:center">
      ${Charts.donut(statusItems)}${legendHtml(statusItems)}</div></div>`;
  W.member_bar = `<div class="dash-card span4"><h3>担当者別 残タスク</h3>
    ${Charts.hbar(memberItems, { width: 300 })}</div>`;
  W.priority_bar = `<div class="dash-card span4"><h3>優先度別</h3>
    ${Charts.hbar(prioItems, { width: 300 })}</div>`;
  W.week_load = `<div class="dash-card span8"><h3>週別 期限タスク数（負荷）</h3>
    ${Charts.line(weeks.map(w => w.value),
      { width: 640, height: 160, labels: weeks.map((w, i) => i % 2 === 0 ? w.label : '') })}</div>`;
  W.deadlines = `<div class="dash-card span4"><h3>期限が近いタスク</h3>
    <ul class="deadline-list">${upcoming.map(t => {
      const cls = U.dueClass(t, smap);
      return `<li data-open="${t.id}">
        ${taskAvatarHtml(t)}
        <span class="t">${U.esc(taskLabel(t))}</span>
        <span class="due ${cls}">${U.fmtDate(t.due_date)}</span></li>`;
    }).join('') || '<div class="empty-note">なし</div>'}</ul></div>`;
  W.mini_board = `<div class="dash-card span8"><h3>簡易ボード</h3>
    <div class="mini-board">${State.statuses.map(st => {
      const stt = tasks.filter(t => t.status_id === st.id);
      return `<div class="mini-col"><h4 style="border-color:${U.esc(st.color)}">${U.esc(st.name)} (${stt.length})</h4>
        ${stt.slice(0, 5).map(t => `<div class="mini-card" data-open="${t.id}">${U.esc(taskLabel(t))}</div>`).join('')}
        ${stt.length > 5 ? `<div class="mini-more">他 ${stt.length - 5} 件</div>` : ''}</div>`;
    }).join('')}</div></div>`;
  W.activity = `<div class="dash-card span4"><h3>最近のアクティビティ</h3>
    <ul class="act-list">${(State.activities || []).slice(0, 10).map(a => `
      <li><span class="act-badge">${U.esc(actLabel(a.action))}</span>
        <b>${U.esc(a.task_title || '')}</b> ${U.esc(a.detail || '')}
        <div>${U.esc(a.actor_name || 'システム')} ・ ${U.esc((a.created_at || '').slice(5, 16))}</div></li>`).join('') ||
      '<div class="empty-note">なし</div>'}</ul></div>`;
  W.burndown = `<div class="dash-card span6"><h3>📉 バーンダウン（残タスク・直近30日）</h3>
    <div id="dash-burndown" class="empty-note">読み込み中…</div></div>`;
  W.risks = `<div class="dash-card span6"><h3>⚠ リスクタスク（期限接近×進捗低・超過）</h3>
    <div id="dash-risks" class="empty-note">読み込み中…</div></div>`;
  W.effort = `<div class="dash-card span6"><h3>⏱ 工数（見積 / 実績）</h3>
    <div id="dash-effort" class="empty-note">読み込み中…</div></div>`;
  W.report = `<div class="dash-card span6"><h3>📄 レポート</h3>
    <p style="color:var(--muted);font-size:12.5px">進捗・完了・リスクを集計した週次サマリーを
      ノート（カテゴリ: レポート）に自動生成します。Webhook設定があれば同時に送信されます。</p>
    ${canEditNotes() ? '<button class="btn primary sm" id="dash-summary">週次サマリーを作成</button>' : ''}
    <a class="btn sm" href="/api/projects/${State.pid}/calendar.ics" download
      style="text-decoration:none;display:inline-block;margin-left:6px">📅 iCal（Outlook購読用）</a></div>`;

  const items = dashLayoutItems();
  const edit = !!State.dashEdit;
  const labelOf = Object.fromEntries(DASH_WIDGETS.map(([id, label]) => [id, label]));
  const itemHtml = (it) => `
    <div class="dash-item ${edit ? 'editing' : ''}"
         data-wid="${it.id}" data-x="${it.x}" data-y="${it.y}" data-w="${it.w}" data-h="${it.h}"
         style="left:${it.x / 12 * 100}%;top:${it.y * DASH_CELL}px;width:${it.w / 12 * 100}%;height:${it.h * DASH_CELL}px">
      ${edit ? `<div class="dash-item-tools">
        <span class="dash-grip" title="ドラッグで移動">⠿</span>
        <span class="dash-item-name">${labelOf[it.id] || it.id}</span>
        <button class="icon-btn" data-remove title="このウィジェットを外す">✕</button>
      </div>
      <span class="dash-rs dash-rs-r" title="ドラッグで幅変更"></span>
      <span class="dash-rs dash-rs-b" title="ドラッグで高さ変更"></span>
      <span class="dash-rs dash-rs-c" title="ドラッグでサイズ変更"></span>` : ''}
      ${W[it.id] || ''}
    </div>`;
  const gridH = (Math.max(0, ...items.map(it => it.y + it.h)) + (edit ? 6 : 0)) * DASH_CELL;
  container.innerHTML = `
    <div class="dash-toolbar">
      ${edit ? `<span class="tag-chip">レイアウト編集中 — バー掴んで移動 / 縁ドラッグでサイズ変更 / ✕で削除。好きな位置に自由配置できます（自分の画面にのみ反映）</span>` : ''}
      <span class="spacer"></span>
      ${edit ? `
        <button class="btn sm" id="dash-add">＋ ウィジェット追加</button>
        <button class="btn sm" id="dash-reset" title="既定の配置に戻す">↺ 初期配置</button>
        <button class="btn sm primary" id="dash-done">✔ 完了</button>`
      : `<button class="btn sm ghost" id="dash-customize" title="ウィジェットの追加・削除・サイズ・配置を編集（自分の画面にのみ反映）">⚙ 編集</button>`}
    </div>
    <div class="dash free ${edit ? 'editing' : ''}" id="dash-grid" style="height:${gridH}px">${items.map(itemHtml).join('')}</div>`;

  container.querySelectorAll('[data-open]').forEach(el => {
    el.addEventListener('click', () => openDetail(Number(el.dataset.open)));
  });
  // 統計カードのクリック → 条件付きテーブル
  container.querySelectorAll('[data-go]').forEach(el => {
    el.addEventListener('click', () => goTableFiltered(el.dataset.go));
  });
  if (edit) setupDashEdit(container, items);
  else container.querySelector('#dash-customize').onclick = () => { State.dashEdit = true; render(); };
  const sumBtn = container.querySelector('#dash-summary');
  if (sumBtn) sumBtn.onclick = async () => {
    sumBtn.disabled = true;
    try {
      await API.weeklySummary(State.pid, State.currentUserId);
      toast('週次サマリーをノートに作成しました');
    } catch (err) { toast(err.message); }
    sumBtn.disabled = false;
  };
  if (items.some(it => ['burndown', 'risks', 'effort'].includes(it.id))) {
    loadDashboardMetrics(container);
  }
}

/* ---- ダッシュボードのレイアウト編集モード（NetBox/Zabbix風） ---- */
function setupDashEdit(container, items) {
  const grid = container.querySelector('#dash-grid');
  const readItem = (el) => ({ id: el.dataset.wid, x: +el.dataset.x, y: +el.dataset.y,
                             w: +el.dataset.w, h: +el.dataset.h });
  const currentItems = () => [...grid.querySelectorAll('.dash-item')].map(readItem);
  const save = () => saveDashLayout(currentItems());
  const applyPos = (el) => {
    el.style.left = `${el.dataset.x / 12 * 100}%`;
    el.style.top = `${el.dataset.y * DASH_CELL}px`;
    el.style.width = `${el.dataset.w / 12 * 100}%`;
    el.style.height = `${el.dataset.h * DASH_CELL}px`;
  };
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w &&
                             a.y < b.y + b.h && b.y < a.y + a.h;
  const collides = (el) => {
    const me = readItem(el);
    return [...grid.querySelectorAll('.dash-item')].some(o => o !== el && overlaps(me, readItem(o)));
  };
  const growGrid = () => {
    const maxB = Math.max(0, ...currentItems().map(it => it.y + it.h));
    grid.style.height = `${(maxB + 6) * DASH_CELL}px`;
  };

  // 移動（バー掴み）とサイズ変更（縁ドラッグ）: 自由配置＝詰め直しはしない。重なる場合のみ元に戻す
  const drag = (el, mode) => (e) => {   // mode: move / r(幅) / b(高さ) / c(両方)
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const s = readItem(el);
    const sx = e.clientX, sy = e.clientY;
    const colPx = grid.clientWidth / 12;
    document.body.classList.add('dash-resizing');
    el.classList.add(mode === 'move' ? 'dragging' : 'resizing');
    const move = (ev) => {
      const dx = Math.round((ev.clientX - sx) / colPx);
      const dy = Math.round((ev.clientY - sy) / DASH_CELL);
      if (mode === 'move') {
        el.dataset.x = Math.max(0, Math.min(12 - s.w, s.x + dx));
        el.dataset.y = Math.max(0, s.y + dy);
      } else {
        if (mode !== 'b') el.dataset.w = Math.max(2, Math.min(12 - s.x, s.w + dx));
        if (mode !== 'r') el.dataset.h = Math.max(2, Math.min(24, s.h + dy));
      }
      applyPos(el);
      growGrid();
      el.classList.toggle('collide', collides(el));
    };
    const up = async () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('dash-resizing');
      el.classList.remove('dragging', 'resizing');
      if (collides(el)) {
        Object.assign(el.dataset, { x: s.x, y: s.y, w: s.w, h: s.h });
        applyPos(el);
        el.classList.remove('collide');
        toast('他のウィジェットと重なるため元の位置に戻しました');
      }
      growGrid();
      await save();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  grid.querySelectorAll('.dash-item').forEach(el => {
    el.querySelector('[data-remove]').onclick = async () => {
      el.remove();
      growGrid();
      await save();
    };
    // 上部バー全体で移動（✕ボタンは除く）
    el.querySelector('.dash-item-tools').addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      drag(el, 'move')(e);
    });
    el.querySelector('.dash-rs-r').addEventListener('mousedown', drag(el, 'r'));
    el.querySelector('.dash-rs-b').addEventListener('mousedown', drag(el, 'b'));
    el.querySelector('.dash-rs-c').addEventListener('mousedown', drag(el, 'c'));
  });

  container.querySelector('#dash-done').onclick = () => { State.dashEdit = false; render(); };
  container.querySelector('#dash-reset').onclick = async () => {
    if (!confirm('ウィジェットの配置・サイズを既定に戻しますか？')) return;
    delete State.prefs.dash_layout;
    await API.setPref(State.currentUserId, 'dash_layout', null);
    render();
    toast('既定の配置に戻しました');
  };
  container.querySelector('#dash-add').onclick = () => {
    const shown = new Set(currentItems().map(it => it.id));
    const hidden = DASH_WIDGETS.filter(([id]) =>
      !shown.has(id) && (id !== 'priority_bar' || fieldVisible('priority')));
    if (!hidden.length) { toast('追加できるウィジェットはありません（すべて表示中）'); return; }
    showModal(`
      <h2>＋ ウィジェットを追加</h2>
      <div id="da-list">${hidden.map(([id, label]) => `
        <div class="status-edit-row" style="cursor:pointer" data-add="${id}">
          <span style="flex:1">${label}</span><span class="tag-chip">追加</span>
        </div>`).join('')}</div>
      <div class="modal-actions"><button class="btn" data-close>閉じる</button></div>`);
    document.querySelectorAll('#da-list [data-add]').forEach(row => {
      row.onclick = async () => {
        const def = DASH_WIDGETS.find(([i]) => i === row.dataset.add);
        const cur = currentItems();
        // 空いている場所（左上から走査）に配置する
        let pos = null;
        for (let y = 0; y <= 500 && !pos; y++) {
          for (let x = 0; x <= 12 - def[2]; x++) {
            const cand = { x, y, w: def[2], h: def[3] };
            if (!cur.some(o => overlaps(cand, o))) { pos = { x, y }; break; }
          }
        }
        await saveDashLayout([...cur, { id: def[0], w: def[2], h: def[3], ...pos }]);
        closeModal();
        render();
      };
    });
  };
}

/* メトリクス（バーンダウン・工数・リスク）を非同期で流し込む */
async function loadDashboardMetrics(container) {
  let m;
  try { m = await API.metrics(State.pid); } catch (e) { return; }
  const bd = container.querySelector('#dash-burndown');
  if (bd) {
    const pts = m.burndown.map(x => x.remaining);
    const labels = m.burndown.map((x, i) => i % 7 === 0 ? x.date.slice(5) : '');
    bd.classList.remove('empty-note');
    bd.innerHTML = Charts.line(pts, { width: 560, height: 150, yMax: Math.max(m.total, 1), labels });
  }
  const rk = container.querySelector('#dash-risks');
  if (rk) {
    rk.classList.remove('empty-note');
    rk.innerHTML = m.risks.length ? `<ul class="deadline-list">${m.risks.slice(0, 8).map(r => `
      <li data-open="${r.id}">
        <span class="t">${U.esc(wbsOf(r.id) ? wbsOf(r.id) + ' ' + r.title : r.title)}</span>
        <span style="color:var(--muted);font-size:12px">${U.esc(r.assignee || '未割当')} / ${r.progress}%</span>
        <span class="due ${r.overdue ? 'overdue' : 'soon'}">${U.esc(r.due.slice(5))}${r.overdue ? ' 超過' : ''}</span>
      </li>`).join('')}</ul>` : '<div class="empty-note">リスクはありません 🎉</div>';
    rk.querySelectorAll('[data-open]').forEach(el =>
      el.addEventListener('click', () => openDetail(Number(el.dataset.open))));
  }
  const ef = container.querySelector('#dash-effort');
  if (ef) {
    ef.classList.remove('empty-note');
    ef.innerHTML = `<table class="admin-table"><thead>
      <tr><th>担当</th><th>タスク</th><th>見積h</th><th>実績h</th><th>差分</th></tr></thead>
      <tbody>${m.effort.map(e => {
        const diff = (e.actual || 0) - (e.estimate || 0);
        return `<tr><td>${U.esc(e.assignee)}</td><td>${e.tasks}</td>
          <td>${e.estimate || 0}</td><td>${e.actual || 0}</td>
          <td style="color:${diff > 0 ? 'var(--danger)' : '#16a34a'}">${diff > 0 ? '+' : ''}${diff}</td></tr>`;
      }).join('')}</tbody></table>`;
  }
}

function actLabel(a) {
  return { create: '作成', status: '状態', assignee: '担当', progress: '進捗',
           comment: '💬', delete: '削除',
           member_add: '参加', member_remove: '離脱' }[a] || a;
}

/* =====================================================================
 *  ホーム（プロジェクト横断・マイダッシュボード）
 * =================================================================== */
async function renderHome(container) {
  container.innerHTML = '<div class="empty-note">読み込み中…</div>';
  let ov;
  try {
    ov = await API.overview(State.currentUserId);
  } catch (err) {
    container.innerHTML = `<div class="empty-note">読み込みに失敗しました: ${U.esc(err.message)}</div>`;
    return;
  }
  const me = memberMap()[State.currentUserId];
  const today = ov.today;
  const in7 = new Date(new Date(today).getTime() + 7 * DAY).toISOString().slice(0, 10);
  const myOverdue = ov.my_tasks.filter(t => t.due_date && t.due_date < today).length;
  const myWeek = ov.my_tasks.filter(t => t.due_date && t.due_date >= today && t.due_date <= in7).length;
  const totalMyOpen = ov.my_tasks.length;

  const projCards = ov.projects.map(p => {
    const pr = p.project;
    const pct = p.total ? Math.round(p.done / p.total * 100) : 0;
    const distTotal = p.status_dist.reduce((a, s) => a + s.count, 0) || 1;
    const stacked = p.status_dist.filter(s => s.count).map(s =>
      `<div style="width:${s.count / distTotal * 100}%;background:${U.esc(s.color)}"
        title="${U.esc(s.name)}: ${s.count}"></div>`).join('');
    return `<div class="proj-card" data-goto="${pr.id}">
      <div class="pc-head">
        <span class="proj-dot" style="background:${U.esc(pr.color)}"></span>
        <b>${U.esc(pr.name)}</b>
        ${p.overdue ? `<span class="pc-overdue">⚠ 超過${p.overdue}</span>` : ''}
      </div>
      <div class="pc-meta">
        タスク ${p.done}/${p.total} 完了 ・ 👥 ${p.member_count}名
        ${p.my_open ? ` ・ 自分の担当 <b>${p.my_open}</b>件` : ''}
      </div>
      <div class="pc-bar"><div style="width:${pct}%"></div></div>
      <div class="pc-dist">${stacked}</div>
      <div class="pc-dates">${U.esc(pr.start_date || '')} 〜 ${U.esc(pr.end_date || '')}
        <span style="float:right">${pct}%</span></div>
    </div>`;
  }).join('');

  container.innerHTML = `<div class="dash">
    <div class="dash-card span12" style="display:flex;align-items:center;gap:14px;padding:14px 20px">
      ${U.avatarHtml(me)}
      <div><b style="font-size:16px">${U.esc(me ? me.name : '')}</b>
        <span style="color:var(--muted);font-size:13px;margin-left:8px">
          ${U.esc((orgMap()[me ? me.org_id : null] || {}).name || '無所属')} ・
          関与プロジェクト ${ov.projects.length} 件</span></div>
      <span style="flex:1"></span>
      <span style="color:var(--muted);font-size:12px">${today}</span>
    </div>

    <div class="dash-card span3"><h3>関与プロジェクト</h3>
      <div class="stat-num">${ov.projects.length}</div><div class="stat-sub">アサイン済み</div></div>
    <div class="dash-card span3"><h3>自分の未完了タスク</h3>
      <div class="stat-num">${totalMyOpen}</div><div class="stat-sub">全プロジェクト合計</div></div>
    <div class="dash-card span3"><h3>自分の期限超過</h3>
      <div class="stat-num ${myOverdue ? 'red' : ''}">${myOverdue}</div><div class="stat-sub">要対応</div></div>
    <div class="dash-card span3"><h3>今後7日の期限</h3>
      <div class="stat-num ${myWeek ? '' : 'green'}">${myWeek}</div><div class="stat-sub">自分の担当分</div></div>

    <div class="dash-card span12"><h3>🗓 全プロジェクトタイムライン</h3>
      ${portfolioHtml(ov.projects)}</div>

    <div class="dash-card span12"><h3>プロジェクト一覧（クリックで開く）</h3>
      <div class="proj-grid">${projCards ||
        '<div class="empty-note">関与しているプロジェクトがありません。<br>プロジェクトの「プロジェクトメンバー ＋」からアサインしてもらうか、新規作成してください。</div>'}</div></div>

    <div class="dash-card span7"><h3>自分のタスク（期限順・全プロジェクト横断）</h3>
      <ul class="deadline-list">${ov.my_tasks.map(t => {
        const cls = (!t.due_date || t.is_done || t.progress >= 100) ? ''
          : t.due_date < today ? 'overdue'
          : (new Date(t.due_date) - new Date(today)) / DAY <= 3 ? 'soon' : '';
        return `<li data-task="${t.id}" data-proj="${t.project_id}">
          <span class="tag-chip" style="background:${U.esc(t.project_color)}22;border-left:3px solid ${U.esc(t.project_color)}">${U.esc(t.project_name)}</span>
          <span class="t">${U.esc(t.title)}</span>
          ${t.status_name ? `<span class="badge" style="background:${U.esc(t.status_color || '#94a3b8')}">${U.esc(t.status_name)}</span>` : ''}
          <span class="due ${cls}">${t.due_date ? U.fmtDate(t.due_date) : '期限なし'}</span></li>`;
      }).join('') || '<div class="empty-note">未完了の担当タスクはありません 🎉</div>'}</ul></div>

    <div class="dash-card span5"><h3>最近のアクティビティ（横断）</h3>
      <ul class="act-list">${ov.activities.map(a => `
        <li><span class="act-badge">${U.esc(actLabel(a.action))}</span>
          <span class="tag-chip">${U.esc(a.project_name)}</span>
          <b>${U.esc(a.task_title || '')}</b> ${U.esc(a.detail || '')}
          <div>${U.esc(a.actor_name || 'システム')} ・ ${U.esc((a.created_at || '').slice(5, 16))}</div></li>`).join('') ||
        '<div class="empty-note">なし</div>'}</ul></div>
  </div>`;

  // プロジェクトカード → プロジェクトを開く
  container.querySelectorAll('[data-goto]').forEach(el => {
    el.addEventListener('click', async () => {
      await loadProject(Number(el.dataset.goto));
      State.view = 'board';
      render();
    });
  });
  // 自分のタスク → 該当プロジェクトを読み込んで詳細を開く
  container.querySelectorAll('[data-task]').forEach(el => {
    el.addEventListener('click', async () => {
      const pid = Number(el.dataset.proj);
      if (State.pid !== pid) await loadProject(pid);
      State.view = 'board';
      render();
      openDetail(Number(el.dataset.task));
    });
  });
}

/* 全PJの期間を1本のタイムラインに（ポートフォリオビュー） */
function portfolioHtml(projects) {
  const withDates = projects.filter(p => p.project.start_date && p.project.end_date);
  if (!withDates.length) return '<div class="empty-note">期間が設定されたプロジェクトがありません</div>';
  const min = withDates.reduce((a, p) => a < p.project.start_date ? a : p.project.start_date,
                               withDates[0].project.start_date);
  const max = withDates.reduce((a, p) => a > p.project.end_date ? a : p.project.end_date,
                               withDates[0].project.end_date);
  const t0 = new Date(min).getTime(), t1 = new Date(max).getTime() + DAY;
  const span = Math.max(t1 - t0, DAY);
  const pos = (d) => Math.min(100, Math.max(0, (new Date(d).getTime() - t0) / span * 100));
  const todayPct = pos(U.todayStr());
  return `<div class="pf-wrap">
    ${withDates.map(p => {
      const pr = p.project;
      const l = pos(pr.start_date), w = Math.max(1.5, pos(pr.end_date) - l);
      const pct = p.total ? Math.round(p.done / p.total * 100) : 0;
      return `<div class="pf-row" data-goto="${pr.id}">
        <span class="pf-name" title="${U.esc(pr.name)}">${U.esc(pr.name)}</span>
        <div class="pf-track">
          <div class="pf-bar" style="left:${l}%;width:${w}%;background:${U.esc(pr.color)}"
               title="${U.esc(pr.start_date)} 〜 ${U.esc(pr.end_date)} / ${pct}%完了">
            <div class="pf-fill" style="width:${pct}%"></div>
          </div>
          <div class="pf-today" style="left:${todayPct}%"></div>
        </div>
        <span class="pf-pct">${pct}%</span>
      </div>`;
    }).join('')}
    <div class="pf-scale"><span>${U.esc(min)}</span><span>${U.esc(max)}</span></div>
  </div>`;
}

/* =====================================================================
 *  イシュービュー（コメントスレッド一覧 — 元データはタスクのコメントと同一）
 * =================================================================== */
async function renderIssues(container) {
  if (!canViewComments()) {
    container.innerHTML = '<div class="empty-note">コメントの閲覧権限がありません（外部ユーザー制限）。</div>';
    return;
  }
  container.innerHTML = '<div class="empty-note">読み込み中…</div>';
  let d;
  try {
    d = await API.discussions(State.pid, State.currentUserId);
  } catch (err) {
    container.innerHTML = `<div class="empty-note">読み込みに失敗しました: ${U.esc(err.message)}</div>`;
    return;
  }
  const smap = statusMap();
  const mmap = memberMap();

  const threadRows = d.threads.map(th => {
    const st = smap[th.status_id];
    const m = mmap[th.assignee_id];
    return `<div class="issue-row" data-open="${th.id}">
      <span class="issue-icon">💬</span>
      <div class="issue-main">
        <div class="issue-title">${U.esc(th.title)}
          ${st ? `<span class="badge" style="background:${U.esc(st.color)}">${U.esc(st.name)}</span>` : ''}
          ${U.prioHtml(th.priority)}</div>
        <div class="issue-sub">
          最終: <b>${U.esc(th.last_author || '不明')}</b> ${U.esc((th.last_at || '').slice(5, 16))}
          — ${U.esc(th.last_body)}${th.last_body && th.last_body.length >= 80 ? '…' : ''}</div>
      </div>
      <span class="issue-count">💬 ${th.comment_count}</span>
      ${U.avatarHtml(m)}
    </div>`;
  }).join('');

  container.innerHTML = `<div class="dash">
    <div class="dash-card span7">
      <h3>コメント一覧（議論のあるタスク: ${d.threads.length} 件）</h3>
      <p style="color:var(--muted);font-size:12px;margin:0 0 10px">
        クリックで議論ページを開きます。プロジェクト未参加の社内メンバーもここからコメントでき、
        @名前 でメンションして意見を求められます。</p>
      ${threadRows || '<div class="empty-note">まだ議論のあるタスクはありません。<br>タスク詳細や議論ページからコメントを投稿するとここに表示されます。</div>'}
    </div>
    <div class="dash-card span5">
      <h3>最新コメント（時系列）</h3>
      ${d.recent.map(c => `
        <div class="issue-recent" data-open="${c.task_id}">
          <div class="meta">${U.avatarHtml(c.author_id ? { name: c.author_name, color: c.author_color } : null)}
            <b>${U.esc(c.author_name || '不明')}</b>
            <span class="tag-chip">${U.esc(wbsOf(c.task_id) ? wbsOf(c.task_id) + ' ' + c.task_title : c.task_title)}</span>
            <span style="color:var(--muted);font-size:11px">${U.esc((c.created_at || '').slice(5, 16))}</span></div>
          <div class="body">${mentionHtml(c.body.length > 120 ? c.body.slice(0, 120) + '…' : c.body)}</div>
        </div>`).join('') || '<div class="empty-note">なし</div>'}
    </div>
  </div>`;

  container.querySelectorAll('[data-open]').forEach(el => {
    el.addEventListener('click', () => openThread(Number(el.dataset.open)));
  });
}

function openThread(tid) {
  State.threadTaskId = tid;
  State.view = 'thread';
  render();
}

/* コメント配列 → {author_id: 発言数}（メンション候補の並び用） */
function commentParticipants(comments) {
  const p = {};
  for (const c of comments || []) {
    if (c.author_id) p[c.author_id] = (p[c.author_id] || 0) + 1;
  }
  return p;
}

/* @名前 のメンションをハイライトして表示 */
function mentionHtml(text) {
  return U.esc(text).replace(/@([^\s@,、。：:]+)/g, '<span class="mention">@$1</span>');
}

/* =====================================================================
 *  @メンション予測変換（Slack風オートコンプリート）
 *  「@」入力で候補を表示。ランキング: 前方一致 > 姓/名の前方一致 > 部分一致、
 *  さらに PJメンバー > 社内 > その他 の順で加点。↑↓/Enter/Tab/Escで操作。
 * =================================================================== */
function attachMentionAutocomplete(textarea, participants = {}) {
  // participants: {member_id: 発言数} — このスレッドの参加者を最上位に出す
  const wrap = textarea.parentElement;
  if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
  const dd = document.createElement('div');
  dd.className = 'mention-dd hidden';
  wrap.appendChild(dd);
  let items = [], active = 0, tokenStart = -1;

  const norm = (s) => s.replace(/[\s　]/g, '').toLowerCase();
  const candidates = (q) => {
    const memberIds = new Set(State.members.map(m => m.id));
    const nq = norm(q);
    return State.users.map(u => {
      const name = norm(u.name);
      let score;
      if (!nq) score = 10;                                   // 「@」直後は全員
      else if (name.startsWith(nq)) score = 100;             // フルネーム前方一致
      else if (u.name.split(/[\s　]/).some(p => norm(p).startsWith(nq))) score = 80;  // 姓 or 名の前方一致
      else if (name.includes(nq)) score = 40;                // 部分一致
      else return null;
      // このスレッドの参加者を最上位に。参加者同士は発言数が多いほど上
      // （発言1件差の重み20 > 自分ペナルティ15 なので、発言数順が崩れない）
      const posts = participants[u.id] || 0;
      if (posts > 0) score += 500 + Math.min(posts, 20) * 20;
      if (memberIds.has(u.id)) score += 30;                  // このPJのメンバーを優先
      if (u.account_type !== 'external') score += 10;        // 社内を優先
      if (u.id === State.currentUserId) score -= 15;         // 自分は下げる
      return { u, score };
    }).filter(Boolean)
      .sort((a, b) => b.score - a.score || a.u.name.localeCompare(b.u.name, 'ja'))
      .slice(0, 6);
  };

  const close = () => { dd.classList.add('hidden'); items = []; };
  const paint = () => {
    const memberIds = new Set(State.members.map(m => m.id));
    dd.innerHTML = items.map((it, i) => `
      <div class="mention-item ${i === active ? 'active' : ''}" data-i="${i}">
        ${U.avatarHtml(it.u)}
        <span class="mi-name">${U.esc(it.u.name)}</span>
        <span class="mi-sub">${participants[it.u.id]
          ? `💬 参加者・${participants[it.u.id]}件`
          : memberIds.has(it.u.id) ? 'PJメンバー'
          : it.u.account_type === 'external' ? '外部'
          : U.esc((orgMap()[it.u.org_id] || {}).name || '')}</span>
      </div>`).join('');
    dd.classList.remove('hidden');
    dd.querySelectorAll('.mention-item').forEach(el => {
      el.onmousedown = (e) => { e.preventDefault(); pick(Number(el.dataset.i)); };
      el.onmouseenter = () => { active = Number(el.dataset.i); paint(); };
    });
  };
  const pick = (i) => {
    const it = items[i];
    if (!it) return;
    const mention = '@' + it.u.name.replace(/[\s　]/g, '');
    const pos = textarea.selectionStart;
    textarea.value = textarea.value.slice(0, tokenStart) + mention + ' ' +
                     textarea.value.slice(pos);
    const np = tokenStart + mention.length + 1;
    textarea.setSelectionRange(np, np);
    textarea.focus();
    close();
  };
  const update = () => {
    const pos = textarea.selectionStart;
    const m = textarea.value.slice(0, pos).match(/(^|[\s　])@([^\s　@]*)$/);
    if (!m) { close(); return; }
    tokenStart = pos - m[2].length - 1;
    items = candidates(m[2]);
    active = 0;
    items.length ? paint() : close();
  };

  textarea.addEventListener('input', update);
  textarea.addEventListener('click', update);
  textarea.addEventListener('keydown', (e) => {
    if (dd.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; paint(); }
    else if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === 'Tab') {
      e.preventDefault(); pick(active);
    } else if (e.key === 'Escape') { e.stopPropagation(); close(); }
  });
  textarea.addEventListener('blur', () => setTimeout(close, 150));
}

/* =====================================================================
 *  議論ページ（GitHub Issue / チャット風の専用ページ）
 * =================================================================== */
async function renderThread(container) {
  const tid = State.threadTaskId;
  if (!tid) { State.view = 'issues'; render(); return; }
  container.innerHTML = '<div class="empty-note">読み込み中…</div>';
  let d;
  try {
    d = await API.taskDetail(tid, State.currentUserId);
  } catch (err) {
    container.innerHTML = `<div class="empty-note">読み込みに失敗しました: ${U.esc(err.message)}</div>`;
    return;
  }
  const t = d.task;
  const smap = statusMap();
  const mmap = memberMap();
  const st = smap[t.status_id];
  const assignee = mmap[t.assignee_id];

  const commentsHtml = d.comments.map(c => {
    const mine = c.author_id === State.currentUserId;
    return `<div class="th-msg ${mine ? 'mine' : ''}">
      ${U.avatarHtml(c.author_id ? { name: c.author_name, color: c.author_color } : null)}
      <div class="th-bubble">
        <div class="th-meta"><b>${U.esc(c.author_name || '不明')}</b>
          <span>${U.esc(c.created_at || '')}${c.updated_at ? '（編集済）' : ''}</span>
          ${(mine || State.myRole === 'admin')
            ? `<button class="icon-btn" data-edit-comment="${c.id}" style="font-size:11px" title="編集">✏</button>
               <button class="icon-btn" data-del-comment="${c.id}" style="font-size:11px">🗑</button>` : ''}</div>
        <div class="th-text">${mentionHtml(c.body)}</div>
        <div class="th-reactions">${reactionChips(c)}</div>
      </div></div>`;
  }).join('');

  container.innerHTML = `<div class="thread-page">
    <div class="th-head dash-card">
      <button class="btn sm" id="th-back">← コメント一覧</button>
      <div class="th-task">
        <div class="th-title">💬 ${U.esc(taskLabel(t))}</div>
        <div class="th-sub">
          ${st ? `<span class="badge" style="background:${U.esc(st.color)}">${U.esc(st.name)}</span>` : ''}
          ${U.prioHtml(t.priority)}
          <span>担当: ${assignee ? U.esc(assignee.name) : '未割当'}</span>
          ${t.due_date ? `<span>期限: ${U.esc(t.due_date)}</span>` : ''}
          <span>進捗: ${t.progress}%</span>
        </div>
      </div>
      <button class="btn sm ghost" id="th-open-task">タスク詳細を開く</button>
    </div>
    <div class="th-body" id="th-body">
      ${commentsHtml || '<div class="empty-note">まだコメントはありません。最初の発言をどうぞ。</div>'}
    </div>
    ${canComment() ? `
    <div class="th-input dash-card">
      ${U.avatarHtml(mmap[State.currentUserId])}
      <div style="flex:1">
        <textarea id="th-comment-body" placeholder="コメントを書く…（@ で候補を表示。PJ未参加のメンバーにも意見を求められます）"></textarea>
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
          <span class="comment-hint">@名前 でメンション ／ Ctrl+Enter で送信</span>
          <span class="spacer"></span>
          <button class="btn primary sm" id="th-send">送信</button>
        </div>
      </div>
    </div>` : `<div class="dash-card" style="text-align:center;color:var(--muted)">
      このプロジェクトでコメントを投稿する権限がありません（${U.esc(EFF_LABEL[State.myRole] || '未参加')}）</div>`}
  </div>`;

  document.getElementById('th-back').onclick = () => { State.view = 'issues'; render(); };
  document.getElementById('th-open-task').onclick = () => openDetail(tid);
  const body = document.getElementById('th-body');
  body.scrollTop = body.scrollHeight;

  const ta = document.getElementById('th-comment-body');
  if (ta) {
    const send = async () => {
      const text = ta.value.trim();
      if (!text) return;
      try {
        await API.addComment(tid, { body: text, author_id: State.currentUserId });
        await refresh({ keepView: true });
      } catch (err) { toast(err.message); }
    };
    document.getElementById('th-send').onclick = send;
    ta.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); };
    attachMentionAutocomplete(ta, commentParticipants(d.comments));
  }
  container.querySelectorAll('[data-del-comment]').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('このコメントを削除しますか？')) return;
      try {
        await API.deleteComment(Number(btn.dataset.delComment), State.currentUserId);
        await refresh({ keepView: true });
      } catch (err) { toast(err.message); }
    };
  });
  container.querySelectorAll('[data-edit-comment]').forEach(btn => {
    btn.onclick = async () => {
      const c = d.comments.find(x => x.id === Number(btn.dataset.editComment));
      const text = prompt('コメントを編集:', c.body);
      if (text === null || !text.trim() || text === c.body) return;
      try {
        await API.editComment(c.id, text.trim(), State.currentUserId);
        await refresh({ keepView: true });
      } catch (err) { toast(err.message); }
    };
  });
  bindReactionEvents(container);
}

/* リアクションのチップ描画（既存＋クイック追加） */
const QUICK_EMOJIS = ['👍', '✅', '👀', '🎉', '❓'];
function reactionChips(c) {
  const rx = c.reactions || [];
  return rx.map(r => `
      <button class="rx-chip ${r.mine ? 'mine' : ''}" data-react="${c.id}" data-emoji="${r.emoji}"
        title="クリックでトグル">${r.emoji} ${r.count}</button>`).join('') +
    (canComment() ? `<span class="rx-add" tabindex="0">☺+
      <span class="rx-picker">${QUICK_EMOJIS.map(e =>
        `<button class="rx-opt" data-react="${c.id}" data-emoji="${e}">${e}</button>`).join('')}</span></span>` : '');
}
function bindReactionEvents(container) {
  container.querySelectorAll('[data-react]').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      try {
        await API.react(Number(btn.dataset.react), btn.dataset.emoji, State.currentUserId);
        await refresh({ keepView: true });
      } catch (err) { toast(err.message); }
    };
  });
}

/* =====================================================================
 *  カレンダービュー（期限・マイルストーンの月表示）
 * =================================================================== */
function renderCalendar(container) {
  if (!State.calMonth) {
    const t = new Date();
    State.calMonth = [t.getFullYear(), t.getMonth()];
  }
  const [y, mo] = State.calMonth;
  const first = new Date(y, mo, 1);
  const startDow = (first.getDay() + 6) % 7;   // 月曜はじまり
  const daysInMonth = new Date(y, mo + 1, 0).getDate();
  const smap = statusMap();
  const mmap = memberMap();
  const today = U.todayStr();
  const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const gridStart = new Date(y, mo, 1 - startDow);
  const weeks = Math.ceil((startDow + daysInMonth) / 7);

  // 期間つきタスク（Googleカレンダー式に週をまたいで横断バー表示する）
  const spans = filteredTasks()
    .filter(t => t.start_date || t.due_date)
    .map(t => ({ t, s: t.start_date || t.due_date, e: t.due_date || t.start_date }))
    .sort((a, b) => a.s < b.s ? -1 : a.s > b.s ? 1 : (a.e > b.e ? -1 : 1));

  let weeksHtml = '';
  for (let w = 0; w < weeks; w++) {
    const wStart = new Date(gridStart); wStart.setDate(gridStart.getDate() + w * 7);
    const wsIso = isoOf(wStart);
    const weIso = isoOf(new Date(wStart.getFullYear(), wStart.getMonth(), wStart.getDate() + 6));
    // レーン割当（貪欲法）: 空いている一番上の段に置く
    const lanes = [];
    const segs = [];
    for (const sp of spans) {
      if (sp.e < wsIso || sp.s > weIso) continue;
      const sIdx = sp.s <= wsIso ? 0
        : Math.round((new Date(sp.s + 'T00:00:00') - wStart) / DAY);
      const eIdx = sp.e >= weIso ? 6
        : Math.round((new Date(sp.e + 'T00:00:00') - wStart) / DAY);
      let lane = lanes.findIndex(last => last < sIdx);
      if (lane === -1) { lane = lanes.length; lanes.push(-1); }
      lanes[lane] = eIdx;
      segs.push({ ...sp, sIdx, eIdx, lane, contL: sp.s < wsIso, contR: sp.e > weIso });
    }
    const cells = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(wStart.getFullYear(), wStart.getMonth(), wStart.getDate() + i);
      const dIso = isoOf(d);
      cells.push(`<div class="cal-cell ${d.getMonth() !== mo ? 'other' : ''} ${dIso === today ? 'today' : ''} ${i >= 5 ? 'weekend' : ''}">
        <div class="cal-date">${d.getDate() === 1 ? `${d.getMonth() + 1}/1` : d.getDate()}</div></div>`);
    }
    const bars = segs.map(sg => {
      const st = smap[sg.t.status_id];
      const done = st && st.is_done;
      const left = sg.sIdx / 7 * 100;
      const width = (sg.eIdx - sg.sIdx + 1) / 7 * 100;
      return `<div class="cal-bar ${done ? 'done' : ''} ${sg.contL ? 'contl' : ''} ${sg.contR ? 'contr' : ''}"
        data-open="${sg.t.id}"
        style="left:calc(${left}% + 2px);width:calc(${width}% - 5px);top:${26 + sg.lane * 22}px;background:${U.esc(st ? st.color : '#94a3b8')}"
        title="${U.esc(taskLabel(sg.t))}（${U.esc(sg.s)}〜${U.esc(sg.e)}）/ ${U.esc((mmap[sg.t.assignee_id] || {}).name || sg.t.assignee_label || '未割当')} / ${sg.t.progress}%">
        ${sg.t.milestone ? '◆ ' : ''}${U.esc(taskLabel(sg.t))}</div>`;
    }).join('');
    const h = Math.max(96, 30 + lanes.length * 22 + 6);
    weeksHtml += `<div class="cal-week" style="min-height:${h}px">${cells.join('')}
      <div class="cal-bars">${bars}</div></div>`;
  }
  container.innerHTML = `
    <div class="cal-toolbar">
      <button class="btn sm" id="cal-prev">←</button>
      <b style="font-size:16px">${y}年 ${mo + 1}月</b>
      <button class="btn sm" id="cal-next">→</button>
      <button class="btn sm ghost" id="cal-today">今月</button>
      <span class="spacer"></span>
      <span style="color:var(--muted);font-size:12px">開始日〜期限を横断表示（色=ステータス）。◆=マイルストーン。フィルターが効きます</span>
    </div>
    <div class="cal-grid">
      <div class="cal-head">${['月', '火', '水', '木', '金', '土', '日'].map(d => `<div class="cal-dow">${d}</div>`).join('')}</div>
      ${weeksHtml}
    </div>`;
  container.querySelector('#cal-prev').onclick = () => {
    State.calMonth = mo === 0 ? [y - 1, 11] : [y, mo - 1]; renderCalendar(container);
  };
  container.querySelector('#cal-next').onclick = () => {
    State.calMonth = mo === 11 ? [y + 1, 0] : [y, mo + 1]; renderCalendar(container);
  };
  container.querySelector('#cal-today').onclick = () => {
    const t = new Date(); State.calMonth = [t.getFullYear(), t.getMonth()]; renderCalendar(container);
  };
  container.querySelectorAll('[data-open]').forEach(el =>
    el.addEventListener('click', () => openDetail(Number(el.dataset.open))));
}

/* =====================================================================
 *  QAビュー（質問管理表。顧客とのQ&Aを管理し、顧客提出用に出力できる）
 * =================================================================== */
const QA_STATUS = [['open', '回答待ち', '#e05252'], ['pending', '保留', '#f59e0b'],
                   ['answered', '回答済み', '#4f6ef7'], ['closed', 'クローズ', '#16a34a']];
const qaNo = (q) => `QA-${String(q.seq).padStart(3, '0')}`;

async function renderQa(container) {
  container.innerHTML = '<div class="empty-note">読み込み中…</div>';
  let items = [];
  try { items = await API.qaList(State.pid); } catch (e) {
    container.innerHTML = `<div class="empty-note">${U.esc(e.message)}</div>`;
    return;
  }
  State.qaItems = items;
  if (!State.qaFilter) State.qaFilter = { status: '', kw: '' };
  drawQaView(container);
}

function drawQaView(container) {
  const f = State.qaFilter;
  const stMap = Object.fromEntries(QA_STATUS.map(([k, l, c]) => [k, { l, c }]));
  const items = State.qaItems.filter(q =>
    (!f.status || q.status === f.status) &&
    (!f.kw || `${q.title} ${q.question} ${q.answer} ${q.decision || ''} ${q.note || ''} ${q.category || ''} ${q.asker_name || ''}`
      .toLowerCase().includes(f.kw.toLowerCase())));
  const today = U.todayStr();
  const openCnt = State.qaItems.filter(q => q.status === 'open').length;
  container.innerHTML = `
  <div class="qa-toolbar">
    ${canCreateTask() ? '<button class="btn primary sm" id="qa-add">＋ QA追加</button>' : ''}
    <select id="qa-fstatus"><option value="">状態: すべて</option>
      ${QA_STATUS.map(([k, l]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${l}</option>`).join('')}
    </select>
    <input type="search" id="qa-kw" placeholder="🔍 キーワード" value="${U.esc(f.kw)}">
    <span class="tag-chip">全 ${State.qaItems.length} 件 ／ 回答待ち <b style="color:var(--danger)">${openCnt}</b> 件</span>
    <span class="spacer"></span>
    ${canManageProject() ? '<button class="btn sm" id="qa-imp" title="QA管理表Excelを取り込み（No列で突合・回答記入で自動回答済み・No空行は新規追加）">📥 Excel取込</button>' : ''}
    <button class="btn sm" id="qa-exp-x" title="整形済みのQA管理表Excelを出力（顧客提出→取込の往復に対応）">📗 Excel出力</button>
    <button class="btn sm" id="qa-exp-h" title="この一覧を単一HTMLで出力">📄 HTML出力</button>
  </div>
  <div class="qa-wrap"><table class="qa-table">
    <thead><tr><th>No</th><th>分類</th><th>件名・質問</th><th>質問者</th><th>質問日</th>
      <th>回答担当</th><th>回答期限</th><th>状態</th><th>回答</th><th>回答日</th>
      <th>決定事項</th><th>備考</th></tr></thead>
    <tbody>${items.map(q => {
      const overdue = q.due_date && ['open', 'pending'].includes(q.status) && q.due_date < today;
      const st = stMap[q.status] || { l: q.status, c: '#8b95a7' };
      return `<tr data-qid="${q.id}">
        <td class="qa-no">${qaNo(q)}</td>
        <td>${q.category ? `<span class="tag-chip">${U.esc(q.category)}</span>` : ''}</td>
        <td class="qa-q"><b>${U.esc(q.title)}</b>${q.comment_count ? ` <span class="tag-chip" title="やり取り ${q.comment_count} 件">💬${q.comment_count}</span>` : ''}${q.question ? `<div class="qa-detail">${U.esc(q.question)}</div>` : ''}
          ${q.task_id ? `<div class="qa-detail">🔗 ${U.esc(wbsOf(q.task_id) ? wbsOf(q.task_id) + ' ' : '')}${U.esc(q.task_title || '')}</div>` : ''}</td>
        <td>${U.esc(q.asker_name || '—')}</td>
        <td class="qa-date">${U.esc((q.asked_at || '').slice(5))}</td>
        <td>${U.esc(q.assignee_name || '—')}</td>
        <td class="qa-date ${overdue ? 'qa-overdue' : ''}">${U.esc((q.due_date || '').slice(5))}${overdue ? ' ⚠' : ''}</td>
        <td><span class="badge" style="background:${st.c}">${st.l}</span></td>
        <td class="qa-a">${U.esc(q.answer || '')}</td>
        <td class="qa-date">${U.esc((q.answered_at || '').slice(5))}</td>
        <td class="qa-a qa-decision">${U.esc(q.decision || '')}</td>
        <td class="qa-a qa-note">${U.esc(q.note || '')}</td></tr>`;
    }).join('') || `<tr><td colspan="12"><div class="empty-note">QAはまだありません${canCreateTask() ? '。「＋QA追加」から登録できます' : ''}</div></td></tr>`}
    </tbody></table></div>`;

  const fs = container.querySelector('#qa-fstatus');
  fs.onchange = () => { f.status = fs.value; drawQaView(container); };
  const kw = container.querySelector('#qa-kw');
  kw.oninput = U.debounce(() => {
    f.kw = kw.value;
    drawQaView(container);
    const el = container.querySelector('#qa-kw');
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, 300);
  const add = container.querySelector('#qa-add');
  if (add) add.onclick = () => openQaModal();
  container.querySelectorAll('tr[data-qid]').forEach(tr => {
    tr.onclick = () => openQaModal(State.qaItems.find(x => x.id === Number(tr.dataset.qid)));
  });
  container.querySelector('#qa-exp-x').onclick = () => exportViewXlsx('qa');
  container.querySelector('#qa-exp-h').onclick = () => exportViewHtml('qa');
  const qaImp = container.querySelector('#qa-imp');
  if (qaImp) qaImp.onclick = () => importViewXlsx('qa');
}

function openQaModal(q = null) {
  showModal(`
    <h2>${q ? `${qaNo(q)} の編集` : '＋ QAを追加'}</h2>
    <div class="form-row"><label>件名 *</label><input id="qam-title" value="${U.esc(q ? q.title : '')}" autofocus></div>
    <div class="form-cols">
      <div class="form-row"><label>分類</label><input id="qam-cat" value="${U.esc(q ? q.category || '' : '')}" placeholder="仕様 / 環境 / データ など"></div>
      <div class="form-row"><label>質問者</label><input id="qam-asker" value="${U.esc(q ? q.asker_name || '' : (State.loginUser ? State.loginUser.name : ''))}" placeholder="顧客名・担当者名"></div>
      <div class="form-row"><label>質問日</label><input type="date" id="qam-asked" value="${U.esc(q ? q.asked_at || '' : U.todayStr())}"></div>
      <div class="form-row"><label>回答期限</label><input type="date" id="qam-due" value="${U.esc(q ? q.due_date || '' : '')}"></div>
      <div class="form-row"><label>回答担当</label>
        <select id="qam-assignee"><option value="">未定</option>
          ${State.members.map(m => `<option value="${m.id}" ${q && q.assignee_id === m.id ? 'selected' : ''}>${U.esc(m.name)}</option>`).join('')}
        </select></div>
      <div class="form-row"><label>ステータス</label>
        <select id="qam-status">${QA_STATUS.map(([k, l]) =>
          `<option value="${k}" ${(q ? q.status : 'open') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="form-row"><label>関連タスク</label>
        <select id="qam-task"><option value="">（なし）</option>
          ${buildWbs(State.tasks).map(t => `<option value="${t.id}" ${q && q.task_id === t.id ? 'selected' : ''}>${U.esc(taskLabel(t))}</option>`).join('')}
        </select></div>
    </div>
    <div class="form-row"><label>質問の詳細</label><textarea id="qam-question" rows="4">${U.esc(q ? q.question || '' : '')}</textarea></div>
    <div class="form-row"><label>回答（記入すると自動で「回答済み」になります）</label>
      <textarea id="qam-answer" rows="4">${U.esc(q ? q.answer || '' : '')}</textarea></div>
    <div class="form-cols">
      <div class="form-row"><label>決定事項</label>
        <textarea id="qam-decision" rows="3" placeholder="このQAで確定した内容">${U.esc(q ? q.decision || '' : '')}</textarea></div>
      <div class="form-row"><label>備考</label>
        <textarea id="qam-note" rows="3" placeholder="補足・経緯メモなど">${U.esc(q ? q.note || '' : '')}</textarea></div>
    </div>
    ${q ? `<div class="form-row"><label>やり取り履歴（再質問・再回答を時系列で記録。Excel出力・取込にも対応）</label>
      <div id="qam-thread" class="qa-thread"><div class="empty-note" style="padding:8px">読み込み中…</div></div>
      ${canCreateTask() ? `<div style="display:flex;gap:8px;margin-top:6px">
        <textarea id="qam-newcomment" rows="2" placeholder="例: 顧客から再質問あり「〜」／ 一次回答を送付 など（Ctrl+Enterで記録）" style="flex:1"></textarea>
        <button class="btn sm primary" id="qam-post" style="align-self:flex-end">記録</button>
      </div>` : ''}</div>` : ''}
    <div class="modal-actions">
      ${q && canManageProject() ? '<button class="btn danger left" id="qam-del">削除</button>' : ''}
      <button class="btn" data-close>キャンセル</button>
      <button class="btn primary" id="qam-save">${q ? '保存' : '追加'}</button>
    </div>`);
  document.getElementById('qam-save').onclick = async () => {
    const v = (id) => document.getElementById(id).value;
    const title = v('qam-title').trim();
    if (!title) { toast('件名を入力してください'); return; }
    const body = {
      title, category: v('qam-cat').trim(), asker_name: v('qam-asker').trim(),
      asked_at: v('qam-asked') || null, due_date: v('qam-due') || null,
      assignee_id: v('qam-assignee') ? Number(v('qam-assignee')) : null,
      status: v('qam-status'), task_id: v('qam-task') ? Number(v('qam-task')) : null,
      question: v('qam-question'), answer: v('qam-answer'),
      decision: v('qam-decision'), note: v('qam-note'),
      actor_id: State.currentUserId,
    };
    if (body.answer.trim() && body.status === 'open') body.status = 'answered';
    try {
      if (q) await API.qaUpdate(q.id, body);
      else await API.qaCreate(State.pid, body);
      closeModal();
      render();
    } catch (err) { toast(err.message); }
  };
  const del = document.getElementById('qam-del');
  if (del) del.onclick = async () => {
    if (!confirm(`${qaNo(q)}「${q.title}」を削除しますか？（やり取り履歴も削除されます）`)) return;
    try {
      await API.qaDelete(q.id, State.currentUserId);
      closeModal();
      render();
    } catch (err) { toast(err.message); }
  };
  // やり取り履歴（既存QAのみ）
  if (q) {
    const box = document.getElementById('qam-thread');
    const loadThread = async () => {
      let items = [];
      try { items = await API.qaComments(q.id); } catch (e) { box.textContent = e.message; return; }
      box.innerHTML = items.map(c => `
        <div class="qa-cline">
          <div class="qa-cmeta">
            ${c.author_id ? U.avatarHtml({ id: c.author_id, name: c.member_name || '?', color: c.member_color || '#7c8db5' }, 'sm') : ''}
            <b>${U.esc(c.member_name || c.author_name || '-')}</b>
            <span>${U.esc((c.created_at || '').slice(5, 16))}</span>
            ${(c.author_id === State.currentUserId || canManageProject())
              ? `<button class="icon-btn qa-cdel" data-cid="${c.id}" title="削除">✕</button>` : ''}
          </div>
          <div class="qa-cbody">${U.esc(c.body)}</div>
        </div>`).join('') || '<div class="empty-note" style="padding:8px">やり取りはまだ記録されていません</div>';
      box.querySelectorAll('.qa-cdel').forEach(b => b.onclick = async () => {
        if (!confirm('この記録を削除しますか？')) return;
        try { await API.qaCommentDel(Number(b.dataset.cid), State.currentUserId); loadThread(); }
        catch (err) { toast(err.message); }
      });
      box.scrollTop = box.scrollHeight;
    };
    loadThread();
    const post = async () => {
      const ta = document.getElementById('qam-newcomment');
      const text = ta.value.trim();
      if (!text) return;
      try {
        await API.qaCommentAdd(q.id, { body: text, actor_id: State.currentUserId });
        ta.value = '';
        await loadThread();
        q.comment_count = (q.comment_count || 0) + 1;
      } catch (err) { toast(err.message); }
    };
    const pb = document.getElementById('qam-post');
    if (pb) {
      pb.onclick = post;
      document.getElementById('qam-newcomment').onkeydown = (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) post();
      };
    }
  }
}

/* =====================================================================
 *  課題ビュー（課題→方針→実行内容を管理。タスクとは分離し関連タスクで紐づけ）
 * =================================================================== */
const ISSUE_STATUS = [['open', '未対応', '#e05252'], ['doing', '対応中', '#f59e0b'],
                      ['resolved', '解決済み', '#16a34a'], ['closed', 'クローズ', '#64748b']];
const issNo = (q) => `ISS-${String(q.seq).padStart(3, '0')}`;

async function renderKadai(container) {
  container.innerHTML = '<div class="empty-note">読み込み中…</div>';
  let items = [];
  try { items = await API.issuesList(State.pid); } catch (e) {
    container.innerHTML = `<div class="empty-note">${U.esc(e.message)}</div>`;
    return;
  }
  State.kadaiItems = items;
  if (!State.kadaiFilter) State.kadaiFilter = { status: '', assignee: '', kw: '' };
  drawKadaiView(container);
}

function drawKadaiView(container) {
  const f = State.kadaiFilter;
  const stMap = Object.fromEntries(ISSUE_STATUS.map(([k, l, c]) => [k, { l, c }]));
  const items = State.kadaiItems.filter(q =>
    (!f.status || (f.status === '_open' ? q.status !== 'closed' : q.status === f.status)) &&
    (!f.assignee || q.assignee_id === Number(f.assignee)) &&
    (!f.kw || `${q.title} ${q.description} ${q.policy} ${q.action_plan} ${q.category || ''} ${q.raised_by || ''}`
      .toLowerCase().includes(f.kw.toLowerCase())));
  const today = U.todayStr();
  const openCnt = State.kadaiItems.filter(q => q.status !== 'closed').length;
  const overdueCnt = State.kadaiItems.filter(q =>
    q.due_date && ['open', 'doing'].includes(q.status) && q.due_date < today).length;
  container.innerHTML = `
  <div class="qa-toolbar">
    ${canCreateTask() ? '<button class="btn primary sm" id="is-add">＋ 課題追加</button>' : ''}
    <select id="is-fstatus"><option value="">状態: すべて</option>
      <option value="_open" ${f.status === '_open' ? 'selected' : ''}>オープンのみ</option>
      ${ISSUE_STATUS.map(([k, l]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${l}</option>`).join('')}
    </select>
    <select id="is-fassignee"><option value="">担当: 全員</option>
      ${State.members.map(m => `<option value="${m.id}" ${f.assignee === String(m.id) ? 'selected' : ''}>${U.esc(m.name)}</option>`).join('')}
    </select>
    <input type="search" id="is-kw" placeholder="🔍 キーワード" value="${U.esc(f.kw)}">
    <span class="tag-chip">全 ${State.kadaiItems.length} 件 ／ オープン <b>${openCnt}</b> 件
      ${overdueCnt ? `／ 期限超過 <b style="color:var(--danger)">${overdueCnt}</b> 件` : ''}</span>
    <span class="spacer"></span>
    <button class="btn sm" id="is-exp-x" title="整形済みの課題管理表Excelを出力">📗 Excel出力</button>
    <button class="btn sm" id="is-exp-h" title="この一覧を単一HTMLで出力">📄 HTML出力</button>
  </div>
  <div class="qa-wrap"><table class="qa-table" style="min-width:1360px">
    <thead><tr><th>No</th><th>重要度</th><th>件名・課題内容</th><th>起票者</th><th>起票日</th>
      <th>担当</th><th>対応期限</th><th>状態</th><th>方針</th><th>実行内容</th><th>解決日</th></tr></thead>
    <tbody>${items.map(q => {
      const overdue = q.due_date && ['open', 'doing'].includes(q.status) && q.due_date < today;
      const st = stMap[q.status] || { l: q.status, c: '#8b95a7' };
      return `<tr data-iid="${q.id}">
        <td class="qa-no">${issNo(q)}</td>
        <td>${U.prioHtml(q.priority)}</td>
        <td class="qa-q"><b>${U.esc(q.title)}</b>
          ${q.comment_count ? ` <span class="tag-chip" title="コメント ${q.comment_count} 件">💬${q.comment_count}</span>` : ''}
          ${q.category ? ` <span class="tag-chip">${U.esc(q.category)}</span>` : ''}
          ${q.description ? `<div class="qa-detail">${U.esc(q.description)}</div>` : ''}
          ${(q.tasks || []).length ? `<div class="qa-detail">🔗 ${q.tasks.map(t =>
            U.esc((wbsOf(t.id) ? wbsOf(t.id) + ' ' : '') + t.title)).join(' ／ ')}</div>` : ''}</td>
        <td>${U.esc(q.raised_by || '—')}</td>
        <td class="qa-date">${U.esc((q.raised_at || '').slice(5))}</td>
        <td>${U.esc(q.assignee_name || '—')}</td>
        <td class="qa-date ${overdue ? 'qa-overdue' : ''}">${U.esc((q.due_date || '').slice(5))}${overdue ? ' ⚠' : ''}</td>
        <td><span class="badge" style="background:${st.c}">${st.l}</span></td>
        <td class="qa-a">${U.esc(q.policy || '')}</td>
        <td class="qa-a">${U.esc(q.action_plan || '')}</td>
        <td class="qa-date">${U.esc((q.resolved_at || '').slice(5))}</td></tr>`;
    }).join('') || `<tr><td colspan="11"><div class="empty-note">課題はまだありません${canCreateTask() ? '。「＋課題追加」から登録できます' : ''}</div></td></tr>`}
    </tbody></table></div>`;

  const fs = container.querySelector('#is-fstatus');
  fs.onchange = () => { f.status = fs.value; drawKadaiView(container); };
  const fa = container.querySelector('#is-fassignee');
  fa.onchange = () => { f.assignee = fa.value; drawKadaiView(container); };
  const kw = container.querySelector('#is-kw');
  kw.oninput = U.debounce(() => {
    f.kw = kw.value;
    drawKadaiView(container);
    const el = container.querySelector('#is-kw');
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, 300);
  const add = container.querySelector('#is-add');
  if (add) add.onclick = () => openKadaiModal();
  container.querySelectorAll('tr[data-iid]').forEach(tr => {
    tr.onclick = () => openKadaiModal(State.kadaiItems.find(x => x.id === Number(tr.dataset.iid)));
  });
  container.querySelector('#is-exp-x').onclick = () => exportViewXlsx('kadai');
  container.querySelector('#is-exp-h').onclick = () => exportViewHtml('kadai');
}

function openKadaiModal(q = null) {
  showModal(`
    <h2>${q ? `${issNo(q)} の編集` : '＋ 課題を追加'}</h2>
    <div class="form-row"><label>件名 *</label><input id="ism-title" value="${U.esc(q ? q.title : '')}" autofocus></div>
    <div class="form-cols">
      <div class="form-row"><label>重要度</label>
        <select id="ism-priority">${['highest', 'high', 'medium', 'low'].map(p =>
          `<option value="${p}" ${(q ? q.priority : 'medium') === p ? 'selected' : ''}>${U.prioLabel[p]}</option>`).join('')}</select></div>
      <div class="form-row"><label>分類</label><input id="ism-cat" value="${U.esc(q ? q.category || '' : '')}" placeholder="仕様 / 体制 / 技術 など"></div>
      <div class="form-row"><label>起票者</label><input id="ism-raised" value="${U.esc(q ? q.raised_by || '' : (State.loginUser ? State.loginUser.name : ''))}"></div>
      <div class="form-row"><label>起票日</label><input type="date" id="ism-raisedat" value="${U.esc(q ? q.raised_at || '' : U.todayStr())}"></div>
      <div class="form-row"><label>担当者</label>
        <select id="ism-assignee"><option value="">未定</option>
          ${State.members.map(m => `<option value="${m.id}" ${q && q.assignee_id === m.id ? 'selected' : ''}>${U.esc(m.name)}</option>`).join('')}
        </select></div>
      <div class="form-row"><label>対応期限</label><input type="date" id="ism-due" value="${U.esc(q ? q.due_date || '' : '')}"></div>
      <div class="form-row"><label>状態</label>
        <select id="ism-status">${ISSUE_STATUS.map(([k, l]) =>
          `<option value="${k}" ${(q ? q.status : 'open') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="form-row"><label>解決日</label><input type="date" id="ism-resolved" value="${U.esc(q ? q.resolved_at || '' : '')}" placeholder="解決/クローズ時に自動設定"></div>
    </div>
    <div class="form-row"><label>課題の内容・背景</label><textarea id="ism-desc" rows="3">${U.esc(q ? q.description || '' : '')}</textarea></div>
    <div class="form-row"><label>方針</label><textarea id="ism-policy" rows="3" placeholder="どう対処するかの方針">${U.esc(q ? q.policy || '' : '')}</textarea></div>
    <div class="form-row"><label>実行内容</label><textarea id="ism-action" rows="3" placeholder="実際に行う（行った）対応内容">${U.esc(q ? q.action_plan || '' : '')}</textarea></div>
    <div class="form-row"><label>関連タスク（クリックで選択／もう一度クリックで解除。ボード・テーブルのタスクに 📌件数 が表示されます）</label>
      <select id="ism-tasks" multiple size="5">
        ${buildWbs(State.tasks).map(t => `<option value="${t.id}"
          ${q && (q.tasks || []).some(x => x.id === t.id) ? 'selected' : ''}>${U.esc(taskLabel(t))}</option>`).join('')}
      </select></div>
    ${q ? `<div class="form-row"><label>コメント（経緯・対応記録を時系列で）</label>
      <div id="ism-thread" class="qa-thread"><div class="empty-note" style="padding:8px">読み込み中…</div></div>
      ${canCreateTask() ? `<div style="display:flex;gap:8px;margin-top:6px">
        <textarea id="ism-newcomment" rows="2" placeholder="対応状況・決定事項など（Ctrl+Enterで記録）" style="flex:1"></textarea>
        <button class="btn sm primary" id="ism-post" style="align-self:flex-end">記録</button>
      </div>` : ''}</div>` : ''}
    <div class="modal-actions">
      ${q && canManageProject() ? '<button class="btn danger left" id="ism-del">削除</button>' : ''}
      <button class="btn" data-close>キャンセル</button>
      <button class="btn primary" id="ism-save">${q ? '保存' : '追加'}</button>
    </div>`);
  enableToggleSelect(document.getElementById('ism-tasks'));
  document.getElementById('ism-save').onclick = async () => {
    const v = (id) => document.getElementById(id).value;
    const title = v('ism-title').trim();
    if (!title) { toast('件名を入力してください'); return; }
    const body = {
      title, priority: v('ism-priority'), category: v('ism-cat').trim(),
      raised_by: v('ism-raised').trim(), raised_at: v('ism-raisedat') || null,
      assignee_id: v('ism-assignee') ? Number(v('ism-assignee')) : null,
      due_date: v('ism-due') || null, status: v('ism-status'),
      resolved_at: v('ism-resolved') || null,
      description: v('ism-desc'), policy: v('ism-policy'), action_plan: v('ism-action'),
      task_ids: [...document.getElementById('ism-tasks').selectedOptions].map(o => Number(o.value)),
      actor_id: State.currentUserId,
    };
    try {
      if (q) await API.issueUpdate(q.id, body);
      else await API.issueCreate(State.pid, body);
      closeModal();
      await loadProject(State.pid);   // タスクの📌件数を更新
      render();
    } catch (err) { toast(err.message); }
  };
  const del = document.getElementById('ism-del');
  if (del) del.onclick = async () => {
    if (!confirm(`${issNo(q)}「${q.title}」を削除しますか？（コメント・関連付けも削除されます）`)) return;
    try {
      await API.issueDelete(q.id, State.currentUserId);
      closeModal();
      await loadProject(State.pid);
      render();
    } catch (err) { toast(err.message); }
  };
  // コメントスレッド（既存課題のみ）
  if (q) {
    const box = document.getElementById('ism-thread');
    const loadThread = async () => {
      let items = [];
      try { items = await API.issueComments(q.id); } catch (e) { box.textContent = e.message; return; }
      box.innerHTML = items.map(c => `
        <div class="qa-cline">
          <div class="qa-cmeta">
            ${c.author_id ? U.avatarHtml({ id: c.author_id, name: c.member_name || '?', color: c.member_color || '#7c8db5' }, 'sm') : ''}
            <b>${U.esc(c.member_name || c.author_name || '-')}</b>
            <span>${U.esc((c.created_at || '').slice(5, 16))}</span>
            ${(c.author_id === State.currentUserId || canManageProject())
              ? `<button class="icon-btn qa-cdel" data-cid="${c.id}" title="削除">✕</button>` : ''}
          </div>
          <div class="qa-cbody">${U.esc(c.body)}</div>
        </div>`).join('') || '<div class="empty-note" style="padding:8px">コメントはまだありません</div>';
      box.querySelectorAll('.qa-cdel').forEach(b => b.onclick = async () => {
        if (!confirm('このコメントを削除しますか？')) return;
        try { await API.issueCommentDel(Number(b.dataset.cid), State.currentUserId); loadThread(); }
        catch (err) { toast(err.message); }
      });
      box.scrollTop = box.scrollHeight;
    };
    loadThread();
    const post = async () => {
      const ta = document.getElementById('ism-newcomment');
      const text = ta.value.trim();
      if (!text) return;
      try {
        await API.issueCommentAdd(q.id, { body: text, actor_id: State.currentUserId });
        ta.value = '';
        await loadThread();
        q.comment_count = (q.comment_count || 0) + 1;
      } catch (err) { toast(err.message); }
    };
    const pb = document.getElementById('ism-post');
    if (pb) {
      pb.onclick = post;
      document.getElementById('ism-newcomment').onkeydown = (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) post();
      };
    }
  }
}

/* タスク詳細などから課題を開く（課題ビューに切り替えてモーダル表示） */
async function openIssueById(iid) {
  try {
    const items = await API.issuesList(State.pid);
    State.kadaiItems = items;
    const it = items.find(x => x.id === iid);
    if (!it) { toast('課題が見つかりません'); return; }
    State.view = 'kadai';
    render();
    openKadaiModal(it);
  } catch (err) { toast(err.message); }
}

/* =====================================================================
 *  管理画面（マネージャー／サイト管理者のみ）
 *  プロジェクト管理・横断分析・組織/ユーザー管理を集約
 * =================================================================== */
function renderManagePage(container) {
  if (loginRank() < 3) {
    container.innerHTML = '<div class="empty-note">管理画面はマネージャー／サイト管理者のみ利用できます。</div>';
    return;
  }
  const tab = State.manageTab || 'projects';
  container.innerHTML = `
    <div class="manage-tabs">
      ${[['projects', '📁 プロジェクト管理'], ['analytics', '📊 横断分析'],
         ['org', '🏢 組織・ユーザー']].map(([k, l]) =>
        `<button class="btn sm ${tab === k ? 'primary' : ''}" data-mtab="${k}">${l}</button>`).join('')}
    </div>
    <div id="manage-body"><div class="empty-note">読み込み中…</div></div>`;
  container.querySelectorAll('[data-mtab]').forEach(b => {
    b.onclick = () => { State.manageTab = b.dataset.mtab; render(); };
  });
  const body = container.querySelector('#manage-body');
  if (tab === 'org') renderAdminPage(body);
  else if (tab === 'analytics') renderManageAnalytics(body);
  else renderManageProjects(body);
}

/* ---- 管理画面: プロジェクト管理タブ ---- */
async function renderManageProjects(body) {
  let list;
  try { list = await API.adminProjects(); } catch (e) {
    body.innerHTML = `<div class="empty-note">${U.esc(e.message)}</div>`;
    return;
  }
  const openProj = async (pid, view) => {
    await loadBootstrap();
    await loadProject(pid);
    State.view = view;
    render();
  };
  body.innerHTML = `
    <div style="display:flex;align-items:center;margin-bottom:10px">
      <span class="set-hint" style="margin:0">メンバーのアサイン（外部ユーザー含む）は各プロジェクトの「👥 メンバー」から行います。</span>
      <span class="spacer"></span>
      <button class="btn primary sm" id="mp-new">＋ 新規プロジェクト</button>
    </div>
    <div class="mp-grid">${list.map(x => {
      const p = x.project;
      const exts = x.members.filter(m => m.account_type === 'external');
      const ints = x.members.filter(m => m.account_type !== 'external');
      const delay = (x.elapsed_pct != null && x.elapsed_pct - x.progress_avg >= 20);
      const badges = [
        p.status === 'archived' ? '<span class="tag-chip">📦 アーカイブ</span>' : '',
        x.overdue ? `<span class="mp-badge red">⚠ 超過 ${x.overdue}</span>` : '',
        x.qa_open ? `<span class="mp-badge amber">❓ QA待ち ${x.qa_open}</span>` : '',
        delay ? '<span class="mp-badge red">🐢 進捗遅れ</span>' : '',
        x.stalled ? '<span class="mp-badge gray">💤 停滞(7日更新なし)</span>' : '',
      ].filter(Boolean).join('');
      return `
      <div class="dash-card mp-card" data-pid="${p.id}">
        <div class="mp-head">
          <span class="proj-dot" style="background:${U.esc(p.color)}"></span>
          <b class="mp-name">${U.esc(p.name)}</b>${badges}
        </div>
        <div class="mp-meta">${U.esc(p.start_date || '—')} 〜 ${U.esc(p.end_date || '—')}
          ／ タスク ${x.done}/${x.total} ／ 最終更新 ${U.esc((x.last_activity || '—').slice(0, 10))}</div>
        <div class="mp-progress"><div style="width:${x.progress_avg}%"></div>
          ${x.elapsed_pct != null ? `<span class="mp-elapsed" style="left:${x.elapsed_pct}%" title="期間経過 ${x.elapsed_pct}%"></span>` : ''}</div>
        <div class="mp-meta">進捗 ${x.progress_avg}%${x.elapsed_pct != null ? ` ／ 期間経過 ${x.elapsed_pct}%` : ''}</div>
        <div class="mp-members">
          ${ints.slice(0, 8).map(m => U.avatarHtml(m, 'sm')).join('')}
          ${ints.length > 8 ? `<span class="mp-meta">+${ints.length - 8}</span>` : ''}
          ${exts.length ? `<span class="ext-chip" title="${U.esc(exts.map(m2 => m2.name).join('・'))}">外部 ${exts.length}名</span>
            <span class="mp-meta">公開: ${U.esc((x.external_tabs || []).map(t => TAB_LABELS_JS[t] || t).join('・') || 'なし')}</span>` : ''}
        </div>
        <div class="mp-actions">
          <button class="btn sm" data-open-pj="${p.id}">開く</button>
          <button class="btn sm" data-members-pj="${p.id}">👥 メンバー</button>
          <button class="btn sm" data-settings-pj="${p.id}">⚙ 設定</button>
        </div>
      </div>`;
    }).join('')}</div>`;
  body.querySelector('#mp-new').onclick = openProjectModal;
  body.querySelectorAll('[data-open-pj]').forEach(b =>
    b.onclick = () => openProj(Number(b.dataset.openPj), 'dashboard'));
  body.querySelectorAll('[data-settings-pj]').forEach(b =>
    b.onclick = () => openProj(Number(b.dataset.settingsPj), 'settings'));
  body.querySelectorAll('[data-members-pj]').forEach(b =>
    b.onclick = async () => {
      await loadBootstrap();
      await loadProject(Number(b.dataset.membersPj));
      render();
      openAssignModal({ externalSection: true });   // 管理画面からのみ外部セクションつき
    });
}

/* ---- 管理画面: 横断分析タブ ---- */
async function renderManageAnalytics(body) {
  let a;
  try { a = await API.adminAnalytics(); } catch (e) {
    body.innerHTML = `<div class="empty-note">${U.esc(e.message)}</div>`;
    return;
  }
  const wl = a.workload.filter(w => w.open || w.done_30d);
  const busiest = a.workload.filter(w => w.open).slice(0, 12);
  body.innerHTML = `
  <div class="dash" style="display:grid;grid-template-columns:repeat(12,1fr);gap:14px">
    <div class="dash-card span7"><h3>👥 メンバー負荷（稼働中PJ・実作業タスクのみ）</h3>
      <table class="task-table" style="min-width:0">
        <thead><tr><th>メンバー</th><th>担当中</th><th>超過</th><th>今週期限</th>
          <th>残見積h</th><th>関与PJ</th><th>30日完了</th></tr></thead>
        <tbody>${wl.map(w => `
          <tr>
            <td><span class="a-dot" style="background:${U.esc(w.color)}"></span>${U.esc(w.name)}
              ${w.account_type === 'external' ? '<span class="ext-chip">外部</span>' : ''}</td>
            <td>${w.open}</td>
            <td class="${w.overdue ? 'qa-overdue' : ''}">${w.overdue || ''}</td>
            <td>${w.due_week || ''}</td>
            <td>${w.est_open || ''}</td>
            <td>${w.projects || ''}</td>
            <td style="color:#16a34a">${w.done_30d || ''}</td>
          </tr>`).join('') || '<tr><td colspan="7">データなし</td></tr>'}</tbody>
      </table></div>
    <div class="dash-card span5"><h3>📊 担当中タスク数（多い順）</h3>
      ${Charts.hbar(busiest.map(w => ({ label: w.name.split(/[\s　]/)[0], color: w.color, value: w.open })),
                    { width: 320 })}</div>
    <div class="dash-card span6"><h3>📈 週次スループット（完了タスク数・直近8週）</h3>
      ${Charts.line(a.weekly_done.map(w => w.done),
                    { width: 520, height: 150, labels: a.weekly_done.map(w => w.label) })}</div>
    <div class="dash-card span6"><h3>🚨 期限超過ワースト（全PJ横断）</h3>
      <ul class="deadline-list">${a.overdue_tasks.map(t => `
        <li data-ot-pid="${t.project_id}" data-ot-tid="${t.id}">
          <span class="tag-chip">${U.esc(t.project_name)}</span>
          <span class="t">${U.esc(t.title)}</span>
          <span style="color:var(--muted);font-size:12px">${U.esc(t.assignee || '未割当')}</span>
          <span class="due overdue">${t.days}日超過</span></li>`).join('') ||
        '<div class="empty-note">期限超過はありません 🎉</div>'}</ul></div>
    <div class="dash-card span12"><h3>🔒 外部ユーザーのアクセス状況（セキュリティレビュー）</h3>
      ${a.externals.map(e => `
        <div class="status-edit-row" style="align-items:flex-start">
          <span style="min-width:180px"><b>${U.esc(e.name)}</b><br>
            <span style="color:var(--muted);font-size:11.5px">${U.esc(e.email || '')}<br>
            最終ログイン: ${U.esc((e.last_login || 'なし').slice(0, 16))}</span></span>
          <div style="flex:1">${e.projects.map(pj => `
            <div style="font-size:12.5px;margin-bottom:3px">
              <span class="tag-chip">${U.esc(pj.name)}</span>
              公開タブ: <b>${U.esc((pj.tabs || []).map(t => TAB_LABELS_JS[t] || t).join('・') || 'なし')}</b>
              ／ 💬コメント ${pj.can_view_comments ? '<b style="color:#d97706">可</b>' : '不可'}
              ／ 📄詳細 ${pj.can_view_detail ? '<b style="color:#d97706">可</b>' : '不可'}
            </div>`).join('') || '<span style="color:var(--muted);font-size:12px">アサインなし（どのPJにもアクセス不可）</span>'}
          </div>
        </div>`).join('') || '<div class="empty-note">外部ユーザーはいません</div>'}
    </div>
  </div>`;
  body.querySelectorAll('[data-ot-pid]').forEach(li => li.onclick = async () => {
    await loadProject(Number(li.dataset.otPid));
    State.view = 'table';
    render();
    openDetail(Number(li.dataset.otTid));
  });
}

/* =====================================================================
 *  ユーザー設定（左下の⚙。ユーザーごとの表示・通知設定＝user_prefs保存）
 * =================================================================== */
function renderMySettings(container) {
  const p = State.prefs || {};
  const nw = p.notify_webhook || {};
  const NTYPES = [['mention', '💬 メンション'], ['assign', '📌 担当割当'],
    ['comment', '🗨 コメント'], ['status', '🔄 ステータス変更'],
    ['due', '⏰ 期限リマインド'], ['watch', '👁 ウォッチ中の変更'], ['system', 'ℹ システム']];
  const evOn = (t) => !nw.events || nw.events.includes(t);
  container.innerHTML = `
  <div class="usettings">
    <p class="set-hint" style="margin:0">この設定は<b>あなたの画面・あなた宛ての通知にのみ</b>反映されます（user単位で保存）。</p>

    <div class="dash-card">
      <h3>🎨 表示</h3>
      <div class="set-row"><label style="flex:1">テーマ
          <small>画面の配色。「OSに合わせる」はWindows/ブラウザのダークモード設定に追従します</small></label>
        <select id="us-theme">
          <option value="light" ${(p.theme || 'light') === 'light' ? 'selected' : ''}>☀ ライト</option>
          <option value="dark" ${p.theme === 'dark' ? 'selected' : ''}>🌙 ダーク</option>
          <option value="system" ${p.theme === 'system' ? 'selected' : ''}>💻 OSに合わせる</option>
        </select></div>
      <div class="set-row"><label style="flex:1">表示密度
          <small>「コンパクト」は文字・余白を詰めて一覧性を上げます（テーブル・ボード向け）</small></label>
        <select id="us-density">
          <option value="normal" ${(p.density || 'normal') === 'normal' ? 'selected' : ''}>標準</option>
          <option value="compact" ${p.density === 'compact' ? 'selected' : ''}>コンパクト</option>
        </select></div>
      <div class="set-row"><label style="flex:1">ログイン後の初期表示
          <small>アプリを開いたときに最初に表示する画面</small></label>
        <select id="us-start">
          <option value="home" ${(p.start_view || 'home') === 'home' ? 'selected' : ''}>🏠 ホーム（マイダッシュボード）</option>
          <option value="last" ${p.start_view === 'last' ? 'selected' : ''}>↩ 前回開いていた画面</option>
        </select></div>
      <p class="set-hint">担当者の表示色は「組織・ユーザー管理」、ダッシュボードの配置はダッシュボードの「⚙編集」で変更できます。</p>
    </div>

    <div class="dash-card">
      <h3>🔔 通知</h3>
      <div class="set-row"><label style="flex:1">デスクトップ通知
          <small>ブラウザの通知機能で、自分宛ての新着通知をポップアップ表示します（このブラウザのみ）</small></label>
        <label class="chk"><input type="checkbox" id="us-desktop" ${p.desktop_notify ? 'checked' : ''}> 有効</label></div>

      <div class="set-row" style="display:block">
        <label class="chk" style="font-size:14px;color:var(--text)">
          <input type="checkbox" id="us-wh-on" ${nw.enabled ? 'checked' : ''}>
          <b>外部チャットへ転送する</b>（Slack / Google Chat / Teams / Discord）</label>
        <small style="color:var(--muted);display:block;margin:4px 0 8px 22px">
          自分宛ての通知を、DM・個人チャネル用に発行した <b>Incoming Webhook URL</b> へ送ります。
          Slack: App「Incoming Webhooks」／ Google Chat: スペース →「アプリと統合」→ Webhook ／
          Teams: Workflows「Webhook要求の受信時」／ Discord: チャンネル設定 → 連携サービス → ウェブフック。
          送信形式はURLから自動判定されます（手動指定も可）。</small>
        <div style="display:flex;gap:8px;margin-left:22px;flex-wrap:wrap">
          <select id="us-wh-provider" title="送信先サービス（ペイロード形式）">
            ${[['auto', '🔍 自動判定'], ['slack', 'Slack'], ['googlechat', 'Google Chat'],
               ['teams', 'Microsoft Teams'], ['discord', 'Discord'], ['text', 'その他（{"text"} 汎用）']]
              .map(([v, l]) => `<option value="${v}" ${(nw.provider || 'auto') === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <input id="us-wh-url" placeholder="https://…（Incoming Webhook URL）" value="${U.esc(nw.url || '')}"
            style="flex:1;min-width:260px;border:1px solid var(--line);border-radius:8px;padding:7px 10px">
          <button class="btn sm" id="us-wh-test">テスト送信</button>
        </div>
        <div style="margin:8px 0 0 22px;display:flex;gap:12px;flex-wrap:wrap" id="us-wh-events">
          ${NTYPES.map(([t, l]) => `<label class="chk"><input type="checkbox" data-ev="${t}" ${evOn(t) ? 'checked' : ''}> ${l}</label>`).join('')}
        </div>
      </div>
    </div>

    <div class="dash-card">
      <h3>🔑 アカウント</h3>
      <div class="set-row"><label style="flex:1">メールアドレス（ログインID）
          <small>${U.esc((State.loginUser || {}).email || '未設定')} — 変更はサイト管理者に依頼してください</small></label></div>
      <div class="set-row"><label style="flex:1">パスワード / APIトークン
          <small>パスワード変更と、自動化・AI連携用のAPIトークンの発行・失効</small></label>
        <button class="btn sm" id="us-password">🔑 開く</button></div>
    </div>
  </div>`;

  const setP = async (key, value) => {
    State.prefs[key] = value;
    try { await API.setPref(State.currentUserId, key, value); }
    catch (e) { toast(e.message); }
  };
  document.getElementById('us-theme').onchange = async (e) => {
    await setP('theme', e.target.value);
    applyUserPrefs();
  };
  document.getElementById('us-density').onchange = async (e) => {
    await setP('density', e.target.value);
    applyUserPrefs();
  };
  document.getElementById('us-start').onchange = (e) => setP('start_view', e.target.value);
  document.getElementById('us-desktop').onchange = async (e) => {
    if (e.target.checked) {
      if (!('Notification' in window)) { toast('このブラウザはデスクトップ通知に対応していません'); e.target.checked = false; return; }
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast('ブラウザの通知が許可されませんでした'); e.target.checked = false; return; }
    }
    await setP('desktop_notify', e.target.checked);
    if (e.target.checked) toast('デスクトップ通知を有効にしました');
  };
  // 外部転送: まとめて notify_webhook に保存
  const saveWebhook = () => {
    const events = [...document.querySelectorAll('#us-wh-events [data-ev]')]
      .filter(c => c.checked).map(c => c.dataset.ev);
    return setP('notify_webhook', {
      enabled: document.getElementById('us-wh-on').checked,
      url: document.getElementById('us-wh-url').value.trim(),
      provider: document.getElementById('us-wh-provider').value,
      events,
    });
  };
  document.getElementById('us-wh-on').onchange = saveWebhook;
  document.getElementById('us-wh-url').onchange = saveWebhook;
  document.getElementById('us-wh-provider').onchange = saveWebhook;
  document.querySelectorAll('#us-wh-events [data-ev]').forEach(c => c.onchange = saveWebhook);
  document.getElementById('us-wh-test').onclick = async () => {
    const url = document.getElementById('us-wh-url').value.trim();
    if (!url) { toast('Webhook URL を入力してください'); return; }
    const btn = document.getElementById('us-wh-test');
    btn.disabled = true;
    try {
      const r = await API.webhookTest(url, document.getElementById('us-wh-provider').value);
      await saveWebhook();
      const names = { slack: 'Slack', googlechat: 'Google Chat', teams: 'Teams', discord: 'Discord', text: '汎用形式' };
      toast(`✅ ${names[r.provider] || r.provider} 形式でテスト送信しました。チャット側で受信を確認してください`);
    } catch (err) { toast(err.message); }
    btn.disabled = false;
  };
  document.getElementById('us-password').onclick = openPasswordModal;
}

/* =====================================================================
 *  ノートビュー（PJのルール・環境・体制などの共有メモ）
 * =================================================================== */
function noteContentHtml(content) {
  // エスケープ後、URLをリンク化し改行を反映
  let s = U.esc(content);
  s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  return s.replace(/\n/g, '<br>');
}

async function renderNotes(container) {
  container.innerHTML = '<div class="empty-note">読み込み中…</div>';
  let notes;
  try {
    notes = await API.listNotes(State.pid);
  } catch (err) {
    container.innerHTML = `<div class="empty-note">読み込みに失敗しました: ${U.esc(err.message)}</div>`;
    return;
  }
  const editable = canEditNotes();
  const cats = [...new Set(notes.map(n => n.category))];
  const catColor = { '環境': '#06b6d4', '体制': '#8b5cf6', 'ルール': '#f59e0b' };

  const noteCard = (n) => `
    <div class="note-card" data-note="${n.id}">
      <div class="note-head">
        ${n.pinned ? '<span title="ピン留め">📌</span>' : ''}
        <span class="note-cat" style="background:${U.esc(catColor[n.category] || '#64748b')}">${U.esc(n.category)}</span>
        <b>${U.esc(n.title)}</b>
        <span class="spacer"></span>
        ${editable ? `<button class="icon-btn" data-edit-note="${n.id}" title="編集">✏</button>
                      <button class="icon-btn" data-del-note="${n.id}" title="削除">🗑</button>` : ''}
      </div>
      <div class="note-body">${noteContentHtml(n.content)}</div>
      ${(n.attachments || []).length || editable ? `<div class="note-attach">
        ${(n.attachments || []).map(a => `
          <span class="note-file">📎 <a href="/api/files/${a.id}">${U.esc(a.filename)}</a>
            ${editable ? `<span class="x" data-del-nattach="${a.id}" title="削除">✕</span>` : ''}</span>`).join('')}
        ${editable ? `<label class="tag-chip" style="cursor:pointer">＋添付
          <input type="file" class="note-attach-input" data-note-attach="${n.id}" style="display:none"></label>` : ''}
      </div>` : ''}
      <div class="note-foot">最終更新: ${U.esc(n.updated_by_name || '—')} ・ ${U.esc((n.updated_at || '').slice(0, 16))}</div>
    </div>`;

  container.innerHTML = `
    <div class="notes-toolbar">
      <span style="color:var(--muted);font-size:13px">
        検証環境・体制・定例ルールなど、プロジェクトで共有したい情報を記録します。</span>
      <span class="spacer"></span>
      ${editable ? '<button class="btn primary sm" id="note-add">＋ ノート追加</button>' : ''}
    </div>
    <div class="notes-grid">
      ${notes.map(noteCard).join('') ||
        '<div class="empty-note">まだノートがありません。「＋ ノート追加」から作成してください。</div>'}
    </div>`;

  const reload = () => renderNotes(container);
  const addBtn = container.querySelector('#note-add');
  if (addBtn) addBtn.onclick = () => openNoteModal(null, reload);
  container.querySelectorAll('[data-edit-note]').forEach(btn => {
    btn.onclick = () => openNoteModal(notes.find(n => n.id === Number(btn.dataset.editNote)), reload);
  });
  container.querySelectorAll('[data-del-note]').forEach(btn => {
    btn.onclick = async () => {
      const n = notes.find(x => x.id === Number(btn.dataset.delNote));
      if (!confirm(`ノート「${n.title}」を削除しますか？`)) return;
      try {
        await API.deleteNote(n.id, State.currentUserId);
        reload();
      } catch (err) { toast(err.message); }
    };
  });
  // ノート添付
  container.querySelectorAll('.note-attach-input').forEach(inp => {
    inp.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        await API.upload('note', Number(inp.dataset.noteAttach), file, State.currentUserId);
        toast(`「${file.name}」を添付しました`);
        reload();
      } catch (err) { toast(err.message); }
    };
  });
  container.querySelectorAll('[data-del-nattach]').forEach(x => {
    x.onclick = async () => {
      if (!confirm('この添付を削除しますか？')) return;
      await API.deleteAttachment(Number(x.dataset.delNattach), State.currentUserId);
      reload();
    };
  });
}

function openNoteModal(note, onSaved) {
  showModal(`
    <h2>${note ? 'ノートを編集' : 'ノートを追加'}</h2>
    <div class="form-cols">
      <div class="form-row"><label>カテゴリ</label>
        <input id="nn-cat" list="nn-cats" value="${U.esc(note ? note.category : 'その他')}">
        <datalist id="nn-cats">
          <option value="環境"><option value="体制"><option value="ルール"><option value="その他">
        </datalist></div>
      <div class="form-row"><label style="visibility:hidden">_</label>
        <label class="chk"><input type="checkbox" id="nn-pin" ${note && note.pinned ? 'checked' : ''}> 📌 ピン留め（先頭に表示）</label></div>
    </div>
    <div class="form-row"><label>タイトル *</label>
      <input id="nn-title" value="${U.esc(note ? note.title : '')}" placeholder="例: 検証環境一覧・アクセス方法"></div>
    <div class="form-row"><label>内容（URLは自動リンク化されます）</label>
      <textarea id="nn-content" style="min-height:180px">${U.esc(note ? note.content : '')}</textarea></div>
    <div class="modal-actions">
      <button class="btn" data-close>キャンセル</button>
      <button class="btn primary" id="nn-save">保存</button>
    </div>`);
  document.getElementById('nn-save').onclick = async () => {
    const title = document.getElementById('nn-title').value.trim();
    if (!title) { toast('タイトルを入力してください'); return; }
    const body = {
      title,
      category: document.getElementById('nn-cat').value.trim() || 'その他',
      content: document.getElementById('nn-content').value,
      pinned: document.getElementById('nn-pin').checked,
      actor_id: State.currentUserId,
    };
    try {
      if (note) await API.updateNote(note.id, { ...body, pinned: body.pinned ? 1 : 0 });
      else await API.createNote(State.pid, body);
      closeModal();
      onSaved();
    } catch (err) { toast(err.message); }
  };
}

/* 設定ページ: ゴミ箱の一覧・復元 */
async function loadTrash(container, pid) {
  const box = container.querySelector('#set-trash');
  if (!box) return;
  let d;
  try { d = await API.trash(pid); } catch (e) { box.textContent = e.message; return; }
  box.classList.remove('empty-note');
  const row = (kind, x) => `
    <div class="status-edit-row">
      <span>${kind === 'task' ? '📋' : '📖'}</span>
      <span style="flex:1">${U.esc(x.title)}</span>
      <span style="color:var(--muted);font-size:12px">${U.esc((x.deleted_at || '').slice(0, 16))}</span>
      <button class="btn sm" data-restore="${kind}:${x.id}">復元</button>
    </div>`;
  box.innerHTML =
    (d.tasks.map(t => row('task', t)).join('') + d.notes.map(n => row('note', n)).join('')) ||
    '<div class="empty-note">ゴミ箱は空です</div>';
  box.querySelectorAll('[data-restore]').forEach(btn => {
    btn.onclick = async () => {
      const [kind, id] = btn.dataset.restore.split(':');
      try {
        if (kind === 'task') await API.restoreTask(Number(id), State.currentUserId);
        else await API.restoreNote(Number(id), State.currentUserId);
        toast('復元しました');
        await refresh();
        loadTrash(container, pid);
      } catch (err) { toast(err.message); }
    };
  });
}

/* CSVテキスト → インポート行（エクスポートCSVと同じ列構成を想定） */
function parseCsvTasks(text) {
  const lines = [];
  let cur = [], field = '', inQ = false;
  const src = text.replace(/^\ufeff/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { cur.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      cur.push(field); field = '';
      if (cur.some(c => c !== '')) lines.push(cur);
      cur = [];
    } else field += ch;
  }
  if (field !== '' || cur.length) { cur.push(field); if (cur.some(c => c !== '')) lines.push(cur); }
  if (lines.length < 2) return [];
  const header = lines[0].map(h => h.trim());
  const colMap = { 'WBS': 'wbs', 'タスク名': 'title', 'ステータス': 'status',
                   '担当者': 'assignee', '優先度': 'priority', '開始日': 'start_date',
                   '期限': 'due_date', '進捗%': 'progress', '進捗': 'progress',
                   '見積h': 'estimate_h', '説明': 'description' };
  const idx = {};
  header.forEach((h, i) => { if (colMap[h]) idx[colMap[h]] = i; });
  if (idx.title === undefined) return [];
  return lines.slice(1).map(cols => {
    const row = {};
    for (const [key, i] of Object.entries(idx)) {
      row[key] = (cols[i] || '').trim();
    }
    row.title = row.title.replace(/^[\s\u3000]+/, '');   // エクスポート時の階層インデントを除去
    return row;
  }).filter(r => r.title);
}

/* =====================================================================
 *  組織・ユーザー管理ページ（独立ページ）
 * =================================================================== */
function renderAdminPage(container) {
  if (loginRank() < 3) {
    container.innerHTML = '<div class="empty-note">組織・ユーザー管理はサイト管理者以上の権限が必要です。</div>';
    return;
  }
  const omap = orgMap();
  const myProjects = (uid) => State.projectMembers
    .filter(pm => pm.member_id === uid)
    .map(pm => {
      const p = State.projects.find(x => x.id === pm.project_id);
      return p ? `<span class="tag-chip" title="${U.esc(ROLE_LABEL[pm.role] || pm.role)}">
        ${U.esc(p.name)}<span class="role-mini role-${U.esc(pm.role)}">${U.esc(ROLE_LABEL[pm.role] || '')}</span></span>` : '';
    }).join(' ');

  const userRow = (u) => `
    <tr data-uid="${u.id}">
      <td>${U.avatarHtml(u)}</td>
      <td><b>${U.esc(u.name)}</b></td>
      <td>${U.esc(u.role)}</td>
      <td>${u.account_type === 'external'
        ? '<span class="ext-chip">外部</span>' : '<span class="int-chip">社内</span>'}</td>
      <td>${u.account_type === 'external'
        ? '<span style="color:var(--muted);font-size:12px">—</span>'
        : `<select data-org-role="${u.id}" title="組織権限。マネージャー/プロ職は全PJの暗黙管理者、サイト管理者はユーザー・組織の管理とデバッグ表示切替が可能">
            ${['manager', 'site_admin', 'professional', 'staff'].map(r =>
              `<option value="${r}" ${(u.org_role || 'staff') === r ? 'selected' : ''}>${ORG_ROLE_LABEL[r]}</option>`).join('')}
          </select>`}</td>
      <td>${u.account_type !== 'external' && ['manager', 'professional'].includes(u.org_role)
        ? '<span class="tag-chip" title="組織権限により全プロジェクトの管理者">全PJ管理者（暗黙）</span> '
        : ''}${myProjects(u.id) || '<span style="color:var(--muted);font-size:12px">未参加</span>'}</td>
      <td><button class="btn sm" data-edit-user="${u.id}">編集</button></td>
    </tr>`;

  const orgBlock = (o, users) => `
    <div class="dash-card span12 org-block">
      <div class="org-head">
        ${o ? `<input type="color" value="${U.esc(o.color)}" data-org-color="${o.id}" title="組織カラー">
               <input type="text" class="org-name" value="${U.esc(o.name)}" data-org-name="${o.id}">
               <span style="color:var(--muted);font-size:12px">${users.length} 名</span>
               <span class="spacer"></span>
               <button class="btn sm" data-add-user-org="${o.id}">＋ ユーザー追加</button>
               <button class="btn sm danger" data-del-org="${o.id}">組織を削除</button>`
            : `<b>（無所属）</b><span style="color:var(--muted);font-size:12px">${users.length} 名</span>`}
      </div>
      ${users.length ? `<table class="admin-table">
        <thead><tr><th></th><th>名前</th><th>役割</th><th>種別</th><th>組織権限</th><th>参加プロジェクト（PJロール）</th><th></th></tr></thead>
        <tbody>${users.map(userRow).join('')}</tbody></table>`
        : '<div style="color:var(--muted);font-size:13px;padding:6px 2px">ユーザーなし</div>'}
    </div>`;

  const groups = State.orgs.map(o => orgBlock(o, State.users.filter(u => u.org_id === o.id)));
  const noOrg = State.users.filter(u => !u.org_id);

  container.innerHTML = `<div class="dash">
    <div class="dash-card span12" style="display:flex;align-items:center;gap:10px">
      <b style="font-size:15px">🏢 組織・ユーザー管理</b>
      <span style="color:var(--muted);font-size:12.5px">
        ユーザーは組織に所属し、プロジェクトへのアサイン時にロール（管理者/メンバー/閲覧/外部）を設定します。
        外部アカウントは参加プロジェクトしか見えません。</span>
      <span class="spacer"></span>
      <button class="btn sm" id="adm-add-org">＋ 組織を追加</button>
      <button class="btn primary sm" id="adm-add-user">＋ ユーザーを追加</button>
    </div>
    ${groups.join('')}
    ${noOrg.length ? orgBlock(null, noOrg) : ''}
    <div class="dash-card span12"><h3>🔐 ログイン履歴（直近30件）</h3>
      <div id="adm-login-logs" class="empty-note">読み込み中…</div></div>
  </div>`;
  API.loginLogs().then(logs => {
    const box = container.querySelector('#adm-login-logs');
    if (!box) return;
    box.classList.remove('empty-note');
    box.innerHTML = `<table class="admin-table"><thead>
      <tr><th>日時</th><th>ユーザー</th><th>結果</th><th>IP</th></tr></thead>
      <tbody>${logs.map(l => `<tr>
        <td>${U.esc((l.created_at || '').slice(0, 16))}</td>
        <td>${U.esc(l.name || '')}</td>
        <td>${l.success ? '✅ 成功' : '<span style="color:var(--danger)">❌ 失敗</span>'}</td>
        <td style="color:var(--muted)">${U.esc(l.ip || '')}</td></tr>`).join('')}</tbody></table>`;
  }).catch(() => {});

  const reload = async () => { await loadBootstrap(); render(); };

  container.querySelector('#adm-add-org').onclick = async () => {
    await API.createOrg({ name: '新しい組織' });
    reload();
  };
  container.querySelector('#adm-add-user').onclick = () => openUserModal(null, {});
  container.querySelectorAll('[data-add-user-org]').forEach(btn => {
    btn.onclick = () => openUserModal(null, { defaultOrgId: Number(btn.dataset.addUserOrg) });
  });
  container.querySelectorAll('[data-edit-user]').forEach(btn => {
    btn.onclick = () => openUserModal(Number(btn.dataset.editUser), {});
  });
  container.querySelectorAll('[data-org-role]').forEach(sel => {
    sel.onchange = async () => {
      await API.updateMember(Number(sel.dataset.orgRole), { org_role: sel.value });
      toast(`組織権限を「${ORG_ROLE_LABEL[sel.value]}」に変更しました`);
      reload();
    };
  });
  container.querySelectorAll('[data-org-name]').forEach(inp => {
    inp.onchange = async () => {
      await API.updateOrg(Number(inp.dataset.orgName), { name: inp.value.trim() || '組織' });
      reload();
    };
  });
  container.querySelectorAll('[data-org-color]').forEach(inp => {
    inp.onchange = async () => {
      await API.updateOrg(Number(inp.dataset.orgColor), { color: inp.value });
      reload();
    };
  });
  container.querySelectorAll('[data-del-org]').forEach(btn => {
    btn.onclick = async () => {
      const o = omap[Number(btn.dataset.delOrg)];
      if (!confirm(`組織「${o.name}」を削除しますか？（所属ユーザーがいる場合は削除できません）`)) return;
      try {
        await API.deleteOrg(o.id);
        reload();
      } catch (err) { toast(err.message); }
    };
  });
}

/* =====================================================================
 *  プロジェクト設定ページ（リーダー・組織上位者のみ）
 * =================================================================== */
function renderSettingsPage(container) {
  const p = State.project;
  if (!canManageProject()) {
    container.innerHTML = '<div class="empty-note">プロジェクト設定はリーダーまたは組織のマネージャー・プロ職のみ変更できます。</div>';
    return;
  }
  const s = p.settings || {};
  const chk = (key, label, hint) => `
    <label class="set-row">
      <input type="checkbox" data-set="${key}" ${s[key] ? 'checked' : ''}>
      <span><b>${label}</b>${hint ? `<small>${hint}</small>` : ''}</span>
    </label>`;

  const stRows = State.statuses.map(st => `
    <div class="status-edit-row" data-sid="${st.id}">
      <input type="color" value="${U.esc(st.color)}" data-f="color">
      <input type="text" value="${U.esc(st.name)}" data-f="name">
      <label class="chk" title="このステータスを完了扱いにする">
        <input type="checkbox" data-f="is_done" ${st.is_done ? 'checked' : ''}>完了</label>
      <button class="icon-btn" data-del-status="${st.id}">🗑</button>
    </div>`).join('');

  const tplRows = (s.note_templates || []).map((t, i) => `
    <div class="cf-row" data-tpl>
      <input data-f="category" placeholder="カテゴリ" value="${U.esc(t.category)}" style="max-width:110px">
      <input data-f="title" placeholder="タイトル" value="${U.esc(t.title)}">
      <button class="icon-btn" data-del-tpl>🗑</button>
    </div>`).join('');

  container.innerHTML = `<div class="dash settings-page">
    <div class="dash-card span12" style="display:flex;align-items:center;gap:10px">
      <b style="font-size:15px">⚙ ${U.esc(p.name)} — プロジェクト設定</b>
      <span class="spacer"></span>
      <button class="btn" id="set-cancel">閉じる</button>
      <button class="btn primary" id="set-save">保存</button>
    </div>

    <div class="dash-card span6"><h3>基本情報</h3>
      <div class="form-row"><label>プロジェクト名</label><input id="set-name" value="${U.esc(p.name)}"></div>
      <div class="form-row"><label>説明</label><textarea id="set-desc">${U.esc(p.description)}</textarea></div>
      <div class="form-cols">
        <div class="form-row"><label>開始日</label><input type="date" id="set-start" value="${U.esc(p.start_date || '')}"></div>
        <div class="form-row"><label>終了予定日</label><input type="date" id="set-end" value="${U.esc(p.end_date || '')}"></div>
      </div>
      <div class="form-row"><label>カラー</label>${colorSwatches('set-colors', p.color)}</div>
    </div>

    <div class="dash-card span6"><h3>ボード列（ステータス）</h3>
      <div id="ps-statuses">${stRows}</div>
      <button class="btn sm" id="set-add-status">＋ 列を追加</button>
      <h3 style="margin-top:18px">カスタムフィールド</h3>
      <div id="ps-cfs">${(p.custom_fields || []).map((f, i) => cfRowHtml(f, i)).join('')}</div>
      <button class="btn sm" id="set-add-cf">＋ フィールド追加</button>
    </div>

    <div class="dash-card span6"><h3>表示設定（タスクの項目をどこまで出すか）</h3>
      <p class="set-hint">OFFにした項目はテーブル・詳細・カードから非表示になります（データは保持）。</p>
      ${chk('show_estimate', '見積h・実績h を表示', '工数管理をしないPJではOFF')}
      ${chk('show_priority', '優先度を表示')}
      ${chk('show_tags', 'タグを表示')}
      ${chk('show_custom_fields', 'カスタムフィールドを表示')}
    </div>

    <div class="dash-card span6"><h3>権限の細部調整</h3>
      <p class="set-hint">実効権限＝組織ロール（マネージャー/プロ職は常に管理者）× PJロール。</p>
      ${chk('member_can_create_tasks', 'メンバーのタスク作成を許可')}
      ${chk('member_can_edit_own_schedule', 'メンバーが自分のタスクの日程を変更可', '開始日・期限・見積の変更を許可（既定はリーダーのみ）')}
      ${chk('member_can_edit_notes', 'メンバーのノート編集を許可')}
      ${chk('advisor_can_comment', 'ご意見番のコメント投稿を許可')}
      ${chk('unassigned_can_comment', '未アサインの社内ユーザーのコメントを許可', 'OFFにするとPJメンバー以外は閲覧のみ')}
    </div>

    <div class="dash-card span6"><h3>👤 担当者の追加選択肢（メンバー以外）</h3>
      <p class="set-hint">アサインされているメンバー以外に、担当者として選べるラベルを定義します
        （例: 顧客・先方・ベンダーA・未定）。ボードの担当者別列やフィルターにも表示されます。</p>
      <div id="set-vas">${(s.virtual_assignees || []).map(l => `
        <div class="cf-row" data-va>
          <input data-f="label" value="${U.esc(l)}" placeholder="例: 顧客">
          <button class="icon-btn" data-del-va>🗑</button>
        </div>`).join('')}</div>
      <button class="btn sm" id="set-add-va">＋ 選択肢を追加</button>
    </div>

    <div class="dash-card span6 ext-danger-box"><h3>🔒 外部パートナーの公開範囲・制限</h3>
      <p class="set-hint">外部（社外）アカウントに関する設定。<b>変更の保存にはマネージャー／サイト管理者の権限と、
        プロジェクト名の確認入力が必要です</b>（サーバー側でも二重に検証されます）。</p>
      <div class="form-row"><label>公開するタブ（チェックしたタブだけが外部ユーザーに表示され、API側でも遮断されます）</label>
        ${[['dashboard', '📊 ダッシュボード'], ['board', '📋 ボード'], ['table', '📑 テーブル'],
           ['gantt', '📅 WBSガント'], ['calendar', '📆 カレンダー'], ['qa', '❓ QA'],
           ['kadai', '📌 課題（既定で非公開）'],
           ['issues', '💬 コメント一覧'], ['notes', '📖 ノート']].map(([k, l]) => `
          <label class="chk" style="display:inline-flex;margin:2px 14px 2px 0">
            <input type="checkbox" data-exttab="${k}" ${(s.external_visible_tabs || []).includes(k) ? 'checked' : ''}
              ${loginRank() < 3 ? 'disabled title="変更はマネージャー／サイト管理者のみ"' : ''}>${l}</label>`).join('')}
      </div>
      ${chk('external_default_view_comments', '外部にコメント閲覧を既定で許可')}
      ${chk('external_default_view_detail', '外部にタスク詳細閲覧を既定で許可')}
      ${chk('external_can_export', '外部のエクスポートを許可')}
    </div>

    <div class="dash-card span6"><h3>ノートテンプレート</h3>
      <p class="set-hint">新規PJ作成時に雛形ノートとして自動作成されます。既存PJには下のボタンで未作成分を追加。</p>
      <div id="set-tpls">${tplRows}</div>
      <button class="btn sm" id="set-add-tpl">＋ テンプレート追加</button>
      <button class="btn sm" id="set-apply-tpl" style="margin-left:8px">📖 未作成分をノートに作成</button>
    </div>

    <div class="dash-card span6"><h3>🔔 通知（Teams / Slack Webhook）</h3>
      <p class="set-hint">Incoming Webhook の URL を設定すると、選択したイベントをチャネルへ送信します。</p>
      <div class="form-row"><label>Webhook URL</label>
        <input id="set-webhook" value="${U.esc(s.webhook_url || '')}" placeholder="Slack / Google Chat / Teams / Discord の Incoming Webhook URL（形式は自動判定）"></div>
      <div class="form-row"><label>送信するイベント</label>
        ${[['mention', '@メンション'], ['assign', '担当割当'], ['due', '期限リマインド'],
           ['status', 'ステータス変更'], ['comment', 'コメント']].map(([k, l]) => `
          <label class="chk" style="display:inline-flex;margin-right:12px">
            <input type="checkbox" data-wevent="${k}" ${(s.webhook_events || []).includes(k) ? 'checked' : ''}>${l}</label>`).join('')}
      </div>
    </div>

    <div class="dash-card span6"><h3>📦 データ管理</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <label class="btn sm" style="cursor:pointer">📥 CSVインポート
          <input type="file" id="set-import" accept=".csv" style="display:none"></label>
        <button class="btn sm" id="set-duplicate">📤 このPJを複製</button>
        <a class="btn sm" href="/api/projects/${p.id}/calendar.ics" download style="text-decoration:none">📅 iCal出力</a>
      </div>
      <p class="set-hint">CSVはエクスポートと同じ列構成（WBS・タスク名・ステータス・担当者・優先度・開始日・期限・進捗%・見積h・説明）を受け付けます。WBS番号で親子関係を復元します。</p>
    </div>

    <div class="dash-card span12"><h3>🗑 ゴミ箱（削除から30日で完全削除）</h3>
      <div id="set-trash" class="empty-note">読み込み中…</div>
    </div>

    <div class="dash-card span12" style="border-color:#fecaca"><h3 style="color:var(--danger)">危険な操作</h3>
      <div style="display:flex;gap:10px;align-items:center">
        <button class="btn danger sm" id="set-archive">${p.status === 'archived' ? 'アーカイブ解除' : '📦 アーカイブ（横断ビューから除外）'}</button>
        <button class="btn danger sm" id="set-delete">🗑 プロジェクトを完全削除</button>
        <span class="set-hint">削除は全タスク・コメント・ノートも消えます。先にエクスポートを推奨。</span>
      </div>
    </div>
  </div>`;

  bindSwatches('set-colors');
  bindCfRowEvents();

  container.querySelector('#set-cancel').onclick = () => { State.view = 'board'; render(); };
  container.querySelector('#set-add-status').onclick = async () => {
    await API.createStatus(p.id, { name: '新しい列', color: '#8b95a7',
      sort_order: State.statuses.length, is_done: false });
    await refresh();
  };
  container.querySelectorAll('[data-del-status]').forEach(btn => {
    btn.onclick = async () => {
      try { await API.deleteStatus(Number(btn.dataset.delStatus)); await refresh(); }
      catch (err) { toast(err.message); }
    };
  });
  container.querySelector('#set-add-cf').onclick = () => {
    document.getElementById('ps-cfs').insertAdjacentHTML('beforeend',
      cfRowHtml({ key: 'field' + Date.now() % 100000, label: '', type: 'text', options: [] }, 0));
    bindCfRowEvents();
  };
  container.querySelector('#set-add-tpl').onclick = () => {
    document.getElementById('set-tpls').insertAdjacentHTML('beforeend', `
      <div class="cf-row" data-tpl>
        <input data-f="category" placeholder="カテゴリ" value="その他" style="max-width:110px">
        <input data-f="title" placeholder="タイトル" value="">
        <button class="icon-btn" data-del-tpl>🗑</button>
      </div>`);
    bindTplRows();
  };
  const bindTplRows = () => {
    container.querySelectorAll('[data-del-tpl]').forEach(b => b.onclick = () => b.closest('[data-tpl]').remove());
    container.querySelectorAll('[data-del-va]').forEach(b => b.onclick = () => b.closest('[data-va]').remove());
  };
  bindTplRows();
  container.querySelector('#set-add-va').onclick = () => {
    document.getElementById('set-vas').insertAdjacentHTML('beforeend', `
      <div class="cf-row" data-va>
        <input data-f="label" value="" placeholder="例: 顧客">
        <button class="icon-btn" data-del-va>🗑</button>
      </div>`);
    bindTplRows();
  };
  container.querySelector('#set-apply-tpl').onclick = async () => {
    await saveSettings();   // テンプレ編集を反映してから
    const r = await API.applyNoteTemplate(p.id, State.currentUserId);
    toast(`テンプレートから ${r.created} 件のノートを作成しました`);
  };

  const collectSettings = () => {
    const out = { ...s };
    container.querySelectorAll('[data-set]').forEach(cb => { out[cb.dataset.set] = cb.checked; });
    out.virtual_assignees = [...container.querySelectorAll('[data-va] [data-f=label]')]
      .map(i => i.value.trim()).filter(Boolean);
    out.webhook_url = container.querySelector('#set-webhook').value.trim();
    out.webhook_events = [...container.querySelectorAll('[data-wevent]')]
      .filter(cb => cb.checked).map(cb => cb.dataset.wevent);
    out.external_visible_tabs = [...container.querySelectorAll('[data-exttab]')]
      .filter(cb => cb.checked).map(cb => cb.dataset.exttab);
    out.note_templates = [...container.querySelectorAll('[data-tpl]')].map(row => ({
      category: row.querySelector('[data-f=category]').value.trim() || 'その他',
      title: row.querySelector('[data-f=title]').value.trim(),
    })).filter(t => t.title);
    return out;
  };

  const saveSettings = async (confirmText) => {
    // ステータス変更を保存
    for (const row of container.querySelectorAll('#ps-statuses .status-edit-row')) {
      const sid = Number(row.dataset.sid);
      const orig = State.statuses.find(x => x.id === sid);
      if (!orig) continue;
      const name = row.querySelector('[data-f=name]').value.trim() || orig.name;
      const color = row.querySelector('[data-f=color]').value;
      const is_done = row.querySelector('[data-f=is_done]').checked ? 1 : 0;
      if (name !== orig.name || color !== orig.color || is_done !== orig.is_done) {
        await API.updateStatus(sid, { name, color, is_done });
      }
    }
    const cfs = [...container.querySelectorAll('#ps-cfs .cf-row')].map(row => ({
      key: row.dataset.key,
      label: row.querySelector('[data-f=label]').value.trim(),
      type: row.querySelector('[data-f=type]').value,
      options: row.querySelector('[data-f=options]').value.split(',').map(x => x.trim()).filter(Boolean),
    })).filter(f => f.label);
    await API.updateProject(p.id, {
      name: container.querySelector('#set-name').value.trim() || p.name,
      description: container.querySelector('#set-desc').value,
      start_date: container.querySelector('#set-start').value || null,
      end_date: container.querySelector('#set-end').value || null,
      color: swatchValue('set-colors'),
      custom_fields: cfs,
      settings: collectSettings(),
      ...(confirmText ? { confirm_text: confirmText } : {}),
    }, State.currentUserId);
    await loadBootstrap();
    await loadProject(p.id);
  };

  // 外部公開設定の変更検知 → 確認モーダル（プロジェクト名の入力必須）
  const EXT_KEYS = [['external_visible_tabs', '公開タブ'],
                    ['external_can_export', 'エクスポート許可'],
                    ['external_default_view_comments', 'コメント閲覧の既定'],
                    ['external_default_view_detail', '詳細閲覧の既定']];
  const extChanges = () => {
    const ns = collectSettings();
    return EXT_KEYS.filter(([k]) =>
      JSON.stringify(s[k] ?? null) !== JSON.stringify(ns[k] ?? null))
      .map(([k, label]) => ({ k, label, value: ns[k] }));
  };
  const openExtConfirm = (changes) => {
    showModal(`
      <h2>🔒 外部公開設定の変更確認</h2>
      <div class="ext-warn">外部パートナーに公開される情報の範囲が変わります。内容をよく確認してください。</div>
      <ul style="font-size:13px;line-height:1.9;margin:10px 0">
        ${changes.map(c => `<li><b>${c.label}</b> → ${
          c.k === 'external_visible_tabs'
            ? (c.value.map(t => TAB_LABELS_JS[t] || t).join('・') || '<b style="color:#dc2626">すべて非公開</b>')
            : (c.value ? '<b style="color:#d97706">許可する</b>' : '許可しない')}</li>`).join('')}
      </ul>
      <div class="form-row"><label>確認のため、プロジェクト名「${U.esc(p.name)}」を入力してください</label>
        <input id="exc-name" autocomplete="off"></div>
      <div class="modal-actions">
        <button class="btn" data-close>キャンセル</button>
        <button class="btn danger" id="exc-ok" disabled>変更を保存</button>
      </div>`);
    const inp = document.getElementById('exc-name');
    const ok = document.getElementById('exc-ok');
    inp.oninput = () => { ok.disabled = inp.value.trim() !== p.name; };
    inp.focus();
    ok.onclick = async () => {
      try {
        await saveSettings(inp.value.trim());
        closeModal();
        toast('プロジェクト設定を保存しました（外部公開設定の変更を記録）');
        render();
      } catch (err) { toast('保存に失敗: ' + err.message); }
    };
  };

  container.querySelector('#set-save').onclick = async () => {
    const changes = extChanges();
    if (changes.length) { openExtConfirm(changes); return; }
    try {
      await saveSettings();
      toast('プロジェクト設定を保存しました');
      render();
    } catch (err) { toast('保存に失敗: ' + err.message); }
  };

  container.querySelector('#set-archive').onclick = async () => {
    const to = p.status === 'archived' ? 'active' : 'archived';
    await API.updateProject(p.id, { status: to }, State.currentUserId);
    await loadBootstrap(); await loadProject(p.id);
    toast(to === 'archived' ? 'アーカイブしました' : 'アーカイブを解除しました');
    render();
  };
  // ---- CSVインポート
  container.querySelector('#set-import').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const rows = parseCsvTasks(text);
    if (!rows.length) { toast('取り込める行がありません（ヘッダー行と「タスク名」列を確認）'); return; }
    if (!confirm(`${rows.length} 件のタスクをインポートします。よろしいですか？\n例: ${rows[0].title}`)) return;
    try {
      const r = await API.importTasks(p.id, rows, State.currentUserId);
      toast(`${r.created} 件をインポートしました`);
      await refresh();
    } catch (err) { toast(err.message); }
    e.target.value = '';
  };
  // ---- PJ複製
  container.querySelector('#set-duplicate').onclick = async () => {
    const name = prompt('複製後のプロジェクト名:', `${p.name} (コピー)`);
    if (!name) return;
    const withTasks = confirm('タスクも含めて複製しますか？\n（OK=タスク込み ／ キャンセル=構成のみ: 列・メンバー・ノート・設定）');
    try {
      const np = await API.duplicateProject(p.id, name, withTasks, State.currentUserId);
      await loadBootstrap();
      await loadProject(np.id);
      State.view = 'board';
      render();
      toast(`「${np.name}」を作成しました`);
    } catch (err) { toast(err.message); }
  };
  // ---- ゴミ箱
  loadTrash(container, p.id);

  container.querySelector('#set-delete').onclick = async () => {
    if (!confirm(`プロジェクト「${p.name}」を全データごと完全削除します。よろしいですか？`)) return;
    if (!confirm('この操作は取り消せません。本当に削除しますか？')) return;
    await API.deleteProject(p.id);
    State.pid = null; State.project = null; State.tasks = [];
    await loadBootstrap();
    State.view = 'home';
    render();
    toast('プロジェクトを削除しました');
  };
}
