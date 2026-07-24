/* eslint-env node */
/* global process */

import express from "express";
import { analyzeAmazonReadiness } from "./amazonIntelligenceEngine.js";

const ROUTER_VERSION = "amazon-intelligence-routes-v2";
const DEFAULT_MAX_VARIANTS = 25;
const DEFAULT_DELAY_MS = 100;
const DEFAULT_MINIMUM_SCORE = 70;
const DEFAULT_SCAN_TIMEOUT_MS = 10 * 60 * 1000;

const intelligenceState = {
  status: "IDLE",
  runId: null,
  startedAt: null,
  completedAt: null,
  sourceVariants: 0,
  totalVariants: 0,
  variantSource: null,
  maxVariants: null,
  delayMs: null,
  minimumScore: null,
  error: null,
  report: null
};

function sendError(res, status, error, extra = {}) {
  return res.status(status).json({
    success: false,
    error: error instanceof Error ? error.message : String(error),
    ...extra
  });
}

function normalizeNumber(value, fallback, minimum = null, maximum = null) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;

  let normalized = number;
  if (minimum !== null) normalized = Math.max(minimum, normalized);
  if (maximum !== null) normalized = Math.min(maximum, normalized);
  return normalized;
}

function normalizeBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;

  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function extractVariants(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.variants)) return data.variants;
  if (Array.isArray(data?.data?.variants)) return data.data.variants;
  return [];
}

function createRunId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function elapsedMs() {
  if (!intelligenceState.startedAt) return 0;
  const start = new Date(intelligenceState.startedAt).getTime();
  const end = intelligenceState.completedAt
    ? new Date(intelligenceState.completedAt).getTime()
    : Date.now();
  return Math.max(0, end - start);
}

function stateResponse() {
  return {
    success: true,
    version: ROUTER_VERSION,
    status: intelligenceState.status,
    runId: intelligenceState.runId,
    startedAt: intelligenceState.startedAt,
    completedAt: intelligenceState.completedAt,
    elapsedMs: elapsedMs(),
    sourceVariants: intelligenceState.sourceVariants,
    totalVariants: intelligenceState.totalVariants,
    variantSource: intelligenceState.variantSource,
    maxVariants: intelligenceState.maxVariants,
    delayMs: intelligenceState.delayMs,
    minimumScore: intelligenceState.minimumScore,
    error: intelligenceState.error,
    hasReport: Boolean(intelligenceState.report),
    statusUrl: "/amazon-intelligence/status",
    reportUrl: "/amazon-intelligence/report"
  };
}

function beginRun({
  runId,
  sourceVariants,
  totalVariants,
  variantSource,
  maxVariants,
  delayMs,
  minimumScore
}) {
  intelligenceState.status = "RUNNING";
  intelligenceState.runId = runId;
  intelligenceState.startedAt = new Date().toISOString();
  intelligenceState.completedAt = null;
  intelligenceState.sourceVariants = sourceVariants;
  intelligenceState.totalVariants = totalVariants;
  intelligenceState.variantSource = variantSource;
  intelligenceState.maxVariants = maxVariants;
  intelligenceState.delayMs = delayMs;
  intelligenceState.minimumScore = minimumScore;
  intelligenceState.error = null;
  intelligenceState.report = null;
}

function completeRun(runId, report) {
  if (intelligenceState.runId !== runId) return;
  intelligenceState.report = report;
  intelligenceState.status = "COMPLETED";
  intelligenceState.completedAt = new Date().toISOString();
  intelligenceState.error = null;
}

function failRun(runId, error) {
  if (runId && intelligenceState.runId !== runId) return;
  intelligenceState.status = "FAILED";
  intelligenceState.error = error instanceof Error ? error.message : String(error);
  intelligenceState.completedAt = new Date().toISOString();
}

function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} exceeded ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function getProvidedAdminKey(req) {
  const directKey = req.headers["x-admin-key"];
  if (directKey) return String(directKey).trim();

  const authorization = String(req.headers.authorization || "").trim();
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  return "";
}

function requireAdmin(req, res, next) {
  const configuredKey = String(process.env.ADMIN_API_KEY || "").trim();

  if (!configuredKey) {
    return sendError(
      res,
      503,
      "ADMIN_API_KEY is not configured. Amazon Intelligence is disabled."
    );
  }

  if (getProvidedAdminKey(req) !== configuredKey) {
    return sendError(res, 401, "Administrator authorization is required.");
  }

  next();
}

