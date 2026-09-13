/**
 * Source of truth for the Firefighter demo repository.
 *
 * The demo is a small but genuinely runnable CommonJS checkout service. History
 * is expressed as an ordered list of commits, each carrying the FULL contents of
 * every file it touches, so the seeder can replay the whole story into a real
 * git repository with deterministic shas.
 *
 * The story: PR #142 adds country specific tax rules and, with them, an
 * unguarded customer.country.toUpperCase() inside CheckoutValidator. Registered
 * customers always carry a country so every test keeps passing; guest checkout
 * does not, so production throws a TypeError three minutes after the deploy.
 * PR #143 ships afterwards but only edits README.md, which makes "blame the most
 * recent deploy" the wrong answer.
 *
 * Invariant for anything edited here: the demo sources contain NO backticks and
 * no dollar-brace sequences, so they can live inside TypeScript template
 * literals without escaping.
 */

/** One commit in the replayed history of the demo repository. */
export interface DemoCommitSpec {
  /** Pull request this squash-merge commit came from. */
  prNumber: number;
  title: string;
  body: string;
  /** Git author name (also used as the PR author handle). */
  author: string;
  /** Git author email. */
  email: string;
  /** ISO timestamp used for BOTH the author and the committer date. */
  date: string;
  /** Repo-relative path -> full new contents of that file at this commit. */
  files: Record<string, string>;
  /** Repo-relative paths removed by this commit. */
  deletes?: string[];
  labels: string[];
  /** When present, a successful production deployment is recorded for this commit. */
  deployedAt?: string;
  /** Branch the PR merged from. Falls back to a slug of the title. */
  headRef?: string;
}

/** The pull request that introduced the regression. */
export const REGRESSION_PR_NUMBER = 142;

/** The file the failing stack frame points at. */
export const REGRESSION_FILE = 'src/validators/CheckoutValidator.js';

/** Contents of the demo repo's .gitignore, committed in the first commit. */
export const DEMO_GITIGNORE = `.firefighter-meta.json
.firefighter-prs.json
node_modules/
`;

// ---------------------------------------------------------------------------
// File contents, one constant per version of each file
// ---------------------------------------------------------------------------

/**
 * Derive one file version from another by replacing an exact snippet.
 * Throws if the snippet is absent, so a fixture can never silently drift.
 */
function mustReplace(source: string, find: string, replaceWith: string): string {
  if (!source.includes(find)) {
    throw new Error('demo fixture drift: snippet not found -> ' + find);
  }
  return source.replace(find, replaceWith);
}

const PACKAGE_JSON = `{
  "name": "checkout-service",
  "private": true,
  "version": "1.0.0",
  "description": "Checkout API for the Firefighter demo storefront.",
  "main": "src/checkout.js",
  "scripts": {
    "test": "node --test"
  }
}
`;

const README_V1 = `# checkout-service

Checkout API for the demo storefront. It validates an incoming order, prices the
cart, confirms stock and returns a response envelope.

## Layout

    src/checkout.js                        HTTP entry point (handleCheckout)
    src/validators/CheckoutValidator.js    per-field order validation
    src/pricing.js                         cart pricing
    src/inventory.js                       stock checks
    src/db.js                              in-memory product catalogue

## Tests

    npm test
`;

const README_V2 = `# checkout-service

Checkout API for the demo storefront. It validates an incoming order, prices the
cart, confirms stock and returns a response envelope.

## Layout

    src/checkout.js                        HTTP entry point (handleCheckout)
    src/validators/CheckoutValidator.js    per-field order validation
    src/pricing.js                         cart pricing
    src/inventory.js                       stock checks
    src/db.js                              in-memory product catalogue

## Request envelope

POST /api/checkout takes a request of the shape:

    {
      "method": "POST",
      "path": "/api/checkout",
      "body": {
        "customer": { "id": "cus_1001", "email": "ada@example.com", "country": "US" },
        "items": [{ "sku": "SKU-1", "qty": 1 }],
        "payment": { "type": "card", "token": "tok_visa_4242" },
        "promoCode": "WELCOME10"
      }
    }

Guest checkout is supported: a guest order carries a customer with a null id and
no saved address, so profile fields such as country may be null.

## Response envelope

handleCheckout returns { status, body }.

    200  order accepted, body carries orderId, lines, subtotalCents,
         discountCents, taxCents and totalCents
    400  validation_failed, body.errors lists every field problem at once
    409  out_of_stock, body.shortages lists the SKUs that came up short

Anything else propagates: the handler deliberately does not swallow unexpected
errors, so they surface as a 500 with a real stack trace.

## Tests

    npm test
`;

