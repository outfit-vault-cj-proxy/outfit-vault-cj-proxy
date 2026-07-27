/* eslint-env node */

// amazonMatcher.js
//
// Portable Amazon Catalog Match Engine.
// Pure matching logic with no Express, Railway, Base44, or Amazon SDK dependency.
//
// Supports both:
//   chooseBestAmazonMatch(sourceProduct, catalogItems, options)
// and legacy:
//   chooseBestAmazonMatch(scoredMatches)
//
// Exports:
//   normalizeText, toArray, normalizeIdentifier, isValidIdentifier,
//   extractAmazonIdentifiers, extractAmazonTitle, extractAmazonBrand,
//   extractAmazonProductType, normalizeApparelCategory, categoriesConflict,
//   calculateTextSimilarity, scoreAmazonCandidate, chooseBestAmazonMatch,
//   MATCH_STATUSES, MATCH_DECISIONS, AMAZON_IDENTIFIER_TYPES

const MATCHER_VERSION = "amazon-matcher-v2";

export const AMAZON_IDENTIFIER_TYPES = [
  "ASIN",
  "UPC",
  "EAN",
  "ISBN",
  "JAN",
  "GTIN"
];

export const MATCH_STATUSES = [
  "IDENTIFIER_MATCH",
  "HIGH_CONFIDENCE_REVIEW",
  "MANUAL_REVIEW",
  "NO_SAFE_MATCH",
  "MISSING_IDENTIFIER",
  "CATEGORY_CONFLICT",
  "BRAND_CONFLICT",
  "VARIANT_CONFLICT",
  "SEARCH_ERROR"
];

export const MATCH_DECISIONS = [
  "AUTO_MATCH",
  "NEEDS_REVIEW",
  "NO_SAFE_MATCH"
];

/* =========================================================
   TEXT + IDENTIFIER HELPERS
========================================================= */

export function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[_/\\|-]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function toArray(value) {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) =>
        String(item || "").split(",")
      )
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

export function normalizeIdentifier(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .trim();
}

function isValidGtinCheckDigit(value) {
  const normalized =
    normalizeIdentifier(value);

  if (!/^\d+$/.test(normalized)) {
    return false;
  }

  const digits = normalized
    .split("")
    .map(Number);

  if (digits.length < 2) {
    return false;
  }

  const suppliedCheckDigit =
    digits.pop();

  const sum = digits
    .reverse()
    .reduce(
      (total, digit, index) =>
        total +
        digit *
          (index % 2 === 0 ? 3 : 1),
      0
    );

  const expectedCheckDigit =
    (10 - (sum % 10)) % 10;

  return (
    suppliedCheckDigit ===
    expectedCheckDigit
  );
}

export function isValidIdentifier(
  value,
  type = ""
) {
  const normalized =
    normalizeIdentifier(value);

  const normalizedType =
    String(type || "")
      .trim()
      .toUpperCase();

  if (!normalized) {
    return false;
  }

  if (normalizedType === "ASIN") {
    return /^[A-Z0-9]{10}$/.test(
      normalized
    );
  }

  if (normalizedType === "UPC") {
    return (
      /^\d{12}$/.test(normalized) &&
      isValidGtinCheckDigit(normalized)
    );
  }

  if (
    normalizedType === "EAN" ||
    normalizedType === "JAN"
  ) {
    return (
      /^\d{13}$/.test(normalized) &&
      isValidGtinCheckDigit(normalized)
    );
  }

  if (normalizedType === "GTIN") {
    return (
      /^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(
        normalized
      ) &&
      isValidGtinCheckDigit(normalized)
    );
  }

  if (normalizedType === "ISBN") {
    if (/^\d{13}$/.test(normalized)) {
      return isValidGtinCheckDigit(
        normalized
      );
    }

    return /^\d{9}[\dX]$/.test(
      normalized
    );
  }

  if (/^[A-Z0-9]{10}$/.test(normalized)) {
    return true;
  }

  if (
    /^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(
      normalized
    )
  ) {
    return isValidGtinCheckDigit(
      normalized
    );
  }

  return false;
}

/* =========================================================
   AMAZON ITEM FIELD EXTRACTION
========================================================= */

