import importlib, sys
sys.path.insert(0, ".")
CASES = {'chunk': [('chunk([1, 2, 3, 4, 5], 2)', [[1, 2], [3, 4], [5]]), ('chunk([], 3)', []), ("chunk('abcd', 4)", [['a', 'b', 'c', 'd']]), ('chunk([1], 0)', 'ValueError')], 'clamp': [('clamp(5, 0, 10)', 5), ('clamp(-3, 0, 10)', 0), ('clamp(99, 0, 10)', 10), ('clamp(1, 5, 2)', 'ValueError')], 'median': [('median([3, 1, 2])', 2), ('median([4, 1, 3, 2])', 2.5), ('median([7])', 7), ('median([])', 'ValueError')], 'duration': [("parse_duration('1h30m15s')", 5415), ("parse_duration('45m')", 2700), ("parse_duration('90s')", 90), ("parse_duration('2h')", 7200), ("parse_duration('')", 'ValueError'), ("parse_duration('5x')", 'ValueError')], 'leap': [('is_leap(2024)', True), ('is_leap(1900)', False), ('is_leap(2000)', True), ('is_leap(2023)', False)], 'rle': [("rle_encode('aaabcc')", 'a3b1c2'), ("rle_encode('')", ''), ("rle_encode('z')", 'z1'), ("rle_encode('aabbbb')", 'a2b4')], 'flatten': [('flatten([1, [2, [3, [4]], 5]])', [1, 2, 3, 4, 5]), ('flatten([])', []), ("flatten(['ab', ['cd']])", ['ab', 'cd']), ('flatten([[], [[]]])', [])], 'search': [('binary_search([1, 3, 5, 7], 7)', 3), ('binary_search([1, 3, 5, 7], 1)', 0), ('binary_search([1, 3, 5, 7], 4)', -1), ('binary_search([], 1)', -1), ('binary_search([2], 2)', 0)], 'wrap': [("wrap_text('aa bb cc', 5)", ['aa bb', 'cc']), ("wrap_text('one two three', 7)", ['one two', 'three']), ("wrap_text('', 5)", []), ("wrap_text('abcdefgh ij', 4)", ['abcdefgh', 'ij'])], 'intervals': [('merge_intervals([(1, 2), (2, 3)])', [(1, 3)]), ('merge_intervals([(1, 10), (2, 3), (12, 13)])', [(1, 10), (12, 13)]), ('merge_intervals([])', []), ('merge_intervals([(5, 6), (1, 2)])', [(1, 2), (5, 6)])], 'base': [('to_base(255, 16)', 'ff'), ('to_base(0, 2)', '0'), ('to_base(5, 2)', '101'), ('to_base(35, 36)', 'z'), ('to_base(1, 1)', 'ValueError')], 'dedupe': [('dedupe([3, 1, 3, 2, 1])', [3, 1, 2]), ('dedupe([])', []), ("dedupe(['b', 'a', 'b'])", ['b', 'a'])], 'roman': [('roman(1994)', 'MCMXCIV'), ('roman(49)', 'XLIX'), ('roman(3999)', 'MMMCMXCIX'), ('roman(4)', 'IV'), ('roman(0)', 'ValueError')], 'percentile': [('percentile([15, 20, 35, 40, 50], 40)', 20), ('percentile([15, 20, 35, 40, 50], 100)', 50), ('percentile([15, 20, 35, 40, 50], 1)', 15), ('percentile([7], 50)', 7), ('percentile([], 50)', 'ValueError')], 'snake': [("camel_to_snake('userName')", 'user_name'), ("camel_to_snake('HTTPServerError')", 'http_server_error'), ("camel_to_snake('getURL2')", 'get_url2'), ("camel_to_snake('already_snake')", 'already_snake')], 'days': [("days_between('2025-03-01', '2025-03-11')", 10), ("days_between('2025-03-11', '2025-03-01')", 10), ("days_between('2024-02-28', '2024-03-01')", 2), ("days_between('2025-01-01', '2025-01-01')", 0)], 'topo': [("topo_sort({'b': ['a'], 'c': ['b'], 'a': []})", ['a', 'b', 'c']), ("topo_sort({'x': ['y']})", ['y', 'x']), ('topo_sort({})', []), ("topo_sort({'a': ['b'], 'b': ['a']})", 'ValueError'), ("topo_sort({'c': [], 'a': [], 'b': ['c']})", ['a', 'c', 'b'])], 'bytesize': [('format_bytes(512)', '512 B'), ('format_bytes(1536)', '1.5 KB'), ('format_bytes(1048576)', '1.0 MB'), ('format_bytes(1023)', '1023 B'), ('format_bytes(5 * 1024 ** 4)', '5120.0 GB')], 'lcs': [("lcs_length('ABCBDAB', 'BDCABA')", 4), ("lcs_length('', 'abc')", 0), ("lcs_length('abc', 'abc')", 3), ("lcs_length('aaa', 'a')", 1), ("lcs_length('a', 'aa')", 1), ("lcs_length('abc', 'def')", 0)], 'rotate': [('rotate([[1, 2], [3, 4]])', [[3, 1], [4, 2]]), ('rotate([[1, 2, 3]])', [[1], [2], [3]]), ('rotate([])', []), ('rotate([[1], [2], [3]])', [[3, 2, 1]])], 'keyvalue': [("parse_kv('a=1; b = two ; c=')", {'a': '1', 'b': 'two', 'c': ''}), ("parse_kv('url=http://x/?q=1')", {'url': 'http://x/?q=1'}), ("parse_kv(' ; ')", {}), ("parse_kv('oops')", 'ValueError')], 'window': [('running_mean([1, 2, 3, 4], 2)', [1.5, 2.5, 3.5]), ('running_mean([5], 1)', [5.0]), ('running_mean([1, 2], 3)', []), ('running_mean([1], 0)', 'ValueError')], 'gcd': [('gcd_many(12, 18)', 6), ('gcd_many(-12, 18)', 6), ('gcd_many(12, -18)', 6), ('gcd_many(7)', 7), ('gcd_many(0, 0)', 0), ('gcd_many()', 'ValueError')], 'titlecase': [("title_case('the lord of the rings')", 'The Lord of the Rings'), ("title_case('what is it made of')", 'What Is It Made Of'), ("title_case('')", ''), ("title_case('ON THE ROAD')", 'On the Road')]}


def passes(module, cases):
    """Every case of one module: an expression and what it must give (or the name of the error it must raise)."""
    try:
        space = vars(importlib.import_module(f"toolkit.{module}")).copy()
    except Exception as e:
        return [f"toolkit/{module}.py does not import: {e!r}"]
    bad = []
    for expression, want in cases:
        try:
            got = eval(expression, space)
        except Exception as e:
            got = type(e).__name__
        if got != want or type(got) is not type(want):
            bad.append(f"{expression}: want {want!r}, got {got!r}")
    return bad


if __name__ == "__main__":
    good = 0
    for module, cases in CASES.items():
        bad = passes(module, cases)
        good += not bad
        for line in bad[:2]:
            print(f"FAIL {module}: {line}")
    print(f"SCORE {good}/{len(CASES)}")
    sys.exit(0 if good == len(CASES) else 1)
