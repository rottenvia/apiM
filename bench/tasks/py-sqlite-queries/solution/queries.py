"""Answer questions.md from shop.db and write answers.json."""
import json
import os
import sqlite3
import subprocess
import sys

if not os.path.exists("shop.db"):
    subprocess.run([sys.executable, "build_db.py"], check=True)
db = sqlite3.connect("shop.db")
one = lambda sql: db.execute(sql).fetchone()[0]  # noqa: E731
rows = lambda sql: db.execute(sql).fetchall()  # noqa: E731

ORDER_VALUES = """
    SELECT o.id, o.order_date, COALESCE(SUM(i.quantity * i.unit_price_cents), 0) AS value
    FROM orders o LEFT JOIN order_items i ON i.order_id = o.id
    WHERE o.status = 'completed'
    GROUP BY o.id
"""

q1 = one(f"SELECT COALESCE(SUM(value), 0) FROM ({ORDER_VALUES}) WHERE substr(order_date, 1, 4) = '2024'")

country_counts = rows("""
    SELECT c.country, COUNT(DISTINCT c.id) AS n
    FROM customers c JOIN orders o ON o.customer_id = c.id
    WHERE o.status = 'completed'
    GROUP BY c.country
""")
best = max(n for _, n in country_counts)
q2 = sorted(c for c, n in country_counts if n == best)

q3 = one("""
    SELECT COUNT(*) FROM customers c
    WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.status = 'completed')
""")

values = sorted(v for (v,) in rows(f"SELECT value FROM ({ORDER_VALUES})"))
mid = len(values) // 2
q4 = values[mid] if len(values) % 2 else (values[mid - 1] + values[mid]) / 2

q5 = [name for (name,) in rows("""
    SELECT p.name FROM order_items i
    JOIN orders o ON o.id = i.order_id JOIN products p ON p.id = i.product_id
    WHERE o.status = 'completed'
    GROUP BY p.id ORDER BY SUM(i.quantity) DESC, p.name ASC LIMIT 3
""")]

q6 = dict(rows("""
    SELECT COALESCE(p.category, 'Uncategorized'), SUM(i.quantity * i.unit_price_cents)
    FROM order_items i JOIN orders o ON o.id = i.order_id JOIN products p ON p.id = i.product_id
    WHERE o.status = 'completed'
    GROUP BY 1
"""))

answers = {"q1": q1, "q2": q2, "q3": q3, "q4": q4, "q5": q5, "q6": q6}
with open("answers.json", "w") as f:
    json.dump(answers, f, indent=2)
print(json.dumps(answers, indent=2))
