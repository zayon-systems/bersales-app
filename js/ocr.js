// Bersales — ocr.js
//
// Runs Tesseract.js entirely in the browser/webview — the image never
// leaves the device. This is best-effort field extraction, not a source of
// truth: manual entry (see app.js's document form) is always available and
// always pre-fills with whatever OCR found, so the user can correct it.
//
// Accuracy note (flagged deliberately, not swept under the rug): in-browser
// OCR on aged, handwritten, or low-quality PH documents (old licenses,
// barangay clearances, glare on laminated IDs) will often get this wrong or
// find nothing. That is expected — treat every OCR result as a draft.
//
// Local-only caveat (also flagged deliberately): Tesseract.js downloads its
// WASM engine and language data (~2-5MB) from a CDN the FIRST time OCR runs,
// and needs internet for that one-time download. After that it's cached by
// the browser/WebView and works offline. This does NOT send any document
// image or extracted data anywhere — it's a one-time fetch of generic
// library files — but it's worth being upfront that "local-only" for
// documents doesn't mean "works offline on first launch."

const OCR = (() => {
  let workerPromise = null;

  function getWorker() {
    if (!workerPromise) {
      // Tesseract.js is loaded via <script> in index.html (CDN, cached by the
      // service worker after first load so OCR keeps working offline).
      workerPromise = Tesseract.createWorker('eng');
    }
    return workerPromise;
  }

  async function recognize(canvasOrImage, onProgress) {
    const worker = await getWorker();
    if (onProgress) {
      // Tesseract.js v5 worker doesn't take a logger post-creation reliably
      // across build wrappers, so we just report indeterminate progress.
      onProgress('reading document…');
    }
    const { data } = await worker.recognize(canvasOrImage);
    return data.text || '';
  }

  // Very deliberately simple heuristics — this is a starting point for the
  // user to correct, not a parser that needs to be "right".
  const DATE_RE = /\b(\d{1,2}[\/\-. ]\d{1,2}[\/\-. ]\d{2,4}|\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}|[A-Z][a-z]{2,8}\.?\s+\d{1,2},?\s+\d{4})\b/g;
  // Widened from the original (which only matched a couple of specific
  // dash patterns, e.g. driver's license numbers) because most PH ID
  // numbers don't fit those shapes: SSS is 2-7-1 digits, PhilHealth is
  // 2-9-1, Pag-IBIG/UMID is 4-4-4, TIN is 3-3-3(-3), NBI/police reference
  // numbers are often plain long digit runs. This instead matches any
  // dash-separated run of letters/digits whose first group is at least 3
  // characters and contains a digit somewhere — broad enough to catch
  // those formats (and, worst case, grab the number minus a short leading
  // group like SSS's 2-digit prefix) while still requiring a digit so it
  // doesn't grab plain all-caps words off the document (e.g. "REPUBLIC",
  // "PHILIPPINES"). Still a draft guess, not a validator — see file header.
  const NUMBER_RE = /\b(?=[A-Z0-9-]*\d)[A-Z0-9]{3,}(?:-[A-Z0-9]{1,})*\b/g;

  function guessFields(text, docType) {
    const template = DOC_TYPES[docType];
    const guesses = {};
    if (!template) return guesses;

    const dates = [...text.matchAll(DATE_RE)].map((m) => m[0]);
    // Now that NUMBER_RE is broad enough to match a bare 3-4 digit group
    // (needed for TIN/UMID-style numbers — see NUMBER_RE comment), it will
    // also pick up a lone year out of a date like "Jan 1, 1990" as its own
    // "number" match. Drop any number match that's fully contained inside
    // an already-found date so a stray year can't hijack the ID-number
    // guess ahead of the document's actual ID number.
    const numbers = [...text.matchAll(NUMBER_RE)]
      .map((m) => m[0])
      .filter((n) => !dates.some((d) => d.includes(n)));

    // The "other" (non-expiry) date-shaped field on this template — e.g.
    // issueDate on most document types, but gun_registration instead calls
    // this cardPrintedDate. Generalized to any field name matching the same
    // /Date$|Expiry$/i pattern app.js's buildForm() uses to render date
    // inputs, rather than hardcoding the literal name 'issueDate', so this
    // keeps working for a document type whose "other date" field has a
    // different name.
    const otherDateField = template.fields.find(
      (f) => f !== template.expiryField && /Date$|Expiry$/i.test(f)
    );

    // Heuristic: if there's an expiry-type field and 2+ dates were found,
    // assume the later date is the expiry and the earlier is the other date.
    if (dates.length >= 2) {
      const sorted = [...dates].sort();
      if (otherDateField) guesses[otherDateField] = sorted[0];
      const expiryField = template.expiryField;
      if (expiryField && template.fields.includes(expiryField)) guesses[expiryField] = sorted[sorted.length - 1];
    } else if (dates.length === 1) {
      if (template.expiryField && template.fields.includes(template.expiryField)) {
        guesses[template.expiryField] = dates[0];
      } else if (otherDateField) {
        guesses[otherDateField] = dates[0];
      }
    }

    // Heuristic: the first ID-like alphanumeric string found maps to
    // whichever "number" field this doc type has.
    const numberField = template.fields.find((f) => /Number$/i.test(f));
    if (numberField && numbers.length > 0) {
      guesses[numberField] = numbers[0];
    }

    return guesses;
  }

  return { recognize, guessFields };
})();
