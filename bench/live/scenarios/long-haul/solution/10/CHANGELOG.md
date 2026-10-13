# Changes

## Unreleased

- prices are read without a float
- the first two days late are free
- fines live in `loans/fines.py`
- `overdue` lists what is late
- fines have no cap any more
- a member holds three books at most
- `return` of a book that is not out is an error, not a crash
- `renew` pushes the due date on, twice at most
- late books cost 25 cents a day, up to the book's price
- `report` says `no loans` for an empty store

## 0.1

- lend, return and report
