import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// World units: 1 unit = 100 km. Map lies in the x/z plane (north = -z); time runs up the y axis.
const UNIT = 100;
const TIME_H = 36;
const TEX_SCALE = 2;          // texture pixels per terrain pixel
const MESH_STEP = 2;          // terrain pixels per mesh cell
const SEA_Y = -0.02;
const SLAB_H = 0.6;
const PLAY_MS = 1400;
// bump with each release (and the ?v= in index.html) so browsers don't mix cached old files with new ones
const DATA_VERSION = 6;

const THEMES = {
  light: {
    bg: '#f3f2ee', ocean: '#dae3e7', unclaimed: '#e9e7df', border: 'rgba(255,255,255,0.95)',
    ghost: '#4d5964', frame: '#b4babf', slabTop: '#e3e1da', slabSide: '#d6d3ca', accent: '#d9480f',
    palette: ['#d9c7a7', '#b5c9a8', '#e3bcae', '#b8c7da', '#ddd3a3', '#c9b6d2', '#a6cbc4', '#e6c7a0', '#c2c1a8', '#d7aaa9'],
    hillAlpha: 0.6, hemi: 2.4, sun: 1.5,
    events: { conflict: '#c2410c', politics: '#2f5fd0', culture: '#7c3aed', society: '#0f766e' },
    sides: { central: '#b42318', axis: '#b42318', entente: '#2f5fd0', allied: '#2f5fd0', soviet: '#7a3e9d' },
  },
  dark: {
    bg: '#14171a', ocean: '#1b252c', unclaimed: '#2b2e31', border: 'rgba(16,19,22,0.9)',
    ghost: '#9fb0bd', frame: '#3b4248', slabTop: '#24282c', slabSide: '#1d2125', accent: '#ff7a45',
    palette: ['#857558', '#62775a', '#8f675f', '#5f7189', '#857d56', '#75657f', '#537c77', '#8f7853', '#727260', '#885e5d'],
    hillAlpha: 0.55, hemi: 2.4, sun: 1.5,
    events: { conflict: '#ff8a5c', politics: '#7aa2ff', culture: '#b794f6', society: '#4fd1c5' },
    sides: { central: '#ff6b5b', axis: '#ff6b5b', entente: '#7aa2ff', allied: '#7aa2ff', soviet: '#c08ae0' },
  },
};

const PERIODS = [
  [300, 'antiquity'], [600, 'lateAntiquity'], [1000, 'earlyMiddleAges'],
  [1300, 'highMiddleAges'], [1492, 'lateMiddleAges'], [1789, 'earlyModern'],
  [1914, 'long19th'], [1945, 'worldWars'], [1991, 'coldWar'], [Infinity, 'contemporary'],
];
const AXIS_YEARS = [-500, 1, 500, 1000, 1500, 2000];
const LANGUAGES = {
  en: 'English', 'zh-CN': '简体中文', ja: '日本語', ko: '한국어', ru: 'Русский', de: 'Deutsch',
  fr: 'Français', es: 'Español', it: 'Italiano', pt: 'Português', tr: 'Türkçe', ar: 'العربية',
};

// ---------------------------------------------------------------- i18n

let strings = null, fallback = null, lang = 'en';

// interface string with {placeholders}, falling back to English
function t(key, vars = {}) {
  const s = strings?.ui[key] ?? fallback.ui[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

const fmtYear = (y) => t(y < 0 ? 'yearBCE' : 'yearCE', { y: Math.abs(y) });
const shortYear = (y) => t(y < 0 ? 'shortBCE' : 'shortCE', { y: Math.abs(y) });
const periodOf = (y) => {
  const key = PERIODS.find(([end]) => y < end)[1];
  return strings.periods[key] ?? fallback.periods[key];
};
const fmtArea = (a) => t('km2', { n: Math.round(a).toLocaleString(lang) });
const catName = (cat) => strings.categories[cat] ?? fallback.categories[cat];
// wartime territory phase titles (they carry their own date, e.g. "November 1942: …")
const phaseTitle = (key) => strings.phases?.[key] ?? fallback.phases[key];
// polity names come from the English source data; translations are keyed by that name
const pn = (name) => strings.polities?.[name] || name;
// a place's name in the current language at a given year (cities can be renamed), or null if it doesn't exist yet/anymore
function placeName(p, year) {
  if ((p.from !== undefined && year < p.from) || (p.to !== undefined && year >= p.to)) return null;
  const key = p.names ? p.names.find(([until]) => until === null || year < until)[1] : p.id;
  return strings.places?.[key] ?? fallback.places[key];
}
// full localized date for dated events, otherwise the year
const fmtDate = (e) => (e.date
  ? new Intl.DateTimeFormat(lang, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${e.date}T12:00:00Z`))
  : fmtYear(e.year));
// localized title/place/text of an event, falling back to the English source
const evText = (e, field) => strings.events[e.wiki]?.[field] ?? e[field];

function wikiUrl(e) {
  const code = lang.split('-')[0];
  const title = code !== 'en' && e.wikiLang?.[code];
  if (!title) return `https://en.wikipedia.org/wiki/${e.wiki}`;
  const variant = lang === 'zh-CN' ? 'zh-cn' : 'wiki';  // simplified-script view of zh.wikipedia
  return `https://${code}.wikipedia.org/${variant}/${encodeURIComponent(title)}`;
}

function pickLanguage() {
  const fromUrl = new URLSearchParams(location.hash.slice(1)).get('lang');
  let saved = null;
  try { saved = localStorage.getItem('atlas-lang'); } catch { /* storage unavailable */ }
  for (const c of [fromUrl, saved, ...navigator.languages]) {
    if (!c) continue;
    if (LANGUAGES[c]) return c;
    if (c.toLowerCase().startsWith('zh')) return 'zh-CN';
    const base = c.split('-')[0];
    if (LANGUAGES[base]) return base;
  }
  return 'en';
}

async function loadLanguage(code) {
  const get = (c) => fetch(`data/i18n/${c}.json?v=${DATA_VERSION}`).then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); });
  fallback ??= await get('en');
  strings = code === 'en' ? fallback : await get(code);
  lang = code;
  try { localStorage.setItem('atlas-lang', code); } catch { /* storage unavailable */ }
  document.documentElement.lang = code;
  document.documentElement.dir = strings.dir || 'ltr';
}

// apply strings to the static page; dynamic parts are refreshed by their own updaters
function applyStaticStrings() {
  document.title = t('title');
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  const link = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
  $('footerText').innerHTML = escapeHtml(t('footer'))
    .replace('{basemaps}', link('https://github.com/aourednik/historical-basemaps', 'historical-basemaps'))
    .replace('{terrain}', link('https://registry.opendata.aws/terrain-tiles/', 'AWS Terrain Tiles'))
    // polity names are only untranslated in a language that has no polity table
    + (lang === 'en' || strings.polities ? '' : ` ${escapeHtml(t('polityNote'))}`);
  $('lang').value = lang;
}

// rough rendered width of a label, for overlap tests (CJK and Hangul glyphs are wider)
function textWidth(s, px) {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0) > 0x2e80 ? px : px * 0.62;
  return w;
}

const $ = (id) => document.getElementById(id);
const PRECISION = { 1: 'precision1', 2: 'precision2', 3: 'precision3' };

const state = {
  idx: 0, scale: 'linear', relief: 30, stack: true, labels: true, places: true, events: true, view: 'cube',
  theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  selected: null, event: null, hoverEvent: null, playing: false, sliceY: 0,
  lens: { ww1: false, ww2: false }, lensAnim: { ww1: 0, ww2: 0 },
};

let data, snaps, meta, elev, land, gridW, gridH, events, wars, places;
let bandGroup, threadGroup, phaseGroup, warPhases;
let renderer, scene, camera, controls, hemi, sun;
let slice, terrain, terrainTex, texCanvas, texCtx, slab;
let ghostGroup, frameLines, axisTicks, traceGroup, eventGroup, eventGuide, eventRing;
let center, size;  // map centre and extent in world units
let hillCanvas, landCanvas;
let playTimer = null, cameraTween = null;
const labelPool = [], axisLabels = [], eventLabelPool = [], placeLabelPool = [];

