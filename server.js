/**
 * =========================================================
 * LONTARA-USLE ENGINE v2.1 (BACKEND - CLOUD COMPUTING)
 * Brand: Lontara Tech - Geospatial Intelligence
 * Logic: USLE (A = R * K * LS * C)
 * Optimization: Environment Variables & Dynamic Port
 * =========================================================
 */

const ee = require("@google/earthengine");
const express = require("express");
const cors = require("cors");
require("dotenv").config(); // Untuk membaca variabel lingkungan (.env)

const app = express();
app.use(cors());
app.use(express.json());

// Menggunakan PORT dinamis untuk Koyeb
const PORT = process.env.PORT || 5000;

// 1. KONEKSI KE GEE (MENGGUNAKAN SERVICE ACCOUNT DARI ENV)
const privateKey = {
  client_email: process.env.GEE_CLIENT_EMAIL,
  private_key: process.env.GEE_PRIVATE_KEY
    ? process.env.GEE_PRIVATE_KEY.replace(/\\n/g, "\n")
    : undefined,
};

console.log("☁️ Menghubungkan ke Google Earth Engine...");
ee.data.authenticateViaServiceAccount(
  privateKey,
  () => {
    ee.initialize(
      null,
      null,
      () => {
        console.log("✔️ GEE Berhasil Terhubung (Production Mode)");
      },
      (err) => console.error("❌ GEE Initialize Error:", err),
    );
  },
  (err) =>
    console.error("❌ GEE Auth Error: Periksa Environment Variables Anda", err),
);

// 2. FUNGSI STATISTIK (Backend Visualizer)
const getVizParams = (image, geometry, scale, palette, bandName) => {
  return new Promise((resolve) => {
    image
      .reduceRegion({
        reducer: ee.Reducer.percentile([5, 95]), // Lebih stabil untuk visualisasi
        geometry: geometry,
        scale: scale,
        bestEffort: true,
      })
      .evaluate((stats, err) => {
        if (err || !stats || stats[`${bandName}_p5`] === undefined) {
          const defaults = {
            R_Factor: { min: 1000, max: 5000 },
            K_Factor: { min: 0.01, max: 0.06 },
            LS_Factor: { min: 0.1, max: 20 },
            C_Factor: { min: 0.001, max: 0.8 },
            Erosi_Total: { min: 0, max: 500 },
          };
          const d = defaults[bandName] || { min: 0, max: 1 };
          return resolve({ min: d.min, max: d.max, palette });
        }
        resolve({
          min: stats[`${bandName}_p5`],
          max: stats[`${bandName}_p95`],
          palette,
        });
      });
  });
};

// 3. LOGIC USLE (A = R * K * LS * C)
const getUSLEFactors = (geometry, year) => {
  // R-Factor: CHIRPS (Metode Lenvain/Bols Indonesia)
  const r = ee
    .ImageCollection("UCSB-CHC/CHIRPS/V3/DAILY_SAT")
    .filterBounds(geometry)
    .filterDate(`${year}-01-01`, `${year}-12-31`)
    .sum()
    .pow(1.09)
    .multiply(0.41)
    .rename("R_Factor");

  // K-Factor: OpenLandMap Texture Approximation
  const texture = ee
    .Image("OpenLandMap/SOL/SOL_TEXTURE-CLASS_USDA-TT_M/v02")
    .clip(geometry);
  const k = texture.multiply(0.005).rename("K_Factor"); // Estimasi berdasarkan kelas tekstur

  // LS-Factor: SRTM 30m Slope Logic
  const srtm = ee.Image("USGS/SRTMGL1_003");
  const slope = ee.Terrain.slope(srtm).clip(geometry);
  const ls = slope.divide(9).pow(1.3).multiply(0.5).rename("LS_Factor");

  // C-Factor: ESA WorldCover Remapping
  const c = ee
    .ImageCollection("ESA/WorldCover/v200")
    .first()
    .clip(geometry)
    .remap(
      [10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100],
      [0.01, 0.1, 0.01, 0.4, 0.6, 0.3, 0.001, 0.01, 0.01, 0.01, 0.9],
    )
    .rename("C_Factor");

  // Laju Erosi Tahunan (A)
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

    image
      .reduceRegion({ reducer: ee.Reducer.first(), geometry: point, scale: 10 })
      .evaluate((val, err) => {
        if (err) return res.status(500).json({ value: 0 });
        const bandName = Object.keys(val)[0];
        res.json({ value: val[bandName] || 0 });
      });
  } catch (err) {
    res.status(500).json({ value: 0 });
  }
});

const processFactor = async (req, res, factorKey, palette) => {
  try {
    const { aoi, year } = req.body;
    const geometry = ee.Geometry(aoi);
    const factors = getUSLEFactors(geometry, year);
    const image = factors[factorKey].clip(geometry);
    const bandName =
      factorKey === "a"
        ? "Erosi_Total"
        : factors[factorKey].bandNames().get(0).getInfo();

    const viz = await getVizParams(image, geometry, 30, palette, bandName);

    image.getMapId(viz, (mapId, err) => {
      if (err || !mapId)
        return res
          .status(500)
          .json({ status: "error", message: "GEE MapID Error" });
      res.json({
        status: "success",
        tile_url: mapId.urlFormat,
        stats: { min: viz.min, max: viz.max },
      });
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
};

// Routing API
app.post("/api/process-r", (req, res) =>
  processFactor(req, res, "r", ["eff3ff", "08519c"]),
);
app.post("/api/process-k", (req, res) =>
  processFactor(req, res, "k", ["f7fcf5", "006d2c"]),
);
app.post("/api/process-ls", (req, res) =>
  processFactor(req, res, "ls", ["fff5f0", "99000d"]),
);
app.post("/api/process-c", (req, res) =>
  processFactor(req, res, "c", ["1a9850", "d73027"]),
);
app.post("/api/process-a", (req, res) =>
  processFactor(req, res, "a", ["ffffb2", "feb24c", "f03b20", "bd0026"]),
);

app.listen(PORT, () =>
  console.log(`🔥 LONTARA-USLE ENGINE Berjalan di Port: ${PORT}`),
);
