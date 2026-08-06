const SPAPI_HOST = "sellingpartnerapi-na.amazon.com";
const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const DEFAULT_MARKETPLACE = "ATVPDKIKX0DER";
const ORDER_PAGE_LIMIT = 100;
const MAX_ORDER_PAGES = 50;
const MAX_ITEM_PAGES = 50;
const REQUEST_TIMEOUT_MS = 30_000;

let cachedLWAToken = null;
let lwaExpiresAt = 0;

function getMarketplace() {
  return process.env.AMAZON_MARKETPLACE_ID || DEFAULT_MARKETPLACE;
}

function getSellerId() {
  return process.env.AMAZON_SELLER_ID;
}

function assertString(value, field) {
  const output = String(value ?? "").trim();

  if (!output) {
    throw new Error(`${field} is required`);
  }

  return output;
}

function checkCreds() {
  const required = [
    "AMAZON_LWA_CLIENT_ID",
    "AMAZON_LWA_CLIENT_SECRET",
    "AMAZON_LWA_REFRESH_TOKEN",
    "AMAZON_SELLER_ID",
  ];

  const missing = required.filter(
    (key) => !String(process.env[key] || "").trim(),
  );

  if (missing.length > 0) {
    throw new Error(`Missing Amazon env vars: ${missing.join(", ")}`);
  }
}

async function readJsonSafely(response) {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function getLWAToken() {
  if (cachedLWAToken && Date.now() < lwaExpiresAt) {
    return cachedLWAToken;
  }

  checkCreds();

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: process.env.AMAZON_LWA_REFRESH_TOKEN,
    client_id: process.env.AMAZON_LWA_CLIENT_ID,
    client_secret: process.env.AMAZON_LWA_CLIENT_SECRET,
  });

  const response = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const data = await readJsonSafely(response);

  if (!response.ok || !data?.access_token) {
    throw new Error(
      `LWA token failed (${response.status}): ${
        typeof data === "string" ? data : JSON.stringify(data)
      }`,
    );
  }

  cachedLWAToken = data.access_token;
  lwaExpiresAt =
    Date.now() +
    (Math.max(60, Number(data.expires_in || 3600)) - 60) * 1000;

  return cachedLWAToken;
}

async function spApiCall(method, path, query = {}, body = null) {
  const lwaToken = await getLWAToken();
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry !== undefined && entry !== null && entry !== "") {
          params.append(key, String(entry));
        }
      }
    } else {
      params.append(key, String(value));
    }
  }

  const queryString = params.toString();
  const url =
    `https://${SPAPI_HOST}${path}` +
    (queryString ? `?${queryString}` : "");

  const bodyString =
    body === null || body === undefined
      ? null
      : JSON.stringify(body);

  const headers = {
    Accept: "application/json",
    "x-amz-access-token": lwaToken,
    "User-Agent":
      "TheOutfitVault/1.0 (Language=JavaScript; Platform=Railway)",
  };

  if (bodyString !== null) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method: String(method).toUpperCase(),
    headers,
    body: bodyString,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  return {
    ok: response.ok,
    status: response.status,
    data: await readJsonSafely(response),
  };
}

function mapProductType(category) {
  const map = {
    Tops: "SHIRT",
    Bottoms: "PANTS",
    Dresses: "DRESS",
    Shoes: "SHOE",
    Accessories: "ACCESSORY",
    Outerwear: "OUTERWEAR",
  };

  return map[category] || "PRODUCT";
}

function normalizeAlphaSize(value) {
  const normalized = String(value || "").trim().toUpperCase();

  const map = {
    "EXTRA SMALL": "xs",
    XS: "xs",
    SMALL: "s",
    S: "s",
    MEDIUM: "m",
    M: "m",
    LARGE: "l",
    L: "l",
    "EXTRA LARGE": "xl",
    XL: "xl",
    XXL: "xxl",
    "2XL": "xxl",
    XXXL: "xxxl",
    "3XL": "xxxl",
    "4XL": "xxxxl",
  };

  return map[normalized] || normalized.toLowerCase();
}

