"""
VLM Client — Dual-AI Multi-Agent Inference Layer.
Orchestrates two specialized AI agents:
  1. AI-1 (Reasoning & Perception Engine): Visual understanding, page classification, obstacle detection, strategic intent.
  2. AI-2 (Tactical Decision-Making Engine): DOM element mapping, micro-action planning, goal completion verification.

Supports ExperientialLabs (gpt-5.6-luna), OpenAI-compatible backends, and local Ollama.
Includes automatic cross-key rate-limit failover and image optimization.
"""

import asyncio
import base64
import json
import logging
import os
import re
import time
from typing import Optional, Dict, Any, List

from prompts import (
    REASONING_SYSTEM_PROMPT,
    REASONING_USER_PROMPT_TEMPLATE,
    DECISION_SYSTEM_PROMPT,
    DECISION_USER_PROMPT_TEMPLATE,
    SYSTEM_PROMPT,
    USER_PROMPT_TEMPLATE
)

logger = logging.getLogger(__name__)


def _extract_json_from_text(text: str) -> Optional[dict]:
    """Helper to extract and parse JSON from mixed LLM output or markdown blocks."""
    if not text:
        return None
    cleaned = text.strip()

    def _clean_and_parse(s: str) -> Optional[dict]:
        try:
            return json.loads(s)
        except Exception:
            pass
        try:
            # Clean invalid escape sequences (e.g. \[ or \( emitted in CSS selectors) and trailing commas
            s_clean = re.sub(r'\\([^"\\/bfnrtu])', r'\1', s)
            s_clean = re.sub(r",\s*([\]}])", r"\1", s_clean)
            return json.loads(s_clean)
        except Exception:
            pass
        return None

    # 1. Try markdown code block
    block_match = re.search(r"```(?:json)?\s*\n?(.*?)\n?\s*```", cleaned, re.DOTALL)
    if block_match:
        res = _clean_and_parse(block_match.group(1).strip())
        if res is not None:
            return res

    # 2. Try raw outer JSON
    json_match = re.search(r"\{[\s\S]*\}", cleaned)
    if json_match:
        res = _clean_and_parse(json_match.group(0))
        if res is not None:
            return res

    # 3. Direct parse
    return _clean_and_parse(cleaned)


