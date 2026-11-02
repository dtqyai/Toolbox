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

const storage = typeof module !== 'undefined' && module.exports
  ? require('./storage.js') : ToolboxStorage;
const { initCounter, shouldHandleCounterShortcut } = typeof module !== 'undefined' && module.exports
  ? require('./counter.js') : ToolboxCounter;

/* ===== TAB NAVIGATION ===== */
const TAB_IDS = ['energy', 'counter', 'price'];
const ACTIVE_TAB_KEY = 'toolbox_active_tab';

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

/* ===== PRICE CALCULATOR ===== */
// Storage is localStorage-only by design: no import/export or remote backup.
// Every read is decoded at the boundary, and revisions prevent a stale tab
// from silently replacing a newer snapshot.
let groups = []; // [{ id, name, items: [...] }]
let editingId = null;
let editingGroupId = null;
let editingBaseItem = null;
let groupsRevision = 0;
let persistedGroupsSnapshot = [];
let priceStatusTimer = null;
let priceInfo = '';
const priceNotices = new Map();
const conflictDrafts = new Map();
let pendingConflictFocus = null;
// Form nodes are replaced by synchronization renders; submissions belong to
// the group/item, and every replacement must inherit their pending state.
const pendingPriceForms = new Map();

function renderPriceNotices() {
  const localKeys = new Set();
  for (const node of document.querySelectorAll?.('[data-status-key]') || []) {
    const message = priceNotices.get(node.dataset.statusKey) || '';
    node.textContent = message;
    node.parentElement.hidden = !message;
    if (message) localKeys.add(node.dataset.statusKey);
  }
  const notices = Array.from(priceNotices.entries());
  const notice = notices.filter(([key]) => !localKeys.has(key)).at(-1) || notices.at(-1);
  const status = document.getElementById('price-storage-status');
  if (!status) return;
  status.textContent = notice ? notice[1] : priceInfo;
  status.hidden = !status.textContent || !!(notice && localKeys.has(notice[0]));
  const banner = document.getElementById('price-status-banner');
  if (banner) {
    banner.hidden = status.hidden;
    if (banner.dataset) banner.dataset.kind = notice ? 'error' : 'info';
  }
  const viewDrafts = document.getElementById('view-conflict-drafts');
  if (viewDrafts) viewDrafts.hidden = !conflictDrafts.size;
  const dismiss = document.getElementById('dismiss-price-status');
  if (dismiss?.dataset) dismiss.dataset.dismissKey = notice ? notice[0] : 'info';
}

function showPriceStatus(message, { persistent = true, targetKey = 'page' } = {}) {
  if (persistent) {
    if (message) priceNotices.set(targetKey, message);
    else priceNotices.delete(targetKey);
  } else {
    clearTimeout(priceStatusTimer);
    priceInfo = message;
    if (message) priceStatusTimer = setTimeout(() => {
      priceInfo = '';
      renderPriceNotices();
    }, 6000);
  }
  renderPriceNotices();
}

function clearPriceStatus(targetKey) {
  priceNotices.delete(targetKey);
  renderPriceNotices();
}

function preserveConflictingEdit(fallbackForm) {
  const form = document.querySelector('.item-edit-form[data-group-id="' + editingGroupId + '"][data-item-id="' + editingId + '"]') || fallbackForm;
  const fields = {};
  for (const field of ['name', 'unitWeight', 'packSize', 'packCount', 'totalPrice']) {
    fields[field] = form?.querySelector('[data-field="' + field + '"]')?.value ?? String(editingBaseItem?.[field] ?? '');
  }
  const id = uid();
  if (form?.contains?.(document.activeElement)) pendingConflictFocus = id;
  conflictDrafts.set(id, {
    id, groupId: editingGroupId, itemId: editingId,
    groupName: groups.find(g => g.id === editingGroupId)?.name || '未命名组', fields,
  });
  showPriceStatus('商品已更新，未保存的输入已保留在冲突草稿中。', { targetKey: 'conflicts' });
}

function renderConflictDrafts() {
  const root = document.getElementById('price-conflicts');
  if (!root) return;
  const drafts = Array.from(conflictDrafts.values(), draft => ({
    ...draft, hasLatest: !!findStoredItem({ groups }, draft.groupId, draft.itemId),
  }));
  const signature = JSON.stringify(drafts);
  if (root.dataset?.signature === signature) return;
  root.innerHTML = priceView.renderConflictDrafts(drafts);
  root.hidden = drafts.length === 0;
  if (root.dataset) root.dataset.signature = signature;
  if (pendingConflictFocus) {
    document.getElementById('conflict-text-' + pendingConflictFocus)?.focus?.();
    pendingConflictFocus = null;
  }
}

