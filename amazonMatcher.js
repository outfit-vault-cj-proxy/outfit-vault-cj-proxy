const DECISIONS = Object.freeze({
  AUTO_MATCH: "AUTO_MATCH",
  MANUAL_REVIEW: "MANUAL_REVIEW",
  NO_SAFE_MATCH: "NO_SAFE_MATCH",
});

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeIdentifier(value) {
  return String(value ?? "")
    .replace(/[\s-]/g, "")
    .trim()
    .toUpperCase();
}

function tokenize(value) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return new Set();
  }

  return new Set(
    normalized
      .split(" ")
      .filter((token) => token.length > 1),
  );
}

function textSimilarity(left, right) {
  const leftText = normalizeText(left);
  const rightText = normalizeText(right);

  if (!leftText || !rightText) {
    return null;
  }

  if (leftText === rightText) {
    return 1;
  }

  if (
    leftText.includes(rightText) ||
    rightText.includes(leftText)
  ) {
    const shorterLength = Math.min(
      leftText.length,
      rightText.length,
    );

    const longerLength = Math.max(
      leftText.length,
      rightText.length,
    );

    return Math.max(0.75, shorterLength / longerLength);
  }

  const leftTokens = tokenize(leftText);
  const rightTokens = tokenize(rightText);

  if (!leftTokens.size || !rightTokens.size) {
    return 0;
  }

  const intersection = [...leftTokens].filter((token) =>
    rightTokens.has(token),
  ).length;

  const union = new Set([
    ...leftTokens,
    ...rightTokens,
  ]).size;

  return union ? intersection / union : 0;
}

function valuesConflict(left, right) {
  const leftText = normalizeText(left);
  const rightText = normalizeText(right);

  if (!leftText || !rightText) {
    return false;
  }

  return textSimilarity(leftText, rightText) < 0.2;
}

function flattenCandidateIdentifiers(candidate) {
  const identifiers = [];

  for (const marketplaceEntry of candidate?.identifiers ?? []) {
    for (
      const identifierEntry of
      marketplaceEntry?.identifiers ?? []
    ) {
      const type = String(
        identifierEntry?.identifierType ?? "",
      )
        .trim()
        .toUpperCase();

      const value = normalizeIdentifier(
        identifierEntry?.identifier,
      );

      if (type && value) {
        identifiers.push({
          type,
          value,
        });
      }
    }
  }

  return identifiers;
}

function identifiersAreEquivalent(
  submittedType,
  submittedValue,
  candidateType,
  candidateValue,
) {
  const leftType = String(submittedType ?? "")
    .trim()
    .toUpperCase();

  const rightType = String(candidateType ?? "")
    .trim()
    .toUpperCase();

  const leftValue = normalizeIdentifier(submittedValue);
  const rightValue = normalizeIdentifier(candidateValue);

  if (!leftValue || !rightValue) {
    return false;
  }

  if (leftValue === rightValue) {
    return true;
  }

  // EAN-13 may represent a UPC-A with one leading zero.
  if (
    (
      (leftType === "UPC" && rightType === "EAN") ||
      (leftType === "EAN" && rightType === "UPC")
    ) &&
    leftValue.padStart(13, "0") ===
      rightValue.padStart(13, "0")
  ) {
    return true;
  }

  // JAN uses the EAN-13 structure.
  if (
    (leftType === "JAN" || rightType === "JAN") &&
    leftValue === rightValue
  ) {
    return true;
  }

  return false;
}

function findIdentifierMatch(
  sourceProduct,
  candidate,
) {
  const submittedType = String(
    sourceProduct?.identifierType ?? "",
  )
    .trim()
    .toUpperCase();

  const submittedValue = normalizeIdentifier(
    sourceProduct?.identifier,
  );

  if (!submittedType || !submittedValue) {
    return null;
  }

  if (
    submittedType === "ASIN" &&
    normalizeIdentifier(candidate?.asin) === submittedValue
  ) {
    return {
      matched: true,
      submittedType,
      candidateType: "ASIN",
      value: submittedValue,
    };
  }

  const candidateIdentifiers =
    flattenCandidateIdentifiers(candidate);

  for (const entry of candidateIdentifiers) {
    if (
      identifiersAreEquivalent(
        submittedType,
        submittedValue,
        entry.type,
        entry.value,
      )
    ) {
      return {
        matched: true,
        submittedType,
        candidateType: entry.type,
        value: entry.value,
      };
    }
  }

  return null;
}

function addCriterion(
  criteria,
  name,
  sourceValue,
  candidateValue,
  weight,
) {
  const similarity = textSimilarity(
    sourceValue,
    candidateValue,
  );

  if (similarity === null) {
    return {
      earned: 0,
      available: 0,
    };
  }

  const earned = similarity * weight;

  criteria.push({
    name,
    sourceValue: sourceValue ?? null,
    candidateValue: candidateValue ?? null,
    similarity: Number(similarity.toFixed(4)),
    weight,
    earned: Number(earned.toFixed(2)),
  });

  return {
    earned,
    available: weight,
  };
}

