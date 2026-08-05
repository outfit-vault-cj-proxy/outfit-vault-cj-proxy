/* eslint-env node */
/* global process */

import express from "express"; 
import { analyzeAmazonReadiness } from "./amazonIntelligenceEngine.js";

const ROUTER_VERSION = "amazon-intelligence-routes-v3"; 
const DEFAULT_MAX_VARIANTS = 5000; 
const DEFAULT_DELAY_MS = 100; 
const DEFAULT_MINIMUM_SCORE = 85; 
const DEFAULT_SCAN_TIMEOUT_MS = 30 * 60 * 1000;

const intelligenceState = { 
status: "IDLE", 
runId: null, 
runType: null, 
startedAt: null, 
completedAt: null, 
sourceVariants: 0, 
totalVariants: 0, 
processedVariants: 0, 
variantSource: null, 
productId: null, 
maxVariants: null, 
delayMs: null, 
minimumScore: null, 
error: null, 
report: null 
};

/* = 
RESPONSE HELPERS 
= */

function sendError(res, status, error, extra = {}) { 
return res.status(status).json({ 
success: false, 
error: error instanceof Error ? error.message : String(error), 
...extra 
}); 
}

function normalizeNumber( 
value, 
fallback, 
minimum = null, 
maximum = null 
) { 
const number = Number(value);

if (!Number.isFinite(number)) { 
return fallback; 
}

let normalized = number;

if (minimum !== null) { 
normalized = Math.max(minimum, normalized); 
}

if (maximum !== null) { 
normalized = Math.min(maximum, normalized); 
}

return normalized; 
}

function normalizeBoolean(value, fallback) { 
if ( 
value === undefined || 
value === null || 
value === "" 
) { 
return fallback; 
}

if (typeof value === "boolean") { 
return value; 
}

const normalized = String(value) 
.trim() 
.toLowerCase();

if ( 
["true", "1", "yes", "on"].includes(normalized) 
) { 
return true; 
}

if ( 
["false", "0", "no", "off"].includes(normalized) 
) { 
return false; 
}

return fallback; 
}

function extractVariants(data) { 
if (Array.isArray(data)) { 
return data; 
}

if (Array.isArray(data?.variants)) { 
return data.variants; 
}

if (Array.isArray(data?.data?.variants)) { 
return data.data.variants; 
}

return []; 
}

function createRunId(prefix = "amazon-intelligence") { 
return [ 
prefix, 
Date.now().toString(36), 
Math.random().toString(36).slice(2, 10) 
].join("-"); 
}

function elapsedMs() { 
if (!intelligenceState.startedAt) { 
return 0; 
}

const start = 
new Date(intelligenceState.startedAt).getTime();

const end = 
intelligenceState.completedAt 
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
runType: intelligenceState.runType, 
startedAt: intelligenceState.startedAt, 
completedAt: intelligenceState.completedAt, 
elapsedMs: elapsedMs(), 
sourceVariants: intelligenceState.sourceVariants, 
totalVariants: intelligenceState.totalVariants, 
processedVariants: intelligenceState.processedVariants, 
variantSource: intelligenceState.variantSource, 
productId: intelligenceState.productId, 
maxVariants: intelligenceState.maxVariants, 
delayMs: intelligenceState.delayMs, 
minimumScore: intelligenceState.minimumScore, 
error: intelligenceState.error, 
hasReport: Boolean(intelligenceState.report), 
statusUrl: "/amazon-intelligence/status", 
reportUrl: "/amazon-intelligence/report" 
}; 
}

/* = 
AUTHENTICATION 
= */

function getProvidedAdminKey(req) { 
const directKey = 
req.headers["x-admin-key"] || 
req.headers["x-auth-secret"];

if (directKey) { 
return String(directKey).trim(); 
}

const authorization = String( 
req.headers.authorization || "" 
).trim();

if ( 
authorization 
.toLowerCase() 
.startsWith("bearer ") 
) { 
return authorization.slice(7).trim(); 
}

return ""; 
}

