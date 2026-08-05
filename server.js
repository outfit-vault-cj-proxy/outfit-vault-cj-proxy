import crypto from "crypto";

const SPAPI_HOST = "sellingpartnerapi-na.amazon.com";
const SPAPI_REGION = "us-east-1";
const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const STS_URL = "https://sts.amazonaws.com/";
const DEFAULT_MARKETPLACE = "ATVPDKIKX0DER";

let cachedLWAToken = null;
let lwaExpiresAt = 0;
let cachedRoleCreds = null;
let roleCredsExpiresAt = 0;

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function uriEncode(str, encodeSlash = true) {
  let result = encodeURIComponent(String(str));
  result = result.replace(/!/g, "%27").replace(/\*/g, "%2A").replace(/\(/g, "%28").replace(/\)/g, "%29");
  if (!encodeSlash) result = result.replace(/%2F/g, "/");
  return result;
}

function getMarketplace() {
  return process.env.AMAZON_MARKETPLACE_ID || DEFAULT_MARKETPLACE;
}

function getSellerId() {
  return process.env.AMAZON_SELLER_ID;
}

function checkCreds() {
  const missing = [
    "AMAZON_LWA_CLIENT_ID",
    "AMAZON_LWA_CLIENT_SECRET",
    "AMAZON_LWA_REFRESH_TOKEN",
    "AMAZON_SPAPI_ACCESS_KEY",
    "AMAZON_SPAPI_SECRET_KEY",
    "AMAZON_SPAPI_ROLE_ARN",
    "AMAZON_SELLER_ID",
  ].filter((k) => !process.env[k]);
  if (missing.length) throw new Error("Missing Amazon env vars: " + missing.join(", "));
}

async function getLWAToken() {
  if (cachedLWAToken && Date.now() < lwaExpiresAt) return cachedLWAToken;
  checkCreds();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: process.env.AMAZON_LWA_REFRESH_TOKEN,
    client_id: process.env.AMAZON_LWA_CLIENT_ID,
    client_secret: process.env.AMAZON_LWA_CLIENT_SECRET,
  });
  const res = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error("LWA token failed: " + JSON.stringify(data));
  cachedLWAToken = data.access_token;
  lwaExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedLWAToken;
}

async function assumeRole() {
  if (cachedRoleCreds && Date.now() < roleCredsExpiresAt) return cachedRoleCreds;
  checkCreds();
  const roleArn = process.env.AMAZON_SPAPI_ROLE_ARN;
  const body = `Action=AssumeRole&Version=2011-06-15&RoleArn=${encodeURIComponent(roleArn)}&RoleSessionName=OutfitVaultSession&DurationSeconds=3600`;
  const headers = sigv4Sign("POST", STS_URL, {}, body, process.env.AMAZON_SPAPI_ACCESS_KEY, process.env.AMAZON_SPAPI_SECRET_KEY, null, "us-east-1", "sts");
  headers["Content-Type"] = "application/x-www-form-urlencoded";
  const res = await fetch(STS_URL, { method: "POST", headers, body });
  const xml = await res.text();
  if (!res.ok) throw new Error("STS AssumeRole failed: " + xml);
  const accessKeyId = xml.match(/<AccessKeyId>([^<]+)<\/AccessKeyId>/)?.[1];
  const secretAccessKey = xml.match(/<SecretAccessKey>([^<]+)<\/SecretAccessKey>/)?.[1];
  const sessionToken = xml.match(/<SessionToken>([^<]+)<\/SessionToken>/)?.[1];
  const expiration = xml.match(/<Expiration>([^<]+)<\/Expiration>/)?.[1];
  if (!accessKeyId || !secretAccessKey || !sessionToken) throw new Error("STS parse failed: " + xml);
  cachedRoleCreds = { accessKeyId, secretAccessKey, sessionToken };
  roleCredsExpiresAt = new Date(expiration).getTime() - 5 * 60 * 1000;
  return cachedRoleCreds;
}

