"""Whole-number division that rounds a half up."""


def half_up_div(n, d):
    return (2 * n + d) // (2 * d)