async function copyConflictDraft(id) {
  const input = document.getElementById('conflict-text-' + id);
  if (!input) return;
  let message;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(input.value);
    message = '已复制草稿。';
  } catch (error) {
    input.focus();
    input.select();
    message = '草稿已选中，请使用复制操作。';
  }
  const status = document.getElementById('conflict-status-' + id);
  if (status) status.textContent = message;
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

function applyStoredGroups(state, fallbackForm) {
  // Every path adopting a persisted snapshot must reconcile the active edit,
  // including saves/deletes that read it before its storage event arrives.
  synchronizeEdit(state, fallbackForm);
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

async function withPriceStorageLock(task, targetKey = 'page') {
  try {
    return await storage.requestWrite('toolbox-price-groups-write', task);
  } catch (error) {
    const message = error instanceof storage.CoordinationError ? error.message : '暂时无法保存，请重试。';
    showPriceStatus(message, { targetKey });
    return false;
  }
}

function synchronizeEdit(state, fallbackForm) {
  if (editingId !== null && hasEditConflict(editingBaseItem, findStoredItem(state, editingGroupId, editingId))) {
    preserveConflictingEdit(fallbackForm);
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

async function mutateGroups(mutator, targetKey) {
  return withPriceStorageLock(async () => {
    const latest = readStoredGroups();
    if (!latest.storageError && storedGroupsChanged(latest)) {
      applyStoredGroups(latest);
      renderPriceList();
      showPriceStatus('已同步其他标签页的修改。', { persistent: false });
    }
    if (mutator() === false) return false;
    return saveGroups(targetKey);
  }, targetKey);
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

function saveGroups(targetKey = 'page') {
  const latest = readStoredGroups();
  if (!latest.storageError && storedGroupsChanged(latest)) {
    applyStoredGroups(latest);
    renderPriceList();
    showPriceStatus('检测到其他标签页的新修改，已保留最新数据；请重试刚才的操作。', { targetKey });
    return false;
  }

  const nextRevision = groupsRevision + 1;
  try {
    writePriceGroups(localStorage, nextRevision, groups);
    groupsRevision = nextRevision;
    persistedGroupsSnapshot = cloneGroups(groups);
    clearPriceStatus(targetKey);
    return true;
  } catch (e) {
    groups = cloneGroups(persistedGroupsSnapshot);
    renderPriceList();
    showPriceStatus('无法保存到浏览器，本次修改未保留。', { targetKey });
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
  }, 'create-group-form');
  if (saved) renderPriceList();
  return saved;
}

async function deleteGroup(groupId) {
  const group = groups.find(g => g.id === groupId);
  if (!group) { renderPriceList(); return; }
  const initiator = document.activeElement;
  const neighbors = neighboringIds(groups, groupId);
  const targetKey = groupId + ':group';
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
      showPriceStatus('该对比组在确认期间已发生变化，未执行删除；请检查后重试。', { targetKey });
      return false;
    }
    groups = groups.filter(g => g.id !== groupId);
    const saved = saveGroups(targetKey);
    if (saved && editingGroupId === groupId) {
      editingId = null;
      editingGroupId = null;
      editingBaseItem = null;
    }
    return saved;
  }, targetKey);
  if (saved) {
    renderPriceList();
    if (canRestoreActionFocus(initiator)) {
      const nextId = neighbors.find(id => groups.some(g => g.id === id));
      const target = nextId && document.querySelector('.group-add-item-form[data-group-id="' + nextId + '"] [data-field="name"]');
      (target || document.getElementById('new-group-name'))?.focus({ preventScroll: true });
    }
  }
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
  }, groupId + ':add');
  if (!saved) { renderPriceList(); return false; }
  const group = groups.find(g => g.id === groupId);
  if (group) renderGroup(group);
  return true;
}