const DB_V1 = `'use strict';

/**
 * Tiny in-memory catalogue. Stands in for the Postgres backed product store
 * until the migration lands.
 */

const PRODUCTS = {
  'SKU-1': { sku: 'SKU-1', name: 'Aeropress Go', priceCents: 3999, stock: 12 },
  'SKU-2': { sku: 'SKU-2', name: 'Burr Grinder', priceCents: 12900, stock: 4 },
  'SKU-3': { sku: 'SKU-3', name: 'Gooseneck Kettle', priceCents: 7450, stock: 0 },
  'SKU-4': { sku: 'SKU-4', name: 'Filter Papers (100)', priceCents: 899, stock: 230 },
};

/**
 * Look up a single product.
 * @param {string} sku
 * @returns {object|null}
 */
function getProduct(sku) {
  return Object.prototype.hasOwnProperty.call(PRODUCTS, sku) ? PRODUCTS[sku] : null;
}

/**
 * Every product, ordered by SKU.
 * @returns {Array<object>}
 */
function listProducts() {
  return Object.keys(PRODUCTS)
    .sort()
    .map(function (sku) {
      return PRODUCTS[sku];
    });
}

/**
 * Stock on hand for a SKU. Unknown SKUs report zero.
 * @param {string} sku
 * @returns {number}
 */
function getStock(sku) {
  const product = getProduct(sku);
  return product ? product.stock : 0;
}

module.exports = { PRODUCTS, getProduct, listProducts, getStock };
`;

const PRICING_V1 = `'use strict';

const { getProduct } = require('./db.js');

/**
 * Price a cart.
 * @param {Array<{sku: string, qty: number}>} items
 * @returns {object} pricing envelope in minor units
 */
function computePrice(items) {
  const lines = [];
  let subtotalCents = 0;

  for (const item of items) {
    const product = getProduct(item.sku);
    if (!product) {
      throw new Error('unknown sku: ' + item.sku);
    }
    const lineCents = product.priceCents * item.qty;
    subtotalCents += lineCents;
    lines.push({
      sku: product.sku,
      name: product.name,
      qty: item.qty,
      unitPriceCents: product.priceCents,
      lineCents: lineCents,
    });
  }

  return {
    currency: 'USD',
    lines: lines,
    subtotalCents: subtotalCents,
    discountCents: 0,
    totalCents: subtotalCents,
  };
}

module.exports = { computePrice };
`;

const PRICING_V2 = `'use strict';

const { getProduct } = require('./db.js');

/** Percentage discounts keyed by promo code. */
const PROMO_CODES = {
  WELCOME10: 0.1,
  BREW20: 0.2,
  RESTOCK5: 0.05,
};

/**
 * Resolve the discount for a promo code. Unknown or missing codes are ignored
 * so a typo never blocks a checkout.
 * @param {string|null|undefined} promoCode
 * @param {number} subtotalCents
 * @returns {number} discount in minor units
 */
function discountFor(promoCode, subtotalCents) {
  if (typeof promoCode !== 'string') {
    return 0;
  }
  const rate = PROMO_CODES[promoCode.toUpperCase()];
  if (typeof rate !== 'number') {
    return 0;
  }
  return Math.round(subtotalCents * rate);
}

/**
 * Price a cart, applying any promo code.
 * @param {Array<{sku: string, qty: number}>} items
 * @param {string=} promoCode
 * @returns {object} pricing envelope in minor units
 */
function computePrice(items, promoCode) {
  const lines = [];
  let subtotalCents = 0;

  for (const item of items) {
    const product = getProduct(item.sku);
    if (!product) {
      throw new Error('unknown sku: ' + item.sku);
    }
    const lineCents = product.priceCents * item.qty;
    subtotalCents += lineCents;
    lines.push({
      sku: product.sku,
      name: product.name,
      qty: item.qty,
      unitPriceCents: product.priceCents,
      lineCents: lineCents,
    });
  }

  const discountCents = discountFor(promoCode, subtotalCents);

  return {
    currency: 'USD',
    lines: lines,
    subtotalCents: subtotalCents,
    discountCents: discountCents,
    totalCents: subtotalCents - discountCents,
  };
}

module.exports = { computePrice, discountFor, PROMO_CODES };
`;

