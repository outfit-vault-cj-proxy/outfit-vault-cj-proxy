/* eslint-env node */
/* global process, fetch */

import express from "express";
import cors from "cors";
import { chooseBestAmazonMatch } from "./amazonMatcher.js";
import createAmazonIntelligenceRouter from "./amazonIntelligenceRoutes.js";
import createAmazonEngineRouter from "./amazonEngineRoutes.js";
import { createAmazonMatchRouter } from "./amazon-match-routes.js";
import * as shopifyVariantsModule from "./shopifyVariants.js";

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
  updateAmazonTracking,
searchCatalogByIdentifier,
searchCatalogItems,
getListingRestrictions,
  previewOfferListing,
  createOfferListing
} from "./amazon.js";

const getShopifyVariants =
  shopifyVariantsModule.getShopifyVariants ||
  shopifyVariantsModule.default;

if (typeof getShopifyVariants !== "function") {
  throw new Error(
    "shopifyVariants.js must export getShopifyVariants as a named or default export."
  );
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const SERVER_VERSION = "amazon-engine-v5-duplicate-protection";

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: false }));

/* =========================================================
   AMAZON ENGINE ROUTER
========================================================= */

app.use(
  "/amazon-engine",
  createAmazonEngineRouter({
    getShopifyVariants
  })
);

app.use(
  "/amazon-intelligence",
  createAmazonIntelligenceRouter({
    getShopifyVariants
  })
  );
app.use(
  createAmazonMatchRouter({
    searchCatalogItems,
loadShopifyProducts: async ({
  limit = 100,
  cursor = null,
  onlyErrored = false
}) => {
  const response = await getShopifyVariants();

  if (!response?.success || !Array.isArray(response?.variants)) {
    throw new Error(
      "Unable to load Shopify variants for Amazon matching"
    );
  }

  const productsById = new Map();

  for (const variant of response.variants) {
    const productId = String(
      variant?.shopify_product_id || ""
    ).trim();

    if (!productId) continue;

    if (!productsById.has(productId)) {
      productsById.set(productId, {
        id: productId,
        title: variant?.productTitle || "",
        vendor: variant?.vendor || "",
        productType: variant?.productType || "",
        featuredImage: variant?.image || null,
        productStatus: variant?.productStatus || null,
        variants: []
      });
    }

    const product = productsById.get(productId);

    product.variants.push({
      id: variant?.shopify_variant_id || null,
      sku: variant?.sku || null,
      barcode: variant?.barcode || null,
      price: Number(variant?.price || 0),
      compareAtPrice:
        variant?.compareAtPrice == null
          ? null
          : Number(variant.compareAtPrice),
      inventoryQuantity:
        Number(variant?.inventoryQuantity || 0),
      selectedOptions:
        Array.isArray(variant?.selectedOptions)
          ? variant.selectedOptions
          : [],
      image: variant?.image || product.featuredImage,
      weight: variant?.weight || null,
      weightUnit: variant?.weightUnit || null
    });
  }

  let products = Array.from(productsById.values());

  // getShopifyVariants already retrieves all Shopify pages.
  // Batch limiting is applied after variants are grouped by product.
  const safeLimit = Math.max(
    1,
    Math.min(Number(limit) || 100, 500)
  );

  products = products.slice(0, safeLimit);

  if (onlyErrored) {
    console.warn(
      "onlyErrored was requested, but no live match-history store is connected yet; scanning the selected Shopify products."
    );
  }

  return {
    items: products,
    nextCursor: null,
    sourceCursor: cursor
  };
},
    saveMatchReview: async () => {},
    getExistingMatchReview: async () => null,
    updateBatchRun: async () => {},
    logger: console,
    authenticateAdmin: (req, res, next) => {
      const expected = process.env.AMAZON_AUTH_SECRET;
      const provided = req.headers["x-admin-key"];

      if (!expected) {
        return res.status(500).json({
          success: false,
          error: "AMAZON_AUTH_SECRET is not configured"
        });
      }

      if (provided !== expected) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized"
        });
      }

      next();
    },
    marketplaceId:
      process.env.AMAZON_MARKETPLACE_ID || "ATVPDKIKX0DER"
  })
);  
/* =========================================================
   CONFIGURATION
========================================================= */

const CJ_API_KEY = process.env.CJ_API_KEY;
const CJ_BASE =
  "https://developers.cjdropshipping.com/api2.0/v1";

const SHOPIFY_API_VERSION =
  process.env.SHOPIFY_API_VERSION || "2026-07";