export function createAmazonIntelligenceRouter(dependencies = {}) {
  const router = express.Router();
  const { getShopifyVariants } = dependencies;

  async function loadVariants(req) {
    let variants = extractVariants(req.body);

    if (variants.length > 0) {
      return { variants, source: "request-body" };
    }

    if (typeof getShopifyVariants !== "function") {
      throw new Error("The Shopify variant loader is unavailable.");
    }

    const shopifyData = await getShopifyVariants({
      productId: req.body?.productId || req.query.productId || null
    });

    variants = extractVariants(shopifyData);
    return { variants, source: "shopify" };
  }

  function getOptions(req, defaults = {}) {
    return {
      maxVariants: Math.floor(
        normalizeNumber(
          req.body?.maxVariants,
          defaults.maxVariants ?? DEFAULT_MAX_VARIANTS,
          1,
          100
        )
      ),
      delayMs: Math.floor(
        normalizeNumber(
          req.body?.delayMs,
          defaults.delayMs ?? DEFAULT_DELAY_MS,
          0,
          10000
        )
      ),
      minimumScore: normalizeNumber(
        req.body?.minimumScore,
        DEFAULT_MINIMUM_SCORE,
        0,
        100
      ),
      scanTimeoutMs: Math.floor(
        normalizeNumber(
          req.body?.scanTimeoutMs,
          DEFAULT_SCAN_TIMEOUT_MS,
          30000,
          30 * 60 * 1000
        )
      ),
      checkPublished: normalizeBoolean(req.body?.checkPublished, true),
      checkRestrictions: normalizeBoolean(req.body?.checkRestrictions, true),
      costs: Array.isArray(req.body?.costs) ? req.body.costs : [],
      profitability: req.body?.profitability || {}
    };
  }

  async function prepareScan(req, defaults = {}) {
    const loaded = await loadVariants(req);
    const sourceVariants = loaded.variants.length;

    if (sourceVariants === 0) {
      throw new Error("No active Shopify variants were found.");
    }

    const options = getOptions(req, defaults);
    const variants = loaded.variants.slice(0, options.maxVariants);

    return {
      variants,
      sourceVariants,
      variantSource: loaded.source,
      options
    };
  }

  async function runAnalysis(prepared, runId) {
    const report = await withTimeout(
      analyzeAmazonReadiness(prepared.variants, prepared.options),
      prepared.options.scanTimeoutMs,
      "Amazon Intelligence analysis"
    );

    return {
      ...report,
      runId,
      variantSource: prepared.variantSource,
      sourceVariants: prepared.sourceVariants,
      receivedVariants: prepared.variants.length,
      limits: {
        maxVariants: prepared.options.maxVariants,
        delayMs: prepared.options.delayMs,
        scanTimeoutMs: prepared.options.scanTimeoutMs
      }
    };
  }

  router.get("/", (req, res) => {
    res.json({
      success: true,
      version: ROUTER_VERSION,
      message: "Amazon Intelligence Engine is running.",
      publishingEnabled: false,
      defaults: {
        maxVariants: DEFAULT_MAX_VARIANTS,
        delayMs: DEFAULT_DELAY_MS,
        minimumScore: DEFAULT_MINIMUM_SCORE,
        scanTimeoutMs: DEFAULT_SCAN_TIMEOUT_MS
      },
      routes: {
        status: "GET /amazon-intelligence/status",
        report: "GET /amazon-intelligence/report",
        analyze: "POST /amazon-intelligence/analyze",
        startBestTestProductScan:
          "POST /amazon-intelligence/start-best-test-product-scan",
        bestTestProduct:
          "POST /amazon-intelligence/find-best-test-product"
      }
    });
  });

  router.get("/status", requireAdmin, (req, res) => {
    res.json(stateResponse());
  });

  router.get("/report", requireAdmin, (req, res) => {
    if (intelligenceState.status === "RUNNING") {
      return res.status(202).json({
        ...stateResponse(),
        accepted: true,
        stillRunning: true,
        message: "Amazon Intelligence analysis is still running."
      });
    }

    if (intelligenceState.status === "FAILED") {
      return sendError(
        res,
        500,
        intelligenceState.error || "Amazon Intelligence analysis failed.",
        stateResponse()
      );
    }

    if (!intelligenceState.report) {
      return sendError(
        res,
        404,
        "No Amazon Intelligence report exists yet.",
        stateResponse()
      );
    }

    res.json(intelligenceState.report);
  });

  router.post("/analyze", requireAdmin, async (req, res) => {
    try {
      if (intelligenceState.status === "RUNNING") {
        return res.status(409).json({
          success: false,
          error: "An Amazon Intelligence analysis is already running.",
          ...stateResponse()
        });
      }

      const prepared = await prepareScan(req, {
        maxVariants: 10,
        delayMs: 0
      });
      const runId = createRunId();

      beginRun({
        runId,
        sourceVariants: prepared.sourceVariants,
        totalVariants: prepared.variants.length,
        variantSource: prepared.variantSource,
        maxVariants: prepared.options.maxVariants,
        delayMs: prepared.options.delayMs,
        minimumScore: prepared.options.minimumScore
      });

      const finalReport = await runAnalysis(prepared, runId);
      completeRun(runId, finalReport);
      res.json(finalReport);
    } catch (error) {
      failRun(intelligenceState.runId, error);
      sendError(res, 500, error, stateResponse());
    }
  });

  router.post(
    "/start-best-test-product-scan",
    requireAdmin,
    async (req, res) => {
      try {
        if (intelligenceState.status === "RUNNING") {
          return res.status(202).json({
            ...stateResponse(),
            accepted: true,
            stillRunning: true,
            message: "Amazon Intelligence analysis is already running."
          });
        }

        const prepared = await prepareScan(req);
        const runId = createRunId();

        beginRun({
          runId,
          sourceVariants: prepared.sourceVariants,
          totalVariants: prepared.variants.length,
          variantSource: prepared.variantSource,
          maxVariants: prepared.options.maxVariants,
          delayMs: prepared.options.delayMs,
          minimumScore: prepared.options.minimumScore
        });

        res.status(202).json({
          ...stateResponse(),
          accepted: true,
          stillRunning: true,
          message: "Amazon Intelligence analysis started in the background."
        });

        void (async () => {
          try {
            const finalReport = await runAnalysis(prepared, runId);
            completeRun(runId, finalReport);
          } catch (error) {
            failRun(runId, error);
          }
        })();
      } catch (error) {
        failRun(intelligenceState.runId, error);
        sendError(res, 500, error, stateResponse());
      }
    }
  );

  router.post(
    "/find-best-test-product",
    requireAdmin,
    async (req, res) => {
      try {
        const refresh = normalizeBoolean(req.body?.refresh, false);

        if (refresh) {
          if (intelligenceState.status === "RUNNING") {
            return res.status(202).json({
              ...stateResponse(),
              accepted: true,
              stillRunning: true,
              message: "Amazon Intelligence analysis is already running."
            });
          }

          const prepared = await prepareScan(req);
          const runId = createRunId();

          beginRun({
            runId,
            sourceVariants: prepared.sourceVariants,
            totalVariants: prepared.variants.length,
            variantSource: prepared.variantSource,
            maxVariants: prepared.options.maxVariants,
            delayMs: prepared.options.delayMs,
            minimumScore: prepared.options.minimumScore
          });

          res.status(202).json({
            ...stateResponse(),
            accepted: true,
            stillRunning: true,
            message: "Amazon Intelligence analysis started in the background."
          });

          void (async () => {
            try {
              const finalReport = await runAnalysis(prepared, runId);
              completeRun(runId, finalReport);
            } catch (error) {
              failRun(runId, error);
            }
          })();

          return;
        }

        if (intelligenceState.status === "RUNNING") {
          return res.status(202).json({
            ...stateResponse(),
            accepted: true,
            stillRunning: true,
            message: "Amazon Intelligence analysis is still running."
          });
        }

        if (intelligenceState.status === "FAILED") {
          return sendError(
            res,
            500,
            intelligenceState.error || "Amazon Intelligence analysis failed.",
            stateResponse()
          );
        }

        if (!intelligenceState.report) {
          return sendError(
            res,
            404,
            "No completed Amazon Intelligence report exists. Start a scan first.",
            stateResponse()
          );
        }

        res.json({
          success: true,
          version: ROUTER_VERSION,
          status: intelligenceState.status,
          runId: intelligenceState.runId,
          summary: intelligenceState.report.summary,
          bestTestProduct: intelligenceState.report.bestTestProduct,
          limits: intelligenceState.report.limits || null,
          note:
            "This route analyzes and recommends only. It does not publish an Amazon listing."
        });
      } catch (error) {
        sendError(res, 500, error, stateResponse());
      }
    }
  );

  return router;
}

export default createAmazonIntelligenceRouter;
