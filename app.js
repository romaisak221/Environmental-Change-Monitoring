// ============================================================
// MINING ENVIRONMENTAL INTELLIGENCE — app.js
// Pilbara WebGIS Dashboard
// ============================================================


// ─── SECTION 1: THEME ICON SVGs ───
var ICON_MOON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
var ICON_SUN  = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';


// ─── SECTION 2: GLOBAL STATE ───
var currentTheme        = 'light';   // light is the default
var activePanel         = null;
var hotspotEnrichedData = [];        // [{index, id, feature, leafletLayer, areaKm2, severity, priority, action}]
var chartMetrics        = null;      // computed metrics object for charts
var highlightedLayer    = null;      // currently selected Leaflet layer

// Layer references populated as each async load completes
var roiLayer, hotspotLayer, severeRaster, moderateRaster;
var layersReady = false;             // guard: tryInitLayers() runs only once


// ─── SECTION 3: UTILITY FUNCTIONS ───

// Proxy area estimate from bounding box.
// Formula: dLat × dLng × 111.32² × cos(centerLat) × 0.65 fill factor.
// Values are suitable for relative ranking only — not survey-grade measurements.
function estimateAreaKm2(feature) {
  var coords = feature.geometry.coordinates;
  if (!coords) return 0;

  var lats = [], lngs = [];
  function collectPoints(ring) {
    ring.forEach(function(pt) {
      if (Array.isArray(pt[0])) {
        pt.forEach(function(p) { lats.push(p[1]); lngs.push(p[0]); });
      } else {
        lats.push(pt[1]); lngs.push(pt[0]);
      }
    });
  }

  var type = feature.geometry.type;
  if (type === 'Polygon') {
    collectPoints(coords[0]);
  } else if (type === 'MultiPolygon') {
    coords.forEach(function(poly) { collectPoints(poly[0]); });
  } else {
    return 0;
  }

  var dLat = Math.max.apply(null, lats) - Math.min.apply(null, lats);
  var dLng = Math.max.apply(null, lngs) - Math.min.apply(null, lngs);
  var centerLat = (Math.max.apply(null, lats) + Math.min.apply(null, lats)) / 2;
  var km2 = dLat * dLng * 111.32 * 111.32 * Math.cos(centerLat * Math.PI / 180) * 0.65;
  return Math.max(0, km2);
}

function formatArea(km2) {
  if (km2 >= 1) return km2.toFixed(2) + ' km²';
  return (km2 * 100).toFixed(1) + ' ha';
}

function classifySeverity(km2) {
  if (km2 >= 1.0) return 'High';
  if (km2 >= 0.1) return 'Moderate';
  return 'Low';
}

function classifyPriority(sev) {
  return sev === 'High' ? 'Immediate' : sev === 'Moderate' ? 'Elevated' : 'Routine';
}

function classifyAction(sev) {
  return sev === 'High' ? 'Ground-truth inspection' : sev === 'Moderate' ? 'Remote assessment' : 'Continue monitoring';
}

function classifyActionShort(sev) {
  return sev === 'High' ? 'Inspect' : sev === 'Moderate' ? 'Review' : 'Monitor';
}

// Aggregate counts and areas for charts and KPIs
function computeMetrics(enriched) {
  var m = { total: enriched.length, high: 0, moderate: 0, low: 0,
            highArea: 0, modArea: 0, lowArea: 0, totalArea: 0 };
  enriched.forEach(function(ed) {
    m.totalArea += ed.areaKm2;
    if (ed.severity === 'High')     { m.high++;     m.highArea += ed.areaKm2; }
    else if (ed.severity === 'Moderate') { m.moderate++; m.modArea  += ed.areaKm2; }
    else                            { m.low++;      m.lowArea  += ed.areaKm2; }
  });
  return m;
}


// ─── SECTION 4: MAP INITIALIZATION ───
var map = L.map('map', {
  zoomControl: false,
  zoomSnap:    0.5,
  zoomDelta:   0.5
}).setView([-22, 118], 7);

