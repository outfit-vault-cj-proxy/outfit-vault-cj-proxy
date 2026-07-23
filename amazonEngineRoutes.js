/* eslint-env node */

import express from "express";

import {
  startAmazonEngineScan,
  rescanAmazonEngineVariant,
  getAmazonEngineStatus,
  getAmazonEngineDashboard,
  getAmazonEngineResults,
  getAmazonEngineResult,
  clearAmazonEngineResults
} from "./amazonEngine.js";

/* =========================================================
   AMAZON ENGINE ROUTER
   Version: 1.0.0

   This file connects amazonEngine.js to Express routes.

   Supported routes:

   GET    /amazon-engine/status
   GET    /amazon-engine/dashboard
   GET    /amazon-engine/results
   GET    /amazon-engine/result/:variantId

   POST   /amazon-engine/scan
   POST   /amazon-engine/rescan/:variantId

   DELETE /amazon-engine/results
========================================================= */

const ROUTER_VERSION =
  "amazon-engine-routes-v1";

/* =========================================================
   HELPERS
========================================================= */

function sendError(
  res,
  status,
  error,
  extra = {}
) {
  return res
    .status(status)
    .json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : String(error),
      ...extra
    });
}

function normalizeBoolean(
  value,
  fallback
) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return fallback;
  }

  if (
    typeof value ===
    "boolean"
  ) {
    return value;
  }

  const normalized =
    String(value)
      .trim()
      .toLowerCase();

  if (
    [
      "true",
      "1",
      "yes",
      "on"
    ].includes(normalized)
  ) {
    return true;
  }

  if (
    [
      "false",
      "0",
      "no",
      "off"
    ].includes(normalized)
  ) {
    return false;
  }

  return fallback;
}

function normalizeNumber(
  value,
  fallback,
  minimum = null,
  maximum = null
) {
  const number =
    Number(value);

  if (
    !Number.isFinite(number)
  ) {
    return fallback;
  }

  let normalized =
    number;

  if (
    minimum !== null
  ) {
    normalized =
      Math.max(
        minimum,
        normalized
      );
  }

  if (
    maximum !== null
  ) {
    normalized =
      Math.min(
        maximum,
        normalized
      );
  }

  return normalized;
}

function normalizeVariantId(
  value
) {
  return String(
    value || ""
  ).trim();
}

function extractVariants(
  data
) {
  if (
    Array.isArray(data)
  ) {
    return data;
  }

  if (
    Array.isArray(
      data?.variants
    )
  ) {
    return data.variants;
  }

  if (
    Array.isArray(
      data?.data?.variants
    )
  ) {
    return data.data.variants;
  }

  return [];
}

function findVariant(
  variants,
  variantId
) {
  const normalizedId =
    normalizeVariantId(
      variantId
    );

  if (!normalizedId) {
    return null;
  }

  return (
    variants.find(
      (variant) => {
        const possibleIds = [
          variant.shopify_variant_id,
          variant.id,
          variant.sku,
          variant.barcode
        ]
          .filter(
            (value) =>
              value !== undefined &&
              value !== null
          )
          .map(
            (value) =>
              String(value)
          );

        return possibleIds.includes(
          normalizedId
        );
      }
    ) || null
  );
}

/* =========================================================
   ROUTER FACTORY
========================================================= */

/**
 * Creates the Amazon Publishing Engine router.
 *
 * @param {Object} dependencies
 * @param {Function} dependencies.getShopifyVariants
 *
 * getShopifyVariants should return either:
 *
 * [
 *   {
 *     shopify_product_id: "...",
 *     shopify_variant_id: "...",
 *     sku: "...",
 *     barcode: "...",
 *     price: 39.99,
 *     inventoryQuantity: 10,
 *     image: "...",
 *     productTitle: "...",
 *     vendor: "...",
 *     productType: "...",
 *     selectedOptions: []
 *   }
 * ]
 *
 * or:
 *
 * {
 *   success: true,
 *   variants: [...]
 * }
 */
