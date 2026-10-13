# cart

Cart arithmetic for the checkout, in whole cents. `npm test` runs the tests.

## Rules

1. A quantity is a whole number of 1 or more, and a price is whole cents, 0 or more. `lineTotal` throws a `RangeError` for anything else.
2. A discount is a percentage from 0 to 100; `discount` throws a `RangeError` outside that.
3. A discount is rounded to whole cents, a half cent going up: 10% of 1005 is 101.
4. `format` gives euros with two decimals and never loses a cent to floating point: `format(5)` is `0.05`, `format(-1250)` is `-12.50`, `format(123456789)` is `1234567.89`.
