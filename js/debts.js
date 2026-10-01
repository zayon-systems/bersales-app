// Bersales — debts.js
//
// Debt ledger CRUD. This is a manual recording/monitoring tool, not a
// transaction system: it never moves money, connects to a bank, or
// auto-calculates interest — the user updates outstandingBalance themselves
// as they pay down or collect a debt. See the product spec's reasoning:
// keeping this a recording tool (not a banking app) deliberately keeps the
// compliance and complexity surface small.

const Debts = (() => {
  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // direction: 'i_owe' (Money I Owe) | 'owed_to_me' (Money Owed to Me)
  async function addDebt(debt) {
    const id = uuid();
    const now = Date.now();
    const record = {
      id,
      direction: debt.direction,
      personName: debt.personName || '',
      originalAmount: debt.originalAmount || '',
      outstandingBalance: debt.outstandingBalance || '',
      interestNote: debt.interestNote || '',
      dueDate: debt.dueDate || '',
      recurring: !!debt.recurring,
      installmentAmount: debt.installmentAmount || '',
      notes: debt.notes || '',
      paymentHistory: debt.paymentHistory || [],
      settled: !!debt.settled, // was hardcoded to false — a debt entered as already-settled (e.g. logging historical records) silently saved as still-active
      createdAt: now,
      updatedAt: now
    };
    const payload = await Crypto.encryptJSON(record);
    await DB.putRaw('debts', id, payload);
    return record;
  }

  async function updateDebt(id, updates) {
    const existing = await getDebt(id);
    if (!existing) throw new Error('Debt not found');
    const merged = { ...existing, ...updates, id, updatedAt: Date.now() };
    const payload = await Crypto.encryptJSON(merged);
    await DB.putRaw('debts', id, payload);
    return merged;
  }

  async function addPayment(id, payment) {
    const existing = await getDebt(id);
    if (!existing) throw new Error('Debt not found');
    const paymentHistory = [...(existing.paymentHistory || []), { ...payment, loggedAt: Date.now() }];
    return updateDebt(id, { paymentHistory });
  }

  async function getDebt(id) {
    const raw = await DB.getRaw('debts', id);
    if (!raw) return null;
    return Crypto.decryptJSON(raw.payload);
  }

  async function getAllDebts() {
    const rawAll = await DB.getAllRaw('debts');
    const debts = [];
    for (const raw of rawAll) {
      try {
        debts.push(await Crypto.decryptJSON(raw.payload));
      } catch (e) {
        console.error('Failed to decrypt debt record', raw.id, e);
      }
    }
    debts.sort((a, b) => b.updatedAt - a.updatedAt);
    return debts;
  }

  async function deleteDebt(id) {
    return DB.deleteRaw('debts', id);
  }

  // Status mirrors Reminders' document status keys (critical_expired /
  // attention / upcoming / good / none) so the same CSS/status-pill styling
  // applies everywhere in the app.
  function statusFor(debt) {
    if (debt.settled) return { status: 'good', daysLeft: null };
    if (!debt.dueDate) return { status: 'none', daysLeft: null };
    return Reminders.statusForDate(debt.dueDate);
  }

  return { addDebt, updateDebt, addPayment, getDebt, getAllDebts, deleteDebt, statusFor };
})();