init().catch((err) => {
  console.error(err);
  const msg = location.protocol === 'file:'
    ? 'Please open this page through a web server (e.g. GitHub Pages or `python -m http.server`).'
    : `Could not load the atlas: ${err.message}`;
  $('loadingText').textContent = fallback ? t(location.protocol === 'file:' ? 'errorFile' : 'errorLoad', { msg: err.message }) : msg;
  document.querySelector('.spinner').remove();
});

async function init() {
  document.documentElement.dataset.theme = state.theme;
  await loadLanguage(pickLanguage());
  $('loadingText').textContent = t('loading');
  const getJson = (url) => fetch(`${url}?v=${DATA_VERSION}`).then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); });
  const [json, img, ev, pl, wl] = await Promise.all([
    getJson('data/boundaries.json'), loadImage(`data/terrain.png?v=${DATA_VERSION}`), getJson('data/events.json'),
    getJson('data/places.json'), getJson('data/war_layers.json'),
  ]);
  warPhases = wl.wars;
  data = json; snaps = data.snapshots; meta = data.meta;
  places = pl.places;
  for (const p of places) {
    const [x, y] = laea(p.lon, p.lat);
    p.x = x / UNIT;
    p.z = -y / UNIT;
  }
  wars = ev.wars;
  events = ev.events;
  for (const e of events) e.t = eventTime(e);
  events.sort((a, b) => a.t - b.t);
  events.forEach((e, i) => {
    const [x, y] = laea(e.lon, e.lat);
    e.index = i;
    e.x = x / UNIT;
    e.z = -y / UNIT;
  });
  const [xmin, ymin, xmax, ymax] = meta.extent;
  center = new THREE.Vector3((xmin + xmax) / 2 / UNIT, 0, -(ymin + ymax) / 2 / UNIT);
  size = { w: (xmax - xmin) / UNIT, d: (ymax - ymin) / UNIT };
  decodeTerrain(img);
  prepareFeatures();

  const hashIndex = () => snaps.findIndex((s) => s.year === Number(new URLSearchParams(location.hash.slice(1)).get('year')));
  state.idx = hashIndex() >= 0 ? hashIndex() : snaps.findIndex((s) => s.year === 1914);
  addEventListener('hashchange', () => { if (hashIndex() >= 0 && hashIndex() !== state.idx) setIndex(hashIndex()); });

  buildStops();
  buildScene();
  buildUI();
  applyStaticStrings();
  applyTheme();
  setIndex(state.idx, true);
  setView('cube', true);
  renderer.setAnimationLoop(frame);
  $('loading').classList.add('done');
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${src}`));
    img.src = src;
  });
}

// ---------------------------------------------------------------- data

// Lambert azimuthal equal-area, matching tools/build_data.py; returns km
function laea(lonDeg, latDeg) {
  const { lon0, lat0, R } = meta.projection;
  const rad = Math.PI / 180;
  const lon = lonDeg * rad, lat = latDeg * rad, l0 = lon0 * rad, p0 = lat0 * rad;
  const dl = lon - l0;
  const k = Math.sqrt(2 / (1 + Math.sin(p0) * Math.sin(lat) + Math.cos(p0) * Math.cos(lat) * Math.cos(dl)));
  return [R * k * Math.cos(lat) * Math.sin(dl), R * k * (Math.cos(p0) * Math.sin(lat) - Math.sin(p0) * Math.cos(lat) * Math.cos(dl))];
}

function decodeTerrain(img) {
  [gridW, gridH] = meta.terrainSize;
  const c = document.createElement('canvas');
  c.width = gridW; c.height = gridH;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, gridW, gridH).data;
  elev = new Float32Array(gridW * gridH);
  land = new Uint8Array(gridW * gridH);
  for (let i = 0; i < elev.length; i++) {
    land[i] = px[i * 4 + 2] > 127 ? 1 : 0;
    const e = px[i * 4] * 256 + px[i * 4 + 1] - meta.elevationOffset;
    elev[i] = land[i] ? Math.max(e, 0) : 0;
  }
  hillCanvas = makeHillshade();
}

function makeHillshade() {
  const c = document.createElement('canvas');
  c.width = gridW; c.height = gridH;
  const ctx = c.getContext('2d');
  const out = ctx.createImageData(gridW, gridH);
  const cell = meta.kmPerPx * 1000, z = 2.2;
  const az = (315 * Math.PI) / 180, alt = (45 * Math.PI) / 180;
  const at = (x, y) => elev[Math.min(gridH - 1, Math.max(0, y)) * gridW + Math.min(gridW - 1, Math.max(0, x))];
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const i = y * gridW + x;
      let v = 255;
      if (land[i]) {
        const dzdx = ((at(x + 1, y) - at(x - 1, y)) * z) / (2 * cell);
        const dzdy = ((at(x, y + 1) - at(x, y - 1)) * z) / (2 * cell);
        const slope = Math.atan(Math.hypot(dzdx, dzdy));
        const aspect = Math.atan2(dzdy, -dzdx);
        const hs = Math.cos(alt) * Math.cos(slope) + Math.sin(alt) * Math.sin(slope) * Math.cos(az - aspect);
        v = 255 * Math.min(1, Math.max(0, 0.5 + (0.5 * hs) / Math.sin(alt)));
      }
      out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v;
      out.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return c;
}

function prepareFeatures() {
  const [xmin, , , ymax] = meta.extent;
  const k = TEX_SCALE / meta.kmPerPx;
  snaps.forEach((s, si) => {
    s.index = si;
    for (const f of s.features) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const path = new Path2D();
      for (const poly of f.p) {
        for (const r of poly) {
          for (let i = 0; i < r.length; i += 2) {
            const x = r[i], y = r[i + 1];
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
            const px = (x - xmin) * k, py = (ymax - y) * k;
            i === 0 ? path.moveTo(px, py) : path.lineTo(px, py);
          }
          path.closePath();
        }
      }
      f.bbox = [x0, y0, x1, y1];
      f.path = path;
    }
  });
}

function colourOf(f) {
  const pal = THEMES[state.theme].palette;
  let c = data.colours[f.s];
  if (c === undefined) { c = 0; for (const ch of f.s) c = (c * 31 + ch.charCodeAt(0)) >>> 0; }
  return pal[c % pal.length];
}

// Time axis: a year maps to [0, 1] (proportional or evenly spaced snapshots),
// then focus bands (the time lens) are magnified to LENS_SHARE of the axis each.
const lensShare = () => (state.lens.ww1 && state.lens.ww2 ? 0.3 : 0.42);

function base01(year) {
  const n = snaps.length;
  if (year <= snaps[0].year) return 0;
  if (year >= snaps[n - 1].year) return 1;
  if (state.scale !== 'even') return (year - snaps[0].year) / (snaps[n - 1].year - snaps[0].year);
  let i = 0;
  while (snaps[i + 1].year < year) i++;
  return (i + (year - snaps[i].year) / (snaps[i + 1].year - snaps[i].year)) / (n - 1);
}

function warp(u) {
  const bands = [];
  for (const [war, [a, b]] of Object.entries(wars)) {
    const k = state.lensAnim[war];
    if (k <= 0) continue;
    const ua = base01(a), ub = base01(b);
    bands.push({ ua, ub, s: ub - ua + k * Math.max(0, lensShare() - (ub - ua)) });
  }
  if (!bands.length) return u;
  bands.sort((p, q) => p.ua - q.ua);
  const natural = 1 - bands.reduce((sum, b) => sum + b.ub - b.ua, 0);
  const squeeze = (1 - bands.reduce((sum, b) => sum + b.s, 0)) / natural;
  let out = 0, prev = 0;
  for (const b of bands) {
    if (u <= b.ua) return out + (u - prev) * squeeze;
    out += (b.ua - prev) * squeeze;
    if (u <= b.ub) return out + ((u - b.ua) / (b.ub - b.ua)) * b.s;
    out += b.s;
    prev = b.ub;
  }
  return out + (u - prev) * squeeze;
}

const yearToY = (year) => TIME_H * warp(base01(year));
const timeY = (i) => yearToY(snaps[i].year);

// fractional year of an event, using its exact date when known
function eventTime(e) {
  if (!e.date) return e.year;
  const d = new Date(`${e.date}T12:00:00Z`);
  return e.year + (d - Date.UTC(e.year, 0, 1)) / (365.25 * 864e5);
}

function heightAt(xw, zw) {
  const [xmin, , , ymax] = meta.extent;
  const gx = (xw * UNIT - xmin) / meta.kmPerPx - 0.5;
  const gy = (ymax + zw * UNIT) / meta.kmPerPx - 0.5;
  const x0 = Math.max(0, Math.min(gridW - 2, Math.floor(gx)));
  const y0 = Math.max(0, Math.min(gridH - 2, Math.floor(gy)));
  const fx = Math.max(0, Math.min(1, gx - x0)), fy = Math.max(0, Math.min(1, gy - y0));
  const i = y0 * gridW + x0;
  const e = elev[i] * (1 - fx) * (1 - fy) + elev[i + 1] * fx * (1 - fy)
    + elev[i + gridW] * (1 - fx) * fy + elev[i + gridW + 1] * fx * fy;
  const isLand = land[Math.round(gy) * gridW + Math.round(gx)];
  return isLand ? e * reliefK() : SEA_Y;
}

const reliefK = () => state.relief / (UNIT * 1000);

// ---------------------------------------------------------------- scene

function buildScene() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  $('scene').appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.5, 2000);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 12;
  controls.maxDistance = 220;
  controls.addEventListener('start', () => { cameraTween = null; });

  hemi = new THREE.HemisphereLight(0xffffff, 0xbbbbbb, 2.4);
  sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(-30, 60, -20);
  scene.add(hemi, sun);

  const [xmin, ymin, xmax, ymax] = meta.extent;
  const W = (xmax - xmin) / UNIT, D = (ymax - ymin) / UNIT;
  const cx = (xmin + xmax) / 2 / UNIT, cz = -(ymin + ymax) / 2 / UNIT;

  // active time slice: terrain + plinth
  slice = new THREE.Group();
  texCanvas = document.createElement('canvas');
  texCanvas.width = gridW * TEX_SCALE;
  texCanvas.height = gridH * TEX_SCALE;
  texCtx = texCanvas.getContext('2d');
  terrainTex = new THREE.CanvasTexture(texCanvas);
  terrainTex.colorSpace = THREE.SRGBColorSpace;
  terrainTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  terrain = new THREE.Mesh(buildTerrainGeometry(), new THREE.MeshLambertMaterial({ map: terrainTex }));
  slab = new THREE.Mesh(
    new THREE.BoxGeometry(W, SLAB_H, D),
    [0, 1, 2, 3, 4, 5].map(() => new THREE.MeshLambertMaterial()),
  );
  slab.position.set(cx, SEA_Y - SLAB_H / 2 - 0.005, cz);
  slice.add(terrain, slab);
  scene.add(slice);

  // ghost boundary layers, one per snapshot
  ghostGroup = new THREE.Group();
  for (const s of snaps) {
    const pos = [];
    for (const f of s.features) {
      for (const poly of f.p) {
        for (const r of poly) {
          const n = r.length / 2;
          for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            pos.push(r[2 * i] / UNIT, 0, -r[2 * i + 1] / UNIT, r[2 * j] / UNIT, 0, -r[2 * j + 1] / UNIT);
          }
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const line = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ transparent: true, depthWrite: false }));
    line.renderOrder = 1;
    ghostGroup.add(line);
  }
  scene.add(ghostGroup);

  // space-time cube frame
  const x0 = xmin / UNIT, x1 = xmax / UNIT, z0 = -ymax / UNIT, z1 = -ymin / UNIT;
  const fp = [];
  for (const y of [0, TIME_H]) {
    fp.push(x0, y, z0, x1, y, z0, x1, y, z0, x1, y, z1, x1, y, z1, x0, y, z1, x0, y, z1, x0, y, z0);
  }
  for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) fp.push(x, 0, z, x, TIME_H, z);
  frameLines = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(fp, 3)),
    new THREE.LineBasicMaterial({ transparent: true, opacity: 0.9 }),
  );
  scene.add(frameLines);

  axisTicks = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
  axisTicks.userData.corner = [x0, z0];
  scene.add(axisTicks);

  traceGroup = new THREE.Group();
  scene.add(traceGroup);

  // historic events: one marker per event at (place, time)
  eventGroup = new THREE.Group();
  const marker = new THREE.OctahedronGeometry(0.45);
  for (const e of events) {
    const m = new THREE.Mesh(marker, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
    m.userData.event = e;
    m.renderOrder = 3;
    eventGroup.add(m);
  }
  scene.add(eventGroup);
  // selected event: a vertical time line through the cube and a ring on the slice
  eventGuide = new THREE.Line(
    new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, TIME_H, 0], 3)),
    new THREE.LineDashedMaterial({ dashSize: 0.5, gapSize: 0.35, transparent: true, opacity: 0.8 }),
  );
  eventGuide.computeLineDistances();
  eventRing = new THREE.Mesh(
    new THREE.RingGeometry(0.7, 0.95, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
  );
  eventRing.renderOrder = 4;
  eventGuide.visible = eventRing.visible = false;
  scene.add(eventGuide, eventRing);

  // time lens: a translucent band per war, and a thread through its events in date order
  bandGroup = new THREE.Group();
  threadGroup = new THREE.Group();
  for (const war of Object.keys(wars)) {
    const box = new THREE.BoxGeometry(size.w, 1, size.d);
    const band = new THREE.Group();
    band.userData.war = war;
    const fill = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ transparent: true }));
    fill.renderOrder = edges.renderOrder = 0;
    band.add(fill, edges);
    band.position.set(center.x, 0, center.z);
    bandGroup.add(band);

    const thread = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ transparent: true, depthWrite: false }));
    thread.userData.war = war;
    thread.userData.events = events.filter((e) => e.war === war);
    threadGroup.add(thread);
  }
  scene.add(bandGroup, threadGroup);

  // wartime territory phases: translucent layers at their dates inside the war bands
  phaseGroup = new THREE.Group();
  for (const [war, phases] of Object.entries(warPhases)) {
    for (const phase of phases) {
      const layer = new THREE.Group();
      layer.userData = { war, t: eventTime({ year: Number(phase.date.slice(0, 4)), date: phase.date }), key: phase.key };
      for (const side of phase.layers) {
        const shapes = side.p.map((poly) => {
          const sh = new THREE.Shape(ringPts(poly[0]));
          for (const h of poly.slice(1)) sh.holes.push(new THREE.Path(ringPts(h)));
          return sh;
        });
        const geo = new THREE.ShapeGeometry(shapes).rotateX(-Math.PI / 2);
        const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
          transparent: true, depthWrite: false, side: THREE.DoubleSide,
        }));
        const lp = [];
        for (const poly of side.p) {
          for (const r of poly) {
            const n = r.length / 2;
            for (let k = 0; k < n; k++) {
              const j = (k + 1) % n;
              lp.push(r[2 * k] / UNIT, 0, -r[2 * k + 1] / UNIT, r[2 * j] / UNIT, 0, -r[2 * j + 1] / UNIT);
            }
          }
        }
        const edge = new THREE.LineSegments(
          new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lp, 3)),
          new THREE.LineBasicMaterial({ transparent: true, depthWrite: false }),
        );
        fill.userData.side = edge.userData.side = side.side;
        fill.renderOrder = edge.renderOrder = 2;
        layer.add(fill, edge);
      }
      phaseGroup.add(layer);
    }
  }
  scene.add(phaseGroup);

  onResize();
  addEventListener('resize', onResize);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerleave', () => { $('tooltip').hidden = true; });
  renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', onClick);
}

function buildTerrainGeometry() {
  const [xmin, ymin, xmax, ymax] = meta.extent;
  const nx = Math.floor(gridW / MESH_STEP), nz = Math.floor(gridH / MESH_STEP);
  const pos = new Float32Array((nx + 1) * (nz + 1) * 3);
  const uv = new Float32Array((nx + 1) * (nz + 1) * 2);
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const v = j * (nx + 1) + i;
      pos[v * 3] = (xmin + (i / nx) * (xmax - xmin)) / UNIT;
      pos[v * 3 + 2] = -(ymax - (j / nz) * (ymax - ymin)) / UNIT;
      uv[v * 2] = i / nx;
      uv[v * 2 + 1] = 1 - j / nz;
    }
  }
  const idx = new Uint32Array(nx * nz * 6);
  let k = 0;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      idx.set([a, c, b, b, c, d], k);
      k += 6;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

function updateRelief() {
  const pos = terrain.geometry.attributes.position;
  for (let v = 0; v < pos.count; v++) pos.array[v * 3 + 1] = heightAt(pos.array[v * 3], pos.array[v * 3 + 2]);
  pos.needsUpdate = true;
  terrain.geometry.computeVertexNormals();
  terrain.geometry.computeBoundingSphere();
}

function drawSliceTexture() {
  const t = THEMES[state.theme];
  const s = snaps[state.idx];
  const ctx = texCtx, W = texCanvas.width, H = texCanvas.height;
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = t.ocean;
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(landCanvas, 0, 0, W, H);
  for (let i = s.features.length - 1; i >= 0; i--) {
    const f = s.features[i];
    ctx.fillStyle = colourOf(f);
    ctx.fill(f.path, 'evenodd');
  }
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = t.hillAlpha;
  ctx.drawImage(hillCanvas, 0, 0, W, H);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = t.border;
  ctx.lineWidth = 2.2;
  for (const f of s.features) ctx.stroke(f.path);
  if (state.selected) {
    ctx.strokeStyle = t.accent;
    ctx.lineWidth = 4.5;
    for (const f of s.features) if (f.n === state.selected) ctx.stroke(f.path);
  }
  // wartime territory at the current war stop: tint, diagonal hatching and a dashed outline per side
  const phase = activePhase();
  if (phase) {
    for (const layer of phase.layers) {
      const colour = t.sides[layer.side];
      layer.path ??= texturePath(layer.p);
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = colour;
      ctx.fill(layer.path, 'evenodd');
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = hatchPattern(ctx, colour);
      ctx.fill(layer.path, 'evenodd');
      ctx.globalAlpha = 1;
      ctx.strokeStyle = colour;
      ctx.lineWidth = 3;
      ctx.setLineDash([10, 6]);
      ctx.stroke(layer.path);
      ctx.setLineDash([]);
    }
  }
  terrainTex.needsUpdate = true;
}

const hatchCache = {};
function hatchPattern(ctx, colour) {
  if (!hatchCache[colour]) {
    const c = document.createElement('canvas');
    c.width = c.height = 14;
    const g = c.getContext('2d');
    g.strokeStyle = colour;
    g.lineWidth = 2.2;
    g.beginPath();
    g.moveTo(-2, 16); g.lineTo(16, -2);
    g.moveTo(-2, 2); g.lineTo(2, -2);
    g.moveTo(12, 16); g.lineTo(16, 12);
    g.stroke();
    hatchCache[colour] = ctx.createPattern(c, 'repeat');
  }
  return hatchCache[colour];
}

// polygons in projected km -> Path2D in slice-texture pixels
function texturePath(polys) {
  const [xmin, , , ymax] = meta.extent;
  const k = TEX_SCALE / meta.kmPerPx;
  const path = new Path2D();
  for (const poly of polys) {
    for (const r of poly) {
      for (let i = 0; i < r.length; i += 2) {
        const px = (r[i] - xmin) * k, py = (ymax - r[i + 1]) * k;
        i === 0 ? path.moveTo(px, py) : path.lineTo(px, py);
      }
      path.closePath();
    }
  }
  return path;
}

function makeLandCanvas() {
  const c = document.createElement('canvas');
  c.width = gridW; c.height = gridH;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(gridW, gridH);
  const hex = THEMES[state.theme].unclaimed;
  const rgb = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
  for (let i = 0; i < land.length; i++) {
    if (!land[i]) continue;
    img.data.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function updateGhosts() {
  const t = THEMES[state.theme];
  ghostGroup.visible = state.stack;
  ghostGroup.children.forEach((line, i) => {
    line.position.y = timeY(i);
    // layers above the slice (the future) stay faint so they don't muddy the map
    const d = timeY(i) - state.sliceY;
    const above = d > 0.001;
    line.material.color.set(t.ghost);
    line.material.opacity = above
      ? 0.02 + 0.1 * Math.exp(-d / 1.2)
      : 0.035 + 0.3 * Math.exp(d / 1.6);
    line.visible = i !== state.idx && !(above && state.view === 'map');
  });
}

function updateAxis() {
  const t = THEMES[state.theme];
  const [x, z] = axisTicks.userData.corner;
  const pos = [];
  snaps.forEach((s, i) => pos.push(x, timeY(i), z, x - 1, timeY(i), z));
  // yearly ticks inside open lens bands
  for (const [war, [a, b]] of Object.entries(wars)) {
    if (state.lensAnim[war] < 0.3) continue;
    for (let y = Math.ceil(a); y <= b; y++) pos.push(x, yearToY(y), z, x - 0.6, yearToY(y), z);
  }
  axisTicks.geometry.dispose();
  axisTicks.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  axisTicks.material.color.set(t.frame);
}

function buildTrace() {
  traceGroup.clear();
  if (!state.selected) return;
  const t = THEMES[state.theme];
  const fill = new THREE.MeshBasicMaterial({
    color: t.accent, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false,
  });
  const edge = new THREE.LineBasicMaterial({ color: t.accent, transparent: true, opacity: 0.85 });
  snaps.forEach((s, i) => {
    const f = s.features.find((q) => q.n === state.selected);
    if (!f) return;
    const shapes = f.p.map((poly) => {
      const sh = new THREE.Shape(ringPts(poly[0]));
      for (const h of poly.slice(1)) sh.holes.push(new THREE.Path(ringPts(h)));
      return sh;
    });
    const g = new THREE.ShapeGeometry(shapes);
    g.rotateX(-Math.PI / 2);
    const layer = new THREE.Group();
    layer.userData.index = i;
    const mesh = new THREE.Mesh(g, fill);
    mesh.renderOrder = 2;
    layer.add(mesh);
    const lp = [];
    for (const poly of f.p) {
      for (const r of poly) {
        const n = r.length / 2;
        for (let k = 0; k < n; k++) {
          const j = (k + 1) % n;
          lp.push(r[2 * k] / UNIT, 0, -r[2 * k + 1] / UNIT, r[2 * j] / UNIT, 0, -r[2 * j + 1] / UNIT);
        }
      }
    }
    layer.add(new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lp, 3)), edge,
    ));
    traceGroup.add(layer);
  });
  positionTrace();
}

const ringPts = (r) => {
  const pts = [];
  for (let i = 0; i < r.length; i += 2) pts.push(new THREE.Vector2(r[i] / UNIT, r[i + 1] / UNIT));
  return pts;
};

function positionTrace() {
  for (const layer of traceGroup.children) {
    layer.position.y = timeY(layer.userData.index) + 0.01;
    layer.visible = layer.userData.index !== state.idx;
  }
}

// ---------------------------------------------------------------- state changes

// Slider stops: every snapshot, plus each territory phase and dated war event while its War focus band is open.
// War stops keep the borders of the snapshot in force when the war began; a snapshot that falls inside an
// open band (1945) is moved to the band's end so it follows the war's last stop instead of interrupting it.
let stops = [];
const phaseTime = (p) => eventTime({ year: Number(p.date.slice(0, 4)), date: p.date });

function buildStops() {
  const list = [];
  snaps.forEach((s, i) => {
    let t = s.year;
    for (const [war, [a, b]] of Object.entries(wars)) if (state.lens[war] && t > a && t < b) t = b;
    list.push({ t, snap: i });
  });
  for (const [war, [a, b]] of Object.entries(wars)) {
    if (!state.lens[war]) continue;
    const base = snapshotFor(a);
    for (const p of warPhases[war]) list.push({ t: phaseTime(p), snap: base, war, phase: p, date: p.date });
    for (const e of events) if (e.war === war && e.t > a && e.t < b) list.push({ t: e.t, snap: base, war, event: e, date: e.date });
  }
  list.sort((p, q) => p.t - q.t);
  stops = list.filter((s, i) => !i || s.t - list[i - 1].t > 0.003 || !s.war);  // merge war stops on the same day
}

// territory phase in force at the current war stop, if any
function activePhase() {
  const s = stops[state.stop];
  if (!s?.war) return null;
  let current = null;
  for (const p of warPhases[s.war]) if (phaseTime(p) <= s.t + 1e-6) current = p;
  return current;
}

function updateNowText() {
  const stop = stops[state.stop];
  const s = snaps[state.idx];
  if (stop.war) {
    const phase = activePhase();
    $('year').textContent = fmtDate({ year: Math.floor(stop.t), date: stop.date });
    $('period').textContent = periodOf(stop.t);
    $('span').textContent = t('bordersOf', { year: shortYear(s.year) }) + (phase ? ` · ${phaseTitle(phase.key)}` : '');
    $('thumbLabel').textContent = new Intl.DateTimeFormat(lang, { year: 'numeric', month: 'short', timeZone: 'UTC' })
      .format(new Date(`${stop.date}T12:00:00Z`));
  } else {
    const next = snaps[state.idx + 1];
    $('year').textContent = fmtYear(s.year);
    $('period').textContent = periodOf(s.year);
    $('span').textContent = next
      ? t('snapshotUntil', { n: s.features.length, year: fmtYear(next.year) })
      : t('snapshotLatest', { n: s.features.length });
    $('thumbLabel').textContent = shortYear(s.year);
  }
  history.replaceState(null, '', `#year=${s.year}${lang === 'en' ? '' : `&lang=${lang}`}`);
}

