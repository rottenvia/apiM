# mdstat

Quick statistics for Markdown files: lines, words (prose only), headings,
fenced code blocks and inline links.

```python
from mdstat import analyze
print(analyze(open("notes.md", encoding="utf-8").read()))
```

See [the samples](samples/guide.md) for example input.

## Status

The library works. There is no command-line interface yet.
