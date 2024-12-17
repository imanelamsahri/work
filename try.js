import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@latest/+esm";
import * as turf from "https://cdn.jsdelivr.net/npm/@turf/turf/+esm";

mapboxgl.accessToken = 'pk.eyJ1IjoibGFtc2FocmlpbWFuZSIsImEiOiJjbTRvNGxzMngwYm95Mmtxc3djZ2NsazVxIn0.CVontsWZE5y3lQSvrvdgKw';

let map;
let db, conn;
let provincesData, damagedBuildingsData, untouchedBuildingsData, nationalRoutesData, provincialRoutesData;
let currentStyleIndex = 0;

const mapStyles = [
  'mapbox://styles/mapbox/streets-v11',
  'mapbox://styles/mapbox/outdoors-v11',
  'mapbox://styles/mapbox/light-v11',
  'mapbox://styles/mapbox/dark-v11',
  'mapbox://styles/mapbox/satellite-v9',
  'mapbox://styles/mapbox/satellite-streets-v11',
];

let draw;
let buildingChart; // Variable pour stocker le graphe

// Initialiser la carte
function initMap() {
  map = new mapboxgl.Map({
    container: 'map',
    style: mapStyles[currentStyleIndex],
    center: [-8.5, 31],
    zoom: 7,
  });

  map.addControl(new mapboxgl.NavigationControl());
}

// Ajouter l'outil de mesure
function addMeasurementTool() {
  draw = new MapboxDraw({
    displayControlsDefault: false,
    controls: {
      polygon: true,
      line_string: true,
      point: true,
      trash: true,
    },
    styles: [
      {
        id: 'gl-draw-line',
        type: 'line',
        paint: {
          'line-color': '#FF0000',
          'line-width': 2,
        },
      },
      {
        id: 'gl-draw-polygon-fill',
        type: 'fill',
        paint: {
          'fill-color': '#0000FF',
          'fill-opacity': 0.5,
        },
      },
    ],
  });

  map.addControl(draw, 'top-left');

  map.on('draw.create', updateMeasurements);
  map.on('draw.update', updateMeasurements);
  map.on('draw.delete', () => {
    document.getElementById('info-bar').textContent = 'Outil de mesure prêt.';
  });
}

// Fonction pour calculer les mesures
function updateMeasurements() {
  const data = draw.getAll();
  let totalDistance = 0;
  let totalArea = 0;

  data.features.forEach(feature => {
    if (feature.geometry.type === 'LineString') {
      totalDistance += turf.length(feature); // Calculer la distance
    } else if (feature.geometry.type === 'Polygon') {
      totalArea += turf.area(feature); // Calculer la surface
    }
  });

  const info = [];
  if (totalDistance > 0) info.push(`Distance totale : ${totalDistance.toFixed(2)} km`);
  if (totalArea > 0) info.push(`Surface totale : ${totalArea.toFixed(2)} m²`);
  document.getElementById('info-bar').textContent = info.length > 0 ? info.join(' | ') : 'Dessinez pour mesurer.';
}

// Charger un GeoJSON dans DuckDB
async function loadGeoJSONToDuckDB(url, tableName) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(` : ${url}`);
  const data = await response.json();

  const features = data.features.map(feature => ({
    geometry: JSON.stringify(feature.geometry),
    properties: JSON.stringify(feature.properties).replace(/'/g, "''"),
  }));

  await conn.query(`CREATE TABLE IF NOT EXISTS ${tableName} (geometry JSON, properties JSON);`);
  for (const feature of features) {
    await conn.query(`INSERT INTO ${tableName} VALUES ('${feature.geometry}', '${feature.properties}');`);
  }

  return data;
}

// Afficher les couches sur la carte
function displayLayers() {
  // Provinces
  map.addSource('provinces-layer', { type: 'geojson', data: provincesData });
  map.addLayer({
    id: 'provinces-fill',
    type: 'fill',
    source: 'provinces-layer',
    paint: {
      'fill-color': ['get', 'fillColor'],
      'fill-opacity': 0.4,
    },
  });
  map.addLayer({
    id: 'provinces-borders',
    type: 'line',
    source: 'provinces-layer',
    paint: {
      'line-color': '#000000',
      'line-width': 1.5,
    },
  });

  // Routes nationales
  map.addSource('national-routes', { type: 'geojson', data: nationalRoutesData });
  map.addLayer({
    id: 'national-routes',
    type: 'line',
    source: 'national-routes',
    paint: { 'line-color': '#0000FF', 'line-width': 2 },
  });

  // Routes provinciales
  map.addSource('provincial-routes', { type: 'geojson', data: provincialRoutesData });
  map.addLayer({
    id: 'provincial-routes',
    type: 'line',
    source: 'provincial-routes',
    paint: { 'line-color': '#FFA500', 'line-width': 2 },
  });

  // Bâtiments endommagés
  map.addSource('damaged-buildings', { type: 'geojson', data: damagedBuildingsData });
  map.addLayer({
    id: 'damaged-buildings',
    type: 'circle',
    source: 'damaged-buildings',
    paint: { 'circle-color': '#FF0000', 'circle-radius': 5 },
  });

  // Bâtiments non touchés
  map.addSource('untouched-buildings', { type: 'geojson', data: untouchedBuildingsData });
  map.addLayer({
    id: 'untouched-buildings',
    type: 'circle',
    source: 'untouched-buildings',
    paint: { 'circle-color': '#00FF00', 'circle-radius': 4 },
  });
}