export function extractAmazonIdentifiers(item) {
  const identifiers = [];

  if (item?.asin) {
    identifiers.push({
      marketplaceId: null,
      type: "ASIN",
      value: normalizeIdentifier(
        item.asin
      )
    });
  }

  const identifierGroups =
    Array.isArray(item?.identifiers)
      ? item.identifiers
      : [];

  for (const entry of identifierGroups) {
    if (
      Array.isArray(
        entry?.identifiers
      )
    ) {
      for (
        const identifier of
        entry.identifiers
      ) {
        const type = String(
          identifier?.identifierType ||
          identifier?.type ||
          ""
        )
          .trim()
          .toUpperCase();

        const value =
          normalizeIdentifier(
            identifier?.identifier ||
            identifier?.value
          );

        if (value) {
          identifiers.push({
            marketplaceId:
              entry?.marketplaceId ||
              null,
            type,
            value
          });
        }
      }

      continue;
    }

    const type = String(
      entry?.type ||
      entry?.identifierType ||
      ""
    )
      .trim()
      .toUpperCase();

    const value =
      normalizeIdentifier(
        entry?.value ||
        entry?.identifier
      );

    if (value) {
      identifiers.push({
        marketplaceId:
          entry?.marketplaceId ||
          null,
        type,
        value
      });
    }
  }

  const directFields = [
    ["UPC", item?.upc],
    ["EAN", item?.ean],
    ["GTIN", item?.gtin],
    ["ISBN", item?.isbn],
    ["JAN", item?.jan]
  ];

  for (
    const [type, rawValue] of
    directFields
  ) {
    const value =
      normalizeIdentifier(rawValue);

    if (value) {
      identifiers.push({
        marketplaceId: null,
        type,
        value
      });
    }
  }

  return identifiers.filter(
    (entry, index, array) =>
      entry.value &&
      array.findIndex(
        (candidate) =>
          candidate.type ===
            entry.type &&
          candidate.value ===
            entry.value
      ) === index
  );
}

export function extractAmazonTitle(
  item,
  marketplaceId = null
) {
  const summaries =
    Array.isArray(item?.summaries)
      ? item.summaries
      : [];

  const summary =
    summaries.find(
      (entry) =>
        !marketplaceId ||
        entry?.marketplaceId ===
          marketplaceId
    ) ||
    summaries[0];

  return String(
    summary?.itemName ||
    summary?.title ||
    item?.attributes?.item_name?.[0]
      ?.value ||
    item?.amazon_title ||
    item?.title ||
    ""
  ).trim();
}

export function extractAmazonBrand(
  item,
  marketplaceId = null
) {
  const summaries =
    Array.isArray(item?.summaries)
      ? item.summaries
      : [];

  const summary =
    summaries.find(
      (entry) =>
        !marketplaceId ||
        entry?.marketplaceId ===
          marketplaceId
    ) ||
    summaries[0];

  return String(
    summary?.brand ||
    item?.attributes?.brand?.[0]
      ?.value ||
    item?.brand ||
    ""
  ).trim();
}

export function extractAmazonProductType(
  item,
  marketplaceId = null
) {
  const productTypes =
    Array.isArray(item?.productTypes)
      ? item.productTypes
      : [];

  const productType =
    productTypes.find(
      (entry) =>
        !marketplaceId ||
        entry?.marketplaceId ===
          marketplaceId
    ) ||
    productTypes[0];

  return String(
    productType?.productType ||
    item?.attributes?.product_type?.[0]
      ?.value ||
    item?.product_type ||
    item?.amazon_product_type ||
    item?.productType ||
    ""
  ).trim();
}

function extractAmazonColor(item) {
  return String(
    item?.attributes?.color?.[0]?.value ||
    item?.color ||
    ""
  ).trim();
}

function extractAmazonSize(item) {
  return String(
    item?.attributes?.size?.[0]?.value ||
    item?.attributes?.size_name?.[0]
      ?.value ||
    item?.size ||
    ""
  ).trim();
}

function extractAmazonModelNumber(item) {
  return String(
    item?.attributes
      ?.model_number?.[0]?.value ||
    item?.attributes
      ?.part_number?.[0]?.value ||
    item?.modelNumber ||
    item?.model_number ||
    ""
  ).trim();
}

/* =========================================================
   APPAREL CATEGORY NORMALIZATION
========================================================= */

