// Numeric validation and price persistence. No DOM or rendering dependencies.
const ToolboxData = (() => {
  const STORAGE_VERSION = 1;
  const PRICE_STORAGE_KEY = 'toolbox_price_groups';

  // Pure helpers are kept separate from DOM wiring so the input and persistence
  // contracts can be exercised with Node's built-in test runner.
  function parseNonNegativeFiniteNumber(value) {
    const text = value == null ? '' : String(value).trim();
    if (!text) return null;
    const number = Number(text);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function parsePositiveFiniteNumber(value) {
    const number = parseNonNegativeFiniteNumber(value);
    return number !== null && number > 0 ? number : null;
  }

  function parsePositiveInteger(value) {
    const number = parsePositiveFiniteNumber(value);
    return number !== null && Number.isSafeInteger(number) ? number : null;
  }

  function cloneGroups(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function isSafeStoredId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9-]+$/.test(value);
  }

  function normalizeStoredItem(item) {
    if (!item || typeof item !== 'object' || !isSafeStoredId(item.id)) return null;
    const unitWeight = parsePositiveFiniteNumber(item.unitWeight);
    const packSize = parsePositiveInteger(item.packSize);
    const packCount = parsePositiveInteger(item.packCount);
    const totalPrice = parsePositiveFiniteNumber(item.totalPrice);
    if (unitWeight === null || packSize === null || packCount === null || totalPrice === null ||
        calcUnitPrice({ unitWeight, packSize, packCount, totalPrice }) === null) return null;
    return {
      id: item.id,
      name: typeof item.name === 'string' ? item.name : '',
      unitWeight,
      packSize,
      packCount,
      totalPrice,
    };
  }

  function normalizeStoredGroup(group) {
    if (!group || typeof group !== 'object' || !isSafeStoredId(group.id) || !Array.isArray(group.items)) return null;
    const items = group.items.map(normalizeStoredItem).filter(Boolean);
    return {
      group: {
        id: group.id,
        name: typeof group.name === 'string' ? group.name : '',
        items,
      },
      hadInvalidData: items.length !== group.items.length,
    };
  }

  function decodeStoredGroups(raw) {
    if (!raw) return { groups: [], revision: 0, hadInvalidData: false };
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || parsed.v !== STORAGE_VERSION || !Array.isArray(parsed.groups)) {
        return { groups: [], revision: 0, hadInvalidData: true };
      }
      const normalized = parsed.groups.map(normalizeStoredGroup);
      const groups = normalized.filter(Boolean).map(result => result.group);
      const revisionValid = parsed.revision == null ||
        (Number.isSafeInteger(parsed.revision) && parsed.revision >= 0);
      return {
        groups,
        revision: revisionValid && parsed.revision != null ? parsed.revision : 0,
        hadInvalidData: !revisionValid || groups.length !== parsed.groups.length ||
          normalized.some(result => result && result.hadInvalidData),
      };
    } catch (e) {
      return { groups: [], revision: 0, hadInvalidData: true };
    }
  }

  function calcUnitPrice(item) {
    const totalWeight = item.unitWeight * item.packSize * item.packCount;
    const unitPrice = item.totalPrice / totalWeight;
    if (!Number.isFinite(totalWeight) || totalWeight <= 0 ||
        !Number.isFinite(unitPrice) || unitPrice <= 0 || !Number.isFinite(unitPrice * 100)) return null;
    return unitPrice;
  }

  const PRICE_EPSILON = 1e-9;

  // Compute { id, up } for every item in one pass so downstream code
  // (cheapest detection, display, summary) can reuse the results.
  function computeUnitPrices(items) {
    return items.map(item => ({ id: item.id, up: calcUnitPrice(item) }));
  }

  function findCheapestInGroup(unitPrices) {
    const priced = unitPrices.filter(w => w.up !== null && w.up > 0);
    if (priced.length === 0) return [];
    const minPrice = Math.min(...priced.map(w => w.up));
    return priced.filter(w => Math.abs(w.up - minPrice) < PRICE_EPSILON).map(w => w.id);
  }

  function hasEditConflict(expectedItem, latestItem) {
    return !expectedItem || !latestItem || JSON.stringify(expectedItem) !== JSON.stringify(latestItem);
  }

  function findStoredItem(state, groupId, itemId) {
    const group = state.groups.find(group => group.id === groupId);
    return group && group.items.find(item => item.id === itemId);
  }

  function hasGroupSnapshotConflict(expectedGroup, latestGroup) {
    return !expectedGroup || !latestGroup || JSON.stringify(expectedGroup) !== JSON.stringify(latestGroup);
  }

  function readPriceGroups(storage) {
    return decodeStoredGroups(storage.getItem(PRICE_STORAGE_KEY));
  }

  function writePriceGroups(storage, revision, groups) {
    storage.setItem(PRICE_STORAGE_KEY, JSON.stringify({ v: STORAGE_VERSION, revision, groups }));
  }

  return {
    PRICE_STORAGE_KEY, parseNonNegativeFiniteNumber, parsePositiveFiniteNumber, parsePositiveInteger,
    cloneGroups, decodeStoredGroups, calcUnitPrice, computeUnitPrices, findCheapestInGroup,
    hasEditConflict, findStoredItem, hasGroupSnapshotConflict, readPriceGroups, writePriceGroups,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ToolboxData;