L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.scale({ position: 'bottomright', metric: true, imperial: false }).addTo(map);

var darkBasemap = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  { attribution: 'Esri, HERE, DeLorme', maxZoom: 16 }
);

var lightBasemap = L.tileLayer(
  'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  { attribution: '© OpenStreetMap contributors', maxZoom: 19 }
);

// Light theme is default
lightBasemap.addTo(map);


// ─── SECTION 5: PANEL MANAGEMENT ───
function openPanel(panelId) {
  // Close whichever panel is currently open
  if (activePanel && activePanel !== panelId) {
    var prev = document.getElementById('panel-' + activePanel);
    if (prev) prev.classList.remove('active');
    var prevBtn = document.querySelector('.nav-btn[data-panel="' + activePanel + '"]');
    if (prevBtn) prevBtn.classList.remove('active');
  }

  activePanel = panelId;

  var panel = document.getElementById('panel-' + panelId);
  if (panel) panel.classList.add('active');

  var btn = document.querySelector('.nav-btn[data-panel="' + panelId + '"]');
  if (btn) btn.classList.add('active');

  // Resize charts after panel slides in (avoids zero-width canvas bug)
  if (panelId === 'analytics') {
    setTimeout(function() {
      if (window.chartSeverity) window.chartSeverity.resize();
      if (window.chartArea)     window.chartArea.resize();
      if (window.chartPriority) window.chartPriority.resize();
    }, 50);
  }
}

function closePanel() {
  if (activePanel) {
    var panel = document.getElementById('panel-' + activePanel);
    if (panel) panel.classList.remove('active');
    var btn = document.querySelector('.nav-btn[data-panel="' + activePanel + '"]');
    if (btn) btn.classList.remove('active');
    activePanel = null;
  }
}

// Nav button clicks
document.querySelectorAll('.nav-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    var target = this.dataset.panel;
    if (activePanel === target) {
      closePanel();
    } else {
      openPanel(target);
    }
  });
});

// Close (×) buttons inside panels
document.querySelectorAll('.panel-close').forEach(function(btn) {
  btn.addEventListener('click', closePanel);
});


// ─── SECTION 6: THEME MANAGEMENT ───
var themeBtn = document.getElementById('themeToggle');

// Show moon icon on load (light mode → click to go dark)
themeBtn.innerHTML = ICON_MOON;

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);

  // Swap basemaps
  if (theme === 'dark') {
    if (map.hasLayer(lightBasemap)) map.removeLayer(lightBasemap);
    if (!map.hasLayer(darkBasemap)) darkBasemap.addTo(map);
    themeBtn.innerHTML = ICON_SUN;
  } else {
    if (map.hasLayer(darkBasemap)) map.removeLayer(darkBasemap);
    if (!map.hasLayer(lightBasemap)) lightBasemap.addTo(map);
    themeBtn.innerHTML = ICON_MOON;
  }

  // Sync basemap radio buttons in Layers panel
  var radios = document.querySelectorAll('input[name="basemap"]');
  radios.forEach(function(r) { r.checked = (r.value === theme); });

  // Rebuild charts with updated theme colours
  if (chartMetrics) buildCharts(chartMetrics);
}

themeBtn.addEventListener('click', function() {
  applyTheme(currentTheme === 'light' ? 'dark' : 'light');
});


// ─── SECTION 7: POPUP HTML BUILDER ───
function buildPopupHTML(ed) {
  var sevClass = 'sev-' + ed.severity.toLowerCase();
  return [
    '<div class="popup-inner">',
    '  <div class="popup-head">',
    '    <div class="popup-title">',
    '      <span class="popup-label">Disturbance Hotspot</span>',
    '      <span class="popup-id-text">' + ed.id + '</span>',
    '    </div>',
    '    <span class="sev-badge ' + sevClass + '">' + ed.severity + '</span>',
    '  </div>',
    '  <div class="popup-stats">',
    '    <div class="popup-stat"><span class="popup-stat-label">Est. Area</span><span class="popup-stat-value">' + formatArea(ed.areaKm2) + '</span></div>',
    '    <div class="popup-stat"><span class="popup-stat-label">Inspection Priority</span><span class="popup-stat-value">' + ed.priority + '</span></div>',
    '    <div class="popup-stat"><span class="popup-stat-label">Recommended Action</span><span class="popup-stat-value">' + classifyAction(ed.severity) + '</span></div>',
    '  </div>',
    '</div>'
  ].join('\n');
}