class VLMClient:
    """Single VLM client for inference (OpenAI-compatible or Ollama)."""

    def __init__(
        self,
        backend: str = "openai",
        model: str = "gpt-5.6-luna",
        base_url: str = None,
        api_key: str = None,
        name: str = "VLM",
    ):
        self.backend = (backend or "openai").lower()
        self.model = model or "gpt-5.6-luna"
        self.base_url = base_url
        self.api_key = api_key or "not-needed"
        self.name = name
        self._client = None

        if self.backend == "ollama":
            self._init_ollama()
        else:
            self._init_openai()

    def _init_ollama(self):
        try:
            import ollama
            host = self.base_url or os.getenv("OLLAMA_HOST", "http://localhost:11434")
            self._client = ollama.Client(host=host)
            logger.info(f"[{self.name}] Ollama client initialized: model={self.model}, host={host}")
        except ImportError:
            logger.warning(f"[{self.name}] Ollama package not installed.")
            self._client = None

    def _init_openai(self):
        try:
            from openai import OpenAI
            kwargs = {"api_key": self.api_key, "timeout": 45.0}
            if self.base_url:
                kwargs["base_url"] = self.base_url
            self._client = OpenAI(**kwargs)
            logger.info(f"[{self.name}] OpenAI client initialized: model={self.model}, base_url={self.base_url}")
        except ImportError:
            logger.warning(f"[{self.name}] OpenAI package not installed.")
            self._client = None

    async def analyze(
        self,
        system_prompt: str,
        user_prompt: str,
        image_base64: Optional[str] = None,
        max_tokens: int = 500,
        temperature: float = 0.2,
    ) -> str:
        """Execute multimodal prompt and return raw string response."""
        start_time = time.time()
        if self.backend == "ollama":
            response = await self._call_ollama(system_prompt, user_prompt, image_base64)
        else:
            response = await self._call_openai(system_prompt, user_prompt, image_base64, max_tokens, temperature)

        # Guard: API can return None content when model produces no text
        if not response:
            logger.warning(f"[{self.name}] Model returned empty/None content — using empty fallback.")
            response = "{}"

        elapsed = time.time() - start_time
        logger.info(f"[{self.name}] Inference completed in {elapsed:.2f}s ({len(response)} chars)")
        return response

    async def _call_ollama(self, system_prompt: str, user_prompt: str, image_base64: Optional[str]) -> str:
        if not self._client:
            raise RuntimeError(f"[{self.name}] Ollama client not initialized")

        messages = [{"role": "system", "content": system_prompt}]
        user_msg = {"role": "user", "content": user_prompt}
        if image_base64:
            opt_b64 = self._prepare_ollama_image(image_base64)
            if opt_b64:
                user_msg["images"] = [opt_b64]
        messages.append(user_msg)

        def _sync_call():
            return self._client.chat(
                model=self.model,
                messages=messages,
                options={"temperature": 0.1, "num_predict": 250, "num_ctx": 2048},
            )

        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(None, _sync_call)
        content = response["message"]["content"]
        if not content:
            logger.warning(f"[{self.name}] Ollama returned empty/None content for model={self.model}")
            content = "{}"
        return content

    async def _call_openai(
        self,
        system_prompt: str,
        user_prompt: str,
        image_base64: Optional[str],
        max_tokens: int = 500,
        temperature: float = 0.2,
    ) -> str:
        if not self._client:
            raise RuntimeError(f"[{self.name}] OpenAI client not initialized")

        messages = [{"role": "system", "content": system_prompt}]
        if image_base64:
            opt_url = self._prepare_image_url(image_base64)
            content = [
                {"type": "text", "text": user_prompt},
                {"type": "image_url", "image_url": {"url": opt_url, "detail": "low"}},
            ]
            messages.append({"role": "user", "content": content})
        else:
            messages.append({"role": "user", "content": user_prompt})

        def _sync_call():
            kwargs = {
                "model": self.model,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens,
            }
            return self._client.chat.completions.create(**kwargs)

        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(None, _sync_call)
        # choices[0].message.content can be None if the model produced no text
        content = response.choices[0].message.content
        if content is None:
            logger.warning(f"[{self.name}] API returned None content for model={self.model}. Finish reason: {response.choices[0].finish_reason}")
            content = "{}"
        return content

    def _prepare_image_url(self, image_base64: str) -> str:
        if not image_base64:
            return image_base64
        try:
            from io import BytesIO
            from PIL import Image

            raw_b64 = image_base64
            if "," in raw_b64:
                _, raw_b64 = raw_b64.split(",", 1)

            img_bytes = base64.b64decode(raw_b64)
            img = Image.open(BytesIO(img_bytes))

            # Optimal dimension for fast vision tokenization (768px)
            max_dim = 768
            if img.width > max_dim or img.height > max_dim:
                scale = min(max_dim / img.width, max_dim / img.height)
                new_size = (int(img.width * scale), int(img.height * scale))
                img = img.resize(new_size, Image.Resampling.BILINEAR)

            if img.mode in ("RGBA", "P"):
                img = img.convert("RGB")

            buf = BytesIO()
            img.save(buf, format="JPEG", quality=60, optimize=True)
            compressed_b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
            return f"data:image/jpeg;base64,{compressed_b64}"
        except Exception as e:
            logger.warning(f"[{self.name}] Image optimization skipped: {e}")
            return image_base64 if image_base64.startswith("data:") else f"data:image/jpeg;base64,{image_base64}"

    def _prepare_ollama_image(self, image_base64: str) -> Optional[str]:
        if not image_base64:
            return None
        try:
            from io import BytesIO
            from PIL import Image

            raw_b64 = image_base64
            if "," in raw_b64:
                _, raw_b64 = raw_b64.split(",", 1)

            img_bytes = base64.b64decode(raw_b64)
            img = Image.open(BytesIO(img_bytes))

            max_dim = 512
            if img.width > max_dim or img.height > max_dim:
                scale = min(max_dim / img.width, max_dim / img.height)
                new_size = (int(img.width * scale), int(img.height * scale))
                img = img.resize(new_size, Image.Resampling.BILINEAR)

            if img.mode in ("RGBA", "P"):
                img = img.convert("RGB")

            buf = BytesIO()
            img.save(buf, format="JPEG", quality=50, optimize=True)
            return base64.b64encode(buf.getvalue()).decode("utf-8")
        except Exception:
            if "," in image_base64:
                return image_base64.split(",", 1)[1]
            return image_base64

    def health_check(self) -> dict:
        try:
            if self.backend == "ollama":
                resp = self._client.list()
                models = []
                try:
                    m_list = resp.get("models", []) if isinstance(resp, dict) else getattr(resp, "models", [])
                    for m in m_list:
                        name = m.get("name", m.get("model", "")) if isinstance(m, dict) else getattr(m, "name", getattr(m, "model", ""))
                        models.append(str(name))
                except Exception:
                    models = []
                return {"status": "ok", "backend": "ollama", "model": self.model, "models": models}
            else:
                return {"status": "ok", "backend": self.backend, "model": self.model}
        except Exception as e:
            return {"status": "error", "backend": self.backend, "model": self.model, "error": str(e)}


