/**
 * Offscreen Document Script — Handles canvas-based redaction requests
 * from the background service worker.
 */

// Listen for messages from the service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'REDACT_IMAGE') {
    handleRedaction(message.payload)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // Keep the message channel open for async response
  }
});

/**
 * Perform redaction on the screenshot.
 * @param {object} payload - {imageDataUrl, regions, options}
 */
async function handleRedaction(payload) {
  const { imageDataUrl, regions, options } = payload;

  if (!imageDataUrl) throw new Error('No image provided for redaction');
  if (!regions || regions.length === 0) {
    return { sanitizedImage: imageDataUrl, manifest: { redactions: [], imageWidth: 0, imageHeight: 0 } };
  }

  // Use the RedactionEngine loaded from the script tag
  const result = await RedactionEngine.redact(imageDataUrl, regions, options || {});
  return result;
}

console.log('[PrivacyVision] Offscreen document ready');
