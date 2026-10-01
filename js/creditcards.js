// Bersales — creditcards.js
//
// Credit card statement cutoff + payment due reminders. Deliberately its
// own tracker rather than a Bills category: a cutoff day and a due day are
// each a fixed day-of-month, which means — unlike a generic bill's one-off
// dueDate — the next occurrence can be computed on the fly every time, so
// these reminders roll forward into next month automatically with no
// manual re-entry. (Bills in general don't get this yet; see the note in
// bills.js — day-of-month recurrence doesn't generalize cleanly to every
// bill type, but it's exactly right for a statement cycle.)
//
// Only the last 4 digits are ever asked for — this is a reminder tool, not
// a wallet, and there's no reason for a full card number to exist anywhere
// in the app, encrypted or not.

const CreditCards = (() => {
  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  async function addCard(card) {
    const id = uuid();
    const now = Date.now();
    const record = {
      id,
      cardName: card.cardName || '',
      bank: card.bank || '',
      last4: (card.last4 || '').replace(/\D/g, '').slice(-4),
      statementCutoffDay: clampDay(card.statementCutoffDay),
      paymentDueDay: clampDay(card.paymentDueDay),
      creditLimit: card.creditLimit || '',
      amountDue: card.amountDue || '', // manual, like Debts' outstandingBalance — you update it yourself after checking your statement
      notes: card.notes || '',
      createdAt: now,
      updatedAt: now
    };
    const payload = await Crypto.encryptJSON(record);
    await DB.putRaw('creditCards', id, payload);
    return record;
  }

  async function updateCard(id, updates) {
    const existing = await getCard(id);
    if (!existing) throw new Error('Credit card not found');
    const merged = {
      ...existing,
      ...updates,
      last4: updates.last4 !== undefined ? updates.last4.replace(/\D/g, '').slice(-4) : existing.last4,
      statementCutoffDay: updates.statementCutoffDay !== undefined ? clampDay(updates.statementCutoffDay) : existing.statementCutoffDay,
      paymentDueDay: updates.paymentDueDay !== undefined ? clampDay(updates.paymentDueDay) : existing.paymentDueDay,
      id,
      updatedAt: Date.now()
    };
    const payload = await Crypto.encryptJSON(merged);
    await DB.putRaw('creditCards', id, payload);
    return merged;
  }

  async function getCard(id) {
    const raw = await DB.getRaw('creditCards', id);
    if (!raw) return null;
    return Crypto.decryptJSON(raw.payload);
  }

  async function getAllCards() {
    const rawAll = await DB.getAllRaw('creditCards');
    const cards = [];
    for (const raw of rawAll) {
      try {
        cards.push(await Crypto.decryptJSON(raw.payload));
      } catch (e) {
        console.error('Failed to decrypt credit card record', raw.id, e);
      }
    }
    cards.sort((a, b) => b.updatedAt - a.updatedAt);
    return cards;
  }

  async function deleteCard(id) {
    return DB.deleteRaw('creditCards', id);
  }

  // --- Day-of-month -> next occurrence ---------------------------------

  function clampDay(day) {
    const n = parseInt(day, 10);
    if (!n || n < 1) return null;
    return Math.min(n, 31);
  }

  function lastDayOfMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
  }

  function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function toISODate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // Returns the next occurrence (today or later) of a given day-of-month,
  // as an ISO date string. A day beyond a short month (e.g. 31 in
  // February) clamps to that month's last day rather than overflowing.
  function nextOccurrence(day) {
    if (!day) return null;
    const today = startOfToday();
    const clampedThisMonth = Math.min(day, lastDayOfMonth(today.getFullYear(), today.getMonth()));
    let candidate = new Date(today.getFullYear(), today.getMonth(), clampedThisMonth);
    if (candidate < today) {
      const y = today.getFullYear(), m = today.getMonth() + 1;
      const nextMonthDate = new Date(y, m, 1);
      const clampedNextMonth = Math.min(day, lastDayOfMonth(nextMonthDate.getFullYear(), nextMonthDate.getMonth()));
      candidate = new Date(nextMonthDate.getFullYear(), nextMonthDate.getMonth(), clampedNextMonth);
    }
    return toISODate(candidate);
  }

  function nextCutoffDate(card) {
    return nextOccurrence(card.statementCutoffDay);
  }

  function nextDueDate(card) {
    return nextOccurrence(card.paymentDueDay);
  }

  const STATUS_RANK = { critical_expired: 0, attention: 1, upcoming: 2, good: 3, none: 4 };

  function cutoffStatus(card) {
    const date = nextCutoffDate(card);
    return date ? Reminders.statusForDate(date) : { status: 'none', daysLeft: null };
  }

  function dueStatus(card) {
    const date = nextDueDate(card);
    return date ? Reminders.statusForDate(date) : { status: 'none', daysLeft: null };
  }

  // Combined status for the card's single list-row pill: whichever of the
  // two upcoming dates is more urgent.
  function statusFor(card) {
    const a = cutoffStatus(card);
    const b = dueStatus(card);
    return STATUS_RANK[a.status] <= STATUS_RANK[b.status] ? a : b;
  }

  return {
    addCard, updateCard, getCard, getAllCards, deleteCard,
    nextCutoffDate, nextDueDate, cutoffStatus, dueStatus, statusFor
  };
})();