async function setLanguage(code) {
  await loadLanguage(code);
  applyStaticStrings();
  updateNowText();
  buildLegend();
  buildSideLegend();
  for (const a of axisLabels) if (a.year !== null) a.el.textContent = shortYear(a.year);
  togglePlay(state.playing);
  updateTimeline();
  updateSelectionPanel();
  updateEventCard();
}

// go to a snapshot (its plain, non-war stop)
function setIndex(i, instant = false) {
  const snap = Math.max(0, Math.min(snaps.length - 1, i));
  setStop(stops.findIndex((s) => s.snap === snap && !s.war), instant);
}

function setStop(i, instant = false) {
  state.stop = Math.max(0, Math.min(stops.length - 1, i));
  const stop = stops[state.stop];
  state.t = stop.t;
  state.idx = stop.snap;
  updateNowText();
  if (instant) state.sliceY = yearToY(state.t);
  drawSliceTexture();
  updateTimeline();
  updateSelectionPanel();
  if (state.event) updateEventCard();
  positionTrace();
  updateGhosts();
}

function setScale(scale) {
  state.scale = scale;
  segOn('scale', scale);
  onTimeWarp();
  updateTimeline();
}

// distance that fits a sphere of radius r, whichever of the two fov axes is tighter
function fitDistance(r) {
  const v = THREE.MathUtils.degToRad(camera.fov) / 2;
  const usable = innerWidth > 760 ? (innerWidth - 340) / innerWidth : 1;
  const h = Math.atan(Math.tan(v) * camera.aspect * usable);
  return r / Math.sin(Math.min(v, h));
}

