/* =======================================================================
   FILADÉLFIA — Página de Lançamentos (Entrega 3)

   Mostra:
   - Lançamentos manuais (tab principal)
   - Títulos importados ocultados (podem ser restaurados)
   - Meus lançamentos (só do usuário atual)

   Permite: editar, excluir (só autor), restaurar ocultados.
   ======================================================================= */

(function () {
  'use strict';
  const F = window.Filadelfia;

  let lancamentos = {};         // { id: { tipo, entidade, vencimento, valor, ... } }
  let ocultados = {};           // { titleId: { fornecedor/cliente, vencimento, valor, ... } }
  let dataStore = null;         // relatórios locais (para lookup de títulos ocultados)
  let activeTab = 'manuais';
  let sortState = { col: 'createdAt', dir: 'desc' };
  let filters = { tipo: '', autor: '', busca: '', dataDe: '', dataAte: '' };
  let editingId = null;

  async function init() {
    await F.Auth.requireAuth();
    F.UI.renderTopbar('lancamentos');

    if (!F.IS_FIREBASE_CONFIGURED) {
      document.getElementById('table-wrap').innerHTML =
        '<div class="empty-state-inline">Firebase não configurado.</div>';
      return;
    }

    dataStore = F.Storage.safeGetJSON(F.KEYS.DATA, null);

    F.DB.subscribeLancamentos(data => {
      lancamentos = data || {};
      updateCounts();
      updateAuthorFilter();
      render();
    });

    F.DB.subscribeHiddenTitles(data => {
      ocultados = data || {};
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

    // Modal de edição
    document.querySelectorAll('[data-close="edit"]').forEach(b => {
      b.addEventListener('click', () => document.getElementById('edit-modal').classList.remove('open'));
    });
    document.getElementById('edit-modal').addEventListener('click', (e) => {
      if (e.target.id === 'edit-modal') document.getElementById('edit-modal').classList.remove('open');
    });
    document.getElementById('btn-save-edit').addEventListener('click', saveEdit);
    document.getElementById('edit-tipo').addEventListener('change', (e) => {
      document.getElementById('edit-entity-label').textContent =
        e.target.value === 'pagar' ? 'Fornecedor' : 'Cliente / Descrição';
    });
  }

  function updateCounts() {
    document.getElementById('count-manuais').textContent = Object.keys(lancamentos).length;
    document.getElementById('count-ocultados').textContent = Object.keys(ocultados).length;
    const myUid = F.state.user?.uid;
    const mine = Object.values(lancamentos).filter(l => l.authorUid === myUid).length;
    document.getElementById('count-meus').textContent = mine;
  }

  function updateAuthorFilter() {
    const sel = document.getElementById('filter-autor');
    const current = sel.value;
    const authors = new Set();
    Object.values(lancamentos).forEach(l => {
      if (l.authorName) authors.add(l.authorName);
    });
    Object.values(ocultados).forEach(o => {
      if (o.deletedByName) authors.add(o.deletedByName);
    });
    const sorted = [...authors].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    sel.innerHTML = '<option value="">Todos</option>' +
      sorted.map(a => `<option value="${F.escapeHTML(a)}">${F.escapeHTML(a)}</option>`).join('');
    if (current && sorted.includes(current)) sel.value = current;
  }

  /* ========== Ordenação ========== */
  function toggleSort(col) {
    if (sortState.col === col) sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
    else { sortState.col = col; sortState.dir = col === 'valor' || col === 'createdAt' ? 'desc' : 'asc'; }
    render();
  }
  function sortIcon(col) {
    if (sortState.col !== col) return '<span style="opacity:0.3;">⇅</span>';
    return sortState.dir === 'asc' ? '<span style="color:var(--accent);">▲</span>' : '<span style="color:var(--accent);">▼</span>';
  }

  /* ========== Filtragem ========== */
  function applyFilters(rows, type) {
    let filtered = rows;

    if (filters.tipo) {
      filtered = filtered.filter(r => r.tipo === filters.tipo);
    }
    if (filters.autor) {
      filtered = filtered.filter(r => (r.authorName || r.deletedByName) === filters.autor);
    }
    if (filters.busca) {
      const q = filters.busca.toUpperCase();
      filtered = filtered.filter(r => {
        const entity = String(r.entidade || r.fornecedor || r.cliente || '').toUpperCase();
        const doc = String(r.documento || '').toUpperCase();
        const note = String(r.nota || '').toUpperCase();
        return entity.includes(q) || doc.includes(q) || note.includes(q);
      });
    }
    if (filters.dataDe) {
      filtered = filtered.filter(r => (r.vencimento || '') >= filters.dataDe);
    }
    if (filters.dataAte) {
      filtered = filtered.filter(r => (r.vencimento || '') <= filters.dataAte);
    }

    return filtered;
  }

  function sortRows(rows) {
    const sorted = [...rows];
    const c = sortState.col;
    const dir = sortState.dir === 'asc' ? 1 : -1;
    sorted.sort((a, b) => {
      let av, bv;
      if (c === 'createdAt') { av = a.createdAt || a.deletedAt || 0; bv = b.createdAt || b.deletedAt || 0; return (av - bv) * dir; }
      if (c === 'tipo') { av = a.tipo || ''; bv = b.tipo || ''; return av.localeCompare(bv) * dir; }
      if (c === 'entidade') {
        av = String(a.entidade || a.fornecedor || a.cliente || '');
        bv = String(b.entidade || b.fornecedor || b.cliente || '');
        return av.localeCompare(bv, 'pt-BR') * dir;
      }
      if (c === 'vencimento') { av = a.vencimento || ''; bv = b.vencimento || ''; return av.localeCompare(bv) * dir; }
      if (c === 'valor') { return ((a.valor || 0) - (b.valor || 0)) * dir; }
      if (c === 'autor') {
        av = a.authorName || a.deletedByName || '';
        bv = b.authorName || b.deletedByName || '';
        return av.localeCompare(bv, 'pt-BR') * dir;
      }
      return 0;
    });
    return sorted;
  }

  /* ========== Render ========== */
  function render() {
    if (activeTab === 'ocultados') renderOcultados();
    else if (activeTab === 'meus') renderManuais(true);
    else renderManuais(false);
  }

  function renderManuais(onlyMine) {
    const myUid = F.state.user?.uid;
    const items = Object.entries(lancamentos).map(([id, l]) => ({ ...l, id }));
    let filtered = onlyMine ? items.filter(l => l.authorUid === myUid) : items;
    filtered = applyFilters(filtered);
    filtered = sortRows(filtered);

    const wrap = document.getElementById('table-wrap');
    if (!filtered.length) {
      wrap.innerHTML = `
        <div class="empty-state-inline">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/><circle cx="12" cy="12" r="10"/></svg>
          <div>Nenhum lançamento ${onlyMine ? 'seu' : ''} encontrado com os filtros atuais.</div>
        </div>
      `;
      return;
    }

    const rows = filtered.map(l => {
      const isOwner = l.authorUid === myUid;
      const tipoLabel = l.tipo === 'pagar' ? 'Pagar' : 'Receber';
      const tipoClass = l.tipo === 'pagar' ? 'pagar' : 'receber';
      const venc = l.vencimento ? F.Fmt.fmtFullDate(F.Dates.parseDateKey(l.vencimento)) : '—';
      const createdAt = l.createdAt ? F.Fmt.fmtRelativeTime(l.createdAt) : '—';
      const createdTitle = l.createdAt ? F.escapeHTML(new Date(l.createdAt).toLocaleString('pt-BR')) : '';
      const note = l.nota ? `<div class="note">${F.escapeHTML(l.nota)}</div>` : '';
      const doc = l.documento ? `<span class="meta" style="margin-right:6px;">${F.escapeHTML(l.documento)}</span>` : '';

      const actions = isOwner
        ? `
          <button class="action-btn" data-edit="${F.escapeHTML(l.id)}" title="Editar">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            Editar
          </button>
          <button class="action-btn danger" data-delete="${F.escapeHTML(l.id)}" title="Excluir">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>
            Excluir
          </button>
        `
        : '<span class="meta" style="padding:4px 6px;">Só autor edita</span>';

      return `
        <tr>
          <td style="width:80px;"><span class="type-badge ${tipoClass}">${tipoLabel}</span></td>
          <td><span class="entity-nm">${F.escapeHTML(l.entidade || '')}</span>${note ? '' : ''}${doc}${note}</td>
          <td class="meta" style="white-space:nowrap;">${F.escapeHTML(venc)}</td>
          <td class="right"><strong>${F.Fmt.fmtMoney(l.valor || 0)}</strong></td>
          <td class="meta">${F.escapeHTML(l.authorName || '—')}</td>
          <td class="meta" title="${createdTitle}">${createdAt}</td>
          <td><div class="actions-cell">${actions}</div></td>
        </tr>
      `;
    }).join('');

    wrap.innerHTML = `
      <table class="data">
        <thead>
          <tr>
            <th class="sortable" data-sort="tipo">Tipo ${sortIcon('tipo')}</th>
            <th class="sortable" data-sort="entidade">Fornecedor / Cliente ${sortIcon('entidade')}</th>
            <th class="sortable" data-sort="vencimento">Vencimento ${sortIcon('vencimento')}</th>
            <th class="right sortable" data-sort="valor">Valor ${sortIcon('valor')}</th>
            <th class="sortable" data-sort="autor">Autor ${sortIcon('autor')}</th>
            <th class="sortable" data-sort="createdAt">Criado ${sortIcon('createdAt')}</th>
            <th class="right">Ações</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    wrap.querySelectorAll('[data-sort]').forEach(th => {
      th.addEventListener('click', () => toggleSort(th.dataset.sort));
    });
    wrap.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => openEdit(btn.dataset.edit));
    });
    wrap.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', () => deleteLancamento(btn.dataset.delete));
    });
  }

  function renderOcultados() {
    // Filtra
    const items = Object.entries(ocultados).map(([id, o]) => {
      const tipo = o._kind === 'receber' ? 'receber' : 'pagar';
      return {
        ...o,
        id,
        tipo,
        entidade: o.fornecedor || o.cliente || '',
        vencimento: o.vencimento,
      };
    });
    let filtered = applyFilters(items);
    filtered = sortRows(filtered);

    const wrap = document.getElementById('table-wrap');
    if (!filtered.length) {
      wrap.innerHTML = `
        <div class="empty-state-inline">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
          <div>Nenhum título foi ocultado.</div>
        </div>
      `;
      return;
    }

    const rows = filtered.map(o => {
      const tipoLabel = o.tipo === 'pagar' ? 'Pagar' : 'Receber';
      const tipoClass = o.tipo === 'pagar' ? 'pagar' : 'receber';
      const venc = o.vencimento ? F.Fmt.fmtFullDate(F.Dates.parseDateKey(o.vencimento)) : '—';
      const deletedAt = o.deletedAt ? F.Fmt.fmtRelativeTime(o.deletedAt) : '—';
      const deletedTitle = o.deletedAt ? F.escapeHTML(new Date(o.deletedAt).toLocaleString('pt-BR')) : '';
      const doc = o.documento ? `<span class="meta" style="margin-right:6px;">${F.escapeHTML(o.documento)}</span>` : '';

      return `
        <tr>
          <td style="width:80px;"><span class="type-badge ${tipoClass}">${tipoLabel}</span></td>
          <td><span class="entity-nm">${F.escapeHTML(o.entidade)}</span>${doc ? '<br>' + doc : ''}</td>
          <td class="meta" style="white-space:nowrap;">${F.escapeHTML(venc)}</td>
          <td class="right"><strong>${F.Fmt.fmtMoney(o.valor || 0)}</strong></td>
          <td class="meta">${F.escapeHTML(o.deletedByName || '—')}</td>
          <td class="meta" title="${deletedTitle}">${deletedAt}</td>
          <td>
            <div class="actions-cell">
              <button class="action-btn success" data-restore="${F.escapeHTML(o.id)}" title="Restaurar">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                Restaurar
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    wrap.innerHTML = `
      <table class="data">
        <thead>
          <tr>
            <th class="sortable" data-sort="tipo">Tipo ${sortIcon('tipo')}</th>
            <th class="sortable" data-sort="entidade">Fornecedor / Cliente ${sortIcon('entidade')}</th>
            <th class="sortable" data-sort="vencimento">Vencimento ${sortIcon('vencimento')}</th>
            <th class="right sortable" data-sort="valor">Valor ${sortIcon('valor')}</th>
            <th class="sortable" data-sort="autor">Ocultado por ${sortIcon('autor')}</th>
            <th class="sortable" data-sort="createdAt">Quando ${sortIcon('createdAt')}</th>
            <th class="right">Ações</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    wrap.querySelectorAll('[data-sort]').forEach(th => {
      th.addEventListener('click', () => toggleSort(th.dataset.sort));
    });
    wrap.querySelectorAll('[data-restore]').forEach(btn => {
      btn.addEventListener('click', () => restoreTitle(btn.dataset.restore));
    });
  }

  /* ========== Ações ========== */
  function openEdit(id) {
    const l = lancamentos[id];
    if (!l) return;
    if (l.authorUid !== F.state.user?.uid) {
      F.UI.showToast('Apenas o autor pode editar', 'error');
      return;
    }
    editingId = id;
    document.getElementById('edit-tipo').value = l.tipo || 'pagar';
    document.getElementById('edit-entity-label').textContent =
      l.tipo === 'pagar' ? 'Fornecedor' : 'Cliente / Descrição';
    document.getElementById('edit-entity').value = l.entidade || '';
    document.getElementById('edit-date').value = l.vencimento || '';
    document.getElementById('edit-value').value = l.valor || '';
    document.getElementById('edit-doc').value = l.documento || '';
    document.getElementById('edit-note').value = l.nota || '';
    document.getElementById('edit-modal').classList.add('open');
  }

  async function saveEdit() {
    if (!editingId) return;
    const tipo = document.getElementById('edit-tipo').value;
    const entidade = document.getElementById('edit-entity').value.trim().toUpperCase();
    const dateVal = document.getElementById('edit-date').value;
    const valor = parseFloat(document.getElementById('edit-value').value);
    const documento = document.getElementById('edit-doc').value.trim();
    const nota = document.getElementById('edit-note').value.trim();

    if (!entidade) { F.UI.showToast('Informe o fornecedor/cliente', 'error'); return; }
    if (!dateVal) { F.UI.showToast('Informe a data de vencimento', 'error'); return; }
    if (!valor || valor <= 0) { F.UI.showToast('Informe um valor positivo', 'error'); return; }
    if (entidade.length > 120) { F.UI.showToast('Nome muito longo', 'error'); return; }
    if (nota.length > 500) { F.UI.showToast('Observação muito longa', 'error'); return; }

    F.UI.showLoading('Salvando...');
    try {
      await F.DB.updateLancamento(editingId, { tipo, entidade, vencimento: dateVal, valor, documento, nota });
      document.getElementById('edit-modal').classList.remove('open');
      F.UI.showToast('Lançamento atualizado', 'success');
      editingId = null;
    } catch (err) {
      console.error(err);
      F.UI.showToast('Erro: ' + err.message, 'error');
    } finally {
      F.UI.hideLoading();
    }
  }

  async function deleteLancamento(id) {
    const l = lancamentos[id];
    if (!l) return;
    if (l.authorUid !== F.state.user?.uid) {
      F.UI.showToast('Apenas o autor pode excluir', 'error');
      return;
    }
    if (!confirm(`Excluir este lançamento manual de "${l.entidade}" (${F.Fmt.fmtMoney(l.valor || 0)})?\n\nA exclusão é sincronizada entre todos os usuários.`)) return;
    try {
      await F.DB.deleteLancamento(id);
      F.UI.showToast('Lançamento excluído', 'success');
    } catch (err) {
      console.error(err);
      F.UI.showToast('Erro: ' + err.message, 'error');
    }
  }

  async function restoreTitle(id) {
    if (!confirm('Restaurar este título? Ele voltará a aparecer no fluxo de caixa.')) return;
    try {
      await F.DB.restoreTitle(id);
      F.UI.showToast('Título restaurado', 'success');
    } catch (err) {
      console.error(err);
      F.UI.showToast('Erro: ' + err.message, 'error');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
