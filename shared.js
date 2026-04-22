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
  const APP_VERSION = 'v4.4';

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
          role: 'admin',
          isDemo: true,
        };
        resolve(state.user);
        return;
      }
      state.fbAuth.onAuthStateChanged(async (fbUser) => {
        if (!fbUser) {
          const returnTo = encodeURIComponent(location.pathname.split('/').pop() || 'index.html');
          location.href = 'login.html?return=' + returnTo;
          return;
        }
        state.user = {
          uid: fbUser.uid,
          email: fbUser.email,
          displayName: fbUser.displayName || fbUser.email.split('@')[0],
          role: 'editor', // padrão temporário até carregar o real
        };
        try { localStorage.setItem(KEYS.AUTHOR, state.user.displayName); } catch {}
        try { sessionStorage.setItem(KEYS.SESSION_USER, JSON.stringify(state.user)); } catch {}
        // Garante registro em /usuarios e carrega o role
        try {
          await ensureUserRecord();
        } catch (err) {
          console.warn('ensureUserRecord falhou:', err);
        }
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
      // Registra login (best-effort)
      try {
        state.user = { uid: cred.user.uid, email: cred.user.email, displayName: cred.user.displayName || email.split('@')[0] };
        await ensureUserRecord();
        await auditLog('auth.login', 'session', cred.user.uid, { email });
      } catch {}
      return cred.user;
    } catch (err) {
      throw translateAuthError(err);
    }
  }

  async function logout() {
    // Registra logout antes de sair (best-effort, não bloqueia)
    try { await auditLog('auth.logout', 'session', state.user?.uid || null, {}); } catch {}
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

  /* ========== Perfis de acesso (Roles) ==========
     3 níveis:
     - admin: pode tudo (config do sistema, gerenciar usuários, ver auditoria)
     - editor: CRUD de dados (lançamentos, comentários, categorias, saldos, importar)
     - viewer: só leitura

     Primeiro usuário que abre o sistema e não encontra NENHUM admin
     se promove automaticamente a admin (bootstrap inicial).

     Além disso, certos e-mails são SEMPRE promovidos a admin automaticamente
     (lista HARDCODED_ADMINS), mesmo que o registro já exista com role diferente.
     Útil para garantir acesso administrativo permanente.
     ================================================ */
  const ROLE_ADMIN = 'admin';
  const ROLE_EDITOR = 'editor';
  const ROLE_VIEWER = 'viewer';

  // E-mails que sempre têm perfil admin (promovidos automaticamente no login)
  const HARDCODED_ADMINS = [
    'r2@solucoesr2.com.br',
  ];

  // Hierarquia: admin > editor > viewer. Um role "tem permissão" se for maior ou igual.
  const ROLE_WEIGHT = { admin: 3, editor: 2, viewer: 1 };

  async function ensureUserRecord() {
    if (!state.user || state.user.isDemo) return;
    if (!state.fbDB) return;
    const uid = state.user.uid;
    const email = (state.user.email || '').toLowerCase();
    const isHardcodedAdmin = HARDCODED_ADMINS.includes(email);
    const ref = state.fbDB.ref(`filadelfia/usuarios/${uid}`);
    const snap = await ref.once('value');
    const existing = snap.val();

    if (!existing) {
      // Primeiro acesso: verifica se JÁ existe algum admin no sistema
      const allSnap = await state.fbDB.ref('filadelfia/usuarios').once('value');
      const all = allSnap.val() || {};
      const hasAnyAdmin = Object.values(all).some(u => u && u.role === ROLE_ADMIN);
      // Admin se: é hardcoded OU primeiro usuário do sistema
      const role = (isHardcodedAdmin || !hasAnyAdmin) ? ROLE_ADMIN : ROLE_EDITOR;

      await ref.set({
        uid,
        email: state.user.email || '',
        displayName: state.user.displayName || state.user.email || 'Usuário',
        role,
        createdAt: firebase.database.ServerValue.TIMESTAMP,
        lastLoginAt: firebase.database.ServerValue.TIMESTAMP,
      });
      state.user.role = role;
      if (role === ROLE_ADMIN) {
        try { await auditLog('user.bootstrap_admin', 'user', uid, { email: state.user.email }); } catch {}
      }
    } else {
      state.user.role = existing.role || ROLE_EDITOR;
      state.user.displayName = existing.displayName || state.user.displayName;

      // Se é hardcoded admin mas role está diferente, corrige automaticamente
      if (isHardcodedAdmin && existing.role !== ROLE_ADMIN) {
        try {
          await ref.update({
            role: ROLE_ADMIN,
            lastLoginAt: firebase.database.ServerValue.TIMESTAMP,
          });
          state.user.role = ROLE_ADMIN;
          console.log(`[Auth] ${email} foi promovido a admin (hardcoded).`);
        } catch (err) {
          console.warn('[Auth] Falha ao promover hardcoded admin:', err);
          // Atualiza só lastLogin
          ref.update({ lastLoginAt: firebase.database.ServerValue.TIMESTAMP }).catch(() => {});
        }
      } else {
        // Atualiza lastLoginAt (best-effort, não bloqueia)
        ref.update({ lastLoginAt: firebase.database.ServerValue.TIMESTAMP }).catch(() => {});
      }
    }
  }

  // Verifica se o usuário atual tem permissão para um role mínimo
  function hasRole(minRole) {
    const current = state.user?.role || ROLE_VIEWER;
    return (ROLE_WEIGHT[current] || 0) >= (ROLE_WEIGHT[minRole] || 0);
  }

  function isAdmin() { return hasRole(ROLE_ADMIN); }
  function isEditor() { return hasRole(ROLE_EDITOR); }
  function isViewer() { return !!state.user; } // qualquer autenticado é pelo menos viewer

  // Gerenciamento de usuários (chamado pela página de configurações)
  async function listUsers() {
    if (!state.fbDB) return [];
    const snap = await state.fbDB.ref('filadelfia/usuarios').once('value');
    const val = snap.val() || {};
    return Object.values(val).sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
  }

  async function updateUserRole(uid, newRole) {
    if (!isAdmin()) throw new Error('Apenas administradores podem alterar perfis');
    if (![ROLE_ADMIN, ROLE_EDITOR, ROLE_VIEWER].includes(newRole)) {
      throw new Error('Perfil inválido');
    }
    // Proteção: não permite remover o último admin
    if (newRole !== ROLE_ADMIN) {
      const users = await listUsers();
      const admins = users.filter(u => u.role === ROLE_ADMIN);
      if (admins.length === 1 && admins[0].uid === uid) {
        throw new Error('Não é possível remover o último administrador do sistema');
      }
    }
    await state.fbDB.ref(`filadelfia/usuarios/${uid}/role`).set(newRole);
    await auditLog('user.role_changed', 'user', uid, { newRole });
  }

  /* ========== Trilha de auditoria (Audit) ==========
     Registra ações relevantes em /filadelfia/audit com retenção de 60 dias.
     Formato: { action, actorUid, actorName, targetType, targetId, details, ts }

     Ações registradas:
     - auth.login, auth.logout
     - user.bootstrap_admin, user.role_changed
     - import.applied, import.rollback
     - lancamento.created, lancamento.updated, lancamento.deleted
     - title.hidden, title.restored
     - comment.created, comment.deleted, comment.restored, comment.purged
     - category.created, category.updated, category.deleted
     - fornecedor.categorized
     - saldo.created (fase 3)
     - bank.created, bank.deleted (fase 3)
     - backup.downloaded, backup.restored (fase 4)
     - config.updated
     ================================================ */
  const AUDIT_RETENTION_DAYS = 60;

  async function auditLog(action, targetType, targetId, details) {
    try {
      if (!state.fbDB || !state.user || state.user.isDemo) return;
      const actorUid = state.user.uid;
      const actorName = state.user.displayName || state.user.email || 'Anônimo';
      await state.fbDB.ref('filadelfia/audit').push({
        action,
        actorUid,
        actorName,
        targetType: targetType || null,
        targetId: targetId || null,
        details: details || {},
        ts: firebase.database.ServerValue.TIMESTAMP,
      });
    } catch (err) {
      console.warn('auditLog falhou:', err);
    }
  }

  // Consulta auditoria (para a página de configurações)
  async function fetchAuditEntries({ limit = 200, since = null } = {}) {
    if (!state.fbDB) return [];
    let ref = state.fbDB.ref('filadelfia/audit').orderByChild('ts');
    if (since) ref = ref.startAt(since);
    ref = ref.limitToLast(limit);
    const snap = await ref.once('value');
    const val = snap.val() || {};
    return Object.entries(val)
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }

  // Limpeza automática: remove entradas mais antigas que o período de retenção.
  // Chamada ocasionalmente (ex: quando admin abre página de configurações).
  async function cleanupAuditLog() {
    if (!state.fbDB || !isAdmin()) return 0;
    const cutoff = Date.now() - (AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const snap = await state.fbDB.ref('filadelfia/audit').orderByChild('ts').endAt(cutoff).once('value');
    const val = snap.val() || {};
    const updates = {};
    Object.keys(val).forEach(id => { updates[id] = null; });
    if (Object.keys(updates).length) {
      await state.fbDB.ref('filadelfia/audit').update(updates);
    }
    return Object.keys(updates).length;
  }

  // Traduz o código da ação para descrição amigável
  const AUDIT_ACTION_LABELS = {
    'auth.login': 'Fez login',
    'auth.logout': 'Saiu do sistema',
    'user.bootstrap_admin': 'Primeiro administrador cadastrado',
    'user.role_changed': 'Alterou perfil de usuário',
    'import.applied': 'Importou relatório SIA',
    'import.rollback': 'Restaurou importação anterior',
    'lancamento.created': 'Criou lançamento manual',
    'lancamento.updated': 'Editou lançamento manual',
    'lancamento.deleted': 'Excluiu lançamento manual',
    'title.hidden': 'Ocultou título importado',
    'title.restored': 'Restaurou título oculto',
    'comment.created': 'Criou comentário',
    'comment.deleted': 'Excluiu comentário',
    'comment.restored': 'Restaurou comentário',
    'comment.purged': 'Apagou comentário definitivamente',
    'category.created': 'Criou categoria',
    'category.updated': 'Editou categoria',
    'category.deleted': 'Excluiu categoria',
    'fornecedor.categorized': 'Atribuiu fornecedor a categoria',
    'saldo.created': 'Lançou saldo bancário',
    'bank.created': 'Criou conta bancária',
    'bank.deleted': 'Removeu conta bancária',
    'backup.downloaded': 'Baixou backup do sistema',
    'backup.restored': 'Restaurou backup',
    'config.updated': 'Alterou configurações',
  };

  function auditActionLabel(action) {
    return AUDIT_ACTION_LABELS[action] || action;
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
  const fmtMoney = v => {
    const n = Number(v);
    return (Number.isFinite(n) ? n : 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };
  const fmtMoneyShort = v => {
    const n = Number(v);
    return (Number.isFinite(n) ? n : 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  };
  const fmtCellMoney = v => Math.abs(Number(v) || 0) < 0.005 ? '–' : fmtMoneyShort(v);
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
    const u = state.user || { displayName: 'Visitante', email: '', role: 'viewer' };
    const initials = (u.displayName || u.email || 'U')
      .split(/\s+/)
      .map(s => s[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase();

    // Badge do perfil
    const roleLabels = { admin: 'ADMIN', editor: 'EDITOR', viewer: 'VIEWER' };
    const roleLabel = roleLabels[u.role] || 'EDITOR';
    const roleClass = 'role-' + (u.role || 'editor');

    // Link para Configurações só aparece para admin
    const configLink = isAdmin()
      ? `<a href="configuracoes.html" ${activePage === 'configuracoes' ? 'class="active"' : ''}>Configurações</a>`
      : '';

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
        ${configLink}
      </nav>
      <div class="topbar-meta">
        <div class="sync-badge" id="sync-badge" title="Status de sincronização">
          <span class="sync-dot"></span>
          <span id="sync-text">—</span>
        </div>
        <div class="user-chip" id="user-chip">
          <button class="avatar" id="user-avatar-btn" title="${escapeHTML(u.email)}" aria-label="Menu do usuário">${escapeHTML(initials)}</button>
          <span class="name-hide-mobile">${escapeHTML(u.displayName)}</span>
          <span class="role-badge ${roleClass} name-hide-mobile" title="Perfil de acesso">${roleLabel}</span>
          <button id="btn-logout" class="name-hide-mobile" title="Sair">Sair</button>
          <div class="user-dropdown" id="user-dropdown" hidden>
            <div class="user-dropdown-info">
              <div class="user-dropdown-name">${escapeHTML(u.displayName || '')}</div>
              <div class="user-dropdown-email">${escapeHTML(u.email || '')}</div>
              <div class="user-dropdown-role ${roleClass}">${roleLabel}</div>
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

    // Fase 6 — garantir que modal de busca global e atalhos estão prontos
    ensureSearchModal();
    setupKeyboardShortcuts();
  }

  /* ========== Fase 6: Busca global e atalhos ==========
     Busca em fornecedores, clientes, categorias, bancos, lançamentos, comentários.
     Ativada por Ctrl+K (desktop) ou Cmd+K (Mac).
     ================================================ */
  function ensureSearchModal() {
    if (document.getElementById('global-search-modal')) return; // já existe
    const modal = document.createElement('div');
    modal.id = 'global-search-modal';
    modal.className = 'global-search-modal';
    modal.setAttribute('hidden', '');
    modal.innerHTML = `
      <div class="gs-backdrop"></div>
      <div class="gs-panel">
        <div class="gs-input-wrap">
          <span class="gs-icon">🔍</span>
          <input type="text" id="global-search-input" class="gs-input" placeholder="Buscar em tudo — fornecedores, lançamentos, comentários, bancos…" />
          <span class="gs-kbd">esc</span>
        </div>
        <div class="gs-results" id="global-search-results">
          <div class="gs-empty">Digite para começar a buscar</div>
        </div>
        <div class="gs-footer">
          <span><kbd>↑↓</kbd> navegar</span>
          <span><kbd>↵</kbd> abrir</span>
          <span><kbd>esc</kbd> fechar</span>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const input = modal.querySelector('#global-search-input');
    const resultsEl = modal.querySelector('#global-search-results');

    let currentResults = [];
    let selectedIndex = 0;

    input.addEventListener('input', debounce(async () => {
      const q = input.value.trim().toLowerCase();
      if (!q) {
        resultsEl.innerHTML = '<div class="gs-empty">Digite para começar a buscar</div>';
        currentResults = [];
        return;
      }
      currentResults = await performGlobalSearch(q);
      renderSearchResults(resultsEl, currentResults, q);
      selectedIndex = 0;
      updateSelectedResult(resultsEl, selectedIndex);
    }, 150));

    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (currentResults.length) {
          selectedIndex = Math.min(selectedIndex + 1, currentResults.length - 1);
          updateSelectedResult(resultsEl, selectedIndex);
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedIndex = Math.max(selectedIndex - 1, 0);
        updateSelectedResult(resultsEl, selectedIndex);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const r = currentResults[selectedIndex];
        if (r) {
          closeGlobalSearch();
          if (r.url) location.href = r.url;
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeGlobalSearch();
      }
    });

    modal.querySelector('.gs-backdrop').addEventListener('click', closeGlobalSearch);
  }

  function openGlobalSearch() {
    const modal = document.getElementById('global-search-modal');
    if (!modal) return;
    modal.removeAttribute('hidden');
    const input = modal.querySelector('#global-search-input');
    if (input) {
      input.value = '';
      input.focus();
    }
    const resultsEl = modal.querySelector('#global-search-results');
    if (resultsEl) resultsEl.innerHTML = '<div class="gs-empty">Digite para começar a buscar</div>';
  }

  function closeGlobalSearch() {
    const modal = document.getElementById('global-search-modal');
    if (modal) modal.setAttribute('hidden', '');
  }

  async function performGlobalSearch(q) {
    const results = [];
    try {
      // 1. Fornecedores e clientes (via dados_importados local ou Firebase)
      const dataLocal = safeGetJSON(KEYS.DATA, null);
      if (dataLocal) {
        const seen = new Set();
        (dataLocal.titulosPagar || []).forEach(t => {
          if (!t.fornecedor) return;
          const key = t.fornecedor.toUpperCase();
          if (seen.has('F:' + key)) return;
          seen.add('F:' + key);
          if (key.toLowerCase().includes(q)) {
            results.push({
              type: 'fornecedor',
              typeLabel: 'Fornecedor',
              title: t.fornecedor,
              description: `Clique para ver no fluxo`,
              url: `index.html`,
              icon: '🏢',
            });
          }
        });
        (dataLocal.titulosReceber || []).forEach(t => {
          if (!t.cliente) return;
          const key = t.cliente.toUpperCase();
          if (seen.has('C:' + key)) return;
          seen.add('C:' + key);
          if (key.toLowerCase().includes(q)) {
            results.push({
              type: 'cliente',
              typeLabel: 'Cliente',
              title: t.cliente,
              description: `Contas a receber`,
              url: `index.html`,
              icon: '👤',
            });
          }
        });
      }

      if (!state.fbDB) return results.slice(0, 30);

      // 2. Categorias
      try {
        const snap = await dbRef('categorias').once('value');
        const cats = snap.val() || {};
        Object.entries(cats).forEach(([id, c]) => {
          if (c && (c.nome || '').toLowerCase().includes(q)) {
            results.push({
              type: 'categoria',
              typeLabel: 'Categoria',
              title: c.nome,
              description: 'Gerenciar fornecedores desta categoria',
              url: `categorias.html`,
              icon: '🏷️',
            });
          }
        });
      } catch {}

      // 3. Bancos
      try {
        const snap = await dbRef('bancos').once('value');
        const banks = snap.val() || {};
        Object.entries(banks).forEach(([id, b]) => {
          if (b && !b.arquivado && (b.nome || '').toLowerCase().includes(q)) {
            results.push({
              type: 'banco',
              typeLabel: 'Banco',
              title: b.nome,
              description: b.tipo === 'vinculada' ? 'Conta vinculada / garantida' : 'Conta livre',
              url: `index.html`,
              icon: '🏦',
            });
          }
        });
      } catch {}

      // 4. Lançamentos manuais
      try {
        const snap = await dbRef('lancamentos').once('value');
        const lancs = snap.val() || {};
        Object.entries(lancs).forEach(([id, l]) => {
          if (!l) return;
          const hay = ((l.entidade || '') + ' ' + (l.documento || '') + ' ' + (l.nota || '')).toLowerCase();
          if (hay.includes(q)) {
            results.push({
              type: 'lancamento',
              typeLabel: 'Lançamento',
              title: l.entidade || '(sem nome)',
              description: `${l.tipo === 'pagar' ? '↓' : '↑'} ${l.documento ? 'Doc ' + l.documento + ' · ' : ''}venc. ${l.vencimento}`,
              url: `lancamentos.html`,
              icon: '🧾',
            });
          }
        });
      } catch {}

      // 5. Comentários (só ativos)
      try {
        const snap = await dbRef('comentarios').once('value');
        const cells = snap.val() || {};
        Object.entries(cells).forEach(([cellKey, commentsMap]) => {
          Object.entries(commentsMap || {}).forEach(([cid, c]) => {
            if (c && !c.deleted && (c.text || '').toLowerCase().includes(q)) {
              const snippet = (c.text || '').slice(0, 80);
              results.push({
                type: 'comentario',
                typeLabel: 'Comentário',
                title: `"${snippet}${c.text.length > 80 ? '…' : ''}"`,
                description: `Por ${c.author || 'Anônimo'}`,
                url: `comentarios.html`,
                icon: '💬',
              });
            }
          });
        });
      } catch {}

    } catch (err) {
      console.warn('Busca falhou:', err);
    }
    return results.slice(0, 40);
  }

  function renderSearchResults(el, results, query) {
    if (!results.length) {
      el.innerHTML = `<div class="gs-empty">Nenhum resultado para "<b>${escapeHTML(query)}</b>"</div>`;
      return;
    }
    // Agrupa por tipo
    const groups = {};
    results.forEach(r => {
      if (!groups[r.typeLabel]) groups[r.typeLabel] = [];
      groups[r.typeLabel].push(r);
    });
    let i = 0;
    const html = Object.entries(groups).map(([label, items]) => {
      const rows = items.map(r => {
        const idx = i++;
        return `
          <div class="gs-result" data-idx="${idx}">
            <span class="gs-result-ic">${r.icon}</span>
            <div class="gs-result-main">
              <div class="gs-result-title">${escapeHTML(r.title)}</div>
              <div class="gs-result-desc">${escapeHTML(r.description || '')}</div>
            </div>
            <span class="gs-result-tag">${escapeHTML(r.typeLabel)}</span>
          </div>
        `;
      }).join('');
      return `
        <div class="gs-section">
          <div class="gs-section-title">${escapeHTML(label)}S · ${items.length}</div>
          ${rows}
        </div>
      `;
    }).join('');
    el.innerHTML = html;

    // Click handler
    el.querySelectorAll('.gs-result').forEach(row => {
      row.addEventListener('click', () => {
        const idx = parseInt(row.dataset.idx, 10);
        const r = results[idx];
        if (r && r.url) {
          closeGlobalSearch();
          location.href = r.url;
        }
      });
      row.addEventListener('mouseenter', () => {
        const idx = parseInt(row.dataset.idx, 10);
        updateSelectedResult(el, idx);
      });
    });
  }

  function updateSelectedResult(el, idx) {
    el.querySelectorAll('.gs-result').forEach(r => r.classList.remove('active'));
    const target = el.querySelector(`.gs-result[data-idx="${idx}"]`);
    if (target) {
      target.classList.add('active');
      target.scrollIntoView({ block: 'nearest' });
    }
  }

  function debounce(fn, wait) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, args), wait);
    };
  }

  // Atalhos de teclado
  let _shortcutsSetup = false;
  function setupKeyboardShortcuts() {
    if (_shortcutsSetup) return;
    _shortcutsSetup = true;

    document.addEventListener('keydown', (e) => {
      // Ignora se estiver em input/textarea (exceto Ctrl+K e ? que vêm de modal)
      const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) && !e.target.closest('#global-search-modal');

      // Ctrl/Cmd + K — busca global
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openGlobalSearch();
        return;
      }

      if (inField) return;

      // ? — mostrar ajuda de atalhos
      if (e.key === '?' && !e.shiftKey) {
        // já sai do if porque ? normalmente requer shift em PT-BR, mas tentamos ambos
      }
      if (e.key === '?') {
        e.preventDefault();
        showShortcutsHelp();
        return;
      }

      // Navegação por tecla única
      const key = e.key.toLowerCase();
      if (key === 'n') { e.preventDefault(); const b = document.getElementById('btn-add-empty') || document.getElementById('btn-new-lanc') || document.querySelector('[data-shortcut="new"]'); if (b) b.click(); return; }
      if (key === 'i') { e.preventDefault(); location.href = 'processamento.html'; return; }
      if (key === 'd') { e.preventDefault(); location.href = 'dashboard.html'; return; }
      if (key === 'f') { e.preventDefault(); location.href = 'index.html'; return; }
    });
  }

  function showShortcutsHelp() {
    // Modal simples com atalhos disponíveis
    let overlay = document.getElementById('shortcuts-help-modal');
    if (overlay) { overlay.removeAttribute('hidden'); return; }
    overlay = document.createElement('div');
    overlay.id = 'shortcuts-help-modal';
    overlay.className = 'global-search-modal';
    overlay.innerHTML = `
      <div class="gs-backdrop"></div>
      <div class="gs-panel" style="max-height: 500px;">
        <div class="gs-input-wrap" style="pointer-events: none;">
          <span class="gs-icon">⌨️</span>
          <div class="gs-input" style="padding: 0; line-height: 1.2;">
            <div style="font-weight: 700; font-size: 15px;">Atalhos de teclado</div>
            <div style="font-size: 12px; color: #9aa3b2; margin-top: 2px;">Pressione as teclas em qualquer página</div>
          </div>
        </div>
        <div class="gs-results">
          <div class="gs-section">
            <div class="gs-section-title">NAVEGAÇÃO</div>
            <div class="shortcut-row"><kbd>F</kbd><span>Fluxo de caixa</span></div>
            <div class="shortcut-row"><kbd>D</kbd><span>Dashboard</span></div>
            <div class="shortcut-row"><kbd>I</kbd><span>Importação (processamento)</span></div>
          </div>
          <div class="gs-section">
            <div class="gs-section-title">AÇÕES</div>
            <div class="shortcut-row"><kbd>Ctrl</kbd>+<kbd>K</kbd><span>Buscar em tudo</span></div>
            <div class="shortcut-row"><kbd>N</kbd><span>Novo lançamento</span></div>
            <div class="shortcut-row"><kbd>?</kbd><span>Esta tela de ajuda</span></div>
            <div class="shortcut-row"><kbd>Esc</kbd><span>Fechar modais</span></div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.setAttribute('hidden', '');
    overlay.querySelector('.gs-backdrop').addEventListener('click', close);
    document.addEventListener('keydown', function onceEsc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onceEsc); }
    });
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
    if (!state.user?.uid) throw new Error('Sessão expirada. Faça login novamente.');
    const ref = dbRef('lancamentos').push();
    const payload = {
      ...data,
      authorUid: state.user.uid,
      authorName: state.user.displayName || state.user.email || 'Anônimo',
      authorEmail: state.user.email || null,
      createdAt: firebase.database.ServerValue.TIMESTAMP,
      updatedAt: firebase.database.ServerValue.TIMESTAMP,
    };
    await ref.set(payload);
    await auditLog('lancamento.created', 'lancamento', ref.key, {
      tipo: data.tipo, valor: data.valor, nome: data.entidade || data.fornecedor || data.cliente || ''
    });
    return ref.key;
  }
  async function updateLancamento(id, data) {
    const payload = { ...data, updatedAt: firebase.database.ServerValue.TIMESTAMP };
    await dbRef(`lancamentos/${id}`).update(payload);
    await auditLog('lancamento.updated', 'lancamento', id, {
      nome: data.entidade || data.fornecedor || data.cliente || ''
    });
  }
  async function deleteLancamento(id) {
    // Captura info antes de deletar, para registrar no log
    let info = {};
    try {
      const snap = await dbRef(`lancamentos/${id}`).once('value');
      const v = snap.val();
      if (v) info = { tipo: v.tipo, nome: v.entidade || v.fornecedor || v.cliente, valor: v.valor };
    } catch {}
    await dbRef(`lancamentos/${id}`).remove();
    await auditLog('lancamento.deleted', 'lancamento', id, info);
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
    await auditLog('title.hidden', 'title', titleId, {
      fornecedor: titleData?.fornecedor || titleData?.cliente || '',
      valor: titleData?.valor,
    });
  }
  async function restoreTitle(titleId) {
    await dbRef(`deletados/${titleId}`).remove();
    await auditLog('title.restored', 'title', titleId, {});
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
    const nomeNorm = String(nome).trim().toUpperCase();
    await dbRef(`categorias/${id}`).set({
      nome: nomeNorm,
      cor: cor || '#6b7280',
      nativa: false,
      createdBy: state.user?.uid || null,
      createdByName: state.user?.displayName || state.user?.email || 'Anônimo',
      createdAt: firebase.database.ServerValue.TIMESTAMP,
    });
    await auditLog('category.created', 'category', id, { nome: nomeNorm, cor });
    return id;
  }
  async function updateCategoria(id, data) {
    const payload = { ...data };
    if (payload.nome) payload.nome = String(payload.nome).trim().toUpperCase();
    await dbRef(`categorias/${id}`).update(payload);
    await auditLog('category.updated', 'category', id, { nome: payload.nome || null });
  }
  async function deleteCategoria(id) {
    await dbRef(`categorias/${id}`).remove();
    await auditLog('category.deleted', 'category', id, {});
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
    await auditLog('fornecedor.categorized', 'fornecedor', key, {
      fornecedor: String(fornecedor).toUpperCase(),
      categoriaId: categoriaId || null,
    });
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
    await auditLog('comment.deleted', 'comment', commentId, { cellKey });
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
    await auditLog('comment.restored', 'comment', commentId, { cellKey });
  }
  // Exclusão permanente (só para uso em lixeira, se o usuário quiser apagar definitivamente)
  async function purgeComment(cellKey, commentId) {
    await dbRef(`comentarios/${cellKey}/${commentId}`).remove();
    await auditLog('comment.purged', 'comment', commentId, { cellKey });
  }

  /* ========== Dados importados (relatórios SIA) ==========
     Otimização: os metadados (processedAt, períodos, contagens) são salvos
     em um nó separado e leve (`dados_importados_meta`). O payload pesado
     (com milhares de títulos) fica em `dados_importados`. Assim, para saber
     se temos a versão mais recente, basta consultar os metadados.
     ======================================================== */
  async function saveImportedData(payload) {
    if (!state.fbDB) throw new Error('Firebase não configurado');
    // Enriquece com info do usuário que processou
    payload.processedBy = payload.processedBy || state.user?.displayName || state.user?.email || 'Anônimo';
    payload.processedByUid = state.user?.uid || null;

    // Arquivar versão anterior no histórico (se existir), mantendo no máximo 5 entradas
    try {
      const currentSnap = await dbRef('dados_importados').once('value');
      const current = currentSnap.val();
      if (current) {
        const histRef = dbRef('importacoes_historico').push();
        await histRef.set({
          payload: current,
          processedAt: current.processedAt,
          processedBy: current.processedBy,
          processedByUid: current.processedByUid || null,
          periodStart: current.periodStart || null,
          periodEnd: current.periodEnd || null,
          countPagar: (current.titulosPagar || []).length,
          countReceber: (current.titulosReceber || []).length,
          archivedAt: firebase.database.ServerValue.TIMESTAMP,
        });
        // Manter apenas as 5 mais recentes
        const allSnap = await dbRef('importacoes_historico').once('value');
        const all = allSnap.val() || {};
        const sorted = Object.entries(all)
          .map(([id, v]) => ({ id, ts: v.archivedAt || v.processedAt || 0 }))
          .sort((a, b) => b.ts - a.ts);
        if (sorted.length > 5) {
          const toDelete = sorted.slice(5);
          const deletions = {};
          toDelete.forEach(e => { deletions[e.id] = null; });
          await dbRef('importacoes_historico').update(deletions);
        }
      }
    } catch (err) {
      console.warn('Falha ao arquivar versão anterior:', err);
      // Não bloqueia a importação nova
    }

    // Metadados leves, separados do payload pesado
    const meta = {
      processedAt: payload.processedAt,
      processedBy: payload.processedBy,
      processedByUid: payload.processedByUid,
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
    await auditLog('import.applied', 'import', null, {
      periodStart: meta.periodStart,
      periodEnd: meta.periodEnd,
      countPagar: meta.countPagar,
      countReceber: meta.countReceber,
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

  /* ========== Bancos e Saldos (Fase 3) ==========
     Cadastro de contas bancárias (livres e vinculadas/garantidas).
     Cada conta tem um histórico de lançamentos de saldo (data + valor).
     O saldo "atual" de cada conta é o lançamento mais recente.

     Estrutura:
     /filadelfia/bancos/{bankId}
       { nome, tipo: 'livre'|'vinculada', ordem, arquivado: bool, createdAt, ... }
     /filadelfia/saldos_historico/{eventId}
       { bankId, valor, ts (data), authorUid, authorName, createdAt }
     ================================================ */
  const BANK_TYPE_LIVRE = 'livre';
  const BANK_TYPE_VINCULADA = 'vinculada';

  // Lista inicial de bancos pré-cadastrados (criada automaticamente na primeira vez)
  const DEFAULT_BANKS = [
    // Contas livres (operacionais)
    { nome: 'ABC', tipo: 'livre', ordem: 10 },
    { nome: 'ITAU', tipo: 'livre', ordem: 20 },
    { nome: 'SAFRA', tipo: 'livre', ordem: 30 },
    { nome: 'BRADESCO', tipo: 'livre', ordem: 40 },
    { nome: 'CAIXA', tipo: 'livre', ordem: 50 },
    { nome: 'C6', tipo: 'livre', ordem: 60 },
    { nome: 'BANCO DO BRASIL', tipo: 'livre', ordem: 70 },
    { nome: 'SANTANDER', tipo: 'livre', ordem: 80 },
    { nome: 'ASA', tipo: 'livre', ordem: 90 },
    { nome: 'SOFISA', tipo: 'livre', ordem: 100 },
    // Contas vinculadas/garantidas
    { nome: 'VINCULADA DO SAFRA', tipo: 'vinculada', ordem: 210 },
    { nome: 'VINCULADA C6', tipo: 'vinculada', ordem: 220 },
    { nome: 'GARANTIDA CAIXA', tipo: 'vinculada', ordem: 230 },
    { nome: 'VINCULADA SAFRA', tipo: 'vinculada', ordem: 240 },
    { nome: 'VINCULADA BB', tipo: 'vinculada', ordem: 250 },
    { nome: 'GARANTIDA SOFISA', tipo: 'vinculada', ordem: 260 },
    { nome: 'VINCULADA SANTANDER', tipo: 'vinculada', ordem: 270 },
    { nome: 'VINCULADA ASA', tipo: 'vinculada', ordem: 280 },
    { nome: 'VINCULADA ABC', tipo: 'vinculada', ordem: 290 },
  ];

  // Chamado pela página do fluxo ao inicializar; se já existir, não faz nada
  async function ensureDefaultBanks() {
    if (!state.fbDB) {
      console.log('[Bancos] Firebase não disponível');
      return;
    }
    try {
      const snap = await dbRef('bancos').once('value');
      const existing = snap.val();
      const existingCount = existing ? Object.keys(existing).length : 0;

      console.log('[Bancos] Contas existentes no Firebase:', existingCount);
      console.log('[Bancos] Role do usuário atual:', state.user?.role || '(ainda não definido)');

      // Se já tem pelo menos uma conta, não mexemos (evita re-criar bancos arquivados)
      if (existingCount > 0) {
        console.log('[Bancos] Já existem bancos cadastrados, não vou criar defaults.');
        return;
      }

      // Só cria se usuário pode escrever (evita erro de permissão para viewer)
      if (!state.user || !state.user.uid) {
        console.warn('[Bancos] Usuário ainda não está definido — tente novamente em alguns segundos.');
        return;
      }
      if (!isEditor()) {
        console.warn('[Bancos] Usuário atual é viewer ou não tem role — não pode criar bancos padrão.');
        return;
      }

      console.log('[Bancos] Criando', DEFAULT_BANKS.length, 'bancos padrão…');

      // Abordagem mais resistente: criar um-a-um. Se um falhar, os outros continuam.
      let ok = 0, fail = 0;
      for (const b of DEFAULT_BANKS) {
        const id = 'bank_' + b.nome.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        try {
          await dbRef(`bancos/${id}`).set({
            nome: b.nome,
            tipo: b.tipo,
            ordem: b.ordem || 999,
            arquivado: false,
            createdBy: state.user.uid,
            createdByName: state.user.displayName || state.user.email || 'Sistema',
            createdAt: firebase.database.ServerValue.TIMESTAMP,
          });
          ok++;
        } catch (err) {
          fail++;
          console.warn(`[Bancos] Falha ao criar "${b.nome}":`, err.message);
        }
      }
      console.log(`[Bancos] ✓ Criados ${ok} de ${DEFAULT_BANKS.length} (${fail} falharam)`);
      if (ok === 0 && fail > 0) {
        throw new Error('Nenhum banco foi criado — verifique as rules do Firebase');
      }
    } catch (err) {
      console.error('[Bancos] Erro ao criar bancos padrão:', err);
      throw err;
    }
  }

  async function createBank(nome, tipo, ordem) {
    if (!state.fbDB) throw new Error('Firebase não configurado');
    const nomeNorm = String(nome).trim().toUpperCase();
    if (!nomeNorm) throw new Error('Nome do banco é obrigatório');
    if (![BANK_TYPE_LIVRE, BANK_TYPE_VINCULADA].includes(tipo)) {
      throw new Error('Tipo inválido (use livre ou vinculada)');
    }
    const id = 'bank_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    await dbRef(`bancos/${id}`).set({
      nome: nomeNorm,
      tipo,
      ordem: ordem || 999,
      arquivado: false,
      createdBy: state.user?.uid || null,
      createdByName: state.user?.displayName || 'Anônimo',
      createdAt: firebase.database.ServerValue.TIMESTAMP,
    });
    await auditLog('bank.created', 'bank', id, { nome: nomeNorm, tipo });
    return id;
  }

  async function updateBank(id, updates) {
    if (!state.fbDB) throw new Error('Firebase não configurado');
    const payload = { ...updates };
    if (payload.nome) payload.nome = String(payload.nome).trim().toUpperCase();
    await dbRef(`bancos/${id}`).update(payload);
  }

  async function deleteBank(id) {
    if (!state.fbDB) throw new Error('Firebase não configurado');
    // Marca como arquivado em vez de deletar (para preservar histórico)
    await dbRef(`bancos/${id}/arquivado`).set(true);
    await auditLog('bank.deleted', 'bank', id, {});
  }

  function subscribeBancos(callback) {
    if (!state.fbDB) { callback({}); return () => {}; }
    const ref = dbRef('bancos');
    const handler = snap => callback(snap.val() || {});
    ref.on('value', handler);
    return () => ref.off('value', handler);
  }

  // Lançar um saldo (registra no histórico)
  async function createSaldo(bankId, valor) {
    if (!state.fbDB) throw new Error('Firebase não configurado');
    if (!bankId) throw new Error('Banco inválido');
    if (!state.user?.uid) throw new Error('Sessão expirada. Faça login novamente.');
    const val = parseFloat(valor);
    if (!Number.isFinite(val)) throw new Error('Valor inválido');
    const ref = dbRef('saldos_historico').push();
    const ts = Date.now(); // data = momento do lançamento (Opção A)
    await ref.set({
      bankId,
      valor: val,
      ts,
      authorUid: state.user.uid,
      authorName: state.user.displayName || state.user.email || 'Anônimo',
      createdAt: firebase.database.ServerValue.TIMESTAMP,
    });
    await auditLog('saldo.created', 'saldo', ref.key, { bankId, valor: val });
    return ref.key;
  }

  // Assinatura do histórico completo (todas as contas)
  function subscribeSaldosHistorico(callback) {
    if (!state.fbDB) { callback({}); return () => {}; }
    const ref = dbRef('saldos_historico');
    const handler = snap => callback(snap.val() || {});
    ref.on('value', handler);
    return () => ref.off('value', handler);
  }

  // Helper: dado um histórico completo, retorna { bankId -> {valor, ts, authorName} } com o último lançamento de cada banco
  function computeCurrentSaldos(historico) {
    const latest = {};
    Object.values(historico || {}).forEach(entry => {
      if (!entry || !entry.bankId) return;
      const prev = latest[entry.bankId];
      if (!prev || (entry.ts || 0) > (prev.ts || 0)) {
        latest[entry.bankId] = entry;
      }
    });
    return latest;
  }

  /* ========== Helpers de UI para perfis (guard visual) ==========
     Páginas chamam applyRoleGuards() depois de renderizar conteúdo
     para esconder/desabilitar elementos conforme o perfil do usuário.

     - [data-requires="editor"] elementos visíveis apenas para editor+
     - [data-requires="admin"]  elementos visíveis apenas para admin
     - [data-viewer-readonly]   inputs ficam somente-leitura para viewer
     ================================================ */
  function applyRoleGuards(container) {
    const root = container || document;
    root.querySelectorAll('[data-requires]').forEach(el => {
      const req = el.getAttribute('data-requires');
      if (!hasRole(req)) {
        el.setAttribute('hidden', '');
        el.style.display = 'none';
      } else {
        el.removeAttribute('hidden');
        el.style.display = '';
      }
    });
    if (!isEditor()) {
      root.querySelectorAll('[data-viewer-readonly]').forEach(el => {
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
          el.setAttribute('disabled', '');
          el.setAttribute('readonly', '');
        } else if (el.tagName === 'BUTTON') {
          el.setAttribute('disabled', '');
          el.style.opacity = '0.4';
          el.style.cursor = 'not-allowed';
        }
      });
    }
  }

  /* ========== Export público ========== */
  window.Filadelfia = {
    APP_VERSION,
    KEYS,
    IS_FIREBASE_CONFIGURED,
    state,
    initFirebase,
    Auth: {
      requireAuth, login, logout,
      hasRole, isAdmin, isEditor, isViewer,
      ROLE_ADMIN, ROLE_EDITOR, ROLE_VIEWER,
      listUsers, updateUserRole,
      ensureUserRecord,
    },
    Audit: {
      log: auditLog,
      fetchEntries: fetchAuditEntries,
      cleanup: cleanupAuditLog,
      actionLabel: auditActionLabel,
      ACTION_LABELS: AUDIT_ACTION_LABELS,
      RETENTION_DAYS: AUDIT_RETENTION_DAYS,
    },
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
      // Bancos e Saldos (Fase 3)
      ensureDefaultBanks, createBank, updateBank, deleteBank, subscribeBancos,
      BANK_TYPE_LIVRE, BANK_TYPE_VINCULADA, DEFAULT_BANKS,
      createSaldo, subscribeSaldosHistorico, computeCurrentSaldos,
    },
    UI: {
      renderTopbar, renderFooter, updateSyncBadge, showToast, hideToast,
      showLoading, hideLoading, applyRoleGuards,
    },
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
