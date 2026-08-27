/* ================= detail.js — タスク詳細パネル（イシュー風） ================= */

let detailTaskId = null;

async function openDetail(tid) {
  try {
    const d = await API.taskDetail(tid, State.currentUserId);
    detailTaskId = tid;
    renderDetailPanel(d);
    document.getElementById('detail-overlay').classList.remove('hidden');
    document.getElementById('detail-panel').classList.remove('hidden');
    if (typeof syncHash === 'function') syncHash();
  } catch (err) { toast('読み込み失敗: ' + err.message); }
}

function closeDetail() {
  detailTaskId = null;
  document.getElementById('detail-overlay').classList.add('hidden');
  document.getElementById('detail-panel').classList.add('hidden');
  if (typeof syncHash === 'function') syncHash();
}

async function reloadDetail() {
  if (detailTaskId) {
    const d = await API.taskDetail(detailTaskId, State.currentUserId);
    renderDetailPanel(d);
  }
}

let detailUpdatedAt = null;   // 楽観ロック用（読み込んだ時点の updated_at）

async function patchTask(tid, patch, { silent } = {}) {
  patch.actor_id = State.currentUserId;
  if (detailUpdatedAt) patch.expected_updated_at = detailUpdatedAt;
  try {
    const updated = await API.updateTask(tid, patch);
    detailUpdatedAt = updated.updated_at;
    await refresh({ keepView: true });
    if (!silent) await reloadDetail();
  } catch (err) {
    toast('更新に失敗: ' + err.message);
    if (String(err.message).includes('先に更新')) await reloadDetail();
  }
}

