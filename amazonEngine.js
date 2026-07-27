/* eslint-env node */

import {
  searchCatalogByIdentifier,
  searchCatalogItems,
  getListingRestrictions,
  getListingStatus
} from "./amazon.js";

import {
  chooseBestAmazonMatch
} from "./amazonMatcher.js";

/* =========================================================
   AMAZON PUBLISHING ENGINE
   Version: 1.0.0

   Purpose:
   - Analyze Shopify variants
   - Detect missing information
   - Search Amazon using UPC/EAN/GTIN
   - Check listing restrictions
   - Sort inventory into publishing queues
========================================================= */

const ENGINE_VERSION =
  "amazon-engine-v3.1-compliance";

const DEFAULT_MINIMUM_READY_SCORE = 85;

/*
  Results are stored in memory for the first version.

  Important:
  Railway may clear these results after a restart or
  new deployment. We will add permanent database storage
  after the scanner and dashboard are confirmed working.
*/

const engineState = {
  status: "IDLE",

  startedAt: null,
  completedAt: null,

  currentIndex: 0,
  totalVariants: 0,

  currentSku: null,
  currentTitle: null,

  error: null,

  results: new Map(),

  summary: createEmptySummary()
};

/* =========================================================
   SUMMARY
========================================================= */

function createEmptySummary() {
  return {
    products: 0,
    variants: 0,

    amazonReady: 0,
    notAmazonReady: 0,
    publishEligible: 0,

    ready: 0,
    published: 0,
    restricted: 0,
    needsUpc: 0,
    noMatch: 0,
    needsReview: 0,
    outOfStock: 0,
    missingSku: 0,
    missingPrice: 0,
    missingImage: 0,
    failed: 0,

    amazonMatches: 0,

    scanned: 0,
    remaining: 0
  };
}

/* =========================================================
   HELPERS
========================================================= */

function sleep(milliseconds) {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        milliseconds
      )
  );
}

function cleanText(value) {
  return String(
    value || ""
  ).trim();
}

function normalizeBarcode(value) {
  return cleanText(value)
    .replace(/\s+/g, "")
    .replace(/[^0-9]/g, "");
}

function normalizeSku(value) {
  return cleanText(value);
}

function normalizeInventory(value) {
  const quantity =
    Number(value);

  if (
    !Number.isFinite(quantity)
  ) {
    return 0;
  }

  return Math.max(
    0,
    Math.floor(quantity)
  );
}

function normalizePrice(value) {
  const price =
    Number(value);

  if (
    !Number.isFinite(price)
  ) {
    return 0;
  }

  return Number(
    price.toFixed(2)
  );
}

function getVariantKey(
  variant
) {
  return (
    variant.shopify_variant_id ||
    variant.id ||
    variant.sku ||
    `variant-${Date.now()}-${Math.random()}`
  );
}

function getIdentifierType(
  barcode
) {
  const length =
    barcode.length;

  if (
    length === 8
  ) {
    return "GTIN";
  }

  if (
    length === 12
  ) {
    return "UPC";
  }

  if (
    length === 13
  ) {
    return "EAN";
  }

  if (
    length === 14
  ) {
    return "GTIN";
  }

  return null;
}

function getSelectedOption(
  variant,
  optionName
) {
  const options =
    variant.selectedOptions ||
    [];

  const option =
    options.find(
      (entry) =>
        cleanText(
          entry?.name
        ).toLowerCase() ===
        cleanText(
          optionName
        ).toLowerCase()
    );

  return option?.value ||
    null;
}

function getVariantTitle(
  variant
) {
  const options =
    (
      variant.selectedOptions ||
      []
    )
      .map(
        (entry) =>
          entry?.value
      )
      .filter(Boolean);

  if (
    options.length === 0
  ) {
    return (
      variant.productTitle ||
      "Untitled Product"
    );
  }

  return (
    `${variant.productTitle || "Untitled Product"} - ` +
    options.join(" / ")
  );
}

function extractAmazonImage(
  match
) {
  const imageSet =
    match?.images?.[0];

  if (!imageSet) {
    return null;
  }

  if (
    Array.isArray(
      imageSet.images
    )
  ) {
    const mainImage =
      imageSet.images.find(
        (image) =>
          image.variant ===
          "MAIN"
      );

    return (
      mainImage?.link ||
      imageSet.images[0]
        ?.link ||
      null
    );
  }

  return null;
}

