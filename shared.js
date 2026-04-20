/* =======================================================================
   FILADELFIA — Sistema Financeiro
   Módulo JS compartilhado

   Conteúdo:
   - Configuração Firebase (substituir antes de publicar)
   - Auth: guard de páginas, login, logout, info do usuário
   - Storage keys e helpers
   - Feriados nacionais e regras bancárias (D+0 pagar, D+1 receber)
   - Formatters e escaping
   - Topbar comum (usuário, sync badge, menu mobile)
   - Toast e loading
   ======================================================================= */

(function () {
  'use strict';

  /* ========== Versão do sistema ==========
     Atualizar a cada nova entrega.
     Formato: v<major>.<minor>
     - major: mudanças estruturais profundas
     - minor: correções e melhorias pontuais
     ======================================= */
  const APP_VERSION = 'v2.9';

  /* ========== Firebase config ==========
     SUBSTITUIR pelos valores do seu projeto
     ===================================== */
  const firebaseConfig = {
    apiKey: "AIzaSyBepv8MkYoli7M4UUapp2rIPql4YLgpIeA",
    authDomain: "filadelfia-d0046.firebaseapp.com",
    databaseURL: "https://filadelfia-d0046-default-rtdb.firebaseio.com",
    projectId: "filadelfia-d0046",
    storageBucket: "filadelfia-d0046.firebasestorage.app",
    messagingSenderId: "277008261687",
    appId: "1:277008261687:web:b5775f630e85a9982855b2"
  };

  const IS_FIREBASE_CONFIGURED = firebaseConfig.apiKey !== "SUA_API_KEY";

  /* ========== Storage keys ========== */
  const KEYS = {
    DATA: 'filadelfia_fluxo_caixa_v2',
    PROVISIONS: 'filadelfia_provisoes_v1',
    DELETED_IMPORTED: 'filadelfia_deleted_imp_v1',
    TRASH: 'filadelfia_trash_v1',
    AUTHOR: 'filadelfia_last_author',
    REMEMBER_LOGIN: 'filadelfia_remember_login',
    SESSION_USER: 'filadelfia_session_user',
  };

  /* ========== Estado global ========== */
  const state = {
    fbApp: null,
    fbAuth: null,
    fbDB: null,
    user: null,  // { uid, email, displayName }
  };

  /* ========== Inicialização Firebase ========== */
  function initFirebase() {
    if (!IS_FIREBASE_CONFIGURED) return false;
    if (state.fbApp) return true;
    if (typeof firebase === 'undefined') {
      console.warn('Firebase SDK não carregado');
      return false;
    }
    try {
      state.fbApp = firebase.initializeApp(firebaseConfig);
      state.fbAuth = firebase.auth();
      state.fbDB = firebase.database();
      return true;
    } catch (err) {
      console.error('Firebase init error:', err);
      return false;
    }
  }

  /* ========== Auth guard ==========
     Páginas chamam Filadelfia.Auth.requireAuth() no início.
     Se não estiver logado, redireciona para login.html.
     Retorna Promise<user> quando autenticado.
     ================================ */
  function requireAuth() {
    return new Promise((resolve) => {
      if (!initFirebase()) {
        // Sem firebase: modo demonstração. Permite acesso sem login mas sem sincronização.
        state.user = {
          uid: 'demo',
          email: 'demo@local',
          displayName: localStorage.getItem(KEYS.AUTHOR) || 'Demo',
          isDemo: true,
        };
        resolve(state.user);
        return;
      }
      state.fbAuth.onAuthStateChanged((fbUser) => {
        if (!fbUser) {
          const returnTo = encodeURIComponent(location.pathname.split('/').pop() || 'index.html');
          location.href = 'login.html?return=' + returnTo;
          return;
        }
        state.user = {
          uid: fbUser.uid,
          email: fbUser.email,
          displayName: fbUser.displayName || fbUser.email.split('@')[0],
        };
        try { localStorage.setItem(KEYS.AUTHOR, state.user.displayName); } catch {}
        try { sessionStorage.setItem(KEYS.SESSION_USER, JSON.stringify(state.user)); } catch {}
        resolve(state.user);
      });
    });
  }

  async function login(email, password, remember) {
    if (!initFirebase()) throw new Error('Firebase não configurado. Edite shared.js.');
    try {
      await state.fbAuth.setPersistence(
        remember ? firebase.auth.Auth.Persistence.LOCAL : firebase.auth.Auth.Persistence.SESSION
      );
      const cred = await state.fbAuth.signInWithEmailAndPassword(email, password);
      if (remember) {
        try { localStorage.setItem(KEYS.REMEMBER_LOGIN, email); } catch {}
      } else {
        try { localStorage.removeItem(KEYS.REMEMBER_LOGIN); } catch {}
      }
      return cred.user;
    } catch (err) {
      throw translateAuthError(err);
    }
  }

  async function logout() {
    try { sessionStorage.removeItem(KEYS.SESSION_USER); } catch {}
    if (state.fbAuth) await state.fbAuth.signOut();
    location.href = 'login.html';
  }

  function translateAuthError(err) {
    const msgs = {
      'auth/invalid-email': 'Email inválido.',
      'auth/user-disabled': 'Usuário desativado. Contate o administrador.',
      'auth/user-not-found': 'Usuário não encontrado.',
      'auth/wrong-password': 'Senha incorreta.',
      'auth/invalid-credential': 'Email ou senha incorretos.',
      'auth/too-many-requests': 'Muitas tentativas. Tente novamente em alguns minutos.',
      'auth/network-request-failed': 'Sem conexão com a internet.',
    };
    const msg = msgs[err.code] || err.message || 'Erro ao fazer login.';
    const e = new Error(msg);
    e.code = err.code;
    return e;
  }

  /* ========== Feriados e regras bancárias ========== */
  const FIXED_HOLIDAYS = [
    [1, 1],   // Confraternização Universal
    [4, 21],  // Tiradentes
    [5, 1],   // Dia do Trabalho
    [9, 7],   // Independência
    [10, 12], // Nossa Senhora Aparecida
    [11, 2],  // Finados
    [11, 15], // Proclamação da República
    [11, 20], // Consciência Negra (nacional desde 2024)
    [12, 25], // Natal
  ];

  function easterSunday(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const L = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * L) / 451);
    const month = Math.floor((h + L - 7 * m + 114) / 31);
    const day = ((h + L - 7 * m + 114) % 31) + 1;
    return new Date(year, month - 1, day);
  }

  function movableHolidays(year) {
    const e = easterSunday(year);
    return [addDays(e, -48), addDays(e, -47), addDays(e, -2), addDays(e, 60)];
  }

  const holidayCache = {};
  function isHoliday(d) {
    const y = d.getFullYear();
    if (!holidayCache[y]) {
      const set = new Set();
      FIXED_HOLIDAYS.forEach(([m, day]) => set.add(dateKey(new Date(y, m - 1, day))));
      movableHolidays(y).forEach(h => set.add(dateKey(h)));
      holidayCache[y] = set;
    }
    return holidayCache[y].has(dateKey(d));
  }

  function isBusinessDay(d) {
    const wd = d.getDay();
    if (wd === 0 || wd === 6) return false;
    if (isHoliday(d)) return false;
    return true;
  }

  function nextBusinessDay(d) {
    let r = new Date(d);
    while (!isBusinessDay(r)) r = addDays(r, 1);
    return r;
  }

  function nextBusinessDayStrict(d) {
    let r = addDays(d, 1);
    while (!isBusinessDay(r)) r = addDays(r, 1);
    return r;
  }

  /* Pagar: data efetiva = próximo dia útil a partir do vencimento */
  function effectiveDatePagar(due) { return nextBusinessDay(due); }

  /* Receber: cliente paga no próximo dia útil, compensa no dia útil seguinte (D+1) */
  function effectiveDateReceber(due) {
    const payDay = nextBusinessDay(due);
    return nextBusinessDayStrict(payDay);
  }

  /* ========== Date helpers ========== */
  function addDays(d, n) {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return stripTime(r);
  }
  function stripTime(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function dateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function parseDateKey(k) {
    const [y, m, d] = k.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function parseDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v) ? null : stripTime(v);
    if (typeof v === 'number') {
      const d = new Date(Math.round((v - 25569) * 86400 * 1000));
      return isNaN(d) ? null : stripTime(d);
    }
    const s = String(v).trim();
    let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) {
      let [_, dd, mm, yy] = m;
      if (yy.length === 2) yy = '20' + yy;
      const d = new Date(+yy, +mm - 1, +dd);
      return isNaN(d) ? null : stripTime(d);
    }
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) {
      const d = new Date(+m[1], +m[2] - 1, +m[3]);
      return isNaN(d) ? null : stripTime(d);
    }
    const d = new Date(s);
    return isNaN(d) ? null : stripTime(d);
  }
  function parseValue(v) {
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    let s = String(v).trim();
    s = s.replace(/R\$\s?/gi, '').replace(/\s/g, '');
    if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  /* ========== Formatters ========== */
  const fmtMoney = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtMoneyShort = v => Number(v || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const fmtCellMoney = v => Math.abs(v) < 0.005 ? '–' : fmtMoneyShort(v);
  const fmtFullDate = d => d.toLocaleDateString('pt-BR');
  const fmtHeaderDate = d => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  const weekdayShort = d => ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][d.getDay()];
  const weekdayFull = d => ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'][d.getDay()];
  const isWeekend = d => d.getDay() === 0 || d.getDay() === 6;
  function fmtRelativeTime(ts) {
    const diff = (Date.now() - ts) / 1000;
    if (diff < 60) return 'agora';
    if (diff < 3600) return `${Math.floor(diff / 60)}min atrás`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h atrás`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d atrás`;
    return new Date(ts).toLocaleDateString('pt-BR');
  }
  function fmtDateTimeFull(ts) {
    const d = new Date(ts);
    const months = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${d.getDate()} de ${months[d.getMonth()]} de ${d.getFullYear()} às ${hh}:${mm}`;
  }

  /* ========== HTML escape ==========
     Centralizado. SEMPRE usar ao inserir dados no DOM via innerHTML.
     ================================= */
  function escapeHTML(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /* Limpa nome do fornecedor/cliente, removendo prefixo numérico "000123-" e normalizando em CAIXA ALTA */
  function cleanEntityName(name) {
    const s = String(name == null ? '' : name).trim();
    const cleaned = s.replace(/^0*\d+\s*[-–]\s*/, '').trim() || s;
    return cleaned.toUpperCase();
  }

  /* Normaliza nome para uso como chave única (remove acentos e caracteres especiais que não podem ir em chaves Firebase) */
  function normalizeKey(name) {
    const s = String(name == null ? '' : name).trim().toUpperCase();
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[.#$/\[\]]/g, '_');
  }

  /* ========== Local storage com tratamento de quota ========== */
  function safeSetItem(key, value) {
    try {
      localStorage.setItem(key, value);
      return { ok: true };
    } catch (err) {
      if (err.name === 'QuotaExceededError' || err.code === 22) {
        return { ok: false, error: 'Armazenamento local cheio. Tente limpar a lixeira ou reduzir o período de importação.' };
      }
      return { ok: false, error: err.message };
    }
  }
  function safeGetItem(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      if (v == null) return fallback;
      return v;
    } catch { return fallback; }
  }
  function safeGetJSON(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      if (v == null) return fallback;
      return JSON.parse(v);
    } catch { return fallback; }
  }
  function safeSetJSON(key, obj) {
    try {
      return safeSetItem(key, JSON.stringify(obj));
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /* ========== Topbar construction ========== */
  const BRAND_SVG = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" role="img" aria-label="Filadelfia">
      <path d="M 55 58 L 172 58 Q 185 58 185 71 L 185 88 Q 185 101 172 101 L 118 101 L 118 128 Q 118 140 105 140 L 92 140 Q 79 140 79 128 L 79 71 Q 79 58 92 58 Z" fill="#ffffff"/>
      <path d="M 82 115 L 199 115 Q 212 115 212 128 L 212 145 Q 212 158 199 158 L 145 158 L 145 185 Q 145 197 132 197 L 119 197 Q 106 197 106 185 L 106 128 Q 106 115 119 115 Z" fill="#1CA7EC"/>
    </svg>
  `;

  function renderTopbar(activePage) {
    const topbar = document.querySelector('.topbar');
    if (!topbar) return;
    const u = state.user || { displayName: 'Visitante', email: '' };
    const initials = (u.displayName || u.email || 'U')
      .split(/\s+/)
      .map(s => s[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase();

    topbar.innerHTML = `
      <a class="brand" href="index.html">
        <div class="brand-mark">${BRAND_SVG}</div>
        <div class="brand-text">
          <span class="name">Filadelfia</span>
          <span class="sub">Sistema Financeiro</span>
        </div>
      </a>
      <nav class="nav" id="nav">
        <a href="index.html" ${activePage === 'fluxo' ? 'class="active"' : ''}>Fluxo de Caixa</a>
        <a href="dashboard.html" ${activePage === 'dashboard' ? 'class="active"' : ''}>Dashboard</a>
        <a href="lancamentos.html" ${activePage === 'lancamentos' ? 'class="active"' : ''}>Lançamentos</a>
        <a href="comentarios.html" ${activePage === 'comentarios' ? 'class="active"' : ''}>Comentários</a>
        <a href="categorias.html" ${activePage === 'categorias' ? 'class="active"' : ''}>Categorias</a>
        <a href="processamento.html" ${activePage === 'processamento' ? 'class="active"' : ''}>Processamento</a>
      </nav>
      <div class="topbar-meta">
        <div class="sync-badge" id="sync-badge" title="Status de sincronização">
          <span class="sync-dot"></span>
          <span id="sync-text">—</span>
        </div>
        <div class="user-chip" id="user-chip">
          <button class="avatar" id="user-avatar-btn" title="${escapeHTML(u.email)}" aria-label="Menu do usuário">${escapeHTML(initials)}</button>
          <span class="name-hide-mobile">${escapeHTML(u.displayName)}</span>
          <button id="btn-logout" class="name-hide-mobile" title="Sair">Sair</button>
          <div class="user-dropdown" id="user-dropdown" hidden>
            <div class="user-dropdown-info">
              <div class="user-dropdown-name">${escapeHTML(u.displayName || '')}</div>
              <div class="user-dropdown-email">${escapeHTML(u.email || '')}</div>
            </div>
            <button id="btn-logout-mobile" class="user-dropdown-logout">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
              Sair
            </button>
          </div>
        </div>
        <button class="menu-toggle" id="menu-toggle" aria-label="Menu">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18"/><path d="M3 6h18"/><path d="M3 18h18"/></svg>
        </button>
      </div>
    `;

    document.getElementById('menu-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('nav')?.classList.toggle('open');
      document.getElementById('user-dropdown')?.setAttribute('hidden', '');
    });
    document.getElementById('btn-logout')?.addEventListener('click', () => {
      if (confirm('Deseja sair da sua conta?')) logout();
    });
    // Avatar dropdown (principalmente para mobile)
    const avatarBtn = document.getElementById('user-avatar-btn');
    const dropdown = document.getElementById('user-dropdown');
    avatarBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      // No desktop, comportamento normal (fazer logout direto via botão ao lado)
      if (window.innerWidth > 860) return;
      if (dropdown.hasAttribute('hidden')) dropdown.removeAttribute('hidden');
      else dropdown.setAttribute('hidden', '');
      document.getElementById('nav')?.classList.remove('open');
    });
    document.getElementById('btn-logout-mobile')?.addEventListener('click', () => {
      if (confirm('Deseja sair da sua conta?')) logout();
    });
    // Fecha dropdown ao clicar fora
    document.addEventListener('click', (e) => {
      if (!dropdown) return;
      if (!e.target.closest('#user-chip')) dropdown.setAttribute('hidden', '');
    });

    if (!IS_FIREBASE_CONFIGURED) {
      updateSyncBadge('offline', 'Sem Firebase');
    } else if (state.fbDB) {
      state.fbDB.ref('.info/connected').on('value', snap => {
        const isConnected = !!snap.val();
        if (isConnected) {
          updateSyncBadge('connected', 'Sincronizado');
          // Ao conectar, busca metadados dos dados importados para montar tooltip informativo
          refreshSyncTooltip();
        } else {
          updateSyncBadge('offline', 'Offline');
        }
      });
    }
  }

  // Busca metadados do Firebase para atualizar o tooltip do sync badge
  // com a última data de importação (útil para saber se os dados estão em dia)
  async function refreshSyncTooltip() {
    try {
      const badge = document.getElementById('sync-badge');
      if (!badge) return;
      const snap = await dbRef('dados_importados_meta').once('value');
      const meta = snap.val();
      if (meta && meta.processedAt) {
        const d = new Date(meta.processedAt);
        const dateStr = d.toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        badge.title = `Sincronizado · dados importados em ${dateStr} por ${meta.processedBy || 'desconhecido'}`;
      } else {
        badge.title = 'Sincronizado · nenhuma importação registrada';
      }
    } catch {}
  }

  function updateSyncBadge(status, text) {
    const badge = document.getElementById('sync-badge');
    if (!badge) return;
    badge.className = 'sync-badge ' + status;
    const t = document.getElementById('sync-text');
    if (t) t.textContent = text;
    // Atualiza tooltip com base no status atual (em mobile só o tooltip comunica)
    if (status === 'offline') {
      badge.title = 'Sem conexão com o servidor';
    } else if (status === 'syncing') {
      badge.title = 'Sincronizando dados…';
    } else if (status === 'connected') {
      // Tooltip detalhado é atualizado via refreshSyncTooltip quando há metadados
      if (!badge.title || badge.title.startsWith('Sem conexão') || badge.title === 'Status de sincronização') {
        badge.title = 'Sincronizado';
      }
    }
  }

  /* ========== Footer ========== */
  // Preenche o rodapé da página com texto institucional + versão do sistema.
  // Só age se já houver um <footer> no DOM; páginas sem footer (ex: login) ficam limpas.
  function renderFooter() {
    const footer = document.querySelector('footer');
    if (!footer) return;
    const copyText = 'DESENVOLVIDO POR R2 SOLUÇÕES EMPRESARIAIS';
    footer.innerHTML = `
      <span class="footer-text">${copyText}</span>
      <span class="footer-version" title="Versão do sistema">${APP_VERSION}</span>
    `;
  }

  /* ========== Toast ========== */
  let toastTimer = null;
  function showToast(text, type, action) {
    let toast = document.getElementById('global-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'global-toast';
      toast.className = 'toast';
      toast.innerHTML = '<span id="global-toast-text"></span><button id="global-toast-action" class="hidden">Desfazer</button>';
      document.body.appendChild(toast);
    }
    document.getElementById('global-toast-text').textContent = text;
    toast.className = 'toast open ' + (type || 'success');

    const actionBtn = document.getElementById('global-toast-action');
    if (action && action.label && action.action) {
      actionBtn.textContent = action.label;
      actionBtn.classList.remove('hidden');
      actionBtn.onclick = () => { action.action(); hideToast(); };
    } else {
      actionBtn.classList.add('hidden');
    }

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, action ? 6000 : 3000);
  }
  function hideToast() {
    const toast = document.getElementById('global-toast');
    if (toast) toast.classList.remove('open');
  }

  /* ========== Loading overlay ========== */
  function showLoading(text) {
    let overlay = document.getElementById('global-loading');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'global-loading';
      overlay.className = 'loading-overlay';
      overlay.innerHTML = '<div class="spinner"></div><div class="text" id="global-loading-text">Carregando…</div>';
      document.body.appendChild(overlay);
    }
    document.getElementById('global-loading-text').textContent = text || 'Carregando…';
    overlay.classList.add('open');
  }
  function hideLoading() {
    const overlay = document.getElementById('global-loading');
    if (overlay) overlay.classList.remove('open');
  }

  /* ========== Key close support para modais ========== */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    }
  });

  /* ========== Firebase Database (CRUD) ==========
     Todas as operações usam o user.uid para marcar autoria.
     Qualquer usuário autenticado pode ler/escrever categorias (compartilhadas).
     Lançamentos e comentários só podem ser modificados pelo autor.
     ================================================= */
  const DB_ROOT = 'filadelfia';

  function dbReady() {
    return !!state.fbDB;
  }
  function dbRef(path) {
    if (!state.fbDB) throw new Error('Firebase não configurado');
    return state.fbDB.ref(`${DB_ROOT}/${path}`);
  }

  // Lançamentos manuais
  async function createLancamento(data) {
    const ref = dbRef('lancamentos').push();
    const payload = {
      ...data,
      authorUid: state.user?.uid || null,
      authorName: state.user?.displayName || state.user?.email || 'Anônimo',
      authorEmail: state.user?.email || null,
      createdAt: firebase.database.ServerValue.TIMESTAMP,
      updatedAt: firebase.database.ServerValue.TIMESTAMP,
    };
    await ref.set(payload);
    return ref.key;
  }
  async function updateLancamento(id, data) {
    const payload = { ...data, updatedAt: firebase.database.ServerValue.TIMESTAMP };
    await dbRef(`lancamentos/${id}`).update(payload);
  }
  async function deleteLancamento(id) {
    await dbRef(`lancamentos/${id}`).remove();
  }
  function subscribeLancamentos(callback) {
    if (!state.fbDB) { callback({}); return () => {}; }
    const ref = dbRef('lancamentos');
    const handler = snap => callback(snap.val() || {});
    ref.on('value', handler);
    return () => ref.off('value', handler);
  }

  // Títulos importados ocultados (soft-delete sincronizado)
  async function hideTitle(titleId, titleData) {
    await dbRef(`deletados/${titleId}`).set({
      ...titleData,
      deletedBy: state.user?.uid || null,
      deletedByName: state.user?.displayName || state.user?.email || 'Anônimo',
      deletedAt: firebase.database.ServerValue.TIMESTAMP,
    });
  }
  async function restoreTitle(titleId) {
    await dbRef(`deletados/${titleId}`).remove();
  }
  function subscribeHiddenTitles(callback) {
    if (!state.fbDB) { callback({}); return () => {}; }
    const ref = dbRef('deletados');
    const handler = snap => callback(snap.val() || {});
    ref.on('value', handler);
    return () => ref.off('value', handler);
  }

  // Categorias (nativamente existe "DEMAIS FORNECEDORES")
  const DEFAULT_CATEGORY_NAME = 'DEMAIS FORNECEDORES';

  async function ensureDefaultCategory() {
    if (!state.fbDB) return null;
    const snap = await dbRef('categorias').once('value');
    const cats = snap.val() || {};
    const existing = Object.entries(cats).find(([id, c]) => c && c.nativa === true);
    if (existing) return existing[0];
    // Cria nativa
    const id = 'cat_default_demais';
    await dbRef(`categorias/${id}`).set({
      nome: DEFAULT_CATEGORY_NAME,
      cor: '#6b7280',
      nativa: true,
      createdBy: state.user?.uid || null,
      createdByName: state.user?.displayName || state.user?.email || 'Sistema',
      createdAt: firebase.database.ServerValue.TIMESTAMP,
    });
    return id;
  }

  async function createCategoria(nome, cor) {
    const id = 'cat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    await dbRef(`categorias/${id}`).set({
      nome: String(nome).trim().toUpperCase(),
      cor: cor || '#6b7280',
      nativa: false,
      createdBy: state.user?.uid || null,
      createdByName: state.user?.displayName || state.user?.email || 'Anônimo',
      createdAt: firebase.database.ServerValue.TIMESTAMP,
    });
    return id;
  }
  async function updateCategoria(id, data) {
    const payload = { ...data };
    if (payload.nome) payload.nome = String(payload.nome).trim().toUpperCase();
    await dbRef(`categorias/${id}`).update(payload);
  }
  async function deleteCategoria(id) {
    await dbRef(`categorias/${id}`).remove();
  }
  function subscribeCategorias(callback) {
    if (!state.fbDB) { callback({}); return () => {}; }
    const ref = dbRef('categorias');
    const handler = snap => callback(snap.val() || {});
    ref.on('value', handler);
    return () => ref.off('value', handler);
  }

  // Atribuição fornecedor -> categoria (chave = nome normalizado)
  async function setFornecedorCategoria(fornecedor, categoriaId) {
    const key = normalizeKey(fornecedor);
    if (!key) return;
    if (categoriaId) {
      await dbRef(`fornecedor_categoria/${key}`).set({
        categoriaId,
        fornecedorNome: String(fornecedor).toUpperCase(),
        assignedBy: state.user?.uid || null,
        assignedAt: firebase.database.ServerValue.TIMESTAMP,
      });
    } else {
      await dbRef(`fornecedor_categoria/${key}`).remove();
    }
  }
  function subscribeFornecedorCategoria(callback) {
    if (!state.fbDB) { callback({}); return () => {}; }
    const ref = dbRef('fornecedor_categoria');
    const handler = snap => callback(snap.val() || {});
    ref.on('value', handler);
    return () => ref.off('value', handler);
  }

  // Comentários (todos)
  function subscribeAllComments(callback) {
    if (!state.fbDB) { callback({}); return () => {}; }
    const ref = dbRef('comentarios');
    const handler = snap => callback(snap.val() || {});
    ref.on('value', handler);
    return () => ref.off('value', handler);
  }
  // Soft-delete: marca como excluído mas mantém os dados para eventual restauração
  async function deleteComment(cellKey, commentId) {
    await dbRef(`comentarios/${cellKey}/${commentId}`).update({
      deleted: true,
      deletedBy: state.user?.uid || null,
      deletedByName: state.user?.displayName || state.user?.email || 'Anônimo',
      deletedAt: firebase.database.ServerValue.TIMESTAMP,
    });
  }
  // Restaura comentário soft-deleted (qualquer autenticado pode restaurar)
  async function restoreComment(cellKey, commentId) {
    await dbRef(`comentarios/${cellKey}/${commentId}`).update({
      deleted: null,
      deletedBy: null,
      deletedByName: null,
      deletedAt: null,
      restoredBy: state.user?.uid || null,
      restoredByName: state.user?.displayName || state.user?.email || 'Anônimo',
      restoredAt: firebase.database.ServerValue.TIMESTAMP,
    });
  }
  // Exclusão permanente (só para uso em lixeira, se o usuário quiser apagar definitivamente)
  async function purgeComment(cellKey, commentId) {
    await dbRef(`comentarios/${cellKey}/${commentId}`).remove();
  }

  /* ========== Dados importados (relatórios SIA) ==========
     Otimização: os metadados (processedAt, períodos, contagens) são salvos
     em um nó separado e leve (`dados_importados_meta`). O payload pesado
     (com milhares de títulos) fica em `dados_importados`. Assim, para saber
     se temos a versão mais recente, basta consultar os metadados.
     ======================================================== */
  async function saveImportedData(payload) {
    if (!state.fbDB) throw new Error('Firebase não configurado');
    // Metadados leves, separados do payload pesado
    const meta = {
      processedAt: payload.processedAt,
      processedBy: payload.processedBy || null,
      periodStart: payload.periodStart || null,
      periodEnd: payload.periodEnd || null,
      countPagar: (payload.titulosPagar || []).length,
      countReceber: (payload.titulosReceber || []).length,
      version: payload.version || 1,
    };
    // Multi-path update para garantir atomicidade
    await dbRef('').update({
      'dados_importados': payload,
      'dados_importados_meta': meta,
    });
  }
  // Busca só os metadados (rápido, poucos KB)
  async function fetchImportedDataMeta() {
    if (!state.fbDB) return null;
    const snap = await dbRef('dados_importados_meta').once('value');
    return snap.val();
  }
  // Busca o payload completo (pode ser pesado com milhares de títulos)
  async function fetchImportedData() {
    if (!state.fbDB) return null;
    const snap = await dbRef('dados_importados').once('value');
    return snap.val();
  }
  // Assinatura em tempo real APENAS nos metadados — quando chega um meta novo,
  // o consumidor decide se precisa baixar o payload completo
  function subscribeImportedDataMeta(callback) {
    if (!state.fbDB) { callback(null); return () => {}; }
    const ref = dbRef('dados_importados_meta');
    const handler = snap => callback(snap.val());
    ref.on('value', handler);
    return () => ref.off('value', handler);
  }
  // Assinatura ao payload completo (mais pesada, usar com cuidado)
  function subscribeImportedData(callback) {
    if (!state.fbDB) { callback(null); return () => {}; }
    const ref = dbRef('dados_importados');
    const handler = snap => callback(snap.val());
    ref.on('value', handler);
    return () => ref.off('value', handler);
  }
  // Remove payload e metadados (para o "Limpar tudo" global)
  async function clearImportedData() {
    if (!state.fbDB) return;
    await dbRef('').update({
      'dados_importados': null,
      'dados_importados_meta': null,
    });
  }

  /* ========== Export público ========== */
  window.Filadelfia = {
    APP_VERSION,
    KEYS,
    IS_FIREBASE_CONFIGURED,
    state,
    initFirebase,
    Auth: { requireAuth, login, logout },
    Dates: {
      FIXED_HOLIDAYS, isHoliday, isBusinessDay, isWeekend,
      nextBusinessDay, nextBusinessDayStrict,
      effectiveDatePagar, effectiveDateReceber,
      addDays, stripTime, dateKey, parseDateKey, parseDate, parseValue,
    },
    Fmt: {
      fmtMoney, fmtMoneyShort, fmtCellMoney,
      fmtFullDate, fmtHeaderDate, weekdayShort, weekdayFull,
      fmtRelativeTime, fmtDateTimeFull,
    },
    escapeHTML,
    cleanEntityName,
    normalizeKey,
    Storage: { safeSetItem, safeGetItem, safeGetJSON, safeSetJSON },
    DB: {
      dbReady, dbRef,
      createLancamento, updateLancamento, deleteLancamento, subscribeLancamentos,
      hideTitle, restoreTitle, subscribeHiddenTitles,
      createCategoria, updateCategoria, deleteCategoria, subscribeCategorias, ensureDefaultCategory, DEFAULT_CATEGORY_NAME,
      setFornecedorCategoria, subscribeFornecedorCategoria,
      subscribeAllComments, deleteComment, restoreComment, purgeComment,
      saveImportedData, fetchImportedData, fetchImportedDataMeta,
      subscribeImportedData, subscribeImportedDataMeta, clearImportedData,
    },
    UI: { renderTopbar, renderFooter, updateSyncBadge, showToast, hideToast, showLoading, hideLoading },
    Config: { firebaseConfig },
  };

  /* ========== Auto-render do rodapé ========== */
  // Toda página que carrega shared.js ganha o rodapé com versão automaticamente.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderFooter);
  } else {
    renderFooter();
  }
})();
