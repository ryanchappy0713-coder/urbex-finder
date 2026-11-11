"""Re-pin approximate spots on the park, trail, gulch or pass named in them instead of the town center.

Usage: python3 tools/refix_pins.py   (edits data/researched-spots.json in place)
Uses the same Nominatim helpers as ingest_sweep.py (1 request/second).
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, 'ingest_sweep.py')).read()
# Pull in the helper functions (q, km, inCO, landmarks) without running the ingest itself.
ns = {'__file__': os.path.join(HERE, 'ingest_sweep.py')}
exec(src[:src.index('data = json.load')].replace("P = ", "P_unused = "), ns)
start, end = src.index('LM_RE'), src.index('towncache = {}')
exec(src[start:end], ns)
q, km, inCO, landmarks = ns['q'], ns['km'], ns['inCO'], ns['landmarks']

P = os.path.join(HERE, '..', 'data', 'researched-spots.json')
data = json.load(open(P))
AREA = {'city', 'town', 'village', 'hamlet', 'administrative', 'county', 'locality', 'suburb', 'neighbourhood'}
moved = 0
for s in data['spots']:
    if not s.get('approx') or s.get('pin') == 'landmark':
        continue
    for lm in landmarks(s['name'] + ' ; ' + s.get('location', ''))[:2]:
        r = q(f'{lm}, Colorado')
        if not r:
            continue
        la, lo = float(r[0]['lat']), float(r[0]['lon'])
        if not inCO(la, lo) or r[0].get('type') in AREA or km(la, lo, s['lat'], s['lon']) > 30:
            continue
        print(f"{s['name'][:50]:50s} -> {lm} ({km(la, lo, s['lat'], s['lon']):.1f} km)", flush=True)
        s['lat'], s['lon'], s['pin'] = round(la, 5), round(lo, 5), 'landmark'
        moved += 1
        break
json.dump(data, open(P, 'w'), indent=1, ensure_ascii=False)
print('moved', moved)
