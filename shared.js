/* =======================================================================
   FILADÉLFIA — Sistema Financeiro
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

  /* Limpa nome do fornecedor/cliente, removendo prefixo numérico "000123-" */
  function cleanEntityName(name) {
    const s = String(name == null ? '' : name).trim();
    return s.replace(/^0*\d+\s*[-–]\s*/, '').trim() || s;
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
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" role="img" aria-label="Filadélfia">
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
          <span class="name">Filadélfia</span>
          <span class="sub">Sistema Financeiro</span>
        </div>
      </a>
      <button class="menu-toggle" id="menu-toggle" aria-label="Menu">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18"/><path d="M3 6h18"/><path d="M3 18h18"/></svg>
      </button>
      <nav class="nav" id="nav">
        <a href="index.html" ${activePage === 'fluxo' ? 'class="active"' : ''}>Fluxo de Caixa</a>
        <a href="dashboard.html" ${activePage === 'dashboard' ? 'class="active"' : ''}>Dashboard</a>
        <a href="processamento.html" ${activePage === 'processamento' ? 'class="active"' : ''}>Processamento</a>
      </nav>
      <div class="topbar-meta">
        <div class="sync-badge" id="sync-badge" title="Status de sincronização">
          <span class="sync-dot"></span>
          <span id="sync-text">—</span>
        </div>
        <div class="user-chip">
          <div class="avatar" title="${escapeHTML(u.email)}">${escapeHTML(initials)}</div>
          <span class="name-hide-mobile">${escapeHTML(u.displayName)}</span>
          <button id="btn-logout" title="Sair">Sair</button>
        </div>
      </div>
    `;

    document.getElementById('menu-toggle')?.addEventListener('click', () => {
      document.getElementById('nav')?.classList.toggle('open');
    });
    document.getElementById('btn-logout')?.addEventListener('click', () => {
      if (confirm('Deseja sair da sua conta?')) logout();
    });

    if (!IS_FIREBASE_CONFIGURED) {
      updateSyncBadge('offline', 'Sem Firebase');
    } else if (state.fbDB) {
      state.fbDB.ref('.info/connected').on('value', snap => {
        updateSyncBadge(snap.val() ? 'connected' : 'offline', snap.val() ? 'Sincronizado' : 'Offline');
      });
    }
  }

  function updateSyncBadge(status, text) {
    const badge = document.getElementById('sync-badge');
    if (!badge) return;
    badge.className = 'sync-badge ' + status;
    const t = document.getElementById('sync-text');
    if (t) t.textContent = text;
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

  /* ========== Export público ========== */
  window.Filadelfia = {
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
    Storage: { safeSetItem, safeGetItem, safeGetJSON, safeSetJSON },
    UI: { renderTopbar, updateSyncBadge, showToast, hideToast, showLoading, hideLoading },
    Config: { firebaseConfig },
  };
})();
