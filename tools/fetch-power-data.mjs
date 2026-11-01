#!/usr/bin/env node
/**
 * Build the bundled datasets the map loads instead of querying Overpass live.
 *
 *   data/plants.json      power plants              (loaded at startup)
 *   data/generators.json  individual generators     (loaded when zoomed in)
 *   data/lines.json       transmission lines        (loaded with the layer)
 *
 * One Overpass query per tile returns all three, because public Overpass
 * instances rate-limit by IP and CI runners share addresses: fewer, patient
 * requests get through where many quick ones are refused with HTTP 429.
 *
 * Run by .github/workflows/update-power-data.yml, or by hand:
 *   node tools/fetch-power-data.mjs
 *   BBOX="south,west,north,east" TILE_DEG=3 node tools/fetch-power-data.mjs
 */
import { writeFile, mkdir } from 'node:fs/promises';

const MIRRORS = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://overpass.private.coffee/api/interpreter'
    ];

const BBOX = (process.env.BBOX || '49.8,-8.7,61.2,2.2').split(',').map(Number);
const TILE_DEG = Number(process.env.TILE_DEG || 3);
const PAUSE_MS = Number(process.env.PAUSE_MS || 8000);
const MIN_VOLTAGE = Number(process.env.MIN_VOLTAGE || 100000);   // transmission, not street poles
const BACKOFF_MS = [20000, 45000, 90000, 150000, 240000, 300000];

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

function topVoltage(raw) {
  if (!raw) return null;
  const vals = String(raw).split(';').map((v) => parseInt(v.trim(), 10)).filter(Number.isFinite);
  return vals.length ? Math.max(...vals) : null;
}

function sourceOf(tags) {
  const raw = tags['plant:source'] || tags['generator:source'] || tags['plant:method'] || '';
  return SOURCE_MAP[String(raw).split(';')[0].trim().toLowerCase()] || 'other';
}

