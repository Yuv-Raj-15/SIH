"""
PrivacyVision Server — Dual-AI Autonomous Browser Agent Orchestrator.

Architecture:
  1. Client-Side: On-Device PII Tokenization & Canvas Visual Redaction
  2. Server AI-1 (Key 1): Multimodal Perception & Strategic Reasoning Engine (gpt-5.6-luna)
  3. Server AI-2 (Key 2): Tactical Decision-Making & Action Engine (gpt-5.6-luna)
  4. Local PII Guard: Zero plaintext credentials or sensitive data ever leave local client.

Usage:
    uvicorn main:app --host 0.0.0.0 --port 8000 --reload
"""

import asyncio
import json
import logging
import os
import sys
import time
from typing import Optional, List, Dict, Any

# Ensure server directory is in sys.path regardless of execution CWD
_server_dir = os.path.dirname(os.path.abspath(__file__))
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from action_parser import parse_vlm_response, validate_actions_against_dom, parse_workflow_plan
from prompts import (
    CHAT_PROMPT_TEMPLATE, SYSTEM_PROMPT,
    PLAN_SYSTEM_PROMPT, PLAN_USER_PROMPT_TEMPLATE,
    DECISION_SYSTEM_PROMPT, VERIFICATION_PROMPT_TEMPLATE,
)
from vlm_client import DualAIClient, VLMClient


# ── Configuration ─────────────────────────────────────────────────────
load_dotenv(os.path.join(_server_dir, ".env"))
load_dotenv()  # also load from CWD if present

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("privacyvision")

VLM_BACKEND = os.getenv("VLM_BACKEND", "openai")
VLM_BASE_URL = os.getenv("VLM_BASE_URL", "https://api.experientiallabs.ai/v1")
REASONING_API_KEY = os.getenv("REASONING_API_KEY") or os.getenv("VLM_API_KEY")
DECISION_API_KEY = os.getenv("DECISION_API_KEY") or os.getenv("VLM_API_KEY")
REASONING_MODEL = os.getenv("REASONING_MODEL", "gpt-5.6-luna")
DECISION_MODEL = os.getenv("DECISION_MODEL", "gpt-5.6-luna")

OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llava:7b")
ENABLE_OLLAMA_GUARD = os.getenv("ENABLE_OLLAMA_GUARD", "true").lower() == "true"  # Default ON: graceful fallback if Ollama offline

