/**
 * Background Service Worker — Orchestrator for PrivacyVision Agent.
 */

import './lib/vault.js';

// ── State ────────────────────────────────────────────────────────────
const DEFAULT_SERVER_URL = 'http://localhost:8000';
// Timeout for server VLM reasoning (120s buffer for multimodal models)
const SERVER_TIMEOUT_MS = 120_000;

let serverUrl = DEFAULT_SERVER_URL;
let isProcessing = false;
let lastAnalysis = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ serverUrl: DEFAULT_SERVER_URL });
});

chrome.storage.local.get(['serverUrl'], (result) => {
  if (result.serverUrl) serverUrl = result.serverUrl;
});

// ── Message handling ─────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Bug 6 fix: Ignore REDACT_IMAGE — that's for the offscreen document
  if (message.type === 'REDACT_IMAGE') return;
  // Also ignore progress messages sent by ourselves
  if (message.type === 'AGENT_PROGRESS') return;

  const handler = BG_HANDLERS[message.type];
  if (handler) {
    handler(message.payload, sender)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => {
        console.error('[PrivacyVision] Error:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // Async response
  }
});

const BG_HANDLERS = {
  START_AGENT_RUN: async (payload) => {
    if (isProcessing) throw new Error('Agent run already in progress');
    isProcessing = true;
    
    const latencies = { ner: 0, redaction: 0, vlm: 0, dom: 0 };
    let audit = { localText: '', cloudText: '' };
    let totalActionsExecuted = 0;
    let actionError = null;
    let finalMessage = 'Finished.';
    const actionHistory = [];
    
    try {
      let iter = 0;
      const MAX_ITER = 10;
      let tabId = await _getActiveTabId();

      // ── Pre-check: If current tab is a restricted page, try to navigate
      // directly based on the user's instruction before entering the loop.
      const isRestricted = await _isRestrictedPage(tabId);
      if (isRestricted) {
        const instruction = payload.instruction || '';
        const targetUrl = _extractUrlFromInstruction(instruction);
        if (targetUrl) {
          chrome.runtime.sendMessage({
            type: 'AGENT_PROGRESS',
            payload: { step: 0, message: `Navigating to ${targetUrl}...` }
          }).catch(() => {});

          await chrome.tabs.update(tabId, { url: targetUrl });
          await _waitForNavigation(tabId);
          tabId = await _getActiveTabId();
          await _ensureContentScript(tabId);
          totalActionsExecuted++;
        } else {
          throw new Error(
            'You are on a browser-internal page (chrome://, about:, etc.) where the agent cannot run. ' +
            'Please navigate to a regular website first, then try again.'
          );
        }
      }

      while (iter < MAX_ITER) {
        iter++;
        // Update popup UI via progress message
        chrome.runtime.sendMessage({ 
          type: 'AGENT_PROGRESS', 
          payload: { step: iter, message: `Step ${iter}: Analyzing page...` } 
        }).catch(() => {}); // ignore error if popup is closed
        
        tabId = await _getActiveTabId();

        // Ensure content script is available before messaging
        await _ensureContentScript(tabId);
        
        // Step 1: NER / DOM Scan
        let t0 = performance.now();
        const pageData = await _sendToContentScript(tabId, 'ANALYZE_PAGE');
        latencies.ner += Math.round(performance.now() - t0);
        
        // Step 2: Redaction
        t0 = performance.now();
        const screenshotDataUrl = await _captureTab(tabId);
        // Capture first so the diagnostic overlays are not baked into the
        // image sent to the model. They are still shown to the user afterward.
        await _sendToContentScript(tabId, 'SHOW_OVERLAYS', {
          findings: pageData.piiFindings,
        });
        const redactionResult = await _redactScreenshot(screenshotDataUrl, pageData.redactionRegions);
        latencies.redaction += Math.round(performance.now() - t0);
        
        // Save for audit (keeps the latest)
        audit.localText = _formatAuditLocal(pageData.piiFindings);
        audit.cloudText = pageData.textSummary;

        // Save global state
        lastAnalysis = {
          tokenMap: pageData.tokenMap,
          piiFindings: pageData.piiFindings
        };

        // Step 3: Server / VLM Reasoning
        chrome.runtime.sendMessage({ 
          type: 'AGENT_PROGRESS', 
          payload: { step: iter, message: `Step ${iter}: Reasoning...` } 
        }).catch(() => {});
        
        // Sanitize user's natural language instruction so no raw PII leaves browser
        let sanitizedInstruction = payload.instruction || 'Analyze and act.';
        try {
          const sRes = await _sendToContentScript(tabId, 'SANITIZE_INSTRUCTION', { text: sanitizedInstruction });
          if (sRes && sRes.sanitized) {
            sanitizedInstruction = sRes.sanitized;
          }
        } catch {}

        t0 = performance.now();
        const serverResponse = await _sendToServerWithTimeout(
          redactionResult.sanitizedImage,
          pageData.textSummary,
          redactionResult.manifest,
          sanitizedInstruction,
          actionHistory
        );
        latencies.vlm += Math.round(performance.now() - t0);

        if (!serverResponse || !serverResponse.actions || serverResponse.actions.length === 0) {
           if (serverResponse?.error) {
             actionError = serverResponse.error;
           }
           finalMessage = serverResponse?.error || serverResponse?.reasoning || 'Goal accomplished or no actions needed.';
           break; // Done!
        }
        
        chrome.runtime.sendMessage({ 
          type: 'AGENT_PROGRESS', 
          payload: { step: iter, message: `Step ${iter}: Executing actions...` } 
        }).catch(() => {});

        // Check if any action is a navigation
        const hasNavigate = serverResponse.actions.some(
          a => (a.type || '').toLowerCase() === 'navigate'
        );

        // Record URL before executing actions to detect navigation
        const tabBefore = await chrome.tabs.get(tabId).catch(() => null);
        const urlBefore = tabBefore ? tabBefore.url : '';

        // Step 4: DOM Action Injector
        t0 = performance.now();
        const execution = await _sendToContentScript(tabId, 'EXECUTE_ACTIONS', {
          actions: serverResponse.actions,
        });
        const results = Array.isArray(execution?.results) ? execution.results : [];
        for (let aIdx = 0; aIdx < serverResponse.actions.length; aIdx++) {
          const act = serverResponse.actions[aIdx];
          const res = results[aIdx];
          const desc = (res && res.description) || act.description || `${act.type} on ${act.selector || act.elementIndex || ''}`;
          const status = res && res.success ? '✓ SUCCESS' : '✕ FAILED';
          actionHistory.push(`[${status}] ${desc}`);
        }

        const successes = results.filter((result) => result && result.success);
        const failures = results.filter((result) => !result || !result.success);
        totalActionsExecuted += successes.length;

        if (failures.length > 0 && successes.length === 0) {
          actionError = `Action execution failed in step ${iter}: ${failures[0]?.error || 'Unknown error'}`;
        }
        latencies.dom += Math.round(performance.now() - t0);

        // Check if page navigated or started loading after clicks (e.g. product links on Amazon)
        await new Promise(r => setTimeout(r, 600));
        const tabAfter = await chrome.tabs.get(tabId).catch(() => null);
        const urlChanged = tabAfter && tabAfter.url && tabAfter.url !== urlBefore;
        const isTabLoading = tabAfter && tabAfter.status === 'loading';

        if (hasNavigate || urlChanged || isTabLoading) {
          console.log('[PrivacyVision] Page navigation detected after action, waiting for new page to complete loading...');
          await _waitForNavigation(tabId);
          tabId = await _getActiveTabId();
          await _ensureContentScript(tabId);
        } else {
          // Sleep to allow dynamic DOM updates to settle
          await new Promise(r => setTimeout(r, 1800));
        }
        
        // Check if there was an error that should break the loop
        if (actionError || serverResponse.error) {
           finalMessage = serverResponse.error || actionError;
           break;
        }
      }

      return {
        latencies,
        audit,
        actionsExecuted: totalActionsExecuted,
        message: finalMessage,
        error: actionError,
      };

    } catch (e) {
      throw new Error(e.message);
    } finally {
      isProcessing = false;
    }
  },

  GET_VAULT_DATA: async () => {
    if (typeof Vault !== 'undefined') {
      try {
        await Vault.seedInitialDemoData();
        const creds = await Vault.getAllCredentials();
        const map = {};
        creds.forEach((c) => {
          const cat = (c.category || 'cred').toUpperCase();
          if (c.data?.username) map[`[${cat}_USER_${c.id.substring(5, 9)}]`] = c.data.username;
          if (c.data?.password) map[`[${cat}_PASS_${c.id.substring(5, 9)}]`] = '•••••••• (Encrypted AES-256)';
          if (c.data?.upiPin) map[`[${cat}_PIN_${c.id.substring(5, 9)}]`] = '•••••• (Encrypted AES-256)';
        });
        if (Object.keys(map).length > 0) return map;
      } catch (err) {
        console.warn('[Vault] Error reading vault data:', err);
      }
    }
    if (lastAnalysis && lastAnalysis.tokenMap) {
      return lastAnalysis.tokenMap;
    }
    try {
      const tabId = await _getActiveTabId();
      await _ensureContentScript(tabId);
      const scan = await _sendToContentScript(tabId, 'GET_LAST_SCAN');
      return scan ? scan.tokenMap : {};
    } catch {
      return {};
    }
  },

  GET_VAULT_RECORDS: async () => {
    if (typeof Vault !== 'undefined') {
      await Vault.seedInitialDemoData();
      const credentials = await Vault.getAllCredentials();
      const rawRecords = await Vault.getRawRecords();
      return { credentials, rawRecords };
    }
    return { credentials: [], rawRecords: [] };
  },

  SAVE_VAULT_RECORD: async (payload) => {
    if (typeof Vault !== 'undefined') {
      return await Vault.saveCredential(payload);
    }
    throw new Error('Vault is not available in background worker');
  },

  DELETE_VAULT_RECORD: async (payload) => {
    if (typeof Vault !== 'undefined') {
      return await Vault.deleteCredential(payload.id);
    }
    throw new Error('Vault is not available in background worker');
  },

  TRIGGER_AUTOFILL: async () => {
    const tabId = await _getActiveTabId();
    await _ensureContentScript(tabId);
    return await _sendToContentScript(tabId, 'AUTOFILL_FORM');
  },

  TRIGGER_PAYMENT: async () => {
    const tabId = await _getActiveTabId();
    await _ensureContentScript(tabId);
    return await _sendToContentScript(tabId, 'AUTHORIZE_AND_PAY');
  }
};

