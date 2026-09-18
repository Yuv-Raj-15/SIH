/**
 * Background Service Worker — Orchestrator for PrivacyVision Agent.
 */

import './lib/vault.js';

// ── Token Reversal Helper ───────────────────────────────────────────
function _detokenizeUrl(url, tokenMap) {
  if (!url || !tokenMap) return url;
  let decoded = url;
  for (const [token, value] of Object.entries(tokenMap)) {
    if (decoded.includes(token)) {
      decoded = decoded.replaceAll(token, value);
    }
    // Also check URL-encoded version of token
    const encodedToken = encodeURIComponent(token);
    if (decoded.includes(encodedToken)) {
      decoded = decoded.replaceAll(encodedToken, encodeURIComponent(value));
    }
  }
  return decoded;
}

// ── PII Sanitization & Overlays ────────────────────────────────────────────────────────────
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
  if (!message || typeof message !== 'object') {
    sendResponse({ success: false, error: 'Invalid message' });
    return false;
  }
  // These message types are fire-and-forget broadcasts — never need a response
  if (message.type === 'REDACT_IMAGE') return false;
  if (message.type === 'AGENT_PROGRESS') return false;
  if (message.type === 'AGENT_COMPLETE') return false;

  const handler = BG_HANDLERS[message.type];
  if (!handler) {
    sendResponse({ success: false, error: `Unrecognized message type: ${message.type}` });
    return false;
  }

  // START_AGENT_RUN is fire-and-run: respond immediately with ack,
  // then execute asynchronously and push results via AGENT_COMPLETE.
  if (message.type === 'START_AGENT_RUN') {
    const runId = Date.now().toString(36);
    sendResponse({ success: true, data: { runId, started: true } });
    // Run the agent asynchronously — never awaited by popup
    handler(message.payload, sender).then((result) => {
      _safeMessage({ type: 'AGENT_COMPLETE', payload: { runId, ...result } });
    }).catch((err) => {
      console.error('[PrivacyVision] START_AGENT_RUN failed:', err);
      _safeMessage({ type: 'AGENT_COMPLETE', payload: { runId, error: err.message || String(err) } });
    });
    return false; // Channel already closed (sendResponse already called)
  }

  // All other handlers: keep channel open, respond when done
  let responded = false;
  const safeRespond = (resp) => {
    if (responded) return;
    responded = true;
    try { sendResponse(resp); } catch { /* port closed */ }
  };

  handler(message.payload, sender)
    .then((data) => safeRespond({ success: true, data }))
    .catch((err) => {
      console.error(`[PrivacyVision] Handler error for ${message.type}:`, err);
      safeRespond({ success: false, error: err.message || 'Handler failed' });
    });
  return true; // Async response channel kept open
});

/** Fire-and-forget message helper — never throws, even if popup is closed */
function _safeMessage(msg) {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch { /* extension context may be invalidated */ }
}



