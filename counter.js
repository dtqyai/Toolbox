const ToolboxCounter = (() => {
  const storage = typeof module !== 'undefined' && module.exports ? require('./storage.js') : ToolboxStorage;
  // Modified keys belong to the browser and OS (Cmd/Ctrl+R reload, Ctrl+'+'
  // zoom): claiming them would break those shortcuts and silently reset or
  // advance the counter.
  function shouldHandleCounterShortcut(counterActive, isTextEntry, isTabControl, hasModifier) {
    return counterActive && !isTextEntry && !isTabControl && !hasModifier;
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
      return await storage.requestWrite('toolbox-counter-write', task);
    } catch (error) {
      showCounterStatus(error instanceof storage.CoordinationError ? error.message : '无法取得写入锁，请重试。');
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

  return { initCounter, loadCounter, updateCounter, resetCounter, shouldHandleCounterShortcut };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = ToolboxCounter;