function buildListingBody(product) {
  const marketplaceId = getMarketplace();
  const productType = mapProductType(product.category);

  const attributes = {
    item_name: [
      {
        value: String(product.product_name || product.title || "").slice(0, 200),
        marketplace_id: marketplaceId,
        language_tag: "en_US",
      },
    ],
    brand: [
      {
        value: product.brand || "The Outfit Vault",
      },
    ],
    fulfillment_availability: [
      {
        fulfillment_channel_code: "DEFAULT",
        quantity: Number(product.inventory_quantity ?? product.quantity) || 0,
      },
    ],
    purchasable_offer: [
      {
        marketplace_id: marketplaceId,
        currency: "USD",
        our_price: [
          {
            amount: String(product.sale_price || product.price || 0),
            currency_code: "USD",
          },
        ],
      },
    ],
  };

  if (product.description) {
    attributes.item_description = [
      {
        value: String(product.description).slice(0, 2000),
        marketplace_id: marketplaceId,
        language_tag: "en_US",
      },
    ];
  }

  const images = Array.isArray(product.product_images)
    ? [...new Set(product.product_images.filter(Boolean))]
    : [];

  if (images[0]) {
    attributes.main_product_image_locator = [
      {
        marketplace_id: marketplaceId,
        value: images[0],
      },
    ];
  }

  if (images[1]) {
    attributes.other_product_image_locator_1 = [
      {
        marketplace_id: marketplaceId,
        value: images[1],
      },
    ];
  }

  const size = product.size ? normalizeAlphaSize(product.size) : null;

  if (size && ["PANTS", "SHORTS", "SKIRT"].includes(productType)) {
    attributes.bottoms_size = [
      {
        marketplace_id: marketplaceId,
        size_system: product.size_system || "us",
        size_class: product.size_class || "alpha",
        size,
      },
    ];
  }

  if (
    size &&
    ["SHIRT", "SWEATER", "T_SHIRT", "OUTERWEAR", "DRESS"].includes(productType)
  ) {
    attributes.shirt_size = [
      {
        marketplace_id: marketplaceId,
        size_system: product.size_system || "us",
        size_class: product.size_class || "alpha",
        size,
      },
    ];
  }

  if (product.upc) {
    attributes.externally_assigned_product_identifier = [
      {
        type: "upc",
        value: String(product.upc),
      },
    ];
  }

  return {
    productType,
    requirements: "LISTING",
    attributes,
  };
}

function resultError(data) {
  return typeof data === "string"
    ? data
    : JSON.stringify(data ?? {}).slice(0, 4000);
}