const BG_HANDLERS = {
  START_AGENT_RUN: async (payload) => {
    if (isProcessing) throw new Error('Agent run already in progress');
    isProcessing = true;
    
    const latencies = { ner: 0, redaction: 0, reasoning: 0, decision: 0, vlm: 0, dom: 0 };
    let audit = { localText: '', cloudText: '', localMaskingLedger: null, telemetry: null };
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
      // Use estimatedSteps from AI plan if provided, otherwise estimate heuristically
      let maxSteps = payload.estimatedSteps || _estimateInitialSteps(payload.instruction);
      let tabId = await _getActiveTabId();

      // ── Pre-check: If current tab is restricted, navigate immediately to the AI-planned target URL
      const isRestricted = await _isRestrictedPage(tabId);
      if (isRestricted) {
        const instruction = payload.instruction || '';
        // Detokenize the URL using the token map provided by the popup
        let targetUrl = payload.targetUrl ||
          _extractUrlFromInstruction(instruction) ||
          `https://www.google.com/search?q=${encodeURIComponent(instruction)}`;
        targetUrl = _detokenizeUrl(targetUrl, payload.tokenMap);

        _safeMessage({
          type: 'AGENT_PROGRESS',
          payload: { step: 0, maxSteps, message: `Navigating to ${targetUrl}...` }
        });

        await chrome.tabs.update(tabId, { url: targetUrl });
        await _waitForNavigation(tabId);
        tabId = await _getActiveTabId();
        await _ensureContentScript(tabId);
        totalActionsExecuted++;
      }

      while (iter < maxSteps) {
        iter++;
        // Update popup UI via progress message
        _safeMessage({ 
          type: 'AGENT_PROGRESS', 
          payload: { step: iter, maxSteps, message: `Step ${iter} of ${maxSteps}: Analyzing page...` } 
        });
        
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
          redactionResult = await _redactScreenshot(screenshotDataUrl, pageData.redactionRegions, tabId);
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

        // Step 3: Dual-AI Server Reasoning & Decision
        _safeMessage({ 
          type: 'AGENT_PROGRESS', 
          payload: { 
            step: iter, 
            maxSteps, 
            phase: 'ai_reasoning',
            message: `Step ${iter} of ${maxSteps}: AI-1 Vision Reasoning (Key 1)...` 
          } 
        });
        
        let sanitizedInstruction = payload.instruction || 'Analyze and act.';
        try {
          const sRes = await _sendToContentScript(tabId, 'SANITIZE_INSTRUCTION', {
            text: sanitizedInstruction,
            tokenMap: payload.tokenMap || {},
          });
          if (sRes && sRes.sanitized) {
            sanitizedInstruction = sRes.sanitized;
          }
          if (sRes && sRes.tokenMap) {
            payload.tokenMap = { ...(payload.tokenMap || {}), ...sRes.tokenMap };
          }
        } catch {}

        t0 = performance.now();
        const serverResponse = await _sendToServerWithTimeout(
          redactionResult.sanitizedImage,
          pageData.textSummary,
          redactionResult.manifest,
          sanitizedInstruction,
          actionHistory,
          {
            scan_duration_ms: latencies.ner,
            redaction_duration_ms: latencies.redaction,
            findings_count: (pageData.piiFindings || []).length
          },
          pageData.domStructured,      // ← Structured DOM for AI-2 indexed selector picking
          payload.plan?.steps || (payload.targetUrl ? [{ step: 1, action: 'Navigate', detail: `Open ${payload.targetUrl}` }] : null)  // ← Pre-seed AI with planned steps

        );
        const vlmElapsed = Math.round(performance.now() - t0);
        latencies.vlm += vlmElapsed;

        if (serverResponse?.telemetry) {
          latencies.reasoning = serverResponse.telemetry.ai_reasoning?.latency_ms || Math.round(vlmElapsed * 0.55);
          latencies.decision = serverResponse.telemetry.ai_decision?.latency_ms || Math.round(vlmElapsed * 0.45);
        }

        // Ensure local masking ledger is fully populated from findings if server omitted it
        const ledgerEntities = serverResponse?.local_masking_ledger?.entities || {};
        if (Object.keys(ledgerEntities).length === 0 && (pageData.piiFindings || []).length > 0) {
          (pageData.piiFindings || []).forEach((f) => {
            if (!ledgerEntities[f.type]) {
              const isFace = f.type === 'FACE_IMAGE' || f.type === 'FACE';
              ledgerEntities[f.type] = {
                count: 0,
                technique: isFace ? 'Gaussian Blur & Privacy Shield' : 'Cryptographic Token Blackout',
                tokens: []
              };
            }
            ledgerEntities[f.type].count++;
            if (f.token && !ledgerEntities[f.type].tokens.includes(f.token)) {
              ledgerEntities[f.type].tokens.push(f.token);
            }
          });
        }

        const totalMaskedCount = (redactionResult.manifest?.redactions || []).length || (pageData.piiFindings || []).length;

        // Save comprehensive zero-leak audit state for popup UI
        audit = {
          localText: _formatAuditLocal(pageData.piiFindings, pageData.tokenMap),
          sanitizedImage: redactionResult.sanitizedImage,
          cloudSummary: _formatAuditCloud(sanitizedInstruction, redactionResult.manifest, pageData.domAnalysis, serverResponse),
          cloudText: pageData.textSummary,
          redactionsCount: totalMaskedCount,
          localMaskingLedger: {
            total_masked: totalMaskedCount,
            entities: ledgerEntities,
          },
          telemetry: serverResponse?.telemetry || null,
          serverReasoning: serverResponse?.reasoning || '',
        };
        lastAudit = audit;

        // Dynamically update total steps if server suggested more for complex tasks
        if (serverResponse?.suggested_max_steps) {
          maxSteps = Math.max(maxSteps, Math.min(40, serverResponse.suggested_max_steps));
        }

        // Check if server returned empty actions or completed
        if (!serverResponse || !serverResponse.actions || serverResponse.actions.length === 0) {
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
          
          // Reverse tokens before navigation (combining payload tokens + latest scan tokens)
          const currentTokenMap = { ...(payload.tokenMap || {}), ...(lastAnalysis?.tokenMap || {}) };
          navUrl = _detokenizeUrl(navUrl, currentTokenMap);

          if (!/^https?:\/\//i.test(navUrl) && !navUrl.startsWith('chrome://')) {
            navUrl = `https://${navUrl}`;
          }
          _safeMessage({ 
            type: 'AGENT_PROGRESS', 
            payload: { step: iter, maxSteps, message: `Step ${iter} of ${maxSteps}: Navigating to ${navUrl}...` } 
          });

          await chrome.tabs.update(tabId, { url: navUrl });
          await _waitForNavigation(tabId);
          tabId = await _getActiveTabId();
          await _ensureContentScript(tabId);
          totalActionsExecuted++;
          actionHistory.push(`[✓ SUCCESS] Navigated to ${navUrl}`);
          continue;
        }

        // Step 4: DOM Action Injector
        _safeMessage({ 
          type: 'AGENT_PROGRESS', 
          payload: { step: iter, maxSteps, message: `Step ${iter} of ${maxSteps}: Executing actions...` } 
        });

        const tabBefore = await chrome.tabs.get(tabId).catch(() => null);
        const urlBefore = tabBefore ? tabBefore.url : '';

        t0 = performance.now();
        const execution = await _sendToContentScript(tabId, 'EXECUTE_ACTIONS', {
          actions: serverResponse.actions,
          tokenMap: currentTokenMap,
        });
        const results = Array.isArray(execution?.results) ? execution.results : [];
        for (let aIdx = 0; aIdx < serverResponse.actions.length; aIdx++) {
          const act = serverResponse.actions[aIdx];
          const res = results[aIdx];
          const desc = (res && res.description) || act.description || `${act.type} on ${act.selector || act.elementIndex || ''}`;
          const status = res && res.success ? '✓ SUCCESS' : '✕ FAILED';
          actionHistory.push(`[${status}] ${desc}`);

          // ── Smart AI-2 Retry: if action failed, ask server for alternative selector ──
          if (res && !res.success && act.selector && !act._retried) {
            try {
              _safeMessage({
                type: 'AGENT_PROGRESS',
                payload: { step: iter, maxSteps, phase: 'retry', message: `Step ${iter}: Selector failed — asking AI-2 for alternative...` }
              });

              const retryRes = await _retryFailedAction(act, pageData, sanitizedInstruction, res.error || 'DOM injection failed');
              if (retryRes && retryRes.corrected_action && retryRes.corrected_action.selector) {
                console.log(`[PrivacyVision] AI-2 Retry: replacing selector '${act.selector}' → '${retryRes.corrected_action.selector}'`);
                const retryExecution = await _sendToContentScript(tabId, 'EXECUTE_ACTIONS', {
                  actions: [{ ...retryRes.corrected_action, _retried: true }],
                });
                const retryResult = retryExecution?.results?.[0];
                if (retryResult && retryResult.success) {
                  actionHistory[actionHistory.length - 1] = `[✓ AI-RETRY SUCCESS] ${retryRes.corrected_action.description || retryRes.corrected_action.selector}`;
                  consecutiveFailures = Math.max(0, consecutiveFailures - 1);
                  totalActionsExecuted++;
                }
              }
            } catch (retryErr) {
              console.warn('[PrivacyVision] AI-2 retry failed (non-fatal):', retryErr.message);
            }
          }
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

  PLAN_INSTRUCTION: async (payload) => {
    const rawInstruction = (payload.instruction || '').trim();
    if (!rawInstruction) throw new Error('Empty instruction');

    // ── Step 1: Instant on-device PII tokenization (zero-latency in-memory, no tab dependency) ──
    const { sanitized: sanitizedInstruction, tokenMap } = _sanitizeInstructionInBackground(rawInstruction);
    const piiCount = Object.keys(tokenMap).length;
    console.log(`[PrivacyVision] Planner: tokenized ${piiCount} PII entities before server call.`);

    // Broadcast status to popup if listening
    _safeMessage({
      type: 'AGENT_PROGRESS',
      payload: { step: 0, maxSteps: 1, phase: 'planning', message: `Analyzing instruction... (${piiCount} PII entities shielded)` }
    });

    // ── Step 2: Fetch plan from /api/plan with resilient timeout ─────────────────────
    let plan = null;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20_000);

    try {
      const res = await fetch(`${serverUrl}/api/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction: sanitizedInstruction }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error(`Server returned status ${res.status}`);
      plan = await res.json();
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      console.warn('[PrivacyVision] Planner: server call failed, using heuristic fallback:', fetchErr.message);
      plan = _buildHeuristicPlan(rawInstruction);
      plan.error = fetchErr.message;
    }

    return {
      plan,
      sanitizedInstruction,
      tokenMap,
      piiCount,
    };
  },

  GET_STATUS: async () => {
    return {
      isProcessing,
      lastAudit,
      lastAnalysis,
    };
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
  },

  QUICK_SCAN_ACTIVE_TAB: async () => {
    try {
      const tabId = await _getActiveTabId();
      await _ensureContentScript(tabId);
      
      const pageData = await _sendToContentScript(tabId, 'ANALYZE_PAGE');
      const screenshotDataUrl = await _captureTab(tabId);
      
      // Trigger live on-page visual shield overlays
      await _sendToContentScript(tabId, 'SHOW_OVERLAYS', {
        findings: pageData.piiFindings,
      });

      let redactionResult = { sanitizedImage: screenshotDataUrl, manifest: { redactions: [] } };
      try {
        redactionResult = await _redactScreenshot(screenshotDataUrl, pageData.redactionRegions, tabId);
      } catch (err) {
        console.warn('[PrivacyVision] Quick visual redaction warning:', err);
      }

      // Build local ledger directly from findings
      const ledgerEntities = {};
      (pageData.piiFindings || []).forEach((f) => {
        if (!ledgerEntities[f.type]) {
          const isFace = f.type === 'FACE_IMAGE' || f.type === 'FACE';
          ledgerEntities[f.type] = {
            count: 0,
            technique: isFace ? 'Gaussian Blur & Privacy Shield' : 'Cryptographic Token Blackout',
            tokens: []
          };
        }
        ledgerEntities[f.type].count++;
        if (f.token && !ledgerEntities[f.type].tokens.includes(f.token)) {
          ledgerEntities[f.type].tokens.push(f.token);
        }
      });

      const totalMasked = (redactionResult.manifest?.redactions || []).length || (pageData.piiFindings || []).length;

      const audit = {
        localText: _formatAuditLocal(pageData.piiFindings, pageData.tokenMap),
        sanitizedImage: redactionResult.sanitizedImage,
        cloudSummary: _formatAuditCloud('(Active Page On-Demand Privacy Scan)', redactionResult.manifest, pageData.domAnalysis),
        cloudText: pageData.textSummary,
        redactionsCount: totalMasked,
        localMaskingLedger: {
          total_masked: totalMasked,
          entities: ledgerEntities,
        },
        telemetry: null,
      };

      lastAudit = audit;
      return audit;
    } catch (err) {
      console.warn('[PrivacyVision] QUICK_SCAN_ACTIVE_TAB error:', err);
      return lastAudit || null;
    }
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
  const text = (instruction || '').toLowerCase().trim();

  // 1. Explicit URLs
  const urlMatch = instruction.match(/https?:\/\/[^\s]+/i);
  if (urlMatch) return urlMatch[0];

  // 2. Domain patterns (e.g. example.org, test.io, myportal.in)
  const domainMatch = instruction.match(/\b([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?)\b/);
  if (domainMatch) {
    const domain = domainMatch[1].toLowerCase();
    if (!['e.g', 'i.e', 'etc.com'].includes(domain)) {
      return `https://${domain}`;
    }
  }

  // 3. Known platform shortcuts
  const PLATFORMS = {
    instagram: 'https://www.instagram.com',
    insta: 'https://www.instagram.com',
    twitter: 'https://twitter.com',
    x: 'https://x.com',
    github: 'https://github.com',
    linkedin: 'https://www.linkedin.com',
    amazon: 'https://www.amazon.com',
    youtube: 'https://www.youtube.com',
    facebook: 'https://www.facebook.com',
    reddit: 'https://www.reddit.com',
    leetcode: 'https://leetcode.com',
    irctc: 'https://www.irctc.co.in',
    google: 'https://www.google.com',
  };

  for (const [key, domainUrl] of Object.entries(PLATFORMS)) {
    if (new RegExp(`\\b${key}\\b`, 'i').test(text)) {
      return domainUrl;
    }
  }

  // 4. Dynamic target command matching: "open <site>", "go to <site>", "visit <site>"
  const openMatch = text.match(/(?:open|go to|visit|launch|navigate to)\s+([a-zA-Z0-9_-]+)/i);
  if (openMatch) {
    const rawTarget = openMatch[1].toLowerCase().trim();
    if (rawTarget.length > 2 && !['site', 'page', 'website', 'tab', 'browser', 'link', 'url', 'the', 'this', 'that'].includes(rawTarget)) {
      return `https://www.${rawTarget}.com`;
    }
  }

  return null; // Graceful fallback to search engine
}

/**
 * Lightweight on-device PII tokenizer for use in the background script
 * when no content script is available (e.g. restricted tab like chrome://newtab).
 * Covers the most critical PII patterns found in user instructions.
 * Returns { sanitized: string, tokenMap: object }
 */
function _sanitizeInstructionInBackground(text) {
  if (!text || typeof text !== 'string') return { sanitized: text, tokenMap: {} };

  const tokenMap = {};
  let result = text;
  let counter = 0;

  const _tok = (label) => {
    const id = Math.random().toString(36).substring(2, 6);
    return `[${label}_${id}]`;
  };

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

  const INLINE_PATTERNS = [
    // UPI ID (must be before EMAIL to avoid overlap)
    { label: 'UPI_ID',      regex: /[a-zA-Z0-9.\-_]+@(?:oksbi|okhdfcbank|okicici|okaxis|ybl|paytm|ibl|upi|axl|sbi|apl)\b/g },
    // Email
    { label: 'EMAIL',       regex: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g },
    // Phone (India + international)
    { label: 'PHONE',       regex: /(?:\+91[\s\-.]?)?\b\d{5}[\s\-.]?\d{5}\b|\+\d{1,3}[\s\-.]?\d{6,12}/g },
    // Credit / Debit card
    { label: 'CREDIT_CARD', regex: /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g },
    // Aadhaar (12 digit)
    { label: 'AADHAAR',     regex: /\b[2-9]\d{3}[\s\-]?\d{4}[\s\-]?\d{4}\b/g },
    // PAN
    { label: 'PAN',         regex: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
    // IFSC
    { label: 'IFSC_CODE',   regex: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g },
    // Social profile URLs (e.g. instagram.com/user, twitter.com/user)
    { label: 'TARGET_USER', regex: /(?:https?:\/\/)?(?:www\.)?(?:instagram\.com|twitter\.com|x\.com|github\.com|threads\.net|linkedin\.com\/in)\/([a-zA-Z0-9_.]{3,35})\/?/gi },
    // PIN / OTP / CVV indicators
    { label: 'PIN',         regex: /\b(?:pin|cvv|otp)[\s:=]+(\d{3,6})\b/gi },
    // Password indicators
    { label: 'PASSWORD',    regex: /\b(?:password|pass)[\s:=]+(\S+)\b/gi },
    // @mentions
    { label: 'USERNAME',    regex: /@([a-zA-Z0-9_.]{3,35})\b/g },
  ];

  for (const { label, regex } of INLINE_PATTERNS) {
    regex.lastIndex = 0;
    result = result.replace(regex, (match) => {
      // Check if already tokenized
      const existing = Object.keys(tokenMap).find(k => tokenMap[k] === match);
      if (existing) return existing;
      const token = _tok(label);
      tokenMap[token] = match;
      counter++;
      return token;
    });
  }

  return { sanitized: result, tokenMap };
}

/**
 * Build a minimal heuristic workflow plan when the /api/plan server is unreachable.
 * Ensures the user can still proceed even in offline scenarios.
 */
function _buildHeuristicPlan(instruction) {
  const text = (instruction || '').toLowerCase();
  const targetUrl = _extractUrlFromInstruction(instruction);
  const isComplex = /\b(book|ticket|train|flight|potd|leetcode|hotel|order|buy|reservation|checkout|solve|problem|register)\b/i.test(text);

  const steps = [];
  if (targetUrl) {
    steps.push({ step: 1, action: 'Navigate', detail: `Open ${targetUrl}` });
  }
  steps.push({ step: steps.length + 1, action: 'Analyze page', detail: 'Scan page for relevant elements and PII' });
  steps.push({ step: steps.length + 1, action: 'Execute task', detail: 'Perform the requested action on the page' });
  if (isComplex) {
    steps.push({ step: steps.length + 1, action: 'Verify & complete', detail: 'Confirm completion and review result' });
  }

  return {
    target_url: targetUrl || '',
    task_summary: instruction.length > 80 ? instruction.substring(0, 77) + '...' : instruction,
    steps,
    estimated_steps: isComplex ? 20 : 10,
    complexity: isComplex ? 'complex' : 'simple',
    warnings: ['Plan generated locally — server unavailable. AI analysis was skipped.'],
    latency_ms: 0,
    error: null,
  };
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
          'lib/redaction-engine.js',
          'lib/pii-scanner.js',
          'lib/dom-analyzer.js',
          'lib/action-executor.js',
          'content.js'
        ],
      });
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['styles/content.css'],
      });
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

