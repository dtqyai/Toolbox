// Classic deferred scripts keep the website build-free; CommonJS supports
// the same modules in Node's unit/runtime tests.
const {
  PRICE_STORAGE_KEY, parseNonNegativeFiniteNumber, parsePositiveFiniteNumber, parsePositiveInteger,
  cloneGroups, decodeStoredGroups, calcUnitPrice, findCheapestInGroup, hasEditConflict,
  findStoredItem, hasGroupSnapshotConflict, readPriceGroups, writePriceGroups,
} = typeof module !== 'undefined' && module.exports
  ? require('./data.js') : ToolboxData;
const priceView = typeof module !== 'undefined' && module.exports
  ? require('./price-view.js') : PriceView;

/* ===== TAB NAVIGATION ===== */
const TAB_IDS = ['energy', 'counter', 'price', 'timer'];
const ACTIVE_TAB_KEY = 'toolbox_active_tab';

// Modified keys belong to the browser and OS (Cmd/Ctrl+R reload, Ctrl+'+'
// zoom): claiming them would break those shortcuts and silently reset or
// advance the counter.
function shouldHandleCounterShortcut(counterActive, isTextEntry, isTabControl, hasModifier) {
  return counterActive && !isTextEntry && !isTabControl && !hasModifier;
}

// Roving tabindex: only the active tab is in the tab order (tabindex="0"),
// the rest are tabindex="-1" but still reachable via arrow keys.
function setActiveTab(tabId) {
  if (!TAB_IDS.includes(tabId)) tabId = 'energy';
  document.querySelectorAll('.tool-page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.setAttribute('aria-selected', 'false');
    b.setAttribute('tabindex', '-1');
  });
  const page = document.getElementById('page-' + tabId);
  if (page) page.classList.add('active');
  const tab = document.getElementById('tab-' + tabId);
  if (tab) {
    tab.setAttribute('aria-selected', 'true');
    tab.setAttribute('tabindex', '0');
  }
}

function switchTab(tabId) {
  if (!TAB_IDS.includes(tabId)) return;
  setActiveTab(tabId);
  const tab = document.getElementById('tab-' + tabId);
  if (tab) tab.focus({ preventScroll: true });
  try { localStorage.setItem(ACTIVE_TAB_KEY, tabId); } catch (e) {}
  if (location.hash !== '#' + tabId) {
    history.replaceState(null, '', '#' + tabId);
  }
}

function restoreTab() {
  const hash = location.hash.replace('#', '');
  if (TAB_IDS.includes(hash)) return hash;
  try {
    const saved = localStorage.getItem(ACTIVE_TAB_KEY);
    if (saved && TAB_IDS.includes(saved)) return saved;
  } catch (e) {}
  return 'energy';
}

// WAI-ARIA tablist keyboard interaction: arrow keys move between tabs,
// Home/End jump to the first/last tab. Click is delegated so no inline
// onclick handlers are needed on the buttons.
function initTabKeyboard() {
  const tablist = document.getElementById('main-tablist');
  if (!tablist) return;
  tablist.addEventListener('click', function(e) {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    switchTab(btn.id.replace('tab-', ''));
  });
  tablist.addEventListener('keydown', function(e) {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    // Modified arrow keys belong to the browser/OS (e.g. Cmd+Left history
    // navigation); only plain keys drive tab navigation.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const currentIdx = TAB_IDS.indexOf(btn.id.replace('tab-', ''));
    if (currentIdx === -1) return;
    let nextIdx = null;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIdx = (currentIdx + 1) % TAB_IDS.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIdx = (currentIdx - 1 + TAB_IDS.length) % TAB_IDS.length;
        break;
      case 'Home':
        nextIdx = 0;
        break;
      case 'End':
        nextIdx = TAB_IDS.length - 1;
        break;
    }
    if (nextIdx !== null) {
      e.preventDefault();
      // The counter also has document-level arrow shortcuts. Stop this tab
      // navigation event before the newly activated counter can consume it.
      e.stopPropagation();
      switchTab(TAB_IDS[nextIdx]);
    }
  });
}

/* ===== ENERGY CONVERTER ===== */
// Integer output is deliberate: food labels quote whole numbers, so a
// whole-number result reads cleaner (100 kJ → 24 kcal, not 23.92). This is
// also why the inputs keep inputmode="numeric" (no decimal point) — do not
// "fix" either to decimals.
function convertKjToKcal(kj) { return kj / 4.184; }
function convertKcalToKj(kcal) { return kcal * 4.184; }

function initEnergyConverter() {
  const inputKj = document.getElementById('input-kj');
  const inputKcal = document.getElementById('input-kcal');

  function bind(source, target, convert) {
    source.addEventListener('input', function() {
      const raw = this.value.trim();
      setInputError(target, '');
      if (raw === '') {
        setInputError(this, '');
        target.value = '';
        return;
      }
      const val = parseNonNegativeFiniteNumber(raw);
      if (val === null) {
        setInputError(this, '请输入大于或等于 0 的数字。');
        target.value = '';
        return;
      }
      setInputError(this, '');
      const result = convert(val);
      if (!Number.isFinite(result)) {
        setInputError(this, '数值过大，请缩小后重试。');
        target.value = '';
        return;
      }
      target.value = Math.round(result);
    });
  }

  bind(inputKj, inputKcal, convertKjToKcal);
  bind(inputKcal, inputKj, convertKcalToKj);
}

