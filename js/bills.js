// Bersales — bills.js
//
// Bills tracker CRUD: utilities, subscriptions, rent, internet, phone,
// insurance, etc. Each bill has a due date and a paid flag for the current
// cycle. Recurring bills don't auto-regenerate next month's entry in v1 —
// marking one paid just clears it from "needs attention" until you update
// the due date yourself for the next cycle. Noted as a known limitation,
// not an oversight: auto-advancing due dates correctly (monthly vs. yearly,
// weekends/holidays, etc.) is enough edge-case logic to deserve its own
// pass rather than being bolted on here.

const BILL_CATEGORIES = [
  { id: 'utilities', label: 'Utilities' },
  { id: 'subscriptions', label: 'Subscriptions' },
  { id: 'rent', label: 'Rent' },
  { id: 'internet', label: 'Internet' },
  { id: 'phone', label: 'Phone' },
  { id: 'insurance', label: 'Insurance' },
  { id: 'other', label: 'Other' }
];

const Bills = (() => {
  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  async function addBill(bill) {
    const id = uuid();
    const now = Date.now();
    const record = {
      id,
      billName: bill.billName || '',
      category: bill.category || 'other',
      amount: bill.amount || '',
      dueDate: bill.dueDate || '',
      recurring: bill.recurring || 'none', // 'none' | 'weekly' | 'monthly' | 'yearly'
      notes: bill.notes || '',
      paid: !!bill.paid, // was hardcoded to false — a bill created with "Paid" already checked silently saved as unpaid
      createdAt: now,
      updatedAt: now
    };
    const payload = await Crypto.encryptJSON(record);
    await DB.putRaw('bills', id, payload);
    return record;
  }

  async function updateBill(id, updates) {
    const existing = await getBill(id);
    if (!existing) throw new Error('Bill not found');
    const merged = { ...existing, ...updates, id, updatedAt: Date.now() };
    const payload = await Crypto.encryptJSON(merged);
    await DB.putRaw('bills', id, payload);
    return merged;
  }

  async function togglePaid(id) {
    const existing = await getBill(id);
    if (!existing) throw new Error('Bill not found');
    return updateBill(id, { paid: !existing.paid });
  }

  async function getBill(id) {
    const raw = await DB.getRaw('bills', id);
    if (!raw) return null;
    return Crypto.decryptJSON(raw.payload);
  }

  async function getAllBills() {
    const rawAll = await DB.getAllRaw('bills');
    const bills = [];
    for (const raw of rawAll) {
      try {
        bills.push(await Crypto.decryptJSON(raw.payload));
      } catch (e) {
        console.error('Failed to decrypt bill record', raw.id, e);
      }
    }
    bills.sort((a, b) => b.updatedAt - a.updatedAt);
    return bills;
  }

  async function deleteBill(id) {
    return DB.deleteRaw('bills', id);
  }

  function statusFor(bill) {
    if (bill.paid) return { status: 'good', daysLeft: null };
    if (!bill.dueDate) return { status: 'none', daysLeft: null };
    return Reminders.statusForDate(bill.dueDate);
  }

  // Monthly-recurring-spend calculator. A weekly bill isn't "4 weeks" worth
  // a month (months aren't 4 weeks), so this normalizes against the actual
  // average: 52 weeks/year ÷ 12 months ≈ 4.333 occurrences/month. A one-time
  // bill ('none') isn't a recurring cost at all, so it contributes 0 — this
  // is a budgeting estimate, deliberately independent of whether THIS
  // cycle's instance happens to be marked paid yet (see Total Unpaid for
  // that instead).
  const MONTHLY_FACTOR = { weekly: 52 / 12, monthly: 1, yearly: 1 / 12 };

  function monthlyEquivalent(bill) {
    const factor = MONTHLY_FACTOR[bill.recurring];
    if (!factor) return 0;
    return (Number(bill.amount) || 0) * factor;
  }

  function totalMonthlyRecurring(bills) {
    return bills.reduce((sum, b) => sum + monthlyEquivalent(b), 0);
  }

  return { addBill, updateBill, togglePaid, getBill, getAllBills, deleteBill, statusFor, monthlyEquivalent, totalMonthlyRecurring };
})();
