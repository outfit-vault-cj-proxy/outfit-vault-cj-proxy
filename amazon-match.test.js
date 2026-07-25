// amazon-match.test.js
//
// Run with:  node --test proxy/amazon-match.test.js
//
// No external test framework required — uses Node's built-in test runner.
// All Amazon responses are mocked; no live SP-API calls are made.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeText,
  toArray,
  normalizeIdentifier,
  isValidIdentifier,
  extractAmazonIdentifiers,
  extractAmazonTitle,
  extractAmazonBrand,
  extractAmazonProductType,
  normalizeApparelCategory,
  categoriesConflict,
  calculateTextSimilarity,
  scoreAmazonCandidate,
  chooseBestAmazonMatch,
} from "./amazon-match.js";
import {
  createCatalogSearchHandler,
  createProductMatchHandler,
  createRematchAllHandler,
} from "./amazon-match-routes.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockRes() {
  const body = {};
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { body.payload = payload; return this; },
    get payload() { return body.payload; },
  };
  return res;
}

function mockReq(overrides = {}) {
  return {
    headers: {},
    query: {},
    body: {},
    get(name) { return this.headers[name.toLowerCase()]; },
    ...overrides,
  };
}

function amazonItem({ asin = "B0ABCDEFGHI", title = "", brand = "", productType = "", identifiers = [] } = {}) {
  return {
    asin,
    summaries: [{ marketplaceId: "ATVPDKIKX0DER", itemName: title, brand }],
    productTypes: [{ marketplaceId: "ATVPDKIKX0DER", productType }],
    identifiers: identifiers.length
      ? [{ marketplaceId: "ATVPDKIKX0DER", identifiers }]
      : [],
  };
}

