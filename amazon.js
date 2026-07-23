/* eslint-env node */
/* global process */

const SPAPI_HOST =
  process.env.AMAZON_SPAPI_HOST ||
  "sellingpartnerapi-na.amazon.com";

const LWA_TOKEN_URL =
  "https://api.amazon.com/auth/o2/token";

const DEFAULT_MARKETPLACE =
  "ATVPDKIKX0DER";

const USER_AGENT =
  "TheOutfitVault/2.0 (Language=JavaScript; Platform=Node.js)";

let cachedLWAToken = null;
let lwaExpiresAt = 0;

/* =========================================================
   CONFIGURATION
========================================================= */

function getMarketplace() {
  return (
    process.env.AMAZON_MARKETPLACE_ID ||
    DEFAULT_MARKETPLACE
  );
}

function getSellerId() {
  return process.env.AMAZON_SELLER_ID;
}

function checkLwaCredentials() {
  const required = [
    "AMAZON_LWA_CLIENT_ID",
    "AMAZON_LWA_CLIENT_SECRET"
  ];

  const missing = required.filter(
    (key) => !process.env[key]
  );

  if (missing.length > 0) {
    throw new Error(
      `Missing Amazon env vars: ${missing.join(", ")}`
    );
  }
}

function checkRuntimeCredentials() {
  const required = [
    "AMAZON_LWA_CLIENT_ID",
    "AMAZON_LWA_CLIENT_SECRET",
    "AMAZON_LWA_REFRESH_TOKEN",
    "AMAZON_SELLER_ID"
  ];

  const missing = required.filter(
    (key) => !process.env[key]
  );

  if (missing.length > 0) {
    throw new Error(
      `Missing Amazon env vars: ${missing.join(", ")}`
    );
  }
}

/* =========================================================
   LOGIN WITH AMAZON
========================================================= */

async function getLWAToken(
  forceRefresh = false
) {
  checkRuntimeCredentials();

  if (
    !forceRefresh &&
    cachedLWAToken &&
    Date.now() < lwaExpiresAt - 60_000
  ) {
    return cachedLWAToken;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token:
      process.env.AMAZON_LWA_REFRESH_TOKEN,
    client_id:
      process.env.AMAZON_LWA_CLIENT_ID,
    client_secret:
      process.env.AMAZON_LWA_CLIENT_SECRET
  });

  const response = await fetch(
    LWA_TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "application/json"
      },
      body: body.toString()
    }
  );

  const responseText =
    await response.text();

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      `Amazon LWA returned invalid JSON: ${responseText}`
    );
  }

  if (
    !response.ok ||
    !data.access_token
  ) {
    throw new Error(
      `Amazon LWA token failed (${response.status}): ${JSON.stringify(
        data
      )}`
    );
  }

  cachedLWAToken =
    data.access_token;

  const expiresIn =
    Number(data.expires_in) || 3600;

  lwaExpiresAt =
    Date.now() + expiresIn * 1000;

  return cachedLWAToken;
}

/* =========================================================
   SP-API REQUESTS
========================================================= */

function buildQueryString(
  query = {}
) {
  const params =
    new URLSearchParams();

  for (
    const [key, value] of
    Object.entries(query)
  ) {
    if (
      value === undefined ||
      value === null ||
      value === ""
    ) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(
          key,
          String(item)
        );
      }
    } else {
      params.append(
        key,
        String(value)
      );
    }
  }

  return params.toString();
}

async function spApiCall(
  method,
  path,
  query = {},
  body = null,
  allowTokenRetry = true
) {
  const lwaToken =
    await getLWAToken();

  const queryString =
    buildQueryString(query);

  const url =
    `https://${SPAPI_HOST}${path}` +
    (
      queryString
        ? `?${queryString}`
        : ""
    );

  const headers = {
    Accept: "application/json",
    "x-amz-access-token":
      lwaToken,
    "user-agent":
      USER_AGENT
  };

  let requestBody;

  if (body !== null) {
    headers["Content-Type"] =
      "application/json";

    requestBody =
      JSON.stringify(body);
  }

  const response = await fetch(
    url,
    {
      method,
      headers,
      body: requestBody
    }
  );

  if (
    (
      response.status === 401 ||
      response.status === 403
    ) &&
    allowTokenRetry
  ) {
    cachedLWAToken = null;
    lwaExpiresAt = 0;

    await getLWAToken(true);

    return spApiCall(
      method,
      path,
      query,
      body,
      false
    );
  }

  const responseText =
    await response.text();

  let data = null;

  if (responseText) {
    try {
      data =
        JSON.parse(responseText);
    } catch {
      data = responseText;
    }
  }

  return {
    ok: response.ok,
    status:
      response.status,
    data
  };
}

