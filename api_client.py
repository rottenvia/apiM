"""DeepSeek API Client for nohomo API Manager"""

import httpx
from typing import Optional, AsyncIterator
import json


async def chat_completion(
    messages: list[dict],
    model: str,
    api_key: str,
    thinking_effort: str = "none",
    stream: bool = False,
) -> dict:
    """Send chat completion request to DeepSeek"""
    
    body = {
        "model": model,
        "messages": messages,
        "stream": stream,
        "max_tokens": 8192,
    }
    
    # Add thinking parameters
    if thinking_effort != "none":
        body["reasoning_effort"] = thinking_effort
        body["extra_body"] = {"thinking": {"type": "enabled"}}
    else:
        body["extra_body"] = {"thinking": {"type": "disabled"}}
    
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            "https://api.deepseek.com/chat/completions",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
            json=body,
        )
        
        if response.status_code != 200:
            return {
                "error": True,
                "message": f"API Error: {response.status_code} - {response.text}",
            }
        
        data = response.json()
        choice = data.get("choices", [{}])[0]
        message = choice.get("message", {})
        
        return {
            "error": False,
            "content": message.get("content", ""),
            "reasoning_content": message.get("reasoning_content"),
            "usage": data.get("usage", {}),
        }


async def stream_chat_completion(
    messages: list[dict],
    model: str,
    api_key: str,
    thinking_effort: str = "none",
) -> AsyncIterator[dict]:
    """Stream chat completion from DeepSeek"""
    
    body = {
        "model": model,
        "messages": messages,
        "stream": True,
        "max_tokens": 8192,
    }
    
    if thinking_effort != "none":
        body["reasoning_effort"] = thinking_effort
        body["extra_body"] = {"thinking": {"type": "enabled"}}
    else:
        body["extra_body"] = {"thinking": {"type": "disabled"}}
    
    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream(
            "POST",
            "https://api.deepseek.com/chat/completions",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
            json=body,
        ) as response:
            async for line in response.aiter_lines():
                if line.startswith("data: "):
                    data_str = line[6:]
                    if data_str.strip() == "[DONE]":
                        break
                    try:
                        data = json.loads(data_str)
                        delta = data.get("choices", [{}])[0].get("delta", {})
                        yield {
                            "content": delta.get("content", ""),
                            "reasoning_content": delta.get("reasoning_content", ""),
                        }
                    except json.JSONDecodeError:
                        continue