export async function checkConnection() {
  const result = {
    connected: false,
    marketplace_id: getMarketplace(),
    seller_id_present: Boolean(getSellerId()),
    lwa_token_generated: false,
    spapi_test_succeeded: false,
  };

  try {
    await getLWAToken();
    result.lwa_token_generated = true;

    const response = await spApiCall("GET", "/orders/v0/orders", {
      MarketplaceIds: getMarketplace(),
      CreatedAfter: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    });

    if (!response.ok) {
      return {
        ...result,
        error_code: "AMAZON_SPAPI_REQUEST_FAILED",
        error: "Amazon SP-API read-only test failed.",
        httpStatus: response.status,
      };
    }

    return {
      ...result,
      connected: true,
      spapi_test_succeeded: true,
    };
  } catch (error) {
    return {
      ...result,
      error_code: "AMAZON_CONNECTION_FAILED",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function testConnection() {
  return checkConnection();
}

export async function publishListing(product) {
  const sellerId = assertString(getSellerId(), "AMAZON_SELLER_ID");
  const sku =
    product.amazon_sku ||
    product.sku ||
    `OV-${assertString(product.id, "product.id")}`;

  const path =
    `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/` +
    encodeURIComponent(sku);

  const response = await spApiCall(
    "PUT",
    path,
    {},
    buildListingBody(product),
  );

  const data = response.data || {};
  const issues = Array.isArray(data.issues) ? data.issues : [];

  return {
    success: response.ok && issues.length === 0,
    sku,
    status: data.status || (response.ok ? "LISTED" : "ERROR"),
    issues,
    submissionId: data.submissionId || null,
    httpStatus: response.status,
    error: response.ok ? null : resultError(data),
  };
}

export async function syncInventory(sku, quantity) {
  const sellerId = assertString(getSellerId(), "AMAZON_SELLER_ID");
  const safeSku = assertString(sku, "sku");

  const path =
    `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/` +
    encodeURIComponent(safeSku);

  const body = {
    productType: "PRODUCT",
    requirements: "LISTING",
    attributes: {
      fulfillment_availability: [
        {
          fulfillment_channel_code: "DEFAULT",
          quantity: Number(quantity) || 0,
        },
      ],
    },
  };

  const response = await spApiCall(
    "PATCH",
    path,
    { mode: "PARTIAL" },
    body,
  );

  return response.ok
    ? {
        success: true,
        sku: safeSku,
        quantity: Number(quantity) || 0,
      }
    : {
        success: false,
        sku: safeSku,
        httpStatus: response.status,
        error: resultError(response.data),
      };
}

export async function syncPrice(sku, price) {
  const sellerId = assertString(getSellerId(), "AMAZON_SELLER_ID");
  const safeSku = assertString(sku, "sku");

  const path =
    `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/` +
    encodeURIComponent(safeSku);

  const body = {
    productType: "PRODUCT",
    requirements: "LISTING",
    attributes: {
      purchasable_offer: [
        {
          marketplace_id: getMarketplace(),
          currency: "USD",
          our_price: [
            {
              amount: String(price),
              currency_code: "USD",
            },
          ],
        },
      ],
    },
  };

  const response = await spApiCall(
    "PATCH",
    path,
    { mode: "PARTIAL" },
    body,
  );

  return response.ok
    ? {
        success: true,
        sku: safeSku,
        price,
      }
    : {
        success: false,
        sku: safeSku,
        httpStatus: response.status,
        error: resultError(response.data),
      };
}

export async function getListingStatus(sku) {
  const sellerId = assertString(getSellerId(), "AMAZON_SELLER_ID");
  const safeSku = assertString(sku, "sku");

  const path =
    `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/` +
    encodeURIComponent(safeSku);

  const response = await spApiCall("GET", path, {
    marketplaceIds: getMarketplace(),
    includedData:
      "summaries,issues,offers,fulfillmentAvailability",
  });

  return response.ok
    ? {
        success: true,
        sku: safeSku,
        data: response.data,
      }
    : {
        success: false,
        sku: safeSku,
        httpStatus: response.status,
        error: resultError(response.data),
      };
}

export async function getOrdersPaginated({
  createdAfter,
  lastUpdatedAfter,
  maxPages = MAX_ORDER_PAGES,
} = {}) {
  if (createdAfter && lastUpdatedAfter) {
    throw new Error("Use createdAfter or lastUpdatedAfter, not both");
  }

  const baseQuery = {
    MarketplaceIds: getMarketplace(),
    MaxResultsPerPage: ORDER_PAGE_LIMIT,
  };

  if (lastUpdatedAfter) {
    baseQuery.LastUpdatedAfter = new Date(lastUpdatedAfter).toISOString();
  } else {
    baseQuery.CreatedAfter = new Date(
      createdAfter || Date.now() - 7 * 86_400_000,
    ).toISOString();
  }

  const orders = [];
  let nextToken = null;
  let pageCount = 0;

  do {
    if (pageCount >= maxPages) {
      return {
        success: false,
        error_code: "AMAZON_ORDER_PAGE_LIMIT_REACHED",
        error: `Stopped after ${maxPages} pages.`,
        orders,
        nextToken,
        pageCount,
      };
    }

    const response = await spApiCall(
      "GET",
      "/orders/v0/orders",
      nextToken ? { NextToken: nextToken } : baseQuery,
    );

    if (!response.ok) {
      return {
        success: false,
        error_code: "AMAZON_ORDERS_REQUEST_FAILED",
        httpStatus: response.status,
        orders,
        nextToken,
        pageCount,
        error: resultError(response.data),
      };
    }

    const payload = response.data?.payload || {};
    orders.push(
      ...(Array.isArray(payload.Orders) ? payload.Orders : []),
    );
    nextToken = payload.NextToken || null;
    pageCount += 1;
  } while (nextToken);

  return {
    success: true,
    orders,
    nextToken: null,
    pageCount,
  };
}

export async function getOrders(createdAfter) {
  return getOrdersPaginated({ createdAfter });
}

export async function getOrderItemsPaginated(
  orderId,
  { maxPages = MAX_ITEM_PAGES } = {},
) {
  const safeOrderId = assertString(orderId, "orderId");
  const path =
    `/orders/v0/orders/${encodeURIComponent(safeOrderId)}/orderItems`;

  const items = [];
  let nextToken = null;
  let pageCount = 0;

  do {
    if (pageCount >= maxPages) {
      return {
        success: false,
        error_code: "AMAZON_ORDER_ITEM_PAGE_LIMIT_REACHED",
        error: `Stopped after ${maxPages} pages.`,
        orderId: safeOrderId,
        items,
        nextToken,
        pageCount,
      };
    }

    const response = await spApiCall(
      "GET",
      path,
      nextToken ? { NextToken: nextToken } : {},
    );

    if (!response.ok) {
      return {
        success: false,
        error_code: "AMAZON_ORDER_ITEMS_REQUEST_FAILED",
        httpStatus: response.status,
        orderId: safeOrderId,
        items,
        nextToken,
        pageCount,
        error: resultError(response.data),
      };
    }

    const payload = response.data?.payload || {};
    items.push(
      ...(Array.isArray(payload.OrderItems)
        ? payload.OrderItems
        : []),
    );
    nextToken = payload.NextToken || null;
    pageCount += 1;
  } while (nextToken);

  return {
    success: true,
    orderId: safeOrderId,
    items,
    nextToken: null,
    pageCount,
  };
}

export async function getOrderItems(orderId) {
  return getOrderItemsPaginated(orderId);
}

function normalizeAmazonCarrier(carrier) {
  const raw = String(carrier || "").trim();
  const upper = raw.toUpperCase();

  const known = new Map([
    ["UPS", "UPS"],
    ["USPS", "USPS"],
    ["FEDEX", "FedEx"],
    ["FED EX", "FedEx"],
    ["DHL", "DHL"],
    ["DHL ECOMMERCE", "DHL eCommerce"],
    ["ONTRAC", "OnTrac"],
    ["LASERSHIP", "LaserShip"],
    ["AMAZON LOGISTICS", "Amazon Logistics"],
  ]);

  const code = known.get(upper);

  return code
    ? {
        carrierCode: code,
        carrierName: code,
      }
    : {
        carrierCode: "Other",
        carrierName: raw || "Other",
      };
}

export async function confirmAmazonShipment({
  orderId,
  trackingNumber,
  carrier,
  shipDate,
  packageReferenceId,
  shippingMethod,
  orderItems,
}) {
  const safeOrderId = assertString(orderId, "orderId");
  const safeTracking = assertString(
    trackingNumber,
    "trackingNumber",
  );

  if (!Array.isArray(orderItems) || orderItems.length === 0) {
    throw new Error(
      "orderItems is required and must include Amazon orderItemId values",
    );
  }

  const normalizedItems = orderItems.map((item, index) => {
    const orderItemId = assertString(
      item?.orderItemId,
      `orderItems[${index}].orderItemId`,
    );

    const quantity = Number(item?.quantity);

    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error(
        `orderItems[${index}].quantity must be a positive integer`,
      );
    }

    return {
      orderItemId,
      quantity,
    };
  });

  const carrierInfo = normalizeAmazonCarrier(carrier);

  const body = {
    marketplaceId: getMarketplace(),
    packageDetail: {
      packageReferenceId: String(
        packageReferenceId || `pkg-${Date.now()}`,
      ).slice(0, 100),
      carrierCode: carrierInfo.carrierCode,
      carrierName: carrierInfo.carrierName,
      shippingMethod: String(
        shippingMethod || "Standard",
      ).slice(0, 100),
      trackingNumber: safeTracking,
      shipDate: new Date(shipDate || Date.now()).toISOString(),
      orderItems: normalizedItems,
    },
  };

  const response = await spApiCall(
    "POST",
    `/orders/v0/orders/${encodeURIComponent(
      safeOrderId,
    )}/shipmentConfirmation`,
    {},
    body,
  );

  if (response.ok || response.status === 204) {
    return {
      success: true,
      orderId: safeOrderId,
      trackingNumber: safeTracking,
      carrierCode: carrierInfo.carrierCode,
      itemCount: normalizedItems.length,
      httpStatus: response.status,
    };
  }

  return {
    success: false,
    orderId: safeOrderId,
    error_code: "AMAZON_SHIPMENT_CONFIRMATION_FAILED",
    httpStatus: response.status,
    error: resultError(response.data),
  };
}

export async function updateAmazonTracking(
  orderId,
  trackingNumber,
  carrier,
  orderItems = [],
) {
  return confirmAmazonShipment({
    orderId,
    trackingNumber,
    carrier,
    orderItems,
  });
}

export function getAuthUrl(stateOrRedirectUri, maybeRedirectUri) {
  const clientId = assertString(
    process.env.AMAZON_LWA_CLIENT_ID,
    "AMAZON_LWA_CLIENT_ID",
  );

  const redirectUri = maybeRedirectUri || stateOrRedirectUri;
  const state = maybeRedirectUri ? stateOrRedirectUri : null;

  const params = new URLSearchParams({
    client_id: clientId,
    scope: "sellingpartnerapi::migration",
    response_type: "code",
    redirect_uri: assertString(redirectUri, "redirectUri"),
  });

  if (state) {
    params.set("state", String(state));
  }

  return (
    "https://sellercentral.amazon.com/apps/external/consent?" +
    params.toString()
  );
}

export async function exchangeAuthCode(code, redirectUri) {
  if (
    !process.env.AMAZON_LWA_CLIENT_ID ||
    !process.env.AMAZON_LWA_CLIENT_SECRET
  ) {
    throw new Error("Amazon LWA client credentials are not configured");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: assertString(code, "code"),
    client_id: process.env.AMAZON_LWA_CLIENT_ID,
    client_secret: process.env.AMAZON_LWA_CLIENT_SECRET,
    redirect_uri: assertString(redirectUri, "redirectUri"),
  });

  const response = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const data = await readJsonSafely(response);

  if (!response.ok || !data?.refresh_token) {
    throw new Error("Amazon authorization-code exchange failed.");
  }

  return {
    refresh_token: data.refresh_token,
    access_token: data.access_token || null,
    expires_in: data.expires_in || null,
    token_type: data.token_type || null,
  };
}

export function normalizeUpc(value) {
  const normalized = String(value || "").replace(/[\s-]/g, "");

  return /^\d{12}$/.test(normalized) ? normalized : null;
}

function buildCleanQuery(params) {
  const clean = {};

  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    if (Array.isArray(value)) {
      const filtered = value.filter(Boolean);

      if (filtered.length > 0) {
        clean[key] = filtered.join(",");
      }
    } else {
      clean[key] = String(value);
    }
  }

  return clean;
}

