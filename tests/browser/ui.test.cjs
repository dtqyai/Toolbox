const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium, webkit } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
let browser, server, url;
const fixture = { v: 1, revision: 1, groups: [{ id: 'g', name: '牛奶对比', items: [
  { id: 'a', name: '纯牛奶 250g × 24盒', unitWeight: 250, packSize: 24, packCount: 1, totalPrice: 59.9 },
  { id: 'b', name: '纯牛奶 200g × 12盒', unitWeight: 200, packSize: 12, packCount: 1, totalPrice: 32.9 },
] }] };
before(async () => {
  const root = path.resolve(__dirname, '../..');
  const files = new Set(['/index.html', '/app.js', '/data.js', '/price-view.js', '/styles.css', '/favicon.png']);
  server = http.createServer((req, res) => {
    const file = new URL(req.url, 'http://localhost').pathname.replace(/^\/$/, '/index.html');
    if (!files.has(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/html');
    res.end(fs.readFileSync(path.join(root, file)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  const engine = process.env.TEST_BROWSER === 'webkit' ? webkit : chromium;
  browser = await engine.launch(engine === chromium && process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {});
});
after(async () => { if (browser) await browser.close(); if (server) await new Promise(r => server.close(r)); });
async function withPage(run, width = 375, { noLocks = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'Asia/Shanghai' });
  if (noLocks) await context.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined }));
  const errors = [];
  context.on('page', page => page.on('pageerror', e => errors.push(e.message)));
  try {
    const page = await context.newPage();
    await page.goto(url);
    await page.evaluate(data => localStorage.setItem('toolbox_price_groups', JSON.stringify(data)), fixture);
    await page.reload();
    await page.locator('#tab-price').click();
    await run(page, context);
    assert.deepEqual(errors, [], 'No uncaught browser errors');
  } catch (error) {
    fs.mkdirSync('test-results', { recursive: true });
    for (const [index, page] of context.pages().entries()) {
      await page.screenshot({ path: `test-results/failure-${Date.now()}-${index}.png`, fullPage: true }).catch(() => {});
    }
    throw error;
  } finally { await context.close(); }
}
async function newGroup(page, name) {
  await page.locator('#new-group-name').fill(name);
  await page.locator('#create-group-form button').click();
  await page.waitForFunction(name => [...document.querySelectorAll('.group-name')].some(el => el.textContent === name), name);
}
async function storedName(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('toolbox_price_groups')).groups[0].items[0].name);
}

