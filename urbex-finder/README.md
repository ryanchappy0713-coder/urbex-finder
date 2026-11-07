# Urbex Finder

Finds abandoned, disused and ruined places near you, helps you research them,
and opens each one in Google Earth.

## Run it

```bash
cd urbex-finder
python3 -m http.server 8000
```

Then open http://localhost:8000. "Near me" needs `localhost` or HTTPS. To use it on your
phone, host the folder on any static host (GitHub Pages, Netlify, Cloudflare Pages).

## How it works

- **Finding places:** OpenStreetMap's Overpass API, searching for `abandoned=*`, `disused=*`,
  `ruins=*`, `historic=ruins`, `abandoned:*` / `disused:*` / `was:*` tags, old railway sites and bunkers.
  Plain old railway track is filtered out because there's too much of it.
- **Research:** nearby Wikipedia articles, plus ready-made searches for history, urbex
  reports, photos, YouTube, old news and owner/demolition news, using the place name and town.
- **Google Earth:** a one-click 3D view of each spot, and saved spots export as KML for
  Google Earth (Projects → Open → Import KML file).
- **Saved spots and notes** are kept in your browser (localStorage).

No API keys needed. Every data source is free. Please be gentle with the free servers.

## Files

`index.html` (layout), `style.css`, `app.js` (all logic), `vendor/` (Leaflet 1.9.4).

## Be safe

Map data can be old. Places may be demolished, guarded, private or structurally unsafe.
Check who owns a site and get permission, never force entry, and don't explore alone.
