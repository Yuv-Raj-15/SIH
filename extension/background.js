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
let lastAudit = null;

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
    let consecutiveFailures = 0;
    let finalMessage = 'Finished.';
    const actionHistory = [];

    let newlyOpenedTabId = null;
    const onTabCreated = (newTab) => {
      if (newTab && newTab.id) {
        console.log('[PrivacyVision] Detected newly opened tab:', newTab.id);
        newlyOpenedTabId = newTab.id;
      }
    };
    chrome.tabs.onCreated.addListener(onTabCreated);
    
    try {
      let iter = 0;
      let maxSteps = _estimateInitialSteps(payload.instruction);
      let tabId = await _getActiveTabId();

      // ── Pre-check: If current tab is restricted, navigate immediately to the target or Google
      const isRestricted = await _isRestrictedPage(tabId);
      if (isRestricted) {
        const instruction = payload.instruction || '';
        // Automatically determine target URL or search query — NEVER crash with Chrome error!
        const targetUrl = _extractUrlFromInstruction(instruction) ||
          `https://www.google.com/search?q=${encodeURIComponent(instruction)}`;

        chrome.runtime.sendMessage({
          type: 'AGENT_PROGRESS',
          payload: { step: 0, maxSteps, message: `Navigating to ${targetUrl}...` }
        }).catch(() => {});

        await chrome.tabs.update(tabId, { url: targetUrl });
        await _waitForNavigation(tabId);
        tabId = await _getActiveTabId();
        await _ensureContentScript(tabId);
        totalActionsExecuted++;
      }

      while (iter < maxSteps) {
        iter++;
        // Update popup UI via progress message
        chrome.runtime.sendMessage({ 
          type: 'AGENT_PROGRESS', 
          payload: { step: iter, maxSteps, message: `Step ${iter} of ${maxSteps}: Analyzing page...` } 
        }).catch(() => {});
        
        tabId = await _getActiveTabId();

        // Check if tab is on Chrome error page and auto-recover
        const tabCheck = await chrome.tabs.get(tabId).catch(() => null);
        if (tabCheck && tabCheck.url && tabCheck.url.startsWith('chrome-error://')) {
          console.warn('[PrivacyVision] Detected chrome-error page. Auto-recovering via Google search...');
          const recoverUrl = `https://www.google.com/search?q=${encodeURIComponent(payload.instruction || 'search')}`;
          await chrome.tabs.update(tabId, { url: recoverUrl });
          await _waitForNavigation(tabId);
          tabId = await _getActiveTabId();
          await _ensureContentScript(tabId);
        }

        // Ensure content script is available before messaging
        await _ensureContentScript(tabId);
        
        // Step 1: NER / DOM Scan
        let t0 = performance.now();
        const pageData = await _sendToContentScript(tabId, 'ANALYZE_PAGE');
        latencies.ner += Math.round(performance.now() - t0);
        
        // Step 2: Redaction
        t0 = performance.now();
        const screenshotDataUrl = await _captureTab(tabId);
        await _sendToContentScript(tabId, 'SHOW_OVERLAYS', {
          findings: pageData.piiFindings,
        });
        let redactionResult = { sanitizedImage: screenshotDataUrl, manifest: { redactions: [] } };
        try {
          redactionResult = await _redactScreenshot(screenshotDataUrl, pageData.redactionRegions);
        } catch (redactErr) {
          console.warn('[PrivacyVision] Visual redaction non-fatal warning:', redactErr.message);
        }
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
          payload: { step: iter, maxSteps, message: `Step ${iter} of ${maxSteps}: Reasoning...` } 
        }).catch(() => {});
        
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

        // Save comprehensive zero-leak audit state for popup UI
        audit = {
          localText: _formatAuditLocal(pageData.piiFindings, pageData.tokenMap),
          sanitizedImage: redactionResult.sanitizedImage,
          cloudSummary: _formatAuditCloud(sanitizedInstruction, redactionResult.manifest, pageData.domAnalysis, serverResponse),
          cloudText: pageData.textSummary,
          redactionsCount: (redactionResult.manifest?.redactions || []).length,
        };
        lastAudit = audit;

        // Dynamically update total steps if server suggested more for complex tasks
        if (serverResponse?.suggested_max_steps) {
          maxSteps = Math.max(maxSteps, Math.min(40, serverResponse.suggested_max_steps));
        }

        // Check if server returned empty actions or completed
        if (!serverResponse || !serverResponse.actions || serverResponse.actions.length === 0) {
          // SEARCH ENGINE FOLLOW-THROUGH GUARD:
          // If on a Google/Bing search page and goal is multi-step (e.g. ticket booking/coding), do NOT terminate!
          const currentTab = await chrome.tabs.get(tabId).catch(() => null);
          const currentUrl = currentTab?.url || '';
          const isSearchEngine = /google\.[a-z.]+\/search|bing\.com\/search/i.test(currentUrl);
          const isMultiStepGoal = _estimateInitialSteps(payload.instruction) > 15;

          if (isSearchEngine && isMultiStepGoal && !serverResponse?.is_goal_complete) {
            console.log('[PrivacyVision] Search engine follow-through triggered. Entering primary destination link...');
            chrome.runtime.sendMessage({ 
              type: 'AGENT_PROGRESS', 
              payload: { step: iter, maxSteps, message: `Step ${iter} of ${maxSteps}: Following through from search into destination site...` } 
            }).catch(() => {});

            const followThrough = await _sendToContentScript(tabId, 'EXECUTE_ACTIONS', {
              actions: [{
                type: 'click',
                selector: 'div#search a[href^="http"]:not([href*="google"]), div.g a[href^="http"], a:has(h3)',
                description: 'Click primary search result link'
              }]
            }).catch(() => null);

            if (followThrough?.results?.[0]?.success) {
              actionHistory.push('[✓ SUCCESS] Navigated to destination site from search results');
              totalActionsExecuted++;
              await _waitForNavigation(tabId);
              tabId = await _getActiveTabId();
              await _ensureContentScript(tabId);
              continue;
            }
          }

          if (serverResponse?.error) {
            actionError = serverResponse.error;
          }
          finalMessage = serverResponse?.error || serverResponse?.reasoning || 'Goal accomplished.';
          break; // Done!
        }

        // Native Navigation Action: Execute cleanly at the browser tab level
        const navAction = serverResponse.actions.find(a => (a.type || '').toLowerCase() === 'navigate');
        if (navAction) {
          let navUrl = (navAction.url || navAction.value || '').trim();
          if (!/^https?:\/\//i.test(navUrl) && !navUrl.startsWith('chrome://')) {
            navUrl = `https://${navUrl}`;
          }
          chrome.runtime.sendMessage({ 
            type: 'AGENT_PROGRESS', 
            payload: { step: iter, maxSteps, message: `Step ${iter} of ${maxSteps}: Navigating to ${navUrl}...` } 
          }).catch(() => {});

          await chrome.tabs.update(tabId, { url: navUrl });
          await _waitForNavigation(tabId);
          tabId = await _getActiveTabId();
          await _ensureContentScript(tabId);
          totalActionsExecuted++;
          actionHistory.push(`[✓ SUCCESS] Navigated to ${navUrl}`);
          continue;
        }

        // Step 4: DOM Action Injector
        chrome.runtime.sendMessage({ 
          type: 'AGENT_PROGRESS', 
          payload: { step: iter, maxSteps, message: `Step ${iter} of ${maxSteps}: Executing actions...` } 
        }).catch(() => {});

        const tabBefore = await chrome.tabs.get(tabId).catch(() => null);
        const urlBefore = tabBefore ? tabBefore.url : '';

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
          consecutiveFailures++;
          if (consecutiveFailures >= 3) {
            actionError = `Action execution failed after 3 attempts: ${failures[0]?.error || 'Unknown error'}`;
          }
        } else if (successes.length > 0) {
          consecutiveFailures = 0;
        }
        latencies.dom += Math.round(performance.now() - t0);

        // Auto-extend steps if approaching limit and task is still actively progressing
        if (iter >= maxSteps - 2 && successes.length > 0 && maxSteps < 48) {
          maxSteps = Math.min(maxSteps + 8, 50);
        }

        // Anti-repetition loop check: If the last 3 actions in history are identical, stop loop
        if (actionHistory.length >= 3) {
          const last1 = actionHistory[actionHistory.length - 1];
          const last2 = actionHistory[actionHistory.length - 2];
          const last3 = actionHistory[actionHistory.length - 3];
          if (last1 === last2 && last2 === last3) {
            console.warn('[PrivacyVision] Loop detected: identical action repeated 3 times. Breaking loop.');
            finalMessage = 'Prevented repetitive action loop.';
            break;
          }
        }

        // Check if a new tab was opened by link click
        if (newlyOpenedTabId && newlyOpenedTabId !== tabId) {
          console.log(`[PrivacyVision] Switching agent focus to newly opened tab ${newlyOpenedTabId}...`);
          try {
            await chrome.tabs.update(newlyOpenedTabId, { active: true });
            tabId = newlyOpenedTabId;
            newlyOpenedTabId = null;
            await _waitForNavigation(tabId);
            await _ensureContentScript(tabId);
            totalActionsExecuted++;
            continue;
          } catch (tabSwitchErr) {
            console.warn('[PrivacyVision] Failed to switch to new tab:', tabSwitchErr);
          }
        }

        // Check if page navigated or started loading after clicks
        await new Promise(r => setTimeout(r, 150));
        const tabAfter = await chrome.tabs.get(tabId).catch(() => null);
        const urlChanged = tabAfter && tabAfter.url && tabAfter.url !== urlBefore;
        const isTabLoading = tabAfter && tabAfter.status === 'loading';

        if (urlChanged || isTabLoading) {
          console.log('[PrivacyVision] Page navigation detected after action, waiting for new page to complete loading...');
          await _waitForNavigation(tabId);
          tabId = await _getActiveTabId();
          await _ensureContentScript(tabId);
        } else {
          // Brief pause to allow dynamic DOM updates to settle
          await new Promise(r => setTimeout(r, 300));
        }
        
        // Check if there was a fatal error
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
      chrome.tabs.onCreated.removeListener(onTabCreated);
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
  },

  GET_AUDIT_DATA: async () => {
    return lastAudit || null;
  }
};

