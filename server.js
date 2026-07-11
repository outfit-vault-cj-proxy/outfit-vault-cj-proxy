import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

/* =========================================================
   ENVIRONMENT VARIABLES
========================================================= */

const CJ_ACCESS_TOKEN =
  process.env.CJ_ACCESS_TOKEN;

const SHOPIFY_STORE_DOMAIN =
  process.env.SHOPIFY_STORE_DOMAIN;

const SHOPIFY_CLIENT_ID =
  process.env.SHOPIFY_CLIENT_ID;

const SHOPIFY_CLIENT_SECRET =
  process.env.SHOPIFY_CLIENT_SECRET;

const SHOPIFY_API_VERSION =
  process.env.SHOPIFY_API_VERSION || "2026-07";

/*
  Amazon sandbox variables currently stored in Railway.
  We are only checking configuration at this stage.
  We are not publishing products or accessing orders yet.
*/

const AMAZON_ENV =
  process.env.AMAZON_ENV || "sandbox";

const AMAZON_LWA_CLIENT_ID =
  process.env.AMAZON_LWA_CLIENT_ID;

const AMAZON_LWA_CLIENT_SECRET =
  process.env.AMAZON_LWA_CLIENT_SECRET;

/* =========================================================
   SHOPIFY TOKEN CACHE
========================================================= */

let cachedShopifyToken = null;
let cachedShopifyTokenExpiresAt = 0;

/* =========================================================
   HELPER FUNCTIONS
========================================================= */

