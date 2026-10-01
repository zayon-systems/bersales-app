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
  const NUMBER_RE = /\b[A-Z0-9]{5,}[-][A-Z0-9-]{2,}\b|\b[A-Z]{1,3}\d{6,}\b|\b\d{2}-\d{7,10}\b/g;

  function guessFields(text, docType) {
    const template = DOC_TYPES[docType];
    const guesses = {};
    if (!template) return guesses;

    const dates = [...text.matchAll(DATE_RE)].map((m) => m[0]);
    const numbers = [...text.matchAll(NUMBER_RE)].map((m) => m[0]);

    // Heuristic: if there's an expiry-type field and 2+ dates were found,
    // assume the later date is the expiry and the earlier is the issue date.
    if (dates.length >= 2) {
      const sorted = [...dates].sort();
      if (template.fields.includes('issueDate')) guesses.issueDate = sorted[0];
      const expiryField = template.expiryField;
      if (expiryField && template.fields.includes(expiryField)) guesses[expiryField] = sorted[sorted.length - 1];
    } else if (dates.length === 1) {
      if (template.expiryField && template.fields.includes(template.expiryField)) {
        guesses[template.expiryField] = dates[0];
      } else if (template.fields.includes('issueDate')) {
        guesses.issueDate = dates[0];
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