function sigv4Sign(method, url, headers, body, accessKey, secretKey, sessionToken, region, service) {
  const urlObj = new URL(url);
  const host = urlObj.host;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const headersToSign = { host, "x-amz-date": amzDate, ...headers };
  if (sessionToken) headersToSign["x-amz-security-token"] = sessionToken;

  const sortedKeys = Object.keys(headersToSign).map((k) => k.toLowerCase()).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${String(headersToSign[k]).trim()}\n`).join("");
  const signedHeaders = sortedKeys.join(";");

  const payloadHash = sha256Hex(body || "");
  const queryParams = [];
  for (const [k, v] of urlObj.searchParams.entries()) {
    queryParams.push(`${uriEncode(k)}=${uriEncode(v)}`);
  }
  queryParams.sort();
  const canonicalQuery = queryParams.join("&");
  const canonicalUri = uriEncode(urlObj.pathname, false) || "/";

  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac("AWS4" + secretKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const resultHeaders = { ...headersToSign };
  resultHeaders["authorization"] = authorization;
  resultHeaders["x-amz-content-sha256"] = payloadHash;
  return resultHeaders;
}

async function spApiCall(method, path, query = {}, body = null) {
  const lwaToken = await getLWAToken();
  const roleCreds = await assumeRole();
  const queryString = Object.entries(query).map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join("&");
  const url = `https://${SPAPI_HOST}${path}${queryString ? "?" + queryString : ""}`;
  const bodyStr = body ? JSON.stringify(body) : "";
  const headers = { "x-amz-access-token": lwaToken };
  if (body) headers["content-type"] = "application/json";
  const signedHeaders = sigv4Sign(method, url, headers, bodyStr, roleCreds.accessKeyId, roleCreds.secretAccessKey, roleCreds.sessionToken, SPAPI_REGION, "execute-api");
  const res = await fetch(url, { method, headers: signedHeaders, body: bodyStr || undefined, signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

function mapProductType(category) {
  const map = { Tops: "SHIRT", Bottoms: "PANTS", Dresses: "DRESS", Shoes: "SHOE", Accessories: "ACCESSORY", Outerwear: "OUTERWEAR" };
  return map[category] || "PRODUCT";
}

// Normalize alpha apparel sizes (S, M, L, XL, etc.) to Amazon's lowercase enum values.
function normalizeAlphaSize(value) {
  const normalized = String(value || "").trim().toUpperCase();
  const map = {
    "EXTRA SMALL": "xs",
    "XS": "xs",
    "SMALL": "s",
    "S": "s",
    "MEDIUM": "m",
    "M": "m",
    "LARGE": "l",
    "L": "l",
    "EXTRA LARGE": "xl",
    "XL": "xl",
    "XXL": "xxl",
    "2XL": "xxl",
  };
  return map[normalized] || normalized.toLowerCase();
}

// Build structured shirt_size attribute for tops. Uses lowercase enum values
// per Amazon convention; the live Product Type Definition is the source of truth.
function buildAmazonShirtSize(size) {
  return [{
    marketplace_id: getMarketplace(),
    size_system: "us",
    size_class: "alpha",
    size: normalizeAlphaSize(size),
  }];
}

// Build structured bottoms_size attribute for pants/shorts/skirts.
function buildAmazonBottomsSize(size) {
  return [{
    marketplace_id: getMarketplace(),
    size_system: "us",
    size_class: "alpha",
    size: normalizeAlphaSize(size),
  }];
}

function detectAmazonProductType(product) {
  return mapProductType(product.category);
}

function isBottomProduct(productType) {
  return ["PANTS", "SHORTS", "SKIRT"].includes(productType);
}

function isTopProduct(productType) {
  return ["SHIRT", "SWEATER", "T_SHIRT", "OUTERWEAR", "DRESS"].includes(productType);
}

function buildListingBody(product) {
  const marketplaceId = getMarketplace();
  const price = String(product.sale_price || product.price || 0);
  const attrs = {
    item_name: [{ value: String(product.product_name).slice(0, 200), marketplace_id: marketplaceId, language_tag: "en_US" }],
    brand: [{ value: product.brand || "The Outfit Vault" }],
    fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: Number(product.inventory_quantity) || 0 }],
    purchasable_offer: [{
      marketplace_id: marketplaceId,
      currency: "USD",
      our_price: [{ amount: price, currency_code: "USD" }],
    }],
  };
  if (product.description) {
    attrs.item_description = [{ value: String(product.description).slice(0, 2000), marketplace_id: marketplaceId, language_tag: "en_US" }];
  }
  if (product.product_images && product.product_images.length) {
    attrs.main_product_image_locator = [{ marketplace_id: marketplaceId, value: product.product_images[0] }];
    if (product.product_images.length > 1) {
      attrs.other_product_image_locator_1 = [{ marketplace_id: marketplaceId, value: product.product_images[1] }];
    }
  }

  // Merge admin-provided Amazon attributes from the Complete Attributes form.
  const extra = product.attributes || {};
  const textAttr = (key) => {
    if (extra[key]) attrs[key] = [{ value: String(extra[key]).slice(0, 2000), marketplace_id: marketplaceId, language_tag: "en_US" }];
  };
  const plainAttr = (key) => {
    if (extra[key]) attrs[key] = [{ value: String(extra[key]), marketplace_id: marketplaceId }];
  };
  // Localized text + localized enums (need language_tag)
  ["product_description", "model_name", "color", "fabric_type", "care_instructions", "style", "merchant_suggested_asin", "closure", "rise", "neck", "sleeve", "fit_type"].forEach(textAttr);
  // Global enums (no language_tag)
  ["target_gender", "age_range_description", "department", "import_designation"].forEach(plainAttr);
  if (Array.isArray(extra.bullet_point) && extra.bullet_point.filter(Boolean).length) {
    attrs.bullet_point = extra.bullet_point.filter(Boolean).slice(0, 5).map((bp) => ({ value: String(bp).slice(0, 500), marketplace_id: marketplaceId, language_tag: "en_US" }));
  }
  // list_price: Amazon expects value as an array of { amount, currency_code }
  if (extra.list_price) {
    attrs.list_price = [{ value: [{ amount: String(extra.list_price), currency_code: "USD" }], marketplace_id: marketplaceId }];
  }
  // country_of_origin: normalize country names to ISO 3166-1 alpha-2 codes
  const COUNTRY_CODES = { "USA": "US", "UNITED STATES": "US", "UNITED STATES OF AMERICA": "US", "CHINA": "CN", "VIETNAM": "VN", "VIET NAM": "VN", "BANGLADESH": "BD", "INDIA": "IN", "MEXICO": "MX", "CAMBODIA": "KH", "INDONESIA": "ID", "TURKEY": "TR", "PAKISTAN": "PK", "TAIWAN": "TW", "SOUTH KOREA": "KR", "KOREA": "KR", "JAPAN": "JP", "ITALY": "IT", "SPAIN": "ES", "PORTUGAL": "PT", "FRANCE": "FR", "UNITED KINGDOM": "GB", "UK": "GB", "CANADA": "CA" };
  if (extra.country_of_origin) {
    const raw = String(extra.country_of_origin).trim().toUpperCase();
    const origin = COUNTRY_CODES[raw] || (raw.length === 2 ? raw : String(extra.country_of_origin));
    attrs.country_of_origin = [{ value: origin, marketplace_id: marketplaceId, language_tag: "en_US" }];
  }
  // Structured size attribute — build from product.size using the correct field
  // for the detected product type. Size enums come from the live Product Type
  // Definition (passed as product.size_system / product.size_class), falling
  // back to lowercase defaults if not provided.
  const productType = detectAmazonProductType(product);
  if (isBottomProduct(productType) && product.size) {
    attrs.bottoms_size = [{
      marketplace_id: marketplaceId,
      size_system: product.size_system || "us",
      size_class: product.size_class || "alpha",
      size: normalizeAlphaSize(product.size),
    }];
    delete attrs.shirt_size;
  }
  if (isTopProduct(productType) && product.size) {
    attrs.shirt_size = [{
      marketplace_id: marketplaceId,
      size_system: product.size_system || "us",
      size_class: product.size_class || "alpha",
      size: normalizeAlphaSize(product.size),
    }];
    delete attrs.bottoms_size;
  }

  // externally_assigned_product_identifier: structured object (type + value),
  // not a plain string. Use the UPC here — never put it in merchant_suggested_asin
  // (ASIN and UPC are different identifiers). For a brand-new listing, omit
  // merchant_suggested_asin unless Amazon explicitly returned a valid ASIN.
  if (product.upc) {
    attrs.externally_assigned_product_identifier = [{
      type: "upc",
      value: String(product.upc),
    }];
  }

  return {
    productType: mapProductType(product.category),
    requirements: "LISTING",
    attributes: attrs,
  };
}

// Read-only connection test for the private, self-authorized SP-API app.
// Exchanges the LWA refresh token for an access token, assumes the IAM role,
// and calls a safe read-only SP-API endpoint (list orders, last 7 days).
// Returns only booleans + a sanitized error_code — never the client secret,
// refresh token, access token, or AWS credentials.
export async function checkConnection() {
  const marketplaceId = getMarketplace();
  const sellerId = getSellerId();
  const result = {
    connected: false,
    marketplace_id: marketplaceId,
    seller_id_present: !!sellerId,
    lwa_token_generated: false,
    spapi_test_succeeded: false,
  };

  // 1. Refresh token present?
  if (!process.env.AMAZON_LWA_REFRESH_TOKEN) {
    return { ...result, error_code: "AMAZON_REFRESH_TOKEN_MISSING", error: "Amazon refresh token is not configured." };
  }

  // 2. LWA client credentials present?
  if (!process.env.AMAZON_LWA_CLIENT_ID || !process.env.AMAZON_LWA_CLIENT_SECRET) {
    return { ...result, error_code: "AMAZON_LWA_AUTH_FAILED", error: "Amazon LWA client credentials are not configured." };
  }

  // 3. Exchange the refresh token for an LWA access token (proves LWA credentials).
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: process.env.AMAZON_LWA_REFRESH_TOKEN,
      client_id: process.env.AMAZON_LWA_CLIENT_ID,
      client_secret: process.env.AMAZON_LWA_CLIENT_SECRET,
    });
    const res = await fetch(LWA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      return { ...result, error_code: "AMAZON_LWA_AUTH_FAILED", error: "Amazon LWA token exchange failed." };
    }
    cachedLWAToken = data.access_token;
    lwaExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
    result.lwa_token_generated = true;
  } catch (_e) {
    return { ...result, error_code: "AMAZON_LWA_AUTH_FAILED", error: "Amazon LWA token exchange failed." };
  }

  // 4. SP-API IAM role credentials present?
  if (!process.env.AMAZON_SPAPI_ACCESS_KEY || !process.env.AMAZON_SPAPI_SECRET_KEY || !process.env.AMAZON_SPAPI_ROLE_ARN) {
    return { ...result, error_code: "AMAZON_SPAPI_CREDENTIALS_MISSING", error: "Amazon SP-API IAM credentials are not configured." };
  }

  // 5. Call a safe read-only SP-API endpoint (list orders, last 7 days).
  try {
    const callResult = await spApiCall("GET", "/orders/v0/orders", {
      MarketplaceIds: marketplaceId,
      CreatedAfter: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    if (!callResult.ok) {
      const status = callResult.status;
      if (status === 401 || status === 403) {
        return { ...result, error_code: "AMAZON_SPAPI_PERMISSION_DENIED", error: "Amazon SP-API denied the read-only test request." };
      }
      return { ...result, error_code: "AMAZON_SPAPI_REQUEST_FAILED", error: "Amazon SP-API read-only test request failed." };
    }
    result.spapi_test_succeeded = true;
    result.connected = true;
    return result;
  } catch (e) {
    const msg = String(e?.message || "");
    if (/STS|AssumeRole|AccessKey|SecretAccessKey|parse failed/i.test(msg)) {
      return { ...result, error_code: "AMAZON_SPAPI_CREDENTIALS_MISSING", error: "Amazon SP-API IAM role assumption failed." };
    }
    return { ...result, error_code: "AMAZON_SPAPI_REQUEST_FAILED", error: "Amazon SP-API read-only test request failed." };
  }
}

export async function publishListing(product) {
  const sellerId = getSellerId();
  const sku = product.amazon_sku || `OV-${product.id}`;
  const path = `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`;
  const body = buildListingBody({ ...product, amazon_sku: sku });
  const result = await spApiCall("PUT", path, {}, body);
  if (result.ok) {
    const data = result.data || {};
    const issues = Array.isArray(data.issues) ? data.issues : [];
    return { success: issues.length === 0, sku, status: data.status || (issues.length ? "INVALID" : "LISTED"), issues, submissionId: data.submissionId || null };
  }
  const errData = result.data || {};
  const issues = Array.isArray(errData.issues) ? errData.issues : [];
  return { success: false, sku, status: "ERROR", issues, error: typeof errData === "string" ? errData : JSON.stringify(errData).slice(0, 4000), httpStatus: result.status };
}

export async function syncInventory(sku, quantity) {
  const sellerId = getSellerId();
  const path = `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`;
  const body = {
    productType: "PRODUCT",
    requirements: "LISTING",
    attributes: {
      fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: Number(quantity) || 0 }],
    },
  };
  const result = await spApiCall("PATCH", path, { mode: "PARTIAL" }, body);
  if (result.ok) return { success: true, sku, quantity };
  return { success: false, sku, error: typeof result.data === "string" ? result.data : JSON.stringify(result.data) };
}

