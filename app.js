/* Live Energy Map
 * -----------------------------------------------------------------------------
 * Three live data sources, all keyless:
 *   1. navigator.geolocation  -> your current position, watched continuously
 *   2. Carbon Intensity API   -> live GB generation mix + carbon intensity
 *                                (national and for each of the 14 DNO regions)
 *   3. Overpass API           -> power stations / generators in the map view,
 *                                queried live from OpenStreetMap
 * Everything runs in the browser; nothing is stored or sent anywhere else.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- constants
  var CI_API = 'https://api.carbonintensity.org.uk';
  var OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
  ];
  var GRID_REFRESH_MS = 5 * 60 * 1000;   // grid mix updates every half hour
  var SCAN_DEBOUNCE_MS = 600;            // settle after panning before querying
  // Power stations barely change, so they ship with the site as a file and are
  // refreshed weekly by .github/workflows/update-power-data.yml. Overpass is
  // then only needed outside the covered area, or for a deliberate live check.
  var DATASET = { plants: 'data/plants.json', generators: 'data/generators.json' };
  var MAX_SCAN_SPAN_DEG = 3.2;           // refuse to scan the whole continent

  // Source taxonomy. Colours come from the stylesheet so light/dark both work.
  var SOURCES = [
    { key: 'wind',    label: 'Wind',        glyph: '🌬', vars: '--s-wind' },
    { key: 'solar',   label: 'Solar',       glyph: '☀',  vars: '--s-solar' },
    { key: 'hydro',   label: 'Hydro',       glyph: '💧', vars: '--s-hydro' },
    { key: 'nuclear', label: 'Nuclear',     glyph: '⚛',  vars: '--s-nuclear' },
    { key: 'gas',     label: 'Gas',         glyph: '🔥', vars: '--s-gas' },
    { key: 'coal',    label: 'Coal / oil',  glyph: '🏭', vars: '--s-coal' },
    { key: 'biomass', label: 'Biomass',     glyph: '🌱', vars: '--s-biomass' },
    { key: 'storage', label: 'Storage',     glyph: '🔋', vars: '--s-storage' },
    { key: 'other',   label: 'Other',       glyph: '•',  vars: '--s-other' }
  ];
  var SRC = {};
  SOURCES.forEach(function (s) { SRC[s.key] = s; });

  // OSM tag values -> our source keys.
  var OSM_SOURCE_MAP = {
    wind: 'wind', solar: 'solar', hydro: 'hydro', tidal: 'hydro', wave: 'hydro',
    nuclear: 'nuclear', gas: 'gas', biogas: 'gas', coal: 'coal', oil: 'coal',
    diesel: 'coal', biomass: 'biomass', biofuel: 'biomass', waste: 'biomass',
    battery: 'storage', 'pumped_storage': 'storage', hydrogen: 'storage',
    geothermal: 'other'
  };
  // Carbon Intensity API fuel names -> our source keys.
  var CI_FUEL_MAP = {
    wind: 'wind', solar: 'solar', hydro: 'hydro', nuclear: 'nuclear',
    gas: 'gas', coal: 'coal', biomass: 'biomass', imports: 'other', other: 'other'
  };

  // The 14 GB distribution regions, with an indicative centre point each.
  var GB_REGIONS = {
    1:  [57.50, -4.20], 2:  [55.60, -3.80], 3:  [53.80, -2.60], 4:  [54.90, -1.70],
    5:  [53.80, -1.30], 6:  [53.20, -3.40], 7:  [51.70, -3.60], 8:  [52.50, -2.10],
    9:  [52.90, -0.90], 10: [52.40,  0.60], 11: [50.80, -3.60], 12: [51.10, -1.40],
    13: [51.51, -0.12], 14: [51.20,  0.60]
  };
  // Sequential ramp (one hue, light -> dark) for gCO2/kWh.
  var CI_STEPS = [
    { max: 100, vars: '--ci-1', label: '0–100' },
    { max: 200, vars: '--ci-2', label: '100–200' },
    { max: 300, vars: '--ci-3', label: '200–300' },
    { max: 400, vars: '--ci-4', label: '300–400' },
    { max: Infinity, vars: '--ci-5', label: '400+' }
  ];

  // ------------------------------------------------------------------- helpers
  var $ = function (id) { return document.getElementById(id); };
  var css = function (name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  };
  var colorOf = function (key) { return css((SRC[key] || SRC.other).vars); };
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var fmt = function (n, d) {
    if (n == null || !isFinite(n)) return '—';
    return n.toLocaleString(undefined, { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  };
  var clock = function (d) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  function haversineKm(a, b) {
    var R = 6371, rad = Math.PI / 180;
    var dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
    var la1 = a[0] * rad, la2 = b[0] * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function distanceLabel(km) {
    if (km == null) return '—';
    return km < 1 ? Math.round(km * 1000) + ' m' : fmt(km, km < 10 ? 1 : 0) + ' km';
  }
  // "500 kW", "1.2 MW", "2 GW", "750000 W" -> megawatts
  function parseCapacityMW(raw) {
    if (!raw) return null;
    var m = String(raw).replace(/,/g, '').match(/(-?\d+(?:\.\d+)?)\s*([kKmMgG]?)[wW]?/);
    if (!m) return null;
    var n = parseFloat(m[1]);
    if (!isFinite(n)) return null;
    var unit = (m[2] || 'M').toLowerCase();       // bare numbers are watts-ish; assume MW only when unit absent AND small
    if (unit === 'k') return n / 1000;
    if (unit === 'g') return n * 1000;
    if (unit === 'm') return n;
    return n / 1e6;
  }

  // -------------------------------------------------------------------- status
  var statusEl = $('status');
  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = 'pill' + (kind ? ' ' + kind : '');
  }
  function hint(text) {
    var el = $('map-hint');
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = text;
    el.hidden = false;
  }

  // ----------------------------------------------------------------- map setup
  if (typeof L === 'undefined') {
    setStatus('Map library failed to load', 'error');
    hint('Leaflet could not be loaded from the CDN. Check your internet connection and reload.');
    return;
  }

  // Reopen where you left off rather than back at the national view.
  var VIEW_KEY = 'energy-map-view-v1';
  var startView = { center: [54.5, -3.2], zoom: 6 };
  try {
    var savedView = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null');
    if (savedView && isFinite(savedView.lat) && isFinite(savedView.lon) && isFinite(savedView.zoom)) {
      startView = { center: [savedView.lat, savedView.lon], zoom: savedView.zoom };
    }
  } catch (e) { /* ignore unreadable storage */ }

  var map = L.map('map', {
    center: startView.center, zoom: startView.zoom, zoomControl: true, worldCopyJump: true,
    preferCanvas: true                   // draw markers on a canvas: much faster on phones
  });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  window.energyMap = map;                // exposed for debugging in the browser console
  var sitesLayer = L.layerGroup().addTo(map);
  var gridLayer = L.layerGroup().addTo(map);
  var meLayer = L.layerGroup().addTo(map);

  $('chk-sites').addEventListener('change', function (e) {
    if (e.target.checked) { map.addLayer(sitesLayer); } else { map.removeLayer(sitesLayer); }
  });
  $('chk-grid').addEventListener('change', function (e) {
    if (e.target.checked) { map.addLayer(gridLayer); } else { map.removeLayer(gridLayer); }
  });

  // ------------------------------------------------------- your live location
  var me = { latlng: null, accuracy: null, watchId: null, marker: null, ring: null, follow: false };

  function renderMe(pos) {
    var c = pos.coords;
    me.latlng = [c.latitude, c.longitude];
    me.accuracy = c.accuracy;

    if (!me.marker) {
      me.marker = L.marker(me.latlng, {
        icon: L.divIcon({ className: '', html: '<div class="you-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
        zIndexOffset: 1000,
        keyboard: false,
        title: 'Your location'
      }).addTo(meLayer).bindPopup('You are here');
      me.ring = L.circle(me.latlng, {
        radius: c.accuracy || 0, color: css('--you'), weight: 1, fillColor: css('--you'), fillOpacity: .12
      }).addTo(meLayer);
    } else {
      me.marker.setLatLng(me.latlng);
      me.ring.setLatLng(me.latlng).setRadius(c.accuracy || 0);
    }

    $('geo-state').hidden = true;
    $('geo-kv').hidden = false;
    $('geo-lat').textContent = c.latitude.toFixed(5) + '°';
    $('geo-lon').textContent = c.longitude.toFixed(5) + '°';
    $('geo-acc').textContent = c.accuracy == null ? '—' : '± ' + fmt(c.accuracy, 0) + ' m';
    $('geo-speed').textContent = (c.speed == null || !isFinite(c.speed))
      ? '—' : fmt(c.speed * 3.6, 1) + ' km/h' + (c.heading != null && isFinite(c.heading) ? ' · ' + fmt(c.heading, 0) + '°' : '');
    $('geo-time').textContent = clock(new Date(pos.timestamp || Date.now()));

    var inGB = c.latitude > 49.5 && c.latitude < 61 && c.longitude > -8.5 && c.longitude < 2.2;
    $('mix-scope').textContent = inGB
      ? 'Live mix and carbon intensity for Great Britain — the grid you are standing on.'
      : 'Live mix and carbon intensity are published for Great Britain only; your position is outside that area, ' +
        'so the figures below describe the GB grid rather than your local one.';

    if (me.follow) { map.setView(me.latlng, Math.max(map.getZoom(), 11), { animate: true }); }
    updateNearby();
  }

  function geoError(err) {
    var msg = 'Location unavailable.';
    if (err && err.code === 1) msg = 'Location permission denied — allow it in your browser to see yourself on the map.';
    else if (err && err.code === 2) msg = 'Your device could not get a position fix.';
    else if (err && err.code === 3) msg = 'Location request timed out.';
    $('geo-state').hidden = false;
    $('geo-state').textContent = msg;
    if (!window.isSecureContext) {
      hint('Browsers only share your location over https:// or localhost. If you opened this file directly, ' +
           'run "python3 -m http.server" in this folder and visit http://localhost:8000/energy-map.html');
    }
  }

  function startWatch() {
    if (!navigator.geolocation) { geoError({ code: 2 }); return; }
    $('geo-state').textContent = 'Locating…';
    $('geo-state').hidden = false;
    if (me.watchId != null) { navigator.geolocation.clearWatch(me.watchId); }
    me.watchId = navigator.geolocation.watchPosition(renderMe, geoError, {
      enableHighAccuracy: true, maximumAge: 10000, timeout: 20000
    });
  }

  $('btn-locate').addEventListener('click', function () {
    if (me.latlng) { map.setView(me.latlng, Math.max(map.getZoom(), 12), { animate: true }); }
    startWatch();
  });
  $('btn-follow').addEventListener('click', function () {
    me.follow = !me.follow;
    this.setAttribute('aria-pressed', String(me.follow));
    this.textContent = 'Follow: ' + (me.follow ? 'on' : 'off');
    if (me.follow && me.latlng) { map.setView(me.latlng, Math.max(map.getZoom(), 12)); }
  });

  // ------------------------------------------------- live GB grid (national)
  function mixToRows(generationmix) {
    var byKey = {};
    (generationmix || []).forEach(function (f) {
      var key = CI_FUEL_MAP[f.fuel] || 'other';
      byKey[key] = (byKey[key] || 0) + (f.perc || 0);
    });
    return SOURCES.map(function (s) { return { key: s.key, label: s.label, perc: byKey[s.key] || 0 }; })
      .filter(function (r) { return r.perc > 0; })
      .sort(function (a, b) { return b.perc - a.perc; });
  }

  function renderMixBar(rows) {
    var bar = $('mixbar'), legend = $('mix-legend'), tbody = $('mix-table').querySelector('tbody');
    bar.innerHTML = '';
    legend.innerHTML = '';
    tbody.innerHTML = '';
    bar.setAttribute('aria-label', 'Live generation mix: ' + rows.map(function (r) {
      return r.label + ' ' + r.perc.toFixed(1) + '%';
    }).join(', '));

    rows.forEach(function (r) {
      var seg = document.createElement('div');
      seg.className = 'seg';
      seg.style.flex = r.perc + ' 0 0';
      seg.style.background = colorOf(r.key);
      seg.title = r.label + ' · ' + r.perc.toFixed(1) + '%';
      if (r.perc >= 9) {
        var lab = document.createElement('span');
        lab.className = 'seg-label';
        lab.textContent = Math.round(r.perc) + '%';
        seg.appendChild(lab);
      }
      bar.appendChild(seg);

      var item = document.createElement('span');
      item.className = 'item';
      item.innerHTML = '<i class="swatch" style="background:' + colorOf(r.key) + '"></i>' +
                       esc(r.label) + ' ' + r.perc.toFixed(1) + '%';
      legend.appendChild(item);

      var tr = document.createElement('tr');
      tr.innerHTML = '<td><i class="swatch" style="background:' + colorOf(r.key) + '"></i>' + esc(r.label) +
                     '</td><td class="num">' + r.perc.toFixed(1) + '%</td>';
      tbody.appendChild(tr);
    });
  }

  function ciColor(g) {
    if (g == null) return css('--s-other');
    for (var i = 0; i < CI_STEPS.length; i++) { if (g <= CI_STEPS[i].max) return css(CI_STEPS[i].vars); }
    return css('--ci-5');
  }

  function renderRegions(regions) {
    gridLayer.clearLayers();
    (regions || []).forEach(function (r) {
      var centre = GB_REGIONS[r.regionid];
      if (!centre) return;                       // skip the England/Scotland/Wales roll-ups
      var g = r.intensity && (r.intensity.forecast != null ? r.intensity.forecast : r.intensity.actual);
      var rows = mixToRows(r.generationmix);
      var mini = rows.map(function (x) {
        return '<i style="flex:' + x.perc + ' 0 0;background:' + colorOf(x.key) + '"></i>';
      }).join('');
      var top = rows.slice(0, 3).map(function (x) { return esc(x.label) + ' ' + Math.round(x.perc) + '%'; }).join(' · ');

      L.circleMarker(centre, {
        radius: 13, color: css('--panel'), weight: 2,
        fillColor: ciColor(g), fillOpacity: .92, className: 'gb-region'
      })
        .bindTooltip(esc(r.shortname || r.dnoregion) + ' · ' + (g == null ? '—' : Math.round(g) + ' gCO₂/kWh'))
        .bindPopup(
          '<h4>' + esc(r.shortname || r.dnoregion) + '</h4>' +
          '<div class="pop-kv"><b>Carbon intensity</b><span>' + (g == null ? '—' : Math.round(g) + ' gCO₂/kWh') + '</span>' +
          '<b>Rating</b><span>' + esc((r.intensity && r.intensity.index) || '—') + '</span></div>' +
          '<div class="mini-mix">' + mini + '</div>' +
          '<div class="muted small">' + top + '</div>' +
          '<div class="muted small">Regional indicator, not a boundary.</div>'
        )
        .addTo(gridLayer);
    });
  }

  var gridTimer = null;
  function loadGrid() {
    setStatus('Updating grid…', 'busy');
    var jobs = [
      fetch(CI_API + '/generation').then(function (r) { return r.json(); }),
      fetch(CI_API + '/intensity').then(function (r) { return r.json(); }),
      fetch(CI_API + '/regional').then(function (r) { return r.json(); })
    ];
    Promise.all(jobs).then(function (res) {
      var gen = res[0] && res[0].data;
      var ci = res[1] && res[1].data && res[1].data[0];
      var reg = res[2] && res[2].data && res[2].data[0];

      if (gen) {
        renderMixBar(mixToRows(gen.generationmix));
        if (gen.from && gen.to) {
          $('mix-caption').textContent = 'Share of GB electricity generated in the current half hour (' +
            clock(new Date(gen.from)) + '–' + clock(new Date(gen.to)) + ')';
        }
      }
      if (ci && ci.intensity) {
        var val = ci.intensity.actual != null ? ci.intensity.actual : ci.intensity.forecast;
        $('ci-value').textContent = val == null ? '—' : Math.round(val);
        $('ci-index').textContent = (ci.intensity.index || '—') +
          (ci.intensity.actual == null ? ' (forecast)' : '');
      }
      if (reg && reg.regions) { renderRegions(reg.regions); }

      setStatus('Live · grid ' + clock(new Date()), 'live');
      $('mix-foot').textContent = 'Source: National Grid ESO Carbon Intensity API (Great Britain). ' +
        'Updated ' + clock(new Date()) + ', refreshing every 5 minutes.';
    }).catch(function (err) {
      setStatus('Grid data unavailable', 'error');
      $('mix-foot').textContent = 'Could not reach the Carbon Intensity API (' + (err && err.message ? err.message : 'network error') +
        '). Retrying in 5 minutes.';
    });
  }

  // --------------------------------------------- live generation sites (OSM)
  // Scanning is the slow part: Overpass queues requests, so we (a) keep every
  // site we have ever fetched, (b) remember which rectangles we have already
  // covered and skip the network entirely for those, and (c) hedge the request
  // across mirrors so one busy server cannot hold the whole scan up.
  var STORE_KEY = 'energy-map-sites-v1';
  var CACHE_TTL_MS = 60 * 60 * 1000;      // a power station is not news; an hour is plenty
  var MAX_STORED_SITES = 2500;
  var HEDGE_DELAYS = [0, 3500, 9000];     // when to bring each mirror in

  var store = { sites: {}, rects: [] };   // rects: {s,w,n,e,t,tier}
  var interacted = false;
  var scanAbort = null;
  var scanTimer = null;
  var tickTimer = null;

  function loadStore() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && parsed.sites && parsed.rects) {
        var now = Date.now();
        store.sites = parsed.sites;
        store.rects = parsed.rects.filter(function (r) { return now - r.t < CACHE_TTL_MS; });
      }
    } catch (e) { /* private mode, quota, corrupt value: start empty */ }
  }
  function saveStore() {
    try {
      // Only live-scanned sites are stored: the bundled dataset is already a
      // cached file, and the rectangles it covers are re-added on every load.
      var live = {}, n = 0;
      Object.keys(store.sites).forEach(function (id) {
        if (store.sites[id].live) { live[id] = store.sites[id]; n++; }
      });
      if (n > MAX_STORED_SITES) {
        Object.keys(live).slice(0, n - MAX_STORED_SITES).forEach(function (id) { delete live[id]; });
      }
      localStorage.setItem(STORE_KEY, JSON.stringify({
        sites: live,
        rects: store.rects.filter(function (r) { return !r.perm; }).slice(-40)
      }));
    } catch (e) { /* nothing we can do; the map still works in memory */ }
  }
  function allSites() {
    return Object.keys(store.sites).map(function (k) { return store.sites[k]; });
  }
  function sitesIn(bounds) {
    return allSites().filter(function (s) { return bounds.contains(s.latlng); });
  }
  // tier 1 = big plants only (low zoom), tier 2 = plants plus individual generators
  function tierFor(zoom) { return zoom >= 12 ? 2 : 1; }
  function covered(b, tier) {
    var now = Date.now();
    return store.rects.some(function (r) {
      return r.tier >= tier && (r.perm || now - r.t < CACHE_TTL_MS) &&
        r.s <= b.getSouth() && r.w <= b.getWest() && r.n >= b.getNorth() && r.e >= b.getEast();
    });
  }

  var datasetBounds = null;               // area the bundled files cover
  var datasetMeta = { plants: null, generators: null };
  var datasetCount = 0;
  var generatorsPending = null;
  var OSM_TYPE = { n: 'node', w: 'way', r: 'relation' };

  function applyDataset(doc, kind) {
    var idx = {};
    (doc.fields || []).forEach(function (f, i) { idx[f] = i; });
    (doc.rows || []).forEach(function (row) {
      var id = row[idx.id];
      if (!id || (store.sites[id] && store.sites[id].live)) return;   // a live scan is fresher
      var kindTag = row[idx.kind] === 'plant' ? 'Power plant' : 'Generator';
      store.sites[id] = {
        id: id,
        latlng: [row[idx.lat], row[idx.lon]],
        name: row[idx.name] || row[idx.operator] ||
              (kindTag === 'Power plant' ? 'Unnamed power plant' : 'Unnamed generator'),
        source: SRC[row[idx.source]] ? row[idx.source] : 'other',
        mw: row[idx.mw],
        operator: row[idx.operator] || null,
        method: null,
        kind: kindTag,
        osm: 'https://www.openstreetmap.org/' + (OSM_TYPE[id.charAt(0)] || 'way') + '/' + id.slice(2),
        live: false
      };
      datasetCount++;
    });
    var b = doc.bbox;
    if (b && b.length === 4) {
      datasetBounds = L.latLngBounds([b[0], b[1]], [b[2], b[3]]);
      store.rects.push({
        s: b[0], w: b[1], n: b[2], e: b[3], t: Date.now(),
        tier: kind === 'generators' ? 2 : 1, perm: true
      });
    }
    datasetMeta[kind] = doc.generated || null;
    updateDataNote();
  }

  function loadDataset(kind) {
    return fetch(DATASET[kind]).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (doc) { applyDataset(doc, kind); return doc; });
  }

  function updateDataNote() {
    var el = $('data-note');
    if (!el) return;
    if (!datasetMeta.plants) {
      el.textContent = 'No bundled dataset on this copy — stations are fetched live as you pan.';
      return;
    }
    var when = new Date(datasetMeta.plants);
    el.textContent = 'Bundled dataset: ' + fmt(datasetCount, 0) + ' stations, updated ' +
      when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) +
      (datasetMeta.generators ? ' (with individual generators)' : '') +
      '. Tap “Scan this area” for a live check against OpenStreetMap.';
  }

  function siteSource(tags) {
    var raw = tags['plant:source'] || tags['generator:source'] || tags['plant:method'] || '';
    var first = String(raw).split(';')[0].trim().toLowerCase();
    return OSM_SOURCE_MAP[first] || 'other';
  }
  function siteCapacity(tags) {
    return parseCapacityMW(tags['plant:output:electricity'] || tags['generator:output:electricity']);
  }
  function radiusFor(mw) {
    if (!mw || !isFinite(mw)) return 5;
    return Math.max(5, Math.min(26, 5 + 2.4 * Math.sqrt(mw)));
  }

  function overpassQuery(b, tier) {
    var bbox = [b.getSouth().toFixed(4), b.getWest().toFixed(4), b.getNorth().toFixed(4), b.getEast().toFixed(4)].join(',');
    var q = '[out:json][timeout:20];(nwr["power"="plant"](' + bbox + ');';
    if (tier >= 2) {
      q += 'nwr["power"="generator"]["generator:source"~"^(wind|hydro|nuclear|coal|gas|oil|diesel|biomass|biofuel|biogas|waste|geothermal|battery|pumped_storage)$"](' + bbox + ');';
    }
    return q + ');out center 600;';
  }

  // Fire the first mirror immediately and bring the others in only if it is
  // still thinking. First usable answer wins; the rest are aborted.
  function hedgedOverpass(query, outerSignal) {
    return new Promise(function (resolve, reject) {
      var settled = false, failures = 0, timers = [], controllers = [];
      function cleanup() {
        timers.forEach(clearTimeout);
        controllers.forEach(function (c) { try { c.abort(); } catch (e) {} });
      }
      function launch(i) {
        if (settled) return;
        var ctrl = new AbortController();
        controllers.push(ctrl);
        if (outerSignal) {
          if (outerSignal.aborted) { try { ctrl.abort(); } catch (e) {} }
          else outerSignal.addEventListener('abort', function () { try { ctrl.abort(); } catch (e) {} });
        }
        fetch(OVERPASS[i], {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
          signal: ctrl.signal
        }).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        }).then(function (json) {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(json);
        }).catch(function (err) {
          if (settled) return;
          failures++;
          if (outerSignal && outerSignal.aborted) { settled = true; cleanup(); reject(err); return; }
          if (failures >= OVERPASS.length) { settled = true; cleanup(); reject(err); }
        });
      }
      OVERPASS.forEach(function (_, i) {
        timers.push(setTimeout(function () { launch(i); }, HEDGE_DELAYS[i] || 0));
      });
    });
  }

  function scanButton(busy) {
    var btn = $('btn-scan');
    btn.disabled = !!busy;
    btn.textContent = busy ? 'Scanning…' : 'Scan this area';
  }

  function scan(auto, force) {
    var b = map.getBounds();
    var tier = tierFor(map.getZoom());
    var span = Math.max(b.getNorth() - b.getSouth(), b.getEast() - b.getWest());

    if (span > MAX_SCAN_SPAN_DEG) {
      if (!auto || interacted) {
        hint('Zoom in to scan for power stations — the area in view is too large to query.');
      }
      return;
    }
    // Already covered (bundled dataset or an earlier scan): redraw from memory.
    if (!force && covered(b, tier)) {
      drawSites();
      updateNearby();
      setStatus('Live · ' + sitesIn(b).length + ' sites in view', 'live');
      return;
    }
    // Inside the bundled area, zooming past the plant-level view just pulls the
    // generator file once — still no Overpass query.
    if (!force && datasetBounds && datasetBounds.contains(b) && tier >= 2 && !datasetMeta.generators) {
      if (!generatorsPending) {
        setStatus('Loading generators…', 'busy');
        generatorsPending = loadDataset('generators').then(function () {
          drawSites();
          updateNearby();
          setStatus('Live · ' + sitesIn(map.getBounds()).length + ' sites in view', 'live');
        }).catch(function () {
          generatorsPending = null;      // fall back to a live scan next time
          scan(auto, true);
        });
      }
      return;
    }
    if (scanAbort) {                      // a newer view supersedes the one in flight
      scanAbort.abort();
      scanAbort = null;
    }
    hint('');
    scanButton(true);

    // Query a little beyond the screen so small pans stay inside the cache.
    var qb = b.pad(0.3);
    var started = Date.now();
    var ctrl = new AbortController();
    scanAbort = ctrl;

    clearInterval(tickTimer);
    setStatus('Scanning area…', 'busy');
    tickTimer = setInterval(function () {
      setStatus('Scanning area… ' + Math.round((Date.now() - started) / 1000) + 's', 'busy');
    }, 1000);

    hedgedOverpass(overpassQuery(qb, tier), ctrl.signal).then(function (data) {
      if (ctrl.signal.aborted) return;
      var added = 0;
      (data.elements || []).forEach(function (el) {
        var tags = el.tags || {};
        var lat = el.lat != null ? el.lat : (el.center && el.center.lat);
        var lon = el.lon != null ? el.lon : (el.center && el.center.lon);
        if (lat == null || lon == null) return;
        var id = el.type + '/' + el.id;
        if (!store.sites[id]) added++;
        store.sites[id] = {
          id: id,
          latlng: [lat, lon],
          name: tags.name || tags.operator || (tags.power === 'plant' ? 'Unnamed power plant' : 'Unnamed generator'),
          source: siteSource(tags),
          mw: siteCapacity(tags),
          operator: tags.operator || null,
          method: tags['plant:method'] || tags['generator:method'] || null,
          kind: tags.power === 'plant' ? 'Power plant' : 'Generator',
          osm: 'https://www.openstreetmap.org/' + el.type + '/' + el.id,
          live: true
        };
      });
      store.rects.push({ s: qb.getSouth(), w: qb.getWest(), n: qb.getNorth(), e: qb.getEast(), t: Date.now(), tier: tier });
      if (store.rects.length > 40) store.rects = store.rects.slice(-40);
      saveStore();

      drawSites();
      updateNearby();
      var secs = ((Date.now() - started) / 1000).toFixed(1);
      var inView = sitesIn(map.getBounds()).length;
      setStatus('Live · ' + inView + ' sites in view · ' + secs + ' s', 'live');
      if (!inView) {
        hint(added ? 'Nothing mapped inside this view — try panning or zooming out a little.'
                   : 'No mapped power stations here. OpenStreetMap coverage varies by area.');
      }
    }).catch(function (err) {
      if (ctrl.signal.aborted || (err && err.name === 'AbortError')) return;
      setStatus('Site scan failed', 'error');
      hint('Could not reach any Overpass mirror (' + (err && err.message ? err.message : 'network error') +
           '). They rate-limit busy clients — wait a moment and tap "Scan this area" again.');
    }).then(function () {
      if (scanAbort === ctrl) scanAbort = null;
      clearInterval(tickTimer);
      scanButton(false);
    });
  }

  var drawn = {};
  function drawSites() {
    var b = map.getBounds().pad(0.2);
    var keep = {};
    sitesIn(b).forEach(function (s) {
      keep[s.id] = true;
      if (drawn[s.id]) return;                 // already on the map: leave it alone
      var m = L.circleMarker(s.latlng, {
        radius: radiusFor(s.mw),
        color: css('--panel'), weight: 2,
        fillColor: colorOf(s.source), fillOpacity: .9
      });
      m.bindTooltip(SRC[s.source].glyph + ' ' + esc(s.name) + (s.mw ? ' · ' + fmt(s.mw, s.mw < 10 ? 1 : 0) + ' MW' : ''));
      m.bindPopup(function () { return popupHtml(s); });
      m.addTo(sitesLayer);
      drawn[s.id] = m;
    });
    Object.keys(drawn).forEach(function (id) {        // drop markers far outside the view
      if (!keep[id]) {
        sitesLayer.removeLayer(drawn[id]);
        delete drawn[id];
      }
    });
  }

  function popupHtml(s) {
    var d = me.latlng ? haversineKm(me.latlng, s.latlng) : null;
    return '<h4>' + SRC[s.source].glyph + ' ' + esc(s.name) + '</h4><div class="pop-kv">' +
      '<b>Type</b><span>' + esc(s.kind) + ' · ' + esc(SRC[s.source].label) + '</span>' +
      '<b>Capacity</b><span>' + (s.mw ? fmt(s.mw, s.mw < 10 ? 2 : 0) + ' MW (nameplate)' : 'not mapped') + '</span>' +
      (s.operator ? '<b>Operator</b><span>' + esc(s.operator) + '</span>' : '') +
      (s.method ? '<b>Method</b><span>' + esc(s.method) + '</span>' : '') +
      (d != null ? '<b>From you</b><span>' + distanceLabel(d) + '</span>' : '') +
      '</div><div class="muted small"><a href="' + s.osm + '" target="_blank" rel="noreferrer">View in OpenStreetMap</a></div>';
  }

  function updateNearby() {
    var b = map.getBounds();
    var inView = sitesIn(b);
    var totalMW = inView.reduce(function (sum, s) { return sum + (s.mw || 0); }, 0);

    $('near-count').textContent = fmt(inView.length, 0);
    $('near-mw').textContent = totalMW ? fmt(totalMW, totalMW < 100 ? 1 : 0) : '—';

    var byKey = {};
    inView.forEach(function (s) {
      var row = byKey[s.source] || (byKey[s.source] = { key: s.source, n: 0, mw: 0 });
      row.n++;
      row.mw += s.mw || 0;
    });
    var rows = Object.keys(byKey).map(function (k) { return byKey[k]; })
      .sort(function (a, b2) { return (b2.mw - a.mw) || (b2.n - a.n); });

    var tbody = $('src-table').querySelector('tbody');
    tbody.innerHTML = '';
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td><i class="swatch" style="background:' + colorOf(r.key) + '"></i>' + esc(SRC[r.key].label) +
        '</td><td class="num">' + r.n + '</td><td class="num">' + (r.mw ? fmt(r.mw, r.mw < 10 ? 1 : 0) : '—') + '</td>';
      tbody.appendChild(tr);
    });
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="muted">Nothing scanned in this view yet.</td></tr>';
    }

    var known = allSites();
    if (me.latlng && known.length) {
      var nearest = null, best = Infinity;
      known.forEach(function (s) {
        var d = haversineKm(me.latlng, s.latlng);
        if (d < best) { best = d; nearest = s; }
      });
      if (nearest) {
        $('near-nearest').innerHTML = 'Nearest to you: <strong>' + esc(nearest.name) + '</strong> (' +
          esc(SRC[nearest.source].label).toLowerCase() + ') — ' + distanceLabel(best) + ' away.';
      }
    } else if (me.latlng) {
      $('near-nearest').textContent = 'Tap "Scan this area" to find power stations around you.';
    }
  }

  // ------------------------------------------------------------------ legends
  (function buildLegends() {
    var ul = $('legend');
    SOURCES.forEach(function (s) {
      var li = document.createElement('li');
      li.innerHTML = '<i class="swatch" style="background:' + colorOf(s.key) + '"></i>' + s.glyph + ' ' + esc(s.label);
      ul.appendChild(li);
    });
    var ramp = $('ramp');
    CI_STEPS.forEach(function (st) {
      var li = document.createElement('li');
      li.innerHTML = '<i class="swatch" style="background:' + css(st.vars) + '"></i>' + st.label;
      ramp.appendChild(li);
    });
    var unit = document.createElement('li');
    unit.className = 'muted';
    unit.textContent = 'gCO₂/kWh';
    ramp.appendChild(unit);
  })();

  // -------------------------------------------------------------------- wiring
  $('btn-scan').addEventListener('click', function () { scan(false, true); });   // force a live check
  map.on('dragend zoomend', function () { interacted = true; });
  map.on('moveend', function () {
    try {
      var c = map.getCenter();
      localStorage.setItem(VIEW_KEY, JSON.stringify({ lat: c.lat, lon: c.lng, zoom: map.getZoom() }));
    } catch (e) { /* storage unavailable: the map still works */ }
  });
  map.on('moveend', function () {
    drawSites();
    updateNearby();
    clearTimeout(scanTimer);
    scanTimer = setTimeout(function () { scan(true); }, SCAN_DEBOUNCE_MS);
  });

  loadStore();                           // sites from earlier visits appear instantly
  drawSites();
  updateNearby();
  updateDataNote();
  loadDataset('plants').then(function () {
    drawSites();
    updateNearby();
    setStatus('Live · ' + sitesIn(map.getBounds()).length + ' sites in view', 'live');
  }).catch(function () {
    // No dataset committed yet (or it failed to load): live scanning covers it.
  });
  loadGrid();
  gridTimer = setInterval(loadGrid, GRID_REFRESH_MS);
  startWatch();
  hint('Live GB grid data is loading. Tap "Locate me" to put your dot on the map, then "Scan this area" for power stations around you.');

  window.addEventListener('beforeunload', function () {
    if (me.watchId != null) navigator.geolocation.clearWatch(me.watchId);
    if (gridTimer) clearInterval(gridTimer);
    if (tickTimer) clearInterval(tickTimer);
    if (scanAbort) { try { scanAbort.abort(); } catch (e) {} }
  });
})();