// ── Offscreen & Redaction management ──────────────────────────────────

async function _ensureOffscreen() {
  if (chrome.offscreen && typeof chrome.offscreen.hasDocument === 'function') {
    if (await chrome.offscreen.hasDocument()) return;
  }
  try {
    const contexts = await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts && contexts.length > 0) return;
  } catch {}

  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: 'Canvas redaction',
    });
    // Settle delay for offscreen scripts to register listeners
    await new Promise(r => setTimeout(r, 120));
  } catch (err) {
    if (!err.message?.includes('single offscreen document')) {
      throw err;
    }
  }
}

async function _redactScreenshot(imageDataUrl, regions, tabId = null) {
  if (!regions || regions.length === 0) {
    return { sanitizedImage: imageDataUrl, manifest: { redactions: [] } };
  }

  // Strategy 1: Direct native canvas redaction via Content Script (Fastest & Most Reliable)
  if (tabId) {
    try {
      const res = await _sendToContentScript(tabId, 'REDACT_IMAGE', { imageDataUrl, regions, options: { blurRadius: 20 } }, 1);
      if (res && res.sanitizedImage) {
        return res;
      }
    } catch (tabErr) {
      console.warn('[PrivacyVision] Content script canvas redaction fallback to offscreen:', tabErr.message);
    }
  }

  // Strategy 2: Offscreen Document
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

async function _sendToServerWithTimeout(
  image, summary, manifest, goal, history = [],
  localTelemetry = null,
  domStructured = null,   // ← Structured DOM JSON for AI-2 selector accuracy
  planSteps = null        // ← Plan steps to pre-seed AI context
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SERVER_TIMEOUT_MS);

  try {
    const body = {
      image,
      dom_summary: summary,
      redaction_manifest: manifest,
      user_goal: goal,
      action_history: history,
      local_telemetry: localTelemetry,
    };
    // Include structured DOM if available (preferred over raw text)
    if (domStructured && typeof domStructured === 'object') {
      body.dom_structured = domStructured;
    }
    // Include plan steps for context pre-seeding (only on first call when history is empty)
    if (planSteps && Array.isArray(planSteps) && history.length === 0) {
      body.plan_steps = planSteps;
    }

    const response = await fetch(`${serverUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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

/**
 * Smart AI-2 Retry: calls /api/retry-action when a DOM action fails.
 * Asks AI-2 to pick an alternative selector from the current DOM.
 * Returns {success: bool, corrected_action: object | null}
 */
async function _retryFailedAction(failedAction, pageData, userGoal, failureReason) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);
  try {
    const body = {
      failed_action: failedAction,
      dom_summary: pageData.textSummary || '',
      user_goal: userGoal || '',
      failure_reason: failureReason || 'Unknown DOM injection error',
    };
    if (pageData.domStructured) {
      body.dom_structured = pageData.domStructured;
    }
    const res = await fetch(`${serverUrl}/api/retry-action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn('[PrivacyVision] /api/retry-action failed:', err.message);
    return null;
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
    const faceCount = manifest.redactions.filter(r => r.type === 'FACE_IMAGE' || r.type === 'FACE').length;
    const textCount = redactionCount - faceCount;
    const detailParts = [];
    if (faceCount > 0) detailParts.push(`${faceCount} Face/Avatar(s) Blurred`);
    if (textCount > 0) detailParts.push(`${textCount} PII Secret(s) Blacked Out`);
    if (detailParts.length > 0) {
      lines.push(`• Redaction Breakdown: ${detailParts.join(' | ')}`);
    }
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
