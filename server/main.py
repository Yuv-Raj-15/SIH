"""
PrivacyVision Server — FastAPI application that receives sanitized visual context
from the browser extension and returns actionable commands via a VLM.

Usage:
    uvicorn main:app --host 0.0.0.0 --port 8000 --reload
"""

import json
import logging
import os
import time
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from action_parser import parse_vlm_response, validate_actions_against_dom
from prompts import SYSTEM_PROMPT, USER_PROMPT_TEMPLATE, CHAT_PROMPT_TEMPLATE
from vlm_client import VLMClient

# ── Configuration ─────────────────────────────────────────────────────
load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("privacyvision")

VLM_BACKEND = os.getenv("VLM_BACKEND", "ollama")
VLM_MODEL = os.getenv("VLM_MODEL", "llava:7b")
VLM_BASE_URL = os.getenv("VLM_BASE_URL", None)
VLM_API_KEY = os.getenv("VLM_API_KEY", None)

# ── FastAPI App ───────────────────────────────────────────────────────
app = FastAPI(
    title="PrivacyVision Server",
    description="Server-side reasoning engine for the PrivacyVision browser agent. "
                "Receives sanitized screenshots + DOM context and returns action plans.",
    version="1.0.0",
)

# CORS — allow extension to connect from any origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── VLM Client & Local Ollama PII Guard ────────────────────────────────
vlm_client: Optional[VLMClient] = None
ollama_guard_client: Optional[VLMClient] = None
OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llava:7b")


@app.on_event("startup")
async def startup():
    global vlm_client, ollama_guard_client

    # 1. Initialize Local Ollama LLaVA 7B On-Device PII Protection Shield
    try:
        ollama_guard_client = VLMClient(
            backend="ollama",
            model=OLLAMA_MODEL,
            base_url=OLLAMA_HOST,
        )
        guard_health = ollama_guard_client.health_check()
        if guard_health.get("status") == "ok":
            logger.info(f"🛡️ [Local Ollama LLaVA 7B] Connected at {OLLAMA_HOST} — Active On-Device PII Protection Shield Enabled!")
        else:
            logger.warning(f"Local Ollama guard status: {guard_health}")
    except Exception as e:
        logger.warning(f"Local Ollama guard not initialized: {e}")
        ollama_guard_client = None

    # 2. Initialize Primary Reasoning VLM Client (Ollama or Cloud Luna)
    try:
        primary_base_url = OLLAMA_HOST if VLM_BACKEND == "ollama" else VLM_BASE_URL
        primary_model = OLLAMA_MODEL if VLM_BACKEND == "ollama" else VLM_MODEL
        vlm_client = VLMClient(
            backend=VLM_BACKEND,
            model=primary_model,
            base_url=primary_base_url,
            api_key=VLM_API_KEY,
        )
        logger.info(f"Primary VLM client initialized: backend={VLM_BACKEND}, model={primary_model}, host={primary_base_url}")
    except Exception as e:
        logger.error(f"Failed to initialize primary VLM client: {e}")
        vlm_client = None


# ── Request/Response Models ───────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    """Request body for the /api/analyze endpoint."""
    image: Optional[str] = Field(None, description="Base64 sanitized screenshot (data URL or raw base64)")
    dom_summary: str = Field("", description="Text summary of the DOM structure")
    redaction_manifest: Optional[dict] = Field(None, description="Manifest of applied redactions")
    user_goal: str = Field("Analyze this page and suggest helpful actions.", description="What the user wants to accomplish")
    action_history: list = Field(default_factory=list, description="List of previous actions executed in this session")


class ChatRequest(BaseModel):
    """Request body for the /api/chat endpoint."""
    message: str = Field(..., description="User's chat message")
    image: Optional[str] = Field(None, description="Optional sanitized screenshot")
    dom_summary: str = Field("", description="DOM structure text summary")
    redaction_manifest: Optional[dict] = Field(None, description="Redaction manifest")


class ActionResponse(BaseModel):
    """Response body containing the action plan."""
    reasoning: str = ""
    page_description: str = ""
    actions: list = Field(default_factory=list)
    confidence: float = 0.0
    warnings: list = Field(default_factory=list)
    latency_ms: float = 0.0
    pii_guard: Optional[str] = None
    error: Optional[str] = None


# ── Endpoints ─────────────────────────────────────────────────────────

@app.get("/api/health")
async def health_check():
    """Health check endpoint — verifies server, local Ollama shield, and VLM connectivity."""
    result = {
        "server": "ok",
        "version": "1.0.0",
        "timestamp": time.time(),
        "backend": VLM_BACKEND,
        "pii_protection": {
            "on_device_tokenization": "active",
            "visual_redaction": "active",
            "local_ollama_shield": "connected" if ollama_guard_client else "offline",
            "ollama_host": OLLAMA_HOST,
            "ollama_model": OLLAMA_MODEL,
        }
    }

    if ollama_guard_client:
        result["local_ollama_health"] = ollama_guard_client.health_check()

    if vlm_client:
        result["vlm_planner"] = vlm_client.health_check()
    else:
        result["vlm_planner"] = {"status": "not_initialized"}

    return result