const SHOPIFY_STORE_DOMAIN = String(
  process.env.SHOPIFY_STORE_DOMAIN || ""
)
  .trim()
  .replace(/^https?:\/\//i, "")
  .replace(/\/+$/, "");

const SHOPIFY_CLIENT_ID =
  process.env.SHOPIFY_CLIENT_ID;

const SHOPIFY_CLIENT_SECRET =
  process.env.SHOPIFY_CLIENT_SECRET;

/* =========================================================
   GENERAL HELPERS
========================================================= */

function jsonError(res, status, error, extra = {}) {
  return res.status(status).json({
    success: false,
    error:
      error instanceof Error
        ? error.message
        : String(error),
    ...extra
  });
}

function responseStatus(data) {
  if (data?.success) return 200;
  if (Number.isInteger(data?.status)) return data.status;
  return 502;
}

async function readJsonResponse(response, serviceName) {
  const responseText = await response.text();

  if (!responseText) return null;

  try {
    return JSON.parse(responseText);
  } catch {
    throw new Error(
      `${serviceName} returned invalid JSON (${response.status}): ${responseText}`
    );
  }
}

/* =========================================================
   CJ DROPSHIPPING
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
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        apiKey: CJ_API_KEY
      })
    }
  );

  const data = await readJsonResponse(
    response,
    "CJ authentication"
  );

  if (
    !response.ok ||
    !data?.data?.accessToken
  ) {
    throw new Error(
      `CJ authentication failed (${response.status}): ${JSON.stringify(data)}`
    );
  }

  cachedCJToken = data.data.accessToken;
  cjTokenExpiresAt =
    Date.now() +
    14 * 24 * 60 * 60 * 1000;

  return cachedCJToken;
}

async function cjRequest(
  method,
  path,
  body = null,
  overrideToken = null
) {
  const token =
    overrideToken ||
    (await getCJToken());

  const options = {
    method,
    headers: {
      "CJ-Access-Token": token,
      Accept: "application/json",
      "Content-Type": "application/json"
    }
  };

  if (body !== null) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(
    `${CJ_BASE}${path}`,
    options
  );

  const data = await readJsonResponse(
    response,
    "CJ API"
  );

  if (!response.ok) {
    throw new Error(
      `CJ request failed (${response.status}): ${JSON.stringify(data)}`
    );
  }

  return data;
}

function cjGet(path, overrideToken) {
  return cjRequest(
    "GET",
    path,
    null,
    overrideToken
  );
}

function cjPost(path, body, overrideToken) {
  return cjRequest(
    "POST",
    path,
    body,
    overrideToken
  );
}

/* =========================================================
   SHOPIFY AUTHENTICATION
========================================================= */

let cachedShopifyToken = null;
let shopifyTokenExpiresAt = 0;

function validateShopifyConfig() {
  const missing = [];

  if (!SHOPIFY_STORE_DOMAIN) {
    missing.push("SHOPIFY_STORE_DOMAIN");
  }

  if (!SHOPIFY_CLIENT_ID) {
    missing.push("SHOPIFY_CLIENT_ID");
  }

  if (!SHOPIFY_CLIENT_SECRET) {
    missing.push("SHOPIFY_CLIENT_SECRET");
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing Shopify variables: ${missing.join(", ")}`
    );
  }
}

async function getShopifyAccessToken(
  forceRefresh = false
) {
  validateShopifyConfig();

  if (
    !forceRefresh &&
    cachedShopifyToken &&
    Date.now() <
      shopifyTokenExpiresAt - 60_000
  ) {
    return cachedShopifyToken;
  }

  const response = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET
      }).toString()
    }
  );

  const data = await readJsonResponse(
    response,
    "Shopify authentication"
  );

  if (
    !response.ok ||
    !data?.access_token
  ) {
    throw new Error(
      `Shopify authentication failed (${response.status}): ${JSON.stringify(data)}`
    );
  }

  cachedShopifyToken = data.access_token;

  const expiresInSeconds =
    Number(data.expires_in) || 86_399;

  shopifyTokenExpiresAt =
    Date.now() +
    expiresInSeconds * 1000;

  return cachedShopifyToken;
}

async function shopifyGraphQL(
  query,
  variables = {},
  allowRetry = true
) {
  const accessToken =
    await getShopifyAccessToken();

  const response = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token":
          accessToken,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        query,
        variables
      })
    }
  );

  if (
    (
      response.status === 401 ||
      response.status === 403
    ) &&
    allowRetry
  ) {
    cachedShopifyToken = null;
    shopifyTokenExpiresAt = 0;

    await getShopifyAccessToken(true);

    return shopifyGraphQL(
      query,
      variables,
      false
    );
  }

  const data = await readJsonResponse(
    response,
    "Shopify API"
  );

  if (!response.ok) {
    throw new Error(
      `Shopify API request failed (${response.status}): ${JSON.stringify(data)}`
    );
  }

  if (data?.errors) {
    throw new Error(
      `Shopify GraphQL error: ${JSON.stringify(data.errors)}`
    );
  }

  return data?.data;
}

/* =========================================================
   SHOPIFY PUBLICATION
========================================================= */

let onlineStorePublicationId = null;

async function getOnlineStorePublicationId() {
  if (onlineStorePublicationId) {
    return onlineStorePublicationId;
  }

  const data = await shopifyGraphQL(`
    query {
      publications(first: 20) {
        edges {
          node {
            id
            name
          }
        }
      }
    }
  `);

  const publication =
    (
      data?.publications?.edges || []
    )
      .map((edge) => edge.node)
      .find(
        (node) =>
          node.name === "Online Store"
      );

  if (!publication) {
    throw new Error(
      "Online Store publication channel not found"
    );
  }

  onlineStorePublicationId =
    publication.id;

  return onlineStorePublicationId;
}

async function publishProduct(productId) {
  const publicationId =
    await getOnlineStorePublicationId();

  const data = await shopifyGraphQL(
    `
      mutation PublishProduct(
        $id: ID!,
        $publicationId: ID!
      ) {
        publishablePublish(
          id: $id,
          input: {
            publicationId: $publicationId
          }
        ) {
          publishable {
            publishedOnCurrentPublication
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      id: productId,
      publicationId
    }
  );

  const errors =
    data?.publishablePublish?.userErrors ||
    [];

  if (errors.length > 0) {
    throw new Error(
      `Shopify publication failed: ${JSON.stringify(errors)}`
    );
  }

  return data.publishablePublish;
}

/* =========================================================
   BASIC ROUTES
========================================================= */

app.get("/", (req, res) => {
  res.json({
    success: true,
    message:
      "The Outfit Vault proxy is running",
    version: SERVER_VERSION,
    amazonEngine:
      "/amazon-engine",
    publishPage:
      "/amazon/publish-page"
  });
});

app.get("/health", async (req, res) => {
  const shopifyConfigured = Boolean(
    SHOPIFY_STORE_DOMAIN &&
      SHOPIFY_CLIENT_ID &&
      SHOPIFY_CLIENT_SECRET
  );

  const amazonConfigured = Boolean(
    process.env.AMAZON_LWA_CLIENT_ID &&
      process.env
        .AMAZON_LWA_CLIENT_SECRET &&
      process.env
        .AMAZON_LWA_REFRESH_TOKEN &&
      process.env.AMAZON_SELLER_ID
  );

  let shopifyAuthenticated = false;
  let shopifyError = null;

  if (shopifyConfigured) {
    try {
      await getShopifyAccessToken();
      shopifyAuthenticated = true;
    } catch (error) {
      shopifyError =
        error instanceof Error
          ? error.message
          : String(error);
    }
  }

  res.json({
    success: true,
    version: SERVER_VERSION,
    shopifyConfigured,
    shopifyAuthenticated,
    shopifyError,
    cjConfigured: Boolean(CJ_API_KEY),
    amazonConfigured,
    amazonEnvironment:
      process.env
        .AMAZON_SPAPI_ENVIRONMENT ||
      "production",
    routes: {
      amazonEngine:
        "/amazon-engine",
      amazonCatalog:
        "/amazon/catalog/search",
      amazonPreview:
        "/amazon/offer/preview",
      amazonCreate:
        "/amazon/offer/create",
      amazonPublishPage:
        "/amazon/publish-page"
    }
  });
});

/* =========================================================
   CJ ROUTES
========================================================= */

app.get("/cj/products", async (req, res) => {
  try {
    const keyword =
      req.query.keyWord ||
      req.query.keyword ||
      "";

    const page = req.query.page || 1;
    const size = req.query.size || 20;

    const data = await cjGet(
      `/product/listV2?page=${encodeURIComponent(page)}&size=${encodeURIComponent(size)}&keyWord=${encodeURIComponent(keyword)}`,
      req.headers["x-cj-access-token"]
    );

    res.json(data);
  } catch (error) {
    jsonError(res, 500, error);
  }
});

app.get("/cj/product", async (req, res) => {
  try {
    const pid = req.query.pid;

    if (!pid) {
      return jsonError(
        res,
        400,
        "pid required"
      );
    }

    const data = await cjGet(
      `/product/query?pid=${encodeURIComponent(pid)}`,
      req.headers["x-cj-access-token"]
    );

    res.json(data);
  } catch (error) {
    jsonError(res, 500, error);
  }
});

app.post(
  "/cj/create-order",
  async (req, res) => {
    try {
      const data = await cjPost(
        "/shopping/order/createOrderV2",
        req.body,
        req.headers["x-cj-access-token"]
      );

      res.json(data);
    } catch (error) {
      jsonError(res, 500, error);
    }
  }
);

/* =========================================================
   SHOPIFY PRODUCTS
========================================================= */

app.get(
  "/shopify/products",
  async (req, res) => {
    try {
      const products = [];
      let cursor = null;
      let hasNextPage = true;

      while (hasNextPage) {
        const data = await shopifyGraphQL(
          `
            query Products(
              $first: Int!,
              $after: String
            ) {
              products(
                first: $first,
                after: $after,
                query: "status:active"
              ) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                edges {
                  node {
                    id
                    title
                    descriptionHtml
                    vendor
                    productType
                    status
                    featuredImage {
                      url
                    }
                    variants(first: 100) {
                      nodes {
                        id
                        sku
                        barcode
                        price
                        compareAtPrice
                        inventoryQuantity
                        selectedOptions {
                          name
                          value
                        }
                        image {
                          url
                        }
                      }
                    }
                  }
                }
              }
            }
          `,
          {
            first: 250,
            after: cursor
          }
        );

        const connection = data.products;

        for (
          const edge of connection.edges
        ) {
          products.push(edge.node);
        }

        hasNextPage =
          connection.pageInfo.hasNextPage;

        cursor =
          connection.pageInfo.endCursor;
      }

      res.json({
        success: true,
        count: products.length,
        products
      });
    } catch (error) {
      jsonError(res, 500, error);
    }
  }
);

app.get(
  "/shopify/products/variants",
  async (req, res) => {
    try {
      const data =
        await getShopifyVariants({
          productId:
            req.query.productId || null
        });

      const variants =
        Array.isArray(data)
          ? data
          : data?.variants || [];

      const meta =
        data?.meta || {
          shopify_api_version:
            SHOPIFY_API_VERSION,
          product_count: null,
          variant_count:
            variants.length,
          generated_at:
            new Date().toISOString()
        };

      res.set(
        "X-Shopify-Variant-Count",
        String(variants.length)
      );

      res.set(
        "X-Shopify-API-Version",
        SHOPIFY_API_VERSION
      );

      if (
        meta.product_count !== null &&
        meta.product_count !== undefined
      ) {
        res.set(
          "X-Shopify-Product-Count",
          String(meta.product_count)
        );
      }

      res.json({
        success: true,
        meta,
        variants
      });
    } catch (error) {
      jsonError(res, 500, error);
    }
  }
);
/* =========================================
   SHOPIFY SINGLE PRODUCT
========================================= */

app.get(
  "/shopify/product",
  async (req, res) => {
    try {
      const productId = String(
        req.query.productId || ""
      ).trim();

      const handle = String(
        req.query.handle || ""
      ).trim();

      if (!productId && !handle) {
        return jsonError(
          res,
          400,
          "productId or handle is required"
        );
      }

      let data;

      if (productId) {
        const normalizedProductId =
          productId.startsWith("gid://")
            ? productId
            : `gid://shopify/Product/${productId}`;

        data = await shopifyGraphQL(
          `
            query ProductForAmazon($id: ID!) {
              product(id: $id) {
                id
                legacyResourceId
                title
                handle
                descriptionHtml
                vendor
                productType
                status
                featuredImage {
                  url
                  altText
                }
                images(first: 20) {
                  nodes {
                    url
                    altText
                  }
                }
                options {
                  id
                  name
                  values
                }
                variants(first: 100) {
                  nodes {
                    id
                    legacyResourceId
                    title
                    sku
                    barcode
                    price
                    inventoryQuantity
                    selectedOptions {
                      name
                      value
                    }
                    image {
                      url
                      altText
                    }
                  }
                }
              }
            }
          `,
          {
            id: normalizedProductId
          }
        );
      } else {
        data = await shopifyGraphQL(
          `
            query ProductForAmazonByHandle(
              $handle: String!
            ) {
              productByHandle(handle: $handle) {
                id
                legacyResourceId
                title
                handle
                descriptionHtml
                vendor
                productType
                status
                featuredImage {
                  url
                  altText
                }
                images(first: 20) {
                  nodes {
                    url
                    altText
                  }
                }
                options {
                  id
                  name
                  values
                }
                variants(first: 100) {
                  nodes {
                    id
                    legacyResourceId
                    title
                    sku
                    barcode
                    price
                    inventoryQuantity
                    selectedOptions {
                      name
                      value
                    }
                    image {
                      url
                      altText
                    }
                  }
                }
              }
            }
          `,
          {
            handle
          }
        );
      }

      const product =
        data?.product ||
        data?.productByHandle ||
        null;

      if (!product) {
        return jsonError(
          res,
          404,
          "Shopify product not found"
        );
      }

      res.json({
        success: true,
        product
      });
    } catch (error) {
      jsonError(res, 500, error);
    }
  }
);
/* =========================================================
   SHOPIFY IMPORT
========================================================= */

app.post(
  "/shopify/import",
  async (req, res) => {
    try {
      const selectedProducts =
        req.body?.selectedProducts;

      if (
        !Array.isArray(selectedProducts) ||
        selectedProducts.length === 0
      ) {
        return jsonError(
          res,
          400,
          "selectedProducts array required"
        );
      }

      const imported = [];

      for (
        const selected of selectedProducts
      ) {
        const cjProductId =
          selected.pid ||
          selected.productId ||
          selected.cjProductId ||
          selected.cj_product_id;

        if (!cjProductId) {
          imported.push({
            success: false,
            error:
              "Missing CJ product ID",
            selected
          });

          continue;
        }

        try {
          const detail = await cjGet(
            `/product/query?pid=${encodeURIComponent(cjProductId)}`,
            req.headers[
              "x-cj-access-token"
            ]
          );

          const product =
            detail?.data || {};

          const images = [
            product.productImage,
            ...(product.productImages || [])
          ].filter(Boolean);

          const result =
            await shopifyGraphQL(
              `
                mutation ProductCreate(
                  $product: ProductCreateInput!,
                  $media: [CreateMediaInput!]
                ) {
                  productCreate(
                    product: $product,
                    media: $media
                  ) {
                    product {
                      id
                      title
                      handle
                    }
                    userErrors {
                      field
                      message
                    }
                  }
                }
              `,
              {
                product: {
                  title:
                    product
                      .productNameEn ||
                    product.productName ||
                    selected.name ||
                    "Imported CJ Product",

                  descriptionHtml:
                    product.description ||
                    product
                      .productDescription ||
                    selected.description ||
                    "",

                  vendor:
                    "CJ Dropshipping",

                  productType:
                    product.categoryName ||
                    product
                      .threeCategoryName ||
                    "Dropshipping",

                  tags: [
                    "CJ Dropshipping",
                    "The Outfit Vault",
                    `CJ_PID_${cjProductId}`
                  ],

                  status: "ACTIVE"
                },

                media: images
                  .slice(0, 10)
                  .map((image) => ({
                    mediaContentType:
                      "IMAGE",
                    originalSource: image,
                    alt:
                      product
                        .productNameEn ||
                      product.productName ||
                      "Product image"
                  }))
              }
            );

          const errors =
            result?.productCreate
              ?.userErrors || [];

          if (errors.length > 0) {
            imported.push({
              cjProductId,
              success: false,
              errors
            });

            continue;
          }

          const created =
            result.productCreate.product;

          let published = false;
          let publishError = null;

          try {
            await publishProduct(
              created.id
            );

            published = true;
          } catch (error) {
            publishError =
              error instanceof Error
                ? error.message
                : String(error);
          }

          imported.push({
            cjProductId,
            success: true,
            published,
            publishError,
            shopifyProduct: created
          });
        } catch (error) {
          imported.push({
            cjProductId,
            success: false,
            error:
              error instanceof Error
                ? error.message
                : String(error)
          });
        }
      }

      res.json({
        success: true,
        imported
      });
    } catch (error) {
      jsonError(res, 500, error);
    }
  }
);

/* =========================================================
   AMAZON CONNECTION
========================================================= */

app.get("/amazon/test", async (req, res) => {
  try {
    const data = await testConnection();

    res
      .status(responseStatus(data))
      .json(data);
  } catch (error) {
    jsonError(res, 500, error);
  }
});

app.get(
  "/amazon/status",
  async (req, res) => {
    try {
      const data =
        await checkConnection();

      res
        .status(responseStatus(data))
        .json(data);
    } catch (error) {
      jsonError(res, 500, error);
    }
  }
);
function isValidGtinCheckDigit(value) {
  const digits = String(value)
    .replace(/[\s-]/g, "")
    .split("")
    .map(Number);

  if (
    digits.length < 2 ||
    digits.some((digit) => Number.isNaN(digit))
  ) {
    return false;
  }

  const suppliedCheckDigit = digits.pop();

  const sum = digits
    .reverse()
    .reduce((total, digit, index) => {
      return total + digit * (index % 2 === 0 ? 3 : 1);
    }, 0);

  const calculatedCheckDigit = (10 - (sum % 10)) % 10;

  return suppliedCheckDigit === calculatedCheckDigit;
}
async function resolveVerifiedAmazonMatch(product, suppliedMatchResolution = null) {
  const asin = String(
    product?.asin ||
    product?.amazon_asin ||
    ""
  )
    .trim()
    .toUpperCase();

  if (!asin) {
    return suppliedMatchResolution;
  }

  if (
    suppliedMatchResolution?.decision === "AUTO_MATCH" &&
    String(
      suppliedMatchResolution?.bestMatch?.asin ||
      ""
    )
      .trim()
      .toUpperCase() === asin
  ) {
    return suppliedMatchResolution;
  }

  const catalogData =
    await searchCatalogByIdentifier(
      asin,
      "ASIN"
    );

  if (
    !catalogData?.success ||
    !Array.isArray(catalogData?.matches)
  ) {
    return {
      decision: "NO_SAFE_MATCH",
      bestMatch: null,
      alternatives: [],
      reason: "ASIN_LOOKUP_FAILED",
      catalogData
    };
  }

  return chooseBestAmazonMatch(
    {
      identifier: asin,
      identifierType: "ASIN",
      title: product?.title || "",
      brand:
        product?.brand ||
        product?.vendor ||
        "",
      productType:
        product?.productType ||
        product?.product_type ||
        "",
      color: product?.color || "",
      size: product?.size || "",
      modelNumber:
        product?.modelNumber ||
        product?.model_number ||
        ""
    },
    catalogData.matches
  );
}

/* =========================================================
   AMAZON CATALOG AND OFFERS
========================================================= */

app.get(
  "/amazon/catalog/search",
  async (req, res) => {
    try {
      const queryIdentifierType = String(
        req.query.identifierType ||
        req.query.identifiersType ||
        req.query.type ||
        ""
      )
        .trim()
        .toUpperCase();

      const identifierEntries = [
        ["ASIN", req.query.asin],
        ["UPC", req.query.upc],
        ["EAN", req.query.ean],
        ["JAN", req.query.jan],
        ["ISBN", req.query.isbn],
        ["GTIN", req.query.gtin],
        ["GTIN", req.query.gtin14],
        ["SKU", req.query.sku],
        [queryIdentifierType, req.query.identifier]
      ];

      const selectedEntry = identifierEntries.find(
        ([type, value]) =>
          type &&
          value !== undefined &&
          value !== null &&
          String(value).trim() !== ""
      );

      if (!selectedEntry) {
        return jsonError(
          res,
          400,
          "A product identifier is required. Provide asin, upc, ean, jan, isbn, gtin, gtin14, sku, or identifier."
        );
      }

      let [identifierType, rawIdentifier] = selectedEntry;

      identifierType = String(identifierType)
        .trim()
        .toUpperCase();

      let identifier = String(rawIdentifier).trim();

      const allowedIdentifierTypes = new Set([
        "ASIN",
        "UPC",
        "EAN",
        "JAN",
        "ISBN",
        "GTIN",
        "SKU"
      ]);

      if (!allowedIdentifierTypes.has(identifierType)) {
        return jsonError(
          res,
          400,
          `Unsupported identifier type: ${identifierType}`
        );
      }

      // Normalize barcode-based identifiers.
      if (
        ["UPC", "EAN", "JAN", "ISBN", "GTIN"].includes(
          identifierType
        )
      ) {
        identifier = identifier.replace(/[\s-]/g, "");
      }

      // Normalize ASIN without changing seller SKUs.
      if (identifierType === "ASIN") {
        identifier = identifier
          .replace(/\s/g, "")
          .toUpperCase();
      }

      if (!identifier) {
        return jsonError(
          res,
          400,
          "The product identifier cannot be empty."
        );
      }

      // Validate ASIN.
      if (
        identifierType === "ASIN" &&
        !/^[A-Z0-9]{10}$/.test(identifier)
      ) {
        return jsonError(
          res,
          400,
          "Invalid ASIN. An ASIN must contain exactly 10 letters or numbers."
        );
      }

      // Validate expected numeric lengths.
      const validLengths = {
        UPC: [12],
        EAN: [13],
        JAN: [13],
        ISBN: [10, 13],
        GTIN: [8, 12, 13, 14]
      };

      if (validLengths[identifierType]) {
        if (!/^\d+$/.test(identifier)) {
          return jsonError(
            res,
            400,
            `${identifierType} must contain numbers only.`
          );
        }

        if (
          !validLengths[identifierType].includes(
            identifier.length
          )
        ) {
          return jsonError(
            res,
            400,
            `Invalid ${identifierType} length. Expected ${validLengths[
              identifierType
            ].join(" or ")} digits.`
          );
        }
      }

      // JAN is part of the EAN-13 system and normally begins with 45 or 49.
      if (
        identifierType === "JAN" &&
        !/^(45|49)/.test(identifier)
      ) {
        return jsonError(
          res,
          400,
          "Invalid JAN. A JAN is normally a 13-digit identifier beginning with 45 or 49."
        );
      }

      // Validate GS1 check digit for numeric identifiers except ISBN-10.
      const shouldValidateCheckDigit =
        ["UPC", "EAN", "JAN", "GTIN"].includes(
          identifierType
        ) ||
        (identifierType === "ISBN" &&
          identifier.length === 13);

      if (
        shouldValidateCheckDigit &&
        !isValidGtinCheckDigit(identifier)
      ) {
        return jsonError(
          res,
          400,
          `Invalid ${identifierType} check digit.`
        );
      }

      const amazonIdentifierType =
  identifierType === "JAN"
    ? "EAN"
    : identifierType === "GTIN"
      ? (
          identifier.length === 12
            ? "UPC"
            : identifier.length === 13
              ? "EAN"
              : identifier.length === 10
                ? "ISBN"
                : null
        )
      : identifierType;

if (!amazonIdentifierType) {
  return jsonError(
    res,
    400,
    `${identifierType}-${identifier.length} is valid as a barcode format, but this Amazon catalog route cannot search that format directly.`
  );
}

const data = await searchCatalogByIdentifier(
  identifier,
  amazonIdentifierType
);
      const sourceProduct = {
  identifier,
  identifierType,
  title: req.query.title || "",
  brand: req.query.brand || "",
  productType: req.query.productType || "",
  color: req.query.color || "",
  size: req.query.size || "",
  modelNumber: req.query.modelNumber || ""
};

const matchResolution = chooseBestAmazonMatch(
  sourceProduct,
  Array.isArray(data?.matches) ? data.matches : []
);
return res
  .status(responseStatus(data))
        .json({
          ...data,
          matchResolution,
          searchMetadata: {
  identifier,
  submittedIdentifierType: identifierType,
  amazonIdentifierType,
  searchedAt: new Date().toISOString()
}
        });
      
    } catch (error) {
      jsonError(res, 500, error);
    }
  }
);
app.get(
  "/amazon/catalog/items",
  async (req, res) => {
    try {
      const adminKey = req.headers["x-admin-key"];

      if (
        process.env.AMAZON_AUTH_SECRET &&
        adminKey !== process.env.AMAZON_AUTH_SECRET
      ) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized"
        });
      }

      const data = await searchCatalogItems({
        identifiers: req.query.identifiers,
        identifiersType: req.query.identifiersType,
        keywords: req.query.keywords,
        brandNames: req.query.brandNames
      });

      res
        .status(responseStatus(data))
        .json(data);
    } catch (error) {
      jsonError(res, 500, error);
    }
  }
);
app.get(
  "/amazon/offer/restrictions",
  async (req, res) => {
    try {
      const asin = req.query.asin;

      if (!asin) {
        return jsonError(
          res,
          400,
          "asin required"
        );
      }

      const data =
        await getListingRestrictions(
          asin,
          req.query.condition ||
            "new_new"
        );

      res
        .status(responseStatus(data))
        .json(data);
    } catch (error) {
      jsonError(res, 500, error);
    }
  }
);

