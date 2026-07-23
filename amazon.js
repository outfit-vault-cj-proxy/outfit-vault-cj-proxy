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
  "TheOutfitVault/1.0 (Language=JavaScript; Platform=Node.js)";

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
   LOGIN WITH AMAZON TOKEN
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

function buildQueryString(query = {}) {
  const params =
    new URLSearchParams();

  for (const [key, value] of Object.entries(
    query
  )) {
    if (
      value === undefined ||
      value === null ||
      value === ""
    ) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, String(item));
      }
    } else {
      params.append(key, String(value));
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
    (queryString
      ? `?${queryString}`
      : "");

  const headers = {
    Accept: "application/json",
    "x-amz-access-token": lwaToken,
    "x-amz-date": new Date()
      .toISOString()
      .replace(/[:-]|\.\d{3}/g, ""),
    "user-agent": USER_AGENT
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
    (response.status === 401 ||
      response.status === 403) &&
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
      data = JSON.parse(responseText);
    } catch {
      data = responseText;
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

function amazonError(result) {
  if (
    typeof result.data === "string"
  ) {
    return result.data;
  }

  return JSON.stringify(
    result.data || {
      message: "Unknown Amazon error"
    }
  );
}

/* =========================================================
   PRODUCT LISTING HELPERS
========================================================= */

function mapProductType(product = {}) {
  const combined = [
    product.category,
    product.product_type,
    product.productType,
    product.product_name,
    product.productTitle
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
    combined.includes("coat") ||
    combined.includes("outerwear")
  ) {
    return "OUTERWEAR";
  }

  return (
    product.amazon_product_type ||
    "PRODUCT"
  );
}

function normalizeImages(product) {
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
    Array.isArray(product.images)
  ) {
    return product.images.filter(Boolean);
  }

  if (product.image) {
    return [product.image];
  }

  return [];
}

function buildListingBody(product) {
  const marketplaceId =
    getMarketplace();

  const title = String(
    product.product_name ||
      product.productTitle ||
      product.title ||
      "The Outfit Vault Product"
  ).slice(0, 200);

  const price = String(
    product.sale_price ||
      product.price ||
      "0"
  );

  const images =
    normalizeImages(product);

  const attributes = {
    item_name: [
      {
        value: title,
        marketplace_id:
          marketplaceId,
        language_tag: "en_US"
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

    fulfillment_availability: [
      {
        fulfillment_channel_code:
          "DEFAULT",
        quantity:
          Number(
            product.inventory_quantity ??
              product.inventoryQuantity
          ) || 0
      }
    ],

    purchasable_offer: [
      {
        marketplace_id:
          marketplaceId,
        currency: "USD",
        our_price: [
          {
            amount: price,
            currency_code: "USD"
          }
        ]
      }
    ]
  };

  const description =
    product.description ||
    product.descriptionHtml;

  if (description) {
    attributes.item_description = [
      {
        value: String(description)
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 2000),
        marketplace_id:
          marketplaceId,
        language_tag: "en_US"
      }
    ];
  }

  if (images[0]) {
    attributes.main_product_image_locator =
      [
        {
          marketplace_id:
            marketplaceId,
          value: images[0]
        }
      ];
  }

  for (
    let index = 1;
    index < Math.min(images.length, 9);
    index++
  ) {
    attributes[
      `other_product_image_locator_${index}`
    ] = [
      {
        marketplace_id:
          marketplaceId,
        value: images[index]
      }
    ];
  }

  if (
    product.barcode ||
    product.gtin
  ) {
    attributes.externally_assigned_product_identifier =
      [
        {
          marketplace_id:
            marketplaceId,
          type:
            String(
              product.barcode ||
                product.gtin
            ).length === 12
              ? "upc"
              : "ean",
          value:
            product.barcode ||
            product.gtin
        }
      ];
  }

  return {
    productType:
      mapProductType(product),
    requirements: "LISTING",
    attributes
  };
}

async function getExistingProductType(
  sku
) {
  const sellerId = getSellerId();

  const path =
    `/listings/2021-08-01/items/` +
    `${encodeURIComponent(
      sellerId
    )}/${encodeURIComponent(sku)}`;

  const result = await spApiCall(
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
    result.data?.summaries?.[0]
      ?.productType ||
    result.data?.productType ||
    "PRODUCT"
  );
}

/* =========================================================
   CONNECTION TEST
========================================================= */

export async function checkConnection() {
  try {
    checkRuntimeCredentials();

    const result = await spApiCall(
      "GET",
      "/sellers/v1/marketplaceParticipations"
    );

    if (!result.ok) {
      return {
        success: false,
        status: result.status,
        error: amazonError(result)
      };
    }

    return {
      success: true,
      seller_id: getSellerId(),
      marketplace:
        getMarketplace(),
      participations:
        result.data?.payload || []
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

export async function testConnection() {
  return checkConnection();
}

/* =========================================================
   LISTING CREATION
========================================================= */

export async function publishListing(
  product
) {
  try {
    checkRuntimeCredentials();

    const sellerId =
      getSellerId();

    const sku = String(
      product.amazon_sku ||
        product.sku ||
        `OV-${product.id}`
    );

    const path =
      `/listings/2021-08-01/items/` +
      `${encodeURIComponent(
        sellerId
      )}/${encodeURIComponent(sku)}`;

    const body =
      buildListingBody({
        ...product,
        amazon_sku: sku
      });

    const result =
      await spApiCall(
        "PUT",
        path,
        {
          marketplaceIds:
            getMarketplace(),
          includedData: "issues"
        },
        body
      );

    if (result.ok) {
      return {
        success: true,
        sku,
        status: "SUBMITTED",
        data: result.data
      };
    }

    return {
      success: false,
      sku,
      status: result.status,
      error: amazonError(result),
      data: result.data
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
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

    const sellerId =
      getSellerId();

    const productType =
      await getExistingProductType(sku);

    const path =
      `/listings/2021-08-01/items/` +
      `${encodeURIComponent(
        sellerId
      )}/${encodeURIComponent(sku)}`;

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
                Math.max(
                  0,
                  Number(quantity) || 0
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
          includedData: "issues"
        },
        body
      );

    if (result.ok) {
      return {
        success: true,
        sku,
        quantity,
        data: result.data
      };
    }

    return {
      success: false,
      sku,
      status: result.status,
      error: amazonError(result)
    };
  } catch (error) {
    return {
      success: false,
      sku,
      error: error.message
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

    const sellerId =
      getSellerId();

    const productType =
      await getExistingProductType(sku);

    const path =
      `/listings/2021-08-01/items/` +
      `${encodeURIComponent(
        sellerId
      )}/${encodeURIComponent(sku)}`;

    const body = {
      productType,
      patches: [
        {
          op: "replace",
          path:
            "/attributes/purchasable_offer",
          value: [
            {
              marketplace_id:
                getMarketplace(),
              currency: "USD",
              our_price: [
                {
                  amount:
                    String(price),
                  currency_code:
                    "USD"
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
          includedData: "issues"
        },
        body
      );

    if (result.ok) {
      return {
        success: true,
        sku,
        price,
        data: result.data
      };
    }

    return {
      success: false,
      sku,
      status: result.status,
      error: amazonError(result)
    };
  } catch (error) {
    return {
      success: false,
      sku,
      error: error.message
    };
  }
}

/* =========================================================
   LISTING STATUS
========================================================= */

export async function getListingStatus(
  sku
) {
  try {
    checkRuntimeCredentials();

    const sellerId =
      getSellerId();

    const path =
      `/listings/2021-08-01/items/` +
      `${encodeURIComponent(
        sellerId
      )}/${encodeURIComponent(sku)}`;

    const result =
      await spApiCall(
        "GET",
        path,
        {
          marketplaceIds:
            getMarketplace(),
          includedData:
            "summaries,issues,attributes"
        }
      );

    if (result.ok) {
      return {
        success: true,
        sku,
        data: result.data
      };
    }

    return {
      success: false,
      sku,
      status: result.status,
      error: amazonError(result)
    };
  } catch (error) {
    return {
      success: false,
      sku,
      error: error.message
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

    if (result.ok) {
      return {
        success: true,
        orders:
          result.data?.payload
            ?.Orders || [],
        nextToken:
          result.data?.payload
            ?.NextToken || null
      };
    }

    return {
      success: false,
      status: result.status,
      error: amazonError(result)
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

export async function getOrderItems(
  orderId
) {
  if (!orderId) {
    return {
      success: false,
      error:
        "Amazon order ID is required"
    };
  }

  try {
    checkRuntimeCredentials();

    const path =
      `/orders/v0/orders/` +
      `${encodeURIComponent(
        orderId
      )}/orderItems`;

    const result =
      await spApiCall(
        "GET",
        path
      );

    if (result.ok) {
      return {
        success: true,
        orderId,
        orderItems:
          result.data?.payload
            ?.OrderItems || [],
        nextToken:
          result.data?.payload
            ?.NextToken || null
      };
    }

    return {
      success: false,
      orderId,
      status: result.status,
      error: amazonError(result)
    };
  } catch (error) {
    return {
      success: false,
      orderId,
      error: error.message
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
      await getOrderItems(orderId);

    if (!orderItemsResult.success) {
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

    const path =
      `/orders/v0/orders/` +
      `${encodeURIComponent(
        orderId
      )}/shipmentConfirmation`;

    const body = {
      packageDetail: {
        packageReferenceId: "1",
        carrierCode:
          carrier || "UPS",
        shippingMethod:
          carrier || "Standard",
        trackingNumber,
        shipDate:
          new Date().toISOString(),
        orderItems
      },
      marketplaceId:
        getMarketplace()
    };

    const result =
      await spApiCall(
        "POST",
        path,
        {},
        body
      );

    if (result.ok) {
      return {
        success: true,
        orderId,
        trackingNumber
      };
    }

    return {
      success: false,
      orderId,
      status: result.status,
      error: amazonError(result)
    };
  } catch (error) {
    return {
      success: false,
      orderId,
      error: error.message
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
    process.env.AMAZON_SPAPI_APP_ID;

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

  const appVersion = String(
    process.env
      .AMAZON_SPAPI_APP_VERSION ||
      "beta"
  ).toLowerCase();

  if (appVersion === "beta") {
    params.set(
      "version",
      "beta"
    );
  }

  return (
    `${sellerCentralUrl}` +
    `/apps/authorize/consent?` +
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
      redirect_uri: redirectUri,
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
