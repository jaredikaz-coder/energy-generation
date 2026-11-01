# ⚡ Live Energy Map

A live map of electricity generation — with **your own location on it**.

Open it on a phone or a laptop and you get three live things on one screen:

- **Your location dot** — a pulsing marker with an accuracy ring, updated
  continuously from your device. **Follow** keeps the map centred on you as you
  move, and the panel shows latitude, longitude, accuracy, speed/heading and the
  time of the last fix.
- **The grid right now** — carbon intensity in gCO₂/kWh plus the live generation
  mix (wind, gas, nuclear, solar, hydro, biomass, coal, imports) for the current
  half hour, from National Grid ESO's
  [Carbon Intensity API](https://carbonintensity.org.uk/). It refreshes itself
  every five minutes. Each of the 14 GB distribution regions is plotted and
  shaded by its own live intensity — tap one for its local mix.
- **Power stations around you** — these ship with the site as a data file built
  from [OpenStreetMap](https://www.openstreetmap.org/), so they appear instantly
  with no waiting: coloured by fuel, sized by capacity, totted up in the sidebar
  with the one nearest to you named. Outside the covered area, or when you tap
  **Scan this area** for a live check, the map queries
  [Overpass](https://overpass-api.de/) directly instead.

No accounts, no API keys, no build step, no server code. Three static files.

## Use it on your phone

Published with GitHub Pages:

1. **Settings → Pages →** Source: *Deploy from a branch*, Branch: `main`,
   folder `/ (root)` → **Save**.
2. A minute later the page is live at
   `https://jaredikaz-coder.github.io/energy-generation/`
3. Open that on your phone, tap **Locate me** and allow location, then
   **Scan this area**. Share → **Add to Home Screen** makes it open like an app.

**It must be `https://`** — browsers only share location over https or
localhost. Opening the file straight off a phone's storage, or over
`http://192.168.…`, shows the map but no location dot.

## Run it locally

```bash
git clone https://github.com/jaredikaz-coder/energy-generation.git
cd energy-generation
python3 -m http.server 8000
```

Then open <http://localhost:8000> — `localhost` counts as a secure context, so
the location dot works there too.

## Honest limits

- **Live mix and carbon intensity are published for Great Britain.** Everywhere
  else the map, your location dot and the power-station scan still work, and the
  page says on screen that the grid figures describe GB rather than your local
  grid. Adding another country means one more fetch plus a fuel-name mapping in
  `app.js`.
- **Site capacities are nameplate ratings** recorded in OpenStreetMap, not live
  output — labelled as such in every popup. Live output is the grid mix panel.
- OpenStreetMap coverage of power infrastructure is good but not complete, and
  Overpass rate-limits busy clients; if a scan fails, wait a moment and tap
  **Scan this area** again.

### Where the station data comes from

Power stations change on the scale of years, so they are **not** fetched live.
`tools/fetch-power-data.mjs` queries OpenStreetMap once and writes two compact
files that the page loads directly:

| File | Contents | Loaded |
| ---- | -------- | ------ |
| `data/plants.json` | every `power=plant` in the covered area | at startup |
| `data/generators.json` | individual generators (turbines, arrays, sets) | when you zoom past level 12 |

`.github/workflows/update-power-data.yml` re-runs that script **every Sunday**
and commits the result if anything changed, so the data stays current without
anyone waiting on a query. You can also run it on demand from the Actions tab,
or locally with `node tools/fetch-power-data.mjs` (set `BBOX="south,west,north,east"`
to cover a different area).

Overpass is still used, but only where the files cannot help: outside the
covered area, and when you tap **Scan this area** for a deliberate live check.
Those live queries ask the fastest mirror first and bring two others in only if
it is still thinking, cache what they find for an hour, and persist it in local
storage along with your last map view. Markers draw on a canvas and are added
and removed incrementally, so panning stays smooth on a phone.
- Needs an internet connection: map tiles and all three feeds are remote.

## Privacy

Your position is read in your browser and used only to draw your dot, centre the
map and measure distances to power stations. It is never sent anywhere — there is
no backend, and the page stores nothing about you.

## Files

| File | Purpose |
| ---- | ------- |
| `index.html` | Page structure |
| `styles.css` | Styling, light and dark themes |
| `app.js` | Geolocation, grid data, dataset loading, live scanning, rendering |
| `data/*.json` | Generated power-station data (see `data/README.md`) |
| `tools/fetch-power-data.mjs` | Builds that data from OpenStreetMap |
| `.github/workflows/update-power-data.yml` | Weekly refresh of the data |

## Credits

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors ·
power station data via the [Overpass API](https://overpass-api.de/) ·
grid data from the [Carbon Intensity API](https://carbonintensity.org.uk/)
(National Grid ESO) · map rendering by [Leaflet](https://leafletjs.com/).

## Licence

[MIT](LICENSE)
