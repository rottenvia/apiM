import sys
sys.path.insert(0, ".")
from pager import get_page, page_count

cases = 0
passed = 0
def expect(label, got, want):
    global cases, passed
    cases += 1
    if got == want:
        passed += 1
    else:
        print(f"FAIL {label}: got {got!r}, want {want!r}")

items = list(range(10))
expect("page 1", get_page(items, 1, 3), [0, 1, 2])
expect("page 2", get_page(items, 2, 3), [3, 4, 5])
expect("last page", get_page(items, 4, 3), [9])
expect("past the end", get_page(items, 5, 3), [])
expect("all pages cover every item once", sum((get_page(items, p, 3) for p in range(1, page_count(10, 3) + 1)), []), items)
expect("count 10/3", page_count(10, 3), 4)
expect("count 9/3", page_count(9, 3), 3)
expect("count 0/3", page_count(0, 3), 0)
expect("count 1/5", page_count(1, 5), 1)
try:
    page_count(5, 0)
    expect("per_page 0 raises", False, True)
except ValueError:
    expect("per_page 0 raises", True, True)
try:
    get_page(items, 0, 3)
    expect("page 0 raises", False, True)
except ValueError:
    expect("page 0 raises", True, True)

print(f"SCORE {passed}/{cases}")
sys.exit(0 if passed == cases else 1)