// ─── SECTION 8: DATA LOADING ───

// ROI boundary — subtle dashed outline, not filled
fetch('data/roi_boundary.geojson')
  .then(function(r) { return r.json(); })
  .then(function(data) {
    roiLayer = L.geoJSON(data, {
      style: {
        color: '#4584bb',
        weight: 1.5,
        fill: false,
        dashArray: '8 5',
        opacity: 0.45
      }
    });
    tryInitLayers();
  })
  .catch(function(e) { console.warn('ROI load failed:', e); });

// Disturbance hotspots — outline only, no fill (avoids obscuring rasters)
fetch('data/hotspot_vectors.geojson')
  .then(function(r) { return r.json(); })
  .then(function(data) {

    // Build enriched data array before creating the layer
    hotspotEnrichedData = data.features.map(function(feat, i) {
      var km2 = estimateAreaKm2(feat);
      var sev = classifySeverity(km2);
      return {
        index:       i,
        id:          feat.properties.id || feat.properties.name || ('HS-' + String(i + 1).padStart(3, '0')),
        feature:     feat,
        leafletLayer: null,  // populated in onEachFeature below
        areaKm2:     km2,
        severity:    sev,
        priority:    classifyPriority(sev),
        action:      classifyAction(sev)
      };
    });

    hotspotLayer = L.geoJSON(data, {
      style: function() {
        return {
          color:       '#e07033',
          weight:      2,
          fillOpacity: 0,       // transparent fill — outline only
          opacity:     0.85
        };
      },
      onEachFeature: function(feature, layer) {
        var idx = feature._dashIdx = hotspotEnrichedData.findIndex(function(ed) {
          return ed.feature === feature;
        });
        if (idx >= 0) hotspotEnrichedData[idx].leafletLayer = layer;

        var ed = hotspotEnrichedData[idx] || {};

        // Hover: brighten outline
        layer.on('mouseover', function() {
          if (highlightedLayer !== this) {
            this.setStyle({ weight: 3, opacity: 1, fillOpacity: 0.08 });
          }
        });

        // Mouse out: restore default (unless this is the selected layer)
        layer.on('mouseout', function() {
          if (highlightedLayer !== this) {
            hotspotLayer.resetStyle(this);
          }
        });

        // Click: select, open panel, show card
        layer.on('click', function(e) {
          L.DomEvent.stopPropagation(e);
          selectHotspot(ed);
        });

        layer.bindPopup(buildPopupHTML(ed), {
          maxWidth: 280,
          className: ''
        });
      }
    });

    tryInitLayers();
  })
  .catch(function(e) { console.warn('Hotspot GeoJSON load failed:', e); });

// Severe loss raster — high opacity, visually dominant
fetch('rasters/severe_loss.tif')
  .then(function(r) { return r.arrayBuffer(); })
  .then(function(ab) { return parseGeoraster(ab); })
  .then(function(georaster) {
    severeRaster = new GeoRasterLayer({
      georaster:   georaster,
      opacity:     0.82,
      pixelValuesToColorFn: function(vals) {
        return vals[0] > 0 ? '#8b0000' : null;
      },
      resolution:  256
    });
    tryInitLayers();
  })
  .catch(function(e) { console.warn('Severe raster load failed:', e); });

