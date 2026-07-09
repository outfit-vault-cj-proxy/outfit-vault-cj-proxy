import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const CJ_TOKEN = process.env.CJ_ACCESS_TOKEN;
const CJ_BASE = "https://developers.cjdropshipping.com/api2.0/v1";

app.get("/", (req, res) => {
  res.json({ success: true, message: "Outfit Vault CJ Proxy running" });
});

app.get("/cj/products", async (req, res) => {
  try {
    const keyword = req.query.keyword || "dress";
    const url = `${CJ_BASE}/product/listV2?page=1&size=20&keyword=${encodeURIComponent(keyword)}`;

    const r = await fetch(url, {
      headers: { "CJ-Access-Token": CJ_TOKEN }
    });

    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
