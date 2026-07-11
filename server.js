import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

/* =========================================================
   ENVIRONMENT VARIABLES
========================================================= */

const CJ_ACCESS_TOKEN = process.env.CJ_ACCESS_TOKEN;
const CJ_API_KEY = process.env.CJ_API_KEY;

const SHOPIFY_STORE_DOMAIN =
  process.env.SHOPIFY_STORE_DOMAIN;

const SHOPIFY_CLIENT_ID =
  process.env.SHOPIFY_CLIENT_ID;

const SHOPIFY_CLIENT_SECRET =
  process.env.SHOPIFY_CLIENT_SECRET;

// Optional fallback for an older permanent Shopify token.
const SHOPIFY_ADMIN_ACCESS_TOKEN =
  process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

const SHOPIFY_API_VERSION =
  process.env.SHOPIFY_API_VERSION || "2026-07";

const AMAZON_ENV =
  process.env.AMAZON_ENV ||
  process.env.AMAZON_ENVIRONMENT ||
  "sandbox";

const AMAZON_LWA_CLIENT_ID =
  process.env.AMAZON_LWA_CLIENT_ID;

const AMAZON_LWA_CLIENT_SECRET =
  process.env.AMAZON_LWA_CLIENT_SECRET;

const CJ_BASE =
  "https://developers.cjdropshipping.com/api2.0/v1";

/* =========================================================
   TOKEN CACHES
========================================================= */

let cachedShopifyToken = null;
let cachedShopifyTokenExpiresAt = 0;

let cachedCJToken = null;
let cachedCJTokenExpiresAt = 0;

let cachedOnlineStorePublicationId = null;

/* =========================================================
   GENERAL HELPERS
========================================================= */

function cleanShopifyDomain(domain = "") {
  return String(domain)
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

function uniqueStrings(values = []) {
  return [
    ...new Set(
      values
        .filter(Boolean)
        .map((value) => String(value).trim())
        .filter(Boolean)
    )
  ];
}

function safeText(value, fallback = "") {
  if (value === null || value === undefined) {
    return fallback;
  }

  const output = String(value).trim();
  return output || fallback;
}

function safePrice(value, fallback = "29.99") {
  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) {
    return fallback;
  }

  return number.toFixed(2);
}

function cleanHtmlDescription(rawDescription = "") {
  if (!rawDescription) {
    return "";
  }

  return String(rawDescription)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(
      /<span[^>]*id=["']fondMartSku["'][^>]*>[\s\S]*?<\/span>/gi,
      ""
    );
}

function getRequestCJToken(req) {
  const headerValue =
    req.headers["x-cj-access-token"];

  if (Array.isArray(headerValue)) {
    return headerValue[0];
  }

  return typeof headerValue === "string"
    ? headerValue.trim()
    : "";
}

/* =========================================================
   CONFIGURATION CHECKS
========================================================= */

function getMissingShopifyVariables() {
  const missing = [];

  if (!SHOPIFY_STORE_DOMAIN) {
    missing.push("SHOPIFY_STORE_DOMAIN");
  }

  const hasClientCredentials =
    Boolean(SHOPIFY_CLIENT_ID) &&
    Boolean(SHOPIFY_CLIENT_SECRET);

  const hasPermanentToken =
    Boolean(SHOPIFY_ADMIN_ACCESS_TOKEN);

  if (!hasClientCredentials && !hasPermanentToken) {
    missing.push(
      "SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET"
    );
  }

  return missing;
}

function getMissingAmazonVariables() {
  const missing = [];

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
  if (SHOPIFY_ADMIN_ACCESS_TOKEN) {
    return SHOPIFY_ADMIN_ACCESS_TOKEN;
  }

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

  const response = await fetch(
    `https://${storeDomain}/admin/oauth/access_token`,
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
      })
    }
  );

  const rawText = await response.text();

  let data;

  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(
      `Shopify token response was not JSON: ${rawText.slice(
        0,
        400
      )}`
    );
  }

  if (!response.ok || !data.access_token) {
    throw new Error(
      `Shopify token request failed: ${JSON.stringify(
        data
      )}`
    );
  }

  cachedShopifyToken = data.access_token;

  const expiresIn = Number(
    data.expires_in || 86400
  );

  cachedShopifyTokenExpiresAt =
    Date.now() +
    Math.max(expiresIn - 300, 60) * 1000;

  return cachedShopifyToken;
}

