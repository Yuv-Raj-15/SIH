/**
 * Vault — Local Encrypted Credential & Payment Vault.
 * Uses Web Crypto API (AES-256-GCM + PBKDF2) + chrome.storage.local / IndexedDB.
 * All data remains strictly on-device. Zero PII is ever transmitted to cloud models.
 */

// eslint-disable-next-line no-var
var Vault = (() => {
  'use strict';

  const STORAGE_KEY = 'pv_encrypted_vault_v1';
  const SALT_KEY = 'pv_vault_salt_v1';
  const DEFAULT_PASSPHRASE = 'PrivacyVision_Local_MasterKey_2026';

  let _cryptoKey = null;

  // ── Web Crypto Key Derivation (PBKDF2 + AES-GCM 256) ────────────────

  async function _getSalt() {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([SALT_KEY], (res) => {
          if (res && res[SALT_KEY]) {
            resolve(_hexToBytes(res[SALT_KEY]));
          } else {
            const salt = crypto.getRandomValues(new Uint8Array(16));
            const hex = _bytesToHex(salt);
            chrome.storage.local.set({ [SALT_KEY]: hex }, () => resolve(salt));
          }
        });
      } else {
        let hex = localStorage.getItem(SALT_KEY);
        if (!hex) {
          const salt = crypto.getRandomValues(new Uint8Array(16));
          hex = _bytesToHex(salt);
          localStorage.setItem(SALT_KEY, hex);
        }
        resolve(_hexToBytes(hex));
      }
    });
  }

  function _bytesToHex(bytes) {
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function _hexToBytes(hex) {
    const match = hex.match(/.{1,2}/g) || [];
    return new Uint8Array(match.map((byte) => parseInt(byte, 16)));
  }

  async function _deriveKey(passphrase = DEFAULT_PASSPHRASE) {
    if (_cryptoKey) return _cryptoKey;
    const salt = await _getSalt();
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      enc.encode(passphrase),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );

    _cryptoKey = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: 100000,
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    return _cryptoKey;
  }

  // ── Encryption / Decryption Utilities ──────────────────────────────

  async function _encrypt(plainText) {
    const key = await _deriveKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const encoded = enc.encode(plainText);

    const ciphertextBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoded
    );

    const ciphertext = btoa(String.fromCharCode(...new Uint8Array(ciphertextBuffer)));
    const ivB64 = btoa(String.fromCharCode(...iv));
    return { ciphertext, iv: ivB64 };
  }

  async function _decrypt(ciphertextB64, ivB64) {
    const key = await _deriveKey();
    const iv = new Uint8Array(atob(ivB64).split('').map((c) => c.charCodeAt(0)));
    const ciphertext = new Uint8Array(atob(ciphertextB64).split('').map((c) => c.charCodeAt(0)));

    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );

    const dec = new TextDecoder();
    return dec.decode(decryptedBuffer);
  }

  // ── Underlying Storage Operations ──────────────────────────────────

  async function _loadEncryptedStore() {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([STORAGE_KEY], (res) => {
          resolve(res && res[STORAGE_KEY] ? res[STORAGE_KEY] : []);
        });
      } else {
        const raw = localStorage.getItem(STORAGE_KEY);
        resolve(raw ? JSON.parse(raw) : []);
      }
    });
  }

  async function _saveEncryptedStore(records) {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [STORAGE_KEY]: records }, () => resolve());
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
        resolve();
      }
    });
  }

  // ── Public Vault Operations ────────────────────────────────────────

  /**
   * Save a credential to the local encrypted vault.
   * @param {object} cred - { domain, name, category, data: { username, password, upiPin, ... } }
   * @returns {Promise<object>} Saved record metadata
   */
  async function saveCredential(cred) {
    const records = await _loadEncryptedStore();
    const id = cred.id || `cred_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const domain = (cred.domain || '').toLowerCase().trim();
    const category = cred.category || 'general';
    const name = cred.name || domain || 'Saved Account';

    // Encrypt sensitive payload
    const rawJson = JSON.stringify(cred.data || {});
    const encrypted = await _encrypt(rawJson);

    const record = {
      id,
      domain,
      name,
      category,
      encrypted,
      updatedAt: Date.now(),
    };

    const existingIndex = records.findIndex((r) => r.id === id);
    if (existingIndex >= 0) {
      records[existingIndex] = record;
    } else {
      records.push(record);
    }

    await _saveEncryptedStore(records);
    return record;
  }

  /**
   * Retrieve all credentials, decrypted locally.
   */
  async function getAllCredentials() {
    const records = await _loadEncryptedStore();
    const decryptedList = [];
    for (const rec of records) {
      try {
        const dataStr = await _decrypt(rec.encrypted.ciphertext, rec.encrypted.iv);
        decryptedList.push({
          id: rec.id,
          domain: rec.domain,
          name: rec.name,
          category: rec.category,
          data: JSON.parse(dataStr),
          cipherSnippet: rec.encrypted.ciphertext.substring(0, 24) + '...',
          ivSnippet: rec.encrypted.iv,
          updatedAt: rec.updatedAt,
        });
      } catch (err) {
        console.warn('[Vault] Decryption failed for record:', rec.id, err);
      }
    }
    return decryptedList;
  }

  /**
   * Get raw records with ciphertext for DevTools audit display.
   */
  async function getRawRecords() {
    return await _loadEncryptedStore();
  }

  /**
   * Find credentials matching the current webpage hostname, domain, title, or form context.
   * Supports web URLs (https://), local files (file:///), localhost, and context-based category matching.
   * @param {string} urlOrHostname - Current tab URL or hostname
   * @param {string} [contextText=''] - Optional context (document.title, form labels, user goal)
   * @returns {Promise<Array<object>>} Matching credentials sorted by relevance score
   */
  async function findMatchingCredentials(urlOrHostname, contextText = '') {
    const all = await getAllCredentials();
    if (!all || all.length === 0) return [];

    let rawUrl = (urlOrHostname || '').toLowerCase().trim();
    let context = (contextText || '').toLowerCase().trim();

    // If in browser context, also include document title and visible keywords
    if (typeof document !== 'undefined') {
      try {
        if (!context) {
          context = `${document.title || ''} ${window.location.pathname || ''}`.toLowerCase();
        } else {
          context += ` ${document.title || ''} ${window.location.pathname || ''}`.toLowerCase();
        }
      } catch {}
    }

    // Normalize target host
    let host = rawUrl;
    let path = '';
    try {
      if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
        const parsed = new URL(rawUrl);
        host = parsed.hostname;
        path = parsed.pathname.toLowerCase();
      } else if (rawUrl.startsWith('file://')) {
        path = rawUrl.replace(/^file:\/\/\/?/i, '').toLowerCase();
        host = 'localhost';
      }
    } catch {}

    const cleanHost = host.replace(/^www\./, '').split(':')[0];
    const hostParts = cleanHost.split('.');
    const hostBrand = hostParts.length >= 2 ? hostParts[0] : cleanHost;

    const scored = [];

    for (const c of all) {
      let score = 0;
      const credDomain = (c.domain || '').toLowerCase().trim();
      const credName = (c.name || '').toLowerCase().trim();
      const credCategory = (c.category || '').toLowerCase().trim();
      const credData = c.data || {};

      // Normalize stored domain
      let cleanTarget = credDomain
        .replace(/^https?:\/\//i, '')
        .replace(/^www\./i, '')
        .split('/')[0]
        .split(':')[0];
      const targetParts = cleanTarget.split('.');
      const targetBrand = targetParts.length >= 2 ? targetParts[0] : cleanTarget;

      // 1. Exact Host / Domain Match
      if (cleanHost && cleanTarget && (cleanHost === cleanTarget || host === credDomain)) {
        score = Math.max(score, 100);
      }

      // 2. Subdomain Match (e.g. auth.securebank.com vs securebank.com)
      if (cleanHost && cleanTarget && (cleanHost.endsWith('.' + cleanTarget) || cleanTarget.endsWith('.' + cleanHost))) {
        score = Math.max(score, 90);
      }

      // 3. Brand Name Match (e.g. 'amazon' in 'amazon.in' or 'amazon.com')
      if (hostBrand && targetBrand && hostBrand.length >= 3 && targetBrand.length >= 3) {
        if (hostBrand === targetBrand) score = Math.max(score, 85);
        else if (hostBrand.includes(targetBrand) || targetBrand.includes(hostBrand)) score = Math.max(score, 80);
      }

      // 4. URL or Path Match (e.g. file:///.../demo/index.html or path /bank/)
      if (cleanTarget.length >= 3 && (rawUrl.includes(cleanTarget) || path.includes(cleanTarget))) {
        score = Math.max(score, 75);
      }

      // 5. Context / Page Title Match
      if (context) {
        if (cleanTarget.length >= 3 && context.includes(cleanTarget)) {
          score = Math.max(score, 75);
        }
        if (credName.length >= 3 && context.includes(credName)) {
          score = Math.max(score, 70);
        }
        if (targetBrand.length >= 3 && context.includes(targetBrand)) {
          score = Math.max(score, 70);
        }

        // Beneficiary or account keyword in context (e.g. "Rahul", "Rent", "HDFC")
        if (credData.beneficiary && context.includes(credData.beneficiary.toLowerCase())) {
          score = Math.max(score, 85);
        }
        if (credData.username && context.includes(credData.username.toLowerCase())) {
          score = Math.max(score, 85);
        }
      }

      // 6. Category Heuristics
      // If page is a banking / fund transfer form
      const isBankingContext = /bank|transfer|neft|imps|beneficiary|accountnumber|ifsc/i.test(context + ' ' + rawUrl);
      if (isBankingContext && credCategory === 'banking') {
        score = Math.max(score, 65);
      }

      // If page is a UPI payment
      const isUpiContext = /upi|vpa|gpay|phonepe|paytm/i.test(context + ' ' + rawUrl);
      if (isUpiContext && credCategory === 'upi') {
        score = Math.max(score, 65);
      }

      // If page is a login form and credential has password
      const isLoginContext = /login|signin|sign-in|authenticate|portal|auth/i.test(context + ' ' + rawUrl);
      if (isLoginContext && credData.password) {
        score = Math.max(score, 60);
      }

      // Demo page general match
      if ((rawUrl.includes('demo') || host.includes('localhost') || rawUrl.includes('127.0.0.1')) && credDomain.includes('bank')) {
        score = Math.max(score, 60);
      }

      if (score > 0) {
        scored.push({ cred: c, score });
      }
    }

    // Sort by descending match score
    scored.sort((a, b) => b.score - a.score);

    // If no direct domain score matched, but the vault contains credentials and context has login/banking
    if (scored.length === 0 && all.length > 0) {
      const isLoginOrBank = /login|signin|password|user|bank|transfer|cred/i.test(context);
      if (isLoginOrBank) {
        // Return banking credential if bank mentioned, or first credential with password
        const bankCred = all.find(c => c.category === 'banking');
        if (/bank|transfer|neft|pay/i.test(context) && bankCred) {
          scored.push({ cred: bankCred, score: 40 });
        } else {
          const pwdCred = all.find(c => c.data?.password);
          if (pwdCred) scored.push({ cred: pwdCred, score: 30 });
        }
      }
    }

    return scored.map(s => s.cred);
  }

  /**
   * Delete a credential by ID.
   */
  async function deleteCredential(id) {
    let records = await _loadEncryptedStore();
    records = records.filter((r) => r.id !== id);
    await _saveEncryptedStore(records);
    return true;
  }

  /**
   * Seed initial mock credentials if the vault is currently empty.
   */
  async function seedInitialDemoData() {
    const existing = await _loadEncryptedStore();
    if (existing.length > 0) return;

    console.log('[Vault] Seeding demo credentials into local encrypted vault...');

    await saveCredential({
      domain: 'securebank',
      name: 'SecureBank Online Portal',
      category: 'banking',
      data: {
        username: 'priya.sharma@gmail.com',
        password: 'MyS3cur3P@ss!',
        accountNumber: '9876543210123456',
        ifsc: 'HDFC0004567',
        beneficiary: 'Rahul Mehta',
        amount: '25000',
        remarks: 'Rent for September 2026',
        upiPin: '849201',
        pin: '849201',
      },
    });

    await saveCredential({
      domain: 'upi',
      name: 'Primary UPI Handle (GPay / PhonePe)',
      category: 'upi',
      data: {
        upiId: 'priya.sharma@oksbi',
        upiPin: '849201',
        linkedBank: 'State Bank of India - A/C 7890',
        defaultAmount: '1500',
      },
    });

    await saveCredential({
      domain: 'instagram.com',
      name: 'Instagram Social Account',
      category: 'social',
      data: {
        username: 'priya_creator_official',
        password: 'InstaSecure@2026!',
      },
    });

    await saveCredential({
      domain: 'twitter.com',
      name: 'X (Twitter) Profile',
      category: 'social',
      data: {
        username: 'priya_tech_sih',
        password: 'Twitter#Shield99!',
      },
    });

    await saveCredential({
      domain: 'amazon.com',
      name: 'Amazon Prime Account',
      category: 'shopping',
      data: {
        username: 'priya.sharma@gmail.com',
        password: 'AmazonP@ssword2026!',
        name: 'Priya Sharma',
        cardNumber: '4532789012345678',
        cvv: '789',
      },
    });

    await saveCredential({
      domain: 'google.com',
      name: 'Google / Gmail Account',
      category: 'general',
      data: {
        username: 'priya.sharma@gmail.com',
        password: 'Google#Airtight2026!',
      },
    });

    console.log('[Vault] Initial demo credentials seeded successfully.');
  }

  return {
    saveCredential,
    getAllCredentials,
    getRawRecords,
    findMatchingCredentials,
    deleteCredential,
    seedInitialDemoData,
  };
})();

if (typeof globalThis !== 'undefined') {
  globalThis.Vault = Vault;
}
if (typeof self !== 'undefined') {
  self.Vault = Vault;
}
if (typeof window !== 'undefined') {
  window.Vault = Vault;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Vault;
}