const PRICING_V3 = `'use strict';

const { getProduct } = require('./db.js');

/** Percentage discounts keyed by promo code. */
const PROMO_CODES = {
  WELCOME10: 0.1,
  BREW20: 0.2,
  RESTOCK5: 0.05,
};

/**
 * Country level tax rates. US stays at zero here on purpose: state level sales
 * tax is calculated downstream by the tax service.
 */
const TAX_RATES = {
  US: 0,
  CA: 0.05,
  GB: 0.2,
  DE: 0.19,
  FR: 0.2,
};

/**
 * Resolve the discount for a promo code. Unknown or missing codes are ignored
 * so a typo never blocks a checkout.
 * @param {string|null|undefined} promoCode
 * @param {number} subtotalCents
 * @returns {number} discount in minor units
 */
function discountFor(promoCode, subtotalCents) {
  if (typeof promoCode !== 'string') {
    return 0;
  }
  const rate = PROMO_CODES[promoCode.toUpperCase()];
  if (typeof rate !== 'number') {
    return 0;
  }
  return Math.round(subtotalCents * rate);
}

/**
 * Tax rate for a destination country. Unknown destinations are untaxed.
 * @param {string|null|undefined} country
 * @returns {number}
 */
function taxRateFor(country) {
  if (typeof country !== 'string') {
    return 0;
  }
  const rate = TAX_RATES[country.toUpperCase()];
  return typeof rate === 'number' ? rate : 0;
}

/**
 * Price a cart, applying any promo code and the destination tax rate.
 * @param {Array<{sku: string, qty: number}>} items
 * @param {string=} promoCode
 * @param {string=} country
 * @returns {object} pricing envelope in minor units
 */
function computePrice(items, promoCode, country) {
  const lines = [];
  let subtotalCents = 0;

  for (const item of items) {
    const product = getProduct(item.sku);
    if (!product) {
      throw new Error('unknown sku: ' + item.sku);
    }
    const lineCents = product.priceCents * item.qty;
    subtotalCents += lineCents;
    lines.push({
      sku: product.sku,
      name: product.name,
      qty: item.qty,
      unitPriceCents: product.priceCents,
      lineCents: lineCents,
    });
  }

  const discountCents = discountFor(promoCode, subtotalCents);
  const taxableCents = subtotalCents - discountCents;
  const taxCents = Math.round(taxableCents * taxRateFor(country));

  return {
    currency: 'USD',
    lines: lines,
    subtotalCents: subtotalCents,
    discountCents: discountCents,
    taxCents: taxCents,
    totalCents: taxableCents + taxCents,
  };
}

module.exports = { computePrice, discountFor, taxRateFor, PROMO_CODES, TAX_RATES };
`;

const INVENTORY_V1 = `'use strict';

const { getStock } = require('./db.js');

/**
 * Confirm every line item can be fulfilled from stock on hand.
 * @param {Array<{sku: string, qty: number}>} items
 * @returns {{ok: boolean, shortages: Array<object>}}
 */
function checkStock(items) {
  const shortages = [];

  for (const item of items) {
    const available = getStock(item.sku);
    if (available < item.qty) {
      shortages.push({ sku: item.sku, requested: item.qty, available: available });
    }
  }

  return { ok: shortages.length === 0, shortages: shortages };
}

module.exports = { checkStock };
`;