function setView(view, instant = false) {
  state.view = view;
  segOn('views', view);
  updateGhosts();
  updateLens();
  const fit = fitDistance;
  const halfCube = Math.hypot(size.w, size.d, TIME_H) / 2;
  const halfMap = Math.hypot(size.w, size.d) / 2;
  const target = new THREE.Vector3(center.x, TIME_H * 0.5, center.z);
  let pos;
  if (view === 'cube') {
    pos = new THREE.Vector3(-0.62, 0.48, 0.8).normalize().multiplyScalar(fit(0.88 * halfCube)).add(target);
  } else if (view === 'map') {
    target.y = timeY(state.idx);
    pos = new THREE.Vector3(0, 1, 0.28).normalize().multiplyScalar(fit(0.8 * halfMap)).add(target);
  } else {
    pos = new THREE.Vector3(0.28, 0.2, 1).normalize().multiplyScalar(fit(0.78 * halfCube)).add(target);
  }
  if (instant) {
    camera.position.copy(pos);
    controls.target.copy(target);
    controls.update();
  } else {
    cameraTween = { t: 0, p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: target };
  }
}

function select(name) {
  state.selected = name;
  buildTrace();
  drawSliceTexture();
  updateSelectionPanel();
  updateTimeline();
}

// the snapshot whose borders were in force when the event happened
const snapshotFor = (year) => {
  let i = 0;
  while (i < snaps.length - 1 && snaps[i + 1].year <= year) i++;
  return i;
};