/* ===== COUNTER ===== */
// A long-press auto-repeat feature (hold +/− to count fast) existed briefly
// and was deliberately removed in favour of plain taps and keyboard
// shortcuts. Do not re-add it.
const COUNTER_KEY = 'toolbox_counter';
let counterState = { value: 0 };

function renderCounterValue(value) {
  const display = document.getElementById('counter-value');
  display.textContent = value;
  display.classList?.toggle('counter-long', String(value).length > 8);
}

function loadCounter() {
  try {
    const storedValue = Number(localStorage.getItem(COUNTER_KEY));
    counterState.value = Number.isSafeInteger(storedValue) ? storedValue : 0;
  } catch (e) {}
  renderCounterValue(counterState.value);
}

function showCounterStatus(message) {
  const status = document.getElementById('counter-storage-status');
  if (status) { status.textContent = message; status.hidden = !message; }
}

async function changeCounter(nextValue) {
  const task = () => {
    try {
      // Read inside the lock: another tab may have changed the stored count.
      const stored = Number(localStorage.getItem(COUNTER_KEY));
      const current = Number.isSafeInteger(stored) ? stored : 0;
      const value = nextValue(current);
      if (!Number.isSafeInteger(value)) {
        showCounterStatus('已达到计数范围上限。');
        return false;
      }
      localStorage.setItem(COUNTER_KEY, String(value));
      counterState.value = value;
      renderCounterValue(value);
      showCounterStatus('');
      return true;
    } catch (e) {
      showCounterStatus('无法保存到浏览器，本次计数未保留。');
      return false;
    }
  };
  try {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
    if (locks && typeof locks.request === 'function') {
      return await locks.request('toolbox-counter-write', task);
    }
    // Reuse the toolbox presence guard on browsers without Web Locks.
    await new Promise(resolve => setTimeout(resolve, 100));
    if (hasAnotherPriceTab()) {
      showCounterStatus('当前浏览器不支持跨标签写入锁；请关闭其他工具箱标签页后重试。');
      return false;
    }
    return task();
  } catch (e) {
    showCounterStatus('无法取得写入锁，请重试。');
    return false;
  }
}

function updateCounter(delta) {
  return changeCounter(value => value + delta);
}

function resetCounter() {
  return changeCounter(() => 0);
}

function initCounter() {
  loadCounter();
  window.addEventListener('storage', e => {
    if (e.key === COUNTER_KEY || e.key === null) loadCounter();
  });
  document.getElementById('btn-plus').addEventListener('click', () => updateCounter(1));
  document.getElementById('btn-minus').addEventListener('click', () => updateCounter(-1));
  document.getElementById('btn-reset').addEventListener('click', resetCounter);

  document.addEventListener('keydown', function(e) {
    const counterPage = document.getElementById('page-counter');
    const counterActive = !!counterPage && counterPage.classList.contains('active');
    const isTextEntry = !!e.target.closest('input, textarea, select, [contenteditable="true"]');
    const isTabControl = !!e.target.closest('[role="tab"], [role="tablist"]');
    const hasModifier = e.metaKey || e.ctrlKey || e.altKey;
    if (!shouldHandleCounterShortcut(counterActive, isTextEntry, isTabControl, hasModifier)) return;
    // A focused button only claims Space (it would activate the button *and*
    // run the shortcut); arrows and R stay live so clicking +/- with the mouse
    // doesn't kill keyboard control.
    const onButton = !!e.target.closest('button');
    switch (e.key) {
      case '+':
      case 'ArrowUp':
        e.preventDefault();
        updateCounter(1);
        break;
      case '-':
      case 'ArrowDown':
        e.preventDefault();
        updateCounter(-1);
        break;
      case ' ':
        if (onButton) return;
        e.preventDefault();
        updateCounter(1);
        break;
      case 'r':
      case 'R':
        e.preventDefault();
        resetCounter();
        break;
    }
  });
}

/* ===== PRICE CALCULATOR ===== */
// Storage is localStorage-only by design: no import/export or remote backup.
// Every read is decoded at the boundary, and revisions prevent a stale tab
// from silently replacing a newer snapshot.
const PRICE_STORAGE_LOCK = 'toolbox-price-groups-write';
const PRICE_PRESENCE_PREFIX = 'toolbox_price_tab_';
const PRICE_PRESENCE_TTL_MS = 5000;
let groups = []; // [{ id, name, items: [...] }]
let editingId = null;
let editingGroupId = null;
let editingBaseItem = null;
let groupsRevision = 0;
let persistedGroupsSnapshot = [];
let priceStatusTimer = null;
let priceTabId = null;
let pricePresenceKey = null;
let pricePresenceTimer = null;
// Form nodes are replaced by synchronization renders; submissions belong to
// the group/item, and every replacement must inherit their pending state.
const pendingPriceForms = new Map();