// ── Tab/Screenshot utilities ─────────────────────────────────────────

/**
 * Check if the current tab is a restricted page where content scripts can't run.
 */
async function _isRestrictedPage(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || '';
    return (
      url.startsWith('chrome://') ||
      url.startsWith('chrome-extension://') ||
      url.startsWith('about:') ||
      url.startsWith('edge://') ||
      url.startsWith('brave://') ||
      url.startsWith('chrome-search://') ||
      url === '' ||
      url === 'about:blank'
    );
  } catch {
    return true; // If we can't even read the tab, assume restricted
  }
}

/**
 * Extract a navigable URL from a natural language instruction.
 * e.g. "open youtube and play video" → "https://www.youtube.com"
 *      "go to instagram.com" → "https://www.instagram.com"
 */
function _extractUrlFromInstruction(instruction) {
  const text = instruction.toLowerCase().trim();

  // 1. Check for explicit URLs
  const urlMatch = instruction.match(/https?:\/\/[^\s]+/i);
  if (urlMatch) return urlMatch[0];

  // 2. Check for "domain.com" patterns
  const domainMatch = instruction.match(/([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?)/);
  if (domainMatch) {
    const domain = domainMatch[1].toLowerCase();
    // Exclude common non-URL words that look like domains
    if (!['e.g', 'i.e', 'etc.com'].includes(domain)) {
      return `https://www.${domain}`;
    }
  }

  // 3. Well-known site names from natural language
  const SITE_MAP = {
    'youtube':    'https://www.youtube.com',
    'google':     'https://www.google.com',
    'instagram':  'https://www.instagram.com',
    'facebook':   'https://www.facebook.com',
    'twitter':    'https://www.twitter.com',
    'x.com':      'https://www.x.com',
    'reddit':     'https://www.reddit.com',
    'linkedin':   'https://www.linkedin.com',
    'github':     'https://www.github.com',
    'amazon':     'https://www.amazon.com',
    'flipkart':   'https://www.flipkart.com',
    'netflix':    'https://www.netflix.com',
    'spotify':    'https://www.spotify.com',
    'whatsapp':   'https://web.whatsapp.com',
    'gmail':      'https://mail.google.com',
    'wikipedia':  'https://www.wikipedia.org',
    'stackoverflow': 'https://stackoverflow.com',
    'stack overflow': 'https://stackoverflow.com',
    'chatgpt':    'https://chat.openai.com',
    'pinterest':  'https://www.pinterest.com',
    'twitch':     'https://www.twitch.tv',
  };

  for (const [name, url] of Object.entries(SITE_MAP)) {
    if (text.includes(name)) return url;
  }

  // 4. Natural language intent heuristics
  if (/\b(play|song|music|video|listen|track)\b/i.test(text)) {
    return 'https://www.youtube.com';
  }
  if (/\b(search|google|look up|who is|what is|where is)\b/i.test(text)) {
    return 'https://www.google.com';
  }
  if (/\b(buy|order|purchase|price of)\b/i.test(text)) {
    return 'https://www.amazon.com';
  }

  return null; // No URL found
}

async function _getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found');
  return tab.id;
}