// events between the current snapshot and the next one
function inWindow(e) {
  const next = snaps[state.idx + 1];
  return e.t >= snaps[state.idx].year && (!next || e.t < next.year);
}

function selectEvent(e, jump = true) {
  state.event = e;
  if (e && jump) {
    togglePlay(false);
    // with the war's lens open, the event has its own stop showing the territory at that date
    const own = stops.findIndex((s) => s.event === e);
    if (own >= 0) setStop(own); else setIndex(snapshotFor(e.year));
  }
  updateEventCard();
  updateTimeline();
}

function updateEventCard() {
  const card = $('eventCard');
  const e = state.event;
  if (!e) { card.hidden = true; return; }
  card.hidden = false;
  const colour = THEMES[state.theme].events[e.cat];
  $('evCat').textContent = catName(e.cat);
  $('evCat').style.color = colour;
  $('evDot').style.background = colour;
  $('evTitle').textContent = evText(e, 'title');
  $('evWhen').textContent = `${fmtDate(e)} · ${evText(e, 'place')}`;
  $('evText').textContent = evText(e, 'text');
  $('evLink').href = wikiUrl(e);
  const si = snapshotFor(e.year);
  $('evJump').textContent = t('bordersOf', { year: shortYear(snaps[si].year) });
  $('evJump').disabled = si === state.idx;
  $('evPrev').disabled = e.index === 0;
  $('evNext').disabled = e.index === events.length - 1;
}

// a war's events count as current while its lens is open, so the whole war reads at once
const lensOpen = (e) => !!e.war && state.lensAnim[e.war] > 0.5;

function updateLens() {
  const t = THEMES[state.theme];
  for (const band of bandGroup.children) {
    const [a, b] = wars[band.userData.war];
    const k = state.lensAnim[band.userData.war];
    const y0 = yearToY(a), y1 = yearToY(b);
    band.visible = k > 0.01;
    band.position.y = (y0 + y1) / 2;
    band.scale.y = Math.max(0.01, y1 - y0);
    band.children[0].material.color.set(t.accent);
    band.children[0].material.opacity = 0.05 * k;
    band.children[1].material.color.set(t.accent);
    band.children[1].material.opacity = 0.45 * k;
  }
  for (const layer of phaseGroup.children) {
    const k = state.lensAnim[layer.userData.war];
    layer.visible = k > 0.01 && state.view !== 'map';
    if (!layer.visible) continue;
    layer.position.y = yearToY(layer.userData.t) + 0.03;
    for (const obj of layer.children) {
      obj.material.color.set(t.sides[obj.userData.side]);
      obj.material.opacity = (obj.isMesh ? 0.3 : 0.75) * k;
    }
  }
  for (const thread of threadGroup.children) {
    const k = state.lensAnim[thread.userData.war];
    thread.visible = k > 0.01 && state.events && state.view !== 'map';
    if (!thread.visible) continue;
    const pts = thread.userData.events.map((e) => new THREE.Vector3(e.x, yearToY(e.t), e.z));
    thread.geometry.setFromPoints(pts);
    thread.material.color.set(t.accent);
    thread.material.opacity = 0.55 * k;
  }
}

// call whenever the time mapping changes (scale, lens)
function onTimeWarp() {
  updateAxis();
  positionTrace();
  updateGhosts();
  updateLens();
}

// legend for the wartime territory layers of the open lenses
const WAR_SIDES = { ww1: ['central', 'entente'], ww2: ['axis', 'soviet', 'allied'] };
function buildSideLegend() {
  const box = $('sideLegend');
  const sides = Object.keys(WAR_SIDES).filter((w) => state.lens[w]).flatMap((w) => WAR_SIDES[w]);
  box.hidden = !sides.length;
  box.innerHTML = '';
  for (const side of sides) {
    const item = document.createElement('span');
    const sw = document.createElement('i');
    sw.style.background = THEMES[state.theme].sides[side];
    item.append(sw, t(`side${side[0].toUpperCase()}${side.slice(1)}`));
    box.appendChild(item);
  }
  if (sides.length) {
    const note = document.createElement('em');
    note.textContent = t('phasesNote');
    box.appendChild(note);
  }
}

function setLens(war, on) {
  state.lens[war] = on;
  for (const b of $('focus').querySelectorAll('button')) b.classList.toggle('on', state.lens[b.dataset.war]);
  buildSideLegend();
  // stops change with the lens; stay on the same snapshot when leaving a war stop
  buildStops();
  if (!on) setIndex(state.idx);
  // opening a lens jumps to the borders in force when that war began and frames the band
  if (on) {
    togglePlay(false);
    setIndex(snapshotFor(wars[war][0]));
    if (state.view !== 'map') focusBand(war);
  }
}

