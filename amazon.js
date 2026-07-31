/* eslint-env node */
/* global process, fetch */

const SPAPI_HOST =
  process.env.AMAZON_SPAPI_HOST ||
  "sellingpartnerapi-na.amazon.com";

const LWA_TOKEN_URL =
  "https://api.amazon.com/auth/o2/token";

const DEFAULT_MARKETPLACE =
  "ATVPDKIKX0DER";

const AMAZON_API_VERSION =
  "amazon-api-v2.2.3-catalog-images";

const USER_AGENT =
  "TheOutfitVault/2.1 (Language=JavaScript; Platform=Node.js)";

const TRANSIENT_SPAPI_STATUSES = new Set([502, 503, 504]);
const SPAPI_RETRY_DELAY_MS = 1200;

let cachedLWAToken = null;
let lwaExpiresAt = 0;

function getMarketplace() {
  return process.env.AMAZON_MARKETPLACE_ID || DEFAULT_MARKETPLACE;
}

function getSellerId() {
  return process.env.AMAZON_SELLER_ID;
}

function checkLwaCredentials() {
  const required = [
    "AMAZON_LWA_CLIENT_ID",
    "AMAZON_LWA_CLIENT_SECRET"
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing Amazon env vars: ${missing.join(", ")}`);
  }
}

function checkRuntimeCredentials() {
  const required = [
    "AMAZON_LWA_CLIENT_ID",
    "AMAZON_LWA_CLIENT_SECRET",
    "AMAZON_LWA_REFRESH_TOKEN",
    "AMAZON_SELLER_ID"
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing Amazon env vars: ${missing.join(", ")}`);
  }
}

async function getLWAToken(forceRefresh = false) {
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
    refresh_token: process.env.AMAZON_LWA_REFRESH_TOKEN,
    client_id: process.env.AMAZON_LWA_CLIENT_ID,
    client_secret: process.env.AMAZON_LWA_CLIENT_SECRET
  });

  const response = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Accept: "application/json"
    },
    body: body.toString()
  });

  const responseText = await response.text();
  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(`Amazon LWA returned invalid JSON: ${responseText}`);
  }

  if (!response.ok || !data.access_token) {
    throw new Error(
      `Amazon LWA token failed (${response.status}): ${JSON.stringify(data)}`
    );
  }

  cachedLWAToken = data.access_token;
  const expiresIn = Number(data.expires_in) || 3600;
  lwaExpiresAt = Date.now() + expiresIn * 1000;
  return cachedLWAToken;
}

function buildQueryString(query = {}) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (
      value === undefined ||
      value === null ||
      value === ""
    ) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (
          item === undefined ||
          item === null ||
          item === ""
        ) {
          continue;
        }

        params.append(key, String(item));
      }

      continue;
    }

    params.append(key, String(value));
  }

  return params.toString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAmazonRequestId(headers) {
  return (
    headers?.get?.("x-amzn-requestid") ||
    headers?.get?.("x-amz-request-id") ||
    null
  );
}

async function spApiCall(
  method,
  path,
  query = {},
  body = null,
  allowTokenRetry = true,
  allowTransientRetry = true
) {
  const lwaToken = await getLWAToken();
  const queryString = buildQueryString(query);

  const url =
    `https://${SPAPI_HOST}${path}` +
    (queryString ? `?${queryString}` : "");

  const headers = {
    Accept: "application/json",
    "x-amz-access-token": lwaToken,
    "user-agent": USER_AGENT
  };

  let requestBody;

  if (body !== null) {
    headers["Content-Type"] = "application/json";
    requestBody = JSON.stringify(body);
  }

  let response;

  try {
    response = await fetch(url, {
      method,
      headers,
      body: requestBody
    });
  } catch (error) {
    return {
      ok: false,
      status: null,
      data: null,
      error: error.message,
      requestId: null,
      url,
      path,
      query
    };
  }

  if (
    (response.status === 401 || response.status === 403) &&
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
      false,
      allowTransientRetry
    );
  }

  if (
    TRANSIENT_SPAPI_STATUSES.has(response.status) &&
    allowTransientRetry
  ) {
    await delay(SPAPI_RETRY_DELAY_MS);

    return spApiCall(
      method,
      path,
      query,
      body,
      allowTokenRetry,
      false
    );
  }

  const responseText = await response.text();
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
    data,
    requestId: getAmazonRequestId(response.headers),
    url,
    path,
    query
  };
}

function amazonError(result) {
  if (!result) return "Unknown Amazon error";
  if (result.error) return result.error;
  if (typeof result.data === "string") return result.data;

  return JSON.stringify(
    result.data || {
      message: "Unknown Amazon error"
    }
  );
}

function amazonErrorDetails(result) {
  const data = result?.data;

  return {
    status: result?.status ?? null,
    requestId:
      result?.requestId ||
      data?.requestId ||
      data?.errors?.[0]?.requestId ||
      null,
    code:
      data?.code ||
      data?.errorCode ||
      data?.errors?.[0]?.code ||
      null,
    message:
      data?.message ||
      data?.error_description ||
      data?.errors?.[0]?.message ||
      (typeof data === "string"
        ? data
        : result?.error || null),
    details:
      data?.details ||
      data?.errors?.[0]?.details ||
      null,
    upstreamBody: data ?? null,
    requestPath: result?.path || null,
    requestQuery: result?.query || null
  };
}

