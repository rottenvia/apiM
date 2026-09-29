# Questions for the quarterly review

Build the sample database with `python3 build_db.py` (it writes `shop.db`).
The schema, with comments, is at the top of `build_db.py`.

Definitions:

- An order's **value** is the sum of `quantity * unit_price_cents` over its
  `order_items` (the price actually charged, not the product's current list
  price). An order with no items has value 0.
- **Revenue** only ever counts completed orders (`status = 'completed'`);
  pending, cancelled and refunded orders never count.

Questions:

1. **q1**: Total revenue in cents from orders placed in calendar year 2024.
2. **q2**: Which country has the most distinct customers with at least one
   completed order? If several countries tie, give all of them.
3. **q3**: How many registered customers have never had a completed order?
4. **q4**: The median value in cents of completed orders (all dates). With
   an even number of orders it is the mean of the two middle values.
5. **q5**: The three products with the most units sold in completed orders,
   most first; ties are broken by product name, A to Z.
6. **q6**: Revenue in cents per product category. Products without a
   category are reported under `"Uncategorized"`.

Put the answers in `answers.json`:

```json
{
  "q1": 0,
  "q2": ["Country", "..."],
  "q3": 0,
  "q4": 0,
  "q5": ["Product", "Product", "Product"],
  "q6": {"category": 0}
}
```

`q2` is sorted alphabetically. Cents are integers, except that `q4` may be
fractional.
