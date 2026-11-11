"""Ingest sweep results: dedupe -> geocode -> verify against town -> merge into researched-spots.json."""
import json, time, urllib.parse, urllib.request, ssl, re, math, glob, sys, os
ctx = ssl.create_default_context(cafile='/root/.ccr/ca-bundle.crt') if os.path.exists('/root/.ccr/ca-bundle.crt') else ssl.create_default_context()
UA = 'UrbexFinder/0.1 (one-time geocode of researched places; https://github.com/ryanchappy0713-coder/urbex-finder)'
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "researched-spots.json")
def norm(n): return re.sub(r'\b(the|ghost town|townsite|abandoned|former|old)\b', ' ', re.sub(r'[^a-z0-9 ]+', ' ', re.sub(r'\(.*?\)', '', n.lower()))).split()
def key(n): return ' '.join(norm(n))
def slug(n): return re.sub(r'[^a-z0-9]+', '-', n.lower()).strip('-')[:60]
def q(t):
    u = 'https://nominatim.openstreetmap.org/search?' + urllib.parse.urlencode({'q': t, 'format': 'jsonv2', 'limit': 1, 'countrycodes': 'us'})
    for a in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': UA}), context=ctx, timeout=30) as r:
                res = json.load(r); time.sleep(1.1); return res
        except Exception: time.sleep(3)
    return []
def km(a, b, c, d):
    p = math.pi / 180; x = math.sin((c - a) * p / 2) ** 2 + math.cos(a * p) * math.cos(c * p) * math.sin((d - b) * p / 2) ** 2
    return 12742 * math.asin(math.sqrt(x))
inCO = lambda la, lo: 36.9 <= la <= 41.1 and -109.1 <= lo <= -102.0
CAT = [(r'race track|amusement|water park|hotel|motel|lodge|resort|ski|theater|drive-in|mall|bowling|rink', 'leisure'), (r'hospital|school|sanatorium|prison|asylum|college', 'institutional'),
       (r'missile|military', 'military'), (r'factory|mill|power plant|mine|grain elevator|uranium|smelter|plant', 'industrial'), (r'railroad|rail|depot', 'rail'),
       (r'church', 'religious'), (r'house|mansion|farmhouse|cabin', 'houses'), (r'ghost town', 'ruins')]
def cat(t):
    for pat, c in CAT:
        if re.search(pat, t): return c
    return 'other'
data = json.load(open(P))
have = {key(s['name']) for s in data['spots']} | {key('Mile High Greyhound Park')}
GENERIC = {'ruins','building','buildings','remains','site','camp','store','general','house','school','church','hotel','vacant','co','colorado','of','and','at','in','upper','floors'}
havesets = [set(h.split()) - GENERIC for h in have]
havesets = [h for h in havesets if len(h) >= 2]
items, seen = [], set()
for f in sorted(glob.glob(os.path.join(sys.argv[1] if len(sys.argv) > 1 else '.', 'agent_*.json'))):
    for it in json.load(open(f)):
        k = key(it.get('name', ''))
        if not k or k in seen or k in have or not it.get('sources'): continue
        # near-duplicate: an existing name's words are all inside the new one (or vice versa)
        ws = set(k.split()) - GENERIC
        if any(h and (h <= ws or ws <= h) for h in havesets): continue
        # skip anything whose condition says it's gone or reopened
        if re.search(r'\b(demolished|torn down|razed|reopened|now a museum|redeveloped into)\b', it.get('condition', ''), re.I) and not re.search(r'partly|partially|still stand|whether it|no source|not confirm|demolished yet|can.t be demolished|cannot be demolished|not (been )?demolished|no (later )?report', it.get('condition', ''), re.I): continue
        seen.add(k); items.append(it)
