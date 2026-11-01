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
- **Power stations around you** — tap **Scan this area** (or just pan and zoom)
  and the map queries [OpenStreetMap via Overpass](https://overpass-api.de/) for
  power plants and generators in view, coloured by fuel and sized by capacity.
  The sidebar totals them up and names the one nearest to you.

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

### Why scanning feels quick

Overpass queues requests, so a single query can sit waiting for seconds. The
page works around that: it asks the fastest mirror first and brings two others
in only if that one is still thinking (first usable answer wins, the rest are
cancelled); it remembers every site and every rectangle it has already covered
for an hour, so panning back over old ground never touches the network; it keeps
that memory in local storage, so a reopened page is populated before you tap
anything, and it reopens on the view you left; below zoom 12 it asks only for
whole power plants rather than every individual turbine; and markers are drawn
on a canvas so hundreds of them stay smooth on a phone.
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
| `app.js` | Geolocation, grid data, Overpass scanning, rendering |

## Credits

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors ·
power station data via the [Overpass API](https://overpass-api.de/) ·
grid data from the [Carbon Intensity API](https://carbonintensity.org.uk/)
(National Grid ESO) · map rendering by [Leaflet](https://leafletjs.com/).

## Licence

[MIT](LICENSE)
