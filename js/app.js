// Bersales — app.js
//
// Main UI controller: screen navigation, PIN setup/lock + auto-lock,
// vault/debts/bills list+form screens, the add-document flow (type →
// scan/crop → OCR → form), a unified Home "next 30 days" feed across
// documents/bills/debts, and settings (change PIN, encrypted export).
//
// v1 scope note (see README): family profiles and dedicated vehicle/property
// record UI are still a follow-on phase — the data model (categories, vault
// CRUD, encryption) is written so that phase plugs in rather than requiring
// a rework.

(() => {
  let addFlow = null; // { docType, category, imageDataUrls: [] }
  let addingAnotherPage = false; // true while the scan screen was re-entered via "+ Add Another Page"
  let editingDocId = null;
  let editingDebtId = null;
  let editingBillId = null;
  let editingCardId = null;
  let activeBillsTab = 'bills'; // 'bills' | 'creditcards'
  let editingHealthId = null;
  let editingTodoId = null;
  let activeMoreTab = 'health'; // 'health' | 'todos'
  let cropState = null; // { canvas, corners:[{x,y}...], scale }
  let lastActivity = Date.now();

  function peso(n) {
    const num = Number(n) || 0;
    return '₱' + num.toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  // --- Theme (System / Light / Dark) ------------------------------------
  //
  // The actual System/Light/Dark CHOICE lives in localStorage, not the
  // encrypted vault — it's a UI preference, not personal data, and it needs
  // to be readable before the vault is even unlocked (the inline script in
  // <head> reads it synchronously to avoid a flash of the wrong theme on
  // launch). THEME_COLORS below must stay in sync with the --bg values in
  // css/styles.css — there's no way to read a CSS custom property's value
  // for a theme that isn't currently applied, so it's duplicated here on
  // purpose rather than fought around.

  const THEME_KEY = 'bersales_theme';
  const THEME_COLORS = { dark: '#0b0b0c', light: '#faf9f7' };

  function getThemePref() {
    return localStorage.getItem(THEME_KEY) || 'system';
  }

  function resolveTheme(pref) {
    if (pref === 'system') {
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    return pref;
  }

  function applyTheme() {
    const resolved = resolveTheme(getThemePref());
    document.documentElement.setAttribute('data-theme', resolved);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLORS[resolved]);
  }

  function setThemePref(pref) {
    localStorage.setItem(THEME_KEY, pref);
    applyTheme();
  }

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (getThemePref() === 'system') applyTheme();
    });
  }

  document.getElementById('theme-select').addEventListener('change', (e) => {
    setThemePref(e.target.value);
  });

  // --- Auto-Lock (idle timeout) -----------------------------------------
  //
  // Same reasoning as the theme preference above: this is a UI/security
  // setting, not vault data, so it lives in plain localStorage rather than
  // the encrypted store — it needs to be readable by the idle-check
  // interval below regardless of lock state. Only 3 or 5 minutes are
  // offered, per spec; getAutoLockMinutes() still falls back sanely if
  // localStorage ever holds something else (a stale value from a future
  // version, manual tampering, etc.).

  const AUTOLOCK_KEY = 'bersales_autolock_minutes';
  const AUTOLOCK_DEFAULT_MINUTES = 5;

  function getAutoLockMinutes() {
    const stored = Number(localStorage.getItem(AUTOLOCK_KEY));
    return stored === 3 || stored === 5 ? stored : AUTOLOCK_DEFAULT_MINUTES;
  }

  function getAutoLockMs() {
    return getAutoLockMinutes() * 60 * 1000;
  }

  function setAutoLockPref(minutes) {
    localStorage.setItem(AUTOLOCK_KEY, String(minutes));
  }

  document.getElementById('autolock-select').addEventListener('change', (e) => {
    setAutoLockPref(Number(e.target.value));
  });

  // --- Screen navigation -----------------------------------------------

  function showScreen(name) {
    document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
    const el = document.getElementById('screen-' + name);
    if (el) el.classList.add('active');
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.nav === name);
    });
    if (name === 'home') renderHome();
    if (name === 'vault') renderVault();
    if (name === 'debts') renderDebts();
    if (name === 'bills') renderBills();
    if (name === 'more') renderMore();
  }

  document.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.nav === 'add-type') {
        addFlow = null;
        editingDocId = null;
        populateAddTypeSelect();
      }
      showScreen(btn.dataset.nav);
    });
  });
  document.querySelectorAll('[data-back]').forEach((btn) => {
    btn.addEventListener('click', () => showScreen(btn.dataset.back));
  });
  document.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.action === 'add-debt') openDebtForEdit(null);
      if (btn.dataset.action === 'add-bill') openBillForEdit(null);
    });
  });

  function unlockedUI(show) {
    document.getElementById('bottom-nav').hidden = !show;
  }

  // --- Activity tracking / auto-lock -----------------------------------

  ['click', 'touchstart', 'keydown'].forEach((ev) =>
    document.addEventListener(ev, () => { lastActivity = Date.now(); })
  );
  setInterval(() => {
    if (Crypto.isUnlocked() && Date.now() - lastActivity > getAutoLockMs()) {
      lockVault();
    }
  }, 15000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && Crypto.isUnlocked()) lockVault();
  });

  function lockVault() {
    Crypto.lock();
    Scanner.stopCamera();
    unlockedUI(false);
    document.getElementById('pin-lock-input').value = '';
    showScreen('lock');
  }

  // --- PIN setup / unlock -----------------------------------------------

  document.getElementById('btn-pin-setup-submit').addEventListener('click', async () => {
    const p1 = document.getElementById('pin-setup-1').value;
    const p2 = document.getElementById('pin-setup-2').value;
    const errEl = document.getElementById('pin-setup-error');
    if (p1.length < 4) { errEl.textContent = 'Use at least 4 characters.'; return; }
    if (p1 !== p2) { errEl.textContent = "PINs don't match."; return; }
    errEl.textContent = '';
    await Crypto.setupPin(p1);
    unlockedUI(true);
    showScreen('home');
  });

  document.getElementById('btn-pin-unlock').addEventListener('click', async () => {
    const pin = document.getElementById('pin-lock-input').value;
    const errEl = document.getElementById('pin-lock-error');
    const ok = await Crypto.unlockWithPin(pin);
    if (!ok) { errEl.textContent = 'Incorrect PIN.'; return; }
    errEl.textContent = '';
    document.getElementById('pin-lock-input').value = '';
    unlockedUI(true);
    showScreen('home');
  });

  // --- Home ----------------------------------------------------------------
  //
  // Aggregates documents, bills, and debts into one feed, all using the same
  // statusForDate() semantics (see reminders.js) so a bill due in 5 days and
  // a document expiring in 5 days get identical status-pill treatment.

  async function buildHomeItems() {
    const [docs, bills, debts, cards, healthItems, todos] = await Promise.all([
      Vault.getAllDocuments(), Bills.getAllBills(), Debts.getAllDebts(), CreditCards.getAllCards(),
      Health.getAllReminders(), Todos.getAllTodos()
    ]);
    const items = [];

    docs.forEach((doc) => {
      const r = Reminders.statusFor(doc);
      if (r.status === 'none') return;
      const template = DOC_TYPES[doc.docType];
      items.push({
        kind: 'document', id: doc.id,
        title: template ? template.label : doc.docType,
        sub: daysLeftText(r.daysLeft),
        status: r.status, daysLeft: r.daysLeft
      });
    });

    bills.forEach((bill) => {
      if (bill.paid) return;
      const r = Bills.statusFor(bill);
      if (r.status === 'none') return;
      items.push({
        kind: 'bill', id: bill.id,
        title: bill.billName || 'Bill',
        sub: `${peso(bill.amount)} — ${daysLeftText(r.daysLeft)}`,
        status: r.status, daysLeft: r.daysLeft
      });
    });

    debts.forEach((debt) => {
      if (debt.settled) return;
      const r = Debts.statusFor(debt);
      if (r.status === 'none') return;
      const verb = debt.direction === 'i_owe' ? 'You owe' : 'Owes you';
      items.push({
        kind: 'debt', id: debt.id,
        title: debt.personName || 'Debt',
        sub: `${verb} ${peso(debt.outstandingBalance)} — ${daysLeftText(r.daysLeft)}`,
        status: r.status, daysLeft: r.daysLeft
      });
    });

    cards.forEach((card) => {
      const name = card.cardName || 'Credit Card';
      if (card.statementCutoffDay) {
        const r = CreditCards.cutoffStatus(card);
        if (r.status !== 'none') {
          items.push({
            kind: 'creditcard', id: card.id,
            title: `${name} — Statement Cutoff`,
            sub: daysLeftText(r.daysLeft),
            status: r.status, daysLeft: r.daysLeft
          });
        }
      }
      if (card.paymentDueDay) {
        const r = CreditCards.dueStatus(card);
        if (r.status !== 'none') {
          items.push({
            kind: 'creditcard', id: card.id,
            title: `${name} — Payment Due`,
            sub: daysLeftText(r.daysLeft),
            status: r.status, daysLeft: r.daysLeft
          });
        }
      }
    });

    healthItems.forEach((item) => {
      if (item.done) return;
      const r = Health.statusFor(item);
      if (r.status === 'none') return;
      const typeLabel = (HEALTH_TYPES.find((t) => t.id === item.type) || {}).label || 'Health';
      items.push({
        kind: 'health', id: item.id,
        title: item.reminderName || typeLabel,
        sub: `${typeLabel} — ${daysLeftText(r.daysLeft)}`,
        status: r.status, daysLeft: r.daysLeft
      });
    });

    todos.forEach((todo) => {
      if (todo.done || !todo.dueDate) return;
      const r = Reminders.statusForDate(todo.dueDate);
      if (r.status === 'none') return;
      items.push({
        kind: 'todo', id: todo.id,
        title: todo.title || 'To-Do',
        sub: daysLeftText(r.daysLeft),
        status: r.status, daysLeft: r.daysLeft
      });
    });

    return items;
  }

  function daysLeftText(daysLeft) {
    return daysLeft < 0 ? `Expired ${Math.abs(daysLeft)}d ago` : `${daysLeft}d left`;
  }

  async function computeTotalOwedRightNow() {
    // Deliberately excludes "owed to you" — mixing a liability total with
    // money coming back to you would make the headline number misleading.
    const [bills, debts, cards] = await Promise.all([Bills.getAllBills(), Debts.getAllDebts(), CreditCards.getAllCards()]);
    const unpaidBills = bills.filter((b) => !b.paid).reduce((sum, b) => sum + (Number(b.amount) || 0), 0);
    const debtsIOwe = debts.filter((d) => d.direction === 'i_owe' && !d.settled)
      .reduce((sum, d) => sum + (Number(d.outstandingBalance) || 0), 0);
    const cardsDue = cards.reduce((sum, c) => sum + (Number(c.amountDue) || 0), 0);
    return unpaidBills + debtsIOwe + cardsDue;
  }

  async function renderHome() {
    const items = await buildHomeItems();
    document.getElementById('home-total-owed').textContent = peso(await computeTotalOwedRightNow());
    const next30 = items.filter((i) => i.daysLeft !== null && i.daysLeft <= 30).sort((a, b) => a.daysLeft - b.daysLeft);
    const attention = items.filter((i) => i.status === 'critical_expired' || i.status === 'attention')
      .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));

    const next30El = document.getElementById('home-next30');
    next30El.innerHTML = next30.length
      ? next30.map(renderReminderRow).join('')
      : '<p class="empty-state">Nothing due in the next 30 days.</p>';

    const attentionEl = document.getElementById('home-attention');
    attentionEl.innerHTML = attention.length
      ? attention.map(renderReminderRow).join('')
      : '<p class="empty-state">Nothing needs attention right now.</p>';

    document.querySelectorAll('#home-next30 .doc-card, #home-attention .doc-card').forEach((card) => {
      card.addEventListener('click', () => openHomeItem(card.dataset.kind, card.dataset.id));
    });
  }

  function openHomeItem(kind, id) {
    if (kind === 'document') openDocForEdit(id);
    if (kind === 'bill') openBillForEdit(id);
    if (kind === 'debt') openDebtForEdit(id);
    if (kind === 'creditcard') { activeBillsTab = 'creditcards'; showScreen('bills'); openCreditCardForEdit(id); }
    if (kind === 'health') { activeMoreTab = 'health'; showScreen('more'); openHealthForEdit(id); }
    if (kind === 'todo') { activeMoreTab = 'todos'; showScreen('more'); openTodoForEdit(id); }
  }

  function renderReminderRow(item) {
    return `<div class="doc-card" data-kind="${item.kind}" data-id="${item.id}">
      <div><div class="doc-card-title">${escapeHtml(item.title)}</div><div class="doc-card-sub">${escapeHtml(item.sub)}</div></div>
      <span class="status-pill status-${item.status}">${Reminders.STATUS_LABELS[item.status]}</span>
    </div>`;
  }

  // --- Vault ---------------------------------------------------------------

  let activeCategoryFilter = 'all';

  async function renderVault() {
    const chipRow = document.getElementById('vault-category-filter');
    chipRow.innerHTML = ['all', ...CATEGORIES.map((c) => c.id)]
      .map((id) => {
        const label = id === 'all' ? 'All' : CATEGORIES.find((c) => c.id === id).label;
        return `<div class="chip ${activeCategoryFilter === id ? 'active' : ''}" data-cat="${id}">${label}</div>`;
      }).join('');
    chipRow.querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => { activeCategoryFilter = chip.dataset.cat; renderVault(); });
    });

    const docs = await Vault.getAllDocuments();
    const filtered = activeCategoryFilter === 'all' ? docs : docs.filter((d) => d.category === activeCategoryFilter);

    const listEl = document.getElementById('vault-list');
    document.getElementById('vault-empty').hidden = filtered.length !== 0;
    listEl.innerHTML = filtered.map((doc) => {
      const template = DOC_TYPES[doc.docType];
      const label = template ? template.label : doc.docType;
      const status = Reminders.statusFor(doc);
      return `<div class="doc-card" data-id="${doc.id}">
        <div><div class="doc-card-title">${escapeHtml(label)}</div><div class="doc-card-sub">${escapeHtml(primaryFieldValue(doc))}</div></div>
        <span class="status-pill status-${status.status}">${Reminders.STATUS_LABELS[status.status]}</span>
      </div>`;
    }).join('');
    listEl.querySelectorAll('.doc-card').forEach((card) => {
      card.addEventListener('click', () => openDocForEdit(card.dataset.id));
    });
  }

  function primaryFieldValue(doc) {
    const template = DOC_TYPES[doc.docType];
    if (!template) return '';
    const nameField = template.fields.find((f) => /Name$|^fullName$|^title$|^itemName$/.test(f));
    if (nameField && doc.fields[nameField]) return doc.fields[nameField];
    // LTOPF and PTCFOR have no person-name field at all (they're defined by
    // the firearm's own details, not the holder's name) — fall back to the
    // type's first field so the Vault card subtitle isn't left blank.
    const firstField = template.fields[0];
    return (firstField && doc.fields[firstField]) || '';
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // --- Add-document flow: Step 1 (type) -----------------------------------

  function populateAddTypeSelect() {
    const sel = document.getElementById('add-type-select');
    sel.innerHTML = Object.entries(DOC_TYPES)
      .map(([key, t]) => `<option value="${key}">${escapeHtml(t.label)}</option>`)
      .join('');
  }

  document.getElementById('btn-add-type-next').addEventListener('click', () => {
    const docType = document.getElementById('add-type-select').value;
    addFlow = { docType, category: DOC_TYPES[docType].category, imageDataUrls: [] };
    showScreen('scan');
    startScanScreen();
  });

  // --- Add-document flow: Step 2 (scan + crop) ----------------------------

  async function startScanScreen() {
    const video = document.getElementById('scan-video');
    document.getElementById('scan-canvas').hidden = true;
    document.getElementById('scan-crop-overlay').hidden = true;
    document.getElementById('crop-controls').hidden = true;
    document.getElementById('scan-controls').hidden = false;
    video.hidden = false;
    try {
      await Scanner.startCamera(video);
    } catch (e) {
      alert('Camera access was denied or unavailable. You can still enter this document manually.');
    }
  }

  document.getElementById('btn-scan-skip').addEventListener('click', () => {
    Scanner.stopCamera();
    if (addingAnotherPage) {
      addingAnotherPage = false;
      showScreen('doc-form');
    } else {
      addFlow.imageDataUrls = [];
      goToDocForm();
    }
  });

  // Tap-to-focus on the live preview — the same gesture CamScanner/most
  // camera apps use when autofocus guesses wrong on a close-up, low-contrast
  // document. Bound once here (not inside startScanScreen, which re-runs on
  // every retake) so it doesn't pile up duplicate listeners across retakes.
  // Scanner.focusAt() is a quiet no-op on devices/browsers that don't expose
  // focus control, so this is always safe to attempt.
  document.getElementById('scan-video').addEventListener('click', async (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const xFrac = (e.clientX - rect.left) / rect.width;
    const yFrac = (e.clientY - rect.top) / rect.height;
    const supported = await Scanner.focusAt(xFrac, yFrac);
    if (supported) showFocusRing(e.clientX, e.clientY);
  });

  function showFocusRing(clientX, clientY) {
    const body = document.querySelector('.scan-body');
    const bodyRect = body.getBoundingClientRect();
    const ring = document.createElement('div');
    ring.className = 'focus-ring';
    ring.style.left = (clientX - bodyRect.left) + 'px';
    ring.style.top = (clientY - bodyRect.top) + 'px';
    body.appendChild(ring);
    setTimeout(() => ring.remove(), 500);
  }

  document.getElementById('btn-scan-capture').addEventListener('click', () => {
    const canvas = Scanner.capturePhoto();
    Scanner.stopCamera();
    document.getElementById('scan-video').hidden = true;
    document.getElementById('scan-controls').hidden = true;
    setupCropUI(canvas);
  });

  // Import from gallery: feeds the same crop/enhance pipeline as a camera
  // capture, just skipping getUserMedia entirely.
  document.getElementById('btn-scan-import').addEventListener('click', () => {
    document.getElementById('scan-file-input').click();
  });

  document.getElementById('scan-file-input').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;
    const img = new Image();
    const url = URL.createObjectURL(file);
    try {
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });
    } catch (err) {
      alert("Couldn't read that image. Please try another file.");
      return;
    } finally {
      URL.revokeObjectURL(url);
    }
    Scanner.stopCamera();
    document.getElementById('scan-video').hidden = true;
    document.getElementById('scan-controls').hidden = true;
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    setupCropUI(canvas);
  });

  function setupCropUI(sourceCanvas) {
    const displayCanvas = document.getElementById('scan-canvas');
    displayCanvas.hidden = false;
    displayCanvas.width = sourceCanvas.width;
    displayCanvas.height = sourceCanvas.height;
    displayCanvas.getContext('2d').drawImage(sourceCanvas, 0, 0);

    const corners = Scanner.autoDetectCorners(sourceCanvas);
    cropState = { canvas: sourceCanvas, corners };

    const overlay = document.getElementById('scan-crop-overlay');
    overlay.hidden = false;
    overlay.innerHTML = `
      <svg class="crop-svg" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;">
        <polygon id="crop-poly" fill="rgba(249,8,2,0.15)" stroke="#f90802" stroke-width="2"></polygon>
      </svg>
      ${corners.map((_, i) => `<div class="crop-handle" data-idx="${i}" style="position:absolute;width:36px;height:36px;margin:-18px;border-radius:50%;background:#f90802;border:3px solid white;touch-action:none;"></div>`).join('')}
    `;
    updateHandlePositions();
    overlay.querySelectorAll('.crop-handle').forEach((handle) => {
      handle.addEventListener('pointerdown', (e) => {
        handle.setPointerCapture(e.pointerId);
        // The rect/scale are fixed for the whole drag (the canvas doesn't
        // resize mid-drag), so they're computed once here instead of inside
        // onMove — the previous version called getBoundingClientRect() on
        // every single pointermove, forcing a layout reflow each time, which
        // is what made corner dragging feel laggy/unresponsive. Pending
        // moves are also coalesced to one requestAnimationFrame callback,
        // since pointermove can fire far faster than the screen can repaint.
        const rect = displayCanvas.getBoundingClientRect();
        const scaleX = sourceCanvas.width / rect.width;
        const scaleY = sourceCanvas.height / rect.height;
        let pendingPoint = null;
        let rafScheduled = false;
        const applyPending = () => {
          rafScheduled = false;
          if (!pendingPoint) return;
          cropState.corners[handle.dataset.idx].x = pendingPoint.x;
          cropState.corners[handle.dataset.idx].y = pendingPoint.y;
          updateHandlePositions();
        };
        const onMove = (moveEv) => {
          const relX = Math.min(Math.max(moveEv.clientX - rect.left, 0), rect.width);
          const relY = Math.min(Math.max(moveEv.clientY - rect.top, 0), rect.height);
          pendingPoint = { x: relX * scaleX, y: relY * scaleY };
          if (!rafScheduled) {
            rafScheduled = true;
            requestAnimationFrame(applyPending);
          }
        };
        const onUp = () => {
          handle.removeEventListener('pointermove', onMove);
          handle.removeEventListener('pointerup', onUp);
          handle.removeEventListener('pointercancel', onUp);
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        // pointercancel (the system interrupting the gesture — e.g. an
        // incoming call, or the OS claiming the touch for a system
        // gesture) was previously unhandled, leaving the pointermove
        // listener attached and making the next drag on that handle behave
        // erratically.
        handle.addEventListener('pointercancel', onUp);
      });
    });

    document.getElementById('crop-controls').hidden = false;
  }

  function updateHandlePositions() {
    const displayCanvas = document.getElementById('scan-canvas');
    const rect = displayCanvas.getBoundingClientRect();
    const overlay = document.getElementById('scan-crop-overlay');
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
    const scaleX = rect.width / displayCanvas.width;
    const scaleY = rect.height / displayCanvas.height;
    overlay.querySelectorAll('.crop-handle').forEach((handle) => {
      const c = cropState.corners[handle.dataset.idx];
      handle.style.left = (c.x * scaleX) + 'px';
      handle.style.top = (c.y * scaleY) + 'px';
    });
    const poly = document.getElementById('crop-poly');
    if (poly) {
      poly.setAttribute('points', cropState.corners.map((c) => `${c.x * scaleX},${c.y * scaleY}`).join(' '));
    }
  }

  document.getElementById('btn-crop-retake').addEventListener('click', () => {
    cropState = null;
    startScanScreen();
    document.getElementById('crop-controls').hidden = true;
  });

  document.getElementById('btn-crop-apply').addEventListener('click', () => {
    // 1200x1680 / quality 0.92: bumped up from an earlier lower-res/quality
    // default specifically so small print (serial numbers, MRZ lines) stays
    // legible — document photos aren't casual photos, text fidelity matters
    // more here than file size.
    const outW = 1200, outH = 1680;
    let warped = Scanner.warpToRectangle(cropState.canvas, cropState.corners, outW, outH);
    if (document.getElementById('crop-enhance-toggle').checked) {
      warped = Scanner.enhanceCanvas(warped);
    }
    addFlow.imageDataUrls = addFlow.imageDataUrls || [];
    addFlow.imageDataUrls.push(warped.toDataURL('image/jpeg', 0.92));

    if (addingAnotherPage) {
      // Returning from "+ Add Another Page" — go straight back to the form
      // and just refresh the thumbnail strip. Do NOT re-run goToDocForm(),
      // which would re-run OCR and rebuild the form, wiping out whatever
      // the user already typed.
      addingAnotherPage = false;
      showScreen('doc-form');
      renderImagePreviewStrip();
    } else {
      goToDocForm();
    }
  });

  document.getElementById('btn-doc-add-page').addEventListener('click', () => {
    addingAnotherPage = true;
    showScreen('scan');
    startScanScreen();
  });

  function renderImagePreviewStrip() {
    const list = document.getElementById('doc-form-image-list');
    const urls = (addFlow && addFlow.imageDataUrls) || [];
    list.innerHTML = urls.map((url, i) => `
      <div class="image-thumb">
        <img src="${url}" alt="Page ${i + 1}" />
        <button type="button" class="image-thumb-remove" data-remove-idx="${i}" aria-label="Remove page ${i + 1}">&times;</button>
      </div>
    `).join('');
    list.querySelectorAll('[data-remove-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        addFlow.imageDataUrls.splice(Number(btn.dataset.removeIdx), 1);
        renderImagePreviewStrip();
      });
    });
  }

  // --- Add/edit-document flow: Step 3 (form) --------------------------------

  async function goToDocForm() {
    showScreen('doc-form');
    const template = DOC_TYPES[addFlow.docType];
    document.getElementById('doc-form-title').textContent = template.label;
    document.getElementById('btn-doc-delete').hidden = true;

    renderImagePreviewStrip();
    const firstImage = (addFlow.imageDataUrls && addFlow.imageDataUrls[0]) || null;

    let guesses = {};
    const ocrStatus = document.getElementById('ocr-status');
    if (firstImage) {
      ocrStatus.hidden = false;
      ocrStatus.textContent = 'Reading document… this can take a few seconds.';
      buildForm(template, {});
      try {
        const img = new Image();
        img.src = firstImage;
        await new Promise((resolve) => { img.onload = resolve; });
        const text = await OCR.recognize(img);
        guesses = OCR.guessFields(text, addFlow.docType);
        ocrStatus.textContent = Object.keys(guesses).length
          ? 'Some fields were pre-filled from the scan — please double-check them.'
          : "Couldn't confidently read this document — please fill in the fields manually.";
      } catch (e) {
        ocrStatus.textContent = 'OCR failed — please fill in the fields manually.';
      }
    } else {
      ocrStatus.hidden = true;
    }
    buildForm(template, guesses);
  }

  function buildForm(template, prefill) {
    const form = document.getElementById('doc-form');
    form.innerHTML = template.fields.map((field) => {
      const isDate = /Date$|Expiry$/i.test(field);
      const label = (template.fieldLabels && template.fieldLabels[field]) || FIELD_LABELS[field] || field;
      let value = prefill[field] || '';
      if (isDate && value) {
        const d = new Date(value);
        value = isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
      }
      return `<div class="form-field">
        <label for="f-${field}">${escapeHtml(label)}</label>
        <input class="text-input" type="${isDate ? 'date' : 'text'}" id="f-${field}" name="${field}" value="${escapeHtml(value)}" />
      </div>`;
    }).join('');
  }

  async function openDocForEdit(id) {
    const doc = await Vault.getDocument(id);
    if (!doc) return;
    const imageDataUrls = doc.hasImage ? await Vault.getDocumentImages(id) : [];
    editingDocId = id;
    addFlow = { docType: doc.docType, category: doc.category, imageDataUrls };
    showScreen('doc-form');
    const template = DOC_TYPES[doc.docType];
    document.getElementById('doc-form-title').textContent = template.label;
    document.getElementById('btn-doc-delete').hidden = false;
    document.getElementById('ocr-status').hidden = true;
    renderImagePreviewStrip();
    buildForm(template, doc.fields);
  }

  document.getElementById('btn-doc-save').addEventListener('click', async () => {
    const template = DOC_TYPES[addFlow.docType];
    const fields = {};
    template.fields.forEach((f) => {
      const el = document.getElementById('f-' + f);
      if (el) fields[f] = el.value;
    });
    const payload = { category: addFlow.category, docType: addFlow.docType, fields, imageDataUrls: addFlow.imageDataUrls };
    if (editingDocId) {
      await Vault.updateDocument(editingDocId, payload);
    } else {
      await Vault.addDocument(payload);
    }
    // Stay on this form instead of returning to the Vault list — cleared
    // back to a blank form for the SAME document type/category (so adding
    // several of one type, e.g. multiple receipts, doesn't mean re-picking
    // the type each time). "+ Add Another Page" below still works off a
    // fresh, empty photo list. Applies after editing an existing document
    // too: a save there also clears the screen rather than showing the
    // document you just edited — worth a look if that's not what you want,
    // since unlike the other forms here, this one can't just re-open blank
    // where it started (there's no list screen in between).
    editingDocId = null;
    document.getElementById('btn-doc-delete').hidden = true;
    document.getElementById('doc-form-title').textContent = template.label;
    document.getElementById('ocr-status').hidden = true;
    addFlow = { docType: addFlow.docType, category: addFlow.category, imageDataUrls: [] };
    renderImagePreviewStrip();
    buildForm(template, {});
  });

  document.getElementById('btn-doc-delete').addEventListener('click', async () => {
    if (!editingDocId) return;
    if (!confirm('Delete this document? This cannot be undone.')) return;
    await Vault.deleteDocument(editingDocId);
    editingDocId = null;
    addFlow = null;
    showScreen('vault');
  });

  // --- Debts -----------------------------------------------------------------

  let activeDebtFilter = 'all';

  async function renderDebts() {
    const filterEl = document.getElementById('debts-filter');
    filterEl.innerHTML = [
      { id: 'all', label: 'All' },
      { id: 'i_owe', label: 'I Owe' },
      { id: 'owed_to_me', label: 'Owed to Me' }
    ].map((f) => `<div class="chip ${activeDebtFilter === f.id ? 'active' : ''}" data-filter="${f.id}">${f.label}</div>`).join('');
    filterEl.querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => { activeDebtFilter = chip.dataset.filter; renderDebts(); });
    });

    const debts = await Debts.getAllDebts();
    const totalIOwe = debts.filter((d) => d.direction === 'i_owe' && !d.settled)
      .reduce((sum, d) => sum + (Number(d.outstandingBalance) || 0), 0);
    const totalOwedToMe = debts.filter((d) => d.direction === 'owed_to_me' && !d.settled)
      .reduce((sum, d) => sum + (Number(d.outstandingBalance) || 0), 0);
    document.getElementById('debts-total-i-owe').textContent = peso(totalIOwe);
    document.getElementById('debts-total-owed-to-me').textContent = peso(totalOwedToMe);

    const filtered = activeDebtFilter === 'all' ? debts : debts.filter((d) => d.direction === activeDebtFilter);
    const listEl = document.getElementById('debts-list');
    document.getElementById('debts-empty').hidden = filtered.length !== 0;
    listEl.innerHTML = filtered.map((debt) => {
      const status = Debts.statusFor(debt);
      const verb = debt.direction === 'i_owe' ? 'You owe' : 'Owes you';
      const sub = `${verb} ${peso(debt.outstandingBalance)}${debt.dueDate ? ' — due ' + debt.dueDate : ''}`;
      return `<div class="doc-card" data-id="${debt.id}">
        <div><div class="doc-card-title">${escapeHtml(debt.personName || 'Unnamed')}</div><div class="doc-card-sub">${escapeHtml(sub)}</div></div>
        <span class="status-pill status-${debt.settled ? 'good' : status.status}">${debt.settled ? 'Settled' : Reminders.STATUS_LABELS[status.status]}</span>
      </div>`;
    }).join('');
    listEl.querySelectorAll('.doc-card').forEach((card) => {
      card.addEventListener('click', () => openDebtForEdit(card.dataset.id));
    });
  }

  async function openDebtForEdit(id) {
    editingDebtId = id;
    showScreen('debt-form');
    document.getElementById('btn-debt-delete').hidden = !id;
    document.getElementById('debt-payment-log-section').hidden = !id;

    let debt = { direction: 'i_owe', personName: '', originalAmount: '', outstandingBalance: '', dueDate: '', recurring: false, installmentAmount: '', interestNote: '', notes: '', settled: false, paymentHistory: [] };
    if (id) {
      const existing = await Debts.getDebt(id);
      if (existing) debt = existing;
    }
    document.getElementById('debt-form-title').textContent = id ? 'Edit Debt' : 'Add Debt';
    document.getElementById('debt-direction').value = debt.direction;
    document.getElementById('debt-personName').value = debt.personName;
    document.getElementById('debt-originalAmount').value = debt.originalAmount;
    document.getElementById('debt-outstandingBalance').value = debt.outstandingBalance;
    document.getElementById('debt-dueDate').value = debt.dueDate;
    document.getElementById('debt-recurring').checked = !!debt.recurring;
    document.getElementById('debt-installmentAmount').value = debt.installmentAmount;
    document.getElementById('debt-interestNote').value = debt.interestNote;
    document.getElementById('debt-notes').value = debt.notes;
    document.getElementById('debt-settled').checked = !!debt.settled;
    renderPaymentList(debt.paymentHistory || []);
  }

  function renderPaymentList(paymentHistory) {
    const el = document.getElementById('debt-payment-list');
    el.innerHTML = paymentHistory.length
      ? [...paymentHistory].reverse().map((p) => `<div class="payment-row"><span>${escapeHtml(p.date || '')}</span><span>${peso(p.amount)}</span></div>`).join('')
      : '<p class="empty-state">No payments logged yet.</p>';
  }

  document.getElementById('btn-debt-add-payment').addEventListener('click', async () => {
    if (!editingDebtId) return;
    const amount = document.getElementById('debt-payment-amount').value;
    const date = document.getElementById('debt-payment-date').value;
    if (!amount || !date) { alert('Enter both an amount and a date to log a payment.'); return; }
    const updated = await Debts.addPayment(editingDebtId, { amount, date });
    renderPaymentList(updated.paymentHistory);
    document.getElementById('debt-payment-amount').value = '';
    document.getElementById('debt-payment-date').value = '';
  });

  document.getElementById('btn-debt-save').addEventListener('click', async () => {
    const payload = {
      direction: document.getElementById('debt-direction').value,
      personName: document.getElementById('debt-personName').value,
      originalAmount: document.getElementById('debt-originalAmount').value,
      outstandingBalance: document.getElementById('debt-outstandingBalance').value,
      dueDate: document.getElementById('debt-dueDate').value,
      recurring: document.getElementById('debt-recurring').checked,
      installmentAmount: document.getElementById('debt-installmentAmount').value,
      interestNote: document.getElementById('debt-interestNote').value,
      notes: document.getElementById('debt-notes').value,
      settled: document.getElementById('debt-settled').checked
    };
    if (editingDebtId) {
      await Debts.updateDebt(editingDebtId, payload);
    } else {
      await Debts.addDebt(payload);
    }
    // Stay on this form instead of returning to the Debts list — clears back
    // to a blank "Add Debt" state (openDebtForEdit already knows how to do
    // that when passed no id) so another entry can be logged right away.
    // Applies after editing an existing debt too, not just adding a new one.
    openDebtForEdit(null);
  });

  document.getElementById('btn-debt-delete').addEventListener('click', async () => {
    if (!editingDebtId) return;
    if (!confirm('Delete this debt record? This cannot be undone.')) return;
    await Debts.deleteDebt(editingDebtId);
    editingDebtId = null;
    showScreen('debts');
  });

  // --- Bills -------------------------------------------------------------------

  function populateBillCategorySelect() {
    const sel = document.getElementById('bill-category');
    sel.innerHTML = BILL_CATEGORIES.map((c) => `<option value="${c.id}">${escapeHtml(c.label)}</option>`).join('');
  }

  async function renderBills() {
    const tabs = [{ id: 'bills', label: 'Bills' }, { id: 'creditcards', label: 'Credit Cards' }];
    const chipRow = document.getElementById('bills-tab-filter');
    chipRow.innerHTML = tabs.map((t) =>
      `<div class="chip ${activeBillsTab === t.id ? 'active' : ''}" data-tab="${t.id}">${t.label}</div>`
    ).join('');
    chipRow.querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => { activeBillsTab = chip.dataset.tab; renderBills(); });
    });

    document.getElementById('bills-list').hidden = activeBillsTab !== 'bills';
    document.getElementById('bills-empty').hidden = activeBillsTab !== 'bills';
    document.getElementById('creditcards-list').hidden = activeBillsTab !== 'creditcards';
    document.getElementById('creditcards-empty').hidden = activeBillsTab !== 'creditcards';

    if (activeBillsTab === 'bills') {
      await renderBillsList();
    } else {
      await renderCreditCardsList();
    }
  }

  function renderSummaryRow(tiles, elId) {
    document.getElementById(elId).innerHTML = tiles.map((t) =>
      `<div class="summary-tile"><div class="summary-label">${escapeHtml(t.label)}</div><div class="summary-amount ${t.colorClass || 'summary-amount-danger'}">${peso(t.amount)}</div></div>`
    ).join('');
  }

  async function renderBillsList() {
    const bills = await Bills.getAllBills();
    const totalUnpaid = bills.filter((b) => !b.paid).reduce((sum, b) => sum + (Number(b.amount) || 0), 0);
    const monthlyRecurring = Bills.totalMonthlyRecurring(bills);
    renderSummaryRow([
      { label: 'Total Unpaid', amount: totalUnpaid, colorClass: 'summary-amount-danger' },
      { label: 'Monthly Recurring (est.)', amount: monthlyRecurring, colorClass: 'summary-amount-info' }
    ], 'bills-summary');

    const listEl = document.getElementById('bills-list');
    document.getElementById('bills-empty').hidden = bills.length !== 0 || activeBillsTab !== 'bills';
    listEl.innerHTML = bills.map((bill) => {
      const status = Bills.statusFor(bill);
      const catLabel = (BILL_CATEGORIES.find((c) => c.id === bill.category) || {}).label || bill.category;
      const sub = `${catLabel} — ${peso(bill.amount)}${bill.dueDate ? ' — due ' + bill.dueDate : ''}`;
      return `<div class="doc-card">
        <div class="doc-card-clickarea" data-id="${bill.id}" style="flex:1;cursor:pointer;">
          <div class="doc-card-title">${escapeHtml(bill.billName || 'Bill')}</div><div class="doc-card-sub">${escapeHtml(sub)}</div>
        </div>
        <label class="bill-paid-toggle"><input type="checkbox" data-paid-toggle="${bill.id}" ${bill.paid ? 'checked' : ''} /> Paid</label>
      </div>`;
    }).join('');
    listEl.querySelectorAll('.doc-card-clickarea').forEach((el) => {
      el.addEventListener('click', () => openBillForEdit(el.dataset.id));
    });
    listEl.querySelectorAll('[data-paid-toggle]').forEach((checkbox) => {
      checkbox.addEventListener('click', (e) => e.stopPropagation());
      checkbox.addEventListener('change', async () => {
        await Bills.togglePaid(checkbox.dataset.paidToggle);
        renderBillsList();
      });
    });
  }

  async function openBillForEdit(id) {
    editingBillId = id;
    showScreen('bill-form');
    document.getElementById('btn-bill-delete').hidden = !id;

    let bill = { billName: '', category: 'other', amount: '', dueDate: '', recurring: 'none', notes: '', paid: false };
    if (id) {
      const existing = await Bills.getBill(id);
      if (existing) bill = existing;
    }
    document.getElementById('bill-form-title').textContent = id ? 'Edit Bill' : 'Add Bill';
    document.getElementById('bill-billName').value = bill.billName;
    document.getElementById('bill-category').value = bill.category;
    document.getElementById('bill-amount').value = bill.amount;
    document.getElementById('bill-dueDate').value = bill.dueDate;
    document.getElementById('bill-recurring').value = bill.recurring;
    document.getElementById('bill-notes').value = bill.notes;
    document.getElementById('bill-paid').checked = !!bill.paid;
  }

  document.getElementById('btn-bill-save').addEventListener('click', async () => {
    const payload = {
      billName: document.getElementById('bill-billName').value,
      category: document.getElementById('bill-category').value,
      amount: document.getElementById('bill-amount').value,
      dueDate: document.getElementById('bill-dueDate').value,
      recurring: document.getElementById('bill-recurring').value,
      notes: document.getElementById('bill-notes').value,
      paid: document.getElementById('bill-paid').checked
    };
    if (editingBillId) {
      await Bills.updateBill(editingBillId, payload);
    } else {
      await Bills.addBill(payload);
    }
    // Stay on this form, cleared back to a blank "Add Bill" state, rather
    // than returning to the Bills list — same pattern as Debts above.
    openBillForEdit(null);
  });

  document.getElementById('btn-bill-delete').addEventListener('click', async () => {
    if (!editingBillId) return;
    if (!confirm('Delete this bill? This cannot be undone.')) return;
    await Bills.deleteBill(editingBillId);
    editingBillId = null;
    showScreen('bills');
  });

  document.getElementById('btn-bills-header-add').addEventListener('click', () => {
    if (activeBillsTab === 'creditcards') {
      openCreditCardForEdit(null);
    } else {
      openBillForEdit(null);
    }
  });

  // --- Credit Cards --------------------------------------------------------

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  async function renderCreditCardsList() {
    const cards = await CreditCards.getAllCards();
    const totalDue = cards.reduce((sum, c) => sum + (Number(c.amountDue) || 0), 0);
    renderSummaryRow([{ label: 'Total Due', amount: totalDue, colorClass: 'summary-amount-danger' }], 'bills-summary');

    const listEl = document.getElementById('creditcards-list');
    document.getElementById('creditcards-empty').hidden = cards.length !== 0 || activeBillsTab !== 'creditcards';
    listEl.innerHTML = cards.map((card) => {
      const status = CreditCards.statusFor(card);
      const parts = [];
      if (card.amountDue) parts.push(peso(card.amountDue) + ' due');
      if (card.bank) parts.push(card.bank);
      if (card.last4) parts.push(`••${card.last4}`);
      if (card.statementCutoffDay) parts.push(`Cutoff: ${ordinal(card.statementCutoffDay)}`);
      if (card.paymentDueDay) parts.push(`Due: ${ordinal(card.paymentDueDay)}`);
      return `<div class="doc-card" data-id="${card.id}">
        <div><div class="doc-card-title">${escapeHtml(card.cardName || 'Credit Card')}</div><div class="doc-card-sub">${escapeHtml(parts.join(' — '))}</div></div>
        <span class="status-pill status-${status.status}">${Reminders.STATUS_LABELS[status.status]}</span>
      </div>`;
    }).join('');
    listEl.querySelectorAll('.doc-card').forEach((card) => {
      card.addEventListener('click', () => openCreditCardForEdit(card.dataset.id));
    });
  }

  async function openCreditCardForEdit(id) {
    editingCardId = id;
    showScreen('creditcard-form');
    document.getElementById('btn-cc-delete').hidden = !id;

    let card = { cardName: '', bank: '', last4: '', amountDue: '', statementCutoffDay: '', paymentDueDay: '', creditLimit: '', notes: '' };
    if (id) {
      const existing = await CreditCards.getCard(id);
      if (existing) card = existing;
    }
    document.getElementById('creditcard-form-title').textContent = id ? 'Edit Credit Card' : 'Add Credit Card';
    document.getElementById('cc-cardName').value = card.cardName;
    document.getElementById('cc-bank').value = card.bank;
    document.getElementById('cc-last4').value = card.last4;
    document.getElementById('cc-amountDue').value = card.amountDue;
    document.getElementById('cc-statementCutoffDay').value = card.statementCutoffDay || '';
    document.getElementById('cc-paymentDueDay').value = card.paymentDueDay || '';
    document.getElementById('cc-creditLimit').value = card.creditLimit;
    document.getElementById('cc-notes').value = card.notes;
  }

  document.getElementById('btn-cc-save').addEventListener('click', async () => {
    const payload = {
      cardName: document.getElementById('cc-cardName').value,
      bank: document.getElementById('cc-bank').value,
      last4: document.getElementById('cc-last4').value,
      amountDue: document.getElementById('cc-amountDue').value,
      statementCutoffDay: document.getElementById('cc-statementCutoffDay').value,
      paymentDueDay: document.getElementById('cc-paymentDueDay').value,
      creditLimit: document.getElementById('cc-creditLimit').value,
      notes: document.getElementById('cc-notes').value
    };
    if (editingCardId) {
      await CreditCards.updateCard(editingCardId, payload);
    } else {
      await CreditCards.addCard(payload);
    }
    // Stay on this form, cleared back to a blank "Add Credit Card" state,
    // rather than returning to the Bills screen. activeBillsTab is kept in
    // sync anyway, in case the back arrow is used afterward.
    activeBillsTab = 'creditcards';
    openCreditCardForEdit(null);
  });

  document.getElementById('btn-cc-delete').addEventListener('click', async () => {
    if (!editingCardId) return;
    if (!confirm('Delete this credit card? This cannot be undone.')) return;
    await CreditCards.deleteCard(editingCardId);
    editingCardId = null;
    activeBillsTab = 'creditcards';
    showScreen('bills');
  });

  // --- More: Health Reminders + To-Dos --------------------------------------

  function populateHealthTypeSelect() {
    const sel = document.getElementById('health-type');
    sel.innerHTML = HEALTH_TYPES.map((t) => `<option value="${t.id}">${escapeHtml(t.label)}</option>`).join('');
  }

  async function renderMore() {
    const tabs = [{ id: 'health', label: 'Health' }, { id: 'todos', label: 'To-Dos' }];
    const chipRow = document.getElementById('more-tab-filter');
    chipRow.innerHTML = tabs.map((t) =>
      `<div class="chip ${activeMoreTab === t.id ? 'active' : ''}" data-tab="${t.id}">${t.label}</div>`
    ).join('');
    chipRow.querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => { activeMoreTab = chip.dataset.tab; renderMore(); });
    });

    document.getElementById('health-list').hidden = activeMoreTab !== 'health';
    document.getElementById('health-empty').hidden = activeMoreTab !== 'health';
    document.getElementById('todos-list').hidden = activeMoreTab !== 'todos';
    document.getElementById('todos-empty').hidden = activeMoreTab !== 'todos';

    if (activeMoreTab === 'health') {
      await renderHealthList();
    } else {
      await renderTodosList();
    }
  }

  // --- Health reminders ---

  async function renderHealthList() {
    const items = await Health.getAllReminders();
    const listEl = document.getElementById('health-list');
    document.getElementById('health-empty').hidden = items.length !== 0 || activeMoreTab !== 'health';
    listEl.innerHTML = items.map((item) => {
      const status = Health.statusFor(item);
      const typeLabel = (HEALTH_TYPES.find((t) => t.id === item.type) || {}).label || item.type;
      const sub = `${typeLabel}${item.dueDate ? ' — due ' + item.dueDate : ''}`;
      return `<div class="doc-card">
        <div class="doc-card-clickarea" data-id="${item.id}" style="flex:1;cursor:pointer;">
          <div class="doc-card-title">${escapeHtml(item.reminderName || typeLabel)}</div><div class="doc-card-sub">${escapeHtml(sub)}</div>
        </div>
        <label class="bill-paid-toggle"><input type="checkbox" data-health-done-toggle="${item.id}" ${item.done ? 'checked' : ''} /> Done</label>
      </div>`;
    }).join('');
    listEl.querySelectorAll('.doc-card-clickarea').forEach((el) => {
      el.addEventListener('click', () => openHealthForEdit(el.dataset.id));
    });
    listEl.querySelectorAll('[data-health-done-toggle]').forEach((checkbox) => {
      checkbox.addEventListener('click', (e) => e.stopPropagation());
      checkbox.addEventListener('change', async () => {
        await Health.toggleDone(checkbox.dataset.healthDoneToggle);
        renderHealthList();
      });
    });
  }

  async function openHealthForEdit(id) {
    editingHealthId = id;
    showScreen('health-form');
    document.getElementById('btn-health-delete').hidden = !id;

    let item = { reminderName: '', type: 'medical', dueDate: '', recurring: 'none', notes: '', done: false };
    if (id) {
      const existing = await Health.getReminder(id);
      if (existing) item = existing;
    }
    document.getElementById('health-form-title').textContent = id ? 'Edit Health Reminder' : 'Add Health Reminder';
    document.getElementById('health-reminderName').value = item.reminderName;
    document.getElementById('health-type').value = item.type;
    document.getElementById('health-dueDate').value = item.dueDate;
    document.getElementById('health-recurring').value = item.recurring;
    document.getElementById('health-notes').value = item.notes;
    document.getElementById('health-done').checked = !!item.done;
  }

  document.getElementById('btn-health-save').addEventListener('click', async () => {
    const payload = {
      reminderName: document.getElementById('health-reminderName').value,
      type: document.getElementById('health-type').value,
      dueDate: document.getElementById('health-dueDate').value,
      recurring: document.getElementById('health-recurring').value,
      notes: document.getElementById('health-notes').value,
      done: document.getElementById('health-done').checked
    };
    if (editingHealthId) {
      await Health.updateReminder(editingHealthId, payload);
    } else {
      await Health.addReminder(payload);
    }
    // Stay on this form, cleared back to a blank "Add Health Reminder"
    // state, rather than returning to the More list.
    activeMoreTab = 'health';
    openHealthForEdit(null);
  });

  document.getElementById('btn-health-delete').addEventListener('click', async () => {
    if (!editingHealthId) return;
    if (!confirm('Delete this health reminder? This cannot be undone.')) return;
    await Health.deleteReminder(editingHealthId);
    editingHealthId = null;
    activeMoreTab = 'health';
    showScreen('more');
  });

  // --- To-Dos ---

  async function renderTodosList() {
    const items = await Todos.getAllTodos();
    const progressEl = document.getElementById('todos-progress');
    if (items.length) {
      const done = items.filter((t) => t.done).length;
      progressEl.hidden = false;
      progressEl.textContent = `${done} of ${items.length} done`;
    } else {
      progressEl.hidden = true;
    }

    const listEl = document.getElementById('todos-list');
    document.getElementById('todos-empty').hidden = items.length !== 0 || activeMoreTab !== 'todos';
    listEl.innerHTML = items.map((todo) => {
      const progress = Todos.checklistProgress(todo);
      const subParts = [];
      if (todo.startDate && todo.dueDate) subParts.push(`${todo.startDate} – ${todo.dueDate}`);
      else if (todo.dueDate) subParts.push(`Due ${todo.dueDate}`);
      else if (todo.startDate) subParts.push(`Starts ${todo.startDate}`);
      if (progress.total) subParts.push(`${progress.done}/${progress.total} steps`);
      return `<div class="doc-card">
        <div class="doc-card-clickarea" data-id="${todo.id}" style="flex:1;cursor:pointer;">
          <div class="doc-card-title ${todo.done ? 'done' : ''}">${escapeHtml(todo.title || 'To-Do')}</div><div class="doc-card-sub">${escapeHtml(subParts.join(' — '))}</div>
        </div>
        <label class="bill-paid-toggle"><input type="checkbox" data-todo-done-toggle="${todo.id}" ${todo.done ? 'checked' : ''} /> Done</label>
      </div>`;
    }).join('');
    listEl.querySelectorAll('.doc-card-clickarea').forEach((el) => {
      el.addEventListener('click', () => openTodoForEdit(el.dataset.id));
    });
    listEl.querySelectorAll('[data-todo-done-toggle]').forEach((checkbox) => {
      checkbox.addEventListener('click', (e) => e.stopPropagation());
      checkbox.addEventListener('change', async () => {
        await Todos.toggleDone(checkbox.dataset.todoDoneToggle);
        renderTodosList();
      });
    });
  }

  function renderChecklist(checklist) {
    const el = document.getElementById('todo-checklist');
    el.innerHTML = (checklist || []).length
      ? checklist.map((it) => `
        <div class="checklist-row">
          <input type="checkbox" data-checklist-toggle="${it.id}" ${it.done ? 'checked' : ''} />
          <span class="checklist-row-text ${it.done ? 'done' : ''}">${escapeHtml(it.text)}</span>
          <button type="button" class="checklist-row-remove" data-checklist-remove="${it.id}" aria-label="Remove step">&times;</button>
        </div>`).join('')
      : '<p class="empty-state">No steps yet.</p>';
    el.querySelectorAll('[data-checklist-toggle]').forEach((checkbox) => {
      checkbox.addEventListener('change', async () => {
        const updated = await Todos.toggleChecklistItem(editingTodoId, checkbox.dataset.checklistToggle);
        renderChecklist(updated.checklist);
      });
    });
    el.querySelectorAll('[data-checklist-remove]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const updated = await Todos.removeChecklistItem(editingTodoId, btn.dataset.checklistRemove);
        renderChecklist(updated.checklist);
      });
    });
  }

  async function openTodoForEdit(id) {
    editingTodoId = id;
    showScreen('todo-form');
    document.getElementById('btn-todo-delete').hidden = !id;
    document.getElementById('todo-checklist-section').hidden = !id;
    document.getElementById('todo-checklist-hint').hidden = !!id;

    let todo = { title: '', startDate: '', dueDate: '', notes: '', done: false, checklist: [] };
    if (id) {
      const existing = await Todos.getTodo(id);
      if (existing) todo = existing;
    }
    document.getElementById('todo-form-title').textContent = id ? 'Edit To-Do' : 'Add To-Do';
    document.getElementById('todo-title').value = todo.title;
    document.getElementById('todo-startDate').value = todo.startDate || '';
    document.getElementById('todo-dueDate').value = todo.dueDate;
    document.getElementById('todo-notes').value = todo.notes;
    document.getElementById('todo-done').checked = !!todo.done;
    renderChecklist(todo.checklist);
  }

  document.getElementById('btn-todo-save').addEventListener('click', async () => {
    const payload = {
      title: document.getElementById('todo-title').value,
      startDate: document.getElementById('todo-startDate').value,
      dueDate: document.getElementById('todo-dueDate').value,
      notes: document.getElementById('todo-notes').value,
      done: document.getElementById('todo-done').checked
    };
    if (editingTodoId) {
      await Todos.updateTodo(editingTodoId, payload);
      // Stay on this form, cleared back to a blank "Add To-Do" state,
      // rather than returning to the More list — same pattern as the other
      // forms above.
      activeMoreTab = 'todos';
      openTodoForEdit(null);
    } else {
      // Deliberate exception to "clear and stay" for a brand-new to-do:
      // re-open it in edit mode instead, so checklist steps can be added
      // right away without an extra tap back in (checklist editing only
      // unlocks once the to-do has an id — see the hint text on this
      // screen). Editing an existing to-do (above) doesn't have that
      // need, so it clears normally.
      const created = await Todos.addTodo(payload);
      await openTodoForEdit(created.id);
    }
  });

  document.getElementById('btn-todo-delete').addEventListener('click', async () => {
    if (!editingTodoId) return;
    if (!confirm('Delete this to-do? This cannot be undone.')) return;
    await Todos.deleteTodo(editingTodoId);
    editingTodoId = null;
    activeMoreTab = 'todos';
    showScreen('more');
  });

  document.getElementById('btn-todo-add-checklist-item').addEventListener('click', async () => {
    if (!editingTodoId) return;
    const input = document.getElementById('todo-checklist-input');
    const text = input.value.trim();
    if (!text) return;
    const updated = await Todos.addChecklistItem(editingTodoId, text);
    input.value = '';
    renderChecklist(updated.checklist);
  });

  document.getElementById('btn-more-header-add').addEventListener('click', () => {
    if (activeMoreTab === 'todos') {
      openTodoForEdit(null);
    } else {
      openHealthForEdit(null);
    }
  });

  // --- Settings ------------------------------------------------------------

  document.getElementById('btn-lock-now').addEventListener('click', lockVault);

  document.getElementById('btn-change-pin').addEventListener('click', async () => {
    const oldPin = prompt('Enter your current PIN/password:');
    if (oldPin === null) return;
    const newPin = prompt('Enter your new PIN/password:');
    if (newPin === null) return;
    if (newPin.length < 4) { alert('Use at least 4 characters.'); return; }
    const ok = await Crypto.changePin(oldPin, newPin);
    alert(ok ? 'PIN changed.' : 'Current PIN was incorrect — nothing was changed.');
  });

  document.getElementById('btn-export').addEventListener('click', async () => {
    const stores = {};
    for (const store of DB.STORES) {
      stores[store] = await DB.getAllRaw(store);
    }
    const bundle = {
      bersalesBackup: true,
      version: 4,
      exportedAt: new Date().toISOString(),
      salt: localStorage.getItem('bersales_salt'),
      verifier: localStorage.getItem('bersales_verifier'),
      stores
    };
    const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bersales-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    alert('Backup file downloaded. This file is encrypted with your current PIN — store it somewhere safe. You will need the same PIN to restore it.');
  });

  // --- Boot ------------------------------------------------------------------

  function boot() {
    applyTheme();
    document.getElementById('theme-select').value = getThemePref();
    document.getElementById('autolock-select').value = String(getAutoLockMinutes());
    populateBillCategorySelect();
    populateHealthTypeSelect();
    if (Crypto.isPinSet()) {
      showScreen('lock');
    } else {
      showScreen('pin-setup');
    }
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('service-worker.js').catch(() => {});
    }
  }

  boot();
})();
