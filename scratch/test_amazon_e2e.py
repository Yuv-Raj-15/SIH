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

# Generate test image
img = Image.new('RGB', (800, 600), color=(240, 240, 240))
buf = BytesIO()
img.save(buf, format='JPEG', quality=50)
img_b64 = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()

payload = {
    "image": img_b64,
    "dom_summary": """
Title: Amazon.com : Samsung S26 Ultra
URL: https://www.amazon.com/s?k=Samsung+S26+Ultra
Viewport: 1920x1080

[1] <input> (searchbox) "Search Amazon" sel="input#twotabsearchtextbox" @(300,10,600x40)
[2] <a> (link) "Samsung Galaxy S26 Ultra 512GB" sel="a.s-product-title" @(200,300,400x30)
[3] <button> (button) "Add to cart" sel="button#a-autoid-1-announce" @(200,500,120x35)
""",
    "redaction_manifest": {"redactions": []},
    "user_goal": "buy samsung s26 ultra via amazon",
    "action_history": []
}

print("Starting Amazon test...", flush=True)
with TestClient(app) as client:
    t0 = time.time()
    res = client.post("/api/analyze", json=payload)
    dt = time.time() - t0
    print(f"Status: {res.status_code} in {dt:.2f}s", flush=True)
    data = res.json()
    print("Latency:", data.get("latency_ms"), "ms", flush=True)
    print("Actions:", data.get("actions"), flush=True)
    print("Reasoning:", data.get("reasoning"), flush=True)
