import time
import os
import sys
import base64
from io import BytesIO
from PIL import Image

sys.path.insert(0, os.path.abspath('.'))
sys.path.insert(0, os.path.abspath('server'))

# Temporarily test with local Ollama
os.environ["VLM_BACKEND"] = "ollama"
os.environ["OLLAMA_MODEL"] = "llava:7b"

from fastapi.testclient import TestClient
from server.main import app

# Generate test image
img = Image.new('RGB', (640, 480), color=(45, 75, 105))
buf = BytesIO()
img.save(buf, format='JPEG', quality=50)
img_b64 = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()

payload = {
    "image": img_b64,
    "dom_summary": """
Title: LeetCode
[1] <input> "Search" sel="input#search"
[2] <a> "Problem of the Day" href="/problems/minimum-cost/" sel="a.potd-link"
""",
    "redaction_manifest": {"redactions": []},
    "user_goal": "solve leetcode potd",
    "action_history": []
}

print("Testing with local Ollama backend...", flush=True)
with TestClient(app) as client:
    t0 = time.time()
    res = client.post("/api/analyze", json=payload)
    t1 = time.time()

    print(f"Status: {res.status_code}", flush=True)
    print(f"Total roundtrip: {t1-t0:.2f}s", flush=True)
    data = res.json()
    print("Actions:", data.get("actions"), flush=True)
    print("Reasoning:", (data.get("reasoning") or "")[:150], flush=True)
