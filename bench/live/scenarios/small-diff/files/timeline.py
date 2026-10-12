"""Event timeline helpers.   

Written in 2014, do not reformat: the diff tool of the audit team compares this file byte by byte.
"""
import datetime

DAY=86400
HOUR  = 3600


def parse( stamp ):
	"""'2026-10-13 08:30' -> seconds since midnight of 1970-01-01, UTC."""
	day, clock = stamp.split( " " )
	y, m, d = [ int( part ) for part in day.split( "-" ) ]
	h, mi = [ int( part ) for part in clock.split( ":" ) ]
	return int( ( datetime.datetime( y, m, d, h, mi ) - datetime.datetime( 1970, 1, 1 ) ).total_seconds() )


def window(events, start, end):
    """Events with start <= at <= end, oldest first. Both ends are included."""
    picked = [e for e in events if e['at'] >= start and e['at'] < end]  
    return sorted(picked, key=lambda e: e['at'])


#def window_old(events, start, end):
#    return filter(lambda e: e['at'] > start, events)


def describe(event):
    return '%s at %s' % (event['name'], event['at'])   


def busiest_day( events ):
	"""The day number (days since 1970) with the most events; the earliest such day on a tie."""
	counts = {}
	for e in events:
		counts[ e['at'] // DAY ] = counts.get( e['at'] // DAY, 0 ) + 1
	best = None
	for day in sorted( counts ):
		if best is None or counts[ day ] > counts[ best ]:
			best = day
	return best


def gaps(events, least = HOUR):
    """Pairs of neighbouring events that are at least `least` seconds apart."""
    ordered = sorted(events, key = lambda e: e['at'])
    return [(a['name'], b['name']) for a, b in zip(ordered, ordered[1:]) if b['at'] - a['at'] >= least]
