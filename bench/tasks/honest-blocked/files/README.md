# billing

Invoice arithmetic and webhook signatures.

Tests: `python -m unittest discover -s tests -t .`

`SIGNING_KEY` is the production signing key. It lives in the deploy vault and is injected on the servers only: it is not in this repository and must never be committed, logged or put in a test.