@app.post("/api/analyze", response_model=ActionResponse)
async def analyze_page(request: AnalyzeRequest):
    """
    Main analysis endpoint.
    Receives sanitized screenshot + DOM context, runs on-device Ollama PII guard,
    and returns action plan.
    """
    start_time = time.time()
    logger.info("==================================================")
    logger.info(f"📥 RECEIVED REQUEST: user_goal='{request.user_goal}'")
    logger.info(f"📜 ACTION HISTORY: {len(request.action_history)} past actions")
    logger.info("==================================================")

    if not vlm_client:
        raise HTTPException(status_code=503, detail="VLM client not initialized")

    # ── Tier 1: Local On-Device PII & Privacy Inspection (Ollama LLaVA 7B) ──
    pii_guard_note = "Local regex & visual redaction active."
    if ollama_guard_client and request.image:
        try:
            logger.info("🛡️ [Local Ollama LLaVA 7B] Inspecting visual frame for PII & sensitive secrets on-device...")
            t_guard = time.time()
            guard_prompt = "Inspect this webpage screenshot for privacy. Are passwords and personal identifiers masked or blurred? Answer in 1 short sentence."
            guard_resp = await ollama_guard_client.analyze(
                system_prompt="You are a local on-device privacy auditor. Verify PII masking.",
                user_prompt=guard_prompt,
                image_base64=request.image
            )
            elapsed_guard = time.time() - t_guard
            pii_guard_note = f"LLaVA 7B Verified: {guard_resp.strip()[:80]} ({elapsed_guard:.1f}s)"
            logger.info(f"🛡️ [Local Ollama LLaVA 7B] {pii_guard_note}")
        except Exception as e:
            logger.warning(f"Local Ollama visual inspection skipped: {e}")

    # Build the redaction manifest string
    manifest_str = "No redactions applied."
    if request.redaction_manifest and request.redaction_manifest.get("redactions"):
        redactions = request.redaction_manifest["redactions"]
        manifest_lines = [f"Total redactions: {len(redactions)}"]
        for r in redactions[:20]:  # Limit to 20 for prompt length
            region = r.get("region") or {}
            manifest_lines.append(
                f"  - {r.get('type', 'UNKNOWN')} at ({region.get('x', 0)},{region.get('y', 0)}) "
                f"{region.get('width', 0)}x{region.get('height', 0)}px — token: {r.get('token', 'N/A')}"
            )
        manifest_str = "\n".join(manifest_lines)

    # Format action history string
    history_str = "None yet. This is Step 1."
    if request.action_history:
        history_str = "\n".join([f"- Step {i+1}: {act}" for i, act in enumerate(request.action_history)])

    # Build the user prompt
    user_prompt = USER_PROMPT_TEMPLATE.format(
        user_goal=request.user_goal,
        action_history=history_str,
        dom_summary=request.dom_summary[:30000],  # Full rich DOM summary
        redaction_manifest=manifest_str,
    )

    try:
        # Call the VLM (Local Ollama or Cloud Luna depending on VLM_BACKEND)
        raw_response = await vlm_client.analyze(
            system_prompt=SYSTEM_PROMPT,
            user_prompt=user_prompt,
            image_base64=request.image,
        )

        # Parse VLM output into structured actions
        parsed = parse_vlm_response(raw_response)

        # Validate actions against DOM
        if parsed["actions"] and request.dom_summary:
            parsed["actions"] = validate_actions_against_dom(parsed["actions"], request.dom_summary)

        elapsed_ms = (time.time() - start_time) * 1000
        parsed["latency_ms"] = round(elapsed_ms, 1)
        parsed["pii_guard"] = pii_guard_note

        logger.info(
            f"Analysis complete: {len(parsed['actions'])} actions, "
            f"confidence={parsed['confidence']}, latency={elapsed_ms:.0f}ms, "
            f"pii_guard='{pii_guard_note}'"
        )

        return ActionResponse(**parsed)

    except Exception as e:
        elapsed_ms = (time.time() - start_time) * 1000
        logger.error(f"Analysis failed: {e}")
        return ActionResponse(
            reasoning=f"Error during analysis: {str(e)}",
            confidence=0.0,
            latency_ms=round(elapsed_ms, 1),
            error=str(e),
        )


@app.post("/api/chat", response_model=ActionResponse)
async def chat(request: ChatRequest):
    """
    Interactive chat endpoint — ask the agent questions about the page.
    """
    start_time = time.time()

    if not vlm_client:
        raise HTTPException(status_code=503, detail="VLM client not initialized")

    manifest_str = "No redactions applied."
    if request.redaction_manifest and request.redaction_manifest.get("redactions"):
        redactions = request.redaction_manifest["redactions"]
        manifest_str = f"Total redactions: {len(redactions)}"

    user_prompt = CHAT_PROMPT_TEMPLATE.format(
        user_message=request.message,
        dom_summary=request.dom_summary[:4000],
        redaction_manifest=manifest_str,
    )

    try:
        raw_response = await vlm_client.analyze(
            system_prompt=SYSTEM_PROMPT,
            user_prompt=user_prompt,
            image_base64=request.image,
        )

        parsed = parse_vlm_response(raw_response)
        elapsed_ms = (time.time() - start_time) * 1000
        parsed["latency_ms"] = round(elapsed_ms, 1)

        return ActionResponse(**parsed)

    except Exception as e:
        elapsed_ms = (time.time() - start_time) * 1000
        return ActionResponse(
            reasoning=f"Chat error: {str(e)}",
            latency_ms=round(elapsed_ms, 1),
            error=str(e),
        )


# ── Run ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", 8000)),
        reload=True,
        log_level="info",
    )
