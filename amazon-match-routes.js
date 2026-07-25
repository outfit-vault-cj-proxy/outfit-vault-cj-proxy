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

const DEFAULT_INCLUDED_DATA = [
  "attributes",
  "identifiers",
  "images",
  "productTypes",
  "summaries",
  "relationships",
];

function responseStatus(data) {
  return data && data.success === false ? 502 : 200;
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
// GET /amazon/catalog/items  — identifier OR keyword search (never both)
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

// ---------------------------------------------------------------------------
// POST /amazon/match-product  — score one product against Amazon catalog
// ---------------------------------------------------------------------------

export function createProductMatchHandler(deps) {
  return async function productMatchHandler(req, res) {
    try {
      const product = req.body?.product;
      if (!product?.title) {
        return res.status(400).json({ success: false, error: "Product title is required" });
      }

      const marketplaceId = deps.marketplaceId || process.env.AMAZON_MARKETPLACE_ID || "ATVPDKIKX0DER";
      const variants = Array.isArray(product?.variants) ? product.variants : [];

      const identifiers = [
        product?.barcode,
        product?.gtin,
        product?.upc,
        product?.ean,
        ...variants.flatMap((v) => [v?.barcode, v?.gtin, v?.upc, v?.ean]),
      ]
        .map(normalizeIdentifier)
        .filter(Boolean);

      let catalogData;

      if (identifiers.length) {
        const groups = {
          UPC: identifiers.filter((v) => /^\d{12}$/.test(v)),
          EAN: identifiers.filter((v) => /^\d{13}$/.test(v)),
          ASIN: identifiers.filter((v) => /^[A-Z0-9]{10}$/.test(v)),
        };
        const searches = [];
        for (const [type, values] of Object.entries(groups)) {
          if (values.length) {
            searches.push(
              deps.searchCatalogItems({
                identifiers: values.slice(0, 20),
                identifiersType: type,
                includedData: DEFAULT_INCLUDED_DATA,
              })
            );
          }
        }
        const responses = await Promise.all(searches);
        catalogData = { items: responses.flatMap((r) => r?.items || []) };
      } else {
        const cleanKeywords = [product?.vendor, product?.productType, product?.title]
          .filter(Boolean)
          .join(" ")
          .slice(0, 500);
        catalogData = await deps.searchCatalogItems({
          keywords: cleanKeywords,
          brandNames: product?.vendor ? [product.vendor] : [],
          includedData: DEFAULT_INCLUDED_DATA,
        });
      }

      const uniqueItems = Array.from(
        new Map(
          (catalogData?.items || []).filter((item) => item?.asin).map((item) => [item.asin, item])
        ).values()
      );

      const scoredMatches = uniqueItems.map((item) =>
        scoreAmazonCandidate({ product, item, marketplaceId, inputIdentifiers: identifiers })
      );
      const bestMatch = chooseBestAmazonMatch(scoredMatches);

      return res.json({
        success: true,
        product: {
          id: product?.id || null,
          handle: product?.handle || null,
          title: product?.title || "",
          vendor: product?.vendor || "",
          productType: product?.productType || "",
          featuredImage: product?.featuredImage || null,
          variants,
        },
        identifiers,
        status: bestMatch?.status || "NO_SAFE_MATCH",
        bestMatch,
        matches: scoredMatches.sort((a, b) => b.confidence - a.confidence).slice(0, 10),
      });
    } catch (error) {
      return jsonError(res, 500, error);
    }
  };
}

// ---------------------------------------------------------------------------
// POST /admin/amazon/rematch-all  — batch rescan with dry-run support
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
    if (data && data.success === false && data.amazon_http_status === 429 && attempt < maxAttempts) {
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
          const variants = Array.isArray(product?.variants) ? product.variants : [];
          const identifiers = [
            product?.barcode, product?.gtin, product?.upc, product?.ean,
            ...variants.flatMap((v) => [v?.barcode, v?.gtin, v?.upc, v?.ean]),
          ].map(normalizeIdentifier).filter(Boolean);

          let catalogData;
          if (identifiers.length) {
            const groups = {
              UPC: identifiers.filter((v) => /^\d{12}$/.test(v)),
              EAN: identifiers.filter((v) => /^\d{13}$/.test(v)),
              ASIN: identifiers.filter((v) => /^[A-Z0-9]{10}$/.test(v)),
            };
            const responses = await Promise.all(
              Object.entries(groups)
                .filter(([, v]) => v.length)
                .map(([type, v]) =>
                  searchWithBackoff(
                    deps,
                    { identifiers: v.slice(0, 20), identifiersType: type, includedData: DEFAULT_INCLUDED_DATA },
                    logger
                  )
                )
            );
            catalogData = { items: responses.flatMap((r) => r?.items || []) };
          } else {
            counts.missingIdentifiers++;
            const cleanKeywords = [product?.vendor, product?.productType, product?.title]
              .filter(Boolean).join(" ").slice(0, 500);
            catalogData = await searchWithBackoff(
              deps,
              { keywords: cleanKeywords, brandNames: product?.vendor ? [product.vendor] : [], includedData: DEFAULT_INCLUDED_DATA },
              logger
            );
          }

          const uniqueItems = Array.from(
            new Map((catalogData?.items || []).filter((i) => i?.asin).map((i) => [i.asin, i])).values()
          );
          const scored = uniqueItems.map((item) =>
            scoreAmazonCandidate({ product, item, marketplaceId, inputIdentifiers: identifiers })
          );
          const best = chooseBestAmazonMatch(scored);

          result = {
            shopifyProductId: product?.id || null,
            shopifyTitle: product?.title || "",
            shopifyVendor: product?.vendor || "",
            shopifyProductType: product?.productType || "",
            shopifyImage: product?.featuredImage || null,
            identifiers,
            status: best?.status || "NO_SAFE_MATCH",
            confidence: best?.confidence || 0,
            bestMatch: best,
            matches: scored.sort((a, b) => b.confidence - a.confidence).slice(0, 10),
          };

          if (best?.status === "IDENTIFIER_MATCH") counts.identifierMatches++;
          else if (best?.status === "HIGH_CONFIDENCE_REVIEW") counts.reviewMatches++;
          else if (best?.conflicts?.productType) counts.categoryConflicts++;
          else if (best?.conflicts?.brand) counts.brandConflicts++;
          else if (best?.status === "NO_SAFE_MATCH") counts.noSafeMatches++;

          if (!dryRun && deps.saveMatchReview && best?.status !== "NO_SAFE_MATCH") {
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
