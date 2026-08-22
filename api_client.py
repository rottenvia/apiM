"""LLM API client for nohomo API Manager (DeepSeek + OpenCode Ox Alpha)."""

import httpx
from typing import AsyncIterator
import json


def _endpoint_for(model: str) -> tuple[str, str, dict]:
    """Return (url, wire model id, extra body fields) for a catalog model."""
    if model in ("ox-alpha", "x-preview-f-free"):
        return (
            "https://opencode.ai/zen/v1/chat/completions",
            "x-preview-f-free",
            {},
        )
    return "https://api.deepseek.com/chat/completions", model, {}


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
    
    url, wire_model, extra = _endpoint_for(model)
    body["model"] = wire_model
    if extra:
        body.update(extra)
    if thinking_effort != "none":
        body["reasoning_effort"] = thinking_effort
        if model not in ("ox-alpha", "x-preview-f-free"):
            body["thinking"] = {"type": "enabled"}
    elif model not in ("ox-alpha", "x-preview-f-free"):
        body["thinking"] = {"type": "disabled"}

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            url,
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
    
    url, wire_model, extra = _endpoint_for(model)
    body["model"] = wire_model
    if extra:
        body.update(extra)
    if thinking_effort != "none":
        body["reasoning_effort"] = thinking_effort
        if "ox-alpha" not in model and model != "x-preview-f-free":
            body["thinking"] = {"type": "enabled"}
    elif "ox-alpha" not in model and model != "x-preview-f-free":
        body["thinking"] = {"type": "disabled"}
    
    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream(
            "POST",
            url,
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