export function scoreAmazonCandidate(
  sourceProduct,
  candidate,
) {
  const criteria = [];
  const warnings = [];

  let earnedPoints = 0;
  let availablePoints = 0;

  const identifierMatch = findIdentifierMatch(
    sourceProduct,
    candidate,
  );

  if (identifierMatch) {
    criteria.push({
      name: "identifier",
      similarity: 1,
      weight: 60,
      earned: 60,
      details: identifierMatch,
    });

    earnedPoints += 60;
    availablePoints += 60;
  } else if (
    sourceProduct?.identifier &&
    sourceProduct?.identifierType
  ) {
    criteria.push({
      name: "identifier",
      similarity: 0,
      weight: 60,
      earned: 0,
      details: {
        submittedType:
          sourceProduct.identifierType,
        submittedValue:
          sourceProduct.identifier,
      },
    });

    availablePoints += 60;
    warnings.push("IDENTIFIER_DID_NOT_MATCH");
  }

  const comparisons = [
    [
      "title",
      sourceProduct?.title,
      candidate?.title,
      20,
    ],
    [
      "brand",
      sourceProduct?.brand,
      candidate?.brand,
      8,
    ],
    [
      "productType",
      sourceProduct?.productType,
      candidate?.productType,
      5,
    ],
    [
      "color",
      sourceProduct?.color,
      candidate?.color,
      3,
    ],
    [
      "size",
      sourceProduct?.size,
      candidate?.size,
      2,
    ],
    [
      "modelNumber",
      sourceProduct?.modelNumber,
      candidate?.modelNumber,
      2,
    ],
  ];

  for (const [
    name,
    sourceValue,
    candidateValue,
    weight,
  ] of comparisons) {
    const result = addCriterion(
      criteria,
      name,
      sourceValue,
      candidateValue,
      weight,
    );

    earnedPoints += result.earned;
    availablePoints += result.available;
  }

  if (
    valuesConflict(
      sourceProduct?.brand,
      candidate?.brand,
    )
  ) {
    warnings.push("BRAND_CONFLICT");
    earnedPoints -= 15;
  }

  if (
    valuesConflict(
      sourceProduct?.productType,
      candidate?.productType,
    )
  ) {
    warnings.push("PRODUCT_TYPE_CONFLICT");
    earnedPoints -= 20;
  }

  if (
    valuesConflict(
      sourceProduct?.color,
      candidate?.color,
    )
  ) {
    warnings.push("COLOR_CONFLICT");
    earnedPoints -= 5;
  }

  const rawScore =
    availablePoints > 0
      ? (earnedPoints / availablePoints) * 100
      : 0;

  const score = Math.max(
    0,
    Math.min(100, Math.round(rawScore)),
  );

  let decision = DECISIONS.NO_SAFE_MATCH;

  if (
    identifierMatch &&
    !warnings.includes("BRAND_CONFLICT") &&
    !warnings.includes("PRODUCT_TYPE_CONFLICT") &&
    score >= 85
  ) {
    decision = DECISIONS.AUTO_MATCH;
  } else if (score >= 65) {
    decision = DECISIONS.MANUAL_REVIEW;
  }

  return {
    asin: candidate?.asin ?? null,
    score,
    decision,
    identifierMatch: identifierMatch ?? null,
    warnings,
    criteria,
  };
}

export function chooseBestAmazonMatch(
  sourceProduct,
  candidates = [],
) {
  const scoredCandidates = candidates
    .map((candidate) => ({
      candidate,
      evaluation: scoreAmazonCandidate(
        sourceProduct,
        candidate,
      ),
    }))
    .sort(
      (left, right) =>
        right.evaluation.score -
        left.evaluation.score,
    );

  const best = scoredCandidates[0] ?? null;
  const runnerUp = scoredCandidates[1] ?? null;

  if (!best) {
    return {
      decision: DECISIONS.NO_SAFE_MATCH,
      bestMatch: null,
      alternatives: [],
      reason: "NO_AMAZON_CANDIDATES",
    };
  }

  let finalDecision = best.evaluation.decision;
  const scoreGap = runnerUp
    ? best.evaluation.score -
      runnerUp.evaluation.score
    : null;

  if (
    finalDecision === DECISIONS.AUTO_MATCH &&
    scoreGap !== null &&
    scoreGap < 10
  ) {
    finalDecision = DECISIONS.MANUAL_REVIEW;
  }

  return {
    decision: finalDecision,
    bestMatch: {
      ...best.candidate,
      matchEvaluation: {
        ...best.evaluation,
        decision: finalDecision,
      },
    },
    alternatives: scoredCandidates
      .slice(1, 4)
      .map(({ candidate, evaluation }) => ({
        ...candidate,
        matchEvaluation: evaluation,
      })),
    scoreGap,
    reason:
      finalDecision === DECISIONS.AUTO_MATCH
        ? "HIGH_CONFIDENCE_UNIQUE_MATCH"
        : finalDecision === DECISIONS.MANUAL_REVIEW
          ? "MATCH_REQUIRES_REVIEW"
          : "NO_SAFE_MATCH",
  };
}

export { DECISIONS };
