import json, sys

INI = """[general]
company = ООО «Северный ветер»
language = ru
[paths]
import = D:\\Обмен\\Входящие
archive = D:\\Архив\\2023
[export]
delimiter = ;
encoding = windows-1251
decimal = ,
"""

ROWS = [
    ("1004", "Анна Лебедева", "Москва", "12 400,50"),
    ("1012", "Пётр Журавлёв", "Самара", "980,00"),
    ("1047", "Гульнара Юсупова", "Казань", "0,00"),
    ("1063", "Фёдор Щербаков", "Тверь", "3 150,75"),
    ("1088", "Эльвира Цой", "Самара", "715,20"),
]
HEAD = "id;имя;город;баланс"


def ini_bytes(text):
    return b"\xff\xfe" + text.replace("\n", "\r\n").encode("utf-16-le")


def csv_bytes(rows):
    return "".join(line + "\r\n" for line in [HEAD] + [";".join(r) for r in rows]).encode("cp1251")


def wanted():
    ini = INI.replace("2023", "2024").replace("delimiter = ;", "delimiter = |")
    rows = [list(r) for r in ROWS]
    rows[1][3] = "1 130,50"
    rows[2][2] = "Нижний Новгород"
    rows.append(["1101", "Зоя Щукина", "Тверь", "0,00"])
    return ini, rows


def money(text):
    return float(text.replace(" ", "").replace("\xa0", "").replace(",", "."))


if __name__ == "__main__":
    ini, rows = wanted()
    checks = []
    raw_ini = open("legacy/settings.ini", "rb").read()
    raw_csv = open("legacy/клиенты.csv", "rb").read()
    checks.append(("settings.ini is still UTF-16 with its mark and CRLF line ends", raw_ini[:2] == b"\xff\xfe" and b"\r\x00\n\x00" in raw_ini and b"\n\x00" not in raw_ini.replace(b"\r\x00\n\x00", b"")))
    try:
        text = raw_ini[2:].decode("utf-16-le")
    except Exception:
        text = ""
    checks.append(("settings.ini has the two changes and nothing else", text.replace("\r\n", "\n") == ini))
    checks.append(("settings.ini is byte for byte a careful edit", raw_ini == ini_bytes(ini)))
    try:
        table = raw_csv.decode("cp1251")
    except Exception:
        table = ""
    checks.append(("клиенты.csv is still Windows-1251 with CRLF line ends", HEAD in table and "\r\n" in table and "\n" not in table.replace("\r\n", "")))
    got_rows = [line.split(";") for line in table.replace("\r\n", "\n").strip("\n").split("\n")[1:]]
    checks.append(("клиенты.csv has the three changes and nothing else", got_rows == rows))
    checks.append(("клиенты.csv is byte for byte a careful edit", raw_csv == csv_bytes(rows)))
    try:
        raw = open("legacy/summary.json", "rb").read()
        summary = json.loads(raw.decode("utf-8"))
        total = sum(money(r[3]) for r in rows)
        checks.append(("summary.json is UTF-8 without a mark", not raw.startswith(b"\xef\xbb\xbf")))
        checks.append(("summary.json counts the customers", summary.get("customers") == len(rows)))
        checks.append(("summary.json has the total balance", isinstance(summary.get("total_balance"), (int, float)) and abs(summary["total_balance"] - total) < 0.005))
        checks.append(("summary.json lists the cities, sorted", summary.get("cities") == sorted({r[2] for r in rows})))
    except Exception as e:
        print(f"legacy/summary.json: {e}")
        checks += [("summary.json", False)] * 4
    for label, ok in checks:
        if not ok:
            print(f"FAIL {label}")
    good = sum(1 for _, ok in checks if ok)
    print(f"SCORE {good}/{len(checks)}")
    sys.exit(0 if good == len(checks) else 1)