function normalizeSku(value) {
  const sku = String(value || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .slice(0, 40);

  if (!sku) throw new Error("A valid seller SKU is required");
  return sku;
}

function normalizeAsin(value) {
  const asin = String(value || "").trim().toUpperCase();

  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    throw new Error("A valid 10-character ASIN is required");
  }

  return asin;
}

function normalizeMoney(value) {
  const price = Number(value);

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("A valid price greater than zero is required");
  }

  return Number(price.toFixed(2));
}

function normalizeQuantity(value) {
  const quantity = Number(value);
  if (!Number.isFinite(quantity)) return 0;
  return Math.max(0, Math.floor(quantity));
}

function getProductSku(product = {}) {
  return normalizeSku(
    product.amazon_sku ||
      product.sku ||
      (product.shopify_variant_id
        ? `OV-${String(product.shopify_variant_id).split("/").pop()}`
        : `OV-${product.id || Date.now()}`)
  );
}

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
        error: amazonError(result),
        data: result.data
      };
    }

    return {
      success: true,
      apiVersion: AMAZON_API_VERSION,
      seller_id: getSellerId(),
      marketplace: getMarketplace(),
      participations: result.data?.payload || []
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

function normalizeDigits(value) {
  return String(value || "")
    .replace(/[\s-]+/g, "")
    .trim();
}

function normalizeUpc(value) {
  const upc = normalizeDigits(value);

  if (!/^\d{12}$/.test(upc)) {
    throw new Error(
      "UPC must contain exactly 12 digits after removing spaces and hyphens."
    );
  }

  return upc;
}

function normalizeCatalogIdentifier(value, type) {
  const normalizedType = String(type || "")
    .trim()
    .toUpperCase();

  const rawValue = normalizeDigits(value);

  if (!ALLOWED_IDENTIFIER_TYPES.has(normalizedType)) {
    throw new Error(
      `Unsupported identifier type: ${normalizedType}`
    );
  }

  if (normalizedType === "UPC") {
    return normalizeUpc(rawValue);
  }

  if (
    normalizedType === "EAN" &&
    !/^\d{13}$/.test(rawValue)
  ) {
    throw new Error("EAN must contain exactly 13 digits.");
  }

  if (
    normalizedType === "GTIN" &&
    !/^\d{14}$/.test(rawValue)
  ) {
    throw new Error("GTIN must contain exactly 14 digits.");
  }

  if (normalizedType === "ASIN") {
    return normalizeAsin(rawValue);
  }

  if (!rawValue) {
    throw new Error("Product identifier is required.");
  }

  return rawValue;
}

function buildIdentifierCatalogQuery({
  identifier,
  identifierType
}) {
  const normalizedType = String(identifierType || "")
    .trim()
    .toUpperCase();

  const normalizedIdentifier =
    normalizeCatalogIdentifier(
      identifier,
      normalizedType
    );

  const query = {
    marketplaceIds: getMarketplace(),
    identifiers: normalizedIdentifier,
    identifiersType: normalizedType,
    includedData:
      "summaries,identifiers,images,productTypes,classifications,relationships",
    pageSize: 20
  };

  if (normalizedType === "SKU") {
    query.sellerId = getSellerId();
  }

  return {
    query,
    normalizedIdentifier,
    normalizedType
  };
}

function buildKeywordCatalogQuery({
  keywords,
  brandNames
}) {
  const normalizedKeywords = String(keywords || "")
    .replace(/\s+/g, " ")
    .trim();

  const normalizedBrand = String(brandNames || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalizedKeywords) {
    throw new Error("Keywords are required.");
  }

  const query = {
    marketplaceIds: getMarketplace(),
    keywords: normalizedKeywords,
    includedData:
      "summaries,identifiers,images,productTypes,classifications,relationships",
    pageSize: 20
  };

  if (normalizedBrand) {
    query.brandNames = normalizedBrand;
  }

  return {
    query,
    normalizedKeywords,
    normalizedBrand
  };
}

export async function searchCatalogByIdentifier(
  identifier,
  identifierType = "UPC"
) {
  return searchCatalogItems({
    identifiers: identifier,
    identifiersType: identifierType
  });
}

const ALLOWED_IDENTIFIER_TYPES = new Set([
  "ASIN",
  "EAN",
  "GTIN",
  "ISBN",
  "JAN",
  "MINSAN",
  "SKU",
  "UPC"
]);

const ALLOWED_AMAZON_ERROR_TYPES = new Set([
  "AccessDenied",
  "Forbidden",
  "InvalidInput",
  "InvalidMarketplace",
  "InvalidMarketplaceId",
  "QuotaExceeded",
  "Throttled",
  "TooManyRequests",
  "Unauthorized"
]);

function amazonCatalogErrorType(data) {
  if (!data || typeof data !== "object") return null;

  const candidates = [
    data.code,
    data.error,
    data.errorCode,
    data.type,
    data.errors?.[0]?.code,
    data.errors?.[0]?.type
  ];

  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (ALLOWED_AMAZON_ERROR_TYPES.has(value)) return value;
  }

  return null;
}

