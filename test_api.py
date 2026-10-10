# /// script
# requires-python = ">=3.10"
# dependencies = ["openai"]
# ///
"""检测本地 Command Code API：uv run test_api.py"""
import json
import time

from openai import OpenAI

BASE_URL = "http://127.0.0.1:19002/v1"
API_KEY = "sk-cc-local"
client = OpenAI(base_url=BASE_URL, api_key=API_KEY)


def step(name, fn):
    t = time.time()
    try:
        detail = fn()
        print(f"[OK]   {name}  {time.time() - t:.2f}s  {detail}")
    except Exception as e:
        print(f"[FAIL] {name}  {e}")


def models():
    return f"-> {[m.id for m in client.models.list().data]}"


def chat(model):
    def run():
        r = client.chat.completions.create(model=model, messages=[{"role": "user", "content": "1+1=? 只回答数字"}])
        return f"-> {r.choices[0].message.content!r}  tokens in/out={r.usage.prompt_tokens}/{r.usage.completion_tokens}"
    return run


def stream():
    parts = []
    for c in client.chat.completions.create(model="deepseek-v4.1-flash", stream=True, messages=[{"role": "user", "content": "用一句话介绍你自己"}]):
        if c.choices and c.choices[0].delta.content:
            parts.append(c.choices[0].delta.content)
    return f"-> {len(parts)} chunks: {''.join(parts)[:60]!r}"


def tools():
    tool = {"type": "function", "function": {"name": "get_weather", "description": "查询天气",
            "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}
    msgs = [{"role": "user", "content": "北京天气怎么样？请调用工具"}]
    r = client.chat.completions.create(model="deepseek-v4.1-flash", messages=msgs, tools=[tool])
    call = r.choices[0].message.tool_calls[0]
    msgs += [r.choices[0].message.model_dump(exclude_none=True),
             {"role": "tool", "tool_call_id": call.id, "content": json.dumps({"weather": "晴", "temp": "22°C"}, ensure_ascii=False)}]
    r2 = client.chat.completions.create(model="deepseek-v4.1-flash", messages=msgs, tools=[tool])
    return f"-> {call.function.name}({call.function.arguments}) => {r2.choices[0].message.content[:60]!r}"


if __name__ == "__main__":
    print(f"BASE_URL={BASE_URL}\n")
    step("列出模型", models)
    step("非流式 deepseek-v4.1-flash", chat("deepseek-v4.1-flash"))
    step("非流式 deepseek-v4.1-flash-fast", chat("deepseek-v4.1-flash-fast"))
    step("流式输出", stream)
    step("工具调用两轮", tools)