function getConfiguredAdminKey() { 
return String( 
process.env.ADMIN_API_KEY || 
process.env.AMAZON_AUTH_SECRET || 
"" 
).trim(); 
}

function requireAdmin(req, res, next) { 
const configuredKey = 
getConfiguredAdminKey();

if (!configuredKey) { 
return sendError( 
res, 
503, 
"ADMIN_API_KEY or AMAZON_AUTH_SECRET is not configured. Amazon Intelligence is disabled." 
); 
}

if ( 
getProvidedAdminKey(req) !==
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

/* = 
RUN STATE 
= */

function beginRun({ 
runId, 
runType, 
sourceVariants, 
totalVariants, 
variantSource, 
productId, 
maxVariants, 
delayMs, 
minimumScore 
}) { 
intelligenceState.status === "RUNNING"; 
intelligenceState.runId = runId; 
intelligenceState.runType = runType; 
intelligenceState.startedAt = 
new Date().toISOString(); 
intelligenceState.completedAt = null; 
intelligenceState.sourceVariants = 
sourceVariants; 
intelligenceState.totalVariants = 
totalVariants; 
intelligenceState.processedVariants = 0; 
intelligenceState.variantSource = 
variantSource; 
intelligenceState.productId = 
productId || null; 
intelligenceState.maxVariants = 
maxVariants; 
intelligenceState.delayMs = 
delayMs; 
intelligenceState.minimumScore = 
minimumScore; 
intelligenceState.error = null; 
intelligenceState.report = null; 
}

function completeRun(runId, report) { 
if ( 
intelligenceState.runId !== runId 
) { 
return; 
}

intelligenceState.report = report; 
intelligenceState.status = "COMPLETED"; 
intelligenceState.processedVariants = 
Number( 
report?.receivedVariants || 
report?.reports?.length || 
intelligenceState.totalVariants 
); 
intelligenceState.completedAt = 
new Date().toISOString(); 
intelligenceState.error = null; 
}

function failRun(runId, error) { 
if ( 
runId && 
intelligenceState.runId !== runId 
) { 
return; 
}

intelligenceState.status = "FAILED"; 
intelligenceState.error = 
error instanceof Error 
? error.message 
: String(error); 
intelligenceState.completedAt = 
new Date().toISOString(); 
}

function withTimeout( 
promise, 
timeoutMs, 
label 
) { 
let timeoutId;

const timeout = new Promise( 
(_, reject) => { 
timeoutId = setTimeout( 
() => { 
reject( 
new Error(
`${label} exceeded ${timeoutMs}ms.`
) 
); 
}, 
timeoutMs 
); 
} 
);

return Promise 
.race([promise, timeout]) 
.finally(() => { 
clearTimeout(timeoutId); 
}); 
}

/* = 
BINARY READINESS 
= */

function buildAutoFixActions(report) { 
const blockers = Array.isArray( 
report?.blockers 
) 
? report.blockers 
: [];

return blockers.map((blocker) => { 
const code = String( 
blocker?.code || "UNKNOWN" 
);

const actions = {
  MISSING_BARCODE:
    "Add a valid GS1 UPC, EAN, or GTIN to the Shopify variant.",
  INVALID_LENGTH:
    "Replace the barcode with a valid 12, 13, or 14 digit identifier.",
  INVALID_CHECK_DIGIT:
    "Correct the barcode check digit or replace it with the supplier's verified barcode.",
  DUPLICATE_BARCODE:
    "Assign a unique barcode to every Shopify variant.",
  NO_AMAZON_MATCH:
    "Review catalog candidates or prepare a new Amazon catalog listing.",
  AMAZON_RESTRICTED:
    "Request Amazon approval or choose an unrestricted product.",
  OUT_OF_STOCK:
    "Increase Shopify inventory before publishing.",
  MISSING_SKU:
    "Create a unique seller SKU for the Shopify variant.",
  MISSING_SUPPLIER_COSTS:
    "Add CJ product and shipping costs so profitability can be confirmed.",
  INCOMPLETE_VARIATION_OPTIONS:
    "Complete all size, color, and style option values for every variant."
};

return {
  code,
  message:
    blocker?.message ||
    "Review this readiness blocker.",
  recommendedAction:
    actions[code] ||
    "Review and correct the product data, then run the analysis again.",
  automatic:
    [
      "MISSING_SKU",
      "INCOMPLETE_VARIATION_OPTIONS"
    ].includes(code)
};
}); 
}

function applyBinaryReadiness( 
report, 
minimumScore 
) { 
const reports = Array.isArray( 
report?.reports 
) 
? report.reports.map((entry) => { 
const scanReady = 
entry?.scan?.status === "READY";

    const scoreReady =
      Number(entry?.amazonReadyScore || 0) >=
      minimumScore;

    const hasBlockers =
      Array.isArray(entry?.blockers) &&
      entry.blockers.length > 0;

    const readinessStatus =
      scanReady &&
      scoreReady &&
      !hasBlockers
        ? "AMAZON_READY"
        : "NOT_AMAZON_READY";

    return {
      ...entry,
      readinessStatus,
      publishEligible:
        readinessStatus ===
        "AMAZON_READY",
      autoFixAvailable:
        buildAutoFixActions(entry)
          .some(
            (action) =>
              action.automatic
          ),
      autoFixActions:
        buildAutoFixActions(entry)
    };
  })
: [];
const amazonReady = 
reports.filter( 
(entry) => 
entry.readinessStatus ===
"AMAZON_READY" 
).length;

const notAmazonReady = 
reports.length - amazonReady;

return { 
...report, 
decisionModel: "BINARY_READINESS", 
publishPolicy: 
"Only products with readinessStatus AMAZON_READY are eligible for publishing.", 
minimumReadyScore: minimumScore, 
summary: { 
...(report?.summary || {}), 
total: reports.length, 
amazonReady, 
notAmazonReady 
}, 
reports 
}; 
}

/* = 
ROUTER 
= */

export function createAmazonIntelligenceRouter( 
dependencies = {} 
) { 
const router = express.Router();

const { 
getShopifyVariants, 
onAnalysisComplete 
} = dependencies;

async function loadVariants(req) { 
let variants = 
extractVariants(req.body);

if (variants.length > 0) {
  return {
    variants,
    source: "request-body"
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

const productId =
  req.body?.productId ||
  req.query?.productId ||
  null;

const shopifyData =
  await getShopifyVariants({
    productId
  });

variants =
  extractVariants(shopifyData);

return {
  variants,
  source: "shopify"
};
}

function getOptions( 
req, 
defaults = {} 
) { 
return { 
maxVariants: 
Math.floor( 
normalizeNumber( 
req.body?.maxVariants ?? 
req.query?.maxVariants, 
defaults.maxVariants ?? 
DEFAULT_MAX_VARIANTS, 
1, 
5000 
) 
),

  delayMs:
    Math.floor(
      normalizeNumber(
        req.body?.delayMs ??
        req.query?.delayMs,
        defaults.delayMs ??
        DEFAULT_DELAY_MS,
        0,
        10000
      )
    ),

  minimumScore:
    normalizeNumber(
      req.body?.minimumScore ??
      req.query?.minimumScore,
      defaults.minimumScore ??
      DEFAULT_MINIMUM_SCORE,
      0,
      100
    ),

  scanTimeoutMs:
    Math.floor(
      normalizeNumber(
        req.body?.scanTimeoutMs ??
        req.query?.scanTimeoutMs,
        defaults.scanTimeoutMs ??
        DEFAULT_SCAN_TIMEOUT_MS,
        30000,
        60 * 60 * 1000
      )
    ),

  checkPublished:
    normalizeBoolean(
      req.body?.checkPublished ??
      req.query?.checkPublished,
      true
    ),

  checkRestrictions:
    normalizeBoolean(
      req.body?.checkRestrictions ??
      req.query?.checkRestrictions,
      true
    ),

  costs:
    Array.isArray(req.body?.costs)
      ? req.body.costs
      : [],

  profitability:
    req.body?.profitability ||
    {}
};
}

async function prepareScan( 
req, 
defaults = {} 
) { 
const loaded = 
await loadVariants(req);

const sourceVariants =
  loaded.variants.length;

if (sourceVariants === 0) {
  throw new Error(
    "No active Shopify variants were found."
  );
}

const options =
  getOptions(req, defaults);

const variants =
  loaded.variants.slice(
    0,
    options.maxVariants
  );

return {
  variants,
  sourceVariants,
  variantSource:
    loaded.source,
  productId:
    req.body?.productId ||
    req.query?.productId ||
    null,
  options
};
}

async function runAnalysis( 
prepared, 
runId 
) { 
const rawReport = 
await withTimeout( 
analyzeAmazonReadiness( 
prepared.variants, 
prepared.options 
), 
prepared.options.scanTimeoutMs, 
"Amazon Intelligence analysis" 
);

const report =
  applyBinaryReadiness(
    rawReport,
    prepared.options.minimumScore
  );

const finalReport = {
  ...report,
  runId,
  variantSource:
    prepared.variantSource,
  sourceVariants:
    prepared.sourceVariants,
  receivedVariants:
    prepared.variants.length,
  productId:
    prepared.productId,
  limits: {
    maxVariants:
      prepared.options.maxVariants,
    delayMs:
      prepared.options.delayMs,
    minimumScore:
      prepared.options.minimumScore,
    scanTimeoutMs:
      prepared.options.scanTimeoutMs
  }
};

if (
  typeof onAnalysisComplete ===
  "function"
) {
  await onAnalysisComplete(
    finalReport
  );
}

return finalReport;
}

async function executeForegroundRun( 
req, 
res, 
{ 
runType, 
defaults = {} 
} 
) { 
if ( 
intelligenceState.status ===
"RUNNING" 
) { 
return res.status(409).json({ 
success: false, 
error: 
"An Amazon Intelligence analysis is already running.", 
...stateResponse() 
}); 
}

const prepared =
  await prepareScan(
    req,
    defaults
  );

const runId =
  createRunId(runType);

beginRun({
  runId,
  runType,
  sourceVariants:
    prepared.sourceVariants,
  totalVariants:
    prepared.variants.length,
  variantSource:
    prepared.variantSource,
  productId:
    prepared.productId,
  maxVariants:
    prepared.options.maxVariants,
  delayMs:
    prepared.options.delayMs,
  minimumScore:
    prepared.options.minimumScore
});

try {
  const finalReport =
    await runAnalysis(
      prepared,
      runId
    );

  completeRun(
    runId,
    finalReport
  );

  return res.json(
    finalReport
  );
} catch (error) {
  failRun(runId, error);

  return sendError(
    res,
    500,
    error,
    stateResponse()
  );
}
}

async function executeBackgroundRun( 
req, 
res, 
{ 
runType, 
defaults = {} 
} 
) { 
if ( 
intelligenceState.status ===
"RUNNING" 
) { 
return res.status(202).json({ 
...stateResponse(), 
accepted: true, 
stillRunning: true, 
message: 
"Amazon Intelligence analysis is already running." 
}); 
}

const prepared =
  await prepareScan(
    req,
    defaults
  );

const runId =
  createRunId(runType);

beginRun({
  runId,
  runType,
  sourceVariants:
    prepared.sourceVariants,
  totalVariants:
    prepared.variants.length,
  variantSource:
    prepared.variantSource,
  productId:
    prepared.productId,
  maxVariants:
    prepared.options.maxVariants,
  delayMs:
    prepared.options.delayMs,
  minimumScore:
    prepared.options.minimumScore
});

res.status(202).json({
  ...stateResponse(),
  accepted: true,
  stillRunning: true,
  message:
    "Amazon Intelligence analysis started in the background."
});

void (async () => {
  try {
    const finalReport =
      await runAnalysis(
        prepared,
        runId
      );

    completeRun(
      runId,
      finalReport
    );
  } catch (error) {
    failRun(
      runId,
      error
    );
  }
})();

return undefined;
}

/* = 
ROUTE DIRECTORY 
= */

router.get("/", (req, res) => { 
res.json({ 
success: true, 
version: ROUTER_VERSION, 
message: 
"Amazon Intelligence Engine is running.", 
decisionModel: 
"BINARY_READINESS", 
publishingEnabled: false, 
defaults: { 
maxVariants: 
DEFAULT_MAX_VARIANTS, 
delayMs: 
DEFAULT_DELAY_MS, 
minimumScore: 
DEFAULT_MINIMUM_SCORE, 
scanTimeoutMs: 
DEFAULT_SCAN_TIMEOUT_MS 
}, 
routes: { 
status: 
"GET /amazon-intelligence/status", 
report: 
"GET /amazon-intelligence/report", 
analyze: 
"POST /amazon-intelligence/analyze", 
analyzeAll: 
"POST /amazon-intelligence/analyze-all", 
analyzeProduct: 
"POST /amazon-intelligence/analyze-product", 
startScan: 
"POST /amazon-intelligence/start-scan", 
dailyRun: 
"POST /amazon-intelligence/run-daily-now", 
bestTestProduct: 
"POST /amazon-intelligence/find-best-test-product", 
autoFix: 
"POST /amazon-intelligence/auto-fix" 
} 
}); 
});

router.get( 
"/status", 
requireAdmin, 
(req, res) => { 
res.json( 
stateResponse() 
); 
} 
);

router.get( 
"/report", 
requireAdmin, 
(req, res) => { 
if ( 
intelligenceState.status ===
"RUNNING" 
) { 
return res.status(202).json({ 
...stateResponse(), 
accepted: true, 
stillRunning: true, 
message: 
"Amazon Intelligence analysis is still running." 
}); 
}

  if (
    intelligenceState.status ===
    "FAILED"
  ) {
    return sendError(
      res,
      500,
      intelligenceState.error ||
      "Amazon Intelligence analysis failed.",
      stateResponse()
    );
  }

  if (
    !intelligenceState.report
  ) {
    return sendError(
      res,
      404,
      "No Amazon Intelligence report exists yet.",
      stateResponse()
    );
  }

  return res.json(
    intelligenceState.report
  );
}
);

/* = 
FOREGROUND ANALYSIS 
= */

router.post( 
"/analyze", 
requireAdmin, 
async (req, res) => { 
try { 
return await executeForegroundRun( 
req, 
res, 
{ 
runType: "MANUAL_ANALYZE", 
defaults: { 
maxVariants: 100, 
delayMs: 0 
} 
} 
); 
} catch (error) { 
return sendError( 
res, 
500, 
error, 
stateResponse() 
); 
} 
} 
);

router.post( 
"/analyze-all", 
requireAdmin, 
async (req, res) => { 
try { 
return await executeForegroundRun( 
req, 
res, 
{ 
runType: "ANALYZE_ALL", 
defaults: { 
maxVariants: 
DEFAULT_MAX_VARIANTS, 
delayMs: 
DEFAULT_DELAY_MS 
} 
} 
); 
} catch (error) { 
return sendError( 
res, 
500, 
error, 
stateResponse() 
); 
} 
} 
);

router.post( 
"/analyze-product", 
requireAdmin, 
async (req, res) => { 
try { 
const productId = 
req.body?.productId || 
req.query?.productId;

    if (!productId) {
      return sendError(
        res,
        400,
        "productId is required."
      );
    }

    return await executeForegroundRun(
      req,
      res,
      {
        runType:
          "ANALYZE_PRODUCT",
        defaults: {
          maxVariants: 100,
          delayMs: 0
        }
      }
    );
  } catch (error) {
    return sendError(
      res,
      500,
      error,
      stateResponse()
    );
  }
}
);

/* = 
BACKGROUND ANALYSIS 
= */

router.post( 
"/start-scan", 
requireAdmin, 
async (req, res) => { 
try { 
return await executeBackgroundRun( 
req, 
res, 
{ 
runType: 
"BACKGROUND_SCAN" 
} 
); 
} catch (error) { 
return sendError( 
res, 
500, 
error, 
stateResponse() 
); 
} 
} 
);

router.post( 
"/start-best-test-product-scan", 
requireAdmin, 
async (req, res) => { 
try { 
return await executeBackgroundRun( 
req, 
res, 
{ 
runType: 
"BEST_TEST_PRODUCT_SCAN" 
} 
); 
} catch (error) { 
return sendError( 
res, 
500, 
error, 
stateResponse() 
); 
} 
} 
);

router.post( 
"/run-daily-now", 
requireAdmin, 
async (req, res) => { 
try { 
return await executeBackgroundRun( 
req, 
res, 
{ 
runType: 
"DAILY_SCHEDULED_SCAN", 
defaults: { 
maxVariants: 
DEFAULT_MAX_VARIANTS, 
delayMs: 
DEFAULT_DELAY_MS, 
minimumScore: 
DEFAULT_MINIMUM_SCORE 
} 
} 
); 
} catch (error) { 
return sendError( 
res, 
500, 
error, 
stateResponse() 
); 
} 
} 
);

/* = 
BEST TEST PRODUCT 
= */

router.post( 
"/find-best-test-product", 
requireAdmin, 
async (req, res) => { 
try { 
const refresh = 
normalizeBoolean( 
req.body?.refresh, 
false 
);

    if (refresh) {
      return await executeBackgroundRun(
        req,
        res,
        {
          runType:
            "BEST_TEST_PRODUCT_REFRESH"
        }
      );
    }

    if (
      intelligenceState.status ===
      "RUNNING"
    ) {
      return res.status(202).json({
        ...stateResponse(),
        accepted: true,
        stillRunning: true,
        message:
          "Amazon Intelligence analysis is still running."
      });
    }

    if (
      intelligenceState.status ===
      "FAILED"
    ) {
      return sendError(
        res,
        500,
        intelligenceState.error ||
        "Amazon Intelligence analysis failed.",
        stateResponse()
      );
    }

    if (
      !intelligenceState.report
    ) {
      return sendError(
        res,
        404,
        "No completed Amazon Intelligence report exists. Start a scan first.",
        stateResponse()
      );
    }

    return res.json({
      success: true,
      version: ROUTER_VERSION,
      status:
        intelligenceState.status,
      runId:
        intelligenceState.runId,
      summary:
        intelligenceState.report
          .summary,
      bestTestProduct:
        intelligenceState.report
          .bestTestProduct,
      limits:
        intelligenceState.report
          .limits ||
        null,
      note:
        "This route analyzes and recommends only. It does not publish an Amazon listing."
    });
  } catch (error) {
    return sendError(
      res,
      500,
      error,
      stateResponse()
    );
  }
}
);

/* = 
AUTO-FIX RECOMMENDATIONS 
= */

router.post( 
"/auto-fix", 
requireAdmin, 
async (req, res) => { 
try { 
const suppliedReport = 
req.body?.report || 
null;

    const report =
      suppliedReport ||
      intelligenceState.report;

    if (!report) {
      return sendError(
        res,
        404,
        "No Amazon Intelligence report is available."
      );
    }

    const requestedKey =
      String(
        req.body?.key ||
        req.body?.variantKey ||
        ""
      ).trim();

    const reports =
      Array.isArray(
        report.reports
      )
        ? report.reports
        : [];

    const selected =
      requestedKey
        ? reports.filter(
            (entry) =>
              String(
                entry?.key || ""
              ) ===
              requestedKey
          )
        : reports.filter(
            (entry) =>
              entry
                .readinessStatus ===
              "NOT_AMAZON_READY"
          );

    return res.json({
      success: true,
      version:
        ROUTER_VERSION,
      mode:
        "RECOMMENDATION_ONLY",
      changedShopifyData:
        false,
      count:
        selected.length,
      recommendations:
        selected.map(
          (entry) => ({
            key: entry.key,
            readinessStatus:
              entry.readinessStatus,
            amazonReadyScore:
              entry.amazonReadyScore,
            actions:
              entry.autoFixActions ||
              buildAutoFixActions(
                entry
              )
          })
        )
    });
  } catch (error) {
    return sendError(
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
