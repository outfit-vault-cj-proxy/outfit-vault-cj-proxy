
// amazon-match.js
//
// Portable Amazon Catalog Match Engine — pure, dependency-free matching logic.
// No Base44 SDK, no Express, no Railway startup code. Safe to drop into the
// live outfit-vault-cj-proxy repository and unit-test in isolation.
//
// Exports:
//   normalizeText, toArray, normalizeIdentifier, isValidIdentifier,
//   extractAmazonIdentifiers, extractAmazonTitle, extractAmazonBrand,
//   extractAmazonProductType, normalizeApparelCategory, categoriesConflict,
//   calculateTextSimilarity, scoreAmazonCandidate, chooseBestAmazonMatch,
//   MATCH_STATUSES, AMAZON_IDENTIFIER_TYPES

// ---------------------------------------------------------------------------
// Text + identifier helpers
// ---------------------------------------------------------------------------

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
      .flatMap((item) => String(item || "").split(","))
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

export function isValidIdentifier(value, type = "") {
  const normalized = normalizeIdentifier(value);
  const normalizedType = String(type || "").toUpperCase();

  if (!normalized) return false;

  if (normalizedType === "ASIN") return /^[A-Z0-9]{10}$/.test(normalized);
  if (normalizedType === "UPC") return /^\d{12}$/.test(normalized);
  if (normalizedType === "EAN") return /^\d{13}$/.test(normalized);
  if (normalizedType === "ISBN") return /^(\d{10}|\d{13})$/.test(normalized);
  if (normalizedType === "JAN") return /^\d{8}$|^\d{13}$/.test(normalized);

  return (
    /^[A-Z0-9]{10}$/.test(normalized) ||
    /^\d{12}$/.test(normalized) ||
    /^\d{13}$/.test(normalized)
  );
}

export const AMAZON_IDENTIFIER_TYPES = ["ASIN", "UPC", "EAN", "ISBN", "JAN"];

// ---------------------------------------------------------------------------
// Amazon item field extraction (handles nested identifiers / summaries)
// ---------------------------------------------------------------------------

export function extractAmazonIdentifiers(item) {
  const result = [];

  if (item?.asin) {
    result.push({
      type: "ASIN",
      value: normalizeIdentifier(item.asin),
    });
  }

  const identifierGroups = Array.isArray(item?.identifiers)
    ? item.identifiers
    : [];

  for (const entry of identifierGroups) {
    // Raw SP-API shape:
    // [{ marketplaceId, identifiers: [{ identifierType, identifier }] }]
    if (Array.isArray(entry?.identifiers)) {
      for (const identifier of entry.identifiers) {
        const type = String(
          identifier?.identifierType || identifier?.type || ""
        ).toUpperCase();

        const value = normalizeIdentifier(
          identifier?.identifier || identifier?.value
        );

        if (value) {
          result.push({
            marketplaceId: entry?.marketplaceId || null,
            type,
            value,
          });
        }
      }

      continue;
    }

    // Railway normalized shape:
    // [{ type: "UPC", value: "889359349981" }]
    const type = String(
      entry?.type || entry?.identifierType || ""
    ).toUpperCase();

    const value = normalizeIdentifier(
      entry?.value || entry?.identifier
    );

    if (value) {
      result.push({
        marketplaceId: entry?.marketplaceId || null,
        type,
        value,
      });
    }
  }

  return result.filter(
    (entry, index, array) =>
      entry.value &&
      array.findIndex(
        (candidate) =>
          candidate.type === entry.type &&
          candidate.value === entry.value
      ) === index
  );
}

export function extractAmazonTitle(item, marketplaceId) {
  const summaries = Array.isArray(item?.summaries) ? item.summaries : [];
  const summary =
    summaries.find((entry) => entry?.marketplaceId === marketplaceId) ||
    summaries[0];
  return String(
    summary?.itemName ||
      summary?.title ||
      item?.attributes?.item_name?.[0]?.value ||
      ""
  ).trim();
}

export function extractAmazonBrand(item, marketplaceId) {
  const summaries = Array.isArray(item?.summaries) ? item.summaries : [];
  const summary =
    summaries.find((entry) => entry?.marketplaceId === marketplaceId) ||
    summaries[0];
  return String(
    summary?.brand || item?.attributes?.brand?.[0]?.value || ""
  ).trim();
}

export function extractAmazonProductType(item, marketplaceId) {
  const productTypes = Array.isArray(item?.productTypes) ? item.productTypes : [];
  const productType =
    productTypes.find((entry) => entry?.marketplaceId === marketplaceId) ||
    productTypes[0];
  return String(
    productType?.productType ||
      item?.attributes?.product_type?.[0]?.value ||
      ""
  ).trim();
}

// ---------------------------------------------------------------------------
// Apparel category normalization + conflict detection
// ---------------------------------------------------------------------------

export function normalizeApparelCategory(value) {
  const text = normalizeText(value);

  if (/\b(dress|gown|one piece|onepiece)\b/.test(text)) return "DRESS";
  if (/\b(jumpsuit|romper|playsuit)\b/.test(text)) return "ONE_PIECE";
  if (/\b(jeans|pants|trousers|leggings|shorts|joggers)\b/.test(text)) return "BOTTOM";
  if (/\b(skirt)\b/.test(text)) return "SKIRT";
  if (/\b(shirt|blouse|top|tee|t shirt|polo|hoodie|sweater)\b/.test(text)) return "TOP";
  if (/\b(jacket|coat|blazer|cardigan)\b/.test(text)) return "OUTERWEAR";
  if (/\b(shoe|boot|sneaker|sandal|heel)\b/.test(text)) return "FOOTWEAR";

  return "UNKNOWN";
}

