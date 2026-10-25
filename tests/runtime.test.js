const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const sources = ['data.js', 'price-view.js', 'storage.js', 'counter.js', 'boss-timer.js', 'app.js']
  .map(file => fs.readFileSync(require.resolve('../' + file), 'utf8'));
function runtime(storage = new Map(), locks) {
  const listeners = {};
  const elements = new Map();
  const document = {
    activeElement: null,
    addEventListener() {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { textContent: '', hidden: true, style: {}, addEventListener() {} });
      return elements.get(id);
    },
    querySelector() { return null; },
    createElement() {
      return { set textContent(value) { this.innerHTML = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } };
    },
  };
  const context = vm.createContext({
    console, document, navigator: { locks },
    window: { addEventListener(name, handler) { listeners[name] = handler; } },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
      key: index => [...storage.keys()][index],
      get length() { return storage.size; },
    },
    setTimeout: fn => { queueMicrotask(fn); return 1; }, clearTimeout() {},
    setInterval: () => 1, clearInterval() {},
  });
  for (const source of sources) vm.runInContext(source, context);
  return { context, document, listeners, run: code => vm.runInContext(code, context) };
}
function serialLocks() {
  let queue = Promise.resolve();
  return { request(name, task) { const result = queue.then(task); queue = result.catch(() => {}); return result; } };
}
function fieldForm(values = {}) {
  return { querySelector(selector) {
    const field = selector.match(/data-field="([^"]+)"/)[1];
    return { value: values[field] ?? '1', dataset: { field }, classList: { toggle() {} }, setAttribute() {} };
  } };
}
const group = { id: 'g', name: '食品', items: [] };

test('counter reads and writes under the shared lock across tabs', async () => {
  const storage = new Map([['toolbox_counter', '0']]);
  const locks = serialLocks();
  const a = runtime(storage, locks), b = runtime(storage, locks);
  a.run('ToolboxCounter.loadCounter()'); b.run('ToolboxCounter.loadCounter()');
  await Promise.all([a.run('ToolboxCounter.updateCounter(1)'), b.run('ToolboxCounter.updateCounter(1)')]);
  assert.equal(storage.get('toolbox_counter'), '2');
  await a.run('ToolboxCounter.resetCounter()');
  await b.run('ToolboxCounter.updateCounter(1)');
  assert.equal(storage.get('toolbox_counter'), '1');
});

test('counter receives external changes and storage clearing', () => {
  const storage = new Map([['toolbox_counter', '4']]);
  const tab = runtime(storage, serialLocks());
  tab.run('initCounter()');
  storage.set('toolbox_counter', '7');
  tab.listeners.storage({ key: 'toolbox_counter' });
  assert.equal(String(tab.document.getElementById('counter-value').textContent), '7');
  storage.clear();
  tab.listeners.storage({ key: null });
  assert.equal(String(tab.document.getElementById('counter-value').textContent), '0');
});

test('full price renders retain existing group form drafts', async () => {
  const storage = new Map([['toolbox_price_groups', JSON.stringify({v: 1, revision: 1, groups: [group]})]]);
  const tab = runtime(storage, serialLocks());
  let input = { dataset: { field: 'name' }, value: '尚未提交的商品', focus() {} };
  const form = () => ({ dataset: { groupId: 'g' }, querySelectorAll: () => [input] });
  const list = tab.document.getElementById('price-list');
  list.querySelectorAll = () => [form()];
  list.querySelector = () => form();
  Object.defineProperty(list, 'innerHTML', { set() { input = { ...input, value: '' }; } });
  tab.run('loadGroups()');
  await tab.run('addGroup("新组")');
  assert.equal(input.value, '尚未提交的商品');
});

test('added fractional quantities remain editable under the same validation', () => {
  const tab = runtime();
  tab.context.form = fieldForm({ unitWeight: '0.001' });
  const result = tab.run('parseItemFields(form)');
  assert.equal(result.unitWeight, 0.001);
  const html = tab.run(`editingId='i'; editingGroupId='g'; renderGroupContent({id:'g',items:[{id:'i',name:'A',unitWeight:0.001,packSize:1,packCount:1,totalPrice:1}]}).itemsHtml`);
  assert.match(html, /<form[^>]*class="item-edit-form"[^>]*novalidate/);
  assert.match(html, /value="0.001"/);
});

