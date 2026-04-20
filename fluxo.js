/* =======================================================================
   FILADÉLFIA — Fluxo de Caixa (JS) v2

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

    unsubscribes.push(F.DB.subscribeLancamentos(data => {
      provisions = data || {};
      if (processed) rebuildAndRender();
    }));
    unsubscribes.push(F.DB.subscribeHiddenTitles(data => {
      deletedImported = data || {};
      if (processed) rebuildAndRender();
    }));

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
    return commentsCache[commentKeyFor(kind, dateK, vendor)] || {};
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

    if (!hasAnyData && Object.keys(provisions).length === 0) {
      if (!F.IS_FIREBASE_CONFIGURED) { showEmpty(); return; }
      setTimeout(() => {
        if (dataStore || Object.keys(provisions).length > 0) finishInit();
        else showEmpty();
      }, 900);
      return;
    }
    finishInit();
  }

  function finishInit() {
    if (!dataStore) dataStore = { titulosPagar: [], titulosReceber: [], processedAt: new Date().toISOString() };
    buildIndex();
    if (!processed.allDates.length) { showEmpty(); return; }
    document.getElementById('empty-state').classList.add('hidden');
    document.getElementById('main-content').classList.remove('hidden');
    setupControls();
    updateHeaderInfo();
    render();
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

  function renderGrid(activeVendors, totalsByDate) {
    const grid = document.getElementById('grid');
    const parts = [];
    const sortedVendors = sortVendors(activeVendors, sortState);

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

    // Receber total
    const rTotal = filteredDates.reduce((s, k) => s + (totalsByDate[k].in), 0);
    parts.push('<tr class="total-row total-in">');
    parts.push('<td class="first">Contas a Receber (Total)</td>');
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

    // Pagar total
    const pTotal = filteredDates.reduce((s, k) => s + (totalsByDate[k].out), 0);
    parts.push('<tr class="total-row total-out">');
    parts.push('<td class="first">Contas a Pagar (Total)</td>');
    filteredDates.forEach(k => {
      const d = F.Dates.parseDateKey(k);
      const we = F.Dates.isWeekend(d) ? ' weekend' : '';
      parts.push(`<td class="${we.trim()}">${F.Fmt.fmtCellMoney(totalsByDate[k].out)}</td>`);
    });
    parts.push(`<td style="border-left:1.5px solid var(--border-strong);">${F.Fmt.fmtCellMoney(pTotal)}</td>`);
    parts.push('</tr>');

    parts.push(`<tr class="section-divider"><td class="first" colspan="${filteredDates.length + 2}">↓ Saídas por fornecedor</td></tr>`);

    sortedVendors.forEach(v => {
      const vTotal = filteredDates.reduce((s, k) => s + (v.byDate.get(k)?.total || 0), 0);
      const isOnlyManual = v.hasManual && !v.hasReal;
      const rowClass = isOnlyManual ? 'vendor-row manual-row' : 'vendor-row';
      const manualTag = isOnlyManual ? '<span class="tag manual">MANUAL</span>' : '';
      const deleteRowBtn = isOnlyManual
        ? `<button class="danger" title="Excluir lançamentos manuais deste fornecedor" data-delete-vendor="${F.escapeHTML(v.name)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg></button>`
        : '';

      parts.push(`<tr class="${rowClass}">`);
      parts.push(`<td class="first"><div class="row-label"><div class="name-group"><span class="nm" title="${F.escapeHTML(v.name)}">${F.escapeHTML(v.name)}${manualTag}</span></div><div class="row-actions">${deleteRowBtn}</div></div></td>`);
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

    parts.push('</tbody>');

    // Só saldo do dia
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
        doc.text('FILADÉLFIA · Detalhamento', 10, 10);
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
    return { activeVendors: sortedVendors, rTotal, receberRow, vendorRows, subOut, totalPagarCells, sT, saldoCells };
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
    ex.vendorRows.forEach(v => lines.push([v.name, ...v.cells.map(moneyCsv), moneyCsv(v.total)].map(csvCell).join(';')));
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
        ex.vendorRows.forEach(v => aoa.push([v.name, ...v.cells, v.total]));
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
        ex.vendorRows.forEach(v => {
          const chunkTotal = chunkIndices.reduce((a, i) => a + v.cells[i], 0);
          body.push([v.name, ...chunkIndices.map(i => fmtMoneyForPdf(v.cells[i])), fmtMoneyForPdf(chunkTotal)]);
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
        doc.text('FILADÉLFIA · Fluxo de Caixa', margin, 9);
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