const INVENTORY_V2 = `'use strict';

const { listProducts } = require('./db.js');

/**
 * Snapshot stock levels once per request instead of reading per line item.
 * @returns {Map<string, number>}
 */
function stockSnapshot() {
  const snapshot = new Map();
  for (const product of listProducts()) {
    snapshot.set(product.sku, product.stock);
  }
  return snapshot;
}

/**
 * Aggregate requested quantities so a cart listing the same SKU twice is
 * compared against stock once.
 * @param {Array<{sku: string, qty: number}>} items
 * @returns {Map<string, number>}
 */
function requestedQuantities(items) {
  const requested = new Map();
  for (const item of items) {
    const current = requested.get(item.sku) || 0;
    requested.set(item.sku, current + item.qty);
  }
  return requested;
}

/**
 * Confirm every line item can be fulfilled from stock on hand.
 * @param {Array<{sku: string, qty: number}>} items
 * @returns {{ok: boolean, shortages: Array<object>}}
 */
function checkStock(items) {
  const snapshot = stockSnapshot();
  const requested = requestedQuantities(items);
  const shortages = [];

  for (const entry of requested) {
    const sku = entry[0];
    const qty = entry[1];
    const available = snapshot.has(sku) ? snapshot.get(sku) : 0;
    if (available < qty) {
      shortages.push({ sku: sku, requested: qty, available: available });
    }
  }

  shortages.sort(function (a, b) {
    if (a.sku < b.sku) return -1;
    if (a.sku > b.sku) return 1;
    return 0;
  });

  return { ok: shortages.length === 0, shortages: shortages };
}

module.exports = { checkStock, stockSnapshot, requestedQuantities };
`;

const VALIDATOR_V1 = `'use strict';

/** Payment methods the checkout accepts. */
const ACCEPTED_PAYMENT_TYPES = ['card', 'paypal', 'apple_pay'];

/**
 * Field level validation for incoming checkout orders.
 *
 * Every validator method returns an array of human readable error strings and
 * validate() aggregates them, so a caller sees every problem at once rather
 * than one per round trip.
 */
class CheckoutValidator {
  /**
   * Run every field validator over an order.
   * @param {object} order
   * @returns {{ok: boolean, errors: Array<string>}}
   */
  validate(order) {
    const errors = [];
    errors.push(...this.items(order));
    errors.push(...this.payment(order));
    return { ok: errors.length === 0, errors: errors };
  }

  /**
   * Validate the cart line items.
   * @param {object} order
   * @returns {Array<string>}
   */
  items(order) {
    const errors = [];
    const items = order && order.items;

    if (!Array.isArray(items) || items.length === 0) {
      errors.push('items: at least one line item is required');
      return errors;
    }

    for (const item of items) {
      if (!item || typeof item.sku !== 'string' || item.sku.length === 0) {
        errors.push('items: every line item needs a sku');
        continue;
      }
      if (!Number.isInteger(item.qty) || item.qty < 1) {
        errors.push('items: qty for ' + item.sku + ' must be a positive integer');
      }
    }

    return errors;
  }

  /**
   * Validate the payment envelope.
   * @param {object} order
   * @returns {Array<string>}
   */
  payment(order) {
    const errors = [];
    const payment = order && order.payment;

    if (!payment) {
      errors.push('payment: payment details are required');
      return errors;
    }
    if (!ACCEPTED_PAYMENT_TYPES.includes(payment.type)) {
      errors.push('payment: unsupported payment type ' + payment.type);
    }
    if (typeof payment.token !== 'string' || payment.token.length < 3) {
      errors.push('payment: a payment token is required');
    }

    return errors;
  }
}

module.exports = { CheckoutValidator, ACCEPTED_PAYMENT_TYPES };
`;

