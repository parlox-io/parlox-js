import { Router } from "express";

export const products = Router();
products.get("/", (_req, res) => { res.json([]); });
