#!/usr/bin/env node
/**
 * Build the bundled power-station dataset.
 *
 * Queries OpenStreetMap (via Overpass) for every power plant and generator in
 * the covered area and writes two compact JSON files that the map loads
 * directly, so the page does not have to query Overpass to show anything.
 *
 *   data/plants.json      every power=plant      (loaded at any zoom)
 *   data/generators.json  individual generators  (loaded when zoomed in)
 *
 * Run by .github/workflows/update-power-data.yml once a week, and by hand with
 * `node tools/fetch-power-data.mjs`. Override the area or endpoint with:
 *   BBOX="south,west,north,east"   OVERPASS_URL="https://…/api/interpreter"
 */
import { writeFile, mkdir } from 'node:fs/promises';

const MIRRORS = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://overpass.private.coffee/api/interpreter'
    ];

// Great Britain and its offshore wind farms.
const BBOX = (process.env.BBOX || '49.8,-8.7,61.2,2.2').split(',').map(Number);
const TILE_DEG = Number(process.env.TILE_DEG || 1.5);
const PAUSE_MS = Number(process.env.PAUSE_MS || 2000);

const GENERATOR_SOURCES =
  '^(wind|hydro|nuclear|coal|gas|oil|diesel|biomass|biofuel|biogas|waste|geothermal|battery|pumped_storage|solar)$';

const SOURCE_MAP = {
  wind: 'wind', solar: 'solar', hydro: 'hydro', tidal: 'hydro', wave: 'hydro',
  nuclear: 'nuclear', gas: 'gas', biogas: 'gas', coal: 'coal', oil: 'coal',
  diesel: 'coal', biomass: 'biomass', biofuel: 'biomass', waste: 'biomass',
  battery: 'storage', pumped_storage: 'storage', hydrogen: 'storage',
  geothermal: 'other'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseCapacityMW(raw) {
  if (!raw) return null;
  const m = String(raw).replace(/,/g, '').match(/(-?\d+(?:\.\d+)?)\s*([kKmMgG]?)[wW]?/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'k') return n / 1000;
  if (unit === 'g') return n * 1000;
  if (unit === 'm') return n;
  return n / 1e6;
}

function sourceOf(tags) {
  const raw = tags['plant:source'] || tags['generator:source'] || tags['plant:method'] || '';
  return SOURCE_MAP[String(raw).split(';')[0].trim().toLowerCase()] || 'other';
}

async function overpass(query) {
  let lastErr;
  for (let attempt = 0; attempt < MIRRORS.length * 2; attempt++) {
    const url = MIRRORS[attempt % MIRRORS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query)
      });
      if (res.status === 429 || res.status === 504) throw new Error('busy: HTTP ' + res.status);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      lastErr = err;
      const wait = 3000 * (attempt + 1);
      console.warn(`  ! ${url} failed (${err.message}); retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

function tiles([s, w, n, e]) {
  const out = [];
  for (let lat = s; lat < n; lat += TILE_DEG) {
    for (let lon = w; lon < e; lon += TILE_DEG) {
      out.push([lat, lon, Math.min(lat + TILE_DEG, n), Math.min(lon + TILE_DEG, e)]);
    }
  }
  return out;
}

function collect(elements, into, kind) {
  let added = 0;
  for (const el of elements || []) {
    const tags = el.tags || {};
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    const id = (el.type === 'node' ? 'n' : el.type === 'way' ? 'w' : 'r') + '/' + el.id;
    if (into.has(id)) continue;
    into.set(id, [
      id,
      Number(lat.toFixed(5)),
      Number(lon.toFixed(5)),
      sourceOf(tags),
      parseCapacityMW(tags['plant:output:electricity'] || tags['generator:output:electricity']),
      tags.name || null,
      tags.operator || null,
      kind
    ]);
    added++;
  }
  return added;
}

async function build(kind, selector, outfile) {
  const found = new Map();
  const boxes = tiles(BBOX);
  console.log(`\n${kind}: ${boxes.length} tiles`);
  for (const [s, w, n, e] of boxes) {
    const bbox = [s, w, n, e].map((v) => v.toFixed(4)).join(',');
    const query = `[out:json][timeout:180];(${selector(bbox)});out center 100000;`;
    const data = await overpass(query);
    const added = collect(data.elements, found, kind === 'plants' ? 'plant' : 'generator');
    console.log(`  ${bbox}: +${added} (total ${found.size})`);
    await sleep(PAUSE_MS);
  }
  const doc = {
    generated: new Date().toISOString(),
    source: 'OpenStreetMap contributors, via the Overpass API (ODbL)',
    bbox: BBOX,
    note: 'Capacity (mw) is the nameplate rating recorded in OpenStreetMap, not live output.',
    fields: ['id', 'lat', 'lon', 'source', 'mw', 'name', 'operator', 'kind'],
    rows: [...found.values()].sort((a, b) => (b[4] || 0) - (a[4] || 0))
  };
  await mkdir(new URL('../data/', import.meta.url), { recursive: true });
  await writeFile(outfile, JSON.stringify(doc));
  console.log(`  -> ${outfile} (${found.size} records)`);
  return found.size;
}

const dataDir = new URL('../data/', import.meta.url);
const plants = await build(
  'plants',
  (bbox) => `nwr["power"="plant"](${bbox});`,
  new URL('plants.json', dataDir)
);
const generators = await build(
  'generators',
  (bbox) => `nwr["power"="generator"]["generator:source"~"${GENERATOR_SOURCES}"](${bbox});`,
  new URL('generators.json', dataDir)
);
console.log(`\nDone: ${plants} plants, ${generators} generators.`);