export async function syncPrice(sku, price) {
  const sellerId = getSellerId();
  const path = `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`;
  const body = {
    productType: "PRODUCT",
    requirements: "LISTING",
    attributes: {
      purchasable_offer: [{
        marketplace_id: getMarketplace(),
        currency: "USD",
        our_price: [{ amount: String(price), currency_code: "USD" }],
      }],
    },
  };
  const result = await spApiCall("PATCH", path, { mode: "PARTIAL" }, body);
  if (result.ok) return { success: true, sku, price };
  return { success: false, sku, error: typeof result.data === "string" ? result.data : JSON.stringify(result.data) };
}

export async function getListingStatus(sku) {
  const sellerId = getSellerId();
  const path = `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`;
  const result = await spApiCall("GET", path, { marketplaceIds: getMarketplace(), includedData: "summaries" });
  if (result.ok) return { success: true, sku, data: result.data };
  return { success: false, sku, error: typeof result.data === "string" ? result.data : JSON.stringify(result.data) };
}

// ===== Phase 1: Paginated orders, order items, shipment confirmation =====
const AMAZON_ORDER_PAGE_LIMIT = 100;
const AMAZON_MAX_ORDER_PAGES = 50;
const AMAZON_MAX_ITEM_PAGES = 50;

function assertNonEmptyString(value, fieldName) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${fieldName} is required`);
  return normalized;
}

function normalizeAmazonCarrier(carrier) {
  const raw = String(carrier || "").trim();
  const upper = raw.toUpperCase();
  const known = new Map([
    ["UPS", "UPS"], ["USPS", "USPS"], ["FEDEX", "FedEx"], ["FED EX", "FedEx"],
    ["DHL", "DHL"], ["DHL ECOMMERCE", "DHL eCommerce"], ["ONTRAC", "OnTrac"],
    ["LASERSHIP", "LaserShip"], ["AMAZON LOGISTICS", "Amazon Logistics"],
  ]);
  const carrierCode = known.get(upper);
  if (carrierCode) return { carrierCode, carrierName: carrierCode };
  return { carrierCode: "Other", carrierName: raw || "Other" };
}

export async function getOrdersPaginated({ createdAfter, lastUpdatedAfter, maxPages = AMAZON_MAX_ORDER_PAGES } = {}) {
  const marketplaceId = getMarketplace();
  if (createdAfter && lastUpdatedAfter) throw new Error("Use createdAfter or lastUpdatedAfter, not both");
  const baseQuery = { MarketplaceIds: marketplaceId, MaxResultsPerPage: AMAZON_ORDER_PAGE_LIMIT };
  if (lastUpdatedAfter) baseQuery.LastUpdatedAfter = new Date(lastUpdatedAfter).toISOString();
  else baseQuery.CreatedAfter = new Date(createdAfter || Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const orders = [];
  let nextToken = null;
  let pageCount = 0;
  do {
    if (pageCount >= maxPages) {
      return { success: false, error_code: "AMAZON_ORDER_PAGE_LIMIT_REACHED", error: `Stopped after ${maxPages} pages to prevent an unbounded sync.`, orders, nextToken, pageCount };
    }
    const query = nextToken ? { NextToken: nextToken } : baseQuery;
    const result = await spApiCall("GET", "/orders/v0/orders", query);
    if (!result.ok) {
      return { success: false, error_code: "AMAZON_ORDERS_REQUEST_FAILED", error: typeof result.data === "string" ? result.data : JSON.stringify(result.data).slice(0, 4000), httpStatus: result.status, orders, nextToken, pageCount };
    }
    const payload = result.data?.payload || {};
    orders.push(...(Array.isArray(payload.Orders) ? payload.Orders : []));
    nextToken = payload.NextToken || null;
    pageCount += 1;
  } while (nextToken);
  return { success: true, orders, nextToken: null, pageCount };
}

export async function getOrderItemsPaginated(orderId, { maxPages = AMAZON_MAX_ITEM_PAGES } = {}) {
  const safeOrderId = assertNonEmptyString(orderId, "orderId");
  const path = `/orders/v0/orders/${encodeURIComponent(safeOrderId)}/orderItems`;
  const items = [];
  let nextToken = null;
  let pageCount = 0;
  do {
    if (pageCount >= maxPages) {
      return { success: false, error_code: "AMAZON_ORDER_ITEM_PAGE_LIMIT_REACHED", error: `Stopped after ${maxPages} pages to prevent an unbounded sync.`, orderId: safeOrderId, items, nextToken, pageCount };
    }
    const query = nextToken ? { NextToken: nextToken } : {};
    const result = await spApiCall("GET", path, query);
    if (!result.ok) {
      return { success: false, error_code: "AMAZON_ORDER_ITEMS_REQUEST_FAILED", error: typeof result.data === "string" ? result.data : JSON.stringify(result.data).slice(0, 4000), httpStatus: result.status, orderId: safeOrderId, items, nextToken, pageCount };
    }
    const payload = result.data?.payload || {};
    items.push(...(Array.isArray(payload.OrderItems) ? payload.OrderItems : []));
    nextToken = payload.NextToken || null;
    pageCount += 1;
  } while (nextToken);
  return { success: true, orderId: safeOrderId, items, nextToken: null, pageCount };
}

// Compatibility wrapper — keeps existing callers working
export async function getOrders(createdAfter) {
  return getOrdersPaginated({ createdAfter });
}

export async function confirmAmazonShipment({ orderId, trackingNumber, carrier, shipDate, packageReferenceId, shippingMethod, orderItems }) {
  const safeOrderId = assertNonEmptyString(orderId, "orderId");
  const safeTracking = assertNonEmptyString(trackingNumber, "trackingNumber");
  if (!Array.isArray(orderItems) || orderItems.length === 0) {
    throw new Error("orderItems is required and must include Amazon orderItemId values");
  }
  const normalizedItems = orderItems.map((item, index) => {
    const orderItemId = assertNonEmptyString(item?.orderItemId, `orderItems[${index}].orderItemId`);
    const quantity = Number(item?.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) throw new Error(`orderItems[${index}].quantity must be a positive integer`);
    return { orderItemId, quantity };
  });
  const carrierInfo = normalizeAmazonCarrier(carrier);
  const body = {
    marketplaceId: getMarketplace(),
    packageDetail: {
      packageReferenceId: String(packageReferenceId || `pkg-${Date.now()}`).slice(0, 100),
      carrierCode: carrierInfo.carrierCode,
      carrierName: carrierInfo.carrierName,
      shippingMethod: String(shippingMethod || "Standard").slice(0, 100),
      trackingNumber: safeTracking,
      shipDate: new Date(shipDate || Date.now()).toISOString(),
      orderItems: normalizedItems,
    },
  };
  const path = `/orders/v0/orders/${encodeURIComponent(safeOrderId)}/shipmentConfirmation`;
  const result = await spApiCall("POST", path, {}, body);
  if (result.ok || result.status === 204) {
    return { success: true, orderId: safeOrderId, trackingNumber: safeTracking, carrierCode: carrierInfo.carrierCode, itemCount: normalizedItems.length, httpStatus: result.status };
  }
  return { success: false, orderId: safeOrderId, error_code: "AMAZON_SHIPMENT_CONFIRMATION_FAILED", error: typeof result.data === "string" ? result.data : JSON.stringify(result.data).slice(0, 4000), httpStatus: result.status };
}

export function chooseAmazonImageGroup(imageGroups, marketplaceId = getMarketplace()) {
  const groups = Array.isArray(imageGroups) ? imageGroups : [];
  return groups.find((group) => group?.marketplaceId === marketplaceId) || groups[0] || {};
}

export function getAuthUrl(redirectUri) {
  const clientId = process.env.AMAZON_LWA_CLIENT_ID;
  if (!clientId) throw new Error("Missing AMAZON_LWA_CLIENT_ID");
  const params = new URLSearchParams({
    client_id: clientId,
    scope: "sellingpartnerapi::migration",
    response_type: "code",
    redirect_uri: redirectUri,
  });
  return `https://sellercentral.amazon.com/apps/external/consent?${params.toString()}`;
}