/** Patient, polite Overpass call: long backoff, Retry-After honoured, mirrors rotated. */
async function overpass(query) {
  let lastErr;
  for (let attempt = 0; attempt < BACKOFF_MS.length * MIRRORS.length; attempt++) {
    const url = MIRRORS[attempt % MIRRORS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'energy-generation-map/1.0 (+https://github.com/jaredikaz-coder/energy-generation)'
        },
        body: 'data=' + encodeURIComponent(query)
      });
      if (res.status === 429 || res.status === 503 || res.status === 504) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
        const wait = retryAfter > 0
          ? Math.min(retryAfter * 1000, 300000)
          : BACKOFF_MS[Math.min(Math.floor(attempt / MIRRORS.length), BACKOFF_MS.length - 1)];
        console.warn(`  · ${new URL(url).host} busy (HTTP ${res.status}); waiting ${Math.round(wait / 1000)}s`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      lastErr = err;
      const wait = BACKOFF_MS[Math.min(Math.floor(attempt / MIRRORS.length), BACKOFF_MS.length - 1)];
      console.warn(`  · ${new URL(url).host} failed (${err.message}); waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
  throw lastErr || new Error('every mirror stayed busy');
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

function query(bbox) {
  return `[out:json][timeout:300];` +
    `(nwr["power"="plant"](${bbox});` +
    `nwr["power"="generator"]["generator:source"~"${GENERATOR_SOURCES}"](${bbox}););->.sites;` +
    `(way["power"="line"]["voltage"](${bbox});` +
    `way["power"="cable"]["voltage"](${bbox}););->.lines;` +
    `.sites out center 200000;` +
    `.lines out geom 60000;`;
}

const plants = new Map();
const generators = new Map();
const lines = new Map();

function ingest(elements) {
  let added = 0;
  for (const el of elements || []) {
    const tags = el.tags || {};
    const id = (el.type === 'node' ? 'n' : el.type === 'way' ? 'w' : 'r') + '/' + el.id;

    if (tags.power === 'line' || tags.power === 'cable') {
      const volts = topVoltage(tags.voltage);
      if (!volts || volts < MIN_VOLTAGE || !el.geometry || lines.has(id)) continue;
      const points = el.geometry
        .filter((p) => p && p.lat != null)
        .map((p) => [Number(p.lat.toFixed(5)), Number(p.lon.toFixed(5))]);
      if (points.length < 2) continue;
      lines.set(id, [id, volts, tags.name || null, tags.operator || null,
        tags.cables ? parseInt(tags.cables, 10) || null : null,
        tags.power === 'cable' ? 'cable' : 'line', points]);
      added++;
      continue;
    }

    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    const isPlant = tags.power === 'plant';
    const into = isPlant ? plants : generators;
    if (into.has(id) || (isPlant ? generators : plants).has(id)) continue;
    into.set(id, [
      id,
      Number(lat.toFixed(5)),
      Number(lon.toFixed(5)),
      sourceOf(tags),
      parseCapacityMW(tags['plant:output:electricity'] || tags['generator:output:electricity']),
      tags.name || null,
      tags.operator || null,
      isPlant ? 'plant' : 'generator'
    ]);
    added++;
  }
  return added;
}

const boxes = tiles(BBOX);
const failed = [];
console.log(`Fetching ${boxes.length} tiles of ${TILE_DEG}° across ${BBOX.join(', ')}`);

for (const [i, [s, w, n, e]] of boxes.entries()) {
  const bbox = [s, w, n, e].map((v) => v.toFixed(4)).join(',');
  process.stdout.write(`tile ${i + 1}/${boxes.length} (${bbox}) … `);
  try {
    const data = await overpass(query(bbox));
    const added = ingest(data.elements);
    console.log(`+${added}  [plants ${plants.size}, generators ${generators.size}, lines ${lines.size}]`);
  } catch (err) {
    console.log(`FAILED (${err.message})`);
    failed.push(bbox);                      // keep going: a partial dataset beats none
  }
  if (i < boxes.length - 1) await sleep(PAUSE_MS);
}

if (failed.length >= boxes.length) {
  console.error('\nEvery tile failed — writing nothing and failing the run.');
  process.exit(1);
}

const dataDir = new URL('../data/', import.meta.url);
await mkdir(dataDir, { recursive: true });

async function write(name, fields, rows, extraNote) {
  const doc = {
    generated: new Date().toISOString(),
    source: 'OpenStreetMap contributors, via the Overpass API (ODbL)',
    bbox: BBOX,
    partial: failed.length > 0 || undefined,
    failedTiles: failed.length ? failed : undefined,
    note: extraNote,
    fields,
    rows
  };
  await writeFile(new URL(name, dataDir), JSON.stringify(doc));
  console.log(`  -> data/${name}: ${rows.length} records`);
}

const siteFields = ['id', 'lat', 'lon', 'source', 'mw', 'name', 'operator', 'kind'];
const byCapacity = (a, b) => (b[4] || 0) - (a[4] || 0);

console.log('\nWriting files:');
await write('plants.json', siteFields, [...plants.values()].sort(byCapacity),
  'Capacity (mw) is the nameplate rating recorded in OpenStreetMap, not live output.');
await write('generators.json', siteFields, [...generators.values()].sort(byCapacity),
  'Capacity (mw) is the nameplate rating recorded in OpenStreetMap, not live output.');
await write('lines.json', ['id', 'voltage', 'name', 'operator', 'cables', 'kind', 'points'],
  [...lines.values()].sort((a, b) => (b[1] || 0) - (a[1] || 0)),
  `Overhead lines and cables at ${MIN_VOLTAGE / 1000} kV and above. Voltage is the highest tagged value. ` +
  'OpenStreetMap records the network, not its live loading.');

if (failed.length) {
  console.warn(`\nPartial dataset: ${failed.length} of ${boxes.length} tiles failed (${failed.join(' | ')}).`);
}
console.log(`\nDone: ${plants.size} plants, ${generators.size} generators, ${lines.size} lines.`);