async function _captureTab(tabId) {
  return await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 85 });
}

/**
 * Ensure content scripts are injected in the tab.
 * Tries a lightweight ping; if it fails, injects scripts programmatically.
 */
async function _ensureContentScript(tabId) {
  // First make sure tab is not currently loading
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && tab.status === 'loading') {
      await _waitForNavigation(tabId);
    }
  } catch {}

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Quick ping to see if the content script is alive
      const response = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_INFO' }, (res) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve(res);
        });
      });
      if (response && response.success !== false) {
        return; // Alive and responding
      }
    } catch (pingErr) {
      const msg = pingErr.message || '';
      if (msg.includes('back/forward cache') || msg.includes('message channel is closed') || msg.includes('Receiving end does not exist')) {
        await _waitForNavigation(tabId);
        tabId = await _getActiveTabId();
      }
    }

    // Inject scripts programmatically
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [
          'lib/vault.js',
          'lib/biometric-gate.js',
          'lib/pii-scanner.js',
          'lib/dom-analyzer.js',
          'lib/action-executor.js',
          'content.js'
        ],
      });
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['styles/content.css'],
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 400));
      return;
    } catch (injectErr) {
      console.warn(`[PrivacyVision] Script injection attempt ${attempt} failed:`, injectErr.message);
      if (attempt < 3) {
        await _waitForNavigation(tabId);
        tabId = await _getActiveTabId();
        await new Promise(r => setTimeout(r, 600));
      } else {
        throw new Error(
          `Cannot connect to this page. It may be a browser-internal page (chrome://, about:, etc.) ` +
          `that doesn't allow extensions. Error: ${injectErr.message}`
        );
      }
    }
  }
}