export function chooseAmazonImageGroup(
  imageGroups,
  marketplaceId = getMarketplace(),
) {
  const groups = Array.isArray(imageGroups) ? imageGroups : [];

  return (
    groups.find(
      (group) => group?.marketplaceId === marketplaceId,
    ) ||
    groups[0] ||
    {}
  );
}

async function searchCatalogInternal(query) {
  const response = await spApiCall(
    "GET",
    "/catalog/2022-04-01/items",
    query,
  );

  if (!response.ok) {
    return {
      success: false,
      status: response.status,
      error_code: "AMAZON_CATALOG_ERROR",
      error: "Amazon catalog search failed.",
      upstream: resultError(response.data),
    };
  }

  const items = (response.data?.items || []).map((item) => {
    const summary = (item.summaries || [])[0] || {};
    const productType = (item.productTypes || [])[0] || {};
    const identifiers = [];

    for (const group of item.identifiers || []) {
      for (const identifier of group.identifiers || []) {
        identifiers.push({
          type: identifier.identifierType,
          value: identifier.identifier,
        });
      }
    }

    const imageGroup = chooseAmazonImageGroup(
      item.images,
      getMarketplace(),
    );
    const images = Array.isArray(imageGroup.images)
      ? imageGroup.images
      : [];
    const mainImage =
      images.find((image) => image.variant === "MAIN") ||
      images[0];

    return {
      asin: item.asin || null,
      parent_asin: null,
      title: summary.itemName || null,
      brand: summary.brand || null,
      productType: productType.productType || null,
      amazon_title: summary.itemName || null,
      amazon_brand: summary.brand || null,
      product_type: productType.productType || null,
      amazon_image: mainImage?.link || mainImage?.url || null,
      identifiers,
    };
  });

  return {
    success: true,
    numberOfResults:
      response.data?.numberOfResults || items.length,
    items,
    upstreamStatus: response.status,
  };
}