export function normalizeApparelCategory(value) {
  const text = normalizeText(value);

  if (
    /\b(dress|gown|one piece|onepiece)\b/.test(
      text
    )
  ) {
    return "DRESS";
  }

  if (
    /\b(jumpsuit|romper|playsuit)\b/.test(
      text
    )
  ) {
    return "ONE_PIECE";
  }

  if (
    /\b(jeans|pants|trousers|leggings|shorts|joggers|bottoms)\b/.test(
      text
    )
  ) {
    return "BOTTOM";
  }

  if (/\bskirt\b/.test(text)) {
    return "SKIRT";
  }

  if (
    /\b(shirt|blouse|top|tee|t shirt|polo|hoodie|sweater|tank)\b/.test(
      text
    )
  ) {
    return "TOP";
  }

  if (
    /\b(jacket|coat|blazer|cardigan|outerwear)\b/.test(
      text
    )
  ) {
    return "OUTERWEAR";
  }

  if (
    /\b(shoe|boot|sneaker|sandal|heel|loafer|footwear)\b/.test(
      text
    )
  ) {
    return "FOOTWEAR";
  }

  if (
    /\b(bra|panty|panties|lingerie|underwear)\b/.test(
      text
    )
  ) {
    return "INTIMATES";
  }

  if (
    /\b(swimsuit|swimwear|bikini)\b/.test(
      text
    )
  ) {
    return "SWIMWEAR";
  }

  return "UNKNOWN";
}

export function categoriesConflict(
  shopifyValue,
  amazonValue
) {
  const shopifyCategory =
    normalizeApparelCategory(
      shopifyValue
    );

  const amazonCategory =
    normalizeApparelCategory(
      amazonValue
    );

  if (
    shopifyCategory === "UNKNOWN" ||
    amazonCategory === "UNKNOWN"
  ) {
    return false;
  }

  return (
    shopifyCategory !==
    amazonCategory
  );
}

/* =========================================================
   TEXT SIMILARITY
========================================================= */

export function calculateTextSimilarity(
  left,
  right
) {
  const a = normalizeText(left);
  const b = normalizeText(right);

  if (!a || !b) {
    return 0;
  }

  if (a === b) {
    return 100;
  }

  const aTokens = new Set(
    a.split(" ").filter(Boolean)
  );

  const bTokens = new Set(
    b.split(" ").filter(Boolean)
  );

  if (
    !aTokens.size ||
    !bTokens.size
  ) {
    return 0;
  }

  const intersection = [
    ...aTokens
  ].filter(
    (token) => bTokens.has(token)
  ).length;

  const union = new Set([
    ...aTokens,
    ...bTokens
  ]).size;

  return Math.round(
    (intersection / union) *
    100
  );
}

/* =========================================================
   CANDIDATE SCORING
========================================================= */

function collectInputIdentifiers(product = {}) {
  const entries = [
    ["ASIN", product?.asin],
    ["ASIN", product?.amazon_asin],
    ["UPC", product?.upc],
    ["EAN", product?.ean],
    ["GTIN", product?.gtin],
    ["ISBN", product?.isbn],
    ["JAN", product?.jan],
    [product?.identifierType, product?.identifier],
    ["BARCODE", product?.barcode]
  ];

  return entries
    .map(([type, value]) => ({
      type: String(type || "")
        .trim()
        .toUpperCase(),
      value:
        normalizeIdentifier(value)
    }))
    .filter((entry) => entry.value);
}

