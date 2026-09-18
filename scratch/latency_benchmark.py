"""
latency_benchmark.py - PrivacyVision Dual-AI Latency Profiler
==============================================================
Measures real-world inference latency for:
  * AI-1 (Reasoning Engine  - Key 1 / REASONING_API_KEY)
  * AI-2 (Decision Engine   - Key 2 / DECISION_API_KEY)
  * Local PrivacyVision server  (http://localhost:8000)
  * Ollama (optional, if ENABLE_OLLAMA_GUARD=true)

Usage:
    cd e:\\SIH\\server
    python ../scratch/latency_benchmark.py

    # Run more samples for stable percentiles
    python ../scratch/latency_benchmark.py --runs 10

    # Also benchmark the local server /api/analyze endpoint
    python ../scratch/latency_benchmark.py --server

    # Benchmark a single key only
    python ../scratch/latency_benchmark.py --only ai1

Requirements:
    pip install openai python-dotenv requests
"""

import argparse
import os
import statistics
import sys
import time
from pathlib import Path
from typing import Optional

# ── Load .env from server/ directory ─────────────────────────────────
_script_dir = Path(__file__).resolve().parent          # scratch/
_root_dir   = _script_dir.parent                       # SIH/
_server_dir = _root_dir / "server"                     # SIH/server/

try:
    from dotenv import load_dotenv
    load_dotenv(_server_dir / ".env")
except ImportError:
    print("⚠  python-dotenv not installed. Reading os.environ only.")

# ── Config from env ───────────────────────────────────────────────────
BASE_URL          = os.getenv("VLM_BASE_URL",      "https://api.experientiallabs.ai/v1")
REASONING_KEY     = os.getenv("REASONING_API_KEY") or os.getenv("VLM_API_KEY", "")
DECISION_KEY      = os.getenv("DECISION_API_KEY")  or os.getenv("VLM_API_KEY", "")
REASONING_MODEL   = os.getenv("REASONING_MODEL",   "gpt-5.6-luna")
DECISION_MODEL    = os.getenv("DECISION_MODEL",    "gpt-5.6-luna")
OLLAMA_HOST       = os.getenv("OLLAMA_HOST",       "http://localhost:11434")
OLLAMA_MODEL      = os.getenv("OLLAMA_MODEL",      "llava:7b")
ENABLE_OLLAMA     = os.getenv("ENABLE_OLLAMA_GUARD", "false").lower() == "true"
SERVER_PORT       = os.getenv("PORT",               "8000")
SERVER_URL        = f"http://localhost:{SERVER_PORT}"

# ── ANSI colours ──────────────────────────────────────────────────────
GREEN  = "\033[92m"
YELLOW = "\033[93m"
RED    = "\033[91m"
CYAN   = "\033[96m"
BOLD   = "\033[1m"
DIM    = "\033[2m"
RESET  = "\033[0m"

# ── Small test prompts (non-sensitive) ────────────────────────────────
REASONING_TEST_PROMPT = (
    "You are a browser page classifier. The page shows a simple search results page. "
    "Respond ONLY with compact JSON: "
    '{"page_type":"search_results","page_summary":"Google search page","obstacle":"none",'
    '"subgoal":"Click first result","strategic_intent":"Navigate to target","is_terminal":false}'
)

DECISION_TEST_PROMPT = (
    "Given page_type=search_results, subgoal=Click first result, "
    "DOM has one clickable link with selector='a#first-result'. "
    "Respond ONLY with compact JSON: "
    '{"actions":[{"type":"click","selector":"a#first-result","description":"Click first result"}],'
    '"decision_rationale":"Click the first search result","is_goal_complete":false}'
)


# ─────────────────────────────────────────────────────────────────────
# Core timing helper
# ─────────────────────────────────────────────────────────────────────
def _ping_openai(
    api_key: str,
    model: str,
    base_url: str,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int = 80,
    label: str = "AI",
) -> dict:
    """
    Send one inference call and return timing data.
    Returns dict with keys: latency_ms, tokens_out, chars_out, error
    """
    try:
        from openai import OpenAI
    except ImportError:
        return {"error": "openai package not installed. Run: pip install openai"}

    client = OpenAI(api_key=api_key, base_url=base_url, timeout=60.0)

    t0 = time.perf_counter()
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": user_prompt},
            ],
            max_tokens=max_tokens,
            temperature=0.1,
        )
        elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)
        content    = resp.choices[0].message.content or ""
        tokens_out = resp.usage.completion_tokens if resp.usage else len(content.split())
        return {
            "latency_ms": elapsed_ms,
            "tokens_out": tokens_out,
            "chars_out":  len(content),
            "content_preview": content[:80].replace("\n", " "),
            "error": None,
        }
    except Exception as e:
        elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)
        return {
            "latency_ms": elapsed_ms,
            "tokens_out": 0,
            "chars_out":  0,
            "content_preview": "",
            "error": str(e),
        }