function showPriceStatus(message) {
  const status = document.getElementById('price-storage-status');
  if (!status) return;
  clearTimeout(priceStatusTimer);
  status.textContent = message;
  status.hidden = !message;
  if (message) {
    priceStatusTimer = setTimeout(() => {
      status.hidden = true;
      status.textContent = '';
    }, 6000);
  }
}

function readStoredGroups() {
  try {
    return { ...readPriceGroups(localStorage), storageError: false };
  } catch (e) {
    return {
      groups: cloneGroups(persistedGroupsSnapshot),
      revision: groupsRevision,
      hadInvalidData: false,
      storageError: true,
    };
  }
}

function applyStoredGroups(state) {
  // Every path adopting a persisted snapshot must reconcile the active edit,
  // including saves/deletes that read it before its storage event arrives.
  synchronizeEdit(state);
  groups = cloneGroups(state.groups);
  groupsRevision = state.revision;
  persistedGroupsSnapshot = cloneGroups(state.groups);
}

function storedGroupsChanged(state) {
  // Clearing storage restarts the revision sequence. Compare against the
  // last persisted contents, not `groups`, which may contain a pending write.
  return state.revision !== groupsRevision ||
    JSON.stringify(state.groups) !== JSON.stringify(persistedGroupsSnapshot);
}

function runWithPriceStorageLock(lockManager, task, fallback) {
  if (lockManager && typeof lockManager.request === 'function') {
    return lockManager.request(PRICE_STORAGE_LOCK, task);
  }
  return fallback ? fallback(task) : Promise.resolve().then(task);
}

// Presence heartbeat for the no-Web-Locks fallback: it is the only signal
// other fallback tabs use to detect this tab, so it only runs where
// navigator.locks is missing (everywhere else it would be pure localStorage
// churn every 2 seconds).
function initPricePresence() {
  if (!pricePresenceKey) {
    priceTabId = uid();
    pricePresenceKey = PRICE_PRESENCE_PREFIX + priceTabId;
  }
  clearInterval(pricePresenceTimer);
  try { localStorage.setItem(pricePresenceKey, String(Date.now())); } catch (e) {}
  pricePresenceTimer = setInterval(() => {
    try { localStorage.setItem(pricePresenceKey, String(Date.now())); } catch (e) {}
  }, 2000);
}

function stopPriceHeartbeat() {
  clearInterval(pricePresenceTimer);
  pricePresenceTimer = null;
  if (pricePresenceKey) {
    try { localStorage.removeItem(pricePresenceKey); } catch (e) {}
  }
}

function hasFreshPricePresence(entries, ownKey, now) {
  return entries.some(([key, value]) => {
    if (!key.startsWith(PRICE_PRESENCE_PREFIX) || key === ownKey) return false;
    const timestamp = Number(value);
    const age = now - timestamp;
    return Number.isFinite(timestamp) && age >= 0 && age < PRICE_PRESENCE_TTL_MS;
  });
}

function hasAnotherPriceTab() {
  initPricePresence();
  try {
    const now = Date.now();
    localStorage.setItem(pricePresenceKey, String(now));
    const entries = [];
    const invalidPresenceKeys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      const value = localStorage.getItem(key);
      entries.push([key, value]);
      if (key.startsWith(PRICE_PRESENCE_PREFIX) && key !== pricePresenceKey) {
        const timestamp = Number(value);
        const age = now - timestamp;
        if (!Number.isFinite(timestamp) || age < 0 || age >= PRICE_PRESENCE_TTL_MS) {
          invalidPresenceKeys.push(key);
        }
      }
    }
    invalidPresenceKeys.forEach(key => localStorage.removeItem(key));
    return hasFreshPricePresence(entries, pricePresenceKey, now);
  } catch (e) {
    return false;
  }
}

async function runFallbackPriceWrite(task) {
  // Give a simultaneously opened tab time to publish its distinct presence key.
  await new Promise(resolve => setTimeout(resolve, 100));
  if (hasAnotherPriceTab()) {
    showPriceStatus('当前浏览器不支持跨标签写入锁；请关闭其他工具箱标签页后重试。');
    return false;
  }
  return task();
}

function withPriceStorageLock(task) {
  const lockManager = typeof navigator !== 'undefined' ? navigator.locks : null;
  return runWithPriceStorageLock(lockManager, task, runFallbackPriceWrite);
}

function synchronizeEdit(state) {
  if (editingId !== null && hasEditConflict(editingBaseItem, findStoredItem(state, editingGroupId, editingId))) {
    editingId = null;
    editingGroupId = null;
    editingBaseItem = null;
  }
}

function priceFormKey(form) {
  if (form.dataset?.groupId) {
    return form.dataset.groupId + ':' + (form.dataset.itemId ? 'edit:' + form.dataset.itemId : 'add');
  }
  return form.id || form;
}

function restorePendingPriceForm(form) {
  const pending = pendingPriceForms.get(priceFormKey(form));
  if (!pending) return;
  pending.forms.add(form);
  for (const button of form.querySelectorAll('button[type="submit"], input[type="submit"]')) {
    if (!pending.buttons.has(button)) pending.buttons.set(button, button.disabled);
    button.disabled = true;
  }
  form.setAttribute('aria-busy', 'true');
}

