import "dotenv/config";
import express from "express";

const app = express();
app.get("/api/products", (_req, res) => res.json([]));
app.listen(3001);