/**
 * Wait for a tab to finish loading after a navigation action.
 */
async function _waitForNavigation(tabId) {
  // Wait a bit for the navigation to start
  await new Promise(r => setTimeout(r, 1000));

  // Poll for tab loading status (max 15 seconds)
  const maxWait = 15_000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') {
        // Page loaded — give it a moment to stabilize
        await new Promise(r => setTimeout(r, 1200));
        return;
      }
    } catch {
      // Tab might have been replaced (e.g. cross-origin navigation)
      break;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  await new Promise(r => setTimeout(r, 1000));
}

async function _sendToContentScript(tabId, type, payload = {}, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, { type, payload }, (response) => {
          if (chrome.runtime.lastError) {
            return reject(new Error(chrome.runtime.lastError.message));
          }
          if (!response) {
            return reject(new Error('No response from content script'));
          }
          if (!response.success) {
            return reject(new Error(response.error || 'Content script error'));
          }
          resolve(response.data);
        });
      });
    } catch (err) {
      const msg = err.message || '';
      const isBfCache = msg.includes('back/forward cache') || msg.includes('message channel is closed');
      const isDisconnected = isBfCache || msg.includes('Receiving end does not exist') || msg.includes('Could not establish connection');

      // CRITICAL: If EXECUTE_ACTIONS triggered a navigation (e.g. clicking a link or search submit),
      // the page was unloaded into bfcache while executing! That means the action SUCCEEDED in navigating.
      if (type === 'EXECUTE_ACTIONS' && isBfCache) {
        console.log('[PrivacyVision] Page navigated during EXECUTE_ACTIONS (bfcache closed channel) — treating as successful navigation.');
        return {
          results: [{
            success: true,
            description: 'Action triggered page navigation (moved to bfcache)'
          }]
        };
      }

      if (isDisconnected && attempt < retries) {
        console.warn(`[PrivacyVision] Tab ${tabId} message failed (${msg}), waiting for page settlement (attempt ${attempt}/${retries})...`);
        await _waitForNavigation(tabId);
        tabId = await _getActiveTabId();
        await _ensureContentScript(tabId);
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      throw err;
    }
  }
}

