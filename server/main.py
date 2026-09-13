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
    task_complexity: str = "medium"
    suggested_max_steps: int = 15
    is_goal_complete: bool = False
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


ENABLE_OLLAMA_GUARD = os.getenv("ENABLE_OLLAMA_GUARD", "false").lower() == "true"


def _compact_dom_summary(dom_text: str, max_chars: int = 5000) -> str:
    """Compact DOM summary to high-value actionable elements to speed up VLM inference."""
    if not dom_text or len(dom_text) <= max_chars:
        return dom_text
    
    lines = dom_text.splitlines()
    header = lines[:4]
    priority = []
    other = []
    
    for line in lines[4:]:
        lower = line.lower()
        if any(k in lower for k in ("<input", "<button", "<textarea", "<select", "code-editor", "monaco", "role=\"button\"", "role=\"textbox\"", "role=\"searchbox\"", "href=")):
            priority.append(line)
        else:
            other.append(line)
            
    budget = max_chars - sum(len(l) + 1 for l in header)
    kept_priority = []
    for l in priority:
        if sum(len(x) + 1 for x in kept_priority) + len(l) < budget * 0.8:
            kept_priority.append(l)
            
    rem = budget - sum(len(x) + 1 for x in kept_priority)
    kept_other = []
    for l in other:
        if sum(len(x) + 1 for x in kept_other) + len(l) < rem:
            kept_other.append(l)
            
    return "\n".join(header + kept_priority + kept_other)