test('unrelated local writes preserve a pending item edit', () => withPage(async page => {
  await page.locator('[data-action=edit]').first().click();
  await page.locator('.item-edit-form [data-field=name]').fill('修改后的牛奶');
  await newGroup(page, '零食');
  await page.locator('.item-edit-form button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('.item-edit-form'));
  assert.equal(await storedName(page), '修改后的牛奶');
}));

test('edit focus enters the form and returns after cancel and save', () => withPage(async page => {
  const edit = page.locator('[data-action=edit]').first();
  await edit.focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('.item-edit-form [data-field=name]').evaluate(e => e === document.activeElement), true);
  await page.locator('[data-action=cancel-edit]').click();
  assert.equal(await edit.evaluate(e => e === document.activeElement), true);
  await page.keyboard.press('Enter');
  await page.locator('.item-edit-form button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('.item-edit-form'));
  assert.equal(await edit.evaluate(e => e === document.activeElement), true);
}));

test('price fields have persistent labels and actionable errors', () => withPage(async page => {
  const form = page.locator('.group-add-item-form');
  assert.equal(await form.locator('input').evaluateAll(es => es.every(e => e.labels.length > 0)), true);
  await form.locator('button').click();
  const weight = form.locator('[data-field=unitWeight]');
  assert.equal(await weight.getAttribute('aria-invalid'), 'true');
  assert.match(await form.innerText(), /大于 0/);
  assert.equal(await weight.evaluate(e => e === document.activeElement), true);
  await weight.fill('100');
  assert.notEqual(await weight.getAttribute('aria-invalid'), 'true');
  await form.locator('[data-field=totalPrice]').fill('10');
  await form.locator('button').click();
  await page.waitForFunction(() => document.querySelectorAll('.item-card').length === 3);
}));

test('energy recalculation removes stale errors on the target field', () => withPage(async page => {
  await page.locator('#tab-energy').click();
  await page.locator('#input-kj').fill('abc');
  assert.equal(await page.locator('#input-kj').getAttribute('aria-invalid'), 'true');
  await page.locator('#input-kcal').fill('100');
  assert.equal(await page.locator('#input-kj').inputValue(), '418');
  assert.equal(await page.locator('#input-kj').evaluate(e => e.classList.contains('error')), false);
  assert.notEqual(await page.locator('#input-kj').getAttribute('aria-invalid'), 'true');
}));

for (const width of [320, 375, 640, 768, 1440]) {
  test(`all tools fit a ${width}px viewport`, () => withPage(async page => {
    for (const tool of ['energy', 'counter', 'price', 'timer']) {
      await page.locator(`#tab-${tool}`).click();
      const dimensions = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
      assert.ok(dimensions.content <= dimensions.viewport, `${tool}: ${JSON.stringify(dimensions)}`);
      assert.equal(await page.locator('.tool-page.active').count(), 1);
    }
  }, width));
}

test('per-100g price is primary and mobile cards leave room for the form', () => withPage(async page => {
  const sizes = await page.locator('.item-card').first().evaluate(e => ({
    primary: parseFloat(getComputedStyle(e.querySelector('.item-unit-price-100')).fontSize),
    secondary: parseFloat(getComputedStyle(e.querySelector('.item-unit-price')).fontSize),
    height: e.getBoundingClientRect().height,
  }));
  assert.ok(sizes.primary > sizes.secondary);
  assert.ok(sizes.height < 210, `Card height ${sizes.height}`);
}));

test('remote edits to another item keep the current draft and new data', () => withPage(async (page, context) => {
  const other = await context.newPage(); await other.goto(url + '/#price');
  await page.locator('[data-action=edit]').first().click();
  await page.locator('.item-edit-form [data-field=name]').fill('本页草稿');
  await other.locator('[data-action=edit]').nth(1).click();
  await other.locator('.item-edit-form [data-field=name]').fill('远程改名');
  await other.locator('.item-edit-form button[type=submit]').click();
  await page.waitForFunction(() => document.querySelectorAll('.item-name')[1].textContent.includes('远程改名'));
  assert.equal(await page.locator('.item-edit-form [data-field=name]').inputValue(), '本页草稿');
  await page.locator('.item-edit-form button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('.item-edit-form'));
  assert.equal(await storedName(page), '本页草稿');
  assert.match(await page.locator('.item-name').nth(1).textContent(), /远程改名/);
}));

test('remote changes to the edited item close the stale form without overwriting', () => withPage(async (page, context) => {
  const other = await context.newPage(); await other.goto(url + '/#price');
  await page.locator('[data-action=edit]').first().click();
  await page.locator('.item-edit-form [data-field=name]').fill('过期草稿');
  await other.locator('[data-action=edit]').first().click();
  await other.locator('.item-edit-form [data-field=name]').fill('远程版本');
  await other.locator('.item-edit-form button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('.item-edit-form'));
  assert.equal(await storedName(page), '远程版本');
}));

test('a failed edit preserves its fractional values and can be retried', () => withPage(async page => {
  await page.locator('[data-action=edit]').first().click();
  await page.locator('.item-edit-form [data-field=name]').fill('重试草稿');
  await page.locator('.item-edit-form [data-field=unitWeight]').fill('0.001');
  await page.evaluate(() => {
    window.originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'toolbox_price_groups') throw new DOMException('quota', 'QuotaExceededError');
      return window.originalSetItem.call(this, key, value);
    };
  });
  await page.locator('.item-edit-form button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#price-storage-status').textContent.includes('无法保存'));
  assert.equal(await page.locator('.item-edit-form [data-field=name]').inputValue(), '重试草稿');
  assert.equal(await storedName(page), fixture.groups[0].items[0].name);
  await page.evaluate(() => { Storage.prototype.setItem = window.originalSetItem; });
  await page.locator('.item-edit-form button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('.item-edit-form'));
  assert.equal(await storedName(page), '重试草稿');
}));

test('long group and product names fit mobile cards and editing fields', () => withPage(async page => {
  await newGroup(page, 'LongUnbrokenProductGroupName'.repeat(4));
  await page.locator('[data-action=edit]').first().click();
  await page.locator('.item-edit-form [data-field=name]').fill('LongUnbrokenProductName'.repeat(4));
  await page.locator('.item-edit-form button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('.item-edit-form'));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
}));

for (const operation of ['clear', 'removeItem']) {
  test(`price synchronization recovers after storage ${operation}`, () => withPage(async (page, context) => {
    await newGroup(page, '旧组');
    await page.locator('[data-action=edit]').first().click();
    const other = await context.newPage(); await other.goto(url);
    await other.evaluate(operation => operation === 'clear' ? localStorage.clear() : localStorage.removeItem('toolbox_price_groups'), operation);
    await page.waitForFunction(() => document.querySelectorAll('.group-card').length === 0, null, { timeout: 1500 });
    assert.equal(await page.locator('.item-edit-form').count(), 0);
    await other.reload(); await other.locator('#tab-price').click();
    await newGroup(other, '新记录');
    await page.waitForFunction(() => document.querySelector('.group-name')?.textContent === '新记录', null, { timeout: 1500 });
    assert.deepEqual(await page.locator('.group-name').allTextContents(), ['新记录']);
  }));
}

test('validation errors survive a full redraw and clear after correction', () => withPage(async page => {
  const form = page.locator('.group-add-item-form').first();
  await form.locator('button').click();
  assert.equal(await form.locator('[aria-invalid=true]').count(), 2);
  await newGroup(page, '新组');
  assert.equal(await form.locator('[aria-invalid=true]').count(), 2);
  await form.locator('[data-field=unitWeight]').fill('100');
  assert.equal(await form.locator('[aria-invalid=true]').count(), 1);
  await form.locator('[data-field=totalPrice]').fill('10');
  assert.equal(await form.locator('[aria-invalid=true]').count(), 0);
}));

test('safe integer limits remain inside mobile counter cards', () => withPage(async page => {
  for (const value of [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
    await page.evaluate(value => localStorage.setItem('toolbox_counter', String(value)), value);
    await page.reload(); await page.locator('#tab-counter').click();
    await page.evaluate(() => document.fonts.ready);
    const size = await page.locator('#counter-value').evaluate(el => ({ scroll: el.scrollWidth, width: el.clientWidth, viewport: innerWidth, page: document.documentElement.scrollWidth }));
    assert.ok(size.scroll <= size.width && size.page <= size.viewport, JSON.stringify(size));
    assert.equal(await page.locator('#counter-value').textContent(), String(value));
  }
}, 320));

test('mobile energy inputs fill their row and the arrow is centered', () => withPage(async page => {
  await page.locator('#tab-energy').click();
  const size = await page.evaluate(() => {
    const row = document.querySelector('.converter-row').getBoundingClientRect();
    const input = document.querySelector('#input-kj').getBoundingClientRect();
    const arrow = document.querySelector('.converter-arrows').getBoundingClientRect();
    return { row: row.width, input: input.width, centerOffset: Math.abs((arrow.left + arrow.width / 2) - (row.left + row.width / 2)) };
  });
  assert.ok(Math.abs(size.row - size.input) < 1 && size.centerOffset < 1, JSON.stringify(size));
}));

test('overflowing price calculations are rejected and can be corrected', () => withPage(async page => {
  const form = page.locator('.group-add-item-form');
  for (const weight of ['1e308', '1e-308']) {
    await form.locator('[data-field=unitWeight]').fill(weight);
    await form.locator('[data-field=packSize]').fill('2');
    await form.locator('[data-field=totalPrice]').fill('10');
    await form.locator('button').click();
    assert.match(await form.innerText(), /计算范围/);
    assert.equal(await page.locator('.item-card').count(), 2);
  }
  await form.locator('[data-field=unitWeight]').fill('100');
  await form.locator('button').click();
  await page.waitForFunction(() => document.querySelectorAll('.item-card').length === 3);
  assert.doesNotMatch(await page.locator('#price-list').innerText(), /Infinity|NaN/);
}));

// Hold the real browser lock until the test releases it. This makes the
// submission/redraw ordering deterministic without replacing app callbacks.
async function holdPriceLock(page) {
  await page.evaluate(() => new Promise(entered => {
    window.heldPriceLock = navigator.locks.request('toolbox-price-groups-write', () => new Promise(release => {
      window.releasePriceLock = release;
      entered();
    }));
  }));
}
async function releasePriceLock(page) {
  await page.evaluate(async () => { window.releasePriceLock(); await window.heldPriceLock; });
}
async function fillItem(form, name, price = '10') {
  await form.locator('[data-field=name]').fill(name);
  await form.locator('[data-field=unitWeight]').fill('100');
  await form.locator('[data-field=totalPrice]').fill(price);
}

for (const remoteChange of ['add', 'change', 'delete']) {
  test(`saving an edit renders a queued remote group ${remoteChange}`, () => withPage(async (page, context) => {
    await page.addInitScript(() => {
      window.queuedStorageEvents = [];
      window.delayStorage = event => {
        if (!window.delayStorageEvents) return;
        event.stopImmediatePropagation();
        window.queuedStorageEvents.push(event);
      };
      window.addEventListener('storage', window.delayStorage);
    });
    await page.reload();
    await newGroup(page, '远端旧组');
    const other = await context.newPage(); await other.goto(url + '/#price');
    await page.locator('[data-action=edit]').first().click();
    await page.locator('.item-edit-form [data-field=name]').fill('本页编辑');
    // Delay delivery, not persistence, as with a queued cross-tab storage event.
    await page.evaluate(() => { window.delayStorageEvents = true; });
    await other.evaluate(change => {
      const state = JSON.parse(localStorage.getItem('toolbox_price_groups'));
      if (change === 'add') state.groups.push({ id: 'remote-new', name: '远端新组', items: [] });
      if (change === 'change') state.groups[1].items.push({ id: 'remote-item', name: '远端商品', unitWeight: 100, packSize: 1, packCount: 1, totalPrice: 10 });
      if (change === 'delete') state.groups.splice(1, 1);
      state.revision += 1;
      localStorage.setItem('toolbox_price_groups', JSON.stringify(state));
    }, remoteChange);
    await page.waitForFunction(() => window.queuedStorageEvents.length > 0);
    await page.locator('.item-edit-form button[type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('.item-edit-form'));
    await page.evaluate(() => {
      window.delayStorageEvents = false;
      for (const event of window.queuedStorageEvents) window.dispatchEvent(new StorageEvent('storage', { key: event.key }));
    });
    const expected = await page.evaluate(() => JSON.parse(localStorage.getItem('toolbox_price_groups')).groups.map(g => g.name));
    assert.deepEqual(await page.locator('.group-name').allTextContents(), expected);
    const expectedItems = await page.evaluate(() => JSON.parse(localStorage.getItem('toolbox_price_groups')).groups.flatMap(g => g.items.map(i => i.name)));
    const visibleItems = await page.locator('.item-name').evaluateAll(elements => elements.map(el => el.firstChild.textContent));
    assert.deepEqual(visibleItems, expectedItems);
    assert.equal(await storedName(page), '本页编辑');
  }));
}

test('pending add preserves the next draft after a synchronization redraw', () => withPage(async page => {
  const form = page.locator('.group-add-item-form').first();
  await fillItem(form, '提交商品');
  await holdPriceLock(page);
  await form.locator('button').click();
  await fillItem(form, '下一件草稿', '20');
  await page.evaluate(() => renderPriceList());
  await releasePriceLock(page);
  await page.waitForFunction(() => document.querySelectorAll('.item-card').length === 3);
  assert.equal(await form.locator('[data-field=name]').inputValue(), '下一件草稿');
  assert.equal(await form.locator('[data-field=totalPrice]').inputValue(), '20');
  const item = await page.evaluate(() => JSON.parse(localStorage.getItem('toolbox_price_groups')).groups[0].items.at(-1));
  assert.equal(item.name, '提交商品'); assert.equal(item.totalPrice, 10);
}));

test('pending new-group submission preserves the next group name', () => withPage(async page => {
  await page.locator('#new-group-name').fill('提交组');
  await holdPriceLock(page);
  await page.locator('#create-group-form button').click();
  await page.locator('#new-group-name').fill('下一组草稿');
  await releasePriceLock(page);
  await page.waitForFunction(() => document.querySelectorAll('.group-card').length === 2);
  assert.equal(await page.locator('#new-group-name').inputValue(), '下一组草稿');
  assert.deepEqual(await page.locator('.group-name').allTextContents(), [fixture.groups[0].name, '提交组']);
}));

test('pending edit saves one snapshot and retains newer draft fields for retry', () => withPage(async page => {
  await page.locator('[data-action=edit]').first().click();
  const form = page.locator('.item-edit-form');
  await fillItem(form, '提交名称', '10');
  await holdPriceLock(page);
  await form.locator('button[type=submit]').click();
  await fillItem(form, '继续编辑', '20');
  await releasePriceLock(page);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('toolbox_price_groups')).revision > 1);
  const item = await page.evaluate(() => JSON.parse(localStorage.getItem('toolbox_price_groups')).groups[0].items[0]);
  assert.equal(item.name, '提交名称'); assert.equal(item.totalPrice, 10);
  assert.equal(await form.count(), 1);
  assert.equal(await form.locator('[data-field=name]').inputValue(), '继续编辑');
  assert.equal(await form.locator('[data-field=totalPrice]').inputValue(), '20');
  await form.locator('button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('.item-edit-form'));
  assert.equal(await storedName(page), '继续编辑');
}));

test('redrawn pending forms stay busy and reject duplicate submissions', () => withPage(async page => {
  const form = page.locator('.group-add-item-form').first();
  await fillItem(form, '仅添加一次');
  await holdPriceLock(page);
  await form.locator('button').click();
  await page.evaluate(() => renderPriceList());
  const busy = await form.getAttribute('aria-busy');
  const disabled = await form.locator('button').isDisabled();
  // Even a programmatic/Enter submission must respect the stable identity.
  await form.evaluate(el => el.requestSubmit());
  await releasePriceLock(page);
  await page.waitForFunction(() => !document.querySelector('.group-add-item-form[aria-busy=true]'));
  assert.equal(busy, 'true'); assert.equal(disabled, true);
  const names = await page.evaluate(() => JSON.parse(localStorage.getItem('toolbox_price_groups')).groups[0].items.map(i => i.name));
  assert.equal(names.filter(name => name === '仅添加一次').length, 1);
  assert.equal(await form.locator('button').isDisabled(), false);
  assert.equal(await form.locator('[data-field=name]').inputValue(), '');
}));

test('no-Web-Locks writes block two active tabs and recover after close', () => withPage(async (page, context) => {
  assert.equal(await page.evaluate(() => navigator.locks), undefined);
  const other = await context.newPage(); await other.goto(url + '/#price');
  const form = page.locator('.group-add-item-form');
  await fillItem(form, '关闭另一页后保存');
  await form.locator('button').click();
  await page.waitForFunction(() => document.querySelector('#price-storage-status').textContent.includes('请关闭'));
  assert.equal(await page.locator('.item-card').count(), 2);
  await page.locator('#tab-counter').click(); await page.locator('#btn-plus').click();
  await page.waitForFunction(() => document.querySelector('#counter-storage-status').textContent.includes('请关闭'));
  assert.equal(await page.locator('#counter-value').textContent(), '0');
  // Navigation exercises the real pagehide release rather than deleting keys.
  await other.goto('about:blank'); await other.close();
  await page.locator('#btn-plus').click();
  await page.waitForFunction(() => document.querySelector('#counter-value').textContent === '1');
  await page.locator('#tab-price').click(); await form.locator('button').click();
  await page.waitForFunction(() => document.querySelectorAll('.item-card').length === 3);
  assert.equal(await form.locator('[data-field=name]').inputValue(), '');
}, 375, { noLocks: true }));

test('boss countdown recomputes after a clock rollback without a false spawn', () => withPage(async page => {
  // Freeze before initialization so the interval starts on the exact second.
  // A running mock clock carries navigation/action latency into its phase,
  // leaving the final tick just before the boundary on slower CI engines.
  await page.clock.install({ time: new Date('2026-09-22T18:00:00+08:00') });
  await page.clock.pauseAt(new Date('2026-09-22T18:01:00+08:00'));
  await page.reload(); await page.locator('#tab-timer').click();
  assert.equal(await page.evaluate(() => new Date().toISOString()), '2026-09-22T10:01:00.000Z');
  assert.match(await page.locator('#n-spawn').textContent(), /18:45:00/);
  await page.clock.setSystemTime(new Date('2026-09-22T17:59:00+08:00'));
  await page.clock.runFor(1000);
  assert.match(await page.locator('#n-spawn').textContent(), /18:00:00/);
  assert.equal(await page.locator('#n-m').textContent(), '00');
  assert.equal(await page.locator('#n-s').textContent(), '59');
  assert.equal(await page.locator('.boss-card.normal').evaluate(el => el.classList.contains('boss-spawned')), false);
  await page.clock.runFor(59000);
  assert.match(await page.locator('#n-spawn').textContent(), /18:45:00/);
  assert.equal(await page.locator('.boss-card.normal').evaluate(el => el.classList.contains('boss-spawned')), true);
}));

test('fallback submission retains its identity and draft through a redraw', () => withPage(async page => {
  const form = page.locator('.group-add-item-form');
  await fillItem(form, 'fallback提交');
  const state = await form.evaluate(el => {
    el.requestSubmit();
    el.querySelector('[data-field=name]').value = 'fallback下一件';
    renderPriceList();
    const replacement = document.querySelector('.group-add-item-form');
    replacement.requestSubmit();
    return { busy: replacement.getAttribute('aria-busy'), disabled: replacement.querySelector('button').disabled };
  });
  assert.deepEqual(state, { busy: 'true', disabled: true });
  await page.waitForFunction(() => document.querySelectorAll('.item-card').length === 3 && !document.querySelector('form[aria-busy=true]'));
  const names = await page.evaluate(() => JSON.parse(localStorage.getItem('toolbox_price_groups')).groups[0].items.map(i => i.name));
  assert.equal(names.filter(name => name === 'fallback提交').length, 1);
  assert.equal(names.includes('fallback下一件'), false);
  assert.equal(await form.locator('[data-field=name]').inputValue(), 'fallback下一件');
  await form.locator('button').click();
  await page.waitForFunction(() => document.querySelectorAll('.item-card').length === 4);
  assert.equal(await form.locator('[data-field=name]').inputValue(), '');
}, 375, { noLocks: true }));

test('price templates keep markup-like names as text through save and reload', () => withPage(async page => {
  const name = '<img src=x onerror="throw 1"> & \'quoted\'';
  await newGroup(page, name);
  await page.locator('[data-action=edit]').first().click();
  await page.locator('.item-edit-form [data-field=name]').fill(name);
  await page.locator('.item-edit-form button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('.item-edit-form'));
  await page.reload();
  assert.equal(await page.locator('.item-name').first().evaluate(el => el.firstChild.textContent), name);
  assert.equal(await page.locator('.group-name').last().textContent(), name);
  assert.equal(await page.locator('#price-list img').count(), 0);
  await page.locator('[data-action=edit]').first().click();
  assert.equal(await page.locator('.item-edit-form [data-field=name]').inputValue(), name);
}));

for (const action of ['delete-group', 'delete-item']) {
  test(`failed ${action} keeps the affected edit draft`, () => withPage(async page => {
    page.on('dialog', dialog => dialog.accept());
    await holdPriceLock(page);
    await page.locator(`[data-action=${action}]`).first().click();
    await page.locator('[data-action=edit]').first().click();
    await page.locator('.item-edit-form [data-field=name]').fill('删除失败仍保留');
    await page.evaluate(() => {
      window.originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === 'toolbox_price_groups') throw new DOMException('quota', 'QuotaExceededError');
        return window.originalSetItem.call(this, key, value);
      };
    });
    await releasePriceLock(page);
    await page.waitForFunction(() => document.querySelector('#price-storage-status').textContent.includes('无法保存'));
    assert.equal(await page.locator('.item-edit-form').count(), 1);
    assert.equal(await page.locator('.item-edit-form [data-field=name]').inputValue(), '删除失败仍保留');
    assert.equal(await storedName(page), fixture.groups[0].items[0].name);
    await page.evaluate(() => { Storage.prototype.setItem = window.originalSetItem; });
    await page.locator('.item-edit-form button[type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('.item-edit-form'));
    assert.equal(await storedName(page), '删除失败仍保留');
  }));
}

test('a queued item deletion does not remove a newer version of that item', () => withPage(async page => {
  await holdPriceLock(page);
  await page.locator('[data-action=delete-item][data-item-id=a]').click();
  // Persist an update before delivering its storage event, while the delete
  // is still waiting for the write lock.
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('toolbox_price_groups'));
    state.groups[0].items[0].name = '删除期间的新版商品';
    state.revision += 1;
    localStorage.setItem('toolbox_price_groups', JSON.stringify(state));
  });
  await releasePriceLock(page);
  await page.waitForFunction(() => document.querySelector('#price-storage-status').textContent.includes('变化') ||
    !document.querySelector('[data-action=delete-item][data-item-id=a]'));
  assert.equal(await storedName(page), '删除期间的新版商品');
  assert.equal(await page.locator('.item-card').count(), 2);
  await page.locator('[data-action=delete-item][data-item-id=a]').click();
  await page.waitForFunction(() => document.querySelectorAll('.item-card').length === 1);
  assert.equal(await page.locator('[data-action=edit][data-item-id=b]').count(), 1);
}));

