def render(restock, unknown):
    out = [f"{r.sku} remaining={r.remaining} order={r.units}" for r in restock]
    out += [f"UNKNOWN {sku} {qty}" for sku, qty in sorted(unknown.items())]
    return "\n".join(out) if out else "nothing to restock"