function renderDetailPanel(d) {
  const t = d.task;
  detailUpdatedAt = t.updated_at;
  const panel = document.getElementById('detail-panel');
  const smap = statusMap();
  const cfDefs = fieldVisible('custom_fields') ? (State.project.custom_fields || []) : [];
  const parent = t.parent_id ? State.tasks.find(x => x.id === t.parent_id) : null;
  // 権限: フィールドごとに編集可否を判定（member は自分の担当タスクの一部項目のみ）
  const dis = (f) => canEditField(t, f) ? '' : 'disabled';
  const cfDis = dis('custom_values');

  const cfInputs = cfDefs.map(f => {
    const val = t.custom_values[f.key] ?? '';
    if (f.type === 'select') {
      return `<label>${U.esc(f.label)}</label>
        <select data-cf="${U.esc(f.key)}" ${cfDis}><option value=""></option>
        ${(f.options || []).map(o => `<option ${o === val ? 'selected' : ''}>${U.esc(o)}</option>`).join('')}</select>`;
    }
    const type = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text';
    return `<label>${U.esc(f.label)}</label>
      <input type="${type}" data-cf="${U.esc(f.key)}" value="${U.esc(val)}" ${cfDis}>`;
  }).join('');

  panel.innerHTML = `
    <div class="dp-head">
      <span class="id">#${t.id}</span>
      ${parent ? `<button class="btn sm ghost" id="dp-goto-parent">↑ ${U.esc(taskLabel(parent))}</button>` : ''}
      <span class="spacer" style="flex:1"></span>
      <button class="icon-btn" id="dp-watch" title="${d.watching ? 'ウォッチ中（クリックで解除）' : 'ウォッチする（変更が通知されます）'}"
        style="font-size:15px">${d.watching ? '🔔' : '🔕'}</button>
      ${State.myRole ? `<span class="tag-chip" title="このプロジェクトでのあなたの実効権限">${U.esc(EFF_LABEL[State.myRole] || '')}</span>` : ''}
      ${canEditTask(t) ? '<button class="btn sm danger" id="dp-delete">削除</button>' : ''}
      <button class="icon-btn" id="dp-close" style="font-size:18px">✕</button>
    </div>
    <div class="dp-body">
      <input class="dp-title" id="dp-title" value="${U.esc(t.title)}" ${dis('title')}>

      <div class="dp-grid">
        <label>ステータス</label>
        <select id="dp-status" ${dis('status_id')}>
          ${State.statuses.map(s => `<option value="${s.id}" ${s.id === t.status_id ? 'selected' : ''}>${U.esc(s.name)}</option>`).join('')}
        </select>
        <label>担当者</label>
        ${hasChildren(t.id)
          ? `<span style="color:var(--muted);font-size:12.5px;align-self:center">—（下位タスクで管理）</span>`
          : `<select id="dp-assignee" ${dis('assignee_id')}>
          ${assigneeOptionsHtml(t)}
        </select>`}
        ${fieldVisible('priority') ? `<label>優先度</label>
        <select id="dp-priority" ${dis('priority')}>
          ${['highest', 'high', 'medium', 'low'].map(p => `<option value="${p}" ${p === t.priority ? 'selected' : ''}>${U.prioLabel[p]}</option>`).join('')}
        </select>` : ''}
        <label>マイルストーン</label>
        <input type="checkbox" id="dp-milestone" ${t.milestone ? 'checked' : ''} style="width:auto;justify-self:start" ${dis('milestone')}>
        <label>開始日</label>
        <input type="date" id="dp-start" value="${U.esc(t.start_date || '')}" ${dis('start_date')}>
        <label>期限</label>
        <input type="date" id="dp-due" value="${U.esc(t.due_date || '')}" ${dis('due_date')}>
        ${fieldVisible('estimate') ? `<label>見積 (h)</label>
        <input type="number" id="dp-est" value="${t.estimate_h ?? ''}" min="0" step="0.5" ${dis('estimate_h')}>
        <label>実績 (h)</label>
        <input type="number" id="dp-act" value="${t.actual_h ?? ''}" min="0" step="0.5" ${dis('actual_h')}>` : ''}
        <label>親タスク</label>
        <select id="dp-parent" ${dis('parent_id')}>
          <option value="">（なし）</option>
          ${buildWbs(State.tasks).filter(x => x.id !== t.id && !isDescendant(x.id, t.id))
            .map(x => `<option value="${x.id}" ${x.id === t.parent_id ? 'selected' : ''}>${U.esc(taskLabel(x))}</option>`).join('')}
        </select>
        <label>先行タスク</label>
        <select id="dp-deps" multiple size="3" title="Ctrl+クリックで複数選択" ${dis('deps')}>
          ${buildWbs(State.tasks).filter(x => x.id !== t.id)
            .map(x => `<option value="${x.id}" ${(t.deps || []).includes(x.id) ? 'selected' : ''}>${U.esc(taskLabel(x))}</option>`).join('')}
        </select>
        <label>繰り返し</label>
        <select id="dp-recur" ${dis('recur')} title="完了にすると次回分が自動作成されます">
          ${[['', 'なし'], ['weekly', '毎週'], ['biweekly', '隔週'], ['monthly', '毎月']]
            .map(([v, l]) => `<option value="${v}" ${(t.recur || '') === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        ${cfInputs}
      </div>

      <div class="dp-section">
        <h3>進捗${d.subtasks.length ? '（サブタスクから自動算出）' : ''}</h3>
        <div class="range-row">
          <input type="range" id="dp-progress" min="0" max="100" step="5" value="${t.progress}"
            ${d.subtasks.length ? 'disabled title="サブタスクの進捗の平均が自動反映されます"' : dis('progress')}>
          <span class="range-val" id="dp-progress-val">${t.progress}%</span>
        </div>
      </div>

      ${fieldVisible('tags') ? `<div class="dp-section">
        <h3>タグ</h3>
        <div class="tag-editor" id="dp-tags">
          ${t.tags.map(tg => `<span class="tag-chip">${U.esc(tg)}${canEditField(t, 'tags') ? `<span class="x" data-tag="${U.esc(tg)}">✕</span>` : ''}</span>`).join('')}
          ${canEditField(t, 'tags') ? '<input id="dp-tag-input" placeholder="+ タグ追加 (Enter)">' : ''}
        </div>
      </div>` : ''}

      <div class="dp-section">
        <h3>説明</h3>
        <textarea class="dp-desc" id="dp-desc" placeholder="タスクの説明・背景・完了条件など" ${dis('description')}>${U.esc(t.description)}</textarea>
      </div>

      <div class="dp-section">
        <h3>サブタスク（${d.subtasks.length}）
          ${canCreateTask() ? '<button class="btn sm ghost" id="dp-add-sub">＋追加</button>' : ''}</h3>
        <ul class="subtask-list">
          ${d.subtasks.map(s => {
            const done = smap[s.status_id] && smap[s.status_id].is_done;
            return `<li data-sub="${s.id}">
              <span>${done ? '✅' : '⬜'}</span>
              <span class="${done ? 'done' : ''}" style="flex:1">${U.esc(taskLabel(s))}</span>
              <span class="mini-pbar"><div style="width:${s.progress}%"></div></span>
              ${U.avatarHtml(memberMap()[s.assignee_id])}</li>`;
          }).join('') || '<div class="empty-note" style="padding:8px;font-size:12px">なし</div>'}
        </ul>
      </div>

      <div class="dp-section">
        <h3>関連リンク（${d.links.length}）
          ${canEditTask(t) ? '<button class="btn sm ghost" id="dp-add-link">＋追加</button>' : ''}</h3>
        <ul class="link-list">
          ${d.links.map(l => `<li>
            <span class="kind-chip">${U.esc(kindLabel(l.kind))}</span>
            ${l.url ? `<a href="${U.esc(l.url)}" target="_blank" rel="noopener">${U.esc(l.title)}</a>`
                    : `<span>${U.esc(l.title)}</span>`}
            <span style="flex:1"></span>
            ${canEditTask(t) ? `<button class="icon-btn" data-del-link="${l.id}">🗑</button>` : ''}</li>`).join('') ||
            '<div class="empty-note" style="padding:8px;font-size:12px">なし</div>'}
        </ul>
      </div>

      <div class="dp-section">
        <h3>📎 添付ファイル（${(d.attachments || []).length}）
          ${canComment() ? `<label class="btn sm ghost" style="cursor:pointer">＋追加
            <input type="file" id="dp-attach" style="display:none"></label>` : ''}</h3>
        <ul class="link-list">
          ${(d.attachments || []).map(a => `<li>
            <span class="kind-chip">${(a.size / 1024).toFixed(0)}KB</span>
            <a href="/api/files/${a.id}">${U.esc(a.filename)}</a>
            <span style="color:var(--muted);font-size:11px">${U.esc(a.uploaded_by_name || '')}</span>
            <span style="flex:1"></span>
            ${(a.uploaded_by === State.currentUserId || State.myRole === 'admin')
              ? `<button class="icon-btn" data-del-attach="${a.id}">🗑</button>` : ''}</li>`).join('') ||
            '<div class="empty-note" style="padding:8px;font-size:12px">なし（20MBまで・主要な形式のみ）</div>'}
        </ul>
      </div>

      <div class="dp-section">
        <h3>🔗 タスク間リンク（${(d.relations || []).length}）
          ${canEditTask(t) ? '<button class="btn sm ghost" id="dp-add-rel">＋追加</button>' : ''}</h3>
        <ul class="link-list">
          ${(d.relations || []).map(r => `<li>
            <span class="kind-chip">${r.kind === 'blocks' ? '⛔ ブロック' : '↔ 関連'}</span>
            <a href="#" data-open-task="${r.other_id}">${U.esc(wbsOf(r.other_id) ? wbsOf(r.other_id) + ' ' + r.other_title : r.other_title)}</a>
            <span style="flex:1"></span>
            ${canEditTask(t) ? `<button class="icon-btn" data-del-rel="${r.id}">🗑</button>` : ''}</li>`).join('') ||
            '<div class="empty-note" style="padding:8px;font-size:12px">なし</div>'}
        </ul>
      </div>

      ${d.comments_hidden
        ? `<div class="dp-section"><h3>💬 コメント・議論</h3>
            <div class="empty-note" style="padding:10px;font-size:12.5px">
              🔒 このプロジェクトではコメントの閲覧が制限されています（外部ユーザー設定）</div></div>`
        : `<div class="dp-section">
        <h3>💬 コメント・議論（${d.comments.length}）
          <button class="btn sm ghost" id="dp-open-thread">議論ページで開く</button></h3>
        <div id="dp-comments">
          ${d.comments.map(c => `<div class="comment">
            ${U.avatarHtml(c.author_id ? { name: c.author_name, color: c.author_color } : null)}
            <div class="body">
              <div class="meta"><b>${U.esc(c.author_name || '不明')}</b> ${U.esc(c.created_at)}${c.updated_at ? '（編集済）' : ''}
                ${(c.author_id === State.currentUserId || State.myRole === 'admin')
                  ? `<button class="icon-btn" data-edit-comment="${c.id}" style="font-size:11px" title="編集">✏</button>
                     <button class="icon-btn" data-del-comment="${c.id}" style="font-size:11px">🗑</button>` : ''}</div>
              <div class="text">${U.esc(c.body)}</div>
            </div></div>`).join('') ||
            '<div class="empty-note" style="padding:8px;font-size:12px">まだコメントはありません</div>'}
        </div>
        ${canComment() ? `<div class="comment-form">
          ${U.avatarHtml(memberMap()[State.currentUserId])}
          <div style="flex:1">
            <textarea id="dp-comment-body" placeholder="コメントを書く…（このタスクに関する議論・報告・質問など）"></textarea>
            <div class="comment-hint">Ctrl+Enter で送信 ／ 投稿者: ${U.esc((memberMap()[State.currentUserId] || {}).name || '未設定')}</div>
            <button class="btn primary sm" id="dp-comment-send" style="margin-top:6px">コメントする</button>
          </div>
        </div>` : `<div class="comment-hint">このプロジェクトでコメントを投稿する権限がありません（${U.esc(EFF_LABEL[State.myRole] || '未参加')}）</div>`}
      </div>`}

      <div class="dp-section">
        <h3>変更履歴</h3>
        <ul class="dp-activity">
          ${d.activities.map(a => `<li>[${U.esc(actLabel(a.action))}] ${U.esc(a.detail || '')}
            — ${U.esc(a.actor_name || 'システム')} ${U.esc((a.created_at || '').slice(5, 16))}</li>`).join('') ||
            '<li>なし</li>'}
        </ul>
      </div>
    </div>`;

  bindDetailEvents(t, d);
}

function isDescendant(candidateId, rootId) {
  // candidateId が rootId の子孫なら true（親付け替えの循環防止）
  let cur = State.tasks.find(x => x.id === candidateId);
  const guard = new Set();
  while (cur && cur.parent_id != null && !guard.has(cur.id)) {
    guard.add(cur.id);
    if (cur.parent_id === rootId) return true;
    cur = State.tasks.find(x => x.id === cur.parent_id);
  }
  return false;
}

function kindLabel(k) {
  return { link: 'リンク', doc: '資料', design: 'デザイン', repo: 'リポジトリ' }[k] || k;
}

function bindDetailEvents(t, d) {
  const $ = (id) => document.getElementById(id);
  const tid = t.id;

  $('dp-close').onclick = closeDetail;
  const gp = $('dp-goto-parent');
  if (gp) gp.onclick = () => openDetail(t.parent_id);

  const delBtn = $('dp-delete');
  if (delBtn) delBtn.onclick = async () => {
    const n = State.tasks.filter(x => x.parent_id === tid).length;
    if (!confirm(`「${t.title}」を削除しますか？${n ? `\n（${n} 件のサブタスクは親なしになります）` : ''}`)) return;
    try {
      await API.deleteTask(tid, State.currentUserId);
      closeDetail();
      await refresh();
      toast('タスクを削除しました');
    } catch (err) { toast(err.message); }
  };

  $('dp-title').onchange = (e) => patchTask(tid, { title: e.target.value }, { silent: true });
  $('dp-status').onchange = (e) => patchTask(tid, { status_id: Number(e.target.value) });
  if ($('dp-assignee')) $('dp-assignee').onchange = (e) => patchTask(tid, assigneePatch(e.target.value));
  if ($('dp-priority')) $('dp-priority').onchange = (e) => patchTask(tid, { priority: e.target.value });
  $('dp-milestone').onchange = (e) => patchTask(tid, { milestone: e.target.checked });
  $('dp-start').onchange = (e) => patchTask(tid, { start_date: e.target.value || null });
  $('dp-due').onchange = (e) => patchTask(tid, { due_date: e.target.value || null });
  if ($('dp-est')) $('dp-est').onchange = (e) =>
    patchTask(tid, { estimate_h: e.target.value ? Number(e.target.value) : null });
  if ($('dp-act')) $('dp-act').onchange = (e) =>
    patchTask(tid, { actual_h: e.target.value ? Number(e.target.value) : null });
  $('dp-desc').onchange = (e) => patchTask(tid, { description: e.target.value }, { silent: true });
  const recurSel = $('dp-recur');
  if (recurSel) recurSel.onchange = (e) => patchTask(tid, { recur: e.target.value });
  const watchBtn = $('dp-watch');
  if (watchBtn) watchBtn.onclick = async () => {
    try {
      if (d.watching) await API.unwatchTask(tid, State.currentUserId);
      else await API.watchTask(tid, State.currentUserId);
      await reloadDetail();
      toast(d.watching ? 'ウォッチを解除しました' : 'ウォッチしました（変更が通知されます）');
    } catch (err) { toast(err.message); }
  };
  const attachInput = $('dp-attach');
  if (attachInput) attachInput.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await API.upload('task', tid, file, State.currentUserId);
      await reloadDetail();
      toast(`「${file.name}」を添付しました`);
    } catch (err) { toast(err.message); }
    e.target.value = '';
  };
  document.querySelectorAll('#detail-panel [data-del-attach]').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('この添付ファイルを削除しますか？')) return;
      await API.deleteAttachment(Number(btn.dataset.delAttach), State.currentUserId);
      await reloadDetail();
    };
  });
  const addRel = $('dp-add-rel');
  if (addRel) addRel.onclick = () => openRelationModal(tid);
  document.querySelectorAll('#detail-panel [data-del-rel]').forEach(btn => {
    btn.onclick = async () => {
      await API.deleteRelation(Number(btn.dataset.delRel));
      await reloadDetail();
    };
  });
  document.querySelectorAll('#detail-panel [data-open-task]').forEach(a => {
    a.onclick = (e) => { e.preventDefault(); openDetail(Number(a.dataset.openTask)); };
  });
  document.querySelectorAll('#detail-panel [data-edit-comment]').forEach(btn => {
    btn.onclick = async () => {
      const c = d.comments.find(x => x.id === Number(btn.dataset.editComment));
      const text = prompt('コメントを編集:', c.body);
      if (text === null || !text.trim() || text === c.body) return;
      try {
        await API.editComment(c.id, text.trim(), State.currentUserId);
        await reloadDetail();
        await refresh({ keepView: true });
      } catch (err) { toast(err.message); }
    };
  });

  $('dp-parent').onchange = (e) =>
    patchTask(tid, { parent_id: e.target.value ? Number(e.target.value) : null });
  $('dp-deps').onchange = (e) =>
    patchTask(tid, { deps: [...e.target.selectedOptions].map(o => Number(o.value)) });

  const rng = $('dp-progress');
  rng.oninput = () => { $('dp-progress-val').textContent = rng.value + '%'; };
  rng.onchange = () => patchTask(tid, { progress: Number(rng.value) });

  // カスタムフィールド
  document.querySelectorAll('#detail-panel [data-cf]').forEach(el => {
    el.onchange = () => {
      const cv = { ...t.custom_values, [el.dataset.cf]: el.value };
      patchTask(tid, { custom_values: cv }, { silent: true });
    };
  });

  // タグ
  const tagInput = $('dp-tag-input');
  if (tagInput) tagInput.onkeydown = (e) => {
    if (e.key === 'Enter' && tagInput.value.trim()) {
      const tags = [...t.tags, tagInput.value.trim()];
      patchTask(tid, { tags });
    }
  };
  document.querySelectorAll('#dp-tags .x').forEach(x => {
    x.onclick = () => {
      const tags = t.tags.filter(tg => tg !== x.dataset.tag);
      patchTask(tid, { tags });
    };
  });

  // サブタスク
  const addSub = $('dp-add-sub');
  if (addSub) addSub.onclick = () => openTaskModal({ parent_id: tid });
  document.querySelectorAll('[data-sub]').forEach(li => {
    li.onclick = () => openDetail(Number(li.dataset.sub));
  });

  // リンク
  const addLink = $('dp-add-link');
  if (addLink) addLink.onclick = () => openLinkModal(tid);
  document.querySelectorAll('[data-del-link]').forEach(btn => {
    btn.onclick = async () => {
      await API.deleteLink(Number(btn.dataset.delLink));
      await reloadDetail(); await refresh({ keepView: true });
    };
  });

  // コメント
  const openTh = $('dp-open-thread');
  if (openTh) openTh.onclick = () => { closeDetail(); openThread(tid); };

  const sendBtn = $('dp-comment-send');
  if (sendBtn) {
    const send = async () => {
      const body = $('dp-comment-body').value.trim();
      if (!body) return;
      try {
        await API.addComment(tid, { body, author_id: State.currentUserId });
        await reloadDetail(); await refresh({ keepView: true });
      } catch (err) { toast(err.message); }
    };
    sendBtn.onclick = send;
    $('dp-comment-body').onkeydown = (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
    };
    attachMentionAutocomplete($('dp-comment-body'), commentParticipants(d.comments));
  }
  document.querySelectorAll('[data-del-comment]').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('このコメントを削除しますか？')) return;
      try {
        await API.deleteComment(Number(btn.dataset.delComment), State.currentUserId);
        await reloadDetail(); await refresh({ keepView: true });
      } catch (err) { toast(err.message); }
    };
  });
}

function openLinkModal(tid) {
  showModal(`
    <h2>関連リンクを追加</h2>
    <div class="form-row"><label>タイトル *</label><input id="lk-title" placeholder="例: API設計書"></div>
    <div class="form-row"><label>URL</label><input id="lk-url" placeholder="https://…（社内Wiki・Figma・リポジトリ等）"></div>
    <div class="form-row"><label>種別</label>
      <select id="lk-kind">
        <option value="link">リンク</option><option value="doc">資料</option>
        <option value="design">デザイン</option><option value="repo">リポジトリ</option>
      </select></div>
    <div class="modal-actions">
      <button class="btn" data-close>キャンセル</button>
      <button class="btn primary" id="lk-save">追加</button>
    </div>`);
  document.getElementById('lk-save').onclick = async () => {
    const title = document.getElementById('lk-title').value.trim();
    if (!title) { toast('タイトルを入力してください'); return; }
    await API.addLink(tid, {
      title,
      url: document.getElementById('lk-url').value.trim(),
      kind: document.getElementById('lk-kind').value,
    });
    closeModal();
    await reloadDetail(); await refresh({ keepView: true });
  };
}


function openRelationModal(tid) {
  showModal(`
    <h2>🔗 タスク間リンクを追加</h2>
    <div class="form-row"><label>相手タスク</label>
      <select id="rel-other">
        ${buildWbs(State.tasks).filter(x => x.id !== tid)
          .map(x => `<option value="${x.id}">${U.esc(taskLabel(x))}</option>`).join('')}
      </select></div>
    <div class="form-row"><label>種類</label>
      <select id="rel-kind">
        <option value="relates">↔ 関連する</option>
        <option value="blocks">⛔ このタスクが相手をブロックする</option>
      </select></div>
    <div class="modal-actions">
      <button class="btn" data-close>キャンセル</button>
      <button class="btn primary" id="rel-save">追加</button>
    </div>`);
  document.getElementById('rel-save').onclick = async () => {
    try {
      await API.addRelation(tid, Number(document.getElementById('rel-other').value),
                            document.getElementById('rel-kind').value);
      closeModal();
      await reloadDetail();
    } catch (err) { toast(err.message); }
  };
}