/* =========================================================
   SHOPIFY GRAPHQL
========================================================= */

async function shopifyGraphQL(
  query,
  variables = {}
) {
  const missing = getMissingShopifyVariables();

  if (missing.length > 0) {
    throw new Error(
      `Missing Railway variables: ${missing.join(", ")}`
    );
  }

  const storeDomain = cleanShopifyDomain(
    SHOPIFY_STORE_DOMAIN
  );

  const accessToken =
    await getShopifyAccessToken();

  const response = await fetch(
    `https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Shopify-Access-Token": accessToken
      },
      body: JSON.stringify({
        query,
        variables
      })
    }
  );

  const rawText = await response.text();

  let payload;

  try {
    payload = JSON.parse(rawText);
  } catch {
    throw new Error(
      `Shopify returned non-JSON data: ${rawText.slice(
        0,
        500
      )}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Shopify HTTP ${response.status}: ${JSON.stringify(
        payload
      )}`
    );
  }

  if (payload.errors?.length) {
    throw new Error(
      `Shopify GraphQL error: ${JSON.stringify(
        payload.errors
      )}`
    );
  }

  return payload.data;
}

/* =========================================================
   CJ AUTHENTICATION
========================================================= */

async function getCJToken() {
  if (CJ_ACCESS_TOKEN) {
    return CJ_ACCESS_TOKEN;
  }

  if (
    cachedCJToken &&
    Date.now() < cachedCJTokenExpiresAt
  ) {
    return cachedCJToken;
  }

  if (!CJ_API_KEY) {
    throw new Error(
      "No CJ token is available. Add CJ_ACCESS_TOKEN or CJ_API_KEY to Railway, or send x-cj-access-token."
    );
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

  const rawText = await response.text();

  let data;

  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(
      `CJ token response was not JSON: ${rawText.slice(
        0,
        400
      )}`
    );
  }

  if (
    !response.ok ||
    !data?.data?.accessToken
  ) {
    throw new Error(
      `CJ token request failed: ${JSON.stringify(
        data
      )}`
    );
  }

  cachedCJToken = data.data.accessToken;

  // Refresh earlier than CJ's maximum token lifetime.
  cachedCJTokenExpiresAt =
    Date.now() +
    13 * 24 * 60 * 60 * 1000;

  return cachedCJToken;
}

async function cjRequest(
  path,
  {
    method = "GET",
    body,
    overrideToken
  } = {}
) {
  const token =
    overrideToken || (await getCJToken());

  const response = await fetch(
    `${CJ_BASE}${path}`,
    {
      method,
      headers: {
        "CJ-Access-Token": token,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body:
        body === undefined
          ? undefined
          : JSON.stringify(body)
    }
  );

  const rawText = await response.text();

  let data;

  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(
      `CJ returned non-JSON data: ${rawText.slice(
        0,
        500
      )}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `CJ HTTP ${response.status}: ${JSON.stringify(
        data
      )}`
    );
  }

  return data;
}

/* =========================================================
   SHOPIFY PUBLICATION
========================================================= */