export function scoreAmazonCandidate({
  product = {},
  item = {},
  marketplaceId = null,
  inputIdentifiers = []
} = {}) {
  const amazonTitle =
    extractAmazonTitle(
      item,
      marketplaceId
    );

  const amazonBrand =
    extractAmazonBrand(
      item,
      marketplaceId
    );

  const amazonType =
    extractAmazonProductType(
      item,
      marketplaceId
    );

  const amazonColor =
    extractAmazonColor(item);

  const amazonSize =
    extractAmazonSize(item);

  const amazonModelNumber =
    extractAmazonModelNumber(item);

  const amazonIdentifiers =
    extractAmazonIdentifiers(item);

  const suppliedInputs = [
    ...collectInputIdentifiers(product),
    ...toArray(inputIdentifiers).map(
      (value) => ({
        type: "",
        value:
          normalizeIdentifier(value)
      })
    )
  ].filter((entry) => entry.value);

  const matchedIdentifier =
    suppliedInputs.length > 0
      ? amazonIdentifiers.find(
          (entry) =>
            suppliedInputs.some(
              (input) =>
                input.value ===
                entry.value
            )
        )
      : null;

  const titleScore =
    calculateTextSimilarity(
      product?.title ||
      product?.productTitle,
      amazonTitle
    );

  const brandScore =
    calculateTextSimilarity(
      product?.vendor ||
      product?.brand,
      amazonBrand
    );

  const typeScore =
    calculateTextSimilarity(
      product?.productType ||
      product?.product_type ||
      product?.category ||
      product?.title,
      `${amazonType} ${amazonTitle}`
    );

  const colorScore =
    product?.color && amazonColor
      ? calculateTextSimilarity(
          product.color,
          amazonColor
        )
      : 0;

  const sizeScore =
    product?.size && amazonSize
      ? calculateTextSimilarity(
          product.size,
          amazonSize
        )
      : 0;

  const modelScore =
    product?.modelNumber &&
    amazonModelNumber
      ? calculateTextSimilarity(
          product.modelNumber,
          amazonModelNumber
        )
      : 0;

  const brandConflict =
    Boolean(
      normalizeText(
        product?.vendor ||
        product?.brand
      )
    ) &&
    Boolean(
      normalizeText(amazonBrand)
    ) &&
    brandScore < 30;

  const productTypeConflict =
    categoriesConflict(
      `${
        product?.productType ||
        product?.product_type ||
        ""
      } ${product?.title || ""}`,
      `${amazonType} ${amazonTitle}`
    );

  const colorConflict =
    Boolean(
      normalizeText(product?.color)
    ) &&
    Boolean(
      normalizeText(amazonColor)
    ) &&
    colorScore < 40;

  const sizeConflict =
    Boolean(
      normalizeText(product?.size)
    ) &&
    Boolean(
      normalizeText(amazonSize)
    ) &&
    sizeScore < 40;

  const modelConflict =
    Boolean(
      normalizeText(
        product?.modelNumber ||
        product?.model_number
      )
    ) &&
    Boolean(
      normalizeText(
        amazonModelNumber
      )
    ) &&
    modelScore < 50;

  let confidence = Math.round(
    titleScore * 0.55 +
    brandScore * 0.2 +
    typeScore * 0.15 +
    colorScore * 0.04 +
    sizeScore * 0.03 +
    modelScore * 0.03
  );

  if (matchedIdentifier) {
    confidence = Math.max(
      confidence,
      97
    );
  }

  if (brandConflict) {
    confidence -= 35;
  }

  if (productTypeConflict) {
    confidence -= 50;
  }

  if (colorConflict) {
    confidence -= 15;
  }

  if (sizeConflict) {
    confidence -= 15;
  }

  if (modelConflict) {
    confidence -= 20;
  }

  confidence = Math.max(
    0,
    Math.min(100, confidence)
  );

  let status =
    "NO_SAFE_MATCH";

  if (
    matchedIdentifier &&
    !brandConflict &&
    !productTypeConflict &&
    !colorConflict &&
    !sizeConflict &&
    !modelConflict
  ) {
    status =
      "IDENTIFIER_MATCH";
  } else if (
    confidence >= 92 &&
    titleScore >= 88 &&
    !brandConflict &&
    !productTypeConflict &&
    !colorConflict &&
    !sizeConflict
  ) {
    status =
      "HIGH_CONFIDENCE_REVIEW";
  } else if (
    confidence >= 75 &&
    !productTypeConflict
  ) {
    status =
      "MANUAL_REVIEW";
  }

  return {
    asin:
      String(item?.asin || "")
        .trim()
        .toUpperCase(),
    status,
    confidence,
    safeToAutoLink:
      status ===
      "IDENTIFIER_MATCH",
    title:
      amazonTitle,
    brand:
      amazonBrand,
    productType:
      amazonType,
    color:
      amazonColor || null,
    size:
      amazonSize || null,
    modelNumber:
      amazonModelNumber || null,
    identifiers:
      amazonIdentifiers,
    scores: {
      title:
        titleScore,
      brand:
        brandScore,
      productType:
        typeScore,
      color:
        colorScore,
      size:
        sizeScore,
      modelNumber:
        modelScore
    },
    conflicts: {
      brand:
        Boolean(brandConflict),
      productType:
        Boolean(
          productTypeConflict
        ),
      color:
        Boolean(colorConflict),
      size:
        Boolean(sizeConflict),
      modelNumber:
        Boolean(modelConflict)
    },
    matchedIdentifier:
      matchedIdentifier || null,
    rawItem:
      item
  };
}

