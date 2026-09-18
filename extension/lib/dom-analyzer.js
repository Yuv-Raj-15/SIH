/**
 * DOM Analyzer — Extracts a structured, semantic representation of the visible DOM.
 * Produces a JSON "screen description" that can be sent to the server VLM for reasoning.
 * All PII in the output should be sanitized by PIIScanner before transmission.
 */

// eslint-disable-next-line no-var
var DOMAnalyzer = (() => {
  'use strict';

  // Interactive element selectors
  const INTERACTIVE_SELECTORS = [
    'a[href]', 'button', 'input', 'textarea', 'select',
    '[role="button"]', '[role="link"]', '[role="checkbox"]',
    '[role="radio"]', '[role="tab"]', '[role="menuitem"]',
    '[role="textbox"]', '[role="combobox"]', '[role="searchbox"]', '[role="option"]',
    '[contenteditable="true"]', '[contenteditable=""]', '[contenteditable]',
    '[onclick]', '[tabindex]:not([tabindex="-1"])',
    '[aria-label]', '[title]',
    '.monaco-editor', '.ace_editor', '[data-track-load="code_editor"]', '[data-e2e-locator]'
  ].join(', ');

  // Elements to skip
  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'svg', 'path', 'meta', 'link', 'br', 'hr',
  ]);

  /**
   * Analyze the current page DOM and return a structured description.
   * @param {Element} [root=document.body]
   * @returns {object} The structured DOM analysis
   */
  function analyze(root = document.body) {
    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      totalHeight: document.documentElement.scrollHeight,
      totalWidth: document.documentElement.scrollWidth,
    };

    const pageInfo = {
      url: window.location.href,
      title: document.title,
      domain: window.location.hostname,
    };

    const elements = [];
    let elementIndex = 0;

    // 1. Collect all interactive elements
    const interactiveEls = root.querySelectorAll(INTERACTIVE_SELECTORS);
    for (const el of interactiveEls) {
      if (!_isVisible(el)) continue;
      const info = _extractElementInfo(el, elementIndex);
      if (info) {
        info._node = el;
        elements.push(info);
        elementIndex++;
      }
    }

    // 2. Collect visible text blocks (headings, paragraphs, labels)
    const textSelectors = 'h1, h2, h3, h4, h5, h6, p, label, span, td, th, li, figcaption, legend';
    const textEls = root.querySelectorAll(textSelectors);
    for (const el of textEls) {
      if (!_isVisible(el)) continue;
      // Skip if already captured as interactive
      if (el.matches(INTERACTIVE_SELECTORS)) continue;

      const text = _getDirectText(el).trim();
      if (text.length < 2 || text.length > 500) continue;

      const rect = el.getBoundingClientRect();
      elements.push({
        _node: el,
        index: elementIndex,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || _inferRole(el),
        text: text,
        rect: _serializeRect(rect),
        selector: _buildSelector(el),
        type: 'text',
      });
      elementIndex++;
    }

    // 3. Collect images
    const images = root.querySelectorAll('img[src]');
    for (const img of images) {
      if (!_isVisible(img)) continue;
      const rect = img.getBoundingClientRect();
      elements.push({
        _node: img,
        index: elementIndex,
        tag: 'img',
        role: 'image',
        alt: img.alt || '',
        src: img.src,
        rect: _serializeRect(rect),
        selector: _buildSelector(img),
        type: 'image',
      });
      elementIndex++;
    }

    // Sort elements by visual position (top-to-bottom, left-to-right)
    elements.sort((a, b) => {
      const dy = a.rect.y - b.rect.y;
      if (Math.abs(dy) > 10) return dy;
      return a.rect.x - b.rect.x;
    });

    // Re-index after sorting
    elements.forEach((el, i) => { 
      el.index = i; 
      if (el._node) {
        el._node.setAttribute('data-pv-index', i);
        delete el._node;
      }
    });

    return {
      pageInfo,
      viewport,
      elements,
      elementCount: elements.length,
      timestamp: Date.now(),
    };
  }

  /**
   * Generate a concise text summary of the page for the VLM prompt.
   * @param {object} analysis - Output from analyze()
   * @returns {string}
   */
  function generateTextSummary(analysis) {
    const lines = [];
    lines.push(`Page: ${analysis.pageInfo.title} (${analysis.pageInfo.domain})`);
    lines.push(`Viewport: ${analysis.viewport.width}x${analysis.viewport.height}`);
    lines.push(`Scroll: ${analysis.viewport.scrollY}/${analysis.viewport.totalHeight}`);
    lines.push(`Elements: ${analysis.elementCount}`);
    lines.push('---');

    for (const el of analysis.elements) {
      const parts = [`[${el.index}]`];
      parts.push(`<${el.tag}>`);
      if (el.role && el.role !== el.tag) parts.push(`(${el.role})`);
      if (el.id) parts.push(`id="${el.id}"`);
      if (el.name) parts.push(`name="${el.name}"`);
      if (el.ariaLabel) parts.push(`aria="${el.ariaLabel.substring(0, 60)}"`);
      if (el.title) parts.push(`title="${el.title.substring(0, 40)}"`);
      if (el.text) parts.push(`"${el.text.substring(0, 80)}"`);
      if (el.value) parts.push(`value="${el.value.substring(0, 40)}"`);
      if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
      if (el.fieldLabel) parts.push(`label="${el.fieldLabel}"`);
      if (el.href) parts.push(`href="${el.href}"`);
      if (el.disabled) parts.push('[disabled]');
      if (el.isContentEditable) parts.push('[contenteditable]');
      if (el.selector) parts.push(`sel="${el.selector}"`);
      parts.push(`@(${el.rect.x},${el.rect.y},${el.rect.width}x${el.rect.height})`);
      lines.push(parts.join(' '));
    }

    return lines.join('\n');
  }

  // ── Internal helpers ────────────────────────────────────────────────

  function _extractElementInfo(el, index) {
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return null;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;

    const isEditable = el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '';

    const info = {
      index,
      tag,
      role: el.getAttribute('role') || _inferRole(el),
      text: _getDirectText(el).trim().substring(0, 200),
      rect: _serializeRect(rect),
      selector: _buildSelector(el),
      type: 'interactive',
      id: el.id || '',
      isContentEditable: isEditable,
    };

    // Input-specific attributes
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || isEditable || info.role === 'textbox' || info.role === 'combobox') {
      info.inputType = isEditable ? 'contenteditable' : (el.type || 'text');
      info.name = el.name || el.getAttribute('name') || '';
      info.value = el.type === 'password' ? '••••••••' : (el.value || el.innerText || '');
      info.placeholder = el.placeholder || el.getAttribute('placeholder') || '';
      info.disabled = el.disabled;
      info.required = el.required;
      info.fieldLabel = _getAssociatedLabel(el);
    }

    // Button/link specific
    if (tag === 'a') {
      info.href = el.href || '';
    }
    if (tag === 'button' || el.getAttribute('role') === 'button') {
      info.disabled = el.disabled;
    }

    // ARIA & semantic attributes
    const ariaLabel = el.getAttribute('aria-label') || el.getAttribute('aria-description');
    if (ariaLabel) info.ariaLabel = ariaLabel.trim();
    const title = el.getAttribute('title');
    if (title) info.title = title.trim();

    return info;
  }

  function _isVisible(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el === document.body || el.tagName === 'HTML') return true;

    // Disconnected from live DOM
    if (!el.isConnected) return false;

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
      return false;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;

    // NOTE: In Chromium/Blink, element.offsetParent is ALWAYS null for elements with position: fixed!
    // Gmail Compose dialog, modals, popovers, and floating toolbars use position: fixed.
    // If the element has positive width & height and is not display:none/visibility:hidden, it is visible.
    return true;
  }

  function _getDirectText(el) {
    // Get text directly owned by this element (not deep children)
    let text = '';
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.textContent;
      }
    }
    // Fallback to innerText if no direct text
    if (!text.trim() && el.innerText) {
      text = el.innerText.substring(0, 200);
    }
    return text;
  }

  function _inferRole(el) {
    const tag = el.tagName.toLowerCase();
    if (el.classList.contains('monaco-editor') || el.closest('.monaco-editor') || el.hasAttribute('data-track-load')) {
      return 'code-editor';
    }
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      if (type === 'submit') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) return 'heading';
    if (tag === 'p') return 'paragraph';
    if (tag === 'label') return 'label';
    if (tag === 'img') return 'image';
    if (tag === 'table') return 'table';
    return tag;
  }

  function _serializeRect(rect) {
    return {
      x: Math.round(rect.x + window.scrollX),
      y: Math.round(rect.y + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }

  function _buildSelector(el) {
    // 1. Data-e2e-locator (e.g. LeetCode buttons)
    if (el.hasAttribute('data-e2e-locator')) {
      return `${el.tagName.toLowerCase()}[data-e2e-locator="${el.getAttribute('data-e2e-locator')}"]`;
    }
    if (el.hasAttribute('data-cy')) {
      return `${el.tagName.toLowerCase()}[data-cy="${el.getAttribute('data-cy')}"]`;
    }
    if (el.classList.contains('monaco-editor')) {
      return '.monaco-editor';
    }

    if (el.id) {
      if (typeof CSS !== 'undefined' && CSS.escape) {
        return '#' + CSS.escape(el.id);
      }
      return `[id="${el.id.replace(/"/g, '\\"')}"]`;
    }

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.length < 50) {
      return `${el.tagName.toLowerCase()}[aria-label="${ariaLabel.replace(/"/g, '\\"')}"]`;
    }

    const parts = [];
    let current = el;
    let depth = 0;
    while (current && current !== document.body && depth < 5) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        selector = (typeof CSS !== 'undefined' && CSS.escape)
          ? '#' + CSS.escape(current.id)
          : `[id="${current.id.replace(/"/g, '\\"')}"]`;
        parts.unshift(selector);
        break;
      }
      if (current.name) {
        selector += `[name="${current.name}"]`;
      }
      if (current.className && typeof current.className === 'string') {
        const cls = current.className.trim().split(/\s+/)
          .filter((c) => c && !c.startsWith('pv-') && !c.includes(':'))[0];
        if (cls && typeof CSS !== 'undefined' && CSS.escape) {
          selector += `.${CSS.escape(cls)}`;
        }
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((s) => s.tagName === current.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          selector += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(selector);
      current = current.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  function _getAssociatedLabel(input) {
    if (input.id) {
      const label = document.querySelector(`label[for="${input.id}"]`);
      if (label) return label.textContent.trim();
    }
    const parentLabel = input.closest('label');
    if (parentLabel) return parentLabel.textContent.trim();
    const prev = input.previousElementSibling;
    if (prev && prev.tagName === 'LABEL') return prev.textContent.trim();
    const parent = input.parentElement;
    if (parent) {
      const label = parent.querySelector('label');
      if (label) return label.textContent.trim();
    }
    return '';
  }

  /**
   * Generate a structured JSON summary of the page for AI-2 selector picking.
   * Produces a machine-readable DOM map with indexed, selector-addressable elements.
   * This is sent as `dom_structured` alongside the text summary.
   * @param {object} analysis - Output from analyze()
   * @returns {object} Structured DOM summary
   */
  function generateStructuredSummary(analysis) {
    const interactive = [];
    const textBlocks = [];

    // Page type hinting — classify the page to help AI-1 skip unnecessary reasoning
    const url = (analysis.pageInfo?.url || '').toLowerCase();
    const title = (analysis.pageInfo?.title || '').toLowerCase();
    let pageTypeHint = 'general';
    if (/login|signin|sign-in|auth|authenticate/i.test(url + title)) pageTypeHint = 'login_form';
    else if (/checkout|cart|payment|pay|billing/i.test(url + title)) pageTypeHint = 'checkout_form';
    else if (/search\?|q=|query=/i.test(url)) pageTypeHint = 'search_results';
    else if (/register|signup|sign-up|create.*account/i.test(url + title)) pageTypeHint = 'registration_form';
    else if (/profile|user\//i.test(url)) pageTypeHint = 'profile_page';
    else if (/feed|home|dashboard/i.test(url)) pageTypeHint = 'feed_page';

    for (const el of (analysis.elements || [])) {
      if (el.type === 'text') {
        // Collect visible text blocks for page state context
        const t = (el.text || '').trim();
        if (t.length > 1 && t.length < 200) {
          textBlocks.push(t);
        }
        continue;
      }
      if (el.type === 'image') continue;

      // Interactive element — emit compact descriptor
      const entry = {
        idx: el.index,
        tag: el.tag,
        sel: el.selector || '',
      };
      if (el.role && el.role !== el.tag && el.role !== 'generic') entry.role = el.role;
      if (el.inputType && el.inputType !== 'text' && el.inputType !== el.tag) entry.type = el.inputType;
      if (el.text) entry.text = el.text.substring(0, 80);
      if (el.placeholder) entry.placeholder = el.placeholder.substring(0, 60);
      if (el.ariaLabel) entry.ariaLabel = el.ariaLabel.substring(0, 60);
      if (el.fieldLabel) entry.fieldLabel = el.fieldLabel.substring(0, 50);
      if (el.href) entry.href = el.href.substring(0, 120);
      if (el.value && el.tag !== 'input') entry.value = el.value.substring(0, 40);
      if (el.disabled) entry.disabled = true;
      if (el.required) entry.required = true;
      interactive.push(entry);
    }

    return {
      url: analysis.pageInfo?.url || '',
      title: analysis.pageInfo?.title || '',
      domain: analysis.pageInfo?.domain || '',
      page_type_hint: pageTypeHint,
      scroll_y: analysis.viewport?.scrollY || 0,
      total_height: analysis.viewport?.totalHeight || 0,
      interactive,
      text_blocks: textBlocks.slice(0, 30),
      element_count: analysis.elementCount || 0,
    };
  }

  return { analyze, generateTextSummary, generateStructuredSummary };
})();

if (typeof window !== 'undefined') {
  window.DOMAnalyzer = DOMAnalyzer;
}
