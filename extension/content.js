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

  // ── Message handler ────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const handler = MESSAGE_HANDLERS[message.type];
    if (handler) {
      try {
        const result = handler(message.payload);
        if (result instanceof Promise) {
          result.then((data) => sendResponse({ success: true, data }))
            .catch((err) => sendResponse({ success: false, error: err.message }));
          return true; // Keep channel open
        }
        sendResponse({ success: true, data: result });
      } catch (err) {
        console.error('[PrivacyVision] Sync Error:', err);
        sendResponse({ success: false, error: err.message });
      }
    }
  });

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

        // 4. Generate text summary
        const textSummary = DOMAnalyzer.generateTextSummary(sanitizedDOM);

        // 5. Build redaction regions (pixel coordinates for screenshot redaction)
        const redactionRegions = _buildRedactionRegions(piiResult);

        _lastScanResult = {
          domAnalysis: sanitizedDOM,
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
      const { actions } = payload;
      if (!actions || !Array.isArray(actions)) {
        throw new Error('Invalid actions payload');
      }

      const results = await ActionExecutor.executeActions(actions);
      return { results, log: ActionExecutor.getActionLog() };
    },

    /** Show local PII overlays after the screenshot has been captured. */
    SHOW_OVERLAYS: (payload = {}) => {
      _showRedactionOverlays(payload.findings || []);
      return { shown: (payload.findings || []).length };
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
      if (typeof PIIScanner !== 'undefined' && PIIScanner.sanitizeInstruction) {
        const sanitized = PIIScanner.sanitizeInstruction(text);
        return { sanitized, tokenMap: PIIScanner.getTokenMap() };
      }
      return { sanitized: text, tokenMap: {} };
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

  // ── Redaction region builder ────────────────────────────────────────

  function _buildRedactionRegions(piiResult) {
    const regions = [];
    const dpr = window.devicePixelRatio || 1;

    for (const finding of piiResult.allFindings) {
      if (!finding.rect || (finding.rect.width === 0 && finding.rect.height === 0)) continue;

      // Convert page coordinates to screenshot pixel coordinates
      // captureVisibleTab captures at viewport coordinates * devicePixelRatio
      const viewportRect = {
        x: (finding.rect.x - window.scrollX) * dpr,
        y: (finding.rect.y - window.scrollY) * dpr,
        width: finding.rect.width * dpr,
        height: finding.rect.height * dpr,
      };

      // Skip elements outside viewport
      if (viewportRect.y + viewportRect.height < 0 || viewportRect.y > window.innerHeight * dpr) continue;
      if (viewportRect.x + viewportRect.width < 0 || viewportRect.x > window.innerWidth * dpr) continue;

      // Add padding
      const pad = 4 * dpr;
      regions.push({
        x: viewportRect.x - pad,
        y: viewportRect.y - pad,
        width: viewportRect.width + pad * 2,
        height: viewportRect.height + pad * 2,
        type: finding.type,
        token: finding.token,
        label: finding.token || finding.type,
        severity: finding.severity,
      });
    }

    return regions;
  }

  // ── Visual overlay management ───────────────────────────────────────

  function _showRedactionOverlays(findings) {
    _clearOverlays();

    for (const finding of findings) {
      if (!finding.rect || (finding.rect.width === 0 && finding.rect.height === 0)) continue;
      // Only show overlays for visible elements
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

    // Auto-clear after 5 seconds
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

