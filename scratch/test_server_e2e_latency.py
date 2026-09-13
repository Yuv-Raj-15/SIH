import time
import os
import sys
import base64
from io import BytesIO
from PIL import Image

sys.path.insert(0, os.path.abspath('.'))
sys.path.insert(0, os.path.abspath('server'))

from fastapi.testclient import TestClient
from server.main import app

# Generate realistic 800x600 test image
img = Image.new('RGB', (800, 600), color=(45, 75, 105))
buf = BytesIO()
img.save(buf, format='JPEG', quality=55)
img_b64 = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()

payload = {
    "image": img_b64,
    "dom_summary": """
Title: LeetCode - The World's Leading Online Programming Learning Platform
URL: https://leetcode.com/problemset/
Viewport: 1920x1080

[1] <input> (searchbox) "Search problems" placeholder="Search..." sel="input#search-box" @(100,50,300x36)
[2] <a> (link) "Problem of the Day" href="/problems/minimum-cost/" sel="a.potd-link" @(100,150,250x24)
[3] <button> (button) "Sign In" sel="button#sign-in" @(800,50,80x36)
""",
    "redaction_manifest": {
        "redactions": []
    },
    "user_goal": "solve today leetcode potd",
    "action_history": []
}

print("Starting TestClient with lifespan...", flush=True)
with TestClient(app) as client:
    print("Invoking /api/analyze with optimized payload...", flush=True)
    t0 = time.time()
    res = client.post("/api/analyze", json=payload)
    t1 = time.time()

    print(f"Status: {res.status_code}", flush=True)
    print(f"Total /api/analyze roundtrip: {t1-t0:.2f}s", flush=True)
    data = res.json()
    print("Latency reported by server:", data.get("latency_ms"), "ms", flush=True)
    print("Task complexity:", data.get("task_complexity"), flush=True)
    print("Suggested max steps:", data.get("suggested_max_steps"), flush=True)
    print("Actions count:", len(data.get("actions", [])), flush=True)
    print("Actions:", data.get("actions"), flush=True)
    print("Reasoning snippet:", (data.get("reasoning") or "")[:150], flush=True)
