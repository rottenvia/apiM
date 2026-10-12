# people.csv

One row per person, merged from `crm.csv` and `shop.csv`.

- A person is an email address. Compare addresses trimmed and in lower case. A row is dropped when its address is not `something@something.tld`: exactly one `@`, text before it, at least one dot after it, no spaces inside.
- Columns, in this order: `email,name,phone,signup`.
- `email`: trimmed, lower case.
- `name`: trimmed, runs of spaces made one. crm.csv has the whole name; shop.csv has first and last (joined with one space, an empty part left out). When both files have a name, crm.csv's wins.
- `phone`: digits only, with a leading `+` kept when there is one. crm.csv's wins when it is not empty. Empty when neither file has one.
- `signup`: `YYYY-MM-DD`. crm.csv writes DD/MM/YYYY, shop.csv writes YYYY-MM-DD HH:MM. When both files have one, the earlier day. Empty when neither has one.
- The same person twice in one file: the first row counts, the later ones are ignored.
- Rows sorted by email. UTF-8 without a byte order mark, commas, `\n` line ends, quotes only where CSV needs them.