// camera on an open band, lower so the stretched time axis has room; uses the band's final position
function focusBand(war) {
  const saved = { ...state.lensAnim };
  for (const w of Object.keys(wars)) state.lensAnim[w] = state.lens[w] ? 1 : 0;
  const [a, b] = wars[war];
  const mid = (yearToY(a) + yearToY(b)) / 2;
  Object.assign(state.lensAnim, saved);
  const target = new THREE.Vector3(center.x, mid, center.z);
  const pos = new THREE.Vector3(-0.62, 0.36, 0.8).normalize()
    .multiplyScalar(fitDistance(0.62 * Math.hypot(size.w, size.d, TIME_H) / 2)).add(target);
  state.view = 'cube';
  segOn('views', 'cube');
  cameraTween = { t: 0, p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: target };
}

function updateEvents() {
  const t = THEMES[state.theme];
  eventGroup.visible = state.events;
  for (const m of eventGroup.children) {
    const e = m.userData.event;
    const now = inWindow(e) || lensOpen(e);
    const focus = e === state.event || e === state.hoverEvent;
    let y = yearToY(e.t);
    if (state.view === 'map') {
      // in map view only the current period is shown, pinned to the terrain surface
      m.visible = now || focus;
      y = state.sliceY + Math.max(0, heightAt(e.x, e.z)) + 0.5;
    } else {
      m.visible = true;
    }
    m.position.set(e.x, y, e.z);
    m.material.color.set(t.events[e.cat]);
    const d = Math.abs(y - state.sliceY);
    m.material.opacity = now || focus ? 1 : 0.25 + 0.5 * Math.exp(-d / 3);
    m.scale.setScalar(focus ? 1.6 : now ? 1.25 : 0.8);
    m.rotation.y += 0.01;
  }
  const e = state.event;
  eventGuide.visible = eventRing.visible = !!e && state.events;
  if (e) {
    eventGuide.position.set(e.x, 0, e.z);
    eventGuide.material.color.set(t.events[e.cat]);
    eventRing.position.set(e.x, state.sliceY + Math.max(0, heightAt(e.x, e.z)) + 0.05, e.z);
    eventRing.material.color.set(t.events[e.cat]);
    eventGuide.visible = state.events && state.view !== 'map';
  }
}

function setTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  applyTheme();
}

function applyTheme() {
  const t = THEMES[state.theme];
  segOn('theme', state.theme);
  scene.background = new THREE.Color(t.bg);
  hemi.intensity = t.hemi;
  sun.intensity = t.sun;
  hemi.groundColor.set(state.theme === 'dark' ? 0x666666 : 0xbbbbbb);
  slab.material.forEach((m, i) => m.color.set(i === 2 ? t.slabTop : t.slabSide));
  frameLines.material.color.set(t.frame);
  for (const i of $('legend').querySelectorAll('i')) i.style.background = t.events[i.dataset.cat];
  landCanvas = makeLandCanvas();
  updateAxis();
  drawSliceTexture();
  updateGhosts();
  updateLens();
  buildSideLegend();
  buildTrace();
  updateSelectionPanel();
  updateEventCard();
  updateTimeline();
}

function togglePlay(force) {
  state.playing = force ?? !state.playing;
  $('playIcon').innerHTML = state.playing
    ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/>'
    : '<path d="M8 5v14l11-7z" fill="currentColor"/>';
  $('play').setAttribute('aria-label', t(state.playing ? 'pause' : 'play'));
  clearInterval(playTimer);
  if (!state.playing) return;
  if (state.stop === stops.length - 1) setStop(0);
  playTimer = setInterval(() => {
    if (state.stop >= stops.length - 1) return togglePlay(false);
    setStop(state.stop + 1);
  }, PLAY_MS);
}

// ---------------------------------------------------------------- UI

function segOn(id, value) {
  for (const b of $(id).querySelectorAll('button')) b.classList.toggle('on', Object.values(b.dataset)[0] === value);
}

function buildUI() {
  $('views').addEventListener('click', (e) => e.target.dataset.view && setView(e.target.dataset.view));
  $('scale').addEventListener('click', (e) => e.target.dataset.scale && setScale(e.target.dataset.scale));
  $('focus').addEventListener('click', (e) => {
    const war = e.target.dataset.war;
    if (war) setLens(war, !state.lens[war]);
  });
  $('theme').addEventListener('click', (e) => e.target.dataset.theme && setTheme(e.target.dataset.theme));
  let reliefPending = false;
  $('relief').addEventListener('input', (e) => {
    state.relief = Number(e.target.value);
    $('reliefVal').textContent = `×${state.relief}`;
    if (!reliefPending) {
      reliefPending = true;
      requestAnimationFrame(() => { reliefPending = false; updateRelief(); });
    }
  });
  $('stack').addEventListener('change', (e) => { state.stack = e.target.checked; updateGhosts(); });
  $('labelsToggle').addEventListener('change', (e) => { state.labels = e.target.checked; });
  $('placesToggle').addEventListener('change', (e) => { state.places = e.target.checked; });
  $('eventsToggle').addEventListener('change', (e) => {
    state.events = e.target.checked;
    if (!state.events) selectEvent(null);
    updateTimeline();
  });
  $('play').addEventListener('click', () => togglePlay());
  $('selClose').addEventListener('click', () => select(null));
  $('evClose').addEventListener('click', () => selectEvent(null));
  $('evPrev').addEventListener('click', () => selectEvent(events[state.event.index - 1]));
  $('evNext').addEventListener('click', () => selectEvent(events[state.event.index + 1]));
  $('evJump').addEventListener('click', () => selectEvent(state.event));
  const select = $('lang');
  for (const [code, name] of Object.entries(LANGUAGES)) select.add(new Option(name, code));
  select.addEventListener('change', () => setLanguage(select.value));
  buildLegend();
  $('panelToggle').addEventListener('click', () => {
    const collapsed = $('panel').classList.toggle('collapsed');
    $('panelToggle').setAttribute('aria-expanded', String(!collapsed));
  });
  if (innerWidth <= 760) $('panel').classList.add('collapsed');

  const track = $('track');
  const pick = (e) => {
    const r = track.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    let best = 0;
    const dist = (s) => Math.abs(yearToY(s.t) / TIME_H - frac);
    stops.forEach((s, i) => { if (dist(s) < dist(stops[best])) best = i; });
    if (best !== state.stop) setStop(best);
  };
  track.addEventListener('pointerdown', (e) => {
    togglePlay(false);
    if (e.target.dataset.event) { selectEvent(events[Number(e.target.dataset.event)]); return; }
    track.setPointerCapture(e.pointerId);
    pick(e);
    track.onpointermove = pick;
  });
  track.addEventListener('pointerup', () => { track.onpointermove = null; });

  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' && e.target.type === 'range') return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { togglePlay(false); setStop(state.stop + 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { togglePlay(false); setStop(state.stop - 1); e.preventDefault(); }
    else if (e.key === 'Home') setStop(0);
    else if (e.key === 'End') setStop(stops.length - 1);
    else if (e.key === ' ' && e.target.tagName !== 'BUTTON') { togglePlay(); e.preventDefault(); }
    else if (e.key === 'Escape') { select(null); selectEvent(null); }
  });

  for (const year of AXIS_YEARS) {
    const el = document.createElement('div');
    el.className = 'axis-label';
    el.textContent = shortYear(year);
    $('labels').appendChild(el);
    axisLabels.push({ el, year });
  }
  // per-year labels and a name for each lens band, shown while the band is open
  for (const [war, [a, b]] of Object.entries(wars)) {
    for (let year = Math.ceil(a); year <= b; year++) {
      const el = document.createElement('div');
      el.className = 'axis-label band';
      el.textContent = shortYear(year);
      $('labels').appendChild(el);
      axisLabels.push({ el, year, war });
    }
    const el = document.createElement('div');
    el.className = 'axis-label band-name';
    $('labels').appendChild(el);
    axisLabels.push({ el, year: b, war, name: true });
    // each territory phase gets a dated title beside its layer
    for (const phase of warPhases[war]) {
      const pel = document.createElement('div');
      pel.className = 'axis-label phase';
      $('labels').appendChild(pel);
      axisLabels.push({ el: pel, year: eventTime({ year: Number(phase.date.slice(0, 4)), date: phase.date }), war, phase });
    }
  }
  const nowLabel = document.createElement('div');
  nowLabel.className = 'axis-label now';
  $('labels').appendChild(nowLabel);
  axisLabels.push({ el: nowLabel, year: null });

  updateRelief();
}