app.get(
  "/amazon/offer/preview",
  async (req, res) => {
    try {
      const product = {
        asin:
          req.query.asin ||
          "B077SH7LZH",
        sku:
          req.query.sku ||
          "AI7AR",
        price:
          req.query.price ||
          "86.95",
        quantity:
          req.query.quantity ||
          "1",
        condition_type:
          req.query.condition ||
          "new_new"
      };

      const data =
        await previewOfferListing(
          product
        );

      res
        .status(responseStatus(data))
        .json({
          ...data,
          testProduct: product
        });
    } catch (error) {
      jsonError(res, 500, error);
    }
  }
);

app.post(
  "/amazon/offer/preview",
  async (req, res) => {
    try {
      const product =
        req.body?.product ||
        req.body;

      if (!product?.asin) {
        return jsonError(
          res,
          400,
          "Product with asin is required"
        );
      }

      const data =
        await previewOfferListing(
          product
        );

      res
        .status(responseStatus(data))
        .json(data);
    } catch (error) {
      jsonError(res, 500, error);
    }
  }
);
app.post("/amazon/eligibility/check", async (req, res) => {
  const product = req.body?.product || req.body || {};

  const asin = product.asin || product.amazon_asin;
  const conditionType =
    product.condition_type ||
    product.conditionType ||
    "new_new";

  if (!asin) {
    return res.status(400).json({
      success: false,
      stage: "INVALID",
      eligible: false,
      error: "Product ASIN is required",
      endpoint: "/amazon/eligibility/check",
      receivedBody: req.body || null
    });
  }

  try {
    const data = await getListingRestrictions(
      asin,
      conditionType
    );

    return res
      .status(
        data?.success
          ? 200
          : Number.isInteger(data?.status)
            ? data.status
            : 502
      )
      .json({
        ...data,
        stage: data?.success
          ? data?.eligible
            ? "ELIGIBLE"
            : "RESTRICTED"
          : "RESTRICTIONS_CHECK",
        endpoint: "/amazon/eligibility/check"
      });
  } catch (error) {
    return res.status(500).json({
      success: false,
      stage: "RESTRICTIONS_CHECK",
      eligible: false,
      error:
        error instanceof Error
          ? error.message
          : String(error),
      endpoint: "/amazon/eligibility/check"
    });
  }
});
app.post(
  "/amazon/offer/create",
  async (req, res) => {
    const product =
      req.body?.product ||
      req.body;

    try {
      if (!product?.asin) {
        return res.status(400).json({
          success: false,
          stage: "INVALID",
          error: "Product with asin is required",
          endpoint: "/amazon/offer/create",
          receivedBody: req.body || null
        });
      }

      if (
        !product.sku &&
        !product.amazon_sku &&
        !product.shopify_variant_id
      ) {
        return res.status(400).json({
          success: false,
          stage: "INVALID",
          error:
            "Product SKU or Shopify variant ID is required",
          endpoint: "/amazon/offer/create",
          receivedProduct: product
        });
      }

      if (
        product.price === undefined ||
        product.price === null ||
        product.price === ""
      ) {
        return res.status(400).json({
          success: false,
          stage: "INVALID",
          error: "Product price is required",
          endpoint: "/amazon/offer/create",
          receivedProduct: product
        });
      }

      /*
       * Duplicate protection:
       * Amazon seller SKUs are the source of truth. Before any new offer
       * submission, look up the exact seller SKU in the Listings Items API.
       *
       * - Existing SKU: block the new submission.
       * - Confirmed 404: SKU does not exist, so publishing may continue.
       * - Any other lookup failure: fail closed so an outage or permission
       *   error cannot accidentally create a duplicate.
       */
      const sellerSku = String(
        product.amazon_sku ||
        product.sku ||
        product.shopify_variant_id ||
        ""
      ).trim();

      const existingListing =
        await getListingStatus(sellerSku);

      if (existingListing?.success) {
        const existingSummaries =
          existingListing?.data?.summaries;

        const existingAsin =
          Array.isArray(existingSummaries) &&
          existingSummaries.length > 0
            ? existingSummaries[0]?.asin || null
            : existingListing?.data?.asin || null;

        return res.status(409).json({
          success: false,
          action: "BLOCKED_DUPLICATE",
          duplicatePrevented: true,
          stage: "DUPLICATE_SKU",
          error:
            "This seller SKU already exists in your Amazon inventory. No new offer was submitted.",
          endpoint: "/amazon/offer/create",
          sku: sellerSku,
          submittedAsin:
            String(product.asin || "")
              .trim()
              .toUpperCase() || null,
          existingAsin,
          existingListing
        });
      }

      const duplicateLookupStatus =
        Number(existingListing?.httpStatus);

      if (
        duplicateLookupStatus !== 404
      ) {
        return res.status(502).json({
          success: false,
          action: "DUPLICATE_CHECK_FAILED",
          duplicatePrevented: true,
          stage: "DUPLICATE_CHECK_ERROR",
          error:
            "Amazon could not confirm whether this seller SKU already exists. Publishing was stopped to prevent a possible duplicate.",
          endpoint: "/amazon/offer/create",
          sku: sellerSku,
          lookupStatus:
            Number.isFinite(duplicateLookupStatus)
              ? duplicateLookupStatus
              : null,
          lookupResult: existingListing
        });
      }

      const matchResolution =
        await resolveVerifiedAmazonMatch(
          product,
          req.body?.matchResolution ||
            product?.matchResolution ||
            null
        );

      if (
        !matchResolution ||
        matchResolution.decision !== "AUTO_MATCH" ||
        !matchResolution.bestMatch?.asin
      ) {
        return res.status(409).json({
          success: false,
          stage: "MATCH_SAFETY_BLOCK",
          error:
            "Amazon offer creation blocked because the ASIN could not be verified as a safe catalog match.",
          endpoint: "/amazon/offer/create",
          matchResolution,
          receivedProduct: product
        });
      }

      const submittedAsin = String(product.asin)
        .trim()
        .toUpperCase();

      const approvedAsin = String(
        matchResolution.bestMatch.asin
      )
        .trim()
        .toUpperCase();

      if (submittedAsin !== approvedAsin) {
        return res.status(409).json({
          success: false,
          stage: "ASIN_MISMATCH",
          error:
            "The requested ASIN does not match the approved Amazon candidate.",
          endpoint: "/amazon/offer/create",
          submittedAsin,
          approvedAsin,
          matchResolution
        });
      }

      product.asin = approvedAsin;

      const data =
        await createOfferListing(
          product
        );

      return res
        .status(
          data?.success
            ? 200
            : Number.isInteger(data?.status)
              ? data.status
              : 422
        )
        .json({
          ...data,
          endpoint:
            "/amazon/offer/create",
          matchResolution,
          receivedProduct: product
        });
    } catch (error) {
      return res.status(500).json({
        success: false,
        stage: "SERVER_ERROR",
        endpoint:
          "/amazon/offer/create",
        error:
          error instanceof Error
            ? error.message
            : String(error),
        stack:
          error instanceof Error
            ? error.stack
            : null,
        receivedProduct: product,
        environment: {
          marketplaceConfigured:
            Boolean(
              process.env
                .AMAZON_MARKETPLACE_ID
            ),
          sellerConfigured:
            Boolean(
              process.env
                .AMAZON_SELLER_ID
            ),
          lwaClientConfigured:
            Boolean(
              process.env
                .AMAZON_LWA_CLIENT_ID
            ),
          lwaSecretConfigured:
            Boolean(
              process.env
                .AMAZON_LWA_CLIENT_SECRET
            ),
          refreshTokenConfigured:
            Boolean(
              process.env
                .AMAZON_LWA_REFRESH_TOKEN
            )
        }
      });
    }
  }
);