function amazonError(result) {
  if (
    typeof result.data ===
    "string"
  ) {
    return result.data;
  }

  return JSON.stringify(
    result.data || {
      message:
        "Unknown Amazon error"
    }
  );
}

/* =========================================================
   GENERAL HELPERS
========================================================= */

function normalizeSku(value) {
  const sku = String(
    value || ""
  )
    .trim()
    .replace(/\s+/g, "-")
    .replace(
      /[^A-Za-z0-9._-]/g,
      ""
    )
    .slice(0, 40);

  if (!sku) {
    throw new Error(
      "A valid seller SKU is required"
    );
  }

  return sku;
}

function normalizeAsin(value) {
  const asin = String(
    value || ""
  )
    .trim()
    .toUpperCase();

  if (
    !/^[A-Z0-9]{10}$/.test(
      asin
    )
  ) {
    throw new Error(
      "A valid 10-character ASIN is required"
    );
  }

  return asin;
}

function normalizeMoney(value) {
  const price =
    Number(value);

  if (
    !Number.isFinite(price) ||
    price <= 0
  ) {
    throw new Error(
      "A valid price greater than zero is required"
    );
  }

  return Number(
    price.toFixed(2)
  );
}

function normalizeQuantity(value) {
  const quantity =
    Number(value);

  if (
    !Number.isFinite(quantity)
  ) {
    return 0;
  }

  return Math.max(
    0,
    Math.floor(quantity)
  );
}

function getProductSku(
  product = {}
) {
  return normalizeSku(
    product.amazon_sku ||
    product.sku ||
    (
      product.shopify_variant_id
        ? `OV-${String(
            product.shopify_variant_id
          ).split("/").pop()}`
        : `OV-${product.id || Date.now()}`
    )
  );
}

/* =========================================================
   CONNECTION TEST
========================================================= */

export async function checkConnection() {
  try {
    checkRuntimeCredentials();

    const result =
      await spApiCall(
        "GET",
        "/sellers/v1/marketplaceParticipations"
      );

    if (!result.ok) {
      return {
        success: false,
        status:
          result.status,
        error:
          amazonError(result),
        data:
          result.data
      };
    }

    return {
      success: true,
      seller_id:
        getSellerId(),
      marketplace:
        getMarketplace(),
      participations:
        result.data?.payload ||
        []
    };
  } catch (error) {
    return {
      success: false,
      error:
        error.message
    };
  }
}

export async function testConnection() {
  return checkConnection();
}

/* =========================================================
   AMAZON CATALOG SEARCH
========================================================= */

