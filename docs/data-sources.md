# GB energy data: what exists, what it licenses, what can be sold

Working inventory for the app. Status: **first pass, 2026-11-05.** Items marked
**[VERIFY]** need confirming against the primary source before anything is built
or sold on them.

The short version: **asset data is abundant and open; live operational data is
abundant and open; the join between them is neither.** That join is the product.

---

## A. Where generators are, and how big they are

| # | Source | What it gives | Covers | Updated | Access | Licence |
|---|--------|---------------|--------|---------|--------|---------|
| A1 | **OpenStreetMap** | Geometry, name, operator, fuel, sometimes capacity | Everything, inconsistently | Continuous | Extract or Overpass | **ODbL** — share-alike |
| A2 | **REPD** (DESNZ Renewable Energy Planning Database) | Every renewable project ≥150 kW: coordinates, capacity (MWelec), status, planning history, operator | GB renewables | Quarterly | CSV from gov.uk | OGL **[VERIFY]** |
| A3 | **NESO TEC Register** | Transmission-connected projects: capacity, connection site, agreement gate | GB transmission | **Twice weekly** (Tue/Fri) | CSV + CKAN API | NESO Open Data Licence **[VERIFY]** |
| A4 | **DNO Embedded Capacity Registers** | Distribution-connected generation and storage ≥1 MW (some from 50 kW): location, capacity, connection date | GB distribution, 6 DNOs | Monthly | Per-DNO open data portals | Per DNO **[VERIFY]** |
| A5 | **Elexon BM unit list** | 3,132 units: fuel type, generation capacity, lead party, **GSP group** | GB market participants | Continuous | Insights API, keyless | Elexon **[VERIFY]** |
| A6 | **DUKES power station list** (DESNZ) | All stations ≥1 MW: location, capacity, commissioning year, fuel | GB, all fuels | Annual | Spreadsheet from gov.uk | OGL |
| A7 | **Ofgem REGO / renewables register** | Accredited generating stations, capacity, technology | GB accredited renewables | Rolling | Ofgem portal | OGL **[VERIFY]** |

**What this means in practice.** We currently use A1 alone, which is why
capacities are patchy and some entries are unnamed. A2 + A3 + A4 together are a
near-complete register of GB generation **with capacities that are actually
reliable**, because they come from planning and connection processes rather than
volunteers. A1 remains the best source of *where the thing physically sits* and
its shape on the ground.

The obvious move: keep OSM for geometry, join A2/A3/A4 for authoritative
capacity, status and ownership.

**ODbL warning (A1).** OpenStreetMap is share-alike. Using it in a commercial app
is fine with attribution. *Distributing a derived database* — e.g. selling a
cleaned asset register substantially built from OSM — triggers the share-alike
obligation. Keep the OSM-derived layer logically separate from a register built
from OGL sources, or accept that the register must be published under ODbL.

---

## B. What the grid is doing right now

| # | Source | What it gives | Granularity | Latency | CORS | Licence |
|---|--------|---------------|-------------|---------|------|---------|
| B1 | **Elexon Insights — BOALF** | Bid-offer acceptances, with `soFlag` marking system (constraint) actions | **Per BM unit** | Minutes | ✗ none | Elexon **[VERIFY]** |
| B2 | **Elexon Insights — PN / FPN** | Each unit's declared output plan | **Per BM unit** | Half-hourly | ✗ none | Elexon |
| B3 | **Elexon Insights — B1610** | **Actual metered output per BM unit** | **Per BM unit** | Half-hourly | ✗ none | Elexon |
| B4 | **Elexon Insights — MELS / MILS / BOD** | Maximum export levels and bid-offer prices | Per BM unit | Half-hourly | ✗ none | Elexon |
| B5 | **Elexon Insights — DISBSAD** | Balancing services adjustment: cost and volume, system-flagged | National | Half-hourly | ✗ none | Elexon |
| B6 | **Elexon Insights — SYSWARN** | NESO system warnings and notices | National | Event-driven | ✗ none | Elexon |
| B7 | **Carbon Intensity API** (NESO) | Intensity and fuel mix, national and 14 regions | Regional | Half-hourly | ✓ `*` | Open |
| B8 | **NESO data portal (CKAN)** | Constraint costs, ETYS boundary geometry, demand and embedded forecasts | Varies | Daily–annual | ✓ `*` | NESO ODL **[VERIFY]** |
| B9 | **Sheffield Solar PV_Live** | Estimated embedded solar output | National + GSP | 30 min | **[VERIFY]** | Academic **[VERIFY]** |
| B10 | **ENTSO-E Transparency** | Generation per production unit, Europe-wide | Per unit | Hourly | Token required | Open, registration |

