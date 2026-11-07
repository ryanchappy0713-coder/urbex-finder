/* Urbex Finder — finds abandoned / disused / ruined places from OpenStreetMap,
 * adds nearby Wikipedia history, and links each spot to Google Earth. */
(() => {
  'use strict';

  // ---------- Config ----------
  const OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter',
    'https://z.overpass-api.de/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ];
  const WIKIDATA = 'https://query.wikidata.org/sparql';
  const CACHE_DAYS = 7;
  const WIDEN_STEPS = [5000, 10000, 25000, 50000];
  const NOMINATIM = 'https://nominatim.openstreetmap.org';
  const WIKI = 'https://en.wikipedia.org/w/api.php';
  const MAX_RESULTS = 400;

  const CATEGORIES = {
    industrial:    { label: 'Industrial',          color: '#e0a23a' },
    institutional: { label: 'Hospitals & schools', color: '#e06a4f' },
    military:      { label: 'Military & bunkers',  color: '#8fa35b' },
    rail:          { label: 'Rail',                color: '#5fa8d3' },
    leisure:       { label: 'Hotels & leisure',    color: '#c77dff' },
    religious:     { label: 'Churches',            color: '#f2e8cf' },
    ruins:         { label: 'Ruins',               color: '#b08968' },
    houses:        { label: 'Houses',              color: '#9a9993' },
    other:         { label: 'Other',               color: '#6c757d' },
  };

  // ---------- State ----------
  const state = {
    center: null,          // {lat, lon}
    places: [],            // normalized results
    hidden: new Set(),     // hidden categories
    activeId: null,
    saved: loadSaved(),
  };

  // ---------- Map ----------
  const map = L.map('map', { zoomControl: true }).setView([39.5, -98.35], 4);
  const satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' });
  const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 19, attribution: '© OpenStreetMap contributors' });
  satellite.addTo(map);
  L.control.layers({ Satellite: satellite, Streets: streets }).addTo(map);
  const markerLayer = L.layerGroup().addTo(map);
  let radiusCircle = null, youMarker = null;
  const markers = new Map();

  map.on('click', (e) => setCenter(e.latlng.lat, e.latlng.lng, { pan: false }));

  // ---------- Elements ----------
  const $ = (id) => document.getElementById(id);
  const statusEl = $('status'), resultsEl = $('results'), filtersEl = $('filters');
  const detailEl = $('detail'), detailBody = $('detailBody'), savedEl = $('saved');

  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => { b.parentElement.hidden = true; }));

  $('searchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('searchInput').value.trim();
    if (!q) return;
    const ll = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (ll) return setCenter(+ll[1], +ll[2], { scan: true });
    setStatus(`Looking up “${q}”…`);
    try {
      const r = await fetchJson(`${NOMINATIM}/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`);
      if (!r.length) return setStatus(`Couldn't find “${q}”.`, true);
      setCenter(+r[0].lat, +r[0].lon, { scan: true });
    } catch (err) { setStatus(`Search failed: ${err.message}`, true); }
  });

  $('locateBtn').addEventListener('click', () => {
    if (!navigator.geolocation) return setStatus('Your browser has no location access.', true);
    setStatus('Finding your location…');
    navigator.geolocation.getCurrentPosition(
      (p) => setCenter(p.coords.latitude, p.coords.longitude, { scan: true, you: true }),
      (err) => setStatus(`Location unavailable (${err.message}). Search for a place instead.`, true),
      { enableHighAccuracy: true, timeout: 15000 });
  });

  $('scanBtn').addEventListener('click', () => {
    if (!state.center) { const c = map.getCenter(); setCenter(c.lat, c.lng, { pan: false }); }
    scan();
  });
  $('radius').addEventListener('change', () => { if (state.center) drawRadius(); });
  $('savedBtn').addEventListener('click', openSaved);
  $('exportKml').addEventListener('click', exportKml);

  // ---------- Core ----------
  function setCenter(lat, lon, { scan: doScan = false, pan = true, you = false } = {}) {
    state.center = { lat, lon };
    drawRadius();
    if (you) {
      if (youMarker) youMarker.remove();
      youMarker = L.marker([lat, lon], {
        icon: L.divIcon({ className: '', html: '<div class="you-are-here"></div>', iconSize: [16, 16] }),
        interactive: false,
      }).addTo(map);
    }
    if (pan) map.fitBounds(radiusCircle.getBounds());
    if (doScan) scan();
    else setStatus('Center set. Tap <b>Scan this area</b>.');
  }

  function drawRadius() {
    const r = +$('radius').value;
    if (radiusCircle) radiusCircle.remove();
    radiusCircle = L.circle([state.center.lat, state.center.lon], {
      radius: r, color: '#e0a23a', weight: 1, fillOpacity: 0.04, dashArray: '4 6', interactive: false,
    }).addTo(map);
  }

  // Bounding-box query with plain key lookups: much faster on Overpass than a
  // regex over every tag key. Results are trimmed to the circle client-side.
  const STATE_PREFIXES = ['abandoned', 'disused', 'ruins', 'was'];
  const FEATURE_KEYS = ['building', 'amenity', 'railway', 'man_made', 'military', 'shop',
    'tourism', 'leisure', 'industrial', 'aeroway', 'landuse', 'historic'];
  function buildQuery(lat, lon, r) {
    const dLat = r / 111320, dLon = r / (111320 * Math.cos(lat * Math.PI / 180));
    const bbox = [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map((n) => n.toFixed(5)).join(',');
    const prefixed = STATE_PREFIXES.flatMap((pre) => FEATURE_KEYS.map((k) => `  nwr["${pre}:${k}"];`)).join('\n');
    return `[out:json][timeout:25][bbox:${bbox}];
(
  nwr["abandoned"="yes"];
  nwr["disused"="yes"];
  nwr["building"~"^(ruins|abandoned)$"];
  nwr["ruins"="yes"];
  nwr["historic"~"^(ruins|mine|mine_shaft|fort|factory|kiln|railway_station|aircraft_wreck|wreck|bunker|tunnel)$"];
  nwr["railway"~"^(abandoned|disused)$"];
  nwr["military"="bunker"];
  nwr["building"="bunker"];
  nwr["shop"="vacant"];
  nwr["landuse"="brownfield"];
  nwr["man_made"~"^(mineshaft|adit)$"];
${prefixed}
);
out center tags ${MAX_RESULTS * 3};`;
  }

  async function scan() {
    if (!state.center) return;
    const { lat, lon } = state.center;
    const r = +$('radius').value;
    const btn = $('scanBtn');
    btn.disabled = true;
    setStatus(`Scanning around this point…`);
    try {
      const { places, notes } = await searchArea(lat, lon, r, (early) => {
        // Wikidata usually answers first: show those places while OpenStreetMap is still working.
        if (!early.length) return;
        const shown = show(early, r);
        setStatus(`Found <b>${shown.length}</b> places so far. Still checking OpenStreetMap for more…`);
      });
      const shown = show(places, r);
      const R = +$('radius').value;
      if (R > r && shown.length) notes.unshift(`Few places within ${r / 1000} km, so this shows the nearest ones up to ${R / 1000} km.`);
      const extra = notes.length ? `<br><small>${notes.join(' ')}</small>` : '';
      setStatus((shown.length
        ? `Found <b>${shown.length}</b> places. Tap one to research it.`
        : `Nothing found within 50 km. Try a nearby city.`) + extra);
    } catch (err) {
      setStatus(`Scan failed: ${esc(err.message)}. The free servers may be busy. Try again in a minute.`, true);
    } finally { btn.disabled = false; }
  }

  // Show places within radius r. If there are fewer than 5, show the nearest ones
  // farther out instead (up to 50 km) and grow the radius to fit them.
  const MIN_RESULTS = 5, FALLBACK_COUNT = 15;
  function show(all, r) {
    const { lat, lon } = state.center;
    const sorted = withDist(all, lat, lon, 50000);
    let shown = sorted.filter((p) => p.dist <= r);
    let R = r;
    if (shown.length < MIN_RESULTS && sorted.length > shown.length) {
      shown = sorted.slice(0, Math.max(FALLBACK_COUNT, shown.length));
      const far = shown[shown.length - 1].dist;
      R = WIDEN_STEPS.find((x) => x >= far && x >= r) || 50000;
    }
    state.places = shown;
    setRadius(R);
    render();
    return shown;
  }

  // Query OpenStreetMap (your radius) and Wikidata (50 km) at the same time.
  async function searchArea(lat, lon, r, onEarly = () => {}) {
    const key = `urbex.cache.v2.${lat.toFixed(2)},${lon.toFixed(2)},${r}`;
    const cached = readCache(key);
    if (cached) return { places: cached, notes: ['(Saved results from an earlier scan.)'] };

    let osmDone = false;
    const osmQuery = (radius) => overpass(buildQuery(lat, lon, radius))
      .then((d) => (d.elements || []).map(normalize).filter(Boolean));
    const [osm, wd] = await Promise.allSettled([
      osmQuery(r).finally(() => { osmDone = true; }),
      wikidata(lat, lon, 50000).then((w) => { if (!osmDone) onEarly(w); return w; }),
    ]);
    if (osm.status === 'rejected' && wd.status === 'rejected') {
      throw new Error(`map servers: ${osm.reason.message}; Wikidata: ${wd.reason.message}`);
    }
    const notes = [];
    let osmPlaces = osm.status === 'fulfilled' ? osm.value : [];
    const wdPlaces = wd.status === 'fulfilled' ? wd.value : [];

    // One wider OpenStreetMap try (25 km) if almost nothing turned up nearby.
    const near = (list) => list.filter((p) => haversine(lat, lon, p.lat, p.lon) <= r).length;
    if (osm.status === 'fulfilled' && r < 25000 && near(osmPlaces) + near(wdPlaces) < MIN_RESULTS) {
      setStatus(`Only a few places within ${r / 1000} km. Checking OpenStreetMap out to 25 km…`);
      try { osmPlaces = await osmQuery(25000); } catch { /* keep what we have */ }
    }
    if (osm.status === 'rejected') notes.push('OpenStreetMap servers are busy right now, so this only shows Wikidata places. Scan again later for more.');
    const places = mergeWikidata(osmPlaces, wdPlaces);
    if (osm.status === 'fulfilled' && wd.status === 'fulfilled') writeCache(key, places);
    return { places, notes };
  }

  function withDist(places, lat, lon, r) {
    return places
      .map((p) => ({ ...p, dist: haversine(lat, lon, p.lat, p.lon) }))
      .filter((p) => p.dist <= r)
      .sort((x, y) => x.dist - y.dist)
      .slice(0, MAX_RESULTS);
  }

  function setRadius(r) {
    const sel = $('radius');
    if (![...sel.options].some((o) => +o.value === r)) {
      sel.add(new Option(`${r / 1000} km`, String(r)));
    }
    if (+sel.value !== r) { sel.value = String(r); drawRadius(); map.fitBounds(radiusCircle.getBounds()); }
  }

  // Ask the servers one after another, a few seconds apart, without waiting for
  // a slow one to finish: the first good answer wins and the rest are cancelled.
  function overpass(query) {
    const ctrls = OVERPASS.map(() => new AbortController());
    const errors = [];
    return new Promise((resolve, reject) => {
      let pending = OVERPASS.length, done = false;
      OVERPASS.forEach((url, i) => {
        setTimeout(async () => {
          if (done) { pending--; return; }
          const timer = setTimeout(() => ctrls[i].abort(), 30000);
          try {
            const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query),
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctrls[i].signal });
            if (!res.ok) throw new Error(`returned ${res.status}`);
            const data = await res.json();
            // Overpass reports timeouts/overload as HTTP 200 with a "remark" and no elements.
            if (data.remark && /error|timed out|out of memory/i.test(data.remark)) throw new Error('timed out');
            if (!done) { done = true; ctrls.forEach((c, j) => j !== i && c.abort()); resolve(data); }
          } catch (e) {
            if (!done) errors.push(e.name === 'AbortError' ? 'too slow' : e.message);
          } finally {
            clearTimeout(timer);
            if (--pending === 0 && !done) reject(new Error(errors[0] || 'no answer'));
          }
        }, i * 4000);
      });
    });
  }

  // ---------- Wikidata (notable abandoned / closed places) ----------
  // abandoned, decommissioned, out of service, not in operation. "Permanently closed"
  // (Q104664889) is only used for heritage-listed items: unlisted closed buildings in
  // Wikidata are very often long demolished.
  const WD_STATES = ['Q63065035', 'Q11639308', 'Q56651571', 'Q111802839'];
  const WD_STATE_LABEL = { Q63065035: 'abandoned', Q11639308: 'decommissioned', Q104664889: 'closed',
    Q56651571: 'out of service', Q111802839: 'closed' };
  const WD_TYPES = { Q74047: 'ghost town', Q109607: 'ruins' };

  const DESC_YES = '\\\\b(abandoned|disused|derelict|defunct|ghost town|ruin|ruins|decommissioned|former (hospital|school|asylum|sanatorium|prison|jail|factory|mill|mine|power|church|hotel|military|air|army|navy|railway|train|station|theat|amusement|resort|plant|brewery|warehouse|depot|fort|missile|base))';
  const DESC_NO = 'demolish|destroyed|razed|torn down|replaced|redevelop|now (a|an|the|home|used|part)|converted|museum|company|organization|band|team|newspaper|magazine|airline|club|league|political';

  async function wikidata(lat, lon, r) {
    const around = `SERVICE wikibase:around { ?item wdt:P625 ?coord . bd:serviceParam wikibase:center "Point(${lon} ${lat})"^^geo:wktLiteral ; wikibase:radius "${r / 1000}" . }`;
    const tail = `FILTER NOT EXISTS { ?item wdt:P5817 wd:Q56556915 }
  FILTER NOT EXISTS { ?item wdt:P576 [] }
  OPTIONAL { ?item wdt:P31 ?type }
  OPTIONAL { ?item schema:description ?desc . FILTER(LANG(?desc) = "en") }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
} LIMIT 1500`;
    const byState = `SELECT ?item ?itemLabel ?state ?ty ?typeLabel ?coord ?desc ?article WHERE {
  ${around}
  { ?item wdt:P5817 ?state . VALUES ?state { ${WD_STATES.map((x) => 'wd:' + x).join(' ')} } }
  UNION { ?item wdt:P5817 ?state . VALUES ?state { wd:Q104664889 } ?item wdt:P1435 [] . }
  UNION { ?item wdt:P31 ?ty . VALUES ?ty { ${Object.keys(WD_TYPES).map((x) => 'wd:' + x).join(' ')} } }
  ${tail}`;
    const byDesc = `SELECT ?item ?itemLabel ?typeLabel ?coord ?desc ?article WHERE {
  ${around}
  ?item schema:description ?d . FILTER(LANG(?d) = "en")
  FILTER(REGEX(?d, "${DESC_YES}", "i"))
  FILTER(!REGEX(?d, "${DESC_NO}", "i"))
  ${tail}`;
    const results = await Promise.allSettled([sparql(byState), sparql(byDesc)]);
    if (results.every((x) => x.status === 'rejected')) throw results[0].reason;

    const byId = new Map();
    for (const res of results) {
      if (res.status !== 'fulfilled') continue;
      for (const b of res.value) {
        const qid = b.item.value.split('/').pop();
        const m = b.coord.value.match(/Point\(([-\d.eE]+) ([-\d.eE]+)\)/);
        if (!m) continue;
        const p = byId.get(qid) || { qid, name: b.itemLabel?.value, lat: +m[2], lon: +m[1], types: new Set(), state: null, article: null, desc: null };
        if (b.state) p.state = WD_STATE_LABEL[b.state.value.split('/').pop()];
        if (b.ty) p.state = p.state || WD_TYPES[b.ty.value.split('/').pop()];
        if (b.typeLabel && !/^Q\d+$/.test(b.typeLabel.value)) p.types.add(b.typeLabel.value);
        if (b.desc) p.desc = b.desc.value;
        if (b.article) p.article = decodeURIComponent(b.article.value.split('/wiki/').pop()).replace(/_/g, ' ');
        byId.set(qid, p);
      }
    }
    return [...byId.values()].filter((p) => p.name && !/^Q\d+$/.test(p.name)).map(wdToPlace);
  }

  async function sparql(q, retry = true) {
    try { return await sparqlOnce(q); } catch (e) {
      // Wikidata rate-limits bursts; one retry after a short pause usually works.
      if (!retry || !/too many|returned 5/.test(e.message)) throw e;
      await new Promise((ok) => setTimeout(ok, 3000));
      return sparqlOnce(q);
    }
  }
  async function sparqlOnce(q) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 40000);
    try {
      const res = await fetch(`${WIKIDATA}?format=json&query=${encodeURIComponent(q)}`,
        { headers: { Accept: 'application/sparql-results+json' }, signal: ctrl.signal });
      if (!res.ok) throw new Error(res.status === 429 ? 'too many requests, wait a minute' : `returned ${res.status}`);
      return (await res.json()).results.bindings;
    } catch (e) {
      throw e.name === 'AbortError' ? new Error('too slow') : e;
    } finally { clearTimeout(timer); }
  }

  function wdToPlace(w) {
    const descLead = w.desc ? w.desc.split(/ (?:in|near|of|at|on) |,|;| \(/)[0].trim() : '';
    const descState = (descLead.match(/^(abandoned|disused|derelict|defunct|former|decommissioned|ruined)\b/i) || [])[1];
    if (!w.state && descState) w.state = descState.toLowerCase();
    if (!w.state && /ghost town/i.test(w.desc || '')) w.state = 'ghost town';
    const type = [...w.types][0] || (descLead ? descLead.replace(/^(abandoned|disused|derelict|defunct|former|decommissioned|ruined)\s+/i, '') : 'place');
    const all = [...w.types].join(' ').toLowerCase() + ' ' + (w.state || '') + ' ' + (w.desc || '').toLowerCase();
    const cat = /hospital|asylum|sanatorium|school|college|university|prison|jail|penitentiary|orphanage/.test(all) ? 'institutional'
      : /military|fort|bunker|missile|barracks|airfield|air base|battery/.test(all) ? 'military'
      : /factory|mill|mine|plant|power|brewery|works|industrial|warehouse|silo|refinery|quarry|dam|pumping|incinerator/.test(all) ? 'industrial'
      : /railway|train|tram|subway|metro|rail|depot|tunnel/.test(all) ? 'rail'
      : /theat|cinema|drive-in|hotel|amusement|stadium|arena|park|resort|casino|mall|ballroom|motel/.test(all) ? 'leisure'
      : /church|chapel|cathedral|synagogue|mosque|temple|monastery/.test(all) ? 'religious'
      : /ghost town|ruins|castle/.test(all) ? 'ruins'
      : /house|mansion|apartment|residence|villa|farm|revenue/.test(all) ? 'houses' : 'other';
    const tags = { name: w.name, description: w.desc || '', wikidata: w.qid, 'instance of': [...w.types].join(', ') || '', 'state of use': w.state || '' };
    if (w.article) tags.wikipedia = 'en:' + w.article;
    return {
      id: `wd/${w.qid}`, source: 'wikidata', osmType: null, osmId: null,
      lat: w.lat, lon: w.lon, tags, cat, status: w.state || 'closed',
      label: cap(w.state && !['ghost town', 'ruins'].includes(w.state) && !type.toLowerCase().startsWith(w.state) ? `${w.state} ${type}` : type),
      name: w.name, hasName: true,
    };
  }

  // Wikidata items that are already on the map from OpenStreetMap get folded in
  // (their Wikipedia/Wikidata links are added); the rest are added as new places.
  function mergeWikidata(osm, wd) {
    const byQid = new Map(osm.filter((p) => p.tags.wikidata).map((p) => [p.tags.wikidata, p]));
    const out = [...osm];
    for (const w of wd) {
      const twin = byQid.get(w.tags.wikidata) ||
        osm.find((p) => haversine(p.lat, p.lon, w.lat, w.lon) < 120 && p.hasName &&
          p.name.toLowerCase().split(' ')[0] === w.name.toLowerCase().split(' ')[0]);
      if (twin) {
        twin.tags = { ...w.tags, ...twin.tags };
      } else out.push(w);
    }
    return out;
  }

  function readCache(key) {
    try {
      const c = JSON.parse(localStorage.getItem(key) || 'null');
      if (c && Date.now() - c.t < CACHE_DAYS * 864e5) return c.places;
    } catch { /* ignore */ }
    return null;
  }
  function writeCache(key, places) {
    const slim = places.map(({ dist, ...p }) => p);
    try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), places: slim })); }
    catch {
      // Storage full: drop old scan caches and try once more.
      try {
        Object.keys(localStorage).filter((k) => k.startsWith('urbex.cache.')).forEach((k) => localStorage.removeItem(k));
        localStorage.setItem(key, JSON.stringify({ t: Date.now(), places: slim }));
      } catch { /* give up quietly */ }
    }
  }

  // ---------- Classification ----------
  const PREFIXES = ['abandoned:', 'disused:', 'ruins:', 'was:', ''];
  function pick(t, key) {
    for (const p of PREFIXES) if (t[p + key] && t[p + key] !== 'no') return t[p + key];
    return null;
  }

  function normalize(el) {
    const t = el.tags || {};
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) return null;

    const railway = pick(t, 'railway');
    const named = t.name || t['abandoned:name'] || t['old_name'] || t['was:name'];
    // Old railway track is mostly noise: keep only stations, tunnels, bridges, yards and named lines.
    if (railway && /^(rail|abandoned|disused|light_rail|tram|narrow_gauge|subway)$/.test(railway)
        && el.type === 'way' && t.tunnel !== 'yes' && t.bridge !== 'yes' && !named) return null;

    const building = pick(t, 'building');
    const amenity = pick(t, 'amenity');
    const manMade = pick(t, 'man_made');
    const military = pick(t, 'military');
    const tourism = pick(t, 'tourism');
    const leisure = pick(t, 'leisure');
    const shop = pick(t, 'shop');
    const landuse = pick(t, 'landuse');
    const aeroway = pick(t, 'aeroway');
    const historic = t.historic;

    let cat = 'other', what = null;
    if (military || building === 'bunker' || landuse === 'military' || aeroway) {
      cat = 'military'; what = military || (aeroway ? `${aeroway} (airfield)` : 'bunker');
    } else if (railway) {
      cat = 'rail';
      what = t.tunnel === 'yes' ? 'railway tunnel' : t.bridge === 'yes' ? 'railway bridge'
        : /station|halt|platform/.test(railway) ? 'railway station' : `railway ${railway}`;
    } else if (/^(hospital|clinic|school|college|university|prison|kindergarten|nursing_home|townhall|courthouse)$/.test(amenity || '')
        || /^(hospital|school|university|college|prison)$/.test(building || '')) {
      cat = 'institutional'; what = amenity || building;
    } else if (/^(place_of_worship|monastery)$/.test(amenity || '') || /^(church|chapel|cathedral|mosque|temple|synagogue)$/.test(building || '')) {
      cat = 'religious'; what = building && building !== 'yes' ? building : 'church';
    } else if (manMade || t.industrial || /^(industrial|quarry|brownfield)$/.test(landuse || '')
        || /^(industrial|factory|warehouse|manufacture|silo|hangar|power|greenhouse)$/.test(building || '')) {
      cat = 'industrial'; what = manMade || t.industrial || (building !== 'yes' && building) || landuse;
    } else if (tourism || leisure || /^(theatre|cinema|nightclub|swimming_pool|casino)$/.test(amenity || '')
        || /^(hotel|stadium|grandstand)$/.test(building || '')) {
      cat = 'leisure'; what = tourism || leisure || amenity || building;
    } else if (/^(house|residential|detached|farm|apartments|cabin|bungalow|villa|farm_auxiliary|barn)$/.test(building || '')) {
      cat = 'houses'; what = building;
    } else if (historic === 'ruins' || t.ruins === 'yes' || building === 'ruins' || historic) {
      cat = 'ruins'; what = t['ruins:building'] || t.castle_type || (historic && historic !== 'ruins' ? historic : 'ruins');
    } else {
      what = amenity || shop || (building && building !== 'yes' ? building : null) || 'site';
    }

    const status = isState(t, 'ruins') || building === 'ruins' || historic === 'ruins' ? 'ruined'
      : isState(t, 'abandoned') ? 'abandoned' : isState(t, 'disused') ? 'disused'
      : isState(t, 'was') ? 'former' : 'unknown';

    const nice = { works: 'factory', ruins: 'ruins', yes: 'building', vacant: 'vacant storefront', brownfield: 'brownfield site', mine_shaft: 'mine shaft' }[what] || human(what);
    const label = nice === 'ruins' ? 'Ruins'
      : cap(`${status === 'unknown' ? '' : status + ' '}${nice}`.trim());
    return {
      id: `${el.type}/${el.id}`, osmType: el.type, osmId: el.id,
      lat, lon, tags: t, cat, status, label,
      name: named || label,
      hasName: !!named,
    };
  }
  function isState(t, s) {
    return t[s] === 'yes' || Object.keys(t).some((k) => k.startsWith(s + ':'));
  }
  const human = (s) => String(s || 'site').replace(/_/g, ' ').replace(/;.*/, '');
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // ---------- Rendering ----------
  function render() {
    // Filters
    const counts = {};
    state.places.forEach((p) => { counts[p.cat] = (counts[p.cat] || 0) + 1; });
    filtersEl.innerHTML = '';
    Object.entries(CATEGORIES).forEach(([k, c]) => {
      if (!counts[k]) return;
      const b = document.createElement('button');
      b.className = 'chip' + (state.hidden.has(k) ? ' off' : '');
      b.innerHTML = `<i style="background:${c.color}"></i>${c.label} ${counts[k]}`;
      b.onclick = () => { state.hidden.has(k) ? state.hidden.delete(k) : state.hidden.add(k); render(); };
      filtersEl.appendChild(b);
    });

    // List + markers
    resultsEl.innerHTML = '';
    markerLayer.clearLayers();
    markers.clear();
    state.places.filter((p) => !state.hidden.has(p.cat)).forEach((p) => {
      const color = CATEGORIES[p.cat].color;
      const li = document.createElement('li');
      li.dataset.id = p.id;
      if (p.id === state.activeId) li.className = 'active';
      li.innerHTML = `<span class="dot" style="background:${color}"></span>
        <span class="name">${state.saved[p.id] ? '★ ' : ''}${esc(p.name)}</span>
        <span class="dist">${fmtDist(p.dist)}</span>
        <span class="sub">${esc(p.hasName ? p.label : CATEGORIES[p.cat].label)}${accessWarning(p.tags) ? ' · ⚠ private' : ''}</span>`;
      li.onclick = () => openDetail(p);
      resultsEl.appendChild(li);

      const m = L.circleMarker([p.lat, p.lon], {
        radius: p.hasName ? 7 : 5, color: '#000', weight: 1, fillColor: color, fillOpacity: 0.95,
      }).bindTooltip(esc(p.name)).on('click', () => openDetail(p));
      m.addTo(markerLayer);
      markers.set(p.id, m);
    });
  }

  function accessWarning(t) {
    return /^(private|no|military)$/.test(t.access || '') ? (t.access) : null;
  }

  // ---------- Detail / research ----------
  async function openDetail(p) {
    state.activeId = p.id;
    savedEl.hidden = true;
    document.querySelectorAll('.results li').forEach((li) => li.classList.toggle('active', li.dataset.id === p.id));
    map.setView([p.lat, p.lon], Math.max(map.getZoom(), 17));
    markers.get(p.id)?.openTooltip();

    const t = p.tags;
    const access = accessWarning(t);
    const cat = CATEGORIES[p.cat];
    const earth = `https://earth.google.com/web/@${p.lat},${p.lon},120a,450d,35y,0h,55t,0r`;
    const gmapsSat = `https://www.google.com/maps/@?api=1&map_action=map&center=${p.lat},${p.lon}&zoom=19&basemap=satellite`;
    const streetView = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.lat},${p.lon}`;
    const source = p.source === 'wikidata'
      ? `<a href="https://www.wikidata.org/wiki/${p.tags.wikidata}" target="_blank" rel="noopener">Wikidata ${esc(p.tags.wikidata)}</a>`
      : `<a href="https://www.openstreetmap.org/${p.osmType}/${p.osmId}" target="_blank" rel="noopener">OpenStreetMap ${p.osmType} ${p.osmId}</a>`;
    const saved = state.saved[p.id];

    detailBody.innerHTML = `
      <h2>${esc(p.name)}</h2>
      <div class="muted">${esc(p.label)} · ${fmtDist(p.dist)} away · ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</div>
      <div class="badges">
        <span class="badge" style="border-color:${cat.color};color:${cat.color}">${cat.label}</span>
        ${access ? `<span class="badge warn">Access: ${esc(access)}</span>` : ''}
        ${t.start_date ? `<span class="badge">Built ${esc(t.start_date)}</span>` : ''}
        ${t.end_date || t['end_date'] ? `<span class="badge">Closed ${esc(t.end_date)}</span>` : ''}
        ${t.heritage || t['heritage:operator'] ? '<span class="badge good">Heritage listed</span>' : ''}
      </div>

      ${p.source === 'wikidata' ? '<p class="muted" style="font-size:12px">From Wikidata. Wikidata sometimes misses demolitions, so check the satellite view to make sure it\'s still standing.</p>' : ''}
      <h3>Look at it</h3>
      <div class="row">
        <a class="btn accent" href="${earth}" target="_blank" rel="noopener">🌍 Open in Google Earth</a>
        <a class="btn" href="${gmapsSat}" target="_blank" rel="noopener">Satellite</a>
        <a class="btn" href="${streetView}" target="_blank" rel="noopener">Street View</a>
      </div>

      <h3>Research</h3>
      <div class="row" id="searchLinks"><span class="muted">Finding the nearest town…</span></div>
      <h3>Nearby on Wikipedia</h3>
      <ul class="wiki" id="wiki"><li class="muted">Loading…</li></ul>

      <h3>My notes</h3>
      <textarea id="note" placeholder="Access points, condition, who to ask for permission…">${esc(saved?.note || '')}</textarea>
      <div class="row" style="margin-top:8px">
        <button class="btn ${saved ? '' : 'accent'}" id="saveBtn">${saved ? '★ Saved (update note)' : '☆ Save spot'}</button>
        ${saved ? '<button class="btn ghost" id="unsaveBtn">Remove</button>' : ''}
      </div>

      <h3>${p.source === 'wikidata' ? 'Wikidata' : 'Map data'}</h3>
      <table class="tags">${Object.entries(t).filter(([, v]) => v).map(([k, v]) =>
        `<tr><td>${esc(k)}</td><td>${linkify(k, v)}</td></tr>`).join('')}</table>
      <p class="muted" style="font-size:12px">Source: ${source}. Spot an error? You can fix it there.</p>
    `;
    detailEl.hidden = false;
    detailEl.scrollTop = 0;

    $('saveBtn').onclick = () => { saveSpot(p, $('note').value); openDetail(p); render(); };
    if (saved) $('unsaveBtn').onclick = () => { delete state.saved[p.id]; persist(); openDetail(p); render(); };

    loadResearch(p);
  }

  async function loadResearch(p) {
    const id = p.id;
    // Wikipedia: articles geotagged within 1 km.
    fetchJson(`${WIKI}?action=query&list=geosearch&gscoord=${p.lat}|${p.lon}&gsradius=1000&gslimit=6&format=json&origin=*`)
      .then((r) => {
        if (state.activeId !== id) return;
        const items = r.query?.geosearch || [];
        $('wiki').innerHTML = items.length ? items.map((w) =>
          `<li><a href="https://en.wikipedia.org/?curid=${w.pageid}" target="_blank" rel="noopener">${esc(w.title)}</a>
           <small> · ${fmtDist(w.dist)}</small></li>`).join('')
          : '<li class="muted">No geotagged articles within 1 km.</li>';
      })
      .catch(() => { if (state.activeId === id) $('wiki').innerHTML = '<li class="muted">Wikipedia unavailable.</li>'; });

    // Reverse geocode for town name, then build targeted search links.
    let town = '';
    try {
      const r = await fetchJson(`${NOMINATIM}/reverse?format=jsonv2&zoom=12&lat=${p.lat}&lon=${p.lon}`);
      const a = r.address || {};
      town = [a.city || a.town || a.village || a.hamlet || a.county, a.state].filter(Boolean).join(', ');
    } catch { /* fine without it */ }
    if (state.activeId !== id) return;

    const subject = p.hasName ? `"${p.name}"` : p.label;
    const q = (extra) => encodeURIComponent(`${subject} ${town} ${extra}`.trim());
    const links = [
      ['History', `https://www.google.com/search?q=${q('history')}`],
      ['Urbex reports', `https://www.google.com/search?q=${q('urbex OR "urban exploration" OR abandoned')}`],
      ['Photos', `https://www.google.com/search?tbm=isch&q=${q('abandoned')}`],
      ['YouTube', `https://www.youtube.com/results?search_query=${q('abandoned')}`],
      ['Old news', `https://www.google.com/search?tbm=nws&q=${q('closed OR demolition OR fire')}`],
      ['Owner / demolition', `https://www.google.com/search?q=${q('owner OR "for sale" OR demolition OR redevelopment')}`],
    ];
    $('searchLinks').innerHTML = (town ? `<div class="muted" style="width:100%">Near ${esc(town)}</div>` : '') +
      links.map(([l, u]) => `<a class="btn" href="${u}" target="_blank" rel="noopener">${l}</a>`).join('');
  }

  // ---------- Saved spots ----------
  function saveSpot(p, note) {
    state.saved[p.id] = { id: p.id, name: p.name, label: p.label, lat: p.lat, lon: p.lon, cat: p.cat,
      note: note || '', savedAt: new Date().toISOString() };
    persist();
  }
  function loadSaved() {
    try { return JSON.parse(localStorage.getItem('urbex.saved') || '{}'); } catch { return {}; }
  }
  function persist() {
    try { localStorage.setItem('urbex.saved', JSON.stringify(state.saved)); } catch { /* private mode */ }
    $('savedCount').textContent = Object.keys(state.saved).length;
  }
  function openSaved() {
    detailEl.hidden = true;
    const list = Object.values(state.saved).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    $('savedList').innerHTML = list.length ? '' : '<li class="muted">Nothing saved yet.</li>';
    list.forEach((s) => {
      const li = document.createElement('li');
      li.innerHTML = `<span><b>${esc(s.name)}</b><br><small class="muted">${esc(s.label)}${s.note ? ' · ' + esc(s.note.slice(0, 60)) : ''}</small></span>
        <a class="btn" href="https://earth.google.com/web/@${s.lat},${s.lon},120a,450d,35y,0h,55t,0r" target="_blank" rel="noopener">🌍</a>`;
      li.querySelector('span').onclick = () => {
        const p = state.places.find((x) => x.id === s.id) ||
          { ...s, tags: s.id.startsWith('wd/') ? { wikidata: s.id.slice(3) } : {}, status: '', hasName: true,
            source: s.id.startsWith('wd/') ? 'wikidata' : 'osm', osmType: s.id.split('/')[0], osmId: s.id.split('/')[1],
            dist: state.center ? haversine(state.center.lat, state.center.lon, s.lat, s.lon) : 0 };
        openDetail(p);
      };
      $('savedList').appendChild(li);
    });
    savedEl.hidden = false;
  }
  function exportKml() {
    const list = Object.values(state.saved);
    if (!list.length) return alertish('Save some spots first.');
    const x = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Urbex Finder spots</name>
<Style id="spot"><IconStyle><color>ff3aa2e0</color><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>
${list.map((s) => `<Placemark><name>${x(s.name)}</name><styleUrl>#spot</styleUrl>
<description>${x(s.label)}${s.note ? '\n\n' + x(s.note) : ''}\n\n${x(sourceUrl(s.id))}</description>
<Point><coordinates>${s.lon},${s.lat},0</coordinates></Point></Placemark>`).join('\n')}
</Document></kml>`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' }));
    a.download = 'urbex-spots.kml';
    document.body.appendChild(a); a.click(); a.remove();
  }
  function alertish(msg) { setStatus(msg, true); }
  function sourceUrl(id) {
    return id.startsWith('wd/') ? `https://www.wikidata.org/wiki/${id.slice(3)}` : `https://www.openstreetmap.org/${id}`;
  }

  // ---------- Utils ----------
  async function fetchJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  function setStatus(html, isErr = false) {
    statusEl.innerHTML = html;
    statusEl.classList.toggle('error', isErr);
  }
  function haversine(a, b, c, d) {
    const R = 6371000, r = Math.PI / 180;
    const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function linkify(k, v) {
    if (k === 'wikipedia' && v.includes(':')) {
      const [lang, title] = v.split(/:(.+)/);
      return `<a href="https://${esc(lang)}.wikipedia.org/wiki/${encodeURIComponent(title)}" target="_blank" rel="noopener">${esc(v)}</a>`;
    }
    if (k === 'wikidata') return `<a href="https://www.wikidata.org/wiki/${encodeURIComponent(v)}" target="_blank" rel="noopener">${esc(v)}</a>`;
    if (/^https?:\/\//.test(v)) return `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a>`;
    return esc(v);
  }

  const fix = document.createElement('style');
  fix.textContent = `.leaflet-control-layers-toggle{background-image:none!important;display:flex!important;align-items:center;justify-content:center;font-size:20px;text-decoration:none;color:#333}
    .leaflet-control-layers-toggle::after{content:"\\25A4"}`;
  document.head.appendChild(fix);

  persist();
  // Expose for tests.
  window.__urbex = { normalize, state };
})();
