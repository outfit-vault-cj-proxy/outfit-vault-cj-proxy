// amazon-match-routes.js
//
// Portable Express route factories for the Amazon Catalog Match Engine.
// Depends on `express` (already used by outfit-vault-cj-proxy) and the pure
// helpers from `./amazon-match.js`. All live services (SP-API search, Shopify
// loader, review persistence, batch-run store, admin auth) are injected via
// the `deps` argument so this module never imports Railway/Base44 code.
//
// Usage in the live server.js:
//
//   import { createAmazonMatchRouter } from "./amazon-match-routes.js";
//   import { searchCatalogItems } from "./amazon.js";
//   // ...other deps...
//   app.use(createAmazonMatchRouter({
//     searchCatalogItems,
//     loadShopifyProducts,
//     saveMatchReview,
//     getExistingMatchReview,
//     updateBatchRun,
//     logger: console,
//     authenticateAdmin,
//     marketplaceId: process.env.AMAZON_MARKETPLACE_ID || "ATVPDKIKX0DER",
//   }));

import express from "express";
import {
  toArray,
  normalizeIdentifier,
  isValidIdentifier,
  scoreAmazonCandidate,
  chooseBestAmazonMatch,
  MATCH_STATUSES,
} from "./amazon-match.js";

const ROUTER_VERSION = "amazon-match-routes-v2.2-search-safe";
const DEFAULT_MINIMUM_READY_SCORE = 85;

const DEFAULT_INCLUDED_DATA = [
  "attributes",
  "identifiers",
  "images",
  "productTypes",
  "summaries",
  "relationships",
];

function responseStatus(data) {
  if (!data || data.success !== false) return 200;

  const upstreamStatus = Number(
    data.amazon_http_status ??
      data.upstreamStatus
  );

  if (
    Number.isInteger(upstreamStatus) &&
    upstreamStatus >= 400 &&
    upstreamStatus <= 599
  ) {
    return upstreamStatus;
  }

  return 502;
}

function jsonError(res, status, error) {
  const message = error?.message || String(error || "Internal error");
  return res.status(status).json({ success: false, error: message });
}

