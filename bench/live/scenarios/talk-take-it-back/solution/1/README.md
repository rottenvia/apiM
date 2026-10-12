# shop

- `shop/cart.py`, `shop/orders.py`, `shop/report.py`: the shop itself.
- `shop/textutils.py`: helpers all of them share (`money`, `clamp`).
- `shop/settings.py` names the price formatter as `module:function`; `shop/hooks.py` loads it.

Tests: `python -m unittest`.
