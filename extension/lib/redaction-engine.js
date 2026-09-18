/**
 * Redaction Engine — Canvas-based visual redaction of sensitive content.
 * Takes a screenshot image and a list of redaction regions, produces a sanitized image.
 * Designed to run in the offscreen document (which has Canvas API access).
 */

// eslint-disable-next-line no-var
var RedactionEngine = (() => {
  'use strict';

  /**
   * Apply redactions to a screenshot image.
   * @param {string} imageDataUrl - Base64 data URL of the screenshot
   * @param {Array<object>} regions - Regions to redact [{x, y, width, height, type, method, label}]
   * @param {object} [options] - Redaction options
   * @returns {Promise<{sanitizedImage: string, manifest: object}>}
   */
  async function redact(imageDataUrl, regions, options = {}) {
    const {
      blurRadius = 20,
      overlayColor = '#000000',
      labelFont = '11px Inter, sans-serif',
      labelColor = '#ffffff',
      labelBgColor = 'rgba(248, 113, 113, 0.85)',
      drawLabels = true,
      quality = 0.55,
      maxWidth = 800,
    } = options;

    // Load the image
    const img = await _loadImage(imageDataUrl);

    // Downscale if width exceeds maxWidth to keep VLM inference fast (<20s)
    let targetWidth = img.width;
    let targetHeight = img.height;
    let scale = 1.0;
    if (img.width > maxWidth) {
      scale = maxWidth / img.width;
      targetWidth = Math.round(img.width * scale);
      targetHeight = Math.round(img.height * scale);
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');

    // Draw original image (scaled)
    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

    // Build redaction manifest
    const manifest = {
      imageWidth: targetWidth,
      imageHeight: targetHeight,
      redactions: [],
      timestamp: Date.now(),
    };

    // Apply each redaction
    for (const region of regions) {
      const method = region.method || _defaultMethod(region.type);
      const rx = Math.max(0, Math.round(region.x * scale));
      const ry = Math.max(0, Math.round(region.y * scale));
      const rw = Math.min(targetWidth - rx, Math.round(region.width * scale));
      const rh = Math.min(targetHeight - ry, Math.round(region.height * scale));

      if (rw <= 0 || rh <= 0) continue;

      switch (method) {
        case 'blur':
          _applyBlur(ctx, rx, ry, rw, rh, blurRadius);
          break;
        case 'blackout':
          _applyBlackout(ctx, rx, ry, rw, rh, overlayColor);
          break;
        case 'pixelate':
          _applyPixelate(ctx, rx, ry, rw, rh);
          break;
        case 'noise':
          _applyNoise(ctx, rx, ry, rw, rh);
          break;
        case 'colorblock':
          _applyColorBlock(ctx, rx, ry, rw, rh, region.color || '#1e293b');
          break;
        default:
          _applyBlackout(ctx, rx, ry, rw, rh, overlayColor);
      }

      // Draw label badge
      if (drawLabels && region.label) {
        const isFace = method === 'blur' || region.type === 'FACE_IMAGE' || region.type === 'FACE';
        const badgeBg = isFace ? '#15803d' : labelBgColor;
        const badgeText = isFace ? '🛡️ FACE MASKED' : region.label;
        _drawLabel(ctx, rx, ry, badgeText, labelFont, labelColor, badgeBg);
      }

      // Record in manifest
      manifest.redactions.push({
        region: { x: rx, y: ry, width: rw, height: rh },
        type: region.type,
        method,
        token: region.token || null,
        label: region.label || region.type,
      });
    }

    // Export sanitized image
    const sanitizedImage = canvas.toDataURL('image/jpeg', quality);

    return { sanitizedImage, manifest };
  }

  // ── Redaction methods ───────────────────────────────────────────────

  function _applyBlur(ctx, x, y, w, h, radius) {
    if (w <= 2 || h <= 2) return;

    try {
      // 1. Irreversible downsample-upsample blur
      const factor = 0.08; // 8% resolution
      const sw = Math.max(2, Math.floor(w * factor));
      const sh = Math.max(2, Math.floor(h * factor));

      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = sw;
      tempCanvas.height = sh;
      const tempCtx = tempCanvas.getContext('2d');
      tempCtx.imageSmoothingEnabled = true;

      // Draw region downscaled
      tempCtx.drawImage(ctx.canvas, x, y, w, h, 0, 0, sw, sh);

      // Draw back upscaled with smoothing to produce Gaussian-like diffusion
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(tempCanvas, 0, 0, sw, sh, x, y, w, h);

      // 2. Add an airtight privacy tint overlay
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.fillRect(x, y, w, h);

      // 3. Draw high-visibility Emerald Green Privacy Shield border
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]); // Reset line dash

      // 4. Draw central shield watermark emblem if region is large enough
      if (w >= 36 && h >= 36) {
        const fontSize = Math.min(24, Math.max(12, Math.floor(Math.min(w, h) * 0.32)));
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('🛡️', x + w / 2, y + h / 2);
      }

      ctx.restore();
    } catch {
      // Fallback: solid pitch-black cover if canvas operations fail
      _applyBlackout(ctx, x, y, w, h, '#000000');
    }
  }

  function _applyBlackout(ctx, x, y, w, h, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }

  function _applyPixelate(ctx, x, y, w, h) {
    const pixelSize = Math.max(8, Math.min(w, h) / 6);
    const imgData = ctx.getImageData(x, y, w, h);

    for (let py = 0; py < h; py += pixelSize) {
      for (let px = 0; px < w; px += pixelSize) {
        // Sample center pixel of each block
        const cx = Math.min(Math.floor(px + pixelSize / 2), w - 1);
        const cy = Math.min(Math.floor(py + pixelSize / 2), h - 1);
        const idx = (cy * w + cx) * 4;
        const r = imgData.data[idx], g = imgData.data[idx + 1],
          b = imgData.data[idx + 2], a = imgData.data[idx + 3];

        ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
        ctx.fillRect(x + px, y + py, pixelSize, pixelSize);
      }
    }
  }

  function _applyNoise(ctx, x, y, w, h) {
    const imageData = ctx.getImageData(x, y, w, h);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = Math.random() * 255;
      data[i + 1] = Math.random() * 255;
      data[i + 2] = Math.random() * 255;
      // Keep alpha
    }
    ctx.putImageData(imageData, x, y);
  }

  function _applyColorBlock(ctx, x, y, w, h, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
    // Draw a diagonal pattern to indicate redaction
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    for (let i = -h; i < w; i += 12) {
      ctx.beginPath();
      ctx.moveTo(x + i, y);
      ctx.lineTo(x + i + h, y + h);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── Label drawing ───────────────────────────────────────────────────

  function _drawLabel(ctx, x, y, text, font, textColor, bgColor) {
    ctx.save();
    ctx.font = font;
    const metrics = ctx.measureText(text);
    const padding = 4;
    const labelW = metrics.width + padding * 2;
    const labelH = 16;
    const labelY = Math.max(0, y - labelH - 2);

    ctx.fillStyle = bgColor;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, labelY, labelW, labelH, 3);
    } else {
      ctx.rect(x, labelY, labelW, labelH);
    }
    ctx.fill();

    ctx.fillStyle = textColor;
    ctx.fillText(text, x + padding, labelY + 12);
    ctx.restore();
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  function _loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  function _defaultMethod(piiType) {
    switch (piiType) {
      case 'FACE_IMAGE':
      case 'FACE':
      case 'AVATAR':
      case 'PROFILE_IMAGE':
        return 'blur';
      case 'PASSWORD':
      case 'PIN':
      case 'CREDIT_CARD':
      case 'AADHAAR':
      case 'SSN':
      case 'PAN':
      case 'PASSPORT':
      case 'ACCOUNT_NUMBER':
      case 'USERNAME':
      case 'PERSON_NAME':
      case 'SOCIAL_METRIC':
        return 'blackout';
      case 'EMAIL':
      case 'PHONE':
      case 'UPI_ID':
      case 'PERSONAL_URL':
        return 'colorblock';
      default:
        return 'blackout';
    }
  }

  return { redact };
})();

if (typeof self !== 'undefined') {
  self.RedactionEngine = RedactionEngine;
}
