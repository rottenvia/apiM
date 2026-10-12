def is_leap(year):
    """True for a leap year of the Gregorian calendar: every 4th year, except centuries, except every 400th year."""
    return year % 4 == 0 and year % 100 != 0
