# calc

A small, safe expression evaluator used by the reporting service for
user-defined formulas (`revenue - refunds`, `max(a, b) * 1.2`, ...).

```python
from calc import evaluate, parse, to_source
evaluate("2 * x ^ 2 - 1", x=3)     # 17
to_source(parse("(1 + 2) * 3"))     # '(1+2)*3'
```

## Language

* numbers: `3`, `2.5`, `.5`
* variables: names made of letters, digits and `_`, passed as keyword args
* functions: `abs`, `min`, `max`, `sqrt`, `round`
* operators, from loosest to tightest binding:

  | operators      | associativity |
  |----------------|---------------|
  | `+` `-`        | left          |
  | `*` `/` `%`    | left          |
  | unary `-`      | prefix        |
  | `^` (power)    | right         |

  So `-2^2` is `-(2^2)` = -4, `2^3^2` is `2^(3^2)` = 512, and a unary minus
  may follow `^` directly: `2^-1` = 0.5. `-` is always an operator token;
  whether it is unary or binary is decided by the parser.

## Printer

`to_source(tree)` renders a tree back to text with no spaces and the
minimum parentheses needed, so that `parse(to_source(t)) == t`.

## Development

    python -m unittest discover -s tests