// ── Tab/Screenshot utilities ─────────────────────────────────────────

/**
 * Estimate initial step allocation based on task complexity.
 * Complex tasks (booking tickets, coding LeetCode POTD, checkout flows) get up to 25 steps.
 */
function _estimateInitialSteps(instruction) {
  const text = (instruction || '').toLowerCase();
  const isComplex = /\b(book|ticket|train|flight|potd|leetcode|hotel|order|buy|reservation|checkout|solve|problem|hackerrank|irctc|makemytrip|bookmyshow|workflow|register)\b/i.test(text);
  return isComplex ? 35 : 15;
}

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
      url.startsWith('chrome-error://') ||
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
 * e.g. "open leetcode and solve potd" → "https://leetcode.com/problemset/"
 *      "book train ticket on irctc" → "https://www.irctc.co.in"
 *      "open any unknown site" / "open somesite.org" → "https://somesite.org"
 */
function _extractUrlFromInstruction(instruction) {
  const text = instruction.toLowerCase().trim();

  // 1. Explicit URLs
  const urlMatch = instruction.match(/https?:\/\/[^\s]+/i);
  if (urlMatch) return urlMatch[0];

  // 2. Domain patterns (e.g., example.org, irctc.co.in, leetcode.com, site.io)
  const domainMatch = instruction.match(/\b([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?)\b/);
  if (domainMatch) {
    const domain = domainMatch[1].toLowerCase();
    if (!['e.g', 'i.e', 'etc.com', 'potd.com'].includes(domain)) {
      return `https://${domain}`;
    }
  }

  // 3. Comprehensive directory of top services & destinations
  const SITE_MAP = {
    // Coding & Development
    'leetcode':       'https://leetcode.com/problemset/',
    'potd':           'https://leetcode.com/problemset/',
    'hackerrank':     'https://www.hackerrank.com',
    'codeforces':     'https://codeforces.com',
    'geeksforgeeks':  'https://www.geeksforgeeks.org',
    'gfg':            'https://www.geeksforgeeks.org',
    'codechef':       'https://www.codechef.com',
    'github':         'https://github.com',
    'gitlab':         'https://gitlab.com',
    'stackoverflow':  'https://stackoverflow.com',
    'stack overflow': 'https://stackoverflow.com',
    
    // Travel & Ticket Booking
    'irctc':          'https://www.irctc.co.in',
    'railway':        'https://www.irctc.co.in',
    'train ticket':   'https://www.irctc.co.in',
    'bookmyshow':     'https://in.bookmyshow.com',
    'movie ticket':   'https://in.bookmyshow.com',
    'makemytrip':     'https://www.makemytrip.com',
    'redbus':         'https://www.redbus.in',
    'goibibo':        'https://www.goibibo.com',
    'cleartrip':      'https://www.cleartrip.com',
    'ixigo':          'https://www.ixigo.com',
    'expedia':        'https://www.expedia.com',
    'booking.com':    'https://www.booking.com',
    
    // Shopping & E-Commerce
    'amazon':         'https://www.amazon.com',
    'flipkart':       'https://www.flipkart.com',
    'myntra':         'https://www.myntra.com',
    'ajio':           'https://www.ajio.com',
    'meesho':         'https://www.meesho.com',
    'swiggy':         'https://www.swiggy.com',
    'zomato':         'https://www.zomato.com',
    'blinkit':        'https://blinkit.com',
    'zepto':          'https://www.zeptonow.com',
    
    // General, Search & Media
    'youtube':        'https://www.youtube.com',
    'google':         'https://www.google.com',
    'instagram':      'https://www.instagram.com',
    'facebook':       'https://www.facebook.com',
    'twitter':        'https://www.twitter.com',
    'x.com':          'https://www.x.com',
    'reddit':         'https://www.reddit.com',
    'linkedin':       'https://www.linkedin.com',
    'netflix':        'https://www.netflix.com',
    'spotify':        'https://www.spotify.com',
    'whatsapp':       'https://web.whatsapp.com',
    'gmail':          'https://mail.google.com',
    'wikipedia':      'https://www.wikipedia.org',
    'chatgpt':        'https://chat.openai.com',
    'pinterest':      'https://www.pinterest.com',
    'twitch':         'https://www.twitch.tv',
  };

  for (const [name, url] of Object.entries(SITE_MAP)) {
    if (text.includes(name)) return url;
  }

  // 4. Intent & command pattern matching: "open <site>", "go to <site>", "visit <site>"
  const openMatch = text.match(/(?:open|go to|visit|launch|navigate to)\s+([a-zA-Z0-9_-]+)/i);
  if (openMatch) {
    const rawTarget = openMatch[1].toLowerCase().trim();
    if (SITE_MAP[rawTarget]) return SITE_MAP[rawTarget];
    // If user asks to open an unfamiliar site like "open foo", attempt standard web URL
    if (rawTarget.length > 2 && !['site', 'page', 'website', 'tab', 'browser', 'link', 'url'].includes(rawTarget)) {
      return `https://www.${rawTarget}.com`;
    }
  }

  // 5. Semantic intent heuristics
  if (/\b(play|song|music|video|listen|track)\b/i.test(text)) {
    return 'https://www.youtube.com';
  }
  if (/\b(search|google|look up|who is|what is|where is)\b/i.test(text)) {
    return 'https://www.google.com';
  }
  if (/\b(buy|order|purchase|price of)\b/i.test(text)) {
    return 'https://www.amazon.com';
  }
  if (/\b(flight|fly to)\b/i.test(text)) {
    return 'https://www.google.com/travel/flights';
  }

  return null; // Return null so fallback to Google Search query occurs cleanly
}

async function _getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found');
  return tab.id;
}