print(len(items), 'new unique places', flush=True)
LM_RE = re.compile(r"((?:[A-Z][\w'.&-]*\s+){1,5}(?:National Wildlife Refuge|Open Space|Natural Area|State Park|State Wildlife Area|Recreation Area|Park|Trailhead|Gulch|Pass|Canyon|Reservoir|Lake|Mountain|Mesa|Preserve|Refuge|Ranch))\b")
STOP = {'The', 'A', 'An', 'Former', 'Old', 'Historic', 'Abandoned'}
def landmarks(text):
    out = []
    for m in LM_RE.findall(text):
        words = m.split()
        while words and words[0] in STOP: words = words[1:]
        lm = ' '.join(words)
        if len(words) >= 2 and lm not in out and not re.search(r'National (Park|Forest|Monument)$', lm): out.append(lm)
    return out[:4]
towncache = {}
def town_pos(town):
    t = re.sub(r'^(?:near|south of|north of|east of|west of|between|just \w+ of|outside)\s+', '', town.split(',')[0], flags=re.I)
    t = re.sub(r'\s*\(.*?\)|\s+area$', '', t).strip()
    county = town.split(',')[1].strip() if ',' in town else ''
    k = f'{t}, {county}, Colorado' if county else f'{t}, Colorado'
    if k not in towncache:
        r = q(k) or (q(f'{county}, Colorado') if county else [])
        towncache[k] = (float(r[0]['lat']), float(r[0]['lon'])) if r and inCO(float(r[0]['lat']), float(r[0]['lon'])) else None
    return towncache[k]
added = 0
for it in items:
    tp = town_pos(it.get('town', ''))
    pos, approx = None, True
    tries = []
    loc = it.get('location', '')
    if re.match(r'^\d+ ', loc): tries.append(loc + ', ' + it.get('town', '').split(',')[0] + ', Colorado')
    tries.append(re.sub(r'\(.*?\)', '', it['name']).strip() + ', Colorado')
    # Parks, trails, gulches, passes etc. named in the name or location pin far better than the town center.
    for lm in landmarks(it['name'] + ' ; ' + loc):
        tries.append(f'{lm}, Colorado')
    for t in tries:
        r = q(t)
        if r and inCO(float(r[0]['lat']), float(r[0]['lon'])):
            la, lo = float(r[0]['lat']), float(r[0]['lon'])
            if tp and km(la, lo, *tp) > 30: continue  # matched something with the same name elsewhere
            area = r[0].get('type') in ('city', 'town', 'village', 'hamlet', 'administrative', 'county', 'locality')
            pos, approx = (la, lo), area and it.get('type') != 'ghost town'
            break
    if not pos and tp: pos, approx = tp, True
    if not pos: print('MISS', it['name']); continue
    data['spots'].append({'id': slug(it['name']), 'name': it['name'], 'cat': cat(it.get('type', '')), 'type': it.get('type', 'site') if it.get('type') != 'other' else 'site',
        'lat': round(pos[0], 5), 'lon': round(pos[1], 5), 'approx': bool(approx),
        'location': (loc + ', ' + it.get('town', '')) if it.get('town', '').split(',')[0] not in loc else loc,
        'condition': it.get('condition', ''), 'access': it.get('access', 'unknown'), 'sources': it['sources'][:3]})
    data['spots'][-1]['added'] = __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(timespec='seconds')
    if it.get('security') or it.get('legal'):
        yr = re.findall(r'(?:19|20)\d\d', it.get('security_notes', '') + ' ' + it.get('condition', ''))
        data['spots'][-1]['verify'] = {k: v for k, v in {'status': 'standing', 'security': it.get('security'), 'security_notes': it.get('security_notes'),
            'legal': it.get('legal'), 'as_of': max(yr) if yr else '', 'sources': it['sources'][:3], 'checked': __import__('datetime').date.today().isoformat()}.items() if v}
    added += 1
    print(('APX ' if approx else 'OK  ') + it['name'][:60], flush=True)
data['researched'] = '2026-11-08'
json.dump(data, open(P, 'w'), indent=1)
print('done: added', added, '| total spots', len(data['spots']))

# Usage: python3 tools/ingest_sweep.py <folder with agent_*.json files>
# Each agent_*.json is a JSON array of {name, type, town, location, condition, access, sources}.
# New places are de-duplicated against data/researched-spots.json, geocoded with Nominatim
# (1 request/second), checked against their town (pins >30 km from the town are rejected),
# and appended. Review the diff, then commit and push.
