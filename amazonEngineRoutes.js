/* eslint-env node */
/* global process */

import express from "express";

import {
  startAmazonEngineScan,
  rescanAmazonEngineVariant,
  scanAmazonVariant,
  getAmazonEngineStatus,
  getAmazonEngineDashboard,
  getAmazonEngineResults,
  getAmazonEngineResult,
  clearAmazonEngineResults
} from "./amazonEngine.js";

import {
  previewOfferListing,
  createOfferListing
} from "./amazon.js";

/* =========================================================
   AMAZON ENGINE ROUTER
   Version: 2.0.0

   Admin-only Amazon publishing tools.

   Routes:

   GET    /amazon-engine
   GET    /amazon-engine/status
   GET    /amazon-engine/dashboard
   GET    /amazon-engine/results
   GET    /amazon-engine/result/:variantId

   POST   /amazon-engine/scan
   POST   /amazon-engine/rescan/:variantId
   POST   /amazon-engine/find-and-publish-one

   DELETE /amazon-engine/results
========================================================= */

const ROUTER_VERSION =
  "amazon-engine-routes-v2";

const dailyPublisherState = {
  date: null,
  published: false,
  result: null
};

/* =========================================================
   GENERAL HELPERS
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
    typeof value === "boolean"
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

function sleep(
  milliseconds
) {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        milliseconds
      )
  );
}

function getTodayKey() {
  return new Date()
    .toISOString()
    .slice(0, 10);
}

/* =========================================================
   ADMIN AUTHENTICATION

   Railway variable required:

   ADMIN_API_KEY=your-long-private-secret

   Supported headers:

   x-admin-key: your-secret

   or:

   Authorization: Bearer your-secret
========================================================= */

function getProvidedAdminKey(
  req
) {
  const directKey =
    req.headers[
      "x-admin-key"
    ];

  if (directKey) {
    return String(
      directKey
    ).trim();
  }

  const authorization =
    String(
      req.headers
        .authorization ||
      ""
    ).trim();

  if (
    authorization
      .toLowerCase()
      .startsWith(
        "bearer "
      )
  ) {
    return authorization
      .slice(7)
      .trim();
  }

  return "";
}

function requireAdmin(
  req,
  res,
  next
) {
  const configuredKey =
    String(
      process.env
        .ADMIN_API_KEY ||
      ""
    ).trim();

  if (!configuredKey) {
    return sendError(
      res,
      503,
      "ADMIN_API_KEY is not configured. The admin publishing route is disabled."
    );
  }

  const providedKey =
    getProvidedAdminKey(
      req
    );

  if (
    !providedKey ||
    providedKey !==
      configuredKey
  ) {
    return sendError(
      res,
      401,
      "Administrator authorization is required."
    );
  }

  next();
}

/* =========================================================
   LOCAL AMAZON CANDIDATE CHECK
========================================================= */

function normalizeBarcode(
  value
) {
  return String(
    value || ""
  )
    .replace(/\s+/g, "")
    .replace(/[^0-9]/g, "");
}

function isValidBarcode(
  value
) {
  const barcode =
    normalizeBarcode(
      value
    );

  return [
    12,
    13,
    14
  ].includes(
    barcode.length
  );
}

function isLocalCandidate(
  variant
) {
  const sku =
    String(
      variant?.sku ||
      ""
    ).trim();

  const price =
    Number(
      variant?.price
    );

  const quantity =
    Number(
      variant
        ?.inventoryQuantity ??
      variant
        ?.inventory_quantity ??
      0
    );

  const image =
    variant?.image ||
    null;

  return Boolean(
    sku &&
    Number.isFinite(price) &&
    price > 0 &&
    Number.isFinite(quantity) &&
    quantity > 0 &&
    image &&
    isValidBarcode(
      variant?.barcode
    )
  );
}

/* =========================================================
   CANDIDATE PRIORITY SCORE

   This ranks locally valid products before Amazon API calls.

   It favors:
   - More inventory
   - Complete product information
   - Useful selling prices
   - Products with compare-at pricing
========================================================= */

