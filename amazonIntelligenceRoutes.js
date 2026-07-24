/* eslint-env node */
/* global process */

import express from "express";

import {
  analyzeAmazonReadiness
} from "./amazonIntelligenceEngine.js";

/* =========================================================
   AMAZON INTELLIGENCE ROUTES
========================================================= */

const ROUTER_VERSION =
  "amazon-intelligence-routes-v1";

const intelligenceState = {
  status: "IDLE",
  startedAt: null,
  completedAt: null,
  error: null,
  report: null
};

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

/* =========================================================
   ADMIN AUTHENTICATION
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
      "ADMIN_API_KEY is not configured. Amazon Intelligence is disabled."
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
   ROUTER FACTORY
========================================================= */

export function createAmazonIntelligenceRouter(
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
          "Amazon Intelligence Engine is running.",

        publishingEnabled:
          false,

        routes: {
          status:
            "GET /amazon-intelligence/status",

          report:
            "GET /amazon-intelligence/report",

          analyze:
            "POST /amazon-intelligence/analyze",

          bestTestProduct:
            "POST /amazon-intelligence/find-best-test-product"
        }
      });
    }
  );

  /* =======================================================
     STATUS
  ======================================================= */

  router.get(
    "/status",
    requireAdmin,
    (req, res) => {
      res.json({
        success: true,

        version:
          ROUTER_VERSION,

        status:
          intelligenceState.status,

        startedAt:
          intelligenceState.startedAt,

        completedAt:
          intelligenceState.completedAt,

        error:
          intelligenceState.error,

        hasReport:
          Boolean(
            intelligenceState.report
          )
      });
    }
  );

  /* =======================================================
     SAVED REPORT
  ======================================================= */

  router.get(
    "/report",
    requireAdmin,
    (req, res) => {
      if (
        !intelligenceState.report
      ) {
        return sendError(
          res,
          404,
          "No Amazon Intelligence report exists yet."
        );
      }

      res.json(
        intelligenceState.report
      );
    }
  );

  /* =======================================================
     LOAD SHOPIFY VARIANTS
  ======================================================= */

  async function loadVariants(
    req
  ) {
    let variants =
      extractVariants(
        req.body
      );

    if (
      variants.length > 0
    ) {
      return {
        variants,
        source:
          "request-body"
      };
    }

    if (
      typeof getShopifyVariants !==
      "function"
    ) {
      throw new Error(
        "The Shopify variant loader is unavailable."
      );
    }

    const shopifyData =
      await getShopifyVariants({
        productId:
          req.body
            ?.productId ||
          req.query
            .productId ||
          null
      });

    variants =
      extractVariants(
        shopifyData
      );

    return {
      variants,
      source:
        "shopify"
    };
  }

  /* =======================================================
     FULL INTELLIGENCE ANALYSIS
  ======================================================= */

  router.post(
    "/analyze",
    requireAdmin,
    async (req, res) => {
      try {
        if (
          intelligenceState
            .status ===
          "RUNNING"
        ) {
          return sendError(
            res,
            409,
            "An Amazon Intelligence analysis is already running."
          );
        }

        const {
          variants,
          source
        } =
          await loadVariants(
            req
          );

        if (
          variants.length ===
          0
        ) {
          return sendError(
            res,
            404,
            "No active Shopify variants were found."
          );
        }

        intelligenceState.status =
          "RUNNING";

        intelligenceState.startedAt =
          new Date()
            .toISOString();

        intelligenceState.completedAt =
          null;

        intelligenceState.error =
          null;

        const options = {
          delayMs:
            normalizeNumber(
              req.body
                ?.delayMs,
              750,
              0,
              60_000
            ),

          minimumScore:
            normalizeNumber(
              req.body
                ?.minimumScore,
              70,
              0,
              100
            ),

          checkPublished:
            normalizeBoolean(
              req.body
                ?.checkPublished,
              true
            ),

          checkRestrictions:
            normalizeBoolean(
              req.body
                ?.checkRestrictions,
              true
            ),

          costs:
            Array.isArray(
              req.body?.costs
            )
              ? req.body.costs
              : [],

          profitability:
            req.body
              ?.profitability ||
            {}
        };

        const report =
          await analyzeAmazonReadiness(
            variants,
            options
          );

        intelligenceState.report =
          report;

        intelligenceState.status =
          "COMPLETED";

        intelligenceState.completedAt =
          new Date()
            .toISOString();

        res.json({
          ...report,

          variantSource:
            source,

          receivedVariants:
            variants.length
        });
      } catch (error) {
        intelligenceState.status =
          "FAILED";

        intelligenceState.error =
          error instanceof Error
            ? error.message
            : String(error);

        intelligenceState.completedAt =
          new Date()
            .toISOString();

        sendError(
          res,
          500,
          error
        );
      }
    }
  );

  /* =======================================================
     FIND BEST TEST PRODUCT

     This route does not publish.
  ======================================================= */

  router.post(
    "/find-best-test-product",
    requireAdmin,
    async (req, res) => {
      try {
        const refresh =
          normalizeBoolean(
            req.body
              ?.refresh,
            true
          );

        let report =
          intelligenceState.report;

        let variantSource =
          "saved-report";

        if (
          refresh ||
          !report
        ) {
          const loaded =
            await loadVariants(
              req
            );

          const variants =
            loaded.variants;

          variantSource =
            loaded.source;

          if (
            variants.length ===
            0
          ) {
            return sendError(
              res,
              404,
              "No active Shopify variants were found."
            );
          }

          intelligenceState.status =
            "RUNNING";

          intelligenceState.startedAt =
            new Date()
              .toISOString();

          intelligenceState.error =
            null;

          report =
            await analyzeAmazonReadiness(
              variants,
              {
                delayMs:
                  normalizeNumber(
                    req.body
                      ?.delayMs,
                    750,
                    0,
                    60_000
                  ),

                minimumScore:
                  normalizeNumber(
                    req.body
                      ?.minimumScore,
                    70,
                    0,
                    100
                  ),

                checkPublished:
                  true,

                checkRestrictions:
                  true,

                costs:
                  Array.isArray(
                    req.body?.costs
                  )
                    ? req.body.costs
                    : [],

                profitability:
                  req.body
                    ?.profitability ||
                  {}
              }
            );

          intelligenceState.report =
            report;

          intelligenceState.status =
            "COMPLETED";

          intelligenceState.completedAt =
            new Date()
              .toISOString();
        }

        res.json({
          success: true,

          version:
            ROUTER_VERSION,

          variantSource,

          summary:
            report.summary,

          bestTestProduct:
            report
              .bestTestProduct,

          note:
            "This route analyzes and recommends only. It does not publish an Amazon listing."
        });
      } catch (error) {
        intelligenceState.status =
          "FAILED";

        intelligenceState.error =
          error instanceof Error
            ? error.message
            : String(error);

        intelligenceState.completedAt =
          new Date()
            .toISOString();

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

export default createAmazonIntelligenceRouter;