export async function searchByIdentifier({
  identifier,
  identifiersType,
  marketplaceId,
}) {
  const type = String(identifiersType || "").toUpperCase();
  let value = String(identifier || "").replace(/[\s-]/g, "");

  if (!value || !type) {
    return {
      success: false,
      error_code: "AMAZON_INVALID_INPUT",
      error: "Identifier and identifiersType are required.",
    };
  }

  if (type === "UPC") {
    value = normalizeUpc(value);

    if (!value) {
      return {
        success: false,
        error_code: "AMAZON_INVALID_INPUT",
        error: "UPC must contain exactly 12 digits.",
      };
    }
  }

  if (type === "EAN" && !/^\d{13}$/.test(value)) {
    return {
      success: false,
      error_code: "AMAZON_INVALID_INPUT",
      error: "EAN must contain exactly 13 digits.",
    };
  }

  if (type === "ASIN" && !/^[A-Z0-9]{10}$/i.test(value)) {
    return {
      success: false,
      error_code: "AMAZON_INVALID_INPUT",
      error: "ASIN must contain exactly 10 alphanumeric characters.",
    };
  }

  return searchCatalogInternal(
    buildCleanQuery({
      marketplaceIds: marketplaceId || getMarketplace(),
      identifiers: value,
      identifiersType: type,
      includedData:
        "summaries,identifiers,productTypes,images",
    }),
  );
}