export async function exchangeAuthCode(code, redirectUri) {
  checkCreds();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: process.env.AMAZON_LWA_CLIENT_ID,
    client_secret: process.env.AMAZON_LWA_CLIENT_SECRET,
    redirect_uri: redirectUri,
  });
  const res = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json();
  if (!res.ok || !data.refresh_token) throw new Error("Token exchange failed: " + JSON.stringify(data));
  return data.refresh_token;
}

// ===== Catalog Items API (read-only) =====
// Used by the Amazon Qualification Engine Stage 1. Reuses spApiCall + sigv4.
// GET /catalog/2022-04-01/items supports identifier lookup and keyword/brand search.
// Errors are sanitized: no raw Amazon bodies, tokens, or headers are returned.
const SAFE_AMAZON_ERROR_TYPES = new Set([
  "Unauthorized", "InvalidInput", "Forbidden", "QuotaExceeded",
  "AccessDenied", "InvalidMarketplace", "InvalidParameter", "ResourceNotFound",
]);

// Extract a short, allowlisted Amazon error code/type from the Catalog Items
// response. Returns null for anything not in the safe set so no raw codes,
// messages, request IDs, or internal details are ever exposed.
function extractAmazonErrorType(data) {
  try {
    if (!data || typeof data !== "object") return null;
    const errs = Array.isArray(data.errors) ? data.errors : null;
    const code = errs && errs[0] ? errs[0].code : null;
    if (typeof code === "string" && SAFE_AMAZON_ERROR_TYPES.has(code)) return code;
    return null;
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// UPC normalization + clean query builder
// ---------------------------------------------------------------------------

// Normalize a UPC: convert to string, remove spaces and hyphens, preserve
// leading zeros, require digits only, validate 12-digit length.
// Returns the normalized string, or null if the value is not a valid UPC.
export function normalizeUpc(value) {
  const s = String(value || "").replace(/[\s-]/g, "");
  if (!/^\d{12}$/.test(s)) return null;
  return s;
}

// Build a clean SP-API query object: no undefined, no null, no empty strings,
// no arrays encoded as JSON strings. Arrays become comma-separated strings.
function buildCleanQuery(params) {
  const result = {};
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (typeof value === "string" && value === "") continue;
    if (Array.isArray(value)) {
      const filtered = value.filter(Boolean);
      if (!filtered.length) continue;
      result[key] = filtered.join(",");
      continue;
    }
    result[key] = String(value);
  }
  return result;
}

// Shared internal: call the Catalog Items API with retry + full error capture.
// `query` must already be a clean object (use buildCleanQuery).
async function searchCatalogInternal(query) {
  const upstreamPath = "/catalog/2022-04-01/items";
  console.log("[catalog-items] upstream request:", {
    marketplaceId: query.marketplaceIds,
    identifiers: query.identifiers || null,
    identifiersType: query.identifiersType || null,
    keywords: query.keywords || null,
    brandNames: query.brandNames || null,
    includedData: query.includedData || null,
    upstreamPath,
    upstreamHost: SPAPI_HOST,
  });

  const maxAttempts = 2; // one retry for transient gateway errors (502/503/504)
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let result;
    try {
      // spApiCall refreshes the LWA access token (getLWAToken) and assumes the
      // IAM role (assumeRole) before signing. SPAPI_HOST is the NA endpoint.
      result = await spApiCall("GET", upstreamPath, query);
    } catch (e) {
      lastError = e?.message || String(e);
      console.log(`[catalog-items] spApiCall exception (attempt ${attempt}):`, lastError);
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      return {
        success: false,
        status: 502,
        error: `Amazon catalog request failed: ${lastError}`,
        upstreamStatus: null,
        upstreamBody: null,
        requestId: null,
      };
    }

    const upstreamStatus = result.status;
    const isTransient = upstreamStatus === 502 || upstreamStatus === 503 || upstreamStatus === 504;

    if (!result.ok) {
      // Capture the full upstream body — handle both JSON and plain-text/HTML
      const upstreamBody = typeof result.data === "string"
        ? result.data.slice(0, 4000)
        : JSON.stringify(result.data).slice(0, 4000);
      const amazonErrorType = extractAmazonErrorType(result.data);
      const requestId = result.data?.errors?.[0]?.details?.requestId
        || result.data?.errors?.[0]?.messageId
        || null;

      console.log("[catalog-items] upstream non-2xx:", {
        upstreamStatus,
        upstreamBody: upstreamBody.slice(0, 500),
        requestId,
        attempt,
      });

      // Retry ONLY transient gateway errors (502/503/504) — not 400/401/403/429
      if (isTransient && attempt < maxAttempts) {
        console.log(`[catalog-items] retrying after ${upstreamStatus} (attempt ${attempt})`);
        await new Promise((r) => setTimeout(r, 1000));
        lastError = `upstream ${upstreamStatus}`;
        continue;
      }

      let error_code = "AMAZON_CATALOG_ERROR";
      let error = "Amazon catalog search failed.";
      if (upstreamStatus === 400) { error_code = "AMAZON_INVALID_INPUT"; error = "Amazon rejected the request as invalid input."; }
      else if (upstreamStatus === 401) { error_code = "AMAZON_AUTH_ERROR"; error = "Amazon authentication failed."; }
      else if (upstreamStatus === 403) { error_code = "AMAZON_CATALOG_PERMISSION_ERROR"; error = "Amazon catalog permission denied."; }
      else if (upstreamStatus === 429) { error_code = "AMAZON_RATE_LIMIT_ERROR"; error = "Amazon rate limit exceeded."; }
      else if (isTransient) { error_code = "AMAZON_GATEWAY_ERROR"; error = `Amazon returned gateway error ${upstreamStatus}.`; }

      return {
        success: false,
        status: 502,
        error_code,
        error,
        upstreamStatus,
        upstreamBody,
        amazon_error_type: amazonErrorType,
        requestId,
      };
    }

    // Success — parse items from the Amazon response
    const items = (result.data?.items || []).map((it) => {
      const s = (it.summaries || [])[0] || {};
      const pt = (it.productTypes || [])[0] || {};
      const idents = [];
      for (const grp of (it.identifiers || [])) {
        for (const id of (grp.identifiers || [])) {
          idents.push({ type: id.identifierType, value: id.identifier });
        }
      }
      // Extract main image from the images includedData
      const imageGroups = Array.isArray(it.images) ? it.images : [];
      const firstImageGroup = chooseAmazonImageGroup(imageGroups, getMarketplace());
      const imageArr = Array.isArray(firstImageGroup?.images) ? firstImageGroup.images : [];
      const mainImage = imageArr.find((img) => img?.variant === "MAIN") || imageArr[0];
      return {
        asin: it.asin || null,
        parent_asin: null,
        amazon_title: s.itemName || null,
        amazon_brand: s.brand || null,
        product_type: pt.productType || null,
        amazon_image: mainImage?.url || null,
        amazon_price: s?.price ? Number(s.price) : null,
        identifiers: idents,
      };
    });

    console.log("[catalog-items] success:", { upstreamStatus, itemsReturned: items.length, numberOfResults: result.data?.numberOfResults });

    return { success: true, numberOfResults: result.data?.numberOfResults || items.length, items, upstreamStatus };
  }

  // Exhausted retries
  return {
    success: false,
    status: 502,
    error: `Amazon catalog request failed after retry: ${lastError || "unknown"}`,
    upstreamStatus: null,
    upstreamBody: null,
    requestId: null,
  };
}

