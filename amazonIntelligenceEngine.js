/* eslint-env node */
/* global process */

import { scanAmazonVariant } from "./amazonEngine.js";

const ENGINE_VERSION = "amazon-intelligence-v1";

/* =========================================================
   BASIC HELPERS
========================================================= */

function cleanDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function cleanText(value) {
  return String(value || "").trim();
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Number(number.toFixed(2))
    : 0;
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/* =========================================================
   BARCODE VALIDATION
========================================================= */

function calculateCheckDigit(body) {
  const digits = cleanDigits(body)
    .split("")
    .map(Number);

  let sum = 0;
  const parity = digits.length % 2;

  for (
    let index = 0;
    index < digits.length;
    index++
  ) {
    const weight =
      index % 2 === parity
        ? 3
        : 1;

    sum += digits[index] * weight;
  }

  return String(
    (10 - (sum % 10)) % 10
  );
}

export function validateBarcode(value) {
  const barcode =
    cleanDigits(value);

  if (!barcode) {
    return {
      valid: false,
      normalized: null,
      type: null,
      reason: "MISSING_BARCODE",
      expectedCheckDigit: null,
      actualCheckDigit: null
    };
  }

  if (
    ![
      12,
      13,
      14
    ].includes(barcode.length)
  ) {
    return {
      valid: false,
      normalized: barcode,
      type: null,
      reason: "INVALID_LENGTH",
      expectedCheckDigit: null,
      actualCheckDigit:
        barcode.slice(-1) || null
    };
  }

  const body =
    barcode.slice(0, -1);

  const expectedCheckDigit =
    calculateCheckDigit(body);

  const actualCheckDigit =
    barcode.slice(-1);

  const valid =
    expectedCheckDigit ===
    actualCheckDigit;

  return {
    valid,
    normalized: barcode,
    type:
      barcode.length === 12
        ? "UPC"
        : barcode.length === 13
        ? "EAN"
        : "GTIN",
    reason:
      valid
        ? null
        : "INVALID_CHECK_DIGIT",
    expectedCheckDigit,
    actualCheckDigit
  };
}

/* =========================================================
   DUPLICATE BARCODE DETECTION
========================================================= */

export function detectDuplicateBarcodes(
  variants = []
) {
  const index =
    new Map();

  for (
    const variant of
    variants
  ) {
    const barcode =
      cleanDigits(
        variant?.barcode
      );

    if (!barcode) {
      continue;
    }

    if (
      !index.has(barcode)
    ) {
      index.set(
        barcode,
        []
      );
    }

    index
      .get(barcode)
      .push({
        shopify_product_id:
          variant
            .shopify_product_id ||
          null,

        shopify_variant_id:
          variant
            .shopify_variant_id ||
          variant.id ||
          null,

        sku:
          variant.sku ||
          null,

        productTitle:
          variant
            .productTitle ||
          null
      });
  }

  return Array
    .from(
      index.entries()
    )
    .filter(
      (
        [
          ,
          matches
        ]
      ) =>
        matches.length > 1
    )
    .map(
      (
        [
          barcode,
          matches
        ]
      ) => ({
        barcode,
        count:
          matches.length,
        matches
      })
    );
}

/* =========================================================
   PRODUCT / VARIANT GROUPING
========================================================= */

export function groupVariantsByProduct(
  variants = []
) {
  const groups =
    new Map();

  for (
    const variant of
    variants
  ) {
    const productId =
      variant
        .shopify_product_id ||
      `unknown:${variant.productTitle || "untitled"}`;

    if (
      !groups.has(
        productId
      )
    ) {
      groups.set(
        productId,
        {
          productId,

          productTitle:
            variant
              .productTitle ||
            null,

          vendor:
            variant.vendor ||
            null,

          productType:
            variant
              .productType ||
            null,

          variants: []
        }
      );
    }

    groups
      .get(productId)
      .variants
      .push(variant);
  }

  return Array.from(
    groups.values()
  );
}

export function analyzeVariationCompleteness(
  group
) {
  const variants =
    Array.isArray(
      group?.variants
    )
      ? group.variants
      : [];

  const optionNames =
    new Set();

  const issues = [];

  for (
    const variant of
    variants
  ) {
    for (
      const option of
      variant
        .selectedOptions ||
      []
    ) {
      const name =
        cleanText(
          option?.name
        );

      if (name) {
        optionNames.add(name);
      }
    }
  }

  if (
    variants.length > 1
  ) {
    for (
      const variant of
      variants
    ) {
      const selected =
        new Map(
          (
            variant
              .selectedOptions ||
            []
          ).map(
            (entry) => [
              cleanText(
                entry?.name
              ),
              cleanText(
                entry?.value
              )
            ]
          )
        );

      for (
        const optionName of
        optionNames
      ) {
        if (
          !selected.get(
            optionName
          )
        ) {
          issues.push({
            code:
              "INCOMPLETE_VARIATION_OPTIONS",

            shopify_variant_id:
              variant
                .shopify_variant_id ||
              variant.id ||
              null,

            message:
              `Variant is missing a value for "${optionName}".`
          });
        }
      }
    }
  }

  return {
    productId:
      group?.productId ||
      null,

    variantCount:
      variants.length,

    optionNames:
      Array.from(
        optionNames
      ),

    complete:
      issues.length === 0,

    issues
  };
}

/* =========================================================
   COST LOOKUP
========================================================= */

function buildCostIndex(
  costs = []
) {
  const index =
    new Map();

  for (
    const cost of
    costs
  ) {
    const possibleKeys = [
      cost
        .shopify_variant_id,
      cost.variantId,
      cost.sku,
      cleanDigits(
        cost.barcode
      )
    ]
      .filter(Boolean)
      .map(String);

    for (
      const key of
      possibleKeys
    ) {
      index.set(
        key,
        cost
      );
    }
  }

  return index;
}

function findCost(
  costIndex,
  variant
) {
  const possibleKeys = [
    variant
      .shopify_variant_id,
    variant.id,
    variant.sku,
    cleanDigits(
      variant.barcode
    )
  ]
    .filter(Boolean)
    .map(String);

  for (
    const key of
    possibleKeys
  ) {
    if (
      costIndex.has(key)
    ) {
      return costIndex.get(
        key
      );
    }
  }

  return {};
}

/* =========================================================
   PROFITABILITY ESTIMATE
========================================================= */

export function estimateProfitability(
  input = {},
  config = {}
) {
  const sellingPrice =
    money(
      input.sellingPrice ??
      input.price
    );

  const productCost =
    money(
      input.productCost ??
      input.cjCost
    );

  const shippingCost =
    money(
      input.shippingCost ??
      input.cjShippingCost
    );

  const referralFeeRate =
    Number(
      input.referralFeeRate ??
      config.referralFeeRate ??
      process.env
        .AMAZON_ESTIMATED_REFERRAL_FEE_RATE ??
      0.15
    );

  const closingFee =
    money(
      input.closingFee ??
      config.closingFee ??
      process.env
        .AMAZON_ESTIMATED_CLOSING_FEE ??
      0
    );

  const fulfillmentFee =
    money(
      input.fulfillmentFee ??
      config.fulfillmentFee ??
      process.env
        .AMAZON_ESTIMATED_FULFILLMENT_FEE ??
      0
    );

  const referralFee =
    money(
      sellingPrice *
      referralFeeRate
    );

  const estimatedAmazonFees =
    money(
      referralFee +
      closingFee +
      fulfillmentFee
    );

  const totalCost =
    money(
      productCost +
      shippingCost +
      estimatedAmazonFees
    );

  const estimatedProfit =
    money(
      sellingPrice -
      totalCost
    );

  const marginPercent =
    sellingPrice > 0
      ? Number(
          (
            (
              estimatedProfit /
              sellingPrice
            ) *
            100
          ).toFixed(2)
        )
      : 0;

  const hasSupplierCosts =
    productCost > 0 ||
    shippingCost > 0;

  return {
    sellingPrice,

    productCost,

    shippingCost,

    referralFeeRate,

    referralFee,

    closingFee,

    fulfillmentFee,

    estimatedAmazonFees,

    totalCost,

    estimatedProfit,

    marginPercent,

    hasSupplierCosts,

    profitable:
      hasSupplierCosts
        ? estimatedProfit > 0
        : null,

    confidence:
      hasSupplierCosts
        ? "ESTIMATED"
        : "INSUFFICIENT_COST_DATA"
  };
}

/* =========================================================
   AMAZON READY SCORE
========================================================= */

export function calculateAmazonReadyScore(
  context = {}
) {
  const scan =
    context.scan ||
    {};

  const barcodeValidation =
    context.barcodeValidation ||
    {};

  const profitability =
    context.profitability ||
    {};

  const variation =
    context.variation ||
    {};

  const duplicateBarcode =
    Boolean(
      context.duplicateBarcode
    );

  const breakdown = {
    barcode: 0,
    amazonMatch: 0,
    restrictions: 0,
    listingState: 0,
    inventory: 0,
    image: 0,
    sku: 0,
    variation: 0,
    supplierData: 0,
    profit: 0
  };

  if (
    barcodeValidation.valid
  ) {
    breakdown.barcode = 15;
  }

  if (
    scan.amazon?.matched
  ) {
    breakdown.amazonMatch = 20;
  }

  if (
    scan.amazon?.eligible !==
    false
  ) {
    breakdown.restrictions = 15;
  }

  if (
    scan.amazon?.listingStatus !==
    "PUBLISHED"
  ) {
    breakdown.listingState = 5;
  }

  if (
    Number(
      scan.inventoryQuantity
    ) > 0
  ) {
    breakdown.inventory = 10;
  }

  if (scan.image) {
    breakdown.image = 5;
  }

  if (scan.sku) {
    breakdown.sku = 5;
  }

  if (
    variation.complete !==
    false
  ) {
    breakdown.variation = 5;
  }

  if (
    profitability
      .hasSupplierCosts
  ) {
    breakdown.supplierData = 5;

    if (
      profitability
        .marginPercent >= 30
    ) {
      breakdown.profit = 15;
    } else if (
      profitability
        .marginPercent >= 20
    ) {
      breakdown.profit = 12;
    } else if (
      profitability
        .marginPercent >= 10
    ) {
      breakdown.profit = 7;
    } else if (
      profitability
        .marginPercent > 0
    ) {
      breakdown.profit = 3;
    }
  }

  let score =
    Object
      .values(breakdown)
      .reduce(
        (
          sum,
          value
        ) =>
          sum + value,
        0
      );

  if (
    duplicateBarcode
  ) {
    score -= 25;
  }

  if (
    !barcodeValidation.valid
  ) {
    score -= 10;
  }

  if (
    scan.amazon?.eligible ===
    false
  ) {
    score -= 30;
  }

  if (
    scan.status ===
    "FAILED"
  ) {
    score -= 30;
  }

  score =
    Math.max(
      0,
      Math.min(
        100,
        score
      )
    );

  let status =
    "NOT_RECOMMENDED";

  if (
    score >= 85 &&
    scan.status ===
      "READY"
  ) {
    status =
      "AMAZON_READY";
  } else if (
    score >= 65
  ) {
    status =
      "NEARLY_READY";
  } else if (
    score >= 35
  ) {
    status =
      "NEEDS_WORK";
  }

  return {
    score,
    status,
    breakdown
  };
}

/* =========================================================
   BLOCKER REPORT
========================================================= */

export function buildBlockers(
  report
) {
  const blockers = [];

  if (
    !report
      .barcodeValidation
      ?.valid
  ) {
    blockers.push({
      code:
        report
          .barcodeValidation
          ?.reason ||
        "INVALID_BARCODE",

      message:
        "The variant does not have a valid UPC, EAN, or GTIN."
    });
  }

  if (
    report.duplicateBarcode
  ) {
    blockers.push({
      code:
        "DUPLICATE_BARCODE",

      message:
        "The same barcode is assigned to more than one Shopify variant."
    });
  }

  if (
    report.scan
      ?.amazon
      ?.eligible ===
    false
  ) {
    blockers.push({
      code:
        "AMAZON_RESTRICTED",

      message:
        "Amazon returned a listing restriction for this ASIN."
    });
  }

  if (
    !report.scan
      ?.amazon
      ?.matched
  ) {
    blockers.push({
      code:
        "NO_AMAZON_MATCH",

      message:
        "Amazon did not return an existing catalog match."
    });
  }

  if (
    Number(
      report.scan
        ?.inventoryQuantity ||
      0
    ) <= 0
  ) {
    blockers.push({
      code:
        "OUT_OF_STOCK",

      message:
        "The Shopify variant has no available inventory."
    });
  }

  if (
    !report.scan?.sku
  ) {
    blockers.push({
      code:
        "MISSING_SKU",

      message:
        "The Shopify variant needs a unique SKU."
    });
  }

  if (
    !report
      .profitability
      ?.hasSupplierCosts
  ) {
    blockers.push({
      code:
        "MISSING_SUPPLIER_COSTS",

      message:
        "CJ product and shipping costs were not supplied, so profit cannot be confirmed."
    });
  }

  return blockers;
}

/* =========================================================
   SUMMARY
========================================================= */

export function buildIntelligenceSummary(
  reports = []
) {
  const summary = {
    total:
      reports.length,

    amazonReady: 0,

    nearlyReady: 0,

    needsWork: 0,

    notRecommended: 0,

    duplicateBarcode: 0,

    invalidBarcode: 0,

    missingSupplierCosts: 0,

    readyInExistingEngine: 0
  };

  for (
    const report of
    reports
  ) {
    switch (
      report
        .intelligenceStatus
    ) {
      case "AMAZON_READY":
        summary.amazonReady++;
        break;

      case "NEARLY_READY":
        summary.nearlyReady++;
        break;

      case "NEEDS_WORK":
        summary.needsWork++;
        break;

      default:
        summary.notRecommended++;
        break;
    }

    if (
      report.duplicateBarcode
    ) {
      summary
        .duplicateBarcode++;
    }

    if (
      !report
        .barcodeValidation
        ?.valid
    ) {
      summary
        .invalidBarcode++;
    }

    if (
      !report
        .profitability
        ?.hasSupplierCosts
    ) {
      summary
        .missingSupplierCosts++;
    }

    if (
      report.scan
        ?.status ===
      "READY"
    ) {
      summary
        .readyInExistingEngine++;
    }
  }

  return summary;
}

/* =========================================================
   BEST TEST PRODUCT
========================================================= */

export function selectBestTestProduct(
  reports = [],
  options = {}
) {
  const minimumScore =
    Number(
      options.minimumScore ??
      70
    );

  const eligible =
    reports
      .filter(
        (report) =>
          report.scan?.status ===
          "READY"
      )
      .filter(
        (report) =>
          report
            .amazonReadyScore >=
          minimumScore
      )
      .filter(
        (report) =>
          !report
            .duplicateBarcode
      )
      .filter(
        (report) =>
          report
            .barcodeValidation
            ?.valid
      )
      .sort(
        (
          first,
          second
        ) => {
          if (
            second
              .amazonReadyScore !==
            first
              .amazonReadyScore
          ) {
            return (
              second
                .amazonReadyScore -
              first
                .amazonReadyScore
            );
          }

          const firstMargin =
            Number(
              first
                .profitability
                ?.marginPercent ||
              0
            );

          const secondMargin =
            Number(
              second
                .profitability
                ?.marginPercent ||
              0
            );

          if (
            secondMargin !==
            firstMargin
          ) {
            return (
              secondMargin -
              firstMargin
            );
          }

          const firstInventory =
            Number(
              first.scan
                ?.inventoryQuantity ||
              0
            );

          const secondInventory =
            Number(
              second.scan
                ?.inventoryQuantity ||
              0
            );

          return (
            secondInventory -
            firstInventory
          );
        }
      );

  if (
    eligible.length === 0
  ) {
    return {
      found: false,

      reason:
        "NO_SAFE_TEST_PRODUCT",

      minimumScore,

      recommendation:
        "Fix the highest-ranked blockers and run the analysis again."
    };
  }

  return {
    found: true,

    minimumScore,

    product:
      eligible[0],

    reason:
      "Highest safe Amazon Ready Score, with profit margin and inventory used as tie-breakers."
  };
}

/* =========================================================
   MAIN ANALYSIS
========================================================= */

export async function analyzeAmazonReadiness(
  variants = [],
  options = {}
) {
  if (
    !Array.isArray(
      variants
    )
  ) {
    throw new Error(
      "variants must be an array."
    );
  }

  const delayMs =
    Math.max(
      0,
      Number(
        options.delayMs ??
        750
      )
    );

  const minimumScore =
    Number(
      options.minimumScore ??
      70
    );

  const duplicateDetails =
    detectDuplicateBarcodes(
      variants
    );

  const duplicateSet =
    new Set(
      duplicateDetails
        .map(
          (entry) =>
            entry.barcode
        )
    );

  const variationByProduct =
    new Map(
      groupVariantsByProduct(
        variants
      ).map(
        (group) => [
          String(
            group.productId
          ),

          analyzeVariationCompleteness(
            group
          )
        ]
      )
    );

  const costIndex =
    buildCostIndex(
      options.costs ||
      []
    );

  const reports = [];

  for (
    let index = 0;
    index < variants.length;
    index++
  ) {
    const variant =
      variants[index];

    const scan =
      await scanAmazonVariant(
        variant,
        {
          checkPublished:
            options
              .checkPublished !==
            false,

          checkRestrictions:
            options
              .checkRestrictions !==
            false
        }
      );

    const barcodeValidation =
      validateBarcode(
        variant.barcode
      );

    const duplicateBarcode =
      duplicateSet.has(
        barcodeValidation
          .normalized
      );

    const variation =
      variationByProduct.get(
        String(
          variant
            .shopify_product_id
        )
      ) || {
        complete: true,
        variantCount: 1,
        optionNames: [],
        issues: []
      };

    const cost =
      findCost(
        costIndex,
        variant
      );

    const profitability =
      estimateProfitability(
        {
          sellingPrice:
            scan.price,

          productCost:
            cost.productCost ??
            cost.cjCost ??
            variant.productCost ??
            variant.cjCost,

          shippingCost:
            cost.shippingCost ??
            cost.cjShippingCost ??
            variant.shippingCost ??
            variant.cjShippingCost,

          referralFeeRate:
            cost
              .referralFeeRate,

          closingFee:
            cost.closingFee,

          fulfillmentFee:
            cost
              .fulfillmentFee
        },

        options
          .profitability ||
        {}
      );

    const score =
      calculateAmazonReadyScore({
        scan,
        barcodeValidation,
        duplicateBarcode,
        variation,
        profitability
      });

    const report = {
      key:
        String(
          variant
            .shopify_variant_id ||
          variant.id ||
          variant.sku ||
          variant.barcode ||
          ""
        ),

      analyzedAt:
        new Date()
          .toISOString(),

      amazonReadyScore:
        score.score,

      intelligenceStatus:
        score.status,

      scoreBreakdown:
        score.breakdown,

      duplicateBarcode,

      barcodeValidation,

      variation,

      profitability,

      scan
    };

    report.blockers =
      buildBlockers(
        report
      );

    reports.push(
      report
    );

    if (
      delayMs > 0 &&
      index <
        variants.length - 1
    ) {
      await sleep(
        delayMs
      );
    }
  }

  reports.sort(
    (
      first,
      second
    ) =>
      second
        .amazonReadyScore -
      first
        .amazonReadyScore
  );

  return {
    success: true,

    version:
      ENGINE_VERSION,

    analyzedAt:
      new Date()
        .toISOString(),

    summary:
      buildIntelligenceSummary(
        reports
      ),

    duplicates:
      duplicateDetails,

    bestTestProduct:
      selectBestTestProduct(
        reports,
        {
          minimumScore
        }
      ),

    reports
  };
}

export default analyzeAmazonReadiness;