async function runFormSubmissionOnce(form, task) {
  const key = priceFormKey(form);
  if (pendingPriceForms.has(key)) return false;
  const pending = { forms: new Set(), buttons: new Map() };
  pendingPriceForms.set(key, pending);
  restorePendingPriceForm(form);
  try {
    return await task();
  } finally {
    pendingPriceForms.delete(key);
    for (const [button, disabled] of pending.buttons) button.disabled = disabled;
    for (const currentForm of pending.forms) currentForm.removeAttribute('aria-busy');
  }
}

function itemFormSnapshot(form) {
  return JSON.stringify(['name', 'unitWeight', 'packSize', 'packCount', 'totalPrice']
    .map(field => form.querySelector('[data-field="' + field + '"]').value));
}

async function mutateGroups(mutator) {
  return withPriceStorageLock(async () => {
    const latest = readStoredGroups();
    if (!latest.storageError && storedGroupsChanged(latest)) {
      applyStoredGroups(latest);
      renderPriceList();
      showPriceStatus('已同步其他标签页的修改。');
    }
    if (mutator() === false) return false;
    return saveGroups();
  });
}

function setInputError(el, message) {
  if (!el) return;
  el.classList.toggle('error', !!message);
  el.setAttribute('aria-invalid', message ? 'true' : 'false');
  let errorId = el.dataset.errorId;
  if (!errorId && !message) return;
  if (!errorId) {
    errorId = 'field-error-' + uid();
    el.dataset.errorId = errorId;
    const error = document.createElement('span');
    error.id = errorId;
    error.className = 'field-error';
    error.setAttribute('aria-live', 'polite');
    el.insertAdjacentElement('afterend', error);
    el.setAttribute('aria-describedby', [el.getAttribute('aria-describedby'), errorId].filter(Boolean).join(' '));
  }
  const error = document.getElementById(errorId);
  if (error) { error.textContent = message; error.hidden = !message; }
}

function flagInputError(el) {
  setInputError(el, '请输入组名称。');
  el?.focus();
}

function saveGroups() {
  const latest = readStoredGroups();
  if (!latest.storageError && storedGroupsChanged(latest)) {
    applyStoredGroups(latest);
    renderPriceList();
    showPriceStatus('检测到其他标签页的新修改，已保留最新数据；请重试刚才的操作。');
    return false;
  }

  const nextRevision = groupsRevision + 1;
  try {
    writePriceGroups(localStorage, nextRevision, groups);
    groupsRevision = nextRevision;
    persistedGroupsSnapshot = cloneGroups(groups);
    return true;
  } catch (e) {
    groups = cloneGroups(persistedGroupsSnapshot);
    renderPriceList();
    showPriceStatus('无法保存到浏览器，本次修改未保留。');
    return false;
  }
}

function loadGroups() {
  const stored = readStoredGroups();
  applyStoredGroups(stored);
  if (stored.storageError) showPriceStatus('浏览器存储不可用，本页修改可能无法保留。');
  else if (stored.hadInvalidData) showPriceStatus('部分本地数据格式无效，已安全忽略。');
}

// crypto.randomUUID() is restricted to secure contexts, so it's missing when
// the page is served over plain HTTP on a LAN address (phone → dev server).
// getRandomValues() has no such restriction, so build a v4 UUID from it.
function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 10
    const hex = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) +
           '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

async function addGroup(name) {
  const saved = await mutateGroups(() => {
    groups.push({ id: uid(), name, items: [] });
  });
  if (saved) renderPriceList();
  return saved;
}

async function deleteGroup(groupId) {
  const group = groups.find(g => g.id === groupId);
  if (!group) { renderPriceList(); return; }
  const confirmedSnapshot = cloneGroups([group])[0];
  const itemCount = group.items.length;
  const detail = itemCount > 0 ? `（含 ${itemCount} 件商品）` : '';
  if (!confirm(`确定要删除对比组「${group.name || '未命名组'}」${detail}吗？此操作不可撤销。`)) return;
  const saved = await withPriceStorageLock(async () => {
    const latest = readStoredGroups();
    if (!latest.storageError) applyStoredGroups(latest);
    const latestGroup = groups.find(g => g.id === groupId);
    if (hasGroupSnapshotConflict(confirmedSnapshot, latestGroup)) {
      renderPriceList();
      showPriceStatus('该对比组在确认期间已发生变化，未执行删除；请检查后重试。');
      return false;
    }
    groups = groups.filter(g => g.id !== groupId);
    const saved = saveGroups();
    if (saved && editingGroupId === groupId) {
      editingId = null;
      editingGroupId = null;
      editingBaseItem = null;
    }
    return saved;
  });
  if (saved) renderPriceList();
}

async function addItemToGroup(groupId, formData) {
  const saved = await mutateGroups(() => {
    const group = groups.find(g => g.id === groupId);
    if (!group) return false;
    group.items.push({
      id: uid(),
      name: formData.name || ('商品 ' + (group.items.length + 1)),
      unitWeight: formData.unitWeight,
      packSize: formData.packSize,
      packCount: formData.packCount,
      totalPrice: formData.totalPrice,
    });
  });
  if (!saved) { renderPriceList(); return false; }
  const group = groups.find(g => g.id === groupId);
  if (group) renderGroup(group);
  return true;
}