function catalogErrorForStatus(status) {
  if (status === 401) {
    return {
      error_code: "AMAZON_AUTH_ERROR",
      error: "Amazon authentication failed."
    };
  }

  if (status === 403) {
    return {
      error_code: "AMAZON_CATALOG_PERMISSION_ERROR",
      error: "Amazon catalog permission denied."
    };
  }

  if (status === 429) {
    return {
      error_code: "AMAZON_RATE_LIMIT_ERROR",
      error: "Amazon catalog rate limit exceeded."
    };
  }

  return {
    error_code: "AMAZON_CATALOG_ERROR",
    error: "Amazon catalog search failed."
  };
}

function flattenCatalogIdentifiers(groups = []) {
  const identifiers = [];

  for (const group of groups) {
    for (const entry of group?.identifiers || []) {
      identifiers.push({
        type: entry.identifierType || null,
        value: entry.identifier || null
      });
    }
  }

  return identifiers;
}

function extractAmazonImages(item = {}, marketplaceId) {
  const imageGroups = Array.isArray(item.images)
    ? item.images
    : Object.values(item.images || {});

  const marketplaceGroup =
    imageGroups.find(
      (group) => group?.marketplaceId === marketplaceId
    ) ||
    imageGroups[0] ||
    null;

  const rawImages = Array.isArray(marketplaceGroup?.images)
    ? marketplaceGroup.images
    : [];

  const normalizedImages = rawImages
    .map((image) => ({
      variant: image?.variant || image?.type || null,
      link: image?.link || image?.url || null,
      height: Number(image?.height) || null,
      width: Number(image?.width) || null
    }))
    .filter((image) => Boolean(image.link));

  const primaryImage =
    normalizedImages.find(
      (image) =>
        String(image.variant || "").toUpperCase() === "MAIN"
    ) ||
    normalizedImages.find(
      (image) =>
        String(image.variant || "").toUpperCase() === "PT01"
    ) ||
    [...normalizedImages].sort((a, b) => {
      const aArea =
        Number(a.width || 0) * Number(a.height || 0);

      const bArea =
        Number(b.width || 0) * Number(b.height || 0);

      return bArea - aArea;
    })[0] ||
    null;

  return {
    amazon_image: primaryImage?.link || null,

    amazon_additional_images: normalizedImages
      .filter((image) => image.link !== primaryImage?.link)
      .map((image) => image.link),

    amazon_images: normalizedImages,

    image_section_present: Boolean(marketplaceGroup),

    image_count: normalizedImages.length,

    image_parse_status:
      normalizedImages.length > 0
        ? "found"
        : marketplaceGroup
          ? "empty"
          : "missing"
  };
}

function extractParentAsin(item = {}, marketplaceId) {
  const relationshipGroup =
    item.relationships?.find(
      (entry) => entry?.marketplaceId === marketplaceId
    ) ||
    item.relationships?.[0] ||
    null;

  const relationships = Array.isArray(
    relationshipGroup?.relationships
  )
    ? relationshipGroup.relationships
    : [];

  const variationRelationship = relationships.find(
    (relationship) =>
      String(relationship?.type || "").toUpperCase() ===
      "VARIATION"
  );

  return variationRelationship?.parentAsins?.[0] || null;
}

function normalizeCatalogItem(item = {}) {
  const marketplaceId = getMarketplace();

  const summary =
    item.summaries?.find(
      (entry) => entry?.marketplaceId === marketplaceId
    ) ||
    item.summaries?.[0] ||
    {};

  const productType =
    item.productTypes?.find(
      (entry) => entry?.marketplaceId === marketplaceId
    ) ||
    item.productTypes?.[0] ||
    {};

  const imageEvidence = extractAmazonImages(
    item,
    marketplaceId
  );

  return {
    asin: item.asin || null,

    parent_asin: extractParentAsin(
      item,
      marketplaceId
    ),

    amazon_title:
      summary.itemName ||
      summary.itemNameText ||
      null,

    amazon_brand:
      summary.brand ||
      summary.manufacturer ||
      null,

    product_type:
      productType.productType ||
      null,

    identifiers: flattenCatalogIdentifiers(
      item.identifiers || []
    ),

    amazon_image:
      imageEvidence.amazon_image,

    amazon_additional_images:
      imageEvidence.amazon_additional_images,

    amazon_images:
      imageEvidence.amazon_images,

    marketplace_id:
      marketplaceId,

    evidence_source:
      "amazon_sp_api_catalog_items",

    evidence_retrieved_at:
      new Date().toISOString(),

    diagnostics: {
      requested_included_data:
        "summaries,identifiers,images,productTypes,classifications,relationships",

      image_section_present:
        imageEvidence.image_section_present,

      image_count:
        imageEvidence.image_count,

      image_parse_status:
        imageEvidence.image_parse_status,

      marketplace_id:
        marketplaceId
    }
  };
}