class DualAIClient:
    """
    Orchestrates the Dual-AI pipeline using the two gpt-5.6-luna API keys:
    - AI-1: Reasoning & Perception Engine (Key 1)
    - AI-2: Tactical Decision-Making Engine (Key 2)
    With automatic cross-key failover if either key encounters a rate limit or outage.
    """

    def __init__(
        self,
        base_url: str = "https://api.experientiallabs.ai/v1",
        reasoning_key: str = None,
        decision_key: str = None,
        reasoning_model: str = "gpt-5.6-luna",
        decision_model: str = "gpt-5.6-luna",
        backend: str = "openai",
    ):
        self.base_url = base_url or os.getenv("VLM_BASE_URL", "https://api.experientiallabs.ai/v1")
        self.backend = backend or os.getenv("VLM_BACKEND", "openai")

        self.reasoning_key = reasoning_key or os.getenv("REASONING_API_KEY") or os.getenv("VLM_API_KEY")
        self.decision_key = decision_key or os.getenv("DECISION_API_KEY") or os.getenv("VLM_API_KEY")

        self.reasoning_model = reasoning_model or os.getenv("REASONING_MODEL", "gpt-5.6-luna")
        self.decision_model = decision_model or os.getenv("DECISION_MODEL", "gpt-5.6-luna")

        # Primary clients
        self.reasoning_client = VLMClient(
            backend=self.backend,
            model=self.reasoning_model,
            base_url=self.base_url,
            api_key=self.reasoning_key,
            name="AI-1 (Reasoning)",
        )

        self.decision_client = VLMClient(
            backend=self.backend,
            model=self.decision_model,
            base_url=self.base_url,
            api_key=self.decision_key,
            name="AI-2 (Decision)",
        )

        # Fallback cross-key clients
        self.reasoning_fallback = VLMClient(
            backend=self.backend,
            model=self.reasoning_model,
            base_url=self.base_url,
            api_key=self.decision_key,
            name="AI-1 (Failover to Key 2)",
        )

        self.decision_fallback = VLMClient(
            backend=self.backend,
            model=self.decision_model,
            base_url=self.base_url,
            api_key=self.reasoning_key,
            name="AI-2 (Failover to Key 1)",
        )

    async def execute_dual_pipeline(
        self,
        user_goal: str,
        dom_summary: str,
        redaction_manifest: str,
        action_history: str,
        image_base64: Optional[str] = None,
    ) -> dict:
        """
        Runs the full 2-stage multi-agent pipeline:
          Stage 1 (AI-1 with Key 1): Visual & Context Reasoning
          Stage 2 (AI-2 with Key 2): Tactical Action Decision
        """
        pipeline_start = time.time()

        # -------------------------------------------------------------
        # STAGE 1: AI-1 (Reasoning Engine)
        # -------------------------------------------------------------
        r_start = time.time()
        reasoning_user_prompt = REASONING_USER_PROMPT_TEMPLATE.format(
            user_goal=user_goal,
            action_history=action_history or "None yet. Starting workflow.",
            dom_summary=dom_summary,
            redaction_manifest=redaction_manifest or "No redactions",
        )

        raw_reasoning = ""
        reasoning_data = {}
        try:
            raw_reasoning = await self.reasoning_client.analyze(
                system_prompt=REASONING_SYSTEM_PROMPT,
                user_prompt=reasoning_user_prompt,
                image_base64=image_base64,
                max_tokens=400,
                temperature=0.2,
            )
            reasoning_data = _extract_json_from_text(raw_reasoning) or {}
        except Exception as e_primary:
            logger.warning(f"AI-1 primary key hit error: {e_primary}. Attempting failover with Key 2...")
            try:
                raw_reasoning = await self.reasoning_fallback.analyze(
                    system_prompt=REASONING_SYSTEM_PROMPT,
                    user_prompt=reasoning_user_prompt,
                    image_base64=image_base64,
                    max_tokens=400,
                    temperature=0.2,
                )
                reasoning_data = _extract_json_from_text(raw_reasoning) or {}
            except Exception as e_fallback:
                logger.error(f"AI-1 reasoning failed on both keys: {e_fallback}")
                reasoning_data = {
                    "page_type": "webpage",
                    "page_summary": "Page loaded. Analyzing actionable elements.",
                    "obstacle": "none",
                    "subgoal": f"Progress towards goal: {user_goal}",
                    "strategic_intent": f"Interact with appropriate elements to achieve: {user_goal}",
                    "is_terminal": False,
                }

        r_latency_ms = round((time.time() - r_start) * 1000, 1)

        # Normalize Stage 1 output
        page_type = reasoning_data.get("page_type", "general_page")
        page_summary = reasoning_data.get("page_summary", "Webpage loaded.")
        obstacle = reasoning_data.get("obstacle", "none")
        subgoal = reasoning_data.get("subgoal", f"Execute next action for: {user_goal}")
        strategic_intent = reasoning_data.get("strategic_intent", subgoal)
        is_terminal = bool(reasoning_data.get("is_terminal", False))

        logger.info(f"🧠 [AI-1 Reasoning] PageType='{page_type}' | Subgoal='{subgoal}' | Terminal={is_terminal} ({r_latency_ms}ms)")

        # Fast terminal exit if AI-1 confirms complete
        if is_terminal:
            total_latency_ms = round((time.time() - pipeline_start) * 1000, 1)
            return {
                "actions": [],
                "reasoning": f"{page_summary} — Goal accomplished.",
                "page_description": page_summary,
                "is_goal_complete": True,
                "confidence": 0.95,
                "warnings": [],
                "telemetry": {
                    "ai_reasoning": {
                        "model": self.reasoning_model,
                        "latency_ms": r_latency_ms,
                        "page_type": page_type,
                        "subgoal": subgoal,
                        "obstacle": obstacle,
                    },
                    "ai_decision": {
                        "model": self.decision_model,
                        "latency_ms": 0.0,
                        "actions_count": 0,
                    },
                    "total_latency_ms": total_latency_ms,
                }
            }

        # ── FAST-PATH: Pure navigation intent — bypass AI-2 ──────────────────
        # If AI-1 sees a simple navigation subgoal (no obstacle, no complex form interaction),
        # skip AI-2 and return the navigate action directly.
        _nav_keywords = ("navigate", "go to", "open ", "visit ", "search for")
        _is_nav_intent = (
            obstacle.lower() in ("none", "", "no obstacle") and
            any(k in subgoal.lower() for k in _nav_keywords) and
            "none yet" in (action_history or "").lower()
        )
        if _is_nav_intent:
            # Extract URL from strategic_intent or subgoal
            import re as _re
            url_match = _re.search(r"https?://[^\s\"']+", strategic_intent + " " + subgoal)
            if url_match:
                nav_url = url_match.group(0).rstrip(".,)")
                total_latency_ms = round((time.time() - pipeline_start) * 1000, 1)
                logger.info(f"⚡ [FAST-PATH] Navigation intent detected — skipping AI-2. URL: {nav_url}")
                return {
                    "actions": [{"type": "navigate", "url": nav_url, "description": f"Navigate to {nav_url}"}],
                    "reasoning": f"[FAST-PATH] {page_summary} — Navigating to start URL.",
                    "page_description": page_summary,
                    "is_goal_complete": False,
                    "confidence": 0.88,
                    "warnings": [],
                    "telemetry": {
                        "ai_reasoning": {"model": self.reasoning_model, "latency_ms": r_latency_ms, "page_type": page_type, "subgoal": subgoal, "obstacle": obstacle},
                        "ai_decision": {"model": "fast_path_bypass", "latency_ms": 0.0, "actions_count": 1},
                        "total_latency_ms": total_latency_ms,
                    }
                }

        # -------------------------------------------------------------
        # STAGE 2: AI-2 (Tactical Decision-Making Engine)
        # -------------------------------------------------------------
        d_start = time.time()
        decision_user_prompt = DECISION_USER_PROMPT_TEMPLATE.format(
            user_goal=user_goal,
            page_type=page_type,
            page_summary=page_summary,
            obstacle=obstacle,
            subgoal=subgoal,
            strategic_intent=strategic_intent,
            is_terminal=is_terminal,
            dom_summary=dom_summary,
            redaction_manifest=redaction_manifest or "No redactions",
            action_history=action_history or "None",
        )

        raw_decision = ""
        decision_data = {}
        try:
            raw_decision = await self.decision_client.analyze(
                system_prompt=DECISION_SYSTEM_PROMPT,
                user_prompt=decision_user_prompt,
                image_base64=None,  # Fast text-only tactical decision
                max_tokens=500,
                temperature=0.15,
            )
            decision_data = _extract_json_from_text(raw_decision) or {}
        except Exception as e_primary:
            logger.warning(f"AI-2 primary key hit error: {e_primary}. Attempting failover with Key 1...")
            try:
                raw_decision = await self.decision_fallback.analyze(
                    system_prompt=DECISION_SYSTEM_PROMPT,
                    user_prompt=decision_user_prompt,
                    image_base64=None,
                    max_tokens=500,
                    temperature=0.15,
                )
                decision_data = _extract_json_from_text(raw_decision) or {}
            except Exception as e_fallback:
                logger.error(f"AI-2 decision failed on both keys: {e_fallback}")
                decision_data = {
                    "actions": [],
                    "decision_rationale": f"Decision error: {e_fallback}",
                    "is_goal_complete": False,
                }

        d_latency_ms = round((time.time() - d_start) * 1000, 1)

        # Extract actions and decision rationale
        actions = decision_data.get("actions", [])
        if not isinstance(actions, list):
            actions = [actions] if actions else []

        decision_rationale = decision_data.get("decision_rationale", f"Action selected for: {subgoal}")
        is_goal_complete = bool(decision_data.get("is_goal_complete", is_terminal))

        total_latency_ms = round((time.time() - pipeline_start) * 1000, 1)
        logger.info(f"🎯 [AI-2 Decision] Actions={len(actions)} | Rationale='{decision_rationale}' ({d_latency_ms}ms)")

        combined_reasoning = f"[AI-1 Reasoning] {page_summary} (Subgoal: {subgoal}). [AI-2 Decision] {decision_rationale}"

        return {
            "actions": actions,
            "reasoning": combined_reasoning,
            "page_description": page_summary,
            "task_complexity": "complex" if len(actions) > 1 or is_terminal else "medium",
            "is_goal_complete": is_goal_complete,
            "confidence": 0.92 if actions or is_goal_complete else 0.5,
            "warnings": [],
            "telemetry": {
                "ai_reasoning": {
                    "model": self.reasoning_model,
                    "latency_ms": r_latency_ms,
                    "page_type": page_type,
                    "subgoal": subgoal,
                    "obstacle": obstacle,
                    "raw_summary": page_summary,
                },
                "ai_decision": {
                    "model": self.decision_model,
                    "latency_ms": d_latency_ms,
                    "rationale": decision_rationale,
                    "actions_count": len(actions),
                },
                "total_latency_ms": total_latency_ms,
            }
        }

    def health_check(self) -> dict:
        r_health = self.reasoning_client.health_check()
        d_health = self.decision_client.health_check()
        return {
            "status": "ok" if r_health.get("status") == "ok" and d_health.get("status") == "ok" else "degraded",
            "backend": self.backend,
            "ai_reasoning": {
                "model": self.reasoning_model,
                "status": r_health.get("status", "unknown"),
            },
            "ai_decision": {
                "model": self.decision_model,
                "status": d_health.get("status", "unknown"),
            }
        }