function buildLegend() {
  const legend = $('legend');
  legend.innerHTML = '';
  for (const cat of Object.keys(fallback.categories)) {
    const item = document.createElement('span');
    const dot = document.createElement('i');
    dot.dataset.cat = cat;
    dot.style.background = THEMES[state.theme].events[cat];
    item.append(dot, catName(cat));
    legend.appendChild(item);
  }
}

function updateTimeline() {
  const ticks = $('ticks');
  ticks.innerHTML = '';
  const present = new Set();
  if (state.selected) snaps.forEach((s, i) => { if (s.features.some((f) => f.n === state.selected)) present.add(i); });
  snaps.forEach((s, i) => {
    const el = document.createElement('div');
    const onSnapshot = i === state.idx && !stops[state.stop]?.war;
    el.className = 'tick' + (onSnapshot ? ' on' : '') + (present.has(i) ? ' present' : '');
    el.style.left = `${(timeY(i) / TIME_H) * 100}%`;
    el.title = fmtYear(s.year);
    ticks.appendChild(el);
  });
  // ticks for the territory phases of open bands (war events already have their diamonds)
  stops.forEach((s, i) => {
    if (!s.phase) return;
    const el = document.createElement('div');
    el.className = 'tick phase-tick' + (i === state.stop ? ' on' : '');
    el.style.left = `${(yearToY(s.t) / TIME_H) * 100}%`;
    el.title = phaseTitle(s.phase.key);
    ticks.appendChild(el);
  });
  for (const [war, [a, b]] of Object.entries(wars)) {
    const k = state.lensAnim[war];
    if (k <= 0.01) continue;
    const el = document.createElement('div');
    el.className = 'tl-band';
    el.style.left = `${(yearToY(a) / TIME_H) * 100}%`;
    el.style.width = `${((yearToY(b) - yearToY(a)) / TIME_H) * 100}%`;
    el.style.opacity = k;
    el.innerHTML = `<span>${escapeHtml(t(war))}</span>`;
    ticks.appendChild(el);
  }
  for (const year of AXIS_YEARS) {
    const el = document.createElement('div');
    el.className = 'tick-label' + (year === 1 || year === 1500 ? ' minor' : '');
    el.textContent = shortYear(year);
    el.style.left = `${(yearToY(year) / TIME_H) * 100}%`;
    ticks.appendChild(el);
  }
  if (state.events) {
    const t = THEMES[state.theme];
    for (const e of events) {
      const el = document.createElement('div');
      el.className = 'ev-dot' + (e === state.event ? ' on' : '');
      el.dataset.event = e.index;
      el.style.left = `${(yearToY(e.t) / TIME_H) * 100}%`;
      el.style.background = t.events[e.cat];
      el.title = `${shortYear(e.year)} · ${evText(e, 'title')}`;
      ticks.appendChild(el);
    }
  }
  $('thumb').style.left = `${(yearToY(state.t) / TIME_H) * 100}%`;
}

function updateSelectionPanel() {
  const box = $('selection');
  if (!state.selected) { box.hidden = true; return; }
  box.hidden = false;
  const years = snaps.filter((s) => s.features.some((f) => f.n === state.selected));
  const here = snaps[state.idx].features.find((f) => f.n === state.selected);
  const ref = here || years[years.length - 1].features.find((f) => f.n === state.selected);
  $('selName').textContent = pn(state.selected);
  $('selSwatch').style.background = colourOf(ref);
  const bits = [];
  if (ref.s && ref.s !== ref.n) bits.push(t('under', { name: pn(ref.s) }));
  bits.push(here ? t('inView', { area: fmtArea(here.a) }) : t('notPresent', { year: fmtYear(snaps[state.idx].year) }));
  $('selMeta').textContent = bits.join(' · ');
  const chips = $('selYears');
  chips.innerHTML = '';
  for (const s of years) {
    const b = document.createElement('button');
    b.textContent = shortYear(s.year);
    if (s.index === state.idx) b.className = 'on';
    b.addEventListener('click', () => { togglePlay(false); setIndex(s.index); });
    chips.appendChild(b);
  }
}

// ---------------------------------------------------------------- picking

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let downAt = null;

// events are small, so pick them in screen space with a generous radius
function pickEvent(clientX, clientY) {
  if (!state.events) return null;
  let best = null, bestD = 14;
  for (const e of events) {
    if (!e.screen) continue;
    const d = Math.hypot(e.screen.x - clientX, e.screen.y - clientY);
    if (d < bestD) { best = e; bestD = d; }
  }
  return best;
}

function pickFeature(clientX, clientY) {
  ndc.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const p = new THREE.Vector3();
  let h = 0;
  for (let k = 0; k < 5; k++) {
    plane.constant = -(state.sliceY + h);
    if (!raycaster.ray.intersectPlane(plane, p)) return null;
    h = Math.max(0, heightAt(p.x, p.z));
  }
  const x = p.x * UNIT, y = -p.z * UNIT;
  const [xmin, ymin, xmax, ymax] = meta.extent;
  if (x < xmin || x > xmax || y < ymin || y > ymax) return null;
  let hit = null;
  for (const f of snaps[state.idx].features) {
    const [x0, y0, x1, y1] = f.bbox;
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    if (inside(f, x, y) && (!hit || f.a < hit.a)) hit = f;
  }
  return hit;
}

function inside(f, x, y) {
  let c = false;
  for (const poly of f.p) {
    for (const r of poly) {
      for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
        const yi = r[i + 1], yj = r[j + 1];
        if ((yi > y) !== (yj > y) && x < ((r[j] - r[i]) * (y - yi)) / (yj - yi) + r[i]) c = !c;
      }
    }
  }
  return c;
}

let hoverQueued = null;
function onPointerMove(e) {
  if (e.buttons) { $('tooltip').hidden = true; return; }
  if (hoverQueued) { hoverQueued = e; return; }
  hoverQueued = e;
  requestAnimationFrame(() => {
    const ev = hoverQueued;
    hoverQueued = null;
    const hit = pickEvent(ev.clientX, ev.clientY);
    state.hoverEvent = hit;
    const f = hit ? null : pickFeature(ev.clientX, ev.clientY);
    const tip = $('tooltip');
    renderer.domElement.style.cursor = hit || f ? 'pointer' : '';
    if (!hit && !f) { tip.hidden = true; return; }
    const lines = [];
    if (hit) {
      lines.push(`<b>${escapeHtml(evText(hit, 'title'))}</b>`,
        `<span>${escapeHtml(fmtDate(hit))} · ${escapeHtml(evText(hit, 'place'))}</span>`);
    } else {
      lines.push(`<b>${escapeHtml(pn(f.n))}</b>`);
      if (f.s && f.s !== f.n) lines.push(escapeHtml(t('under', { name: pn(f.s) })));
      if (f.o && f.o !== f.n && f.o !== f.s) lines.push(escapeHtml(t('partOf', { name: pn(f.o) })));
      const precision = PRECISION[f.b] ? ' · ' + t('bordersPrecision', { precision: t(PRECISION[f.b]) }) : '';
      lines.push(`<span>${escapeHtml(fmtArea(f.a) + precision)}</span>`);
    }
    tip.innerHTML = lines.join('<br>');
    tip.hidden = false;
    const x = Math.min(ev.clientX + 14, innerWidth - tip.offsetWidth - 8);
    const y = Math.min(ev.clientY + 14, innerHeight - tip.offsetHeight - 8);
    tip.style.transform = `translate(${x}px, ${y}px)`;
  });
}

