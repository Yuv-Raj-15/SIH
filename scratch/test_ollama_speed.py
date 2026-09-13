import time
import ollama

client = ollama.Client(host='http://localhost:11434')
t0 = time.time()
resp = client.chat(
    model='llava:7b',
    messages=[{'role': 'user', 'content': 'Say hi in 3 words.'}],
    options={'num_predict': 50}
)
t1 = time.time()
print(f"Local Ollama response in {t1-t0:.2f}s: {resp['message']['content']}")
