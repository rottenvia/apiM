# loans

Who has which book, in one JSON file.

    python -m loans add-book b1 "Dune" 12.50
    python -m loans add-member m1 "Ada"
    python -m loans lend b1 m1

| command | what it does |
|---|---|
| `add-book ID TITLE PRICE` | a new book |
| `add-member ID NAME` | a new member |
| `lend BOOK MEMBER` | lends a book for 14 days |
| `return BOOK` | takes it back |
| `renew BOOK` | 14 more days, twice at most |
| `report` | what is out |
| `overdue` | what is late, the most days late first |

`--store FILE` names the file (default `store.json`); `--today YYYY-MM-DD` runs a command as if on that day.

## Not supported

E-books are never lent: the publisher licence forbids it.