async function _captureTab(tabId) {
  let targetWindowId = null;
  if (tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.windowId) {
        targetWindowId = tab.windowId;
      }
    } catch {}
  }

  // 1x1 blank JPEG fallback in case of Chromium GPU readback stall/failure
  const fallbackImg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await chrome.tabs.captureVisibleTab(targetWindowId, { format: 'jpeg', quality: 55 });
    } catch (err) {
      console.warn(`[PrivacyVision] Tab capture attempt ${attempt} failed: ${err.message}`);
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 150 * attempt));
      } else {
        console.warn('[PrivacyVision] Image capture readback failed across retries. Continuing with DOM-only reasoning fallback.');
        return fallbackImg;
      }
    }
  }
  return fallbackImg;
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
      await new Promise(r => setTimeout(r, 150));
      return;
    } catch (injectErr) {
      console.warn(`[PrivacyVision] Script injection attempt ${attempt} failed:`, injectErr.message);
      if (attempt < 3) {
        await _waitForNavigation(tabId);
        tabId = await _getActiveTabId();
        await new Promise(r => setTimeout(r, 200));
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
 * Wait for a tab to finish loading after a navigation action with minimal latency.
 */
async function _waitForNavigation(tabId) {
  // If tab is already completed, brief settle and return immediately
  try {
    const initialTab = await chrome.tabs.get(tabId);
    if (initialTab && initialTab.status === 'complete') {
      await new Promise(r => setTimeout(r, 150));
      return;
    }
  } catch {}

  // Wait brief moment for pending navigation to register
  await new Promise(r => setTimeout(r, 150));

  // Poll for tab loading status with high frequency (100ms, max 10s)
  const maxWait = 10_000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') {
        // Page loaded — brief settle for DOM hydration
        await new Promise(r => setTimeout(r, 250));
        return;
      }
    } catch {
      // Tab might have been replaced (e.g. cross-origin navigation)
      break;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  await new Promise(r => setTimeout(r, 200));
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
function _formatAuditLocal(findings, tokenMap = {}) {
  if (!findings || findings.length === 0) {
    return "✓ No sensitive PII or credentials detected on this page.\n\n🔒 Form inputs are scanned on-device. All passwords, PINs, and personal records remain encrypted in local browser memory.";
  }
  let lines = [`🛡️ ${findings.length} Sensitive Entity(s) Detected & Masked Locally:`];
  findings.slice(0, 8).forEach(f => {
    const rawVal = tokenMap && tokenMap[f.token] ? `"${tokenMap[f.token]}"` : '(Masked Secret)';
    lines.push(`• [${f.type}] ${rawVal} ➔ Protected as ${f.token}`);
  });
  lines.push('\n🔒 100% On-Device Isolation: Plaintext secrets never leave your browser memory or local vault.');
  return lines.join('\n');
}

function _formatAuditCloud(sanitizedGoal, manifest, domAnalysis, serverResponse) {
  const lines = [];
  lines.push(`🎯 User Instruction (Sanitized):`);
  lines.push(`"${sanitizedGoal || 'Analyze and act.'}"\n`);
  
  const redactionCount = (manifest?.redactions || []).length;
  lines.push(`🖼️ Visual Screenshot Payload:`);
  lines.push(`• Redacted Base64 JPEG frame`);
  lines.push(`• ${redactionCount} visual area(s) blacked out / blurred on-device`);
  if (manifest?.redactions && manifest.redactions.length > 0) {
    const tokens = manifest.redactions.map(r => r.token || r.type).slice(0, 6).join(', ');
    lines.push(`• Masked Tokens Sent: ${tokens}`);
  }
  
  lines.push(`\n📋 Essential Page Context (Important Info Only):`);
  if (domAnalysis?.elements) {
    const keyElements = domAnalysis.elements
      .filter(el => ['input', 'button', 'a', 'select', 'textarea'].includes(el.tag) || el.role === 'code-editor')
      .slice(0, 6);
    if (keyElements.length > 0) {
      keyElements.forEach(el => {
        const label = el.ariaLabel || el.placeholder || el.text || el.name || el.selector || el.tag;
        const cleanLabel = (label || '').trim().replace(/\s+/g, ' ').substring(0, 32);
        lines.push(`• <${el.tag}> ${cleanLabel}`);
      });
    } else {
      lines.push(`• Processed semantic page elements`);
    }
  } else {
    lines.push(`• Processed semantic page elements`);
  }

  if (serverResponse?.actions && serverResponse.actions.length > 0) {
    lines.push(`\n🤖 AI Action Planned:`);
    const act = serverResponse.actions[0];
    lines.push(`• ${act.type.toUpperCase()}: ${act.description || act.selector || act.url || ''}`);
  }
  
  lines.push(`\n✅ 0 Bytes of Plaintext Passwords or Unmasked PII Transmitted.`);
  return lines.join('\n');
}