async function deleteItemFromGroup(groupId, itemId) {
  const item = findStoredItem({ groups }, groupId, itemId);
  if (!item) return;
  const expectedItem = { ...item };
  const saved = await mutateGroups(() => {
    if (hasEditConflict(expectedItem, findStoredItem({ groups }, groupId, itemId))) {
      showPriceStatus('该商品在删除前已发生变化，未执行删除；请检查后重试。');
      return false;
    }
    const group = groups.find(g => g.id === groupId);
    group.items = group.items.filter(i => i.id !== itemId);
  });
  if (!saved) { renderPriceList(); return; }
  clearEditingIfMatches(groupId, itemId);
  const group = groups.find(g => g.id === groupId);
  if (group) renderGroup(group);
}

function startEditItem(groupId, itemId) {
  const item = findStoredItem({ groups }, groupId, itemId);
  if (!item) return;
  const previousGroupId = editingGroupId;
  editingGroupId = groupId;
  editingId = itemId;
  editingBaseItem = { ...item };
  if (previousGroupId && previousGroupId !== groupId) {
    const previousGroup = groups.find(g => g.id === previousGroupId);
    if (previousGroup) renderGroup(previousGroup);
  }
  const group = groups.find(g => g.id === groupId);
  if (group) renderGroup(group);
  document.querySelector('.item-edit-form[data-group-id="' + groupId + '"][data-item-id="' + itemId + '"] [data-field="name"]')?.focus();
}

function focusItemAction(groupId, itemId) {
  document.querySelector('[data-action="edit"][data-group-id="' + groupId + '"][data-item-id="' + itemId + '"]')?.focus({ preventScroll: true });
}

function cancelEdit(groupId, itemId) {
  if (groupId && (editingGroupId !== groupId || editingId !== itemId)) {
    const staleGroup = groups.find(g => g.id === groupId);
    if (staleGroup) renderGroup(staleGroup);
    return;
  }
  const prevGroupId = editingGroupId;
  const prevItemId = editingId;
  editingId = null;
  editingGroupId = null;
  editingBaseItem = null;
  if (prevGroupId != null) {
    const group = groups.find(g => g.id === prevGroupId);
    if (group) renderGroup(group);
    focusItemAction(prevGroupId, prevItemId);
  }
}

// Only drop the edit session when it still points at this exact item — a
// save finishing must not clobber an edit the user started elsewhere while
// the write was in flight (the fallback lock path adds a 100ms window).
function clearEditingIfMatches(groupId, itemId) {
  if (editingGroupId !== groupId || editingId !== itemId) return;
  editingId = null;
  editingGroupId = null;
  editingBaseItem = null;
}

async function saveEditItem(form, groupId, itemId) {
  const fields = parseItemFields(form);
  if (!fields) return;
  const name = form.querySelector('[data-field="name"]').value.trim();
  const submittedDraft = itemFormSnapshot(form);

  const baseItem = editingBaseItem;
  const saved = await withPriceStorageLock(async () => {
    const latest = readStoredGroups();
    if (!latest.storageError && hasEditConflict(baseItem, findStoredItem(latest, groupId, itemId))) {
      // Applying the snapshot closes only stale edits. The user may already
      // have reopened this item against the latest version while we waited.
      applyStoredGroups(latest);
      renderPriceList();
      showPriceStatus('该商品已发生变化，已保留最新数据；本次过期修改未保存。');
      if (editingId === null) focusItemAction(groupId, itemId);
      return false;
    }
    if (!latest.storageError) applyStoredGroups(latest);
    const group = groups.find(g => g.id === groupId);
    const item = group && group.items.find(i => i.id === itemId);
    if (!item) { renderPriceList(); return false; }
    item.name = name || item.name;
    item.unitWeight = fields.unitWeight;
    item.packSize = fields.packSize;
    item.packCount = fields.packCount;
    item.totalPrice = fields.totalPrice;
    const saved = saveGroups();
    if (saved && editingGroupId === groupId && editingId === itemId) {
      const currentForm = document.querySelector('.item-edit-form[data-group-id="' + groupId + '"][data-item-id="' + itemId + '"]');
      if (currentForm && itemFormSnapshot(currentForm) !== submittedDraft) {
        // New input belongs to a subsequent edit of the just-saved version.
        editingBaseItem = { ...item };
      } else {
        clearEditingIfMatches(groupId, itemId);
      }
    }
    return saved;
  });
  if (!saved) return;
  // The write may have merged changes to any group before its storage event
  // arrives. Refresh that entire snapshot while retaining unrelated drafts.
  renderPriceList();
  if (editingId === null) focusItemAction(groupId, itemId);
}

function renderGroupContent(group) {
  return priceView.renderGroupContent(group, { editingId, editingGroupId });
}

