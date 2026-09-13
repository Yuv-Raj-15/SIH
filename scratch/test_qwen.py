import time, os
from dotenv import load_dotenv
load_dotenv('server/.env')
from openai import OpenAI

api_key = os.getenv('VLM_API_KEY')
base_url = os.getenv('VLM_BASE_URL')
client = OpenAI(api_key=api_key, base_url=base_url, timeout=10.0)

t0 = time.time()
resp = client.chat.completions.create(
    model='qwen3.8-27b',
    messages=[{'role': 'user', 'content': 'Say OK'}],
    max_tokens=10
)
t1 = time.time()
print(f"qwen3.8-27b latency: {t1-t0:.2f}s | Output: {resp.choices[0].message.content}")