const VALIDATOR_V2 = `'use strict';

/** Payment methods the checkout accepts. */
const ACCEPTED_PAYMENT_TYPES = ['card', 'paypal', 'apple_pay'];

/** Destinations finance can calculate tax for. */
const SUPPORTED_COUNTRIES = ['US', 'CA', 'GB', 'DE', 'FR'];

/**
 * Field level validation for incoming checkout orders.
 *
 * Every validator method returns an array of human readable error strings and
 * validate() aggregates them, so a caller sees every problem at once rather
 * than one per round trip.
 */
class CheckoutValidator {
  /**
   * Run every field validator over an order.
   * @param {object} order
   * @returns {{ok: boolean, errors: Array<string>}}
   */
  validate(order) {
    const errors = [];
    errors.push(...this.items(order));
    errors.push(...this.payment(order));
    errors.push(...this.country(order.customer));
    return { ok: errors.length === 0, errors: errors };
  }

  /**
   * Validate the cart line items.
   * @param {object} order
   * @returns {Array<string>}
   */
  items(order) {
    const errors = [];
    const items = order && order.items;

    if (!Array.isArray(items) || items.length === 0) {
      errors.push('items: at least one line item is required');
      return errors;
    }

    for (const item of items) {
      if (!item || typeof item.sku !== 'string' || item.sku.length === 0) {
        errors.push('items: every line item needs a sku');
        continue;
      }
      if (!Number.isInteger(item.qty) || item.qty < 1) {
        errors.push('items: qty for ' + item.sku + ' must be a positive integer');
      }
    }

    return errors;
  }

  /**
   * Validate the payment envelope.
   * @param {object} order
   * @returns {Array<string>}
   */
  payment(order) {
    const errors = [];
    const payment = order && order.payment;

    if (!payment) {
      errors.push('payment: payment details are required');
      return errors;
    }
    if (!ACCEPTED_PAYMENT_TYPES.includes(payment.type)) {
      errors.push('payment: unsupported payment type ' + payment.type);
    }
    if (typeof payment.token !== 'string' || payment.token.length < 3) {
      errors.push('payment: a payment token is required');
    }

    return errors;
  }

  /**
   * Orders must declare a destination country so the right tax rules apply.
   * @param {object} customer
   * @returns {Array<string>}
   */
  country(customer) {
    const errors = [];
    const code = customer.country.toUpperCase();

    if (!SUPPORTED_COUNTRIES.includes(code)) {
      errors.push('country: ' + code + ' is not a supported destination');
    }

    return errors;
  }
}

module.exports = { CheckoutValidator, ACCEPTED_PAYMENT_TYPES, SUPPORTED_COUNTRIES };
`;

const CHECKOUT_V1 = `'use strict';

const { CheckoutValidator } = require('./validators/CheckoutValidator.js');
const { computePrice } = require('./pricing.js');
const { checkStock } = require('./inventory.js');

const validator = new CheckoutValidator();

/**
 * Deterministic order id derived from the cart, so replays are reproducible.
 * @param {object} order
 * @returns {string}
 */
function orderId(order) {
  const seed = order.items
    .map(function (item) {
      return item.sku + 'x' + item.qty;
    })
    .join('|');

  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return 'ord_' + hash.toString(16).padStart(8, '0');
}

/**
 * Handle POST /api/checkout.
 *
 * Unexpected errors are deliberately NOT caught here: the API gateway turns
 * them into a 500 and reports the stack, which is what we want to see.
 *
 * @param {{method: string, path: string, body: object}} request
 * @returns {{status: number, body: object}}
 */
function handleCheckout(request) {
  const order = request.body;

  const validation = validator.validate(order);
  if (!validation.ok) {
    return { status: 400, body: { error: 'validation_failed', errors: validation.errors } };
  }

  const stock = checkStock(order.items);
  if (!stock.ok) {
    return { status: 409, body: { error: 'out_of_stock', shortages: stock.shortages } };
  }

  const price = computePrice(order.items);

  return {
    status: 200,
    body: Object.assign({ orderId: orderId(order) }, price),
  };
}

module.exports = { handleCheckout };
`;

const CHECKOUT_V2 = mustReplace(
  CHECKOUT_V1,
  '  const price = computePrice(order.items);',
  '  const price = computePrice(order.items, order.promoCode);',
);