// Moderate loss raster — lower opacity so severe raster reads above it
fetch('rasters/moderate_loss.tif')
  .then(function(r) { return r.arrayBuffer(); })
  .then(function(ab) { return parseGeoraster(ab); })
  .then(function(georaster) {
    moderateRaster = new GeoRasterLayer({
      georaster:   georaster,
      opacity:     0.55,
      pixelValuesToColorFn: function(vals) {
        return vals[0] > 0 ? '#d48c20' : null;
      },
      resolution:  256
    });
    tryInitLayers();
  })
  .catch(function(e) { console.warn('Moderate raster load failed:', e); });


// ─── SECTION 9: tryInitLayers() GUARD ───
// All four async loads call this. Only proceeds when every layer is ready.
function tryInitLayers() {
  if (!roiLayer || !hotspotLayer || !severeRaster || !moderateRaster) return;
  if (layersReady) return;
  layersReady = true;

  // Add layers in z-order: rasters first, then vectors on top
  roiLayer.addTo(map);
  severeRaster.addTo(map);
  moderateRaster.addTo(map);
  hotspotLayer.addTo(map);

  // Bring rasters to front so they sit above the tile basemap
  severeRaster.bringToFront();
  moderateRaster.bringToFront();

  // Fit map to hotspot extent
  var bounds = hotspotLayer.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [48, 48] });

  setupLayerToggles();

  // Compute metrics, populate overview and analytics panels, build table and charts
  chartMetrics = computeMetrics(hotspotEnrichedData);
  updateOverviewPanel(chartMetrics);
  buildHotspotTable(hotspotEnrichedData);
  buildCharts(chartMetrics);
}


// ─── SECTION 10: LAYER TOGGLES & OPACITY ───
function setupLayerToggles() {

  // Vector layer toggles
  var vectorMap = {
    'toggle-roi':      { layer: roiLayer,      front: false },
    'toggle-hotspots': { layer: hotspotLayer,   front: false }
  };
  Object.keys(vectorMap).forEach(function(id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', function() {
      var cfg = vectorMap[id];
      if (this.checked) {
        cfg.layer.addTo(map);
      } else {
        map.removeLayer(cfg.layer);
      }
    });
  });

  // Raster layer toggles
  var rasterMap = {
    'toggle-severe':   { layer: severeRaster },
    'toggle-moderate': { layer: moderateRaster }
  };
  Object.keys(rasterMap).forEach(function(id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', function() {
      if (this.checked) {
        rasterMap[id].layer.addTo(map);
        rasterMap[id].layer.bringToFront();
      } else {
        map.removeLayer(rasterMap[id].layer);
      }
    });
  });

  // Opacity sliders
  function wireOpacity(sliderId, valId, rasterLayer) {
    var slider = document.getElementById(sliderId);
    var valEl  = document.getElementById(valId);
    if (!slider) return;
    slider.addEventListener('input', function() {
      rasterLayer.setOpacity(this.value / 100);
      if (valEl) valEl.textContent = this.value + '%';
    });
  }

  wireOpacity('opacity-severe',   'opacity-severe-val',   severeRaster);
  wireOpacity('opacity-moderate', 'opacity-moderate-val', moderateRaster);

  // Basemap radio buttons sync with applyTheme()
  document.querySelectorAll('input[name="basemap"]').forEach(function(radio) {
    radio.addEventListener('change', function() {
      applyTheme(this.value);
    });
  });
}


// ─── SECTION 11: OVERVIEW PANEL UPDATES ───
function updateOverviewPanel(m) {
  function setText(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val;
  }
  setText('kpiHotspotCount', m.total);
  setText('kpiTotalArea',    formatArea(m.totalArea));
  setText('kpiPriority',     m.high > 0 ? 'Immediate' : m.moderate > 0 ? 'Elevated' : 'Routine');
  setText('kpiHighCount',    m.high);
  setText('analyticsCount',      m.total);
  setText('analyticsTotalArea',  formatArea(m.totalArea));
  setText('analyticsHighCount',  m.high);
}


