/* eslint-env node */
/* global process */
import express from "express";
import cors from "cors";
import { checkConnection, testConnection, getAuthUrl, exchangeAuthCode, publishListing, syncInventory, syncPrice, getListingStatus, getOrders, getOrderItems, updateAmazonTracking } from "./amazon.js";

const app = express();
app.use(cors());
app.use(express.json());

const CJ_API_KEY = process.env.CJ_API_KEY;
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const CJ_BASE = "https://developers.cjdropshipping.com/api2.0/v1";
const SHOPIFY_API_VERSION = "2026-07";

let cachedToken = null;
let tokenExpiresAt = 0;

async function getCJToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  if (!CJ_API_KEY) throw new Error("Missing CJ_API_KEY");
  const res = await fetch(`${CJ_BASE}/authentication/getAccessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: CJ_API_KEY })
  });
  const data = await res.json();
  if (!res.ok || !data.data?.accessToken) throw new Error(JSON.stringify(data));
  cachedToken = data.data.accessToken;
  tokenExpiresAt = Date.now() + 14 * 24 * 60 * 60 * 1000;
  return cachedToken;
}

async function cjGet(path, overrideToken) {
  const token = overrideToken || await getCJToken();
  const r = await fetch(`${CJ_BASE}${path}`, {
    headers: { "CJ-Access-Token": token, "Content-Type": "application/json" }
  });
  return r.json();
}

async function cjPost(path, body, overrideToken) {
  const token = overrideToken || await getCJToken();
  const r = await fetch(`${CJ_BASE}${path}`, {
    method: "POST",
    headers: { "CJ-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return r.json();
}

async function shopifyGraphQL(query, variables) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_ACCESS_TOKEN) {
    throw new Error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN");
  }
  const res = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query, variables })
    }
  );
  const data = await res.json();
  if (data.errors) throw new Error("Shopify error: " + JSON.stringify(data.errors));
  return data.data;
}

let onlineStorePublicationId = null;
async function getOnlineStorePublicationId() {
  if (onlineStorePublicationId) return onlineStorePublicationId;
  const query = `query { publications(first: 20) { edges { node { id name } } } }`;
  const data = await shopifyGraphQL(query, {});
  const pub = (data.publications.edges || []).map((e) => e.node).find((n) => n.name === "Online Store");
  if (!pub) throw new Error("Online Store publication channel not found");
  onlineStorePublicationId = pub.id;
  return onlineStorePublicationId;
}

async function publishProduct(productId) {
  const publicationId = await getOnlineStorePublicationId();
  const mutation = `
    mutation publishablePublish($id: ID!, $publicationId: ID!) {
      publishablePublish(id: $id, input: { publicationId: $publicationId }) {
        publishable { publishedOnCurrentPublication }
        userErrors { field message }
      }
    }`;
  const data = await shopifyGraphQL(mutation, { id: productId, publicationId });
  return data.publishablePublish;
}

app.get("/", (req, res) => {
  res.json({ success: true, message: "The Outfit Vault proxy is running" });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    shopifyConfigured: !!(process.env.SHOPIFY_STORE_DOMAIN && process.env.SHOPIFY_ADMIN_ACCESS_TOKEN),
    cjConfigured: !!process.env.CJ_API_KEY,
    amazonConfigured: !!process.env.AMAZON_LWA_CLIENT_ID,
    amazonEnvironment: process.env.AMAZON_SPAPI_ENVIRONMENT || "production",
  });
});

// Search CJ product catalog
app.get("/cj/products", async (req, res) => {
  try {
    const keyWord = req.query.keyWord || req.query.keyword || "";
    const page = req.query.page || 1;
    const size = req.query.size || 20;
    const data = await cjGet(
      `/product/listV2?page=${page}&size=${size}&keyWord=${encodeURIComponent(keyWord)}`,
      req.headers["x-cj-access-token"]
    );
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Fetch full CJ product detail
app.get("/cj/product", async (req, res) => {
  try {
    const pid = req.query.pid;
    if (!pid) return res.status(400).json({ success: false, error: "pid required" });
    const data = await cjGet(`/product/query?pid=${encodeURIComponent(pid)}`, req.headers["x-cj-access-token"]);
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Forward an order to CJ for fulfillment
app.post("/cj/create-order", async (req, res) => {
  try {
    const data = await cjPost("/shopping/order/createOrderV2", req.body, req.headers["x-cj-access-token"]);
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Fetch all active Shopify products (catalog sync into The Outfit Vault)
app.get("/shopify/products", async (req, res) => {
  try {
    const allProducts = [];
    let cursor = null;
    let hasNextPage = true;
    while (hasNextPage) {
      const query = `
        query Products($first: Int!, $after: String) {
          products(first: $first, after: $after, query: "status:active") {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id
                title
                descriptionHtml
                vendor
                productType
                status
                featuredMedia { preview { image { url } } }
                variants(first: 100) {
                  nodes {
                    id
                    sku
                    price
                    compareAtPrice
                    inventoryQuantity
                    selectedOptions { name value }
                    image { url }
                  }
                }
              }
            }
          }
        }`;
      const data = await shopifyGraphQL(query, { first: 250, after: cursor });
      const conn = data.products;
      for (const edge of conn.edges) allProducts.push(edge.node);
      hasNextPage = conn.pageInfo.hasNextPage;
      cursor = conn.pageInfo.endCursor;
    }
    res.json({ success: true, products: allProducts });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Fetch Shopify products with full per-variant data for Amazon enrichment.
// Returns a flat array of variant objects with denormalized product fields,
// containing only the data needed for GTIN exemption evaluation and Amazon
// listing creation. Additive only — does not modify /shopify/products.
app.get("/shopify/products/variants", async (req, res) => {
  try {
    const productId = req.query.productId;
    const allVariants = [];
    let productCount = 0;
    let hasNextPage = false;
    let nextCursor = null;

    function flattenVariants(node) {
      productCount++;
      const productImage = node.featuredImage?.url || null;
      for (const edge of (node.variants?.edges || [])) {
        const v = edge.node;
        const weight = v.inventoryItem?.measurement?.weight;
        allVariants.push({
          shopify_product_id: node.id,
          shopify_variant_id: v.id,
          sku: v.sku || null,
          barcode: v.barcode || null,
          price: parseFloat(v.price) || 0,
          inventoryQuantity: v.inventoryQuantity != null ? v.inventoryQuantity : 0,
          weight: weight?.value || null,
          weightUnit: weight?.unit || null,
          selectedOptions: v.selectedOptions || [],
          image: v.image?.url || productImage,
          productTitle: node.title,
          vendor: node.vendor,
          productType: node.productType,
        });
      }
      const vpi = node.variants?.pageInfo;
      if (vpi) {
        hasNextPage = vpi.hasNextPage || false;
        nextCursor = vpi.endCursor || null;
      }
    }

    if (productId) {
      const query = `
        query ProductWithVariants($id: ID!) {
          product(id: $id) {
            id title vendor productType
            featuredImage { url }
            variants(first: 250) {
              pageInfo { hasNextPage endCursor }
              edges { node {
                id sku barcode price inventoryQuantity
                selectedOptions { name value }
                image { url }
                inventoryItem { measurement { weight { value unit } } }
              } }
            }
          }
        }`;
      const data = await shopifyGraphQL(query, { id: productId });
      if (data.product) flattenVariants(data.product);
    } else {
      let cursor = null;
      let moreProducts = true;
      while (moreProducts) {
        const query = `
          query ProductsWithVariants($first: Int!, $after: String) {
            products(first: $first, after: $after, query: "status:active") {
              pageInfo { hasNextPage endCursor }
              edges { node {
                id title vendor productType
                featuredImage { url }
                variants(first: 250) {
                  edges { node {
                    id sku barcode price inventoryQuantity
                    selectedOptions { name value }
                    image { url }
                    inventoryItem { measurement { weight { value unit } } }
                  } }
                }
              } }
            }
          }`;
        const data = await shopifyGraphQL(query, { first: 250, after: cursor });
        const conn = data.products;
        for (const edge of conn.edges) flattenVariants(edge.node);
        moreProducts = conn.pageInfo.hasNextPage;
        cursor = conn.pageInfo.endCursor;
      }
      hasNextPage = false;
      nextCursor = null;
    }

    // Integrity validation
    const seenIds = new Set();
    const duplicates = [];
    for (const v of allVariants) {
      if (!v.shopify_product_id) {
        return res.status(500).json({
          success: false,
          error: "Integrity validation failed: variant missing shopify_product_id",
          variant_id: v.shopify_variant_id || null,
        });
      }
      if (productId && v.shopify_product_id !== productId) {
        return res.status(500).json({
          success: false,
          error: `Integrity validation failed: variant ${v.shopify_variant_id} belongs to ${v.shopify_product_id}, expected ${productId}`,
        });
      }
      if (seenIds.has(v.shopify_variant_id)) {
        duplicates.push(v.shopify_variant_id);
      } else {
        seenIds.add(v.shopify_variant_id);
      }
    }
    if (duplicates.length > 0) {
      return res.status(500).json({
        success: false,
        error: `Integrity validation failed: ${duplicates.length} duplicate variant ID(s) detected`,
        duplicate_variant_ids: duplicates,
      });
    }

    // Diagnostic headers
    res.set("X-Shopify-Product-Count", String(productCount));
    res.set("X-Shopify-Variant-Count", String(allVariants.length));
    res.set("X-Shopify-API-Version", SHOPIFY_API_VERSION);

    res.json({
      success: true,
      meta: {
        shopify_api_version: SHOPIFY_API_VERSION,
        product_count: productCount,
        variant_count: allVariants.length,
        has_next_page: hasNextPage,
        next_cursor: nextCursor,
        generated_at: new Date().toISOString(),
      },
      variants: allVariants,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Import CJ products into Shopify as ACTIVE, published to the Online Store
app.post("/shopify/import", async (req, res) => {
  try {
    const selectedProducts = req.body?.selectedProducts;
    if (!Array.isArray(selectedProducts) || selectedProducts.length === 0) {
      return res.status(400).json({ success: false, error: "selectedProducts array required" });
    }
    const imported = [];
    for (const item of selectedProducts) {
      const cjProductId = item.pid || item.productId || item.cjProductId || item.cj_product_id;
      if (!cjProductId) {
        imported.push({ success: false, error: "Missing CJ product id", item });
        continue;
      }
      let product = {};
      try {
        const detail = await cjGet(`/product/query?pid=${encodeURIComponent(cjProductId)}`, req.headers["x-cj-access-token"]);
        product = detail.data || {};
      } catch (e) {
        imported.push({ cjProductId, success: false, error: "CJ detail fetch failed: " + e.message });
        continue;
      }

      const images = [product.productImage, ...(product.productImages || [])].filter(Boolean);
      const price = String(item.price || product.sellPrice || product.productSellPrice || product.suggestSellPrice || "29.99");

      const mutation = `
        mutation ProductCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
          productCreate(product: $product, media: $media) {
            product { id title handle }
            userErrors { field message }
          }
        }`;

      const variables = {
        product: {
          title: product.productNameEn || product.productName || item.name || "Imported CJ Product",
          descriptionHtml: product.description || product.productDescription || item.description || "",
          vendor: "CJ Dropshipping",
          productType: product.categoryName || product.threeCategoryName || "Dropshipping",
          tags: ["CJ Dropshipping", "The Outfit Vault", `CJ_PID_${cjProductId}`],
          status: "ACTIVE"
        },
        media: images.slice(0, 10).map((src) => ({
          mediaContentType: "IMAGE",
          originalSource: src,
          alt: product.productNameEn || product.productName || "Product image"
        }))
      };

      try {
        const result = await shopifyGraphQL(mutation, variables);
        const errors = result.productCreate.userErrors;
        if (errors.length) {
          imported.push({ cjProductId, success: false, errors });
          continue;
        }
        const created = result.productCreate.product;
        // Publish to the Online Store so it appears on the storefront
        try {
          await publishProduct(created.id);
        } catch (pubErr) {
          // Product is created/active; publishing failure is non-fatal
        }
        imported.push({ cjProductId, success: true, shopifyProduct: created });
      } catch (e) {
        imported.push({ cjProductId, success: false, error: e.message });
      }
    }
    res.status(200).json({ success: true, imported });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ===== Amazon SP-API routes =====
app.get("/amazon/test", async (req, res) => {
  try {
    const data = await testConnection();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/amazon/auth", (req, res) => {
  try {
    const state = req.query.state || Math.random().toString(36).slice(2);
    const redirectUri = process.env.AMAZON_OAUTH_REDIRECT_URI || `${req.protocol}://${req.get("host")}/amazon/callback`;
    const url = getAuthUrl(state, redirectUri);
    res.redirect(url);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/amazon/callback", async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).json({ success: false, error: "Missing authorization code" });
    const redirectUri = process.env.AMAZON_OAUTH_REDIRECT_URI || `${req.protocol}://${req.get("host")}/amazon/callback`;
    const result = await exchangeAuthCode(code, redirectUri);

    // Automatically store the refresh token in the Base44 database and switch to production
    const authUrl = process.env.BASE44_AMAZON_AUTH_URL;
    const authSecret = process.env.AMAZON_AUTH_SECRET;
    let stored = false;
    let storeError = null;
    if (authUrl && authSecret && result.refresh_token) {
      try {
        const storeRes = await fetch(authUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-auth-secret": authSecret },
          body: JSON.stringify({ action: "store-token", refresh_token: result.refresh_token }),
        });
        const storeData = await storeRes.json();
        stored = storeData.success;
        if (!storeData.success) storeError = storeData.error;
      } catch (storeErr) {
        storeError = storeErr.message;
        console.log("Token storage failed: " + storeErr.message);
      }
    } else {
      storeError = "BASE44_AMAZON_AUTH_URL or AMAZON_AUTH_SECRET not set in proxy env";
    }

    const appUrl = process.env.BASE44_APP_URL || "https://theoutfitvault.store";
    const params = new URLSearchParams({ amazon_connected: stored ? "1" : "0" });
    if (storeError) params.set("error", storeError);
    res.redirect(302, `${appUrl}/marketplace?${params.toString()}`);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// OAuth aliases (canonical route names)