test('price mutations merge latest storage and roll back failed saves', async () => {
  const storage = new Map([['toolbox_price_groups', JSON.stringify({v: 1, revision: 1, groups: [group]})]]);
  const tab = runtime(storage, serialLocks());
  // Rendering is outside this persistence test; exercised separately above.
  tab.run('renderPriceList = () => {}; renderGroup = () => {}; loadGroups()');
  storage.set('toolbox_price_groups', JSON.stringify({v: 1, revision: 2, groups: [group, {id: 'remote', name: '其他标签', items: []}]}));
  await tab.run('addGroup("本页")');
  assert.equal(JSON.parse(storage.get('toolbox_price_groups')).groups.length, 3);
  const saved = storage.get('toolbox_price_groups');
  tab.run('localStorage.setItem = () => { throw new Error("quota"); }');
  assert.equal(await tab.run('addGroup("不能保存")'), false);
  assert.equal(storage.get('toolbox_price_groups'), saved);
  assert.equal(tab.run('groups.length'), 3);
});

test('counter fallback refuses multiple tabs and succeeds once the other closes', async () => {
  const storage = new Map([['toolbox_counter', '5']]);
  const a = runtime(storage), b = runtime(storage);
  a.run('ToolboxStorage.publishPresence(); ToolboxCounter.loadCounter()'); b.run('ToolboxStorage.publishPresence(); ToolboxCounter.loadCounter()');
  assert.equal(await a.run('ToolboxCounter.updateCounter(1)'), false);
  assert.equal(storage.get('toolbox_counter'), '5');
  b.run('ToolboxStorage.stopPresence()');
  assert.equal(await a.run('ToolboxCounter.updateCounter(1)'), true);
  assert.equal(storage.get('toolbox_counter'), '6');
});

test('counter storage failure leaves both display and saved count unchanged', async () => {
  const storage = new Map([['toolbox_counter', '3']]);
  const tab = runtime(storage, serialLocks());
  tab.run('ToolboxCounter.loadCounter(); localStorage.setItem = () => { throw new Error("quota"); }');
  assert.equal(await tab.run('ToolboxCounter.updateCounter(1)'), false);
  assert.equal(storage.get('toolbox_counter'), '3');
  assert.equal(String(tab.document.getElementById('counter-value').textContent), '3');
  assert.match(tab.document.getElementById('counter-storage-status').textContent, /无法保存/);
});

test('counter refuses unsafe integer overflow', async () => {
  const storage = new Map([['toolbox_counter', String(Number.MAX_SAFE_INTEGER)]]);
  const tab = runtime(storage, serialLocks());
  assert.equal(await tab.run('ToolboxCounter.updateCounter(1)'), false);
  assert.equal(storage.get('toolbox_counter'), String(Number.MAX_SAFE_INTEGER));
});

test('stale price edit cannot overwrite a newer persisted item', async () => {
  const item = {id: 'i', name: '原商品', unitWeight: 100, packSize: 1, packCount: 1, totalPrice: 10};
  const storage = new Map([['toolbox_price_groups', JSON.stringify({v: 1, revision: 1, groups: [{...group, items: [item]}]})]]);
  const tab = runtime(storage, serialLocks());
  tab.run('renderPriceList = () => {}; renderGroup = () => {}; loadGroups(); startEditItem("g", "i")');
  const latest = JSON.stringify({v: 1, revision: 2, groups: [{...group, items: [{...item, name: '其他标签修改'}]}]});
  storage.set('toolbox_price_groups', latest);
  tab.context.form = fieldForm({ name: '过期修改' });
  await tab.run('saveEditItem(form, "g", "i")');
  assert.equal(storage.get('toolbox_price_groups'), latest);
  assert.equal(tab.run('groups[0].items[0].name'), '其他标签修改');
  assert.equal(tab.run('editingId'), null);
  assert.equal(tab.run('Array.from(conflictDrafts.values())[0].fields.name'), '过期修改');
});

test('failed price edit retains its editing session for retry', async () => {
  const item = {id: 'i', name: '原商品', unitWeight: 100, packSize: 1, packCount: 1, totalPrice: 10};
  const storage = new Map([['toolbox_price_groups', JSON.stringify({v: 1, revision: 1, groups: [{...group, items: [item]}]})]]);
  const tab = runtime(storage, serialLocks());
  tab.run('renderPriceList = () => {}; renderGroup = () => {}; loadGroups(); startEditItem("g", "i"); localStorage.setItem = () => { throw new Error("quota"); }');
  tab.context.form = fieldForm({ name: '修改草稿' });
  await tab.run('saveEditItem(form, "g", "i")');
  assert.equal(tab.run('editingId'), 'i');
  assert.equal(tab.run('groups[0].items[0].name'), '原商品');
});

