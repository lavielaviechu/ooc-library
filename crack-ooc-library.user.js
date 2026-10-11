// ==UserScript==
// @name         Crack OOC 보관함
// @namespace    crack.ooc.library
// @version      2.0.2.0
// @description  OOC를 보관하고 안전한 assistant carrier에 독립적으로 자동 컨텍스트를 주입 (version 관리방식: 데이터구조버전.크랙UI변경.기능추가및수정.버그수정)
// @match        https://crack.wrtn.ai/*
// @noframes
// @icon         data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Crect%20x%3D%224%22%20y%3D%224%22%20width%3D%2256%22%20height%3D%2256%22%20rx%3D%2214%22%20fill%3D%22%23ef4444%22%2F%3E%3Cg%20fill%3D%22none%22%20stroke%3D%22%23fff%22%20stroke-width%3D%223%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Crect%20x%3D%2215%22%20y%3D%2219%22%20width%3D%229%22%20height%3D%2225%22%20rx%3D%222%22%2F%3E%3Crect%20x%3D%2227%22%20y%3D%2215%22%20width%3D%229%22%20height%3D%2229%22%20rx%3D%222%22%2F%3E%3Cpath%20d%3D%22m39%2022%207-2%207%2023-7%202zM13%2049h40M18%2026h3M30%2022h3%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E
// @connect      crack-api.wrtn.ai
// @connect      contents-api.wrtn.ai
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

/* schemaVersion 2
 * - v1의 단일-key 카테고리/OOC 객체를 명시적 레코드로 이관한다.
 * - v1 자료는 읽는 즉시 메모리에서 v2로 변환되며, 다음 저장 때 v2로 기록된다.
 * - 이관된 기존 OOC의 자동주입은 항상 OFF다.
 * - 구버전 호환: 1.x 스크립트는 schemaVersion 2 자료를 "데이터 형식이 올바르지 않습니다"로 거부한다.
 *   같은 Firebase/백업을 쓰는 다른 기기도 2.x로 올려야 읽을 수 있다 (조용한 자료 손실은 없다).
 * - autoSettings.wrmcCarrierMode는 2.0.2.0에서 추가됐다. 2.0.1.x가 저장하면 이 값만 빠지고 'auto'로 돌아간다.
 *
 * 자동 OOC (2.0.2.0)
 * - USER 메시지와 WebSocket payload는 읽기만 한다. 자동 OOC는 과거 assistant 메시지(carrier) 끝에
 *   generation 동안만 숨김 주석으로 붙였다가, 완료 후 서버의 최신 본문에서 자기 marker 구간만 제거한다.
 * - WRMC가 감지되면 WRMC stableFrame이 고를 carrier와 WISH marker가 있는 메시지를 피해 별도 carrier를 쓴다.
 * - 독립 carrier가 없거나 어떤 단계든 실패하면 그 generation의 자동 OOC만 건너뛰고 원래 전송은 그대로 보낸다.
 * - hook 설치 순서(WRMC/에리 wrapper의 안쪽·바깥쪽)는 동작 조건이 아니다. 실제 위치는 진단에만 표시한다.
 */