app.get("/amazon/oauth/start", (req, res) => {
  try {
    const state = req.query.state || Math.random().toString(36).slice(2);
    const redirectUri = process.env.AMAZON_OAUTH_REDIRECT_URI || `${req.protocol}://${req.get("host")}/amazon/oauth/callback`;
    const url = getAuthUrl(state, redirectUri);
    res.redirect(url);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/amazon/oauth/callback", async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).json({ success: false, error: "Missing authorization code" });
    const redirectUri = process.env.AMAZON_OAUTH_REDIRECT_URI || `${req.protocol}://${req.get("host")}/amazon/oauth/callback`;
    const result = await exchangeAuthCode(code, redirectUri);

    const authUrl = process.env.BASE44_AMAZON_AUTH_URL;
    const authSecret = process.env.AMAZON_AUTH_SECRET;
    let stored = false;
    let storeError = null;
    if (authUrl && authSecret && result.refresh_token) {
      try {
        const storeRes = await fetch(authUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-auth-secret": authSecret },
          body: JSON.stringify({ action: "store-token", refresh_token: result.refresh_token }),
        });
        const storeData = await storeRes.json();
        stored = storeData.success;
        if (!storeData.success) storeError = storeData.error;
      } catch (storeErr) {
        storeError = storeErr.message;
      }
    } else {
      storeError = "BASE44_AMAZON_AUTH_URL or AMAZON_AUTH_SECRET not set in proxy env";
    }

    const appUrl = process.env.BASE44_APP_URL || "https://theoutfitvault.store";
    const params = new URLSearchParams({ amazon_connected: stored ? "1" : "0" });
    if (storeError) params.set("error", storeError);
    res.redirect(302, `${appUrl}/marketplace?${params.toString()}`);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/amazon/status", async (req, res) => {
  try {
    const data = await checkConnection();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/amazon/listing", async (req, res) => {
  try {
    const product = req.body?.product;
    if (!product) return res.status(400).json({ success: false, error: "product required" });
    const data = await publishListing(product);
    res.status(data.success ? 200 : 502).json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.put("/amazon/inventory", async (req, res) => {
  try {
    const { sku, quantity } = req.body || {};
    if (!sku) return res.status(400).json({ success: false, error: "sku required" });
    const data = await syncInventory(sku, quantity);
    res.status(data.success ? 200 : 502).json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/amazon/inventory", async (req, res) => {
  try {
    const { sku, quantity } = req.body || {};
    if (!sku) return res.status(400).json({ success: false, error: "sku required" });
    const data = await syncInventory(sku, quantity);
    res.status(data.success ? 200 : 502).json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.put("/amazon/price", async (req, res) => {
  try {
    const { sku, price } = req.body || {};
    if (!sku) return res.status(400).json({ success: false, error: "sku required" });
    const data = await syncPrice(sku, price);
    res.status(data.success ? 200 : 502).json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/amazon/price", async (req, res) => {
  try {
    const { sku, price } = req.body || {};
    if (!sku) return res.status(400).json({ success: false, error: "sku required" });
    const data = await syncPrice(sku, price);
    res.status(data.success ? 200 : 502).json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/amazon/listing/:sku", async (req, res) => {
  try {
    const data = await getListingStatus(req.params.sku);
    res.status(data.success ? 200 : 502).json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/amazon/orders", async (req, res) => {
  try {
    const data = await getOrders(req.query.createdAfter);
    res.status(data.success ? 200 : 502).json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/amazon/order-items/:orderId", async (req, res) => {
  try {
    const data = await getOrderItems(req.params.orderId);
    res.status(data.success ? 200 : 502).json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/amazon/tracking", async (req, res) => {
  try {
    const { orderId, trackingNumber, carrier } = req.body || {};
    if (!orderId || !trackingNumber) return res.status(400).json({ success: false, error: "orderId and trackingNumber required" });
    const data = await updateAmazonTracking(orderId, trackingNumber, carrier);
    res.status(data.success ? 200 : 502).json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Outfit Vault proxy running on port ${PORT}`);
});
