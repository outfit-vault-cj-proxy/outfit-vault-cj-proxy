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
  const res = await fetch(url, { method, headers: signedHeaders, body: bodyStr || undefined });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

function mapProductType(category) {
  const map = { Tops: "SHIRT", Bottoms: "PANTS", Dresses: "DRESS", Shoes: "SHOE", Accessories: "ACCESSORY", Outerwear: "OUTERWEAR" };
  return map[category] || "PRODUCT";
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
  ["product_description", "model_name", "color", "fabric_type", "care_instructions", "style", "merchant_suggested_asin", "externally_assigned_product_identifier", "closure", "rise", "neck", "sleeve", "fit_type"].forEach(textAttr);
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
  // shirt_size: complex attribute with size_system, size_class, size sub-properties
  if (extra.shirt_size) {
    attrs.shirt_size = [{
      marketplace_id: marketplaceId,
      size_system: "US",
      size_class: "alpha",
      size: String(extra.shirt_size),
    }];
  }
  // bottoms_size: complex attribute with size_system, size_class, size sub-properties
  if (extra.bottoms_size) {
    attrs.bottoms_size = [{
      marketplace_id: marketplaceId,
      size_system: "US",
      size_class: "numeric",
      size: String(extra.bottoms_size),
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

export async function getOrders(createdAfter) {
  const path = "/orders/v0/orders";
  const query = {
    MarketplaceIds: getMarketplace(),
    CreatedAfter: createdAfter || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
  const result = await spApiCall("GET", path, query);
  if (result.ok) return { success: true, orders: result.data?.payload?.Orders || [] };
  return { success: false, error: typeof result.data === "string" ? result.data : JSON.stringify(result.data) };
}

export async function updateAmazonTracking(orderId, trackingNumber, carrier) {
  const path = `/orders/v0/orders/${encodeURIComponent(orderId)}/shipment`;
  const body = {
    marketplaceId: getMarketplace(),
    packageDetails: {
      trackingNumber,
      carrierCode: carrier || "UPS",
    },
  };
  const result = await spApiCall("POST", path, {}, body);
  if (result.ok) return { success: true, orderId, trackingNumber };
  return { success: false, orderId, error: typeof result.data === "string" ? result.data : JSON.stringify(result.data) };
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

export async function searchCatalogItems(params) {
  const marketplaceId = getMarketplace();
  const query = { marketplaceIds: marketplaceId, includedData: "summaries,identifiers,productTypes" };

  if (params.identifiers && params.identifiersType) {
    query.identifiers = String(params.identifiers);
    query.identifiersType = String(params.identifiersType).toUpperCase();
  } else if (params.keywords || params.brandNames) {
    if (params.keywords) query.keywords = String(params.keywords);
    if (params.brandNames) query.brandNames = String(params.brandNames);
  } else {
    return { success: false, error_code: "AMAZON_CATALOG_ERROR", error: "Missing search parameters." };
  }

  let result;
  try {
    result = await spApiCall("GET", "/catalog/2022-04-01/items", query);
  } catch (_e) {
    return { success: false, error_code: "AMAZON_CATALOG_ERROR", error: "Amazon catalog request failed.", amazon_http_status: null, amazon_error_type: null };
  }

  if (!result.ok) {
    const status = result.status;
    let error_code = "AMAZON_CATALOG_ERROR";
    let error = "Amazon catalog search failed.";
    if (status === 401) { error_code = "AMAZON_AUTH_ERROR"; error = "Amazon authentication failed."; }
    else if (status === 403) { error_code = "AMAZON_CATALOG_PERMISSION_ERROR"; error = "Amazon catalog permission denied."; }
    else if (status === 429) { error_code = "AMAZON_RATE_LIMIT_ERROR"; error = "Amazon rate limit exceeded."; }
    return {
      success: false,
      error_code,
      error,
      amazon_http_status: result.status || null,
      amazon_error_type: extractAmazonErrorType(result.data),
    };
  }

  const items = (result.data?.items || []).map((it) => {
    const s = (it.summaries || [])[0] || {};
    const pt = (it.productTypes || [])[0] || {};
    const idents = [];
    for (const grp of (it.identifiers || [])) {
      for (const id of (grp.identifiers || [])) {
        idents.push({ type: id.identifierType, value: id.identifier });
      }
    }
    return {
      asin: it.asin || null,
      parent_asin: null,
      amazon_title: s.itemName || null,
      amazon_brand: s.brand || null,
      product_type: pt.productType || null,
      identifiers: idents,
    };
  });

  return { success: true, numberOfResults: result.data?.numberOfResults || items.length, items };
}

// ===== Product Type Definitions API (read-only) =====
// Fetches the full product type definition (valid enum values, required
// attributes, property shapes) for a given product type. Used to verify
// exact accepted values for complex attributes like bottoms_size.
export async function getProductTypeDefinition(productType) {
  const pt = productType || "PANTS";
  const marketplaceId = getMarketplace();
  const result = await spApiCall("GET", `/definitions/2020-09-01/productTypes/${encodeURIComponent(pt)}`, {
    marketplaceIds: marketplaceId,
    requirements: "LISTING",
    locale: "en_US",
  });
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
