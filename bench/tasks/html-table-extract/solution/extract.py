"""Extract the 'Hydroelectricity by country' table from a saved wiki page.

usage: python extract.py PAGE.html OUT.json
"""
import json
import re
import sys
from html.parser import HTMLParser

VOID = {"br", "img", "hr", "meta", "link", "input", "col", "wbr", "area", "base", "source"}


class Node:
    def __init__(self, tag, attrs, parent):
        self.tag, self.attrs, self.parent = tag, dict(attrs), parent
        self.children = []

    def hidden(self):
        style = (self.attrs.get("style") or "").replace(" ", "").lower()
        return "display:none" in style or "sortkey" in (self.attrs.get("class") or "").split()

    def find_all(self, tag):
        for c in self.children:
            if isinstance(c, Node):
                if c.tag == tag:
                    yield c
                yield from c.find_all(tag)


class TreeBuilder(HTMLParser):
    """Tiny tolerant DOM builder that knows the implicit-close rules tables need."""

    CLOSES = {
        "td": {"td", "th"}, "th": {"td", "th"},
        "tr": {"td", "th", "tr"},
        "tbody": {"td", "th", "tr", "tbody", "thead", "tfoot"},
        "thead": {"td", "th", "tr", "tbody", "thead", "tfoot"},
        "tfoot": {"td", "th", "tr", "tbody", "thead", "tfoot"},
        "p": {"p"}, "li": {"li"},
    }

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#root", {}, None)
        self.cur = self.root

    def _close_implicit(self, tag):
        closes = self.CLOSES.get(tag)
        if not closes:
            return
        n = self.cur
        while n is not self.root and n.tag != "table":
            if n.tag in closes:
                self.cur = n.parent
            n = n.parent

    def handle_starttag(self, tag, attrs):
        self._close_implicit(tag)
        node = Node(tag, attrs, self.cur)
        self.cur.children.append(node)
        if tag not in VOID:
            self.cur = node

    def handle_startendtag(self, tag, attrs):
        self.cur.children.append(Node(tag, attrs, self.cur))

    def handle_endtag(self, tag):
        n = self.cur
        while n is not self.root and n.tag != tag:
            if tag in ("tr", "td", "th") and n.tag == "table":
                return  # stray end tag
            n = n.parent
        if n is not self.root:
            self.cur = n.parent

    def handle_data(self, data):
        self.cur.children.append(data)


def text_of(node):
    out = []

    def walk(n):
        for c in n.children:
            if isinstance(c, str):
                out.append(c)
            elif c.tag in ("sup", "script", "style") or c.hidden():
                continue
            elif c.tag == "br":
                out.append(" ")
            elif c.tag == "table":
                continue
            else:
                walk(c)

    walk(node)
    return re.sub(r"\s+", " ", "".join(out).replace("\xa0", " ")).strip()


def clean_name(s):
    s = re.sub(r"\[[^\]]*\]", "", s)
    return s.strip().rstrip("*†‡§ ").strip()


MISSING = {"", "-", "—", "–", "n/a", "na", "?"}


def number(s):
    s = re.sub(r"\[[^\]]*\]", "", s)
    s = re.sub(r"\(.*?\)", "", s).replace("%", "").replace(",", "").replace(" ", "").replace("−", "-")
    s = s.strip().rstrip("*†")
    if s.lower() in MISSING:
        return None
    v = float(s)
    return int(v) if v.is_integer() else v


def grid(table):
    """Expand rowspan/colspan into a list of rows of (cell node, is_header)."""
    rows = [tr for tr in table.find_all("tr") if nearest_table(tr) is table]
    out, pending = [], {}
    for tr in rows:
        row, col = [], 0
        cells = [c for c in tr.children if isinstance(c, Node) and c.tag in ("td", "th")]
        it = iter(cells)
        while True:
            if col in pending and pending[col][0] > 0:
                left, node = pending[col]
                row.append(node)
                pending[col] = (left - 1, node)
                col += 1
                continue
            c = next(it, None)
            if c is None:
                break
            rs = int(c.attrs.get("rowspan") or 1)
            cs = int(c.attrs.get("colspan") or 1)
            for _ in range(cs):
                row.append(c)
                if rs > 1:
                    pending[col] = (rs - 1, c)
                col += 1
        out.append(row)
    return out


def nearest_table(n):
    n = n.parent
    while n is not None and n.tag != "table":
        n = n.parent
    return n


def extract(html_text):
    b = TreeBuilder()
    b.feed(html_text)
    b.close()
    table = None
    for t in b.root.find_all("table"):
        cap = next((c for c in t.children if isinstance(c, Node) and c.tag == "caption"), None)
        if cap and text_of(cap).lower().startswith("hydroelectricity by country"):
            table = t
            break
    if table is None:
        raise SystemExit("table not found")
    g = grid(table)
    header_rows = [r for r in g if r and all(c.tag == "th" for c in r)]
    top, sub = header_rows[0], header_rows[1]
    years = [text_of(sub[i]) for i in range(len(top)) if "generation" in text_of(top[i]).lower()]
    gen_cols = [i for i in range(len(top)) if "generation" in text_of(top[i]).lower()]
    result = []
    for row in g:
        if row in header_rows or not row:
            continue
        texts = [text_of(c) for c in row]
        if any(re.search(r"\b(sub-?total|total)\b", t, re.I) for t in texts[:2]):
            continue
        if len(row) < len(top):
            continue
        result.append({
            "region": clean_name(texts[0]),
            "country": clean_name(texts[1]),
            "capacity_mw": number(texts[2]),
            "generation_gwh": {y: number(texts[i]) for y, i in zip(years, gen_cols)},
            "share_pct": number(texts[len(top) - 1]),
        })
    return result


def main():
    if len(sys.argv) != 3:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    with open(sys.argv[1], encoding="utf-8") as fh:
        data = extract(fh.read())
    with open(sys.argv[2], "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
