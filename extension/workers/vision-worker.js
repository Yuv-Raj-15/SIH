/**
 * Vision Worker — Runs ML inference in a Web Worker to avoid blocking UI.
 * Uses Transformers.js (ONNX Runtime Web) for face/object detection.
 * 
 * Supports WebGPU acceleration with automatic WASM fallback.
 * 
 * NOTE: This worker requires @huggingface/transformers to be available.
 * For a Chrome extension, the library must be bundled or loaded from CDN.
 * In development, we use the CDN approach. For production, bundle with webpack/rollup.
 */

// Import Transformers.js from CDN (works in Web Workers)
importScripts('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.1/dist/transformers.min.js');

// Access the Transformers module
const { pipeline, env } = self.TransformersApi || {};

// Configure: disable local model storage (use cache API)
if (env) {
  env.allowLocalModels = false;
  env.useBrowserCache = true;
}

// ── State ────────────────────────────────────────────────────────────
let objectDetector = null;
let isLoading = false;
let modelReady = false;

// ── Message handler ──────────────────────────────────────────────────
self.onmessage = async function (event) {
  const { type, payload, id } = event.data;

  try {
    switch (type) {
      case 'LOAD_MODEL':
        await loadModel(payload);
        self.postMessage({ id, type: 'MODEL_LOADED', success: true });
        break;

      case 'DETECT_OBJECTS':
        const detections = await detectObjects(payload);
        self.postMessage({ id, type: 'DETECTION_RESULT', success: true, data: detections });
        break;

      case 'GET_STATUS':
        self.postMessage({
          id,
          type: 'STATUS',
          data: { modelReady, isLoading },
        });
        break;

      default:
        self.postMessage({ id, type: 'ERROR', error: `Unknown message type: ${type}` });
    }
  } catch (err) {
    self.postMessage({ id, type: 'ERROR', error: err.message });
  }
};

// ── Model loading ────────────────────────────────────────────────────

async function loadModel(options = {}) {
  if (modelReady || isLoading) return;
  isLoading = true;

  const modelId = options.model || 'Xenova/detr-resnet-50';

  self.postMessage({ type: 'PROGRESS', message: `Loading model: ${modelId}...` });

  try {
    objectDetector = await pipeline('object-detection', modelId, {
      // Prefer WebGPU, fallback to WASM
      device: options.device || 'wasm',
      dtype: options.dtype || 'fp32',
      progress_callback: (progress) => {
        if (progress.status === 'progress') {
          self.postMessage({
            type: 'PROGRESS',
            message: `Downloading: ${progress.file} (${Math.round(progress.progress || 0)}%)`,
          });
        }
      },
    });

    modelReady = true;
    self.postMessage({ type: 'PROGRESS', message: 'Model loaded successfully!' });
  } catch (err) {
    self.postMessage({ type: 'PROGRESS', message: `Model load failed: ${err.message}` });
    throw err;
  } finally {
    isLoading = false;
  }
}

// ── Object detection ─────────────────────────────────────────────────

async function detectObjects(payload) {
  const { imageDataUrl, threshold = 0.7 } = payload;

  if (!modelReady || !objectDetector) {
    // Auto-load if not ready
    await loadModel();
  }

  // Run detection
  const results = await objectDetector(imageDataUrl, {
    threshold,
    percentage: true, // Return bounding boxes as percentages
  });

  // Filter and format results
  const detections = results.map((det) => ({
    label: det.label,
    score: Math.round(det.score * 100) / 100,
    box: {
      // Convert percentage to pixel coordinates (will be multiplied by image dimensions on the caller side)
      xmin: det.box.xmin,
      ymin: det.box.ymin,
      xmax: det.box.xmax,
      ymax: det.box.ymax,
    },
  }));

  // Identify privacy-sensitive detections
  const sensitiveLabels = ['person', 'face', 'cell phone', 'laptop', 'tv', 'monitor'];
  const privacyDetections = detections.filter((d) =>
    sensitiveLabels.some((label) => d.label.toLowerCase().includes(label))
  );

  return {
    allDetections: detections,
    privacyDetections,
    totalCount: detections.length,
    privacyCount: privacyDetections.length,
  };
}

self.postMessage({ type: 'READY', message: 'Vision worker initialized' });
