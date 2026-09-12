# PrivacyVision Agent

> **On-Device Visual Perception for Privacy-Preserving Browser Agents**  
> SIH 2026 — Problem Statement: On-device Visual Perception for Light-weight Browser Agents

## 🛡️ Overview

PrivacyVision is a privacy-preserving browser agent that combines **on-device vision processing** with **server-side AI reasoning**. The client-side Chrome extension detects and redacts sensitive data (faces, passwords, PII) locally before sending anonymized context to a central VLM for intelligent action planning.

### Key Features

| Feature | Implementation |
|:---|:---|
| **Local Vision Processing** | Transformers.js + DETR object detection in Web Workers (WebGPU/WASM) |
| **PII Detection** | 13+ regex patterns + DOM-aware scanning for emails, phones, Aadhaar, PAN, SSN, passwords |
| **Visual Redaction** | Canvas-based blur, blackout, pixelate, noise, colorblock — 5 redaction methods |
| **Reversible Tokenization** | PII replaced with tokens like `[EMAIL_1]` — mapping stored locally, never sent to server |
| **Server-Side VLM** | Ollama (LLaVA/Qwen2.5-VL) or any OpenAI-compatible API (vLLM, Groq, Together AI) |
| **Action Execution** | Click, type, scroll, navigate, select, hover — with visual feedback and humanistic typing |
| **Privacy Guarantee** | Sensitive data NEVER leaves the browser. Only sanitized images + tokenized DOM are transmitted |

## 🏗️ Architecture

```
┌────────────────── Client (Chrome Extension) ──────────────────┐
│                                                                │
│  Tab Screenshot ──► DOM Analyzer ──► PII Scanner               │
│       │                   │               │                    │
│       ▼                   ▼               ▼                    │
│  Vision Worker ──► Redaction Engine (Canvas) ──► Sanitized     │
│  (Transformers.js)  blur/blackout/pixelate      Payload        │
│                                                    │           │
└────────────────────────────────────────────────────┼───────────┘
                                                     │ HTTPS
┌────────────────── Server (Python) ─────────────────┼───────────┐
│                                                     ▼           │
│  FastAPI ──► VLM Client ──► LLaVA / Qwen2.5-VL               │
│                                    │                            │
│                                    ▼                            │
│                              Action Parser                      │
│                              (JSON actions)                     │
└────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼ JSON Actions
┌────────────────── Client Executes Actions ────────────────────┐
│  click() · type() · scroll() · navigate() · select()          │
└───────────────────────────────────────────────────────────────┘
```

## 🚀 Quick Start

### Prerequisites

- **Chrome** 113+ (for WebGPU support) or any modern Chromium browser
- **Python** 3.10+
- **Ollama** installed locally ([ollama.com](https://ollama.com)) with LLaVA model

### 1. Install Ollama & Pull Model

```bash
# Install Ollama from https://ollama.com
# Then pull a vision model:
ollama pull llava:7b
```

### 2. Start the Server

```bash
cd server
pip install -r requirements.txt
cp .env.example .env   # Edit if needed

# Start the FastAPI server
python main.py
# Server runs at http://localhost:8000
```

### 3. Load the Chrome Extension

1. Open Chrome → navigate to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **"Load unpacked"** → select the `extension/` directory
4. The PrivacyVision icon appears in your toolbar

### 4. Test with the Demo Page

1. Open `demo/index.html` in Chrome (or serve it: `python -m http.server 3000 --directory demo`)
2. Click the PrivacyVision extension icon
3. Click **"Analyze Page"** — watch it:
   - Detect PII (emails, phones, Aadhaar, passwords, faces)
   - Show red overlay indicators on detected items
   - Redact the screenshot (blur faces, black out passwords)
   - Send sanitized data to the server
   - Receive action suggestions from the VLM

## 📁 Project Structure

```
├── extension/                    # Chrome Extension (Client)
│   ├── manifest.json             # Manifest V3 config
│   ├── background.js             # Service worker orchestrator
│   ├── content.js                # DOM analysis + action execution
│   ├── popup/                    # Dashboard popup UI
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.js
│   ├── offscreen/                # Canvas redaction (offscreen doc)
│   │   ├── offscreen.html
│   │   └── offscreen.js
│   ├── workers/                  # ML inference Web Worker
│   │   └── vision-worker.js
│   ├── lib/                      # Core libraries
│   │   ├── pii-scanner.js        # Regex + DOM PII detection
│   │   ├── dom-analyzer.js       # Structured DOM extraction
│   │   ├── redaction-engine.js   # Canvas-based visual redaction
│   │   └── action-executor.js    # Execute server commands
│   ├── icons/
│   └── styles/
│       └── content.css
│
├── server/                       # Server (Python + FastAPI)
│   ├── main.py                   # FastAPI application
│   ├── vlm_client.py             # VLM inference abstraction
│   ├── action_parser.py          # Parse VLM → structured actions
│   ├── prompts.py                # System/user prompts
│   ├── requirements.txt
│   └── .env.example
│
├── demo/                         # Demo test page
│   ├── index.html                # Fake banking portal with PII
│   └── styles.css
│
└── README.md
```

## 🔒 Privacy Guarantees

| Data Type | Treatment | Leaves Browser? |
|:---|:---|:---|
| Passwords | Blackout (solid black rectangle) | ❌ Never |
| Faces / Photos | Gaussian blur | ❌ Only blurred version |
| Emails | Color-block + token `[EMAIL_1]` | ❌ Only token |
| Phone Numbers | Color-block + token `[PHONE_1]` | ❌ Only token |
| Aadhaar / SSN / PAN | Blackout | ❌ Never |
| Credit Card Numbers | Blackout | ❌ Never |
| Account Numbers | Blackout | ❌ Never |
| DOM Structure | Tokenized (PII replaced) | ✅ Sanitized version |
| Page Layout | Redacted screenshot | ✅ Sanitized version |

## ⚙️ Configuration

### Server Environment Variables

| Variable | Default | Description |
|:---|:---|:---|
| `VLM_BACKEND` | `ollama` | Backend: `ollama`, `openai`, `vllm`, `together`, `groq` |
| `VLM_MODEL` | `llava:7b` | Model name |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server URL |
| `VLM_BASE_URL` | — | OpenAI-compatible API base URL |
| `VLM_API_KEY` | — | API key for cloud backends |
| `PORT` | `8000` | Server port |

### Extension Settings (via Popup)

- **Server URL**: Default `http://localhost:8000`
- **Redaction Sensitivity**: Low / Medium / High

## 📊 Evaluation Criteria Mapping

| Criterion | Weight | How We Address It |
|:---|:---|:---|
| Visual context accuracy | 25% | DETR object detection + structured DOM with bounding boxes |
| PII detection recall/precision | 20% | 13+ regex patterns + DOM-aware scanning + context keywords |
| Redaction precision | 20% | Pixel-level canvas redaction with 5 methods + labeled tokens |
| Client resource utilization | 20% | Web Workers, quantized models, WebGPU, lazy loading |
| End-to-end latency | 15% | Parallel DOM+vision analysis, cached results, streaming |

## 🛠️ Tech Stack

- **Client**: Chrome Extension (Manifest V3), Transformers.js, ONNX Runtime Web, Canvas API
- **Server**: Python, FastAPI, Ollama / vLLM
- **Models**: DETR-ResNet-50 (client), LLaVA 7B / Qwen2.5-VL (server)

## 📄 License

Built for Smart India Hackathon 2026.