export async function searchCatalogItems(params = {}) {
  try {
    checkRuntimeCredentials();

    const hasIdentifierInput =
      params.identifiers !== undefined ||
      params.identifiersType !== undefined;

    const hasKeywordInput =
      params.keywords !== undefined ||
      params.brandNames !== undefined;

    if (
      hasIdentifierInput &&
      hasKeywordInput
    ) {
      return {
        success: false,
        error_code: "INVALID_REQUEST",
        error:
          "Use identifier search or keyword search, never both in the same request.",
        amazon_http_status: 400,
        amazon_error_type: "InvalidInput"
      };
    }

    let searchMode;
    let query;
    let normalizedIdentifier = null;
    let normalizedType = null;
    let normalizedKeywords = null;

    if (hasIdentifierInput) {
      const built =
        buildIdentifierCatalogQuery({
          identifier: params.identifiers,
          identifierType: params.identifiersType
        });

      searchMode = "IDENTIFIER";
      query = built.query;
      normalizedIdentifier =
        built.normalizedIdentifier;
      normalizedType =
        built.normalizedType;
    } else {
      const built =
        buildKeywordCatalogQuery({
          keywords: params.keywords,
          brandNames: params.brandNames
        });

      searchMode = "KEYWORD";
      query = built.query;
      normalizedKeywords =
        built.normalizedKeywords;
    }

    const result = await spApiCall(
      "GET",
      "/catalog/2022-04-01/items",
      query
    );

    if (!result.ok) {
      const details =
        amazonErrorDetails(result);

      return {
        success: false,
        ...catalogErrorForStatus(result.status),
        searchMode,
        amazon_http_status:
          result.status ?? null,
        upstreamStatus:
          result.status ?? null,
        amazon_error_type:
          amazonCatalogErrorType(result.data),
        amazon_error_code:
          details.code,
        amazon_error_message:
          details.message,
        amazon_request_id:
          details.requestId,
        amazon_error_details:
          details.details,
        upstreamBody:
          details.upstreamBody,
        requestPath:
          details.requestPath,
        requestQuery:
          details.requestQuery
      };
    }

    const rawItems =
      result.data?.items || [];

    const items =
      rawItems.map(normalizeCatalogItem);

    return {
      success: true,
      apiVersion: AMAZON_API_VERSION,
      searchMode,
      identifier:
        normalizedIdentifier,
      identifierType:
        normalizedType,
      keywords:
        normalizedKeywords,
      marketplaceId:
        getMarketplace(),
      numberOfResults:
        result.data?.numberOfResults ??
        items.length,
      items,
      matches: items,
      pagination:
        result.data?.pagination || null,
      refinements:
        result.data?.refinements || null,
      amazon_request_id:
        result.requestId || null
    };
  } catch (error) {
    return {
      success: false,
      error_code: "AMAZON_CATALOG_ERROR",
      error:
        error.message ||
        "Amazon catalog request failed.",
      amazon_http_status: null,
      upstreamStatus: null,
      amazon_error_type: null,
      amazon_error_code: null,
      amazon_error_message:
        error.message || null,
      amazon_request_id: null,
      amazon_error_details: null
    };
  }
}