// Search by identifier (UPC/EAN/ASIN) — never combined with keywords or brandNames.
// Normalizes the identifier: removes spaces/hyphens, preserves leading zeros,
// validates format per type. Does NOT send a Shopify SKU as a UPC.
export async function searchByIdentifier({ identifier, identifiersType, marketplaceId }) {
  const mid = marketplaceId || getMarketplace();
  const type = String(identifiersType || "").toUpperCase();
  const rawId = String(identifier || "").replace(/[\s-]/g, "");

  if (!rawId) return { success: false, error_code: "AMAZON_CATALOG_ERROR", error: "Missing identifier value." };
  if (!type) return { success: false, error_code: "AMAZON_CATALOG_ERROR", error: "Missing identifiersType." };

  // Validate identifier format per type — reject before sending to Amazon
  if (type === "UPC" && !/^\d{12}$/.test(rawId)) {
    return { success: false, error_code: "AMAZON_INVALID_INPUT", error: `Invalid UPC (must be 12 digits): ${rawId}` };
  }
  if (type === "EAN" && !/^\d{13}$/.test(rawId)) {
    return { success: false, error_code: "AMAZON_INVALID_INPUT", error: `Invalid EAN (must be 13 digits): ${rawId}` };
  }
  if (type === "ASIN" && !/^[A-Z0-9]{10}$/.test(rawId)) {
    return { success: false, error_code: "AMAZON_INVALID_INPUT", error: `Invalid ASIN (must be 10 alphanumeric): ${rawId}` };
  }

  const query = buildCleanQuery({
    marketplaceIds: mid,
    identifiers: rawId,
    identifiersType: type,
    includedData: "summaries,identifiers,productTypes",
  });

  return await searchCatalogInternal(query);
}