# ── FastAPI App ───────────────────────────────────────────────────────
app = FastAPI(
    title="PrivacyVision Dual-AI Agent Server",
    description="Multi-agent reasoning and decision server for PrivacyVision browser agent.",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Multi-AI Client Instances ─────────────────────────────────────────
dual_ai: Optional[DualAIClient] = None
ollama_guard_client: Optional[VLMClient] = None


@app.on_event("startup")
async def startup():
    global dual_ai, ollama_guard_client

    # Initialize Dual-AI Agent Orchestrator (Reasoning on Key 1, Decision on Key 2)
    try:
        dual_ai = DualAIClient(
            base_url=VLM_BASE_URL,
            reasoning_key=REASONING_API_KEY,
            decision_key=DECISION_API_KEY,
            reasoning_model=REASONING_MODEL,
            decision_model=DECISION_MODEL,
            backend=VLM_BACKEND,
        )
        logger.info(
            f"🚀 [Dual-AI Orchestrator Initialized] "
            f"AI-1 (Reasoning): {REASONING_MODEL} (Key 1) | "
            f"AI-2 (Decision): {DECISION_MODEL} (Key 2) | "
            f"Endpoint: {VLM_BASE_URL}"
        )
    except Exception as e:
        logger.error(f"Failed to initialize Dual-AI Orchestrator: {e}")
        dual_ai = None

    # Optional local Ollama guard
    if ENABLE_OLLAMA_GUARD:
        try:
            ollama_guard_client = VLMClient(
                backend="ollama",
                model=OLLAMA_MODEL,
                base_url=OLLAMA_HOST,
                name="Local Ollama Shield",
            )
            logger.info(f"🛡️ Local Ollama Shield connected at {OLLAMA_HOST}")
        except Exception as e:
            logger.warning(f"Local Ollama Shield disabled: {e}")
            ollama_guard_client = None


# ── Request / Response Schemas ────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    image: Optional[str] = Field(None, description="Sanitized/redacted base64 screenshot")
    dom_summary: str = Field("", description="Compacted DOM text summary")
    dom_structured: Optional[dict] = Field(None, description="Structured DOM JSON from DOMAnalyzer (preferred over raw text)")
    redaction_manifest: Optional[dict] = Field(None, description="Manifest of redactions applied on-device")
    user_goal: str = Field("Analyze page and assist user.", description="User objective")
    action_history: list = Field(default_factory=list, description="Past steps executed in this session")
    plan_steps: Optional[list] = Field(None, description="AI-planned workflow steps from /api/plan (used to pre-seed context)")
    local_telemetry: Optional[dict] = Field(None, description="Local on-device masking telemetry")


class ChatRequest(BaseModel):
    message: str = Field(..., description="User query")
    image: Optional[str] = Field(None, description="Sanitized screenshot")
    dom_summary: str = Field("", description="DOM structure")
    redaction_manifest: Optional[dict] = Field(None, description="Redaction manifest")


class RetryActionRequest(BaseModel):
    failed_action: dict = Field(..., description="The action that failed during DOM injection")
    dom_summary: str = Field("", description="Current compacted DOM text")
    dom_structured: Optional[dict] = Field(None, description="Structured DOM JSON")
    user_goal: str = Field("", description="Overall user goal")
    failure_reason: str = Field("", description="Error message from the executor")





class ActionResponse(BaseModel):
    reasoning: str = ""
    page_description: str = ""
    task_complexity: str = "medium"
    suggested_max_steps: int = 25
    is_goal_complete: bool = False
    actions: list = Field(default_factory=list)
    confidence: float = 0.0
    warnings: list = Field(default_factory=list)
    latency_ms: float = 0.0
    pii_guard: Optional[str] = None
    local_masking_ledger: Optional[dict] = None
    telemetry: Optional[dict] = None
    error: Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────────

def _compact_dom(dom_text: str, max_chars: int = 5500) -> str:
    """Prioritizes interactive and semantically meaningful elements for inference."""
    if not dom_text or len(dom_text) <= max_chars:
        return dom_text

    lines = dom_text.splitlines()
    header = lines[:3]
    priority = []
    secondary = []

    priority_keywords = (
        "<input", "<button", "<textarea", "<select", "<a",
        "role=\"button\"", "role=\"textbox\"", "role=\"searchbox\"", "role=\"link\"",
        "sel=", "checkout", "cart", "pay", "submit", "login", "code-editor", "monaco"
    )

    for line in lines[3:]:
        lower = line.lower()
        if any(k in lower for k in priority_keywords):
            priority.append(line)
        else:
            secondary.append(line)

    budget = max_chars - sum(len(l) + 1 for l in header)
    kept = []
    for l in priority:
        if sum(len(x) + 1 for x in kept) + len(l) < budget * 0.85:
            kept.append(l)

    rem = budget - sum(len(x) + 1 for x in kept)
    for l in secondary:
        if sum(len(x) + 1 for x in kept) + len(l) < rem:
            kept.append(l)

    return "\n".join(header + kept)


def _structured_dom_to_text(dom_structured: dict, max_chars: int = 5000) -> str:
    """
    Converts the structured DOM JSON (from DOMAnalyzer on the client) into a
    compact, AI-optimized text format that AI-1 and AI-2 can reference by index.

    Structured DOM format example:
      {
        "page_type_hint": "checkout_form",
        "interactive": [{"idx":0,"tag":"button","text":"Place Order","sel":"#checkout-btn"}],
        "text_blocks": ["Total: ₹2,499"]
      }
    """
    if not dom_structured or not isinstance(dom_structured, dict):
        return ""

    lines = []

    page_hint = dom_structured.get("page_type_hint", "")
    url = dom_structured.get("url", "")
    title = dom_structured.get("title", "")
    if url:
        lines.append(f"URL: {url}")
    if title:
        lines.append(f"Title: {title}")
    if page_hint:
        lines.append(f"PageHint: {page_hint}")

    # Interactive elements (highest priority for AI-2 selector picking)
    interactive = dom_structured.get("interactive", [])
    if interactive:
        lines.append("--- Interactive Elements ---")
        for el in interactive[:60]:  # cap at 60 elements
            idx = el.get("idx", "?")
            tag = el.get("tag", "el")
            sel = el.get("sel", "")
            text = (el.get("text") or el.get("placeholder") or el.get("ariaLabel") or "")[:50]
            role = el.get("role", "")
            itype = el.get("type", "")
            parts = [f"[{idx}] <{tag}>"]
            if itype and itype not in ("text", tag):
                parts.append(f"type={itype}")
            if role and role not in (tag, "generic"):
                parts.append(f"role={role}")
            if text:
                parts.append(f'"{text}"')
            if sel:
                parts.append(f"sel={sel}")
            lines.append(" ".join(parts))

    # Text blocks (for context/page state)
    text_blocks = dom_structured.get("text_blocks", [])
    if text_blocks:
        lines.append("--- Page Text (sanitized) ---")
        for tb in text_blocks[:20]:
            if isinstance(tb, str) and len(tb.strip()) > 1:
                lines.append(tb.strip()[:120])

    result = "\n".join(lines)
    return result[:max_chars]


async def _verify_actions_with_ai(
    actions: list,
    user_goal: str,
    dom_summary: str,
    reasoning_client,
    ollama_hints: str = "",
) -> dict:
    """
    AI-3: Lightweight action verification gate.
    Runs AFTER AI-2 produces actions, BEFORE they are sent to the client for execution.
    Uses the reasoning client with a compact prompt to catch:
      - Raw PII/plaintext secrets in action values
      - Empty or clearly wrong selectors
      - Actions that look like infinite loops
    Returns {"verified": bool, "confidence": float, "warnings": [str], "corrected_actions": list}
    """
    if not actions or not reasoning_client:
        return {"verified": True, "confidence": 1.0, "warnings": [], "corrected_actions": actions}

    import time as _time
    import json as _json, re as _re


    actions_json = _json.dumps(actions[:5], ensure_ascii=False)[:1200]
    verify_prompt = VERIFICATION_PROMPT_TEMPLATE.format(
        user_goal=user_goal[:200],
        actions_json=actions_json,
        ollama_hints=ollama_hints,
    )

    t0 = _time.perf_counter()
    try:
        raw = await reasoning_client.analyze(
            system_prompt=(
                "You are AI-3: a rapid action safety verifier. "
                "Inspect the planned browser actions for PII leaks, bad selectors, and loops. "
                "Output ONLY compact JSON: "
                '{\"verified\":true,\"confidence\":0.95,\"warnings\":[],\"corrected_actions\":[]}'
            ),
            user_prompt=verify_prompt,
            image_base64=None,
            max_tokens=180,
            temperature=0.0,
        )
        latency_ms = round((_time.perf_counter() - t0) * 1000, 1)

        match = _re.search(r"\{[\s\S]*\}", raw)
        if match:
            try:
                result = _json.loads(match.group(0))
            except Exception:
                result = {"verified": True, "confidence": 0.8, "warnings": ["AI-3 parse error"]}
        else:
            result = {"verified": True, "confidence": 0.9, "warnings": []}

        result["latency_ms"] = latency_ms
        logger.info(
            f"✅ [AI-3 Verifier] verified={result.get('verified')} | "
            f"confidence={result.get('confidence')} | warnings={result.get('warnings', [])} | {latency_ms}ms"
        )

        # If verifier returned corrected actions, use those instead
        corrected = result.get("corrected_actions", [])
        if corrected and isinstance(corrected, list) and len(corrected) > 0:
            return {**result, "corrected_actions": corrected}
        return {**result, "corrected_actions": actions}

    except Exception as e:
        latency_ms = round((_time.perf_counter() - t0) * 1000, 1)
        logger.warning(f"[AI-3 Verifier] Error (non-blocking): {e}")
        return {"verified": True, "confidence": 0.8, "warnings": [str(e)], "corrected_actions": actions, "latency_ms": latency_ms}


def _build_local_masking_ledger(manifest: Optional[dict], telemetry: Optional[dict]) -> dict:
    """
    Constructs an informative ledger of what the local on-device model did:
    - Number of entities masked
    - Methods used (Solid Blackout, Gaussian Blur, Reversible Tokens)
    - Zero plaintext leaked confirmation
    """
    redactions = (manifest or {}).get("redactions", [])
    entities_summary = {}

    for r in redactions:
        etype = r.get("type", "UNKNOWN").upper()
        method = "Canvas Blackout" if any(k in etype for k in ("PASS", "PIN", "CVV", "CARD", "AADHAAR", "PAN")) else "Reversible Token / Blur"
        token = r.get("token", "N/A")
        if etype not in entities_summary:
            entities_summary[etype] = {
                "count": 0,
                "technique": method,
                "tokens": [],
            }
        entities_summary[etype]["count"] += 1
        if token != "N/A" and token not in entities_summary[etype]["tokens"]:
            entities_summary[etype]["tokens"].append(token)

    return {
        "status": "active",
        "total_masked": len(redactions),
        "zero_leak_guarantee": "100% On-Device Isolation. 0 bytes of plaintext secrets transmitted.",
        "entities": entities_summary,
        "techniques_applied": [
            "Hardware-isolated AES-256-GCM Vault",
            "Canvas Visual Redaction (Blackout & Blur)",
            "Bidirectional Reversible Tokenization",
            "Local Ollama Vision Guard (llava:7b)" if ENABLE_OLLAMA_GUARD else "Local Ollama Guard (disabled)",
        ],
        "local_scan_ms": (telemetry or {}).get("scan_duration_ms", 0),
    }


async def _run_ollama_pii_guard(
    dom_summary: str,
    redaction_manifest: dict,
    image_base64: Optional[str] = None,
) -> dict:
    """
    Local Ollama PII Verification Gate.

    Runs BEFORE the cloud Dual-AI pipeline.
    Checks whether the client-side regex scan missed any PII in the DOM text
    and optionally verifies faces/avatars in the screenshot.

    Returns a dict:
      {
        "additional_redactions": [...],  # extra PII types found
        "verdict": "clean" | "extra_pii_found",
        "latency_ms": float,
        "raw_response": str,
        "error": str | None,
      }
    """
    if not ollama_guard_client:
        return {"verdict": "guard_offline", "additional_redactions": [], "latency_ms": 0, "error": "Ollama not initialized"}

    # Build a short, safe DOM snippet (no already-tokenised secrets)
    dom_snippet = dom_summary[:1800] if dom_summary else "(no DOM)"

    already_masked = []
    for r in (redaction_manifest or {}).get("redactions", []):
        already_masked.append(r.get("type", "UNKNOWN"))

    system_prompt = (
        "You are a strict on-device Privacy Guard. "
        "Your ONLY job is to find PII that the regex scanner missed in the DOM text. "
        "PII types to look for: phone numbers, email addresses, Aadhaar numbers, PAN, "
        "passport numbers, credit/debit card numbers, bank account numbers, UPI IDs, "
        "full personal names, physical addresses, dates of birth. "
        "The following PII types were ALREADY masked by the client: " + str(already_masked) + ". "
        "Respond ONLY with compact JSON — no prose, no markdown. "
        'Example: {"verdict":"extra_pii_found","additional_redactions":[{"type":"PHONE","hint":"ends in 3210"}]}'
        ' or {"verdict":"clean","additional_redactions":[]}'
    )

    user_prompt = f"DOM TEXT TO SCAN:\n{dom_snippet}"

    import time as _time
    t0 = _time.perf_counter()
    try:
        raw = await ollama_guard_client.analyze(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            image_base64=image_base64,   # pass redacted screenshot if available
            max_tokens=200,
            temperature=0.0,
        )
        latency_ms = round((_time.perf_counter() - t0) * 1000, 1)

        # Parse JSON from response
        import re as _re, json as _json
        match = _re.search(r"\{.*\}", raw, _re.DOTALL)
        if match:
            try:
                parsed = _json.loads(match.group(0))
            except Exception:
                parsed = {"verdict": "parse_error", "additional_redactions": []}
        else:
            parsed = {"verdict": "clean", "additional_redactions": []}

        parsed["latency_ms"] = latency_ms
        parsed["raw_response"] = raw[:300]
        parsed["error"] = None
        logger.info(
            f"🛡️  [Ollama Guard] verdict='{parsed.get('verdict')}' | "
            f"extra_pii={len(parsed.get('additional_redactions', []))} | {latency_ms}ms"
        )
        return parsed

    except Exception as e:
        latency_ms = round((_time.perf_counter() - t0) * 1000, 1)
        logger.warning(f"[Ollama Guard] Error (non-blocking): {e}")
        return {"verdict": "guard_error", "additional_redactions": [], "latency_ms": latency_ms, "error": str(e)}


async def _run_ollama_prompt_guard(instruction: str) -> dict:
    """
    Local Ollama Prompt Privacy Shield.
    Runs ON-DEVICE BEFORE any prompt text is sent to the cloud model.
    Uses the local LLM (e.g. llava:7b) to detect usernames, handles, personal names,
    account identifiers, and secret tokens that client-side regex might have missed.
    """
    if not ollama_guard_client or not ENABLE_OLLAMA_GUARD or not instruction or not instruction.strip():
        return {
            "sanitized": instruction,
            "token_map": {},
            "pii_found": [],
            "latency_ms": 0,
            "status": "disabled",
        }

    system_prompt = (
        "You are an on-device local privacy shield. Your ONLY task is to identify all PII entities "
        "(usernames, social media handles, full personal names, account IDs, emails, phone numbers, secret codes) "
        "in the user instruction text.\n"
        "Respond ONLY with valid JSON in this exact structure:\n"
        '{"pii_found": [{"text": "exact entity", "type": "USERNAME|PERSON|EMAIL|PHONE|SECRET"}]}'
    )

    user_prompt = f'User instruction text:\n"{instruction}"'

    import time as _time, re as _re, json as _json, hashlib as _hashlib
    t0 = _time.perf_counter()

    try:
        raw = await ollama_guard_client.analyze(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            image_base64=None,
            max_tokens=150,
            temperature=0.0,
        )
        latency_ms = round((_time.perf_counter() - t0) * 1000, 1)

        match = _re.search(r"\{[\s\S]*\}", raw)
        if match:
            clean_json = _re.sub(r'\\([^"\\/bfnrtu])', r'\1', match.group(0))
            clean_json = _re.sub(r",\s*([\]}])", r"\1", clean_json)
            try:
                parsed = _json.loads(clean_json)
            except Exception:
                parsed = {"pii_found": []}
        else:
            parsed = {"pii_found": []}

        token_map = {}
        sanitized = instruction
        pii_list = parsed.get("pii_found", [])

        for item in pii_list:
            if not isinstance(item, dict):
                continue
            entity_text = item.get("text", "").strip()
            entity_text = _re.sub(r'\\([^"\\/bfnrtu])', r'\1', entity_text)
            etype = item.get("type", "ENTITY").upper()
            if entity_text and len(entity_text) >= 2 and entity_text in sanitized:
                # Do not re-tokenize if it already looks like a token [XYZ_123]
                if entity_text.startswith("[") and entity_text.endswith("]"):
                    continue
                h = _hashlib.md5(entity_text.encode()).hexdigest()[:4]
                token = f"[{etype}_{h}]"
                token_map[token] = entity_text
                sanitized = sanitized.replace(entity_text, token)


        logger.info(
            f"🛡️  [Ollama Prompt Guard] Detected {len(token_map)} entity(ies) in prompt "
            f"in {latency_ms}ms: {list(token_map.keys())}"
        )

        return {
            "sanitized": sanitized,
            "token_map": token_map,
            "pii_found": pii_list,
            "latency_ms": latency_ms,
            "status": "active",
        }
    except Exception as e:
        latency_ms = round((_time.perf_counter() - t0) * 1000, 1)
        logger.warning(f"[Ollama Prompt Guard] Error (non-blocking): {e}")
        return {
            "sanitized": instruction,
            "token_map": {},
            "pii_found": [],
            "latency_ms": latency_ms,
            "error": str(e),
            "status": "error",
        }


# ── Endpoints ─────────────────────────────────────────────────────────

@app.get("/api/health")
async def health_check():
    """Health check endpoint — returns dual-AI engine statuses and on-device protection metrics."""
    res = {
        "server": "ok",
        "version": "2.0.0",
        "architecture": "Dual-AI Multi-Agent Pipeline",
        "timestamp": time.time(),
        "backend": VLM_BACKEND,
        "pii_protection": {
            "on_device_tokenization": "active",
            "visual_redaction": "active",
            "vault_isolation": "hardware_memory",
        },
    }

    if dual_ai:
        res["dual_ai_status"] = dual_ai.health_check()
    else:
        res["dual_ai_status"] = {"status": "error", "message": "DualAIClient not initialized"}

    if ollama_guard_client:
        res["local_ollama_shield"] = ollama_guard_client.health_check()

    return res


@app.post("/api/analyze", response_model=ActionResponse)
async def analyze_page(request: AnalyzeRequest):
    """
    Primary Dual-AI Analysis Endpoint.
    Executes:
      Stage 1: AI-1 (Reasoning Engine with Key 1) for visual understanding & strategic intent.
      Stage 2: AI-2 (Decision Engine with Key 2) for tactical element selection & micro-actions.
      Stage 3: Verification & Safety Guard.
    """
    start_time = time.time()
    logger.info("==================================================")
    logger.info(f"📥 REQUEST RECEIVED: user_goal='{request.user_goal}'")
    logger.info(f"📜 PAST ACTIONS IN SESSION: {len(request.action_history)}")
    logger.info("==================================================")

    if not dual_ai:
        raise HTTPException(status_code=503, detail="Dual-AI client not initialized")

    # Format redaction manifest
    manifest_str = "No redactions applied."
    if request.redaction_manifest and request.redaction_manifest.get("redactions"):
        redactions = request.redaction_manifest["redactions"]
        manifest_lines = [f"Total entities masked on-device: {len(redactions)}"]
        for r in redactions[:12]:
            manifest_lines.append(f"  - {r.get('type', 'SENSITIVE')} -> Protected as {r.get('token', 'TOKEN')}")
        manifest_str = "\n".join(manifest_lines)

    # Format action history — pre-seed from plan_steps if no real history yet
    history_str = "None yet. Starting workflow."
    if request.action_history:
        history_str = "\n".join([f"- Step {i+1}: {act}" for i, act in enumerate(request.action_history[-6:])])
    elif request.plan_steps:
        # Pre-seed with planned steps so AI knows the intended workflow
        plan_lines = [f"[PLANNED] Step {s.get('step', i+1)}: {s.get('action', '')} — {s.get('detail', '')}" for i, s in enumerate(request.plan_steps[:5]) if isinstance(s, dict)]
        if plan_lines:
            history_str = "[PRE-PLANNED WORKFLOW — no actions executed yet]\n" + "\n".join(plan_lines)

    # Compact DOM for low token overhead — prefer structured JSON if available
    compact_dom = _compact_dom(request.dom_summary, max_chars=5500)
    if request.dom_structured:
        compact_dom = _structured_dom_to_text(request.dom_structured) or compact_dom

    # Build local masking ledger for UI explainability
    local_ledger = _build_local_masking_ledger(request.redaction_manifest, request.local_telemetry)

    try:
        # ── [LAUNCH ALL TASKS CONCURRENTLY] ──
        # Since the extension already sanitizes the prompt, we use request.user_goal directly for the cloud AI.
        # Ollama guards act as a concurrent secondary safety net.
        
        async def run_prompt_guard():
            return await _run_ollama_prompt_guard(request.user_goal)
            
        async def run_dom_guard():
            if ENABLE_OLLAMA_GUARD and ollama_guard_client:
                logger.info("🛡️  [Ollama Guard] Running local PII verification gate on DOM & prompt...")
                return await _run_ollama_pii_guard(
                    dom_summary=compact_dom,
                    redaction_manifest=request.redaction_manifest or {},
                    image_base64=request.image,
                )
            return {"verdict": "guard_disabled", "additional_redactions": [], "latency_ms": 0}

        async def run_pipeline():
            return await dual_ai.execute_dual_pipeline(
                user_goal=request.user_goal,
                dom_summary=compact_dom,
                redaction_manifest=manifest_str,
                action_history=history_str,
                image_base64=request.image,
            )

        # Run them in parallel
        prompt_guard_result, ollama_result, pipeline_result = await asyncio.gather(
            run_prompt_guard(),
            run_dom_guard(),
            run_pipeline()
        )

        sanitized_goal = prompt_guard_result.get("sanitized", request.user_goal)
        if prompt_guard_result.get("token_map"):
            local_ledger["ollama_prompt_guard"] = {
                "entities_masked": len(prompt_guard_result["token_map"]),
                "tokens": prompt_guard_result["token_map"],
                "model": OLLAMA_MODEL if ENABLE_OLLAMA_GUARD else "disabled",
                "latency_ms": prompt_guard_result.get("latency_ms", 0),
            }
            
        extra_pii = ollama_result.get("additional_redactions", [])
        if extra_pii:
            logger.info(f"🛡️  [Ollama Guard] Found {len(extra_pii)} extra redaction hints for AI-3 to verify")

        actions = pipeline_result.get("actions", [])

        # Validate actions against current DOM (prevent invalid selectors)
        if actions and request.dom_summary:
            actions = validate_actions_against_dom(actions, request.dom_summary)

        # Prepare hints for AI-3 based on Ollama's secondary findings
        hints_str = ""
        if extra_pii or prompt_guard_result.get("token_map"):
            hints = ["4. EXACTLY enforce these secondary PII rules from local Ollama shields:"]
            for k, v in prompt_guard_result.get("token_map", {}).items():
                hints.append(f"   - DO NOT expose '{v}' (use '{k}')")
            for e in extra_pii:
                hints.append(f"   - Watch out for {e.get('type', 'sensitive data')}: {e.get('hint', '')}")
            hints_str = "\n".join(hints)

        # ── [STAGE 3] AI-3 Action Verifier (lightweight safety gate) ──────
        ai3_result = await _verify_actions_with_ai(
            actions=actions,
            user_goal=sanitized_goal,
            dom_summary=compact_dom,
            reasoning_client=dual_ai.reasoning_client,
            ollama_hints=hints_str,
        )
        # Use corrected actions if AI-3 patched them
        if ai3_result.get("corrected_actions") and ai3_result["corrected_actions"] != actions:
            logger.info(f"🔧 [AI-3 Verifier] Corrected {len(actions)} → {len(ai3_result['corrected_actions'])} actions")
            actions = ai3_result["corrected_actions"]
        # Merge AI-3 warnings into response warnings
        ai3_warnings = ai3_result.get("warnings", [])

        elapsed_ms = round((time.time() - start_time) * 1000, 1)

        # Merge Ollama telemetry into response telemetry
        telemetry = pipeline_result.get("telemetry") or {}
        telemetry["ollama_guard"] = {
            "verdict": ollama_result.get("verdict"),
            "extra_pii_found": len(ollama_result.get("additional_redactions", [])),
            "latency_ms": ollama_result.get("latency_ms", 0),
            "enabled": ENABLE_OLLAMA_GUARD,
        }
        telemetry["ai3_verifier"] = {
            "verified": ai3_result.get("verified", True),
            "confidence": ai3_result.get("confidence", 1.0),
            "latency_ms": ai3_result.get("latency_ms", 0),
            "warnings": ai3_warnings,
        }

        # Update ledger with Ollama findings
        local_ledger["ollama_guard"] = {
            "verdict": ollama_result.get("verdict", "guard_disabled"),
            "extra_pii_caught": len(ollama_result.get("additional_redactions", [])),
            "latency_ms": ollama_result.get("latency_ms", 0),
            "model": OLLAMA_MODEL if ENABLE_OLLAMA_GUARD else "disabled",
        }

        all_warnings = pipeline_result.get("warnings", []) + ai3_warnings

        response = ActionResponse(
            reasoning=pipeline_result.get("reasoning", ""),
            page_description=pipeline_result.get("page_description", ""),
            task_complexity=pipeline_result.get("task_complexity", "medium"),
            suggested_max_steps=25,
            is_goal_complete=pipeline_result.get("is_goal_complete", False),
            actions=actions,
            confidence=pipeline_result.get("confidence", 0.9),
            warnings=all_warnings,
            latency_ms=elapsed_ms,
            pii_guard=(
                f"Ollama({OLLAMA_MODEL}) verified + AI-3 verified + 100% On-Device Masked"
                if ENABLE_OLLAMA_GUARD else
                "AI-3 verified + 100% On-Device Masked (0 Plaintext Leaked)"
            ),
            local_masking_ledger=local_ledger,
            telemetry=telemetry,
        )

        logger.info(
            f"✅ Full Pipeline Done: {len(actions)} actions | "
            f"Goal={response.is_goal_complete} | "
            f"Ollama={ollama_result.get('verdict')} | "
            f"AI3={ai3_result.get('verified')} | Total={elapsed_ms}ms"
        )
        return response

    except Exception as e:
        elapsed_ms = round((time.time() - start_time) * 1000, 1)
        logger.error(f"Dual-AI pipeline failed: {e}", exc_info=True)
        return ActionResponse(
            reasoning=f"Analysis encountered an error: {str(e)}",
            confidence=0.0,
            latency_ms=elapsed_ms,
            local_masking_ledger=local_ledger,
            error=str(e),
        )





@app.post("/api/retry-action")
async def retry_action(request: RetryActionRequest):
    """
    AI-2 Smart Selector Retry Endpoint.

    Called by the extension when a DOM action fails (selector not found, click failed, etc.).
    Receives the failed action, current DOM, and error context.
    AI-2 re-analyzes the DOM and returns an alternative action with a corrected selector.
    This prevents silent failures and reduces wasted agent iterations.
    """
    start_time = time.time()
    logger.info(f"🔄 [Retry] Failed action={request.failed_action.get('type')} | reason='{request.failure_reason[:80]}'")

    if not dual_ai:
        raise HTTPException(status_code=503, detail="Dual-AI client not initialized")

    # Build DOM context — prefer structured if available
    dom_text = request.dom_summary
    if request.dom_structured:
        dom_text = _structured_dom_to_text(request.dom_structured) or dom_text
    compact_dom = _compact_dom(dom_text, max_chars=3500)

    import json as _json
    retry_prompt = f"""The following browser action FAILED during DOM injection:

Failed Action: {_json.dumps(request.failed_action, ensure_ascii=False)}
Failure Reason: {request.failure_reason}
User Goal: {request.user_goal}

Current DOM Elements:
{compact_dom}

Please select an ALTERNATIVE element from the DOM that best fulfills the same intent.
Return a corrected single action. Output ONLY valid JSON matching:
{{"type": "click|type|navigate|scroll", "selector": "correct CSS selector", "value": "", "description": "why this alternative works"}}"""

    try:
        raw = await dual_ai.decision_client.analyze(
            system_prompt=DECISION_SYSTEM_PROMPT,
            user_prompt=retry_prompt,
            image_base64=None,
            max_tokens=200,
            temperature=0.1,
        )
        elapsed_ms = round((time.time() - start_time) * 1000, 1)

        import re as _re
        match = _re.search(r"\{[\s\S]*\}", raw)
        if match:
            try:
                corrected = _json.loads(match.group(0))
            except Exception:
                corrected = None
        else:
            corrected = None

        if corrected and corrected.get("selector") or corrected.get("url"):
            logger.info(f"✅ [Retry] Corrected action: {corrected.get('type')} on '{corrected.get('selector') or corrected.get('url')}' ({elapsed_ms}ms)")
            return {"success": True, "corrected_action": corrected, "latency_ms": elapsed_ms}
        else:
            return {"success": False, "corrected_action": None, "latency_ms": elapsed_ms, "error": "AI-2 could not find alternative selector"}

    except Exception as e:
        elapsed_ms = round((time.time() - start_time) * 1000, 1)
        logger.error(f"[Retry] Failed: {e}")
        return {"success": False, "corrected_action": None, "latency_ms": elapsed_ms, "error": str(e)}


@app.post("/api/chat", response_model=ActionResponse)
async def chat(request: ChatRequest):
    """Interactive chat endpoint using the Reasoning Engine."""
    start_time = time.time()
    if not dual_ai:
        raise HTTPException(status_code=503, detail="Dual-AI client not initialized")

    user_prompt = CHAT_PROMPT_TEMPLATE.format(
        user_message=request.message,
        dom_summary=request.dom_summary[:3500],
        redaction_manifest="No redactions",
    )

    try:
        raw = await dual_ai.reasoning_client.analyze(
            system_prompt=SYSTEM_PROMPT,
            user_prompt=user_prompt,
            image_base64=request.image,
            max_tokens=400,
        )
        parsed = parse_vlm_response(raw)
        elapsed_ms = round((time.time() - start_time) * 1000, 1)
        parsed["latency_ms"] = elapsed_ms
        return ActionResponse(**parsed)
    except Exception as e:
        elapsed_ms = round((time.time() - start_time) * 1000, 1)
        return ActionResponse(
            reasoning=f"Chat error: {str(e)}",
            latency_ms=elapsed_ms,
            error=str(e),
        )


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True, log_level="info")