export async function searchByKeywords({
  keywords,
  marketplaceId,
  brandNames,
}) {
  const value = String(keywords || "").trim();

  if (!value) {
    return {
      success: false,
      error_code: "AMAZON_INVALID_INPUT",
      error: "keywords is required.",
    };
  }

  return searchCatalogInternal(
    buildCleanQuery({
      marketplaceIds: marketplaceId || getMarketplace(),
      keywords: value,
      brandNames,
      includedData:
        "summaries,identifiers,productTypes,images",
    }),
  );
}

export async function searchCatalogItems(params = {}) {
  if (params.identifiers && params.identifiersType) {
    return searchByIdentifier({
      identifier: Array.isArray(params.identifiers)
        ? params.identifiers[0]
        : params.identifiers,
      identifiersType: params.identifiersType,
      marketplaceId: getMarketplace(),
    });
  }

  if (params.keywords) {
    return searchByKeywords({
      keywords: params.keywords,
      marketplaceId: getMarketplace(),
      brandNames: params.brandNames,
    });
  }

  return {
    success: false,
    error_code: "AMAZON_INVALID_INPUT",
    error: "Missing catalog search parameters.",
  };
}

export async function searchCatalogByIdentifier(
  identifier,
  identifiersType = "ASIN",
) {
  const result = await searchByIdentifier({
    identifier,
    identifiersType,
    marketplaceId: getMarketplace(),
  });

  return {
    ...result,
    matches: Array.isArray(result?.items) ? result.items : [],
  };
}

export async function getProductTypeDefinition(
  productType = "PANTS",
) {
  const query = {
    marketplaceIds: getMarketplace(),
    requirements: "LISTING",
    locale: "en_US",
    requirementsEnforced: "ENFORCED",
  };

  if (getSellerId()) {
    query.sellerId = getSellerId();
  }

  const response = await spApiCall(
    "GET",
    `/definitions/2020-09-01/productTypes/${encodeURIComponent(
      productType,
    )}`,
    query,
  );

  return response.ok
    ? {
        success: true,
        productType,
        definition: response.data,
      }
    : {
        success: false,
        status: response.status,
        error: resultError(response.data),
      };
}

