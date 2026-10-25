// Shared browser write coordination; independent of tool state and rendering.
const ToolboxStorage = (() => {
  // Keep the existing key prefix so already-open older pages remain visible.
  const PRESENCE_PREFIX = 'toolbox_price_tab_';
  const PRESENCE_TTL_MS = 5000;
  let presenceKey = null;
  let presenceTimer = null;
  let initialized = false;

  class CoordinationError extends Error {}
  function makeId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'tab-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }
  // Presence heartbeat for the no-Web-Locks fallback: it is the only signal
  // other fallback tabs use to detect this tab, so it only runs where
  // navigator.locks is missing (everywhere else it would be pure localStorage
  // churn every 2 seconds).
  function publishPresence() {
    if (!presenceKey) {
      presenceKey = PRESENCE_PREFIX + makeId();
    }
    clearInterval(presenceTimer);
    try { localStorage.setItem(presenceKey, String(Date.now())); } catch (e) {}
    presenceTimer = setInterval(() => {
      try { localStorage.setItem(presenceKey, String(Date.now())); } catch (e) {}
    }, 2000);
  }

  function stopPresence() {
    clearInterval(presenceTimer);
    presenceTimer = null;
    if (presenceKey) {
      try { localStorage.removeItem(presenceKey); } catch (e) {}
    }
  }

  function hasFreshPresence(entries, ownKey, now) {
    return entries.some(([key, value]) => {
      if (!key.startsWith(PRESENCE_PREFIX) || key === ownKey) return false;
      const timestamp = Number(value);
      const age = now - timestamp;
      return Number.isFinite(timestamp) && age >= 0 && age < PRESENCE_TTL_MS;
    });
  }

  function hasAnotherTab() {
    publishPresence();
    try {
      const now = Date.now();
      localStorage.setItem(presenceKey, String(now));
      const entries = [];
      const invalidPresenceKeys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        const value = localStorage.getItem(key);
        entries.push([key, value]);
        if (key.startsWith(PRESENCE_PREFIX) && key !== presenceKey) {
          const timestamp = Number(value);
          const age = now - timestamp;
          if (!Number.isFinite(timestamp) || age < 0 || age >= PRESENCE_TTL_MS) {
            invalidPresenceKeys.push(key);
          }
        }
      }
      invalidPresenceKeys.forEach(key => localStorage.removeItem(key));
      return hasFreshPresence(entries, presenceKey, now);
    } catch (error) {
      throw new CoordinationError('无法检查其他标签页，请重试。');
    }
  }

  function init() {
    if (initialized) return;
    initialized = true;
    if (typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function') return;
    publishPresence();
    window.addEventListener('pagehide', stopPresence);
    window.addEventListener('pageshow', publishPresence);
  }

  function runWithLock(lockManager, name, task, fallback) {
    if (lockManager && typeof lockManager.request === 'function') return lockManager.request(name, task);
    return fallback ? fallback(task) : Promise.resolve().then(task);
  }

  async function requestWrite(name, task) {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
    return runWithLock(locks, name, task, async run => {
      init();
      await new Promise(resolve => setTimeout(resolve, 100));
      if (hasAnotherTab()) {
        throw new CoordinationError('当前浏览器不支持跨标签写入锁；请关闭其他工具箱标签页后重试。');
      }
      return run();
    });
  }

  return { CoordinationError, init, requestWrite, runWithLock, hasFreshPresence, publishPresence, stopPresence };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = ToolboxStorage;