/* =========================================================
   BEST MATCH SELECTION
========================================================= */

function isAlreadyScoredMatch(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.confidence ===
      "number" &&
    typeof value.status ===
      "string"
  );
}

function buildDecisionResponse(
  scoredMatches,
  options = {}
) {
  const ordered = [
    ...scoredMatches
  ].sort(
    (a, b) =>
      b.confidence -
      a.confidence
  );

  const minimumAutoMatchConfidence =
    Number(
      options.minimumAutoMatchConfidence ??
      95
    );

  const minimumReviewConfidence =
    Number(
      options.minimumReviewConfidence ??
      75
    );

  const autoMatch =
    ordered.find(
      (match) =>
        match.status ===
          "IDENTIFIER_MATCH" &&
        match.safeToAutoLink &&
        match.confidence >=
          minimumAutoMatchConfidence &&
        match.asin
    );

  if (autoMatch) {
    return {
      version:
        MATCHER_VERSION,
      decision:
        "AUTO_MATCH",
      bestMatch:
        autoMatch,
      alternatives:
        ordered
          .filter(
            (match) =>
              match !== autoMatch
          )
          .slice(0, 5),
      reason:
        "A verified identifier matched an Amazon catalog item without brand, category, color, size, or model conflicts.",
      confidence:
        autoMatch.confidence,
      safeToPublish:
        true
    };
  }

  const reviewMatch =
    ordered.find(
      (match) =>
        (
          match.status ===
            "HIGH_CONFIDENCE_REVIEW" ||
          match.status ===
            "MANUAL_REVIEW"
        ) &&
        match.confidence >=
          minimumReviewConfidence &&
        match.asin
    );

  if (reviewMatch) {
    return {
      version:
        MATCHER_VERSION,
      decision:
        "NEEDS_REVIEW",
      bestMatch:
        reviewMatch,
      alternatives:
        ordered
          .filter(
            (match) =>
              match !== reviewMatch
          )
          .slice(0, 5),
      reason:
        "A possible Amazon catalog match was found, but it is not safe for automatic linking.",
      confidence:
        reviewMatch.confidence,
      safeToPublish:
        false
    };
  }

  return {
    version:
      MATCHER_VERSION,
    decision:
      "NO_SAFE_MATCH",
    bestMatch:
      null,
    alternatives:
      ordered.slice(0, 5),
    reason:
      ordered.length === 0
        ? "Amazon returned no catalog candidates."
        : "No candidate passed the safe matching rules.",
    confidence:
      ordered[0]?.confidence ||
      0,
    safeToPublish:
      false
  };
}

export function chooseBestAmazonMatch(
  sourceProductOrScoredMatches = [],
  catalogItems = [],
  options = {}
) {
  if (
    Array.isArray(
      sourceProductOrScoredMatches
    ) &&
    sourceProductOrScoredMatches.every(
      isAlreadyScoredMatch
    )
  ) {
    return buildDecisionResponse(
      sourceProductOrScoredMatches,
      options
    );
  }

  const sourceProduct =
    sourceProductOrScoredMatches ||
    {};

  const candidates =
    Array.isArray(catalogItems)
      ? catalogItems
      : [];

  const marketplaceId =
    options.marketplaceId ||
    sourceProduct?.marketplaceId ||
    null;

  const inputIdentifiers =
    collectInputIdentifiers(
      sourceProduct
    ).map((entry) => entry.value);

  const scoredMatches =
    candidates.map((item) =>
      scoreAmazonCandidate({
        product:
          sourceProduct,
        item,
        marketplaceId,
        inputIdentifiers
      })
    );

  return buildDecisionResponse(
    scoredMatches,
    options
  );
}

export default chooseBestAmazonMatch;