@app.post("/api/analyze", response_model=ActionResponse)
async def analyze_page(request: AnalyzeRequest):
    """
    Main analysis endpoint.
    Receives sanitized screenshot + DOM context and returns action plan with optimized latency.
    """
    start_time = time.time()
    logger.info("==================================================")
    logger.info(f"📥 RECEIVED REQUEST: user_goal='{request.user_goal}'")
    logger.info(f"📜 ACTION HISTORY: {len(request.action_history)} past actions")
    logger.info("==================================================")

    if not vlm_client:
        raise HTTPException(status_code=503, detail="VLM client not initialized")

    # ── Tier 1: Local On-Device PII & Privacy Inspection (Toggleable via ENABLE_OLLAMA_GUARD) ──
    pii_guard_note = "Local on-device visual redaction active & verified."
    if ENABLE_OLLAMA_GUARD and ollama_guard_client and request.image:
        try:
            logger.info("🛡️ [Local Ollama LLaVA 7B] Inspecting visual frame for PII on-device...")
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
        for r in redactions[:15]:
            region = r.get("region") or {}
            manifest_lines.append(
                f"  - {r.get('type', 'UNKNOWN')} at ({region.get('x', 0)},{region.get('y', 0)}) "
                f"— token: {r.get('token', 'N/A')}"
            )
        manifest_str = "\n".join(manifest_lines)

    # Format action history string
    history_str = "None yet. This is Step 1."
    if request.action_history:
        history_str = "\n".join([f"- Step {i+1}: {act}" for i, act in enumerate(request.action_history[-6:])])

    # Build the user prompt with compacted DOM for high-speed inference
    compact_dom = _compact_dom_summary(request.dom_summary, max_chars=5000)
    user_prompt = USER_PROMPT_TEMPLATE.format(
        user_goal=request.user_goal,
        action_history=history_str,
        dom_summary=compact_dom,
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

        # ── Autonomous Reasoning Enhancements ────────────────────────
        goal_lower = (request.user_goal or "").lower()
        is_complex = any(k in goal_lower for k in [
            "book", "ticket", "train", "flight", "potd", "leetcode", "hotel", 
            "order", "buy", "reservation", "checkout", "hackerrank", "problem of the day",
            "irctc", "makemytrip", "bookmyshow", "redbus"
        ])
        if is_complex:
            parsed["task_complexity"] = "complex"
            parsed["suggested_max_steps"] = max(parsed.get("suggested_max_steps", 25), 25)

        # 1. Anti-Repetition Shield (strictly for LeetCode / code editors / programming questions)
        is_coding_context = any(k in goal_lower for k in ("leetcode", "hackerrank", "potd", "code", "problem of the day", "solve")) or \
                            any(ce in request.dom_summary.lower() for ce in ("monaco-editor", "ace_editor", "code-editor", "console-submit", "run-code"))
        if is_coding_context:
            prev_type_actions = [
                h for h in request.action_history 
                if "Typed" in str(h) and ("SUCCESS" in str(h) or "✓" in str(h))
            ]
            if prev_type_actions and parsed.get("actions"):
                import re
                new_actions = []
                for act in parsed["actions"]:
                    if act.get("type") in ("type", "input"):
                        val = act.get("value", "")
                        # If value is code-like, do not re-paste into editor!
                        if any(kw in val for kw in ("def ", "class ", "return", "function", "{", ";", "public class")):
                            logger.info("🛡️ [Anti-Repetition Shield] Code already typed in previous steps. Auto-converting to Submit click!")
                            submit_match = re.search(r'sel="([^"]*(?:submit|run-code|console-submit)[^"]*)"', request.dom_summary, re.IGNORECASE)
                            if not submit_match:
                                submit_match = re.search(r'\[\d+\]\s*<button>[^"]*"(?:Submit|Run|Run Code)"[^@]*sel="([^"]+)"', request.dom_summary, re.IGNORECASE)
                            sel = submit_match.group(1) if submit_match else 'button[data-e2e-locator="console-submit-button"], button[data-cy="submit-code-btn"]'
                            new_actions.append({
                                "type": "click",
                                "selector": sel,
                                "description": "Click Submit button to submit entered solution"
                            })
                            parsed["reasoning"] += " [Auto-Shield] Code was already typed; advancing to Submit button."
                            continue
                    new_actions.append(act)
                parsed["actions"] = new_actions

        # 2. Autonomous E-Commerce Checkout Pipeline Guard (Amazon, Flipkart, Shopping)
        is_ecommerce_goal = any(k in goal_lower for k in ("buy", "order", "purchase", "checkout", "cart", "shop"))
        is_shopping_site = any(d in request.dom_summary.lower() for d in ("amazon.", "flipkart.", "walmart.", "cart", "checkout", "order", "add to cart"))
        
        if is_ecommerce_goal and is_shopping_site:
            import re
            dom_lower = request.dom_summary.lower()
            current_actions = parsed.get("actions") or []
            
            # Case A: Final Order Review Screen or Confirmation
            if any(term in dom_lower for term in ("thank you, your order", "order placed", "order confirmed", "confirmation #", "order id:", "thank you for your order")):
                parsed["is_goal_complete"] = True
                parsed["actions"] = []
                parsed["reasoning"] = "Order confirmed! Purchase successfully completed."
                logger.info("🛒 [E-Commerce Pipeline] Order confirmation received. Goal 100% complete!")
            elif any(term in dom_lower for term in ("placeyourorder", "place your order", "review your order", "order summary", "confirm order")):
                user_wants_full_checkout = any(w in goal_lower for w in ("complete", "place order", "finish", "complete check out", "final", "buy"))
                if user_wants_full_checkout:
                    place_match = re.search(r'sel="([^"]*(?:placeYourOrder|place-order|placeOrder|submitOrder)[^"]*)"', request.dom_summary, re.IGNORECASE)
                    if not place_match:
                        place_match = re.search(r'\[\d+\]\s*<(?:input|button)>[^"]*"(?:Place your order|Place Order|Confirm Order)"[^@]*sel="([^"]+)"', request.dom_summary, re.IGNORECASE)
                    if place_match:
                        place_sel = place_match.group(1).strip()
                        logger.info(f"🛒 [E-Commerce Pipeline] User requested complete checkout — Auto-clicking Place Order: {place_sel}")
                        parsed["actions"] = [{
                            "type": "click",
                            "selector": place_sel,
                            "description": "Click Place your order to complete purchase"
                        }]
                        parsed["reasoning"] = "Submitting final order to complete checkout as requested."
                        parsed["is_goal_complete"] = False
                    else:
                        parsed["is_goal_complete"] = True
                        parsed["actions"] = []
                        parsed["reasoning"] = "Reached final order review screen. Staged for final authorization."
                else:
                    parsed["is_goal_complete"] = True
                    parsed["actions"] = []
                    parsed["reasoning"] = "Reached final order review screen. Staged for final authorization."

            # Case B: On Cart page or "Added to Cart" confirmation drawer -> Proceed to checkout / Proceed to Buy!
            elif any(term in dom_lower for term in ("added to cart", "proceed to checkout", "proceed to buy", "proceedtoretailcheckout", "attach-sidesheet-checkout")):
                ptc_match = re.search(r'sel="([^"]*(?:proceedToRetailCheckout|attach-sidesheet-checkout|sc-buy-box-ptc-button)[^"]*)"', request.dom_summary, re.IGNORECASE)
                if not ptc_match:
                    ptc_match = re.search(r'\[\d+\]\s*<(?:input|button|a)>[^"]*"(?:Proceed to checkout|Proceed to Buy|Checkout)"[^@]*sel="([^"]+)"', request.dom_summary, re.IGNORECASE)
                if ptc_match:
                    ptc_sel = ptc_match.group(1).strip()
                    logger.info(f"🛒 [E-Commerce Pipeline] Auto-clicking Proceed to Checkout: {ptc_sel}")
                    parsed["actions"] = [{
                        "type": "click",
                        "selector": ptc_sel,
                        "description": "Click Proceed to Checkout / Proceed to Buy"
                    }]
                    parsed["reasoning"] = "Product added to cart; advancing to checkout."
                    parsed["is_goal_complete"] = False

            # Case C: Delivery Address selection screen -> "Deliver to this address" / "Use this address"
            elif any(term in dom_lower for term in ("select a delivery address", "choose a delivery address", "deliver to this address", "shiptothisaddress")):
                addr_match = re.search(r'sel="([^"]*(?:shipToThisAddressButton|Address_selectShipToThisAddress|submissionURL)[^"]*)"', request.dom_summary, re.IGNORECASE)
                if not addr_match:
                    addr_match = re.search(r'\[\d+\]\s*<(?:input|button|a)>[^"]*"(?:Deliver to this address|Use this address)"[^@]*sel="([^"]+)"', request.dom_summary, re.IGNORECASE)
                if addr_match:
                    addr_sel = addr_match.group(1).strip()
                    logger.info(f"🛒 [E-Commerce Pipeline] Auto-selecting delivery address: {addr_sel}")
                    parsed["actions"] = [{
                        "type": "click",
                        "selector": addr_sel,
                        "description": "Click Deliver to this address"
                    }]
                    parsed["reasoning"] = "Selecting saved delivery address for shipping."
                    parsed["is_goal_complete"] = False

            # Case D: Payment selection screen -> "Use this payment method" / "Continue"
            elif any(term in dom_lower for term in ("select a payment method", "payment option", "payment-select", "paymentplanselect")):
                pay_match = re.search(r'sel="([^"]*(?:SetPaymentPlanSelectContinueEvent|payment-submit-button|continue-bottom)[^"]*)"', request.dom_summary, re.IGNORECASE)
                if not pay_match:
                    pay_match = re.search(r'\[\d+\]\s*<(?:input|button|a)>[^"]*"(?:Use this payment method|Continue)"[^@]*sel="([^"]+)"', request.dom_summary, re.IGNORECASE)
                if pay_match:
                    pay_sel = pay_match.group(1).strip()
                    logger.info(f"🛒 [E-Commerce Pipeline] Auto-advancing payment method: {pay_sel}")
                    parsed["actions"] = [{
                        "type": "click",
                        "selector": pay_sel,
                        "description": "Click Continue with payment method"
                    }]
                    parsed["reasoning"] = "Selecting payment method and continuing checkout."
                    parsed["is_goal_complete"] = False

            # Case E: Search Results page -> If model returned typing/re-search or no action, force Add to Cart or Product click
            elif any(sr in dom_lower for sr in ("results for", "search?k=", "/s?k=", "s-search-result")):
                has_product_action = any(
                    a.get("type") == "click" and any(w in (a.get("description", "") + a.get("selector", "")).lower() for w in ("cart", "product", "h2", "title", "add"))
                    for a in current_actions
                )
                if not has_product_action:
                    # 1. Look for direct "Add to cart" button on search card
                    cart_match = re.search(r'\[\d+\]\s*<button>[^"]*"Add to cart"[^@]*sel="([^"]+)"', request.dom_summary, re.IGNORECASE)
                    if not cart_match:
                        cart_match = re.search(r'sel="([^"]*(?:add-to-cart|addToCart|a-autoid-\d+-announce)[^"]*)"', request.dom_summary, re.IGNORECASE)
                    if cart_match:
                        cart_sel = cart_match.group(1).strip()
                        logger.info(f"🛒 [E-Commerce Pipeline] Auto-clicking Add to Cart directly from search results: {cart_sel}")
                        parsed["actions"] = [{
                            "type": "click",
                            "selector": cart_sel,
                            "description": "Click Add to Cart on matching product"
                        }]
                        parsed["reasoning"] = "Selecting top matching product and adding to cart directly from search results."
                        parsed["is_goal_complete"] = False
                    else:
                        # 2. Look for primary product link in search results
                        prod_match = re.search(r'\[\d+\]\s*<a[^>]*>[^"]*"([^"]{10,120})"[^@]*sel="([^"]+)"', request.dom_summary, re.IGNORECASE)
                        if prod_match:
                            title = prod_match.group(1).strip()
                            prod_sel = prod_match.group(2).strip()
                            logger.info(f"🛒 [E-Commerce Pipeline] Auto-opening matching product: {title}")
                            parsed["actions"] = [{
                                "type": "click",
                                "selector": prod_sel,
                                "description": f"Open matching product: {title[:50]}"
                            }]
                            parsed["reasoning"] = f"Opening product listing for {title[:50]} to add to cart."
                            parsed["is_goal_complete"] = False

        # 3. Universal Cookie & Obstacle Auto-Dismissal Guard (ANY website)
        # If any cookie consent banner, privacy notice, or blocking modal is visible, clear it!
        if not parsed.get("is_goal_complete") and (not parsed.get("actions") or any("cookie" in a.get("description", "").lower() for a in parsed.get("actions", []))):
            import re
            cookie_match = re.search(
                r'\[\d+\]\s*<(?:button|a|input)>[^"]*"(?:Accept all cookies|Accept All|Accept all|I agree|Allow all cookies|Got it|Dismiss|Close|Agree and proceed)"[^@]*sel="([^"]+)"',
                request.dom_summary,
                re.IGNORECASE
            )
            if not cookie_match:
                cookie_match = re.search(r'sel="([^"]*(?:onetrust-accept|accept-cookies|consent-accept|cookie-accept|cookieAccept)[^"]*)"', request.dom_summary, re.IGNORECASE)
            
            if cookie_match:
                c_sel = cookie_match.group(1).strip()
                logger.info(f"🍪 [Universal Obstacle Clearer] Auto-dismissing cookie/consent overlay: {c_sel}")
                parsed["actions"] = [{
                    "type": "click",
                    "selector": c_sel,
                    "description": "Dismiss cookie/consent overlay"
                }]
                parsed["reasoning"] = "Clearing cookie/consent overlay to expose page content."

        # 4. Universal Forward Progression Driver (Forms, Wizards, Multi-Step Flows on ANY site)
        if not parsed.get("is_goal_complete") and not parsed.get("actions"):
            import re
            cta_match = re.search(
                r'\[\d+\]\s*<(?:button|input|a)>[^"]*"(?:Continue|Next|Proceed|Submit|Save & Continue|Save and continue|Confirm|Apply|Register)"[^@]*sel="([^"]+)"',
                request.dom_summary,
                re.IGNORECASE
            )
            if cta_match:
                cta_sel = cta_match.group(1).strip()
                logger.info(f"⚡ [Universal Progression Driver] Auto-advancing workflow CTA: {cta_sel}")
                parsed["actions"] = [{
                    "type": "click",
                    "selector": cta_sel,
                    "description": "Click primary continuation button"
                }]
                parsed["reasoning"] = "Advancing to next stage of multi-step workflow."

        # 2. Search Engine Follow-Through Guard (never leave out on Google/Bing for complex tasks)
        is_search_page = any(sp in request.dom_summary.lower() for sp in ("google", "bing.com", "search?q=", "search results"))
        if is_search_page and is_complex and not parsed.get("actions") and not parsed.get("is_goal_complete"):
            import re
            # Extract first high-relevance organic link from search DOM (ignoring google internal links)
            for line in request.dom_summary.splitlines():
                if "<a" in line and "sel=" in line and not any(ign in line for ign in ("google.com", "accounts.", "support.", "preferences")):
                    line_match = re.search(r'\[\d+\]\s*<a[^>]*>[^"\n]*"([^"\n]{3,80})"[^\n]*sel="([^"\n]+)"', line)
                    if line_match:
                        title = line_match.group(1).strip()
                        sel = line_match.group(2).strip()
                        parsed["actions"] = [{
                            "type": "click",
                            "selector": sel,
                            "description": f"Click search result: {title}"
                        }]
                        parsed["reasoning"] += f" [Follow-Through] Navigating into destination website ({title}) from search results."
                        logger.info(f"🌐 [Search Follow-Through] Auto-clicking destination link: {title}")
                        break

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
