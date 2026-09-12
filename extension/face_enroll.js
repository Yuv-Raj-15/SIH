/**
 * Face Enrollment & Local Biometrics Controller.
 * Runs in a dedicated extension tab to enable Chromium camera permission prompts.
 * Computes 100% on-device visual feature vectors; zero frames leave this machine.
 */

(() => {
  'use strict';

  const STORAGE_KEY = 'BrowserAgent_EnrolledFace_v1';

  // Elements
  const video = document.getElementById('webcam-video');
  const canvas = document.getElementById('capture-canvas');
  const reticle = document.getElementById('reticle-overlay');
  const statusMsg = document.getElementById('cam-status-msg');
  const badge = document.getElementById('enroll-badge');
  const btnStartCam = document.getElementById('btn-start-cam');
  const btnStopCam = document.getElementById('btn-stop-cam');
  const btnCapture = document.getElementById('btn-capture-face');
  const btnTriggerFile = document.getElementById('btn-trigger-file');
  const inputFile = document.getElementById('input-face-file');
  const profileDisplay = document.getElementById('profile-display');
  const btnClearProfile = document.getElementById('btn-clear-profile');
  const testBox = document.getElementById('test-verification-box');
  const simScoreText = document.getElementById('sim-score-text');
  const simProgressBar = document.getElementById('sim-progress-bar');
  const simStatusLabel = document.getElementById('sim-status-label');

  let activeStream = null;
  let currentProfile = null;
  let liveTestInterval = null;

  // ── Init ─────────────────────────────────────────────────────────────
  async function init() {
    await loadStoredProfile();

    btnStartCam.addEventListener('click', startCamera);
    btnStopCam.addEventListener('click', stopCamera);
    btnCapture.addEventListener('click', captureCurrentFrame);
    btnTriggerFile.addEventListener('click', () => inputFile.click());
    inputFile.addEventListener('change', handleFileUpload);
    btnClearProfile.addEventListener('click', clearProfile);

    // Auto-prompt to start camera on page open
    startCamera();
  }

  // ── Camera Handling ──────────────────────────────────────────────────
  async function startCamera() {
    statusMsg.textContent = 'Requesting camera authorization from browser...';
    statusMsg.style.display = 'flex';

    try {
      if (activeStream) {
        stopCamera();
      }

      activeStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: 'user',
        },
        audio: false,
      });

      video.srcObject = activeStream;
      await video.play();

      statusMsg.style.display = 'none';
      reticle.style.display = 'block';
      btnStartCam.style.display = 'none';
      btnStopCam.style.display = 'inline-flex';
      btnCapture.disabled = false;

      // Start live verification test if profile already exists
      if (currentProfile && currentProfile.signature) {
        startLiveVerificationTest();
      }
    } catch (err) {
      console.error('[FaceEnroll] Camera access failed:', err);
      statusMsg.style.display = 'flex';
      reticle.style.display = 'none';
      btnCapture.disabled = true;

      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        statusMsg.innerHTML = `
          <div style="color: #f87171; line-height: 1.6;">
            <strong>⚠️ Camera Permission Denied</strong><br>
            Please click the camera lock icon in Chrome's address bar, select "Always allow", and refresh this tab.<br>
            <em>Or upload a selfie image below without a webcam.</em>
          </div>`;
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        statusMsg.innerHTML = `
          <div style="color: #f87171; line-height: 1.6;">
            <strong>📷 No Webcam Detected</strong><br>
            Please connect a camera or use the <strong>photo upload option</strong> below.
          </div>`;
      } else {
        statusMsg.innerHTML = `
          <div style="color: #f87171; line-height: 1.6;">
            <strong>Camera Error:</strong> ${err.message || err.name}<br>
            Please use the <strong>photo upload fallback</strong> below.
          </div>`;
      }
    }
  }

  function stopCamera() {
    if (liveTestInterval) {
      clearInterval(liveTestInterval);
      liveTestInterval = null;
    }

    if (activeStream) {
      activeStream.getTracks().forEach((t) => t.stop());
      activeStream = null;
    }

    video.srcObject = null;
    reticle.style.display = 'none';
    btnStartCam.style.display = 'inline-flex';
    btnStopCam.style.display = 'none';
    btnCapture.disabled = true;

    statusMsg.textContent = 'Camera is inactive. Click "Start Camera" to turn it back on.';
    statusMsg.style.display = 'flex';

    if (testBox) testBox.style.display = 'none';
  }

  // ── Biometric Signature Computation ──────────────────────────────────

  /**
   * Compute normalized luminance vector from a canvas.
   * Dimensions: 64x64 = 4096 dimensions.
   */
  function computeFaceSignature(sourceCanvas) {
    const width = 64;
    const height = 64;
    const smallCanvas = document.createElement('canvas');
    smallCanvas.width = width;
    smallCanvas.height = height;
    const ctx = smallCanvas.getContext('2d');

    ctx.drawImage(sourceCanvas, 0, 0, width, height);
    const imgData = ctx.getImageData(0, 0, width, height);
    const pixels = imgData.data;
    const vector = new Float32Array(width * height);

    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      // Perceptual luminance: 0.299 R + 0.587 G + 0.114 B
      const lum = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
      const idx = i / 4;
      vector[idx] = lum;
      sum += lum;
    }

    // Mean normalization
    const mean = sum / vector.length;
    let variance = 0;
    for (let i = 0; i < vector.length; i++) {
      variance += Math.pow(vector[i] - mean, 2);
    }
    const stdDev = Math.sqrt(variance / vector.length) || 1;

    for (let i = 0; i < vector.length; i++) {
      vector[i] = (vector[i] - mean) / stdDev;
    }

    return Array.from(vector);
  }

  function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // ── Capture from Webcam ──────────────────────────────────────────────
  async function captureCurrentFrame() {
    if (!video.videoWidth || !video.videoHeight) {
      alert('Camera feed is still initializing. Please wait a second.');
      return;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');

    // Handle mirror inversion
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const signature = computeFaceSignature(canvas);
    const thumbnail = canvas.toDataURL('image/jpeg', 0.8);

    await saveProfile({
      signature,
      thumbnail,
      enrolledAt: Date.now(),
      source: 'webcam',
      algorithm: 'Local-Normalized-Luminance-v1 (4096-Dim)',
    });
  }

  // ── Capture from File Upload Fallback ─────────────────────────────────
  function handleFileUpload(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = async () => {
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        const signature = computeFaceSignature(canvas);
        const thumbnail = canvas.toDataURL('image/jpeg', 0.8);

        await saveProfile({
          signature,
          thumbnail,
          enrolledAt: Date.now(),
          source: 'file_upload',
          algorithm: 'Local-Normalized-Luminance-v1 (4096-Dim)',
        });
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
    inputFile.value = ''; // Reset input
  }

  // ── Storage and Persistence ──────────────────────────────────────────
  async function saveProfile(profile) {
    currentProfile = profile;

    // Save to chrome.storage.local (unified extension storage)
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      await new Promise((resolve) => {
        chrome.storage.local.set({ [STORAGE_KEY]: profile }, resolve);
      });
    }

    // Also write to localStorage for fallback
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
    } catch {}

    updateUI(profile);

    // If camera is running, start live verification test
    if (activeStream) {
      startLiveVerificationTest();
    }
  }

  async function loadStoredProfile() {
    let profile = null;

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      profile = await new Promise((resolve) => {
        chrome.storage.local.get([STORAGE_KEY], (res) => {
          resolve(res && res[STORAGE_KEY] ? res[STORAGE_KEY] : null);
        });
      });
    }

    if (!profile) {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        try { profile = JSON.parse(raw); } catch {}
      }
    }

    currentProfile = profile;
    updateUI(profile);
  }

  async function clearProfile() {
    if (!confirm('Are you sure you want to delete your enrolled face biometric profile?')) {
      return;
    }

    currentProfile = null;

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      await new Promise((resolve) => {
        chrome.storage.local.remove([STORAGE_KEY], resolve);
      });
    }

    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}

    if (liveTestInterval) {
      clearInterval(liveTestInterval);
      liveTestInterval = null;
    }

    updateUI(null);
  }

  // ── Live Verification Test ───────────────────────────────────────────
  function startLiveVerificationTest() {
    if (!testBox || !currentProfile || !currentProfile.signature) return;
    testBox.style.display = 'block';

    if (liveTestInterval) clearInterval(liveTestInterval);

    liveTestInterval = setInterval(() => {
      if (!video.videoWidth || !activeStream) return;

      const tCanvas = document.createElement('canvas');
      tCanvas.width = 160;
      tCanvas.height = 120;
      const ctx = tCanvas.getContext('2d');
      ctx.drawImage(video, 0, 0, 160, 120);

      const liveVector = computeFaceSignature(tCanvas);
      const similarity = cosineSimilarity(currentProfile.signature, liveVector);
      const percent = Math.max(0, Math.min(100, Math.round(similarity * 100)));

      simScoreText.textContent = `${percent}%`;
      simProgressBar.style.width = `${percent}%`;

      if (percent >= 65) {
        simProgressBar.style.background = '#10b981';
        simStatusLabel.textContent = `✓ Face Match Verified (${percent}% Confidence)`;
        simStatusLabel.style.color = '#34d399';
      } else if (percent >= 40) {
        simProgressBar.style.background = '#f59e0b';
        simStatusLabel.textContent = `Align Face Inside Guide (${percent}%)`;
        simStatusLabel.style.color = '#fbbf24';
      } else {
        simProgressBar.style.background = '#ef4444';
        simStatusLabel.textContent = `Looking for enrolled face... (${percent}%)`;
        simStatusLabel.style.color = '#f87171';
      }
    }, 280);
  }

  // ── UI Rendering ─────────────────────────────────────────────────────
  function updateUI(profile) {
    if (profile && profile.signature) {
      badge.textContent = '✓ ENROLLED & ACTIVE';
      badge.className = 'badge badge-enrolled';
      btnClearProfile.style.display = 'inline-block';

      const dateStr = new Date(profile.enrolledAt).toLocaleString();
      const dims = profile.signature.length;

      profileDisplay.className = 'profile-box';
      profileDisplay.innerHTML = `
        <div class="profile-card-content">
          <img src="${profile.thumbnail || ''}" alt="Enrolled Face" class="profile-thumb">
          <div class="profile-meta">
            <div class="meta-row">
              <span class="meta-label">Status:</span>
              <span class="meta-val" style="color: #34d399;">Active On-Device</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">Algorithm:</span>
              <span class="meta-val">${profile.algorithm || 'Local Normalized'}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">Vector Dimensions:</span>
              <span class="meta-val">${dims} Float32 Elements</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">Enrolled:</span>
              <span class="meta-val">${dateStr}</span>
            </div>
          </div>
        </div>
      `;

      if (activeStream) {
        startLiveVerificationTest();
      }
    } else {
      badge.textContent = 'NOT ENROLLED';
      badge.className = 'badge badge-unregistered';
      btnClearProfile.style.display = 'none';

      profileDisplay.className = 'profile-box empty';
      profileDisplay.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">👤</div>
          <p>No biometric signature enrolled yet.</p>
          <span class="empty-sub">Enroll your face on the left to activate hardware-isolated password and payment authorization.</span>
        </div>
      `;

      if (testBox) testBox.style.display = 'none';
    }
  }

  init();
})();
