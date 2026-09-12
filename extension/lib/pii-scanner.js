/**
 * PII Scanner — Client-side PII/sensitive data detection engine.
 * Runs as a content script. Detects PII via regex patterns + DOM context.
 * All processing is local — no data leaves the browser.
 */

// eslint-disable-next-line no-var
var PIIScanner = (() => {
  'use strict';

  // ── Pattern definitions ─────────────────────────────────────────────
  const PII_PATTERNS = {
    EMAIL: {
      regex: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
      label: 'EMAIL',
      severity: 'high',
    },
    PHONE_IN: {
      regex: /(?:\+91[\s\-.]?)?\(?\d{3,5}\)?[\s\-.]?\d{3,5}[\s\-.]?\d{4,5}/g,
      label: 'PHONE',
      severity: 'high',
    },
    PHONE_INTL: {
      regex: /\+\d{1,3}[\s\-.]?\(?\d{2,4}\)?[\s\-.]?\d{3,4}[\s\-.]?\d{3,4}/g,
      label: 'PHONE',
      severity: 'high',
    },
    CREDIT_CARD: {
      regex: /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g,
      label: 'CREDIT_CARD',
      severity: 'critical',
    },
    AADHAAR: {
      regex: /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g,
      label: 'AADHAAR',
      severity: 'critical',
      // Validator: Aadhaar numbers don't start with 0 or 1
      validate: (match) => {
        const digits = match.replace(/[\s\-]/g, '');
        return digits.length === 12 && !digits.startsWith('0') && !digits.startsWith('1');
      },
    },
    PAN: {
      regex: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
      label: 'PAN',
      severity: 'critical',
    },
    SSN: {
      regex: /\b\d{3}[\s\-]?\d{2}[\s\-]?\d{4}\b/g,
      label: 'SSN',
      severity: 'critical',
    },
    DATE_OF_BIRTH: {
      regex: /\b(?:\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})\b/g,
      label: 'DOB',
      severity: 'medium',
    },
    IFSC: {
      regex: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
      label: 'IFSC_CODE',
      severity: 'medium',
    },
    UPI_ID: {
      regex: /[a-zA-Z0-9.\-_]+@[a-z]{2,}/g,
      label: 'UPI_ID',
      severity: 'high',
      // Distinguish from email: UPI domains are short (oksbi, ybl, paytm etc.)
      validate: (match) => {
        const domain = match.split('@')[1];
        const upiDomains = ['oksbi', 'okhdfcbank', 'okicici', 'okaxis', 'ybl', 'paytm', 'ibl', 'upi', 'axl', 'sbi', 'apl'];
        return upiDomains.includes(domain) || domain.length <= 5;
      },
    },
    ACCOUNT_NUMBER: {
      regex: /\b\d{9,18}\b/g,
      label: 'ACCOUNT_NUMBER',
      severity: 'critical',
      // Only flag numbers that appear near banking context
      contextRequired: true,
    },
    IP_ADDRESS: {
      regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
      label: 'IP_ADDRESS',
      severity: 'low',
    },
    PASSPORT: {
      regex: /\b[A-Z]\d{7}\b/g,
      label: 'PASSPORT',
      severity: 'critical',
    },
  };

  // Context keywords that indicate surrounding text is sensitive
  const CONTEXT_KEYWORDS = [
    'account', 'acct', 'a/c', 'balance', 'ifsc', 'bank', 'card',
    'password', 'pass', 'pin', 'cvv', 'otp', 'ssn', 'aadhaar',
    'pan', 'passport', 'license', 'licence', 'salary', 'income',
    'transfer', 'beneficiary', 'routing', 'swift',
  ];

  // DOM input types that are inherently sensitive
  const SENSITIVE_INPUT_TYPES = ['password', 'email', 'tel'];
  const SENSITIVE_INPUT_NAMES = [
    'password', 'pass', 'pwd', 'email', 'phone', 'tel', 'mobile',
    'ssn', 'aadhaar', 'pan', 'dob', 'birth', 'account', 'card',
    'cvv', 'otp', 'pin', 'name', 'address', 'passport',
  ];

  // ── Token storage (for reversible redaction) ────────────────────────
  let _tokenMap = {};   // token → original value
  let _tokenCounter = {};

  function _resetTokens() {
    _tokenMap = {};
    _tokenCounter = {};
  }

  function _generateToken(label) {
    if (!_tokenCounter[label]) _tokenCounter[label] = 0;
    _tokenCounter[label]++;
    const token = `[${label}_${_tokenCounter[label]}]`;
    return token;
  }

  // ── Core scanning ───────────────────────────────────────────────────

  /**
   * Scan a string for PII matches.
   * @param {string} text - The text to scan
   * @param {string} [contextHint] - Surrounding context (label text, field name)
   * @returns {Array<{type: string, value: string, start: number, end: number, severity: string, token: string}>}
   */
  function scanText(text, contextHint = '') {
    if (!text || typeof text !== 'string') return [];

    const findings = [];
    const fullContext = (text + ' ' + contextHint).toLowerCase();
    const hasContext = CONTEXT_KEYWORDS.some((kw) => fullContext.includes(kw));

    for (const [key, pattern] of Object.entries(PII_PATTERNS)) {
      // Skip context-dependent patterns if no context
      if (pattern.contextRequired && !hasContext) continue;

      pattern.regex.lastIndex = 0; // Reset regex state
      let match;
      while ((match = pattern.regex.exec(text)) !== null) {
        const value = match[0];

        // Run validator if present
        if (pattern.validate && !pattern.validate(value)) continue;

        const token = _generateToken(pattern.label);
        _tokenMap[token] = value;

        findings.push({
          type: pattern.label,
          value,
          start: match.index,
          end: match.index + value.length,
          severity: pattern.severity,
          token,
        });
      }
    }

    // Deduplicate overlapping findings (prefer higher severity)
    return _deduplicateFindings(findings);
  }

  /**
   * Scan a DOM element for sensitive inputs and visible text.
   * @param {Element} rootElement - The root element to scan
   * @returns {{textFindings: Array, inputFindings: Array, allFindings: Array}}
   */
  function scanDOM(rootElement = document.body) {
    _resetTokens();
    const textFindings = [];
    const inputFindings = [];

    // 1. Scan all visible text nodes
    const walker = document.createTreeWalker(
      rootElement,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          // Skip hidden, script, style elements
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName.toLowerCase();
          if (['script', 'style', 'noscript', 'svg'].includes(tag)) return NodeFilter.FILTER_REJECT;
          if (parent.offsetParent === null && parent !== document.body) return NodeFilter.FILTER_REJECT;
          const text = node.textContent.trim();
          if (text.length < 3) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    let textNode;
    while ((textNode = walker.nextNode())) {
      const text = textNode.textContent;
      // Get context from parent's label, aria, etc.
      const parent = textNode.parentElement;
      const contextHint = _getElementContext(parent);

      const findings = scanText(text, contextHint);
      for (const f of findings) {
        f.element = parent;
        f.rect = _getElementRect(parent);
        f.source = 'text';
        textFindings.push(f);
      }
    }

    // 2. Scan input fields
    const inputs = rootElement.querySelectorAll('input, textarea, select');
    for (const input of inputs) {
      const inputType = (input.type || '').toLowerCase();
      const inputName = (input.name || '').toLowerCase();
      const inputId = (input.id || '').toLowerCase();
      const inputPlaceholder = (input.placeholder || '').toLowerCase();
      const inputLabel = _getAssociatedLabel(input);

      // Check if the input type or name indicates sensitivity
      const isSensitiveType = SENSITIVE_INPUT_TYPES.includes(inputType);
      const isSensitiveName = SENSITIVE_INPUT_NAMES.some(
        (kw) => inputName.includes(kw) || inputId.includes(kw) || inputPlaceholder.includes(kw) || inputLabel.toLowerCase().includes(kw)
      );

      if (isSensitiveType || isSensitiveName) {
        const value = input.value || '';
        let piiType = 'SENSITIVE_INPUT';

        if (inputType === 'password') piiType = 'PASSWORD';
        else if (inputType === 'email' || inputName.includes('email')) piiType = 'EMAIL';
        else if (inputType === 'tel' || inputName.includes('phone') || inputName.includes('tel') || inputName.includes('mobile')) piiType = 'PHONE';
        else if (inputName.includes('card')) piiType = 'CREDIT_CARD';
        else if (inputName.includes('account') || inputName.includes('acct')) piiType = 'ACCOUNT_NUMBER';
        else if (inputName.includes('name') || inputName.includes('beneficiary')) piiType = 'PERSON_NAME';

        const token = _generateToken(piiType);
        if (value) _tokenMap[token] = value;

        inputFindings.push({
          type: piiType,
          value: piiType === 'PASSWORD' ? '••••••••' : value,
          severity: piiType === 'PASSWORD' ? 'critical' : 'high',
          token,
          element: input,
          rect: _getElementRect(input),
          source: 'input',
          selector: _buildSelector(input),
          inputType,
          fieldLabel: inputLabel,
        });
      }

      // Also regex-scan the input value
      if (input.value && input.value.length > 3 && inputType !== 'password') {
        const findings = scanText(input.value, inputLabel + ' ' + inputName);
        for (const f of findings) {
          f.element = input;
          f.rect = _getElementRect(input);
          f.source = 'input-value';
          f.selector = _buildSelector(input);
          textFindings.push(f);
        }
      }
    }

    // 3. Scan images with faces (mark for vision pipeline)
    const images = rootElement.querySelectorAll('img[src]');
    const imageFindings = [];
    // Only strong profile/avatar keywords — avoid generic terms like 'user'
    const PROFILE_KEYWORDS = ['avatar', 'profile-pic', 'profile_pic', 'profilepic',
      'profile-photo', 'profile_photo', 'profile-image', 'profile_image',
      'user-avatar', 'user_avatar', 'headshot', 'portrait', 'selfie',
      'face-photo', 'passport-photo'];

    for (const img of images) {
      const alt = (img.alt || '').toLowerCase();
      const cls = (img.className || '').toLowerCase();
      const id = (img.id || '').toLowerCase();
      const src = (img.src || '').toLowerCase();

      const combinedText = `${alt} ${cls} ${id} ${src}`;
      const isProfileImage = PROFILE_KEYWORDS.some((kw) => combinedText.includes(kw));

      // Only flag if keyword match AND image is a reasonable size (not tiny icons)
      if (isProfileImage && img.naturalWidth >= 40 && img.naturalHeight >= 40) {
        imageFindings.push({
          type: 'FACE_IMAGE',
          severity: 'high',
          element: img,
          rect: _getElementRect(img),
          source: 'image',
          src: img.src,
          token: _generateToken('FACE'),
        });
      }
    }

    const allFindings = [...textFindings, ...inputFindings, ...imageFindings];

    return {
      textFindings,
      inputFindings,
      imageFindings,
      allFindings,
      tokenMap: { ..._tokenMap },
      summary: {
        total: allFindings.length,
        critical: allFindings.filter((f) => f.severity === 'critical').length,
        high: allFindings.filter((f) => f.severity === 'high').length,
        medium: allFindings.filter((f) => f.severity === 'medium').length,
        low: allFindings.filter((f) => f.severity === 'low').length,
        types: [...new Set(allFindings.map((f) => f.type))],
      },
    };
  }

  /**
   * Sanitize a DOM structure object by replacing PII values with tokens.
   * @param {object} domStructure - The DOM structure from DOMAnalyzer
   * @param {Array} findings - PII findings array
   * @returns {object} Sanitized DOM structure
   */
  function sanitizeDOMStructure(domStructure, findings) {
    const sanitized = JSON.parse(JSON.stringify(domStructure)); // Deep clone

    for (const element of sanitized.elements || []) {
      // DOMAnalyzer stores visible text in `text` (not `textContent`).
      // Sanitize every user-facing string field before the summary is sent.
      const fieldsToSanitize = ['text', 'value', 'placeholder', 'fieldLabel', 'ariaLabel', 'href'];
      for (const field of fieldsToSanitize) {
        if (typeof element[field] !== 'string' || !element[field]) continue;
        for (const finding of findings) {
          if (!finding.value || !finding.token) continue;
          element[field] = element[field].split(finding.value).join(finding.token);
        }
      }
    }

    return sanitized;
  }

  // ── Helper functions ────────────────────────────────────────────────

  function _getElementRect(el) {
    try {
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.x + window.scrollX),
        y: Math.round(rect.y + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    } catch {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
  }

  function _getElementContext(el) {
    if (!el) return '';
    const parts = [];
    if (el.getAttribute('aria-label')) parts.push(el.getAttribute('aria-label'));
    if (el.getAttribute('title')) parts.push(el.getAttribute('title'));
    // Check for preceding label
    const prev = el.previousElementSibling;
    if (prev && prev.tagName === 'LABEL') parts.push(prev.textContent);
    // Check parent's text
    const parent = el.parentElement;
    if (parent) {
      const label = parent.querySelector('label');
      if (label) parts.push(label.textContent);
    }
    return parts.join(' ');
  }

  function _getAssociatedLabel(input) {
    // Check for <label for="...">
    if (input.id) {
      const label = document.querySelector(`label[for="${input.id}"]`);
      if (label) return label.textContent.trim();
    }
    // Check for parent <label>
    const parentLabel = input.closest('label');
    if (parentLabel) return parentLabel.textContent.trim();
    // Check preceding sibling
    const prev = input.previousElementSibling;
    if (prev && prev.tagName === 'LABEL') return prev.textContent.trim();
    // Check parent's label child
    const parent = input.parentElement;
    if (parent) {
      const label = parent.querySelector('label');
      if (label) return label.textContent.trim();
    }
    return input.placeholder || input.name || '';
  }

  function _buildSelector(el) {
    if (el.id) return `#${el.id}`;
    const parts = [];
    let current = el;
    while (current && current !== document.body) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        selector = `#${current.id}`;
        parts.unshift(selector);
        break;
      }
      if (current.className && typeof current.className === 'string') {
        const cls = current.className.trim().split(/\s+/).filter(c => c && !c.startsWith('pv-'))[0];
        if (cls) selector += `.${cls}`;
      }
      // Add nth-child for disambiguation
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((s) => s.tagName === current.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          selector += `:nth-child(${idx})`;
        }
      }
      parts.unshift(selector);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function _deduplicateFindings(findings) {
    // Sort by start position, then by severity (critical first)
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    findings.sort((a, b) => a.start - b.start || severityOrder[a.severity] - severityOrder[b.severity]);

    const result = [];
    for (const f of findings) {
      // Check if this finding overlaps with the last accepted one
      const last = result[result.length - 1];
      if (last && f.start < last.end && f.type !== last.type) {
        // Overlapping — keep the higher severity one
        if (severityOrder[f.severity] < severityOrder[last.severity]) {
          result[result.length - 1] = f;
        }
        continue;
      }
      result.push(f);
    }
    return result;
  }

  /**
   * Tokenize any sensitive data inside a natural language instruction or text string,
   * replacing emails, card numbers, phone numbers, and keys with tokens like [EMAIL_1],
   * and saving them in _tokenMap so that local de-tokenization works automatically.
   */
  function sanitizeInstruction(text) {
    if (!text || typeof text !== 'string') return text;
    const findings = scanText(text);
    if (!findings || findings.length === 0) return text;

    // Sort descending by start position to replace without offsetting indices
    const sorted = [...findings].sort((a, b) => b.start - a.start);
    let result = text;
    for (const f of sorted) {
      result = result.substring(0, f.start) + f.token + result.substring(f.end);
    }
    return result;
  }

  // ── Public API ──────────────────────────────────────────────────────
  return {
    scanText,
    scanDOM,
    sanitizeDOMStructure,
    sanitizeInstruction,
    getTokenMap: () => ({ ..._tokenMap }),
    PII_PATTERNS,
  };
})();

// Make available to content script messaging
if (typeof window !== 'undefined') {
  window.PIIScanner = PIIScanner;
}
