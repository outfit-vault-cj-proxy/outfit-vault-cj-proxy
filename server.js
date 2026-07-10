import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const CJ_ACCESS_TOKEN = process.env.CJ_ACCESS_TOKEN;
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_ACCESS_TOKEN =
  process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

// Shopify releases API versions quarterly.
// This can be overridden later with a Railway variable.
const SHOPIFY_API_VERSION =
  process.env.SHOPIFY_API_VERSION || "2026-07";

function cleanShopifyDomain(domain = "") {
  return domain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

function requiredVariablesMissing() {
  const missing = [];

  if (!SHOPIFY_STORE_DOMAIN) {
    missing.push("SHOPIFY_STORE_DOMAIN");
  }

  if (!SHOPIFY_ADMIN_ACCESS_TOKEN) {
    missing.push("SHOPIFY_ADMIN_ACCESS_TOKEN");
  }

  return missing;
}

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "The Outfit Vault CJ proxy is running"
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    status: "healthy",
    shopifyConfigured:
      Boolean(SHOPIFY_STORE_DOMAIN) &&
      Boolean(SHOPIFY_ADMIN_ACCESS_TOKEN),
    cjConfigured: Boolean(CJ_ACCESS_TOKEN)
  });
});

/*
 * Retrieve products already in The Outfit Vault Shopify store.
 *
 * Example:
 * /shopify/products
 * /shopify/products?limit=20
 * /shopify/products?query=jeans
 */
app.get("/shopify/products", async (req, res) => {
  try {
    const missing = requiredVariablesMissing();

    if (missing.length > 0) {
      return res.status(500).json({
        success: false,
        error: "Missing Railway environment variables",
        missing
      });
    }

    const storeDomain = cleanShopifyDomain(
      SHOPIFY_STORE_DOMAIN
    );

    const requestedLimit = Number(req.query.limit || 50);
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

            media(first: 20) {
              nodes {
                ... on MediaImage {
                  id
                  image {
                    url
                    altText
                    width
                    height
                  }
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

    const shopifyResponse = await fetch(
      `https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token":
            SHOPIFY_ADMIN_ACCESS_TOKEN
        },
        body: JSON.stringify({
          query: graphqlQuery,
          variables: {
            first: limit,
            query: searchQuery || null
          }
        })
      }
    );

    const rawText = await shopifyResponse.text();

    let shopifyData;

    try {
      shopifyData = JSON.parse(rawText);
    } catch {
      return res.status(502).json({
        success: false,
        error:
          "Shopify returned a response that was not JSON",
        httpStatus: shopifyResponse.status,
        responsePreview: rawText.slice(0, 500)
      });
    }

    if (!shopifyResponse.ok) {
      return res.status(shopifyResponse.status).json({
        success: false,
        error: "Shopify API request failed",
        shopifyResponse: shopifyData
      });
    }

    if (shopifyData.errors) {
      return res.status(400).json({
        success: false,
        error: "Shopify GraphQL returned errors",
        details: shopifyData.errors
      });
    }

    const products =
      shopifyData?.data?.products?.nodes || [];

    return res.status(200).json({
      success: true,
      count: products.length,
      products,
      pageInfo:
        shopifyData?.data?.products?.pageInfo || null
    });
  } catch (error) {
    console.error("SHOPIFY_PRODUCTS_ERROR", error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/*
 * Search CJ products.
 *
 * Example:
 * /cj/products?keyword=jeans
 */
app.get("/cj/products", async (req, res) => {
  try {
    if (!CJ_ACCESS_TOKEN) {
      return res.status(500).json({
        success: false,
        error:
          "CJ_ACCESS_TOKEN is missing from Railway"
      });
    }

    const keyword =
      typeof req.query.keyword === "string" &&
      req.query.keyword.trim()
        ? req.query.keyword.trim()
        : "clothing";

    const requestedSize = Number(req.query.size || 20);
    const size = Math.min(
      Math.max(requestedSize, 1),
      50
    );

    const page = Math.max(
      Number(req.query.page || 1),
      1
    );

    const cjUrl =
      "https://developers.cjdropshipping.com" +
      "/api2.0/v1/product/listV2" +
      `?page=${page}` +
      `&size=${size}` +
      `&keyword=${encodeURIComponent(keyword)}`;

    const cjResponse = await fetch(cjUrl, {
      headers: {
        "CJ-Access-Token": CJ_ACCESS_TOKEN,
        Accept: "application/json"
      }
    });

    const rawText = await cjResponse.text();

    let cjData;

    try {
      cjData = JSON.parse(rawText);
    } catch {
      return res.status(502).json({
        success: false,
        error:
          "CJ returned a response that was not JSON",
        httpStatus: cjResponse.status,
        responsePreview: rawText.slice(0, 500)
      });
    }

    return res.status(cjResponse.status).json(cjData);
  } catch (error) {
    console.error("CJ_PRODUCTS_ERROR", error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found",
    method: req.method,
    path: req.path,
    availableRoutes: [
      "GET /",
      "GET /health",
      "GET /shopify/products",
      "GET /cj/products?keyword=jeans"
    ]
  });
});

const PORT = Number(process.env.PORT) || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `THE_OUTFIT_VAULT_PROXY_STARTED_ON_PORT_${PORT}`
  );
});
