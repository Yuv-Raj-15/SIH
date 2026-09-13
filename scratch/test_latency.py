import time
import os
import sys
sys.path.insert(0, os.path.abspath('.'))

from dotenv import load_dotenv
load_dotenv('server/.env')
from openai import OpenAI
from server.prompts import SYSTEM_PROMPT, USER_PROMPT_TEMPLATE
import base64
from io import BytesIO
from PIL import Image

api_key = os.getenv('VLM_API_KEY')
base_url = os.getenv('VLM_BASE_URL')

client = OpenAI(api_key=api_key, base_url=base_url, timeout=20.0)

sample_dom = """
[1] <input> (searchbox) "Search Google" name="q" sel="textarea[name='q']" @(100,200,600x40)
[2] <button> (button) "Google Search" sel="input[name='btnK']" @(300,260,120x36)
[3] <a> (link) "LeetCode POTD" href="https://leetcode.com/problemset/" sel="a#potd" @(100,350,200x20)
"""
prompt = USER_PROMPT_TEMPLATE.format(
    user_goal="Solve LeetCode POTD",
    action_history="None",
    dom_summary=sample_dom,
    redaction_manifest="No redactions"
)

img = Image.new('RGB', (800, 600), color=(73, 109, 137))
buf = BytesIO()
img.save(buf, format='JPEG', quality=60)
img_b64 = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()

models = [
    "deepseek-v4-flash",
    "deepseek-v4.1-flash",
    "qwen3.8-27b",
    "gpt-5.6-luna"
]

for m in models:
    print(f"\n--- Testing {m} (with image) ---", flush=True)
    try:
        t0 = time.time()
        resp = client.chat.completions.create(
            model=m,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": img_b64, "detail": "low"}}
                    ]
                }
            ],
            max_tokens=500,
            temperature=0.2
        )
        t1 = time.time()
        print(f"SUCCESS in {t1-t0:.2f}s | Output: {resp.choices[0].message.content[:100]}...", flush=True)
    except Exception as e:
        print(f"Vision failed for {m}: {e}", flush=True)
        # Try text-only
        try:
            print(f"Trying text-only for {m}...", flush=True)
            t0 = time.time()
            resp = client.chat.completions.create(
                model=m,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": prompt}
                ],
                max_tokens=500,
                temperature=0.2
            )
            t1 = time.time()
            print(f"Text-only SUCCESS in {t1-t0:.2f}s | Output: {resp.choices[0].message.content[:100]}...", flush=True)
        except Exception as e2:
            print(f"Text-only failed for {m}: {e2}", flush=True)
