/* =======================================================================
   FILADÉLFIA — Fluxo de Caixa (JS)

   Principais otimizações vs versão anterior:
   - renderKPIs e renderGrid compartilham a iteração (um único loop)
   - Export PDF agora usa jsPDF-AutoTable (texto real, paginado)
   - Comentários gerenciados via Firebase Realtime DB com subscrição
   - Sanitização consistente (sempre via F.escapeHTML)
   - Try/catch em operações de localStorage e Firebase
   - Feedback de erro e loading em todas as operações assíncronas
   ======================================================================= */

(function () {
  'use strict';
  const F = window.Filadelfia;

  /* ========== Estado da aplicação ========== */
  let dataStore = null;        // dados importados
  let provisions = [];         // provisões manuais ativas
  let deletedImported = {};    // { titleId: { deletedAt } }
  let trash = [];              // itens na lixeira
  let processed = null;        // índice calculado (allDates, vendors, receberByDate)
  let filteredDates = [];      // datas após filtro de período
  let viewMode = 'effective';  // 'effective' | 'due'
  let commentsCache = {};      // cache do Firebase
  let currentDetail = null;    // modal aberto

  /* ========== Carga de dados do localStorage ========== */
  function loadData() {
    dataStore = F.Storage.safeGetJSON(F.KEYS.DATA, null);
    provisions = F.Storage.safeGetJSON(F.KEYS.PROVISIONS, []);
    deletedImported = F.Storage.safeGetJSON(F.KEYS.DELETED_IMPORTED, {});
    trash = F.Storage.safeGetJSON(F.KEYS.TRASH, []);
    return !!dataStore;
  }
  function saveProvisions() {
    const r = F.Storage.safeSetJSON(F.KEYS.PROVISIONS, provisions);
    if (!r.ok) F.UI.showToast(r.error, 'error');
  }
  function saveDeletedImported() {
    const r = F.Storage.safeSetJSON(F.KEYS.DELETED_IMPORTED, deletedImported);
    if (!r.ok) F.UI.showToast(r.error, 'error');
  }
  function saveTrash() {
    const r = F.Storage.safeSetJSON(F.KEYS.TRASH, trash);
    if (!r.ok) F.UI.showToast(r.error, 'error');
  }

  /* ========== Construção do índice ==========
     Mescla importados + provisões, aplica regras bancárias,
     e cria mapas otimizados para renderização.
     ========================================== */
  function buildIndex() {
    const titulosPagar = [];
    const titulosReceber = [];

    (dataStore?.titulosPagar || []).forEach(t => {
      if (!deletedImported[t.id]) titulosPagar.push({ ...t, _manual: false });
    });
    (dataStore?.titulosReceber || []).forEach(t => {
      if (!deletedImported[t.id]) titulosReceber.push({ ...t, _manual: false });
    });

    provisions.forEach(p => {
      if (p.tipo === 'pagar') {
        titulosPagar.push({
          id: p.id,
          fornecedor: p.entidade,
          documento: p.documento || '',
          vencimento: p.vencimento,
          valor: p.valor,
          _manual: true,
          _author: p.autor,
          _note: p.nota,
          _createdAt: p.createdAt,
        });
      } else {
        titulosReceber.push({
          id: p.id,
          cliente: p.entidade,
          documento: p.documento || '',
          vencimento: p.vencimento,
          valor: p.valor,
          _manual: true,
          _author: p.autor,
          _note: p.nota,
          _createdAt: p.createdAt,
        });
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
    const vendors = [...vendorMap.entries()]
      .map(([name, entry]) => {
        let total = 0;
        entry.byDate.forEach(b => total += b.total);
        return { name, total, byDate: entry.byDate, hasManual: entry.hasManual, hasReal: entry.hasReal };
      })
      .sort((a, b) => b.total - a.total);

    processed = { allDates, vendors, receberByDate };
  }

  /* ========== Firebase comentários ========== */
  function subscribeComments() {
    if (!F.state.fbDB) return;
    const ref = F.state.fbDB.ref('filadelfia/comentarios');
    ref.on('value', snap => {
      commentsCache = snap.val() || {};
      if (processed) render();
      if (currentDetail) refreshDetailComments();
    }, err => {
      console.error('Firebase comments error:', err);
      F.UI.updateSyncBadge('offline', 'Erro de conexão');
    });
  }

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

  /* ========== Inicialização ========== */
  async function init() {
    await F.Auth.requireAuth();
    F.UI.renderTopbar('fluxo');

    if (F.IS_FIREBASE_CONFIGURED) subscribeComments();

    if (!loadData() && provisions.length === 0) {
      showEmpty();
      return;
    }
    if (!dataStore) dataStore = { titulosPagar: [], titulosReceber: [], processedAt: new Date().toISOString() };

    buildIndex();
    if (!processed.allDates.length) {
      showEmpty();
      return;
    }

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
    // Atualiza data/hora do último envio e período importado no topo da página
    const el = document.getElementById('meta-info');
    if (!el || !dataStore) return;

    const importedAt = dataStore.processedAt ? F.Fmt.fmtDateTimeFull(new Date(dataStore.processedAt)) : '—';
    let periodText = '';
    if (dataStore.periodStart && dataStore.periodEnd) {
      const d0 = F.Dates.parseDateKey(dataStore.periodStart);
      const d1 = F.Dates.parseDateKey(dataStore.periodEnd);
      periodText = `${F.Fmt.fmtFullDate(d0)} a ${F.Fmt.fmtFullDate(d1)}`;
    } else if (processed.allDates.length) {
      periodText = `${F.Fmt.fmtFullDate(F.Dates.parseDateKey(processed.allDates[0]))} a ${F.Fmt.fmtFullDate(F.Dates.parseDateKey(processed.allDates[processed.allDates.length-1]))}`;
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
    document.getElementById('btn-trash').addEventListener('click', openTrash);

    // Export dropdown
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

    // Form
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

    // Modal close buttons
    document.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.getElementById(btn.dataset.close + '-modal').classList.remove('open');
      });
    });
    ['detail', 'form', 'trash'].forEach(id => {
      document.getElementById(id + '-modal').addEventListener('click', (e) => {
        if (e.target.id === id + '-modal') document.getElementById(id + '-modal').classList.remove('open');
      });
    });
  }

  function setViewMode(mode) {
    viewMode = mode;
    document.getElementById('view-effective').classList.toggle('active', mode === 'effective');
    document.getElementById('view-due').classList.toggle('active', mode === 'due');
    buildIndex();
    const s = document.getElementById('filter-start').value;
    const e = document.getElementById('filter-end').value;
    if (!processed.allDates.includes(s)) {
      document.getElementById('filter-start').value = processed.allDates[0];
    }
    if (!processed.allDates.includes(e)) {
      document.getElementById('filter-end').value = processed.allDates[processed.allDates.length - 1];
    }
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

    // Pré-calcular activeVendors e agregados por data (uma só iteração)
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
    const first = F.Dates.parseDateKey(filteredDates[0]);
    const last = F.Dates.parseDateKey(filteredDates[filteredDates.length - 1]);
    const modeLabel = viewMode === 'effective' ? 'data efetiva' : 'data de vencimento';
    const manualCount = provisions.length;
    document.getElementById('grid-sub').textContent =
      `${activeVendors.length} fornecedores · ${filteredDates.length} dias · ${manualCount} lançamento${manualCount !== 1 ? 's' : ''} manual · ${modeLabel}`;
  }

  function renderGrid(activeVendors, totalsByDate) {
    const grid = document.getElementById('grid');
    const parts = [];

    // Thead
    parts.push('<thead><tr>');
    parts.push('<th class="first">Fornecedor / Conta</th>');
    filteredDates.forEach(k => {
      const d = F.Dates.parseDateKey(k);
      const we = F.Dates.isWeekend(d) ? ' weekend' : '';
      parts.push(`<th class="${we.trim()}">${F.Fmt.fmtHeaderDate(d)}<span class="wd">${F.Fmt.weekdayShort(d)}</span></th>`);
    });
    parts.push('<th style="border-left:1.5px solid var(--border-strong);">Total</th>');
    parts.push('</tr></thead>');

    parts.push('<tbody>');

    // ========= TOTALIZADORES NO TOPO =========
    // Total Contas a Receber
    const rTotal = filteredDates.reduce((s, k) => s + (totalsByDate[k].in), 0);
    parts.push('<tr class="total-row total-in">');
    parts.push('<td class="first">Contas a Receber (Total)</td>');
    filteredDates.forEach(k => {
      const d = F.Dates.parseDateKey(k);
      const we = F.Dates.isWeekend(d) ? ' weekend' : '';
      parts.push(`<td class="${we.trim()}">${F.Fmt.fmtCellMoney(totalsByDate[k].in)}</td>`);
    });
    parts.push(`<td style="border-left:1.5px solid var(--border-strong);">${F.Fmt.fmtCellMoney(rTotal)}</td>`);
    parts.push('</tr>');

    // Total Contas a Pagar (NOVO - imediatamente abaixo de Receber)
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

    // ========= ENTRADAS DETALHADAS =========
    parts.push(`<tr class="section-divider"><td class="first" colspan="${filteredDates.length + 2}">↑ Entradas detalhadas</td></tr>`);
    parts.push('<tr class="receber-row">');
    parts.push('<td class="first"><div class="row-label"><div class="name-group"><span class="nm">Contas a Receber</span><span class="sub">Total de recebimentos</span></div></div></td>');
    filteredDates.forEach(k => {
      const d = F.Dates.parseDateKey(k);
      const bucket = processed.receberByDate.get(k);
      const v = bucket?.total || 0;
      const we = F.Dates.isWeekend(d) ? ' weekend' : '';
      const hasComment = hasCommentsForCell('receber', k, null);
      const commentDot = hasComment ? '<span class="comment-dot"></span>' : '';
      if (v > 0) {
        const cls = bucket?.hasManual ? 'manual-val' : 'in-val';
        parts.push(`<td class="${cls}${we}" data-detail="receber" data-date="${k}"><span>${F.Fmt.fmtCellMoney(v)}</span>${commentDot}</td>`);
      } else {
        parts.push(`<td class="empty${we}" data-add="receber" data-date="${k}"><span>–</span>${commentDot}</td>`);
      }
    });
    parts.push(`<td class="in-val" style="border-left:1.5px solid var(--border-strong);">${F.Fmt.fmtCellMoney(rTotal)}</td>`);
    parts.push('</tr>');

    // ========= SAÍDAS POR FORNECEDOR =========
    parts.push(`<tr class="section-divider"><td class="first" colspan="${filteredDates.length + 2}">↓ Saídas por fornecedor</td></tr>`);
    activeVendors.forEach(v => {
      const vTotal = filteredDates.reduce((s, k) => s + (v.byDate.get(k)?.total || 0), 0);
      const isOnlyManual = v.hasManual && !v.hasReal;
      const rowClass = isOnlyManual ? 'vendor-row manual-row' : 'vendor-row';
      const manualTag = isOnlyManual ? '<span class="tag manual">MANUAL</span>' : '';
      const deleteRowBtn = isOnlyManual
        ? `<button class="danger" title="Excluir linha manual" data-delete-vendor="${F.escapeHTML(v.name)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg></button>`
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

    // ========= TFOOT: Saldo e Acumulado =========
    parts.push('<tfoot>');

    // Saldo do dia
    parts.push('<tr class="saldo"><td class="first">Saldo do dia</td>');
    let saldoTotal = 0;
    filteredDates.forEach(k => {
      const s = totalsByDate[k].net;
      saldoTotal += s;
      const cls = s >= 0 ? 'positive-bal' : 'negative-bal';
      parts.push(`<td class="${cls}">${Math.abs(s) < 0.005 ? '–' : F.Fmt.fmtMoneyShort(s)}</td>`);
    });
    parts.push(`<td class="${saldoTotal >= 0 ? 'positive-bal' : 'negative-bal'}" style="border-left:1.5px solid var(--border-strong);">${F.Fmt.fmtMoneyShort(saldoTotal)}</td></tr>`);

    // Acumulado
    parts.push('<tr class="acumulado"><td class="first">Saldo acumulado</td>');
    let acc = 0;
    filteredDates.forEach(k => {
      acc += totalsByDate[k].net;
      parts.push(`<td class="${acc >= 0 ? 'positive-bal' : 'negative-bal'}">${F.Fmt.fmtMoneyShort(acc)}</td>`);
    });
    parts.push(`<td class="${acc >= 0 ? 'positive-bal' : 'negative-bal'}" style="border-left:1.5px solid var(--border-strong);">${F.Fmt.fmtMoneyShort(acc)}</td></tr>`);
    parts.push('</tfoot>');

    grid.innerHTML = parts.join('');

    // Event handlers
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

  /* ========== Provisões ========== */
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

  function saveProvision() {
    const tipo = document.getElementById('form-type-toggle').querySelector('.active').dataset.type;
    const entidade = document.getElementById('form-entity').value.trim();
    const dateVal = document.getElementById('form-date').value;
    const valor = parseFloat(document.getElementById('form-value').value);
    const documento = document.getElementById('form-doc').value.trim();
    const nota = document.getElementById('form-note').value.trim();
    const autor = F.state.user?.displayName || F.state.user?.email || 'Anônimo';

    if (!entidade) { F.UI.showToast('Informe o fornecedor/cliente', 'error'); return; }
    if (!dateVal) { F.UI.showToast('Informe a data de vencimento', 'error'); return; }
    if (!valor || valor <= 0) { F.UI.showToast('Informe um valor positivo', 'error'); return; }
    if (entidade.length > 120) { F.UI.showToast('Nome muito longo (máx 120 caracteres)', 'error'); return; }
    if (nota.length > 500) { F.UI.showToast('Observação muito longa (máx 500 caracteres)', 'error'); return; }

    const prov = {
      id: 'M' + Date.now() + Math.random().toString(36).slice(2, 8),
      tipo, entidade,
      vencimento: dateVal,
      valor, documento, nota, autor,
      createdAt: Date.now(),
    };

    provisions.push(prov);
    saveProvisions();

    document.getElementById('form-modal').classList.remove('open');
    rebuildAndRender();
    F.UI.showToast('Lançamento manual criado', 'success');
  }

  function deleteProvision(provId) {
    const idx = provisions.findIndex(p => p.id === provId);
    if (idx === -1) return;
    const prov = provisions[idx];
    provisions.splice(idx, 1);
    saveProvisions();
    trash.push({ kind: 'provision', deletedAt: Date.now(), data: prov });
    saveTrash();
    rebuildAndRender();
    updateTrashCount();
    F.UI.showToast('Lançamento enviado à lixeira', 'success', {
      label: 'Desfazer',
      action: () => restoreFromTrash(trash.length - 1)
    });
  }

  function deleteImportedTitle(title, kind) {
    deletedImported[title.id] = { deletedAt: Date.now() };
    saveDeletedImported();
    trash.push({ kind: 'imported', deletedAt: Date.now(), data: { ...title, _kind: kind } });
    saveTrash();
    rebuildAndRender();
    updateTrashCount();
    F.UI.showToast('Título importado ocultado', 'success', {
      label: 'Desfazer',
      action: () => restoreFromTrash(trash.length - 1)
    });
  }

  function deleteManualVendorRow(vendorName) {
    const affected = provisions.filter(p => p.tipo === 'pagar' && p.entidade === vendorName);
    if (!affected.length) return;
    if (!confirm(`Excluir todos os ${affected.length} lançamento(s) manuais de "${vendorName}"?`)) return;
    affected.forEach(p => trash.push({ kind: 'provision', deletedAt: Date.now(), data: p }));
    provisions = provisions.filter(p => !(p.tipo === 'pagar' && p.entidade === vendorName));
    saveProvisions();
    saveTrash();
    rebuildAndRender();
    updateTrashCount();
    F.UI.showToast(`${affected.length} lançamento(s) enviados à lixeira`, 'success');
  }

  function restoreFromTrash(idx) {
    const item = trash[idx];
    if (!item) return;
    if (item.kind === 'provision') {
      provisions.push(item.data);
      saveProvisions();
    } else if (item.kind === 'imported') {
      delete deletedImported[item.data.id];
      saveDeletedImported();
    }
    trash.splice(idx, 1);
    saveTrash();
    rebuildAndRender();
    updateTrashCount();
    if (document.getElementById('trash-modal').classList.contains('open')) renderTrashTab(currentTrashTab);
    F.UI.showToast('Restaurado', 'success');
  }

  function emptyTrash() {
    if (!trash.length) return;
    if (!confirm(`Apagar definitivamente ${trash.length} item(ns) da lixeira? Esta ação não pode ser desfeita.`)) return;
    trash = [];
    saveTrash();
    updateTrashCount();
    renderTrashTab(currentTrashTab);
    F.UI.showToast('Lixeira esvaziada', 'success');
  }

  function updateTrashCount() {
    const el = document.getElementById('trash-count');
    if (!el) return;
    if (trash.length > 0) {
      el.textContent = trash.length;
      el.style.display = 'inline-block';
    } else {
      el.style.display = 'none';
    }
  }

  function rebuildAndRender() {
    buildIndex();
    if (processed.allDates.length) {
      const s = document.getElementById('filter-start').value;
      const e = document.getElementById('filter-end').value;
      if (!processed.allDates.some(k => k >= s && k <= e)) {
        document.getElementById('filter-start').value = processed.allDates[0];
        document.getElementById('filter-end').value = processed.allDates[processed.allDates.length - 1];
      }
    }
    render();
    if (currentDetail && document.getElementById('detail-modal').classList.contains('open')) {
      openDetail(currentDetail.kind, currentDetail.dateKey, currentDetail.vendorName);
    }
  }

  /* ========== Modal de detalhes ========== */
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

    currentDetail = { kind, dateKey: dk, vendorName };

    document.getElementById('detail-title').textContent = title;
    document.getElementById('detail-subtitle').textContent = subtitle;

    const modeLabel = viewMode === 'effective' ? 'Efetiva (após regra bancária)' : 'Vencimento';
    document.getElementById('detail-date-info').innerHTML = `
      <span class="date-chip">Exibido por: <strong>${F.escapeHTML(modeLabel)}</strong></span>
      <span class="date-chip">Data: <strong>${F.escapeHTML(F.Fmt.fmtFullDate(d))}</strong></span>
    `;

    const isReceber = kind === 'receber';
    const entityCol = isReceber ? 'Cliente' : 'Fornecedor';
    const valueCls = isReceber ? 'value-in' : 'value-out';

    document.getElementById('detail-thead').innerHTML = `
      <tr>
        <th>Documento</th>
        <th>${entityCol}</th>
        <th>Vencimento</th>
        <th>Data efetiva</th>
        <th class="right">Valor</th>
        <th class="right"></th>
      </tr>
    `;
    const tbody = document.getElementById('detail-tbody');
    tbody.innerHTML = titulos.length === 0
      ? '<tr><td colspan="6" style="padding:30px;text-align:center;color:var(--text-muted)">Nenhum título nesta data.</td></tr>'
      : titulos.map(t => {
        const name = (isReceber ? t.cliente : t.fornecedor) || '—';
        const manualTag = t._manual ? '<span class="tag">MANUAL</span>' : '';
        const noteLine = t._note
          ? `<div style="font-size:11px;color:var(--text-muted);margin-top:3px;font-family:'JetBrains Mono',monospace;">${F.escapeHTML(t._note)}</div>`
          : '';
        return `
          <tr class="${t._manual ? 'manual-title' : ''}">
            <td class="doc">${F.escapeHTML(t.documento || '—')}</td>
            <td>${F.escapeHTML(name)}${manualTag}${noteLine}</td>
            <td>${F.Fmt.fmtFullDate(F.Dates.parseDateKey(t.vencimentoDate))}</td>
            <td>${F.Fmt.fmtFullDate(F.Dates.parseDateKey(t.efetivaDate))}</td>
            <td class="right ${valueCls}">${F.Fmt.fmtMoney(t.valor)}</td>
            <td class="right">
              <button class="row-del-btn" data-title-id="${F.escapeHTML(t.id)}" data-title-manual="${t._manual ? '1' : '0'}" data-title-kind="${kind}" title="Excluir título">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>
              </button>
            </td>
          </tr>
        `;
      }).join('');

    tbody.querySelectorAll('[data-title-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tid = btn.dataset.titleId;
        const isManual = btn.dataset.titleManual === '1';
        const k = btn.dataset.titleKind;
        if (isManual) {
          if (confirm('Excluir este lançamento manual? Será enviado à lixeira.')) deleteProvision(tid);
        } else {
          if (confirm('Ocultar este título importado? Será enviado à lixeira e pode ser restaurado depois.')) {
            const list = k === 'receber' ? dataStore.titulosReceber : dataStore.titulosPagar;
            const original = list.find(t => t.id === tid);
            if (original) deleteImportedTitle(original, k);
          }
        }
      });
    });

    const totalEl = document.getElementById('detail-total');
    totalEl.textContent = F.Fmt.fmtMoney(total);
    totalEl.className = 'total-value ' + (isReceber ? 'in' : 'out');

    refreshDetailComments();
    document.getElementById('detail-modal').classList.add('open');
  }

  /* ========== Comentários ========== */
  function refreshDetailComments() {
    if (!currentDetail) return;
    const authorTag = document.getElementById('comment-author-tag');
    if (authorTag) {
      authorTag.innerHTML = 'Publicar como <strong>' + F.escapeHTML(F.state.user?.displayName || 'Anônimo') + '</strong>';
    }

    if (!F.IS_FIREBASE_CONFIGURED) {
      document.getElementById('comments-list').innerHTML =
        '<div class="comment-empty">Firebase não configurado. Configure em shared.js para habilitar comentários.</div>';
      document.getElementById('comment-count').textContent = '0';
      return;
    }

    const comments = getCommentsForCell(currentDetail.kind, currentDetail.dateKey, currentDetail.vendorName);
    const list = Object.entries(comments)
      .map(([id, c]) => ({ id, ...c }))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

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
    if (text.length > 1000) { F.UI.showToast('Comentário muito longo (máx 1000 caracteres)', 'error'); return; }

    if (!F.state.fbDB) {
      F.UI.showToast('Firebase não configurado', 'error');
      return;
    }

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
      .catch(err => {
        console.error(err);
        F.UI.showToast('Erro ao enviar comentário', 'error');
      });
  }

  function deleteComment(commentId) {
    if (!currentDetail || !F.state.fbDB) return;
    const key = commentKeyFor(currentDetail.kind, currentDetail.dateKey, currentDetail.vendorName);
    F.state.fbDB.ref(`filadelfia/comentarios/${key}/${commentId}`).remove()
      .then(() => F.UI.showToast('Comentário excluído', 'success'))
      .catch(() => F.UI.showToast('Erro ao excluir', 'error'));
  }

  /* ========== Lixeira ========== */
  let currentTrashTab = 'manual';
  function openTrash() {
    document.getElementById('trash-modal').classList.add('open');
    document.querySelectorAll('.trash-modal .tabs button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === currentTrashTab);
      btn.onclick = () => {
        currentTrashTab = btn.dataset.tab;
        document.querySelectorAll('.trash-modal .tabs button').forEach(b =>
          b.classList.toggle('active', b.dataset.tab === currentTrashTab)
        );
        renderTrashTab(currentTrashTab);
      };
    });
    document.getElementById('btn-empty-trash').onclick = emptyTrash;
    renderTrashTab(currentTrashTab);
  }

  function renderTrashTab(tab) {
    const body = document.getElementById('trash-body');
    const info = document.getElementById('trash-info');

    const filtered = trash.map((t, i) => ({ ...t, _idx: i })).filter(t =>
      tab === 'manual' ? t.kind === 'provision' : t.kind === 'imported'
    );

    info.textContent = `${filtered.length} item${filtered.length !== 1 ? 'ns' : ''} · Total na lixeira: ${trash.length}`;

    if (!filtered.length) {
      body.innerHTML = '<div class="empty-trash">Nenhum item nesta aba.</div>';
      return;
    }

    body.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Tipo</th>
            <th>Entidade</th>
            <th>Vencimento</th>
            <th class="right">Valor</th>
            <th>Excluído</th>
            <th class="right">Ação</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map(item => {
            const d = item.data;
            const isProv = item.kind === 'provision';
            const typeBadge = isProv
              ? (d.tipo === 'pagar'
                ? '<span style="color:var(--danger-text);font-weight:600">Pagar (M)</span>'
                : '<span style="color:var(--accent-text);font-weight:600">Receber (M)</span>')
              : (d._kind === 'pagar'
                ? '<span style="color:var(--danger-text)">Pagar</span>'
                : '<span style="color:var(--accent-text)">Receber</span>');
            const entity = isProv ? d.entidade : (d._kind === 'pagar' ? d.fornecedor : d.cliente);
            const venc = d.vencimento;
            return `
              <tr>
                <td>${typeBadge}</td>
                <td>${F.escapeHTML(entity || '—')}</td>
                <td>${F.Fmt.fmtFullDate(F.Dates.parseDateKey(venc))}</td>
                <td class="right">${F.Fmt.fmtMoney(d.valor || 0)}</td>
                <td><span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-muted);">${F.Fmt.fmtRelativeTime(item.deletedAt)}</span></td>
                <td class="right"><button class="restore-btn" data-restore-idx="${item._idx}">Restaurar</button></td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;

    body.querySelectorAll('[data-restore-idx]').forEach(btn => {
      btn.addEventListener('click', () => restoreFromTrash(parseInt(btn.dataset.restoreIdx, 10)));
    });
  }

  /* ========== EXPORTAÇÃO ========== */
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
    // Receber
    let rTotal = 0;
    const receberRow = filteredDates.map(k => {
      const v = processed.receberByDate.get(k)?.total || 0;
      rTotal += v;
      return v;
    });
    // Vendors
    const vendorRows = activeVendors.map(v => {
      let t = 0;
      const cells = filteredDates.map(k => {
        const val = v.byDate.get(k)?.total || 0;
        t += val;
        return val;
      });
      return { name: v.name, cells, total: t };
    });
    // Subtotal pagar
    let subOut = 0;
    const totalPagarCells = filteredDates.map(k => {
      const s = activeVendors.reduce((a, v) => a + (v.byDate.get(k)?.total || 0), 0);
      subOut += s;
      return s;
    });
    // Saldo
    let sT = 0;
    const saldoCells = filteredDates.map((k, i) => {
      const s = receberRow[i] - totalPagarCells[i];
      sT += s;
      return s;
    });
    // Acumulado
    let acc = 0;
    const accCells = filteredDates.map((k, i) => {
      acc += (receberRow[i] - totalPagarCells[i]);
      return acc;
    });

    return {
      activeVendors, rTotal, receberRow,
      vendorRows, subOut, totalPagarCells,
      sT, saldoCells, acc, accCells,
    };
  }

  /* ---------- CSV ---------- */
  function csvCell(v) {
    const s = String(v);
    if (s.includes(';') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
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
    ex.vendorRows.forEach(v => {
      lines.push([v.name, ...v.cells.map(moneyCsv), moneyCsv(v.total)].map(csvCell).join(';'));
    });
    lines.push(['Saldo do dia', ...ex.saldoCells.map(moneyCsv), moneyCsv(ex.sT)].map(csvCell).join(';'));
    lines.push(['Saldo acumulado', ...ex.accCells.map(moneyCsv), moneyCsv(ex.acc)].map(csvCell).join(';'));

    const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, getExportFilename('csv'));
  }

  /* ---------- XLSX ---------- */
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
        aoa.push(['Saldo acumulado', ...ex.accCells, ex.acc]);

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

        // Aba de títulos detalhados
        const detailAoa = [['Tipo', 'Vencimento', 'Data efetiva', 'Cliente / Fornecedor', 'Documento', 'Valor', 'Manual?']];
        const merged = {
          pagar: (dataStore.titulosPagar || []).filter(t => !deletedImported[t.id]).map(t => ({ ...t, _manual: false })),
          receber: (dataStore.titulosReceber || []).filter(t => !deletedImported[t.id]).map(t => ({ ...t, _manual: false })),
        };
        provisions.forEach(p => {
          if (p.tipo === 'pagar') merged.pagar.push({ id: p.id, fornecedor: p.entidade, documento: p.documento || '', vencimento: p.vencimento, valor: p.valor, _manual: true });
          else merged.receber.push({ id: p.id, cliente: p.entidade, documento: p.documento || '', vencimento: p.vencimento, valor: p.valor, _manual: true });
        });

        const s = document.getElementById('filter-start').value;
        const e = document.getElementById('filter-end').value;

        merged.receber.forEach(t => {
          const due = F.Dates.parseDateKey(t.vencimento);
          const eff = F.Dates.effectiveDateReceber(due);
          const useK = F.Dates.dateKey(viewMode === 'effective' ? eff : due);
          if (useK >= s && useK <= e) {
            detailAoa.push(['Receber', F.Fmt.fmtFullDate(due), F.Fmt.fmtFullDate(eff), t.cliente || '', t.documento || '', t.valor, t._manual ? 'Sim' : 'Não']);
          }
        });
        merged.pagar.forEach(t => {
          const due = F.Dates.parseDateKey(t.vencimento);
          const eff = F.Dates.effectiveDatePagar(due);
          const useK = F.Dates.dateKey(viewMode === 'effective' ? eff : due);
          if (useK >= s && useK <= e) {
            detailAoa.push(['Pagar', F.Fmt.fmtFullDate(due), F.Fmt.fmtFullDate(eff), t.fornecedor || '', t.documento || '', t.valor, t._manual ? 'Sim' : 'Não']);
          }
        });

        const ws2 = XLSX.utils.aoa_to_sheet(detailAoa);
        ws2['!cols'] = [{ wch: 9 }, { wch: 14 }, { wch: 14 }, { wch: 40 }, { wch: 18 }, { wch: 14 }, { wch: 10 }];
        const r2 = XLSX.utils.decode_range(ws2['!ref']);
        for (let R = 1; R <= r2.e.r; R++) {
          const addr = XLSX.utils.encode_cell({ r: R, c: 5 });
          if (ws2[addr]) { ws2[addr].z = 'R$ #,##0.00;[Red]-R$ #,##0.00'; ws2[addr].t = 'n'; }
        }
        XLSX.utils.book_append_sheet(wb, ws2, 'Títulos detalhados');

        XLSX.writeFile(wb, getExportFilename('xlsx'));
        F.UI.hideLoading();
        F.UI.showToast('Planilha gerada', 'success');
      } catch (err) {
        console.error(err);
        F.UI.hideLoading();
        F.UI.showToast('Erro ao gerar planilha: ' + err.message, 'error');
      }
    }, 50);
  }

  /* ---------- PNG ---------- */
  async function exportPNG() {
    F.UI.showLoading('Gerando imagem…');
    const card = document.getElementById('grid-card');
    const scroll = document.getElementById('grid-scroll');
    const originalMaxHeight = scroll.style.maxHeight;
    scroll.style.maxHeight = 'none';
    scroll.classList.add('export-mode');
    try {
      await new Promise(r => setTimeout(r, 80));
      const canvas = await html2canvas(card, {
        scale: 2,
        backgroundColor: '#ffffff',
        logging: false,
        useCORS: true,
      });
      canvas.toBlob(blob => {
        if (blob) downloadBlob(blob, getExportFilename('png'));
        scroll.style.maxHeight = originalMaxHeight;
        scroll.classList.remove('export-mode');
        F.UI.hideLoading();
        F.UI.showToast('Imagem gerada', 'success');
      }, 'image/png');
    } catch (err) {
      console.error(err);
      scroll.style.maxHeight = originalMaxHeight;
      scroll.classList.remove('export-mode');
      F.UI.hideLoading();
      F.UI.showToast('Erro ao gerar imagem: ' + err.message, 'error');
    }
  }

  /* ---------- PDF (texto real, paginado) ---------- */
  async function exportPDF() {
    F.UI.showLoading('Gerando PDF…');
    try {
      const ex = collectExportData();
      const { jsPDF } = window.jspdf;

      // Usar paisagem A4
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();

      // Calcula quantas datas cabem por página (texto comprime muito mais)
      // Largura útil: pageW - 2*margin. Coluna nome = 55mm, total = 24mm
      const margin = 8;
      const nameWidth = 55;
      const totalColWidth = 24;
      const usableWidth = pageW - 2 * margin - nameWidth - totalColWidth;
      const dateColWidth = 18; // largura mínima legível
      const datesPerPage = Math.max(3, Math.floor(usableWidth / dateColWidth));

      const s = document.getElementById('filter-start').value;
      const e = document.getElementById('filter-end').value;
      const periodText = `${F.Fmt.fmtFullDate(F.Dates.parseDateKey(s))} a ${F.Fmt.fmtFullDate(F.Dates.parseDateKey(e))}`;
      const modeText = viewMode === 'effective' ? 'Data efetiva' : 'Vencimento';

      // Dividir datas em chunks
      const dateChunks = [];
      for (let i = 0; i < filteredDates.length; i += datesPerPage) {
        dateChunks.push(filteredDates.slice(i, i + datesPerPage));
      }

      // Para cada chunk, gerar uma sequência de páginas
      dateChunks.forEach((chunk, chunkIdx) => {
        const chunkIndices = chunk.map(k => filteredDates.indexOf(k));

        // Monta body para autoTable
        const head = [['Fornecedor / Conta', ...chunk.map(k => {
          const d = F.Dates.parseDateKey(k);
          return `${F.Fmt.fmtHeaderDate(d)}\n${F.Fmt.weekdayShort(d)}`;
        }), 'Total']];

        const body = [];
        // Totais no topo
        const rTotalChunk = chunkIndices.reduce((a, i) => a + ex.receberRow[i], 0);
        body.push([
          { content: 'Contas a Receber (Total)', styles: { fontStyle: 'bold', fillColor: [212, 234, 250], textColor: [10, 110, 158] } },
          ...chunkIndices.map(i => ({
            content: fmtMoneyForPdf(ex.receberRow[i]),
            styles: { fontStyle: 'bold', fillColor: [212, 234, 250], textColor: [10, 110, 158] },
          })),
          { content: fmtMoneyForPdf(rTotalChunk), styles: { fontStyle: 'bold', fillColor: [212, 234, 250], textColor: [10, 110, 158] } },
        ]);

        const pTotalChunk = chunkIndices.reduce((a, i) => a + ex.totalPagarCells[i], 0);
        body.push([
          { content: 'Contas a Pagar (Total)', styles: { fontStyle: 'bold', fillColor: [252, 218, 217], textColor: [180, 35, 24] } },
          ...chunkIndices.map(i => ({
            content: fmtMoneyForPdf(ex.totalPagarCells[i]),
            styles: { fontStyle: 'bold', fillColor: [252, 218, 217], textColor: [180, 35, 24] },
          })),
          { content: fmtMoneyForPdf(pTotalChunk), styles: { fontStyle: 'bold', fillColor: [252, 218, 217], textColor: [180, 35, 24] } },
        ]);

        // Fornecedores
        ex.vendorRows.forEach(v => {
          const chunkTotal = chunkIndices.reduce((a, i) => a + v.cells[i], 0);
          body.push([
            v.name,
            ...chunkIndices.map(i => fmtMoneyForPdf(v.cells[i])),
            fmtMoneyForPdf(chunkTotal),
          ]);
        });

        // Saldo e acumulado
        const sTChunk = chunkIndices.reduce((a, i) => a + ex.saldoCells[i], 0);
        body.push([
          { content: 'Saldo do dia', styles: { fontStyle: 'bold', fillColor: [10, 14, 22], textColor: [255, 255, 255] } },
          ...chunkIndices.map(i => ({
            content: fmtMoneyForPdf(ex.saldoCells[i]),
            styles: { fontStyle: 'bold', fillColor: [10, 14, 22], textColor: ex.saldoCells[i] >= 0 ? [28, 167, 236] : [255, 121, 113] },
          })),
          { content: fmtMoneyForPdf(sTChunk), styles: { fontStyle: 'bold', fillColor: [10, 14, 22], textColor: sTChunk >= 0 ? [28, 167, 236] : [255, 121, 113] } },
        ]);

        body.push([
          { content: 'Saldo acumulado', styles: { fontStyle: 'bold', fillColor: [245, 247, 250], textColor: [74, 82, 98] } },
          ...chunkIndices.map(i => ({
            content: fmtMoneyForPdf(ex.accCells[i]),
            styles: { fontStyle: 'bold', fillColor: [245, 247, 250], textColor: ex.accCells[i] >= 0 ? [10, 110, 158] : [180, 35, 24] },
          })),
          { content: fmtMoneyForPdf(ex.acc), styles: { fontStyle: 'bold', fillColor: [245, 247, 250], textColor: ex.acc >= 0 ? [10, 110, 158] : [180, 35, 24] } },
        ]);

        if (chunkIdx > 0) doc.addPage();

        // Cabeçalho da página
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

        // Tabela
        doc.autoTable({
          head: head,
          body: body,
          startY: 18,
          margin: { left: margin, right: margin },
          theme: 'grid',
          styles: {
            fontSize: 7.5,
            cellPadding: 2,
            lineColor: [228, 232, 238],
            lineWidth: 0.1,
            overflow: 'linebreak',
          },
          headStyles: {
            fillColor: [10, 14, 22],
            textColor: [255, 255, 255],
            fontStyle: 'bold',
            halign: 'right',
            fontSize: 8,
          },
          columnStyles: (() => {
            const styles = { 0: { cellWidth: nameWidth, halign: 'left', fontSize: 7, fontStyle: 'normal' } };
            chunk.forEach((_, idx) => {
              styles[idx + 1] = { halign: 'right', cellWidth: dateColWidth - 0.5 };
            });
            styles[chunk.length + 1] = { halign: 'right', fontStyle: 'bold', cellWidth: totalColWidth };
            return styles;
          })(),
          didParseCell: (data) => {
            // Primeira coluna (nomes): alinhamento esquerdo
            if (data.column.index === 0 && data.section === 'body' && data.cell.styles) {
              data.cell.styles.halign = 'left';
            }
          },
        });

        // Rodapé
        const pageCount = doc.internal.getNumberOfPages();
        doc.setTextColor(107, 114, 128);
        doc.setFontSize(7);
        doc.text(
          `Gerado em ${new Date().toLocaleString('pt-BR')} · R2 Soluções Empresariais · Página ${pageCount}`,
          pageW / 2,
          pageH - 4,
          { align: 'center' }
        );
      });

      doc.save(getExportFilename('pdf'));
      F.UI.hideLoading();
      F.UI.showToast('PDF gerado', 'success');
    } catch (err) {
      console.error(err);
      F.UI.hideLoading();
      F.UI.showToast('Erro ao gerar PDF: ' + err.message, 'error');
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

  /* ========== Boot ========== */
  document.addEventListener('DOMContentLoaded', init);
})();
