"""
VLM Client — Abstraction layer for Vision-Language Model inference.
Supports two backends:
  1. Ollama (default, local) — uses the `ollama` package
  2. OpenAI-compatible API (vLLM, Together AI, Groq) — uses the `openai` package
"""

import base64
import json
import logging
import os
import time
from typing import Optional

logger = logging.getLogger(__name__)


class VLMClient:
    """Unified client for VLM inference across backends."""

    def __init__(
        self,
        backend: str = "ollama",
        model: str = None,
        base_url: str = None,
        api_key: str = None,
    ):
        self.backend = backend.lower()
        self.model = model
        self.base_url = base_url
        self.api_key = api_key
        self._client = None

        if self.backend == "ollama":
            self.model = model or os.getenv("OLLAMA_MODEL", "llava:7b")
            # If base_url was accidentally passed as cloud URL, force OLLAMA_HOST
            is_local = base_url and ("localhost" in base_url or "127.0.0.1" in base_url or "11434" in str(base_url))
            self.base_url = base_url if is_local else os.getenv("OLLAMA_HOST", "http://localhost:11434")
            self._init_ollama()
        elif self.backend in ("openai", "vllm", "together", "groq"):
            self.model = model or os.getenv("VLM_MODEL", "gpt-4o-mini")
            self.base_url = base_url or os.getenv("VLM_BASE_URL")
            self.api_key = api_key or os.getenv("VLM_API_KEY", "not-needed")
            self._init_openai()
        else:
            raise ValueError(f"Unknown backend: {self.backend}")

    def _init_ollama(self):
        """Initialize Ollama client."""
        try:
            import ollama
            self._client = ollama.Client(host=self.base_url)
            logger.info(f"Ollama client initialized: model={self.model}, host={self.base_url}")
        except ImportError:
            logger.warning("Ollama package not installed. Install with: pip install ollama")
            self._client = None

    def _init_openai(self):
        """Initialize OpenAI-compatible client."""
        try:
            from openai import OpenAI
            kwargs = {"api_key": self.api_key, "timeout": 60.0}
            if self.base_url:
                kwargs["base_url"] = self.base_url
            self._client = OpenAI(**kwargs)
            logger.info(f"OpenAI client initialized: model={self.model}, base_url={self.base_url}")
        except ImportError:
            logger.warning("OpenAI package not installed. Install with: pip install openai")
            self._client = None

    async def analyze(
        self,
        system_prompt: str,
        user_prompt: str,
        image_base64: Optional[str] = None,
    ) -> str:
        """
        Send a multimodal prompt (text + optional image) to the VLM.
        Returns the raw text response.
        """
        start_time = time.time()

        try:
            if self.backend == "ollama":
                response = await self._call_ollama(system_prompt, user_prompt, image_base64)
            else:
                response = await self._call_openai(system_prompt, user_prompt, image_base64)

            elapsed = time.time() - start_time
            logger.info(f"VLM inference completed in {elapsed:.2f}s ({len(response)} chars)")
            return response

        except Exception as e:
            elapsed = time.time() - start_time
            logger.error(f"VLM inference failed after {elapsed:.2f}s: {e}")
            raise

    async def _call_ollama(self, system_prompt: str, user_prompt: str, image_base64: Optional[str]) -> str:
        """Call Ollama API with bounded context and prediction tokens for maximum speed."""
        import asyncio

        if not self._client:
            raise RuntimeError("Ollama client not initialized")

        messages = [
            {"role": "system", "content": system_prompt},
        ]

        # Build user message with downscaled image
        user_msg = {"role": "user", "content": user_prompt}
        if image_base64:
            optimized_b64 = self._prepare_ollama_image(image_base64)
            if optimized_b64:
                user_msg["images"] = [optimized_b64]

        messages.append(user_msg)

        # Run synchronous Ollama call in thread pool with tight context window
        def _sync_call():
            return self._client.chat(
                model=self.model,
                messages=messages,
                options={
                    "temperature": 0.1,
                    "num_predict": 160,
                    "num_ctx": 2048,
                },
            )

        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(None, _sync_call)
        return response["message"]["content"]

    async def _call_openai(self, system_prompt: str, user_prompt: str, image_base64: Optional[str]) -> str:
        """Call OpenAI-compatible API (works with vLLM, Together, Groq, Gemini, etc.)."""
        import asyncio

        if not self._client:
            raise RuntimeError("OpenAI client not initialized")

        messages = [
            {"role": "system", "content": system_prompt},
        ]

        # Build user message with optional image
        if image_base64:
            optimized_image_url = self._prepare_image_url(image_base64)
            content = [
                {"type": "text", "text": user_prompt},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": optimized_image_url,
                        "detail": "low",
                    },
                },
            ]
            messages.append({"role": "user", "content": content})
        else:
            messages.append({"role": "user", "content": user_prompt})

        def _sync_call():
            kwargs = dict(
                model=self.model,
                messages=messages,
                temperature=0.2,
                max_tokens=600,
            )
            # Gemini supports response_format for JSON
            try:
                kwargs["response_format"] = {"type": "json_object"}
            except Exception:
                pass
            return self._client.chat.completions.create(**kwargs)

        # Retry with exponential backoff (handles 503 / rate limits)
        max_retries = 3
        last_error = None
        for attempt in range(max_retries):
            try:
                loop = asyncio.get_event_loop()
                response = await loop.run_in_executor(None, _sync_call)
                return response.choices[0].message.content
            except Exception as e:
                last_error = e
                error_str = str(e)
                # Retry on 503 (overloaded) or 429 (rate limit)
                if "503" in error_str or "429" in error_str or "overloaded" in error_str.lower():
                    wait_time = (2 ** attempt) * 2  # 2s, 4s, 8s
                    logger.warning(f"VLM call failed (attempt {attempt+1}/{max_retries}), retrying in {wait_time}s: {e}")
                    await asyncio.sleep(wait_time)
                    continue
                raise  # Non-retryable error
        raise last_error  # All retries failed

    def _prepare_image_url(self, image_base64: str) -> str:
        """Format and aggressively downscale image to optimize VLM latency and token overhead."""
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

            # Fast downscale: Max dimension 768px for lightning-fast vision tokenization
            max_dim = 768
            if img.width > max_dim or img.height > max_dim:
                scale = min(max_dim / img.width, max_dim / img.height)
                new_size = (int(img.width * scale), int(img.height * scale))
                img = img.resize(new_size, Image.Resampling.BILINEAR)

            if img.mode in ("RGBA", "P"):
                img = img.convert("RGB")

            buf = BytesIO()
            img.save(buf, format="JPEG", quality=55, optimize=True)
            compressed_b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
            return f"data:image/jpeg;base64,{compressed_b64}"
        except Exception as e:
            logger.warning(f"Image optimization skipped: {e}")
            return image_base64 if image_base64.startswith("data:") else f"data:image/jpeg;base64,{image_base64}"

    def _prepare_ollama_image(self, image_base64: str) -> Optional[str]:
        """Format and downscale image specifically for Ollama local VRAM limits (max 512px)."""
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

            # Fast downscale: Max dimension 512px for low VRAM consumption on 4GB GPUs
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
        except Exception as e:
            logger.warning(f"Ollama image preparation skipped: {e}")
            if "," in image_base64:
                return image_base64.split(",", 1)[1]
            return image_base64

    def health_check(self) -> dict:
        """Check if the VLM backend is reachable."""
        try:
            if self.backend == "ollama":
                resp = self._client.list()
                # Handle both old dict format and newer object format
                available = []
                try:
                    model_list = resp.get("models", []) if isinstance(resp, dict) else getattr(resp, "models", [])
                    for m in model_list:
                        name = m.get("name", m.get("model", "")) if isinstance(m, dict) else getattr(m, "name", getattr(m, "model", ""))
                        available.append(str(name))
                except Exception:
                    available = []
                return {
                    "status": "ok",
                    "backend": "ollama",
                    "model": self.model,
                    "available_models": available,
                    "model_loaded": any(self.model in m for m in available),
                }
            else:
                # OpenAI-compatible: try listing models
                models = self._client.models.list()
                return {
                    "status": "ok",
                    "backend": self.backend,
                    "model": self.model,
                }
        except Exception as e:
            return {
                "status": "error",
                "backend": self.backend,
                "model": self.model,
                "error": str(e),
            }
