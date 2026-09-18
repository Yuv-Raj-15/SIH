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
      // Only flag IPs near network/server context to avoid false positives (version numbers, prices)
      contextRequired: true,
    },
    PASSPORT: {
      regex: /\b[A-Z]\d{7}\b/g,
      label: 'PASSPORT',
      severity: 'critical',
    },
    SOCIAL_METRIC: {
      regex: /\b\d+[\s,]*(?:k|m|b)?\s*(?:followers?|following|posts?|likes?|subscribers?|views?|connections?|retweets?)\b/gi,
      label: 'SOCIAL_METRIC',
      severity: 'high',
    },
    HANDLE: {
      regex: /(?:^|[\s(])@([a-zA-Z0-9_.]{3,30})\b/g,
      label: 'USERNAME',
      severity: 'high',
    },
    PERSONAL_URL: {
      regex: /\b(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.(?:com\.np|np|me|bio|link|site|dev|app|info|portfolio))\b/gi,
      label: 'PERSONAL_URL',
      severity: 'medium',
    },
  };

  // Context keywords that indicate surrounding text is sensitive
  const CONTEXT_KEYWORDS = [
    'account', 'acct', 'a/c', 'balance', 'ifsc', 'bank', 'card',
    'password', 'pass', 'pin', 'cvv', 'otp', 'ssn', 'aadhaar',
    'pan', 'passport', 'license', 'licence', 'salary', 'income',
    'transfer', 'beneficiary', 'routing', 'swift',
    // Extended: UPI & Indian banking
    'upi', 'neft', 'rtgs', 'imps', 'vpa', 'payer', 'payee',
    // Extended: identity & address
    'dob', 'birth', 'address', 'residence', 'permanent',
    // Extended: credentials
    'token', 'secret', 'key', 'api key', 'auth', 'credential',
    // Extended: financial
    'debit', 'credit', 'loan', 'emi', 'folio', 'policy',
  ];

  // DOM input types that are inherently sensitive
  const SENSITIVE_INPUT_TYPES = ['password', 'email', 'tel'];
  const SENSITIVE_INPUT_NAMES = [
    'password', 'pass', 'pwd', 'email', 'phone', 'tel', 'mobile',
    'ssn', 'aadhaar', 'aadhar', 'pan', 'dob', 'birth', 'account', 'card',
    'cvv', 'otp', 'pin', 'name', 'address', 'addr', 'passport',
    'upi', 'vpa', 'ifsc', 'routing', 'swift', 'beneficiary',
    'salary', 'income', 'amount', 'token', 'secret', 'apikey', 'api_key',
  ];

  // ── Token storage (for reversible redaction) ────────────────────────
  let _tokenMap = {};   // token → original value
  let _tokenCounter = {};
  const _registeredTokens = {}; // persistent tokens registered externally (e.g. prompt PII, vault, popup)

  function registerTokens(tokens) {
    if (!tokens || typeof tokens !== 'object') return;
    for (const [tok, val] of Object.entries(tokens)) {
      if (tok && val) {
        _tokenMap[tok] = val;
        _registeredTokens[tok] = val;
      }
    }
  }

  function _resetTokens() {
    // Preserve instruction and externally registered tokens across scan cycles
    const preserved = { ..._registeredTokens };
    for (const [k, v] of Object.entries(_tokenMap)) {
      if (k.includes('TARGET_USER') || k.includes('INSTRUCTION') || k.includes('USERNAME')) {
        preserved[k] = v;
      }
    }
    _tokenMap = preserved;
    _tokenCounter = {};
    for (const k of Object.keys(preserved)) {
      const match = k.match(/^\[([A-Z0-9_]+)_(\d+)\]$/);
      if (match) {
        _tokenCounter[match[1]] = Math.max(_tokenCounter[match[1]] || 0, parseInt(match[2], 10));
      }
    }
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

    // 0. Detect active page profile identity (Instagram, Twitter, LinkedIn, GitHub, etc.)
    const hostname = (typeof window !== 'undefined' && window.location ? window.location.hostname || '' : '').toLowerCase();
    const pathname = (typeof window !== 'undefined' && window.location ? window.location.pathname || '' : '');
    const isSocialOrProfilePage = (
      /instagram\.com|threads\.net|twitter\.com|x\.com|linkedin\.com|facebook\.com|github\.com|tiktok\.com|youtube\.com|pinterest\.com|reddit\.com|bsky\.app|mastodon|medium\.com|quora\.com|discord\.com|telegram\.org|whatsapp\.com/i.test(hostname) ||
      /\/(?:profile|user|u|in|channel|c|author|member|account)\b/i.test(pathname) ||
      pathname.includes('/@')
    );

    // Extract profile handle from URL pathname
    const pathSegments = pathname.split('/').filter(Boolean);
    let pageHandle = null;
    if (pathSegments.length > 0) {
      const candidate = pathSegments[0].replace(/^@/, '');
      const reserved = ['explore', 'direct', 'reels', 'stories', 'accounts', 'p', 'reel', 'tv', 'about', 'help', 'privacy', 'settings', 'home', 'search', 'notifications', 'messages', 'login', 'signup', 'in'];
      if (!reserved.includes(candidate.toLowerCase()) && /^[a-zA-Z0-9_.]{3,35}$/.test(candidate)) {
        pageHandle = candidate;
      } else if (pathSegments[0].toLowerCase() === 'in' && pathSegments[1]) {
        // LinkedIn /in/username
        pageHandle = pathSegments[1];
      }
    }

    // Extract profile name & handle from title or meta tags
    let pageDisplayName = null;
    if (typeof document !== 'undefined') {
      const docTitle = document.title || '';
      const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
      const titleToParse = ogTitle || docTitle;

      // e.g. "Yuvraj Rauniyar (@yuvraj_rauniyar15) • Instagram photos and videos"
      const parenMatch = titleToParse.match(/^([^(]+?)\s*\(@([a-zA-Z0-9_.]{3,35})\)/i);
      if (parenMatch) {
        pageDisplayName = parenMatch[1].trim();
        pageHandle = pageHandle || parenMatch[2].trim();
      } else {
        const splitMatch = titleToParse.match(/^([^|•\-\/]+)\s*[|•\-\/]/);
        if (splitMatch && splitMatch[1].trim().length > 2 && splitMatch[1].trim().length < 40) {
          const cName = splitMatch[1].trim();
          if (!['instagram', 'twitter', 'linkedin', 'github', 'facebook'].includes(cName.toLowerCase())) {
            pageDisplayName = cName;
          }
        }
      }

      // Fallback: extract display name directly from profile header DOM if title is generic (e.g. "Instagram")
      if (!pageDisplayName) {
        const headerContainer = document.querySelector('header, [role="main"] header, section');
        if (headerContainer) {
          const candidates = headerContainer.querySelectorAll('h1, h2, h3, span, div');
          for (const el of candidates) {
            const txt = (el.textContent || '').trim();
            if (txt.length >= 3 && txt.length <= 40 && !txt.includes('\n') && txt !== pageHandle) {
              if (/^[A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+)+$/.test(txt)) {
                pageDisplayName = txt;
                break;
              }
            }
          }
        }
      }
    }

    // Register active profile identity tokens
    let pageHandleToken = null;
    if (pageHandle) {
      pageHandleToken = _generateToken('USERNAME');
      _tokenMap[pageHandleToken] = pageHandle;
    }
    let pageNameToken = null;
    if (pageDisplayName && pageDisplayName.length > 2) {
      pageNameToken = _generateToken('PERSON_NAME');
      _tokenMap[pageNameToken] = pageDisplayName;
    }

    // 1. Scan all visible text nodes
    const walker = document.createTreeWalker(
      rootElement,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName.toLowerCase();
          if (['script', 'style', 'noscript', 'svg'].includes(tag)) return NodeFilter.FILTER_REJECT;
          if (parent !== document.body) {
            if (parent.checkVisibility) {
              if (!parent.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return NodeFilter.FILTER_REJECT;
            } else if (parent.offsetParent === null && parent.offsetWidth === 0 && parent.offsetHeight === 0) {
              return NodeFilter.FILTER_REJECT;
            }
          }
          const text = node.textContent.trim();
          if (text.length < 2) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    let textNode;
    while ((textNode = walker.nextNode())) {
      const text = textNode.textContent;
      const parent = textNode.parentElement;
      const contextHint = _getElementContext(parent);

      const findings = scanText(text, contextHint);

      // Check for profile handle in text
      if (pageHandle && text.includes(pageHandle)) {
        const idx = text.indexOf(pageHandle);
        findings.push({
          type: 'USERNAME',
          value: pageHandle,
          start: idx,
          end: idx + pageHandle.length,
          severity: 'high',
          token: pageHandleToken || _generateToken('USERNAME'),
        });
      }

      // Check for display name in text
      if (pageDisplayName && text.includes(pageDisplayName)) {
        const idx = text.indexOf(pageDisplayName);
        findings.push({
          type: 'PERSON_NAME',
          value: pageDisplayName,
          start: idx,
          end: idx + pageDisplayName.length,
          severity: 'high',
          token: pageNameToken || _generateToken('PERSON_NAME'),
        });
      }

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

    // 3. Scan images, avatars, face pictures, and user media thumbnails
    const baseImages = Array.from(rootElement.querySelectorAll('img, svg[role="img"], canvas, [role="img"]'));
    const bgNodes = Array.from(rootElement.querySelectorAll('[style*="background-image"], [style*="background:"]'));
    // Deduplicate
    const imageSet = new Set([...baseImages, ...bgNodes]);
    const imageFindings = [];
    const AVATAR_REGEX = /\b(avatar|profile|profile[\s_-]?pic|profile[\s_-]?photo|profile[\s_-]?image|user[\s_-]?avatar|user[\s_-]?photo|headshot|portrait|selfie|face|author|creator|pfp|dp)\b/i;

    for (const el of imageSet) {
      if (el.checkVisibility) {
        if (!el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) continue;
      } else if (el.offsetParent === null && el !== document.body && !el.isConnected) {
        continue;
      }

      const rect = _getElementRect(el);
      const w = rect.width || el.naturalWidth || el.offsetWidth || el.clientWidth || 0;
      const h = rect.height || el.naturalHeight || el.offsetHeight || el.clientHeight || 0;
      if (w < 16 || h < 16) continue;
      rect.width = w;
      rect.height = h;

      const tag = el.tagName.toLowerCase();
      const alt = (el.getAttribute('alt') || '').toLowerCase();
      const cls = (el.className && typeof el.className === 'string' ? el.className : '').toLowerCase();
      const id = (el.id || '').toLowerCase();
      const src = (el.getAttribute('src') || el.src || '').toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const title = (el.getAttribute('title') || '').toLowerCase();
      const parentAria = (el.parentElement?.getAttribute('aria-label') || '').toLowerCase();
      const parentCls = (el.parentElement?.className && typeof el.parentElement.className === 'string' ? el.parentElement.className : '').toLowerCase();
      const styleAttr = (el.getAttribute('style') || '').toLowerCase();

      const combinedText = `${alt} ${cls} ${id} ${aria} ${title} ${parentAria} ${parentCls} ${src} ${styleAttr}`;

      let isFaceOrAvatar = AVATAR_REGEX.test(combinedText);

      // Check circular / avatar shape (common on modern web / social apps)
      if (!isFaceOrAvatar) {
        try {
          const compStyle = window.getComputedStyle(el);
          const bRadius = compStyle.borderRadius;
          const isCircular = bRadius === '50%' || parseFloat(bRadius) >= 16;
          const isSquareOrCircle = Math.abs(w - h) <= 16;
          if (isCircular && isSquareOrCircle && w >= 24 && w <= 360) {
            isFaceOrAvatar = true;
          }
        } catch {}
      }

      // Check social & profile page auto-shield
      // On social profile and feed pages, all user avatars, cards, and photos are faces/PII!
      if (!isFaceOrAvatar && isSocialOrProfilePage) {
        const isSystemSvg = tag === 'svg' && /direct|explore|search|home|message|settings|more|menu|heart|comment|share/i.test(combinedText);
        if (!isSystemSvg) {
          if (w >= 20 && h >= 20) {
            isFaceOrAvatar = true;
          }
        }
      }

      if (isFaceOrAvatar) {
        const token = _generateToken('FACE');
        imageFindings.push({
          type: 'FACE_IMAGE',
          severity: 'high',
          element: el,
          rect,
          source: 'image',
          src: src || '(dynamic image)',
          token,
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

    // Aggregate all findings and active tokens
    const allReplacements = [];
    for (const f of findings || []) {
      if (f.value && f.token && typeof f.value === 'string' && f.value.length >= 2) {
        if (!allReplacements.some(r => r.value === f.value)) {
          allReplacements.push({ value: f.value, token: f.token });
        }
      }
    }
    for (const [token, value] of Object.entries(_tokenMap || {})) {
      if (value && typeof value === 'string' && value.length >= 2) {
        if (!allReplacements.some(r => r.value === value)) {
          allReplacements.push({ value, token });
        }
      }
    }

    // Sort descending by value length so longer phrases replace first (e.g. "Yuvraj Rauniyar" before "Yuvraj")
    allReplacements.sort((a, b) => b.value.length - a.value.length);

    for (const element of sanitized.elements || []) {
      const fieldsToSanitize = ['text', 'value', 'placeholder', 'fieldLabel', 'ariaLabel', 'title', 'alt', 'href', 'selector'];
      for (const field of fieldsToSanitize) {
        if (typeof element[field] !== 'string' || !element[field]) continue;
        for (const rep of allReplacements) {
          if (element[field].includes(rep.value)) {
            element[field] = element[field].replaceAll(rep.value, rep.token);
          }
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
    if (parent && typeof parent.querySelector === 'function') {
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
    if (parent && typeof parent.querySelector === 'function') {
      const label = parent.querySelector('label');
      if (label && label.textContent) return label.textContent.trim();
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

    let result = text;

    // 1. Replace any known tokens already registered in _tokenMap
    for (const [tok, original] of Object.entries(_tokenMap)) {
      if (original && typeof original === 'string' && original.length > 2 && result.includes(original)) {
        result = result.replaceAll(original, tok);
      }
    }

    // 2. Scan for social profile URLs in instruction (e.g. "https://instagram.com/yuvraj_rauniyar15/")
    const URL_HANDLE_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:instagram\.com|twitter\.com|x\.com|github\.com|threads\.net|linkedin\.com\/in)\/([a-zA-Z0-9_.]{3,35})\/?/gi;
    let urlMatch;
    while ((urlMatch = URL_HANDLE_REGEX.exec(text)) !== null) {
      const handle = urlMatch[1];
      const reserved = ['explore', 'direct', 'reels', 'stories', 'accounts', 'p', 'reel'];
      if (!reserved.includes(handle.toLowerCase())) {
        let token = Object.keys(_tokenMap).find(k => _tokenMap[k] === handle);
        if (!token) {
          token = _generateToken('TARGET_USER');
          _tokenMap[token] = handle;
        }
        result = result.replaceAll(handle, token);
      }
    }

    // 3. Scan for target username/handle in natural language phrases
    // e.g. "send follow request to yuvraj_rauniyar15 from instagram"
    // e.g. "follow yuvraj_rauniyar15"
    // e.g. "visit profile of yuvraj_rauniyar15"
    const TARGET_REGEX = /(?:follow(?:ing)?|request to|send.*to|to|for|profile (?:of)?|user|account|message|dm|visit|open|view|target)\s+@?([a-zA-Z0-9_.]{3,35})\b/gi;
    let targetMatch;
    while ((targetMatch = TARGET_REGEX.exec(text)) !== null) {
      const username = targetMatch[1];
      const reservedWords = [
        'instagram', 'twitter', 'facebook', 'linkedin', 'github', 'amazon', 'google',
        'the', 'this', 'that', 'page', 'profile', 'user', 'site', 'website', 'account',
        'tab', 'browser', 'feed', 'post', 'story', 'reel', 'explore', 'home'
      ];
      if (!reservedWords.includes(username.toLowerCase())) {
        let token = Object.keys(_tokenMap).find(k => _tokenMap[k] === username);
        if (!token) {
          token = _generateToken('TARGET_USER');
          _tokenMap[token] = username;
        }
        result = result.replaceAll(username, token);
      }
    }

    // 4. Scan for @mentions (e.g. "@yuvraj_rauniyar15")
    const MENTION_REGEX = /@([a-zA-Z0-9_.]{3,35})\b/g;
    let mentionMatch;
    while ((mentionMatch = MENTION_REGEX.exec(text)) !== null) {
      const handle = mentionMatch[1];
      let token = Object.keys(_tokenMap).find(k => _tokenMap[k] === handle);
      if (!token) {
        token = _generateToken('TARGET_USER');
        _tokenMap[token] = handle;
      }
      result = result.replaceAll(`@${handle}`, token);
    }

    // 5. Run standard PII patterns (email, phone, credit card, social metrics, etc.)
    const findings = scanText(result);
    if (findings && findings.length > 0) {
      const sorted = [...findings].sort((a, b) => b.start - a.start);
      for (const f of sorted) {
        result = result.substring(0, f.start) + f.token + result.substring(f.end);
      }
    }

    return result;
  }

  // ── Public API ──────────────────────────────────────────────────────
  return {
    scanText,
    scanDOM,
    sanitizeDOMStructure,
    sanitizeInstruction,
    registerTokens,
    getTokenMap: () => ({ ..._tokenMap }),
    PII_PATTERNS,
  };
})();

// Make available to content script messaging
if (typeof window !== 'undefined') {
  window.PIIScanner = PIIScanner;
}
