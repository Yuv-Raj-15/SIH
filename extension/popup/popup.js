/**
 * Popup Script — PrivacyVision Agent with Encrypted Vault & Biometric Face Gate.
 */

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const els = {
    tabs: $$('.tab-btn'),
    panes: $$('.tab-pane'),
    btnRun: $('#btn-run'),
    chatInput: $('#chat-input'),
    latencyBox: $('#latency-box'),
    latNer: $('#lat-ner'),
    latRedaction: $('#lat-redaction'),
    latVlm: $('#lat-vlm'),
    latDom: $('#lat-dom'),
    privacyStatusText: $('#privacy-status-text'),
    auditLocal: $('#audit-local'),
    auditCloud: $('#audit-cloud'),
    vaultList: $('#vault-list'),
    faceStatusBadge: $('#face-status-badge'),
    btnEnrollFace: $('#btn-enroll-face'),
    btnClearFace: $('#btn-clear-face'),
    camPreviewContainer: $('#face-preview-container'),
    camVideo: $('#popup-cam-video'),
    camCanvas: $('#popup-cam-canvas'),
    camMsg: $('#popup-cam-msg'),
    btnShowAddModal: $('#btn-show-add-modal'),
    addCredModal: $('#add-cred-modal'),
    btnCloseAddModal: $('#btn-close-add-modal'),
    btnCancelAdd: $('#btn-cancel-add'),
    formAddCred: $('#form-add-cred'),
  };

  let _camStream = null;
  let _enrolling = false;

  // ── Init ───────────────────────────────────────────────────────────
  function init() {
    // Tab switching
    els.tabs.forEach((tab) => {
      tab.addEventListener('click', () => switchTab(tab.dataset.target));
    });

    // Run button
    if (els.btnRun) els.btnRun.addEventListener('click', handleRunAgent);

    // Vault modal handlers
    els.btnShowAddModal.addEventListener('click', () => {
      els.addCredModal.style.display = 'flex';
    });
    els.btnCloseAddModal.addEventListener('click', () => {
      els.addCredModal.style.display = 'none';
    });
    els.btnCancelAdd.addEventListener('click', () => {
      els.addCredModal.style.display = 'none';
    });
    els.formAddCred.addEventListener('submit', handleSaveCredential);

    // Biometric face handlers
    els.btnEnrollFace.addEventListener('click', handleEnrollFace);
    els.btnClearFace.addEventListener('click', handleClearFace);

    // Update face status
    updateFaceStatusUI();

    // Fetch initial vault data
    fetchVaultData();

    // Listen for progress messages from background
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'AGENT_PROGRESS') {
        els.privacyStatusText.textContent = message.payload.message;
        els.privacyStatusText.style.color = '#0284c7';
      }
    });

    // Listen for storage changes (face enrollment or vault updates from tabs)
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local') {
          if (changes['BrowserAgent_EnrolledFace_v1']) {
            updateFaceStatusUI();
          }
          if (changes['BrowserAgent_Vault_Records_v1']) {
            fetchVaultData();
          }
        }
      });
    }
  }

  function switchTab(targetId) {
    els.tabs.forEach((t) => t.classList.toggle('active', t.dataset.target === targetId));
    els.panes.forEach((p) => p.classList.toggle('active', p.id === targetId));

    if (targetId === 'tab-vault') {
      fetchVaultData();
      updateFaceStatusUI();
    }
  }

  // ── Agent Execution Handlers ───────────────────────────────────────

  async function handleRunAgent() {
    const instruction = els.chatInput.value.trim();
    if (!instruction) return;

    els.btnRun.disabled = true;
    els.btnRun.textContent = 'Agent Running...';
    els.privacyStatusText.textContent = 'Scanning DOM & sanitizing PII locally...';
    els.privacyStatusText.style.color = '';

    els.latencyBox.style.display = 'block';
    els.latNer.textContent = '...';
    els.latRedaction.textContent = '...';
    els.latVlm.textContent = '...';
    els.latDom.textContent = '...';

    els.auditLocal.innerHTML = '<div class="placeholder-text">Scanning...</div>';
    els.auditCloud.innerHTML = '<div class="placeholder-text">Sanitizing...</div>';

    try {
      const result = await sendToBG('START_AGENT_RUN', { instruction });

      if (result.latencies) {
        els.latNer.textContent = `${result.latencies.ner || 0}ms`;
        els.latRedaction.textContent = `${result.latencies.redaction || 0}ms`;
        els.latVlm.textContent = `${result.latencies.vlm || 0}ms`;
        els.latDom.textContent = `${result.latencies.dom || 0}ms`;
      }

      if (result.audit) {
        els.auditLocal.textContent = result.audit.localText || 'No text found';
        els.auditCloud.textContent = result.audit.cloudText || 'No payload generated';
      }

      if (result.error) {
        els.privacyStatusText.textContent = `Alert: ${result.error}`;
        els.privacyStatusText.style.color = '#dc2626';
      } else if (result.actionsExecuted !== undefined) {
        els.privacyStatusText.textContent = `✓ Executed ${result.actionsExecuted} actions. 0 bytes of sensitive credentials left this device.`;
        els.privacyStatusText.style.color = '#15803d';
      } else {
        els.privacyStatusText.textContent = result.message || 'Run completed.';
        els.privacyStatusText.style.color = '#15803d';
      }
    } catch (err) {
      els.privacyStatusText.textContent = `Error: ${err.message}`;
      els.privacyStatusText.style.color = '#dc2626';
    } finally {
      els.btnRun.disabled = false;
      els.btnRun.textContent = '▶ Run Autonomous Agent';
    }
  }

  // ── Vault Management Handlers ──────────────────────────────────────

  async function fetchVaultData() {
    try {
      const res = await sendToBG('GET_VAULT_RECORDS');
      renderVault(res.credentials || []);
    } catch (err) {
      console.error('Failed to fetch vault records:', err);
      els.vaultList.innerHTML = '<div class="placeholder-text" style="color:red; text-align:center;">Failed to access vault.</div>';
    }
  }

  function renderVault(credentials) {
    if (!credentials || credentials.length === 0) {
      els.vaultList.innerHTML = '<div class="placeholder-text" style="padding: 10px; text-align: center;">Vault is empty. Click "+ Add Account" to save credentials.</div>';
      return;
    }

    els.vaultList.innerHTML = '';

    credentials.forEach((item) => {
      const cat = item.category || 'general';
      const catClass = `cat-${cat}`;
      const data = item.data || {};

      let fieldsHtml = '';
      if (data.username) {
        fieldsHtml += `
          <div class="vault-field-row">
            <span class="vault-field-label">User/Email:</span>
            <span class="vault-field-value">${_escape(data.username)}</span>
          </div>`;
      }
      if (data.password) {
        fieldsHtml += `
          <div class="vault-field-row">
            <span class="vault-field-label">Password:</span>
            <span class="vault-field-value secret-val" data-secret="${_escape(data.password)}">••••••••</span>
          </div>`;
      }
      if (data.upiId) {
        fieldsHtml += `
          <div class="vault-field-row">
            <span class="vault-field-label">UPI Handle:</span>
            <span class="vault-field-value">${_escape(data.upiId)}</span>
          </div>`;
      }
      if (data.upiPin) {
        fieldsHtml += `
          <div class="vault-field-row">
            <span class="vault-field-label">UPI PIN:</span>
            <span class="vault-field-value secret-val" data-secret="${_escape(data.upiPin)}">••••••</span>
          </div>`;
      }
      if (data.accountNumber) {
        fieldsHtml += `
          <div class="vault-field-row">
            <span class="vault-field-label">Account No:</span>
            <span class="vault-field-value">${_escape(data.accountNumber)}</span>
          </div>`;
      }

      const card = document.createElement('div');
      card.className = 'vault-item';
      card.innerHTML = `
        <div class="vault-item-header">
          <span class="vault-item-title">${_escape(item.name || item.domain)}</span>
          <span class="vault-category-badge ${catClass}">${_escape(cat)}</span>
        </div>
        <div class="vault-item-domain">🌐 ${_escape(item.domain)}</div>
        <div class="vault-fields">${fieldsHtml}</div>
        <div class="vault-field-cipher">Ciphertext: ${item.cipherSnippet || 'AES-GCM (Encrypted)'}</div>
        <div class="vault-item-footer">
          <button class="vault-action-btn btn-toggle-secret">👁️ Reveal / Hide</button>
          <button class="vault-action-btn btn-delete-cred" data-id="${item.id}">🗑️ Delete</button>
        </div>
      `;

      // Toggle secret visibility
      const toggleBtn = card.querySelector('.btn-toggle-secret');
      toggleBtn.addEventListener('click', () => {
        const secretSpans = card.querySelectorAll('.secret-val');
        secretSpans.forEach((span) => {
          if (span.textContent.includes('•')) {
            span.textContent = span.dataset.secret;
          } else {
            span.textContent = '••••••••';
          }
        });
      });

      // Delete handler
      const deleteBtn = card.querySelector('.btn-delete-cred');
      deleteBtn.addEventListener('click', async () => {
        if (confirm(`Delete saved credential for "${item.name}"?`)) {
          await sendToBG('DELETE_VAULT_RECORD', { id: item.id });
          fetchVaultData();
        }
      });

      els.vaultList.appendChild(card);
    });
  }

  async function handleSaveCredential(e) {
    e.preventDefault();
    const domain = $('#add-domain').value.trim();
    const name = $('#add-name').value.trim();
    const category = $('#add-category').value;
    const username = $('#add-username').value.trim();
    const password = $('#add-password').value.trim();
    const upiPin = $('#add-pin').value.trim();
    const accountNumber = $('#add-account').value.trim();
    const ifsc = $('#add-ifsc').value.trim();

    const credPayload = {
      domain,
      name,
      category,
      data: {
        username: username || undefined,
        password: password || undefined,
        upiPin: upiPin || undefined,
        accountNumber: accountNumber || undefined,
        ifsc: ifsc || undefined,
      },
    };

    try {
      await sendToBG('SAVE_VAULT_RECORD', credPayload);
      els.addCredModal.style.display = 'none';
      els.formAddCred.reset();
      fetchVaultData();
    } catch (err) {
      alert('Failed to save credential: ' + err.message);
    }
  }

  // ── Biometric Face Recognition Enrollment ──────────────────────────

  async function updateFaceStatusUI() {
    let faceProfile = null;
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      faceProfile = await new Promise((resolve) => {
        chrome.storage.local.get(['BrowserAgent_EnrolledFace_v1'], (res) => {
          resolve(res && res['BrowserAgent_EnrolledFace_v1'] ? res['BrowserAgent_EnrolledFace_v1'] : null);
        });
      });
    }

    if (!faceProfile) {
      const raw = localStorage.getItem('BrowserAgent_EnrolledFace_v1');
      if (raw) {
        try { faceProfile = JSON.parse(raw); } catch {}
      }
    }

    if (faceProfile && faceProfile.signature) {
      els.faceStatusBadge.textContent = '✓ ENROLLED & ACTIVE';
      els.faceStatusBadge.className = 'badge badge-success';
      els.btnClearFace.style.display = 'inline-block';
      els.btnEnrollFace.textContent = '📸 Manage Biometrics / Re-Enroll';
    } else {
      els.faceStatusBadge.textContent = 'NOT ENROLLED';
      els.faceStatusBadge.className = 'badge badge-secondary';
      els.btnClearFace.style.display = 'none';
      els.btnEnrollFace.textContent = '📸 Enroll Face Biometrics';
    }
  }

  function handleEnrollFace() {
    // Open dedicated tab to ensure Chromium native camera permission prompt works
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url: chrome.runtime.getURL('face_enroll.html') });
    } else {
      window.open(chrome.runtime.getURL('face_enroll.html'), '_blank');
    }
  }

  async function handleClearFace() {
    if (confirm('Clear your enrolled face profile from this device?')) {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await new Promise((r) => chrome.storage.local.remove(['BrowserAgent_EnrolledFace_v1'], r));
      }
      try { localStorage.removeItem('BrowserAgent_EnrolledFace_v1'); } catch {}
      updateFaceStatusUI();
    }
  }

  function _computeNormalizedSignature(canvas) {
    const sCanvas = document.createElement('canvas');
    sCanvas.width = 64;
    sCanvas.height = 64;
    const ctx = sCanvas.getContext('2d');
    ctx.drawImage(canvas, 0, 0, 64, 64);

    const imgData = ctx.getImageData(0, 0, 64, 64);
    const pixels = imgData.data;
    const vec = [];
    let sum = 0;

    for (let i = 0; i < pixels.length; i += 4) {
      const lum = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
      vec.push(lum);
      sum += lum;
    }
    const mean = sum / vec.length;
    return vec.map((v) => v - mean);
  }

  // ── Utils ──────────────────────────────────────────────────────────

  function sendToBG(type, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, payload }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response) {
          reject(new Error('No response from background'));
          return;
        }
        if (!response.success) {
          reject(new Error(response.error || 'Unknown background error'));
          return;
        }
        resolve(response.data);
      });
    });
  }

  function _escape(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    }[m]));
  }

  init();
})();