export async function searchCatalogByIdentifier(
  identifier,
  identifierType = "UPC"
) {
  try {
    checkRuntimeCredentials();

    if (!identifier) {
      return {
        success: false,
        error:
          "Product identifier is required"
      };
    }

    const normalizedIdentifier =
      String(identifier)
        .trim()
        .replace(/\s+/g, "");

    const normalizedType =
      String(identifierType)
        .trim()
        .toUpperCase();

    const allowedTypes =
      new Set([
        "ASIN",
        "EAN",
        "GTIN",
        "ISBN",
        "JAN",
        "MINSAN",
        "SKU",
        "UPC"
      ]);

    if (
      !allowedTypes.has(
        normalizedType
      )
    ) {
      return {
        success: false,
        error:
          `Unsupported identifier type: ${normalizedType}`
      };
    }

    const query = {
      marketplaceIds:
        getMarketplace(),
      identifiers:
        normalizedIdentifier,
      identifiersType:
        normalizedType,
      includedData:
        "summaries,identifiers,images,productTypes,classifications",
      pageSize: 20
    };

    if (
      normalizedType === "SKU"
    ) {
      query.sellerId =
        getSellerId();
    }

    const result =
      await spApiCall(
        "GET",
        "/catalog/2022-04-01/items",
        query
      );

    if (!result.ok) {
      return {
        success: false,
        status:
          result.status,
        error:
          amazonError(result),
        data:
          result.data
      };
    }

    const items =
      result.data?.items ||
      [];

    return {
      success: true,
      identifier:
        normalizedIdentifier,
      identifierType:
        normalizedType,
      marketplaceId:
        getMarketplace(),
      matchCount:
        items.length,
      pagination:
        result.data?.pagination ||
        null,
      refinements:
        result.data?.refinements ||
        null,
      matches:
        items.map((item) => {
          const summary =
            item.summaries?.find(
              (entry) =>
                entry.marketplaceId ===
                getMarketplace()
            ) ||
            item.summaries?.[0] ||
            {};

          const productType =
            item.productTypes?.find(
              (entry) =>
                entry.marketplaceId ===
                getMarketplace()
            ) ||
            item.productTypes?.[0] ||
            {};

          return {
            asin:
              item.asin ||
              null,
            title:
              summary.itemName ||
              null,
            brand:
              summary.brand ||
              null,
            manufacturer:
              summary.manufacturer ||
              null,
            modelNumber:
              summary.modelNumber ||
              null,
            color:
              summary.color ||
              null,
            size:
              summary.size ||
              null,
            productType:
              productType.productType ||
              null,
            identifiers:
              item.identifiers ||
              [],
            images:
              item.images ||
              [],
            classifications:
              item.classifications ||
              []
          };
        })
    };
  } catch (error) {
    return {
      success: false,
      error:
        error.message
    };
  }
}

/* =========================================================
   LISTING RESTRICTIONS
========================================================= */

export async function getListingRestrictions(
  asin,
  conditionType = "new_new"
) {
  try {
    checkRuntimeCredentials();

    const normalizedAsin =
      normalizeAsin(asin);

    const result =
      await spApiCall(
        "GET",
        "/listings/2021-08-01/restrictions",
        {
          asin:
            normalizedAsin,
          sellerId:
            getSellerId(),
          marketplaceIds:
            getMarketplace(),
          conditionType
        }
      );

    if (!result.ok) {
      return {
        success: false,
        asin:
          normalizedAsin,
        status:
          result.status,
        error:
          amazonError(result),
        data:
          result.data
      };
    }

    const restrictions =
      result.data?.restrictions ||
      [];

    return {
      success: true,
      asin:
        normalizedAsin,
      conditionType,
      eligible:
        restrictions.length ===
        0,
      restrictions
    };
  } catch (error) {
    return {
      success: false,
      error:
        error.message
    };
  }
}

/* =========================================================
   OFFER-ONLY LISTING
========================================================= */

function buildOfferOnlyBody(
  product = {}
) {
  const marketplaceId =
    getMarketplace();

  const asin =
    normalizeAsin(
      product.asin ||
      product.amazon_asin
    );

  const price =
    normalizeMoney(
      product.price ||
      product.sale_price
    );

  const quantity =
    normalizeQuantity(
      product.quantity ??
      product.inventory_quantity ??
      product.inventoryQuantity
    );

  const conditionType =
    product.condition_type ||
    product.conditionType ||
    "new_new";

  return {
    productType:
      "PRODUCT",

    requirements:
      "LISTING_OFFER_ONLY",

    attributes: {
      condition_type: [
        {
          value:
            conditionType,
          marketplace_id:
            marketplaceId
        }
      ],

      merchant_suggested_asin: [
        {
          value:
            asin,
          marketplace_id:
            marketplaceId
        }
      ],

      fulfillment_availability: [
        {
          fulfillment_channel_code:
            "DEFAULT",
          quantity
        }
      ],

      purchasable_offer: [
        {
          audience:
            "ALL",
          currency:
            "USD",
          marketplace_id:
            marketplaceId,
          our_price: [
            {
              schedule: [
                {
                  value_with_tax:
                    price
                }
              ]
            }
          ]
        }
      ]
    }
  };
}