(() => {
  'use strict';
  const STORAGE_KEY = 'crack-ooc-library.connection';
  const SCHEMA_VERSION = 2;
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const PageAbortController = W.AbortController || AbortController;
  const pageStorage = W.localStorage;
  const pageIndexedDb = W.indexedDB;
  const AUTO_MARKER = 'CRACK_OOC_LIBRARY_AUTO';
  const AUTO_MARKER_VERSION = 'v1';
  const PATCH_CHAR_LIMIT = 50000;
  const PATCH_BYTE_BUDGET = 101400;
  const PREPARE_TIMEOUT_MS = 8000;
  const CLEANUP_TIMEOUT_MS = 6000;
  const WATCHDOG_MS = 120000;
  const IN_PROGRESS_GRACE_MS = 10000;
  const LOAD_RECOVERY_MIN_AGE_MS = 20000;
  const RESIDUE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
  const CARRIER_SEARCH_DEPTH = 4;
  const SAMPLE_GENERATION_ID = '0'.repeat(36);
  const WRMC_MODES = ['auto', 'always', 'never'];
  const RESIDUE_KEY = 'crack-ooc-library.auto-residues.v1';
  const CONDITION_TYPES = new Set(['always', 'model', 'userLength', 'keyword']);
  const AUTO_DEFAULTS = Object.freeze({ enabled: false, conditionType: 'always', conditionValue: '', keywordScope: 'user', priority: 0, injectionBody: '' });
  const SETTINGS_DEFAULTS = Object.freeze({ autoInjectionEnabled: false, autoOocMaxChars: 2000, wrmcCarrierMode: 'auto' });
  const fresh = () => ({ schemaVersion: SCHEMA_VERSION, updatedAt: 0, autoSettings: { ...SETTINGS_DEFAULTS }, categories: [], extras: [] });
  const copy = value => JSON.parse(JSON.stringify(value));
  const one = value => Object.entries(value)[0];
  let library = null, editing = null, pendingRead = null, database = null, saving = false;
  let settings = { mode: 'local' }, manager = null, selectedInput = null, drag = null;
  const expanded = new Set(), attached = new Map();
  const socketWatch = new WeakSet(), sendQueues = new Map(), inFlight = new Set();
  // generationId → { chatId, state: 'preparing' | 'armed', sentAt, lastStreamAt, socket }
  const live = new Map(), carrierLocks = new Map(), cleanupRunning = new Map();
  const autoDiagnostics = [], diagnosticsById = new Map();
  const hookInfo = { installed: false, position: '', wishWrapper: false };
  const dropAreas = new WeakMap();
  try { settings = JSON.parse(pageStorage.getItem(STORAGE_KEY)) || settings; } catch { /* 설정이 없거나 손상되었으면 로컬로 시작한다. */ }
  installStandaloneInjector();

  function stableId(text) {
    let hash = 2166136261;
    for (const char of String(text)) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); }
    return `ooc_${(hash >>> 0).toString(36)}`;
  }
  function newId() { return crypto.randomUUID?.() || stableId(`${Date.now()}\u0000${Math.random()}`); }
  function validName(name, kind = '이름') {
    if (typeof name !== 'string' || !name.trim()) throw Error(`${kind}이 올바르지 않습니다.`);
    if (/[.#$\[\]/\u0000-\u001f\u007f]/u.test(name)) throw Error(`${kind}에는 . # $ / [ ] 및 제어 문자를 사용할 수 없습니다.`);
    if (new TextEncoder().encode(name).length > 768) throw Error(`${kind}은 UTF-8 기준 768바이트 이내여야 합니다.`);
    return name;
  }
  function normalizeAuto(value = {}) {
    const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const conditionType = CONDITION_TYPES.has(src.conditionType) ? src.conditionType : AUTO_DEFAULTS.conditionType;
    const priority = Number(src.priority);
    return {
      enabled: src.enabled === true,
      conditionType,
      conditionValue: String(src.conditionValue || '').slice(0, 1000),
      keywordScope: ['user', 'recent', 'both'].includes(src.keywordScope) ? src.keywordScope : 'user',
      priority: Number.isFinite(priority) ? Math.max(-999, Math.min(999, Math.trunc(priority))) : 0,
      injectionBody: typeof src.injectionBody === 'string' ? src.injectionBody : '',
    };
  }
  function normalizeSettings(value = {}) {
    const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const max = Number(src.autoOocMaxChars);
    return { autoInjectionEnabled: src.autoInjectionEnabled === true,
      autoOocMaxChars: Number.isSafeInteger(max) ? Math.max(0, Math.min(50000, max)) : SETTINGS_DEFAULTS.autoOocMaxChars,
      wrmcCarrierMode: WRMC_MODES.includes(src.wrmcCarrierMode) ? src.wrmcCarrierMode : SETTINGS_DEFAULTS.wrmcCarrierMode };
  }
  function normalizeEntry(value, path, usedIds) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('OOC 항목 형식이 올바르지 않습니다.');
    const name = validName(value.name, 'OOC 이름');
    if (Array.from(name).length > 20 || typeof value.content !== 'string') throw Error('OOC 이름 또는 내용이 올바르지 않습니다.');
    let id = typeof value.id === 'string' && /^[\w-]{1,100}$/.test(value.id) ? value.id : stableId(`${path}\u0000${name}\u0000${value.content}`);
    if (usedIds.has(id)) id = stableId(`${id}\u0000${path}`);
    usedIds.add(id);
    return { id, name, content: value.content, autoInjection: normalizeAuto(value.autoInjection) };
  }
  function migrateV1(value) {
    const used = new Set();
    const legacyEntry = (item, path) => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 1) throw Error('항목 형식이 올바르지 않습니다.');
      const [name, content] = one(item);
      return normalizeEntry({ name, content, autoInjection: AUTO_DEFAULTS }, path, used);
    };
    return { schemaVersion: SCHEMA_VERSION, updatedAt: value.updatedAt, autoSettings: { ...SETTINGS_DEFAULTS },
      categories: value.categories.map((item, category) => {
        if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 1) throw Error('카테고리 형식이 올바르지 않습니다.');
        const [name, children] = one(item); validName(name, '카테고리 이름');
        if (!Array.isArray(children)) throw Error('카테고리 형식이 올바르지 않습니다.');
        return { name, items: children.map((child, index) => legacyEntry(child, `category:${category}:${index}`)) };
      }), extras: value.extras.map((item, index) => legacyEntry(item, `extra:${index}`)) };
  }
  function check(value) {
    if (!value || ![1, SCHEMA_VERSION].includes(value.schemaVersion) || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0 ||
        !Array.isArray(value.categories) || !Array.isArray(value.extras)) throw Error('데이터 형식이 올바르지 않습니다.');
    if (value.schemaVersion === 1) return migrateV1(value);
    const used = new Set();
    return { schemaVersion: SCHEMA_VERSION, updatedAt: value.updatedAt, autoSettings: normalizeSettings(value.autoSettings),
      categories: value.categories.map((category, categoryIndex) => {
        if (!category || typeof category !== 'object' || Array.isArray(category) || !Array.isArray(category.items)) throw Error('카테고리 형식이 올바르지 않습니다.');
        const name = validName(category.name, '카테고리 이름');
        return { name, items: category.items.map((item, index) => normalizeEntry(item, `category:${categoryIndex}:${index}`, used)) };
      }), extras: value.extras.map((item, index) => normalizeEntry(item, `extra:${index}`, used)) };
  }
  function transport(value, direction) {
    if (!value || typeof value !== 'object') throw Error('Firebase 자료 형식이 올바르지 않습니다.');
    if (direction === 'read' && value.schemaVersion === 1) {
      const list = values => values == null ? [] : values;
      return { ...value, categories: list(value.categories).map(item => { const [name, children] = one(item); return Object.fromEntries([[name, children === false ? [] : list(children)]]); }), extras: list(value.extras) };
    }
    const data = direction === 'write' ? check(value) : value;
    if (data.categories != null && !Array.isArray(data.categories)) throw Error('Firebase 카테고리 형식이 올바르지 않습니다.');
    const list = values => values == null ? [] : Array.isArray(values) ? values : (() => { throw Error('Firebase 목록 형식이 올바르지 않습니다.'); })();
    return { schemaVersion: data.schemaVersion, updatedAt: data.updatedAt, autoSettings: data.autoSettings,
      categories: list(data.categories).map(category => ({ ...category, items: direction === 'write' && !category.items.length ? false : category.items === false ? [] : list(category.items) })),
      extras: list(data.extras) };
  }
  async function localData(value) {
    if (!database) database = new Promise((resolve, reject) => {
      const opening = pageIndexedDb.open('crack-ooc-library', 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore('library');
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => { database = null; reject(Error('로컬 저장소를 열 수 없습니다.')); };
    });
    const db = await database;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('library', value ? 'readwrite' : 'readonly');
      const store = transaction.objectStore('library');
      const operation = value ? store.put(value, 'library') : store.get('library');
      transaction.oncomplete = () => {
        try { resolve(value || (operation.result === undefined ? fresh() : check(operation.result))); } catch (error) { reject(error); }
      };
      transaction.onabort = transaction.onerror = () => reject(Error('로컬 저장소의 읽기 또는 저장에 실패했습니다.'));
    });
  }
  function configFrom(text) {
    const json = text.trim().replace(/^(?:const|let|var)\s+firebaseConfig\s*=\s*/, '').replace(/;\s*$/, '')
      .replace(/([{,]\s*)([\w$]+)\s*:/g, '$1"$2":').replace(/,\s*}/g, '}');
    let config;
    try { config = JSON.parse(json); } catch { throw Error('Firebase config를 중괄호까지 복사하세요.'); }
    if (typeof config?.apiKey !== 'string' || !config.apiKey.trim() || typeof config.projectId !== 'string' || !/^[a-z][a-z0-9-]{4,62}$/.test(config.projectId)) throw Error('apiKey와 projectId를 확인하세요.');
    let address;
    try { address = new URL(config.databaseURL); } catch { throw Error('연동 가이드 2단계의 databaseURL을 확인하세요.'); }
    const project = config.projectId;
    const regional = new RegExp(`^${project}(?:-default-rtdb)?\\.[a-z0-9-]+\\.firebasedatabase\\.app$`);
    if (address.protocol !== 'https:' || address.username || address.password || address.port || address.search || address.hash || address.pathname !== '/' ||
        ![`${project}.firebaseio.com`, `${project}-default-rtdb.firebaseio.com`].includes(address.hostname) && !regional.test(address.hostname)) throw Error('같은 프로젝트의 공식 Realtime Database 주소를 입력하세요.');
    return { apiKey: config.apiKey.trim(), projectId: project, databaseURL: address.origin };
  }
  async function http(address, method = 'GET', body, form = false) {
    const abort = new PageAbortController(), timeout = setTimeout(() => abort.abort(), 25000);
    try {
      const response = await W.fetch(address, { method, credentials: 'omit', cache: 'no-store', signal: abort.signal,
        headers: body === undefined ? undefined : { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
        body: body === undefined ? undefined : form ? body : JSON.stringify(body) });
      const text = await response.text(), data = text ? JSON.parse(text) : null;
      if (!response.ok) {
        const reason = data?.error?.message || data?.error;
        if (['INVALID_LOGIN_CREDENTIALS', 'EMAIL_NOT_FOUND', 'INVALID_PASSWORD'].includes(reason)) throw Error('이메일과 비밀번호를 확인하세요.');
        if (reason === 'Permission denied') throw Error('DB 접근이 거부되었습니다. 연동 가이드 5단계의 보안 규칙을 확인하세요.');
        throw Error(`Firebase 요청 실패 (${response.status}). 로그인과 보안 규칙을 확인하세요.`);
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw Error('요청 시간이 초과되었습니다. 저장 요청이었다면 저장 여부를 확인한 뒤 다시 시도하세요.');
      if (error instanceof TypeError) throw Error('Firebase에 연결하지 못했습니다. 네트워크 또는 사이트의 연결 차단을 확인하세요.');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  async function idToken(connection) {
    if (!connection.auth?.refreshToken) throw Error('DB 설정에서 로그인하세요.');
    if (connection.auth.until <= Date.now() + 60000) {
      const response = await http(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(connection.config.apiKey)}`, 'POST',
        new URLSearchParams({ grant_type: 'refresh_token', refresh_token: connection.auth.refreshToken }).toString(), true);
      connection.auth = { uid: response.user_id, token: response.id_token, refreshToken: response.refresh_token, until: Date.now() + Number(response.expires_in) * 1000 };
      if (connection === settings) pageStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    }
    return connection.auth.token;
  }
  async function firebase(connection, method = 'GET', path = '', value) {
    // 주소는 configFrom()을 통과한 Firebase DB로만 한정한다.
    const token = await idToken(connection);
    return http(`${connection.config.databaseURL}/oocLibrary${path}.json?auth=${encodeURIComponent(token)}${method === 'PUT' ? '&print=silent' : ''}`, method, value);
  }
  async function readLibrary() {
    if (library) return library;
    if (!pendingRead) pendingRead = (async () => {
      if (settings.mode === 'firebase') {
        settings.config = configFrom(JSON.stringify(settings.config));
        const value = await firebase(settings);
        library = value === null ? fresh() : check(transport(value, 'read'));
      } else library = await localData();
      return library;
    })().finally(() => { pendingRead = null; });
    return pendingRead;
  }
  function change(update) {
    if (saving) return;
    const next = copy(editing || library); update(next); check(next);
    if (JSON.stringify(next) === JSON.stringify(editing || library)) return;
    editing = next; drawManager();
  }
  async function saveLibrary() {
    if (!editing || saving) return;
    saving = true; drawManager();
    try {
      const value = check(copy(editing));
      if (settings.mode === 'firebase') {
        const stamp = await firebase(settings, 'GET', '/updatedAt');
        if (stamp !== null && (!Number.isSafeInteger(stamp) || stamp < 0)) throw Error('Firebase 수정 시각이 올바르지 않습니다.');
        if ((stamp || 0) !== library.updatedAt && !await confirm('덮어쓰기 확인', '다른 기기에서 변경한 자료가 있습니다. 저장하면 Firebase의 기존 자료를 현재 편집 내용으로 덮어씁니다.', '덮어쓰기')) return;
        value.updatedAt = Math.max(Date.now(), (stamp || 0) + 1);
        await firebase(settings, 'PUT', '', transport(value, 'write'));
      } else { value.updatedAt = Math.max(Date.now(), library.updatedAt + 1); await localData(value); }
      library = value; editing = null; drawPanels();
    } finally { saving = false; drawManager(); }
  }

  const paths = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    folderPlus: '<path d="M3 9V7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z M17 1v6M14 4h6"/>',
    file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9ZM14 3v6h6M8 13h8M8 17h5"/>',
    edit: '<path d="m15 4 5 5M4 20l4-1L21 6a2.8 2.8 0 0 0-4-4L4 15Z"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
    grip: '<path d="M5 8h14M5 12h14M5 16h14"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    save: '<path d="M20 7v13H4V4h13ZM8 4v6h8V4M8 20v-6h8v6"/>',
    gear: '<path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/>',
    local: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
    flame: '<path d="M12 2c1 5 6 6 6 11a6 6 0 0 1-12 0c0-3 2-5 3-7 0 3 1 4 2 4 2-2 2-5 1-8Z"/><path d="M12 12c-2 2-3 3-3 5a3 3 0 0 0 6 0c0-2-2-3-3-5Z"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4M12 17h.01"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>'
  };
  const svg = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
  function node(tag, css, text) { const element = document.createElement(tag); if (css) element.className = css; if (text !== undefined) element.textContent = text; return element; }
  function action(text, handler, icon, css = '') {
    const element = node('button', icon ? `oa-icon ${css}` : `oa-button ${css}`, icon ? undefined : text);
    element.type = 'button'; element.title = text; element.setAttribute('aria-label', text);
    if (icon) element.innerHTML = svg(icon);
    element.addEventListener('click', async event => {
      event.preventDefault(); event.stopPropagation(); if (element.disabled) return;
      element.disabled = true;
      try { await handler(); } catch (error) { alert(error.message); }
      finally { element.disabled = false; }
    });
    return element;
  }
  function dialog(title, width = 'small') {
    const root = node('dialog', `oa-dialog oa-${width}`), header = node('header', 'oa-header');
    root.setAttribute('aria-label', title); const label = node('strong', '', title); header.append(label);
    const body = node('div', 'oa-body'), footer = node('footer', 'oa-footer'); root.append(header, body, footer); document.body.append(root);
    const view = { root, header, label, body, footer, close: () => root.close() };
    root.addEventListener('close', () => root.remove()); root.addEventListener('cancel', event => event.preventDefault()); root.showModal(); return view;
  }
  function closeWithEscape(view) { view.root.addEventListener('cancel', () => { if (!view.root.querySelector('[aria-busy="true"]')) view.close(); }); }
  function alert(message) {
    const view = dialog('안내'); view.body.append(node('p', 'oa-message', message)); view.footer.append(action('확인', view.close)); closeWithEscape(view);
  }
  function confirm(title, message, accept) {
    return new Promise(resolve => {
      const view = dialog(title); view.body.append(node('p', 'oa-message oa-warning', message));
      const finish = answer => { view.close(); resolve(answer); };
      view.footer.append(action('취소', () => finish(false)), action(accept, () => finish(true), null, 'oa-primary'));
      view.root.addEventListener('cancel', () => finish(false));
    });
  }
  function field(view, title, tag = 'input', value = '') {
    const wrap = node('label', 'oa-field'); wrap.append(node('span', '', title)); const input = node(tag); input.value = value; input.setAttribute('aria-label', title); wrap.append(input); view.append(wrap); return input;
  }
  function toggleField(view, title, checked, hint = '') {
    const label = node('label', 'oa-toggle-field'), input = node('input'); input.type = 'checkbox'; input.checked = !!checked;
    label.append(input, node('span', '', title)); if (hint) label.append(node('small', '', hint)); view.append(label); return input;
  }
  const contents = (data, category) => category < 0 ? data.extras : data.categories[category].items;
  const total = data => data.extras.length + data.categories.reduce((sum, item) => sum + item.items.length, 0);
  const allEntries = data => [...data.categories.flatMap(category => category.items), ...data.extras];

  function parseLengthCondition(value) {
    const text = String(value || '').normalize('NFKC').trim().replace(/\s+/g, '');
    let match;
    if ((match = /^최소(\d+)(?:자)?$/.exec(text))) return { min: Number(match[1]), max: Infinity };
    if ((match = /^최대(\d+)(?:자)?$/.exec(text))) return { min: 0, max: Number(match[1]) };
    if ((match = /^(?:>=)?(\d+)(?:자)?(?:이상|\+)?$/.exec(text))) return { min: Number(match[1]), max: Infinity };
    if ((match = /^(?:<=)(\d+)(?:자)?$/.exec(text)) || (match = /^(\d+)(?:자)?이하$/.exec(text))) return { min: 0, max: Number(match[1]) };
    if ((match = /^(\d+)(?:자)?(?:~|-|–|—)(\d+)(?:자)?$/.exec(text))) return { min: Math.min(Number(match[1]), Number(match[2])), max: Math.max(Number(match[1]), Number(match[2])) };
    return null;
  }
  function splitValues(value) { return String(value || '').split(/[\n,]+/).map(part => part.normalize('NFKC').trim()).filter(Boolean); }
  function modelValues(model) {
    const source = model && typeof model === 'object' ? model : {};
    return [...new Set([source.crackerModel, source.chatModelId, source.model, source.label, source.name].map(value => String(value || '').normalize('NFKC').trim().toLocaleLowerCase()).filter(Boolean))];
  }
  function conditionMatches(entry, request) {
    const rule = entry.autoInjection, value = rule.conditionValue;
    if (rule.conditionType === 'always') return true;
    if (rule.conditionType === 'model') {
      const actual = modelValues(request.model), wanted = splitValues(value).map(item => item.toLocaleLowerCase());
      return wanted.length > 0 && wanted.some(item => actual.includes(item));
    }
    if (rule.conditionType === 'userLength') {
      const range = parseLengthCondition(value); if (!range) return false;
      const length = String(request.userText || '').length; return length >= range.min && length <= range.max;
    }
    if (rule.conditionType === 'keyword') {
      const words = splitValues(value).map(item => item.toLocaleLowerCase()); if (!words.length) return false;
      const user = String(request.userText || '').normalize('NFKC').toLocaleLowerCase();
      const recent = String(request.recentText || '').normalize('NFKC').toLocaleLowerCase();
      const haystack = rule.keywordScope === 'recent' ? recent : rule.keywordScope === 'both' ? `${user}\n${recent}` : user;
      return words.some(word => haystack.includes(word));
    }
    return false;
  }
  function renderAutoItem(entry) {
    const body = String(entry.autoInjection.injectionBody || entry.content || '').trim();
    if (!body) return '';
    return `- ${safeForHtmlComment(body.replace(/\r\n?/g, '\n')).replace(/\n/g, '\n  ')}`;
  }
  // maxChars는 USER 2,000자와 무관한 AUTO 전용 예산이다. carrier에 실제로 덧붙는 전체 구간
  // (marker 주석, [자동 OOC] wrapper, 항목 구분자)을 모두 센다. 항목은 통째로 넣거나 통째로 뺀다.
  function selectAutoOoc(data, request = {}) {
    const configured = normalizeSettings(data.autoSettings), requested = Number(request.maxChars);
    const maxChars = Math.max(0, Math.min(configured.autoOocMaxChars, Number.isFinite(requested) ? Math.trunc(requested) : configured.autoOocMaxChars));
    const overhead = Number.isFinite(Number(request.overhead)) ? Math.max(0, Number(request.overhead)) : autoRegionOverhead();
    const modelDetected = modelValues(request.model).length > 0;
    if (!configured.autoInjectionEnabled || !['before-send', 'before-reroll', 'preview'].includes(request.reason) || maxChars <= 0) return { block: '', selected: [], matched: [], omitted: 0, maxChars, chars: 0, modelDetected };
    const seen = new Set(), summary = row => ({ id: row.entry.id, name: row.entry.name, priority: row.entry.autoInjection.priority });
    const candidates = allEntries(data).map((entry, order) => ({ entry, order, rendered: renderAutoItem(entry) }))
      .filter(row => row.entry.autoInjection.enabled && row.rendered && conditionMatches(row.entry, request))
      .filter(row => { const key = row.rendered.normalize('NFKC'); if (seen.has(key)) return false; seen.add(key); return true; })
      .sort((a, b) => b.entry.autoInjection.priority - a.entry.autoInjection.priority || a.order - b.order);
    const selected = [], pieces = [], prefix = '[자동 OOC]\n', suffix = '\n[/자동 OOC]';
    for (const row of candidates) {
      const next = [...pieces, row.rendered], block = prefix + next.join('\n') + suffix;
      if (block.length + overhead <= maxChars) { pieces.push(row.rendered); selected.push(summary(row)); }
    }
    const block = pieces.length ? prefix + pieces.join('\n') + suffix : '';
    return { block, selected, matched: candidates.map(summary), omitted: candidates.length - selected.length, maxChars, chars: block ? block.length + overhead : 0, modelDetected };
  }

  // ---------------------------------------------------------------------------
  // Standalone carrier injector
  // ---------------------------------------------------------------------------
  // Crack and the currently deployed WRMC both use Socket.IO text frames.  This
  // injector owns only its marker and never rewrites the USER frame.
  function parseSocketFrame(raw) {
    if (typeof raw !== 'string') return null;
    const match = /^42(\/[^,]+,)?(\d*)(\[.*)$/s.exec(raw);
    if (!match || match[1] && match[1] !== '/v3/chats,') return null;
    try {
      const value = JSON.parse(match[3]);
      return Array.isArray(value) && typeof value[0] === 'string' ? { event: value[0], payload: value[1], ackId: match[2], raw } : null;
    } catch { return null; }
  }
  const messageIdOf = message => String(message?._id || message?.id || '');
  const messageRoleOf = message => String(message?.role || message?.type || '').toLowerCase();
  const messageTextOf = message => String(message?.content ?? message?.message ?? message?.text ?? '');
  function currentChatId(pathname = W.location?.pathname || location.pathname) {
    for (const pattern of [/^\/stories\/[^/]+\/episodes\/([^/?#]+)/, /^\/characters\/[^/]+\/chats\/([^/?#]+)/, /^\/u\/[^/]+\/c\/([^/?#]+)/]) {
      const match = String(pathname).match(pattern); if (match) return match[1];
    }
    return '';
  }
  function stableCarrierFrame(newestFirst) {
    const messages = (newestFirst || []).filter(message => ['user', 'assistant'].includes(messageRoleOf(message)));
    const ids = messages.map(messageIdOf);
    if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw Error('최근 대화 메시지 ID가 비어 있거나 중복됐습니다.');
    const latest = messages.find(message => messageRoleOf(message) === 'assistant') || null;
    const latestIndex = latest ? messages.indexOf(latest) : -1;
    const userIndex = latestIndex < 0 ? -1 : messages.findIndex((message, index) => index > latestIndex && messageRoleOf(message) === 'user');
    const carrier = userIndex < 0 ? null : messages.find((message, index) => index > userIndex && messageRoleOf(message) === 'assistant') || null;
    const latestUser = messages.find(message => messageRoleOf(message) === 'user') || null;
    // stable: 최신 assistant(리롤 대상 포함)와 그 USER 경계를 넘긴, 이번 send/reroll에서 모두 컨텍스트에 남는 assistant들 (최신순).
    // carrier(= stable[0])는 WRMC stableFrame()이 이번 generation에서 고를 메시지와 같다.
    const stable = userIndex < 0 ? [] : messages.filter((message, index) => index > userIndex && messageRoleOf(message) === 'assistant');
    return { messages, latest, latestUser, carrier, stable, trailingUser: messageRoleOf(messages[0]) === 'user' };
  }
  // WRMC가 실제로 PATCH하는 대상은 (1) stableFrame carrier, (2) 이미 WISH marker가 있는 메시지뿐이다.
  // 둘 다 후보에서 빼면 marker가 아직 안 붙은 경우와 이전 carrier 정리 대기 중인 경우를 모두 피한다.
  const WISH_MARKER_PATTERN = /RP_CONTEXT_MANAGER_(?:START|END)|WISH_SESSION_SETUP_(?:START|END)|!--RP_CTX\b|RP_CTX_END--|<rp_context_manager\b|\(RP_COG_V1\|/i;
  const hasWishMarker = text => WISH_MARKER_PATTERN.test(String(text || ''));
  function detectWish(data, messages = []) {
    const mode = normalizeSettings(data?.autoSettings).wrmcCarrierMode, signals = [];
    // 감지 전용 읽기다. WRMC의 API·이벤트·내부 상태를 호출하거나 기다리지 않는다.
    try { if ('__WishCognitionBridge' in W || '__WISH_COGNITION_ENGINE__' in W) signals.push('global'); } catch {}
    try { if (document.querySelector('#wish-rp-quick,#wish-rp-root,#wish-m3-style,#wish-rp-message-injection-style')) signals.push('dom'); } catch {}
    if (hookInfo.wishWrapper) signals.push('wrapper');
    if ((messages || []).some(message => hasWishMarker(messageTextOf(message)))) signals.push('marker');
    return { mode, signals, separate: mode === 'always' || mode !== 'never' && signals.length > 0 };
  }
  function selectAutoCarrier(frame, separateFromWish) {
    const predictedWishId = messageIdOf(frame.carrier), rejected = [];
    for (const message of frame.stable.slice(0, CARRIER_SEARCH_DEPTH)) {
      const id = messageIdOf(message), text = messageTextOf(message);
      const reason = separateFromWish && id === predictedWishId ? 'wrmc-predicted-carrier' : hasWishMarker(text) ? 'wish-marker' : !removeAutoRegions(text).trim() ? 'empty-body' : '';
      if (!reason) return { carrier: message, carrierId: id, predictedWishId, rejected };
      rejected.push({ id, reason });
    }
    return { carrier: null, carrierId: '', predictedWishId, rejected };
  }
  function accessToken() {
    const source = `; ${document.cookie || ''}`;
    for (const part of source.split('; access_token=').slice(1)) {
      const raw = part.split(';').shift().trim(); if (!raw) continue;
      try { return decodeURIComponent(raw); } catch { return raw; }
    }
    return '';
  }
  function requestHandle(options) {
    if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest(options);
    if (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function') return GM.xmlHttpRequest(options);
    throw Error('userscript 네트워크 API를 사용할 수 없습니다.');
  }
  function crackRequest(method, url, body, signal, timeout = 2500) {
    const token = accessToken(); if (!token) return Promise.reject(Error('Crack 로그인 토큰을 찾지 못했습니다.'));
    return new Promise((resolve, reject) => {
      let settled = false, handle;
      const done = (fn, value) => { if (settled) return; settled = true; signal?.removeEventListener('abort', abort); fn(value); };
      const abort = () => {
        if (settled) return; settled = true; signal?.removeEventListener('abort', abort);
        try { handle?.abort?.(); } catch {}
        reject(Object.assign(Error('자동 OOC 요청이 취소되었습니다.'), { code: 'AUTO_OOC_ABORT' }));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        handle = requestHandle({ method, url, timeout, data: body === undefined ? undefined : JSON.stringify(body),
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*', platform: 'web', 'wrtn-locale': 'ko-KR' },
          onload(response) {
            let parsed = null; try { parsed = response.responseText ? JSON.parse(response.responseText) : null; } catch {}
            if (response.status >= 200 && response.status < 300) done(resolve, parsed ?? { ok: true });
            else done(reject, Object.assign(Error(`Crack API 오류 ${response.status}`), { code: 'AUTO_OOC_HTTP', status: response.status }));
          },
          ontimeout: () => done(reject, Object.assign(Error('Crack API 요청 시간이 초과되었습니다.'), { code: 'AUTO_OOC_TIMEOUT' })),
          onerror: () => done(reject, Object.assign(Error('Crack API 네트워크 오류'), { code: 'AUTO_OOC_NETWORK' })),
          onabort: () => done(reject, Object.assign(Error('Crack API 요청이 취소되었습니다.'), { code: 'AUTO_OOC_ABORT' })),
        });
        handle?.catch?.(error => done(reject, error));
      } catch (error) { done(reject, error); }
    });
  }
  async function fetchRecentMessages(chatId, signal, limit = 30) {
    const response = await crackRequest('GET', `https://crack-api.wrtn.ai/crack-gen/v3/chats/${encodeURIComponent(chatId)}/messages?limit=${limit}`, undefined, signal);
    const messages = response?.data?.messages ?? response?.messages;
    if (!Array.isArray(messages)) throw Error('최근 대화 응답 형식을 확인할 수 없습니다.');
    return messages;
  }
  async function fetchCarrierMessage(chatId, messageId, signal) {
    try {
      const response = await crackRequest('GET', `https://crack-api.wrtn.ai/crack-gen/v3/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`, undefined, signal);
      const message = response?.data || response;
      if (messageIdOf(message) && messageRoleOf(message) === 'assistant') return message;
    } catch (error) {
      if (error?.status !== 404 && error?.status !== 410) throw error;
    }
    const recent = await fetchRecentMessages(chatId, signal, 50);
    return recent.find(message => messageIdOf(message) === String(messageId) && messageRoleOf(message) === 'assistant') || null;
  }
  const patchEndpoints = (chatId, messageId) => [
    `https://contents-api.wrtn.ai/character-chat/v3/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
    `https://crack-api.wrtn.ai/crack-gen/v3/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
    `https://contents-api.wrtn.ai/character-chat/character-chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
  ];
  function safeForHtmlComment(text) { return String(text || '').replace(/<!--/g, '<\u200B!--').replace(/-->/g, '--\u200B>'); }
  // 같은 generation id의 START/END 쌍만 한 구간으로 본다. id를 주지 않으면 모든 AUTO 구간(잔여물 포함)을 찾는다.
  // 서버·다른 도구가 주석 앞에 \ 또는 ?를 붙이거나 &lt;!-- 로 바꾼 형태는 WRMC가 실제로 대비하는 변형이다.
  // 붙일 때 넣은 구분용 줄바꿈 두 개까지만 함께 지우므로, 그 뒤에 다른 확장이 덧붙인 내용은 그대로 남는다.
  function markerPattern(generationId = '') {
    const id = generationId ? String(generationId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '[A-Za-z0-9_-]{12,100}';
    const pair = (open, close, group) => `(?:\\\\|\\?)?${open}${AUTO_MARKER}_START:${AUTO_MARKER_VERSION}:(${id})\\r?\\n[\\s\\S]*?\\r?\\n${AUTO_MARKER}_END:${AUTO_MARKER_VERSION}:\\${group}${close}`;
    return new RegExp(`(?:\\r?\\n){0,2}(?:${pair('<!--', '-->', 1)}|${pair('&lt;!--', '--&gt;', 2)})`, 'g');
  }
  function removeAutoRegions(text, generationId = '') { return String(text ?? '').replace(markerPattern(generationId), ''); }
  const countAutoRegions = (text, generationId = '') => (String(text ?? '').match(markerPattern(generationId)) || []).length;
  function autoRegion(block, generationId) {
    return `\n\n<!--${AUTO_MARKER}_START:${AUTO_MARKER_VERSION}:${generationId}\n${safeForHtmlComment(block)}\n${AUTO_MARKER}_END:${AUTO_MARKER_VERSION}:${generationId}-->`;
  }
  const autoRegionOverhead = (generationId = SAMPLE_GENERATION_ID) => autoRegion('', generationId).length;
  const normalizeBreaks = text => String(text ?? '').replace(/\r\n?/g, '\n');
  const carrierBytes = text => new TextEncoder().encode(JSON.stringify({ message: String(text ?? '') })).length;
  function fitBundleForCarrier(data, request, base, generationId) {
    const overhead = autoRegionOverhead(generationId);
    let limit = Math.max(0, Math.min(data.autoSettings.autoOocMaxChars, PATCH_CHAR_LIMIT - base.length));
    for (let pass = 0; pass < allEntries(data).length + 2 && limit > 0; pass++) {
      const result = selectAutoOoc(data, { ...request, maxChars: limit, overhead });
      if (!result.block) return { result, region: '', message: base };
      const region = autoRegion(result.block, generationId), message = base + region;
      if (message.length <= PATCH_CHAR_LIMIT && carrierBytes(message) <= PATCH_BYTE_BUDGET) return { result, region, message };
      limit = Math.min(limit - 1, result.chars - 1);
    }
    return { result: { block: '', selected: [], matched: [], omitted: 0, chars: 0 }, region: '', message: base };
  }
  const LORE_TAG_PATTERN = /\s*<ooc_lore_context>[\s\S]*?<\/ooc_lore_context>\s*/gi, LORE_TAG_ESCAPED_PATTERN = /\s*&lt;ooc_lore_context&gt;[\s\S]*?&lt;\/ooc_lore_context&gt;\s*/gi;
  const WISH_BLOCK_PATTERN = /(?:\\|\?)?(?:<!--|&lt;!--)RP_CONTEXT_MANAGER_START\b[\s\S]*?RP_CONTEXT_MANAGER_END(?:-->|--&gt;)/gi;
  // 조건 판정용 USER 원문. 에리 로어 블록·AUTO 잔여물·WISH 블록이 글자수/키워드 조건을 스스로 건드리지 못하게 한다.
  function conditionSourceText(text) {
    const source = String(text ?? '');
    const cleaned = removeAutoRegions(source).replace(LORE_TAG_PATTERN, '\n').replace(LORE_TAG_ESCAPED_PATTERN, '\n').replace(WISH_BLOCK_PATTERN, '\n');
    return cleaned === source ? source : cleaned.trim();
  }
  function visibleConversationText(messages) {
    return [...(messages || [])].reverse().map(message => removeAutoRegions(messageTextOf(message)).replace(LORE_TAG_PATTERN, '\n').replace(LORE_TAG_ESCAPED_PATTERN, '\n').replace(/<!--[^]*?-->/g, '')).join('\n\n').slice(-12000);
  }
  function semanticModelLabel() {
    const button = [...document.querySelectorAll('button[aria-haspopup]')].find(node => node.querySelector('img[src*="/model-icon/"]'));
    return String(button?.textContent || '').trim();
  }
  function currentModelContext(payload, messages = []) {
    // 메시지 객체의 crackerModel/chatModelId/model은 직전 assistant 응답에 쓰인 모델이다. 아무 곳에서도 못 찾으면 빈 값이 되고 모델 조건 OOC만 빠진다.
    const lastAssistant = (messages || []).find(message => messageRoleOf(message) === 'assistant');
    const sources = [payload, payload?.data, payload?.options, payload?.data?.options, lastAssistant].filter(value => value && typeof value === 'object');
    const pick = (...keys) => { for (const source of sources) for (const key of keys) if (typeof source[key] === 'string' && source[key].trim()) return source[key].trim(); return ''; };
    let next = {};
    try {
      const script = document.querySelector('#__NEXT_DATA__'), state = script ? JSON.parse(script.textContent || '{}') : null;
      const chatId = String(payload?.chatId || payload?.data?.chatId || currentChatId());
      const fallback = state?.props?.pageProps?.fallback || {};
      next = fallback[`/v3/chats/${chatId}`]?.data || Object.values(fallback).find(value => String(value?.data?._id || value?.data?.id || '') === chatId)?.data || {};
    } catch {}
    return {
      crackerModel: pick('crackerModel', 'cracker_model') || String(next?.crackerModel || ''),
      chatModelId: pick('chatModelId', 'chat_model_id') || String(next?.chatModelId || ''),
      model: pick('model', 'modelId', 'model_id', 'engine') || String(next?.model || ''),
      label: pick('modelName', 'modelLabel', 'crackerModelName') || semanticModelLabel(),
    };
  }
  // 복구 기록은 "어느 방의 어느 메시지에 어떤 generation marker가 남았을 수 있는지"만 담는다.
  // 본문 snapshot은 저장하지 않으며, cleanup은 항상 서버의 현재 본문에서 자기 marker 구간만 지운다.
  function loadResidues() {
    try {
      const value = JSON.parse(pageStorage.getItem(RESIDUE_KEY) || '[]'), oldest = Date.now() - RESIDUE_MAX_AGE_MS;
      return Array.isArray(value) ? value.filter(row => row && row.chatId && row.messageId && row.generationId && !(Number(row.at) < oldest)) : [];
    } catch { return []; }
  }
  function saveResidues(rows) {
    try { if (rows.length) pageStorage.setItem(RESIDUE_KEY, JSON.stringify(rows.slice(-20))); else pageStorage.removeItem(RESIDUE_KEY); } catch {}
  }
  function rememberResidue(record) {
    const rows = loadResidues().filter(row => row.generationId !== record.generationId);
    rows.push({ chatId: record.chatId, messageId: record.messageId, generationId: record.generationId, event: record.event, at: record.at, v: AUTO_MARKER_VERSION });
    saveResidues(rows);
  }
  function forgetResidue(generationId) { saveResidues(loadResidues().filter(row => row.generationId !== generationId)); }
  const skipInjection = (reason, message = reason) => Object.assign(Error(message), { code: 'AUTO_OOC_SKIP', reason });
  // 이 스크립트가 같은 메시지를 읽고-고쳐-쓰는 작업(주입·cleanup)을 메시지 단위로 직렬화한다.
  function withCarrierLock(record, work) {
    const key = `${record.chatId}:${record.messageId}`, previous = carrierLocks.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(work);
    carrierLocks.set(key, task);
    return task.finally(() => { if (carrierLocks.get(key) === task) carrierLocks.delete(key); });
  }
  function mutateCarrier(record, build, verify, signal, hooks = {}) {
    return withCarrierLock(record, async () => {
      const endpoints = patchEndpoints(record.chatId, record.messageId); let lastError = null;
      for (let round = 0; round < endpoints.length; round++) {
        if (signal?.aborted) throw Object.assign(Error('자동 OOC 처리가 취소되었습니다.'), { code: 'AUTO_OOC_ABORT' });
        try {
          const currentMessage = await fetchCarrierMessage(record.chatId, record.messageId, signal);
          if (!currentMessage) return { missing: true, text: '' };
          const current = messageTextOf(currentMessage), built = await build(current);
          if (built.text === current && verify(current, built)) return { verified: true, unchanged: true, text: current, built };
          if (built.skip) return { skipped: true, text: current, built };
          // A second read immediately before PATCH narrows the non-atomic read/write window.
          const preflight = await fetchCarrierMessage(record.chatId, record.messageId, signal);
          if (!preflight || messageTextOf(preflight) !== current) { lastError = Error('PATCH 직전 carrier 본문이 바뀌었습니다.'); continue; }
          await hooks.guard?.(current);
          hooks.beforePatch?.();
          await crackRequest('PATCH', endpoints[round], { message: built.text }, signal);
          record.patched = true;
          // HTTP 2xx만으로는 성공으로 치지 않는다. 일부 endpoint는 2xx 뒤에도 본문이 그대로다.
          const checked = await fetchCarrierMessage(record.chatId, record.messageId, signal), observed = checked ? messageTextOf(checked) : '';
          if (verify(observed, built)) return { verified: true, text: observed, built };
          lastError = Error('PATCH 뒤 AUTO OOC marker 검증에 실패했습니다.');
        } catch (error) {
          if (error?.code === 'AUTO_OOC_SKIP' || error?.code === 'AUTO_OOC_ABORT') throw error;
          lastError = error;
        }
      }
      throw lastError || Error('AUTO OOC carrier PATCH에 실패했습니다.');
    });
  }
  function noteCleanup(generationId, ok, reason) {
    const diag = diagnosticsById.get(generationId); if (!diag) return;
    diag.cleanup = ok ? 'ok' : 'failed'; diag.recoveryReason = reason;
  }
  async function cleanupAutoRecord(record, signal, reason = 'manual') {
    try {
      const result = await mutateCarrier({ chatId: record.chatId, messageId: record.messageId },
        current => ({ text: removeAutoRegions(current, record.generationId) }),
        current => countAutoRegions(current, record.generationId) === 0, signal);
      if (result.verified || result.missing) {
        forgetResidue(record.generationId); live.delete(record.generationId); noteCleanup(record.generationId, true, reason);
        console.info('[Crack OOC 보관함] AUTO OOC cleanup', { reason, chatId: record.chatId, carrierId: record.messageId, generationId: record.generationId, removed: !result.unchanged && !result.missing });
        return true;
      }
    } catch (error) { console.warn('[Crack OOC 보관함] AUTO OOC cleanup 보류', { reason, record, error }); }
    noteCleanup(record.generationId, false, reason);
    return false;
  }
  // 준비 중(아직 원래 전송을 내보내지 않은) generation의 block은 어떤 trigger도 지우지 않는다.
  const cleanable = row => live.get(row.generationId)?.state !== 'preparing';
  // 이 페이지가 만든 기록이 아니면 다른 탭이 방금 준비한 generation일 수 있다. 충분히 지난 것만 잔여물로 본다.
  const staleEnough = row => !live.has(row.generationId) && Date.now() - Number(row.at || 0) >= LOAD_RECOVERY_MIN_AGE_MS;
  async function cleanupChatResidues(chatId, signal, reason = 'residue') {
    const outcome = { ok: true, cleaned: [] };
    for (const record of loadResidues().filter(row => String(row.chatId) === String(chatId) && cleanable(row))) {
      if (!await cleanupAutoRecord(record, signal, reason)) { outcome.ok = false; return outcome; }
      outcome.cleaned.push(record.messageId);
    }
    return outcome;
  }
  // 복구 기록이 없는 잔여물(다른 기기·지워진 저장소)도 최근 대화에서 marker로 찾아 지운다.
  async function cleanupStrayRegions(chatId, messages, signal, skipIds = []) {
    const outcome = { ok: true, cleaned: [] };
    for (const message of messages || []) {
      const messageId = messageIdOf(message);
      if (messageRoleOf(message) !== 'assistant' || skipIds.includes(messageId) || !countAutoRegions(messageTextOf(message))) continue;
      try {
        const result = await mutateCarrier({ chatId, messageId }, current => ({ text: removeAutoRegions(current) }), current => countAutoRegions(current) === 0, signal);
        if (!result.verified && !result.missing) { outcome.ok = false; return outcome; }
        outcome.cleaned.push(messageId);
        console.info('[Crack OOC 보관함] 기록 없는 AUTO OOC 잔여물 정리', { chatId, carrierId: messageId });
      } catch (error) { console.warn('[Crack OOC 보관함] AUTO OOC 잔여물 정리 실패', { chatId, messageId, error }); outcome.ok = false; return outcome; }
    }
    return outcome;
  }
  async function runCleanup(records, reason) {
    for (const record of records) {
      if (!cleanable(record) || cleanupRunning.has(record.generationId)) continue;
      const controller = new PageAbortController(), timer = setTimeout(() => controller.abort(), CLEANUP_TIMEOUT_MS);
      const task = cleanupAutoRecord(record, controller.signal, reason).finally(() => { clearTimeout(timer); cleanupRunning.delete(record.generationId); });
      cleanupRunning.set(record.generationId, task);
      await task;
    }
  }
  function scheduleCleanup(reason, filter, delay = 0) {
    // 대상은 trigger 시점에 확정한다. 이후에 준비되는 새 generation은 늦게 도착한 이전 trigger의 대상이 아니다.
    const targets = loadResidues().filter(row => cleanable(row) && filter(row)); if (!targets.length) return;
    setTimeout(() => { void runCleanup(targets, reason); }, Math.max(0, delay));
  }
  function armGeneration(record, socket) {
    const generationId = record.generationId;
    live.set(generationId, { chatId: record.chatId, state: 'armed', sentAt: Date.now(), lastStreamAt: 0, socket });
    // 완료·오류 이벤트를 받지 못한 generation은 마지막 스트림 활동 뒤 120초에 정리한다.
    const tick = () => {
      const row = live.get(generationId); if (!row) return;
      const idle = Date.now() - Math.max(row.sentAt, row.lastStreamAt);
      if (idle >= WATCHDOG_MS) scheduleCleanup('watchdog', item => item.generationId === generationId);
      else setTimeout(tick, WATCHDOG_MS - idle + 50);
    };
    setTimeout(tick, WATCHDOG_MS);
  }
  function recordDiagnostics(diag) {
    autoDiagnostics.push(diag); while (autoDiagnostics.length > 30) diagnosticsById.delete(autoDiagnostics.shift().generationId);
    if (diag.generationId) diagnosticsById.set(diag.generationId, diag);
    console.info('[Crack OOC 보관함] AUTO OOC', { ...diag });
  }
  function diagnosticsText() {
    return JSON.stringify({ hook: hookInfo, pendingCleanup: loadResidues(), recent: autoDiagnostics.slice(-5) }, null, 2);
  }
  async function injectAutoOoc(parsed, signal, socket = null, diag = {}) {
    const skip = reason => { diag.skipReason = reason; return null; };
    const data = await readLibrary();
    if (!data.autoSettings.autoInjectionEnabled || !allEntries(data).some(entry => entry.autoInjection.enabled)) return skip('auto-ooc-off');
    const chatId = String(parsed.payload?.chatId || parsed.payload?.data?.chatId || ''); if (!chatId) return skip('no-chat-id');
    // 방금 내보낸 generation이 아직 컨텍스트를 읽기 전일 수 있다. 그 block은 건드리지 않고 이번 frame만 그대로 보낸다.
    if ([...live.values()].some(row => row.chatId === chatId && row.state === 'armed' && !row.ended && Date.now() - row.sentAt < IN_PROGRESS_GRACE_MS)) return skip('generation-in-progress');
    let recent = await fetchRecentMessages(chatId, signal, 50), frame = stableCarrierFrame(recent);
    if (frame.trailingUser) return skip('trailing-user');
    // B. 이전 generation 잔여물: 복구 기록 → 기록 없는 marker 순서로 정리한다.
    const residues = await cleanupChatResidues(chatId, signal, `before-${parsed.event}`);
    if (!residues.ok) return skip('residue-cleanup-failed');
    const stray = await cleanupStrayRegions(chatId, recent, signal, residues.cleaned);
    if (!stray.ok) return skip('residue-cleanup-failed');
    if (residues.cleaned.length || stray.cleaned.length) {
      diag.recoveryReason = `before-${parsed.event}`;
      recent = await fetchRecentMessages(chatId, signal, 50); frame = stableCarrierFrame(recent);
      if (frame.trailingUser) return skip('trailing-user');
    }
    // C~E. 원래 USER 입력으로 조건을 다시 평가한다. reroll은 서버의 직전 USER 본문을 쓴다.
    const payloadText = parsed.payload?.message ?? parsed.payload?.content ?? parsed.payload?.text;
    const userText = conditionSourceText(parsed.event === 'send' && typeof payloadText === 'string' ? payloadText : messageTextOf(frame.latestUser));
    const model = currentModelContext(parsed.payload, recent);
    const request = { reason: parsed.event === 'reroll' ? 'before-reroll' : 'before-send', chatId, userText, recentText: visibleConversationText(recent), model };
    const planned = selectAutoOoc(data, request);
    Object.assign(diag, { userChars: userText.length, modelDetected: planned.modelDetected, matched: planned.matched, selected: planned.selected, bundleChars: planned.chars });
    if (!planned.block) return skip(planned.matched.length ? 'over-budget' : 'no-matching-ooc');
    // F~G. WRMC가 고를 carrier를 같은 알고리즘으로 예측해 제외하고, 남은 것 중 가장 가까운 안정 assistant를 쓴다.
    const wish = detectWish(data, recent), choice = selectAutoCarrier(frame, wish.separate);
    Object.assign(diag, { wrmc: { mode: wish.mode, signals: wish.signals, separate: wish.separate }, predictedWrmcCarrierId: choice.predictedWishId,
      carrierId: choice.carrierId, carriersSeparated: !!choice.carrierId && choice.carrierId !== choice.predictedWishId, rejectedCarriers: choice.rejected });
    if (!choice.carrier) return skip('no-independent-carrier');
    const generationId = (crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '_');
    const record = { chatId, messageId: choice.carrierId, generationId, event: parsed.event, at: Date.now(), patched: false, journaled: false };
    diag.generationId = generationId; request.generationKey = generationId;
    live.set(generationId, { chatId, state: 'preparing', sentAt: 0, lastStreamAt: 0, socket });
    try {
      const result = await mutateCarrier(record, current => {
        // H~I. PATCH 직전 최신 본문 기준 안전 조건. WRMC가 이미 쓰고 있는 메시지면 물러난다.
        if (hasWishMarker(current)) throw skipInjection('carrier-has-wish-marker');
        const base = removeAutoRegions(current);
        if (!base.trim()) throw skipInjection('carrier-empty');
        const fitted = fitBundleForCarrier(data, request, base, generationId);
        return fitted.region ? { text: fitted.message, fitted } : { text: current, skip: true, fitted };
      }, (observed, built) => !!built?.fitted?.region && normalizeBreaks(observed) === normalizeBreaks(built.text) && countAutoRegions(observed) === 1 && countAutoRegions(observed, generationId) === 1,
      signal, {
        async guard() {
          if (currentChatId() !== chatId) throw skipInjection('chat-changed');
          if (socket && socket.readyState !== 1) throw skipInjection('socket-not-open');
          const now = stableCarrierFrame(await fetchRecentMessages(chatId, signal, 30));
          const again = selectAutoCarrier(now, wish.separate || detectWish(data, now.messages).separate);
          if (now.trailingUser || messageIdOf(now.latest) === record.messageId || again.carrierId !== record.messageId || wish.separate && again.predictedWishId === record.messageId) throw skipInjection('carrier-changed');
        },
        // 복구 기록을 PATCH보다 먼저 남긴다. PATCH 응답을 못 받아도 잔여물 위치를 잃지 않는다.
        beforePatch() { record.journaled = true; rememberResidue(record); },
      });
      if (!result.verified) { live.delete(generationId); return skip(result.missing ? 'carrier-missing' : 'over-budget'); }
      const fitted = result.built.fitted.result;
      Object.assign(diag, { selected: fitted.selected, bundleChars: fitted.chars, patched: true, verified: true, cleanup: 'pending' });
      return record;
    } catch (error) {
      diag.skipReason = error?.reason || (error?.code === 'AUTO_OOC_ABORT' ? 'timeout' : 'patch-or-verify-failed'); diag.error = String(error?.message || error);
      diag.patched = record.patched; diag.verified = false;
      if (!record.journaled) { live.delete(generationId); return null; }
      // PATCH가 서버에 닿았을 수 있다. 원래 전송을 내보내기 전에 자기 marker부터 지워 본다.
      live.set(generationId, { chatId, state: 'armed', sentAt: 0, lastStreamAt: 0, socket });
      const controller = new PageAbortController(), timer = setTimeout(() => controller.abort(), 3000);
      try { await cleanupAutoRecord(record, controller.signal, 'inject-failed'); } finally { clearTimeout(timer); }
      return null;
    }
  }
  const STREAM_CHUNK_PATTERN = /^42(?:\/v3\/chats,)?\d*\["characterMessageGenerating"/;
  const COMPLETED_FRAME_PATTERN = /^42(?:\/v3\/chats,)?\d*\["characterMessageGenerated"/;
  function watchAutoSocket(socket) {
    if (socketWatch.has(socket)) return; socketWatch.add(socket);
    socket.addEventListener('message', event => {
      const data = event.data; if (typeof data !== 'string') return;
      // 누적 스트림 chunk는 JSON으로 풀지 않고 watchdog 기준 시각만 갱신한다.
      if (STREAM_CHUNK_PATTERN.test(data)) { for (const row of live.values()) if (row.socket === socket && row.state === 'armed') row.lastStreamAt = Date.now(); return; }
      if (!live.size && !COMPLETED_FRAME_PATTERN.test(data)) return;
      const parsed = parseSocketFrame(data); if (!parsed) return;
      const reason = parsed.event === 'characterMessageGenerated' ? 'generation-completed' : /cancel/i.test(parsed.event) ? 'generation-cancelled' : /(?:error|failed)/i.test(parsed.event) ? 'generation-error' : '';
      if (!reason) return;
      const chatId = String(parsed.payload?.data?.chatId || parsed.payload?.chatId || '');
      const sameChat = row => chatId ? String(row.chatId) === chatId : live.get(row.generationId)?.socket === socket;
      for (const [generationId, row] of live) if (row.state === 'armed' && sameChat({ generationId, chatId: row.chatId })) row.ended = true;
      scheduleCleanup(reason, sameChat);
    });
    socket.addEventListener('close', () => scheduleCleanup('socket-close', row => live.get(row.generationId)?.socket === socket || staleEnough(row)));
  }
  function looksLikeWishWrapper(fn) {
    try { return /sendNeedsPreparation|generationGates|WishHistory/.test(Function.prototype.toString.call(fn)); } catch { return false; }
  }
  function frameKey(parsed) {
    const payload = parsed.payload || {}, requestId = parsed.ackId || payload.requestId || payload.generationId || payload.turnId || payload.data?.requestId;
    return requestId ? `${payload.chatId || payload.data?.chatId}:${parsed.event}:${requestId}` : `${payload.chatId || payload.data?.chatId}:${parsed.event}:${String(parsed.raw).slice(-300)}`;
  }
  function installStandaloneInjector() {
    const previousSend = W.WebSocket?.prototype?.send; if (typeof previousSend !== 'function') return;
    // 같은 스크립트가 두 번 주입돼도 hook은 하나만 둔다.
    if (previousSend.__crackOocLibraryAutoHook || W.__CRACK_OOC_LIBRARY_AUTO_HOOK__) return;
    try { Object.defineProperty(W, '__CRACK_OOC_LIBRARY_AUTO_HOOK__', { value: true, configurable: true }); } catch {}
    // 진단용 정보일 뿐이다. 안쪽이든 바깥쪽이든 같은 방식으로 동작한다.
    let native = false; try { native = /\[native code\]/.test(Function.prototype.toString.call(previousSend)); } catch {}
    hookInfo.installed = true; hookInfo.wishWrapper = looksLikeWishWrapper(previousSend);
    hookInfo.position = native ? 'inner (native send 바로 위)' : hookInfo.wishWrapper ? 'outer (WRMC wrapper 바깥)' : 'outer (다른 wrapper 바깥)';
    function autoOocSend(data) {
      watchAutoSocket(this);
      const parsed = parseSocketFrame(data), chatId = String(parsed?.payload?.chatId || parsed?.payload?.data?.chatId || '');
      if (!parsed || !['send', 'reroll'].includes(parsed.event) || !chatId || chatId !== currentChatId()) return previousSend.call(this, data);
      if (library && (!library.autoSettings.autoInjectionEnabled || !allEntries(library).some(entry => entry.autoInjection.enabled))) return previousSend.call(this, data);
      const socket = this, key = frameKey(parsed); if (inFlight.has(key)) { console.warn('[Crack OOC 보관함] 동일 generation 중복 hook을 무시했습니다.', key); return undefined; }
      inFlight.add(key);
      const previous = sendQueues.get(chatId) || Promise.resolve();
      const task = previous.catch(() => {}).then(async () => {
        const started = Date.now(), diag = { generationId: '', event: parsed.event, at: started, hook: hookInfo.position, patched: false, verified: false, cleanup: 'not-needed', skipReason: '', recoveryReason: '' };
        const controller = new PageAbortController(), timer = setTimeout(() => controller.abort(), PREPARE_TIMEOUT_MS); let record = null;
        try { record = await injectAutoOoc(parsed, controller.signal, socket, diag); }
        catch (error) { diag.skipReason = diag.skipReason || (error?.code === 'AUTO_OOC_ABORT' ? 'timeout' : 'error'); diag.error = String(error?.message || error); console.warn('[Crack OOC 보관함] 자동주입 실패 · 정상 채팅을 계속합니다.', error); }
        finally { clearTimeout(timer); }
        diag.prepareMs = Date.now() - started;
        // M. payload는 한 글자도 바꾸지 않고 그대로 넘긴다.
        try {
          previousSend.call(socket, data); diag.sent = true;
          if (record) { armGeneration(record, socket); if (socket.readyState !== undefined && socket.readyState !== 1) scheduleCleanup('socket-not-open', row => row.generationId === record.generationId); }
        } catch (error) {
          diag.sent = false; console.error('[Crack OOC 보관함] 원래 WebSocket 전송 실패', error);
          if (record) { live.set(record.generationId, { chatId, state: 'armed', sentAt: 0, lastStreamAt: 0, socket }); scheduleCleanup('send-failed', row => row.generationId === record.generationId); }
        }
        recordDiagnostics(diag);
      }).finally(() => { inFlight.delete(key); if (sendQueues.get(chatId) === task) sendQueues.delete(chatId); });
      sendQueues.set(chatId, task); return undefined;
    }
    autoOocSend.__crackOocLibraryAutoHook = true;
    W.WebSocket.prototype.send = autoOocSend;
    W.addEventListener?.('pagehide', () => scheduleCleanup('pagehide', row => live.has(row.generationId) || staleEnough(row)));
    // 방을 옮긴 뒤(주소가 바뀐 뒤)에 판단한다. 지금 방에서 진행 중인 generation은 완료 이벤트가 정리한다.
    W.navigation?.addEventListener?.('navigate', () => setTimeout(() => scheduleCleanup('navigate', row => live.has(row.generationId) ? String(row.chatId) !== currentChatId() : staleEnough(row)), 1000));
    // 새로고침·탭 종료로 남은 잔여물. 다른 탭이 방금 준비한 generation일 수 있으므로 충분히 지난 기록만 정리한다.
    setTimeout(() => {
      for (const row of loadResidues()) {
        const wait = Math.max(0, LOAD_RECOVERY_MIN_AGE_MS - (Date.now() - Number(row.at || 0)));
        setTimeout(() => scheduleCleanup('page-load', item => item.generationId === row.generationId && staleEnough(item)), wait + 50);
      }
    }, 1500);
  }
  if (W.__CRACK_OOC_LIBRARY_TEST__ === true) {
    Object.defineProperty(W, '__CRACK_OOC_LIBRARY_TEST_API__', { configurable: true, value: {
      check, transport, selectAutoOoc, stableCarrierFrame, selectAutoCarrier, detectWish, removeAutoRegions, countAutoRegions, autoRegion, autoRegionOverhead,
      conditionSourceText, cleanupAutoRecord, cleanupChatResidues, injectAutoOoc, markerPattern, fitBundleForCarrier, loadResidues, diagnostics: autoDiagnostics, hookInfo, live,
    } });
  }
  function backup(data) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const anchor = node('a'); anchor.href = url; anchor.download = `OOC-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function showManager() {
    await readLibrary(); if (manager) return;
    manager = dialog('OOC 보관함', 'large'); drawManager();
    manager.root.addEventListener('cancel', () => { if (!saving) exitManager().catch(error => alert(error.message)); });
  }
  async function exitManager() {
    if (saving) return;
    if (editing && !await confirm('미저장 변경', '저장하지 않은 변경을 버리고 닫을까요?', '버리고 닫기')) return;
    editing = null; manager.close(); manager = null; expanded.clear();
  }
  function drawManager() {
    if (!manager) return;
    const view = manager, query = view.body.querySelector('input[type="search"]')?.value || '';
    view.header.replaceChildren(view.label);
    if (editing) { const dot = node('span', 'oa-dot'); dot.title = '미저장 변경'; dot.setAttribute('aria-label', '미저장 변경'); view.header.append(dot); }
    const buttons = node('div', 'oa-actions');
    buttons.append(action('DB 연동', showConnection, settings.mode === 'firebase' ? 'flame' : 'local'), action('설정', showBackup, 'gear'), action('저장', saveLibrary, 'save'), action('닫기', exitManager, 'close'));
    buttons.querySelectorAll('button').forEach(button => { button.disabled = saving; });
    buttons.children[2].disabled = saving || !editing; view.header.append(buttons); view.body.replaceChildren(); view.footer.hidden = true;
    const toolbar = node('div', 'oa-toolbar'), search = node('div', 'oa-search'); search.innerHTML = svg('search');
    const input = node('input'); input.type = 'search'; input.placeholder = '검색'; input.setAttribute('aria-label', '검색'); input.value = query; search.append(input);
    const rows = node('div', 'oa-tree'); input.addEventListener('input', () => drawTree(rows, input.value));
    toolbar.append(search, action('OOC 추가', () => editOoc(), 'plus'), action('카테고리 추가', () => editFolder(), 'folderPlus'));
    toolbar.querySelectorAll('button').forEach(button => { button.disabled = saving; }); view.body.append(toolbar, rows); drawTree(rows, query);
  }
  function row(title, location, edit, remove, auto = false) {
    const root = node('div', 'oa-row'); root.dataset.kind = location.kind;
    const symbol = node('span', 'oa-symbol'); symbol.innerHTML = svg(location.kind === 'folder' ? 'folder' : 'file'); root.append(symbol, node('span', 'oa-name', title));
    if (auto) root.append(node('span', 'oa-auto-badge', '자동'));
    const tools = node('div', 'oa-row-actions'); const handle = action('순서 변경', () => {}, 'grip'); handle.dataset.sort = '';
    handle.addEventListener('pointerdown', event => startDrag(event, root, location));
    tools.append(handle);
    if (location.kind === 'folder') tools.append(action('이 카테고리에 OOC 추가', () => editOoc(location.category), 'plus'));
    tools.append(action('편집', edit, 'edit'), action('삭제', remove, 'trash'));
    tools.querySelectorAll('button').forEach(button => { button.disabled = saving; }); root.append(tools); return root;
  }
  function drawTree(root, query) {
    root.replaceChildren(); const data = editing || library, needle = query.trim().toLocaleLowerCase();
    const matches = item => [item.name, item.content, item.autoInjection.injectionBody, item.autoInjection.conditionValue].some(value => String(value || '').toLocaleLowerCase().includes(needle));
    data.categories.forEach((folder, category) => {
      const { name, items } = folder, folderMatch = name.toLocaleLowerCase().includes(needle);
      if (needle && !folderMatch && !items.some(matches)) return;
      const group = node('section', 'oa-group'); const header = row(name, { kind: 'folder', category }, () => editFolder(category), () => deleteEntry(category));
      const toggle = node('button', 'oa-toggle'); toggle.type = 'button'; toggle.innerHTML = svg('chevron'); toggle.setAttribute('aria-label', `${name} 펼치기`);
      const open = expanded.has(category) || !!needle; group.classList.toggle('oa-open', open); toggle.setAttribute('aria-expanded', String(open));
      header.prepend(toggle); const children = node('div', 'oa-children'); children.hidden = !open;
      toggle.onclick = () => { if (expanded.has(category)) expanded.delete(category); else expanded.add(category); drawTree(root, query); };
      header.querySelector('.oa-name').onclick = toggle.onclick;
      const count = node('span', 'oa-count', String(items.length)); header.insertBefore(count, header.lastChild);
      items.forEach((item, index) => { if (!needle || folderMatch || matches(item)) {
        const element = row(item.name, { kind: 'ooc', category, index }, () => editOoc(category, index), () => deleteEntry(category, index), item.autoInjection.enabled); children.append(element); dropTarget(element, { kind: 'ooc', category, index });
      } });
      if (!items.length) children.append(node('div', 'oa-empty'));
      dropTarget(header, { kind: 'folder', category }); dropTarget(children, { kind: 'ooc', category, index: items.length }, true);
      // 접힌 카테고리 위에 OOC를 놓으면 그 카테고리 마지막으로 이동한다.
      dropTarget(header, { kind: 'ooc', category, index: items.length }, true);
      group.append(header, children); root.append(group);
    });
    const extras = node('section', 'oa-extras');
    data.extras.forEach((item, index) => { if (matches(item)) {
      const element = row(item.name, { kind: 'ooc', category: -1, index }, () => editOoc(-1, index), () => deleteEntry(-1, index), item.autoInjection.enabled); extras.append(element); dropTarget(element, { kind: 'ooc', category: -1, index });
    } });
    if (!data.extras.length) extras.append(node('div', 'oa-empty')); dropTarget(extras, { kind: 'ooc', category: -1, index: data.extras.length }, true); root.append(extras);
  }
  function clearDrag() {
    drag?.events.abort(); drag?.ghost?.remove();
    document.querySelectorAll('.oa-before,.oa-after,.oa-dragging').forEach(element => element.classList.remove('oa-before', 'oa-after', 'oa-dragging')); drag = null;
  }
  function dropTarget(element, target, end = false) {
    const areas = dropAreas.get(element) || {}; areas[target.kind] = { target, end }; dropAreas.set(element, areas);
  }
  function startDrag(event, element, location) {
    if (event.button !== 0 || saving || manager.body.querySelector('input[type="search"]').value) return;
    event.preventDefault(); event.stopPropagation();
    const startX = event.clientX, startY = event.clientY, rect = element.getBoundingClientRect(), events = new PageAbortController();
    drag = { ...location, element, events, ghost: null, destination: null };
    document.addEventListener('pointermove', move => {
      if (move.pointerId !== event.pointerId || !drag) return;
      if (!drag.ghost && Math.hypot(move.clientX - startX, move.clientY - startY) < 4) return;
      move.preventDefault();
      if (!drag.ghost) {
        drag.ghost = element.cloneNode(true); drag.ghost.classList.add('oa-ghost');
        Object.assign(drag.ghost.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px` });
        manager.root.append(drag.ghost); element.classList.add('oa-dragging');
      }
      drag.ghost.style.transform = `translate(${move.clientX - startX}px,${move.clientY - startY}px)`;
      document.querySelectorAll('.oa-before,.oa-after').forEach(item => item.classList.remove('oa-before', 'oa-after'));
      drag.destination = null;
      for (const hit of document.elementsFromPoint(move.clientX, move.clientY)) {
        const area = dropAreas.get(hit)?.[drag.kind]; if (!area || hit === element) continue;
        const after = area.end || move.clientY > hit.getBoundingClientRect().top + hit.offsetHeight / 2;
        const target = area.target;
        drag.destination = { ...target, [drag.kind === 'folder' ? 'category' : 'index']: (drag.kind === 'folder' ? target.category : target.index) + (!area.end && after ? 1 : 0) };
        hit.classList.add(after ? 'oa-after' : 'oa-before'); break;
      }
    }, { signal: events.signal, passive: false });
    document.addEventListener('pointerup', finish => {
      if (finish.pointerId !== event.pointerId) return;
      const target = drag?.destination; if (target) moveDrag(target); else clearDrag();
    }, { signal: events.signal });
    document.addEventListener('pointercancel', clearDrag, { signal: events.signal });
  }
  function moveDrag(target) {
    const source = drag; clearDrag(); if (!source) return;
    change(data => {
      if (source.kind === 'folder') {
        const item = data.categories.splice(source.category, 1)[0]; data.categories.splice(target.category - (source.category < target.category ? 1 : 0), 0, item); expanded.clear();
      } else {
        const from = contents(data, source.category), to = contents(data, target.category); const item = from.splice(source.index, 1)[0];
        to.splice(target.index - (source.category === target.category && source.index < target.index ? 1 : 0), 0, item);
      }
    });
  }
  function editFolder(category) {
    if (saving) return; const data = editing || library, view = dialog(category === undefined ? '카테고리 추가' : '카테고리 편집');
    const input = field(view.body, '이름', 'input', category === undefined ? '' : data.categories[category].name);
    view.footer.append(action('취소', view.close), action('적용', () => {
      const name = input.value.trim(); if (!name) throw Error('카테고리 이름을 입력하세요.');
      change(data => { if (category === undefined) data.categories.push({ name, items: [] }); else data.categories[category].name = name; }); view.close();
    }, null, 'oa-primary')); closeWithEscape(view); input.focus();
  }
  function editOoc(category = -1, index) {
    if (saving) return; const data = editing || library;
    const current = index === undefined ? { id: newId(), name: '', content: '', autoInjection: { ...AUTO_DEFAULTS } } : contents(data, category)[index];
    const view = dialog(index === undefined ? 'OOC 추가' : 'OOC 편집');
    const name = field(view.body, '이름', 'input', current.name), body = field(view.body, '내용', 'textarea', current.content), folder = field(view.body, '카테고리', 'select'); body.rows = 9;
    folder.append(new Option('미분류', '-1')); data.categories.forEach((item, index) => folder.append(new Option(item.name, String(index)))); folder.value = String(category);
    const autoArea = node('section', 'oa-auto-editor'); autoArea.append(node('h3', '', '자동주입'));
    const enabled = toggleField(autoArea, '이 OOC 자동주입', current.autoInjection.enabled, 'USER 입력문에는 붙이지 않고 숨은 assistant carrier 컨텍스트에만 추가합니다.');
    const condition = field(autoArea, '조건 유형', 'select');
    for (const [value, label] of [['always', '항상'], ['model', '모델'], ['userLength', 'USER 입력 글자수'], ['keyword', '키워드/트리거']]) condition.append(new Option(label, value));
    condition.value = current.autoInjection.conditionType;
    const conditionValue = field(autoArea, '조건값', 'input', current.autoInjection.conditionValue);
    const scope = field(autoArea, '키워드 검색 범위', 'select');
    for (const [value, label] of [['user', '현재 USER 입력'], ['recent', '최근 대화'], ['both', '현재 USER 입력 + 최근 대화']]) scope.append(new Option(label, value));
    scope.value = current.autoInjection.keywordScope;
    const priority = field(autoArea, '우선순위 (-999~999)', 'input', String(current.autoInjection.priority)); priority.type = 'number'; priority.min = '-999'; priority.max = '999'; priority.step = '1';
    const injectionBody = field(autoArea, '주입용 본문', 'textarea', current.autoInjection.injectionBody); injectionBody.rows = 6; injectionBody.placeholder = '비우면 위의 기존 OOC 내용을 사용합니다.';
    const hint = node('p', 'oa-hint'); autoArea.append(hint); view.body.append(autoArea);
    function syncConditionUi() {
      const type = condition.value; scope.closest('.oa-field').hidden = type !== 'keyword'; conditionValue.closest('.oa-field').hidden = type === 'always';
      conditionValue.placeholder = type === 'model' ? '예: hyperchat 또는 하이퍼챗 1.0 (쉼표/줄바꿈으로 복수)' : type === 'userLength' ? '예: 500+, 800~1500, 1500 이상' : '쉼표 또는 줄바꿈으로 여러 키워드';
      hint.textContent = type === 'model' ? '전송 payload·직전 AI 답변의 crackerModel/chatModelId/model과 현재 모델 표시명을 정확히 비교합니다. 모델을 확인하지 못한 턴에는 이 OOC만 빠집니다.' : type === 'userLength' ? '현재 전송하려는 USER 문자열의 JavaScript length를 로컬에서 계산합니다. 에리 로어 블록 등 다른 확장이 붙인 내용은 세지 않습니다.' : type === 'keyword' ? '대소문자를 구분하지 않는 포함 검색입니다.' : '매 전송/리롤의 자동주입 후보가 됩니다.';
    }
    condition.addEventListener('change', syncConditionUi); syncConditionUi();
    view.footer.append(action('취소', view.close), action('적용', () => {
      const title = name.value.trim(); if (!title || Array.from(title).length > 20) throw Error('이름은 1~20자로 입력하세요.');
      const priorityValue = Number(priority.value); if (!Number.isInteger(priorityValue) || priorityValue < -999 || priorityValue > 999) throw Error('우선순위는 -999~999 정수로 입력하세요.');
      if (enabled.checked && condition.value !== 'always' && !conditionValue.value.trim()) throw Error('선택한 자동주입 조건값을 입력하세요.');
      if (condition.value === 'userLength' && !parseLengthCondition(conditionValue.value)) throw Error('글자수 조건은 500+, 800~1500, 1500 이상처럼 입력하세요.');
      change(data => {
        const to = Number(folder.value), value = { id: current.id, name: title, content: body.value, autoInjection: normalizeAuto({ enabled: enabled.checked, conditionType: condition.value, conditionValue: conditionValue.value.trim(), keywordScope: scope.value, priority: priorityValue, injectionBody: injectionBody.value }) };
        if (index === undefined) contents(data, to).push(value);
        else if (to === category) contents(data, category)[index] = value;
        else { contents(data, category).splice(index, 1); contents(data, to).push(value); }
      }); view.close();
    }, null, 'oa-primary')); closeWithEscape(view); name.focus();
  }
  async function deleteEntry(category, index) {
    if (saving) return;
    if (!await confirm('삭제 확인', index === undefined ? '카테고리와 안에 있는 모든 OOC를 삭제할까요?' : '이 OOC를 삭제할까요?', '삭제')) return;
    change(data => { if (index === undefined) { data.categories.splice(category, 1); expanded.clear(); } else contents(data, category).splice(index, 1); });
  }
  function showBackup() {
    const view = dialog('설정'); const data = editing || library, autoHeading = node('h3', '', '자동 OOC');
    const autoArea = node('section', 'oa-settings-section'), enabled = toggleField(autoArea, '자동 OOC 사용', data.autoSettings.autoInjectionEnabled, 'USER 입력문은 건드리지 않습니다. 과거 AI 답변 하나에 응답이 끝날 때까지만 숨김 주석으로 붙였다가 제거합니다. 독립된 답변을 확보하지 못한 턴은 자동 OOC만 건너뜁니다.');
    const maxChars = field(autoArea, '자동 OOC 최대 글자수 (USER 2,000자와 별개 · marker/구분자 포함)', 'input', String(data.autoSettings.autoOocMaxChars)); maxChars.type = 'number'; maxChars.min = '0'; maxChars.max = '50000'; maxChars.step = '100';
    const wrmcMode = field(autoArea, 'Wish RP Manager와 주입 대상 분리', 'select');
    for (const [value, label] of [['auto', '자동 감지 (권장)'], ['always', '항상 분리'], ['never', '분리 안 함 (WRMC 미사용)']]) wrmcMode.append(new Option(label, value));
    wrmcMode.value = data.autoSettings.wrmcCarrierMode;
    const draftSettings = () => normalizeSettings({ autoInjectionEnabled: enabled.checked, autoOocMaxChars: Number(maxChars.value), wrmcCarrierMode: wrmcMode.value });
    const preview = node('div', 'oa-preview'), previewTitle = node('strong', '', '자동 적용 예정'), previewList = node('div', 'oa-preview-list', '미리보기를 눌러 확인하세요.'); preview.append(previewTitle, previewList);
    const previewButton = action('현재 턴 미리보기', async () => {
      const context = await standalonePreviewContext();
      const draft = copy(editing || library); draft.autoSettings = draftSettings();
      const result = selectAutoOoc(draft, { ...context, reason: 'preview', maxChars: Number(maxChars.value) });
      previewList.replaceChildren();
      if (!result.selected.length) previewList.append(node('span', 'oa-muted', '현재 조건에 맞는 OOC가 없습니다.'));
      else result.selected.forEach(item => previewList.append(node('div', '', `- ${item.name} (우선순위 ${item.priority})`)));
      if (result.selected.length) previewList.append(node('small', '', `예상 ${result.chars.toLocaleString()}자 / 최대 ${result.maxChars.toLocaleString()}자`));
      if (result.omitted) previewList.append(node('small', '', `한도 때문에 제외 ${result.omitted}개`));
      if (context.frame) {
        const choice = selectAutoCarrier(context.frame, detectWish(draft, context.frame.messages).separate);
        previewList.append(node('small', '', context.frame.trailingUser ? '주입 대상: 답 없는 USER가 마지막이라 이번 턴은 건너뜁니다.' : !choice.carrier ? '주입 대상: 독립된 과거 AI 답변이 없어 이번 턴은 건너뜁니다.' : choice.carrierId !== choice.predictedWishId ? '주입 대상: WRMC와 분리된 과거 AI 답변' : '주입 대상: 최신 직전의 과거 AI 답변'));
      }
    });
    const diagnostics = node('details', 'oa-diagnostics'), diagnosticsBody = node('pre', '', ''); diagnostics.append(node('summary', '', '진단 (최근 자동 OOC)'), diagnosticsBody);
    diagnostics.addEventListener('toggle', () => { if (diagnostics.open) diagnosticsBody.textContent = diagnosticsText(); });
    autoArea.prepend(autoHeading); autoArea.append(previewButton, preview, diagnostics);
    const heading = node('h3', '', '백업'); const buttons = node('div', 'oa-backup');
    const file = node('input'); file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true;
    file.addEventListener('change', async () => {
      if (!file.files[0]) return;
      try {
        const data = check(JSON.parse(await file.files[0].text()));
        if (!await confirm('전체 복원', `현재 전체 자료와 미저장 변경을 백업의 OOC ${total(data)}개로 교체합니다. 저장을 누르면 기존 DB 자료가 덮어써집니다. 계속할까요?`, '복원')) return;
        data.updatedAt = library.updatedAt; editing = data; expanded.clear(); drawManager(); view.close();
      } catch (error) { alert(`복원 실패: ${error.message}`); }
    });
    buttons.append(action('전체 백업', () => backup(editing || library)), action('전체 복원', () => file.click())); view.body.append(autoArea, heading, buttons, file);
    view.footer.append(action('취소', view.close), action('자동 OOC 설정 적용', () => {
      const max = Number(maxChars.value); if (!Number.isSafeInteger(max) || max < 0 || max > 50000) throw Error('자동 OOC 최대 글자수는 0~50,000 정수로 입력하세요.');
      change(next => { next.autoSettings = draftSettings(); }); view.close();
    }, null, 'oa-primary')); closeWithEscape(view);
  }

  function localPreviewContext() {
    const editor = document.querySelector('.__chat_input_textarea[contenteditable="true"]');
    const userText = editor?.textContent || '';
    const modelButton = [...document.querySelectorAll('button')].find(button => button.querySelector('img[src*="/model-icon/"]') && button.getAttribute('aria-haspopup'));
    const label = modelButton?.textContent?.trim() || '';
    let model = { label };
    try {
      const chatId = location.pathname.match(/\/(?:episodes|chats|c)\/([^/?#]+)/)?.[1] || '';
      const next = JSON.parse(document.querySelector('#__NEXT_DATA__')?.textContent || '{}');
      const meta = next?.props?.pageProps?.fallback?.[`/v3/chats/${chatId}`]?.data;
      if (meta) model = { crackerModel: meta.crackerModel, chatModelId: meta.chatModelId, model: meta.model, label };
    } catch { /* 현재 표시명만 사용한다. */ }
    return { reason: 'preview', userText, recentText: '', model };
  }

  async function standalonePreviewContext() {
    const base = localPreviewContext(), chatId = currentChatId();
    if (!chatId) return base;
    const controller = new PageAbortController(), timer = setTimeout(() => controller.abort(), 3000);
    try {
      const messages = await fetchRecentMessages(chatId, controller.signal, 30);
      let frame = null; try { frame = stableCarrierFrame(messages); } catch { /* carrier 표시만 생략한다. */ }
      return { ...base, chatId, frame, userText: conditionSourceText(base.userText), recentText: visibleConversationText(messages), model: currentModelContext(null, messages) };
    } catch (error) {
      console.info('[Crack OOC 보관함] 미리보기 최근 대화 조회 생략', error);
      return { ...base, chatId };
    } finally { clearTimeout(timer); }
  }

  function showConnection() {
    if (editing) throw Error('변경을 저장하거나 버린 뒤 DB를 전환하세요.');
    const view = dialog('DB 연동'); let mode = settings.mode, login = null, applying = false;
    const top = node('div', 'oa-db-top'), segment = node('div', 'oa-segment'); segment.setAttribute('role', 'radiogroup'); segment.setAttribute('aria-label', '저장소');
    const firebaseArea = node('div', 'oa-firebase');
    const config = field(firebaseArea, 'Firebase config', 'textarea', settings.config ? JSON.stringify(settings.config, null, 2) : ''); config.rows = 7; config.spellcheck = false;
    const credentials = node('div', 'oa-credentials'), email = node('input'), password = node('input'); email.type = 'email'; email.placeholder = '이메일'; email.autocomplete = 'username'; email.setAttribute('aria-label', '이메일');
    password.type = 'password'; password.placeholder = '비밀번호'; password.autocomplete = 'current-password'; password.setAttribute('aria-label', '비밀번호');
    const state = node('p', 'oa-auth-state', settings.mode === 'firebase' ? '연결됨' : '');
    const loginButton = action('로그인', async () => {
      login = null; const chosenConfig = configFrom(config.value);
      try {
        const auth = await http(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(chosenConfig.apiKey)}`, 'POST', { email: email.value.trim(), password: password.value, returnSecureToken: true });
        login = { mode: 'firebase', config: chosenConfig, auth: { uid: auth.localId, token: auth.idToken, refreshToken: auth.refreshToken, until: Date.now() + Number(auth.expiresIn) * 1000 } }; state.textContent = '로그인됨';
      } finally { password.value = ''; }
    }); credentials.append(email, password, loginButton); firebaseArea.append(credentials, state);
    const guide = action('연동 가이드', () => showGuide(login || (settings.mode === 'firebase' ? settings : null)), 'help', 'oa-guide');
    for (const [value, text] of [['local', '로컬'], ['firebase', 'Firebase']]) {
      const label = node('label'), radio = node('input'); radio.type = 'radio'; radio.name = 'oa-storage-mode'; radio.value = value; radio.checked = mode === value;
      radio.addEventListener('change', () => { mode = value; updateMode(); }); label.append(radio, node('span', '', text)); segment.append(label);
    }
    function updateMode() { firebaseArea.hidden = mode !== 'firebase'; guide.hidden = mode !== 'firebase'; }
    updateMode(); top.append(segment, guide); view.body.append(top, firebaseArea);
    config.addEventListener('input', () => { login = null; state.textContent = ''; });
    const cancel = action('취소', view.close), apply = action('연동 적용', async () => {
      applying = true; view.root.setAttribute('aria-busy', 'true'); cancel.disabled = true;
      view.body.querySelectorAll('input,textarea,button').forEach(control => { control.disabled = true; });
      try {
        if (mode === 'local' && settings.mode === 'local') { view.close(); return; }
        if (mode === 'local') {
          const local = await localData(), choice = await selectSource(local, library, true); if (!choice) return;
          const data = choice === 'local' ? local : copy(library); if (choice === 'firebase') await localData(data);
          const next = { mode: 'local', ...(settings.config ? { config: settings.config } : {}) };
          pageStorage.setItem(STORAGE_KEY, JSON.stringify(next)); settings = next; library = data;
        } else {
          const chosen = configFrom(config.value);
          const connection = login || (settings.mode === 'firebase' ? copy(settings) : null);
          if (!connection || JSON.stringify(connection.config) !== JSON.stringify(chosen)) throw Error('현재 config로 먼저 로그인하세요.');
          const raw = await firebase(connection), remote = raw === null ? fresh() : check(transport(raw, 'read'));
          const local = await localData();
          const choice = raw === null ? 'local' : await selectSource(local, remote); if (!choice) return;
          const data = copy(choice === 'local' ? local : remote);
          if (choice === 'local') { data.updatedAt = Math.max(Date.now(), remote.updatedAt + 1); await firebase(connection, 'PUT', '', transport(data, 'write')); }
          else await localData(data);
          pageStorage.setItem(STORAGE_KEY, JSON.stringify(connection)); settings = connection; library = data;
        }
        drawManager(); drawPanels(); view.close();
      } finally {
        applying = false; view.root.removeAttribute('aria-busy'); cancel.disabled = false;
        view.body.querySelectorAll('input,textarea,button').forEach(control => { control.disabled = false; });
      }
    }, null, 'oa-primary'); view.footer.append(cancel, apply);
    view.root.addEventListener('cancel', () => { if (!applying && !loginButton.disabled) view.close(); });
  }
  function selectSource(local, remote, disconnect = false) {
    return new Promise(resolve => {
      const view = dialog('사용할 데이터 선택'), choices = node('div', 'oa-source-options'); let source = null;
      view.body.append(node('p', 'oa-message', disconnect ? 'Firebase 원본은 유지됩니다. 로컬에서 사용할 자료를 선택하세요.' : '자료를 합치지 않고 한쪽 전체 자료를 사용합니다. 반대쪽 자료는 삭제·덮어쓰기되며, 백업이 없으면 복구할 수 없습니다.'));
      const warning = node('p', 'oa-message oa-warning'), apply = action('적용', () => finish(source), null, 'oa-primary'); apply.disabled = true;
      for (const [key, title, data] of [['local', '로컬', local], ['firebase', 'Firebase', remote]]) {
        const card = action(title, () => {
          source = key; apply.disabled = false; choices.querySelectorAll('button').forEach(button => button.classList.toggle('oa-selected', button === card));
          warning.textContent = disconnect ? key === 'local' ? '기존 로컬 자료를 그대로 사용합니다. Firebase 원본도 유지합니다.' : '기존 로컬의 모든 자료를 삭제하고 Firebase 자료로 교체합니다. Firebase 원본은 유지합니다.' : key === 'local' ? 'Firebase의 모든 자료를 삭제하고 로컬 자료로 덮어씁니다.' : '로컬의 모든 자료를 삭제하고 Firebase 자료로 덮어씁니다.';
        }, null, 'oa-source'); card.replaceChildren(node('strong', '', title), node('span', '', `카테고리 ${data.categories.length} · OOC ${total(data)}`)); choices.append(card);
      }
      function finish(answer) { view.close(); resolve(answer); }
      view.body.append(choices, warning); view.footer.append(action('취소', () => finish(null)), apply); view.root.addEventListener('cancel', () => finish(null));
    });
  }
  function showGuide(connection) {
    const view = dialog('Firebase 연동 가이드', 'guide');
    const sections = [
      ['1. 내 프로젝트 만들기', ['Firebase 콘솔에서 프로젝트를 만드세요. OOC 보관함 전용 프로젝트를 권장합니다.', '프로젝트 설정 → 일반 → 내 앱 → 웹 앱(</>) 등록. 앱 이름을 정하고 등록하세요. Hosting 설정은 필요 없습니다.', '웹 앱의 SDK 설정에서 구성(Config)을 선택하고 firebaseConfig의 중괄호 안 내용을 중괄호까지 복사하세요.']],
      ['2. 데이터베이스 만들기', ['콘솔 → 빌드(Build) → Realtime Database → 데이터베이스 만들기. Firestore가 아닙니다.', '위치를 선택하고 잠금 모드로 시작하세요. 테스트 모드는 데이터를 공개할 수 있으므로 사용하지 마세요.', '데이터 탭 상단의 https://…firebaseio.com 또는 https://…firebasedatabase.app 주소를 복사하세요.', 'config에 databaseURL이 없다면 아래 형식으로 추가하고 값은 본인 DB 주소로 바꾸세요.']],
      ['3. 로그인 사용자 등록하기', ['콘솔 → Authentication → 시작하기 → 로그인 방법(Sign-in method).', '이메일/비밀번호(Email/Password)를 활성화하고 저장하세요. 이메일 링크 로그인은 켜지 않아도 됩니다.', '사용자(Users) 탭 → 사용자 추가(Add user) → 사용할 이메일과 비밀번호 입력 → 등록.', '메일 계정은 실제로 존재하거나 사용하는 이메일이 아니어도 됩니다. 다른 서비스와 겹치지 않는 임의의 이메일과 비밀번호를 권장합니다.']],
      ['4. 보관함에서 로그인하기', ['가이드를 닫고 DB 연동 → Firebase → config 붙여넣기.', '등록한 이메일과 비밀번호를 입력하고 로그인을 누르세요.', '로그인됨 표시를 확인한 뒤 이 가이드를 다시 열어 아래 보안 규칙을 복사하세요.']],
      ['5. DB 접근 보안 규칙 게시하기', ['로그인한 뒤 아래 본인 UID 전용 규칙을 복사하세요.', '전용 DB라면 Realtime Database → 규칙(Rules)에서 아래 규칙으로 교체하고 게시(Publish)하세요. 기존 프로그램과 공유하는 DB라면 기존 규칙을 백업하고 rules 아래에 oocLibrary 부분만 추가하세요. 상위 경로의 공개 읽기/쓰기 규칙은 하위 규칙보다 우선하므로 그대로 두면 보호되지 않습니다.']],
      ['6. 연결 확인 · 다른 기기에서 사용하기', ['가이드를 닫고 연동 적용을 누르세요. 양쪽에 자료가 있으면 사용할 쪽과 삭제될 쪽을 확인하세요. 중요한 자료는 먼저 설정의 전체 백업으로 보관하세요.', '다른 기기에서도 같은 config와 프로젝트에 등록한 이메일/비밀번호로 연결하세요.']]
    ];
    sections.forEach(([title, steps], index) => {
      const section = node('details', 'oa-guide-section'); section.open = index === 0 || (index === 4 && !!connection?.auth?.uid); section.append(node('summary', '', title));
      const list = node('ol'); steps.forEach(text => list.append(node('li', '', text))); section.append(list);
      if (index === 1) section.append(node('pre', '', 'databaseURL: "복사한 데이터베이스 주소",'));
      if (index === 3) section.append(node('p', 'oa-message', '브라우저 데이터 삭제·비공개 모드·저장 차단 시에는 다시 로그인해야 합니다. 공용 기기에서는 사용하지 않는 것을 권장합니다.'));
      if (index === 4) {
        if (connection?.auth?.uid) {
          const rule = `auth != null && auth.uid === ${JSON.stringify(connection.auth.uid)}`;
          const text = field(section, '보안 규칙', 'textarea', JSON.stringify({ rules: { oocLibrary: { '.read': rule, '.write': rule } } }, null, 2)); text.rows = 8; text.readOnly = true;
          section.append(action('규칙 복사', async () => { await navigator.clipboard.writeText(text.value); }, 'copy'));
          section.append(node('p', 'oa-message', '자료는 /oocLibrary에 공통으로 저장하며, 접근은 위 UID의 사용자만 허용합니다. 개인 전용 프로젝트를 사용하세요.'));
        } else {
          section.append(node('p', 'oa-message', 'DB 연동에서 먼저 로그인하면 본인 UID 전용 보안 규칙이 표시됩니다.'));
        }
      }
      view.body.append(section);
    }); view.header.append(action('닫기', view.close, 'close')); view.footer.hidden = true; closeWithEscape(view);
  }

  function bookmark() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return;
    const range = selection.getRangeAt(0), editor = (range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement)?.closest('.__chat_input_textarea[contenteditable="true"]');
    if (editor) selectedInput = { editor, range: range.cloneRange() };
  }
  document.addEventListener('selectionchange', bookmark);
  function slashRange(saved) {
    const { editor, range } = saved;
    if (!editor.isConnected || !range.collapsed || !editor.contains(range.startContainer)) throw Error('입력창의 / 바로 뒤에 커서를 놓으세요.');
    // 커서 앞의 실제 텍스트 노드를 찾는다. 편집기 내부 상태/전용 API 접근 없음.
    const before = document.createRange(); before.selectNodeContents(editor); before.setEnd(range.startContainer, range.startOffset);
    if (!before.toString().endsWith('/')) throw Error('커서 바로 앞에 /가 있어야 합니다.');
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT); let previous = null;
    while (walker.nextNode()) {
      const text = walker.currentNode;
      const point = range.comparePoint(text, text.length);
      if (point <= 0 && text.length) previous = { node: text, offset: text.length };
      if (text === range.startContainer) { if (range.startOffset) previous = { node: text, offset: range.startOffset }; break; }
      if (point > 0) break;
    }
    if (!previous || previous.node.data[previous.offset - 1] !== '/') throw Error('커서 위치를 확인하세요.');
    const replacement = document.createRange(); replacement.setStart(previous.node, previous.offset - 1); replacement.setEnd(previous.node, previous.offset); return replacement;
  }
  function useOoc(content) {
    if (!selectedInput) throw Error('입력창에 /를 입력하세요.');
    const replacement = slashRange(selectedInput), editor = selectedInput.editor; editor.focus();
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(replacement);
    // 브라우저 편집 명령은 input 이벤트를 발생시켜 Crack의 편집 상태도 갱신한다.
    // Enter/전송 버튼/Crack API는 호출하지 않는다.
    if (!document.execCommand('insertText', false, content.replace(/\r\n?/g, '\n'))) throw Error('텍스트 입력에 실패했습니다.');
    bookmark();
  }
  function drawPanel(panel) {
    panel.body.replaceChildren(); if (!library) return;
    const ooc = item => { const button = action(item.name, () => useOoc(item.content), null, 'oa-use'); button.addEventListener('pointerdown', event => event.preventDefault()); return button; };
    library.categories.forEach(folder => {
      const { name, items: entries } = folder, section = node('details', 'oa-list-folder'), summary = node('summary');
      summary.innerHTML = svg('chevron') + svg('folder'); summary.append(node('span', '', name)); section.append(summary); entries.forEach(item => section.append(ooc(item))); panel.body.append(section);
    }); library.extras.forEach(item => panel.body.append(ooc(item)));
  }
  function drawPanels() { attached.forEach(panel => { if (panel.active) drawPanel(panel); }); }
  function panelMode(panel, enabled) {
    panel.active = enabled; panel.body.hidden = !enabled; panel.native.forEach(element => { element.classList.toggle('oa-native-hidden', enabled); }); panel.button.classList.toggle('oa-tab-active', enabled); panel.button.setAttribute('aria-pressed', String(enabled));
  }
  function discover() {
    for (const [root, panel] of attached) if (!root.isConnected || !panel.button.isConnected) {
      panelMode(panel, false); panel.body.remove(); panel.button.remove(); panel.config.remove(); attached.delete(root);
    }
    document.querySelectorAll('[role="tablist"]').forEach(tabs => {
      const hub = Array.from(tabs.querySelectorAll('[role="tab"]')).find(tab => tab.textContent.trim() === '단축어 허브'); if (!hub) return;
      const root = tabs.parentElement.parentElement; if (attached.has(root)) return;
      const native = Array.from(root.children).slice(1); if (!native.some(element => element.querySelector('ul'))) return;
      const panel = { native, body: node('div', 'oa-panel-body'), active: false }; panel.body.hidden = true; panel.body.setAttribute('aria-label', 'OOC 목록');
      panel.button = action('OOC 보관함', async () => {
        bookmark(); await readLibrary(); panelMode(panel, true); drawPanel(panel);
      }, null, 'oa-tab'); panel.button.addEventListener('pointerdown', event => { bookmark(); event.preventDefault(); });
      panel.config = action('OOC 설정', showManager, 'gear', 'oa-panel-config'); panel.config.addEventListener('pointerdown', event => { bookmark(); event.preventDefault(); });
      tabs.append(panel.button, panel.config); tabs.classList.add('oa-tabs'); root.append(panel.body); attached.set(root, panel);
      tabs.addEventListener('click', event => { if (event.target.closest('[role="tab"]')) panelMode(panel, false); });
    });
  }
  // OOC 항목의 포커스를 보존하며 기본 단축어의 Enter 선택만 막는다.
  document.addEventListener('keydown', event => {
    const panel = Array.from(attached.values()).find(panel => panel.active && panel.body.isConnected);
    if (!panel || event.isComposing || !event.target.closest?.('.__chat_input_textarea') || !['Enter', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.key !== 'Enter') panel.body.querySelector('summary,button')?.focus();
  }, true);

  void readLibrary().catch(error => console.warn('[Crack OOC 보관함] 자동주입 자료를 미리 읽지 못했습니다.', error));

  function startUi() {
  const styles = node('style'); styles.textContent = `
    .oa-dialog{--oa-bg:hsl(var(--card,0 0% 9%));--oa-fg:hsl(var(--foreground,0 0% 98%));--oa-muted:hsl(var(--muted-foreground,0 0% 58%));--oa-line:hsl(var(--border,0 0% 22%));--oa-accent:#a5a0f5;color:var(--oa-fg);background:var(--oa-bg);border:1px solid var(--oa-line);border-radius:16px;padding:0;width:min(520px,calc(100vw - 32px));max-height:86vh;box-shadow:0 24px 80px #0007;font:14px/1.5 system-ui}
    .oa-dialog [hidden]{display:none!important}.oa-dialog::backdrop{background:#0007}.oa-dialog.oa-large{width:min(680px,calc(100vw - 32px))}.oa-dialog.oa-guide{width:min(620px,calc(100vw - 32px))}.oa-header{display:flex;align-items:center;gap:8px;height:64px;padding:0 20px;border-bottom:1px solid var(--oa-line)}.oa-header strong{font-size:16px;font-weight:650}.oa-header>.oa-icon{margin-left:auto}.oa-actions{display:flex;gap:4px;margin-left:auto}.oa-dot{width:7px;height:7px;background:#f06b73;border-radius:50%}.oa-body{padding:20px;overflow:auto;max-height:calc(86vh - 142px)}.oa-large .oa-body{min-height:260px;max-height:calc(86vh - 66px)}.oa-footer{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid var(--oa-line)}
    .oa-dialog button{font:inherit;cursor:pointer}.oa-icon{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:6px;border:0;border-radius:6px;background:transparent;color:var(--oa-muted,currentColor);flex-shrink:0}.oa-icon svg, .oa-symbol svg,.oa-search svg,.oa-toggle svg,.oa-list-folder svg{width:20px;height:20px;display:block;flex-shrink:0}.oa-icon:hover,.oa-toggle:hover{background:#8882;color:var(--oa-fg,inherit)}.oa-dialog button:disabled{opacity:.35;cursor:default}.oa-dialog button:focus-visible,.oa-dialog summary:focus-visible{outline:2px solid var(--oa-accent);outline-offset:2px}.oa-button{border:1px solid var(--oa-line);background:transparent;color:inherit;border-radius:8px;padding:7px 14px}.oa-primary{background:var(--oa-accent);color:#171724;border-color:transparent}.oa-toolbar{display:flex;align-items:center;gap:6px;margin-bottom:14px}.oa-search{display:flex;align-items:center;gap:8px;flex:1;border:1px solid var(--oa-line);border-radius:8px;padding:0 10px;color:var(--oa-muted)}
    .oa-dialog input,.oa-dialog textarea,.oa-dialog select{color:inherit;background:transparent;border:1px solid var(--oa-line);border-radius:8px;padding:9px 10px;font:inherit;width:100%;box-sizing:border-box;min-width:0}.oa-search input{border:0;outline:none;padding:9px 0}.oa-field{display:flex;flex-direction:column;gap:7px;margin-bottom:16px}.oa-field>span{font-size:13px;color:var(--oa-muted)}.oa-dialog textarea{resize:vertical;white-space:pre-wrap}.oa-dialog select option{color:#eee;background:#222}.oa-toggle-field{display:grid;grid-template-columns:auto 1fr;gap:4px 9px;align-items:center;margin:0 0 16px}.oa-toggle-field input{width:18px;height:18px}.oa-toggle-field small{grid-column:2;color:var(--oa-muted);line-height:1.45}.oa-hint{margin:-8px 0 14px;color:var(--oa-muted);font-size:12px;line-height:1.5}.oa-auto-editor,.oa-settings-section{border-top:1px solid var(--oa-line);padding-top:16px;margin-top:4px}.oa-settings-section{border:1px solid var(--oa-line);border-radius:10px;padding:14px;margin-bottom:22px}.oa-preview{margin-top:12px;padding:10px;border-radius:8px;background:#8881}.oa-preview strong{display:block;margin-bottom:6px}.oa-preview-list{white-space:pre-wrap}.oa-preview-list small{display:block;color:var(--oa-muted);margin-top:6px}.oa-muted{color:var(--oa-muted)}.oa-diagnostics{margin-top:12px}.oa-diagnostics summary{cursor:pointer;color:var(--oa-muted);font-size:12px}.oa-diagnostics pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#8881;border-radius:6px;padding:10px;margin:8px 0 0;font-size:11px;max-height:240px;overflow:auto}
    .oa-group{margin:8px 0;border:1px solid var(--oa-line);border-radius:10px;overflow:visible}.oa-group>.oa-row{background:#8881;border-radius:9px}.oa-row{position:relative;display:flex;align-items:center;gap:9px;min-height:44px;padding:4px 8px;box-sizing:border-box}.oa-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.oa-group>.oa-row>.oa-name{font-weight:600;cursor:pointer}.oa-symbol{color:var(--oa-muted);flex-shrink:0}.oa-group>.oa-row>.oa-symbol{color:#c4b391}.oa-count{color:var(--oa-muted);font-size:12px}.oa-auto-badge{font-size:11px;color:#b9b5ff;border:1px solid #a5a0f555;border-radius:999px;padding:1px 6px}.oa-row-actions{display:flex;gap:2px}.oa-row-actions .oa-icon{width:28px;height:28px;padding:5px}.oa-row-actions .oa-icon[data-sort]{cursor:grab;touch-action:none}.oa-toggle{width:20px;height:28px;border:0;padding:0;background:transparent;color:var(--oa-muted);flex-shrink:0}.oa-toggle svg{width:16px;height:16px;transition:transform .15s}.oa-open .oa-toggle svg{transform:rotate(90deg)}.oa-children{margin:0 12px 10px 30px;padding-left:8px;border-left:2px solid var(--oa-line)}.oa-children .oa-row+.oa-row{border-top:1px solid #8882}.oa-extras{margin-top:14px}.oa-extras>.oa-row{border-bottom:1px solid #8882}.oa-empty{height:28px}.oa-before::before,.oa-after::after{content:'';position:absolute;left:0;right:0;height:3px;background:var(--oa-accent);border-radius:3px;z-index:2;pointer-events:none}.oa-before::before{top:0}.oa-after::after{bottom:0}.oa-children,.oa-extras{position:relative}.oa-dragging{opacity:.3}.oa-ghost{position:fixed;pointer-events:none;z-index:3;background:var(--oa-bg);border:1px solid var(--oa-line);border-radius:8px;box-shadow:0 8px 24px #0006;opacity:.95}
    .oa-message{white-space:pre-line;margin:0 0 14px;line-height:1.7}.oa-warning{color:#ed969e;background:#eb6b7410;border:1px solid #eb6b7440;border-radius:8px;padding:12px}.oa-source-options{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0}.oa-source{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:14px}.oa-source span{font-size:12px;color:var(--oa-muted)}.oa-source.oa-selected{border-color:var(--oa-accent);background:#a5a0f512}.oa-backup{display:flex;gap:8px}.oa-body h3{margin:0 0 14px;font-size:14px}.oa-db-top{display:flex;align-items:center;gap:8px;margin-bottom:16px}.oa-segment{display:flex;padding:3px;border-radius:9px;background:#8882;flex:1}.oa-segment label{flex:1;text-align:center;cursor:pointer}.oa-segment input{position:absolute;opacity:0;width:1px;height:1px}.oa-segment span{display:block;border-radius:6px;padding:7px 12px;color:var(--oa-muted)}.oa-segment input:checked+span{color:var(--oa-fg);background:var(--oa-bg);box-shadow:0 1px 4px #0003}.oa-segment input:focus-visible+span{outline:2px solid var(--oa-accent)}.oa-credentials{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) auto;gap:8px;align-items:center}.oa-credentials .oa-button{padding:9px 12px}.oa-auth-state{font-size:12px;color:var(--oa-muted);min-height:18px;margin:10px 0 0}.oa-guide-section{border-bottom:1px solid var(--oa-line);padding:12px 0}.oa-guide-section:first-child{padding-top:0}.oa-guide-section summary{cursor:pointer;font-weight:600}.oa-guide-section ol{padding-left:23px}.oa-guide-section li{margin:8px 0;line-height:1.7}.oa-guide-section pre{white-space:pre-wrap;background:#8881;border-radius:6px;padding:10px;font-size:12px}.oa-guide-section small{color:var(--oa-muted);overflow-wrap:anywhere}
    .oa-native-hidden{display:none!important}.oa-tabs{overflow-x:auto!important;overflow-y:hidden!important;flex-wrap:nowrap!important}.oa-tab{background:transparent;border:0;border-bottom:2px solid transparent;padding:0 8px 8px;margin-bottom:-1px;flex-shrink:0;font-size:14px;color:inherit;white-space:nowrap;border-radius:0}.oa-tab-active{border-bottom-color:currentColor;font-weight:600}.oa-panel-config{width:28px;height:28px;margin-bottom:6px}.oa-panel-body{min-height:0;flex:1;overflow:auto;padding:8px 16px;font-size:14px}.oa-panel-body[hidden]{display:none}.oa-use{display:block;border:0;background:transparent;color:inherit;padding:8px;width:100%;text-align:left;border-radius:6px;font-size:14px}.oa-use:hover{background:#8882}.oa-list-folder summary{display:flex;align-items:center;gap:8px;padding:8px 0;cursor:pointer;font-weight:600;list-style:none}.oa-list-folder summary::-webkit-details-marker{display:none}.oa-list-folder summary svg:first-child{width:14px;height:14px}.oa-list-folder[open] summary svg:first-child{transform:rotate(90deg)}.oa-list-folder>.oa-use{margin-left:20px;width:calc(100% - 20px);padding-left:12px;border-left:2px solid #8884;border-radius:0}
    @media(max-width:480px){.oa-header{padding:0 12px}.oa-body{padding:14px}.oa-row-actions{gap:0}.oa-children{margin-left:22px}.oa-credentials{gap:5px}.oa-credentials input{padding:8px 6px}.oa-credentials .oa-button{padding:8px}.oa-source-options{gap:6px}.oa-source{padding:10px}}
  `; document.head.append(styles);
  let queued = false;
  const observer = new MutationObserver(() => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; discover(); }); });
  observer.observe(document.body, { childList: true, subtree: true }); discover(); bookmark();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startUi, { once: true });
  else startUi();
})();
