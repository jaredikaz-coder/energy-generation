# Bundled data

`plants.json` and `generators.json` are built from OpenStreetMap by
`tools/fetch-power-data.mjs` and refreshed weekly by
`.github/workflows/update-power-data.yml`. They are generated files — edit the
script, not these.

Each file is compact by design: a `fields` list naming the columns, then `rows`
of plain arrays in that order. Capacity (`mw`) is the **nameplate** rating
recorded in OpenStreetMap, not live output.

Data © OpenStreetMap contributors, licensed [ODbL](https://www.openstreetmap.org/copyright).
