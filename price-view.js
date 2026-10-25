// Stateless price templates. The controller owns DOM, focus and draft state.
const PriceView = (() => {
  const { computeUnitPrices, findCheapestInGroup } = typeof module !== 'undefined' && module.exports
    ? require('./data.js') : ToolboxData;

  function escHtml(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Build the summary + items HTML for a single group. Shared by the full
  // list render and the per-group partial update so they never diverge.
  function renderGroupContent(group, { editingId = null, editingGroupId = null } = {}) {
    const unitPrices = computeUnitPrices(group.items);
    const cheapestIds = new Set(findCheapestInGroup(unitPrices));
    const upById = new Map(unitPrices.map(w => [w.id, w.up]));

    const itemsHtml = group.items.length === 0
      ? '<div class="group-empty">该组暂无商品，请在下方表单中添加</div>'
      : group.items.map(item => {
          const up = upById.get(item.id);
          const isCheapest = cheapestIds.has(item.id);
          const totalWeight = item.unitWeight * item.packSize * item.packCount;
          const isEditing = editingId === item.id && editingGroupId === group.id;

          let cardClass = 'item-card';
          if (isCheapest && group.items.length > 1) cardClass += ' cheapest';
          const cheapestBadge = isCheapest && group.items.length > 1 ? '<span class="item-cheapest-badge">最划算 ✓</span>' : '';

          let body = '';
          if (isEditing) {
            body = `<div class="item-card-inner">
                <div class="item-info">
                  <div class="item-name">${escHtml(item.name)}${cheapestBadge}</div>
                  <div class="item-spec">${item.unitWeight}g × ${item.packSize}件 × ${item.packCount}套</div>
                </div>
              </div>
              <form class="item-edit-form" data-group-id="${group.id}" data-item-id="${item.id}" novalidate>
                <div class="form-field full-width">
                  <label for="edit-${group.id}-${item.id}-name">商品名称</label>
                  <input id="edit-${group.id}-${item.id}-name" class="input" type="text" data-field="name" value="${escHtml(item.name)}" aria-label="商品名称">
                </div>
                <div class="form-field">
                  <label for="edit-${group.id}-${item.id}-unitWeight">单件重量（g）</label>
                  <input id="edit-${group.id}-${item.id}-unitWeight" class="input" type="number" min="0" step="any" data-field="unitWeight" value="${item.unitWeight}" required aria-label="单品重量，单位克">
                </div>
                <div class="form-field">
                  <label for="edit-${group.id}-${item.id}-packSize">每套件数</label>
                  <input id="edit-${group.id}-${item.id}-packSize" class="input" type="number" min="1" step="1" data-field="packSize" value="${item.packSize}" aria-label="套装内数量">
                </div>
                <div class="form-field">
                  <label for="edit-${group.id}-${item.id}-packCount">购买套数</label>
                  <input id="edit-${group.id}-${item.id}-packCount" class="input" type="number" min="1" step="1" data-field="packCount" value="${item.packCount}" aria-label="套装数量">
                </div>
                <div class="form-field">
                  <label for="edit-${group.id}-${item.id}-totalPrice">总价（元）</label>
                  <input id="edit-${group.id}-${item.id}-totalPrice" class="input" type="number" min="0" step="any" data-field="totalPrice" value="${item.totalPrice}" required aria-label="总价，单位元">
                </div>
                ${operationStatus(group.id + ':edit:' + item.id)}
                <div class="item-edit-actions">
                  <button type="button" class="btn-ghost" data-action="cancel-edit" data-group-id="${group.id}" data-item-id="${item.id}">取消</button>
                  <button type="submit" class="btn-primary">保存</button>
                </div>
              </form>`;
          } else {
            body = `<div class="item-card-inner">
                <div class="item-info">
                  <div class="item-name">${escHtml(item.name)}${cheapestBadge}</div>
                  <div class="item-spec">${item.unitWeight}g × ${item.packSize}件 × ${item.packCount}套</div>
                </div>
                <div class="item-meta">
                  <div class="item-unit-price-100">${up !== null ? (up * 100).toFixed(2) : '--'} <span>元/100g</span></div>
                  <div class="item-unit-price">${up !== null ? up.toFixed(4) : '--'} 元/g</div>
                  <div class="item-total-price">共 ¥${item.totalPrice.toFixed(2)} · ${Number.isFinite(totalWeight) && totalWeight > 0 ? totalWeight.toFixed(1) : '--'} g</div>
                </div>
              </div>
              <div class="item-actions">
                <button class="btn-ghost" data-action="edit" data-group-id="${group.id}" data-item-id="${item.id}" aria-label="编辑">编辑</button>
                <button class="btn-ghost btn-delete" data-action="delete-item" data-group-id="${group.id}" data-item-id="${item.id}" aria-label="删除">删除</button>
              </div>`;
          }
          return '<div class="' + cardClass + '">' + body + '</div>';
        }).join('');

    const summaryHtml = group.items.length > 0 ? (() => {
      const priced = unitPrices.filter(w => w.up !== null && w.up > 0);
      const cheapestPrice = priced.length > 0 ? Math.min(...priced.map(w => w.up)) : null;
      const maxPrice = priced.length > 0 ? Math.max(...priced.map(w => w.up)) : null;
      if (cheapestPrice === null) return '';
      const range = cheapestPrice === maxPrice ? '¥' + (cheapestPrice * 100).toFixed(2)
        : '¥' + (cheapestPrice * 100).toFixed(2) + '～¥' + (maxPrice * 100).toFixed(2);
      const percent = ((maxPrice - cheapestPrice) / maxPrice * 100).toFixed(1);
      const saving = priced.length > 1 && Number(percent) > 0 ? ' · 最低单价低 ' + percent + '%' : '';
      return '<div class="group-summary">共 ' + group.items.length + ' 件商品 · 每 100g：' + range + saving + '</div>';
    })() : '';

    return { summaryHtml, itemsHtml };
  }

  function renderGroupCard(group, editingState) {
      const { summaryHtml, itemsHtml } = renderGroupContent(group, editingState);
      return `<div class="group-card" data-group-id="${group.id}">
        <div class="group-header">
          <h2 class="group-name">${escHtml(group.name) || '未命名组'}</h2>
          <button class="btn-ghost btn-delete" data-action="delete-group" data-group-id="${group.id}" aria-label="删除组">删除组</button>
        </div>
        ${operationStatus(group.id + ':group')}
        ${summaryHtml}
        <div class="group-items">${itemsHtml}</div>
        <div class="group-add-form">
          <form class="group-add-item-form" data-group-id="${group.id}" novalidate>
            <p class="form-hint">每套件数 × 购买套数 = 总件数</p>
            <div class="group-add-row">
              <div class="form-field field-name">
                <label for="add-${group.id}-name">商品名称</label>
                <input id="add-${group.id}-name" class="input" type="text" data-field="name" placeholder="如：纯牛奶" >
              </div>
              <div class="form-field field-unitWeight">
                <label for="add-${group.id}-unitWeight">单件重量（g）</label>
                <input id="add-${group.id}-unitWeight" class="input" type="number" data-field="unitWeight" placeholder="如：250" min="0" step="any" required>
              </div>
              <div class="form-field field-totalPrice">
                <label for="add-${group.id}-totalPrice">总价（元）</label>
                <input id="add-${group.id}-totalPrice" class="input" type="number" data-field="totalPrice" placeholder="如：59.9" min="0" step="any" required>
              </div>
              <div class="form-field field-packSize">
                <label for="add-${group.id}-packSize">每套件数</label>
                <input id="add-${group.id}-packSize" class="input" type="number" data-field="packSize" placeholder="" min="1" step="1" value="1">
              </div>
              <div class="form-field field-packCount">
                <label for="add-${group.id}-packCount">购买套数</label>
                <input id="add-${group.id}-packCount" class="input" type="number" data-field="packCount" placeholder="" min="1" step="1" value="1">
              </div>
              <button type="submit" class="btn-primary">添加商品</button>
            </div>
            ${operationStatus(group.id + ':add')}
          </form>
        </div>
      </div>`;
  }

  function operationStatus(key) {
    return `<div class="operation-status" hidden>
      <p data-status-key="${escHtml(key)}" role="status"></p>
      <button type="button" class="btn-ghost" data-dismiss-key="${escHtml(key)}">关闭提示</button>
    </div>`;
  }

  function renderConflictDrafts(drafts) {
    if (!drafts.length) return '';
    return '<h2 class="conflict-heading">冲突草稿</h2>' + drafts.map(draft => {
      const fields = draft.fields;
      const text = '商品名称：' + fields.name + '\n单件重量（g）：' + fields.unitWeight +
        '\n每套件数：' + fields.packSize + '\n购买套数：' + fields.packCount + '\n总价（元）：' + fields.totalPrice;
      return `<article class="card conflict-draft" data-draft-id="${draft.id}">
        <h3>${escHtml(draft.groupName)} · ${escHtml(fields.name) || '未命名商品'}</h3>
        <p class="conflict-message">${draft.hasLatest ? '商品已更新，未保存的输入已保留。可编辑最新版后重新填写。刷新前请复制需要的草稿。' : '商品或对比组已删除，未保存的输入已保留。刷新前请复制需要的草稿。'}</p>
        <textarea id="conflict-text-${draft.id}" class="input conflict-text" readonly rows="5" aria-label="冲突草稿内容">${escHtml(text)}</textarea>
        <div class="conflict-actions">
          <button type="button" class="btn-ghost" data-conflict-action="copy" data-draft-id="${draft.id}">复制草稿</button>
          ${draft.hasLatest ? `<button type="button" class="btn-ghost" data-conflict-action="edit" data-draft-id="${draft.id}">编辑最新版</button>` : ''}
          <button type="button" class="btn-ghost" data-conflict-action="discard" data-draft-id="${draft.id}">放弃草稿</button>
        </div>
        <p id="conflict-status-${draft.id}" class="draft-copy-status" role="status"></p>
      </article>`;
    }).join('');
  }

  return { renderGroupContent, renderGroupCard, renderConflictDrafts };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PriceView;
