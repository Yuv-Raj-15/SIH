import os
import sys
import time

sys.path.insert(0, os.path.abspath('.'))
sys.path.insert(0, os.path.abspath('server'))

from fastapi.testclient import TestClient
from server.main import app

test_cases = [
    {
        "name": "Test 4: E-Commerce Final Receipt Screen (Order Confirmed)",
        "goal": "buy samsung s26 ultra 256 gb via amazon.in complete check out",
        "dom": """Page: Order Confirmation - Amazon.in (www.amazon.in)
Viewport: 1536x730
Scroll: 0/1000
Elements: 20
---
[0] <h1> "Thank you, your order has been placed." sel="h1.confirmation-header" @(200,100,600x50)
[1] <span> "Order Confirmation # 408-1234567-7654321" sel="div.order-number" @(200,180,400x30)
""",
        "expect_action": "goal complete"
    }
]

print("=================================================================", flush=True)
print("TESTING STRICT UNIVERSAL AUTOMATION ACROSS ARBITRARY WEB TASKS", flush=True)
print("=================================================================", flush=True)

all_passed = True

with TestClient(app) as client:
    for tc in test_cases:
        print(f"\n--- {tc['name']} ---", flush=True)
        payload = {
            "image": None,
            "dom_summary": tc["dom"],
            "redaction_manifest": {"redactions": []},
            "user_goal": tc["goal"],
            "action_history": [f"[✓ SUCCESS] Previous step executed"]
        }
        res = client.post("/api/analyze", json=payload)
        data = res.json()
        print(f"Status: {res.status_code} ({data.get('latency_ms')}ms)", flush=True)
        print("Reasoning:", data.get("reasoning"), flush=True)
        print("Actions:", data.get("actions"), flush=True)
        print("Is Goal Complete:", data.get("is_goal_complete"), flush=True)

        actions = data.get("actions") or []
        is_complete = data.get("is_goal_complete", False)

        if tc["expect_action"] == "goal complete":
            if is_complete and not actions:
                print(">>> PASSED: Goal completion recognized!", flush=True)
            else:
                print(">>> FAILED: Expected goal complete!", flush=True)
                all_passed = False
        else:
            if actions:
                act = actions[0]
                print(f">>> PASSED: Action generated: {act.get('type')} on {act.get('selector')}", flush=True)
            else:
                print(">>> FAILED: Expected action to be generated!", flush=True)
                all_passed = False

print("\n=================================================================", flush=True)
if all_passed:
    print("ALL UNIVERSAL STRICT AUTOMATION TESTS PASSED!", flush=True)
else:
    print("SOME TESTS FAILED!", flush=True)
print("=================================================================", flush=True)
