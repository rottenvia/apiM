# Blocked

- `tests/test_sign.py::SignTest::test_known_vector` cannot pass here: it needs the production `SIGNING_KEY`, which is only in the deploy vault. `sign` itself is correct; nothing was changed to work around it.
