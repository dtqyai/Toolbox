const BossTimer = (() => {
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

  return { initBossTimer, getNext, fmtCountdown };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = BossTimer;