**B3 is the headline.** Actual metered output per BM unit is exactly "is that
power station running right now, and how hard" — for every transmission-connected
asset in GB. Combined with B1, it answers "is it running, and is the system
making it do something unusual". Nobody is showing this on a map.

**B10 is the expansion path.** ENTSO-E publishes per-unit generation across
Europe, which is how this becomes more than a GB app without a new architecture.

**The CORS column is not a footnote.** Every Elexon feed refuses browser calls,
so a server must sit in between. That is already the plan (a small Cloudflare
Worker), but it means Elexon data can never be a purely static-file feature.

---

## C. The gap — and why it is the business

**No public dataset maps a BM unit to a physical asset with coordinates.**

- Elexon knows `T_GORDW-1` is a 70 MW wind BM unit in GSP group `_P`, named
  something like "Gordonbush".
- OpenStreetMap knows there is a wind farm called Gordonbush at 58.13 N, 4.03 W.
- REPD knows a 70 MW wind project called Gordonbush was consented in 2011 at a
  given grid reference, operated by SSE.

Nothing joins them. Doing that join well — fuzzy name matching, capacity
agreement, distance checks, and manual correction of the stubborn few hundred —
produces something that does not exist publicly and that other people would pay
for. It is also *defensible*: the inputs are free to everyone, the join is work.

Rough scale: ~1,500 relevant BM units, of which perhaps 60–70% should match
automatically on name and capacity; the rest is an afternoon a week of manual
reconciliation, building an asset that compounds.

---

## D. Monetisation read

| Tier | Content | Source data |
|------|---------|-------------|
| **Free** | Where generators are, capacity, fuel, your location, live national mix and carbon | A1–A4, B7 |
| **Free** | "Is this one running now?" for transmission-connected assets | B3 |
| **Paid** | History: output and constraint actions over time, per asset | B1–B3, archived by us |
| **Paid** | Alerts: notify when a named asset is constrained, or starts and stops | B1, B3 + our join |
| **Paid** | Constraint analytics by region and boundary; curtailment volumes and cost | B1, B5, B8 |
| **Paid / licence** | The asset register itself — BMU ↔ site ↔ coordinates ↔ capacity | **Our join** (ODbL care needed) |

**The pattern: live is free, *time* is paid.** Same model as Flightradar24 —
seeing the sky now costs nothing, looking backwards is the subscription. It works
because storing history is the cost we bear and the value they want.

---

## E. Open questions to settle before building

1. **[BLOCKING] Elexon commercial terms.** The BMRS open data licence grants a
   worldwide, royalty-free, perpetual right to copy, publish, distribute and
   adapt, with attribution: *"Contains BMRS data © Elexon Limited copyright and
   database right [year]."* But Elexon's general site disclaimer says commercial
   use is prohibited, and the API terms forbid scraping outside the API. These may
   well govern different things — site content versus licensed data — but **a paid
   product must not rest on an ambiguity.** Email Elexon and get it in writing.
   This is the single most important unknown.
2. **REPD and DNO register licences** — confirm OGL or equivalent, and that
   commercial redistribution is allowed.
3. **ODbL boundary** — decide now whether the asset register is OSM-derived
   (share-alike) or OGL-derived (free to license). This shapes the schema.
4. **gbcapacity.com** — what it shows, what it sources, and whether it already
   does the BM asset join. Worth twenty minutes; unreachable from the build
   environment.
5. **PV_Live terms** — academic sources often restrict commercial use.

---

## F. Next three days

- **Day 1** — Download REPD, the TEC register and two DNO capacity registers.
  Count rows, check coordinate formats, see how many have usable capacities.
- **Day 2** — Attempt the BMU join on a sample of 100 units. Measure the
  automatic match rate. That number decides whether the paid tier is real.
- **Day 3** — Licences: email Elexon, read the NESO and OGL terms, decide the
  ODbL boundary. Look at gbcapacity.com and the other incumbents.

Primary licence pages must be read directly before launch; this document records
what was found by search, not by reading every source in full.
