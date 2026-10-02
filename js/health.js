// Bersales — health.js
//
// Health reminders: medical check-ups, dental check-ups, vaccinations,
// medication refills. Deliberately the same shape as bills.js (a due date,
// an optional recurring interval, a "done this cycle" flag) — a check-up
// you're overdue for and a bill you're overdue for should feel identical on
// Home, and reusing the pattern means reusing the same known limitation:
// recurring reminders don't auto-regenerate next cycle's due date in v1,
// you update it yourself after marking one done.
//
// This is reminders only, not a health record store — see templates.js'
// medical_record document type for actually storing results/prescriptions.

const HEALTH_TYPES = [
  { id: 'medical', label: 'Medical Check-up' },
  { id: 'dental', label: 'Dental Check-up' },
  { id: 'vaccination', label: 'Vaccination' },
  { id: 'medication', label: 'Medication Refill' },
  { id: 'other', label: 'Other' }
];

const Health = (() => {
  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  async function addReminder(item) {
    const id = uuid();
    const now = Date.now();
    const record = {
      id,
      reminderName: item.reminderName || '',
      type: item.type || 'other',
      dueDate: item.dueDate || '',
      recurring: item.recurring || 'none', // 'none' | 'monthly' | 'quarterly' | 'biannual' | 'yearly'
      notes: item.notes || '',
      done: false,
      createdAt: now,
      updatedAt: now
    };
    const payload = await Crypto.encryptJSON(record);
    await DB.putRaw('healthReminders', id, payload);
    return record;
  }

  async function updateReminder(id, updates) {
    const existing = await getReminder(id);
    if (!existing) throw new Error('Health reminder not found');
    const merged = { ...existing, ...updates, id, updatedAt: Date.now() };
    const payload = await Crypto.encryptJSON(merged);
    await DB.putRaw('healthReminders', id, payload);
    return merged;
  }

  async function toggleDone(id) {
    const existing = await getReminder(id);
    if (!existing) throw new Error('Health reminder not found');
    return updateReminder(id, { done: !existing.done });
  }

  async function getReminder(id) {
    const raw = await DB.getRaw('healthReminders', id);
    if (!raw) return null;
    return Crypto.decryptJSON(raw.payload);
  }

  async function getAllReminders() {
    const rawAll = await DB.getAllRaw('healthReminders');
    const items = [];
    for (const raw of rawAll) {
      try {
        items.push(await Crypto.decryptJSON(raw.payload));
      } catch (e) {
        console.error('Failed to decrypt health reminder record', raw.id, e);
      }
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    return items;
  }

  async function deleteReminder(id) {
    return DB.deleteRaw('healthReminders', id);
  }

  function statusFor(item) {
    if (item.done) return { status: 'good', daysLeft: null };
    if (!item.dueDate) return { status: 'none', daysLeft: null };
    return Reminders.statusForDate(item.dueDate);
  }

  return { addReminder, updateReminder, toggleDone, getReminder, getAllReminders, deleteReminder, statusFor };
})();