async function getOnlineStorePublicationId() {
  if (cachedOnlineStorePublicationId) {
    return cachedOnlineStorePublicationId;
  }

  const query = `
    query OnlineStorePublications {
      publications(first: 50) {
        nodes {
          id
          name
        }
      }
    }
  `;

  const data = await shopifyGraphQL(
    query,
    {}
  );

  const publications =
    data?.publications?.nodes || [];

  const onlineStore = publications.find(
    (publication) =>
      String(publication.name)
        .trim()
        .toLowerCase() === "online store"
  );

  if (!onlineStore?.id) {
    throw new Error(
      "Shopify Online Store publication was not found. Confirm the Online Store sales channel is installed."
    );
  }

  cachedOnlineStorePublicationId =
    onlineStore.id;

  return onlineStore.id;
}

async function publishProductToOnlineStore(
  productId
) {
  const publicationId =
    await getOnlineStorePublicationId();

  const mutation = `
    mutation PublishProduct(
      $productId: ID!
      $publicationId: ID!
    ) {
      publishablePublish(
        id: $productId
        input: {
          publicationId: $publicationId
        }
      ) {
        publishable {
          publishedOnPublication(
            publicationId: $publicationId
          )
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const data = await shopifyGraphQL(
    mutation,
    {
      productId,
      publicationId
    }
  );

  const result =
    data?.publishablePublish;

  if (result?.userErrors?.length) {
    throw new Error(
      `Shopify publication failed: ${JSON.stringify(
        result.userErrors
      )}`
    );
  }

  return result;
}

/* =========================================================
   CJ PRODUCT NORMALIZATION
========================================================= */

function getCJProductData(response) {
  const value = response?.data;

  if (Array.isArray(value)) {
    return value[0] || {};
  }

  return value || {};
}

function getCJVariants(product, item = {}) {
  const candidates = [
    product.variants,
    product.variantList,
    product.productVariants,
    product.variantData,
    item.variants
  ];

  return (
    candidates.find(Array.isArray) || []
  );
}

function getVariantSKU(variant, index) {
  return safeText(
    variant.variantSku ||
      variant.sku ||
      variant.variantSKU ||
      variant.vSku ||
      variant.vid,
    `CJ-VARIANT-${index + 1}`
  );
}

function getVariantPrice(
  variant,
  fallbackPrice
) {
  return safePrice(
    variant.variantSellPrice ||
      variant.sellPrice ||
      variant.price ||
      variant.variantPrice ||
      fallbackPrice,
    fallbackPrice
  );
}

function getVariantImage(variant) {
  return safeText(
    variant.variantImage ||
      variant.image ||
      variant.variantImageUrl ||
      variant.img
  );
}

function extractVariantOptions(
  variant,
  index
) {
  const color = safeText(
    variant.color ||
      variant.variantColor ||
      variant.optionColor
  );

  const size = safeText(
    variant.size ||
      variant.variantSize ||
      variant.optionSize
  );

  if (color || size) {
    const output = [];

    if (color) {
      output.push({
        name: "Color",
        value: color
      });
    }

    if (size) {
      output.push({
        name: "Size",
        value: size
      });
    }

    return output;
  }

  const key = safeText(
    variant.variantKey ||
      variant.variantName ||
      variant.name ||
      variant.title ||
      variant.variantSku
  );

  if (key) {
    const parts = key
      .split(/[-,/|]/)
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts.length >= 2) {
      return [
        {
          name: "Color",
          value: parts[0]
        },
        {
          name: "Size",
          value: parts
            .slice(1)
            .join(" / ")
        }
      ];
    }

    return [
      {
        name: "Style",
        value: key
      }
    ];
  }

  return [
    {
      name: "Style",
      value: `Option ${index + 1}`
    }
  ];
}

function buildProductOptions(
  normalizedVariants
) {
  const map = new Map();

  for (const variant of normalizedVariants) {
    for (const option of variant.options) {
      if (!map.has(option.name)) {
        map.set(option.name, new Set());
      }

      map.get(option.name).add(option.value);
    }
  }

  return [...map.entries()].map(
    ([name, values]) => ({
      name,
      values: [...values].map((value) => ({
        name: value
      }))
    })
  );
}

function normalizeCJVariants(
  product,
  item,
  fallbackPrice
) {
  return getCJVariants(product, item).map(
    (variant, index) => ({
      sku: getVariantSKU(
        variant,
        index
      ),

      barcode: safeText(
        variant.barcode ||
          variant.variantBarcode
      ),

      price: getVariantPrice(
        variant,
        fallbackPrice
      ),

      image: getVariantImage(variant),

      options: extractVariantOptions(
        variant,
        index
      )
    })
  );
}

/* =========================================================
   SHOPIFY PRODUCT CREATION
========================================================= */

async function createShopifyProduct({
  product,
  item,
  cjProductId
}) {
  const title = safeText(
    product.productNameEn ||
      product.productName ||
      item.title ||
      item.name,
    "Imported CJ Product"
  );

  const descriptionHtml =
    cleanHtmlDescription(
      product.description ||
        product.productDescription ||
        item.description ||
        ""
    );

  const basePrice = safePrice(
    item.price ||
      item.retailPrice ||
      product.sellPrice ||
      product.productSellPrice ||
      product.suggestSellPrice,
    "29.99"
  );

  const images = uniqueStrings([
    product.productImage,
    ...(Array.isArray(
      product.productImages
    )
      ? product.productImages
      : []),
    item.image,
    ...(Array.isArray(item.images)
      ? item.images
      : [])
  ]).slice(0, 10);

  const normalizedVariants =
    normalizeCJVariants(
      product,
      item,
      basePrice
    );

  const productOptions =
    buildProductOptions(
      normalizedVariants
    );

  const productCreateMutation = `
    mutation CreateCJProduct(
      $product: ProductCreateInput!
      $media: [CreateMediaInput!]
    ) {
      productCreate(
        product: $product
        media: $media
      ) {
        product {
          id
          title
          handle
          status
          options {
            id
            name
            optionValues {
              id
              name
            }
          }
          variants(first: 10) {
            nodes {
              id
              sku
              price
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const productInput = {
    title,
    descriptionHtml,
    vendor: "CJ Dropshipping",
    productType: safeText(
      product.categoryName ||
        product.threeCategoryName ||
        item.productType,
      "Dropshipping"
    ),
    tags: [
      "CJ Dropshipping",
      "The Outfit Vault",
      `CJ_PID_${cjProductId}`
    ],
    status: "ACTIVE"
  };

  if (productOptions.length > 0) {
    productInput.productOptions =
      productOptions;
  }

  const media = images.map(
    (imageUrl) => ({
      mediaContentType: "IMAGE",
      originalSource: imageUrl,
      alt: title
    })
  );

  const createData =
    await shopifyGraphQL(
      productCreateMutation,
      {
        product: productInput,
        media
      }
    );

  const createResult =
    createData?.productCreate;

  if (createResult?.userErrors?.length) {
    throw new Error(
      `Shopify product creation failed: ${JSON.stringify(
        createResult.userErrors
      )}`
    );
  }

  const createdProduct =
    createResult?.product;

  if (!createdProduct?.id) {
    throw new Error(
      "Shopify did not return a product ID."
    );
  }

  let createdVariants =
    createdProduct.variants?.nodes || [];

  /*
   * productCreate only creates the initial Shopify variant.
   * When CJ supplies multiple variants, replace the standalone
   * Shopify variant with the complete CJ variant list.
   */
  if (normalizedVariants.length > 0) {
    const variantsMutation = `
      mutation CreateCJVariants(
        $productId: ID!
        $variants: [ProductVariantsBulkInput!]!
      ) {
        productVariantsBulkCreate(
          productId: $productId
          variants: $variants
          strategy: REMOVE_STANDALONE_VARIANT
        ) {
          productVariants {
            id
            title
            sku
            price
            selectedOptions {
              name
              value
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variantInputs =
      normalizedVariants.map(
        (variant) => {
          const input = {
            price: variant.price,

            inventoryItem: {
              sku: variant.sku,
              tracked: true
            },

            inventoryPolicy: "DENY",

            optionValues:
              variant.options.map(
                (option) => ({
                  optionName:
                    option.name,
                  name: option.value
                })
              )
          };

          if (variant.barcode) {
            input.barcode =
              variant.barcode;
          }

          if (variant.image) {
            input.mediaSrc = [
              variant.image
            ];
          }

          return input;
        }
      );

    const variantsData =
      await shopifyGraphQL(
        variantsMutation,
        {
          productId:
            createdProduct.id,
          variants: variantInputs
        }
      );

    const variantsResult =
      variantsData
        ?.productVariantsBulkCreate;

    if (
      variantsResult?.userErrors?.length
    ) {
      throw new Error(
        `Shopify variant creation failed: ${JSON.stringify(
          variantsResult.userErrors
        )}`
      );
    }

    createdVariants =
      variantsResult?.productVariants ||
      [];
  }

  const publicationResult =
    await publishProductToOnlineStore(
      createdProduct.id
    );

  return {
    product: createdProduct,
    variants: createdVariants,
    publication: publicationResult
  };
}

/* =========================================================
   ROOT AND HEALTH ROUTES
========================================================= */

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message:
      "The Outfit Vault marketplace proxy is running",
    integrations: {
      cj: Boolean(
        CJ_ACCESS_TOKEN || CJ_API_KEY
      ),
      shopify:
        getMissingShopifyVariables()
          .length === 0,
      amazon:
        getMissingAmazonVariables()
          .length === 0
    }
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    status: "healthy",
    shopifyConfigured:
      getMissingShopifyVariables()
        .length === 0,
    cjConfigured: Boolean(
      CJ_ACCESS_TOKEN || CJ_API_KEY
    ),
    amazonConfigured:
      getMissingAmazonVariables()
        .length === 0,
    amazonEnvironment: AMAZON_ENV
  });
});

/* =========================================================
   CJ ROUTES
========================================================= */

app.get("/cj/products", async (req, res) => {
  try {
    const keyword = safeText(
      req.query.keyWord ||
        req.query.keyword,
      "clothing"
    );

    const page = Math.max(
      Number(req.query.page || 1),
      1
    );

    const size = Math.min(
      Math.max(
        Number(req.query.size || 20),
        1
      ),
      100
    );

    const token =
      getRequestCJToken(req);

    const data = await cjRequest(
      `/product/listV2?page=${page}&size=${size}&keyword=${encodeURIComponent(
        keyword
      )}`,
      {
        overrideToken: token
      }
    );

    return res.status(200).json(data);
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
});

app.get("/cj/product", async (req, res) => {
  try {
    const pid = safeText(req.query.pid);

    if (!pid) {
      return res.status(400).json({
        success: false,
        error: "pid is required"
      });
    }

    const token =
      getRequestCJToken(req);

    const data = await cjRequest(
      `/product/query?pid=${encodeURIComponent(
        pid
      )}`,
      {
        overrideToken: token
      }
    );

    return res.status(200).json(data);
  } catch (error) {
    console.error(
      "CJ_PRODUCT_ERROR",
      error
    );

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post(
  "/cj/create-order",
  async (req, res) => {
    try {
      const token =
        getRequestCJToken(req);

      const data = await cjRequest(
        "/shopping/order/createOrderV2",
        {
          method: "POST",
          body: req.body,
          overrideToken: token
        }
      );

      return res
        .status(200)
        .json(data);
    } catch (error) {
      console.error(
        "CJ_CREATE_ORDER_ERROR",
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
   CJ → SHOPIFY IMPORT
========================================================= */

app.post(
  "/shopify/import",
  async (req, res) => {
    try {
      const selectedProducts =
        req.body?.selectedProducts;

      if (
        !Array.isArray(
          selectedProducts
        ) ||
        selectedProducts.length === 0
      ) {
        return res.status(400).json({
          success: false,
          error:
            "selectedProducts must be a non-empty array"
        });
      }

      const token =
        getRequestCJToken(req);

      const imported = [];

      for (const item of selectedProducts) {
        const cjProductId =
          item.pid ||
          item.productId ||
          item.cjProductId ||
          item.cj_product_id;

        if (!cjProductId) {
          imported.push({
            success: false,
            error:
              "Missing CJ product ID",
            item
          });

          continue;
        }

        try {
          const detailResponse =
            await cjRequest(
              `/product/query?pid=${encodeURIComponent(
                cjProductId
              )}`,
              {
                overrideToken:
                  token
              }
            );

          const product =
            getCJProductData(
              detailResponse
            );

          if (
            !product ||
            Object.keys(product).length ===
              0
          ) {
            throw new Error(
              "CJ returned no product details."
            );
          }

          const created =
            await createShopifyProduct({
              product,
              item,
              cjProductId
            });

          imported.push({
            success: true,
            cjProductId,
            shopifyProduct:
              created.product,
            shopifyProductId:
              created.product.id,
            shopifyVariantIds:
              created.variants.map(
                (variant) =>
                  variant.id
              ),
            shopifyVariants:
              created.variants,
            published: true
          });
        } catch (error) {
          imported.push({
            success: false,
            cjProductId,
            error: error.message
          });
        }
      }

      const successful =
        imported.filter(
          (item) => item.success
        );

      const failed = imported.filter(
        (item) => !item.success
      );

      const status =
        failed.length > 0 &&
        successful.length === 0
          ? 502
          : 200;

      return res.status(status).json({
        success: failed.length === 0,
        createdCount:
          successful.length,
        failedCount: failed.length,
        imported
      });
    } catch (error) {
      console.error(
        "SHOPIFY_IMPORT_ERROR",
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
   SHOPIFY → OUTFIT VAULT SYNC
========================================================= */

app.get(
  "/shopify/products",
  async (req, res) => {
    try {
      const allProducts = [];

      let cursor = null;
      let hasNextPage = true;

      while (hasNextPage) {
        const query = `
          query ActiveProducts(
            $first: Int!
            $after: String
          ) {
            products(
              first: $first
              after: $after
              query: "status:active"
              sortKey: UPDATED_AT
              reverse: true
            ) {
              nodes {
                id
                title
                handle
                description
                descriptionHtml
                vendor
                productType
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
                    preview {
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

        const data =
          await shopifyGraphQL(
            query,
            {
              first: 100,
              after: cursor
            }
          );

        const connection =
          data?.products;

        allProducts.push(
          ...(connection?.nodes || [])
        );

        hasNextPage = Boolean(
          connection?.pageInfo
            ?.hasNextPage
        );

        cursor =
          connection?.pageInfo
            ?.endCursor || null;
      }

      return res.status(200).json({
        success: true,
        count: allProducts.length,
        products: allProducts
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
   AMAZON CONFIGURATION STATUS

   The live Amazon routes should remain in Base44 until an
   amazon.js module is actually added to this GitHub repository.
========================================================= */

app.get("/amazon/status", (req, res) => {
  const missing =
    getMissingAmazonVariables();

  if (missing.length > 0) {
    return res.status(500).json({
      success: false,
      configured: false,
      connected: false,
      environment: AMAZON_ENV,
      missingVariables: missing
    });
  }

  return res.status(200).json({
    success: true,
    configured: true,
    connected: false,
    environment: AMAZON_ENV,
    message:
      "Amazon credentials are configured. Live authorization is managed through the Base44 OAuth functions."
  });
});

/* =========================================================
   404
========================================================= */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found",
    method: req.method,
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
      `THE_OUTFIT_VAULT_PROXY_STARTED_ON_PORT_${PORT}`
    );
  }
);
