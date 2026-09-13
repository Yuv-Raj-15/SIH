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

client = OpenAI(api_key=api_key, base_url=base_url, timeout=30.0)

# Compact DOM
compact_dom = """
[1] <input> "Search" sel="textarea[name='q']" @(100,200,600x40)
[2] <button> "Google Search" sel="input[name='btnK']" @(300,260,120x36)
[3] <a> "LeetCode - Problem of the Day" href="https://leetcode.com/problemset/" sel="a.potd" @(100,350,200x20)
"""
prompt = USER_PROMPT_TEMPLATE.format(
    user_goal="Solve LeetCode POTD",
    action_history="Step 1: Navigated to google.com",
    dom_summary=compact_dom,
    redaction_manifest="None"
)

# 720p image at quality 50
img = Image.new('RGB', (640, 480), color=(50, 80, 120))
buf = BytesIO()
img.save(buf, format='JPEG', quality=50)
img_b64 = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
print(f"Compressed image size: {len(buf.getvalue())} bytes ({len(img_b64)} chars)", flush=True)

t0 = time.time()
resp = client.chat.completions.create(
    model="gpt-5.6-luna",
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
    max_tokens=400,
    temperature=0.1
)
t1 = time.time()
print(f"Optimized gpt-5.6-luna latency: {t1-t0:.2f}s", flush=True)
print("Tokens generated:", resp.usage.completion_tokens)
print("Content:\n", resp.choices[0].message.content)