for (const operation of ['save-edit', 'delete-group']) {
  test(`${operation} reconciles another active edit before adopting queued storage changes`, () => withPage(async page => {
    if (operation === 'delete-group') await newGroup(page, '待删除组');
    await holdPriceLock(page);
    if (operation === 'save-edit') {
      await page.locator('[data-action=edit][data-item-id=a]').click();
      await page.locator('.item-edit-form [data-field=name]').fill('保存第一件');
      await page.locator('.item-edit-form button[type=submit]').click();
    } else {
      page.once('dialog', dialog => dialog.accept());
      await page.locator('[data-action=delete-group]').last().click();
    }
    await page.locator('[data-action=edit][data-item-id=b]').click();
    await page.locator('.item-edit-form [data-field=name]').fill('第二件的旧草稿');
    await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem('toolbox_price_groups'));
      state.groups[0].items[1].name = '第二件的远端新版';
      state.revision += 1;
      localStorage.setItem('toolbox_price_groups', JSON.stringify(state));
      window.expectedRevision = state.revision + 1;
    });
    await releasePriceLock(page);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('toolbox_price_groups')).revision === window.expectedRevision);
    assert.equal(await page.locator('.item-edit-form').count(), 0);
    assert.match(await page.locator('.item-name').nth(1).textContent(), /第二件的远端新版/);
  }));
}