function requireAdmin(deps) {
  if (deps.authenticateAdmin) return deps.authenticateAdmin;
  // Fallback: x-admin-key header check against AMAZON_AUTH_SECRET.
  return (req, res, next) => {
    const expected = process.env.AMAZON_AUTH_SECRET;
    const provided = req.headers["x-admin-key"];
    if (!expected) return res.status(500).json({ success: false, error: "AMAZON_AUTH_SECRET is not configured" });
    if (typeof provided !== "string" || provided !== expected) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// GET /amazon/catalog/items  Ã¢ÂÂ identifier OR keyword search (never both)
// ---------------------------------------------------------------------------

export function createCatalogSearchHandler(deps) {
  return async function catalogSearchHandler(req, res) {
    try {
      const expectedAdminKey = process.env.AMAZON_AUTH_SECRET;
      const providedAdminKey = req.headers["x-admin-key"];

      if (!expectedAdminKey) {
        return res.status(500).json({ success: false, error: "AMAZON_AUTH_SECRET is not configured" });
      }
      if (typeof providedAdminKey !== "string" || providedAdminKey !== expectedAdminKey) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const identifiers = toArray(req.query.identifiers).map(normalizeIdentifier).filter(Boolean);
      const keywords = String(req.query.keywords || "").trim();
      const brandNames = toArray(req.query.brandNames);
      const identifiersType = String(req.query.identifiersType || "").trim().toUpperCase();

      if (!identifiers.length && !keywords) {
        return res.status(400).json({ success: false, error: "Provide identifiers or search keywords" });
      }
      if (identifiers.length && !identifiersType) {
        return res.status(400).json({ success: false, error: "identifiersType is required for identifier search" });
      }

      const invalidIdentifiers = identifiers.filter((id) => !isValidIdentifier(id, identifiersType));
      if (invalidIdentifiers.length) {
        return res.status(400).json({ success: false, error: "Invalid product identifiers", invalidIdentifiers });
      }

      let data;
      if (identifiers.length) {
        data = await deps.searchCatalogItems({
          identifiers,
          identifiersType,
          includedData: DEFAULT_INCLUDED_DATA,
        });
      } else {
        data = await deps.searchCatalogItems({
          keywords,
          brandNames,
          includedData: DEFAULT_INCLUDED_DATA,
        });
      }

      return res.status(responseStatus(data)).json(data);
    } catch (error) {
      return jsonError(res, 500, error);
    }
  };
}

function unique(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function groupIdentifiers(values = []) {
  const identifiers = unique(
    values.map(normalizeIdentifier).filter(Boolean)
  );

  return {
    all: identifiers,
    UPC: identifiers.filter((value) => /^\d{12}$/.test(value)),
    EAN: identifiers.filter((value) => /^\d{13}$/.test(value)),
    GTIN: identifiers.filter((value) => /^\d{14}$/.test(value)),
    ASIN: identifiers.filter((value) => /^[A-Z0-9]{10}$/.test(value))
  };
}

function catalogFailureRecord(data, context = {}) {
  return {
    searchMode: data?.searchMode || context.searchMode || null,
    identifier: context.identifier || null,
    identifierType: context.identifierType || null,
    keywords: context.keywords || null,
    httpStatus: data?.amazon_http_status ?? data?.upstreamStatus ?? null,
    amazonErrorCode: data?.amazon_error_code || data?.error_code || null,
    amazonErrorType: data?.amazon_error_type || null,
    amazonErrorMessage:
      data?.amazon_error_message ||
      data?.error ||
      "Amazon catalog search failed.",
    amazonRequestId: data?.amazon_request_id || null,
    amazonErrorDetails: data?.amazon_error_details || null,
    upstreamBody: data?.upstreamBody ?? null,
    requestPath: data?.requestPath || null,
    requestQuery: data?.requestQuery || null
  };
}

function normalizeDecision(scoredMatches = [], options = {}) {
  const rawDecision = chooseBestAmazonMatch(scoredMatches, options) || {};
  const bestMatch =
    rawDecision.bestMatch ||
    ((rawDecision.asin || rawDecision.confidence !== undefined)
      ? rawDecision
      : null);
  const status =
    rawDecision.decision ||
    rawDecision.status ||
    bestMatch?.status ||
    "NO_SAFE_MATCH";

  return { rawDecision, bestMatch, status };
}

async function searchIdentifiers(deps, grouped, searchFn) {
  const jobs = [];

  for (const type of ["UPC", "EAN", "GTIN", "ASIN"]) {
    for (const identifier of grouped[type] || []) {
      jobs.push({
        identifier,
        identifierType: type,
        promise: searchFn({
          identifiers: identifier,
          identifiersType: type,
          includedData: DEFAULT_INCLUDED_DATA
        })
      });
    }
  }

  const settled = await Promise.all(
    jobs.map(async (job) => ({ ...job, data: await job.promise }))
  );

  const items = [];
  const failures = [];

  for (const result of settled) {
    if (result.data?.success === false) {
      failures.push(catalogFailureRecord(result.data, {
        searchMode: "IDENTIFIER",
        identifier: result.identifier,
        identifierType: result.identifierType
      }));
      continue;
    }

    items.push(...(result.data?.items || result.data?.matches || []));
  }

  return { items, failures, searchCount: settled.length };
}

async function searchKeywords(deps, product, searchFn) {
  const cleanKeywords = [
    product?.vendor,
    product?.productType,
    product?.title
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);

  if (!cleanKeywords) {
    return {
      items: [],
      failures: [{
        searchMode: "KEYWORD",
        amazonErrorCode: "INVALID_REQUEST",
        amazonErrorMessage: "No usable product keywords were available."
      }],
      searchCount: 0
    };
  }

  const data = await searchFn({
    keywords: cleanKeywords,
    brandNames: product?.vendor || "",
    includedData: DEFAULT_INCLUDED_DATA
  });

  if (data?.success === false) {
    return {
      items: [],
      failures: [catalogFailureRecord(data, {
        searchMode: "KEYWORD",
        keywords: cleanKeywords
      })],
      searchCount: 1
    };
  }

  return {
    items: data?.items || data?.matches || [],
    failures: [],
    searchCount: 1
  };
}

function dedupeCatalogItems(items = []) {
  return Array.from(
    new Map(
      items
        .filter((item) => item?.asin)
        .map((item) => [item.asin, item])
    ).values()
  );
}

function buildSearchErrorResult({ product, identifiers, failures }) {
  return {
    shopifyProductId: product?.id || null,
    shopifyTitle: product?.title || "",
    shopifyVendor: product?.vendor || "",
    shopifyProductType: product?.productType || "",
    shopifyImage: product?.featuredImage || null,
    identifiers,
    status: "SEARCH_ERROR",
    readiness: "NOT_AMAZON_READY",
    confidence: 0,
    publishEligible: false,
    bestMatch: null,
    matches: [],
    searchErrors: failures,
    error:
      failures?.[0]?.amazonErrorMessage ||
      "Amazon catalog search failed."
  };
}

// ---------------------------------------------------------------------------
// POST /amazon/match-product  Ã¢ÂÂ score one product against Amazon catalog
// ---------------------------------------------------------------------------

export function createProductMatchHandler(deps) {
  return async function productMatchHandler(req, res) {
    try {
      const product = req.body?.product;

      if (!product?.title) {
        return res.status(400).json({
          success: false,
          error: "Product title is required"
        });
      }

      const marketplaceId =
        deps.marketplaceId ||
        process.env.AMAZON_MARKETPLACE_ID ||
        "ATVPDKIKX0DER";

      const variants = Array.isArray(product?.variants)
        ? product.variants
        : [];

      const grouped = groupIdentifiers([
        product?.barcode,
        product?.gtin,
        product?.upc,
        product?.ean,
        product?.asin,
        ...variants.flatMap((variant) => [
          variant?.barcode,
          variant?.gtin,
          variant?.upc,
          variant?.ean,
          variant?.asin
        ])
      ]);

      const searchResult = grouped.all.length > 0
        ? await searchIdentifiers(
            deps,
            grouped,
            (params) => deps.searchCatalogItems(params)
          )
        : await searchKeywords(
            deps,
            product,
            (params) => deps.searchCatalogItems(params)
          );

      const uniqueItems = dedupeCatalogItems(searchResult.items);

      if (
        uniqueItems.length === 0 &&
        searchResult.failures.length > 0
      ) {
        const failed = buildSearchErrorResult({
          product,
          identifiers: grouped.all,
          failures: searchResult.failures
        });

        return res.status(502).json({
          success: false,
          version: ROUTER_VERSION,
          product: {
            id: product?.id || null,
            handle: product?.handle || null,
            title: product?.title || "",
            vendor: product?.vendor || "",
            productType: product?.productType || "",
            featuredImage: product?.featuredImage || null,
            variants
          },
          ...failed
        });
      }

      const scoredMatches = uniqueItems.map((item) =>
        scoreAmazonCandidate({
          product,
          item,
          marketplaceId,
          inputIdentifiers: grouped.all
        })
      );

      const decision = normalizeDecision(scoredMatches, {
        minimumAutoMatchConfidence: 95,
        minimumReviewConfidence: 75
      });

      const bestMatch = decision.bestMatch;
      const confidence = Number(bestMatch?.confidence) || 0;

      return res.json({
        success: true,
        version: ROUTER_VERSION,
        product: {
          id: product?.id || null,
          handle: product?.handle || null,
          title: product?.title || "",
          vendor: product?.vendor || "",
          productType: product?.productType || "",
          featuredImage: product?.featuredImage || null,
          variants
        },
        identifiers: grouped.all,
        status: decision.status,
        readiness:
          confidence >= DEFAULT_MINIMUM_READY_SCORE
            ? "AMAZON_READY"
            : "NOT_AMAZON_READY",
        publishEligible:
          decision.status === "IDENTIFIER_MATCH" &&
          confidence >= 95,
        bestMatch,
        matches: scoredMatches
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 10),
        searchWarnings:
          searchResult.failures.length > 0
            ? searchResult.failures
            : undefined
      });
    } catch (error) {
      return jsonError(res, 500, error);
    }
  };
}

// ---------------------------------------------------------------------------
// POST /admin/amazon/rematch-all  Ã¢ÂÂ batch rescan with dry-run support
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function searchWithBackoff(deps, params, logger) {
  const maxAttempts = 4;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    const data = await deps.searchCatalogItems(params);
    const status = Number(
      data?.amazon_http_status ??
        data?.upstreamStatus
    );

    if (
      data?.success === false &&
      status === 429 &&
      attempt < maxAttempts
    ) {
      const wait = Math.min(2000 * 2 ** (attempt - 1), 16000);
      logger?.log?.(`[rematch-all] 429 throttled, backing off ${wait}ms (attempt ${attempt})`);
      await sleep(wait);
      continue;
    }
    return data;
  }
}

export function createRematchAllHandler(deps) {
  return async function rematchAllHandler(req, res) {
    try {
      const options = req.body || {};
      const dryRun = options.dryRun !== false; // default true
      const onlyErrored = Boolean(options.onlyErrored);
      const limit = Math.max(1, Math.min(Number(options.limit) || 100, 500));
      const cursor = options.cursor || null;

      if (!deps.loadShopifyProducts) {
        return res.status(500).json({ success: false, error: "loadShopifyProducts is not configured on the server" });
      }

      const marketplaceId = deps.marketplaceId || process.env.AMAZON_MARKETPLACE_ID || "ATVPDKIKX0DER";
      const logger = deps.logger || console;
      const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      if (deps.updateBatchRun) {
        await deps.updateBatchRun(runId, {
          status: "RUNNING",
          dryRun,
          onlyErrored,
          requestedLimit: limit,
          startedAt: new Date().toISOString(),
        });
      }

      const products = await deps.loadShopifyProducts({ limit, cursor, onlyErrored });

      const counts = {
        processed: 0,
        identifierMatches: 0,
        reviewMatches: 0,
        missingIdentifiers: 0,
        categoryConflicts: 0,
        brandConflicts: 0,
        noSafeMatches: 0,
        searchErrors: 0,
      };

      const results = [];

      for (const product of products.items || []) {
        counts.processed++;
        let result;
        try {
          const variants = Array.isArray(product?.variants)
            ? product.variants
            : [];

          const grouped = groupIdentifiers([
            product?.barcode,
            product?.gtin,
            product?.upc,
            product?.ean,
            product?.asin,
            ...variants.flatMap((variant) => [
              variant?.barcode,
              variant?.gtin,
              variant?.upc,
              variant?.ean,
              variant?.asin
            ])
          ]);

          if (grouped.all.length === 0) {
            counts.missingIdentifiers++;
          }

          const searchResult = grouped.all.length > 0
            ? await searchIdentifiers(
                deps,
                grouped,
                (params) => searchWithBackoff(deps, params, logger)
              )
            : await searchKeywords(
                deps,
                product,
                (params) => searchWithBackoff(deps, params, logger)
              );

          const uniqueItems = dedupeCatalogItems(searchResult.items);

          if (
            uniqueItems.length === 0 &&
            searchResult.failures.length > 0
          ) {
            counts.searchErrors++;

            result = buildSearchErrorResult({
              product,
              identifiers: grouped.all,
              failures: searchResult.failures
            });

            results.push(result);
            continue;
          }

          const scored = uniqueItems.map((item) =>
            scoreAmazonCandidate({
              product,
              item,
              marketplaceId,
              inputIdentifiers: grouped.all
            })
          );

          const decision = normalizeDecision(scored);
          const best = decision.bestMatch;
          const status = decision.status;
          const confidence = Number(best?.confidence) || 0;

          result = {
            shopifyProductId: product?.id || null,
            shopifyTitle: product?.title || "",
            shopifyVendor: product?.vendor || "",
            shopifyProductType: product?.productType || "",
            shopifyImage: product?.featuredImage || null,
            identifiers: grouped.all,
            status,
            readiness:
              confidence >= DEFAULT_MINIMUM_READY_SCORE
                ? "AMAZON_READY"
                : "NOT_AMAZON_READY",
            confidence,
            publishEligible:
              status === "IDENTIFIER_MATCH" &&
              confidence >= 95,
            bestMatch: best,
            matches: scored
              .sort((a, b) => b.confidence - a.confidence)
              .slice(0, 10),
            searchWarnings:
              searchResult.failures.length > 0
                ? searchResult.failures
                : undefined
          };

          if (status === "IDENTIFIER_MATCH") {
            counts.identifierMatches++;
          } else if (status === "HIGH_CONFIDENCE_REVIEW") {
            counts.reviewMatches++;
          } else if (best?.conflicts?.productType) {
            counts.categoryConflicts++;
          } else if (best?.conflicts?.brand) {
            counts.brandConflicts++;
          } else if (status === "NO_SAFE_MATCH") {
            counts.noSafeMatches++;
          }

          if (
            !dryRun &&
            deps.saveMatchReview &&
            status !== "NO_SAFE_MATCH" &&
            status !== "SEARCH_ERROR"
          ) {
            await deps.saveMatchReview(result);
          }
        } catch (err) {
          counts.searchErrors++;
          result = {
            shopifyProductId: product?.id || null,
            shopifyTitle: product?.title || "",
            status: "SEARCH_ERROR",
            confidence: 0,
            error: err?.message || "Search error",
          };
        }
        results.push(result);
      }

      if (deps.updateBatchRun) {
        await deps.updateBatchRun(runId, {
          status: "COMPLETED",
          ...counts,
          cursor: products.nextCursor || null,
          completedAt: new Date().toISOString(),
        });
      }

      return res.json({
        success: true,
        version: ROUTER_VERSION,
        runId,
        dryRun,
        ...counts,
        nextCursor: products.nextCursor || null,
        results,
      });
    } catch (error) {
      if (deps.updateBatchRun) {
        try { await deps.updateBatchRun(`run_${Date.now()}`, { status: "FAILED", error: error?.message || "Failed" }); } catch (_e) {}
      }
      return jsonError(res, 500, error);
    }
  };
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createAmazonMatchRouter(deps = {}) {
  const router = express.Router();
  const admin = requireAdmin(deps);

  router.get("/amazon/catalog/items", admin, createCatalogSearchHandler(deps));
  router.post("/amazon/match-product", admin, createProductMatchHandler(deps));
  router.post("/admin/amazon/rematch-all", admin, createRematchAllHandler(deps));

  return router;
}

export { MATCH_STATUSES };