/* =========================================================
   ONE-TAP AMAZON PUBLISH PAGE
========================================================= */

app.get(
  "/amazon/publish-page",
  (req, res) => {
    res.set(
      "Cache-Control",
      "no-store"
    );

    res.type("html");

    res.send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >
  <title>Publish to Amazon</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 20px;
      background: #101017;
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .card {
      max-width: 520px;
      margin: 25px auto;
      padding: 24px;
      background: #1d1d29;
      border: 1px solid #38384a;
      border-radius: 18px;
    }
    .warning {
      padding: 13px;
      margin-bottom: 18px;
      background: #342814;
      border: 1px solid #735923;
      border-radius: 11px;
      color: #ffe5a0;
    }
    label {
      display: block;
      margin-top: 16px;
      margin-bottom: 7px;
      font-weight: 700;
    }
    input, button {
      width: 100%;
      min-height: 50px;
      padding: 12px;
      border-radius: 11px;
      font-size: 17px;
    }
    input {
      color: #fff;
      background: #0f0f17;
      border: 1px solid #4c4c61;
    }
    button {
      margin-top: 22px;
      background: #d5a62a;
      color: #171208;
      border: 0;
      font-weight: 800;
    }
    button:disabled { opacity: .6; }
    pre {
      margin-top: 20px;
      padding: 14px;
      min-height: 80px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      background: #09090e;
      border-radius: 10px;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>Publish to Amazon</h1>

    <div class="warning">
      This submits a real Amazon offer.
      Review every field before publishing.
    </div>

    <label for="asin">Amazon ASIN</label>
    <input id="asin" maxlength="10">

    <label for="sku">Seller SKU</label>
    <input id="sku">

    <label for="price">Price</label>
    <input
      id="price"
      type="number"
      min="0.01"
      step="0.01"
    >

    <label for="quantity">Quantity</label>
    <input
      id="quantity"
      value="1"
      type="number"
      min="0"
      step="1"
    >

    <button
      id="publishButton"
      type="button"
    >
      Publish to Amazon
    </button>

    <pre id="result">Ready.</pre>
  </main>

  <script>
    const publishButton =
      document.getElementById(
        "publishButton"
      );

    const resultBox =
      document.getElementById(
        "result"
      );

    publishButton.addEventListener(
      "click",
      async () => {
        const asin =
          document
            .getElementById("asin")
            .value
            .trim()
            .toUpperCase();

        const sku =
          document
            .getElementById("sku")
            .value
            .trim();

        const price =
          Number(
            document
              .getElementById("price")
              .value
          );

        const quantity =
          Number(
            document
              .getElementById("quantity")
              .value
          );

        if (
          !asin ||
          !sku ||
          !Number.isFinite(price) ||
          price <= 0 ||
          !Number.isInteger(quantity) ||
          quantity < 0
        ) {
          resultBox.textContent =
            "Enter a valid ASIN, SKU, price and quantity.";
          return;
        }

        if (
          !window.confirm(
            "Submit a real Amazon offer for " +
            asin +
            " at $" +
            price.toFixed(2) +
            "?"
          )
        ) {
          return;
        }

        publishButton.disabled = true;
        publishButton.textContent =
          "Publishing...";

        try {
          const response = await fetch(
            "/amazon/offer/create",
            {
              method: "POST",
              headers: {
                "Content-Type":
                  "application/json"
              },
              body: JSON.stringify({
                asin,
                sku,
                price,
                quantity,
                condition_type:
                  "new_new"
              })
            }
          );

          const data =
            await response.json();

          resultBox.textContent =
            JSON.stringify(
              data,
              null,
              2
            );

          publishButton.textContent =
            data.success
              ? "Submitted"
              : "Try Again";
        } catch (error) {
          resultBox.textContent =
            "Error: " +
            error.message;

          publishButton.textContent =
            "Try Again";
        } finally {
          publishButton.disabled =
            false;
        }
      }
    );
  </script>
</body>
</html>
    `);
  }
);

/* =========================================================
   AMAZON OAUTH
========================================================= */

function amazonAuthorizationCode(query) {
  return (
    query.spapi_oauth_code ||
    query.code ||
    null
  );
}

async function storeAmazonRefreshToken(
  refreshToken
) {
  const authUrl =
    process.env.BASE44_AMAZON_AUTH_URL;

  const authSecret =
    process.env.AMAZON_AUTH_SECRET;

  if (!authUrl || !authSecret) {
    return {
      stored: false,
      error:
        "BASE44_AMAZON_AUTH_URL or AMAZON_AUTH_SECRET is missing"
    };
  }

  const response = await fetch(
    authUrl,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json",
        "x-auth-secret":
          authSecret
      },
      body: JSON.stringify({
        action: "store-token",
        refresh_token: refreshToken
      })
    }
  );

  const data = await readJsonResponse(
    response,
    "Amazon token storage"
  );

  if (
    !response.ok ||
    !data?.success
  ) {
    return {
      stored: false,
      error:
        data?.error ||
        `Token storage failed (${response.status})`
    };
  }

  return {
    stored: true,
    error: null
  };
}

async function handleAmazonOAuthCallback(
  req,
  res,
  callbackPath
) {
  try {
    const code =
      amazonAuthorizationCode(
        req.query
      );

    if (!code) {
      return jsonError(
        res,
        400,
        "Missing Amazon authorization code"
      );
    }

    const redirectUri =
      process.env
        .AMAZON_OAUTH_REDIRECT_URI ||
      `${req.protocol}://${req.get("host")}${callbackPath}`;

    const result =
      await exchangeAuthCode(
        code,
        redirectUri
      );

    if (!result.refresh_token) {
      return jsonError(
        res,
        500,
        "Amazon did not return a refresh token"
      );
    }

    const storage =
      await storeAmazonRefreshToken(
        result.refresh_token
      );

    const appUrl =
      process.env.BASE44_APP_URL ||
      "https://theoutfitvault.store";

    const params =
      new URLSearchParams({
        amazon_connected:
          storage.stored
            ? "1"
            : "0"
      });

    if (storage.error) {
      params.set(
        "error",
        storage.error
      );
    }

    res.redirect(
      302,
      `${appUrl}/marketplace?${params.toString()}`
    );
  } catch (error) {
    jsonError(res, 500, error);
  }
}

function beginAmazonOAuth(
  req,
  res,
  callbackPath
) {
  try {
    const state =
      req.query.state ||
      Math.random()
        .toString(36)
        .slice(2);

    const redirectUri =
      process.env
        .AMAZON_OAUTH_REDIRECT_URI ||
      `${req.protocol}://${req.get("host")}${callbackPath}`;

    const url = getAuthUrl(
      state,
      redirectUri
    );

    res.redirect(url);
  } catch (error) {
    jsonError(res, 500, error);
  }
}

app.get(
  "/amazon/auth",
  (req, res) =>
    beginAmazonOAuth(
      req,
      res,
      "/amazon/callback"
    )
);

app.get(
  "/amazon/callback",
  (req, res) =>
    handleAmazonOAuthCallback(
      req,
      res,
      "/amazon/callback"
    )
);

app.get(
  "/amazon/oauth/start",
  (req, res) =>
    beginAmazonOAuth(
      req,
      res,
      "/amazon/oauth/callback"
    )
);

app.get(
  "/amazon/oauth/callback",
  (req, res) =>
    handleAmazonOAuthCallback(
      req,
      res,
      "/amazon/oauth/callback"
    )
);

/* =========================================================
   AMAZON STANDARD LISTINGS
========================================================= */

app.post(
  "/amazon/listing",
  async (req, res) => {
    try {
      const product =
        req.body?.product;

      if (!product) {
        return jsonError(
          res,
          400,
          "product required"
        );
      }

      let matchResolution =
        req.body?.matchResolution ||
        product?.matchResolution ||
        null;

      // Existing-ASIN listings must be verified before publishing.
      // New catalog listings without an ASIN continue through the
      // normal GTIN or GTIN-exemption workflow in publishListing().
      if (product?.asin) {
        matchResolution =
          await resolveVerifiedAmazonMatch(
            product,
            matchResolution
          );

        if (
          !matchResolution ||
          matchResolution.decision !== "AUTO_MATCH" ||
          !matchResolution.bestMatch?.asin
        ) {
          return res.status(409).json({
            success: false,
            stage: "MATCH_SAFETY_BLOCK",
            error:
              "Existing-ASIN publishing requires a verified AUTO_MATCH decision.",
            matchResolution
          });
        }

        const submittedAsin = String(product.asin)
          .trim()
          .toUpperCase();

        const approvedAsin = String(
          matchResolution.bestMatch.asin
        )
          .trim()
          .toUpperCase();

        if (submittedAsin !== approvedAsin) {
          return res.status(409).json({
            success: false,
            stage: "ASIN_MISMATCH",
            error:
              "The submitted ASIN does not match the approved Amazon candidate.",
            submittedAsin,
            approvedAsin,
            matchResolution
          });
        }

        product.asin = approvedAsin;
      }

      const data =
        await publishListing(product);

      res
        .status(responseStatus(data))
        .json({
          ...data,
          ...(matchResolution
            ? { matchResolution }
            : {})
        });
    } catch (error) {
      jsonError(res, 500, error);
    }
  }
);

app.get(
  "/amazon/listing/:sku",
  async (req, res) => {
    try {
      const data =
        await getListingStatus(
          req.params.sku
        );

      res
        .status(responseStatus(data))
        .json(data);
    } catch (error) {
      jsonError(res, 500, error);
    }
  }
);

async function handleInventory(req, res) {
  try {
    const {
      sku,
      quantity
    } = req.body || {};

    if (!sku) {
      return jsonError(
        res,
        400,
        "sku required"
      );
    }

    const data =
      await syncInventory(
        sku,
        quantity
      );

    res
      .status(responseStatus(data))
      .json(data);
  } catch (error) {
    jsonError(res, 500, error);
  }
}

app.put(
  "/amazon/inventory",
  handleInventory
);

app.post(
  "/amazon/inventory",
  handleInventory
);

async function handlePrice(req, res) {
  try {
    const {
      sku,
      price
    } = req.body || {};

    if (!sku) {
      return jsonError(
        res,
        400,
        "sku required"
      );
    }

    if (
      price === undefined ||
      price === null ||
      price === ""
    ) {
      return jsonError(
        res,
        400,
        "price required"
      );
    }

    const data =
      await syncPrice(
        sku,
        price
      );

    res
      .status(responseStatus(data))
      .json(data);
  } catch (error) {
    jsonError(res, 500, error);
  }
}

app.put(
  "/amazon/price",
  handlePrice
);

app.post(
  "/amazon/price",
  handlePrice
);

/* =========================================================
   AMAZON ORDERS
========================================================= */

app.get(
  "/amazon/orders",
  async (req, res) => {
    try {
      const data =
        await getOrders(
          req.query.createdAfter
        );

      res
        .status(responseStatus(data))
        .json(data);
    } catch (error) {
      jsonError(res, 500, error);
    }
  }
);

app.get(
  "/amazon/order-items/:orderId",
  async (req, res) => {
    try {
      const data =
        await getOrderItems(
          req.params.orderId
        );

      res
        .status(responseStatus(data))
        .json(data);
    } catch (error) {
      jsonError(res, 500, error);
    }
  }
);

app.post(
  "/amazon/tracking",
  async (req, res) => {
    try {
      const {
        orderId,
        trackingNumber,
        carrier
      } = req.body || {};

      if (
        !orderId ||
        !trackingNumber
      ) {
        return jsonError(
          res,
          400,
          "orderId and trackingNumber required"
        );
      }

      const data =
        await updateAmazonTracking(
          orderId,
          trackingNumber,
          carrier
        );

      res
        .status(responseStatus(data))
        .json(data);
    } catch (error) {
      jsonError(res, 500, error);
    }
  }
);

/* =========================================================
   ROUTE CHECK
========================================================= */

app.get("/debug/routes", (req, res) => {
  const routes = [];

  for (
    const layer of
    app._router?.stack || []
  ) {
    if (layer.route) {
      routes.push({
        path: layer.route.path,
        methods: Object.keys(
          layer.route.methods || {}
        )
          .filter(
            (method) =>
              layer.route
                .methods[method]
          )
          .map((method) =>
            method.toUpperCase()
          )
      });

      continue;
    }

    if (
      layer.name === "router" &&
      layer.regexp
    ) {
      routes.push({
        path:
          "Mounted router: /amazon-engine",
        methods: ["ROUTER"]
      });
    }
  }

  res.json({
    success: true,
    version: SERVER_VERSION,
    routeCount: routes.length,
    routes
  });
});

/* =========================================================
   JSON 404
========================================================= */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found",
    method: req.method,
    path: req.path,
    version: SERVER_VERSION,
    available: {
      health: "/health",
      amazonEngine:
        "/amazon-engine",
      publishPage:
        "/amazon/publish-page",
      catalogSearch:
  "/amazon/catalog/search?upc=889359349981",
catalogItems:
  "/amazon/catalog/items?keywords=dress",
offerPreview:
  "/amazon/offer/preview?asin=B077SH7LZH&sku=...",
    }
  });
});

/* =========================================================
   SERVER STARTUP
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Outfit Vault proxy running on port ${PORT}`
    );

    console.log(
      `Server version: ${SERVER_VERSION}`
    );

    console.log(
      "Amazon engine: GET /amazon-engine"
    );

    console.log(
      "Find and publish one: POST /amazon-engine/find-and-publish-one"
    );
  }
);
