/* =======================================================================
   FILADELFIA — Configurações
   Página admin com 4 abas: Usuários, Auditoria, Backup, Importações
   ======================================================================= */

(function () {
  'use strict';
  const F = window.Filadelfia;

  /* ========== Estado ========== */
  let usersCache = [];
  let auditCache = [];

  /* ========== Init ========== */
  async function init() {
    await F.Auth.requireAuth();
    F.UI.renderTopbar('configuracoes');

    // Guard: só admin acessa
    if (!F.Auth.isAdmin()) {
      document.getElementById('denied').classList.remove('hidden');
      document.getElementById('content').classList.add('hidden');
      return;
    }
    document.getElementById('denied').classList.add('hidden');
    document.getElementById('content').classList.remove('hidden');

    setupTabs();
    setupBackupButtons();
    setupAuditButtons();

    // Limpeza automática de auditoria (best-effort)
    F.Audit.cleanup().then(n => {
      if (n > 0) console.log(`[Audit] ${n} entradas antigas removidas`);
    }).catch(() => {});

    // Carrega aba inicial
    await loadUsers();
  }

  /* ========== Abas ========== */
  function setupTabs() {
    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tabName = btn.dataset.tab;
        document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('pane-' + tabName).classList.add('active');

        // Carrega dados ao abrir a aba
        if (tabName === 'usuarios') await loadUsers();
        else if (tabName === 'auditoria') await loadAudit();
        else if (tabName === 'importacoes') await loadImportHistory();
      });
    });
  }

  /* ========== ABA USUÁRIOS ========== */
  async function loadUsers() {
    const el = document.getElementById('users-list');
    el.innerHTML = '<div style="padding: 40px 20px; text-align: center; color: var(--text-muted);">Carregando usuários…</div>';
    try {
      usersCache = await F.Auth.listUsers();
      renderUsers();
    } catch (err) {
      el.innerHTML = `<div style="padding: 40px 20px; text-align: center; color: var(--danger-text);">Erro ao carregar: ${F.escapeHTML(err.message)}</div>`;
    }
  }

  function renderUsers() {
    const el = document.getElementById('users-list');
    if (!usersCache.length) {
      el.innerHTML = '<div style="padding: 40px 20px; text-align: center; color: var(--text-muted);">Nenhum usuário cadastrado.</div>';
      return;
    }
    const myUid = F.state.user?.uid;

    el.innerHTML = usersCache.map(u => {
      const initials = (u.displayName || u.email || 'U')
        .split(/\s+/)
        .map(s => s[0])
        .filter(Boolean)
        .slice(0, 2)
        .join('')
        .toUpperCase();
      const isMe = u.uid === myUid;
      const lastLogin = u.lastLoginAt
        ? F.Fmt.fmtRelativeTime(u.lastLoginAt)
        : 'nunca acessou';

      return `
        <div class="user-row" data-uid="${F.escapeHTML(u.uid)}">
          <div class="avatar">${F.escapeHTML(initials)}</div>
          <div class="info">
            <div class="name">${F.escapeHTML(u.displayName || '—')} ${isMe ? '<span class="you">VOCÊ</span>' : ''}</div>
            <div class="email">${F.escapeHTML(u.email || '')}</div>
            <div class="meta">Último acesso: ${F.escapeHTML(lastLogin)}</div>
          </div>
          <select class="role-select" data-uid="${F.escapeHTML(u.uid)}" ${isMe ? 'disabled title="Você não pode alterar o próprio perfil"' : ''}>
            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
            <option value="editor" ${u.role === 'editor' ? 'selected' : ''}>Editor</option>
            <option value="viewer" ${u.role === 'viewer' ? 'selected' : ''}>Viewer</option>
          </select>
        </div>
      `;
    }).join('');

    // Handlers de mudança de role
    el.querySelectorAll('.role-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        const uid = sel.dataset.uid;
        const newRole = sel.value;
        const user = usersCache.find(u => u.uid === uid);
        if (!user) return;
        if (!confirm(`Confirma alterar o perfil de ${user.displayName || user.email} para ${newRole.toUpperCase()}?`)) {
          // Reverte a seleção
          sel.value = user.role;
          return;
        }
        try {
          F.UI.showLoading('Atualizando perfil…');
          await F.Auth.updateUserRole(uid, newRole);
          user.role = newRole;
          F.UI.showToast('Perfil atualizado', 'success');
        } catch (err) {
          F.UI.showToast(err.message || 'Erro ao atualizar perfil', 'error');
          sel.value = user.role; // reverte
        } finally {
          F.UI.hideLoading();
        }
      });
    });
  }

  /* ========== ABA AUDITORIA ========== */
  function setupAuditButtons() {
    document.getElementById('btn-audit-refresh').addEventListener('click', loadAudit);
    document.getElementById('btn-audit-cleanup').addEventListener('click', async () => {
      if (!confirm(`Remover entradas de auditoria com mais de ${F.Audit.RETENTION_DAYS} dias?`)) return;
      try {
        F.UI.showLoading('Limpando…');
        const n = await F.Audit.cleanup();
        F.UI.showToast(`${n} entrada(s) removida(s)`, 'success');
        await loadAudit();
      } catch (err) {
        F.UI.showToast(err.message, 'error');
      } finally {
        F.UI.hideLoading();
      }
    });

    document.getElementById('audit-action-filter').addEventListener('change', renderAudit);
    document.getElementById('audit-user-filter').addEventListener('change', renderAudit);
  }

  async function loadAudit() {
    const tbody = document.getElementById('audit-tbody');
    tbody.innerHTML = '<tr><td colspan="4" class="audit-empty">Carregando…</td></tr>';
    try {
      auditCache = await F.Audit.fetchEntries({ limit: 500 });
      populateAuditFilters();
      renderAudit();
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="4" class="audit-empty" style="color: var(--danger-text);">Erro: ${F.escapeHTML(err.message)}</td></tr>`;
    }
  }

  function populateAuditFilters() {
    // Ações únicas
    const actions = [...new Set(auditCache.map(e => e.action))].sort();
    const actionSel = document.getElementById('audit-action-filter');
    const currentAction = actionSel.value;
    actionSel.innerHTML = '<option value="">Todas as ações</option>' +
      actions.map(a => `<option value="${F.escapeHTML(a)}">${F.escapeHTML(F.Audit.actionLabel(a))}</option>`).join('');
    actionSel.value = currentAction;

    // Usuários únicos
    const users = [...new Map(auditCache.map(e => [e.actorUid, e.actorName])).entries()]
      .filter(([uid]) => uid)
      .sort((a, b) => (a[1] || '').localeCompare(b[1] || ''));
    const userSel = document.getElementById('audit-user-filter');
    const currentUser = userSel.value;
    userSel.innerHTML = '<option value="">Todos os usuários</option>' +
      users.map(([uid, name]) => `<option value="${F.escapeHTML(uid)}">${F.escapeHTML(name || uid)}</option>`).join('');
    userSel.value = currentUser;
  }

  function renderAudit() {
    const tbody = document.getElementById('audit-tbody');
    const actionFilter = document.getElementById('audit-action-filter').value;
    const userFilter = document.getElementById('audit-user-filter').value;

    let filtered = auditCache;
    if (actionFilter) filtered = filtered.filter(e => e.action === actionFilter);
    if (userFilter) filtered = filtered.filter(e => e.actorUid === userFilter);

    if (!filtered.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="audit-empty">Nenhuma entrada com esses filtros</td></tr>';
      return;
    }

    tbody.innerHTML = filtered.map(e => {
      const timeAgo = F.Fmt.fmtRelativeTime(e.ts);
      const fullTime = F.Fmt.fmtDateTimeFull(new Date(e.ts || Date.now()));
      const details = summarizeDetails(e);
      return `
        <tr>
          <td class="col-time" title="${F.escapeHTML(fullTime)}">${F.escapeHTML(timeAgo)}</td>
          <td class="col-actor">${F.escapeHTML(e.actorName || e.actorUid || '—')}</td>
          <td class="col-action">${F.escapeHTML(F.Audit.actionLabel(e.action))}</td>
          <td class="col-details">${details}</td>
        </tr>
      `;
    }).join('');
  }

  function summarizeDetails(e) {
    const d = e.details || {};
    if (!Object.keys(d).length) {
      return e.targetType ? `<span title="${F.escapeHTML(e.targetType + ':' + (e.targetId || ''))}">${F.escapeHTML(e.targetType)}</span>` : '—';
    }
    // Formata campos conhecidos de forma mais legível
    const parts = [];
    if (d.nome) parts.push(F.escapeHTML(d.nome));
    if (d.fornecedor) parts.push(F.escapeHTML(d.fornecedor));
    if (d.tipo) parts.push(F.escapeHTML(d.tipo));
    if (d.valor != null) parts.push(F.Fmt.fmtMoney(d.valor));
    if (d.newRole) parts.push(`novo perfil: ${F.escapeHTML(d.newRole)}`);
    if (d.periodStart && d.periodEnd) parts.push(`período ${F.escapeHTML(d.periodStart)} a ${F.escapeHTML(d.periodEnd)}`);
    if (d.countPagar != null) parts.push(`${d.countPagar} pagar, ${d.countReceber || 0} receber`);
    if (d.email) parts.push(F.escapeHTML(d.email));
    if (d.cellKey) parts.push(`<span style="opacity:0.6;">${F.escapeHTML(d.cellKey)}</span>`);
    return parts.length ? parts.join(' · ') : '—';
  }

  /* ========== ABA BACKUP ========== */
  function setupBackupButtons() {
    document.getElementById('btn-backup-download').addEventListener('click', downloadBackup);
    document.getElementById('btn-backup-restore').addEventListener('click', () => {
      document.getElementById('backup-file-input').click();
    });
    document.getElementById('backup-file-input').addEventListener('change', restoreBackup);
    document.getElementById('btn-clear-imported').addEventListener('click', clearImported);
  }

  async function downloadBackup() {
    try {
      F.UI.showLoading('Gerando backup…');
      const snap = await F.DB.dbRef('').once('value');
      const all = snap.val() || {};
      // Remove audit do backup (fica muito pesado e é regenerável)
      const payload = { ...all };
      delete payload.audit;

      const backup = {
        version: F.APP_VERSION,
        generatedAt: new Date().toISOString(),
        generatedBy: F.state.user?.email || F.state.user?.displayName || 'desconhecido',
        data: payload,
      };
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.download = `filadelfia-backup-${ts}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      await F.Audit.log('backup.downloaded', 'backup', null, { size: blob.size });
      F.UI.showToast('Backup gerado', 'success');
    } catch (err) {
      console.error(err);
      F.UI.showToast('Erro ao gerar backup: ' + err.message, 'error');
    } finally {
      F.UI.hideLoading();
    }
  }

  async function restoreBackup(ev) {
    const file = ev.target.files?.[0];
    if (!file) return;
    ev.target.value = ''; // permite reusar

    const confirmed = confirm(
      '⚠ RESTAURAR BACKUP\n\n' +
      'Esta operação vai SOBRESCREVER TODOS os dados atuais do sistema com o conteúdo do arquivo.\n\n' +
      'O que será restaurado: lançamentos, comentários, categorias, dados importados, usuários e configurações.\n\n' +
      'Esta ação não pode ser desfeita (a não ser que você tenha outro backup).\n\n' +
      'Deseja continuar?'
    );
    if (!confirmed) return;

    try {
      F.UI.showLoading('Lendo arquivo…');
      const text = await file.text();
      const backup = JSON.parse(text);
      if (!backup || !backup.data) throw new Error('Arquivo inválido: estrutura não reconhecida');

      F.UI.showLoading('Restaurando dados…');
      // Escreve em cada subnó, preservando o /audit atual
      const updates = {};
      Object.keys(backup.data).forEach(key => {
        if (key !== 'audit') updates[key] = backup.data[key];
      });
      await F.DB.dbRef('').update(updates);

      await F.Audit.log('backup.restored', 'backup', null, {
        generatedAt: backup.generatedAt,
        generatedBy: backup.generatedBy,
        version: backup.version,
      });

      F.UI.hideLoading();
      F.UI.showToast('Backup restaurado. Recarregue a página.', 'success');
      setTimeout(() => location.reload(), 2500);
    } catch (err) {
      console.error(err);
      F.UI.hideLoading();
      F.UI.showToast('Erro ao restaurar: ' + err.message, 'error');
    }
  }

  async function clearImported() {
    if (!confirm('Remover os dados importados do SIA do Firebase? Os outros dados serão mantidos.')) return;
    try {
      F.UI.showLoading('Limpando…');
      await F.DB.clearImportedData();
      // Limpa também o localStorage local (se estivermos nessa máquina)
      try { localStorage.removeItem(F.KEYS.DATA); } catch {}
      await F.Audit.log('import.cleared', 'import', null, {});
      F.UI.showToast('Dados importados removidos', 'success');
    } catch (err) {
      F.UI.showToast('Erro: ' + err.message, 'error');
    } finally {
      F.UI.hideLoading();
    }
  }

  /* ========== ABA IMPORTAÇÕES (Fase 4) ========== */
  async function loadImportHistory() {
    const el = document.getElementById('import-history-list');
    el.innerHTML = '<div style="padding: 30px 20px; text-align: center; color: var(--text-muted);">Carregando histórico…</div>';
    try {
      const snap = await F.DB.dbRef('importacoes_historico').once('value');
      const hist = snap.val() || {};
      const entries = Object.entries(hist)
        .map(([id, v]) => ({ id, ...v }))
        .sort((a, b) => (b.processedAt || 0) - (a.processedAt || 0));

      if (!entries.length) {
        el.innerHTML = '<div style="padding: 30px 20px; text-align: center; color: var(--text-muted); font-size: 13px;">Nenhuma importação anterior. O histórico é gerado a partir da próxima importação.</div>';
        return;
      }

      el.innerHTML = entries.map((e, i) => {
        const when = F.Fmt.fmtDateTimeFull(new Date(e.processedAt));
        const period = (e.periodStart && e.periodEnd) ? `${e.periodStart} a ${e.periodEnd}` : '—';
        const isCurrent = i === 0;
        return `
          <div style="padding: 14px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 10px; ${isCurrent ? 'background: var(--accent-bg); border-color: var(--accent);' : 'background: var(--surface);'}">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap;">
              <div style="flex: 1; min-width: 0;">
                <div style="font-weight: 700; font-size: 13px;">
                  ${isCurrent ? '<span style="font-family: JetBrains Mono, monospace; font-size: 9px; padding: 2px 7px; background: var(--accent); color: #fff; border-radius: 3px; letter-spacing: 0.08em; margin-right: 6px;">ATUAL</span>' : ''}
                  ${F.escapeHTML(when)}
                </div>
                <div style="font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--text-muted); margin-top: 4px;">
                  Por ${F.escapeHTML(e.processedBy || '—')} · ${e.countPagar || 0} pagar · ${e.countReceber || 0} receber · período ${F.escapeHTML(period)}
                </div>
              </div>
              ${isCurrent ? '' : `<button class="btn" data-rollback-id="${F.escapeHTML(e.id)}" style="flex-shrink: 0;">Restaurar esta versão</button>`}
            </div>
          </div>
        `;
      }).join('');

      el.querySelectorAll('[data-rollback-id]').forEach(btn => {
        btn.addEventListener('click', () => rollbackImport(btn.dataset.rollbackId));
      });
    } catch (err) {
      el.innerHTML = `<div style="padding: 30px 20px; text-align: center; color: var(--danger-text); font-size: 13px;">Erro: ${F.escapeHTML(err.message)}</div>`;
    }
  }

  async function rollbackImport(id) {
    if (!confirm('Restaurar esta versão como dados importados atuais?\n\nA versão atual será sobrescrita, mas continuará no histórico (se houver espaço).')) return;
    try {
      F.UI.showLoading('Restaurando importação…');
      // Pega o snapshot histórico
      const snap = await F.DB.dbRef(`importacoes_historico/${id}`).once('value');
      const hist = snap.val();
      if (!hist || !hist.payload) throw new Error('Snapshot não encontrado ou sem payload');

      // Restaura via saveImportedData (vai passar por toda a validação normal)
      await F.DB.saveImportedData(hist.payload);
      await F.Audit.log('import.rollback', 'import', id, {
        restoredProcessedAt: hist.processedAt,
        periodStart: hist.periodStart,
        periodEnd: hist.periodEnd,
      });

      F.UI.showToast('Importação restaurada', 'success');
      await loadImportHistory();
    } catch (err) {
      F.UI.showToast('Erro: ' + err.message, 'error');
    } finally {
      F.UI.hideLoading();
    }
  }

  /* ========== Start ========== */
  init();
})();