const CHECKOUT_V3 = mustReplace(
  CHECKOUT_V1,
  '  const price = computePrice(order.items);',
  '  const price = computePrice(order.items, order.promoCode, order.customer.country);',
);

const TEST_V1 = `'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleCheckout } = require('../src/checkout.js');

/**
 * Build a checkout request for a registered customer. Registered customers
 * always have a saved profile, so every field below is populated.
 */
function orderRequest(overrides) {
  const body = {
    customer: { id: 'cus_1001', email: 'ada@example.com', country: 'US' },
    items: [{ sku: 'SKU-1', qty: 1 }],
    payment: { type: 'card', token: 'tok_visa_4242' },
  };
  return {
    method: 'POST',
    path: '/api/checkout',
    headers: { 'content-type': 'application/json' },
    body: Object.assign(body, overrides || {}),
  };
}

test('a registered customer can check out', function () {
  const res = handleCheckout(orderRequest());
  assert.equal(res.status, 200);
  assert.equal(res.body.currency, 'USD');
  assert.equal(res.body.subtotalCents, 3999);
  assert.equal(res.body.totalCents, 3999);
  assert.match(res.body.orderId, /^ord_[0-9a-f]{8}$/);
});

test('line items are priced per unit', function () {
  const res = handleCheckout(
    orderRequest({ items: [{ sku: 'SKU-1', qty: 2 }, { sku: 'SKU-4', qty: 3 }] }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.lines.length, 2);
  assert.equal(res.body.subtotalCents, 10695);
  assert.equal(res.body.totalCents, 10695);
});

test('an empty cart is rejected', function () {
  const res = handleCheckout(orderRequest({ items: [] }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'validation_failed');
  assert.ok(
    res.body.errors.some(function (e) {
      return e.startsWith('items:');
    }),
  );
});

test('missing payment details are rejected', function () {
  const res = handleCheckout(orderRequest({ payment: null }));
  assert.equal(res.status, 400);
  assert.ok(
    res.body.errors.some(function (e) {
      return e.startsWith('payment:');
    }),
  );
});

test('an out of stock SKU returns 409', function () {
  const res = handleCheckout(orderRequest({ items: [{ sku: 'SKU-3', qty: 1 }] }));
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'out_of_stock');
  assert.equal(res.body.shortages[0].sku, 'SKU-3');
  assert.equal(res.body.shortages[0].available, 0);
});
`;

const TEST_V2 = mustReplace(
  TEST_V1,
  "test('an empty cart is rejected'",
  `test('a promo code applies a percentage discount', function () {
  const res = handleCheckout(orderRequest({ promoCode: 'WELCOME10' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.discountCents, 400);
  assert.equal(res.body.totalCents, 3599);
});

test('an unknown promo code is ignored rather than rejected', function () {
  const res = handleCheckout(orderRequest({ promoCode: 'NOT-A-CODE' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.discountCents, 0);
  assert.equal(res.body.totalCents, 3999);
});

test('an empty cart is rejected'`,
);

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * The demo repository's history, oldest first. Each entry is one squash-merged
 * pull request; the seeder replays them into a real git repo with fixed author
 * and committer dates, which makes every resulting sha deterministic.
 */
