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

/* =====================================================================
 *  ボードビュー
 * =================================================================== */
function renderBoard(container) {
  const tasks = filteredTasks();
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
      {
        key: 'm-none', id: null, name: '未割当', color: '#94a3b8',
        head: `${U.avatarHtml(null)}未割当`,
        tasks: tasks.filter(t => !t.assignee_id),
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
      else if (key !== 'm-none') preset.assignee_id = Number(key.slice(1));
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
    <div class="card-title">${t.milestone ? '<span class="msdiamond">◆</span> ' : ''}${U.esc(t.title)}</div>
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
      ${U.avatarHtml(m)}
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
        } else {
          const mid = key === 'm-none' ? null : Number(key.slice(1));
          if (t.assignee_id === mid) return;
          await API.updateTask(dragId, { assignee_id: mid, actor_id: State.currentUserId });
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
        case 'assignee': return mmap[t.assignee_id] ? mmap[t.assignee_id].name : 'んんん';
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
      if (field === 'progress' || field === 'status_id' || field === 'assignee_id') {
        value = value === null ? null : Number(value);
      }
      if (field === 'estimate_h') value = value === null ? null : Number(value);
      try {
        await API.updateTask(tid, { [field]: value, actor_id: State.currentUserId });
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
    <td><select data-edit="assignee_id" ${dis('assignee_id')}>
      <option value="">未割当</option>
      ${State.members.map(m => `<option value="${m.id}" ${m.id === t.assignee_id ? 'selected' : ''}>${U.esc(m.name)}</option>`).join('')}
    </select></td>
    ${vis.prio ? `<td><select data-edit="priority" ${dis('priority')}>
      ${['highest', 'high', 'medium', 'low'].map(p => `<option value="${p}" ${p === t.priority ? 'selected' : ''}>${U.prioLabel[p]}</option>`).join('')}
    </select></td>` : ''}
    <td><input type="date" data-edit="start_date" value="${U.esc(t.start_date || '')}" ${dis('start_date')}></td>
    <td class="${dueCls ? 'due ' + dueCls : ''}"><input type="date" data-edit="due_date" value="${U.esc(t.due_date || '')}" ${dis('due_date')}></td>
    <td><span class="mini-pbar"><div style="width:${t.progress}%"></div></span>${t.progress}%</td>
    ${vis.est ? `<td><input type="number" data-edit="estimate_h" value="${t.estimate_h ?? ''}" min="0" step="0.5" style="width:56px" ${dis('estimate_h')}></td>` : ''}
    ${vis.tags ? `<td>${t.tags.map(tg => `<span class="tag-chip">${U.esc(tg)}</span>`).join(' ')}</td>` : ''}
    ${cfDefs.map(f => `<td>${U.esc(t.custom_values[f.key] ?? '')}</td>`).join('')}
    <td>${t.comment_count ? `💬${t.comment_count}` : ''}</td>
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
    const m = mmap[t.assignee_id];
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
      <span class="g-cell-sm g-col-a" title="${m ? U.esc(m.name) : ''}">${m ? U.esc(m.name.split(/[\s　]/)[0]) : '—'}</span>
      <span class="g-cell-sm g-col-d">${fmtShort(t.start_date)}${(t.start_date || t.due_date) ? '〜' : ''}${fmtShort(t.due_date)}</span>
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
    const st = smap[t.status_id];
    const color = st ? st.color : '#94a3b8';
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
        title="${U.esc(t.title)}  ${s} 〜 ${e}  進捗${t.progress}%">
      <div class="fill" style="width:${t.progress}%"></div>
      ${!parent && w > 80 ? `<span class="g-bar-label">${U.esc(t.title)}</span>` : ''}
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
    ${State.baseline && Object.keys(State.baseline).length ? '<span class="tag-chip" title="灰色の細いバーが基準線（保存時点の計画）">基準線表示中</span>' : ''}
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
  </div>
  <p style="color:var(--muted);font-size:12px;margin:8px 2px">
    ${G.edit
      ? 'バー中央ドラッグ＝日程移動 ／ 左端＝開始日のみ・右端＝期限のみ変更 ／ 左の行を⠿でドラッグ＝並べ替え ／ ⭢⭠＝階層変更 ／ ＋＝サブタスク追加 ／ 最下段レーンをドラッグ＝新規タスク作成'
      : 'タスク名・バーのクリックで詳細を開きます。◆ はマイルストーン。'}</p>`;

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
function renderDashboard(container) {
  const tasks = State.tasks;
  const smap = statusMap();
  const today = U.todayStr();
  const total = tasks.length;
  const done = tasks.filter(t => smap[t.status_id] && smap[t.status_id].is_done).length;
  const overdue = tasks.filter(t => t.due_date && t.due_date < today &&
    !(smap[t.status_id] && smap[t.status_id].is_done)).length;
  const avg = total ? Math.round(tasks.reduce((a, t) => a + t.progress, 0) / total) : 0;

  const statusItems = State.statuses.map(s => ({
    label: s.name, color: s.color,
    value: tasks.filter(t => t.status_id === s.id).length,
  }));
  const memberItems = [
    ...State.members.map(m => ({
      label: m.name.split(/[\s　]/)[0], color: m.color,
      value: tasks.filter(t => t.assignee_id === m.id &&
        !(smap[t.status_id] && smap[t.status_id].is_done)).length,
    })),
    { label: '未割当', color: '#cbd5e1', value: tasks.filter(t => !t.assignee_id).length },
  ];
  const prioColors = { highest: '#ef4444', high: '#f97316', medium: '#6366f1', low: '#94a3b8' };
  const prioItems = ['highest', 'high', 'medium', 'low'].map(p => ({
    label: U.prioLabel[p], color: prioColors[p],
    value: tasks.filter(t => t.priority === p).length,
  }));

  // 週別の期限件数（負荷の見える化）
  const weeks = [];
  const wkStart = new Date();
  wkStart.setDate(wkStart.getDate() - wkStart.getDay() + 1 - 14);  // 2週前の月曜から
  for (let i = 0; i < 10; i++) {
    const s = new Date(wkStart.getTime() + i * 7 * DAY);
    const e = new Date(s.getTime() + 6 * DAY);
    const si = s.toISOString().slice(0, 10), ei = e.toISOString().slice(0, 10);
    weeks.push({
      label: `${s.getMonth() + 1}/${s.getDate()}`,
      value: tasks.filter(t => t.due_date && t.due_date >= si && t.due_date <= ei).length,
    });
  }

  const upcoming = tasks
    .filter(t => t.due_date && !(smap[t.status_id] && smap[t.status_id].is_done))
    .sort((a, b) => a.due_date < b.due_date ? -1 : 1).slice(0, 8);

  const legendHtml = (items) => `<div class="legend">${items.map(i => `
    <div class="row"><span class="dot" style="background:${i.color}"></span>
    ${U.esc(i.label)}<span class="val">${i.value}</span></div>`).join('')}</div>`;

  container.innerHTML = `<div class="dash">
    <div class="dash-card span3"><h3>タスク総数</h3><div class="stat-num">${total}</div>
      <div class="stat-sub">サブタスク含む</div></div>
    <div class="dash-card span3"><h3>完了</h3><div class="stat-num green">${done}</div>
      <div class="stat-sub">${total ? Math.round(done / total * 100) : 0}% 完了</div></div>
    <div class="dash-card span3"><h3>期限超過</h3><div class="stat-num ${overdue ? 'red' : ''}">${overdue}</div>
      <div class="stat-sub">要対応</div></div>
    <div class="dash-card span3"><h3>平均進捗</h3><div class="stat-num">${avg}%</div>
      <div class="stat-sub">全タスク平均</div></div>

    <div class="dash-card span4"><h3>ステータス別</h3>
      <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;justify-content:center">
        ${Charts.donut(statusItems)}${legendHtml(statusItems)}</div></div>
    <div class="dash-card span4"><h3>担当者別 残タスク</h3>${Charts.hbar(memberItems, { width: 300 })}</div>
    <div class="dash-card span4"><h3>優先度別</h3>${Charts.hbar(prioItems, { width: 300 })}</div>

    <div class="dash-card span8"><h3>週別 期限タスク数（負荷）</h3>
      ${Charts.line(weeks.map(w => w.value), { width: 640, height: 160, labels: weeks.map((w, i) => i % 2 === 0 ? w.label : '') })}</div>
    <div class="dash-card span4"><h3>期限が近いタスク</h3>
      <ul class="deadline-list">${upcoming.map(t => {
        const cls = U.dueClass(t, smap);
        return `<li data-open="${t.id}">
          ${U.avatarHtml(memberMap()[t.assignee_id])}
          <span class="t">${U.esc(t.title)}</span>
          <span class="due ${cls}">${U.fmtDate(t.due_date)}</span></li>`;
      }).join('') || '<div class="empty-note">なし</div>'}</ul></div>

    <div class="dash-card span8"><h3>簡易ボード</h3>
      <div class="mini-board">${State.statuses.map(s => {
        const st = tasks.filter(t => t.status_id === s.id);
        return `<div class="mini-col"><h4 style="border-color:${U.esc(s.color)}">${U.esc(s.name)} (${st.length})</h4>
          ${st.slice(0, 5).map(t => `<div class="mini-card" data-open="${t.id}">${U.esc(t.title)}</div>`).join('')}
          ${st.length > 5 ? `<div class="mini-more">他 ${st.length - 5} 件</div>` : ''}</div>`;
      }).join('')}</div></div>

    <div class="dash-card span6"><h3>📉 バーンダウン（残タスク・直近30日）</h3>
      <div id="dash-burndown" class="empty-note">読み込み中…</div></div>
    <div class="dash-card span6"><h3>⚠ リスクタスク（期限接近×進捗低・超過）</h3>
      <div id="dash-risks" class="empty-note">読み込み中…</div></div>
    <div class="dash-card span6"><h3>⏱ 工数（見積 / 実績）</h3>
      <div id="dash-effort" class="empty-note">読み込み中…</div></div>
    <div class="dash-card span6"><h3>📄 レポート</h3>
      <p style="color:var(--muted);font-size:12.5px">進捗・完了・リスクを集計した週次サマリーを
        ノート（カテゴリ: レポート）に自動生成します。Webhook設定があれば同時に送信されます。</p>
      ${canEditNotes() ? '<button class="btn primary sm" id="dash-summary">週次サマリーを作成</button>' : ''}
      <a class="btn sm" href="/api/projects/${State.pid}/calendar.ics" download style="text-decoration:none;display:inline-block;margin-left:6px">📅 iCal（Outlook購読用）</a>
    </div>

    <div class="dash-card span4"><h3>最近のアクティビティ</h3>
      <ul class="act-list">${(State.activities || []).slice(0, 10).map(a => `
        <li><span class="act-badge">${U.esc(actLabel(a.action))}</span>
          <b>${U.esc(a.task_title || '')}</b> ${U.esc(a.detail || '')}
          <div>${U.esc(a.actor_name || 'システム')} ・ ${U.esc((a.created_at || '').slice(5, 16))}</div></li>`).join('') ||
        '<div class="empty-note">なし</div>'}</ul></div>
  </div>`;

  container.querySelectorAll('[data-open]').forEach(el => {
    el.addEventListener('click', () => openDetail(Number(el.dataset.open)));
  });
  const sumBtn = container.querySelector('#dash-summary');
  if (sumBtn) sumBtn.onclick = async () => {
    sumBtn.disabled = true;
    try {
      await API.weeklySummary(State.pid, State.currentUserId);
      toast('週次サマリーをノートに作成しました');
    } catch (err) { toast(err.message); }
    sumBtn.disabled = false;
  };
  loadDashboardMetrics(container);
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
        <span class="t">${U.esc(r.title)}</span>
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
        const cls = !t.due_date ? '' : t.due_date < today ? 'overdue'
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
            <span class="tag-chip">${U.esc(c.task_title)}</span>
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
        <div class="th-title">💬 ${U.esc(t.title)}</div>
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
  const byDay = {};
  for (const t of filteredTasks()) {
    if (t.due_date) (byDay[t.due_date] = byDay[t.due_date] || []).push(t);
  }
  const cells = [];
  const totalCells = Math.ceil((startDow + daysInMonth) / 7) * 7;
  for (let i = 0; i < totalCells; i++) {
    const dnum = i - startDow + 1;
    if (dnum < 1 || dnum > daysInMonth) { cells.push('<div class="cal-cell other"></div>'); continue; }
    const iso = `${y}-${String(mo + 1).padStart(2, '0')}-${String(dnum).padStart(2, '0')}`;
    const items = byDay[iso] || [];
    const dow = i % 7;
    cells.push(`<div class="cal-cell ${iso === today ? 'today' : ''} ${dow >= 5 ? 'weekend' : ''}">
      <div class="cal-date">${dnum}</div>
      ${items.slice(0, 3).map(t => {
        const st = smap[t.status_id];
        const done = st && st.is_done;
        return `<div class="cal-item ${done ? 'done' : ''}" data-open="${t.id}"
          style="border-left-color:${U.esc(st ? st.color : '#94a3b8')}"
          title="${U.esc(t.title)} / ${U.esc((mmap[t.assignee_id] || {}).name || '未割当')}">
          ${t.milestone ? '◆ ' : ''}${U.esc(t.title)}</div>`;
      }).join('')}
      ${items.length > 3 ? `<div class="cal-more">他 ${items.length - 3} 件</div>` : ''}
    </div>`);
  }
  container.innerHTML = `
    <div class="cal-toolbar">
      <button class="btn sm" id="cal-prev">←</button>
      <b style="font-size:16px">${y}年 ${mo + 1}月</b>
      <button class="btn sm" id="cal-next">→</button>
      <button class="btn sm ghost" id="cal-today">今月</button>
      <span class="spacer"></span>
      <span style="color:var(--muted);font-size:12px">期限日ベース。◆=マイルストーン。フィルターが効きます</span>
    </div>
    <div class="cal-grid">
      ${['月', '火', '水', '木', '金', '土', '日'].map(d => `<div class="cal-dow">${d}</div>`).join('')}
      ${cells.join('')}
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

    <div class="dash-card span6"><h3>外部ユーザーの既定・制限</h3>
      <p class="set-hint">新しく外部ユーザーをアサインしたときの初期値。個別の変更はメンバー管理から。</p>
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
        <input id="set-webhook" value="${U.esc(s.webhook_url || '')}" placeholder="https://outlook.office.com/webhook/… または https://hooks.slack.com/…"></div>
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
  };
  bindTplRows();
  container.querySelector('#set-apply-tpl').onclick = async () => {
    await saveSettings();   // テンプレ編集を反映してから
    const r = await API.applyNoteTemplate(p.id, State.currentUserId);
    toast(`テンプレートから ${r.created} 件のノートを作成しました`);
  };

  const collectSettings = () => {
    const out = { ...s };
    container.querySelectorAll('[data-set]').forEach(cb => { out[cb.dataset.set] = cb.checked; });
    out.webhook_url = container.querySelector('#set-webhook').value.trim();
    out.webhook_events = [...container.querySelectorAll('[data-wevent]')]
      .filter(cb => cb.checked).map(cb => cb.dataset.wevent);
    out.note_templates = [...container.querySelectorAll('[data-tpl]')].map(row => ({
      category: row.querySelector('[data-f=category]').value.trim() || 'その他',
      title: row.querySelector('[data-f=title]').value.trim(),
    })).filter(t => t.title);
    return out;
  };

  const saveSettings = async () => {
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
    }, State.currentUserId);
    await loadBootstrap();
    await loadProject(p.id);
  };

  container.querySelector('#set-save').onclick = async () => {
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
