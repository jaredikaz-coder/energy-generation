#!/usr/bin/env node
/**
 * Probe the public GB constraint-related feeds and report what they return.
 *
 * Nothing in Great Britain publishes live loading per transmission circuit, so
 * before colouring anything "red for constrained" we need to know which of the
 * published feeds are reachable, what shape they have, and whether a browser
 * may call them directly (CORS) or whether a workflow must fetch and commit
 * them instead. This script answers exactly that and writes no data.
 *
 * Run from CI (which has open internet) with:
 *   node tools/probe-constraint-sources.mjs
 */
const now = new Date();
const iso = (d) => d.toISOString().slice(0, 19) + 'Z';
const from = iso(new Date(now.getTime() - 3 * 60 * 60 * 1000));
const to = iso(now);
const today = now.toISOString().slice(0, 10);

const TARGETS = [
  ['Elexon: health',            `https://data.elexon.co.uk/bmrs/api/v1/health`],
  ['Elexon: BOALF (bid-offer acceptances)', `https://data.elexon.co.uk/bmrs/api/v1/datasets/BOALF?from=${from}&to=${to}&format=json`],
  ['Elexon: DISBSAD (balancing adjustment, incl. constraint volumes/costs)', `https://data.elexon.co.uk/bmrs/api/v1/datasets/DISBSAD?from=${from}&to=${to}&format=json`],
  ['Elexon: NETBSAD summary',   `https://data.elexon.co.uk/bmrs/api/v1/balancing/nonbm/netbsad?from=${from}&to=${to}&format=json`],
  ['Elexon: system warnings',   `https://data.elexon.co.uk/bmrs/api/v1/datasets/SYSWARN?publishDateTimeFrom=${from}&publishDateTimeTo=${to}&format=json`],
  ['Elexon: BMU list (locations?)', `https://data.elexon.co.uk/bmrs/api/v1/reference/bmunits/all`],
  ['Elexon: physical PN sample', `https://data.elexon.co.uk/bmrs/api/v1/balancing/physical/all?dataset=PN&settlementDate=${today}&settlementPeriod=20&format=json`],
  ['NESO: datasets matching "constraint"', `https://api.neso.energy/api/3/action/package_search?q=constraint&rows=10`],
  ['NESO: datasets matching "boundary"',   `https://api.neso.energy/api/3/action/package_search?q=boundary&rows=10`],
  ['NESO: datasets matching "curtailment"',`https://api.neso.energy/api/3/action/package_search?q=curtailment&rows=10`]
];

const trim = (s, n) => (s.length > n ? s.slice(0, n) + ' …[truncated]' : s);

for (const [label, url] of TARGETS) {
  console.log('\n' + '='.repeat(78));
  console.log(label);
  console.log(url);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const cors = res.headers.get('access-control-allow-origin');
    console.log(`  status: ${res.status} ${res.statusText}`);
    console.log(`  content-type: ${res.headers.get('content-type')}`);
    console.log(`  CORS (access-control-allow-origin): ${cors || 'ABSENT — a browser cannot call this directly'}`);
    const text = await res.text();
    console.log(`  bytes: ${text.length}`);
    let shape = '';
    try {
      const json = JSON.parse(text);
      const top = Array.isArray(json) ? json : (json.data ?? json.result ?? json);
      const sample = Array.isArray(top) ? top[0] : top;
      shape = '  keys: ' + Object.keys(sample || {}).join(', ');
      if (Array.isArray(top)) shape += `\n  records: ${top.length}`;
      console.log(shape);
      console.log('  sample: ' + trim(JSON.stringify(sample), 900));
    } catch {
      console.log('  body: ' + trim(text, 400));
    }
  } catch (err) {
    console.log(`  FAILED: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 1200));
}
console.log('\nProbe complete. Nothing was written or committed.');