function calculateCandidatePriority(
  variant
) {
  const quantity =
    Math.max(
      0,
      Number(
        variant
          ?.inventoryQuantity ??
        variant
          ?.inventory_quantity ??
        0
      ) || 0
    );

  const price =
    Math.max(
      0,
      Number(
        variant?.price
      ) || 0
    );

  const compareAtPrice =
    Math.max(
      0,
      Number(
        variant
          ?.compareAtPrice
      ) || 0
    );

  let score = 50;

  score += Math.min(
    20,
    quantity
  );

  if (
    price >= 20 &&
    price <= 150
  ) {
    score += 15;
  } else if (
    price > 150
  ) {
    score += 8;
  } else {
    score += 5;
  }

  if (
    compareAtPrice >
    price
  ) {
    score += 10;
  }

  if (
    variant?.vendor
  ) {
    score += 3;
  }

  if (
    variant?.productType
  ) {
    score += 2;
  }

  return score;
}

function rankCandidates(
  variants
) {
  return variants
    .filter(
      isLocalCandidate
    )
    .map(
      (variant) => ({
        variant,
        priorityScore:
          calculateCandidatePriority(
            variant
          )
      })
    )
    .sort(
      (a, b) =>
        b.priorityScore -
        a.priorityScore
    );
}

/* =========================================================
   ROUTER FACTORY
========================================================= */

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
        adminPublishingProtected:
          true,
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
          findAndPublishOne:
            "POST /amazon-engine/find-and-publish-one",
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
        res.json(
          getAmazonEngineStatus()
        );
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
        res.json(
          getAmazonEngineDashboard()
        );
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

        res.json(
          getAmazonEngineResults(
            filters
          )
        );
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

          variant =
            findVariant(
              extractVariants(
                shopifyData
              ),
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
     FIND AND PUBLISH EXACTLY ONE ITEM

     Admin-only.

     Required request body:

     {
       "confirmation": "PUBLISH_ONE"
     }

     Optional:

     {
       "maxCandidates": 25,
       "delayMs": 750,
       "quantityLimit": 1,
       "allowSecondToday": false
     }
  ======================================================= */

  router.post(
    "/find-and-publish-one",
    requireAdmin,
    async (req, res) => {
      try {
        const confirmation =
          String(
            req.body
              ?.confirmation ||
            ""
          )
            .trim()
            .toUpperCase();

        if (
          confirmation !==
          "PUBLISH_ONE"
        ) {
          return sendError(
            res,
            400,
            "Publishing confirmation is required.",
            {
              requiredConfirmation:
                "PUBLISH_ONE"
            }
          );
        }

        if (
          typeof getShopifyVariants !==
          "function"
        ) {
          return sendError(
            res,
            503,
            "The Shopify variant loader is unavailable."
          );
        }

        const today =
          getTodayKey();

        if (
          dailyPublisherState.date !==
          today
        ) {
          dailyPublisherState.date =
            today;

          dailyPublisherState.published =
            false;

          dailyPublisherState.result =
            null;
        }

        const allowSecondToday =
          normalizeBoolean(
            req.body
              ?.allowSecondToday,
            false
          );

        if (
          dailyPublisherState.published &&
          !allowSecondToday
        ) {
          return res
            .status(409)
            .json({
              success: false,
              error:
                "One item has already been published during this server session today.",
              date:
                today,
              previousResult:
                dailyPublisherState.result
            });
        }

        const maxCandidates =
          normalizeNumber(
            req.body
              ?.maxCandidates,
            25,
            1,
            100
          );

        const delayMs =
          normalizeNumber(
            req.body
              ?.delayMs,
            750,
            0,
            10_000
          );

        const quantityLimit =
          Math.floor(
            normalizeNumber(
              req.body
                ?.quantityLimit,
              1,
              1,
              100
            )
          );

        const shopifyData =
          await getShopifyVariants();

        const variants =
          extractVariants(
            shopifyData
          );

        if (
          variants.length === 0
        ) {
          return sendError(
            res,
            404,
            "No active Shopify variants were found."
          );
        }

        const rankedCandidates =
          rankCandidates(
            variants
          );

        if (
          rankedCandidates.length ===
          0
        ) {
          return res
            .status(422)
            .json({
              success: false,
              error:
                "No locally eligible Shopify products were found.",
              requirements: [
                "SKU",
                "12, 13 or 14-digit barcode",
                "Price greater than zero",
                "Inventory greater than zero",
                "Product image"
              ],
              totalVariants:
                variants.length
            });
        }

        const candidatesToScan =
          rankedCandidates.slice(
            0,
            maxCandidates
          );

        const reviewed = [];

        let selected = null;

        for (
          let index = 0;
          index <
          candidatesToScan.length;
          index++
        ) {
          const candidate =
            candidatesToScan[index];

          const scan =
            await scanAmazonVariant(
              candidate.variant,
              {
                checkPublished:
                  true,
                checkRestrictions:
                  true
              }
            );

          reviewed.push({
            shopify_variant_id:
              scan
                .shopify_variant_id,
            sku:
              scan.sku,
            productTitle:
              scan.productTitle,
            status:
              scan.status,
            readinessScore:
              scan.readinessScore,
            asin:
              scan.amazon?.asin ||
              null,
            recommendation:
              scan.recommendation,
            error:
              scan.error
          });

          if (
            scan.status ===
            "READY" &&
            scan.amazon?.asin
          ) {
            selected = {
              scan,
              priorityScore:
                candidate
                  .priorityScore
            };

            break;
          }

          if (
            delayMs > 0 &&
            index <
              candidatesToScan.length -
                1
          ) {
            await sleep(
              delayMs
            );
          }
        }

        if (!selected) {
          return res
            .status(422)
            .json({
              success: false,
              error:
                "No Amazon-ready item was found among the candidates reviewed.",
              totalShopifyVariants:
                variants.length,
              locallyEligible:
                rankedCandidates.length,
              reviewedCount:
                reviewed.length,
              reviewed
            });
        }

        const availableQuantity =
          Math.max(
            0,
            Math.floor(
              Number(
                selected.scan
                  .inventoryQuantity
              ) || 0
            )
          );

        const publishQuantity =
          Math.min(
            availableQuantity,
            quantityLimit
          );

        if (
          publishQuantity <= 0
        ) {
          return sendError(
            res,
            422,
            "The selected product no longer has available inventory."
          );
        }

        const amazonProduct = {
          asin:
            selected.scan
              .amazon.asin,

          sku:
            selected.scan.sku,

          price:
            selected.scan.price,

          quantity:
            publishQuantity,

          condition_type:
            "new_new",

          shopify_variant_id:
            selected.scan
              .shopify_variant_id
        };

        const preview =
          await previewOfferListing(
            amazonProduct
          );

        if (!preview?.success) {
          return res
            .status(
              Number.isInteger(
                preview?.status
              )
                ? preview.status
                : 422
            )
            .json({
              success: false,
              error:
                "Amazon validation preview did not approve the listing.",
              selectedProduct:
                selected.scan,
              preview,
              reviewed
            });
        }

        const publication =
          await createOfferListing(
            amazonProduct
          );

        if (!publication?.success) {
          return res
            .status(
              Number.isInteger(
                publication
                  ?.status
              )
                ? publication
                    .status
                : 502
            )
            .json({
              success: false,
              error:
                "Amazon did not accept the listing submission.",
              selectedProduct:
                selected.scan,
              preview,
              publication,
              reviewed
            });
        }

        const finalResult = {
          success: true,
          message:
            "One Amazon-ready Shopify item was submitted to Amazon.",
          date:
            today,
          selectedProduct: {
            productTitle:
              selected.scan
                .productTitle,
            variantTitle:
              selected.scan
                .variantTitle,
            shopifyProductId:
              selected.scan
                .shopify_product_id,
            shopifyVariantId:
              selected.scan
                .shopify_variant_id,
            sku:
              selected.scan.sku,
            barcode:
              selected.scan
                .barcode,
            image:
              selected.scan.image,
            price:
              selected.scan.price,
            availableInventory:
              selected.scan
                .inventoryQuantity,
            publishedQuantity:
              publishQuantity,
            readinessScore:
              selected.scan
                .readinessScore,
            priorityScore:
              selected
                .priorityScore,
            amazonAsin:
              selected.scan
                .amazon.asin,
            amazonTitle:
              selected.scan
                .amazon.title,
            amazonBrand:
              selected.scan
                .amazon.brand
          },
          preview,
          publication,
          scanSummary: {
            totalShopifyVariants:
              variants.length,
            locallyEligible:
              rankedCandidates.length,
            reviewedCount:
              reviewed.length
          },
          reviewed
        };

        dailyPublisherState.date =
          today;

        dailyPublisherState.published =
          true;

        dailyPublisherState.result =
          finalResult
            .selectedProduct;

        res
          .status(201)
          .json(
            finalResult
          );
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
     CLEAR ENGINE RESULTS
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
