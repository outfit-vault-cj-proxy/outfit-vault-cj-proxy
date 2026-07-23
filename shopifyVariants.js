/* eslint-env node */
/* global process, fetch */

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

let cachedShopifyToken = null;
let shopifyTokenExpiresAt = 0;

/* =========================================================
   HELPERS
========================================================= */

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

/* =========================================================
   SHOPIFY AUTHENTICATION
========================================================= */

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
    Number(
      data.expires_in
    ) || 86_399;

  shopifyTokenExpiresAt =
    Date.now() +
    expiresInSeconds * 1000;

  return cachedShopifyToken;
}

/* =========================================================
   SHOPIFY GRAPHQL
========================================================= */

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
   VARIANT FORMATTER
========================================================= */

function formatVariant(
  product,
  variant
) {
  const productImage =
    product.featuredImage
      ?.url || null;

  const weight =
    variant.inventoryItem
      ?.measurement
      ?.weight;

  return {
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

    compareAtPrice:
      variant.compareAtPrice
        ? Number(
            variant.compareAtPrice
          )
        : null,

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
      product.title ||
      null,

    vendor:
      product.vendor ||
      null,

    productType:
      product.productType ||
      null,

    productStatus:
      product.status ||
      null
  };
}

/* =========================================================
   SINGLE PRODUCT VARIANTS
========================================================= */

async function loadSingleProductVariants(
  productId
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
        status

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
              compareAtPrice
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
          productId
      }
    );

  const product =
    data?.product;

  if (!product) {
    return {
      productCount: 0,
      variants: []
    };
  }

  const variants =
    (
      product.variants
        ?.edges || []
    ).map(
      (edge) =>
        formatVariant(
          product,
          edge.node
        )
    );

  return {
    productCount: 1,
    variants
  };
}

/* =========================================================
   ALL ACTIVE PRODUCT VARIANTS
========================================================= */

async function loadAllProductVariants() {
  const variants = [];

  let productCount = 0;
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
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
              status

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
                    compareAtPrice
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
      data?.products;

    if (!connection) {
      throw new Error(
        "Shopify did not return a products connection."
      );
    }

    for (
      const edge of
      connection.edges || []
    ) {
      const product =
        edge.node;

      productCount++;

      for (
        const variantEdge of
        product.variants
          ?.edges || []
      ) {
        variants.push(
          formatVariant(
            product,
            variantEdge.node
          )
        );
      }
    }

    hasNextPage =
      Boolean(
        connection.pageInfo
          ?.hasNextPage
      );

    cursor =
      connection.pageInfo
        ?.endCursor ||
      null;
  }

  return {
    productCount,
    variants
  };
}

/* =========================================================
   DUPLICATE CHECK
========================================================= */

function validateUniqueVariants(
  variants
) {
  const seenIds =
    new Set();

  const duplicates = [];

  for (
    const variant of
    variants
  ) {
    const variantId =
      variant.shopify_variant_id;

    if (!variantId) {
      continue;
    }

    if (
      seenIds.has(
        variantId
      )
    ) {
      duplicates.push(
        variantId
      );
    }

    seenIds.add(
      variantId
    );
  }

  if (
    duplicates.length > 0
  ) {
    throw new Error(
      `Duplicate Shopify variants detected: ${duplicates.join(
        ", "
      )}`
    );
  }
}

/* =========================================================
   PUBLIC VARIANT LOADER
========================================================= */

export async function getShopifyVariants(
  options = {}
) {
  const productId =
    options.productId ||
    null;

  const result =
    productId
      ? await loadSingleProductVariants(
          productId
        )
      : await loadAllProductVariants();

  validateUniqueVariants(
    result.variants
  );

  return {
    success: true,

    meta: {
      shopify_api_version:
        SHOPIFY_API_VERSION,

      product_count:
        result.productCount,

      variant_count:
        result.variants.length,

      product_id:
        productId,

      generated_at:
        new Date()
          .toISOString()
    },

    variants:
      result.variants
  };
}

export default getShopifyVariants;
