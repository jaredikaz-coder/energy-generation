#!/usr/bin/env node
/**
 * Build the bundled datasets from an OpenStreetMap extract.
 *
 * Public Overpass instances rate-limit shared CI addresses hard — runs were
 * spending twenty minutes in backoff and still coming away empty. A regional
 * extract has no such limits: download it once, filter it with osmium, and
 * convert the result here. Same output files, deterministic, a few minutes.
 *
 * Expects a GeoJSON Text Sequence on stdin or at argv[2], as produced by:
 *   osmium tags-filter -o power.osm.pbf great-britain.osm.pbf \
 *          nwr/power=plant nwr/power=generator w/power=line w/power=cable
 *   osmium export power.osm.pbf -f geojsonseq --add-unique-id=type_id -o power.geojsonseq
 */
import { createReadStream } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const BBOX = (process.env.BBOX || '49.8,-8.7,61.2,2.2').split(',').map(Number);
const MIN_VOLTAGE = Number(process.env.MIN_VOLTAGE || 100000);
const GENERATOR_SOURCES = new Set(['wind', 'hydro', 'nuclear', 'coal', 'gas', 'oil', 'diesel',
  'biomass', 'biofuel', 'biogas', 'waste', 'geothermal', 'battery', 'pumped_storage', 'solar',
  'tidal', 'wave', 'hydrogen']);

const SOURCE_MAP = {
  wind: 'wind', solar: 'solar', hydro: 'hydro', tidal: 'hydro', wave: 'hydro',
  nuclear: 'nuclear', gas: 'gas', biogas: 'gas', coal: 'coal', oil: 'coal',
  diesel: 'coal', biomass: 'biomass', biofuel: 'biomass', waste: 'biomass',
  battery: 'storage', pumped_storage: 'storage', hydrogen: 'storage', geothermal: 'other'
};

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

/** Every coordinate in a geometry, flattened. */
function* coords(geom) {
  if (!geom) return;
  const walk = function* (c, depth) {
    if (depth === 1) { yield c; return; }
    for (const part of c) yield* walk(part, depth - 1);
  };
  const depth = { Point: 1, LineString: 2, MultiLineString: 3, Polygon: 3, MultiPolygon: 4 }[geom.type];
  if (!depth) return;
  yield* walk(geom.coordinates, depth);
}
function centroid(geom) {
  let n = 0, x = 0, y = 0;
  for (const [lon, lat] of coords(geom)) { x += lon; y += lat; n++; }
  return n ? [y / n, x / n] : null;
}
function lineCoords(geom) {
  if (geom.type === 'LineString') return geom.coordinates.map(([lon, lat]) => [round(lat), round(lon)]);
  if (geom.type === 'MultiLineString') {
    return geom.coordinates.reduce((a, b) => (b.length > a.length ? b : a), [])
      .map(([lon, lat]) => [round(lat), round(lon)]);
  }
  return null;
}
const round = (v) => Number(v.toFixed(5));
const inBox = ([lat, lon]) => lat >= BBOX[0] && lat <= BBOX[2] && lon >= BBOX[1] && lon <= BBOX[3];

const plants = new Map();
const generators = new Map();
const lines = new Map();
let seen = 0, skipped = 0;

const input = process.argv[2] ? createReadStream(process.argv[2]) : process.stdin;
const rl = createInterface({ input, crlfDelay: Infinity });

for await (const raw of rl) {
  const line = raw.replace(/^\x1e/, '').trim();     // RS separator used by geojsonseq
  if (!line) continue;
  let f;
  try { f = JSON.parse(line); } catch { skipped++; continue; }
  const tags = f.properties || {};
  const id = String(f.id ?? tags['@id'] ?? '').replace(/^node\//, 'n/').replace(/^way\//, 'w/').replace(/^relation\//, 'r/');
  if (!id) continue;
  seen++;

  if (tags.power === 'line' || tags.power === 'cable') {
    const volts = topVoltage(tags.voltage);
    if (!volts || volts < MIN_VOLTAGE || lines.has(id)) continue;
    const points = lineCoords(f.geometry);
    if (!points || points.length < 2 || !inBox(points[0])) continue;
    lines.set(id, [id, volts, tags.name || null, tags.operator || null,
      tags.cables ? parseInt(tags.cables, 10) || null : null,
      tags.power === 'cable' ? 'cable' : 'line', points]);
    continue;
  }

  const isPlant = tags.power === 'plant';
  const isGenerator = tags.power === 'generator';
  if (!isPlant && !isGenerator) continue;
  if (isGenerator) {
    const src = String(tags['generator:source'] || '').split(';')[0].trim().toLowerCase();
    if (!GENERATOR_SOURCES.has(src)) continue;
  }
  const c = centroid(f.geometry);
  if (!c || !inBox(c)) continue;
  const into = isPlant ? plants : generators;
  if (into.has(id)) continue;
  into.set(id, [id, round(c[0]), round(c[1]), sourceOf(tags),
    parseCapacityMW(tags['plant:output:electricity'] || tags['generator:output:electricity']),
    tags.name || null, tags.operator || null, isPlant ? 'plant' : 'generator']);
}

const dataDir = new URL('../data/', import.meta.url);
await mkdir(dataDir, { recursive: true });

async function write(name, fields, rows, note) {
  await writeFile(new URL(name, dataDir), JSON.stringify({
    generated: new Date().toISOString(),
    source: 'OpenStreetMap contributors (ODbL), from a Geofabrik extract',
    bbox: BBOX, note, fields, rows
  }));
  console.log(`  -> data/${name}: ${rows.length} records`);
}

const siteFields = ['id', 'lat', 'lon', 'source', 'mw', 'name', 'operator', 'kind'];
const byCapacity = (a, b) => (b[4] || 0) - (a[4] || 0);
const capacityNote = 'Capacity (mw) is the nameplate rating recorded in OpenStreetMap, not live output.';

console.log(`Read ${seen} features (${skipped} unparsable).`);
await write('plants.json', siteFields, [...plants.values()].sort(byCapacity), capacityNote);
await write('generators.json', siteFields, [...generators.values()].sort(byCapacity), capacityNote);
await write('lines.json', ['id', 'voltage', 'name', 'operator', 'cables', 'kind', 'points'],
  [...lines.values()].sort((a, b) => (b[1] || 0) - (a[1] || 0)),
  `Overhead lines and cables at ${MIN_VOLTAGE / 1000} kV and above. OpenStreetMap records the network, not its live loading.`);

if (!plants.size && !generators.size) {
  console.error('No stations found — refusing to publish an empty dataset.');
  process.exit(1);
}
console.log(`\nDone: ${plants.size} plants, ${generators.size} generators, ${lines.size} lines.`);