def _ping_server(endpoint: str = "/health") -> dict:
    """Ping the local FastAPI server."""
    try:
        import requests
        t0 = time.perf_counter()
        r  = requests.get(f"{SERVER_URL}{endpoint}", timeout=10)
        elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)
        return {"latency_ms": elapsed_ms, "status_code": r.status_code, "error": None}
    except Exception as e:
        return {"latency_ms": None, "status_code": None, "error": str(e)}


def _ping_ollama() -> dict:
    """Ping local Ollama with a tiny inference call."""
    try:
        import ollama as ol
        client = ol.Client(host=OLLAMA_HOST)
        t0 = time.perf_counter()
        resp = client.chat(
            model=OLLAMA_MODEL,
            messages=[{"role": "user", "content": "Reply with the word OK only."}],
            options={"num_predict": 5, "temperature": 0},
        )
        elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)
        return {"latency_ms": elapsed_ms, "response": resp["message"]["content"], "error": None}
    except Exception as e:
        return {"latency_ms": None, "error": str(e)}


# ─────────────────────────────────────────────────────────────────────
# Stats helpers
# ─────────────────────────────────────────────────────────────────────
def _percentile(data: list, pct: float) -> float:
    if not data:
        return 0.0
    sorted_data = sorted(data)
    idx = (pct / 100) * (len(sorted_data) - 1)
    lo, hi = int(idx), min(int(idx) + 1, len(sorted_data) - 1)
    return round(sorted_data[lo] + (sorted_data[hi] - sorted_data[lo]) * (idx - lo), 1)


def _colour_latency(ms: Optional[float]) -> str:
    if ms is None:
        return f"{RED}TIMEOUT{RESET}"
    if ms < 1000:
        return f"{GREEN}{ms}ms{RESET}"
    if ms < 3000:
        return f"{YELLOW}{ms}ms{RESET}"
    return f"{RED}{ms}ms{RESET}"


def _bar(ms: Optional[float], max_ms: float = 8000, width: int = 30) -> str:
    if ms is None:
        return "[" + " " * width + "]"
    filled = max(1, min(width, round((ms / max_ms) * width)))
    colour = GREEN if ms < 1000 else (YELLOW if ms < 3000 else RED)
    return f"[{colour}{'#' * filled}{RESET}{'.' * (width - filled)}]"


