"""Smart Search Engine for nohomo API Manager"""

import httpx
import json
import re
from typing import Optional


def auto_thinking_effort(message: str) -> str:
    """Determine thinking effort based on message complexity"""
    lower = message.lower()
    word_count = len(message.split())
    
    # Simple patterns
    simple_patterns = [
        r'^(hi|hello|hey|sup|yo)\b',
        r'^(thanks|thank you|thx)',
        r'^(ok|okay|got it|sure)',
        r'how (do|can) i (run|start|launch|open|install)',
        r'what (is|are) (your|the) (name|version)',
    ]
    
    if word_count <= 5:
        if any(re.search(p, lower) for p in simple_patterns):
            return "none"
        return "low"
    
    # Complex indicators
    complex_patterns = [
        r'debug|error|bug|crash|fail',
        r'implement|architect|design|build|create.*system',
        r'explain.*how.*works',
        r'compare|analyze|evaluate|review',
        r'optimize|refactor|improve|performance',
        r'security|vulnerability|exploit',
        r'algorithm|data structure',
        r'proof|prove|theorem',
        r'multi.*step|complex|complicated',
    ]
    
    complex_score = sum(1 for p in complex_patterns if re.search(p, lower))
    
    if complex_score >= 3 or word_count > 100:
        return "max"
    if complex_score >= 2 or word_count > 50:
        return "high"
    if complex_score >= 1 or word_count > 15:
        return "low"
    
    return "low"


def should_auto_search(message: str) -> bool:
    """Determine if web search should be triggered"""
    lower = message.lower()
    
    search_triggers = [
        r'search\s+(for|about|the)',
        r'find\s+(me|the|a|information|info)',
        r'look\s+up',
        r'what\s+is\s+the\s+(latest|current|newest|recent)',
        r'how\s+to\s+fix',
        r'error.*\d+',
        r'github\.com|stackoverflow',
        r'latest\s+version',
        r'documentation\s+for',
        r'any\s+(updates|news|changes)',
        r'\b(2024|2025|2026)\b',
        r'release\s+(date|notes)',
    ]
    
    return any(re.search(p, lower) for p in search_triggers)


async def generate_search_queries(
    message: str,
    context: str,
    deepseek_key: str
) -> dict:
    """Use DeepSeek to generate smart search queries"""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                "https://api.deepseek.com/chat/completions",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {deepseek_key}",
                },
                json={
                    "model": "deepseek-v4-flash",
                    "messages": [
                        {
                            "role": "system",
                            "content": """You are a search query optimizer. Generate 2-4 precise web search queries.
Rules:
- Each query targets a SPECIFIC aspect
- Include version numbers, specific terms
- Include FULL error messages if present
- Never generate vague single-word queries

Respond in JSON ONLY:
{"queries": ["query1", "query2"], "intent": "brief description", "type": "documentation|github|forum|article"}"""
                        },
                        {
                            "role": "user",
                            "content": f'Message: "{message}"\nContext: {context}\n\nGenerate search queries.'
                        }
                    ],
                    "response_format": {"type": "json_object"},
                    "temperature": 0.3,
                    "max_tokens": 500,
                }
            )
            
            if response.status_code == 200:
                data = response.json()
                content = data.get("choices", [{}])[0].get("message", {}).get("content", "{}")
                return json.loads(content)
    except Exception as e:
        print(f"Query generation error: {e}")
    
    return {"queries": [message], "intent": message, "type": "general"}


async def tavily_search(
    query: str,
    tavily_key: str,
    max_results: int = 5
) -> list[dict]:
    """Execute Tavily search"""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                "https://api.tavily.com/search",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {tavily_key}",
                },
                json={
                    "query": query,
                    "search_depth": "advanced",
                    "max_results": max_results,
                    "include_answer": True,
                    "chunks_per_source": 3,
                }
            )
            
            if response.status_code == 200:
                data = response.json()
                results = []
                for r in data.get("results", []):
                    results.append({
                        "title": r.get("title", ""),
                        "url": r.get("url", ""),
                        "content": r.get("content", ""),
                        "score": r.get("score", 0),
                    })
                return results
    except Exception as e:
        print(f"Tavily search error: {e}")
    
    return []


async def smart_search(
    message: str,
    context: str,
    deepseek_key: str,
    tavily_key: str
) -> dict:
    """Execute smart multi-step search"""
    # Generate search queries
    plan = await generate_search_queries(message, context, deepseek_key)
    queries = plan.get("queries", [message])
    
    all_results = []
    
    # Execute searches
    for query in queries[:4]:
        results = await tavily_search(query, tavily_key)
        all_results.extend(results)
    
    # Deduplicate
    seen_urls = set()
    unique_results = []
    for r in all_results:
        if r["url"] not in seen_urls and r["score"] >= 0.3 and len(r["content"]) >= 50:
            seen_urls.add(r["url"])
            unique_results.append(r)
    
    # Sort by score
    unique_results.sort(key=lambda x: x["score"], reverse=True)
    top_results = unique_results[:8]
    
    # Build summary
    summary = ""
    for i, r in enumerate(top_results, 1):
        summary += f"[{i}] {r['title']}\nURL: {r['url']}\n{r['content']}\n\n---\n\n"
    
    return {
        "results": top_results,
        "queries": queries,
        "summary": summary,
        "count": len(top_results),
    }
