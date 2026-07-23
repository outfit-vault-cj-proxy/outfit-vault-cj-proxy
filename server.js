/* eslint-env node */
/* global process */

import express from "express";
import cors from "cors";

import {
  checkConnection,
  testConnection,
  getAuthUrl,
  exchangeAuthCode,
  publishListing,
  syncInventory,
  syncPrice,
  getListingStatus,
  getOrders,
  getOrderItems,
  updateAmazonTracking
} from "./amazon.js";

const app = express();

app.use(cors());
app.use(express.json());

/* =========================================================
   ENVIRONMENT VARIABLES
========================================================= */

const CJ_API_KEY = process.env.CJ_API_KEY;

const SHOPIFY_STORE_DOMAIN = String(
  process.env.SHOPIFY_STORE_DOMAIN || ""
)
  .trim()
  .replace(/^https?:\/\//i, "")
  .replace(/\/+$/, "");

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

const CJ_BASE =
  "https://developers.cjdropshipping.com/api2.0/v1";

const SHOPIFY_API_VERSION = "2026-07";

/* =========================================================
   CJ DROPSHIPPING AUTHENTICATION
========================================================= */

let cachedCJToken = null;
let cjTokenExpiresAt = 0;

async function getCJToken() {
  if (
    cachedCJToken &&
    Date.now() < cjTokenExpiresAt
  ) {
    return cachedCJToken;
  }

  if (!CJ_API_KEY) {
    throw new Error("Missing CJ_API_KEY");
  }

  const response = await fetch(
    `${CJ_BASE}/authentication/getAccessToken`,