export function categoriesConflict(shopifyValue, amazonValue) {
  const shopifyCategory = normalizeApparelCategory(shopifyValue);
  const amazonCategory = normalizeApparelCategory(amazonValue);

  if (shopifyCategory === "UNKNOWN" || amazonCategory === "UNKNOWN") return false;
  return shopifyCategory !== amazonCategory;
}

// ---------------------------------------------------------------------------
// Text similarity (Jaccard over normalized tokens)
// ---------------------------------------------------------------------------

export function calculateTextSimilarity(left, right) {
  const a = normalizeText(left);
  const b = normalizeText(right);

  if (!a || !b) return 0;
  if (a === b) return 100;

  const aTokens = new Set(a.split(" ").filter(Boolean));
  const bTokens = new Set(b.split(" ").filter(Boolean));

  if (!aTokens.size || !bTokens.size) return 0;

  const intersection = [...aTokens].filter((token) => bTokens.has(token)).length;
  const union = new Set([...aTokens, ...bTokens]).size;

  return Math.round((intersection / union) * 100);
}

// ---------------------------------------------------------------------------
// Candidate scoring
// ---------------------------------------------------------------------------

export function scoreAmazonCandidate({ product, item, marketplaceId, inputIdentifiers = [] }) {
  const amazonTitle = extractAmazonTitle(item, marketplaceId);
  const amazonBrand = extractAmazonBrand(item, marketplaceId);
  const amazonType = extractAmazonProductType(item, marketplaceId);
  const amazonIdentifiers = extractAmazonIdentifiers(item);

  const normalizedInputs = inputIdentifiers.map(normalizeIdentifier).filter(Boolean);

  const matchedIdentifier =
    normalizedInputs.length > 0
      ? amazonIdentifiers.find((entry) => normalizedInputs.includes(entry.value))
      : null;

  const titleScore = calculateTextSimilarity(product?.title, amazonTitle);
  const brandScore = calculateTextSimilarity(
    product?.vendor || product?.brand,
    amazonBrand
  );
  const typeScore = calculateTextSimilarity(
    product?.productType || product?.category || product?.title,
    `${amazonType} ${amazonTitle}`
  );

  const brandConflict =
    normalizeText(product?.vendor || product?.brand) &&
    normalizeText(amazonBrand) &&
    brandScore < 30;

  const productTypeConflict = categoriesConflict(
    `${product?.productType || ""} ${product?.title || ""}`,
    `${amazonType} ${amazonTitle}`
  );

  let confidence = Math.round(titleScore * 0.65 + brandScore * 0.2 + typeScore * 0.15);

  if (matchedIdentifier) confidence = Math.max(confidence, 95);
  if (brandConflict) confidence -= 35;
  if (productTypeConflict) confidence -= 45;
  confidence = Math.max(0, Math.min(100, confidence));

  let status = "NO_SAFE_MATCH";

  if (matchedIdentifier && !brandConflict && !productTypeConflict) {
    status = "IDENTIFIER_MATCH";
  } else if (confidence >= 92 && titleScore >= 90 && !brandConflict && !productTypeConflict) {
    status = "HIGH_CONFIDENCE_REVIEW";
  } else if (confidence >= 75 && !productTypeConflict) {
    status = "MANUAL_REVIEW";
  }

  return {
    asin: String(item?.asin || "").trim(),
    status,
    confidence,
    safeToAutoLink: status === "IDENTIFIER_MATCH",
    title: amazonTitle,
    brand: amazonBrand,
    productType: amazonType,
    identifiers: amazonIdentifiers,
    scores: { title: titleScore, brand: brandScore, productType: typeScore },
    conflicts: { brand: Boolean(brandConflict), productType: Boolean(productTypeConflict) },
    matchedIdentifier: matchedIdentifier || null,
    rawItem: item,
  };
}

// ---------------------------------------------------------------------------
// Best-match selection
// ---------------------------------------------------------------------------

export function chooseBestAmazonMatch(scoredMatches = []) {
  const ordered = [...scoredMatches].sort(
    (a, b) => b.confidence - a.confidence
  );

  const identifierMatch = ordered.find(
    (match) =>
      match.status === "IDENTIFIER_MATCH" &&
      match.safeToAutoLink
  );

  if (identifierMatch) return identifierMatch;

  const highConfidenceReview = ordered.find(
    (match) => match.status === "HIGH_CONFIDENCE_REVIEW"
  );

  if (highConfidenceReview) return highConfidenceReview;

  const manualReview = ordered.find(
    (match) => match.status === "MANUAL_REVIEW"
  );

  if (manualReview) return manualReview;

  return {
    status: "NO_SAFE_MATCH",
    confidence: 0,
    safeToAutoLink: false,
  };
}

// ---------------------------------------------------------------------------
// Status constants
// ---------------------------------------------------------------------------

export const MATCH_STATUSES = [
  "IDENTIFIER_MATCH",
  "HIGH_CONFIDENCE_REVIEW",
  "MANUAL_REVIEW",
  "NO_SAFE_MATCH",
  "MISSING_IDENTIFIER",
  "CATEGORY_CONFLICT",
  "BRAND_CONFLICT",
  "VARIANT_CONFLICT",
  "SEARCH_ERROR",
];

export const MATCH_DECISIONS = ["PENDING", "APPROVED", "REJECTED", "NEEDS_NEW_SEARCH"];