function createBaseResult(
  variant
) {
  const barcode =
    normalizeBarcode(
      variant.barcode
    );

  const sku =
    normalizeSku(
      variant.sku
    );

  const quantity =
    normalizeInventory(
      variant.inventoryQuantity ??
      variant.inventory_quantity
    );

  const price =
    normalizePrice(
      variant.price
    );

  const identifierType =
    barcode
      ? getIdentifierType(
          barcode
        )
      : null;

  return {
    key:
      getVariantKey(
        variant
      ),

    shopify_product_id:
      variant.shopify_product_id ||
      null,

    shopify_variant_id:
      variant.shopify_variant_id ||
      variant.id ||
      null,

    productTitle:
      variant.productTitle ||
      null,

    variantTitle:
      getVariantTitle(
        variant
      ),

    vendor:
      variant.vendor ||
      null,

    productType:
      variant.productType ||
      null,

    sku:
      sku || null,

    barcode:
      barcode || null,

    identifierType,

    price,
    inventoryQuantity:
      quantity,

    image:
      variant.image ||
      null,

    color:
      getSelectedOption(
        variant,
        "Color"
      ),

    size:
      getSelectedOption(
        variant,
        "Size"
      ),

    status:
      "PENDING",

    recommendation:
      "Waiting for scan",

    readinessScore:
      0,

    readinessStatus:
      "NOT_AMAZON_READY",

    publishEligible:
      false,

    autoFixAvailable:
      false,

    autoFixActions:
      [],

    amazon: {
      matched: false,
      asin: null,
      title: null,
      brand: null,
      manufacturer: null,
      productType: null,
      image: null,
      matchCount: 0,
      restrictions: [],
      eligible: null,
      listingStatus: null,
      matchMethod: null,
      evidenceLevel: "NONE",
      identifierProvenance: null,
      requiresManualReview: false
    },

    issues: [],

    scannedAt: null,
    error: null
  };
}

/* =========================================================
   LOCAL READINESS CHECK
========================================================= */

function performLocalValidation(
  result
) {
  const issues = [];

  if (!result.sku) {
    issues.push({
      code:
        "MISSING_SKU",
      severity:
        "ERROR",
      message:
        "Shopify variant does not have a SKU."
    });
  }

  if (
    result.price <= 0
  ) {
    issues.push({
      code:
        "MISSING_PRICE",
      severity:
        "ERROR",
      message:
        "Shopify variant does not have a valid selling price."
    });
  }

  if (
    result.inventoryQuantity <=
    0
  ) {
    issues.push({
      code:
        "OUT_OF_STOCK",
      severity:
        "WARNING",
      message:
        "Shopify variant currently has no available inventory."
    });
  }

  if (!result.image) {
    issues.push({
      code:
        "MISSING_IMAGE",
      severity:
        "WARNING",
      message:
        "Shopify variant does not have an image."
    });
  }

  if (!result.barcode) {
    issues.push({
      code:
        "MISSING_UPC",
      severity:
        "REVIEW",
      message:
        "No UPC, EAN or GTIN is stored in Shopify."
    });
  } else if (
    !result.identifierType
  ) {
    issues.push({
      code:
        "INVALID_BARCODE_LENGTH",
      severity:
        "ERROR",
      message:
        "Barcode must contain 8, 12, 13 or 14 digits."
    });
  }

  result.issues.push(
    ...issues
  );

  return result;
}

function hasIssue(
  result,
  code
) {
  return result.issues.some(
    (issue) =>
      issue.code === code
  );
}

function removeIssues(
  result,
  codes
) {
  const blockedCodes =
    new Set(codes);

  result.issues =
    result.issues.filter(
      (issue) =>
        !blockedCodes.has(
          issue.code
        )
    );

  return result;
}