async function submitOfferOnlyListing(
  product,
  validationPreview
) {
  checkRuntimeCredentials();

  const sellerId =
    getSellerId();

  const sku =
    getProductSku(product);

  const asin =
    normalizeAsin(
      product.asin ||
      product.amazon_asin
    );

  const path =
    `/listings/2021-08-01/items/` +
    `${encodeURIComponent(
      sellerId
    )}/${encodeURIComponent(
      sku
    )}`;

  const query = {
    marketplaceIds:
      getMarketplace(),
    includedData:
      validationPreview
        ? "issues,identifiers"
        : "issues",
    issueLocale:
      "en_US"
  };

  if (validationPreview) {
    query.mode =
      "VALIDATION_PREVIEW";
  }

  const body =
    buildOfferOnlyBody({
      ...product,
      asin
    });

  const result =
    await spApiCall(
      "PUT",
      path,
      query,
      body
    );

  if (!result.ok) {
    return {
      success: false,
      preview:
        validationPreview,
      sku,
      asin,
      status:
        result.status,
      error:
        amazonError(result),
      data:
        result.data,
      requestBody:
        body
    };
  }

  const issues =
    result.data?.issues ||
    [];

  const blockingIssues =
    issues.filter(
      (issue) =>
        issue.severity ===
        "ERROR"
    );

  return {
    success:
      blockingIssues.length ===
      0,
    preview:
      validationPreview,
    sku,
    asin,
    amazonStatus:
      result.data?.status ||
      null,
    submissionId:
      result.data
        ?.submissionId ||
      null,
    issues,
    blockingIssueCount:
      blockingIssues.length,
    identifiers:
      result.data
        ?.identifiers ||
      [],
    data:
      result.data
  };
}

export async function previewOfferListing(
  product
) {
  try {
    if (!product) {
      return {
        success: false,
        error:
          "Product is required"
      };
    }

    return await submitOfferOnlyListing(
      product,
      true
    );
  } catch (error) {
    return {
      success: false,
      preview: true,
      error:
        error.message
    };
  }
}

export async function createOfferListing(
  product
) {
  try {
    if (!product) {
      return {
        success: false,
        error:
          "Product is required"
      };
    }

    const asin =
      normalizeAsin(
        product.asin ||
        product.amazon_asin
      );

    const restrictions =
      await getListingRestrictions(
        asin,
        product.condition_type ||
        product.conditionType ||
        "new_new"
      );

    if (
      !restrictions.success
    ) {
      return {
        success: false,
        stage:
          "RESTRICTIONS_CHECK",
        restrictions
      };
    }

    if (
      !restrictions.eligible
    ) {
      return {
        success: false,
        stage:
          "RESTRICTED",
        asin,
        message:
          "Amazon requires approval or additional action before this ASIN can be listed.",
        restrictions:
          restrictions.restrictions
      };
    }

    const preview =
      await previewOfferListing(
        product
      );

    if (!preview.success) {
      return {
        success: false,
        stage:
          "VALIDATION_PREVIEW",
        asin,
        preview
      };
    }

    const submission =
      await submitOfferOnlyListing(
        product,
        false
      );

    return {
      ...submission,
      stage:
        submission.success
          ? "SUBMITTED"
          : "SUBMISSION_FAILED",
      restrictions,
      preview
    };
  } catch (error) {
    return {
      success: false,
      stage:
        "ERROR",
      error:
        error.message
    };
  }
}

/* =========================================================
   STANDARD PRODUCT LISTING
========================================================= */