export function createAmazonEngineRouter(
  dependencies = {}
) {
  const router =
    express.Router();

  const {
    getShopifyVariants
  } = dependencies;

  /* =======================================================
     ROUTER HOME
  ======================================================= */

  router.get(
    "/",
    (req, res) => {
      res.json({
        success: true,
        version:
          ROUTER_VERSION,
        message:
          "Amazon Publishing Engine API is running",
        routes: {
          status:
            "GET /amazon-engine/status",
          dashboard:
            "GET /amazon-engine/dashboard",
          results:
            "GET /amazon-engine/results",
          result:
            "GET /amazon-engine/result/:variantId",
          scan:
            "POST /amazon-engine/scan",
          rescan:
            "POST /amazon-engine/rescan/:variantId",
          clear:
            "DELETE /amazon-engine/results"
        }
      });
    }
  );

  /* =======================================================
     ENGINE STATUS
  ======================================================= */

  router.get(
    "/status",
    (req, res) => {
      try {
        const data =
          getAmazonEngineStatus();

        res.json(data);
      } catch (error) {
        sendError(
          res,
          500,
          error
        );
      }
    }
  );

  /* =======================================================
     ENGINE DASHBOARD
  ======================================================= */

  router.get(
    "/dashboard",
    (req, res) => {
      try {
        const data =
          getAmazonEngineDashboard();

        res.json(data);
      } catch (error) {
        sendError(
          res,
          500,
          error
        );
      }
    }
  );

  /* =======================================================
     ENGINE RESULTS
  ======================================================= */

  router.get(
    "/results",
    (req, res) => {
      try {
        const filters = {
          status:
            req.query.status ||
            null,

          search:
            req.query.search ||
            req.query.q ||
            null,

          vendor:
            req.query.vendor ||
            null,

          limit:
            normalizeNumber(
              req.query.limit,
              100,
              1,
              500
            ),

          offset:
            normalizeNumber(
              req.query.offset,
              0,
              0
            )
        };

        const data =
          getAmazonEngineResults(
            filters
          );

        res.json(data);
      } catch (error) {
        sendError(
          res,
          500,
          error
        );
      }
    }
  );

  /* =======================================================
     SINGLE ENGINE RESULT
  ======================================================= */

  router.get(
    "/result/:variantId",
    (req, res) => {
      try {
        const variantId =
          normalizeVariantId(
            req.params.variantId
          );

        if (!variantId) {
          return sendError(
            res,
            400,
            "variantId is required"
          );
        }

        const data =
          getAmazonEngineResult(
            variantId
          );

        if (!data.success) {
          return res
            .status(404)
            .json(data);
        }

        res.json(data);
      } catch (error) {
        sendError(
          res,
          500,
          error
        );
      }
    }
  );

  /* =======================================================
     START FULL SCAN

     Supported request methods:

     Method 1:
     Send variants directly:

     {
       "variants": [...]
     }

     Method 2:
     Send no variants and allow this router to load all
     Shopify variants using getShopifyVariants().
  ======================================================= */

  router.post(
    "/scan",
    async (req, res) => {
      try {
        let variants =
          extractVariants(
            req.body
          );

        let variantSource =
          "request-body";

        if (
          variants.length === 0
        ) {
          if (
            typeof getShopifyVariants !==
            "function"
          ) {
            return sendError(
              res,
              400,
              "No variants were supplied and the Shopify variant loader is unavailable."
            );
          }

          const shopifyData =
            await getShopifyVariants({
              productId:
                req.body?.productId ||
                req.query.productId ||
                null
            });

          variants =
            extractVariants(
              shopifyData
            );

          variantSource =
            "shopify";
        }

        if (
          variants.length === 0
        ) {
          return sendError(
            res,
            400,
            "No Shopify variants were found to scan."
          );
        }

        const options = {
          delayMs:
            normalizeNumber(
              req.body?.delayMs ??
                req.query.delayMs,
              750,
              0,
              60_000
            ),

          checkPublished:
            normalizeBoolean(
              req.body
                ?.checkPublished ??
                req.query
                  .checkPublished,
              true
            ),

          checkRestrictions:
            normalizeBoolean(
              req.body
                ?.checkRestrictions ??
                req.query
                  .checkRestrictions,
              true
            ),

          replaceExisting:
            normalizeBoolean(
              req.body
                ?.replaceExisting ??
                req.query
                  .replaceExisting,
              true
            )
        };

        const result =
          await startAmazonEngineScan(
            variants,
            options
          );

        if (!result.success) {
          return res
            .status(409)
            .json({
              ...result,
              variantSource,
              receivedVariants:
                variants.length
            });
        }

        res
          .status(202)
          .json({
            ...result,
            variantSource,
            receivedVariants:
              variants.length,
            options,
            statusUrl:
              "/amazon-engine/status",
            dashboardUrl:
              "/amazon-engine/dashboard",
            resultsUrl:
              "/amazon-engine/results"
          });
      } catch (error) {
        sendError(
          res,
          500,
          error
        );
      }
    }
  );

  /* =======================================================
     RESCAN ONE VARIANT

     You may send the full Shopify variant in the body:

     {
       "variant": {
         "shopify_variant_id": "...",
         "sku": "...",
         "barcode": "...",
         "price": 39.99
       }
     }

     If no variant is provided, the route loads Shopify
     variants and finds the requested variant automatically.
  ======================================================= */

  router.post(
    "/rescan/:variantId",
    async (req, res) => {
      try {
        const variantId =
          normalizeVariantId(
            req.params.variantId
          );

        if (!variantId) {
          return sendError(
            res,
            400,
            "variantId is required"
          );
        }

        let variant =
          req.body?.variant ||
          null;

        let variantSource =
          "request-body";

        if (!variant) {
          const directVariants =
            extractVariants(
              req.body
            );

          variant =
            findVariant(
              directVariants,
              variantId
            );
        }

        if (!variant) {
          if (
            typeof getShopifyVariants !==
            "function"
          ) {
            return sendError(
              res,
              400,
              "Variant data was not supplied and the Shopify variant loader is unavailable."
            );
          }

          const shopifyData =
            await getShopifyVariants({
              productId:
                req.body?.productId ||
                req.query.productId ||
                null
            });

          const shopifyVariants =
            extractVariants(
              shopifyData
            );

          variant =
            findVariant(
              shopifyVariants,
              variantId
            );

          variantSource =
            "shopify";
        }

        if (!variant) {
          return sendError(
            res,
            404,
            "Shopify variant was not found.",
            {
              variantId
            }
          );
        }

        const options = {
          checkPublished:
            normalizeBoolean(
              req.body
                ?.checkPublished ??
                req.query
                  .checkPublished,
              true
            ),

          checkRestrictions:
            normalizeBoolean(
              req.body
                ?.checkRestrictions ??
                req.query
                  .checkRestrictions,
              true
            )
        };

        const result =
          await rescanAmazonEngineVariant(
            variant,
            options
          );

        res.json({
          ...result,
          variantSource,
          variantId,
          options
        });
      } catch (error) {
        sendError(
          res,
          500,
          error
        );
      }
    }
  );

  /* =======================================================
     CLEAR RESULTS
  ======================================================= */

  router.delete(
    "/results",
    (req, res) => {
      try {
        const data =
          clearAmazonEngineResults();

        if (!data.success) {
          return res
            .status(409)
            .json(data);
        }

        res.json(data);
      } catch (error) {
        sendError(
          res,
          500,
          error
        );
      }
    }
  );

  return router;
}

export default createAmazonEngineRouter;
