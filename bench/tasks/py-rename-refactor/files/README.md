# shop

Pricing helpers for the web store.

```python
from shop import calc
calc([("9.99", 2), ("5", 1)], region="reduced")   # -> Decimal('26.23')
```

Command line:

    python -m shop calc 9.99:2 5:1 --region reduced
    python -m shop tax 100 --region default

Run the tests with `python -m unittest discover -s tests -t .`