export async function getListingRestrictions(
  asin,
  conditionType = "new_new",
) {
  const normalizedAsin = assertString(asin, "asin")
    .trim()
    .toUpperCase();

  if (!/^[A-Z0-9]{10}$/.test(normalizedAsin)) {
    return {
      success: false,
      status: 400,
      eligible: null,
      restrictions: [],
      error_code: "INVALID_ASIN",
      error: "ASIN must contain exactly 10 letters or numbers.",
    };
  }

  const response = await spApiCall(
    "GET",
    "/listings/2021-08-01/restrictions",
    {
      asin: normalizedAsin,
      sellerId: assertString(
        getSellerId(),
        "AMAZON_SELLER_ID",
      ),
      marketplaceIds: getMarketplace(),
      conditionType: String(conditionType || "new_new"),
    },
  );

  if (!response.ok) {
    return {
      success: false,
      status: response.status,
      eligible: null,
      restrictions: [],
      error_code: "AMAZON_RESTRICTIONS_REQUEST_FAILED",
      error: resultError(response.data),
    };
  }

  const restrictions = Array.isArray(
    response.data?.restrictions,
  )
    ? response.data.restrictions
    : [];

  return {
    success: true,
    status: response.status,
    asin: normalizedAsin,
    conditionType: String(conditionType || "new_new"),
    eligible: restrictions.length === 0,
    restrictions,
  };
}

export async function previewOfferListing(product = {}) {
  const asin = product.asin || product.amazon_asin;
  const conditionType =
    product.condition_type ||
    product.conditionType ||
    "new_new";

  const restrictions = await getListingRestrictions(
    asin,
    conditionType,
  );

  return {
    ...restrictions,
    stage: restrictions.success
      ? restrictions.eligible
        ? "ELIGIBLE"
        : "RESTRICTED"
      : "RESTRICTION_CHECK_ERROR",
    readOnly: true,
    externalWritesPerformed: 0,
    preview: {
      asin: asin ? String(asin).trim().toUpperCase() : null,
      sku: product.sku || product.amazon_sku || null,
      price: product.price ?? null,
      quantity: product.quantity ?? null,
      conditionType,
    },
  };
}

async function putOfferOnlyListing(product) {
  const sellerId = assertString(
    getSellerId(),
    "AMAZON_SELLER_ID",
  );

  const sku =
    product.amazon_sku ||
    product.sku ||
    `OV-${product.id || Date.now()}`;

  const asin = assertString(
    product.asin || product.amazon_asin,
    "asin",
  )
    .trim()
    .toUpperCase();

  const price = Number(product.price);

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(
      "price must be a number greater than zero",
    );
  }

  const quantity = Number(product.quantity);

  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error(
      "quantity must be a whole number of zero or greater",
    );
  }

  const path =
    `/listings/2021-08-01/items/${encodeURIComponent(
      sellerId,
    )}/` + encodeURIComponent(sku);

  const body = {
    productType: product.productType || "PRODUCT",
    requirements: "LISTING_OFFER_ONLY",
    attributes: {
      merchant_suggested_asin: [
        {
          value: asin,
          marketplace_id: getMarketplace(),
        },
      ],
      purchasable_offer: [
        {
          marketplace_id: getMarketplace(),
          currency: "USD",
          audience: "ALL",
          our_price: [
            {
              schedule: [
                {
                  value_with_tax: price,
                },
              ],
            },
          ],
        },
      ],
      fulfillment_availability: [
        {
          fulfillment_channel_code: "DEFAULT",
          quantity,
        },
      ],
      condition_type: [
        {
          value: product.condition_type || "new_new",
          marketplace_id: getMarketplace(),
        },
      ],
    },
  };

  const response = await spApiCall(
    "PUT",
    path,
    {
      marketplaceIds: getMarketplace(),
    },
    body,
  );

  return {
    response,
    sku,
    asin,
  };
}

export async function createOfferListing(product) {
  try {
    const { response, sku, asin } =
      await putOfferOnlyListing(product);

    const data = response.data || {};
    const issues = Array.isArray(data.issues)
      ? data.issues
      : [];
    const success = response.ok && issues.length === 0;

    return {
      success,
      status: response.status,
      sku,
      asin,
      stage: success ? "SUBMITTED" : "SUBMISSION_FAILED",
      amazonStatus: data.status || null,
      issues,
      submissionId: data.submissionId || null,
      error: success ? null : resultError(data),
    };
  } catch (error) {
    return {
      success: false,
      stage: "INVALID",
      status: 400,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function createOffer(product) {
  return createOfferListing(product);
}
