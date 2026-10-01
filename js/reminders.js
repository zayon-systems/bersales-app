// Bersales — reminders.js
//
// Per-document expiry status. Deliberately NOT an aggregate "health score" —
// that was cut during product review because averaging hides one critical
// item behind many fine ones. Each document gets its own status; the home
// screen lists items needing attention individually.

const Reminders = (() => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  function parseDate(str) {
    if (!str) return null;
    // Accept common formats: YYYY-MM-DD (native <input type=date>), or
    // whatever the browser's Date parser can handle for OCR-guessed text.
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }

  // status: 'critical_expired' | 'attention' | 'upcoming' | 'good' | 'none'
  //
  // statusForDate is the shared primitive — bills.js and debts.js both call
  // it directly so a bill due in 5 days and a document expiring in 5 days
  // get the exact same status/color treatment.
  function statusForDate(dateStr) {
    const d = parseDate(dateStr);
    if (!d) return { status: 'none', daysLeft: null };

    const now = new Date();
    const daysLeft = Math.ceil((d.getTime() - now.getTime()) / DAY_MS);

    if (daysLeft < 0) return { status: 'critical_expired', daysLeft };
    if (daysLeft <= 30) return { status: 'attention', daysLeft };
    if (daysLeft <= 90) return { status: 'upcoming', daysLeft };
    return { status: 'good', daysLeft };
  }

  function statusFor(doc) {
    const template = DOC_TYPES[doc.docType];
    const expiryField = template && template.expiryField;
    if (!expiryField) return { status: 'none', daysLeft: null };
    const value = doc.fields && doc.fields[expiryField];
    if (!value) return { status: 'none', daysLeft: null };
    return statusForDate(value);
  }

  const STATUS_LABELS = {
    critical_expired: 'Expired',
    attention: 'Needs attention',
    upcoming: 'Upcoming',
    good: 'Good',
    none: 'No expiry tracked'
  };

  function nextThirtyDays(docs) {
    return docs
      .map((doc) => ({ doc, ...statusFor(doc) }))
      .filter((item) => item.daysLeft !== null && item.daysLeft <= 30)
      .sort((a, b) => a.daysLeft - b.daysLeft);
  }

  function needsAttention(docs) {
    return docs
      .map((doc) => ({ doc, ...statusFor(doc) }))
      .filter((item) => item.status === 'critical_expired' || item.status === 'attention')
      .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
  }

  return { statusFor, statusForDate, STATUS_LABELS, nextThirtyDays, needsAttention };
})();
