/* =======================================================================
   FILADELFIA — Fluxo de Caixa (JS) v2

   Mudanças nesta versão:
   - Lançamentos manuais, lixeira e títulos ocultados agora sincronizam via Firebase
   - Nomes de fornecedores/clientes normalizados em CAIXA ALTA
   - Removida linha "Saldo acumulado"
   - Alerta de confirmação para lançamentos com valor > 10x o maior título importado
   - Ordenação clicável nas colunas (nome e cada data)
   - Modal de detalhes ampliado com ordenação e exportação própria (XLSX/PDF/PNG)
   ======================================================================= */

(function () {
  'use strict';
  const F = window.Filadelfia;

  /* ========== Estado ========== */
  let dataStore = null;
  let provisions = {};
  let deletedImported = {};
  let processed = null;
  let filteredDates = [];
  let viewMode = 'effective';
  let commentsCache = {};
  let currentDetail = null;
  let unsubscribes = [];

  let sortState = { col: 'total', dir: 'desc' };
  let detailSortState = { col: null, dir: 'asc' };
  let detailCurrentRows = [];

  // v2 — categorias e hierarquia
  let categorias = {};           // { catId: { nome, cor, nativa, ... } }
  let fornecedorMap = {};        // { normKey: { categoriaId, fornecedorNome } }
  let expandedCategories = new Set(); // categoria expandida
  let expandedReceber = false;   // total a receber expandido (só com manuais)
  let expandedPagarTotal = false; // total a pagar expandido em categorias

  /* ========== Carga ========== */
  function loadLocalData() {
    dataStore = F.Storage.safeGetJSON(F.KEYS.DATA, null);
    return !!dataStore;
  }

  /* ========== Subscrição Firebase ========== */
  function subscribeAll() {
    unsubscribes.forEach(u => { try { u(); } catch {} });
    unsubscribes = [];
    if (!F.DB.dbReady()) return;

    // OTIMIZAÇÃO: escutamos apenas os metadados (poucos KB) para detectar
    // quando há versão mais nova. Só baixamos o payload completo quando
    // realmente preciso.
    unsubscribes.push(F.DB.subscribeImportedDataMeta(async meta => {
      if (!meta || !meta.processedAt) return;
      const localAt = dataStore?.processedAt;
      const isNewer = !localAt || new Date(meta.processedAt) > new Date(localAt);
      if (!isNewer) return;
      // Baixa payload completo (pode demorar com muitos títulos, mas só roda quando necessário)
      try {
        const data = await F.DB.fetchImportedData();
        if (!data) return;
        dataStore = data;
        F.Storage.safeSetJSON(F.KEYS.DATA, data);
        if (processed) {
          rebuildAndRender();
        } else {
          finishInit();
        }
      } catch (err) {
        console.error('Falha ao baixar dados importados:', err);
      }
    }));

    unsubscribes.push(F.DB.subscribeLancamentos(data => {
      provisions = data || {};
      if (processed) rebuildAndRender();
    }));
    unsubscribes.push(F.DB.subscribeHiddenTitles(data => {
      deletedImported = data || {};
      if (processed) rebuildAndRender();
    }));

    // v2 — categorias e atribuições
    unsubscribes.push(F.DB.subscribeCategorias(data => {
      categorias = data || {};
      if (processed) render();
    }));
    unsubscribes.push(F.DB.subscribeFornecedorCategoria(data => {
      fornecedorMap = data || {};
      if (processed) render();
    }));

    // Garante que a categoria nativa existe
    F.DB.ensureDefaultCategory().catch(err => console.warn('Categoria padrão:', err));

    F.state.fbDB.ref('filadelfia/comentarios').on('value', snap => {
      commentsCache = snap.val() || {};
      if (processed) render();
      if (currentDetail) refreshDetailComments();
    }, err => {
      console.error('Firebase comments error:', err);
      F.UI.updateSyncBadge('offline', 'Erro de conexão');
    });
  }

  /* ========== Índice ========== */
  function buildIndex() {
    const titulosPagar = [];
    const titulosReceber = [];

    (dataStore?.titulosPagar || []).forEach(t => {
      if (!deletedImported[t.id]) {
        titulosPagar.push({ ...t, fornecedor: (t.fornecedor || '').toUpperCase(), _manual: false });
      }
    });
    (dataStore?.titulosReceber || []).forEach(t => {
      if (!deletedImported[t.id]) {
        titulosReceber.push({ ...t, cliente: (t.cliente || '').toUpperCase(), _manual: false });
      }
    });

    Object.entries(provisions).forEach(([id, p]) => {
      const tit = {
        id,
        documento: p.documento || '',
        vencimento: p.vencimento,
        valor: p.valor,
        _manual: true,
        _author: p.authorName,
        _authorUid: p.authorUid,
        _note: p.nota,
        _createdAt: p.createdAt,
      };
      if (p.tipo === 'pagar') {
        tit.fornecedor = (p.entidade || '').toUpperCase();
        titulosPagar.push(tit);
      } else {
        tit.cliente = (p.entidade || '').toUpperCase();
        titulosReceber.push(tit);
      }
    });

    const vendorMap = new Map();
    const dateSet = new Set();

    titulosPagar.forEach(t => {
      const due = F.Dates.parseDateKey(t.vencimento);
      const eff = F.Dates.effectiveDatePagar(due);
      const useDate = viewMode === 'effective' ? eff : due;
      const k = F.Dates.dateKey(useDate);
      dateSet.add(k);
      if (!vendorMap.has(t.fornecedor)) {
        vendorMap.set(t.fornecedor, { hasReal: false, hasManual: false, byDate: new Map() });
      }
      const entry = vendorMap.get(t.fornecedor);
      if (t._manual) entry.hasManual = true; else entry.hasReal = true;
      if (!entry.byDate.has(k)) entry.byDate.set(k, { total: 0, titulos: [], hasManual: false });
      const bucket = entry.byDate.get(k);
      bucket.total += t.valor;
      if (t._manual) bucket.hasManual = true;
      bucket.titulos.push({ ...t, vencimentoDate: t.vencimento, efetivaDate: F.Dates.dateKey(eff) });
    });

    const receberByDate = new Map();
    titulosReceber.forEach(t => {
      const due = F.Dates.parseDateKey(t.vencimento);
      const eff = F.Dates.effectiveDateReceber(due);
      const useDate = viewMode === 'effective' ? eff : due;
      const k = F.Dates.dateKey(useDate);
      dateSet.add(k);
      if (!receberByDate.has(k)) receberByDate.set(k, { total: 0, titulos: [], hasManual: false });
      const bucket = receberByDate.get(k);
      bucket.total += t.valor;
      if (t._manual) bucket.hasManual = true;
      bucket.titulos.push({ ...t, vencimentoDate: t.vencimento, efetivaDate: F.Dates.dateKey(eff) });
    });

    const allDates = [...dateSet].sort();
    const vendors = [...vendorMap.entries()].map(([name, entry]) => {
      let total = 0;
      entry.byDate.forEach(b => total += b.total);
      return { name, total, byDate: entry.byDate, hasManual: entry.hasManual, hasReal: entry.hasReal };
    });

    let maxImportValue = 0;
    (dataStore?.titulosPagar || []).forEach(t => { if (t.valor > maxImportValue) maxImportValue = t.valor; });
    (dataStore?.titulosReceber || []).forEach(t => { if (t.valor > maxImportValue) maxImportValue = t.valor; });

    processed = { allDates, vendors, receberByDate, maxImportValue };
  }

  /* ========== Ordenação ========== */
  function sortVendors(vendors, sState) {
    const sorted = [...vendors];
    if (sState.col === 'name') {
      sorted.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
      if (sState.dir === 'desc') sorted.reverse();
    } else if (sState.col === 'total') {
      sorted.sort((a, b) => sState.dir === 'asc' ? a.total - b.total : b.total - a.total);
    } else {
      const k = sState.col;
      sorted.sort((a, b) => {
        const va = a.byDate.get(k)?.total || 0;
        const vb = b.byDate.get(k)?.total || 0;
        return sState.dir === 'asc' ? va - vb : vb - va;
      });
    }
    return sorted;
  }

  /* ========== Comentários - keys ========== */
  function commentKeyFor(kind, dateK, vendor) {
    const safe = s => String(s == null ? '' : s).replace(/[.#$/\[\]]/g, '_');
    if (kind === 'receber') return `receber__${dateK}`;
    return `pagar__${safe(vendor)}__${dateK}`;
  }
  function getCommentsForCell(kind, dateK, vendor) {
    const all = commentsCache[commentKeyFor(kind, dateK, vendor)] || {};
    // Filtra os soft-deleted
    const filtered = {};
    Object.entries(all).forEach(([id, c]) => {
      if (c && !c.deleted) filtered[id] = c;
    });
    return filtered;
  }
  function hasCommentsForCell(kind, dateK, vendor) {
    return Object.keys(getCommentsForCell(kind, dateK, vendor)).length > 0;
  }

  /* ========== Init ========== */
  async function init() {
    await F.Auth.requireAuth();
    F.UI.renderTopbar('fluxo');

    if (F.IS_FIREBASE_CONFIGURED) subscribeAll();

    loadLocalData();
    const hasAnyData = dataStore && ((dataStore.titulosPagar || []).length + (dataStore.titulosReceber || []).length > 0);

    // Se já temos dados locais, renderiza IMEDIATAMENTE e deixa o Firebase
    // sincronizar em segundo plano se houver versão mais nova
    if (hasAnyData || Object.keys(provisions).length > 0) {
      finishInit();
      return;
    }

    // Sem dados locais: aguardar brevemente o Firebase responder com metadados
    // (leve, poucos KB) antes de mostrar tela vazia
    if (!F.IS_FIREBASE_CONFIGURED) { showEmpty(); return; }
    setTimeout(() => {
      if (processed) return; // Firebase já disparou finishInit
      const hasDataNow = dataStore && ((dataStore.titulosPagar || []).length + (dataStore.titulosReceber || []).length > 0);
      if (hasDataNow || Object.keys(provisions).length > 0) finishInit();
      else showEmpty();
    }, 600);
  }

  let _initDone = false;
  function finishInit() {
    if (!dataStore) dataStore = { titulosPagar: [], titulosReceber: [], processedAt: new Date().toISOString() };
    buildIndex();
    if (!processed.allDates.length) { showEmpty(); return; }
    document.getElementById('empty-state').classList.add('hidden');
    document.getElementById('main-content').classList.remove('hidden');
    if (!_initDone) {
      setupControls();
      _initDone = true;
    }
    updateHeaderInfo();
    render();

    // Se veio da página de comentários com query params, abre o detalhe
    checkUrlParams();
  }

  function checkUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const detail = params.get('detail');
    const date = params.get('date');
    const vendor = params.get('vendor');
    if (!detail || !date) return;

    // Ajusta filtro para garantir que a data está visível
    if (!processed.allDates.includes(date)) {
      F.UI.showToast('A data do comentário está fora do período importado', 'error');
      return;
    }
    const startInput = document.getElementById('filter-start');
    const endInput = document.getElementById('filter-end');
    if (date < startInput.value) startInput.value = date;
    if (date > endInput.value) endInput.value = date;
    render();

    // Abre o detalhe
    setTimeout(() => {
      try {
        const vendorUpper = vendor ? vendor.toUpperCase() : null;
        if (detail === 'pagar' && vendorUpper) {
          // Verifica se o fornecedor existe com esse nome normalizado
          const exists = processed.vendors.some(v => v.name === vendorUpper || v.name.replace(/_/g, ' ') === vendorUpper);
          if (exists) {
            const realName = processed.vendors.find(v => v.name === vendorUpper || v.name.replace(/_/g, ' ') === vendorUpper)?.name;
            openDetail('pagar', date, realName);
          } else {
            F.UI.showToast('Fornecedor não encontrado no período atual', 'error');
          }
        } else if (detail === 'receber') {
          openDetail('receber', date, null);
        }
        // Limpa os query params da URL (sem recarregar)
        history.replaceState({}, document.title, window.location.pathname);
      } catch (e) {
        console.warn('Erro ao abrir detalhe:', e);
      }
    }, 200);
  }

  function showEmpty() {
    document.getElementById('empty-state').classList.remove('hidden');
    document.getElementById('main-content').classList.add('hidden');
    document.getElementById('btn-add-empty')?.addEventListener('click', () => openForm());
  }

  function updateHeaderInfo() {
    const el = document.getElementById('meta-info');
    if (!el || !dataStore) return;
    const importedAt = dataStore.processedAt ? F.Fmt.fmtDateTimeFull(new Date(dataStore.processedAt)) : '—';
    let periodText = '';
    if (dataStore.periodStart && dataStore.periodEnd) {
      const d0 = F.Dates.parseDateKey(dataStore.periodStart);
      const d1 = F.Dates.parseDateKey(dataStore.periodEnd);
      periodText = `${F.Fmt.fmtFullDate(d0)} a ${F.Fmt.fmtFullDate(d1)}`;
    } else if (processed.allDates.length) {
      periodText = `${F.Fmt.fmtFullDate(F.Dates.parseDateKey(processed.allDates[0]))} a ${F.Fmt.fmtFullDate(F.Dates.parseDateKey(processed.allDates[processed.allDates.length - 1]))}`;
    }
    el.innerHTML = `
      <span class="meta-chip"><span class="meta-label">Últ. importação:</span> <strong>${F.escapeHTML(importedAt)}</strong></span>
      <span class="meta-chip"><span class="meta-label">Período importado:</span> <strong>${F.escapeHTML(periodText)}</strong></span>
    `;
  }

  function setupControls() {
    const startInput = document.getElementById('filter-start');
    const endInput = document.getElementById('filter-end');
    startInput.value = processed.allDates[0];
    endInput.value = processed.allDates[processed.allDates.length - 1];
    startInput.addEventListener('change', render);
    endInput.addEventListener('change', render);

    document.getElementById('btn-reset').addEventListener('click', () => {
      startInput.value = processed.allDates[0];
      endInput.value = processed.allDates[processed.allDates.length - 1];
      render();
    });

    document.getElementById('view-effective').addEventListener('click', () => setViewMode('effective'));
    document.getElementById('view-due').addEventListener('click', () => setViewMode('due'));
    document.getElementById('btn-add').addEventListener('click', () => openForm());

    const exportBtn = document.getElementById('btn-export-toggle');
    const exportMenu = document.getElementById('export-menu');
    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      exportMenu.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (!exportMenu.contains(e.target) && e.target !== exportBtn) {
        exportMenu.classList.remove('open');
      }
    });
    exportMenu.querySelectorAll('button[data-export]').forEach(btn => {
      btn.addEventListener('click', () => {
        exportMenu.classList.remove('open');
        runExport(btn.dataset.export);
      });
    });

    document.getElementById('form-type-toggle').querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        document.getElementById('form-type-toggle').querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('form-entity-label').textContent =
          btn.dataset.type === 'pagar' ? 'Fornecedor' : 'Cliente / Descrição';
      });
    });
    document.getElementById('btn-save').addEventListener('click', saveProvision);
    document.getElementById('btn-add-comment').addEventListener('click', addComment);

    document.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.getElementById(btn.dataset.close + '-modal').classList.remove('open');
      });
    });
    ['detail', 'form'].forEach(id => {
      document.getElementById(id + '-modal').addEventListener('click', (e) => {
        if (e.target.id === id + '-modal') document.getElementById(id + '-modal').classList.remove('open');
      });
    });

    document.getElementById('detail-export-xlsx').addEventListener('click', () => exportDetail('xlsx'));
    document.getElementById('detail-export-pdf').addEventListener('click', () => exportDetail('pdf'));
    document.getElementById('detail-export-png').addEventListener('click', () => exportDetail('png'));
  }

  function setViewMode(mode) {
    viewMode = mode;
    document.getElementById('view-effective').classList.toggle('active', mode === 'effective');
    document.getElementById('view-due').classList.toggle('active', mode === 'due');
    buildIndex();
    const s = document.getElementById('filter-start').value;
    const e = document.getElementById('filter-end').value;
    if (!processed.allDates.includes(s)) document.getElementById('filter-start').value = processed.allDates[0];
    if (!processed.allDates.includes(e)) document.getElementById('filter-end').value = processed.allDates[processed.allDates.length - 1];
    render();
  }

  /* ========== Render ========== */
  function render() {
    const s = document.getElementById('filter-start').value;
    const e = document.getElementById('filter-end').value;
    filteredDates = processed.allDates.filter(k => k >= s && k <= e);

    if (!filteredDates.length) {
      document.getElementById('grid').innerHTML =
        '<tbody><tr><td style="padding:40px;text-align:center;color:var(--text-muted)">Nenhum dado no período selecionado.</td></tr></tbody>';
      document.getElementById('grid-sub').textContent = '';
      return;
    }

    const activeVendors = processed.vendors.filter(v => filteredDates.some(k => v.byDate.has(k)));
    const totalsByDate = {};
    let totalIn = 0, totalOut = 0, deficitDays = 0;
    let inDays = 0, outDays = 0;

    filteredDates.forEach(k => {
      const rIn = processed.receberByDate.get(k)?.total || 0;
      let rOut = 0;
      activeVendors.forEach(v => { rOut += v.byDate.get(k)?.total || 0; });
      totalsByDate[k] = { in: rIn, out: rOut, net: rIn - rOut };
      totalIn += rIn;
      totalOut += rOut;
      if (rIn > 0) inDays++;
      if (rOut > 0) outDays++;
      if (rIn - rOut < -0.005) deficitDays++;
    });

    renderKPIs(totalIn, totalOut, inDays, outDays, deficitDays);
    renderGrid(activeVendors, totalsByDate);
    renderSub(activeVendors);
  }

  function renderKPIs(totalIn, totalOut, inDays, outDays, deficitDays) {
    const net = totalIn - totalOut;
    document.getElementById('kpi-in').textContent = F.Fmt.fmtMoney(totalIn);
    document.getElementById('kpi-out').textContent = F.Fmt.fmtMoney(totalOut);
    const netEl = document.getElementById('kpi-net');
    netEl.textContent = F.Fmt.fmtMoney(net);
    netEl.className = 'value ' + (net >= 0 ? 'positive' : 'negative');
    document.getElementById('kpi-in-sub').textContent = `em ${inDays} dias`;
    document.getElementById('kpi-out-sub').textContent = `em ${outDays} dias`;
    document.getElementById('kpi-net-sub').textContent = net >= 0 ? 'Superavit no período' : 'Deficit no período';
    document.getElementById('kpi-deficit').textContent = deficitDays;
    document.getElementById('kpi-deficit-sub').textContent = `de ${filteredDates.length} dias`;
  }

  function renderSub(activeVendors) {
    const modeLabel = viewMode === 'effective' ? 'data efetiva' : 'data de vencimento';
    const manualCount = Object.keys(provisions).length;
    document.getElementById('grid-sub').textContent =
      `${activeVendors.length} fornecedores · ${filteredDates.length} dias · ${manualCount} lançamento${manualCount !== 1 ? 's' : ''} manual · ${modeLabel}`;
  }

  function sortIcon(col) {
    if (sortState.col !== col) return `<span class="sort-icon">⇅</span>`;
    return sortState.dir === 'asc' ? `<span class="sort-icon active">▲</span>` : `<span class="sort-icon active">▼</span>`;
  }
  function toggleSort(col) {
    if (sortState.col === col) sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
    else { sortState.col = col; sortState.dir = col === 'name' ? 'asc' : 'desc'; }
    render();
  }

  /* ========== Agrupamento por categoria ==========
     Retorna:
       [
         { id: catId, nome, cor, nativa, fornecedores: [{name,byDate,total,hasManual,hasReal}], total, byDate }
       ]
     Categorias vazias são omitidas.
     Nativa sempre presente como fallback (acomoda não-atribuídos).
     ================================================ */
  function groupVendorsByCategory(vendors) {
    const nativeEntry = Object.entries(categorias).find(([, c]) => c?.nativa);
    const nativeId = nativeEntry?.[0];

    // Map: nomeFornecedor UPPERCASE -> categoriaId
    const vendorCatIndex = {};
    Object.values(fornecedorMap).forEach(fc => {
      const nm = String(fc.fornecedorNome || '').toUpperCase();
      if (nm) vendorCatIndex[nm] = fc.categoriaId;
    });

    // Inicializa grupos para TODAS as categorias existentes
    const groups = {};
    Object.entries(categorias).forEach(([cid, cat]) => {
      groups[cid] = {
        id: cid,
        nome: cat.nome || '',
        cor: cat.cor || '#6b7280',
        nativa: !!cat.nativa,
        fornecedores: [],
        total: 0,
        byDate: new Map(),
      };
    });

    vendors.forEach(v => {
      let cid = vendorCatIndex[v.name];
      if (!cid || !groups[cid]) cid = nativeId; // fallback para nativa
      if (!cid) {
        // Sem categoria nativa ainda: cria temporária
        groups['__none__'] = groups['__none__'] || {
          id: '__none__',
          nome: 'DEMAIS FORNECEDORES',
          cor: '#6b7280',
          nativa: true,
          fornecedores: [],
          total: 0,
          byDate: new Map(),
        };
        cid = '__none__';
      }
      const g = groups[cid];
      g.fornecedores.push(v);
      g.total += v.total;
      v.byDate.forEach((bucket, k) => {
        if (!g.byDate.has(k)) g.byDate.set(k, { total: 0 });
        g.byDate.get(k).total += bucket.total;
      });
    });

    // Retorna apenas categorias com fornecedores
    return Object.values(groups).filter(g => g.fornecedores.length > 0);
  }

  function sortCategoryGroups(groups, sState) {
    const sorted = [...groups];
    // Nativa sempre no final para manter o jeito tradicional
    sorted.sort((a, b) => {
      if (a.nativa && !b.nativa) return 1;
      if (!a.nativa && b.nativa) return -1;
      if (sState.col === 'name') {
        const cmp = a.nome.localeCompare(b.nome, 'pt-BR');
        return sState.dir === 'asc' ? cmp : -cmp;
      }
      if (sState.col === 'total') {
        return sState.dir === 'asc' ? a.total - b.total : b.total - a.total;
      }
      // Ordena por coluna de data específica
      const va = a.byDate.get(sState.col)?.total || 0;
      const vb = b.byDate.get(sState.col)?.total || 0;
      return sState.dir === 'asc' ? va - vb : vb - va;
    });
    return sorted;
  }

  function renderGrid(activeVendors, totalsByDate) {
    const grid = document.getElementById('grid');
    const parts = [];
    const groups = groupVendorsByCategory(activeVendors);
    const sortedGroups = sortCategoryGroups(groups, sortState);

    // Thead
    parts.push('<thead><tr>');
    parts.push(`<th class="first sortable" data-sort-col="name">Fornecedor / Conta ${sortIcon('name')}</th>`);
    filteredDates.forEach(k => {
      const d = F.Dates.parseDateKey(k);
      const we = F.Dates.isWeekend(d) ? ' weekend' : '';
      parts.push(`<th class="sortable${we}" data-sort-col="${k}">${F.Fmt.fmtHeaderDate(d)}<span class="wd">${F.Fmt.weekdayShort(d)}</span> ${sortIcon(k)}</th>`);
    });
    parts.push(`<th class="sortable" data-sort-col="total" style="border-left:1.5px solid var(--border-strong);">Total ${sortIcon('total')}</th>`);
    parts.push('</tr></thead>');

    parts.push('<tbody>');

    // ======= Contas a Receber =======
    // Verifica se tem manuais de receber para decidir se é expansível
    const hasReceberManual = Object.values(provisions).some(p => p.tipo === 'receber');
    const rTotal = filteredDates.reduce((s, k) => s + totalsByDate[k].in, 0);
    const receberExpanderIcon = hasReceberManual
      ? (expandedReceber
        ? '<span class="expander" title="Recolher">▾</span>'
        : '<span class="expander" title="Expandir">▸</span>')
      : '<span class="expander disabled">·</span>';

    parts.push('<tr class="total-row total-in" data-toggle-receber="1" style="cursor:' + (hasReceberManual ? 'pointer' : 'default') + ';">');
    parts.push(`<td class="first">${receberExpanderIcon} Contas a Receber (Total)</td>`);
    filteredDates.forEach(k => {
      const d = F.Dates.parseDateKey(k);
      const we = F.Dates.isWeekend(d) ? ' weekend' : '';
      const hasComment = hasCommentsForCell('receber', k, null);
      const commentDot = hasComment ? '<span class="comment-dot"></span>' : '';
      const bucket = processed.receberByDate.get(k);
      const val = bucket?.total || 0;
      if (val > 0) {
        parts.push(`<td class="${we.trim()}" data-detail="receber" data-date="${k}" style="cursor:pointer;"><span>${F.Fmt.fmtCellMoney(val)}</span>${commentDot}</td>`);
      } else {
        parts.push(`<td class="${we.trim()}" data-add="receber" data-date="${k}" style="cursor:pointer;"><span>${F.Fmt.fmtCellMoney(0)}</span>${commentDot}</td>`);
      }
    });
    parts.push(`<td style="border-left:1.5px solid var(--border-strong);">${F.Fmt.fmtCellMoney(rTotal)}</td>`);
    parts.push('</tr>');

    // Detalhe expandido de Contas a Receber (só manuais, pois importados não têm fornecedor/cliente individualizado na linha)
    if (expandedReceber && hasReceberManual) {
      // Agrupa receber manuais por cliente/descrição
      const receberByClient = new Map();
      Object.entries(provisions).forEach(([id, p]) => {
        if (p.tipo !== 'receber') return;
        const nm = String(p.entidade || '').toUpperCase();
        if (!receberByClient.has(nm)) receberByClient.set(nm, { byDate: new Map(), total: 0 });
        const entry = receberByClient.get(nm);
        const due = F.Dates.parseDateKey(p.vencimento);
        const eff = F.Dates.effectiveDateReceber(due);
        const useK = F.Dates.dateKey(viewMode === 'effective' ? eff : due);
        if (filteredDates.includes(useK)) {
          if (!entry.byDate.has(useK)) entry.byDate.set(useK, 0);
          entry.byDate.set(useK, entry.byDate.get(useK) + p.valor);
          entry.total += p.valor;
        }
      });
      const clientsArr = [...receberByClient.entries()].sort((a, b) => b[1].total - a[1].total);
      clientsArr.forEach(([nm, info]) => {
        parts.push('<tr class="vendor-row sub-row">');
        parts.push(`<td class="first"><div class="row-label" style="padding-left:24px;"><span class="nm" title="${F.escapeHTML(nm)}">${F.escapeHTML(nm)} <span class="tag manual">MANUAL</span></span></div></td>`);
        filteredDates.forEach(k => {
          const d = F.Dates.parseDateKey(k);
          const we = F.Dates.isWeekend(d) ? ' weekend' : '';
          const val = info.byDate.get(k) || 0;
          if (val > 0) {
            parts.push(`<td class="manual-val${we}"><span>${F.Fmt.fmtCellMoney(val)}</span></td>`);
          } else {
            parts.push(`<td class="empty${we}"><span>–</span></td>`);
          }
        });
        parts.push(`<td class="in-val" style="border-left:1.5px solid var(--border-strong);">${F.Fmt.fmtCellMoney(info.total)}</td>`);
        parts.push('</tr>');
      });
    }

    // ======= Contas a Pagar =======
    const pTotal = filteredDates.reduce((s, k) => s + totalsByDate[k].out, 0);
    const pagarExpanderIcon = expandedPagarTotal
      ? '<span class="expander" title="Recolher">▾</span>'
      : '<span class="expander" title="Expandir">▸</span>';

    parts.push('<tr class="total-row total-out" data-toggle-pagar="1" style="cursor:pointer;">');
    parts.push(`<td class="first">${pagarExpanderIcon} Contas a Pagar (Total)</td>`);
    filteredDates.forEach(k => {
      const d = F.Dates.parseDateKey(k);
      const we = F.Dates.isWeekend(d) ? ' weekend' : '';
      parts.push(`<td class="${we.trim()}">${F.Fmt.fmtCellMoney(totalsByDate[k].out)}</td>`);
    });
    parts.push(`<td style="border-left:1.5px solid var(--border-strong);">${F.Fmt.fmtCellMoney(pTotal)}</td>`);
    parts.push('</tr>');

    // Se expandido: mostra categorias e fornecedores dentro
    if (expandedPagarTotal) {
      sortedGroups.forEach(g => {
        const catExpanded = expandedCategories.has(g.id);
        const catIcon = catExpanded
          ? '<span class="expander" title="Recolher">▾</span>'
          : '<span class="expander" title="Expandir">▸</span>';

        // Linha da categoria
        parts.push(`<tr class="cat-row" data-toggle-cat="${F.escapeHTML(g.id)}" style="cursor:pointer;">`);
        parts.push(`<td class="first"><div class="row-label" style="padding-left:20px;"><span class="cat-dot" style="background:${F.escapeHTML(g.cor)};"></span><span class="nm">${catIcon} ${F.escapeHTML(g.nome)} <span class="cat-count-chip">${g.fornecedores.length}</span></span></div></td>`);
        filteredDates.forEach(k => {
          const d = F.Dates.parseDateKey(k);
          const we = F.Dates.isWeekend(d) ? ' weekend' : '';
          const val = g.byDate.get(k)?.total || 0;
          parts.push(`<td class="cat-cell${we}">${F.Fmt.fmtCellMoney(val)}</td>`);
        });
        parts.push(`<td class="cat-cell" style="border-left:1.5px solid var(--border-strong);">${F.Fmt.fmtCellMoney(g.total)}</td>`);
        parts.push('</tr>');

        // Fornecedores da categoria (se expandida)
        if (catExpanded) {
          // Ordena fornecedores conforme sortState
          const sortedVendors = sortVendors(g.fornecedores, sortState);
          sortedVendors.forEach(v => {
            const vTotal = filteredDates.reduce((s, k) => s + (v.byDate.get(k)?.total || 0), 0);
            const isOnlyManual = v.hasManual && !v.hasReal;
            const rowClass = isOnlyManual ? 'vendor-row sub-row manual-row' : 'vendor-row sub-row';
            const manualTag = isOnlyManual ? '<span class="tag manual">MANUAL</span>' : '';
            const deleteRowBtn = isOnlyManual
              ? `<button class="danger" title="Excluir lançamentos manuais deste fornecedor" data-delete-vendor="${F.escapeHTML(v.name)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg></button>`
              : '';

            parts.push(`<tr class="${rowClass}">`);
            parts.push(`<td class="first"><div class="row-label" style="padding-left:40px;"><div class="name-group"><span class="nm" title="${F.escapeHTML(v.name)}">${F.escapeHTML(v.name)}${manualTag}</span></div><div class="row-actions">${deleteRowBtn}</div></div></td>`);
            filteredDates.forEach(k => {
              const d = F.Dates.parseDateKey(k);
              const bucket = v.byDate.get(k);
              const val = bucket?.total || 0;
              const we = F.Dates.isWeekend(d) ? ' weekend' : '';
              const hasComment = hasCommentsForCell('pagar', k, v.name);
              const commentDot = hasComment ? '<span class="comment-dot"></span>' : '';
              if (val > 0) {
                const cls = bucket?.hasManual ? 'manual-val' : 'out-val';
                parts.push(`<td class="${cls}${we}" data-detail="pagar" data-date="${k}" data-vendor="${F.escapeHTML(v.name)}"><span>${F.Fmt.fmtCellMoney(val)}</span>${commentDot}</td>`);
              } else {
                parts.push(`<td class="empty${we}" data-add="pagar" data-date="${k}" data-vendor="${F.escapeHTML(v.name)}"><span>–</span>${commentDot}</td>`);
              }
            });
            parts.push(`<td class="out-val" style="border-left:1.5px solid var(--border-strong);">${F.Fmt.fmtCellMoney(vTotal)}</td>`);
            parts.push('</tr>');
          });
        }
      });
    }

    parts.push('</tbody>');

    // Rodapé — só Saldo do dia
    parts.push('<tfoot>');
    parts.push('<tr class="saldo"><td class="first">Saldo do dia</td>');
    let saldoTotal = 0;
    filteredDates.forEach(k => {
      const saldo = totalsByDate[k].net;
      saldoTotal += saldo;
      const cls = saldo >= 0 ? 'positive-bal' : 'negative-bal';
      parts.push(`<td class="${cls}">${Math.abs(saldo) < 0.005 ? '–' : F.Fmt.fmtMoneyShort(saldo)}</td>`);
    });
    parts.push(`<td class="${saldoTotal >= 0 ? 'positive-bal' : 'negative-bal'}" style="border-left:1.5px solid var(--border-strong);">${F.Fmt.fmtMoneyShort(saldoTotal)}</td></tr>`);
    parts.push('</tfoot>');

    grid.innerHTML = parts.join('');

    // Handlers
    grid.querySelectorAll('[data-sort-col]').forEach(th => {
      th.addEventListener('click', () => toggleSort(th.dataset.sortCol));
    });
    grid.querySelectorAll('[data-detail]').forEach(cell => {
      cell.addEventListener('click', (e) => {
        e.stopPropagation();
        openDetail(cell.dataset.detail, cell.dataset.date, cell.dataset.vendor);
      });
    });
    grid.querySelectorAll('[data-add]').forEach(cell => {
      cell.addEventListener('click', (e) => {
        e.stopPropagation();
        openForm({
          tipo: cell.dataset.add,
          vencimento: cell.dataset.date,
          entidade: cell.dataset.vendor || '',
        });
      });
    });
    grid.querySelectorAll('[data-delete-vendor]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteManualVendorRow(btn.dataset.deleteVendor);
      });
    });
    grid.querySelectorAll('[data-toggle-receber]').forEach(row => {
      row.addEventListener('click', (e) => {
        // Evita disparar quando clica numa célula de valor (que tem data-detail ou data-add)
        if (e.target.closest('[data-detail]') || e.target.closest('[data-add]')) return;
        if (!hasReceberManual) return;
        expandedReceber = !expandedReceber;
        render();
      });
    });
    grid.querySelectorAll('[data-toggle-pagar]').forEach(row => {
      row.addEventListener('click', () => {
        expandedPagarTotal = !expandedPagarTotal;
        render();
      });
    });
    grid.querySelectorAll('[data-toggle-cat]').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('[data-detail]') || e.target.closest('[data-add]')) return;
        const cid = row.dataset.toggleCat;
        if (expandedCategories.has(cid)) expandedCategories.delete(cid);
        else expandedCategories.add(cid);
        render();
      });
    });
  }

  /* ========== Provisões (Firebase) ========== */
  function openForm(prefill) {
    prefill = prefill || {};
    const tipo = prefill.tipo || 'pagar';
    document.getElementById('form-type-toggle').querySelectorAll('button').forEach(b => {
      b.classList.toggle('active', b.dataset.type === tipo);
    });
    document.getElementById('form-entity-label').textContent =
      tipo === 'pagar' ? 'Fornecedor' : 'Cliente / Descrição';
    document.getElementById('form-entity').value = prefill.entidade || '';
    document.getElementById('form-date').value = prefill.vencimento || F.Dates.dateKey(new Date());
    document.getElementById('form-value').value = '';
    document.getElementById('form-doc').value = '';
    document.getElementById('form-note').value = '';
    document.getElementById('form-modal').classList.add('open');
    setTimeout(() => document.getElementById('form-entity').focus(), 100);
  }

  async function saveProvision() {
    const tipo = document.getElementById('form-type-toggle').querySelector('.active').dataset.type;
    const entidade = document.getElementById('form-entity').value.trim().toUpperCase();
    const dateVal = document.getElementById('form-date').value;
    const valor = parseFloat(document.getElementById('form-value').value);
    const documento = document.getElementById('form-doc').value.trim();
    const nota = document.getElementById('form-note').value.trim();

    if (!entidade) { F.UI.showToast('Informe o fornecedor/cliente', 'error'); return; }
    if (!dateVal) { F.UI.showToast('Informe a data de vencimento', 'error'); return; }
    if (!valor || valor <= 0) { F.UI.showToast('Informe um valor positivo', 'error'); return; }
    if (entidade.length > 120) { F.UI.showToast('Nome muito longo (máx 120 caracteres)', 'error'); return; }
    if (nota.length > 500) { F.UI.showToast('Observação muito longa (máx 500 caracteres)', 'error'); return; }

    if (processed?.maxImportValue > 0 && valor > processed.maxImportValue * 10) {
      const msg = `O valor digitado (${F.Fmt.fmtMoney(valor)}) está muito acima do maior título importado (${F.Fmt.fmtMoney(processed.maxImportValue)}).\n\nTem certeza que deseja salvar?`;
      if (!confirm(msg)) return;
    }

    if (!F.DB.dbReady()) { F.UI.showToast('Firebase não está pronto. Verifique conexão.', 'error'); return; }

    F.UI.showLoading('Salvando…');
    try {
      await F.DB.createLancamento({ tipo, entidade, vencimento: dateVal, valor, documento, nota });
      document.getElementById('form-modal').classList.remove('open');
      F.UI.showToast('Lançamento manual criado', 'success');
    } catch (err) {
      console.error(err);
      F.UI.showToast('Erro ao salvar: ' + err.message, 'error');
    } finally {
      F.UI.hideLoading();
    }
  }

  async function deleteProvision(provId) {
    const prov = provisions[provId];
    if (!prov) return;
    if (prov.authorUid && prov.authorUid !== F.state.user?.uid) {
      F.UI.showToast('Apenas o autor pode excluir este lançamento', 'error');
      return;
    }
    try {
      await F.DB.deleteLancamento(provId);
      F.UI.showToast('Lançamento excluído', 'success');
    } catch (err) {
      console.error(err);
      F.UI.showToast('Erro ao excluir: ' + err.message, 'error');
    }
  }

  async function deleteImportedTitle(title, kind) {
    try {
      await F.DB.hideTitle(title.id, { ...title, _kind: kind });
      F.UI.showToast('Título ocultado', 'success');
    } catch (err) {
      console.error(err);
      F.UI.showToast('Erro: ' + err.message, 'error');
    }
  }

  async function deleteManualVendorRow(vendorName) {
    const myLancs = Object.entries(provisions).filter(([id, p]) =>
      p.tipo === 'pagar' &&
      (p.entidade || '').toUpperCase() === vendorName.toUpperCase() &&
      (!p.authorUid || p.authorUid === F.state.user?.uid)
    );
    if (!myLancs.length) {
      F.UI.showToast('Você não tem lançamentos manuais deste fornecedor', 'error');
      return;
    }
    if (!confirm(`Excluir ${myLancs.length} lançamento(s) manuais seus de "${vendorName}"?`)) return;
    F.UI.showLoading('Excluindo…');
    try {
      await Promise.all(myLancs.map(([id]) => F.DB.deleteLancamento(id)));
      F.UI.showToast('Lançamentos excluídos', 'success');
    } catch (err) {
      console.error(err);
      F.UI.showToast('Erro: ' + err.message, 'error');
    } finally {
      F.UI.hideLoading();
    }
  }

  function rebuildAndRender() {
    buildIndex();
    if (processed.allDates.length) {
      const s = document.getElementById('filter-start')?.value;
      const e = document.getElementById('filter-end')?.value;
      if (s && e && !processed.allDates.some(k => k >= s && k <= e)) {
        document.getElementById('filter-start').value = processed.allDates[0];
        document.getElementById('filter-end').value = processed.allDates[processed.allDates.length - 1];
      }
    }
    if (document.getElementById('main-content').classList.contains('hidden')) {
      document.getElementById('empty-state').classList.add('hidden');
      document.getElementById('main-content').classList.remove('hidden');
      setupControls();
      updateHeaderInfo();
    }
    render();
    if (currentDetail && document.getElementById('detail-modal').classList.contains('open')) {
      openDetail(currentDetail.kind, currentDetail.dateKey, currentDetail.vendorName);
    }
  }

  /* ========== Detalhes ========== */
  function openDetail(kind, dk, vendorName) {
    const d = F.Dates.parseDateKey(dk);
    let titulos = [], total = 0, title = '', subtitle = '';
    if (kind === 'receber') {
      const bucket = processed.receberByDate.get(dk);
      titulos = bucket?.titulos || [];
      total = bucket?.total || 0;
      title = 'Contas a Receber';
      subtitle = `${titulos.length} título${titulos.length !== 1 ? 's' : ''} · ${F.Fmt.weekdayFull(d)}, ${F.Fmt.fmtFullDate(d)}`;
    } else {
      const vendor = processed.vendors.find(v => v.name === vendorName);
      const bucket = vendor?.byDate.get(dk);
      titulos = bucket?.titulos || [];
      total = bucket?.total || 0;
      title = vendorName;
      subtitle = `${titulos.length} título${titulos.length !== 1 ? 's' : ''} · ${F.Fmt.weekdayFull(d)}, ${F.Fmt.fmtFullDate(d)}`;
    }

    currentDetail = { kind, dateKey: dk, vendorName, titulos, total };
    detailSortState = { col: null, dir: 'asc' };

    document.getElementById('detail-title').textContent = title;
    document.getElementById('detail-subtitle').textContent = subtitle;

    const modeLabel = viewMode === 'effective' ? 'Efetiva (após regra bancária)' : 'Vencimento';
    document.getElementById('detail-date-info').innerHTML = `
      <span class="date-chip">Exibido por: <strong>${F.escapeHTML(modeLabel)}</strong></span>
      <span class="date-chip">Data: <strong>${F.escapeHTML(F.Fmt.fmtFullDate(d))}</strong></span>
    `;

    renderDetailTable();

    const totalEl = document.getElementById('detail-total');
    totalEl.textContent = F.Fmt.fmtMoney(total);
    totalEl.className = 'total-value ' + (kind === 'receber' ? 'in' : 'out');

    refreshDetailComments();
    document.getElementById('detail-modal').classList.add('open');
  }

  function detailSortIcon(col) {
    if (detailSortState.col !== col) return `<span class="sort-icon">⇅</span>`;
    return detailSortState.dir === 'asc' ? `<span class="sort-icon active">▲</span>` : `<span class="sort-icon active">▼</span>`;
  }
  function toggleDetailSort(col) {
    if (detailSortState.col === col) detailSortState.dir = detailSortState.dir === 'asc' ? 'desc' : 'asc';
    else { detailSortState.col = col; detailSortState.dir = 'asc'; }
    renderDetailTable();
  }

  function renderDetailTable() {
    if (!currentDetail) return;
    const { kind, titulos } = currentDetail;
    const isReceber = kind === 'receber';
    const entityCol = isReceber ? 'Cliente' : 'Fornecedor';
    const valueCls = isReceber ? 'value-in' : 'value-out';

    let sorted = [...titulos];
    if (detailSortState.col) {
      const c = detailSortState.col;
      const dir = detailSortState.dir === 'asc' ? 1 : -1;
      sorted.sort((a, b) => {
        let av, bv;
        if (c === 'documento') { av = a.documento || ''; bv = b.documento || ''; return av.localeCompare(bv) * dir; }
        if (c === 'entidade') {
          av = isReceber ? (a.cliente || '') : (a.fornecedor || '');
          bv = isReceber ? (b.cliente || '') : (b.fornecedor || '');
          return av.localeCompare(bv) * dir;
        }
        if (c === 'vencimento') return a.vencimentoDate.localeCompare(b.vencimentoDate) * dir;
        if (c === 'efetiva') return a.efetivaDate.localeCompare(b.efetivaDate) * dir;
        if (c === 'valor') return (a.valor - b.valor) * dir;
        return 0;
      });
    }

    detailCurrentRows = sorted;

    document.getElementById('detail-thead').innerHTML = `
      <tr>
        <th class="sortable" data-detail-sort="documento">Documento ${detailSortIcon('documento')}</th>
        <th class="sortable" data-detail-sort="entidade">${entityCol} ${detailSortIcon('entidade')}</th>
        <th class="sortable" data-detail-sort="vencimento">Vencimento ${detailSortIcon('vencimento')}</th>
        <th class="sortable" data-detail-sort="efetiva">Data efetiva ${detailSortIcon('efetiva')}</th>
        <th class="sortable right" data-detail-sort="valor">Valor ${detailSortIcon('valor')}</th>
        <th class="right"></th>
      </tr>
    `;

    const tbody = document.getElementById('detail-tbody');
    tbody.innerHTML = sorted.length === 0
      ? '<tr><td colspan="6" style="padding:30px;text-align:center;color:var(--text-muted)">Nenhum título nesta data.</td></tr>'
      : sorted.map(t => {
        const name = (isReceber ? t.cliente : t.fornecedor) || '—';
        const manualTag = t._manual ? '<span class="tag">MANUAL</span>' : '';
        const noteLine = t._note
          ? `<div style="font-size:11px;color:var(--text-muted);margin-top:3px;font-family:'JetBrains Mono',monospace;">${F.escapeHTML(t._note)}</div>`
          : '';
        const canDelete = !t._manual || !t._authorUid || (t._authorUid === F.state.user?.uid);
        const deleteBtn = canDelete
          ? `<button class="row-del-btn" data-title-id="${F.escapeHTML(t.id)}" data-title-manual="${t._manual ? '1' : '0'}" data-title-kind="${kind}" title="Excluir"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg></button>`
          : '';
        return `
          <tr class="${t._manual ? 'manual-title' : ''}">
            <td class="doc">${F.escapeHTML(t.documento || '—')}</td>
            <td>${F.escapeHTML(name)}${manualTag}${noteLine}</td>
            <td>${F.Fmt.fmtFullDate(F.Dates.parseDateKey(t.vencimentoDate))}</td>
            <td>${F.Fmt.fmtFullDate(F.Dates.parseDateKey(t.efetivaDate))}</td>
            <td class="right ${valueCls}">${F.Fmt.fmtMoney(t.valor)}</td>
            <td class="right">${deleteBtn}</td>
          </tr>
        `;
      }).join('');

    document.querySelectorAll('[data-detail-sort]').forEach(th => {
      th.addEventListener('click', () => toggleDetailSort(th.dataset.detailSort));
    });
    tbody.querySelectorAll('[data-title-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tid = btn.dataset.titleId;
        const isManual = btn.dataset.titleManual === '1';
        const k = btn.dataset.titleKind;
        if (isManual) {
          if (confirm('Excluir este lançamento manual? A ação é sincronizada entre todos os usuários.')) deleteProvision(tid);
        } else {
          if (confirm('Ocultar este título importado? Pode ser restaurado depois.')) {
            const list = k === 'receber' ? dataStore.titulosReceber : dataStore.titulosPagar;
            const original = list.find(t => t.id === tid);
            if (original) deleteImportedTitle(original, k);
          }
        }
      });
    });
  }

  /* ========== Export modal de detalhes ========== */
  async function exportDetail(kind) {
    if (!currentDetail || !detailCurrentRows.length) {
      F.UI.showToast('Nada para exportar', 'error');
      return;
    }
    const isReceber = currentDetail.kind === 'receber';
    const entityLabel = isReceber ? 'Cliente' : 'Fornecedor';
    const title = currentDetail.vendorName || 'Contas a Receber';
    const d = F.Dates.parseDateKey(currentDetail.dateKey);
    const dateLabel = F.Fmt.fmtFullDate(d);
    const safeTitle = String(title).replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
    const filename = `filadelfia_detalhe_${safeTitle}_${currentDetail.dateKey}`;

    if (kind === 'xlsx') {
      try {
        F.UI.showLoading('Gerando planilha…');
        const aoa = [
          [title],
          [`Data: ${dateLabel} · Total: ${F.Fmt.fmtMoney(currentDetail.total)}`],
          [],
          ['Documento', entityLabel, 'Vencimento', 'Data efetiva', 'Valor', 'Manual?'],
          ...detailCurrentRows.map(t => [
            t.documento || '',
            (isReceber ? t.cliente : t.fornecedor) || '',
            F.Fmt.fmtFullDate(F.Dates.parseDateKey(t.vencimentoDate)),
            F.Fmt.fmtFullDate(F.Dates.parseDateKey(t.efetivaDate)),
            t.valor,
            t._manual ? 'Sim' : 'Não',
          ])
        ];
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [{ wch: 18 }, { wch: 40 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 10 }];
        const range = XLSX.utils.decode_range(ws['!ref']);
        for (let R = 4; R <= range.e.r; R++) {
          const addr = XLSX.utils.encode_cell({ r: R, c: 4 });
          if (ws[addr]) { ws[addr].z = 'R$ #,##0.00;[Red]-R$ #,##0.00'; ws[addr].t = 'n'; }
        }
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Detalhes');
        XLSX.writeFile(wb, filename + '.xlsx');
        F.UI.showToast('Planilha gerada', 'success');
      } catch (err) {
        console.error(err);
        F.UI.showToast('Erro: ' + err.message, 'error');
      } finally {
        F.UI.hideLoading();
      }
      return;
    }

    if (kind === 'pdf') {
      try {
        F.UI.showLoading('Gerando PDF…');
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        const pageW = doc.internal.pageSize.getWidth();
        const pageH = doc.internal.pageSize.getHeight();

        doc.setFillColor(10, 14, 22);
        doc.rect(0, 0, pageW, 20, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.text('FILADELFIA · Detalhamento', 10, 10);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.text(title, 10, 16);
        doc.text(dateLabel, pageW - 10, 10, { align: 'right' });
        doc.text(`Total: ${F.Fmt.fmtMoney(currentDetail.total)}`, pageW - 10, 16, { align: 'right' });

        doc.autoTable({
          head: [['Documento', entityLabel, 'Vencimento', 'Data efetiva', 'Valor', 'Tipo']],
          body: detailCurrentRows.map(t => [
            t.documento || '—',
            (isReceber ? t.cliente : t.fornecedor) || '—',
            F.Fmt.fmtFullDate(F.Dates.parseDateKey(t.vencimentoDate)),
            F.Fmt.fmtFullDate(F.Dates.parseDateKey(t.efetivaDate)),
            F.Fmt.fmtMoneyShort(t.valor),
            t._manual ? 'Manual' : 'Import.',
          ]),
          startY: 24,
          margin: { left: 10, right: 10 },
          theme: 'grid',
          styles: { fontSize: 8, cellPadding: 2, lineColor: [228, 232, 238], lineWidth: 0.1 },
          headStyles: { fillColor: [10, 14, 22], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 9 },
          columnStyles: {
            0: { cellWidth: 30 },
            1: { cellWidth: 'auto' },
            2: { cellWidth: 22, halign: 'center' },
            3: { cellWidth: 22, halign: 'center' },
            4: { cellWidth: 25, halign: 'right', fontStyle: 'bold', textColor: isReceber ? [10, 110, 158] : [180, 35, 24] },
            5: { cellWidth: 18, halign: 'center' },
          },
        });

        doc.setTextColor(107, 114, 128);
        doc.setFontSize(7);
        doc.text(`Gerado em ${new Date().toLocaleString('pt-BR')} · R2 Soluções Empresariais`, pageW / 2, pageH - 5, { align: 'center' });

        doc.save(filename + '.pdf');
        F.UI.showToast('PDF gerado', 'success');
      } catch (err) {
        console.error(err);
        F.UI.showToast('Erro: ' + err.message, 'error');
      } finally {
        F.UI.hideLoading();
      }
      return;
    }

    if (kind === 'png') {
      try {
        F.UI.showLoading('Gerando imagem…');
        const modal = document.querySelector('.modal.detail-modal');
        const canvas = await html2canvas(modal, {
          scale: 2,
          backgroundColor: '#ffffff',
          logging: false,
          useCORS: true,
          windowWidth: modal.scrollWidth,
          windowHeight: modal.scrollHeight,
        });
        canvas.toBlob(blob => {
          if (blob) downloadBlob(blob, filename + '.png');
          F.UI.showToast('Imagem gerada', 'success');
        }, 'image/png');
      } catch (err) {
        console.error(err);
        F.UI.showToast('Erro: ' + err.message, 'error');
      } finally {
        F.UI.hideLoading();
      }
    }
  }

  /* ========== Comentários ========== */
  function refreshDetailComments() {
    if (!currentDetail) return;
    const authorTag = document.getElementById('comment-author-tag');
    if (authorTag) {
      authorTag.innerHTML = 'Publicar como <strong>' + F.escapeHTML(F.state.user?.displayName || 'Anônimo') + '</strong>';
    }

    if (!F.IS_FIREBASE_CONFIGURED) {
      document.getElementById('comments-list').innerHTML = '<div class="comment-empty">Firebase não configurado.</div>';
      document.getElementById('comment-count').textContent = '0';
      return;
    }

    const comments = getCommentsForCell(currentDetail.kind, currentDetail.dateKey, currentDetail.vendorName);
    const list = Object.entries(comments).map(([id, c]) => ({ id, ...c })).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    document.getElementById('comment-count').textContent = list.length;
    const listEl = document.getElementById('comments-list');
    if (!list.length) {
      listEl.innerHTML = '<div class="comment-empty">Nenhum comentário ainda. Seja o primeiro!</div>';
    } else {
      listEl.innerHTML = list.map(c => `
        <div class="comment">
          <div class="meta">
            <span class="author">${F.escapeHTML(c.author || 'Anônimo')}</span>
            <div style="display:flex;gap:8px;align-items:center;">
              <span class="time" title="${F.escapeHTML(new Date(c.createdAt).toLocaleString('pt-BR'))}">${F.Fmt.fmtRelativeTime(c.createdAt)}</span>
              ${c.authorUid === F.state.user?.uid ? `<button class="del-btn" data-comment-id="${F.escapeHTML(c.id)}">Excluir</button>` : ''}
            </div>
          </div>
          <div class="text">${F.escapeHTML(c.text)}</div>
        </div>
      `).join('');
      listEl.querySelectorAll('[data-comment-id]').forEach(btn => {
        btn.addEventListener('click', () => {
          if (confirm('Excluir este comentário?')) deleteComment(btn.dataset.commentId);
        });
      });
    }
  }

  function addComment() {
    if (!currentDetail) return;
    const text = document.getElementById('comment-text').value.trim();
    if (!text) { F.UI.showToast('Escreva um comentário', 'error'); return; }
    if (text.length > 1000) { F.UI.showToast('Comentário muito longo', 'error'); return; }
    if (!F.state.fbDB) { F.UI.showToast('Firebase não configurado', 'error'); return; }

    const key = commentKeyFor(currentDetail.kind, currentDetail.dateKey, currentDetail.vendorName);
    const payload = {
      author: F.state.user?.displayName || 'Anônimo',
      authorUid: F.state.user?.uid || null,
      authorEmail: F.state.user?.email || null,
      text,
      createdAt: firebase.database.ServerValue.TIMESTAMP,
    };
    F.state.fbDB.ref(`filadelfia/comentarios/${key}`).push().set(payload)
      .then(() => {
        document.getElementById('comment-text').value = '';
        F.UI.showToast('Comentário publicado', 'success');
      })
      .catch(err => { console.error(err); F.UI.showToast('Erro ao enviar', 'error'); });
  }

  function deleteComment(commentId) {
    if (!currentDetail || !F.state.fbDB) return;
    const key = commentKeyFor(currentDetail.kind, currentDetail.dateKey, currentDetail.vendorName);
    F.state.fbDB.ref(`filadelfia/comentarios/${key}/${commentId}`).remove()
      .then(() => F.UI.showToast('Comentário excluído', 'success'))
      .catch(() => F.UI.showToast('Erro ao excluir', 'error'));
  }

  /* ========== Export da grade ========== */
  function getExportFilename(ext) {
    const s = document.getElementById('filter-start').value;
    const e = document.getElementById('filter-end').value;
    return `filadelfia_fluxo_caixa_${s}_a_${e}.${ext}`;
  }
  function runExport(kind) {
    if (!filteredDates.length) { F.UI.showToast('Nenhum dado no período', 'error'); return; }
    switch (kind) {
      case 'csv': exportCSV(); break;
      case 'xlsx': exportXLSX(); break;
      case 'pdf': exportPDF(); break;
      case 'png': exportPNG(); break;
    }
  }

  function collectExportData() {
    const activeVendors = processed.vendors.filter(v => filteredDates.some(k => v.byDate.has(k)));
    const sortedVendors = sortVendors(activeVendors, sortState);
    const groups = groupVendorsByCategory(activeVendors);
    const sortedGroups = sortCategoryGroups(groups, sortState);

    let rTotal = 0;
    const receberRow = filteredDates.map(k => {
      const v = processed.receberByDate.get(k)?.total || 0;
      rTotal += v;
      return v;
    });
    const vendorRows = sortedVendors.map(v => {
      let t = 0;
      const cells = filteredDates.map(k => {
        const val = v.byDate.get(k)?.total || 0;
        t += val;
        return val;
      });
      return { name: v.name, cells, total: t };
    });
    let subOut = 0;
    const totalPagarCells = filteredDates.map(k => {
      const s = sortedVendors.reduce((a, v) => a + (v.byDate.get(k)?.total || 0), 0);
      subOut += s;
      return s;
    });
    let sT = 0;
    const saldoCells = filteredDates.map((k, i) => {
      const s = receberRow[i] - totalPagarCells[i];
      sT += s;
      return s;
    });
    return { activeVendors: sortedVendors, rTotal, receberRow, vendorRows, subOut, totalPagarCells, sT, saldoCells, sortedGroups };
  }

  function csvCell(v) {
    const s = String(v);
    if (s.includes(';') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function moneyCsv(v) { return v.toFixed(2).replace('.', ','); }

  function exportCSV() {
    const ex = collectExportData();
    const lines = [];
    const header = ['Item', ...filteredDates.map(k => F.Fmt.fmtFullDate(F.Dates.parseDateKey(k))), 'Total'];
    lines.push(header.map(csvCell).join(';'));
    lines.push(['Contas a Receber (Total)', ...ex.receberRow.map(moneyCsv), moneyCsv(ex.rTotal)].map(csvCell).join(';'));
    lines.push(['Contas a Pagar (Total)', ...ex.totalPagarCells.map(moneyCsv), moneyCsv(ex.subOut)].map(csvCell).join(';'));

    // Categorias e fornecedores
    ex.sortedGroups.forEach(g => {
      const catCells = filteredDates.map(k => moneyCsv(g.byDate.get(k)?.total || 0));
      lines.push([`  [${g.nome}]`, ...catCells, moneyCsv(g.total)].map(csvCell).join(';'));
      const sortedVendors = sortVendors(g.fornecedores, sortState);
      sortedVendors.forEach(v => {
        const vTotal = filteredDates.reduce((s, k) => s + (v.byDate.get(k)?.total || 0), 0);
        const cells = filteredDates.map(k => moneyCsv(v.byDate.get(k)?.total || 0));
        lines.push([`    ${v.name}`, ...cells, moneyCsv(vTotal)].map(csvCell).join(';'));
      });
    });

    lines.push(['Saldo do dia', ...ex.saldoCells.map(moneyCsv), moneyCsv(ex.sT)].map(csvCell).join(';'));

    const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, getExportFilename('csv'));
  }

  function exportXLSX() {
    F.UI.showLoading('Gerando planilha…');
    setTimeout(() => {
      try {
        const ex = collectExportData();
        const aoa = [];
        aoa.push(['Item', ...filteredDates.map(k => F.Fmt.fmtFullDate(F.Dates.parseDateKey(k))), 'Total']);
        aoa.push(['Contas a Receber (Total)', ...ex.receberRow, ex.rTotal]);
        aoa.push(['Contas a Pagar (Total)', ...ex.totalPagarCells, ex.subOut]);

        // Categorias e fornecedores
        const catRowIndices = [];
        ex.sortedGroups.forEach(g => {
          const catCells = filteredDates.map(k => g.byDate.get(k)?.total || 0);
          aoa.push([`▸ ${g.nome}`, ...catCells, g.total]);
          catRowIndices.push(aoa.length - 1); // armazena índice 0-based da linha
          const sortedVendors = sortVendors(g.fornecedores, sortState);
          sortedVendors.forEach(v => {
            const vTotal = filteredDates.reduce((s, k) => s + (v.byDate.get(k)?.total || 0), 0);
            const cells = filteredDates.map(k => v.byDate.get(k)?.total || 0);
            aoa.push([`    ${v.name}`, ...cells, vTotal]);
          });
        });

        aoa.push(['Saldo do dia', ...ex.saldoCells, ex.sT]);

        const ws = XLSX.utils.aoa_to_sheet(aoa);
        const range = XLSX.utils.decode_range(ws['!ref']);
        for (let R = 1; R <= range.e.r; R++) {
          for (let C = 1; C <= range.e.c; C++) {
            const addr = XLSX.utils.encode_cell({ r: R, c: C });
            if (ws[addr] && typeof ws[addr].v === 'number') {
              ws[addr].z = 'R$ #,##0.00;[Red]-R$ #,##0.00';
              ws[addr].t = 'n';
            }
          }
        }
        ws['!cols'] = [{ wch: 36 }, ...filteredDates.map(() => ({ wch: 14 })), { wch: 16 }];
        ws['!freeze'] = { xSplit: 1, ySplit: 1 };

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Fluxo de Caixa');
        XLSX.writeFile(wb, getExportFilename('xlsx'));
        F.UI.showToast('Planilha gerada', 'success');
      } catch (err) {
        console.error(err);
        F.UI.showToast('Erro: ' + err.message, 'error');
      } finally {
        F.UI.hideLoading();
      }
    }, 50);
  }

  async function exportPNG() {
    F.UI.showLoading('Gerando imagem…');
    const card = document.getElementById('grid-card');
    const scroll = document.getElementById('grid-scroll');
    const originalMaxHeight = scroll.style.maxHeight;
    scroll.style.maxHeight = 'none';
    scroll.classList.add('export-mode');
    try {
      await new Promise(r => setTimeout(r, 80));
      const canvas = await html2canvas(card, { scale: 2, backgroundColor: '#ffffff', logging: false, useCORS: true });
      canvas.toBlob(blob => {
        if (blob) downloadBlob(blob, getExportFilename('png'));
        scroll.style.maxHeight = originalMaxHeight;
        scroll.classList.remove('export-mode');
        F.UI.showToast('Imagem gerada', 'success');
      }, 'image/png');
    } catch (err) {
      console.error(err);
      scroll.style.maxHeight = originalMaxHeight;
      scroll.classList.remove('export-mode');
      F.UI.showToast('Erro: ' + err.message, 'error');
    } finally {
      F.UI.hideLoading();
    }
  }

  async function exportPDF() {
    F.UI.showLoading('Gerando PDF…');
    try {
      const ex = collectExportData();
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const margin = 8;
      const nameWidth = 55;
      const totalColWidth = 24;
      const usableWidth = pageW - 2 * margin - nameWidth - totalColWidth;
      const dateColWidth = 18;
      const datesPerPage = Math.max(3, Math.floor(usableWidth / dateColWidth));

      const s = document.getElementById('filter-start').value;
      const e = document.getElementById('filter-end').value;
      const periodText = `${F.Fmt.fmtFullDate(F.Dates.parseDateKey(s))} a ${F.Fmt.fmtFullDate(F.Dates.parseDateKey(e))}`;
      const modeText = viewMode === 'effective' ? 'Data efetiva' : 'Vencimento';

      const dateChunks = [];
      for (let i = 0; i < filteredDates.length; i += datesPerPage) {
        dateChunks.push(filteredDates.slice(i, i + datesPerPage));
      }

      dateChunks.forEach((chunk, chunkIdx) => {
        const chunkIndices = chunk.map(k => filteredDates.indexOf(k));
        const head = [['Fornecedor / Conta', ...chunk.map(k => {
          const d = F.Dates.parseDateKey(k);
          return `${F.Fmt.fmtHeaderDate(d)}\n${F.Fmt.weekdayShort(d)}`;
        }), 'Total']];

        const body = [];
        const rTotalChunk = chunkIndices.reduce((a, i) => a + ex.receberRow[i], 0);
        body.push([
          { content: 'Contas a Receber (Total)', styles: { fontStyle: 'bold', fillColor: [212, 234, 250], textColor: [10, 110, 158] } },
          ...chunkIndices.map(i => ({ content: fmtMoneyForPdf(ex.receberRow[i]), styles: { fontStyle: 'bold', fillColor: [212, 234, 250], textColor: [10, 110, 158] } })),
          { content: fmtMoneyForPdf(rTotalChunk), styles: { fontStyle: 'bold', fillColor: [212, 234, 250], textColor: [10, 110, 158] } },
        ]);
        const pTotalChunk = chunkIndices.reduce((a, i) => a + ex.totalPagarCells[i], 0);
        body.push([
          { content: 'Contas a Pagar (Total)', styles: { fontStyle: 'bold', fillColor: [252, 218, 217], textColor: [180, 35, 24] } },
          ...chunkIndices.map(i => ({ content: fmtMoneyForPdf(ex.totalPagarCells[i]), styles: { fontStyle: 'bold', fillColor: [252, 218, 217], textColor: [180, 35, 24] } })),
          { content: fmtMoneyForPdf(pTotalChunk), styles: { fontStyle: 'bold', fillColor: [252, 218, 217], textColor: [180, 35, 24] } },
        ]);
        ex.sortedGroups.forEach(g => {
          // Linha de categoria (fundo cinza claro, texto escuro)
          const catChunkTotal = chunkIndices.reduce((a, i) => {
            const dk = filteredDates[i];
            return a + (g.byDate.get(dk)?.total || 0);
          }, 0);
          body.push([
            { content: `▸ ${g.nome}`, styles: { fontStyle: 'bold', fillColor: [245, 247, 251], textColor: [10, 14, 22] } },
            ...chunkIndices.map(i => {
              const dk = filteredDates[i];
              const val = g.byDate.get(dk)?.total || 0;
              return { content: fmtMoneyForPdf(val), styles: { fontStyle: 'bold', fillColor: [245, 247, 251], textColor: [180, 35, 24] } };
            }),
            { content: fmtMoneyForPdf(catChunkTotal), styles: { fontStyle: 'bold', fillColor: [245, 247, 251], textColor: [180, 35, 24] } },
          ]);
          const sortedVendors = sortVendors(g.fornecedores, sortState);
          sortedVendors.forEach(v => {
            const cells = filteredDates.map(k => v.byDate.get(k)?.total || 0);
            const chunkTotal = chunkIndices.reduce((a, i) => a + cells[i], 0);
            body.push([`    ${v.name}`, ...chunkIndices.map(i => fmtMoneyForPdf(cells[i])), fmtMoneyForPdf(chunkTotal)]);
          });
        });
        const sTChunk = chunkIndices.reduce((a, i) => a + ex.saldoCells[i], 0);
        body.push([
          { content: 'Saldo do dia', styles: { fontStyle: 'bold', fillColor: [10, 14, 22], textColor: [255, 255, 255] } },
          ...chunkIndices.map(i => ({ content: fmtMoneyForPdf(ex.saldoCells[i]), styles: { fontStyle: 'bold', fillColor: [10, 14, 22], textColor: ex.saldoCells[i] >= 0 ? [28, 167, 236] : [255, 121, 113] } })),
          { content: fmtMoneyForPdf(sTChunk), styles: { fontStyle: 'bold', fillColor: [10, 14, 22], textColor: sTChunk >= 0 ? [28, 167, 236] : [255, 121, 113] } },
        ]);

        if (chunkIdx > 0) doc.addPage();
        doc.setFillColor(10, 14, 22);
        doc.rect(0, 0, pageW, 14, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.text('FILADELFIA · Fluxo de Caixa', margin, 9);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        const pageInfoText = dateChunks.length > 1 ? `Parte ${chunkIdx + 1}/${dateChunks.length} · ` : '';
        doc.text(`${pageInfoText}${periodText} · ${modeText}`, pageW - margin, 9, { align: 'right' });

        doc.autoTable({
          head: head,
          body: body,
          startY: 18,
          margin: { left: margin, right: margin },
          theme: 'grid',
          styles: { fontSize: 7.5, cellPadding: 2, lineColor: [228, 232, 238], lineWidth: 0.1, overflow: 'linebreak' },
          headStyles: { fillColor: [10, 14, 22], textColor: [255, 255, 255], fontStyle: 'bold', halign: 'right', fontSize: 8 },
          columnStyles: (() => {
            const styles = { 0: { cellWidth: nameWidth, halign: 'left', fontSize: 7, fontStyle: 'normal' } };
            chunk.forEach((_, idx) => { styles[idx + 1] = { halign: 'right', cellWidth: dateColWidth - 0.5 }; });
            styles[chunk.length + 1] = { halign: 'right', fontStyle: 'bold', cellWidth: totalColWidth };
            return styles;
          })(),
          didParseCell: (data) => {
            if (data.column.index === 0 && data.section === 'body' && data.cell.styles) {
              data.cell.styles.halign = 'left';
            }
          },
        });

        const pageCount = doc.internal.getNumberOfPages();
        doc.setTextColor(107, 114, 128);
        doc.setFontSize(7);
        doc.text(`Gerado em ${new Date().toLocaleString('pt-BR')} · R2 Soluções Empresariais · Página ${pageCount}`, pageW / 2, pageH - 4, { align: 'center' });
      });

      doc.save(getExportFilename('pdf'));
      F.UI.showToast('PDF gerado', 'success');
    } catch (err) {
      console.error(err);
      F.UI.showToast('Erro: ' + err.message, 'error');
    } finally {
      F.UI.hideLoading();
    }
  }

  function fmtMoneyForPdf(v) {
    if (Math.abs(v) < 0.005) return '–';
    return F.Fmt.fmtMoneyShort(v);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