// Drafts belong to their group/item, not to the DOM nodes a render replaces.
// An edit is restored only if its form still exists after conflict handling.
function preservePriceDrafts(root, render) {
  const drafts = Array.from(root.querySelectorAll('form[data-group-id]'), form => ({
    groupId: form.dataset.groupId,
    itemId: form.dataset.itemId,
    calculationError: form.dataset.calculationError,
    fields: Array.from(form.querySelectorAll('[data-field]'), input => ({
      field: input.dataset.field, value: input.value,
      error: input.getAttribute?.('aria-invalid') === 'true'
        ? document.getElementById(input.dataset.errorId)?.textContent : '',
      focused: input === document.activeElement,
      start: input.selectionStart, end: input.selectionEnd,
    })),
  }));
  render();
  for (const form of root.querySelectorAll('form[data-group-id]')) {
    restorePendingPriceForm(form);
    const draft = drafts.find(d => d.groupId === form.dataset.groupId && d.itemId === form.dataset.itemId);
    if (!draft) continue;
    if (draft.calculationError) form.dataset.calculationError = draft.calculationError;
    for (const input of form.querySelectorAll('[data-field]')) {
      const field = draft.fields.find(f => f.field === input.dataset.field);
      if (!field) continue;
      input.value = field.value;
      if (field.error) setInputError(input, field.error);
      if (field.focused) {
        input.focus({ preventScroll: true });
        if (field.start != null && typeof input.setSelectionRange === 'function') {
          input.setSelectionRange(field.start, field.end);
        }
      }
    }
  }
}

// Re-render just one group in place — preserves the add-form inputs and
// the scroll position of the rest of the page. Falls back to a full
// render if the group's card isn't in the DOM yet.
function renderGroup(group) {
  const card = document.querySelector('.group-card[data-group-id="' + group.id + '"]');
  if (!card) { renderPriceList(); return; }
  const { summaryHtml, itemsHtml } = renderGroupContent(group);

  const oldSummary = card.querySelector(':scope > .group-summary');
  if (oldSummary) oldSummary.remove();
  if (summaryHtml) {
    const header = card.querySelector(':scope > .group-header');
    if (header) header.insertAdjacentHTML('afterend', summaryHtml);
  }

  const itemsDiv = card.querySelector(':scope > .group-items');
  if (itemsDiv) preservePriceDrafts(itemsDiv, () => { itemsDiv.innerHTML = itemsHtml; });
}

function renderPriceList() {
  const list = document.getElementById('price-list');
  preservePriceDrafts(list, renderPriceListContent);
}