function mapProductType(
  product = {}
) {
  const combined = [
    product.category,
    product.product_type,
    product.productType,
    product.product_name,
    product.productTitle,
    product.title
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (
    combined.includes("jean") ||
    combined.includes("pants") ||
    combined.includes("trouser")
  ) {
    return "PANTS";
  }

  if (
    combined.includes("dress")
  ) {
    return "DRESS";
  }

  if (
    combined.includes("shirt") ||
    combined.includes("top") ||
    combined.includes("blouse")
  ) {
    return "SHIRT";
  }

  if (
    combined.includes("shoe") ||
    combined.includes("boot") ||
    combined.includes("sneaker")
  ) {
    return "SHOES";
  }

  if (
    combined.includes("jacket") ||
    combined.includes("coat")
  ) {
    return "OUTERWEAR";
  }

  return (
    product.amazon_product_type ||
    "PRODUCT"
  );
}

function normalizeImages(
  product = {}
) {
  if (
    Array.isArray(
      product.product_images
    )
  ) {
    return product.product_images.filter(
      Boolean
    );
  }

  if (
    Array.isArray(
      product.images
    )
  ) {
    return product.images.filter(
      Boolean
    );
  }

  if (product.image) {
    return [product.image];
  }

  return [];
}

function buildListingBody(
  product = {}
) {
  const marketplaceId =
    getMarketplace();

  const title = String(
    product.product_name ||
    product.productTitle ||
    product.title ||
    "The Outfit Vault Product"
  ).slice(0, 200);

  const price =
    normalizeMoney(
      product.sale_price ||
      product.price
    );

  const quantity =
    normalizeQuantity(
      product.inventory_quantity ??
      product.inventoryQuantity
    );

  const images =
    normalizeImages(product);

  const attributes = {
    item_name: [
      {
        value: title,
        marketplace_id:
          marketplaceId,
        language_tag:
          "en_US"
      }
    ],

    brand: [
      {
        value:
          product.brand ||
          product.vendor ||
          "The Outfit Vault",
        marketplace_id:
          marketplaceId
      }
    ],

    condition_type: [
      {
        value:
          "new_new",
        marketplace_id:
          marketplaceId
      }
    ],

    fulfillment_availability: [
      {
        fulfillment_channel_code:
          "DEFAULT",
        quantity
      }
    ],

    purchasable_offer: [
      {
        audience:
          "ALL",
        currency:
          "USD",
        marketplace_id:
          marketplaceId,
        our_price: [
          {
            schedule: [
              {
                value_with_tax:
                  price
              }
            ]
          }
        ]
      }
    ]
  };

  if (images[0]) {
    attributes.main_product_image_locator = [
      {
        marketplace_id:
          marketplaceId,
        media_location:
          images[0]
      }
    ];
  }

  return {
    productType:
      mapProductType(product),
    requirements:
      "LISTING",
    attributes
  };
}

export async function publishListing(
  product
) {
  try {
    checkRuntimeCredentials();

    if (!product) {
      return {
        success: false,
        error:
          "Product is required"
      };
    }

    const sellerId =
      getSellerId();

    const sku =
      getProductSku(product);

    const path =
      `/listings/2021-08-01/items/` +
      `${encodeURIComponent(
        sellerId
      )}/${encodeURIComponent(
        sku
      )}`;

    const body =
      buildListingBody(product);

    const result =
      await spApiCall(
        "PUT",
        path,
        {
          marketplaceIds:
            getMarketplace(),
          includedData:
            "issues",
          issueLocale:
            "en_US"
        },
        body
      );

    if (!result.ok) {
      return {
        success: false,
        sku,
        status:
          result.status,
        error:
          amazonError(result),
        data:
          result.data
      };
    }

    return {
      success: true,
      sku,
      status:
        result.data?.status ||
        "SUBMITTED",
      issues:
        result.data?.issues ||
        [],
      data:
        result.data
    };
  } catch (error) {
    return {
      success: false,
      error:
        error.message
    };
  }
}

/* =========================================================
   LISTING STATUS
========================================================= */

async function getExistingProductType(
  sku
) {
  const sellerId =
    getSellerId();

  const path =
    `/listings/2021-08-01/items/` +
    `${encodeURIComponent(
      sellerId
    )}/${encodeURIComponent(
      sku
    )}`;

  const result =
    await spApiCall(
      "GET",
      path,
      {
        marketplaceIds:
          getMarketplace(),
        includedData:
          "summaries"
      }
    );

  if (!result.ok) {
    return "PRODUCT";
  }

  return (
    result.data
      ?.summaries?.[0]
      ?.productType ||
    result.data
      ?.productType ||
    "PRODUCT"
  );
}

export async function getListingStatus(
  sku
) {
  try {
    checkRuntimeCredentials();

    const normalizedSku =
      normalizeSku(sku);

    const path =
      `/listings/2021-08-01/items/` +
      `${encodeURIComponent(
        getSellerId()
      )}/${encodeURIComponent(
        normalizedSku
      )}`;

    const result =
      await spApiCall(
        "GET",
        path,
        {
          marketplaceIds:
            getMarketplace(),
          includedData:
            "summaries,issues,attributes,offers,fulfillmentAvailability"
        }
      );

    if (!result.ok) {
      return {
        success: false,
        sku:
          normalizedSku,
        status:
          result.status,
        error:
          amazonError(result),
        data:
          result.data
      };
    }

    return {
      success: true,
      sku:
        normalizedSku,
      data:
        result.data
    };
  } catch (error) {
    return {
      success: false,
      sku,
      error:
        error.message
    };
  }
}

/* =========================================================
   INVENTORY
========================================================= */

export async function syncInventory(
  sku,
  quantity
) {
  try {
    checkRuntimeCredentials();

    const normalizedSku =
      normalizeSku(sku);

    const productType =
      await getExistingProductType(
        normalizedSku
      );

    const path =
      `/listings/2021-08-01/items/` +
      `${encodeURIComponent(
        getSellerId()
      )}/${encodeURIComponent(
        normalizedSku
      )}`;

    const body = {
      productType,
      patches: [
        {
          op: "replace",
          path:
            "/attributes/fulfillment_availability",
          value: [
            {
              fulfillment_channel_code:
                "DEFAULT",
              quantity:
                normalizeQuantity(
                  quantity
                )
            }
          ]
        }
      ]
    };

    const result =
      await spApiCall(
        "PATCH",
        path,
        {
          marketplaceIds:
            getMarketplace(),
          includedData:
            "issues",
          issueLocale:
            "en_US"
        },
        body
      );

    return {
      success:
        result.ok,
      sku:
        normalizedSku,
      quantity:
        normalizeQuantity(
          quantity
        ),
      status:
        result.status,
      error:
        result.ok
          ? null
          : amazonError(result),
      data:
        result.data
    };
  } catch (error) {
    return {
      success: false,
      sku,
      error:
        error.message
    };
  }
}

/* =========================================================
   PRICE
========================================================= */

export async function syncPrice(
  sku,
  price
) {
  try {
    checkRuntimeCredentials();

    const normalizedSku =
      normalizeSku(sku);

    const normalizedPrice =
      normalizeMoney(price);

    const productType =
      await getExistingProductType(
        normalizedSku
      );

    const path =
      `/listings/2021-08-01/items/` +
      `${encodeURIComponent(
        getSellerId()
      )}/${encodeURIComponent(
        normalizedSku
      )}`;

    const body = {
      productType,
      patches: [
        {
          op: "replace",
          path:
            "/attributes/purchasable_offer",
          value: [
            {
              audience:
                "ALL",
              currency:
                "USD",
              marketplace_id:
                getMarketplace(),
              our_price: [
                {
                  schedule: [
                    {
                      value_with_tax:
                        normalizedPrice
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    };

    const result =
      await spApiCall(
        "PATCH",
        path,
        {
          marketplaceIds:
            getMarketplace(),
          includedData:
            "issues",
          issueLocale:
            "en_US"
        },
        body
      );

    return {
      success:
        result.ok,
      sku:
        normalizedSku,
      price:
        normalizedPrice,
      status:
        result.status,
      error:
        result.ok
          ? null
          : amazonError(result),
      data:
        result.data
    };
  } catch (error) {
    return {
      success: false,
      sku,
      error:
        error.message
    };
  }
}

/* =========================================================
   ORDERS
========================================================= */

export async function getOrders(
  createdAfter
) {
  try {
    checkRuntimeCredentials();

    const result =
      await spApiCall(
        "GET",
        "/orders/v0/orders",
        {
          MarketplaceIds:
            getMarketplace(),
          CreatedAfter:
            createdAfter ||
            new Date(
              Date.now() -
              7 *
              24 *
              60 *
              60 *
              1000
            ).toISOString()
        }
      );

    if (!result.ok) {
      return {
        success: false,
        status:
          result.status,
        error:
          amazonError(result),
        data:
          result.data
      };
    }

    return {
      success: true,
      orders:
        result.data?.payload
          ?.Orders ||
        [],
      nextToken:
        result.data?.payload
          ?.NextToken ||
        null
    };
  } catch (error) {
    return {
      success: false,
      error:
        error.message
    };
  }
}

export async function getOrderItems(
  orderId
) {
  try {
    checkRuntimeCredentials();

    if (!orderId) {
      return {
        success: false,
        error:
          "Amazon order ID is required"
      };
    }

    const result =
      await spApiCall(
        "GET",
        `/orders/v0/orders/${encodeURIComponent(
          orderId
        )}/orderItems`
      );

    if (!result.ok) {
      return {
        success: false,
        orderId,
        status:
          result.status,
        error:
          amazonError(result),
        data:
          result.data
      };
    }

    return {
      success: true,
      orderId,
      orderItems:
        result.data?.payload
          ?.OrderItems ||
        [],
      nextToken:
        result.data?.payload
          ?.NextToken ||
        null
    };
  } catch (error) {
    return {
      success: false,
      orderId,
      error:
        error.message
    };
  }
}

/* =========================================================
   SHIPMENT CONFIRMATION
========================================================= */

export async function updateAmazonTracking(
  orderId,
  trackingNumber,
  carrier
) {
  try {
    checkRuntimeCredentials();

    if (
      !orderId ||
      !trackingNumber
    ) {
      return {
        success: false,
        error:
          "orderId and trackingNumber are required"
      };
    }

    const orderItemsResult =
      await getOrderItems(
        orderId
      );

    if (
      !orderItemsResult.success
    ) {
      return orderItemsResult;
    }

    const orderItems =
      orderItemsResult.orderItems.map(
        (item) => ({
          orderItemId:
            item.OrderItemId,
          quantity:
            Number(
              item.QuantityOrdered
            ) || 1
        })
      );

    const result =
      await spApiCall(
        "POST",
        `/orders/v0/orders/${encodeURIComponent(
          orderId
        )}/shipmentConfirmation`,
        {},
        {
          packageDetail: {
            packageReferenceId:
              "1",
            carrierCode:
              carrier ||
              "UPS",
            shippingMethod:
              carrier ||
              "Standard",
            trackingNumber,
            shipDate:
              new Date()
                .toISOString(),
            orderItems
          },
          marketplaceId:
            getMarketplace()
        }
      );

    return {
      success:
        result.ok,
      orderId,
      trackingNumber,
      status:
        result.status,
      error:
        result.ok
          ? null
          : amazonError(result),
      data:
        result.data
    };
  } catch (error) {
    return {
      success: false,
      orderId,
      error:
        error.message
    };
  }
}

/* =========================================================
   AMAZON OAUTH
========================================================= */

export function getAuthUrl(
  state,
  _redirectUri
) {
  const applicationId =
    process.env
      .AMAZON_SPAPI_APP_ID;

  if (!applicationId) {
    throw new Error(
      "Missing AMAZON_SPAPI_APP_ID"
    );
  }

  const sellerCentralUrl =
    process.env
      .AMAZON_SELLER_CENTRAL_URL ||
    "https://sellercentral.amazon.com";

  const params =
    new URLSearchParams({
      application_id:
        applicationId,
      state:
        state ||
        Math.random()
          .toString(36)
          .slice(2)
    });

  const appVersion =
    String(
      process.env
        .AMAZON_SPAPI_APP_VERSION ||
      "beta"
    ).toLowerCase();

  if (
    appVersion === "beta"
  ) {
    params.set(
      "version",
      "beta"
    );
  }

  return (
    `${sellerCentralUrl}` +
    "/apps/authorize/consent?" +
    params.toString()
  );
}

export async function exchangeAuthCode(
  code,
  redirectUri
) {
  checkLwaCredentials();

  if (!code) {
    throw new Error(
      "Missing Amazon authorization code"
    );
  }

  if (!redirectUri) {
    throw new Error(
      "Missing Amazon OAuth redirect URI"
    );
  }

  const body =
    new URLSearchParams({
      grant_type:
        "authorization_code",
      code,
      redirect_uri:
        redirectUri,
      client_id:
        process.env
          .AMAZON_LWA_CLIENT_ID,
      client_secret:
        process.env
          .AMAZON_LWA_CLIENT_SECRET
    });

  const response = await fetch(
    LWA_TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded;charset=UTF-8",
        Accept:
          "application/json"
      },
      body:
        body.toString()
    }
  );

  const responseText =
    await response.text();

  let data;

  try {
    data =
      JSON.parse(
        responseText
      );
  } catch {
    throw new Error(
      `Amazon token exchange returned invalid JSON: ${responseText}`
    );
  }

  if (
    !response.ok ||
    !data.refresh_token
  ) {
    throw new Error(
      `Amazon token exchange failed (${response.status}): ${JSON.stringify(
        data
      )}`
    );
  }

  return data;
}
