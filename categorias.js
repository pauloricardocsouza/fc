/* =======================================================================
   FILADELFIA — Página de Categorias (Entrega 2)

   Permite:
   - Criar, editar, excluir categorias (exceto a nativa "DEMAIS FORNECEDORES")
   - Atribuir fornecedores a categorias
   - Devolver fornecedores para o pool "Demais"
   - Lista todos os fornecedores extraídos dos dados importados + lançamentos manuais
   ======================================================================= */

(function () {
  'use strict';
  const F = window.Filadelfia;

  let categorias = {};            // { catId: { nome, cor, nativa, ... } }
  let fornecedorMap = {};         // { normalizedKey: { categoriaId, fornecedorNome, ... } }
  let allFornecedores = new Map(); // { nameUpper: { count, manual, real } } — derivado dos dados
  let selectedCatId = null;
  let selectedAssigned = new Set();
  let selectedPool = new Set();
  let assignedFilter = '';
  let poolFilter = '';

  async function init() {
    await F.Auth.requireAuth();
    F.UI.renderTopbar('categorias');

    if (!F.IS_FIREBASE_CONFIGURED) {
      document.querySelector('.main-layout').innerHTML =
        '<div style="padding:40px;text-align:center;grid-column:1/-1;">Firebase não está configurado. Esta página requer Firebase para funcionar.</div>';
      return;
    }

    // Carrega fornecedores dos dados locais importados + lançamentos manuais
    loadAllFornecedores();

    // Garante a categoria nativa
    try {
      await F.DB.ensureDefaultCategory();
    } catch (err) {
      console.warn('Erro ao criar categoria padrão:', err);
    }

    // Subscreve categorias e atribuições
    F.DB.subscribeCategorias(data => {
      categorias = data || {};
      renderCategoryList();
      if (selectedCatId && !categorias[selectedCatId]) {
        selectedCatId = null;
        renderDetail();
      } else if (selectedCatId) {
        renderDetail();
      }
    });

    F.DB.subscribeFornecedorCategoria(data => {
      fornecedorMap = data || {};
      // Recarrega lista de fornecedores para pegar novos que apareçam via lançamentos manuais
      loadAllFornecedores();
      if (selectedCatId) renderDetail();
      renderCategoryList(); // atualiza contadores
    });

    // Subscreve lançamentos para pegar fornecedores de lançamentos manuais em tempo real
    F.DB.subscribeLancamentos(data => {
      loadAllFornecedores(data);
      if (selectedCatId) renderDetail();
    });

    setupEvents();
  }

  function loadAllFornecedores(manualLancamentos) {
    const dataStore = F.Storage.safeGetJSON(F.KEYS.DATA, null);
    const names = new Map();

    // Importados
    (dataStore?.titulosPagar || []).forEach(t => {
      const nm = String(t.fornecedor || '').toUpperCase().trim();
      if (!nm) return;
      if (!names.has(nm)) names.set(nm, { count: 0, real: 0, manual: 0 });
      const info = names.get(nm);
      info.count++;
      info.real++;
    });

    // Lançamentos manuais
    const lancs = manualLancamentos || {};
    Object.values(lancs).forEach(p => {
      if (p.tipo !== 'pagar') return;
      const nm = String(p.entidade || '').toUpperCase().trim();
      if (!nm) return;
      if (!names.has(nm)) names.set(nm, { count: 0, real: 0, manual: 0 });
      const info = names.get(nm);
      info.count++;
      info.manual++;
    });

    allFornecedores = names;
  }

  /* ========== Render lista de categorias ========== */
  function renderCategoryList() {
    const listEl = document.getElementById('cat-list');
    const entries = Object.entries(categorias);

    // Conta fornecedores por categoria (nativas recebem os não-atribuídos)
    const countsByCategory = {};
    const nativeId = Object.entries(categorias).find(([id, c]) => c?.nativa)?.[0];

    // Fornecedores atribuídos
    Object.values(fornecedorMap).forEach(fc => {
      const cid = fc.categoriaId;
      countsByCategory[cid] = (countsByCategory[cid] || 0) + 1;
    });

    // Fornecedores NÃO atribuídos vão automaticamente para a categoria nativa (para exibição)
    if (nativeId) {
      const totalFornecedores = allFornecedores.size;
      const totalAssigned = Object.keys(fornecedorMap).length;
      const naoAtribuidos = Math.max(0, totalFornecedores - totalAssigned);
      countsByCategory[nativeId] = (countsByCategory[nativeId] || 0) + naoAtribuidos;
    }

    document.getElementById('cat-total-count').textContent = entries.length;

    if (!entries.length) {
      listEl.innerHTML = '<div class="empty-msg">Carregando categorias...</div>';
      return;
    }

    // Ordena: nativa primeiro, depois alfabética
    entries.sort(([, a], [, b]) => {
      if (a.nativa && !b.nativa) return -1;
      if (!a.nativa && b.nativa) return 1;
      return (a.nome || '').localeCompare(b.nome || '', 'pt-BR');
    });

    listEl.innerHTML = entries.map(([id, cat]) => {
      const count = countsByCategory[id] || 0;
      const nativa = cat.nativa ? '<span class="native-badge">NATIVA</span>' : '';
      const actions = cat.nativa
        ? ''
        : `<div class="cat-actions">
            <button data-edit-cat="${F.escapeHTML(id)}" title="Renomear">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            </button>
            <button class="danger" data-delete-cat="${F.escapeHTML(id)}" title="Excluir">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>
            </button>
          </div>`;

      return `
        <div class="cat-item ${id === selectedCatId ? 'active' : ''}" data-cat-id="${F.escapeHTML(id)}">
          <div class="cat-color-dot" style="background:${F.escapeHTML(cat.cor || '#6b7280')}"></div>
          <div class="cat-info">
            <div class="cat-name">${F.escapeHTML(cat.nome || '')}${nativa}</div>
            <div class="cat-count">${count} fornecedor${count !== 1 ? 'es' : ''}</div>
          </div>
          ${actions}
        </div>
      `;
    }).join('');

    // Handlers
    listEl.querySelectorAll('.cat-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        selectCategory(el.dataset.catId);
      });
    });
    listEl.querySelectorAll('[data-edit-cat]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        editCategory(btn.dataset.editCat);
      });
    });
    listEl.querySelectorAll('[data-delete-cat]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteCategory(btn.dataset.deleteCat);
      });
    });
  }

  function selectCategory(id) {
    selectedCatId = id;
    selectedAssigned.clear();
    selectedPool.clear();
    assignedFilter = '';
    poolFilter = '';
    const as = document.getElementById('assigned-search');
    const ps = document.getElementById('pool-search');
    if (as) as.value = '';
    if (ps) ps.value = '';
    renderCategoryList();
    renderDetail();
  }

  /* ========== Render detalhe (direita) ========== */
  function renderDetail() {
    if (!selectedCatId || !categorias[selectedCatId]) {
      document.getElementById('detail-empty').classList.remove('hidden');
      document.getElementById('detail-body').classList.add('hidden');
      document.getElementById('detail-cat-title').textContent = 'Selecione uma categoria';
      document.getElementById('detail-cat-sub').textContent = '—';
      return;
    }

    document.getElementById('detail-empty').classList.add('hidden');
    document.getElementById('detail-body').classList.remove('hidden');

    const cat = categorias[selectedCatId];
    document.getElementById('detail-cat-title').innerHTML = `
      <span class="cat-color-dot" style="display:inline-block;width:12px;height:12px;background:${F.escapeHTML(cat.cor || '#6b7280')};border-radius:50%;border:1px solid rgba(0,0,0,0.2);vertical-align:middle;"></span>
      <span style="vertical-align:middle;">${F.escapeHTML(cat.nome)}</span>
    `;
    document.getElementById('detail-cat-sub').textContent = cat.nativa
      ? 'Categoria nativa (padrão para fornecedores não atribuídos)'
      : (cat.createdByName ? `Criada por ${cat.createdByName}` : '—');

    // Ajustes de títulos quando é a categoria nativa
    document.getElementById('assigned-title').textContent = cat.nativa
      ? 'Fornecedores nesta categoria'
      : 'Fornecedores nesta categoria';
    document.getElementById('pool-title').textContent = 'Fornecedores disponíveis (Demais)';

    renderAssignedList();
    renderPoolList();
  }

  function renderAssignedList() {
    const listEl = document.getElementById('assigned-list');
    const cat = categorias[selectedCatId];
    const isNative = cat?.nativa;

    // Lista de nomes atribuídos a essa categoria
    let assignedNames;
    if (isNative) {
      // Nativa: quem NÃO está atribuído em nenhuma categoria + quem foi atribuído a ela explicitamente
      const explicitlyAssigned = new Set(
        Object.entries(fornecedorMap).filter(([, fc]) => fc.categoriaId === selectedCatId).map(([, fc]) => String(fc.fornecedorNome || '').toUpperCase())
      );
      const anyAssigned = new Set(Object.values(fornecedorMap).map(fc => String(fc.fornecedorNome || '').toUpperCase()));
      assignedNames = [...allFornecedores.keys()].filter(nm => !anyAssigned.has(nm) || explicitlyAssigned.has(nm));
    } else {
      assignedNames = Object.values(fornecedorMap)
        .filter(fc => fc.categoriaId === selectedCatId)
        .map(fc => String(fc.fornecedorNome || '').toUpperCase())
        .filter(nm => nm);
    }

    // Ordena alfabética
    assignedNames.sort((a, b) => a.localeCompare(b, 'pt-BR'));

    // Filtro
    const filtered = assignedFilter
      ? assignedNames.filter(nm => nm.includes(assignedFilter.toUpperCase()))
      : assignedNames;

    document.getElementById('assigned-count').textContent = `${filtered.length}${assignedFilter ? ` de ${assignedNames.length}` : ''}`;

    if (!filtered.length) {
      listEl.innerHTML = `<div class="empty-msg">${assignedFilter ? 'Nenhum fornecedor encontrado com esse filtro.' : 'Nenhum fornecedor atribuído. Use a lista ao lado para adicionar.'}</div>`;
      updateActionButtons();
      return;
    }

    listEl.innerHTML = filtered.map(nm => {
      const info = allFornecedores.get(nm) || { count: 0 };
      const selected = selectedAssigned.has(nm) ? 'selected' : '';
      return `
        <div class="fornecedor-item ${selected}" data-forn-assigned="${F.escapeHTML(nm)}">
          <span class="fornecedor-name" title="${F.escapeHTML(nm)}">${F.escapeHTML(nm)}</span>
          <span class="fornecedor-count">${info.count} tit.</span>
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('[data-forn-assigned]').forEach(el => {
      el.addEventListener('click', () => {
        const nm = el.dataset.fornAssigned;
        if (selectedAssigned.has(nm)) selectedAssigned.delete(nm);
        else selectedAssigned.add(nm);
        el.classList.toggle('selected');
        updateActionButtons();
      });
    });

    updateActionButtons();
  }

  function renderPoolList() {
    const listEl = document.getElementById('pool-list');
    // Pool = fornecedores que estão em OUTRAS categorias (não na selecionada) ou não-atribuídos mas visíveis na nativa
    const cat = categorias[selectedCatId];
    const isNative = cat?.nativa;

    // Quem não está atribuído à categoria atual
    const assignedToThisCat = new Set(
      Object.entries(fornecedorMap)
        .filter(([, fc]) => fc.categoriaId === selectedCatId)
        .map(([, fc]) => String(fc.fornecedorNome || '').toUpperCase())
    );

    let poolNames;
    if (isNative) {
      // Nativa: pool é quem está atribuído a OUTRAS categorias
      poolNames = Object.values(fornecedorMap)
        .map(fc => String(fc.fornecedorNome || '').toUpperCase())
        .filter(nm => nm && !assignedToThisCat.has(nm));
    } else {
      // Não-nativa: pool é todos os fornecedores não atribuídos a essa categoria
      poolNames = [...allFornecedores.keys()].filter(nm => !assignedToThisCat.has(nm));
    }

    // Remove duplicatas
    poolNames = [...new Set(poolNames)];
    poolNames.sort((a, b) => a.localeCompare(b, 'pt-BR'));

    const filtered = poolFilter
      ? poolNames.filter(nm => nm.includes(poolFilter.toUpperCase()))
      : poolNames;

    document.getElementById('pool-count').textContent = `${filtered.length}${poolFilter ? ` de ${poolNames.length}` : ''}`;

    if (!filtered.length) {
      listEl.innerHTML = `<div class="empty-msg">${poolFilter ? 'Nenhum fornecedor encontrado.' : 'Todos os fornecedores já estão atribuídos a esta categoria.'}</div>`;
      updateActionButtons();
      return;
    }

    listEl.innerHTML = filtered.map(nm => {
      const info = allFornecedores.get(nm) || { count: 0 };
      const selected = selectedPool.has(nm) ? 'selected' : '';
      // Mostra a categoria atual (se existir) do fornecedor
      const currentCatInfo = Object.values(fornecedorMap).find(fc => String(fc.fornecedorNome || '').toUpperCase() === nm);
      const currentCatName = currentCatInfo ? (categorias[currentCatInfo.categoriaId]?.nome || '') : '';
      const catLabel = currentCatName ? `<span class="fornecedor-count" title="Categoria atual">${F.escapeHTML(currentCatName.length > 18 ? currentCatName.slice(0, 18) + '…' : currentCatName)}</span>` : `<span class="fornecedor-count">${info.count} tit.</span>`;
      return `
        <div class="fornecedor-item ${selected}" data-forn-pool="${F.escapeHTML(nm)}">
          <span class="fornecedor-name" title="${F.escapeHTML(nm)}">${F.escapeHTML(nm)}</span>
          ${catLabel}
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('[data-forn-pool]').forEach(el => {
      el.addEventListener('click', () => {
        const nm = el.dataset.fornPool;
        if (selectedPool.has(nm)) selectedPool.delete(nm);
        else selectedPool.add(nm);
        el.classList.toggle('selected');
        updateActionButtons();
      });
    });

    updateActionButtons();
  }

  function updateActionButtons() {
    document.getElementById('btn-remove-selected').disabled = selectedAssigned.size === 0;
    document.getElementById('btn-add-selected').disabled = selectedPool.size === 0;
    document.getElementById('btn-remove-selected').innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
      Devolver ${selectedAssigned.size > 0 ? `(${selectedAssigned.size})` : 'selecionados'}
    `;
    document.getElementById('btn-add-selected').innerHTML = `
      Atribuir ${selectedPool.size > 0 ? `(${selectedPool.size})` : 'selecionados'}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    `;
  }

  /* ========== Ações ========== */
  function setupEvents() {
    document.getElementById('btn-new-cat').addEventListener('click', createNewCategory);
    document.getElementById('new-cat-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') createNewCategory();
    });

    document.getElementById('assigned-search').addEventListener('input', (e) => {
      assignedFilter = e.target.value.trim();
      renderAssignedList();
    });
    document.getElementById('pool-search').addEventListener('input', (e) => {
      poolFilter = e.target.value.trim();
      renderPoolList();
    });

    document.getElementById('btn-add-selected').addEventListener('click', assignSelectedToCategory);
    document.getElementById('btn-remove-selected').addEventListener('click', removeSelectedFromCategory);
  }

  async function createNewCategory() {
    const nameInput = document.getElementById('new-cat-name');
    const colorInput = document.getElementById('new-cat-color');
    const name = nameInput.value.trim();
    const color = colorInput.value;

    if (!name) { F.UI.showToast('Informe o nome da categoria', 'error'); return; }
    if (name.length < 2) { F.UI.showToast('Nome muito curto', 'error'); return; }
    if (name.length > 60) { F.UI.showToast('Nome muito longo (máx 60)', 'error'); return; }

    // Verifica duplicata
    const nameUpper = name.toUpperCase();
    const duplicate = Object.values(categorias).some(c => (c.nome || '').toUpperCase() === nameUpper);
    if (duplicate) { F.UI.showToast('Já existe uma categoria com esse nome', 'error'); return; }

    try {
      const id = await F.DB.createCategoria(name, color);
      nameInput.value = '';
      F.UI.showToast('Categoria criada', 'success');
      selectCategory(id);
    } catch (err) {
      console.error(err);
      F.UI.showToast('Erro ao criar: ' + err.message, 'error');
    }
  }

  async function editCategory(id) {
    const cat = categorias[id];
    if (!cat || cat.nativa) return;
    const newName = prompt('Novo nome da categoria:', cat.nome);
    if (!newName || !newName.trim()) return;
    const trimmed = newName.trim();
    if (trimmed.length < 2 || trimmed.length > 60) {
      F.UI.showToast('Nome deve ter entre 2 e 60 caracteres', 'error');
      return;
    }
    const upper = trimmed.toUpperCase();
    const duplicate = Object.entries(categorias).some(([cid, c]) =>
      cid !== id && (c.nome || '').toUpperCase() === upper
    );
    if (duplicate) { F.UI.showToast('Já existe uma categoria com esse nome', 'error'); return; }

    try {
      await F.DB.updateCategoria(id, { nome: trimmed });
      F.UI.showToast('Categoria renomeada', 'success');
    } catch (err) {
      console.error(err);
      F.UI.showToast('Erro: ' + err.message, 'error');
    }
  }

  async function deleteCategory(id) {
    const cat = categorias[id];
    if (!cat || cat.nativa) return;

    // Conta fornecedores atribuídos
    const assigned = Object.values(fornecedorMap).filter(fc => fc.categoriaId === id).length;
    const msg = assigned > 0
      ? `Excluir a categoria "${cat.nome}"?\n\n${assigned} fornecedor(es) serão devolvidos para "Demais Fornecedores".`
      : `Excluir a categoria "${cat.nome}"?`;
    if (!confirm(msg)) return;

    F.UI.showLoading('Excluindo...');
    try {
      // Remove atribuições
      const toRemove = Object.entries(fornecedorMap).filter(([, fc]) => fc.categoriaId === id);
      for (const [key] of toRemove) {
        await F.DB.dbRef(`fornecedor_categoria/${key}`).remove();
      }
      await F.DB.deleteCategoria(id);
      if (selectedCatId === id) selectedCatId = null;
      F.UI.showToast('Categoria excluída', 'success');
    } catch (err) {
      console.error(err);
      F.UI.showToast('Erro: ' + err.message, 'error');
    } finally {
      F.UI.hideLoading();
    }
  }

  async function assignSelectedToCategory() {
    if (!selectedCatId || selectedPool.size === 0) return;
    const cat = categorias[selectedCatId];
    if (!cat) return;

    F.UI.showLoading(`Atribuindo ${selectedPool.size} fornecedor(es)...`);
    try {
      const names = [...selectedPool];
      // Se a categoria é nativa, atribuir explicitamente
      // Se não é nativa, basta setar para essa categoria
      await Promise.all(names.map(nm => F.DB.setFornecedorCategoria(nm, selectedCatId)));
      selectedPool.clear();
      F.UI.showToast(`${names.length} fornecedor(es) atribuídos a "${cat.nome}"`, 'success');
    } catch (err) {
      console.error(err);
      F.UI.showToast('Erro: ' + err.message, 'error');
    } finally {
      F.UI.hideLoading();
    }
  }

  async function removeSelectedFromCategory() {
    if (!selectedCatId || selectedAssigned.size === 0) return;
    const cat = categorias[selectedCatId];
    if (!cat) return;

    F.UI.showLoading(`Devolvendo ${selectedAssigned.size} fornecedor(es)...`);
    try {
      const names = [...selectedAssigned];
      // Remove a atribuição (volta para o pool "Demais")
      await Promise.all(names.map(nm => F.DB.setFornecedorCategoria(nm, null)));
      selectedAssigned.clear();
      F.UI.showToast(`${names.length} fornecedor(es) devolvidos`, 'success');
    } catch (err) {
      console.error(err);
      F.UI.showToast('Erro: ' + err.message, 'error');
    } finally {
      F.UI.hideLoading();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
