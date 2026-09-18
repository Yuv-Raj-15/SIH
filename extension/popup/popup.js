/**
 * Popup Script — PrivacyVision Dual-AI Command Center
 * Orchestrates:
 *  - Dual-AI Pipeline Visualization (AI-1 Reasoning + AI-2 Decision)
 *  - On-Device Perception & Masking Showcase
 *  - Encrypted Hardware-Isolated Vault & Face Biometrics
 *  - Live Zero-Leak Audit
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
    promptChips: $$('.prompt-chip'),
    
    // Pipeline stages
    pipelineCard: $('#pipeline-card'),
    pipelineStepCounter: $('#pipeline-step-counter'),
    stageLocal: $('#stage-local'),
    stageAi1: $('#stage-ai1'),
    stageAi2: $('#stage-ai2'),
    stageInject: $('#stage-inject'),
    conn1: $('#conn-1'),
    conn2: $('#conn-2'),
    conn3: $('#conn-3'),

    // Telemetry
    latencyBox: $('#latency-box'),
    latNer: $('#lat-ner'),
    latRedaction: $('#lat-redaction'),
    latReasoning: $('#lat-reasoning'),
    latDecision: $('#lat-decision'),
    latDom: $('#lat-dom'),

    // Status
    privacyStatusText: $('#privacy-status-text'),
    statusTitle: $('#status-title'),
    leakBadge: $('#leak-badge'),
    quickMaskStrip: $('#quick-mask-strip'),
    qmTitle: $('#qm-title'),
    qmSubtitle: $('#qm-subtitle'),
    btnJumpMasking: $('#btn-jump-masking'),

    // Masking tab
    maskingBadge: $('#masking-badge'),
    metricMaskedCount: $('#metric-masked-count'),
    ledgerEntityCount: $('#ledger-entity-count'),
    ledgerList: $('#ledger-list'),
    auditMaskedImg: $('#audit-masked-img'),
    visualPlaceholder: $('#visual-placeholder'),

    // Vault
    vaultList: $('#vault-list'),
    faceStatusBadge: $('#face-status-badge'),
    btnEnrollFace: $('#btn-enroll-face'),
    btnClearFace: $('#btn-clear-face'),
    btnShowAddModal: $('#btn-show-add-modal'),
    addCredModal: $('#add-cred-modal'),
    btnCloseAddModal: $('#btn-close-add-modal'),
    btnCancelAdd: $('#btn-cancel-add'),
    formAddCred: $('#form-add-cred'),

    // Audit tab
    auditLocalText: $('#audit-local-text'),
    auditCloudText: $('#audit-cloud-text'),

  };

  // Internal state for execution tracking
  let _executionMeta = null;

  // ── Initialization ─────────────────────────────────────────────────
  function init() {
    // 1. Tab navigation
    els.tabs.forEach((tab) => {
      tab.addEventListener('click', () => switchTab(tab.dataset.target));
    });

    // 2. Quick prompt chips
    els.promptChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        if (els.chatInput) {
          els.chatInput.value = chip.dataset.prompt;
          els.chatInput.focus();
        }
      });
    });

    // 3. Jump to masking tab button
    if (els.btnJumpMasking) {
      els.btnJumpMasking.addEventListener('click', () => switchTab('tab-masking'));
    }

    // 4. Run autonomous agent button (1-Step Direct Execution)
    if (els.btnRun) {
      els.btnRun.addEventListener('click', handleRunAgent);
    }

    // 5. Enter key triggers agent run
    if (els.chatInput) {
      els.chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          handleRunAgent();
        }
      });
    }

    // Check if agent is currently running in background
    sendToBG('GET_STATUS', {}, 2000).then((status) => {
      if (status && status.isProcessing) {
        els.btnRun.disabled = true;
        els.btnRun.querySelector('.btn-text').textContent = 'Dual-AI Orchestrating...';
        if (els.statusTitle) els.statusTitle.textContent = 'Agent Running';
        if (els.privacyStatusText) els.privacyStatusText.textContent = 'Agent is executing tasks in the background...';
        if (els.latencyBox) els.latencyBox.style.display = 'flex';
        setStageActive(els.stageLocal);
      }
    }).catch(() => {});

    // 6. Vault modals & actions
    if (els.btnShowAddModal) {
      els.btnShowAddModal.addEventListener('click', () => {
        els.addCredModal.style.display = 'flex';
      });
    }
    if (els.btnCloseAddModal) {
      els.btnCloseAddModal.addEventListener('click', () => {
        els.addCredModal.style.display = 'none';
      });
    }
    if (els.btnCancelAdd) {
      els.btnCancelAdd.addEventListener('click', () => {
        els.addCredModal.style.display = 'none';
      });
    }
    if (els.formAddCred) {
      els.formAddCred.addEventListener('submit', handleSaveCredential);
    }

    // 6. Biometric Face handlers
    if (els.btnEnrollFace) {
      els.btnEnrollFace.addEventListener('click', handleEnrollFace);
    }
    if (els.btnClearFace) {
      els.btnClearFace.addEventListener('click', handleClearFace);
    }

    // Initial state setup
    updateFaceStatusUI();
    fetchVaultData();
    fetchInitialAudit(true);

    // Progress + completion listener from background service worker
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'AGENT_PROGRESS') {
        handleProgressUpdate(message.payload);
      } else if (message.type === 'AGENT_COMPLETE') {
        handleAgentComplete(message.payload);
      }
    });

    // Storage listener (for updates from other tabs)
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local') {
          if (changes['BrowserAgent_EnrolledFace_v1']) updateFaceStatusUI();
          if (changes['BrowserAgent_Vault_Records_v1']) fetchVaultData();
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
    } else if (targetId === 'tab-masking' || targetId === 'tab-audit') {
      fetchInitialAudit(true);
    }
  }

  // ── Pipeline Progress Tracking ─────────────────────────────────────
  function handleProgressUpdate(payload) {
    if (!payload) return;
    
    if (els.pipelineStepCounter) {
      els.pipelineStepCounter.textContent = `Step ${payload.step || 1}/${payload.maxSteps || 15}`;
    }

    if (els.privacyStatusText) {
      els.privacyStatusText.textContent = payload.message || 'Processing...';
    }

    const phase = (payload.phase || '').toLowerCase();
    const msg = (payload.message || '').toLowerCase();

    // Planning phase — update the plan loading UI
    if (phase === 'planning') {
      if (els.privacyStatusText) {
        els.privacyStatusText.textContent = payload.message || 'Planning...';
        els.privacyStatusText.style.color = '';
      }
      return; // Don't reset pipeline visuals during planning
    }

    // Reset stages
    resetPipelineVisuals();

    if (phase === 'ner' || msg.includes('analyzing') || msg.includes('masking')) {
      setStageActive(els.stageLocal);
      if (els.statusTitle) els.statusTitle.textContent = 'Local On-Device Masking';
    } else if (phase === 'ai_reasoning' || msg.includes('ai-1') || msg.includes('reasoning')) {
      setStageCompleted(els.stageLocal);
      setConnectorActive(els.conn1);
      setStageActive(els.stageAi1);
      if (els.statusTitle) els.statusTitle.textContent = 'AI-1: Vision Reasoning (Key 1)';
    } else if (phase === 'ai_decision' || msg.includes('ai-2') || msg.includes('decision')) {
      setStageCompleted(els.stageLocal);
      setStageCompleted(els.stageAi1);
      setConnectorActive(els.conn1);
      setConnectorActive(els.conn2);
      setStageActive(els.stageAi2);
      if (els.statusTitle) els.statusTitle.textContent = 'AI-2: Tactical Planning (Key 2)';
    } else if (phase === 'executing' || msg.includes('executing') || msg.includes('actions')) {
      setStageCompleted(els.stageLocal);
      setStageCompleted(els.stageAi1);
      setStageCompleted(els.stageAi2);
      setConnectorActive(els.conn1);
      setConnectorActive(els.conn2);
      setConnectorActive(els.conn3);
      setStageActive(els.stageInject);
      if (els.statusTitle) els.statusTitle.textContent = 'DOM Action Execution';
    }
  }

  function resetPipelineVisuals() {
    [els.stageLocal, els.stageAi1, els.stageAi2, els.stageInject].forEach((s) => {
      if (s) {
        s.classList.remove('active', 'completed');
      }
    });
    [els.conn1, els.conn2, els.conn3].forEach((c) => {
      if (c) c.classList.remove('active');
    });
  }

  function setStageActive(stageEl) {
    if (stageEl) stageEl.classList.add('active');
  }

  function setStageCompleted(stageEl) {
    if (stageEl) stageEl.classList.add('completed');
  }

  function setConnectorActive(connEl) {
    if (connEl) connEl.classList.add('active');
  }



  /**
   * Pure client-side PII tokenizer in popup for instant zero-dependency masking.
   */
  function _sanitizeInstructionLocally(text) {
    if (!text || typeof text !== 'string') return { sanitized: text, tokenMap: {} };
    const tokenMap = {};
    let result = text;
    const _tok = (label) => `[${label}_${Math.random().toString(36).substring(2, 6)}]`;

    // 1. Social usernames in natural language phrases (e.g. "profile for yuvraj_rauniyar15", "follow yuvraj_rauniyar15")
    const TARGET_REGEX = /(?:follow(?:ing)?|request to|profile (?:for|of)?|user(?:name)?|account|message|dm|visit|target)\s+@?([a-zA-Z0-9_.]{3,35})\b/gi;
    const reservedWords = [
      'the', 'this', 'that', 'page', 'profile', 'user', 'site', 'website', 'account',
      'tab', 'browser', 'feed', 'post', 'story', 'reel', 'explore', 'home', 'request',
      'button', 'link', 'instagram', 'twitter', 'facebook', 'linkedin', 'github', 'amazon', 'google'
    ];
    let tm;
    while ((tm = TARGET_REGEX.exec(result)) !== null) {
      const handle = tm[1];
      if (!reservedWords.includes(handle.toLowerCase())) {
        let token = Object.keys(tokenMap).find(k => tokenMap[k] === handle);
        if (!token) {
          token = _tok('TARGET_USER');
          tokenMap[token] = handle;
        }
        result = result.replaceAll(handle, token);
      }
    }

    const PATTERNS = [
      { label: 'UPI_ID', regex: /[a-zA-Z0-9.\-_]+@(?:oksbi|okhdfcbank|okicici|okaxis|ybl|paytm|ibl|upi|axl|sbi|apl)\b/g },
      { label: 'EMAIL', regex: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g },
      { label: 'PHONE', regex: /(?:\+91[\s\-.]?)?\b\d{5}[\s\-.]?\d{5}\b|\+\d{1,3}[\s\-.]?\d{6,12}/g },
      { label: 'CREDIT_CARD', regex: /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g },
      { label: 'AADHAAR', regex: /\b[2-9]\d{3}[\s\-]?\d{4}[\s\-]?\d{4}\b/g },
      { label: 'PAN', regex: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
      { label: 'IFSC_CODE', regex: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g },
      { label: 'TARGET_USER', regex: /(?:https?:\/\/)?(?:www\.)?(?:instagram\.com|twitter\.com|x\.com|github\.com|threads\.net|linkedin\.com\/in)\/([a-zA-Z0-9_.]{3,35})\/?/gi },
      { label: 'PIN', regex: /\b(?:pin|cvv|otp)[\s:=]+(\d{3,6})\b/gi },
      { label: 'PASSWORD', regex: /\b(?:password|pass)[\s:=]+(\S+)\b/gi },
      { label: 'USERNAME', regex: /@([a-zA-Z0-9_.]{3,35})\b/g },
    ];

    for (const { label, regex } of PATTERNS) {
      regex.lastIndex = 0;
      result = result.replace(regex, (match) => {
        const existing = Object.keys(tokenMap).find(k => tokenMap[k] === match);
        if (existing) return existing;
        const token = _tok(label);
        tokenMap[token] = match;
        return token;
      });
    }
    return { sanitized: result, tokenMap };
  }



  /**
   * Called when background fires AGENT_COMPLETE with the final run result.
   */
  function handleAgentComplete(result) {
    if (!result) return;

    // Update latencies
    if (result.latencies) {
      if (els.latNer) els.latNer.textContent = `${result.latencies.ner || 0}ms`;
      if (els.latRedaction) els.latRedaction.textContent = `${result.latencies.redaction || 0}ms`;
      if (els.latReasoning) els.latReasoning.textContent = result.latencies.reasoning
        ? `${Math.round(result.latencies.reasoning)}ms`
        : `${result.latencies.vlm || 0}ms`;
      if (els.latDecision) els.latDecision.textContent = result.latencies.decision
        ? `${Math.round(result.latencies.decision)}ms` : '--';
      if (els.latDom) els.latDom.textContent = `${result.latencies.dom || 0}ms`;
    }

    if (result.audit) {
      renderMaskingShowcase(result.audit);
      renderAudit(result.audit);
    }

    const meta = _executionMeta || {};
    if (result.error) {
      if (els.statusTitle) els.statusTitle.textContent = 'Alert / Issue';
      if (els.privacyStatusText) {
        els.privacyStatusText.textContent = result.error;
        els.privacyStatusText.style.color = '#f43f5e';
      }
    } else {
      if (els.statusTitle) els.statusTitle.textContent = 'Goal Accomplished';
      const actionsCount = result.actionsExecuted || 0;
      const piiNote = (meta?.piiCount || 0) > 0
        ? ` ${meta.piiCount} PII tokens resolved on-device.` : '';
      if (els.privacyStatusText) {
        els.privacyStatusText.textContent =
          `Done: ${actionsCount} actions executed.${piiNote} 0 bytes of sensitive credentials left this PC.`;
        els.privacyStatusText.style.color = '#34d399';
      }
      [els.stageLocal, els.stageAi1, els.stageAi2, els.stageInject].forEach((s) => {
        if (s) s.classList.add('completed');
      });
      [els.conn1, els.conn2, els.conn3].forEach((c) => {
        if (c) c.classList.add('active');
      });
    }

    // Re-enable controls
    if (els.btnRun) {
      els.btnRun.disabled = false;
      els.btnRun.querySelector('.btn-text').textContent = 'Run Agent';
    }
    _executionMeta = null;
  }

  // ── 1-Step Direct Execution ───────────────────────────────
  async function handleRunAgent() {
    const instruction = els.chatInput.value.trim();
    if (!instruction) return;

    // Local PII Sanitization
    const { sanitized, tokenMap } = _sanitizeInstructionLocally(instruction);
    const piiCount = Object.keys(tokenMap).length;

    _executionMeta = { tokenMap, piiCount };

    els.btnRun.disabled = true;
    els.btnRun.querySelector('.btn-text').textContent = 'Dual-AI Orchestrating...';
    if (els.statusTitle) els.statusTitle.textContent = 'Agent Initializing';
    els.privacyStatusText.textContent = 'Starting on-device PII scan & dual-agent reasoning...';
    els.privacyStatusText.style.color = '';

    els.latencyBox.style.display = 'flex';
    els.latNer.textContent = '...';
    els.latRedaction.textContent = '...';
    els.latReasoning.textContent = '...';
    els.latDecision.textContent = '...';
    els.latDom.textContent = '...';

    setStageActive(els.stageLocal);

    try {
      // Fire-and-forget: background responds immediately with {started: true}.
      // Actual results arrive via AGENT_COMPLETE message event.
      await sendToBG('START_AGENT_RUN', {
        instruction: sanitized,
        tokenMap,
      });
      // ack received — UI stays in running state until AGENT_COMPLETE fires
    } catch (err) {
      if (els.statusTitle) els.statusTitle.textContent = 'Execution Error';
      els.privacyStatusText.textContent = `Error: ${err.message}`;
      els.privacyStatusText.style.color = '#f43f5e';
      els.btnRun.disabled = false;
      els.btnRun.querySelector('.btn-text').textContent = 'Run Agent';
    }
  }


  // ── Showcase: What Local Model Has Done ─────────────────────────────
  function renderMaskingShowcase(audit) {
    if (!audit) return;

    const ledger = audit.localMaskingLedger;
    const redactionsCount = audit.redactionsCount || (ledger?.total_masked) || 0;

    // Badges & Counters
    if (els.maskingBadge) els.maskingBadge.textContent = redactionsCount;
    if (els.metricMaskedCount) els.metricMaskedCount.textContent = redactionsCount;
    if (els.ledgerEntityCount) els.ledgerEntityCount.textContent = `${redactionsCount} Items Protected`;

    // Quick Mask Strip on Run tab
    if (els.quickMaskStrip) {
      if (redactionsCount > 0) {
        els.quickMaskStrip.style.display = 'flex';
        if (els.qmTitle) els.qmTitle.textContent = `Shielded ${redactionsCount} Sensitive Entities On-Device`;
        if (els.qmSubtitle) els.qmSubtitle.textContent = 'Plaintext passwords and PII never reached the cloud';
      } else {
        els.quickMaskStrip.style.display = 'none';
      }
    }

    // Render Masked Screenshot Preview
    if (audit.sanitizedImage && els.auditMaskedImg) {
      els.auditMaskedImg.src = audit.sanitizedImage;
      els.auditMaskedImg.style.display = 'block';
      if (els.visualPlaceholder) els.visualPlaceholder.style.display = 'none';
    }

    // Render Ledger list
    if (els.ledgerList) {
      if (!ledger || !ledger.entities || Object.keys(ledger.entities).length === 0) {
        if (redactionsCount === 0) {
          els.ledgerList.innerHTML = `
            <div class="empty-placeholder">
              <span>✓ Page scanned: No plaintext passwords or sensitive PII detected on this screen.</span>
            </div>`;
        }
        return;
      }

      let rowsHtml = '';
      for (const [entityType, info] of Object.entries(ledger.entities)) {
        const tokensStr = info.tokens && info.tokens.length > 0 ? info.tokens.join(', ') : 'Protected Token';
        let techClass = 'tech-token';
        if (info.technique.toLowerCase().includes('blackout')) techClass = 'tech-blackout';
        else if (info.technique.toLowerCase().includes('blur')) techClass = 'tech-blur';

        rowsHtml += `
          <div class="ledger-row">
            <div class="ledger-entity">
              <span>🔒</span>
              <div>
                <strong>${_escape(entityType)}</strong> (${info.count} instance${info.count > 1 ? 's' : ''})
                <div style="font-size: 0.62rem; color: #94a3b8;">Token: ${tokensStr}</div>
              </div>
            </div>
            <span class="ledger-tech ${techClass}">${_escape(info.technique)}</span>
          </div>
        `;
      }
      els.ledgerList.innerHTML = rowsHtml;
    }
  }

  // ── Live Audit Rendering ───────────────────────────────────────────
  async function fetchInitialAudit(forceActiveScan = false) {
    try {
      let audit = await sendToBG('GET_AUDIT_DATA');
      // If no audit, or requested live scan, or previous scan had 0 entities, run active on-demand scan!
      if (!audit || forceActiveScan || !audit.sanitizedImage || (audit.redactionsCount === 0 && !audit.localText)) {
        const liveAudit = await sendToBG('QUICK_SCAN_ACTIVE_TAB');
        if (liveAudit && (liveAudit.redactionsCount > 0 || !audit)) {
          audit = liveAudit;
        }
      }
      if (audit) {
        renderMaskingShowcase(audit);
        renderAudit(audit);
      }
    } catch (err) {
      console.warn('Could not fetch audit data:', err);
    }
  }

  function renderAudit(audit) {
    if (!audit) return;
    if (els.auditLocalText) {
      els.auditLocalText.textContent = audit.localText || 'No PII detected locally.';
    }
    if (els.auditCloudText) {
      els.auditCloudText.textContent = audit.cloudSummary || audit.cloudText || 'No payload generated.';
    }
  }

  // ── Vault Management ───────────────────────────────────────────────
  async function fetchVaultData() {
    try {
      const res = await sendToBG('GET_VAULT_RECORDS');
      renderVault(res.credentials || []);
    } catch (err) {
      if (els.vaultList) {
        els.vaultList.innerHTML = '<div class="empty-placeholder" style="color:#f43f5e;">Failed to access local vault.</div>';
      }
    }
  }

  function renderVault(credentials) {
    if (!els.vaultList) return;

    if (!credentials || credentials.length === 0) {
      els.vaultList.innerHTML = '<div class="empty-placeholder">Local vault is empty. Click "+ Add Account" to save credentials.</div>';
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
            <span class="vault-field-label">UPI ID:</span>
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
        <div class="vault-field-cipher">Cipher: ${item.cipherSnippet || 'AES-256-GCM (Hardware Memory)'}</div>
        <div class="vault-item-footer">
          <button class="vault-action-btn btn-toggle-secret">👁️ Reveal</button>
          <button class="vault-action-btn btn-delete-cred" data-id="${item.id}">🗑️ Delete</button>
        </div>
      `;

      // Reveal / hide secret toggle
      const toggleBtn = card.querySelector('.btn-toggle-secret');
      toggleBtn.addEventListener('click', () => {
        const secretSpans = card.querySelectorAll('.secret-val');
        secretSpans.forEach((span) => {
          if (span.textContent.includes('•')) {
            span.textContent = span.dataset.secret;
            toggleBtn.textContent = '🔒 Hide';
          } else {
            span.textContent = '••••••••';
            toggleBtn.textContent = '👁️ Reveal';
          }
        });
      });

      // Delete handler
      const deleteBtn = card.querySelector('.btn-delete-cred');
      deleteBtn.addEventListener('click', async () => {
        if (confirm(`Delete local credential for "${item.name}"?`)) {
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

    const data = {};
    if (username) data.username = username;
    if (password) data.password = password;
    if (upiPin) data.upiPin = upiPin;
    if (accountNumber) data.accountNumber = accountNumber;
    if (ifsc) data.ifsc = ifsc;

    await sendToBG('SAVE_VAULT_RECORD', {
      domain,
      name,
      category,
      data
    });

    els.addCredModal.style.display = 'none';
    els.formAddCred.reset();
    fetchVaultData();
  }

  // ── Face Biometrics Status ─────────────────────────────────────────
  async function updateFaceStatusUI() {
    if (!els.faceStatusBadge) return;
    try {
      const faceData = await sendToBG('GET_ENROLLED_FACE');
      if (faceData && faceData.enrolled) {
        els.faceStatusBadge.textContent = 'ACTIVE';
        els.faceStatusBadge.className = 'badge badge-success';
        if (els.btnClearFace) els.btnClearFace.style.display = 'inline-block';
      } else {
        els.faceStatusBadge.textContent = 'NOT ENROLLED';
        els.faceStatusBadge.className = 'badge badge-secondary';
        if (els.btnClearFace) els.btnClearFace.style.display = 'none';
      }
    } catch {
      els.faceStatusBadge.textContent = 'OFFLINE';
    }
  }

  function handleEnrollFace() {
    chrome.tabs.create({ url: chrome.runtime.getURL('face_enroll.html') });
  }

  async function handleClearFace() {
    if (confirm('Clear enrolled face biometrics?')) {
      await sendToBG('CLEAR_ENROLLED_FACE');
      updateFaceStatusUI();
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────
  /**
   * Send a message to the background service worker.
   * Includes a timeout guard so the popup never hangs if background is silent.
   */
  function sendToBG(type, payload = {}, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Background timeout: no response for '${type}' after ${timeoutMs / 1000}s`));
      }, timeoutMs);

      try {
        chrome.runtime.sendMessage({ type, payload }, (res) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (res && res.success === false) {
            reject(new Error(res.error || 'Operation failed'));
          } else {
            resolve(res?.data !== undefined ? res.data : res);
          }
        });
      } catch (err) {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      }
    });
  }

  function _escape(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Boot
  document.addEventListener('DOMContentLoaded', init);
})();