test('an old pending edit conflict preserves a newly opened edit of the latest version', () => withPage(async page => {
  await page.locator('[data-action=edit][data-item-id=a]').click();
  await page.locator('.item-edit-form [data-field=name]').fill('过期提交');
  await holdPriceLock(page);
  await page.locator('.item-edit-form button[type=submit]').click();
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('toolbox_price_groups'));
    state.groups[0].items[0].name = '远端新版';
    state.revision += 1;
    localStorage.setItem('toolbox_price_groups', JSON.stringify(state));
    window.dispatchEvent(new StorageEvent('storage', { key: 'toolbox_price_groups' }));
  });
  assert.equal(await page.locator('.item-edit-form').count(), 0);
  await page.locator('[data-action=edit][data-item-id=a]').click();
  await page.locator('.item-edit-form [data-field=name]').fill('基于新版的新草稿');
  await releasePriceLock(page);
  await page.waitForFunction(() => document.querySelector('#price-storage-status').textContent.includes('过期修改未保存'));
  assert.equal(await page.locator('.item-edit-form').count(), 1);
  assert.equal(await page.locator('.item-edit-form [data-field=name]').inputValue(), '基于新版的新草稿');
  assert.equal(await storedName(page), '远端新版');
  await page.locator('.item-edit-form button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('.item-edit-form'));
  assert.equal(await storedName(page), '基于新版的新草稿');
}));

test('a queued add merges data recreated with the same revision and preserves its next draft', () => withPage(async page => {
  await holdPriceLock(page);
  await page.locator('#new-group-name').fill('本页新组');
  await page.locator('#create-group-form button').click();
  await page.locator('#new-group-name').fill('下一组草稿');
  await page.evaluate(() => {
    localStorage.removeItem('toolbox_price_groups');
    localStorage.setItem('toolbox_price_groups', JSON.stringify({
      v: 1, revision: 1, groups: [{ id: 'recreated', name: '清空后重建', items: [] }],
    }));
  });
  await releasePriceLock(page);
  await page.waitForFunction(() => !document.querySelector('#create-group-form[aria-busy=true]'));
  assert.deepEqual(await page.locator('.group-name').allTextContents(), ['清空后重建', '本页新组']);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('toolbox_price_groups')));
  assert.deepEqual(saved.groups.map(g => g.name), ['清空后重建', '本页新组']);
  assert.equal(await page.locator('#new-group-name').inputValue(), '下一组草稿');
}));