export async function getListingRestrictions(
  asin,
  conditionType = "new_new"
) {
  try {
    checkRuntimeCredentials();

    const normalizedAsin = normalizeAsin(asin);

    const result = await spApiCall(
      "GET",
      "/listings/2021-08-01/restrictions",
      {
        asin: normalizedAsin,
        sellerId: getSellerId(),
        marketplaceIds: getMarketplace(),
        conditionType
      }
    );

    if (!result.ok) {
      return {
        success: false,
        asin: normalizedAsin,
        status: result.status,
        error: amazonError(result),
        data: result.data
      };
    }

    const restrictions = result.data?.restrictions || [];

    return {
      success: true,
      asin: normalizedAsin,
      conditionType,
      eligible: restrictions.length === 0,
      restrictions
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

function buildOfferOnlyBody(product = {}) {
  const marketplaceId = getMarketplace();
  const asin = normalizeAsin(product.asin || product.amazon_asin);
  const price = normalizeMoney(product.price || product.sale_price);

  const quantity = normalizeQuantity(
    product.quantity ??
      product.inventory_quantity ??
      product.inventoryQuantity
  );

  const conditionType =
    product.condition_type ||
    product.conditionType ||
    "new_new";

  return {
    // Amazon documents PRODUCT for offer-only listing submissions.
    productType: "PRODUCT",
    requirements: "LISTING_OFFER_ONLY",
    attributes: {
      condition_type: [
        {
          value: conditionType,
          marketplace_id: marketplaceId
        }
      ],
      merchant_suggested_asin: [
        {
          value: asin,
          marketplace_id: marketplaceId
        }
      ],
      fulfillment_availability: [
        {
          fulfillment_channel_code: "DEFAULT",
          quantity
        }
      ],
      purchasable_offer: [
        {
          audience: "ALL",
          currency: "USD",
          our_price: [
            {
              schedule: [
                {
                  value_with_tax: price
                }
              ]
            }
          ]
        }
      ]
    }
  };
}

async function submitOfferOnlyListing(product, validationPreview) {
  checkRuntimeCredentials();

  const sellerId = getSellerId();
  const sku = getProductSku(product);
  const asin = normalizeAsin(product.asin || product.amazon_asin);

  const path =
    `/listings/2021-08-01/items/` +
    `${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`;

  const query = {
    marketplaceIds: getMarketplace(),
    issueLocale: "en_US"
  };

  if (validationPreview)
     query.mode = "VALIDATION_PREVIEW";

  const body = buildOfferOnlyBody({
    ...product,
    asin
  });

  const result = await spApiCall("PUT", path, query, body);

  if (!result.ok) {
    return {
      success: false,
      preview: validationPreview,
      sku,
      asin,
      status: result.status,
      error: amazonError(result),
      data: result.data,
      requestBody: body
    };
  }

  const issues = result.data?.issues || [];
  const blockingIssues = issues.filter(
    (issue) => issue.severity === "ERROR"
  );

  return {
    success: blockingIssues.length === 0,
    preview: validationPreview,
    sku,
    asin,
    amazonStatus: result.data?.status || null,
    submissionId: result.data?.submissionId || null,
    issues,
    blockingIssueCount: blockingIssues.length,
    identifiers: result.data?.identifiers || [],
    data: result.data
  };
}

export async function previewOfferListing(product) {
  try {
    if (!product) {
      return {
        success: false,
        error: "Product is required"
      };
    }

    return await submitOfferOnlyListing(product, true);
  } catch (error) {
    return {
      success: false,
      preview: true,
      error: error.message
    };
  }
}

export async function createOfferListing(product) {
  try {
    if (!product) {
      return {
        success: false,
        error: "Product is required"
      };
    }

    const asin = normalizeAsin(product.asin || product.amazon_asin);

    const restrictions = await getListingRestrictions(
      asin,
      product.condition_type ||
        product.conditionType ||
        "new_new"
    );

    if (!restrictions.success) {
      return {
        success: false,
        stage: "RESTRICTIONS_CHECK",
        restrictions
      };
    }

    if (!restrictions.eligible) {
      return {
        success: false,
        stage: "RESTRICTED",
        asin,
        message:
          "Amazon requires approval or additional action before this ASIN can be listed.",
        restrictions: restrictions.restrictions
      };
    }

    const preview = await previewOfferListing(product);

    if (!preview.success) {
      return {
        success: false,
        stage: "VALIDATION_PREVIEW",
        asin,
        preview
      };
    }

    const submission = await submitOfferOnlyListing(product, false);

    return {
      ...submission,
      stage: submission.success ? "SUBMITTED" : "SUBMISSION_FAILED",
      restrictions,
      preview
    };
  } catch (error) {
    return {
      success: false,
      stage: "ERROR",
      error: error.message
    };
  }
}

function mapProductType(product = {}) {
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

  if (combined.includes("dress")) return "DRESS";

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

  return product.amazon_product_type || "PRODUCT";
}

function normalizeImages(product = {}) {
  if (Array.isArray(product.product_images)) {
    return product.product_images.filter(Boolean);
  }

  if (Array.isArray(product.images)) {
    return product.images.filter(Boolean);
  }

  if (product.image) return [product.image];
  return [];
}


function isBlankAmazonAttribute(value) {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function inferExternalIdentifierType(value) {
  const normalized = String(value || "").replace(/\D/g, "");

  if (normalized.length === 12) return "upc";
  if (normalized.length === 13) return "ean";
  if (normalized.length === 14) return "gtin";

  return "upc";
}

function normalizeCustomAmazonAttributes(customAttributes, marketplaceId) {
  if (!customAttributes || typeof customAttributes !== "object") {
    return {};
  }

  const textAttributes = new Set([
    "product_description",
    "fabric_type",
    "care_instructions",
    "color",
    "age_range_description",
    "department",
    "model_name",
    "style",
    "neck",
    "sleeve",
    "fit_type"
  ]);

  const controlledAttributes = new Set([
    "merchant_suggested_asin",
    "rise",
    "closure",
    "target_gender",
    "import_designation"
  ]);

  const normalized = {};

  for (const [name, rawValue] of Object.entries(customAttributes)) {
    if (isBlankAmazonAttribute(rawValue)) continue;

    // Preserve already-structured SP-API attribute arrays.
    if (
      Array.isArray(rawValue) &&
      rawValue.length > 0 &&
      rawValue.every(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          !Array.isArray(entry)
      )
    ) {
      normalized[name] = rawValue;
      continue;
    }

    if (name === "bullet_point") {
      const bulletValues = Array.isArray(rawValue)
        ? rawValue
        : String(rawValue)
            .split(/\r?\n/)
            .map((value) => value.trim())
            .filter(Boolean);

      normalized.bullet_point = bulletValues.map((value) => ({
        value: String(value),
        marketplace_id: marketplaceId,
        language_tag: "en_US"
      }));
      continue;
    }

    if (name === "list_price") {
      const amount =
        typeof rawValue === "object"
          ? Number(
              rawValue.amount ??
                rawValue.value_with_tax ??
                rawValue.value
            )
          : Number(rawValue);

      if (Number.isFinite(amount) && amount > 0) {
        normalized.list_price = [
          {
            value: [
              {
                amount: String(Number(amount.toFixed(2))),
                currency_code:
                  (typeof rawValue === "object" &&
                    (rawValue.currency_code || rawValue.currency)) ||
                  "USD"
              }
            ],
            marketplace_id: marketplaceId
          }
        ];
      }
      continue;
    }

    if (name === "externally_assigned_product_identifier") {
      const identifierValue =
        typeof rawValue === "object"
          ? rawValue.value ?? rawValue.identifier
          : rawValue;

      if (!isBlankAmazonAttribute(identifierValue)) {
        normalized.externally_assigned_product_identifier = [
          {
            type:
              (typeof rawValue === "object" &&
                (rawValue.type || rawValue.identifierType)) ||
              inferExternalIdentifierType(identifierValue),
            value: String(identifierValue).trim(),
            marketplace_id: marketplaceId
          }
        ];
      }
      continue;
    }

    if (name === "country_of_origin") {
      const countryCodes = {
        USA: "US",
        "UNITED STATES": "US",
        "UNITED STATES OF AMERICA": "US",
        CHINA: "CN",
        VIETNAM: "VN",
        "VIET NAM": "VN",
        BANGLADESH: "BD",
        INDIA: "IN",
        MEXICO: "MX",
        CAMBODIA: "KH",
        INDONESIA: "ID",
        TURKEY: "TR",
        PAKISTAN: "PK",
        TAIWAN: "TW",
        "SOUTH KOREA": "KR",
        KOREA: "KR",
        JAPAN: "JP",
        ITALY: "IT",
        SPAIN: "ES",
        PORTUGAL: "PT",
        FRANCE: "FR",
        "UNITED KINGDOM": "GB",
        UK: "GB",
        CANADA: "CA"
      };

      const rawCountry =
        typeof rawValue === "object"
          ? rawValue.value ?? rawValue.code
          : rawValue;

      const upperCountry = String(rawCountry || "")
        .trim()
        .toUpperCase();

      if (upperCountry) {
        normalized.country_of_origin = [
          {
            value:
              countryCodes[upperCountry] ||
              (upperCountry.length === 2
                ? upperCountry
                : String(rawCountry).trim()),
            marketplace_id: marketplaceId
          }
        ];
      }
      continue;
    }

    if (name === "shirt_size") {
      if (typeof rawValue === "object" && !Array.isArray(rawValue)) {
        normalized.shirt_size = [
          {
            ...rawValue,
            size_system: rawValue.size_system || "US",
            size_class: rawValue.size_class || "alpha",
            size: String(rawValue.size ?? rawValue.value ?? "").trim(),
            marketplace_id:
              rawValue.marketplace_id || marketplaceId
          }
        ];
      } else {
        normalized.shirt_size = [
          {
            size: String(rawValue).trim(),
            size_system: "US",
            size_class: "alpha",
            marketplace_id: marketplaceId
          }
        ];
      }
      continue;
    }

    if (name === "bottoms_size") {
      if (typeof rawValue === "object" && !Array.isArray(rawValue)) {
        normalized.bottoms_size = [
          {
            ...rawValue,
            marketplace_id:
              rawValue.marketplace_id || marketplaceId
          }
        ];
      } else {
        normalized.bottoms_size = [
          {
            size: String(rawValue).trim(),
            size_system: "US",
            size_class: "numeric",
            marketplace_id: marketplaceId
          }
        ];
      }
      continue;
    }

    const values = Array.isArray(rawValue) ? rawValue : [rawValue];

    if (textAttributes.has(name)) {
      normalized[name] = values
        .filter((value) => !isBlankAmazonAttribute(value))
        .map((value) => ({
          value: String(value),
          marketplace_id: marketplaceId,
          language_tag: "en_US"
        }));
      continue;
    }

    if (controlledAttributes.has(name)) {
      normalized[name] = values
        .filter((value) => !isBlankAmazonAttribute(value))
        .map((value) => ({
          value: String(value),
          marketplace_id: marketplaceId
        }));
      continue;
    }

    // Generic fallback for any additional attributes added later.
    normalized[name] = values
      .filter((value) => !isBlankAmazonAttribute(value))
      .map((value) => ({
        value:
          typeof value === "object"
            ? value.value ?? value
            : value,
        marketplace_id: marketplaceId
      }));
  }

  return normalized;
}

function buildListingBody(product = {}) {
  const marketplaceId = getMarketplace();

  const title = String(
    product.product_name ||
      product.productTitle ||
      product.title ||
      "The Outfit Vault Product"
  ).slice(0, 200);

  const price = normalizeMoney(product.sale_price || product.price);

  const quantity = normalizeQuantity(
    product.inventory_quantity ??
      product.inventoryQuantity
  );

  const images = normalizeImages(product);

  const attributes = {
    item_name: [
      {
        value: title,
        marketplace_id: marketplaceId,
        language_tag: "en_US"
      }
    ],
    brand: [
      {
        value:
          product.brand ||
          product.vendor ||
          "The Outfit Vault",
        marketplace_id: marketplaceId
      }
    ],
    condition_type: [
      {
        value: "new_new",
        marketplace_id: marketplaceId
      }
    ],
    fulfillment_availability: [
      {
        fulfillment_channel_code: "DEFAULT",
        quantity
      }
    ],
    purchasable_offer: [
      {
        audience: "ALL",
        currency: "USD",
        marketplace_id: marketplaceId,
        our_price: [
          {
            schedule: [
              {
                value_with_tax: price
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
        marketplace_id: marketplaceId,
        media_location: images[0]
      }
    ];
  }

  const customAttributes = normalizeCustomAmazonAttributes(
    product.attributes,
    marketplaceId
  );

  Object.assign(attributes, customAttributes);

  return {
    productType: mapProductType(product),
    requirements: "LISTING",
    attributes
  };
}

export async function publishListing(product) {
  try {
    checkRuntimeCredentials();

    if (!product) {
      return {
        success: false,
        error: "Product is required"
      };
    }

    const sellerId = getSellerId();
    const sku = getProductSku(product);

    const path =
      `/listings/2021-08-01/items/` +
      `${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`;

    const body = buildListingBody(product);

    const result = await spApiCall(
      "PUT",
      path,
      {
        marketplaceIds: getMarketplace(),
        includedData: "issues",
        issueLocale: "en_US"
      },
      body
    );

    if (!result.ok) {
      return {
        success: false,
        sku,
        status: result.status,
        error: amazonError(result),
        data: result.data
      };
    }

    return {
      success: true,
      apiVersion: AMAZON_API_VERSION,
      sku,
      status: result.data?.status || "SUBMITTED",
      issues: result.data?.issues || [],
      data: result.data
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function getExistingProductType(sku) {
  const sellerId = getSellerId();

  const path =
    `/listings/2021-08-01/items/` +
    `${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`;

  const result = await spApiCall("GET", path, {
    marketplaceIds: getMarketplace(),
    includedData: "summaries"
  });

  if (!result.ok) return "PRODUCT";

  return (
    result.data?.summaries?.[0]?.productType ||
    result.data?.productType ||
    "PRODUCT"
  );
}

export async function getListingStatus(sku) {
  try {
    checkRuntimeCredentials();

    const normalizedSku = normalizeSku(sku);

    const path =
      `/listings/2021-08-01/items/` +
      `${encodeURIComponent(getSellerId())}/${encodeURIComponent(
        normalizedSku
      )}`;

    const result = await spApiCall("GET", path, {
      marketplaceIds: getMarketplace(),
      includedData:
        "summaries,issues,attributes,offers,fulfillmentAvailability"
    });

    if (!result.ok) {
      return {
        success: false,
        sku: normalizedSku,
        status: result.status,
        error: amazonError(result),
        data: result.data
      };
    }

    return {
      success: true,
      sku: normalizedSku,
      data: result.data
    };
  } catch (error) {
    return {
      success: false,
      sku,
      error: error.message
    };
  }
}

export async function syncInventory(sku, quantity) {
  try {
    checkRuntimeCredentials();

    const normalizedSku = normalizeSku(sku);
    const productType = await getExistingProductType(normalizedSku);

    const path =
      `/listings/2021-08-01/items/` +
      `${encodeURIComponent(getSellerId())}/${encodeURIComponent(
        normalizedSku
      )}`;

    const body = {
      productType,
      patches: [
        {
          op: "replace",
          path: "/attributes/fulfillment_availability",
          value: [
            {
              fulfillment_channel_code: "DEFAULT",
              quantity: normalizeQuantity(quantity)
            }
          ]
        }
      ]
    };

    const result = await spApiCall(
      "PATCH",
      path,
      {
        marketplaceIds: getMarketplace(),
        includedData: "issues",
        issueLocale: "en_US"
      },
      body
    );

    return {
      success: result.ok,
      sku: normalizedSku,
      quantity: normalizeQuantity(quantity),
      status: result.status,
      error: result.ok ? null : amazonError(result),
      data: result.data
    };
  } catch (error) {
    return {
      success: false,
      sku,
      error: error.message
    };
  }
}

export async function syncPrice(sku, price) {
  try {
    checkRuntimeCredentials();

    const normalizedSku = normalizeSku(sku);
    const normalizedPrice = normalizeMoney(price);
    const productType = await getExistingProductType(normalizedSku);

    const path =
      `/listings/2021-08-01/items/` +
      `${encodeURIComponent(getSellerId())}/${encodeURIComponent(
        normalizedSku
      )}`;

    const body = {
      productType,
      patches: [
        {
          op: "replace",
          path: "/attributes/purchasable_offer",
          value: [
            {
              audience: "ALL",
              currency: "USD",
              our_price: [
                {
                  schedule: [
                    {
                      value_with_tax: normalizedPrice
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    };

    const result = await spApiCall(
      "PATCH",
      path,
      {
        marketplaceIds: getMarketplace(),
        includedData: "issues",
        issueLocale: "en_US"
      },
      body
    );

    return {
      success: result.ok,
      sku: normalizedSku,
      price: normalizedPrice,
      status: result.status,
      error: result.ok ? null : amazonError(result),
      data: result.data
    };
  } catch (error) {
    return {
      success: false,
      sku,
      error: error.message
    };
  }
}

export async function getOrders(createdAfter) {
  try {
    checkRuntimeCredentials();

    const result = await spApiCall(
      "GET",
      "/orders/v0/orders",
      {
        MarketplaceIds: getMarketplace(),
        CreatedAfter:
          createdAfter ||
          new Date(
            Date.now() -
              7 * 24 * 60 * 60 * 1000
          ).toISOString()
      }
    );

    if (!result.ok) {
      return {
        success: false,
        status: result.status,
        error: amazonError(result),
        data: result.data
      };
    }

    return {
      success: true,
      orders: result.data?.payload?.Orders || [],
      nextToken: result.data?.payload?.NextToken || null
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

export async function getOrderItems(orderId) {
  try {
    checkRuntimeCredentials();

    if (!orderId) {
      return {
        success: false,
        error: "Amazon order ID is required"
      };
    }

    const result = await spApiCall(
      "GET",
      `/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems`
    );

    if (!result.ok) {
      return {
        success: false,
        orderId,
        status: result.status,
        error: amazonError(result),
        data: result.data
      };
    }

    return {
      success: true,
      orderId,
      orderItems: result.data?.payload?.OrderItems || [],
      nextToken: result.data?.payload?.NextToken || null
    };
  } catch (error) {
    return {
      success: false,
      orderId,
      error: error.message
    };
  }
}

export async function updateAmazonTracking(
  orderId,
  trackingNumber,
  carrier
) {
  try {
    checkRuntimeCredentials();

    if (!orderId || !trackingNumber) {
      return {
        success: false,
        error: "orderId and trackingNumber are required"
      };
    }

    const orderItemsResult = await getOrderItems(orderId);

    if (!orderItemsResult.success) return orderItemsResult;

    const orderItems = orderItemsResult.orderItems.map((item) => ({
      orderItemId: item.OrderItemId,
      quantity: Number(item.QuantityOrdered) || 1
    }));

    const result = await spApiCall(
      "POST",
      `/orders/v0/orders/${encodeURIComponent(
        orderId
      )}/shipmentConfirmation`,
      {},
      {
        packageDetail: {
          packageReferenceId: "1",
          carrierCode: carrier || "UPS",
          shippingMethod: carrier || "Standard",
          trackingNumber,
          shipDate: new Date().toISOString(),
          orderItems
        },
        marketplaceId: getMarketplace()
      }
    );

    return {
      success: result.ok,
      orderId,
      trackingNumber,
      status: result.status,
      error: result.ok ? null : amazonError(result),
      data: result.data
    };
  } catch (error) {
    return {
      success: false,
      orderId,
      error: error.message
    };
  }
}

export function getAuthUrl(state, _redirectUri) {
  const applicationId = process.env.AMAZON_SPAPI_APP_ID;

  if (!applicationId) {
    throw new Error("Missing AMAZON_SPAPI_APP_ID");
  }

  const sellerCentralUrl =
    process.env.AMAZON_SELLER_CENTRAL_URL ||
    "https://sellercentral.amazon.com";

  const params = new URLSearchParams({
    application_id: applicationId,
    state: state || Math.random().toString(36).slice(2)
  });

  const appVersion = String(
    process.env.AMAZON_SPAPI_APP_VERSION || "beta"
  ).toLowerCase();

  if (appVersion === "beta") {
    params.set("version", "beta");
  }

  return (
    `${sellerCentralUrl}` +
    "/apps/authorize/consent?" +
    params.toString()
  );
}

export async function exchangeAuthCode(code, redirectUri) {
  checkLwaCredentials();

  if (!code) {
    throw new Error("Missing Amazon authorization code");
  }

  if (!redirectUri) {
    throw new Error("Missing Amazon OAuth redirect URI");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: process.env.AMAZON_LWA_CLIENT_ID,
    client_secret: process.env.AMAZON_LWA_CLIENT_SECRET
  });

  const response = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Accept: "application/json"
    },
    body: body.toString()
  });

  const responseText = await response.text();
  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      `Amazon token exchange returned invalid JSON: ${responseText}`
    );
  }

  if (!response.ok || !data.refresh_token) {
    throw new Error(
      `Amazon token exchange failed (${response.status}): ${JSON.stringify(
        data
      )}`
    );
  }

  return data;
}