test('last-moment unrelated storage changes preserve the current edit for retry', () => {
  const item = {id: 'i', name: '原商品', unitWeight: 100, packSize: 1, packCount: 1, totalPrice: 10};
  const storage = new Map([['toolbox_price_groups', JSON.stringify({v: 1, revision: 1, groups: [{...group, items: [item]}]})]]);
  const tab = runtime(storage, serialLocks());
  tab.run('renderPriceList = () => {}; renderGroup = () => {}; loadGroups(); startEditItem("g", "i")');
  storage.set('toolbox_price_groups', JSON.stringify({v: 1, revision: 2, groups: [{...group, items: [item]}, {id: 'other', name: '其他组', items: []}]}));
  assert.equal(tab.run('saveGroups()'), false);
  assert.equal(tab.run('editingId'), 'i');
  assert.equal(tab.run('groups.length'), 2);
});

test('a restarted revision sequence cannot overwrite a different stored snapshot', async () => {
  const storage = new Map([['toolbox_price_groups', JSON.stringify({ v: 1, revision: 1, groups: [group] })]]);
  const tab = runtime(storage, serialLocks());
  tab.run('renderPriceList = () => {}; loadGroups()');
  // Another tab clears storage and creates its first group before this tab's
  // queued storage events are delivered. The revision is 1 again.
  const replacement = { id: 'new', name: '清空后创建', items: [] };
  storage.set('toolbox_price_groups', JSON.stringify({ v: 1, revision: 1, groups: [replacement] }));
  assert.equal(await tab.run('addGroup("本页新组")'), true);
  const saved = JSON.parse(storage.get('toolbox_price_groups'));
  assert.deepEqual(saved.groups.map(g => g.name), ['清空后创建', '本页新组']);
});

test('save preflight detects changed contents even when the revision is reused', () => {
  const storage = new Map([['toolbox_price_groups', JSON.stringify({ v: 1, revision: 1, groups: [group] })]]);
  const tab = runtime(storage, serialLocks());
  tab.run('renderPriceList = () => {}; loadGroups(); groups[0].name = "待保存"');
  const latest = JSON.stringify({ v: 1, revision: 1, groups: [{ ...group, name: '重建后的数据' }] });
  storage.set('toolbox_price_groups', latest);
  assert.equal(tab.run('saveGroups()'), false);
  assert.equal(storage.get('toolbox_price_groups'), latest);
  assert.equal(tab.run('groups[0].name'), '重建后的数据');
});

for (const synchronous of [false, true]) {
  test(`rejected price lock (${synchronous ? 'sync' : 'async'}) keeps input and restores submission controls`, async () => {
    const saved = JSON.stringify({ v: 1, revision: 1, groups: [group] });
    const storage = new Map([['toolbox_price_groups', saved]]);
    const locks = { request() {
      if (synchronous) throw new Error('lock denied');
      return Promise.reject(new Error('lock denied'));
    } };
    const tab = runtime(storage, locks);
    tab.run('loadGroups()');
    const button = { disabled: false };
    const attributes = new Map();
    tab.context.form = {
      id: 'create-group-form',
      querySelectorAll: () => [button],
      setAttribute: (key, value) => attributes.set(key, value),
      removeAttribute: key => attributes.delete(key),
    };
    assert.equal(await tab.run('runFormSubmissionOnce(form, () => addGroup("保留组名"))'), false);
    assert.equal(button.disabled, false);
    assert.equal(attributes.has('aria-busy'), false);
    assert.equal(storage.get('toolbox_price_groups'), saved);
    assert.match(tab.document.getElementById('price-storage-status').textContent, /暂时无法保存/);
    assert.equal(tab.document.getElementById('price-storage-status').hidden, false);
  });
}

test('fallback refuses a write when presence storage cannot be checked', async () => {
  const storage = new Map([['toolbox_counter', '3']]);
  const tab = runtime(storage);
  tab.run('localStorage.key = () => { throw new Error("blocked"); }');
  assert.equal(await tab.run('ToolboxCounter.updateCounter(1)'), false);
  assert.equal(storage.get('toolbox_counter'), '3');
  assert.match(tab.document.getElementById('counter-storage-status').textContent, /无法检查/);
});