// ─── SECTION 12: HOTSPOT TABLE ───
function buildHotspotTable(enriched) {
  var tbody = document.getElementById('hs-table-body');
  if (!tbody) return;

  // Sort descending by area
  var sorted = enriched.slice().sort(function(a, b) { return b.areaKm2 - a.areaKm2; });

  tbody.innerHTML = '';

  sorted.forEach(function(row, rank) {
    var tr = document.createElement('tr');
    tr.className = 'hs-tr';
    tr.dataset.originalIndex = String(row.index);

    var sevClass = 'sev-' + row.severity.toLowerCase();

    tr.innerHTML = [
      '<td class="hs-rank">' + (rank + 1) + '</td>',
      '<td class="hs-id-cell">' + row.id + '</td>',
      '<td>' + formatArea(row.areaKm2) + '</td>',
      '<td><span class="sev-badge ' + sevClass + '">' + row.severity + '</span></td>',
      '<td>' + classifyActionShort(row.severity) + '</td>'
    ].join('');

    tr.addEventListener('click', function() {
      selectHotspot(row);
    });

    tbody.appendChild(tr);
  });

  // Search / filter
  var searchInput = document.getElementById('hotspotSearch');
  if (searchInput) {
    searchInput.addEventListener('input', function() {
      var q = this.value.toLowerCase().trim();
      tbody.querySelectorAll('.hs-tr').forEach(function(tr) {
        tr.style.display = !q || tr.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });
  }
}


// ─── SECTION 13: HOTSPOT SELECTION (centralised) ───

// Single entry point for selecting a hotspot from the table OR from the map click.
function selectHotspot(ed) {
  // Deselect previous highlighted layer
  if (highlightedLayer && hotspotLayer) {
    hotspotLayer.resetStyle(highlightedLayer);
  }

  // Style the selected layer with a bright outline (no heavy fill)
  if (ed.leafletLayer) {
    ed.leafletLayer.setStyle({ color: '#f0c040', weight: 3, fillOpacity: 0.08, opacity: 1 });
    highlightedLayer = ed.leafletLayer;

    // Fly to feature bounds
    var bounds = ed.leafletLayer.getBounds();
    if (bounds.isValid()) {
      map.flyToBounds(bounds, { maxZoom: 13, padding: [80, 80], duration: 0.8 });
    }

    ed.leafletLayer.openPopup();
  }

  // Highlight the matching table row
  selectHotspotInTable(ed.index);

  // Show details card
  showSelectedCard(ed);
}

// Highlight a row in the hotspot table by its original feature index
function selectHotspotInTable(originalIndex) {
  document.querySelectorAll('.hs-tr').forEach(function(r) {
    r.classList.remove('hs-tr-selected');
  });
  var target = document.querySelector('.hs-tr[data-original-index="' + originalIndex + '"]');
  if (target) {
    target.classList.add('hs-tr-selected');
    target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function showSelectedCard(ed) {
  var card = document.getElementById('hs-selected-card');
  if (!card) return;

  var sevClass = 'sev-' + ed.severity.toLowerCase();

  var setEl = function(id, val, cls) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    if (cls) { el.className = el.className.replace(/sev-\S+/g, '').trim() + ' ' + cls; }
  };

  setEl('hs-card-id',       ed.id);
  setEl('hs-card-badge',    ed.severity, 'sev-badge ' + sevClass);
  setEl('hs-card-area',     formatArea(ed.areaKm2));
  setEl('hs-card-priority', ed.priority);
  setEl('hs-card-action',   classifyAction(ed.severity));

  card.classList.add('visible');
}

function clearHotspotSelection() {
  // Reset the highlighted polygon
  if (highlightedLayer && hotspotLayer) {
    hotspotLayer.resetStyle(highlightedLayer);
    highlightedLayer = null;
  }

  // Deselect table row
  document.querySelectorAll('.hs-tr').forEach(function(r) {
    r.classList.remove('hs-tr-selected');
  });

  // Hide details card
  var card = document.getElementById('hs-selected-card');
  if (card) card.classList.remove('visible');

  // Close open popup
  map.closePopup();
}


// ─── SECTION 14: CHARTS ───
function buildCharts(m) {
  var style = getComputedStyle(document.documentElement);
  var textCol   = style.getPropertyValue('--text-secondary').trim();
  var borderCol = style.getPropertyValue('--border').trim();
  var textPri   = style.getPropertyValue('--text-primary').trim();

  var HIGH_COL = '#ff5f5f';
  var MOD_COL  = '#ffb347';
  var LOW_COL  = '#4caf82';

  // Destroy existing charts before rebuilding (theme change)
  if (window.chartSeverity) { window.chartSeverity.destroy(); window.chartSeverity = null; }
  if (window.chartArea)     { window.chartArea.destroy();     window.chartArea     = null; }
  if (window.chartPriority) { window.chartPriority.destroy(); window.chartPriority = null; }

  var svCtx = document.getElementById('chart-severity');
  if (svCtx) {
    window.chartSeverity = new Chart(svCtx, {
      type: 'doughnut',
      data: {
        labels: ['High', 'Moderate', 'Low'],
        datasets: [{
          data: [m.high, m.moderate, m.low],
          backgroundColor: [HIGH_COL, MOD_COL, LOW_COL],
          borderWidth: 0,
          hoverOffset: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '60%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: textCol, boxWidth: 12, padding: 12, font: { size: 11 } }
          },
          tooltip: {
            callbacks: {
              label: function(ctx) {
                var pct = m.total ? Math.round(ctx.parsed / m.total * 100) : 0;
                return ' ' + ctx.label + ': ' + ctx.parsed + ' sites (' + pct + '%)';
              }
            }
          }
        }
      }
    });
  }

  var arCtx = document.getElementById('chart-area');
  if (arCtx) {
    window.chartArea = new Chart(arCtx, {
      type: 'bar',
      data: {
        labels: ['High', 'Moderate', 'Low'],
        datasets: [{
          label: 'Est. Area (km²)',
          data: [+m.highArea.toFixed(3), +m.modArea.toFixed(3), +m.lowArea.toFixed(3)],
          backgroundColor: [HIGH_COL, MOD_COL, LOW_COL],
          borderRadius: 4,
          borderWidth: 0
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          x: {
            ticks: { color: textCol, font: { size: 10 } },
            grid:  { color: borderCol }
          },
          y: {
            ticks: { color: textCol, font: { size: 10 } },
            grid:  { display: false }
          }
        }
      }
    });
  }

  var prCtx = document.getElementById('chart-priority');
  if (prCtx) {
    window.chartPriority = new Chart(prCtx, {
      type: 'bar',
      data: {
        labels: ['Immediate', 'Elevated', 'Routine'],
        datasets: [{
          label: 'Sites',
          data: [m.high, m.moderate, m.low],
          backgroundColor: [HIGH_COL, MOD_COL, LOW_COL],
          borderRadius: 4,
          borderWidth: 0
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          x: {
            ticks: { color: textCol, font: { size: 10 } },
            grid:  { color: borderCol }
          },
          y: {
            ticks: { color: textCol, font: { size: 10 } },
            grid:  { display: false }
          }
        }
      }
    });
  }
}


// ─── SECTION 15: MAP TOOL BUTTONS ───

// Reset View: fly back to hotspot extent
document.getElementById('btnResetView').addEventListener('click', function() {
  if (hotspotLayer) {
    var bounds = hotspotLayer.getBounds();
    if (bounds.isValid()) map.flyToBounds(bounds, { padding: [48, 48], duration: 1.0 });
  } else {
    map.flyTo([-22, 118], 7, { duration: 1.0 });
  }
});

// Clear Selection: deselect hotspot, hide card, reset layer style
document.getElementById('btnClearSelection').addEventListener('click', function() {
  clearHotspotSelection();
});


// ─── SECTION 16: STARTUP ───
// Open the Overview panel after a brief delay so the map can render first
setTimeout(function() { openPanel('overview'); }, 700);