function renderPriceListContent() {
  const list = document.getElementById('price-list');
  const empty = document.getElementById('price-empty');

  if (groups.length === 0) {
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  list.innerHTML = groups.map(group => priceView.renderGroupCard(group, { editingId, editingGroupId })).join('');
}

// Shared validation for the add-item and edit-item forms: parse all four
// numeric fields and flag every invalid one so the user sees all errors.
const ITEM_FIELD_PARSERS = {
  unitWeight: parsePositiveFiniteNumber,
  packSize: parsePositiveInteger,
  packCount: parsePositiveInteger,
  totalPrice: parsePositiveFiniteNumber,
};

function validateItemField(el) {
  const field = el.dataset.field;
  const value = ITEM_FIELD_PARSERS[field](el.value);
  const message = field === 'packSize' || field === 'packCount'
    ? '请输入大于 0 的整数。' : '请输入大于 0 的数字。';
  setInputError(el, value === null ? message : '');
  return value;
}

function parseItemFields(form, focusError = true) {
  const fields = {};
  let firstInvalid = null;
  for (const field of Object.keys(ITEM_FIELD_PARSERS)) {
    const el = form.querySelector('[data-field="' + field + '"]');
    fields[field] = validateItemField(el);
    if (fields[field] === null && !firstInvalid) firstInvalid = el;
  }
  if (form.dataset) delete form.dataset.calculationError;
  if (!firstInvalid && calcUnitPrice(fields) === null) {
    firstInvalid = form.querySelector('[data-field="unitWeight"]');
    setInputError(firstInvalid, '超出计算范围，请调整重量、数量或总价。');
    if (form.dataset) form.dataset.calculationError = 'true';
  }
  if (firstInvalid && focusError) firstInvalid.focus();
  return firstInvalid ? null : fields;
}

async function handleAddSubmit(form, groupId) {
  const fields = parseItemFields(form);
  if (!fields) return;
  const submittedDraft = itemFormSnapshot(form);
  const formData = {
    name: form.querySelector('[data-field="name"]').value.trim(),
    unitWeight: fields.unitWeight,
    packSize: fields.packSize,
    packCount: fields.packCount,
    totalPrice: fields.totalPrice,
  };
  if (await addItemToGroup(groupId, formData)) {
    // A synchronization render may have replaced the submitted form.
    const currentForm = document.querySelector('.group-add-item-form[data-group-id="' + groupId + '"]');
    if (currentForm && itemFormSnapshot(currentForm) === submittedDraft) currentForm.reset();
  }
}

function initPriceCalculator() {
  const lockManager = typeof navigator !== 'undefined' ? navigator.locks : null;
  if (!lockManager) {
    initPricePresence();
    // Release the presence claim while hidden and rebuild it on return, so a
    // bfcache restore doesn't leave this tab invisible to other fallback tabs.
    window.addEventListener('pagehide', stopPriceHeartbeat);
    window.addEventListener('pageshow', initPricePresence);
  }
  loadGroups();
  renderPriceList();

  window.addEventListener('storage', function(e) {
    if (e.key !== PRICE_STORAGE_KEY && e.key !== null) return;
    // Read the current snapshot: queued events may predate a clear and a new
    // revision sequence. A reset must also invalidate the old edit session.
    const stored = readStoredGroups();
    if (stored.storageError) { showPriceStatus('无法读取浏览器存储，请重试。'); return; }
    if (stored.revision === groupsRevision && JSON.stringify(stored.groups) === JSON.stringify(groups)) return;
    const previousGroups = groups;
    // Re-render only groups whose content actually changed so in-progress
    // add-form inputs elsewhere survive the sync.
    const changedIds = new Set(stored.groups
      .filter(g => {
        const prev = previousGroups.find(p => p.id === g.id);
        return !prev || JSON.stringify(prev) !== JSON.stringify(g);
      })
      .map(g => g.id));
    // Other items may change while this item's draft remains valid.
    applyStoredGroups(stored);
    if (previousGroups.some(p => !stored.groups.some(g => g.id === p.id))) {
      renderPriceList();
    } else {
      stored.groups.forEach(g => {
        // A group added remotely has no card yet; renderGroup falls back to
        // a full render for it.
        if (changedIds.has(g.id)) renderGroup(g);
      });
    }
    showPriceStatus(stored.hadInvalidData
      ? '其他标签页写入的数据格式无效，已安全忽略。'
      : '已同步其他标签页的修改。');
  });

  const list = document.getElementById('price-list');

  list.addEventListener('input', e => {
    const el = e.target;
    if (!(el.dataset.field in ITEM_FIELD_PARSERS)) return;
    const form = el.closest('form');
    if (form?.dataset.calculationError) parseItemFields(form, false);
    else if (el.getAttribute('aria-invalid') === 'true') validateItemField(el);
  });

  // Single delegated click handler for every action button inside the list.
  list.addEventListener('click', async function(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn || !list.contains(btn)) return;
    const action = btn.dataset.action;
    const groupId = btn.dataset.groupId;
    const itemId = btn.dataset.itemId;
    if (action === 'edit') startEditItem(groupId, itemId);
    else if (action === 'delete-item') await deleteItemFromGroup(groupId, itemId);
    else if (action === 'cancel-edit') cancelEdit(groupId, itemId);
    else if (action === 'delete-group') await deleteGroup(groupId);
  });

  // Single delegated submit handler for both the add-item and edit-item forms.
  list.addEventListener('submit', async function(e) {
    const form = e.target;
    if (!form.matches('form')) return;
    if (form.classList.contains('group-add-item-form')) {
      e.preventDefault();
      await runFormSubmissionOnce(form, () => handleAddSubmit(form, form.dataset.groupId));
    } else if (form.classList.contains('item-edit-form')) {
      e.preventDefault();
      await runFormSubmissionOnce(form, () => saveEditItem(form, form.dataset.groupId, form.dataset.itemId));
    }
  });

  const createGroupForm = document.getElementById('create-group-form');
  if (createGroupForm) {
    const nameInput = document.getElementById('new-group-name');
    nameInput.addEventListener('input', () => {
      if (nameInput.value.trim()) setInputError(nameInput, '');
    });
    createGroupForm.addEventListener('submit', async function(e) {
      e.preventDefault();
      const nameInput = document.getElementById('new-group-name');
      const submittedName = nameInput.value;
      const name = submittedName.trim();
      if (!name) { flagInputError(nameInput); return; }
      await runFormSubmissionOnce(createGroupForm, async () => {
        if (await addGroup(name) && nameInput.value === submittedName) nameInput.value = '';
      });
    });
  }
}

/* ===== BOSS TIMER ===== */
// Pure schedule/format helpers live at module level so Node's test runner
// can exercise the boundary math directly.
function pad(n) { return String(n).padStart(2, '0'); }

// Next spawn strictly after `now`: ceil alone returns a boundary that can
// equal `now`, so the loop advances one extra cycle in that case.
function getNext(now, baseMs, intervalMs) {
  const elapsed = now - baseMs;
  let next = baseMs + Math.ceil(elapsed / intervalMs) * intervalMs;
  while (next <= now) next += intervalMs;
  return next;
}

function fmtCountdown(totalSecs, hasHours) {
  if (hasHours) {
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const s = totalSecs % 60;
    return pad(h) + ':' + pad(m) + ':' + pad(s);
  }
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return pad(m) + ':' + pad(s);
}

