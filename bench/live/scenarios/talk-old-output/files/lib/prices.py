def with_tax(cents, percent):
    return cents + cents * percent // 100


def split_bill(cents, people):
    share, rest = divmod(cents, people)
    return [share + (1 if i < rest else 0) for i in range(people)]