function buildKeywordSearchText(
  result
) {
  return [
    result.vendor,
    result.productType,
    result.productTitle,
    result.variantTitle,
    result.color,
    result.size,
    result.sku
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function buildMatcherProduct(
  result
) {
  return {
    id:
      result.shopify_product_id,
    title:
      result.productTitle ||
      result.variantTitle,
    productTitle:
      result.productTitle,
    variantTitle:
      result.variantTitle,
    vendor:
      result.vendor,
    brand:
      result.vendor,
    productType:
      result.productType,
    color:
      result.color,
    size:
      result.size,
    sku:
      result.sku,
    barcode:
      result.barcode
  };
}

function applyAmazonMatch(
  result,
  match,
  matchCount = 1
) {
  if (!match) {
    return result;
  }

  result.amazon.matched =
    true;

  result.amazon.asin =
    match.asin ||
    null;

  result.amazon.title =
    match.title ||
    match.amazon_title ||
    null;

  result.amazon.brand =
    match.brand ||
    match.amazon_brand ||
    null;

  result.amazon.manufacturer =
    match.manufacturer ||
    null;

  result.amazon.productType =
    match.productType ||
    match.product_type ||
    null;

  result.amazon.image =
    match.image ||
    extractAmazonImage(match) ||
    null;

  result.amazon.matchCount =
    matchCount;

  return result;
}

/* =========================================================
   READINESS SCORE
========================================================= */

function calculateReadinessScore(
  result,
  minimumScore =
    DEFAULT_MINIMUM_READY_SCORE
) {
  if (
    result.amazon.listingStatus ===
    "PUBLISHED"
  ) {
    result.readinessStatus =
      "AMAZON_READY";

    result.publishEligible =
      true;

    return 100;
  }
  let score = 100;

  if (!result.sku) {
    score -= 25;
  }

  if (
    result.price <= 0
  ) {
    score -= 25;
  }

  if (
    result.inventoryQuantity <=
    0
  ) {
    score -= 15;
  }

  if (!result.image) {
    score -= 10;
  }

  if (!result.barcode) {
    score -= 25;
  }

  if (
    result.barcode &&
    !result.identifierType
  ) {
    score -= 25;
  }

  if (
    result.amazon.matched
  ) {
    score += 5;
  }

  if (
    result.amazon.eligible ===
    false
  ) {
    score -= 40;
  }

  if (
    result.error
  ) {
    score -= 30;
  }

  score = Math.max(
    0,
    Math.min(
      100,
      score
    )
  );

  const hardBlocker =
    !result.sku ||
    result.price <= 0 ||
    result.inventoryQuantity <= 0 ||
    !result.image ||
    !result.barcode ||
    !result.identifierType ||
    !result.amazon.matched ||
    result.amazon.eligible === false ||
    Boolean(result.error);

  result.readinessStatus =
    score >= minimumScore &&
    !hardBlocker
      ? "AMAZON_READY"
      : "NOT_AMAZON_READY";

  result.publishEligible =
    result.readinessStatus ===
    "AMAZON_READY";

  return score;
}

/* =========================================================
   AUTO-FIX RECOMMENDATIONS
========================================================= */

function buildAutoFixActions(
  result
) {
  const recommendations = {
    MISSING_SKU:
      "Generate and save a unique seller SKU.",
    MISSING_PRICE:
      "Add a valid Shopify selling price.",
    OUT_OF_STOCK:
      "Increase Shopify inventory before publishing.",
    MISSING_IMAGE:
      "Add a primary product image.",
    MISSING_UPC:
      "Add the supplier's verified GS1 UPC, EAN or GTIN.",
    INVALID_BARCODE_LENGTH:
      "Replace the barcode with a valid 8, 12, 13 or 14 digit identifier.",
    MULTIPLE_AMAZON_MATCHES:
      "Review the Amazon candidates before approving an ASIN.",
    AMAZON_KEYWORD_REVIEW:
      "Review the suggested Amazon ASIN before approving it.",
    AMAZON_SCAN_ERROR:
      "Correct the Amazon API error and retry the scan."
  };

  const automaticCodes =
    new Set([
      "MISSING_SKU"
    ]);

  const actions =
    result.issues.map(
      (issue) => ({
        code:
          issue.code,
        message:
          issue.message,
        recommendedAction:
          recommendations[
            issue.code
          ] ||
          "Review and correct the product data, then scan again.",
        automatic:
          automaticCodes.has(
            issue.code
          )
      })
    );

  if (
    !result.amazon.matched &&
    result.barcode &&
    result.identifierType
  ) {
    actions.push({
      code:
        "NO_AMAZON_MATCH",
      message:
        "Amazon did not return a safe catalog match.",
      recommendedAction:
        "Review catalog candidates or prepare a new Amazon catalog listing.",
      automatic:
        false
    });
  }

  if (
    result.amazon.eligible ===
    false
  ) {
    actions.push({
      code:
        "AMAZON_RESTRICTED",
      message:
        "Amazon returned a listing restriction.",
      recommendedAction:
        "Request Amazon approval or choose an unrestricted product.",
      automatic:
        false
    });
  }

  return actions;
}

/* =========================================================
   FINAL STATUS CLASSIFICATION
========================================================= */

function classifyResult(
  result
) {
  if (
    result.error
  ) {
    result.status =
      "FAILED";

    result.recommendation =
      "Review the scan error and retry.";

    return result;
  }

  if (
    hasIssue(
      result,
      "MISSING_SKU"
    )
  ) {
    result.status =
      "MISSING_SKU";

    result.recommendation =
      "Add a unique SKU in Shopify.";

    return result;
  }

  if (
    hasIssue(
      result,
      "MISSING_PRICE"
    )
  ) {
    result.status =
      "MISSING_PRICE";

    result.recommendation =
      "Add a valid Shopify price.";

    return result;
  }

  if (
    result.amazon.listingStatus ===
    "PUBLISHED"
  ) {
    result.status =
      "PUBLISHED";

    result.recommendation =
      "Listing already exists in the Amazon seller account.";

    return result;
  }

  if (
    hasIssue(
      result,
      "INVALID_BARCODE_LENGTH"
    )
  ) {
    result.status =
      "NEEDS_REVIEW";

    result.recommendation =
      "Correct the barcode stored in Shopify.";

    return result;
  }

  if (
    hasIssue(
      result,
      "AMAZON_KEYWORD_REVIEW"
    )
  ) {
    result.status =
      "NEEDS_REVIEW";

    result.recommendation =
      "Review the suggested Amazon ASIN before approving publication.";

    return result;
  }

  if (
    hasIssue(
      result,
      "MISSING_UPC"
    )
  ) {
    result.status =
      "NEEDS_UPC";

    result.recommendation =
      "Review for manufacturer UPC, GTIN exemption or private-label UPC.";

    return result;
  }

  if (
    !result.amazon.matched
  ) {
    result.status =
      "NO_MATCH";

    result.recommendation =
      "Amazon has no catalog match for this barcode. Review for a new listing.";

    return result;
  }

  if (
    result.amazon.eligible ===
    false
  ) {
    result.status =
      "RESTRICTED";

    result.recommendation =
      "Amazon approval or additional documentation is required.";

    return result;
  }

  if (
    result.inventoryQuantity <=
    0
  ) {
    result.status =
      "OUT_OF_STOCK";

    result.recommendation =
      "Amazon match found, but inventory is currently zero.";

    return result;
  }

  if (!result.image) {
    result.status =
      "NEEDS_REVIEW";

    result.recommendation =
      "Amazon match found. Add or verify the product image before publishing.";

    return result;
  }

  result.status =
    "READY";

  result.recommendation =
    "Amazon catalog match found and no listing restriction was returned.";

  return result;
}

/* =========================================================
   EXISTING AMAZON LISTING CHECK
========================================================= */

async function checkExistingListing(
  result
) {
  if (!result.sku) {
    return result;
  }

  try {
    const listing =
      await getListingStatus(
        result.sku
      );

    if (
      listing.success
    ) {
      const data =
        listing.data ||
        {};

      const summary =
        data.summaries?.[0] ||
        {};

      const asin =
        summary.asin ||
        data.identifiers?.find(
          (entry) =>
            entry?.asin
        )?.asin ||
        data.asin ||
        null;

      result.amazon.listingStatus =
        "PUBLISHED";

      result.amazon.existingListing =
        data;

      result.amazon.matched =
        true;

      result.amazon.asin =
        asin ||
        result.amazon.asin;

      result.amazon.title =
        summary.itemName ||
        summary.itemNameByMarketplace?.[0]?.itemName ||
        result.amazon.title;

      result.amazon.productType =
        summary.productType ||
        data.productType ||
        result.amazon.productType;

      result.amazon.eligible =
        true;

      result.amazon.matchMethod =
        "EXISTING_SELLER_LISTING";

      result.amazon.evidenceLevel =
        "VERIFIED";

      result.amazon.identifierProvenance =
        "AMAZON_SELLER_ACCOUNT";

      result.amazon.requiresManualReview =
        false;

      removeIssues(
        result,
        [
          "MISSING_UPC",
          "INVALID_BARCODE_LENGTH",
          "NO_AMAZON_MATCH",
          "MULTIPLE_AMAZON_MATCHES"
        ]
      );
    } else if (
      listing.status === 404
    ) {
      result.amazon.listingStatus =
        "NOT_FOUND";
    } else {
      result.amazon.listingStatus =
        "UNKNOWN";
    }
  } catch {
    result.amazon.listingStatus =
      "UNKNOWN";
  }

  return result;
}

/* =========================================================
   AMAZON CATALOG SCAN
========================================================= */

async function scanAmazonCatalogByIdentifier(
  result
) {
  if (
    !result.barcode ||
    !result.identifierType
  ) {
    return result;
  }

  const catalog =
    await searchCatalogByIdentifier(
      result.barcode,
      result.identifierType
    );

  if (
    !catalog.success
  ) {
    throw new Error(
      catalog.error ||
      "Amazon catalog identifier search failed"
    );
  }

  result.amazon.matchCount =
    catalog.matchCount ||
    0;

  if (
    !catalog.matches ||
    catalog.matches.length ===
      0
  ) {
    return result;
  }

  if (
    catalog.matches.length ===
    1
  ) {
    applyAmazonMatch(
      result,
      catalog.matches[0],
      1
    );

    result.amazon.matchMethod =
      "EXACT_IDENTIFIER";

    result.amazon.evidenceLevel =
      "VERIFIED";

    result.amazon.identifierProvenance =
      "SHOPIFY_SUPPLIER_IDENTIFIER";

    result.amazon.requiresManualReview =
      false;

    return result;
  }

  result.issues.push({
    code:
      "MULTIPLE_AMAZON_MATCHES",
    severity:
      "REVIEW",
    message:
      `Amazon returned ${catalog.matches.length} matches for this identifier.`
  });

  return result;
}

async function scanAmazonCatalogByKeywords(
  result
) {
  const keywords =
    buildKeywordSearchText(
      result
    );

  if (!keywords) {
    return result;
  }

  const catalog =
    await searchCatalogItems({
      keywords,
      brandNames:
        result.vendor ||
        ""
    });

  if (
    !catalog.success
  ) {
    throw new Error(
      catalog.error ||
      "Amazon catalog keyword search failed"
    );
  }

  const items =
    catalog.items ||
    [];

  result.amazon.matchCount =
    Math.max(
      result.amazon.matchCount ||
      0,
      items.length
    );

  if (
    items.length === 0
  ) {
    return result;
  }

  const decision =
    chooseBestAmazonMatch(
      buildMatcherProduct(
        result
      ),
      items,
      {
        minimumAutoMatchConfidence:
          95,
        minimumReviewConfidence:
          75
      }
    );

  const best =
    decision?.bestMatch ||
    null;

  /*
    Compliance rule:
    Keyword, title, image, or public-web similarity is supporting evidence only.
    It may suggest an ASIN for review, but it must never assign a UPC/GTIN or
    make the product publish-ready without an exact verified identifier or an
    existing seller listing.
  */

  if (
    [
      "AUTO_MATCH",
      "NEEDS_REVIEW"
    ].includes(
      decision?.decision
    ) &&
    best?.asin
  ) {
    result.amazon.asin =
      best.asin;

    result.amazon.title =
      best.title ||
      best.amazon_title ||
      null;

    result.amazon.brand =
      best.brand ||
      best.amazon_brand ||
      null;

    result.amazon.productType =
      best.productType ||
      best.product_type ||
      null;

    result.amazon.matchMethod =
      "KEYWORD_CANDIDATE";

    result.amazon.evidenceLevel =
      "SUPPORTING_ONLY";

    result.amazon.identifierProvenance =
      "AMAZON_CATALOG_KEYWORD_SEARCH";

    result.amazon.requiresManualReview =
      true;

    result.amazon.matched =
      false;

    result.issues.push({
      code:
        "AMAZON_KEYWORD_REVIEW",
      severity:
        "REVIEW",
      message:
        `Amazon found a possible ASIN match with ${Math.round(
          Number(decision.confidence || best.confidence || 0)
        )}% confidence. Product identity and identifier ownership must be verified before publishing.`
    });
  }

  return result;
}

/* =========================================================
   AMAZON RESTRICTIONS
========================================================= */

async function scanRestrictions(
  result
) {
  if (
    !result.amazon.asin
  ) {
    return result;
  }

  const restrictionResult =
    await getListingRestrictions(
      result.amazon.asin,
      "new_new"
    );

  if (
    !restrictionResult.success
  ) {
    throw new Error(
      restrictionResult.error ||
      "Amazon restriction check failed"
    );
  }

  result.amazon.eligible =
    restrictionResult.eligible;

  result.amazon.restrictions =
    restrictionResult.restrictions ||
    [];

  return result;
}

/* =========================================================
   SINGLE VARIANT SCAN
========================================================= */

export async function scanAmazonVariant(
  variant,
  options = {}
) {
  const {
    checkPublished = true,
    checkRestrictions = true,
    minimumScore =
      DEFAULT_MINIMUM_READY_SCORE
  } = options;

  const result =
    performLocalValidation(
      createBaseResult(
        variant
      )
    );

  try {
    /*
      Existing seller listings must be checked first.
      An already-listed SKU does not require another UPC.
    */

    if (
      checkPublished &&
      result.sku
    ) {
      await checkExistingListing(
        result
      );
    }

    if (
      result.amazon.listingStatus !==
      "PUBLISHED"
    ) {
      if (
        result.barcode &&
        result.identifierType
      ) {
        await scanAmazonCatalogByIdentifier(
          result
        );
      }

      /*
        If the identifier is missing, invalid, or returned no safe match,
        search Amazon by product title, brand, category, color, size and SKU.
      */

      if (
        !result.amazon.matched
      ) {
        await scanAmazonCatalogByKeywords(
          result
        );
      }

      if (
        result.amazon.matched &&
        result.amazon.asin &&
        checkRestrictions
      ) {
        await scanRestrictions(
          result
        );
      }
    }
  } catch (error) {
    result.error =
      error.message;

    result.issues.push({
      code:
        "AMAZON_SCAN_ERROR",
      severity:
        "ERROR",
      message:
        error.message
    });
  }

  result.readinessScore =
    calculateReadinessScore(
      result,
      minimumScore
    );

  classifyResult(
    result
  );

  result.autoFixActions =
    buildAutoFixActions(
      result
    );

  result.autoFixAvailable =
    result.autoFixActions.some(
      (action) =>
        action.automatic
    );

  result.scannedAt =
    new Date()
      .toISOString();

  return result;
}

/* =========================================================
   SUMMARY CALCULATION
========================================================= */

function calculateSummary(
  results
) {
  const summary =
    createEmptySummary();

  const productIds =
    new Set();

  summary.variants =
    results.length;

  for (
    const result of
    results
  ) {
    if (
      result.shopify_product_id
    ) {
      productIds.add(
        result.shopify_product_id
      );
    }

    if (
      result.amazon.matched
    ) {
      summary.amazonMatches++;
    }

    if (
      result.readinessStatus ===
      "AMAZON_READY"
    ) {
      summary.amazonReady++;
    } else {
      summary.notAmazonReady++;
    }

    if (
      result.publishEligible
    ) {
      summary.publishEligible++;
    }

    switch (
      result.status
    ) {
      case "READY":
        summary.ready++;
        break;

      case "PUBLISHED":
        summary.published++;
        break;

      case "RESTRICTED":
        summary.restricted++;
        break;

      case "NEEDS_UPC":
        summary.needsUpc++;
        break;

      case "NO_MATCH":
        summary.noMatch++;
        break;

      case "OUT_OF_STOCK":
        summary.outOfStock++;
        break;

      case "MISSING_SKU":
        summary.missingSku++;
        break;

      case "MISSING_PRICE":
        summary.missingPrice++;
        break;

      case "FAILED":
        summary.failed++;
        break;

      default:
        summary.needsReview++;
        break;
    }

    if (
      hasIssue(
        result,
        "MISSING_IMAGE"
      )
    ) {
      summary.missingImage++;
    }
  }

  summary.products =
    productIds.size;

  summary.scanned =
    results.length;

  summary.remaining =
    Math.max(
      0,
      engineState.totalVariants -
      results.length
    );

  return summary;
}

/* =========================================================
   FULL STORE SCAN
========================================================= */

export async function startAmazonEngineScan(
  variants,
  options = {}
) {
  if (
    engineState.status ===
    "RUNNING"
  ) {
    return {
      success: false,
      error:
        "Amazon Publishing Engine scan is already running.",
      state:
        getAmazonEngineStatus()
    };
  }

  if (
    !Array.isArray(
      variants
    )
  ) {
    return {
      success: false,
      error:
        "A Shopify variants array is required."
    };
  }

  const {
    delayMs = 750,
    checkPublished = true,
    checkRestrictions = true,
    minimumScore =
      DEFAULT_MINIMUM_READY_SCORE,
    replaceExisting = true
  } = options;

  if (replaceExisting) {
    engineState.results.clear();
  }

  engineState.status =
    "RUNNING";

  engineState.startedAt =
    new Date()
      .toISOString();

  engineState.completedAt =
    null;

  engineState.currentIndex =
    0;

  engineState.totalVariants =
    variants.length;

  engineState.currentSku =
    null;

  engineState.currentTitle =
    null;

  engineState.error =
    null;

  engineState.summary =
    createEmptySummary();

  /*
    The scan continues asynchronously after the route responds.
  */

  void (
    async () => {
      try {
        for (
          let index = 0;
          index < variants.length;
          index++
        ) {
          const variant =
            variants[index];

          engineState.currentIndex =
            index + 1;

          engineState.currentSku =
            variant.sku ||
            null;

          engineState.currentTitle =
            getVariantTitle(
              variant
            );

          const result =
            await scanAmazonVariant(
              variant,
              {
                checkPublished,
                checkRestrictions,
                minimumScore
              }
            );

          engineState.results.set(
            result.key,
            result
          );

          engineState.summary =
            calculateSummary(
              Array.from(
                engineState.results.values()
              )
            );

          /*
            Amazon applies API usage limits.
            A delay reduces the chance of rate-limit failures.
          */

          if (
            index <
              variants.length -
                1 &&
            delayMs > 0
          ) {
            await sleep(
              delayMs
            );
          }
        }

        engineState.status =
          "COMPLETED";

        engineState.completedAt =
          new Date()
            .toISOString();

        engineState.currentSku =
          null;

        engineState.currentTitle =
          null;

        engineState.summary =
          calculateSummary(
            Array.from(
              engineState.results.values()
            )
          );
      } catch (error) {
        engineState.status =
          "FAILED";

        engineState.error =
          error.message;

        engineState.completedAt =
          new Date()
            .toISOString();
      }
    }
  )();

  return {
    success: true,
    message:
      "Amazon Publishing Engine scan started.",
    totalVariants:
      variants.length,
    version:
      ENGINE_VERSION
  };
}

/* =========================================================
   RESCAN ONE VARIANT
========================================================= */

export async function rescanAmazonEngineVariant(
  variant,
  options = {}
) {
  const result =
    await scanAmazonVariant(
      variant,
      options
    );

  engineState.results.set(
    result.key,
    result
  );

  engineState.summary =
    calculateSummary(
      Array.from(
        engineState.results.values()
      )
    );

  return {
    success: true,
    result
  };
}

/* =========================================================
   READ ENGINE DATA
========================================================= */

export function getAmazonEngineStatus() {
  const progress =
    engineState.totalVariants >
    0
      ? Number(
          (
            (
              engineState.currentIndex /
              engineState.totalVariants
            ) *
            100
          ).toFixed(1)
        )
      : 0;

  return {
    success: true,

    version:
      ENGINE_VERSION,

    status:
      engineState.status,

    startedAt:
      engineState.startedAt,

    completedAt:
      engineState.completedAt,

    currentIndex:
      engineState.currentIndex,

    totalVariants:
      engineState.totalVariants,

    progress,

    currentSku:
      engineState.currentSku,

    currentTitle:
      engineState.currentTitle,

    error:
      engineState.error,

    summary:
      engineState.summary
  };
}

export function getAmazonEngineDashboard() {
  const results =
    Array.from(
      engineState.results.values()
    );

  const readyProducts =
    results
      .filter(
        (result) =>
          result.readinessStatus ===
          "AMAZON_READY"
      )
      .sort(
        (a, b) =>
          b.readinessScore -
          a.readinessScore
      )
      .slice(0, 10);

  const needsUpc =
    results
      .filter(
        (result) =>
          result.status ===
          "NEEDS_UPC"
      )
      .slice(0, 10);

  const restricted =
    results
      .filter(
        (result) =>
          result.status ===
          "RESTRICTED"
      )
      .slice(0, 10);

  const needsAiFix =
    results
      .filter(
        (result) =>
          result.readinessStatus ===
          "NOT_AMAZON_READY" &&
          result.autoFixAvailable
      )
      .slice(0, 10);

  return {
    success: true,

    version:
      ENGINE_VERSION,

    status:
      getAmazonEngineStatus(),

    summary:
      engineState.summary,

    compliancePolicy: {
      keywordMatchesAreAdvisoryOnly: true,
      webFoundUpcsRequireVerification: true,
      acceptedAutomaticEvidence: [
        "EXISTING_SELLER_LISTING",
        "EXACT_IDENTIFIER"
      ],
      prohibitedAutomaticActions: [
        "GUESS_UPC",
        "COPY_PRIVATE_LABEL_GTIN",
        "AUTO_PUBLISH_KEYWORD_ONLY_MATCH"
      ]
    },

    highlights: {
      readyProducts,
      needsAiFix,
      needsUpc,
      restricted
    }
  };
}

export function getAmazonEngineResults(
  filters = {}
) {
  const {
    status,
    search,
    vendor,
    limit = 100,
    offset = 0
  } = filters;

  let results =
    Array.from(
      engineState.results.values()
    );

  if (status) {
    const normalizedStatus =
      String(status)
        .trim()
        .toUpperCase();

    results =
      results.filter(
        (result) =>
          result.status ===
            normalizedStatus ||
          result.readinessStatus ===
            normalizedStatus
      );
  }

  if (vendor) {
    const normalizedVendor =
      String(vendor)
        .trim()
        .toLowerCase();

    results =
      results.filter(
        (result) =>
          String(
            result.vendor ||
            ""
          )
            .toLowerCase()
            .includes(
              normalizedVendor
            )
      );
  }

  if (search) {
    const normalizedSearch =
      String(search)
        .trim()
        .toLowerCase();

    results =
      results.filter(
        (result) => {
          const searchable = [
            result.productTitle,
            result.variantTitle,
            result.sku,
            result.barcode,
            result.vendor,
            result.amazon.asin,
            result.amazon.title,
            result.amazon.brand
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();

          return searchable.includes(
            normalizedSearch
          );
        }
      );
  }

  results.sort(
    (a, b) =>
      b.readinessScore -
      a.readinessScore
  );

  const safeOffset =
    Math.max(
      0,
      Number(offset) || 0
    );

  const safeLimit =
    Math.min(
      500,
      Math.max(
        1,
        Number(limit) || 100
      )
    );

  return {
    success: true,

    total:
      results.length,

    offset:
      safeOffset,

    limit:
      safeLimit,

    results:
      results.slice(
        safeOffset,
        safeOffset +
          safeLimit
      )
  };
}

export function getAmazonEngineResult(
  variantId
) {
  const normalizedId =
    String(
      variantId || ""
    );

  const result =
    Array.from(
      engineState.results.values()
    ).find(
      (entry) =>
        String(
          entry.shopify_variant_id
        ) ===
          normalizedId ||
        String(
          entry.key
        ) ===
          normalizedId ||
        String(
          entry.sku
        ) ===
          normalizedId
    );

  if (!result) {
    return {
      success: false,
      error:
        "Amazon Publishing Engine result not found."
    };
  }

  return {
    success: true,
    result
  };
}

export function clearAmazonEngineResults() {
  if (
    engineState.status ===
    "RUNNING"
  ) {
    return {
      success: false,
      error:
        "Cannot clear results while a scan is running."
    };
  }

  engineState.results.clear();

  engineState.status =
    "IDLE";

  engineState.startedAt =
    null;

  engineState.completedAt =
    null;

  engineState.currentIndex =
    0;

  engineState.totalVariants =
    0;

  engineState.currentSku =
    null;

  engineState.currentTitle =
    null;

  engineState.error =
    null;

  engineState.summary =
    createEmptySummary();

  return {
    success: true,
    message:
      "Amazon Publishing Engine results cleared."
  };
}