function initBossTimer() {
  const originalTitle = document.title;

  function flash(el) { el.classList.remove('boss-flash'); void el.offsetWidth; el.classList.add('boss-flash'); }
  function fmtDate(ts) {
    return new Date(ts).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).replace(/\//g, '-');
  }
  function onSpawn(cfg) {
    // Distinct spawn pulse so a refresh is obvious even without watching the digits.
    cfg.card.classList.remove('boss-spawned');
    void cfg.card.offsetWidth;
    cfg.card.classList.add('boss-spawned');
  }

  // Base times and intervals are hardcoded on purpose: this timer tracks one
  // game's fixed spawn schedule. If the schedule ever changes, edit the base
  // and interval below — a settings UI is deliberately out of scope.
  const WORLD = {
    key: 'world', title: '世界首领',
    base: new Date('2023-10-27T22:00:00+08:00').getTime(),
    interval: 12600 * 1000,
    els: { spawn: document.getElementById('w-spawn'), h: document.getElementById('w-h'), m: document.getElementById('w-m'), s: document.getElementById('w-s') },
    card: document.querySelector('.boss-card.world'),
    prev: null, next: 0, hasHours: true, notifiedFor: -1,
  };
  const NORMAL = {
    key: 'normal', title: '巢穴首领',
    base: new Date('2026-03-31T18:45:00+08:00').getTime(),
    interval: 2700 * 1000,
    els: { spawn: document.getElementById('n-spawn'), m: document.getElementById('n-m'), s: document.getElementById('n-s') },
    card: document.querySelector('.boss-card.normal'),
    prev: null, next: 0, hasHours: false, notifiedFor: -1,
  };

  function updateCard(cfg) {
    const now = Date.now();
    cfg.next = getNext(now, cfg.base, cfg.interval);
    // Detect a rollover into the next cycle → fire spawn effects once.
    if (cfg.notifiedFor !== -1 && now >= cfg.notifiedFor && cfg.next > cfg.notifiedFor) onSpawn(cfg);
    cfg.notifiedFor = cfg.next;

    cfg.els.spawn.textContent = fmtDate(cfg.next);
    const remaining = Math.max(0, cfg.next - now);
    const totalSecs = Math.floor(remaining / 1000);
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const s = totalSecs % 60;
    if (cfg.hasHours) {
      if (!cfg.prev || h !== cfg.prev.h) { cfg.els.h.textContent = pad(h); if (cfg.prev) flash(cfg.els.h); }
      if (!cfg.prev || m !== cfg.prev.m) { cfg.els.m.textContent = pad(m); if (cfg.prev) flash(cfg.els.m); }
      if (!cfg.prev || s !== cfg.prev.s) { cfg.els.s.textContent = pad(s); if (cfg.prev) flash(cfg.els.s); }
      cfg.prev = { h, m, s };
    } else {
      const totalM = Math.floor(totalSecs / 60);
      if (!cfg.prev || totalM !== cfg.prev.m) { cfg.els.m.textContent = pad(totalM); if (cfg.prev) flash(cfg.els.m); }
      if (!cfg.prev || s !== cfg.prev.s) { cfg.els.s.textContent = pad(s); if (cfg.prev) flash(cfg.els.s); }
      cfg.prev = { m: totalM, s };
    }

    // Urgency highlight in the final minute before a spawn.
    if (totalSecs > 0 && totalSecs <= 60) cfg.card.classList.add('boss-soon');
    else cfg.card.classList.remove('boss-soon');

    return totalSecs;
  }

  const TICK_MS_VISIBLE = 1000;
  const TICK_MS_HIDDEN = 5000;

  function tick() {
    const ws = updateCard(WORLD);
    const ns = updateCard(NORMAL);
    // Show a countdown in the tab title while the page is in the background.
    if (document.hidden) {
      document.title = '巢穴 ' + fmtCountdown(ns, false) + ' · 世界 ' + fmtCountdown(ws, true) + ' — ' + originalTitle;
    } else if (document.title !== originalTitle) {
      document.title = originalTitle;
    }
  }

  let timerId = null;
  function startTimer() {
    if (timerId) clearInterval(timerId);
    timerId = setInterval(tick, document.hidden ? TICK_MS_HIDDEN : TICK_MS_VISIBLE);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && document.title !== originalTitle) document.title = originalTitle;
    tick();
    startTimer();
  });

  tick();
  startTimer();
}

/* ===== INIT ===== */
function initSafely(name, initializer) {
  try {
    initializer();
  } catch (error) {
    console.error(`[Toolbox] ${name} 初始化失败`, error);
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    setActiveTab(restoreTab());
    initTabKeyboard();
    window.addEventListener('hashchange', () => {
      const hash = location.hash.replace('#', '');
      if (TAB_IDS.includes(hash)) switchTab(hash);
    });

    initSafely('热量换算', initEnergyConverter);
    initSafely('计数器', initCounter);
    initSafely('比价计算', initPriceCalculator);
    initSafely('Boss 计时', initBossTimer);
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    convertKcalToKj,
    convertKjToKcal,
    decodeStoredGroups,
    findCheapestInGroup,
    fmtCountdown,
    getNext,
    hasEditConflict,
    hasFreshPricePresence,
    hasGroupSnapshotConflict,
    parseNonNegativeFiniteNumber,
    parsePositiveFiniteNumber,
    parsePositiveInteger,
    runFormSubmissionOnce,
    runWithPriceStorageLock,
    shouldHandleCounterShortcut,
  };
}