// Search by keywords — never combined with identifiers.
export async function searchByKeywords({ keywords, marketplaceId, brandNames }) {
  const mid = marketplaceId || getMarketplace();
  const kw = String(keywords || "").trim();

  if (!kw) return { success: false, error_code: "AMAZON_CATALOG_ERROR", error: "Missing keywords." };

  const query = buildCleanQuery({
    marketplaceIds: mid,
    keywords: kw,
    includedData: "summaries,identifiers,productTypes,images",
  });

  if (Array.isArray(brandNames) && brandNames.filter(Boolean).length) {
    query.brandNames = brandNames.filter(Boolean).join(",");
  }

  return await searchCatalogInternal(query);
}

// Backward-compatible dispatcher: delegates to searchByIdentifier or
// searchByKeywords based on which params are present. Never combines both.
export async function searchCatalogItems(params) {
  const marketplaceId = getMarketplace();

  if (params.identifiers && params.identifiersType) {
    const type = String(params.identifiersType).toUpperCase();
    let identifier = params.identifiers;
    if (Array.isArray(identifier)) identifier = identifier[0];
    identifier = String(identifier || "").replace(/[\s-]/g, "");

    // UPC normalization: validate before sending; do not send SKU as UPC
    if (type === "UPC") {
      const normalized = normalizeUpc(identifier);
      if (!normalized) {
        return { success: false, error_code: "AMAZON_INVALID_INPUT", error: `Invalid UPC (must be 12 digits): ${identifier}` };
      }
      identifier = normalized;
    }

    return searchByIdentifier({ identifier, identifiersType: type, marketplaceId });
  }

  if (params.keywords || params.brandNames) {
    return searchByKeywords({
      keywords: params.keywords,
      marketplaceId,
      brandNames: params.brandNames,
    });
  }

  return { success: false, error_code: "AMAZON_CATALOG_ERROR", error: "Missing search parameters." };
}

