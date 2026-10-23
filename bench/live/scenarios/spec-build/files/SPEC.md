# tally

`tally.py` keeps a time log in `tally.json`, in the folder it is run from.

## Commands

    python tally.py add <duration> <text> [--date YYYY-MM-DD] [--tag TAG]...
    python tally.py list [--from DATE] [--to DATE] [--tag TAG]
    python tally.py sum  [--from DATE] [--to DATE] [--by tag|date]
    python tally.py rm <id>
    python tally.py export <file.csv>

## Rules

1. A duration is `90m`, `2h`, `1h30m` or `1.5h`, and is kept as whole minutes (`1.5h` is 90). Zero, a negative one, more than 24 hours, one that is not a whole number of minutes (`0.01h`), or anything else is an error.
2. Every entry gets the next id: 1, 2, 3 and so on. An id is never used twice, also after `rm`.
3. `add` prints `added <id>`.
4. `--date` is today when left out. A date that does not exist (2026-02-30) is an error.
5. Tags are kept in lower case, each once, sorted.
6. `list` prints a line per entry, oldest date first and by id within a date: `<id>  <date>  <H:MM>  <text>`, then `  [tag1,tag2]` when the entry has tags. Two spaces between the columns.
7. `--from` and `--to` include their day. `--tag` keeps the entries that have the tag, in any case.
8. With nothing to show, `list` prints `nothing logged`.
9. `sum` prints `total <H:MM>`. With `--by tag` it first prints a line per tag, `<tag> <H:MM>`, sorted by tag, and entries without a tag under `(none)` last; an entry with two tags counts under both and once in the total. With `--by date`, a line per date, oldest first, then the total.
10. `rm <id>` prints `removed <id>`. An id that is not there is an error.
11. `export` writes a CSV with the header `id,date,minutes,text,tags`, the tags joined by one space, in the order of `list`, and prints `exported <n>`.
12. An error is one line on stderr that starts with `error: `, exit code 2, and `tally.json` stays as it was. Everything else exits 0.
13. H:MM: the hours are not padded, the minutes are: `0:05`, `12:30`, `100:00`.
14. `tally.json` is never left half written: write a file next to it and rename.

The tests run with `python -m unittest`: nothing is installed for them.