export const DEMO_COMMITS: DemoCommitSpec[] = [
  {
    prNumber: 128,
    title: 'chore: bootstrap checkout service',
    body: [
      'Bootstraps the checkout service extracted from the monolith.',
      '',
      '- handleCheckout validates an order, prices the cart and confirms stock',
      '- CheckoutValidator owns per-field validation and reports every problem at once',
      '- the in-memory catalogue stands in for the product DB until the Postgres',
      '  migration lands',
      '',
      'Tests: npm test',
    ].join('\n'),
    author: 'dana-mercer',
    email: 'dana.mercer@firefighter-demo.dev',
    date: '2026-09-10T09:00:00Z',
    headRef: 'chore/bootstrap-checkout-service',
    labels: ['chore', 'checkout'],
    files: {
      '.gitignore': DEMO_GITIGNORE,
      'package.json': PACKAGE_JSON,
      'README.md': README_V1,
      'src/db.js': DB_V1,
      'src/pricing.js': PRICING_V1,
      'src/inventory.js': INVENTORY_V1,
      'src/validators/CheckoutValidator.js': VALIDATOR_V1,
      'src/checkout.js': CHECKOUT_V1,
      'test/checkout.test.js': TEST_V1,
    },
  },
  {
    prNumber: 139,
    title: 'feat(pricing): add promo code support',
    body: [
      'Adds promo code support to the pricing engine.',
      '',
      '- PROMO_CODES table with WELCOME10 / BREW20 / RESTOCK5',
      '- unknown or missing codes are ignored rather than rejected, so a typo',
      '  never blocks a checkout',
      '- computePrice now returns discountCents alongside the subtotal',
      '',
      'promoCode is optional on the request body, so no client change is needed.',
    ].join('\n'),
    author: 'raj-patel',
    email: 'raj.patel@firefighter-demo.dev',
    date: '2026-09-11T11:00:00Z',
    headRef: 'feat/promo-codes',
    labels: ['feature', 'pricing'],
    deployedAt: '2026-09-11T11:20:00Z',
    files: {
      'src/pricing.js': PRICING_V2,
      'src/checkout.js': CHECKOUT_V2,
      'test/checkout.test.js': TEST_V2,
    },
  },
  {
    prNumber: 141,
    title: 'chore(inventory): refactor stock lookup',
    body: [
      'Refactors the stock lookup to take a single snapshot of the catalogue per',
      'request instead of one read per line item.',
      '',
      '- duplicate SKUs in a cart are aggregated before the stock comparison',
      '- shortages come back sorted by SKU so responses are stable',
      '',
      'No behaviour change for single-line carts.',
    ].join('\n'),
    author: 'lin-zhao',
    email: 'lin.zhao@firefighter-demo.dev',
    date: '2026-09-12T15:30:00Z',
    headRef: 'chore/inventory-stock-lookup',
    labels: ['chore', 'refactor', 'inventory'],
    deployedAt: '2026-09-12T15:50:00Z',
    files: {
      'src/inventory.js': INVENTORY_V2,
    },
  },
  {
    prNumber: REGRESSION_PR_NUMBER,
    title: 'feat(checkout): enforce country-specific tax rules',
    body: [
      'Enforces country specific tax rules at checkout.',
      '',
      'Finance needs VAT applied for GB / DE / FR and GST for CA. This adds:',
      '',
      '- CheckoutValidator.country(customer), which rejects unsupported destinations',
      '- TAX_RATES in pricing.js and a taxCents line on the response envelope',
      '- handleCheckout passes the customer country through to computePrice',
      '',
      'US stays at 0 at the country level; state level sales tax is still',
      'calculated by the downstream tax service, so existing totals are unchanged.',
    ].join('\n'),
    author: 'sam-okafor',
    email: 'sam.okafor@firefighter-demo.dev',
    date: '2026-09-13T09:12:00Z',
    headRef: 'feat/country-tax-rules',
    labels: ['feature', 'checkout', 'tax'],
    deployedAt: '2026-09-13T09:15:00Z',
    files: {
      'src/validators/CheckoutValidator.js': VALIDATOR_V2,
      'src/pricing.js': PRICING_V3,
      'src/checkout.js': CHECKOUT_V3,
    },
  },
  {
    prNumber: 143,
    title: 'docs: clarify checkout README',
    body: [
      'Documents the checkout request and response envelope so support can read',
      'it without opening the code.',
      '',
      'No functional change - README.md only.',
    ].join('\n'),
    author: 'nina-bloom',
    email: 'nina.bloom@firefighter-demo.dev',
    date: '2026-09-13T09:17:00Z',
    headRef: 'docs/checkout-readme',
    labels: ['docs'],
    deployedAt: '2026-09-13T09:17:30Z',
    files: {
      'README.md': README_V2,
    },
  },
];
