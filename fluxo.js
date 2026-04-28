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

  // Fase 3 — Saldos bancários
  let bancos = {};               // { bankId: { nome, tipo, ordem, arquivado } }
  let saldosHistorico = {};      // { eventId: { bankId, valor, ts, ... } }

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
        F.UI.updateSyncBadge('syncing', 'Atualizando');
        const data = await F.DB.fetchImportedData();
        if (!data) return;
        dataStore = data;
        F.Storage.safeSetJSON(F.KEYS.DATA, data);
        if (processed) {
          rebuildAndRender();
        } else {
          finishInit();
        }
        F.UI.updateSyncBadge('connected', 'Sincronizado');
      } catch (err) {
        console.error('Falha ao baixar dados importados:', err);
        F.UI.updateSyncBadge('offline', 'Erro');
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

    // Fase 3 — bancos e saldos
    unsubscribes.push(F.DB.subscribeBancos(data => {
      bancos = data || {};
      renderSaldosPanel();
    }));
    unsubscribes.push(F.DB.subscribeSaldosHistorico(data => {
      saldosHistorico = data || {};
      renderSaldosPanel();
    }));
    // Cria bancos padrão se for a primeira vez (só roda se for editor+)
    F.DB.ensureDefaultBanks().catch(err => console.warn('Bancos padrão:', err));

    // Garante que a categoria nativa existe
    F.DB.ensureDefaultCategory().catch(err => console.warn('Categoria padrão:', err));

    // Assinatura de comentários (usa listener direto pois precisamos do snap completo)
    const commentsRef = F.state.fbDB.ref('filadelfia/comentarios');
    const commentsHandler = snap => {
      commentsCache = snap.val() || {};
      if (processed) render();
      if (currentDetail) refreshDetailComments();
    };
    const commentsErrHandler = err => {
      console.error('Firebase comments error:', err);
      F.UI.updateSyncBadge('offline', 'Erro de conexão');
    };
    commentsRef.on('value', commentsHandler, commentsErrHandler);
    // Adiciona ao unsubscribes para cleanup em nova subscribeAll (evita leak / listener dobrado)
    unsubscribes.push(() => commentsRef.off('value', commentsHandler));
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

    // Ajusta filtro para garantir que a data está visível.
    // Validação mais permissiva: aceita se a data estiver dentro do range
    // entre o primeiro e último dia de allDates (ainda que não haja movimento
    // exatamente naquele dia).
    const allDates = processed.allDates;
    const inPeriod = allDates.length && date >= allDates[0] && date <= allDates[allDates.length - 1];
    // Fallback: checar também o período importado (pode ser mais amplo que allDates)
    const importStart = dataStore?.periodStart;
    const importEnd = dataStore?.periodEnd;
    const inImportPeriod = importStart && importEnd && date >= importStart && date <= importEnd;

    if (!inPeriod && !inImportPeriod) {
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
          // Normaliza qualquer separador (ponto, underscore, múltiplos espaços) em espaço único
          // para comparar com tolerância, já que o parse da key perde os pontos originais.
          const normalize = s => String(s || '').toUpperCase().replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
          const target = normalize(vendorUpper);
          const match = processed.vendors.find(v => normalize(v.name) === target);
          if (match) {
            openDetail('pagar', date, match.name);
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

    // Listeners da recorrência (Fase 5)
    const recurCheck = document.getElementById('form-recurrence');
    const recurOpts = document.getElementById('form-recurrence-options');
    if (recurCheck && recurOpts) {
      recurCheck.addEventListener('change', () => {
        recurOpts.style.display = recurCheck.checked ? 'block' : 'none';
        updateRecurrencePreview();
      });
    }
    ['form-date', 'form-recurrence-freq', 'form-recurrence-end'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', updateRecurrencePreview);
    });

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

    // Preserva posição de scroll (horizontal e vertical) da grade antes do re-render
    const scrollEl = document.getElementById('grid-scroll');
    const prevScrollLeft = scrollEl?.scrollLeft || 0;
    const prevScrollTop = scrollEl?.scrollTop || 0;

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

    // Restaura posição de scroll após re-render (evita "pulo" quando update vem via Firebase)
    if (scrollEl && (prevScrollLeft > 0 || prevScrollTop > 0)) {
      // requestAnimationFrame garante que o layout foi aplicado antes de restaurar
      requestAnimationFrame(() => {
        scrollEl.scrollLeft = prevScrollLeft;
        scrollEl.scrollTop = prevScrollTop;
      });
    }

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
    // Expõe flags de render atual no dataset do grid (acessível pelo delegate)
    grid.dataset.hasReceberManual = hasReceberManual ? '1' : '0';

    // Delegação de eventos no #grid-scroll — registra UMA VEZ por sessão.
    // Usa variável de módulo (_toggleDelegateRegistered) em vez de propriedade DOM
    // para garantir que o flag não se perca entre re-renders.
    setupToggleDelegate();
  }

  let _toggleDelegateRegistered = false;
  function setupToggleDelegate() {
    if (_toggleDelegateRegistered) return;
    const gridScroll = document.getElementById('grid-scroll');
    if (!gridScroll) return;
    _toggleDelegateRegistered = true;
    console.log('[Toggle] Registrando listener delegate no #grid-scroll (uma vez)');

    gridScroll.addEventListener('click', (e) => {
      const target = e.target;
      const grid = document.getElementById('grid');

      // Toggle categoria (mais específico primeiro)
      const catRow = target.closest('[data-toggle-cat]');
      if (catRow) {
        const cid = catRow.dataset.toggleCat;
        if (expandedCategories.has(cid)) expandedCategories.delete(cid);
        else expandedCategories.add(cid);
        render();
        return;
      }

      // Toggle linha "Contas a Pagar (Total)"
      const pagarRow = target.closest('[data-toggle-pagar]');
      if (pagarRow) {
        expandedPagarTotal = !expandedPagarTotal;
        render();
        return;
      }

      // Toggle linha "Contas a Receber (Total)"
      const receberRow = target.closest('[data-toggle-receber]');
      if (receberRow) {
        // Ignora clique em células com data-detail ou data-add (cliques em valores reais)
        const td = target.closest('td');
        if (td && (td.hasAttribute('data-detail') || td.hasAttribute('data-add'))) return;
        if (grid && grid.dataset.hasReceberManual !== '1') return;
        expandedReceber = !expandedReceber;
        render();
        return;
      }
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
    // Reset recorrência
    const recurCheck = document.getElementById('form-recurrence');
    if (recurCheck) recurCheck.checked = false;
    const recurOpts = document.getElementById('form-recurrence-options');
    if (recurOpts) recurOpts.style.display = 'none';
    const recurFreq = document.getElementById('form-recurrence-freq');
    if (recurFreq) recurFreq.value = 'mensal';
    const recurEnd = document.getElementById('form-recurrence-end');
    if (recurEnd) {
      // Default: 12 meses à frente
      const dEnd = F.Dates.addDays(new Date(), 365);
      recurEnd.value = F.Dates.dateKey(dEnd);
    }
    updateRecurrencePreview();
    document.getElementById('form-modal').classList.add('open');
    setTimeout(() => document.getElementById('form-entity').focus(), 100);
  }

  // Atualiza a prévia ao mudar campos
  function updateRecurrencePreview() {
    const preview = document.getElementById('form-recurrence-preview');
    if (!preview) return;
    const checked = document.getElementById('form-recurrence')?.checked;
    if (!checked) return;
    const startStr = document.getElementById('form-date')?.value;
    const freq = document.getElementById('form-recurrence-freq')?.value || 'mensal';
    const endStr = document.getElementById('form-recurrence-end')?.value;
    if (!startStr || !endStr) { preview.innerHTML = 'Preencha a data de vencimento e a data final.'; return; }
    const dates = generateRecurrenceDates(startStr, endStr, freq);
    if (!dates.length) { preview.innerHTML = '<span style="color: var(--danger-text);">A data final é anterior à data inicial.</span>'; return; }
    const count = dates.length;
    const first = F.Fmt.fmtFullDate(F.Dates.parseDateKey(dates[0]));
    const last = F.Fmt.fmtFullDate(F.Dates.parseDateKey(dates[dates.length - 1]));
    preview.innerHTML = `Serão criados <b>${count} lançamento${count !== 1 ? 's' : ''}</b>, de ${F.escapeHTML(first)} a ${F.escapeHTML(last)}.`;
  }

  // Gera lista de datas (YYYY-MM-DD) desde startStr até endStr inclusive, seguindo a frequência
  function generateRecurrenceDates(startStr, endStr, freq) {
    const start = F.Dates.parseDateKey(startStr);
    const end = F.Dates.parseDateKey(endStr);
    if (!start || !end || end < start) return [];
    const out = [];
    const originalDay = start.getDate(); // Preserva o "dia alvo" (ex: 31) para que cada mês use esse dia ou o último dia se não existir
    let cur = new Date(start);
    // Hard limit para evitar loops gigantes (10 anos de semanal = 520 = OK)
    let safetyLimit = 600;

    // Helper: avança para o próximo mês/ano preservando o dia original, sem transbordar
    function advanceMonth(d, monthsToAdd) {
      const y = d.getFullYear();
      const m = d.getMonth() + monthsToAdd;
      // Último dia do mês alvo
      const lastDayOfTarget = new Date(y, m + 1, 0).getDate();
      // Se o dia original cabe no novo mês, usa ele; senão, usa o último dia do novo mês
      const targetDay = Math.min(originalDay, lastDayOfTarget);
      return new Date(y, m, targetDay);
    }

    while (cur <= end && safetyLimit-- > 0) {
      out.push(F.Dates.dateKey(cur));
      if (freq === 'semanal') cur = F.Dates.addDays(cur, 7);
      else if (freq === 'quinzenal') cur = F.Dates.addDays(cur, 14);
      else if (freq === 'mensal') cur = advanceMonth(cur, 1);
      else if (freq === 'anual') cur = advanceMonth(cur, 12);
      else break;
    }
    return out;
  }

  let _salvandoProvision = false;
  async function saveProvision() {
    if (_salvandoProvision) return; // Guard contra double submit
    const tipo = document.getElementById('form-type-toggle').querySelector('.active').dataset.type;
    const entidade = document.getElementById('form-entity').value.trim().toUpperCase();
    const dateVal = document.getElementById('form-date').value;
    const valor = parseFloat(document.getElementById('form-value').value);
    const documento = document.getElementById('form-doc').value.trim();
    const nota = document.getElementById('form-note').value.trim();
    const recurChecked = document.getElementById('form-recurrence')?.checked;
    const recurFreq = document.getElementById('form-recurrence-freq')?.value || 'mensal';
    const recurEnd = document.getElementById('form-recurrence-end')?.value;

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

    // Se recorrência ativada, monta lista de datas
    let datasParaCriar = [dateVal];
    if (recurChecked) {
      if (!recurEnd) { F.UI.showToast('Informe a data final da recorrência', 'error'); return; }
      datasParaCriar = generateRecurrenceDates(dateVal, recurEnd, recurFreq);
      if (!datasParaCriar.length) { F.UI.showToast('A data final deve ser posterior à inicial', 'error'); return; }
      if (datasParaCriar.length > 200) {
        if (!confirm(`Vão ser criados ${datasParaCriar.length} lançamentos. Continuar?`)) return;
      }
    }

    F.UI.showLoading(recurChecked ? `Criando ${datasParaCriar.length} lançamentos…` : 'Salvando…');
    _salvandoProvision = true;
    try {
      // Gera um seriesId único para agrupar todos os lançamentos da mesma recorrência
      const seriesId = recurChecked
        ? ('rec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8))
        : null;
      let criados = 0;
      for (const d of datasParaCriar) {
        const payload = { tipo, entidade, vencimento: d, valor, documento, nota };
        if (seriesId) {
          payload.seriesId = seriesId;
          payload.seriesFreq = recurFreq;
        }
        await F.DB.createLancamento(payload);
        criados++;
      }
      document.getElementById('form-modal').classList.remove('open');
      if (recurChecked) {
        F.UI.showToast(`${criados} lançamento${criados !== 1 ? 's' : ''} criado${criados !== 1 ? 's' : ''}`, 'success');
      } else {
        F.UI.showToast('Lançamento manual criado', 'success');
      }
    } catch (err) {
      console.error(err);
      F.UI.showToast('Erro ao salvar: ' + err.message, 'error');
    } finally {
      F.UI.hideLoading();
      _salvandoProvision = false;
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
      if (!_initDone) {
        setupControls();
        _initDone = true;
      }
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
    if (!F.state.user?.uid) { F.UI.showToast('Sessão expirada. Faça login novamente.', 'error'); return; }

    const key = commentKeyFor(currentDetail.kind, currentDetail.dateKey, currentDetail.vendorName);
    const payload = {
      author: F.state.user.displayName || F.state.user.email || 'Anônimo',
      authorUid: F.state.user.uid,
      authorEmail: F.state.user.email || null,
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
    // Usa soft-delete (marca deleted:true) em vez de remover, para preservar histórico
    F.DB.deleteComment(key, commentId)
      .then(() => F.UI.showToast('Comentário excluído', 'success'))
      .catch(err => {
        console.error(err);
        F.UI.showToast('Erro ao excluir: ' + (err?.message || ''), 'error');
      });
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

  /* ========================================================================
     FASE 3 — PAINEL DE SALDOS BANCÁRIOS
     ======================================================================== */

  // Retorna a sigla curta (2-3 letras) para o badge do banco
  function bankBadge(nome) {
    const n = (nome || '').trim();
    if (!n) return '?';
    // Caso especial: bancos comuns
    const map = {
      'ABC': 'ABC', 'ITAU': 'IT', 'SAFRA': 'SA', 'BRADESCO': 'BR',
      'CAIXA': 'CX', 'C6': 'C6', 'BANCO DO BRASIL': 'BB', 'SANTANDER': 'ST',
      'ASA': 'AS', 'SOFISA': 'SO',
    };
    if (map[n]) return map[n];
    // Se começa com "VINCULADA" ou "GARANTIDA", usar sigla do banco
    const parts = n.split(/\s+/);
    if (parts[0] === 'VINCULADA' || parts[0] === 'GARANTIDA') {
      const base = parts.slice(1).join(' ');
      if (map[base]) return '⦁' + map[base];
      return parts[1] ? parts[1].slice(0, 2) : 'V';
    }
    // Fallback: primeiras 2 letras
    return n.slice(0, 2);
  }

  // Render principal do painel de saldos
  function renderSaldosPanel() {
    const wrap = document.querySelector('.saldos-wrap');
    if (!wrap) return;

    // Se há um saldo em edição ativa, NÃO re-renderiza (senão perde o input que o usuário está digitando)
    const emEdicao = wrap.querySelector('[data-editing="true"]');
    if (emEdicao) {
      console.log('[Saldos] Render pulado: saldo em edição');
      return;
    }

    const bancosAtivos = Object.entries(bancos).filter(([id, b]) => b && !b.arquivado);

    // Painel SEMPRE visível (permite criar primeiros bancos)
    wrap.style.display = '';

    // Aplicar role guards (esconde "Nova conta" de viewers)
    F.UI.applyRoleGuards(wrap);

    // Saldos atuais (último lançamento de cada banco)
    const atuais = F.DB.computeCurrentSaldos(saldosHistorico);

    // Separa por tipo e ordena
    const livres = bancosAtivos
      .filter(([id, b]) => b.tipo === 'livre')
      .sort(([idA, a], [idB, b]) => (a.ordem || 999) - (b.ordem || 999) || (a.nome || '').localeCompare(b.nome || ''));
    const vinculadas = bancosAtivos
      .filter(([id, b]) => b.tipo === 'vinculada')
      .sort(([idA, a], [idB, b]) => (a.ordem || 999) - (b.ordem || 999) || (a.nome || '').localeCompare(b.nome || ''));

    // Calcula totais por grupo
    let totalLivre = 0, totalVinculada = 0;
    let countLivreComSaldo = 0, countVincComSaldo = 0;
    livres.forEach(([id]) => {
      const s = atuais[id];
      if (s) { totalLivre += s.valor; countLivreComSaldo++; }
    });
    vinculadas.forEach(([id]) => {
      const s = atuais[id];
      if (s) { totalVinculada += s.valor; countVincComSaldo++; }
    });
    const totalGeral = totalLivre + totalVinculada;

    // Totalizadores
    const setTotal = (elId, val) => {
      const el = document.getElementById(elId);
      if (!el) return;
      el.textContent = F.Fmt.fmtMoney(val);
      el.classList.toggle('neg', val < 0);
    };
    setTotal('saldo-total-livre', totalLivre);
    setTotal('saldo-total-vinculada', totalVinculada);
    setTotal('saldo-total-geral', totalGeral);
    const metaLivre = document.getElementById('saldo-total-livre-meta');
    if (metaLivre) metaLivre.textContent = `${countLivreComSaldo} de ${livres.length} com saldo`;
    const metaVinc = document.getElementById('saldo-total-vinculada-meta');
    if (metaVinc) metaVinc.textContent = `${countVincComSaldo} de ${vinculadas.length} com saldo`;

    // Listas
    renderSaldoList('saldos-lista-livres', livres, atuais);
    renderSaldoList('saldos-lista-vinculadas', vinculadas, atuais);
  }

  function renderSaldoList(elId, bancosList, atuais) {
    const el = document.getElementById(elId);
    if (!el) return;
    const canEdit = F.Auth.isEditor();
    const isAdminUser = F.Auth.isAdmin();

    if (!bancosList.length) {
      // Se é o grupo de livres e ainda não tem nenhum banco no sistema, mostra botão de cadastro padrão
      const totalBancos = Object.keys(bancos).length;
      if (elId === 'saldos-lista-livres' && totalBancos === 0 && canEdit) {
        el.innerHTML = `
          <div style="padding: 24px 20px; text-align: center;">
            <div style="color: var(--text-muted); font-size: 12.5px; margin-bottom: 12px;">
              Ainda não há contas bancárias cadastradas.
            </div>
            <button class="btn" id="btn-cadastrar-bancos-padrao">+ Cadastrar 19 bancos padrão</button>
            <div style="color: var(--text-muted); font-size: 10.5px; margin-top: 8px; font-family: 'JetBrains Mono', monospace;">
              ABC, ITAU, SAFRA, BRADESCO, CAIXA, C6, BB, SANTANDER, ASA, SOFISA + 9 vinculadas
            </div>
          </div>
        `;
        document.getElementById('btn-cadastrar-bancos-padrao')?.addEventListener('click', async () => {
          try {
            F.UI.showLoading('Cadastrando bancos padrão…');
            await F.DB.ensureDefaultBanks();
            F.UI.showToast('19 bancos cadastrados', 'success');
          } catch (err) {
            F.UI.showToast('Erro: ' + err.message, 'error');
            console.error(err);
          } finally {
            F.UI.hideLoading();
          }
        });
      } else {
        el.innerHTML = '<div style="padding: 16px; color: var(--text-muted); font-size: 12px; text-align: center; font-style: italic;">Nenhuma conta neste grupo.</div>';
      }
      return;
    }

    el.innerHTML = bancosList.map(([id, b]) => {
      const saldo = atuais[id];
      const valorDisplay = saldo ? F.Fmt.fmtMoney(saldo.valor) : '— sem saldo —';
      const valorClass = saldo ? (saldo.valor < 0 ? 'neg' : '') : 'empty';
      const ts = saldo ? F.Fmt.fmtRelativeTime(saldo.ts) : 'nunca lançado';
      const author = saldo ? ' · ' + F.escapeHTML(saldo.authorName || 'Anônimo') : '';
      return `
        <div class="saldo-item tipo-${F.escapeHTML(b.tipo)}" data-bank-id="${F.escapeHTML(id)}">
          <div class="bank-badge" title="${F.escapeHTML(b.nome)}">${F.escapeHTML(bankBadge(b.nome))}</div>
          <div class="bank-info">
            <div class="bank-nome" title="${F.escapeHTML(b.nome)}">${F.escapeHTML(b.nome)}</div>
            <div class="bank-ts">Atualizado ${F.escapeHTML(ts)}${author}</div>
          </div>
          <div class="bank-valor ${valorClass}" ${canEdit ? 'data-editable="true"' : ''} title="${canEdit ? 'Clique para editar' : 'Somente leitura'}">${F.escapeHTML(valorDisplay)}</div>
          ${isAdminUser ? `<button class="bank-delete" data-delete-bank="${F.escapeHTML(id)}" title="Arquivar esta conta">×</button>` : ''}
        </div>
      `;
    }).join('');

    // Handlers de edição inline
    if (canEdit) {
      el.querySelectorAll('[data-editable="true"]').forEach(cell => {
        cell.addEventListener('click', () => startEditSaldo(cell));
      });
    }

    // Handler de arquivamento (admin)
    if (isAdminUser) {
      el.querySelectorAll('[data-delete-bank]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const bankId = btn.dataset.deleteBank;
          const banco = bancos[bankId];
          if (!banco) return;
          if (!confirm(`Arquivar a conta "${banco.nome}"?\n\nO histórico de saldos será preservado, mas a conta não aparecerá mais no painel.`)) return;
          try {
            await F.DB.deleteBank(bankId);
            F.UI.showToast('Conta arquivada', 'success');
          } catch (err) {
            F.UI.showToast('Erro: ' + err.message, 'error');
          }
        });
      });
    }
  }

  function startEditSaldo(cell) {
    if (cell.dataset.editing === 'true') return;
    const item = cell.closest('.saldo-item');
    if (!item) return;
    const bankId = item.dataset.bankId;
    const currentText = cell.textContent.trim();
    // Extrair valor atual (se houver) para pre-fill
    const match = currentText.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
    const currentValue = parseFloat(match);
    const preFill = Number.isFinite(currentValue) ? currentValue.toFixed(2).replace('.', ',') : '';

    cell.dataset.editing = 'true';
    const origClass = cell.className;
    cell.innerHTML = `<input type="text" class="bank-valor-input" placeholder="0,00" value="${preFill}" inputmode="decimal" />`;
    const input = cell.querySelector('input');
    input.focus();
    input.select();

    let committed = false;

    async function commit() {
      if (committed) return;
      committed = true;
      const raw = input.value.trim();
      cell.dataset.editing = 'false';
      // Cancelar se vazio ou igual ao atual
      if (!raw) {
        renderSaldosPanel();
        return;
      }
      // Parse "1.234,56" ou "1234.56" ou "1234,56"
      const val = parseValueFlex(raw);
      if (!Number.isFinite(val)) {
        F.UI.showToast('Valor inválido', 'error');
        renderSaldosPanel();
        return;
      }
      try {
        await F.DB.createSaldo(bankId, val);
        F.UI.showToast('Saldo lançado', 'success');
        // render acontece automaticamente via subscribe
      } catch (err) {
        F.UI.showToast('Erro: ' + err.message, 'error');
        renderSaldosPanel();
      }
    }

    function cancel() {
      if (committed) return;
      committed = true;
      cell.dataset.editing = 'false';
      renderSaldosPanel();
    }

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
  }

  // Parser flexível: aceita "1.234,56", "1234.56", "1234,56", "1234", "-500"
  function parseValueFlex(s) {
    if (typeof s !== 'string') return NaN;
    let str = s.trim();
    if (!str) return NaN;
    const neg = str.startsWith('-');
    if (neg) str = str.slice(1);
    // Remove R$ se houver
    str = str.replace(/R\$\s*/i, '');
    // Se tem vírgula e ponto: ponto = milhar, vírgula = decimal
    if (str.includes(',') && str.includes('.')) {
      str = str.replace(/\./g, '').replace(',', '.');
    } else if (str.includes(',')) {
      str = str.replace(',', '.');
    }
    // Se não tem separador decimal e tem mais de 2 dígitos no fim, assume que é inteiro
    const n = parseFloat(str);
    if (!Number.isFinite(n)) return NaN;
    return neg ? -n : n;
  }

  /* ========== Modal: Histórico de saldos ========== */
  function openSaldosHistorico() {
    const modal = document.getElementById('saldos-historico-modal');
    if (!modal) return;
    modal.classList.add('open');
    renderSaldosHistorico();
    // Popular select
    const sel = document.getElementById('saldos-hist-banco-filter');
    if (sel) {
      const bancosOrdenados = Object.entries(bancos)
        .filter(([id, b]) => b)
        .sort(([, a], [, b]) => (a.ordem || 999) - (b.ordem || 999));
      sel.innerHTML = '<option value="">Todos os bancos</option>' +
        bancosOrdenados.map(([id, b]) => `<option value="${F.escapeHTML(id)}">${F.escapeHTML(b.nome)}</option>`).join('');
    }
  }

  function renderSaldosHistorico() {
    const tbody = document.getElementById('saldos-hist-tbody');
    if (!tbody) return;
    const filtro = document.getElementById('saldos-hist-banco-filter')?.value || '';
    let entries = Object.entries(saldosHistorico)
      .map(([id, v]) => ({ id, ...v }))
      .filter(e => e && e.bankId);
    if (filtro) entries = entries.filter(e => e.bankId === filtro);
    entries.sort((a, b) => (b.ts || 0) - (a.ts || 0));

    document.getElementById('saldos-hist-sub').textContent =
      `${entries.length} lançamento${entries.length !== 1 ? 's' : ''}`;

    if (!entries.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="hist-empty">Nenhum lançamento registrado</td></tr>';
      return;
    }

    tbody.innerHTML = entries.map(e => {
      const banco = bancos[e.bankId];
      const nomeBanco = banco ? banco.nome : `(conta removida: ${e.bankId})`;
      const when = F.Fmt.fmtDateTimeFull(new Date(e.ts || 0));
      const valorClass = e.valor < 0 ? 'hist-valor neg' : 'hist-valor';
      return `
        <tr>
          <td style="font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--text-muted); white-space: nowrap;">${F.escapeHTML(when)}</td>
          <td><b>${F.escapeHTML(nomeBanco)}</b></td>
          <td class="${valorClass}">${F.Fmt.fmtMoney(e.valor)}</td>
          <td style="font-size: 11.5px;">${F.escapeHTML(e.authorName || '—')}</td>
        </tr>
      `;
    }).join('');
  }

  function closeSaldosHistorico() {
    const modal = document.getElementById('saldos-historico-modal');
    if (modal) modal.classList.remove('open');
  }

  /* ========== Modal: Nova conta bancária ========== */
  function openNovoBanco() {
    if (!F.Auth.isEditor()) {
      F.UI.showToast('Apenas editores e admins podem criar contas', 'warning');
      return;
    }
    const modal = document.getElementById('novo-banco-modal');
    if (!modal) return;
    modal.classList.add('open');
    const nomeInput = document.getElementById('novo-banco-nome');
    const tipoSel = document.getElementById('novo-banco-tipo');
    if (nomeInput) { nomeInput.value = ''; nomeInput.focus(); }
    if (tipoSel) tipoSel.value = 'livre';
  }

  function closeNovoBanco() {
    const modal = document.getElementById('novo-banco-modal');
    if (modal) modal.classList.remove('open');
  }

  async function salvarNovoBanco() {
    const nome = (document.getElementById('novo-banco-nome')?.value || '').trim().toUpperCase();
    const tipo = document.getElementById('novo-banco-tipo')?.value || 'livre';
    if (!nome) {
      F.UI.showToast('Informe o nome do banco', 'warning');
      return;
    }
    // Evita duplicata pelo nome
    const duplicate = Object.values(bancos).find(b => b && b.nome === nome && !b.arquivado);
    if (duplicate) {
      F.UI.showToast('Já existe uma conta com esse nome', 'warning');
      return;
    }
    try {
      F.UI.showLoading('Criando conta…');
      // Define ordem: 999 + número de contas do tipo (adiciona ao fim)
      const countSameType = Object.values(bancos).filter(b => b && b.tipo === tipo && !b.arquivado).length;
      const ordem = (tipo === 'vinculada' ? 400 : 200) + countSameType;
      await F.DB.createBank(nome, tipo, ordem);
      F.UI.showToast('Conta criada', 'success');
      closeNovoBanco();
    } catch (err) {
      F.UI.showToast('Erro: ' + err.message, 'error');
    } finally {
      F.UI.hideLoading();
    }
  }

  /* ========== Modal: Lançar saldo (via botão dedicado) ========== */
  function openLancarSaldo() {
    if (!F.Auth.isEditor()) {
      F.UI.showToast('Apenas editores e admins podem lançar saldos', 'warning');
      return;
    }
    const modal = document.getElementById('lancar-saldo-modal');
    if (!modal) return;

    // Popular dropdown de bancos (agrupados por tipo)
    const select = document.getElementById('lancar-saldo-banco');
    const bancosAtivos = Object.entries(bancos)
      .filter(([id, b]) => b && !b.arquivado)
      .sort(([, a], [, b]) => (a.ordem || 999) - (b.ordem || 999));

    if (!bancosAtivos.length) {
      // Tenta criar os 19 bancos padrão agora mesmo (último recurso)
      F.UI.showLoading('Cadastrando contas bancárias padrão…');
      F.DB.ensureDefaultBanks()
        .then(() => {
          F.UI.hideLoading();
          // O subscribe do Firebase vai disparar e atualizar "bancos".
          // Esperar 500ms para o Firebase sincronizar antes de reabrir.
          setTimeout(() => {
            const ativos = Object.values(bancos).filter(b => b && !b.arquivado).length;
            if (ativos > 0) {
              F.UI.showToast('Contas cadastradas. Abrindo modal…', 'success');
              openLancarSaldo(); // reabre
            } else {
              F.UI.showToast('Não foi possível cadastrar as contas. Abra o console (F12) e verifique erros, ou use o botão "+ Nova conta" no painel.', 'error');
            }
          }, 700);
        })
        .catch(err => {
          F.UI.hideLoading();
          console.error(err);
          F.UI.showToast('Erro ao cadastrar contas: ' + err.message + '. Verifique as rules do Firebase (veja LEIA-ME.md).', 'error');
        });
      return;
    }

    const livres = bancosAtivos.filter(([, b]) => b.tipo === 'livre');
    const vinculadas = bancosAtivos.filter(([, b]) => b.tipo === 'vinculada');
    const atuais = F.DB.computeCurrentSaldos(saldosHistorico);

    let html = '<option value="">Selecione uma conta…</option>';
    if (livres.length) {
      html += '<optgroup label="Contas correntes">';
      livres.forEach(([id, b]) => {
        const saldoAtual = atuais[id];
        const hint = saldoAtual ? ' — atual: ' + F.Fmt.fmtMoney(saldoAtual.valor) : ' — sem saldo';
        html += `<option value="${F.escapeHTML(id)}">${F.escapeHTML(b.nome)}${F.escapeHTML(hint)}</option>`;
      });
      html += '</optgroup>';
    }
    if (vinculadas.length) {
      html += '<optgroup label="Vinculadas / Garantidas">';
      vinculadas.forEach(([id, b]) => {
        const saldoAtual = atuais[id];
        const hint = saldoAtual ? ' — atual: ' + F.Fmt.fmtMoney(saldoAtual.valor) : ' — sem saldo';
        html += `<option value="${F.escapeHTML(id)}">${F.escapeHTML(b.nome)}${F.escapeHTML(hint)}</option>`;
      });
      html += '</optgroup>';
    }
    select.innerHTML = html;

    document.getElementById('lancar-saldo-valor').value = '';
    document.getElementById('lancar-saldo-preview').style.display = 'none';
    modal.classList.add('open');
    setTimeout(() => select.focus(), 100);
  }

  function closeLancarSaldo() {
    const modal = document.getElementById('lancar-saldo-modal');
    if (modal) modal.classList.remove('open');
  }

  function updateLancarSaldoPreview() {
    const bankId = document.getElementById('lancar-saldo-banco').value;
    const raw = document.getElementById('lancar-saldo-valor').value.trim();
    const preview = document.getElementById('lancar-saldo-preview');
    if (!bankId || !raw) {
      preview.style.display = 'none';
      return;
    }
    const val = parseValueFlex(raw);
    if (!Number.isFinite(val)) {
      preview.style.display = 'none';
      return;
    }
    const banco = bancos[bankId];
    if (!banco) { preview.style.display = 'none'; return; }
    preview.style.display = 'block';
    preview.innerHTML = `Você vai lançar <b>${F.Fmt.fmtMoney(val)}</b> como saldo atual de <b>${F.escapeHTML(banco.nome)}</b>.`;
  }

  let _salvandoSaldo = false;
  async function salvarLancarSaldo() {
    if (_salvandoSaldo) return; // Guard contra double submit (Enter + Click simultâneos)
    const bankId = document.getElementById('lancar-saldo-banco').value;
    const raw = document.getElementById('lancar-saldo-valor').value.trim();
    if (!bankId) { F.UI.showToast('Selecione uma conta', 'warning'); return; }
    if (!raw) { F.UI.showToast('Informe o valor do saldo', 'warning'); return; }
    const val = parseValueFlex(raw);
    if (!Number.isFinite(val)) { F.UI.showToast('Valor inválido', 'error'); return; }
    _salvandoSaldo = true;
    try {
      F.UI.showLoading('Salvando saldo…');
      await F.DB.createSaldo(bankId, val);
      F.UI.showToast('Saldo lançado', 'success');
      closeLancarSaldo();
    } catch (err) {
      F.UI.showToast('Erro: ' + err.message, 'error');
    } finally {
      F.UI.hideLoading();
      _salvandoSaldo = false;
    }
  }

  /* ========== Setup dos handlers de saldos (chamado no init) ========== */
  function setupSaldosHandlers() {
    document.getElementById('btn-saldos-historico')?.addEventListener('click', openSaldosHistorico);
    document.getElementById('btn-saldos-novo-banco')?.addEventListener('click', openNovoBanco);
    document.getElementById('btn-salvar-novo-banco')?.addEventListener('click', salvarNovoBanco);
    document.getElementById('saldos-hist-banco-filter')?.addEventListener('change', renderSaldosHistorico);

    // Lançar saldo (modal novo)
    document.getElementById('btn-lancar-saldo')?.addEventListener('click', openLancarSaldo);
    document.getElementById('btn-salvar-lancar-saldo')?.addEventListener('click', salvarLancarSaldo);
    document.getElementById('lancar-saldo-banco')?.addEventListener('change', updateLancarSaldoPreview);
    document.getElementById('lancar-saldo-valor')?.addEventListener('input', updateLancarSaldoPreview);
    document.getElementById('lancar-saldo-valor')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); salvarLancarSaldo(); }
    });

    // Exportar (dropdown)
    const btnExport = document.getElementById('btn-saldos-export');
    const menuExport = document.getElementById('saldos-export-menu');
    if (btnExport && menuExport) {
      btnExport.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = menuExport.classList.toggle('open');
        btnExport.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      });
      // Fecha ao clicar fora
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.saldos-export-wrap')) {
          menuExport.classList.remove('open');
          btnExport.setAttribute('aria-expanded', 'false');
        }
      });
      // Itens do menu
      menuExport.querySelectorAll('.saldos-export-item').forEach(item => {
        item.addEventListener('click', () => {
          menuExport.classList.remove('open');
          btnExport.setAttribute('aria-expanded', 'false');
          const formato = item.dataset.export;
          if (formato === 'pdf') exportarSaldosPDF();
          else if (formato === 'png') exportarSaldosPNG();
        });
      });
    }

    // Fechar modais
    document.querySelectorAll('[data-close="saldos-historico"]').forEach(el => {
      el.addEventListener('click', closeSaldosHistorico);
    });
    document.querySelectorAll('[data-close="novo-banco"]').forEach(el => {
      el.addEventListener('click', closeNovoBanco);
    });
    document.querySelectorAll('[data-close="lancar-saldo"]').forEach(el => {
      el.addEventListener('click', closeLancarSaldo);
    });
    // Fechar ao clicar fora do modal (no overlay)
    document.getElementById('saldos-historico-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'saldos-historico-modal') closeSaldosHistorico();
    });
    document.getElementById('novo-banco-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'novo-banco-modal') closeNovoBanco();
    });
    document.getElementById('lancar-saldo-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'lancar-saldo-modal') closeLancarSaldo();
    });

    // ESC fecha modais
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const histOpen = document.getElementById('saldos-historico-modal')?.classList.contains('open');
      const novoOpen = document.getElementById('novo-banco-modal')?.classList.contains('open');
      const lancOpen = document.getElementById('lancar-saldo-modal')?.classList.contains('open');
      if (histOpen) closeSaldosHistorico();
      if (novoOpen) closeNovoBanco();
      if (lancOpen) closeLancarSaldo();
    });
  }

  /* ========== Exportação dos Saldos Bancários ========== */

  // Helper: prepara o card de saldos para exportação (esconde botões, mostra timestamp)
  function _prepareSaldosForExport() {
    const card = document.querySelector('.saldos-card');
    const ts = document.getElementById('saldos-export-timestamp');
    if (!card || !ts) return null;

    // Formata data/hora atual no horário de Brasília (UTC-3)
    const agora = new Date();
    const fmt = new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    });
    const partes = fmt.formatToParts(agora);
    const dia = partes.find(p => p.type === 'day').value;
    const mes = partes.find(p => p.type === 'month').value;
    const ano = partes.find(p => p.type === 'year').value;
    const hora = partes.find(p => p.type === 'hour').value;
    const min = partes.find(p => p.type === 'minute').value;
    const tsTexto = `Exportado em ${dia}/${mes}/${ano} às ${hora}:${min}`;

    ts.textContent = tsTexto;
    ts.classList.add('show');
    card.classList.add('exporting');

    return { card, ts, tsTexto, agora };
  }

  function _restoreSaldosAfterExport(state) {
    if (!state) return;
    state.card.classList.remove('exporting');
    state.ts.classList.remove('show');
    state.ts.textContent = '';
  }

  // Filename helper: "saldos-bancarios-AAAA-MM-DD-HHMM"
  function _saldosFilename(agora, ext) {
    const fmt = new Intl.DateTimeFormat('sv-SE', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    });
    const stamp = fmt.format(agora).replace(/[\s:]/g, '-');
    return `saldos-bancarios-${stamp}.${ext}`;
  }

  async function exportarSaldosPNG() {
    const state = _prepareSaldosForExport();
    if (!state) return;
    try {
      F.UI.showLoading('Gerando imagem…');
      // pequeno delay para CSS aplicar
      await new Promise(r => setTimeout(r, 50));
      const canvas = await html2canvas(state.card, {
        backgroundColor: '#ffffff',
        scale: 2,
        useCORS: true,
        logging: false,
      });
      const dataUrl = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = _saldosFilename(state.agora, 'png');
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      F.UI.showToast('Imagem exportada com sucesso', 'success');
    } catch (err) {
      console.error(err);
      F.UI.showToast('Erro ao gerar imagem: ' + err.message, 'error');
    } finally {
      F.UI.hideLoading();
      _restoreSaldosAfterExport(state);
    }
  }

  async function exportarSaldosPDF() {
    const state = _prepareSaldosForExport();
    if (!state) return;
    try {
      F.UI.showLoading('Gerando PDF…');
      await new Promise(r => setTimeout(r, 50));
      const canvas = await html2canvas(state.card, {
        backgroundColor: '#ffffff',
        scale: 2,
        useCORS: true,
        logging: false,
      });
      const imgData = canvas.toDataURL('image/png');

      const { jsPDF } = window.jspdf;
      // Decidir orientação: se largura > altura, usa landscape
      const isLandscape = canvas.width > canvas.height;
      const pdf = new jsPDF({
        orientation: isLandscape ? 'landscape' : 'portrait',
        unit: 'mm',
        format: 'a4',
      });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 8;
      const maxW = pageWidth - margin * 2;
      const maxH = pageHeight - margin * 2;
      // Calcular escala mantendo proporção
      const ratio = canvas.width / canvas.height;
      let imgW = maxW;
      let imgH = maxW / ratio;
      if (imgH > maxH) {
        imgH = maxH;
        imgW = maxH * ratio;
      }
      const offsetX = (pageWidth - imgW) / 2;
      const offsetY = (pageHeight - imgH) / 2;
      pdf.addImage(imgData, 'PNG', offsetX, offsetY, imgW, imgH);
      pdf.save(_saldosFilename(state.agora, 'pdf'));
      F.UI.showToast('PDF exportado com sucesso', 'success');
    } catch (err) {
      console.error(err);
      F.UI.showToast('Erro ao gerar PDF: ' + err.message, 'error');
    } finally {
      F.UI.hideLoading();
      _restoreSaldosAfterExport(state);
    }
  }

  // Chama setup dos handlers quando DOM estiver pronto (complementar ao init principal)
  // Flag para evitar registro duplo de event listeners (que causaria handler rodar 2x)
  let _saldosHandlersSetup = false;
  function setupSaldosHandlersOnce() {
    if (_saldosHandlersSetup) return;
    _saldosHandlersSetup = true;
    setupSaldosHandlers();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupSaldosHandlersOnce);
  } else {
    setupSaldosHandlersOnce();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