function cleanShopifyDomain(domain = "") {
  return domain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

function getMissingShopifyVariables() {
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

  return missing;
}

function getMissingAmazonVariables() {
  const missing = [];

  if (!AMAZON_ENV) {
    missing.push("AMAZON_ENV");
  }

  if (!AMAZON_LWA_CLIENT_ID) {
    missing.push("AMAZON_LWA_CLIENT_ID");
  }

  if (!AMAZON_LWA_CLIENT_SECRET) {
    missing.push("AMAZON_LWA_CLIENT_SECRET");
  }

  return missing;
}

/* =========================================================
   SHOPIFY AUTHENTICATION
========================================================= */

async function getShopifyAccessToken() {
  if (
    cachedShopifyToken &&
    Date.now() < cachedShopifyTokenExpiresAt
  ) {
    return cachedShopifyToken;
  }

  const missing = getMissingShopifyVariables();

  if (missing.length > 0) {
    throw new Error(
      `Missing Railway variables: ${missing.join(", ")}`
    );
  }

  const storeDomain = cleanShopifyDomain(
    SHOPIFY_STORE_DOMAIN
  );

  const tokenResponse = await fetch(
    `https://${storeDomain}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        grant_type: "client_credentials"
      })
    }
  );

  const rawText = await tokenResponse.text();

  let tokenData;

  try {
    tokenData = JSON.parse(rawText);
  } catch {
    throw new Error(
      `Shopify token response was not JSON: ${rawText.slice(
        0,
        300
      )}`
    );
  }

  if (
    !tokenResponse.ok ||
    !tokenData.access_token
  ) {
    throw new Error(
      `Shopify token request failed: ${JSON.stringify(
        tokenData
      )}`
    );
  }

  cachedShopifyToken =
    tokenData.access_token;

  const expiresIn = Number(
    tokenData.expires_in || 86400
  );

  cachedShopifyTokenExpiresAt =
    Date.now() +
    Math.max(expiresIn - 300, 60) * 1000;

  return cachedShopifyToken;
}

/* =========================================================
   ROOT ROUTE
========================================================= */

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message:
      "The Outfit Vault marketplace proxy is running",

    integrations: {
      cj: Boolean(CJ_ACCESS_TOKEN),

      shopify:
        getMissingShopifyVariables().length === 0,

      amazon:
        getMissingAmazonVariables().length === 0
    }
  });
});

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    status: "healthy",

    shopifyConfigured:
      getMissingShopifyVariables().length === 0,

    cjConfigured:
      Boolean(CJ_ACCESS_TOKEN),

    amazonConfigured:
      getMissingAmazonVariables().length === 0,

    amazonEnvironment:
      AMAZON_ENV
  });
});

/* =========================================================
   AMAZON CONFIGURATION STATUS
========================================================= */

app.get("/amazon/status", (req, res) => {
  const missing =
    getMissingAmazonVariables();

  if (missing.length > 0) {
    return res.status(500).json({
      success: false,
      connected: false,
      environment: AMAZON_ENV,
      error: "Amazon configuration is incomplete",
      missingVariables: missing
    });
  }

  return res.status(200).json({
    success: true,
    configured: true,
    connected: false,
    environment: AMAZON_ENV,
    message:
      "Amazon sandbox credentials are stored. Live SP-API authentication has not been activated yet."
  });
});

/* =========================================================
   SHOPIFY PRODUCTS
========================================================= */

app.get(
  "/shopify/products",
  async (req, res) => {
    try {
      const storeDomain =
        cleanShopifyDomain(
          SHOPIFY_STORE_DOMAIN
        );

      const accessToken =
        await getShopifyAccessToken();

      const requestedLimit = Number(
        req.query.limit || 50
      );

      const limit = Math.min(
        Math.max(requestedLimit, 1),
        100
      );

      const searchQuery =
        typeof req.query.query === "string"
          ? req.query.query.trim()
          : "";

      const graphqlQuery = `
        query OutfitVaultProducts(
          $first: Int!
          $query: String
        ) {
          products(
            first: $first
            query: $query
            sortKey: UPDATED_AT
            reverse: true
          ) {
            nodes {
              id
              title
              handle
              description
              descriptionHtml
              productType
              vendor
              status
              tags
              createdAt
              updatedAt
              onlineStoreUrl

              featuredMedia {
                preview {
                  image {
                    url
                    altText
                    width
                    height
                  }
                }
              }

              variants(first: 100) {
                nodes {
                  id
                  title
                  sku
                  barcode
                  price
                  compareAtPrice
                  availableForSale
                  inventoryQuantity

                  selectedOptions {
                    name
                    value
                  }

                  image {
                    url
                    altText
                    width
                    height
                  }
                }
              }
            }

            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `;

      const shopifyResponse =
        await fetch(
          `https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/json",

              "X-Shopify-Access-Token":
                accessToken
            },

            body: JSON.stringify({
              query: graphqlQuery,

              variables: {
                first: limit,
                query:
                  searchQuery || null
              }
            })
          }
        );

      const rawText =
        await shopifyResponse.text();

      let shopifyData;

      try {
        shopifyData =
          JSON.parse(rawText);
      } catch {
        return res.status(502).json({
          success: false,

          error:
            "Shopify returned a response that was not JSON",

          httpStatus:
            shopifyResponse.status,

          responsePreview:
            rawText.slice(0, 500)
        });
      }

      if (!shopifyResponse.ok) {
        return res
          .status(shopifyResponse.status)
          .json({
            success: false,

            error:
              "Shopify API request failed",

            shopifyResponse:
              shopifyData
          });
      }

      if (shopifyData.errors) {
        return res.status(400).json({
          success: false,

          error:
            "Shopify GraphQL returned errors",

          details:
            shopifyData.errors
        });
      }

      const products =
        shopifyData?.data?.products
          ?.nodes || [];

      return res.status(200).json({
        success: true,
        count: products.length,
        products,

        pageInfo:
          shopifyData?.data?.products
            ?.pageInfo || null
      });
    } catch (error) {
      console.error(
        "SHOPIFY_PRODUCTS_ERROR",
        error
      );

      return res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* =========================================================
   CJ PRODUCTS
========================================================= */

app.get(
  "/cj/products",
  async (req, res) => {
    try {
      if (!CJ_ACCESS_TOKEN) {
        return res.status(500).json({
          success: false,

          error:
            "CJ_ACCESS_TOKEN is missing from Railway"
        });
      }

      const keyword =
        typeof req.query.keyword ===
          "string" &&
        req.query.keyword.trim()
          ? req.query.keyword.trim()
          : "clothing";

      const cjUrl =
        "https://developers.cjdropshipping.com" +
        "/api2.0/v1/product/listV2" +
        "?page=1" +
        "&size=20" +
        `&keyword=${encodeURIComponent(
          keyword
        )}`;

      const cjResponse =
        await fetch(cjUrl, {
          headers: {
            "CJ-Access-Token":
              CJ_ACCESS_TOKEN,

            Accept:
              "application/json"
          }
        });

      const rawText =
        await cjResponse.text();

      let cjData;

      try {
        cjData =
          JSON.parse(rawText);
      } catch {
        return res.status(502).json({
          success: false,

          error:
            "CJ returned a response that was not JSON",

          responsePreview:
            rawText.slice(0, 500)
        });
      }

      return res
        .status(cjResponse.status)
        .json(cjData);
    } catch (error) {
      console.error(
        "CJ_PRODUCTS_ERROR",
        error
      );

      return res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* =========================================================
   404 ROUTE
========================================================= */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found",
    path: req.path
  });
});

/* =========================================================
   START SERVER
========================================================= */

const PORT =
  Number(process.env.PORT) || 8080;

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `THE_OUTFIT_VAULT_MARKETPLACE_PROXY_STARTED_ON_PORT_${PORT}`
    );
  }
);