async function deleteItemFromGroup(groupId, itemId) {
  const item = findStoredItem({ groups }, groupId, itemId);
  if (!item) return;
  const initiator = document.activeElement;
  const neighbors = neighboringIds(groups.find(g => g.id === groupId).items, itemId);
  const targetKey = groupId + ':group';
  const expectedItem = { ...item };
  const saved = await mutateGroups(() => {
    if (hasEditConflict(expectedItem, findStoredItem({ groups }, groupId, itemId))) {
      showPriceStatus('该商品在删除前已发生变化，未执行删除；请检查后重试。', { targetKey });
      return false;
    }
    const group = groups.find(g => g.id === groupId);
    group.items = group.items.filter(i => i.id !== itemId);
  }, targetKey);
  if (!saved) { renderPriceList(); return; }
  clearEditingIfMatches(groupId, itemId);
  const group = groups.find(g => g.id === groupId);
  if (group) renderGroup(group);
  if (canRestoreActionFocus(initiator)) {
    const nextId = neighbors.find(id => group?.items.some(item => item.id === id));
    if (nextId) focusItemAction(groupId, nextId);
    else document.querySelector('.group-add-item-form[data-group-id="' + groupId + '"] [data-field="name"]')?.focus({ preventScroll: true });
  }
}

function neighboringIds(items, id) {
  const index = items.findIndex(item => item.id === id);
  return [...items.slice(index + 1), ...items.slice(0, index).reverse()].map(item => item.id);
}

function canRestoreActionFocus(initiator) {
  return !document.activeElement || document.activeElement === document.body || document.activeElement === initiator;
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
  const targetKey = groupId + ':edit:' + itemId;
  const saved = await withPriceStorageLock(async () => {
    const latest = readStoredGroups();
    if (!latest.storageError && hasEditConflict(baseItem, findStoredItem(latest, groupId, itemId))) {
      // Applying the snapshot closes only stale edits. The user may already
      // have reopened this item against the latest version while we waited.
      applyStoredGroups(latest, form);
      renderPriceList();
      showPriceStatus('该商品已发生变化，过期修改未保存。' + (conflictDrafts.size ? '输入已保留在冲突草稿中。' : ''), { targetKey: conflictDrafts.size ? 'conflicts' : 'page' });
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
    const saved = saveGroups(targetKey);
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
  }, targetKey);
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
  renderConflictDrafts();
  renderPriceNotices();
}

function renderPriceList() {
  const list = document.getElementById('price-list');
  preservePriceDrafts(list, renderPriceListContent);
  renderConflictDrafts();
  renderPriceNotices();
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
      : '已同步其他标签页的修改。', { persistent: stored.hadInvalidData });
  });

  document.getElementById('page-price').addEventListener('click', async event => {
    if (event.target.closest('#view-conflict-drafts')) document.querySelector('.conflict-text')?.focus();
    const dismiss = event.target.closest('[data-dismiss-key]');
    if (dismiss) {
      const key = dismiss.dataset.dismissKey;
      if (key === 'info') priceInfo = '';
      else priceNotices.delete(key);
      renderPriceNotices();
      const form = dismiss.closest('form');
      (form?.querySelector('button[type="submit"]') || document.getElementById('new-group-name'))?.focus({ preventScroll: true });
    }
    const button = event.target.closest('[data-conflict-action]');
    if (!button) return;
    const draft = conflictDrafts.get(button.dataset.draftId);
    if (!draft) return;
    if (button.dataset.conflictAction === 'copy') await copyConflictDraft(draft.id);
    if (button.dataset.conflictAction === 'edit') startEditItem(draft.groupId, draft.itemId);
    if (button.dataset.conflictAction === 'discard') {
      const drafts = Array.from(conflictDrafts.keys());
      const index = drafts.indexOf(draft.id);
      conflictDrafts.delete(draft.id);
      if (!conflictDrafts.size) clearPriceStatus('conflicts');
      renderConflictDrafts();
      renderPriceNotices();
      const next = drafts.slice(index + 1).concat(drafts.slice(0, index)).find(id => conflictDrafts.has(id));
      (next ? document.getElementById('conflict-text-' + next) : document.getElementById('new-group-name'))?.focus({ preventScroll: true });
    }
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
    initSafely('存储协调', () => storage.init());
    initSafely('计数器', initCounter);
    initSafely('比价计算', initPriceCalculator);
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    convertKcalToKj,
    convertKjToKcal,
    decodeStoredGroups,
    findCheapestInGroup,
    hasEditConflict,
    hasGroupSnapshotConflict,
    parseNonNegativeFiniteNumber,
    parsePositiveFiniteNumber,
    parsePositiveInteger,
    runFormSubmissionOnce,
    shouldHandleCounterShortcut,
  };
}
