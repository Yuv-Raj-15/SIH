/**
 * Content Script — Injected into every page.
 * Handles: DOM analysis, PII scanning, action execution.
 * Communicates with the background service worker via chrome.runtime messages.
 */

(() => {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────
  let _isScanning = false;
  let _lastScanResult = null;
  let _overlays = [];

  // ── Message Handlers — declared BEFORE listener to avoid TDZ ──────
  // CRITICAL: MESSAGE_HANDLERS must be defined before onMessage.addListener
  // because const/let are NOT hoisted. The listener fires synchronously
  // on the first message and would hit a ReferenceError otherwise.
  const MESSAGE_HANDLERS = {
    /**
     * Analyze the DOM and scan for PII. Returns structured data.
     */
    ANALYZE_PAGE: async () => {
      _isScanning = true;
      document.documentElement.classList.add('pv-scanning-active');

      try {
        // 1. Analyze DOM structure
        const domAnalysis = DOMAnalyzer.analyze(document.body);

        // 2. Scan for PII
        const piiResult = PIIScanner.scanDOM(document.body);

        // 3. Sanitize the DOM structure (replace PII with tokens)
        const sanitizedDOM = PIIScanner.sanitizeDOMStructure(domAnalysis, piiResult.allFindings);

        // 4. Generate text summary (legacy format, kept for backward compat)
        let textSummary = DOMAnalyzer.generateTextSummary(sanitizedDOM);

        // 4b. Generate structured JSON summary (preferred — AI-2 can pick selectors by index)
        const domStructured = DOMAnalyzer.generateStructuredSummary(sanitizedDOM);

        // Check if on-device encrypted vault has matching credentials for this page
        if (typeof Vault !== 'undefined') {
          try {
            const vaultMatches = await Vault.findMatchingCredentials(window.location.href);
            if (vaultMatches && vaultMatches.length > 0) {
              const top = vaultMatches[0];
              const availableFields = Object.keys(top.data || {}).filter(k => top.data[k]);
              textSummary += `\n\n[LOCAL ENCRYPTED VAULT STATUS: Saved account credentials found for "${top.name || top.domain}" (${top.category}): fields available [${availableFields.join(', ')}]. If login form, passwords, or credential blanks need filling, use type with tokens (e.g. value="[USERNAME]", value="[PASSWORD]", value="[PIN]") or action "autofill" to auto-extract safely on-device.]`;
            }
          } catch (vaultErr) {
            console.warn('[PrivacyVision] Non-fatal vault hint warning:', vaultErr);
          }
        }

        // 5. Build redaction regions (pixel coordinates for screenshot redaction)
        const redactionRegions = _buildRedactionRegions(piiResult);

        _lastScanResult = {
          domAnalysis: sanitizedDOM,
          domStructured,          // Structured JSON for AI-2 indexed selector picking
          textSummary,
          piiFindings: piiResult.allFindings.map((f) => ({
            type: f.type,
            severity: f.severity,
            token: f.token,
            rect: f.rect,
            source: f.source,
            label: f.type,
          })),
          redactionRegions,
          tokenMap: piiResult.tokenMap,
          summary: piiResult.summary,
        };

        return _lastScanResult;
      } finally {
        _isScanning = false;
        setTimeout(() => {
          document.documentElement.classList.remove('pv-scanning-active');
        }, 1500);
      }
    },

    /**
     * Execute actions received from the server.
     */
    EXECUTE_ACTIONS: async (payload) => {
      const { actions, tokenMap } = payload;
      if (!actions || !Array.isArray(actions)) {
        throw new Error('Invalid actions payload');
      }
      if (tokenMap && typeof PIIScanner !== 'undefined' && PIIScanner.registerTokens) {
        PIIScanner.registerTokens(tokenMap);
      }
      const results = await ActionExecutor.executeActions(actions, tokenMap);
      return { results, log: ActionExecutor.getActionLog() };
    },

    /** Show local PII overlays after the screenshot has been captured. */
    SHOW_OVERLAYS: (payload = {}) => {
      _showRedactionOverlays(payload.findings || []);
      return { shown: (payload.findings || []).length };
    },

    /**
     * Redact screenshot on-device using Canvas API directly in content script.
     */
    REDACT_IMAGE: async (payload = {}) => {
      const { imageDataUrl, regions, options } = payload;
      if (!imageDataUrl) throw new Error('No image provided for redaction');
      if (typeof RedactionEngine !== 'undefined') {
        return await RedactionEngine.redact(imageDataUrl, regions || [], options || {});
      }
      throw new Error('RedactionEngine not loaded in content script');
    },

    /**
     * Clear all visual overlays.
     */
    CLEAR_OVERLAYS: () => {
      _clearOverlays();
      return { cleared: true };
    },

    /**
     * Sanitize user instruction before sending prompt to cloud server.
     */
    SANITIZE_INSTRUCTION: (payload = {}) => {
      const text = payload.text || '';
      if (payload.tokenMap && typeof PIIScanner !== 'undefined' && PIIScanner.registerTokens) {
        PIIScanner.registerTokens(payload.tokenMap);
      }
      if (typeof PIIScanner !== 'undefined' && PIIScanner.sanitizeInstruction) {
        const sanitized = PIIScanner.sanitizeInstruction(text);
        return { sanitized, tokenMap: PIIScanner.getTokenMap() };
      }
      return { sanitized: text, tokenMap: payload.tokenMap || {} };
    },

    /**
     * Get the last scan result (cached).
     */
    GET_LAST_SCAN: () => {
      return _lastScanResult;
    },

    /**
     * Quick PII count (lightweight scan without full DOM analysis).
     */
    QUICK_PII_COUNT: () => {
      const piiResult = PIIScanner.scanDOM(document.body);
      return piiResult.summary;
    },

    /**
     * Get page metadata.
     */
    GET_PAGE_INFO: () => {
      return {
        url: window.location.href,
        title: document.title,
        domain: window.location.hostname,
        success: true,
      };
    },

    /**
     * Trigger smart local autofill for the current page from local encrypted vault.
     */
    AUTOFILL_FORM: async () => {
      return await ActionExecutor.executeActions([{ type: 'autofill' }]);
    },

    /**
     * Trigger payment flow: autofill details, biometric face verification, and payment execution.
     */
    AUTHORIZE_AND_PAY: async () => {
      return await ActionExecutor.executeActions([{ type: 'authorize_and_pay' }]);
    },

    /**
     * Get matching credentials for current page from local vault.
     */
    GET_VAULT_MATCHES: async () => {
      if (typeof Vault === 'undefined') return [];
      return await Vault.findMatchingCredentials(window.location.href);
    },
  };

  // ── Message listener — always calls sendResponse, never leaves channel open ──
  // Rules enforced here:
  // 1. If handler exists: wrap in Promise, always resolve/reject → always sendResponse.
  // 2. If handler missing: immediately sendResponse with error, return false (sync).
  // 3. Async handlers are guarded with a 60s timeout so the channel never hangs.
  const HANDLER_TIMEOUT_MS = 60_000;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') {
      sendResponse({ success: false, error: 'Invalid message format' });
      return false;
    }

    const handler = MESSAGE_HANDLERS[message.type];

    if (!handler) {
      // No handler — respond immediately so Chrome doesn't hold the port open
      sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
      return false;
    }

    // Wrap both sync and async handlers uniformly in a Promise
    let settled = false;
    const safeRespond = (response) => {
      if (settled) return;
      settled = true;
      try { sendResponse(response); } catch { /* port may have closed */ }
    };

    // Timeout guard: if the handler takes too long, close gracefully
    const timeoutId = setTimeout(() => {
      console.warn(`[PrivacyVision] Handler '${message.type}' timed out after ${HANDLER_TIMEOUT_MS}ms`);
      safeRespond({ success: false, error: `Handler timed out: ${message.type}` });
    }, HANDLER_TIMEOUT_MS);

    Promise.resolve()
      .then(() => handler(message.payload || {}))
      .then((data) => {
        clearTimeout(timeoutId);
        safeRespond({ success: true, data });
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        console.error(`[PrivacyVision] Handler '${message.type}' error:`, err);
        safeRespond({ success: false, error: err?.message || String(err) });
      });

    return true; // Keep channel open for async response
  });

  // ── Redaction region builder ────────────────────────────────────────

  function _buildRedactionRegions(piiResult) {
    const regions = [];
    const dpr = window.devicePixelRatio || 1;

    for (const finding of piiResult.allFindings) {
      if (!finding.rect || (finding.rect.width === 0 && finding.rect.height === 0)) continue;

      const viewportRect = {
        x: (finding.rect.x - window.scrollX) * dpr,
        y: (finding.rect.y - window.scrollY) * dpr,
        width: finding.rect.width * dpr,
        height: finding.rect.height * dpr,
      };

      if (viewportRect.y + viewportRect.height < 0 || viewportRect.y > window.innerHeight * dpr) continue;
      if (viewportRect.x + viewportRect.width < 0 || viewportRect.x > window.innerWidth * dpr) continue;

      const pad = 4 * dpr;
      const isFace = finding.type === 'FACE_IMAGE' || finding.type === 'FACE';
      regions.push({
        x: viewportRect.x - pad,
        y: viewportRect.y - pad,
        width: viewportRect.width + pad * 2,
        height: viewportRect.height + pad * 2,
        type: finding.type,
        token: finding.token,
        label: isFace ? '[FACE MASKED]' : (finding.token || finding.type),
        severity: finding.severity,
        method: isFace ? 'blur' : 'blackout',
      });
    }

    return regions;
  }

  // ── Visual overlay management ───────────────────────────────────────

  function _showRedactionOverlays(findings) {
    _clearOverlays();

    for (const finding of findings) {
      if (!finding.rect || (finding.rect.width === 0 && finding.rect.height === 0)) continue;
      const viewY = finding.rect.y - window.scrollY;
      if (viewY + finding.rect.height < 0 || viewY > window.innerHeight) continue;

      const overlay = document.createElement('div');
      overlay.className = 'pv-redaction-overlay';
      overlay.dataset.piiType = finding.type;
      Object.assign(overlay.style, {
        left: `${finding.rect.x - window.scrollX - 2}px`,
        top: `${finding.rect.y - window.scrollY - 2}px`,
        width: `${finding.rect.width + 4}px`,
        height: `${finding.rect.height + 4}px`,
        position: 'fixed',
      });
      document.body.appendChild(overlay);
      _overlays.push(overlay);
    }

    setTimeout(_clearOverlays, 5000);
  }

  function _clearOverlays() {
    for (const overlay of _overlays) {
      overlay.remove();
    }
    _overlays = [];
  }

  // ── Init ────────────────────────────────────────────────────────────
  if (typeof Vault !== 'undefined') {
    Vault.seedInitialDemoData().catch(() => {});
  }
  console.log('[PrivacyVision] Content script loaded on:', window.location.href);
})();
