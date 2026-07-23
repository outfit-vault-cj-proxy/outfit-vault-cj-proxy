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
  updateAmazonTracking,
  searchCatalogByIdentifier,
  getListingRestrictions,
  previewOfferListing,
  createOfferListing
} from "./amazon.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: false }));

/* =========================================================
   CONFIGURATION
========================================================= */

const CJ_API_KEY =
  process.env.CJ_API_KEY;

const CJ_BASE =
  "https://developers.cjdropshipping.com/api2.0/v1";

const SHOPIFY_API_VERSION =
  process.env.SHOPIFY_API_VERSION ||
  "2026-07";

const SHOPIFY_STORE_DOMAIN =
  String(
    process.env.SHOPIFY_STORE_DOMAIN ||
    ""
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

function jsonError(
  res,
  status,
  error,
  extra = {}
) {
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
  if (data?.success) {
    return 200;
  }

  if (
    Number.isInteger(
      data?.status
    )
  ) {
    return data.status;
  }

  return 502;
}

async function readJsonResponse(
  response,
  serviceName
) {
  const responseText =
    await response.text();

  if (!responseText) {
    return null;
  }

  try {
    return JSON.parse(
      responseText
    );
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
    Date.now() <
      cjTokenExpiresAt
  ) {
    return cachedCJToken;
  }

  if (!CJ_API_KEY) {
    throw new Error(
      "Missing CJ_API_KEY"
    );
  }

  const response = await fetch(
    `${CJ_BASE}/authentication/getAccessToken`,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json",
        Accept:
          "application/json"
      },
      body: JSON.stringify({
        apiKey: CJ_API_KEY
      })
    }
  );

  const data =
    await readJsonResponse(
      response,
      "CJ authentication"
    );

  if (
    !response.ok ||
    !data?.data?.accessToken
  ) {
    throw new Error(
      `CJ authentication failed (${response.status}): ${JSON.stringify(
        data
      )}`
    );
  }

  cachedCJToken =
    data.data.accessToken;

  cjTokenExpiresAt =
    Date.now() +
    14 *
      24 *
      60 *
      60 *
      1000;

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
      "CJ-Access-Token":
        token,
      Accept:
        "application/json",
      "Content-Type":
        "application/json"
    }
  };

  if (body !== null) {
    options.body =
      JSON.stringify(body);
  }

  const response = await fetch(
    `${CJ_BASE}${path}`,
    options
  );

  const data =
    await readJsonResponse(
      response,
      "CJ API"
    );

  if (!response.ok) {
    throw new Error(
      `CJ request failed (${response.status}): ${JSON.stringify(
        data
      )}`
    );
  }

  return data;
}

function cjGet(
  path,
  overrideToken
) {
  return cjRequest(
    "GET",
    path,
    null,
    overrideToken
  );
}

