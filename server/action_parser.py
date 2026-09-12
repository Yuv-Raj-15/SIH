"""
Action Parser — Parses VLM natural language / JSON output into structured action commands.
Handles edge cases like malformed JSON, embedded JSON in text, missing fields.
"""

import json
import re
from typing import Any


# Valid action types
VALID_ACTION_TYPES = {
    "click", "type", "input", "scroll", "navigate", "select", "wait",
    "hover", "focus", "clear", "keypress", "key", "enter", "submit",
    "autofill", "fill_form", "pay", "authorize_and_pay"
}


def parse_vlm_response(raw_response: str) -> dict:
    """
    Parse the VLM's response into a structured action plan.
    
    Attempts multiple strategies:
    1. Direct JSON parse
    2. Extract JSON from markdown code blocks
    3. Extract JSON object from mixed text
    4. Fallback: treat entire response as reasoning with no actions
    """
    if not raw_response or not raw_response.strip():
        return _fallback_response("Empty response from VLM")

    text = raw_response.strip()

    # Strategy 1: Direct JSON parse
    try:
        parsed = json.loads(text)
        return _validate_and_normalize(parsed)
    except json.JSONDecodeError:
        pass

    # Strategy 2: Extract from markdown code block
    code_block_match = re.search(r"```(?:json)?\s*\n?(.*?)\n?\s*```", text, re.DOTALL)
    if code_block_match:
        try:
            parsed = json.loads(code_block_match.group(1).strip())
            return _validate_and_normalize(parsed)
        except json.JSONDecodeError:
            pass

    # Strategy 3: Find JSON object in text (greedy match for outermost braces)
    json_match = re.search(r"\{.*\}", text, re.DOTALL)
    if json_match:
        try:
            parsed = json.loads(json_match.group(0))
            return _validate_and_normalize(parsed)
        except json.JSONDecodeError:
            pass

    # Strategy 4: Fallback — treat as reasoning
    return _fallback_response(text)


def _validate_and_normalize(data: Any) -> dict:
    """Validate and normalize parsed VLM output."""
    # A model can return valid JSON that is not an action-plan object (for
    # example [] or null). Treat that as an unparseable response instead of
    # raising AttributeError and turning the whole request into a server error.
    if not isinstance(data, dict):
        return _fallback_response(json.dumps(data, ensure_ascii=False))

    raw_confidence = data.get("confidence", 0.5)
    try:
        confidence = max(0.0, min(1.0, float(raw_confidence)))
    except (TypeError, ValueError):
        confidence = 0.5

    raw_warnings = data.get("warnings", [])
    if isinstance(raw_warnings, list):
        warnings = [str(w) for w in raw_warnings]
    elif raw_warnings:
        warnings = [str(raw_warnings)]
    else:
        warnings = []

    result = {
        "reasoning": str(data.get("reasoning", data.get("analysis", "")) or ""),
        "page_description": str(data.get("page_description", "") or ""),
        "actions": [],
        "confidence": confidence,
        "warnings": warnings,
    }

    # Normalize actions
    raw_actions = data.get("actions", [])
    if isinstance(raw_actions, list):
        for action in raw_actions:
            if not isinstance(action, dict):
                continue
            normalized = _normalize_action(action)
            if normalized:
                result["actions"].append(normalized)

    return result


def _normalize_action(action: dict) -> dict | None:
    """Normalize a single action dict."""
    action_type = (action.get("type", "") or "").lower().strip()
    
    if action_type not in VALID_ACTION_TYPES:
        return None

    normalized = {
        "type": action_type,
        "description": str(action.get("description", "") or ""),
    }

    # Type-specific fields
    if "elementIndex" in action:
        try:
            normalized["elementIndex"] = int(action["elementIndex"])
        except (ValueError, TypeError):
            pass

    if action_type in ("click", "type", "input", "select", "hover", "focus", "clear"):
        selector = action.get("selector", action.get("element", action.get("target", "")))
        if not selector and "elementIndex" not in normalized:
            return None
        if selector:
            normalized["selector"] = str(selector)

    if action_type in ("autofill", "fill_form", "pay", "authorize_and_pay"):
        selector = action.get("selector", action.get("element", action.get("target", "")))
        if selector:
            normalized["selector"] = str(selector)

    if action_type in ("type", "input", "select"):
        normalized["value"] = str(action.get("value", action.get("text", "")) or "")

    if action_type == "scroll":
        normalized["direction"] = str(action.get("direction", "down") or "down").lower()
        try:
            normalized["amount"] = int(action.get("amount", action.get("pixels", 400)))
        except (TypeError, ValueError):
            normalized["amount"] = 400

    if action_type == "navigate":
        url = action.get("url", action.get("value", ""))
        if not url:
            return None
        normalized["url"] = url

    if action_type == "wait":
        try:
            normalized["duration"] = int(action.get("duration", action.get("value", 1000)))
        except (TypeError, ValueError):
            normalized["duration"] = 1000

    return normalized


def _fallback_response(text: str) -> dict:
    """Create a fallback response when parsing fails."""
    return {
        "reasoning": text[:1000],
        "page_description": "",
        "actions": [],
        "confidence": 0.3,
        "warnings": ["VLM response could not be parsed as structured JSON"],
    }


def validate_actions_against_dom(actions: list[dict], dom_summary: str) -> list[dict]:
    """
    Optional: cross-reference action selectors against the DOM summary
    to flag potentially invalid targets.
    """
    validated = []
    for action in actions:
        action_copy = dict(action)
        selector = action_copy.get("selector", "")
        
        # Basic validation: check if selector appears in DOM summary
        if selector and selector not in dom_summary:
            action_copy["_warning"] = f"Selector '{selector}' not found in DOM summary"
        
        validated.append(action_copy)
    
    return validated
