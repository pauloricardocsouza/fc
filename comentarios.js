/* =======================================================================
   FILADELFIA — Página de Comentários (Entrega 3)

   Feed centralizado de todos os comentários.
   - Tab "Ativos": comentários vigentes
   - Tab "Excluídos": soft-deleted, podem ser restaurados ou removidos permanentemente
   - Filtros: tipo, autor, texto, fornecedor, data
   - Clique em "Ir à célula" navega ao fluxo com a célula aberta
   ======================================================================= */

(function () {
  'use strict';
  const F = window.Filadelfia;

  let allComments = {};       // { cellKey: { commentId: comment } }
  let flatComments = [];      // achatado com metadados extraídos
  let activeTab = 'ativos';   // 'ativos' | 'excluidos'
  let filters = { tipo: '', autor: '', busca: '', dataDe: '', dataAte: '' };

  async function init() {
    await F.Auth.requireAuth();
    F.UI.renderTopbar('comentarios');

    if (!F.IS_FIREBASE_CONFIGURED) {
      document.getElementById('feed').innerHTML =
        '<div class="empty-state-inline">Firebase não configurado.</div>';
      return;
    }

    F.DB.subscribeAllComments(data => {
      allComments = data || {};
      flatten();
      updateAuthorFilter();
      updateCounts();
      render();
    });

    setupEvents();
  }

  function setupEvents() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeTab = btn.dataset.tab;
        render();
      });
    });

    document.getElementById('filter-tipo').addEventListener('change', (e) => { filters.tipo = e.target.value; render(); });
    document.getElementById('filter-autor').addEventListener('change', (e) => { filters.autor = e.target.value; render(); });
    document.getElementById('filter-busca').addEventListener('input', (e) => { filters.busca = e.target.value.trim(); render(); });
    document.getElementById('filter-data-de').addEventListener('change', (e) => { filters.dataDe = e.target.value; render(); });
    document.getElementById('filter-data-ate').addEventListener('change', (e) => { filters.dataAte = e.target.value; render(); });
    document.getElementById('btn-reset-filters').addEventListener('click', () => {
      filters = { tipo: '', autor: '', busca: '', dataDe: '', dataAte: '' };
      document.getElementById('filter-tipo').value = '';
      document.getElementById('filter-autor').value = '';
      document.getElementById('filter-busca').value = '';
      document.getElementById('filter-data-de').value = '';
      document.getElementById('filter-data-ate').value = '';
      render();
    });
  }

  /* ========== Parse de cellKey ==========
     Formato: 'pagar__FORNECEDOR__YYYY-MM-DD' ou 'receber__YYYY-MM-DD'
     ========================================= */
  function parseCellKey(cellKey) {
    const parts = cellKey.split('__');
    if (parts[0] === 'receber' && parts.length === 2) {
      return { tipo: 'receber', data: parts[1] };
    }
    if (parts[0] === 'pagar' && parts.length === 3) {
      return { tipo: 'pagar', fornecedor: parts[1].replace(/_/g, ' '), data: parts[2] };
    }
    return { tipo: 'desconhecido', raw: cellKey };
  }

  function flatten() {
    flatComments = [];
    Object.entries(allComments).forEach(([cellKey, comments]) => {
      if (!comments) return;
      const meta = parseCellKey(cellKey);
      Object.entries(comments).forEach(([commentId, c]) => {
        if (!c) return;
        flatComments.push({
          ...c,
          id: commentId,
          cellKey,
          tipo: meta.tipo,
          fornecedor: meta.fornecedor || '',
          dataCell: meta.data || '',
        });
      });
    });
    // Ordena por createdAt desc (mais recente primeiro)
    flatComments.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  function updateCounts() {
    const ativos = flatComments.filter(c => !c.deleted).length;
    const excluidos = flatComments.filter(c => c.deleted).length;
    document.getElementById('count-ativos').textContent = ativos;
    document.getElementById('count-excluidos').textContent = excluidos;
  }

  function updateAuthorFilter() {
    const sel = document.getElementById('filter-autor');
    const current = sel.value;
    const authors = new Set();
    flatComments.forEach(c => { if (c.author) authors.add(c.author); });
    const sorted = [...authors].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    sel.innerHTML = '<option value="">Todos</option>' +
      sorted.map(a => `<option value="${F.escapeHTML(a)}">${F.escapeHTML(a)}</option>`).join('');
    if (current && sorted.includes(current)) sel.value = current;
  }

  function applyFilters(items) {
    let filtered = items;
    if (filters.tipo) filtered = filtered.filter(c => c.tipo === filters.tipo);
    if (filters.autor) filtered = filtered.filter(c => c.author === filters.autor);
    if (filters.busca) {
      const q = filters.busca.toUpperCase();
      filtered = filtered.filter(c => {
        const txt = String(c.text || '').toUpperCase();
        const forn = String(c.fornecedor || '').toUpperCase();
        const auth = String(c.author || '').toUpperCase();
        return txt.includes(q) || forn.includes(q) || auth.includes(q);
      });
    }
    if (filters.dataDe) filtered = filtered.filter(c => (c.dataCell || '') >= filters.dataDe);
    if (filters.dataAte) filtered = filtered.filter(c => (c.dataCell || '') <= filters.dataAte);
    return filtered;
  }

  function render() {
    const feed = document.getElementById('feed');
    // Filtra ativos/excluídos conforme tab
    const base = activeTab === 'excluidos'
      ? flatComments.filter(c => c.deleted)
      : flatComments.filter(c => !c.deleted);
    const filtered = applyFilters(base);

    if (!filtered.length) {
      const emptyMsg = activeTab === 'excluidos'
        ? (flatComments.filter(c => c.deleted).length === 0 ? 'Nenhum comentário excluído.' : 'Nenhum comentário com os filtros atuais.')
        : (flatComments.filter(c => !c.deleted).length === 0 ? 'Nenhum comentário ainda.' : 'Nenhum comentário com os filtros atuais.');
      feed.innerHTML = `
        <div class="empty-state-inline">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <div>${emptyMsg}</div>
        </div>
      `;
      return;
    }

    feed.innerHTML = filtered.map(c => renderCard(c)).join('');

    // Handlers
    feed.querySelectorAll('[data-goto-cell]').forEach(btn => {
      btn.addEventListener('click', () => gotoCell(btn.dataset.gotoCell));
    });
    feed.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', () => {
        const [cellKey, commentId] = btn.dataset.delete.split('::');
        if (confirm('Excluir este comentário?\n\nEle ficará disponível na aba "Excluídos" e pode ser restaurado.')) {
          deleteComment(cellKey, commentId);
        }
      });
    });
    feed.querySelectorAll('[data-restore]').forEach(btn => {
      btn.addEventListener('click', () => {
        const [cellKey, commentId] = btn.dataset.restore.split('::');
        restoreComment(cellKey, commentId);
      });
    });
    feed.querySelectorAll('[data-purge]').forEach(btn => {
      btn.addEventListener('click', () => {
        const [cellKey, commentId] = btn.dataset.purge.split('::');
        if (confirm('Excluir PERMANENTEMENTE este comentário?\n\nEsta ação não pode ser desfeita.')) {
          purgeComment(cellKey, commentId);
        }
      });
    });
  }

  function renderCard(c) {
    const isOwner = c.authorUid === F.state.user?.uid;
    const tipoLabel = c.tipo === 'pagar' ? 'A PAGAR' : c.tipo === 'receber' ? 'A RECEBER' : 'DESCONHECIDO';
    const tipoClass = c.tipo === 'pagar' ? 'pagar' : c.tipo === 'receber' ? 'receber' : '';
    const vendorChip = c.fornecedor ? `<span class="target-chip vendor">${F.escapeHTML(c.fornecedor)}</span>` : '';
    const dateChip = c.dataCell
      ? `<span class="target-chip">${F.escapeHTML(F.Fmt.fmtFullDate(F.Dates.parseDateKey(c.dataCell)))}</span>`
      : '';
    const time = c.createdAt ? F.Fmt.fmtRelativeTime(c.createdAt) : '—';
    const timeFull = c.createdAt ? new Date(c.createdAt).toLocaleString('pt-BR') : '';

    // Informações de exclusão (se for um card de excluído)
    let deletedInfo = '';
    let cardClass = 'comment-card';
    if (c.deleted) {
      cardClass += ' deleted';
      const deletedTime = c.deletedAt ? F.Fmt.fmtRelativeTime(c.deletedAt) : '—';
      const deletedFull = c.deletedAt ? new Date(c.deletedAt).toLocaleString('pt-BR') : '';
      deletedInfo = `
        <div class="deleted-info">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>
          Excluído por <strong>${F.escapeHTML(c.deletedByName || '—')}</strong> <span title="${F.escapeHTML(deletedFull)}">${deletedTime}</span>
        </div>
      `;
    }

    // Botões de ação dependem do contexto (ativo ou excluído)
    let actions;
    if (c.deleted) {
      // Card excluído: restaurar (qualquer) + apagar permanente (só autor)
      actions = `
        <div class="comment-actions">
          <button class="restore-btn" data-restore="${F.escapeHTML(c.cellKey)}::${F.escapeHTML(c.id)}" title="Restaurar comentário">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
            Restaurar
          </button>
          ${isOwner ? `
            <button class="danger" data-purge="${F.escapeHTML(c.cellKey)}::${F.escapeHTML(c.id)}" title="Excluir permanentemente">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
              Excluir permanentemente
            </button>
          ` : ''}
        </div>
      `;
    } else {
      // Card ativo: ir à célula + excluir (só autor)
      actions = `
        <div class="comment-actions">
          <button class="goto-btn" data-goto-cell="${F.escapeHTML(c.cellKey)}" title="Ir para a célula">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14L21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
            Ir à célula
          </button>
          ${isOwner ? `
            <button class="danger" data-delete="${F.escapeHTML(c.cellKey)}::${F.escapeHTML(c.id)}" title="Excluir">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>
              Excluir
            </button>
          ` : ''}
        </div>
      `;
    }

    return `
      <div class="${cardClass}">
        <div class="comment-header">
          <div>
            <div class="comment-meta">
              <span class="comment-author">${F.escapeHTML(c.author || '—')}</span>
              <span class="comment-time" title="${F.escapeHTML(timeFull)}">${time}</span>
            </div>
            <div class="comment-target">
              <span class="target-chip ${tipoClass}">${tipoLabel}</span>
              ${vendorChip}
              ${dateChip}
            </div>
          </div>
          ${actions}
        </div>
        <div class="comment-text">${F.escapeHTML(c.text || '')}</div>
        ${deletedInfo}
      </div>
    `;
  }

  /* ========== Navegação ========== */
  function gotoCell(cellKey) {
    const meta = parseCellKey(cellKey);
    const params = new URLSearchParams();
    params.set('detail', meta.tipo);
    params.set('date', meta.data || '');
    if (meta.fornecedor) params.set('vendor', meta.fornecedor);
    window.location.href = 'index.html?' + params.toString();
  }

  /* ========== Ações ========== */
  async function deleteComment(cellKey, commentId) {
    try {
      await F.DB.deleteComment(cellKey, commentId);
      F.UI.showToast('Comentário movido para excluídos', 'success');
    } catch (err) {
      console.error(err);
      F.UI.showToast('Erro: ' + err.message, 'error');
    }
  }

  async function restoreComment(cellKey, commentId) {
    try {
      await F.DB.restoreComment(cellKey, commentId);
      F.UI.showToast('Comentário restaurado', 'success');
    } catch (err) {
      console.error(err);
      F.UI.showToast('Erro: ' + err.message, 'error');
    }
  }

  async function purgeComment(cellKey, commentId) {
    try {
      await F.DB.purgeComment(cellKey, commentId);
      F.UI.showToast('Comentário excluído permanentemente', 'success');
    } catch (err) {
      console.error(err);
      F.UI.showToast('Erro: ' + err.message, 'error');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