function onClick(e) {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const hit = pickEvent(e.clientX, e.clientY);
  if (hit) { selectEvent(hit === state.event ? null : hit); return; }
  const f = pickFeature(e.clientX, e.clientY);
  select(f && f.n !== state.selected ? f.n : null);
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- frame loop

const tmp = new THREE.Vector3();

function frame() {
  // open or close time-lens bands smoothly
  let warped = false;
  for (const war of Object.keys(wars)) {
    const target = state.lens[war] ? 1 : 0;
    const k = state.lensAnim[war];
    if (k === target) continue;
    state.lensAnim[war] = Math.abs(target - k) < 0.02 ? target : k + (target - k) * 0.1;
    warped = true;
  }
  if (warped) {
    onTimeWarp();
    updateTimeline();
  }

  // slide the active slice along the time axis
  const goal = yearToY(state.t);
  const prev = state.sliceY;
  state.sliceY += (goal - state.sliceY) * 0.12;
  if (Math.abs(goal - state.sliceY) < 0.002) state.sliceY = goal;
  slice.position.y = state.sliceY;
  if (state.sliceY !== prev) {
    updateGhosts();
    if (state.view === 'map' && !cameraTween) {
      const dy = state.sliceY - prev;
      camera.position.y += dy;
      controls.target.y += dy;
    }
  }

  if (cameraTween) {
    cameraTween.t = Math.min(1, cameraTween.t + 1 / 50);
    const k = cameraTween.t < 0.5 ? 4 * cameraTween.t ** 3 : 1 - (-2 * cameraTween.t + 2) ** 3 / 2;
    camera.position.lerpVectors(cameraTween.p0, cameraTween.p1, k);
    controls.target.lerpVectors(cameraTween.t0, cameraTween.t1, k);
    if (cameraTween.t >= 1) cameraTween = null;
  }
  controls.update();
  updateEvents();
  renderer.render(scene, camera);
  updateLabels();
}

function project(x, y, z) {
  tmp.set(x, y, z).project(camera);
  return { x: ((tmp.x + 1) / 2) * innerWidth, y: ((1 - tmp.y) / 2) * innerHeight, visible: tmp.z < 1 && tmp.z > -1 };
}

function updateLabels() {
  const placed = [];
  const overlaps = (box) => placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);

  // event markers: remember screen positions for picking; label the current period's events
  let evUsed = 0;
  for (const m of eventGroup.children) {
    const e = m.userData.event;
    e.screen = null;
    if (!state.events || !m.visible) continue;
    const p = project(m.position.x, m.position.y, m.position.z);
    if (!p.visible) continue;
    e.screen = p;
    const focus = e === state.event || e === state.hoverEvent;
    if (!focus && !((inWindow(e) || lensOpen(e)) && state.labels)) continue;
    const text = `${shortYear(e.year)} · ${evText(e, 'title')}`;
    const box = [p.x + 8, p.y - 9, p.x + 16 + textWidth(text, 11), p.y + 9];
    if (!focus && overlaps(box)) continue;
    placed.push(box);
    const el = eventLabelPool[evUsed] || makeLabel(eventLabelPool, 'event-label');
    if (el.textContent !== text) el.textContent = text;
    el.style.setProperty('--c', THEMES[state.theme].events[e.cat]);
    el.classList.toggle('focus', focus);
    el.style.transform = `translate(${p.x + 12}px, ${p.y}px) translate(0, -50%)`;
    el.style.display = '';
    evUsed++;
  }
  for (let i = evUsed; i < eventLabelPool.length; i++) eventLabelPool[i].style.display = 'none';

  // geographic names on the active slice, in priority order around the polity labels
  const dist = camera.position.distanceTo(controls.target);
  const zoomedIn = dist < 60;
  const year = snaps[state.idx].year;
  let placeUsed = 0;
  const drawPlaces = (test) => {
    if (!state.places) return;
    for (const pl of places) {
      if (!test(pl) || (pl.rank > 1 && !zoomedIn)) continue;
      const name = placeName(pl, year);
      if (!name) continue;
      const p = project(pl.x, state.sliceY + Math.max(0, heightAt(pl.x, pl.z)) + 0.2, pl.z);
      if (!p.visible || p.x < 0 || p.y < 0 || p.x > innerWidth || p.y > innerHeight) continue;
      const city = pl.type === 'city';
      const px = pl.type === 'ocean' ? 12.5 : pl.type === 'mountains' ? 11 : 10.5;
      const w = textWidth(name, px) + (city ? 12 : 4), h = 14;
      const box = city ? [p.x - 4, p.y - h / 2, p.x + w, p.y + h / 2] : [p.x - w / 2, p.y - h / 2, p.x + w / 2, p.y + h / 2];
      if (overlaps(box)) continue;
      placed.push(box);
      const el = placeLabelPool[placeUsed] || makeLabel(placeLabelPool, 'place-label');
      if (el.textContent !== name) el.textContent = name;
      el.className = `place-label ${pl.type}`;
      el.style.transform = city
        ? `translate(${p.x}px, ${p.y}px) translate(-3.5px, -50%)`
        : `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
      el.style.display = '';
      placeUsed++;
    }
  };
  const isWater = (pl) => pl.type === 'sea' || pl.type === 'ocean';
  drawPlaces((pl) => isWater(pl) || (pl.type === 'city' && pl.rank === 1));

  // polity labels on the active slice, largest first, skipping overlaps
  let used = 0;
  if (state.labels) {
    const minArea = 9000 * (dist / 50) ** 2;
    for (const f of snaps[state.idx].features) {
      const isSel = f.n === state.selected;
      if (used >= 45) break;
      if (f.a < minArea && !isSel) continue;
      const lx = f.l[0] / UNIT, lz = -f.l[1] / UNIT;
      const p = project(lx, state.sliceY + Math.max(0, heightAt(lx, lz)) + 0.25, lz);
      if (!p.visible || p.x < 0 || p.y < 0 || p.x > innerWidth || p.y > innerHeight) continue;
      const name = pn(f.n);
      const text = [...name].length > 28 ? [...name].slice(0, 26).join('') + '…' : name;
      const major = f.a > 400000;
      const w = textWidth(text, major ? 13 : 11.3) + 6, h = 15;
      const box = [p.x - w / 2, p.y - h / 2, p.x + w / 2, p.y + h / 2];
      if (!isSel && overlaps(box)) continue;
      placed.push(box);
      const el = labelPool[used] || makeLabel(labelPool, 'label');
      if (el.textContent !== text) el.textContent = text;
      el.className = 'label' + (major ? ' major' : '') + (isSel ? ' sel' : '');
      el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
      el.style.display = '';
      used++;
    }
  }
  for (let i = used; i < labelPool.length; i++) labelPool[i].style.display = 'none';
  drawPlaces((pl) => !isWater(pl) && !(pl.type === 'city' && pl.rank === 1));
  for (let i = placeUsed; i < placeLabelPool.length; i++) placeLabelPool[i].style.display = 'none';

  // time axis labels
  const [x, z] = axisTicks.userData.corner;
  const phaseYs = [];
  const openBand = (year) => Object.entries(wars).some(([w, [a, b]]) => state.lensAnim[w] > 0.5 && year >= a - 3 && year <= b + 3);
  for (const a of axisLabels) {
    const year = a.year ?? snaps[state.idx].year;
    const y = a.year === null ? state.sliceY : yearToY(year);
    // band names and phase titles sit on the cube's opposite (east) edge, clear of the year labels and the panel
    const east = a.name || a.phase;
    const p = east ? project(center.x + size.w / 2 + 1, a.name ? y + 0.9 : y, z) : project(x - 1.2, y, z);
    let show = p.visible && state.view !== 'map';
    if (a.war) show &&= state.lensAnim[a.war] > 0.5;
    else if (a.year !== null) show &&= !openBand(year);  // round-year labels give way inside open bands
    if (!east && a.year !== null) show &&= Math.abs(y - state.sliceY) > 0.5;
    if (a.phase) {
      // phase titles are stacked tightly; keep only those with room
      show &&= state.view !== 'map' && phaseYs.every((py) => Math.abs(py - p.y) > 13);
      if (show) phaseYs.push(p.y);
    }
    a.el.style.display = show ? '' : 'none';
    if (!show) continue;
    if (a.year === null) a.el.textContent = shortYear(year);
    if (a.name) a.el.textContent = t(`${a.war}Name`);
    if (a.phase) {
      const text = phaseTitle(a.phase.key);
      if (a.el.textContent !== text) a.el.textContent = text;
    }
    a.el.style.transform = `translate(${p.x}px, ${p.y}px) translate(${east ? '0' : '-100%'}, -50%)`;
  }
}

function makeLabel(pool, className) {
  const el = document.createElement('div');
  el.className = className;
  $('labels').appendChild(el);
  pool.push(el);
  return el;
}

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  // keep the scene centred in the space right of the side panel
  const wide = innerWidth > 760;
  camera.setViewOffset(innerWidth, innerHeight, wide ? -166 : 0, wide ? 36 : -70, innerWidth, innerHeight);
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
