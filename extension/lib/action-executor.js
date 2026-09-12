/**
 * Action Executor — Executes UI action commands received from the server.
 * Runs as part of the content script. Safely executes click, type, scroll, 
 * navigate, select, and wait commands.
 */

// eslint-disable-next-line no-var
var ActionExecutor = (() => {
  'use strict';

  // Track executed actions for the log
  const _actionLog = [];

  /**
   * Execute a list of actions sequentially.
   * @param {Array<object>} actions - Array of action objects
   * @returns {Promise<Array<object>>} Results for each action
   */
  async function executeActions(actions) {
    const results = [];

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const result = await _executeOne(action, i);
      results.push(result);
      _actionLog.push({ ...action, result, timestamp: Date.now() });

      // Brief delay between actions for visual feedback and DOM updates
      if (i < actions.length - 1) {
        await _delay(action.delayAfter || 500);
      }
    }

    return results;
  }

  /**
   * Execute a single action.
   */
  async function _executeOne(action, index) {
    const type = (action.type || '').toLowerCase();

    try {
      switch (type) {
        case 'click':
          return await _actionClick(action);
        case 'type':
        case 'input':
          return await _actionType(action);
        case 'autofill':
        case 'fill_form':
          return await _actionAutofill(action);
        case 'pay':
        case 'authorize_and_pay':
          return await _actionAuthorizeAndPay(action);
        case 'scroll':
          return await _actionScroll(action);
        case 'navigate':
          return await _actionNavigate(action);
        case 'select':
          return await _actionSelect(action);
        case 'wait':
          return await _actionWait(action);
        case 'hover':
          return await _actionHover(action);
        case 'focus':
          return await _actionFocus(action);
        case 'clear':
          return await _actionClear(action);
        case 'keypress':
        case 'key':
        case 'enter':
          return await _actionKeypress(action);
        default:
          return { success: false, error: `Unknown action type: ${type}` };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ── Token & Vault De-anonymization (Zero PII leaves browser) ──────

  async function _resolveVaultValue(el, rawValue) {
    let value = rawValue || '';

    // 1. Resolve PII tokens from PIIScanner (e.g. [EMAIL_1], [PASSWORD_1], [PHONE_1])
    if (typeof PIIScanner !== 'undefined' && PIIScanner.getTokenMap) {
      const tokenMap = PIIScanner.getTokenMap();
      if (tokenMap && tokenMap[value]) {
        return tokenMap[value];
      }
      // Check if value contains tokens
      for (const [tok, orig] of Object.entries(tokenMap || {})) {
        if (value.includes(tok)) {
          value = value.replaceAll(tok, orig);
        }
      }
    }

    // 2. Automatically resolve local Vault secrets for the current site
    if (typeof Vault !== 'undefined') {
      const elType = (el ? el.getAttribute('type') || '' : '').toLowerCase();
      const elId = (el ? el.id || '' : '').toLowerCase();
      const elName = (el ? el.getAttribute('name') || '' : '').toLowerCase();
      const elAutocomplete = (el ? el.getAttribute('autocomplete') || '' : '').toLowerCase();
      const elPlaceholder = (el ? el.getAttribute('placeholder') || '' : '').toLowerCase();
      const elAria = (el ? el.getAttribute('aria-label') || '' : '').toLowerCase();
      const combinedAttrs = `${elId} ${elName} ${elAutocomplete} ${elPlaceholder} ${elAria}`;

      const isPassword = (
        elType === 'password' ||
        /current-password|new-password/i.test(elAutocomplete) ||
        /password|pwd|pass\b/i.test(combinedAttrs)
      );

      const isPinOrCvv = /pin|cvv|cvc|security.*code|otp/i.test(combinedAttrs);
      const isCard = /card|pan|account.*num/i.test(combinedAttrs);
      const isUsernameOrEmail = (
        elType === 'email' ||
        /username|email|account-name/i.test(elAutocomplete) ||
        /user|email|login|account|phone/i.test(combinedAttrs)
      );

      // Check if value is a placeholder or token representation
      const isPlaceholderOrToken = (
        !value ||
        value === '••••••••' ||
        value === '••••••' ||
        /^\[?[A-Z0-9_]*(PASS|PWD|SECRET|CRED|PIN|USER|EMAIL|TOKEN)[A-Z0-9_]*\]?$/i.test(value.trim()) ||
        /^(password|secret|pass|mypassword|user|username|email|enter password)$/i.test(value.trim()) ||
        value.includes('{{VAULT:') ||
        value.includes('[PASSWORD') ||
        value.includes('[CRED_')
      );

      try {
        const matches = await Vault.findMatchingCredentials(window.location.href);
        if (matches && matches.length > 0) {
          const cred = matches[0].data || {};

          // A. Password field - ALWAYS prioritize vault password for current site!
          if (isPassword || (isPlaceholderOrToken && /pass|pwd/i.test(value))) {
            if (cred.password) {
              console.log('[ActionExecutor] Automatically retrieved password from local vault for', window.location.hostname);
              return cred.password;
            }
          }

          // B. PIN / CVV field
          if (isPinOrCvv || (isPlaceholderOrToken && /pin|cvv/i.test(value))) {
            if (cred.upiPin) return cred.upiPin;
            if (cred.cvv) return cred.cvv;
          }

          // C. Credit card / Account number
          if (isCard || (isPlaceholderOrToken && /card|account/i.test(value))) {
            if (cred.cardNumber) return cred.cardNumber;
            if (cred.accountNumber) return cred.accountNumber;
          }

          // D. Username / Email field
          if ((isUsernameOrEmail && isPlaceholderOrToken) || (isPlaceholderOrToken && /user|email/i.test(value))) {
            if (cred.username) return cred.username;
            if (cred.email) return cred.email;
          }
        }
      } catch (err) {
        console.warn('[ActionExecutor] Automatic vault lookup error:', err);
      }
    }

    return value;
  }

  // ── Action implementations ──────────────────────────────────────────

  async function _actionClick(action) {
    const el = _findElement(action);
    if (!el) return { success: false, error: `Element not found: ${action.selector || action.elementIndex}` };

    _highlightElement(el, 'click');
    await _delay(150);

    // Scroll into view if needed
    try {
      el.scrollIntoView({ behavior: 'auto', block: 'center' });
    } catch {}
    await _delay(100);

    // Try focusing
    try { el.focus(); } catch {}

    // Center coordinates for realistic mouse events
    const rect = el.getBoundingClientRect();
    const clientX = Math.round(rect.left + rect.width / 2);
    const clientY = Math.round(rect.top + rect.height / 2);
    const downOpts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
      button: 0,
      buttons: 1
    };
    const upOpts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
      button: 0,
      buttons: 0
    };

    // Full pointer and mouse sequence for React, Angular, Gmail, Twitter
    el.dispatchEvent(new PointerEvent('pointerdown', downOpts));
    el.dispatchEvent(new MouseEvent('mousedown', downOpts));
    el.dispatchEvent(new PointerEvent('pointerup', upOpts));
    el.dispatchEvent(new MouseEvent('mouseup', upOpts));
    el.dispatchEvent(new MouseEvent('click', upOpts));

    // Native click call
    if (typeof el.click === 'function') {
      try { el.click(); } catch {}
    }

    // Also trigger Enter keydown/keyup on role="button" elements if click doesn't trigger
    if (el.getAttribute('role') === 'button' || el.tagName.toLowerCase() === 'div') {
      try {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      } catch {}
    }

    // If element is an icon/span inside a button or role=button, click parent too
    const parentBtn = el.closest('button, [role="button"], a');
    if (parentBtn && parentBtn !== el) {
      try { parentBtn.click(); } catch {}
    }

    // If element is an empty password input, automatically populate it from vault
    const isPwdEl = (
      (el.getAttribute('type') || '').toLowerCase() === 'password' ||
      /password|pwd/i.test(el.id + (el.getAttribute('name') || ''))
    );
    if (isPwdEl && !el.value && typeof Vault !== 'undefined') {
      try {
        const matches = await Vault.findMatchingCredentials(window.location.href);
        if (matches && matches.length > 0 && matches[0].data?.password) {
          console.log('[ActionExecutor] Auto-populating clicked empty password field from local vault');
          _setNativeValue(el, matches[0].data.password);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } catch {}
    }

    _removeHighlight(el);
    return { success: true, description: `Clicked ${action.selector || action.description || 'element'}` };
  }

  function _setNativeValue(element, value) {
    const isContentEditable = element.isContentEditable ||
      element.getAttribute('contenteditable') === 'true' ||
      element.getAttribute('contenteditable') === '';

    if (isContentEditable) {
      element.focus();
      element.innerText = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  async function _actionType(action) {
    const el = _findElement(action);
    if (!el) return { success: false, error: `Element not found: ${action.selector || action.elementIndex}` };

    // Resolve value locally from Reversible Token Map or Encrypted Vault (Zero PII to cloud!)
    const text = await _resolveVaultValue(el, action.value || action.text || '');

    _highlightElement(el, 'type');
    await _delay(150);

    try {
      el.scrollIntoView({ behavior: 'auto', block: 'center' });
    } catch {}
    try {
      el.focus();
    } catch {}

    const isContentEditable = el.isContentEditable ||
      el.getAttribute('contenteditable') === 'true' ||
      el.getAttribute('contenteditable') === '';

    // Clear existing value if requested
    if (action.clear !== false) {
      if (isContentEditable) {
        el.innerText = '';
      } else {
        _setNativeValue(el, '');
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Type character by character with native setter & events for framework compatibility
    let current = '';
    for (let i = 0; i < text.length; i++) {
      current += text[i];
      if (isContentEditable) {
        el.innerText = current;
      } else {
        _setNativeValue(el, current);
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text[i], inputType: 'insertText' }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: text[i], bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keypress', { key: text[i], bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: text[i], bubbles: true }));
      await _delay(15 + Math.random() * 20);
    }

    if (isContentEditable) {
      el.innerText = text;
    } else {
      _setNativeValue(el, text);
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));

    // Auto-fill adjacent empty password field if user just typed a login / email
    const elInputType = (el.getAttribute('type') || '').toLowerCase();
    const isLoginField = elInputType === 'email' || /user|login|email/i.test(el.id + (el.getAttribute('name') || ''));
    if (isLoginField && typeof Vault !== 'undefined') {
      try {
        const form = el.closest('form') || document;
        const pwdInput = form.querySelector('input[type="password"], input[name*="password"], input[id*="password"]');
        if (pwdInput && !pwdInput.value) {
          const matches = await Vault.findMatchingCredentials(window.location.href);
          if (matches && matches.length > 0 && matches[0].data?.password) {
            console.log('[ActionExecutor] Auto-filling empty password field in same form from local vault');
            _setNativeValue(pwdInput, matches[0].data.password);
            pwdInput.dispatchEvent(new Event('input', { bubbles: true }));
            pwdInput.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      } catch {}
    }

    // Detect if this is a search input or if submit was requested
    const isSearchInput = (
      action.submit ||
      action.pressEnter ||
      (el.getAttribute('type') || '').toLowerCase() === 'search' ||
      /search/i.test(el.getAttribute('placeholder') || '') ||
      /search/i.test(el.getAttribute('name') || '') ||
      /search/i.test(el.id || '') ||
      el.getAttribute('name') === 'q'
    );

    if (isSearchInput) {
      await _delay(250);
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));

      // Also try submitting parent form
      const form = el.closest('form');
      if (form) {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }

      // Adjacent search button check
      const searchBtn = document.querySelector('button#search-icon-legacy, button[aria-label="Search"], input[type="submit"]');
      if (searchBtn && typeof searchBtn.click === 'function') {
        try { searchBtn.click(); } catch {}
      }
    }

    _removeHighlight(el);
    const isSecret = (el.getAttribute('type') || '').toLowerCase() === 'password';
    const maskedSnippet = isSecret ? '••••••••' : text.substring(0, 30);
    return { success: true, description: `Typed "${maskedSnippet}" into ${action.selector || 'element'}` };
  }


  // ── Smart Local Form Autofill Engine ────────────────────────────────

  async function _actionAutofill(action) {
    if (typeof Vault === 'undefined') {
      return { success: false, error: 'Local Vault not initialized' };
    }

    const matches = await Vault.findMatchingCredentials(window.location.href);
    if (!matches || matches.length === 0) {
      return { success: false, error: `No stored credentials in local vault for ${window.location.hostname}` };
    }

    const cred = matches[0];
    const data = cred.data || {};

    // Check if form contains password/PIN to request biometric authorization up front
    const passwordInputs = document.querySelectorAll('input[type="password"], input[name*="pin"], input[id*="pin"]');
    if (passwordInputs.length > 0 && typeof BiometricGate !== 'undefined') {
      const auth = await BiometricGate.requestAuthorization({
        title: `Authorize Autofill for ${cred.name}`,
        target: window.location.hostname,
        credentialType: 'Saved Vault Credentials & Password',
        description: `Autofill ${cred.name} on ${window.location.hostname}. Stored 100% locally.`,
      });
      if (!auth.authorized) {
        return { success: false, error: 'User Denied Biometric Authorization for Autofill' };
      }
    }

    let filledCount = 0;
    const inputs = document.querySelectorAll('input:not([type="hidden"]), textarea, select');

    for (const input of inputs) {
      const type = (input.getAttribute('type') || '').toLowerCase();
      const id = (input.id || '').toLowerCase();
      const name = (input.getAttribute('name') || '').toLowerCase();
      const placeholder = (input.getAttribute('placeholder') || '').toLowerCase();
      const labelText = (input.closest('label') || input.parentElement)?.textContent?.toLowerCase() || '';
      const combined = `${id} ${name} ${placeholder} ${labelText}`;

      let valToFill = null;

      // 1. Password / PIN
      if (type === 'password' || /password|pwd|pass/i.test(combined)) {
        valToFill = data.password;
      } else if (/pin|cvv/i.test(combined)) {
        valToFill = data.upiPin || data.cvv;
      }
      // 2. Username / Email
      else if (/username|user|email|login/i.test(combined)) {
        valToFill = data.username || data.email;
      }
      // 3. Beneficiary / Full Name
      else if (/beneficiary|payee|recipient|receiver/i.test(combined)) {
        valToFill = data.beneficiary || data.name || data.fullName;
      } else if (/name/i.test(combined) && !/user/i.test(combined)) {
        valToFill = data.name || data.fullName || data.username;
      }
      // 4. Bank Account
      else if (/account|acct/i.test(combined)) {
        valToFill = data.accountNumber;
      }
      // 5. IFSC / Routing
      else if (/ifsc|routing/i.test(combined)) {
        valToFill = data.ifsc;
      }
      // 6. Amount
      else if (/amount/i.test(combined)) {
        valToFill = data.amount || data.defaultAmount;
      }
      // 7. UPI ID
      else if (/upi/i.test(combined)) {
        valToFill = data.upiId;
      }
      // 8. Remarks / Note
      else if (/remark|note|memo|reason/i.test(combined)) {
        valToFill = data.remarks || 'Authorized via PrivacyVision Agent';
      }

      if (valToFill) {
        _highlightElement(input, 'autofill');
        _setNativeValue(input, valToFill);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await _delay(120);
        _removeHighlight(input);
        filledCount++;
      }
    }

    return {
      success: true,
      description: `Autofilled ${filledCount} field(s) from local vault for ${cred.name}`,
    };
  }

  // ── Authorize and Pay Action ────────────────────────────────────────

  async function _actionAuthorizeAndPay(action) {
    // 1. First autofill the form with credentials
    await _actionAutofill(action);

    // 2. If a specific element or selector was requested by AI, click that directly!
    if (action.selector || action.elementIndex !== undefined) {
      return await _actionClick(action);
    }

    // 3. Otherwise find general form submit button
    const submitBtn = document.querySelector(
      'button[type="submit"], input[type="submit"], form button:not([type="button"])'
    );

    if (submitBtn) {
      return await _actionClick({ selector: _buildSelector(submitBtn), description: 'Submit Authorized Action' });
    }

    return { success: true, description: 'Autofilled and authorized credentials.' };
  }

  async function _actionScroll(action) {
    const direction = (action.direction || 'down').toLowerCase();
    const amount = action.amount || 400;

    let scrollX = 0, scrollY = 0;
    if (direction === 'down') scrollY = amount;
    else if (direction === 'up') scrollY = -amount;
    else if (direction === 'right') scrollX = amount;
    else if (direction === 'left') scrollX = -amount;

    window.scrollBy({ left: scrollX, top: scrollY, behavior: 'smooth' });
    await _delay(500);

    return { success: true, description: `Scrolled ${direction} by ${amount}px` };
  }

  async function _actionNavigate(action) {
    const url = action.url || action.value;
    if (!url) return { success: false, error: 'No URL provided for navigate action' };

    window.location.href = url;
    return { success: true, description: `Navigating to ${url}` };
  }

  async function _actionSelect(action) {
    const el = _findElement(action);
    if (!el || el.tagName.toLowerCase() !== 'select') {
      return { success: false, error: `Select element not found: ${action.selector}` };
    }

    _highlightElement(el, 'select');
    el.value = action.value || '';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    _removeHighlight(el);

    return { success: true, description: `Selected "${action.value}" in ${action.selector}` };
  }

  async function _actionWait(action) {
    const ms = action.duration || action.value || 1000;
    await _delay(ms);
    return { success: true, description: `Waited ${ms}ms` };
  }

  async function _actionHover(action) {
    const el = _findElement(action);
    if (!el) return { success: false, error: `Element not found: ${action.selector}` };

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    _highlightElement(el, 'hover');
    await _delay(500);
    _removeHighlight(el);

    return { success: true, description: `Hovered over ${action.selector}` };
  }

  async function _actionFocus(action) {
    const el = _findElement(action);
    if (!el) return { success: false, error: `Element not found: ${action.selector}` };

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus();
    return { success: true, description: `Focused ${action.selector}` };
  }

  async function _actionClear(action) {
    const el = _findElement(action);
    if (!el) return { success: false, error: `Element not found: ${action.selector}` };

    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, description: `Cleared ${action.selector}` };
  }

  async function _actionKeypress(action) {
    // Find element to press key on (defaults to active element or body)
    let el = null;
    if (action.selector) {
      el = _findElement(action);
    }
    if (!el) {
      el = document.activeElement || document.body;
    }

    const key = action.key || action.value || 'Enter';
    const keyCode = key === 'Enter' ? 13 : key === 'Tab' ? 9 : key === 'Escape' ? 27 : 0;

    el.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, keyCode, which: keyCode, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keypress', { key, code: key, keyCode, which: keyCode, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, keyCode, which: keyCode, bubbles: true }));

    // Special: if Enter key, also try form submission
    if (key === 'Enter') {
      const form = el.closest('form');
      if (form) {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
    }

    return { success: true, description: `Pressed ${key} on ${action.selector || 'active element'}` };
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  function _findElement(action) {
    // 1. Try numeric or string data-pv-index
    if (action.elementIndex !== undefined && action.elementIndex !== null) {
      const idx = parseInt(action.elementIndex, 10);
      if (!isNaN(idx)) {
        const el = document.querySelector(`[data-pv-index="${idx}"]`);
        if (el) return el;
      }
    }

    // 2. Try CSS selector with safe error handling
    if (action.selector && typeof action.selector === 'string') {
      const sel = action.selector.trim();
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch {
        // Handle unescaped ID selectors (e.g. Gmail's #:7c)
        if (sel.startsWith('#')) {
          const rawId = sel.substring(1);
          const byId = document.getElementById(rawId);
          if (byId) return byId;
          try {
            if (typeof CSS !== 'undefined' && CSS.escape) {
              const escaped = document.querySelector('#' + CSS.escape(rawId));
              if (escaped) return escaped;
            }
          } catch {}
        }
      }

      // If selector has exact aria-label match, also try substring match (Gmail unicode support)
      if (sel.includes('[aria-label="')) {
        try {
          const looseSel = sel.replace(/\[aria-label="([^"]+)"\]/, '[aria-label*="$1"]');
          const el = document.querySelector(looseSel);
          if (el) return el;
        } catch {}
      }
    }

    // 3. Match by ARIA label or title if specified in description/selector
    if (action.description || action.selector) {
      const combined = `${action.selector || ''} ${action.description || ''}`;
      const ariaMatch = combined.match(/aria-label=["']?([^"'\]]+)["']?/i);
      if (ariaMatch) {
        const found = document.querySelector(`[aria-label*="${ariaMatch[1]}"]`);
        if (found) return found;
      }

      // Check common keywords from description
      const descLower = (action.description || '').toLowerCase();
      if (descLower) {
        const ariaEls = document.querySelectorAll('[aria-label], [title], [placeholder], [name]');
        for (const el of ariaEls) {
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const title = (el.getAttribute('title') || '').toLowerCase();
          const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
          const name = (el.getAttribute('name') || '').toLowerCase();
          if (aria && (aria === descLower || descLower.includes(aria) || aria.includes(descLower))) return el;
          if (title && (title === descLower || descLower.includes(title))) return el;
          if (placeholder && (placeholder === descLower || descLower.includes(placeholder))) return el;
          if (name && (name === descLower || descLower.includes(name))) return el;
        }
      }
    }

    // 4. Try element index from DOM collection
    if (action.elementIndex !== undefined && action.elementIndex !== null) {
      const idx = parseInt(action.elementIndex, 10);
      if (!isNaN(idx)) {
        const all = document.querySelectorAll('a, button, input, textarea, select, [role="button"], [role="textbox"], [contenteditable]');
        if (all[idx]) return all[idx];
      }
    }

    // 5. Try text content match
    if (action.text || action.description) {
      const searchText = (action.text || action.description).toLowerCase().trim();
      const candidates = document.querySelectorAll('button, a, input[type="submit"], [role="button"], [role="tab"], [role="menuitem"]');
      for (const el of candidates) {
        const elText = (el.textContent || '').toLowerCase().trim();
        const aria = (el.getAttribute('aria-label') || '').toLowerCase().trim();
        if (elText === searchText || aria === searchText) return el;
        if (searchText.length > 2 && (elText.includes(searchText) || aria.includes(searchText))) return el;
      }
    }

    return null;
  }

  function _highlightElement(el, actionType) {
    const indicator = document.createElement('div');
    indicator.className = 'pv-action-indicator';
    indicator.dataset.action = actionType;
    const rect = el.getBoundingClientRect();
    Object.assign(indicator.style, {
      position: 'fixed',
      left: `${rect.left - 4}px`,
      top: `${rect.top - 4}px`,
      width: `${rect.width + 8}px`,
      height: `${rect.height + 8}px`,
    });
    document.body.appendChild(indicator);
    el._pvIndicator = indicator;
  }

  function _removeHighlight(el) {
    if (el._pvIndicator) {
      el._pvIndicator.remove();
      delete el._pvIndicator;
    }
  }

  function _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  return {
    executeActions,
    getActionLog: () => [..._actionLog],
  };
})();

if (typeof window !== 'undefined') {
  window.ActionExecutor = ActionExecutor;
}
