// Bersales — vault.js
//
// Document CRUD. Every record is encrypted (crypto.js) before it touches
// storage (db.js) and decrypted only in memory after the vault is unlocked.
//
// Images are stored separately from document metadata (see db.js) — getDocument()
// returns fields/category/etc. only; call getDocumentImages(id) when you
// actually need to render the photo(s) (document form, edit view). This keeps
// list/home rendering fast as the vault grows, since it never has to
// decrypt image bytes just to show a title and a status pill.
//
// A document can hold more than one scanned page (front/back of an ID, a
// multi-page certificate) — each is an individual flat scan, never merged
// into a multi-page PDF. imageDataUrls is stored as an array under the same
// 'images' store record, keyed by the document's id.

const Vault = (() => {
  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  async function addDocument(doc) {
    const id = uuid();
    const now = Date.now();
    const imageDataUrls = (doc.imageDataUrls || []).filter(Boolean);
    const record = {
      id,
      category: doc.category,
      docType: doc.docType,
      fields: doc.fields || {},
      notes: doc.notes || '',
      hasImage: imageDataUrls.length > 0,
      createdAt: now,
      updatedAt: now
    };
    const payload = await Crypto.encryptJSON(record);
    await DB.putRaw('documents', id, payload);
    if (imageDataUrls.length) {
      const imgPayload = await Crypto.encryptJSON({ imageDataUrls });
      await DB.putRaw('images', id, imgPayload);
    }
    return { ...record, imageDataUrls };
  }

  async function updateDocument(id, updates) {
    const existing = await getDocument(id);
    if (!existing) throw new Error('Document not found');
    const imageDataUrls = updates.imageDataUrls !== undefined
      ? (updates.imageDataUrls || []).filter(Boolean)
      : undefined;
    const hasImage = imageDataUrls !== undefined ? imageDataUrls.length > 0 : existing.hasImage;
    const merged = {
      ...existing,
      category: updates.category ?? existing.category,
      docType: updates.docType ?? existing.docType,
      fields: updates.fields ?? existing.fields,
      notes: updates.notes ?? existing.notes,
      hasImage,
      id,
      updatedAt: Date.now()
    };
    const payload = await Crypto.encryptJSON(merged);
    await DB.putRaw('documents', id, payload);
    if (imageDataUrls !== undefined) {
      if (imageDataUrls.length) {
        const imgPayload = await Crypto.encryptJSON({ imageDataUrls });
        await DB.putRaw('images', id, imgPayload);
      } else {
        await DB.deleteRaw('images', id);
      }
    }
    return merged;
  }

  async function getDocument(id) {
    const raw = await DB.getRaw('documents', id);
    if (!raw) return null;
    return Crypto.decryptJSON(raw.payload);
  }

  async function getDocumentImages(id) {
    const raw = await DB.getRaw('images', id);
    if (!raw) return [];
    const data = await Crypto.decryptJSON(raw.payload);
    // Back-compat: an older record (before multi-page support) stored a
    // single imageDataUrl rather than an array.
    if (data.imageDataUrls) return data.imageDataUrls;
    if (data.imageDataUrl) return [data.imageDataUrl];
    return [];
  }

  async function getAllDocuments() {
    const rawAll = await DB.getAllRaw('documents');
    const docs = [];
    for (const raw of rawAll) {
      try {
        docs.push(await Crypto.decryptJSON(raw.payload));
      } catch (e) {
        // Skip a record that fails to decrypt rather than crash the whole vault view.
        console.error('Failed to decrypt record', raw.id, e);
      }
    }
    docs.sort((a, b) => b.updatedAt - a.updatedAt);
    return docs;
  }

  async function deleteDocument(id) {
    await DB.deleteRaw('images', id);
    return DB.deleteRaw('documents', id);
  }

  return { addDocument, updateDocument, getDocument, getDocumentImages, getAllDocuments, deleteDocument };
})();
