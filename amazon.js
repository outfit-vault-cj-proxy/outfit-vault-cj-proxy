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
  return {
    productType: mapProductType(product.category),
    requirements: "LISTING",
    attributes: attrs,
  };
}

export async function checkConnection() {
  try {
    checkCreds();
    await getLWAToken();
    await assumeRole();
    return { success: true, seller_id: getSellerId(), marketplace: getMarketplace() };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export async function publishListing(product) {
  const sellerId = getSellerId();
  const sku = product.amazon_sku || `OV-${product.id}`;
  const path = `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`;
  const body = buildListingBody({ ...product, amazon_sku: sku });
  const result = await spApiCall("PUT", path, {}, body);
  if (result.ok) return { success: true, sku, status: "LISTED" };
  return { success: false, sku, error: typeof result.data === "string" ? result.data : JSON.stringify(result.data), status: result.status };
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