function cjPost(
  path,
  body,
  overrideToken
) {
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
    missing.push(
      "SHOPIFY_STORE_DOMAIN"
    );
  }

  if (!SHOPIFY_CLIENT_ID) {
    missing.push(
      "SHOPIFY_CLIENT_ID"
    );
  }

  if (!SHOPIFY_CLIENT_SECRET) {
    missing.push(
      "SHOPIFY_CLIENT_SECRET"
    );
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing Shopify variables: ${missing.join(
        ", "
      )}`
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
      shopifyTokenExpiresAt -
        60_000
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
        Accept:
          "application/json"
      },
      body:
        new URLSearchParams({
          grant_type:
            "client_credentials",
          client_id:
            SHOPIFY_CLIENT_ID,
          client_secret:
            SHOPIFY_CLIENT_SECRET
        }).toString()
    }
  );

  const data =
    await readJsonResponse(
      response,
      "Shopify authentication"
    );

  if (
    !response.ok ||
    !data?.access_token
  ) {
    throw new Error(
      `Shopify authentication failed (${response.status}): ${JSON.stringify(
        data
      )}`
    );
  }

  cachedShopifyToken =
    data.access_token;

  const expiresInSeconds =
    Number(data.expires_in) ||
    86_399;

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
        "Content-Type":
          "application/json",
        Accept:
          "application/json"
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

    await getShopifyAccessToken(
      true
    );

    return shopifyGraphQL(
      query,
      variables,
      false
    );
  }

  const data =
    await readJsonResponse(
      response,
      "Shopify API"
    );

  if (!response.ok) {
    throw new Error(
      `Shopify API request failed (${response.status}): ${JSON.stringify(
        data
      )}`
    );
  }

  if (data?.errors) {
    throw new Error(
      `Shopify GraphQL error: ${JSON.stringify(
        data.errors
      )}`
    );
  }

  return data?.data;
}

/* =========================================================
   SHOPIFY PUBLICATION
========================================================= */

let onlineStorePublicationId = null;

async function getOnlineStorePublicationId() {
  if (
    onlineStorePublicationId
  ) {
    return onlineStorePublicationId;
  }

  const query = `
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
  `;

  const data =
    await shopifyGraphQL(
      query
    );

  const publication =
    (
      data?.publications
        ?.edges || []
    )
      .map(
        (edge) =>
          edge.node
      )
      .find(
        (node) =>
          node.name ===
          "Online Store"
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

async function publishProduct(
  productId
) {
  const publicationId =
    await getOnlineStorePublicationId();

  const mutation = `
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
  `;

  const data =
    await shopifyGraphQL(
      mutation,
      {
        id: productId,
        publicationId
      }
    );

  const errors =
    data?.publishablePublish
      ?.userErrors || [];

  if (
    errors.length > 0
  ) {
    throw new Error(
      `Shopify publication failed: ${JSON.stringify(
        errors
      )}`
    );
  }

  return data.publishablePublish;
}

/* =========================================================
   BASIC ROUTES
========================================================= */

app.get(
  "/",
  (req, res) => {
    res.json({
      success: true,
      message:
        "The Outfit Vault proxy is running",
      version:
        "amazon-publish-page-v4",
      publishPage:
        "/amazon/publish-page"
    });
  }
);

app.get(
  "/health",
  async (req, res) => {
    const shopifyConfigured =
      Boolean(
        SHOPIFY_STORE_DOMAIN &&
          SHOPIFY_CLIENT_ID &&
          SHOPIFY_CLIENT_SECRET
      );

    const amazonConfigured =
      Boolean(
        process.env
          .AMAZON_LWA_CLIENT_ID &&
          process.env
            .AMAZON_LWA_CLIENT_SECRET &&
          process.env
            .AMAZON_LWA_REFRESH_TOKEN &&
          process.env
            .AMAZON_SELLER_ID
      );

    let shopifyAuthenticated =
      false;

    let shopifyError = null;

    if (
      shopifyConfigured
    ) {
      try {
        await getShopifyAccessToken();

        shopifyAuthenticated =
          true;
      } catch (error) {
        shopifyError =
          error.message;
      }
    }

    res.json({
      success: true,
      version:
        "amazon-publish-page-v4",
      shopifyConfigured,
      shopifyAuthenticated,
      shopifyError,
      cjConfigured:
        Boolean(
          CJ_API_KEY
        ),
      amazonConfigured,
      amazonEnvironment:
        process.env
          .AMAZON_SPAPI_ENVIRONMENT ||
        "production",
      amazonCatalogRoute:
        "/amazon/catalog/search",
      amazonPreviewRoute:
        "/amazon/offer/preview",
      amazonCreateRoute:
        "/amazon/offer/create",
      amazonPublishPage:
        "/amazon/publish-page"
    });
  }
);

/* =========================================================
   CJ ROUTES
========================================================= */

app.get(
  "/cj/products",
  async (req, res) => {
    try {
      const keyword =
        req.query.keyWord ||
        req.query.keyword ||
        "";

      const page =
        req.query.page ||
        1;

      const size =
        req.query.size ||
        20;

      const data =
        await cjGet(
          `/product/listV2?page=${encodeURIComponent(
            page
          )}&size=${encodeURIComponent(
            size
          )}&keyWord=${encodeURIComponent(
            keyword
          )}`,
          req.headers[
            "x-cj-access-token"
          ]
        );

      res.json(data);
    } catch (error) {
      jsonError(
        res,
        500,
        error
      );
    }
  }
);

app.get(
  "/cj/product",
  async (req, res) => {
    try {
      const pid =
        req.query.pid;

      if (!pid) {
        return jsonError(
          res,
          400,
          "pid required"
        );
      }

      const data =
        await cjGet(
          `/product/query?pid=${encodeURIComponent(
            pid
          )}`,
          req.headers[
            "x-cj-access-token"
          ]
        );

      res.json(data);
    } catch (error) {
      jsonError(
        res,
        500,
        error
      );
    }
  }
);

app.post(
  "/cj/create-order",
  async (req, res) => {
    try {
      const data =
        await cjPost(
          "/shopping/order/createOrderV2",
          req.body,
          req.headers[
            "x-cj-access-token"
          ]
        );

      res.json(data);
    } catch (error) {
      jsonError(
        res,
        500,
        error
      );
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
      let hasNextPage =
        true;

      while (
        hasNextPage
      ) {
        const query = `
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
        `;

        const data =
          await shopifyGraphQL(
            query,
            {
              first: 250,
              after:
                cursor
            }
          );

        const connection =
          data.products;

        for (
          const edge of
          connection.edges
        ) {
          products.push(
            edge.node
          );
        }

        hasNextPage =
          connection.pageInfo
            .hasNextPage;

        cursor =
          connection.pageInfo
            .endCursor;
      }

      res.json({
        success: true,
        count:
          products.length,
        products
      });
    } catch (error) {
      jsonError(
        res,
        500,
        error
      );
    }
  }
);

app.get(
  "/shopify/products/variants",
  async (req, res) => {
    try {
      const requestedProductId =
        req.query.productId ||
        null;

      const variants = [];
      let productCount = 0;

      function addProductVariants(
        product
      ) {
        productCount++;

        const productImage =
          product.featuredImage
            ?.url || null;

        for (
          const edge of
          product.variants
            ?.edges || []
        ) {
          const variant =
            edge.node;

          const weight =
            variant.inventoryItem
              ?.measurement
              ?.weight;

          variants.push({
            shopify_product_id:
              product.id,

            shopify_variant_id:
              variant.id,

            sku:
              variant.sku ||
              null,

            barcode:
              variant.barcode ||
              null,

            price:
              Number(
                variant.price
              ) || 0,

            inventoryQuantity:
              variant.inventoryQuantity ??
              0,

            weight:
              weight?.value ||
              null,

            weightUnit:
              weight?.unit ||
              null,

            selectedOptions:
              variant.selectedOptions ||
              [],

            image:
              variant.image?.url ||
              productImage,

            productTitle:
              product.title,

            vendor:
              product.vendor,

            productType:
              product.productType
          });
        }
      }

      if (
        requestedProductId
      ) {
        const query = `
          query Product(
            $id: ID!
          ) {
            product(id: $id) {
              id
              title
              vendor
              productType
              featuredImage {
                url
              }
              variants(first: 250) {
                edges {
                  node {
                    id
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
                    }
                    inventoryItem {
                      measurement {
                        weight {
                          value
                          unit
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        `;

        const data =
          await shopifyGraphQL(
            query,
            {
              id:
                requestedProductId
            }
          );

        if (
          data.product
        ) {
          addProductVariants(
            data.product
          );
        }
      } else {
        let cursor = null;
        let hasNextPage =
          true;

        while (
          hasNextPage
        ) {
          const query = `
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
                    vendor
                    productType
                    featuredImage {
                      url
                    }
                    variants(first: 250) {
                      edges {
                        node {
                          id
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
                          }
                          inventoryItem {
                            measurement {
                              weight {
                                value
                                unit
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          `;

          const data =
            await shopifyGraphQL(
              query,
              {
                first: 250,
                after:
                  cursor
              }
            );

          const connection =
            data.products;

          for (
            const edge of
            connection.edges
          ) {
            addProductVariants(
              edge.node
            );
          }

          hasNextPage =
            connection.pageInfo
              .hasNextPage;

          cursor =
            connection.pageInfo
              .endCursor;
        }
      }

      const seenIds =
        new Set();

      const duplicates = [];

      for (
        const variant of
        variants
      ) {
        if (
          seenIds.has(
            variant.shopify_variant_id
          )
        ) {
          duplicates.push(
            variant.shopify_variant_id
          );
        }

        seenIds.add(
          variant.shopify_variant_id
        );
      }

      if (
        duplicates.length > 0
      ) {
        return jsonError(
          res,
          500,
          "Duplicate Shopify variants detected",
          {
            duplicates
          }
        );
      }

      res.set(
        "X-Shopify-Product-Count",
        String(
          productCount
        )
      );

      res.set(
        "X-Shopify-Variant-Count",
        String(
          variants.length
        )
      );

      res.set(
        "X-Shopify-API-Version",
        SHOPIFY_API_VERSION
      );

      res.json({
        success: true,
        meta: {
          shopify_api_version:
            SHOPIFY_API_VERSION,
          product_count:
            productCount,
          variant_count:
            variants.length,
          generated_at:
            new Date()
              .toISOString()
        },
        variants
      });
    } catch (error) {
      jsonError(
        res,
        500,
        error
      );
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
        req.body
          ?.selectedProducts;

      if (
        !Array.isArray(
          selectedProducts
        ) ||
        selectedProducts.length ===
          0
      ) {
        return jsonError(
          res,
          400,
          "selectedProducts array required"
        );
      }

      const imported = [];

      for (
        const selected of
        selectedProducts
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
          const detail =
            await cjGet(
              `/product/query?pid=${encodeURIComponent(
                cjProductId
              )}`,
              req.headers[
                "x-cj-access-token"
              ]
            );

          const product =
            detail?.data ||
            {};

          const images = [
            product.productImage,
            ...(
              product.productImages ||
              []
            )
          ].filter(Boolean);

          const mutation = `
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
          `;

          const variables = {
            product: {
              title:
                product
                  .productNameEn ||
                product
                  .productName ||
                selected.name ||
                "Imported CJ Product",

              descriptionHtml:
                product
                  .description ||
                product
                  .productDescription ||
                selected.description ||
                "",

              vendor:
                "CJ Dropshipping",

              productType:
                product
                  .categoryName ||
                product
                  .threeCategoryName ||
                "Dropshipping",

              tags: [
                "CJ Dropshipping",
                "The Outfit Vault",
                `CJ_PID_${cjProductId}`
              ],

              status:
                "ACTIVE"
            },

            media:
              images
                .slice(0, 10)
                .map(
                  (image) => ({
                    mediaContentType:
                      "IMAGE",
                    originalSource:
                      image,
                    alt:
                      product
                        .productNameEn ||
                      product
                        .productName ||
                      "Product image"
                  })
                )
          };

          const result =
            await shopifyGraphQL(
              mutation,
              variables
            );

          const errors =
            result.productCreate
              ?.userErrors ||
            [];

          if (
            errors.length > 0
          ) {
            imported.push({
              cjProductId,
              success: false,
              errors
            });

            continue;
          }

          const created =
            result.productCreate
              .product;

          let published =
            false;

          let publishError =
            null;

          try {
            await publishProduct(
              created.id
            );

            published = true;
          } catch (error) {
            publishError =
              error.message;
          }

          imported.push({
            cjProductId,
            success: true,
            published,
            publishError,
            shopifyProduct:
              created
          });
        } catch (error) {
          imported.push({
            cjProductId,
            success: false,
            error:
              error.message
          });
        }
      }

      res.json({
        success: true,
        imported
      });
    } catch (error) {
      jsonError(
        res,
        500,
        error
      );
    }
  }
);

/* =========================================================
   AMAZON CONNECTION
========================================================= */

app.get(
  "/amazon/test",
  async (req, res) => {
    try {
      const data =
        await testConnection();

      res
        .status(
          responseStatus(
            data
          )
        )
        .json(data);
    } catch (error) {
      jsonError(
        res,
        500,
        error
      );
    }
  }
);

app.get(
  "/amazon/status",
  async (req, res) => {
    try {
      const data =
        await checkConnection();

      res
        .status(
          responseStatus(
            data
          )
        )
        .json(data);
    } catch (error) {
      jsonError(
        res,
        500,
        error
      );
    }
  }
);

/* =========================================================
   AMAZON CATALOG SEARCH
========================================================= */

app.get(
  "/amazon/catalog/search",
  async (req, res) => {
    try {
      const identifier =
        req.query.identifier ||
        req.query.upc ||
        req.query.ean ||
        req.query.gtin ||
        req.query.asin ||
        req.query.sku;

      let identifierType =
        req.query.identifierType ||
        req.query.type;

      if (!identifierType) {
        if (
          req.query.asin
        ) {
          identifierType =
            "ASIN";
        } else if (
          req.query.sku
        ) {
          identifierType =
            "SKU";
        } else if (
          req.query.ean
        ) {
          identifierType =
            "EAN";
        } else if (
          req.query.gtin
        ) {
          identifierType =
            "GTIN";
        } else {
          identifierType =
            "UPC";
        }
      }

      if (!identifier) {
        return jsonError(
          res,
          400,
          "identifier is required"
        );
      }

      const data =
        await searchCatalogByIdentifier(
          identifier,
          identifierType
        );

      res
        .status(
          responseStatus(
            data
          )
        )
        .json(data);
    } catch (error) {
      jsonError(
        res,
        500,
        error
      );
    }
  }
);

/* =========================================================
   AMAZON OFFER ENGINE
========================================================= */

app.get(
  "/amazon/offer/restrictions",
  async (req, res) => {
    try {
      const asin =
        req.query.asin;

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
        .status(
          responseStatus(
            data
          )
        )
        .json(data);
    } catch (error) {
      jsonError(
        res,
        500,
        error
      );
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
        .status(
          responseStatus(
            data
          )
        )
        .json({
          ...data,
          testProduct:
            product
        });
    } catch (error) {
      jsonError(
        res,
        500,
        error
      );
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

      if (
        !product ||
        !product.asin
      ) {
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
        .status(
          responseStatus(
            data
          )
        )
        .json(data);
    } catch (error) {
      jsonError(
        res,
        500,
        error
      );
    }
  }
);

app.post(
  "/amazon/offer/create",
  async (req, res) => {
    try {
      const product =
        req.body?.product ||
        req.body;

      if (
        !product ||
        !product.asin
      ) {
        return jsonError(
          res,
          400,
          "Product with asin is required"
        );
      }

      if (
        !product.sku &&
        !product.amazon_sku &&
        !product.shopify_variant_id
      ) {
        return jsonError(
          res,
          400,
          "Product SKU or Shopify variant ID is required"
        );
      }

      if (
        product.price ===
          undefined ||
        product.price ===
          null ||
        product.price ===
          ""
      ) {
        return jsonError(
          res,
          400,
          "Product price is required"
        );
      }

      const data =
        await createOfferListing(
          product
        );

      res
        .status(
          responseStatus(
            data
          )
        )
        .json(data);
    } catch (error) {
      jsonError(
        res,
        500,
        error
      );
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

    res.type(
      "html"
    );

    res.send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >

  <title>
    Publish to Amazon
  </title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 20px;
      background: #101017;
      color: #ffffff;
      font-family:
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
    }

    .card {
      max-width: 520px;
      margin: 25px auto;
      padding: 24px;
      background: #1d1d29;
      border: 1px solid #38384a;
      border-radius: 18px;
    }

    h1 {
      margin-top: 0;
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

    input {
      width: 100%;
      min-height: 50px;
      padding: 12px;
      color: #ffffff;
      background: #0f0f17;
      border: 1px solid #4c4c61;
      border-radius: 11px;
      font-size: 17px;
    }

    button {
      width: 100%;
      min-height: 56px;
      margin-top: 22px;
      padding: 15px;
      background: #d5a62a;
      color: #171208;
      border: 0;
      border-radius: 12px;
      font-size: 18px;
      font-weight: 800;
    }

    button:disabled {
      opacity: 0.6;
    }

    pre {
      margin-top: 20px;
      padding: 14px;
      min-height: 80px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      background: #09090e;
      border-radius: 10px;
      color: #e8e8ef;
      font-size: 13px;
    }
  </style>
</head>

<body>
  <main class="card">
    <h1>
      Publish to Amazon
    </h1>

    <div class="warning">
      This button submits a real Amazon offer.
      Review every field before publishing.
    </div>

    <label for="asin">
      Amazon ASIN
    </label>

    <input
      id="asin"
      value="B077SH7LZH"
      maxlength="10"
    >

    <label for="sku">
      Seller SKU
    </label>

    <input
      id="sku"
      value="AI7AR"
    >

    <label for="price">
      Price
    </label>

    <input
      id="price"
      value="86.95"
      type="number"
      min="0.01"
      step="0.01"
    >

    <label for="quantity">
      Quantity
    </label>

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

    <pre id="result">
Ready to publish.
    </pre>
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
            .getElementById(
              "asin"
            )
            .value
            .trim()
            .toUpperCase();

        const sku =
          document
            .getElementById(
              "sku"
            )
            .value
            .trim();

        const price =
          Number(
            document
              .getElementById(
                "price"
              )
              .value
          );

        const quantity =
          Number(
            document
              .getElementById(
                "quantity"
              )
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
            "Please enter a valid ASIN, SKU, price and quantity.";

          return;
        }

        const confirmed =
          window.confirm(
            "This will submit a real Amazon offer for ASIN " +
            asin +
            " at $" +
            price.toFixed(2) +
            ". Continue?"
          );

        if (!confirmed) {
          return;
        }

        publishButton.disabled =
          true;

        publishButton.textContent =
          "Publishing...";

        resultBox.textContent =
          "Checking restrictions, validating and submitting to Amazon...";

        try {
          const response =
            await fetch(
              "/amazon/offer/create",
              {
                method:
                  "POST",

                headers: {
                  "Content-Type":
                    "application/json"
                },

                body:
                  JSON.stringify({
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

          if (data.success) {
            publishButton.textContent =
              "Submitted to Amazon";
          } else {
            publishButton.textContent =
              "Try Again";
          }
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

function amazonAuthorizationCode(
  query
) {
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
    process.env
      .BASE44_AMAZON_AUTH_URL;

  const authSecret =
    process.env
      .AMAZON_AUTH_SECRET;

  if (
    !authUrl ||
    !authSecret
  ) {
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
        action:
          "store-token",
        refresh_token:
          refreshToken
      })
    }
  );

  const data =
    await readJsonResponse(
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
      `${req.protocol}://${req.get(
        "host"
      )}${callbackPath}`;

    const result =
      await exchangeAuthCode(
        code,
        redirectUri
      );

    if (
      !result.refresh_token
    ) {
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
      process.env
        .BASE44_APP_URL ||
      "https://theoutfitvault.store";

    const params =
      new URLSearchParams({
        amazon_connected:
          storage.stored
            ? "1"
            : "0"
      });

    if (
      storage.error
    ) {
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
    jsonError(
      res,
      500,
      error
    );
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
      `${req.protocol}://${req.get(
        "host"
      )}${callbackPath}`;

    const url =
      getAuthUrl(
        state,
        redirectUri
      );

    res.redirect(url);
  } catch (error) {
    jsonError(
      res,
      500,
      error
    );
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

      const data =
        await publishListing(
          product
        );

      res
        .status(
          responseStatus(
            data
          )
        )
        .json(data);
    } catch (error) {
      jsonError(
        res,
        500,
        error
      );
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
        .status(
          responseStatus(
            data
          )
        )
        .json(data);
    } catch (error) {
      jsonError(
        res,
        500,
        error
      );
    }
  }
);

async function handleInventory(
  req,
  res
) {
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
      .status(
        responseStatus(
          data
        )
      )
      .json(data);
  } catch (error) {
    jsonError(
      res,
      500,
      error
    );
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

async function handlePrice(
  req,
  res
) {
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
      .status(
        responseStatus(
          data
        )
      )
      .json(data);
  } catch (error) {
    jsonError(
      res,
      500,
      error
    );
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
        .status(
          responseStatus(
            data
          )
        )
        .json(data);
    } catch (error) {
      jsonError(
        res,
        500,
        error
      );
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
        .status(
          responseStatus(
            data
          )
        )
        .json(data);
    } catch (error) {
      jsonError(
        res,
        500,
        error
      );
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
        .status(
          responseStatus(
            data
          )
        )
        .json(data);
    } catch (error) {
      jsonError(
        res,
        500,
        error
      );
    }
  }
);

/* =========================================================
   ROUTE CHECK
========================================================= */

app.get(
  "/debug/routes",
  (req, res) => {
    const routes = [];

    for (
      const layer of
      app._router?.stack ||
      []
    ) {
      if (
        !layer.route
      ) {
        continue;
      }

      const methods =
        Object.keys(
          layer.route.methods ||
          {}
        )
          .filter(
            (method) =>
              layer.route
                .methods[method]
          )
          .map(
            (method) =>
              method.toUpperCase()
          );

      routes.push({
        path:
          layer.route.path,
        methods
      });
    }

    res.json({
      success: true,
      version:
        "amazon-publish-page-v4",
      routeCount:
        routes.length,
      routes
    });
  }
);

/* =========================================================
   JSON 404
========================================================= */

app.use(
  (req, res) => {
    res.status(404).json({
      success: false,
      error:
        "Route not found",
      method:
        req.method,
      path:
        req.path,
      version:
        "amazon-publish-page-v4",
      publishPage:
        "/amazon/publish-page",
      catalogSearch:
        "/amazon/catalog/search?upc=889359349981",
      offerPreview:
        "/amazon/offer/preview?asin=B077SH7LZH&sku=AI7AR&price=86.95&quantity=1"
    });
  }
);

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
      "Server version: amazon-publish-page-v4"
    );

    console.log(
      "Amazon catalog route: GET /amazon/catalog/search"
    );

    console.log(
      "Amazon offer preview: GET/POST /amazon/offer/preview"
    );

    console.log(
      "Amazon offer create: POST /amazon/offer/create"
    );

    console.log(
      "Amazon publishing page: GET /amazon/publish-page"
    );
  }
);