# ─────────────────────────────────────────────────────────────────────
# Benchmark runner
# ─────────────────────────────────────────────────────────────────────
def run_benchmark(runs: int = 5, include_server: bool = False, only: Optional[str] = None):
    print(f"\n{BOLD}{CYAN}{'='*65}{RESET}")
    print(f"{BOLD}{CYAN}  PrivacyVision - Dual-AI Latency Benchmark{RESET}")
    print(f"{BOLD}{CYAN}{'='*65}{RESET}")
    print(f"{DIM}  Base URL : {BASE_URL}")
    print(f"  AI-1 key : {REASONING_KEY[:18]}... ({REASONING_MODEL})")
    print(f"  AI-2 key : {DECISION_KEY[:18]}... ({DECISION_MODEL})")
    print(f"  Samples  : {runs} run(s) per model{RESET}")
    print()

    results = {}

    # ── AI-1 Reasoning Engine ─────────────────────────────────────────
    if only in (None, "ai1"):
        print(f"{BOLD}[1/3] AI-1 — Reasoning Engine (Key 1 · {REASONING_MODEL}){RESET}")
        latencies = []
        for i in range(runs):
            sys.stdout.write(f"  Run {i+1}/{runs} ... ")
            sys.stdout.flush()
            r = _ping_openai(
                api_key=REASONING_KEY,
                model=REASONING_MODEL,
                base_url=BASE_URL,
                system_prompt="You are a browser page classifier. Always reply with compact JSON only.",
                user_prompt=REASONING_TEST_PROMPT,
                max_tokens=80,
                label="AI-1",
            )
            if r["error"]:
                print(f"{RED}ERROR: {r['error']}{RESET}")
            else:
                latencies.append(r["latency_ms"])
                tok_rate = round(r["tokens_out"] / (r["latency_ms"] / 1000), 1) if r["latency_ms"] > 0 else 0
                print(f"{_colour_latency(r['latency_ms'])}  {DIM}{r['tokens_out']} tok · {tok_rate} tok/s · \"{r['content_preview'][:50]}\"{RESET}")
            time.sleep(0.3)

        results["ai1"] = latencies
        if latencies:
            print(f"\n  {BOLD}AI-1 Summary:{RESET}")
            print(f"    Min    : {_colour_latency(min(latencies))}")
            print(f"    Avg    : {_colour_latency(round(statistics.mean(latencies), 1))}")
            print(f"    p50    : {_colour_latency(_percentile(latencies, 50))}")
            print(f"    p95    : {_colour_latency(_percentile(latencies, 95))}")
            print(f"    Max    : {_colour_latency(max(latencies))}")
            print(f"    Bar    : {_bar(statistics.mean(latencies))}")
        print()

    # ── AI-2 Decision Engine ──────────────────────────────────────────
    if only in (None, "ai2"):
        print(f"{BOLD}[2/3] AI-2 — Decision Engine (Key 2 · {DECISION_MODEL}){RESET}")
        latencies = []
        for i in range(runs):
            sys.stdout.write(f"  Run {i+1}/{runs} ... ")
            sys.stdout.flush()
            r = _ping_openai(
                api_key=DECISION_KEY,
                model=DECISION_MODEL,
                base_url=BASE_URL,
                system_prompt="You are a browser action planner. Always reply with compact JSON only.",
                user_prompt=DECISION_TEST_PROMPT,
                max_tokens=80,
                label="AI-2",
            )
            if r["error"]:
                print(f"{RED}ERROR: {r['error']}{RESET}")
            else:
                latencies.append(r["latency_ms"])
                tok_rate = round(r["tokens_out"] / (r["latency_ms"] / 1000), 1) if r["latency_ms"] > 0 else 0
                print(f"{_colour_latency(r['latency_ms'])}  {DIM}{r['tokens_out']} tok · {tok_rate} tok/s · \"{r['content_preview'][:50]}\"{RESET}")
            time.sleep(0.3)

        results["ai2"] = latencies
        if latencies:
            print(f"\n  {BOLD}AI-2 Summary:{RESET}")
            print(f"    Min    : {_colour_latency(min(latencies))}")
            print(f"    Avg    : {_colour_latency(round(statistics.mean(latencies), 1))}")
            print(f"    p50    : {_colour_latency(_percentile(latencies, 50))}")
            print(f"    p95    : {_colour_latency(_percentile(latencies, 95))}")
            print(f"    Max    : {_colour_latency(max(latencies))}")
            print(f"    Bar    : {_bar(statistics.mean(latencies))}")
        print()

    # ── Local PrivacyVision Server ────────────────────────────────────
    if include_server or only == "server":
        print(f"{BOLD}[3/3] Local PrivacyVision Server ({SERVER_URL}){RESET}")
        latencies = []
        for i in range(runs):
            sys.stdout.write(f"  Run {i+1}/{runs} ... ")
            sys.stdout.flush()
            r = _ping_server("/health")
            if r["error"]:
                print(f"{RED}OFFLINE — {r['error']}{RESET}")
            else:
                latencies.append(r["latency_ms"])
                print(f"{_colour_latency(r['latency_ms'])}  {DIM}HTTP {r['status_code']}{RESET}")
            time.sleep(0.1)

        results["server"] = latencies
        if latencies:
            print(f"\n  {BOLD}Server Summary:{RESET}")
            print(f"    Min    : {_colour_latency(min(latencies))}")
            print(f"    Avg    : {_colour_latency(round(statistics.mean(latencies), 1))}")
            print(f"    p95    : {_colour_latency(_percentile(latencies, 95))}")
            print(f"    Bar    : {_bar(statistics.mean(latencies), max_ms=500)}")
        elif not latencies:
            print(f"  {YELLOW}Server not reachable — is 'uvicorn main:app' running?{RESET}")
        print()

    # -- Ollama (always runs when --only ollama; otherwise only if ENABLE_OLLAMA_GUARD=true) ------
    run_ollama = (only == "ollama") or (ENABLE_OLLAMA and only in (None, "ollama"))
    if run_ollama:
        print(f"{BOLD}[Ollama] Local On-Device Guard ({OLLAMA_HOST} | {OLLAMA_MODEL}){RESET}")
        print(f"{DIM}  (Each call is a real inference — first run may be slower if model is cold){RESET}")
        ol_latencies = []
        for i in range(runs):
            sys.stdout.write(f"  Run {i+1}/{runs} ... ")
            sys.stdout.flush()
            r = _ping_ollama()
            if r["error"]:
                print(f"{RED}OFFLINE/ERROR: {r['error']}{RESET}")
            else:
                ol_latencies.append(r["latency_ms"])
                print(f"{_colour_latency(r['latency_ms'])}  {DIM}response: \"{str(r.get('response','')).strip()[:60]}\"{RESET}")
            time.sleep(0.2)

        results["ollama"] = ol_latencies
        if ol_latencies:
            print(f"\n  {BOLD}Ollama Summary ({OLLAMA_MODEL}):{RESET}")
            print(f"    Min    : {_colour_latency(min(ol_latencies))}")
            print(f"    Avg    : {_colour_latency(round(statistics.mean(ol_latencies), 1))}")
            print(f"    p50    : {_colour_latency(_percentile(ol_latencies, 50))}")
            print(f"    p95    : {_colour_latency(_percentile(ol_latencies, 95))}")
            print(f"    Max    : {_colour_latency(max(ol_latencies))}")
            print(f"    Bar    : {_bar(statistics.mean(ol_latencies), max_ms=30000)}")
        print()

    # ── Final Side-by-Side Comparison ────────────────────────────────
    print(f"{BOLD}{CYAN}{'-'*65}{RESET}")
    print(f"{BOLD}  Final Comparison Table{RESET}")
    print(f"{BOLD}{CYAN}{'-'*65}{RESET}")
    print(f"  {'Model':<30} {'Avg':>8}  {'p50':>8}  {'p95':>8}  {'Min':>8}")
    print(f"  {'-'*30} {'-'*8}  {'-'*8}  {'-'*8}  {'-'*8}")

    label_map = {
        "ai1":    f"AI-1 Reasoning  ({REASONING_MODEL})",
        "ai2":    f"AI-2 Decision   ({DECISION_MODEL})",
        "server": f"Local Server    (:{SERVER_PORT})",
        "ollama": f"Ollama Local    ({OLLAMA_MODEL})",
    }
    for key, lats in results.items():
        if not lats:
            continue
        avg = round(statistics.mean(lats), 1)
        p50 = _percentile(lats, 50)
        p95 = _percentile(lats, 95)
        mn  = min(lats)
        label = label_map.get(key, key)
        avg_s = f"{avg}ms".rjust(8)
        p50_s = f"{p50}ms".rjust(8)
        p95_s = f"{p95}ms".rjust(8)
        mn_s  = f"{mn}ms".rjust(8)

        colour = GREEN if avg < 1500 else (YELLOW if avg < 4000 else RED)
        print(f"  {label:<30} {colour}{avg_s}{RESET}  {p50_s}  {p95_s}  {mn_s}")

    print(f"{BOLD}{CYAN}{'='*65}{RESET}\n")

    # ── Verdict ───────────────────────────────────────────────────────
    for key in ("ai1", "ai2", "ollama"):
        lats = results.get(key, [])
        if not lats:
            continue
        avg = statistics.mean(lats)
        lbl = {"ai1": "AI-1 Reasoning", "ai2": "AI-2 Decision", "ollama": f"Ollama ({OLLAMA_MODEL})"}[key]
        if avg < 1000:
            verdict = f"{GREEN}Excellent - sub-1s responses{RESET}"
        elif avg < 2500:
            verdict = f"{GREEN}Good - acceptable for real-time agent tasks{RESET}"
        elif avg < 8000:
            verdict = f"{YELLOW}Moderate - typical for a local 7B model on CPU/GPU{RESET}"
        else:
            verdict = f"{RED}Slow - model may be running on CPU only; try a smaller quant{RESET}"
        print(f"  {BOLD}{lbl}:{RESET} {verdict}")
    print()


# ─────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="PrivacyVision Dual-AI Latency Benchmark",
        formatter_class=argparse.RawTextHelpFormatter,
    )
    parser.add_argument(
        "--runs", type=int, default=5,
        help="Number of inference calls per model (default: 5)",
    )
    parser.add_argument(
        "--server", action="store_true",
        help="Also benchmark local FastAPI server /health endpoint",
    )
    parser.add_argument(
        "--only", choices=["ai1", "ai2", "server", "ollama"], default=None,
        help="Benchmark only one target (ai1 | ai2 | server | ollama)",
    )
    args = parser.parse_args()
    run_benchmark(runs=args.runs, include_server=args.server, only=args.only)
