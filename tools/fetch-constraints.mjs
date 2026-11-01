#!/usr/bin/env node
/**
 * Build data/constraints.json — how much generation is being held back (or
 * pushed up) right now for system reasons, by region.
 *
 * Elexon publishes every balancing acceptance (BOALF) with an `soFlag`. When
 * that flag is set, the acceptance was taken for *system* reasons — i.e. a
 * network constraint — rather than to balance energy. Comparing the accepted
 * level against the unit's own plan (PN) says whether it was constrained down
 * (curtailed) or up. The BM unit reference list then places each unit in a GSP
 * group, which is how this becomes a map of regions.
 *
 * Elexon sends no CORS header, so a browser cannot do this itself; this runs in
 * CI and commits the (small) result.
 *
 * Note on what this is NOT: it is not live loading on individual circuits.
 * Nobody publishes that for GB. This is constraint *actions*, by region.
 */
import { writeFile, mkdir } from 'node:fs/promises';

const API = process.env.ELEXON_API || 'https://data.elexon.co.uk/bmrs/api/v1';
const HOURS_BACK = Number(process.env.HOURS_BACK || 2);

// GSP group -> the regions this map already draws (Carbon Intensity region ids)
const GSP_TO_REGION = {
  _P: { id: 1,  name: 'North Scotland' },
  _N: { id: 2,  name: 'South Scotland' },
  _G: { id: 3,  name: 'North West England' },
  _F: { id: 4,  name: 'North East England' },
  _M: { id: 5,  name: 'Yorkshire' },
  _D: { id: 6,  name: 'North Wales & Merseyside' },
  _K: { id: 7,  name: 'South Wales' },
  _E: { id: 8,  name: 'West Midlands' },
  _B: { id: 9,  name: 'East Midlands' },
  _A: { id: 10, name: 'East England' },
  _L: { id: 11, name: 'South West England' },
  _H: { id: 12, name: 'South England' },
  _C: { id: 13, name: 'London' },
  _J: { id: 14, name: 'South East England' }
};

const iso = (d) => d.toISOString().slice(0, 19) + 'Z';
const avg = (a, b) => (Number(a || 0) + Number(b || 0)) / 2;

async function get(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const json = await res.json();
  return json.data ?? json;
}

const now = new Date();
const from = new Date(now.getTime() - HOURS_BACK * 3600 * 1000);

console.log(`Window: ${iso(from)} → ${iso(now)}`);

// 1. Who is who, and where are they?
const units = await get(`${API}/reference/bmunits/all`);
const unitIndex = new Map();
for (const u of units) {
  const key = u.nationalGridBmUnit || u.elexonBmUnit;
  if (!key) continue;
  unitIndex.set(key, {
    name: u.bmUnitName || u.leadPartyName || key,
    fuel: u.fuelType || null,
    capacity: Number(u.generationCapacity || 0) || null,
    gsp: u.gspGroupId || null,
    party: u.leadPartyName || null
  });
}
console.log(`Reference: ${unitIndex.size} BM units`);

// 2. Acceptances taken for system reasons.
const acceptances = await get(`${API}/datasets/BOALF?from=${iso(from)}&to=${iso(now)}&format=json`);
const systemActions = acceptances.filter((a) => a.soFlag === true);
console.log(`Acceptances: ${acceptances.length}, system-flagged: ${systemActions.length}`);

// 3. What those units planned to do, so the direction is meaningful.
const periods = [...new Set(systemActions.map((a) => `${a.settlementDate}|${a.settlementPeriodFrom}`))];
const planned = new Map();                       // "date|period|unit" -> MW
for (const key of periods.slice(0, 12)) {        // a window of 2h is 4 periods; cap for safety
  const [date, period] = key.split('|');
  try {
    const pns = await get(`${API}/balancing/physical/all?dataset=PN&settlementDate=${date}&settlementPeriod=${period}&format=json`);
    for (const pn of pns) {
      planned.set(`${date}|${period}|${pn.nationalGridBmUnit}`, avg(pn.levelFrom, pn.levelTo));
    }
  } catch (err) {
    console.warn(`  ! PN for ${date} period ${period} failed: ${err.message}`);
  }
}
console.log(`Plans: ${planned.size} unit-periods`);

// 4. Aggregate by region.
const regions = {};
const seen = new Set();
for (const a of systemActions) {
  const unit = unitIndex.get(a.nationalGridBmUnit) || {};
  const region = GSP_TO_REGION[unit.gsp];
  if (!region) continue;                          // interconnectors and unplaced units
  const accepted = avg(a.levelFrom, a.levelTo);
  const plan = planned.get(`${a.settlementDate}|${a.settlementPeriodFrom}|${a.nationalGridBmUnit}`);
  const delta = plan == null ? 0 : accepted - plan;
  if (!delta) continue;

  const r = regions[region.id] || (regions[region.id] = {
    id: region.id, name: region.name, gsp: unit.gsp, downMW: 0, upMW: 0, units: []
  });
  if (delta < 0) r.downMW += -delta; else r.upMW += delta;

  const dedupe = `${region.id}|${a.nationalGridBmUnit}|${a.acceptanceNumber}`;
  if (!seen.has(dedupe)) {
    seen.add(dedupe);
    r.units.push({
      name: unit.name, bmUnit: a.nationalGridBmUnit, fuel: unit.fuel,
      deltaMW: Math.round(delta), time: a.timeFrom
    });
  }
}

for (const r of Object.values(regions)) {
  r.downMW = Math.round(r.downMW);
  r.upMW = Math.round(r.upMW);
  r.units.sort((x, y) => Math.abs(y.deltaMW) - Math.abs(x.deltaMW));
  r.units = r.units.slice(0, 8);
}

const doc = {
  generated: new Date().toISOString(),
  windowFrom: iso(from),
  windowTo: iso(now),
  source: 'Elexon Insights (BOALF system-flagged acceptances vs physical notifications), BM unit reference list',
  note: 'Constraint ACTIONS by region, not circuit loading. Live flow on individual transmission circuits is not published for GB. ' +
        'downMW is generation held back for system reasons; upMW is generation called on.',
  totals: {
    downMW: Math.round(Object.values(regions).reduce((s, r) => s + r.downMW, 0)),
    upMW: Math.round(Object.values(regions).reduce((s, r) => s + r.upMW, 0)),
    systemActions: systemActions.length
  },
  regions
};

await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(new URL('../data/constraints.json', import.meta.url), JSON.stringify(doc));
console.log(`\n-> data/constraints.json`);
console.log(`   ${Object.keys(regions).length} regions, ${doc.totals.downMW} MW held back, ${doc.totals.upMW} MW called on`);
for (const r of Object.values(regions).sort((a, b) => b.downMW - a.downMW).slice(0, 5)) {
  console.log(`   ${r.name}: −${r.downMW} MW / +${r.upMW} MW (${r.units.length} units)`);
}
