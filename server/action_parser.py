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


def _clean_json_string(text: str) -> str:
    """
    Clean and repair JSON text that may contain unescaped newlines/tabs inside string literals
    or trailing commas, especially common when VLMs generate multi-line code solutions.
    """
    if not text:
        return text

    # Remove trailing commas before } or ]
    cleaned = re.sub(r",\s*([\]}])", r"\1", text)

    return cleaned


def _try_parse_json(text: str) -> dict | None:
    """Attempt JSON parsing with progressive repairs."""
    # 1. Direct parse
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # 2. Clean trailing commas and whitespace
    try:
        return json.loads(_clean_json_string(text))
    except json.JSONDecodeError:
        pass

    # 3. Replace raw unescaped newlines/tabs inside quoted string values
    try:
        def _escape_string_literals(match):
            inner = match.group(1)
            # escape real newlines and tabs inside the string
            inner = inner.replace("\r\n", "\\n").replace("\n", "\\n").replace("\t", "\\t")
            return f'"{inner}"'

        # Match content within double quotes (handles escaped quotes)
        repaired = re.sub(r'"((?:\\.|[^"\\])*)"', _escape_string_literals, text)
        repaired = _clean_json_string(repaired)
        return json.loads(repaired)
    except Exception:
        pass

    # 4. Repair truncated JSON (auto-close open quotes, brackets, and braces)
    try:
        trimmed = text.strip()
        if trimmed.count('"') % 2 != 0:
            trimmed += '"'
        open_brackets = trimmed.count('[') - trimmed.count(']')
        open_braces = trimmed.count('{') - trimmed.count('}')
        if open_brackets > 0 or open_braces > 0:
            repaired = trimmed + (']' * max(0, open_brackets)) + ('}' * max(0, open_braces))
            repaired = _clean_json_string(repaired)
            return json.loads(repaired)
    except Exception:
        pass

    return None


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

    # Strategy 1: Direct JSON parse (with repairs)
    parsed = _try_parse_json(text)
    if parsed is not None:
        return _validate_and_normalize(parsed)

    # Strategy 2: Extract from markdown code block
    code_block_match = re.search(r"```(?:json)?\s*\n?(.*?)\n?\s*```", text, re.DOTALL)
    if code_block_match:
        parsed = _try_parse_json(code_block_match.group(1).strip())
        if parsed is not None:
            return _validate_and_normalize(parsed)

    # Strategy 3: Find JSON object in text (greedy match for outermost braces)
    json_match = re.search(r"\{.*\}", text, re.DOTALL)
    if json_match:
        parsed = _try_parse_json(json_match.group(0))
        if parsed is not None:
            return _validate_and_normalize(parsed)

    # Strategy 4: Fallback — treat as reasoning
    return _fallback_response(text)


def _validate_and_normalize(data: Any) -> dict:
    """Validate and normalize parsed VLM output."""
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

    # Dynamic step & complexity fields
    task_complexity = str(data.get("task_complexity", "medium")).lower().strip()
    if task_complexity not in ("simple", "medium", "complex"):
        task_complexity = "medium"

    try:
        suggested_max_steps = int(data.get("suggested_max_steps", 15 if task_complexity == "medium" else (25 if task_complexity == "complex" else 10)))
    except (TypeError, ValueError):
        suggested_max_steps = 25 if task_complexity == "complex" else 15

    is_goal_complete = bool(data.get("is_goal_complete", False))

    result = {
        "reasoning": str(data.get("reasoning", data.get("analysis", "")) or ""),
        "page_description": str(data.get("page_description", "") or ""),
        "task_complexity": task_complexity,
        "suggested_max_steps": max(5, min(40, suggested_max_steps)),
        "is_goal_complete": is_goal_complete,
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

    # If is_goal_complete is explicitly True or actions is empty without error, check goal completion
    if is_goal_complete:
        result["actions"] = []

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
            sel_str = str(selector).strip().strip("'\"")
            if sel_str.startswith("sel="):
                sel_str = sel_str[4:].strip().strip("'\"")
            elif sel_str.startswith("sel#") or sel_str.startswith("sel.") or sel_str.startswith("sel["):
                sel_str = sel_str[3:].strip()
            normalized["selector"] = sel_str

    if action_type in ("autofill", "fill_form", "pay", "authorize_and_pay"):
        selector = action.get("selector", action.get("element", action.get("target", "")))
        if selector:
            sel_str = str(selector).strip().strip("'\"")
            if sel_str.startswith("sel="):
                sel_str = sel_str[4:].strip().strip("'\"")
            elif sel_str.startswith("sel#") or sel_str.startswith("sel.") or sel_str.startswith("sel["):
                sel_str = sel_str[3:].strip()
            normalized["selector"] = sel_str

    if action_type in ("type", "input", "select"):
        normalized["value"] = str(action.get("value", action.get("text", "")) or "")

    if action_type == "scroll":
        normalized["direction"] = str(action.get("direction", "down") or "down").lower()
        try:
            normalized["amount"] = int(action.get("amount", action.get("pixels", 400)))
        except (TypeError, ValueError):
            normalized["amount"] = 400

    if action_type == "navigate":
        url = str(action.get("url", action.get("value", "")) or "").strip()
        if not url:
            return None
        # Normalize protocol: prepend https:// if missing
        if not url.startswith("http://") and not url.startswith("https://") and not url.startswith("chrome://"):
            url = f"https://{url}"
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


def parse_workflow_plan(raw_response: str) -> dict:
    """
    Parse a workflow plan response from the planner model into a dict.
    Supports markdown code blocks, partial JSON, trailing commas, and unescaped quotes.
    """
    if not raw_response or not raw_response.strip():
        return {}

    text = raw_response.strip()

    # 1. Direct or repaired parse
    parsed = _try_parse_json(text)
    if parsed and isinstance(parsed, dict):
        return parsed

    # 2. Extract from markdown code block
    code_block_match = re.search(r"```(?:json)?\s*\n?(.*?)\n?\s*```", text, re.DOTALL)
    if code_block_match:
        parsed = _try_parse_json(code_block_match.group(1).strip())
        if parsed and isinstance(parsed, dict):
            return parsed

    # 3. Find JSON object in text
    json_match = re.search(r"\{.*\}", text, re.DOTALL)
    if json_match:
        parsed = _try_parse_json(json_match.group(0))
        if parsed and isinstance(parsed, dict):
            return parsed

    return {}

