import "dotenv/config";
import express, { type Express } from "express";
import { products } from "./routes.js";

export function createApp(): Express {
  const app = express();
  app.use("/products", products);
  return app;
}

createApp().listen(4000);