// ===== Product Type Definitions API (read-only) =====
// Fetches the full product type definition (valid enum values, required
// attributes, property shapes) for a given product type. Used to verify
// exact accepted values for complex attributes like bottoms_size.
export async function getProductTypeDefinition(productType) {
  const pt = productType || "PANTS";
  const marketplaceId = getMarketplace();
  const sellerId = getSellerId();
  const query = {
    marketplaceIds: marketplaceId,
    requirements: "LISTING",
    locale: "en_US",
    requirementsEnforced: "ENFORCED",
  };
  if (sellerId) query.sellerId = sellerId;
  const result = await spApiCall("GET", `/definitions/2020-09-01/productTypes/${encodeURIComponent(pt)}`, query);
  if (!result.ok) {
    return { success: false, error: typeof result.data === "string" ? result.data : JSON.stringify(result.data).slice(0, 4000), status: result.status };
  }
  return { success: true, productType: pt, definition: result.data };
}

// ===== Offer-Only Listing (LISTING_OFFER_ONLY) — Staged with full diagnostics =====
// Attaches a seller offer to an existing Amazon ASIN without recreating
// the full product detail page. Used for approved IDENTIFIER_MATCH records
// with a verified ASIN. Returns complete nested diagnostics at each stage:
// RESTRICTIONS_CHECK, VALIDATION_PREVIEW, SUBMISSION_FAILED, or SUBMITTED.

