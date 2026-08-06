/* eslint-env node */
/* global process, fetch */

const SHOPIFY_API_VERSION =
  String(process.env.SHOPIFY_API_VERSION || "2026-07").trim();

function normalizeShopifyDomain(value) {
  let domain = String(value || "").trim();
  domain = domain.replace(/^https?:\/\//i, "").replace(/\/+$/g, "");
  if (!domain) throw new Error("SHOPIFY_STORE_DOMAIN is not configured.");
  return domain;
}

function toShopifyGid(value, resourceType) {
  const input = String(value || "").trim();
  if (!input) return null;
  if (input.startsWith("gid://shopify/")) return input;
  if (/^\d+$/.test(input)) {
    return `gid://shopify/${resourceType}/${input}`;
  }
  throw new Error(
    `${resourceType} id must be numeric or a Shopify GID.`
  );
}

function requireShopifyImagesAdmin(req, res, next) {
  const expected = String(process.env.AMAZON_AUTH_SECRET || "").trim();

  if (!expected) return next();

  const provided = String(req.headers["x-admin-key"] || "").trim();

  if (!provided || provided !== expected) {
    return res.status(401).json({
      success: false,
      readOnly: true,
      endpoint: "/shopify/product/images",
      error: "Unauthorized",
    });
  }

  next();
}

async function shopifyGraphQL(query, variables = {}) {
  const storeDomain = normalizeShopifyDomain(
    process.env.SHOPIFY_STORE_DOMAIN
  );

  const accessToken = String(
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || ""
  ).trim();

  if (!accessToken) {
    throw new Error("SHOPIFY_ADMIN_ACCESS_TOKEN is not configured.");
  }

  const url =
    `https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await response.text();

  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (_error) {
    throw new Error(
      `Shopify returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Shopify GraphQL HTTP ${response.status}: ${JSON.stringify(payload)}`
    );
  }

  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new Error(
      `Shopify GraphQL error: ${JSON.stringify(payload.errors)}`
    );
  }

  return payload?.data || {};
}

function normalizeImage(image, source) {
  if (!image?.url) return null;

  return {
    id: image.id || null,
    url: image.url,
    altText: image.altText || null,
    width: Number.isFinite(Number(image.width)) ? Number(image.width) : null,
    height: Number.isFinite(Number(image.height)) ? Number(image.height) : null,
    source,
  };
}

function uniqueImages(images) {
  const seen = new Set();
  const output = [];

  for (const image of images) {
    if (!image?.url) continue;
    if (seen.has(image.url)) continue;
    seen.add(image.url);
    output.push(image);
  }

  return output;
}

async function lookupVariantBySku(sku, limit) {
  const escapedSku = String(sku || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');

  const query = `
    query VariantBySku($query: String!, $limit: Int!) {
      productVariants(first: $limit, query: $query) {
        nodes {
          id
          sku
          title
          image {
            id
            url
            altText
            width
            height
          }
          product {
            id
            title
            handle
            images(first: 100) {
              nodes {
                id
                url
                altText
                width
                height
              }
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(query, {
    query: `sku:"${escapedSku}"`,
    limit,
  });

  const variants = Array.isArray(data?.productVariants?.nodes)
    ? data.productVariants.nodes
    : [];

  const exact =
    variants.find(
      (variant) =>
        String(variant?.sku || "").trim().toUpperCase() ===
        String(sku || "").trim().toUpperCase()
    ) || null;

  return { exact, variants };
}

async function lookupVariantById(variantId) {
  const query = `
    query VariantById($id: ID!) {
      productVariant(id: $id) {
        id
        sku
        title
        image {
          id
          url
          altText
          width
          height
        }
        product {
          id
          title
          handle
          images(first: 100) {
            nodes {
              id
              url
              altText
              width
              height
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(query, { id: variantId });
  return data?.productVariant || null;
}

async function lookupProductById(productId) {
  const query = `
    query ProductById($id: ID!) {
      product(id: $id) {
        id
        title
        handle
        images(first: 100) {
          nodes {
            id
            url
            altText
            width
            height
          }
        }
        variants(first: 100) {
          nodes {
            id
            sku
            title
            image {
              id
              url
              altText
              width
              height
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(query, { id: productId });
  return data?.product || null;
}

export function registerShopifyProductImagesRoute(app) {
  if (!app || typeof app.get !== "function") {
    throw new Error(
      "registerShopifyProductImagesRoute requires an Express app."
    );
  }

  app.get(
    "/shopify/product/images",
    requireShopifyImagesAdmin,
    async (req, res) => {
      try {
        const sku = String(req.query.sku || "").trim();
        const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, 100));
        const rawVariantId = String(req.query.variantId || "").trim();
        const rawProductId = String(req.query.productId || "").trim();

        if (!sku && !rawVariantId && !rawProductId) {
          return res.status(400).json({
            success: false,
            readOnly: true,
            endpoint: "/shopify/product/images",
            error: "Provide sku, variantId, or productId.",
          });
        }

        let variant = null;
        let product = null;
        let skuSearchCandidates = [];

        if (rawVariantId) {
          const variantId = toShopifyGid(rawVariantId, "ProductVariant");
          variant = await lookupVariantById(variantId);

          if (!variant) {
            return res.status(404).json({
              success: false,
              readOnly: true,
              endpoint: "/shopify/product/images",
              error: "Shopify variant not found.",
              variantId,
            });
          }

          product = variant.product || null;
        } else if (sku) {
          const lookup = await lookupVariantBySku(sku, limit);
          variant = lookup.exact;
          skuSearchCandidates = lookup.variants;

          if (!variant) {
            return res.status(404).json({
              success: false,
              readOnly: true,
              endpoint: "/shopify/product/images",
              error: "No exact Shopify variant SKU match.",
              sku,
              candidates: skuSearchCandidates.map((item) => ({
                id: item?.id || null,
                sku: item?.sku || null,
                title: item?.title || null,
                productId: item?.product?.id || null,
                productTitle: item?.product?.title || null,
              })),
            });
          }

          product = variant.product || null;
        } else {
          const productId = toShopifyGid(rawProductId, "Product");
          product = await lookupProductById(productId);

          if (!product) {
            return res.status(404).json({
              success: false,
              readOnly: true,
              endpoint: "/shopify/product/images",
              error: "Shopify product not found.",
              productId,
            });
          }
        }

        const variantImage = normalizeImage(
          variant?.image,
          "VARIANT_IMAGE"
        );

        const productImages = Array.isArray(product?.images?.nodes)
          ? product.images.nodes
              .map((image) => normalizeImage(image, "PRODUCT_IMAGE"))
              .filter(Boolean)
          : [];

        const variantImages = Array.isArray(product?.variants?.nodes)
          ? product.variants.nodes
              .map((item) =>
                normalizeImage(item?.image, "PRODUCT_VARIANT_IMAGE")
              )
              .filter(Boolean)
          : [];

        const images = uniqueImages([
          variantImage,
          ...productImages,
          ...variantImages,
        ]);

        return res.status(200).json({
          success: true,
          readOnly: true,
          externalWritesPerformed: 0,
          endpoint: "/shopify/product/images",
          shopifyApiVersion: SHOPIFY_API_VERSION,
          requested: {
            sku: sku || null,
            variantId: rawVariantId || null,
            productId: rawProductId || null,
          },
          exactVariantMatched: Boolean(variant),
          variant: variant
            ? {
                id: variant.id || null,
                sku: variant.sku || null,
                title: variant.title || null,
                image: variantImage,
              }
            : null,
          product: product
            ? {
                id: product.id || null,
                title: product.title || null,
                handle: product.handle || null,
              }
            : null,
          imageCount: images.length,
          images,
        });
      } catch (error) {
        return res.status(500).json({
          success: false,
          readOnly: true,
          externalWritesPerformed: 0,
          endpoint: "/shopify/product/images",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );
}