function shopifyProduct(overrides = {}) {
  return {
    id: "gid://shopify/Product/1",
    title: "Women's Black Dress",
    vendor: "The Outfit Vault",
    productType: "Dresses",
    featuredImage: null,
    variants: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Identifier + text helpers
// ---------------------------------------------------------------------------

test("normalizeText lowercases and strips punctuation", () => {
  assert.equal(normalizeText("Women's Black_Dress-2pk"), "women s black dress 2pk");
  assert.equal(normalizeText("A & B"), "a and b");
  assert.equal(normalizeText(null), "");
});

test("toArray splits arrays and comma strings", () => {
  assert.deepEqual(toArray(["a", "b"]), ["a", "b"]);
  assert.deepEqual(toArray("a, b ,c"), ["a", "b", "c"]);
  assert.deepEqual(toArray(null), []);
});

test("normalizeIdentifier strips non-alphanumerics and uppercases", () => {
  assert.equal(normalizeIdentifier(" 012-345-678-905 "), "012345678905");
  assert.equal(normalizeIdentifier("b0abcdefg-h"), "B0ABCDEFGH");
});

test("isValidIdentifier validates by type", () => {
  assert.equal(isValidIdentifier("012345678905", "UPC"), true);
  assert.equal(isValidIdentifier("012345678905", "EAN"), false);
  assert.equal(isValidIdentifier("0123456789012", "EAN"), true);
  assert.equal(isValidIdentifier("B0ABCDEFGH", "ASIN"), true);
  assert.equal(isValidIdentifier("B0ABCDEFG", "ASIN"), false);
  assert.equal(isValidIdentifier("", "UPC"), false);
});

// ---------------------------------------------------------------------------
// Amazon item extraction
// ---------------------------------------------------------------------------

test("extractAmazonIdentifiers parses nested identifier arrays and dedupes", () => {
  const item = amazonItem({
    asin: "B0ABCDEFGH",
    identifiers: [
      { identifierType: "UPC", identifier: "012345678905" },
      { identifierType: "UPC", identifier: "012345678905" },
      { identifierType: "EAN", identifier: "0123456789012" },
    ],
  });
  const ids = extractAmazonIdentifiers(item);
  assert.equal(ids.length, 3); // ASIN + UPC + EAN (dup UPC removed)
  assert.equal(ids[0].type, "ASIN");
  assert.equal(ids[1].type, "UPC");
  assert.equal(ids[2].type, "EAN");
});

test("extractAmazonTitle/Brand/ProductType prefer marketplace-matched summary", () => {
  const item = {
    asin: "B0ABCDEFGH",
    summaries: [
      { marketplaceId: "A1PA6795UYM299", itemName: "DE Title", brand: "DE Brand" },
      { marketplaceId: "ATVPDKIKX0DER", itemName: "US Title", brand: "US Brand" },
    ],
    productTypes: [{ marketplaceId: "ATVPDKIKX0DER", productType: "DRESS" }],
  };
  assert.equal(extractAmazonTitle(item, "ATVPDKIKX0DER"), "US Title");
  assert.equal(extractAmazonBrand(item, "ATVPDKIKX0DER"), "US Brand");
  assert.equal(extractAmazonProductType(item, "ATVPDKIKX0DER"), "DRESS");
});

// ---------------------------------------------------------------------------
// Category conflict detection
// ---------------------------------------------------------------------------

test("normalizeApparelCategory maps common apparel terms", () => {
  assert.equal(normalizeApparelCategory("Summer Dress"), "DRESS");
  assert.equal(normalizeApparelCategory("Denim Jeans"), "BOTTOM");
  assert.equal(normalizeApparelCategory("Hoodie"), "TOP");
  assert.equal(normalizeApparelCategory("Leather Jacket"), "OUTERWEAR");
  assert.equal(normalizeApparelCategory("Running Shoe"), "FOOTWEAR");
  assert.equal(normalizeApparelCategory("Widget"), "UNKNOWN");
});

test("categoriesConflict: dress vs pants conflicts", () => {
  assert.equal(categoriesConflict("Women's Black Dress", "Pants"), true);
});

test("categoriesConflict: hoodie vs dress conflicts", () => {
  assert.equal(categoriesConflict("Hoodie", "Evening Gown"), true);
});

test("categoriesConflict: unknown category does not conflict", () => {
  assert.equal(categoriesConflict("Widget", "Dress"), false);
});

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

test("exact UPC match yields IDENTIFIER_MATCH and safeToAutoLink", () => {
  const product = shopifyProduct({ barcode: "012345678905" });
  const item = amazonItem({
    asin: "B0ABCDEFGH",
    title: "Women's Black Dress",
    brand: "The Outfit Vault",
    productType: "DRESS",
    identifiers: [{ identifierType: "UPC", identifier: "012345678905" }],
  });
  const scored = scoreAmazonCandidate({ product, item, marketplaceId: "ATVPDKIKX0DER", inputIdentifiers: ["012345678905"] });
  assert.equal(scored.status, "IDENTIFIER_MATCH");
  assert.equal(scored.safeToAutoLink, true);
  assert.ok(scored.confidence >= 95);
});

test("exact EAN match yields IDENTIFIER_MATCH", () => {
  const product = shopifyProduct({ ean: "0123456789012" });
  const item = amazonItem({
    title: "Women's Black Dress",
    brand: "The Outfit Vault",
    productType: "DRESS",
    identifiers: [{ identifierType: "EAN", identifier: "0123456789012" }],
  });
  const scored = scoreAmazonCandidate({ product, item, marketplaceId: "ATVPDKIKX0DER", inputIdentifiers: ["0123456789012"] });
  assert.equal(scored.status, "IDENTIFIER_MATCH");
});

test("exact ASIN match yields IDENTIFIER_MATCH", () => {
  const product = shopifyProduct();
  const item = amazonItem({
    asin: "B0ABCDEFGH",
    title: "Women's Black Dress",
    brand: "The Outfit Vault",
    productType: "DRESS",
    identifiers: [{ identifierType: "ASIN", identifier: "B0ABCDEFGH" }],
  });
  const scored = scoreAmazonCandidate({ product, item, marketplaceId: "ATVPDKIKX0DER", inputIdentifiers: ["B0ABCDEFGH"] });
  assert.equal(scored.status, "IDENTIFIER_MATCH");
});

test("dress vs pants candidate produces CATEGORY_CONFLICT (no auto-link)", () => {
  const product = shopifyProduct({ title: "Women's Black Dress", productType: "Dresses" });
  const item = amazonItem({ title: "Women's Black Pants", brand: "The Outfit Vault", productType: "PANTS" });
  const scored = scoreAmazonCandidate({ product, item, marketplaceId: "ATVPDKIKX0DER", inputIdentifiers: [] });
  assert.equal(scored.conflicts.productType, true);
  assert.notEqual(scored.status, "IDENTIFIER_MATCH");
  assert.equal(scored.safeToAutoLink, false);
});

test("brand conflict detected when brands differ strongly", () => {
  const product = shopifyProduct({ title: "Women's Black Dress", vendor: "The Outfit Vault" });
  const item = amazonItem({ title: "Women's Black Dress", brand: "Acme Corp", productType: "DRESS" });
  const scored = scoreAmazonCandidate({ product, item, marketplaceId: "ATVPDKIKX0DER", inputIdentifiers: [] });
  assert.equal(scored.conflicts.brand, true);
  assert.equal(scored.safeToAutoLink, false);
});

test("title-only 95% match never auto-links", () => {
  const product = shopifyProduct({ title: "Women's Black Dress", vendor: "The Outfit Vault" });
  const item = amazonItem({ title: "Women's Black Dress", brand: "The Outfit Vault", productType: "DRESS" });
  const scored = scoreAmazonCandidate({ product, item, marketplaceId: "ATVPDKIKX0DER", inputIdentifiers: [] });
  assert.equal(scored.safeToAutoLink, false);
  assert.ok(scored.status === "HIGH_CONFIDENCE_REVIEW" || scored.status === "MANUAL_REVIEW");
});

test("same generic words but different item yields NO_SAFE_MATCH", () => {
  const product = shopifyProduct({ title: "Women's Black Fashion", vendor: "BrandX", productType: "Dresses" });
  const item = amazonItem({ title: "Women's Black Fashion", brand: "BrandY", productType: "PANTS" });
  const scored = scoreAmazonCandidate({ product, item, marketplaceId: "ATVPDKIKX0DER", inputIdentifiers: [] });
  assert.equal(scored.status, "NO_SAFE_MATCH");
});

test("chooseBestAmazonMatch prefers identifier match over high-confidence review", () => {
  const idMatch = { status: "IDENTIFIER_MATCH", confidence: 95, safeToAutoLink: true, asin: "A1" };
  const review = { status: "HIGH_CONFIDENCE_REVIEW", confidence: 98, safeToAutoLink: false, asin: "A2" };
  const best = chooseBestAmazonMatch([review, idMatch]);
  assert.equal(best.asin, "A1");
});

test("chooseBestAmazonMatch returns NO_SAFE_MATCH when nothing is safe", () => {
  const best = chooseBestAmazonMatch([{ status: "MANUAL_REVIEW", confidence: 60, safeToAutoLink: false }]);
  assert.equal(best.status, "NO_SAFE_MATCH");
});

// ---------------------------------------------------------------------------
// Route: GET /amazon/catalog/items
// ---------------------------------------------------------------------------

function setupEnv(secret = "secret123") {
  process.env.AMAZON_AUTH_SECRET = secret;
}

test("catalog search: missing admin secret -> HTTP 500", async () => {
  delete process.env.AMAZON_AUTH_SECRET;
  const handler = createCatalogSearchHandler({ searchCatalogItems: async () => ({ success: true, items: [] }) });
  const res = mockRes();
  await handler(mockReq({ query: { keywords: "dress" } }), res);
  assert.equal(res.statusCode, 500);
});

test("catalog search: incorrect admin key -> HTTP 401", async () => {
  setupEnv();
  const handler = createCatalogSearchHandler({ searchCatalogItems: async () => ({ success: true, items: [] }) });
  const res = mockRes();
  await handler(mockReq({ headers: { "x-admin-key": "wrong" }, query: { keywords: "dress" } }), res);
  assert.equal(res.statusCode, 401);
});

test("catalog search: malformed identifier -> HTTP 400", async () => {
  setupEnv();
  const handler = createCatalogSearchHandler({ searchCatalogItems: async () => ({ success: true, items: [] }) });
  const res = mockRes();
  await handler(
    mockReq({ headers: { "x-admin-key": "secret123" }, query: { identifiers: "abc", identifiersType: "UPC" } }),
    res
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.payload.error, /Invalid product identifiers/);
});

test("catalog search: identifier without identifiersType -> HTTP 400", async () => {
  setupEnv();
  const handler = createCatalogSearchHandler({ searchCatalogItems: async () => ({ success: true, items: [] }) });
  const res = mockRes();
  await handler(
    mockReq({ headers: { "x-admin-key": "secret123" }, query: { identifiers: "012345678905" } }),
    res
  );
  assert.equal(res.statusCode, 400);
});

test("catalog search: no identifiers and no keywords -> HTTP 400", async () => {
  setupEnv();
  const handler = createCatalogSearchHandler({ searchCatalogItems: async () => ({ success: true, items: [] }) });
  const res = mockRes();
  await handler(mockReq({ headers: { "x-admin-key": "secret123" }, query: {} }), res);
  assert.equal(res.statusCode, 400);
});

test("catalog search: valid identifier search calls SP-API with identifiers mode", async () => {
  setupEnv();
  let received;
  const searchCatalogItems = async (params) => { received = params; return { success: true, items: [] }; };
  const handler = createCatalogSearchHandler({ searchCatalogItems });
  const res = mockRes();
  await handler(
    mockReq({ headers: { "x-admin-key": "secret123" }, query: { identifiers: "012345678905", identifiersType: "UPC" } }),
    res
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(received.identifiers, ["012345678905"]);
  assert.equal(received.identifiersType, "UPC");
});

// ---------------------------------------------------------------------------
// Route: POST /amazon/match-product
// ---------------------------------------------------------------------------

test("match-product: missing title -> HTTP 400", async () => {
  setupEnv();
  const handler = createProductMatchHandler({ searchCatalogItems: async () => ({ success: true, items: [] }) });
  const res = mockRes();
  await handler(mockReq({ headers: { "x-admin-key": "secret123" }, body: { product: {} } }), res);
  assert.equal(res.statusCode, 400);
});

test("match-product: missing barcode falls back to keyword search", async () => {
  setupEnv();
  let received;
  const searchCatalogItems = async (params) => { received = params; return { success: true, items: [] }; };
  const handler = createProductMatchHandler({ searchCatalogItems });
  const res = mockRes();
  await handler(
    mockReq({
      headers: { "x-admin-key": "secret123" },
      body: { product: shopifyProduct() },
    }),
    res
  );
  assert.equal(res.statusCode, 200);
  assert.ok(received.keywords);
  assert.ok(!received.identifiers);
});

test("match-product: duplicate ASINs are removed before scoring", async () => {
  setupEnv();
  const item = amazonItem({ asin: "B0ABCDEFGH", title: "Women's Black Dress", brand: "The Outfit Vault", productType: "DRESS" });
  const searchCatalogItems = async () => ({ success: true, items: [item, item, item] });
  const handler = createProductMatchHandler({ searchCatalogItems });
  const res = mockRes();
  await handler(
    mockReq({ headers: { "x-admin-key": "secret123" }, body: { product: shopifyProduct() } }),
    res
  );
  assert.equal(res.payload.matches.length, 1);
});

test("match-product: empty Amazon response yields NO_SAFE_MATCH", async () => {
  setupEnv();
  const searchCatalogItems = async () => ({ success: true, items: [] });
  const handler = createProductMatchHandler({ searchCatalogItems });
  const res = mockRes();
  await handler(
    mockReq({ headers: { "x-admin-key": "secret123" }, body: { product: shopifyProduct() } }),
    res
  );
  assert.equal(res.payload.status, "NO_SAFE_MATCH");
});

// ---------------------------------------------------------------------------
// Route: POST /admin/amazon/rematch-all
// ---------------------------------------------------------------------------

test("rematch-all: dry run does not call saveMatchReview", async () => {
  setupEnv();
  let saved = 0;
  const deps = {
    searchCatalogItems: async () => ({ success: true, items: [] }),
    loadShopifyProducts: async () => ({ items: [shopifyProduct()], nextCursor: null }),
    saveMatchReview: async () => { saved++; },
    updateBatchRun: async () => {},
  };
  const handler = createRematchAllHandler(deps);
  const res = mockRes();
  await handler(mockReq({ headers: { "x-admin-key": "secret123" }, body: { dryRun: true, limit: 10 } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.dryRun, true);
  assert.equal(saved, 0);
});

test("rematch-all: Amazon 429 is retried with backoff", async () => {
  setupEnv();
  let calls = 0;
  const deps = {
    searchCatalogItems: async () => {
      calls++;
      if (calls < 2) return { success: false, amazon_http_status: 429, error: "throttled" };
      return { success: true, items: [] };
    },
    loadShopifyProducts: async () => ({ items: [shopifyProduct()], nextCursor: null }),
    saveMatchReview: async () => {},
    updateBatchRun: async () => {},
  };
  const handler = createRematchAllHandler(deps);
  const res = mockRes();
  await handler(mockReq({ headers: { "x-admin-key": "secret123" }, body: { dryRun: true, limit: 10 } }), res);
  assert.ok(calls >= 2);
  assert.equal(res.statusCode, 200);
});

test("rematch-all: missing loadShopifyProducts -> HTTP 500", async () => {
  setupEnv();
  const handler = createRematchAllHandler({ searchCatalogItems: async () => ({ success: true, items: [] }) });
  const res = mockRes();
  await handler(mockReq({ headers: { "x-admin-key": "secret123" }, body: { dryRun: true } }), res);
  assert.equal(res.statusCode, 500);
});