// Mettre à jour les compteurs de bâtiments et le graphe
async function updateBuildingCounts(provinceName) {
  let damagedCount = 0;
  let untouchedCount = 0;

  if (provinceName) {
    damagedCount = await conn.query(`
      SELECT COUNT(*) AS count
      FROM damagedprov_data
      WHERE properties->>'Nom_Provin' = '${provinceName}'
    `).then(res => Number(res.toArray()[0].count)); // Convert BigInt to Number

    untouchedCount = await conn.query(`
      SELECT COUNT(*) AS count
      FROM nntoucheprov_data
      WHERE properties->>'Nom_Provin' = '${provinceName}'
    `).then(res => Number(res.toArray()[0].count)); // Convert BigInt to Number
  }

  const infoBar = document.getElementById('info-bar');
  infoBar.textContent = `Province : ${provinceName || 'Toutes'} | Bâtiments touchés : ${damagedCount} | Bâtiments non touchés : ${untouchedCount}`;

  updateBuildingChart(damagedCount, untouchedCount, provinceName || 'Toutes');
}

// Mettre à jour ou créer un graphique
function updateBuildingChart(damagedCount, untouchedCount, provinceName) {
  const ctx = document.getElementById('building-chart').getContext('2d');

  if (buildingChart) {
    buildingChart.data.datasets[0].data = [damagedCount, untouchedCount];
    buildingChart.options.plugins.title.text = `Statistiques pour ${provinceName}`;
    buildingChart.update();
  } else {
    buildingChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['Touchés', 'Non Touchés'],
        datasets: [{
          label: 'Nombre de bâtiments',
          data: [damagedCount, untouchedCount],
          backgroundColor: ['#FF0000', '#00FF00'],
        }],
      },
      options: {
        responsive: true,
        plugins: {
          title: {
            display: true,
            text: `Statistiques pour ${provinceName}`,
          },
          legend: { display: false },
        },
      },
    });
  }
}

// Remplir le menu déroulant des provinces
function populateProvinceDropdown(provinceNames) {
  const select = document.getElementById('province-select');
  provinceNames.forEach(name => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  });

  select.addEventListener('change', async (e) => {
    const provinceName = e.target.value || null;
    const filter = provinceName ? ['==', ['get', 'Nom_Provin'], provinceName] : null;
    map.setFilter('damaged-buildings', filter);
    map.setFilter('untouched-buildings', filter);

    await updateBuildingCounts(provinceName);
  });
}

// Initialisation principale
(async function init() {
  try {
    initMap();
    addMeasurementTool();

    const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);
    const worker = new Worker(URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })));
    db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    conn = await db.connect();

    provincesData = await loadGeoJSONToDuckDB('./provinces.geojson', 'provinces_data');
    damagedBuildingsData = await loadGeoJSONToDuckDB('./damagedprov.geojson', 'damagedprov_data');
    untouchedBuildingsData = await loadGeoJSONToDuckDB('./nntoucheprov.geojson', 'nntoucheprov_data');
    nationalRoutesData = await loadGeoJSONToDuckDB('./routesnationales.geojson', 'routes_nationales_data');
    provincialRoutesData = await loadGeoJSONToDuckDB('./routesprovinciales.geojson', 'routes_provinciales_data');

    provincesData.features.forEach((feature, index) => {
      feature.properties.fillColor = `hsl(${index * 30}, 70%, 50%)`;
    });

    const provinceNames = await conn.query(`
      SELECT DISTINCT properties->>'Nom_Provin' AS province FROM damagedprov_data WHERE province IS NOT NULL;
    `).then(res => res.toArray().map(row => row.province));

    displayLayers();
    populateProvinceDropdown(provinceNames);
    document.getElementById('styleButton').addEventListener('click', changeMapStyle);
    document.getElementById('info-bar').textContent = 'Carte prête.';
  } catch (error) {
    console.error('Erreur:', error);
    document.getElementById('info-bar').textContent = '';
  }
})();
