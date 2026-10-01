// Bersales — crypto.js
//
// All encryption happens on-device using the Web Crypto API. Nothing here
// ever makes a network call. The user's PIN never leaves the device and is
// never stored — only a PBKDF2-derived key (kept in memory for the session)
// and a random salt + a verifier ciphertext (both non-secret) are persisted.

const Crypto = (() => {
  const PBKDF2_ITERATIONS = 250000; // deliberately high; local-only so cost is one-time per unlock
  const VERIFIER_PLAINTEXT = 'bersales-pin-ok';

  let sessionKey = null; // CryptoKey, held only in memory, cleared on lock/logout

  function bufToB64(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  }
  function b64ToBuf(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr.buffer;
  }

  async function deriveKey(pin, saltB64) {
    const salt = saltB64 ? b64ToBuf(saltB64) : crypto.getRandomValues(new Uint8Array(16));
    const saltOut = saltB64 || bufToB64(salt);
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(pin), { name: 'PBKDF2' }, false, ['deriveKey']
    );
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    return { key, saltB64: saltOut };
  }

  async function encryptString(key, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
    return { iv: bufToB64(iv), data: bufToB64(ciphertext) };
  }

  async function decryptString(key, payload) {
    const iv = new Uint8Array(b64ToBuf(payload.iv));
    const data = b64ToBuf(payload.data);
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return new TextDecoder().decode(plainBuf);
  }

  // --- Public API -----------------------------------------------------

  async function setupPin(pin) {
    const { key, saltB64 } = await deriveKey(pin, null);
    const verifier = await encryptString(key, VERIFIER_PLAINTEXT);
    localStorage.setItem('bersales_salt', saltB64);
    localStorage.setItem('bersales_verifier', JSON.stringify(verifier));
    sessionKey = key;
    return true;
  }

  function isPinSet() {
    return !!localStorage.getItem('bersales_salt') && !!localStorage.getItem('bersales_verifier');
  }

  async function unlockWithPin(pin) {
    const saltB64 = localStorage.getItem('bersales_salt');
    const verifier = JSON.parse(localStorage.getItem('bersales_verifier') || 'null');
    if (!saltB64 || !verifier) return false;
    const { key } = await deriveKey(pin, saltB64);
    try {
      const plain = await decryptString(key, verifier);
      if (plain === VERIFIER_PLAINTEXT) {
        sessionKey = key;
        return true;
      }
      return false;
    } catch (e) {
      // AES-GCM auth failure = wrong PIN
      return false;
    }
  }

  function lock() {
    sessionKey = null;
  }

  function isUnlocked() {
    return !!sessionKey;
  }

  async function encryptJSON(obj) {
    if (!sessionKey) throw new Error('Vault is locked');
    return encryptString(sessionKey, JSON.stringify(obj));
  }

  async function decryptJSON(payload) {
    if (!sessionKey) throw new Error('Vault is locked');
    const str = await decryptString(sessionKey, payload);
    return JSON.parse(str);
  }

  async function changePin(oldPin, newPin) {
    const ok = await unlockWithPin(oldPin);
    if (!ok) return false;
    // Re-encrypt every record, across every store (documents, images, debts,
    // bills), under the new key.
    const oldKey = sessionKey;
    const decrypted = []; // { store, id, plain }
    for (const store of DB.STORES) {
      const records = await DB.getAllRaw(store);
      for (const rec of records) {
        const plain = await decryptString(oldKey, rec.payload);
        decrypted.push({ store, id: rec.id, plain });
      }
    }
    await setupPin(newPin); // rotates salt + verifier + sessionKey
    for (const item of decrypted) {
      const payload = await encryptString(sessionKey, item.plain);
      await DB.putRaw(item.store, item.id, payload);
    }
    return true;
  }

  return { setupPin, isPinSet, unlockWithPin, lock, isUnlocked, encryptJSON, decryptJSON, changePin };
})();