// ── Offscreen document management ────────────────────────────────────

async function _ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: 'Canvas redaction',
    });
  }
}

async function _redactScreenshot(imageDataUrl, regions) {
  if (!regions || regions.length === 0) {
    return { sanitizedImage: imageDataUrl, manifest: { redactions: [] } };
  }
  await _ensureOffscreen();
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'REDACT_IMAGE', payload: { imageDataUrl, regions, options: { blurRadius: 20 } } },
      (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!response || !response.success) return reject(new Error('Redaction failed'));
        resolve(response.data);
      }
    );
  });
}

// ── Server communication ─────────────────────────────────────────────

async function _sendToServerWithTimeout(image, summary, manifest, goal, history = []) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SERVER_TIMEOUT_MS);

  try {
    const response = await fetch(`${serverUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image,
        dom_summary: summary,
        redaction_manifest: manifest,
        user_goal: goal,
        action_history: history,
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`Server ${response.status}`);
    return await response.json();
    
  } catch (err) {
    clearTimeout(timeoutId);
    const message = err.name === 'AbortError'
      ? `Server request timed out after ${SERVER_TIMEOUT_MS / 1000} seconds`
      : `Server request failed: ${err.message}`;
    console.warn('[PrivacyVision] ' + message, err);

    // Keep the run responsive, but never report fake actions as completed.
    return {
      fallback: true,
      reasoning: 'Analysis could not be completed.',
      actions: [],
      error: message,
    };
  }
}

// ── Audit Formatting ─────────────────────────────────────────────────
function _formatAuditLocal(findings) {
  if (!findings || findings.length === 0) return "No PII found locally.";
  let lines = [];
  findings.slice(0, 10).forEach(f => {
     lines.push(`Found ${f.type} -> ${f.token}`);
  });
  return lines.join("\n");
}
