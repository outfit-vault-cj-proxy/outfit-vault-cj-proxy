import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Outfit Vault proxy is running"
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "healthy" });
});

const PORT = Number(process.env.PORT) || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SERVER_STARTED_ON_PORT_${PORT}`);
});