async function putOfferOnlyListing(product) {
  const sellerId = getSellerId();
  const sku = product.amazon_sku || product.sku || `OV-${product.id || Date.now()}`;
  const path = `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`;
  const marketplaceId = getMarketplace();
  const price = String(product.price || 0);
  const quantity = Number(product.quantity) || 0;
  const asin = product.asin || product.amazon_asin;
  const conditionType = product.condition_type || "new_new";

  const body = {
    productType: product.productType || "PRODUCT",
    requirements: "LISTING_OFFER_ONLY",
    attributes: {
      merchant_suggested_asin: [{ value: asin, marketplace_id: marketplaceId }],
      purchasable_offer: [{
        marketplace_id: marketplaceId,
        currency: "USD",
        our_price: [{ amount: price, currency_code: "USD" }],
      }],
      fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity }],
      condition_type: [{ value: conditionType, marketplace_id: marketplaceId }],
    },
  };

  const result = await spApiCall("PUT", path, {}, body);
  return { result, sku, asin, marketplaceId };
}

async function checkOfferRestrictions(product) {
  const asin = product.asin || product.amazon_asin;
  if (!asin) {
    return { success: false, status: 400, error: "ASIN is required for restrictions check" };
  }
  try {
    const result = await searchCatalogItems({ identifiers: asin, identifiersType: "ASIN" });
    return result;
  } catch (e) {
    return { success: false, status: 502, error: e?.message || "Restrictions check threw an error", asin };
  }
}

async function previewOfferListing(product) {
  let putResult;
  try {
    putResult = await putOfferOnlyListing(product);
  } catch (e) {
    return { success: false, status: 502, error: e?.message || "Preview PUT threw an error", data: null };
  }
  const { result, sku, asin } = putResult;
  const data = result.data || {};
  const issues = Array.isArray(data.issues) ? data.issues : [];

  if (result.ok && issues.length === 0) {
    return { success: true, status: result.status, sku, asin, issues: [], data };
  }
  return {
    success: false,
    status: result.status || 422,
    error: typeof data === "string" ? data : (data?.errors?.[0]?.message || data?.message || "Amazon validation preview failed"),
    issues,
    data,
    sku,
    asin,
  };
}

async function submitOfferOnlyListing(product, dryRun) {
  let putResult;
  try {
    putResult = await putOfferOnlyListing(product);
  } catch (e) {
    return { success: false, status: 502, error: e?.message || "Submission PUT threw an error", data: null };
  }
  const { result, sku, asin } = putResult;
  const data = result.data || {};
  const issues = Array.isArray(data.issues) ? data.issues : [];

  if (result.ok && issues.length === 0) {
    return {
      success: true,
      status: result.status,
      sku,
      asin,
      stage: "SUBMITTED",
      amazonStatus: data.status || null,
      issues: [],
      submissionId: data.submissionId || null,
      data,
    };
  }
  return {
    success: false,
    status: result.status || 422,
    sku,
    asin,
    stage: "SUBMISSION_FAILED",
    amazonStatus: data.status || null,
    issues,
    error: typeof data === "string" ? data : (data?.errors?.[0]?.message || data?.message || "Amazon offer submission failed"),
    data,
  };
}

export async function createOfferListing(product) {
  const restrictions = await checkOfferRestrictions(product);
  if (!restrictions.success) {
    return {
      success: false,
      stage: "RESTRICTIONS_CHECK",
      status: restrictions.status || 502,
      error: restrictions.error || "Amazon restrictions check failed",
      restrictions,
    };
  }

  const preview = await previewOfferListing(product);
  if (!preview.success) {
    return {
      success: false,
      stage: "VALIDATION_PREVIEW",
      status: preview.status || 422,
      error: preview.error || "Amazon validation preview failed",
      issues: preview.issues || preview.data?.issues || [],
      preview,
    };
  }

  const submission = await submitOfferOnlyListing(product, false);
  if (!submission.success) {
    return {
      ...submission,
      success: false,
      stage: "SUBMISSION_FAILED",
      status: submission.status || 422,
      error: submission.error || "Amazon offer submission failed",
      restrictions,
      preview,
    };
  }

  return {
    ...submission,
    success: true,
    stage: "SUBMITTED",
    restrictions,
    preview,
  };
}

export async function createOffer(product) {
  return createOfferListing(product);
}
