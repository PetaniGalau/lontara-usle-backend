/**
 * =========================================================
 * LONTARA-USLE ENGINE v2.4 (KOYEB PRODUCTION)
 * Berdasarkan Logika Simulasi Lokal yang Tangguh
 * Logic: USLE (A = R * K * LS * C)
 * =========================================================
 */

const ee = require("@google/earthengine");
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// Port dinamis untuk Koyeb (Default 8000)
const PORT = process.env.PORT || 8000;

// 1. KREDENSIAL GEE (Environment Variables)
const credentials = {
  client_email: process.env.GEE_CLIENT_EMAIL,
  private_key: process.env.GEE_PRIVATE_KEY
    ? process.env.GEE_PRIVATE_KEY.replace(/\\n/g, "\n")
    : undefined,
};

console.log("☁️ Menghubungkan ke Google Earth Engine...");

ee.data.authenticateViaPrivateKey(
  credentials,
  () => {
    ee.initialize(
      null,
      null,
      () => {
        console.log(`✔️ GEE Berhasil Terhubung (Project: ${process.env.EE_PROJECT_ID || 'Default'})`);
      },
      (err) => console.error("❌ GEE Initialize Error:", err),
      null,
      process.env.EE_PROJECT_ID 
    );
  },
  (err) => console.error("❌ GEE Auth Error:", err)
);

// 2. FUNGSI STATISTIK
const getVizParams = (image, geometry, scale, palette, bandName) => {
  return new Promise((resolve) => {
    image
      .reduceRegion({
        reducer: ee.Reducer.percentile([2, 98]),
        geometry: geometry,
        scale: scale,
        bestEffort: true,
        maxPixels: 1e9
      })
      .evaluate((stats, err) => {
        if (err || !stats || stats[`${bandName}_p2`] === undefined) {
          const defaults = {
            R_Factor: { min: 500, max: 4000 },
            K_Factor: { min: 0.01, max: 0.05 },
            LS_Factor: { min: 0.1, max: 15 },
            C_Factor: { min: 0.001, max: 0.5 },
            Erosi_Total: { min: 0, max: 200 },
          };
          const d = defaults[bandName] || { min: 0, max: 1 };
          return resolve({ min: d.min, max: d.max, palette });
        }
        resolve({
          min: stats[`${bandName}_p2`],
          max: stats[`${bandName}_p98`],
          palette,
        });
      });
  });
};

// 3. LOGIC USLE (Berdasarkan Simulasi Lokal Mas Fajar)
const getUSLEFactors = (geometry, year) => {
  // R-Factor: CHIRPS
  const r = ee.ImageCollection("UCSB-CHC/CHIRPS/V3/DAILY_SAT")
    .filterBounds(geometry)
    .filterDate(`${year}-01-01`, `${year}-12-31`)
    .select("precipitation")
    .sum()
    .pow(1.09)
    .multiply(0.41)
    .rename("R_Factor");

  // K-Factor: Sand + Clay WFRACTION
  const sand = ee.Image("OpenLandMap/SOL/SOL_SAND-WFRACTION_USDA-3A1A1A_M/v02").select("b0");
  const clay = ee.Image("OpenLandMap/SOL/SOL_CLAY-WFRACTION_USDA-3A1A1A_M/v02").select("b0");
  const k = sand.add(clay).multiply(0.001).rename("K_Factor");

  // LS-Factor: SRTM Slope Logic
  const srtm = ee.Image("USGS/SRTMGL1_003");
  const slope = ee.Terrain.slope(srtm).multiply(Math.PI / 180);
  const ls = ee.Image.constant(30)
    .divide(22.13)
    .pow(0.4)
    .multiply(slope.sin().divide(0.0896).pow(1.3))
    .rename("LS_Factor");

  // C-Factor: ESA WorldCover
  const c = ee.ImageCollection("ESA/WorldCover/v200")
    .filterBounds(geometry)
    .first()
    .remap(
      [10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100],
      [0.001, 0.01, 0.001, 0.2, 0.5, 0.3, 0.001, 0.001, 0.001, 0.001, 0.9]
    )
    .rename("C_Factor");

  // A = R * K * LS * C
  const a = r.multiply(k).multiply(ls).multiply(c).rename("Erosi_Total");

  return { r, k, ls, c, a };
};

// 4. ENDPOINTS API
app.post("/api/identify", async (req, res) => {
  try {
    const { lat, lng, factor } = req.body;
    const point = ee.Geometry.Point([lng, lat]);
    const factors = getUSLEFactors(point, 2024);
    const image = factors[factor];
    image.reduceRegion({ reducer: ee.Reducer.first(), geometry: point, scale: 30 })
      .evaluate((val, err) => {
        if (err) return res.status(500).json({ value: 0 });
        const bandName = image.bandNames().get(0).getInfo();
        res.json({ value: val[bandName] || 0 });
      });
  } catch (err) { res.status(500).json({ value: 0 }); }
});

const processFactor = async (req, res, factorKey, palette) => {
  try {
    const { aoi, year } = req.body;
    const geometry = ee.Geometry(aoi);
    const factors = getUSLEFactors(geometry, year);
    const image = factors[factorKey].clip(geometry);
    const bandName = image.bandNames().get(0).getInfo();
    const viz = await getVizParams(image, geometry, 100, palette, bandName);
    
    image.getMapId(viz, (mapId, err) => {
      if (err || !mapId) return res.status(500).json({ status: "error", message: "MapID Gagal" });
      res.json({
        status: "success",
        tile_url: mapId.urlFormat,
        stats: { min: viz.min, max: viz.max }
      });
    });
  } catch (err) { res.status(500).json({ status: "error", message: err.message }); }
};

app.post("/api/process-r", (req, res) => processFactor(req, res, "r", ["eff3ff", "08519c"]));
app.post("/api/process-k", (req, res) => processFactor(req, res, "k", ["f7fcf5", "006d2c"]));
app.post("/api/process-ls", (req, res) => processFactor(req, res, "ls", ["fff5f0", "99000d"]));
app.post("/api/process-c", (req, res) => processFactor(req, res, "c", ["1a9850", "d73027"]));
app.post("/api/process-a", (req, res) => processFactor(req, res, "a", ["#ffffb2", "#bd0026"]));

app.listen(PORT, () => console.log(`🔥 LONTARA-USLE ENGINE Aktif di Port: ${PORT}`));
