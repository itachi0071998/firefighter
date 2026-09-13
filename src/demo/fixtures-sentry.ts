/**
 * Demo fixtures whose file layout mirrors a REAL Sentry project.
 *
 * The stack traces this service produces are the ones Firefighter investigates
 * when INCIDENT_SOURCE=sentry, so the paths and line numbers here must match
 * what Sentry reports:
 *
 *   src/checkout/checkout.validator.ts:16  CheckoutValidator.validateCheckout
 *   src/checkout/checkout.service.ts:24    CheckoutService.createOrder
 *
 * Those two line numbers are load-bearing. Seeding asserts them, so an edit that
 * shifts them fails loudly instead of silently breaking the investigation.
 *
 * PR #211 ships BOTH the country rule and the test that covers it, so reverting
 * it removes the feature and its test together and the revert branch stays green.
 */
import type { DemoCommitSpec } from './fixtures.ts';

export const SENTRY_REGRESSION_PR = 211;

/** The frames Sentry reports, asserted after seeding. */
export const SENTRY_ANCHORS = [
  { path: 'src/checkout/checkout.validator.ts', line: 16, contains: '.toUpperCase()' },
  { path: 'src/checkout/checkout.service.ts', line: 24, contains: 'validateCheckout(request)' },
] as const;

export const SENTRY_DEMO_COMMITS: DemoCommitSpec[] = [
  {
    prNumber: 201,
    title: `chore: bootstrap checkout service`,
    body: `Initial checkout service: validation, pricing, inventory and the order flow.`,
    author: `dana-ruiz`,
    email: `dana@example.com`,
    date: `2026-09-13T12:00:00Z`,
    files: {
      "package.json": `{
  "name": "checkout-service",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "description": "Checkout service for the Firefighter demo storefront.",
  "scripts": {
    "test": "node --test"
  }
}
`,
      "README.md": `# checkout-service

Checkout API for the Firefighter demo storefront.

- \`src/checkout/checkout.service.ts\` orchestrates a checkout
- \`src/checkout/checkout.validator.ts\` validates the incoming request
- \`src/checkout/pricing.ts\` totals the cart
- \`src/checkout/inventory.ts\` reserves stock

Run the tests with \`npm test\`.
`,
      ".gitignore": `.firefighter-meta.json
.firefighter-prs.json
node_modules/
`,
      "src/checkout/checkout.types.ts": `/** Shared checkout types. */

export interface CheckoutItem {
  sku: string;
  qty: number;
  unitPrice: number;
}

export interface Customer {
  id: string | null;
  email: string;
  /** Destination country. Guests may not supply one. */
  country: string | null;
}

export interface Payment {
  type: string;
  token: string;
}

export interface CheckoutRequest {
  customer: Customer;
  items: CheckoutItem[];
  payment: Payment;
  promoCode?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface Order {
  status: number;
  errors: string[];
  total: number;
  currency: string;
}
`,
      "src/checkout/checkout.validator.ts": `import type { CheckoutRequest, ValidationResult } from './checkout.types.ts';

/** Validates an incoming checkout request before an order is created. */
export class CheckoutValidator {
  /**
   * @param request incoming checkout payload
   * @returns validation outcome with any field errors
   */
  validateCheckout(request: CheckoutRequest): ValidationResult {
    const errors: string[] = [];

    if (!request.items || request.items.length === 0) {
      errors.push('items: cart is empty');
    }
    if (!request.payment || !request.payment.token) {
      errors.push('payment: token is required');
    }

    return { ok: errors.length === 0, errors };
  }
}
`,
      "src/checkout/checkout.service.ts": `import { CheckoutValidator } from './checkout.validator.ts';
import type { CheckoutRequest, Order } from './checkout.types.ts';
import { priceItems } from './pricing.ts';
import { reserveStock } from './inventory.ts';

/** Orchestrates a checkout: validate, price, reserve stock, create the order. */
export class CheckoutService {
  readonly validator = new CheckoutValidator();

  /**
   * Create an order from a checkout request.
   *
   * Validation failures come back to the caller as a 400. Anything the
   * validator throws is allowed to propagate: an unexpected error must never
   * be turned into a successful checkout.
   *
   * @param request incoming checkout payload
   * @returns the created order, or a validation failure
   */
  createOrder(request: CheckoutRequest): Order {
    if (!request) {
      throw new Error('checkout request is required');
    }
    const validation = this.validator.validateCheckout(request);
    if (!validation.ok) {
      return { status: 400, errors: validation.errors, total: 0, currency: 'USD' };
    }

    const total = priceItems(request.items, request.promoCode);
    reserveStock(request.items);

    return { status: 201, errors: [], total, currency: 'USD' };
  }
}
`,
      "src/checkout/pricing.ts": `import type { CheckoutItem } from './checkout.types.ts';

/**
 * Total the cart.
 *
 * @param items line items
 * @returns total in minor units
 */
export function priceItems(items: CheckoutItem[]): number {
  return items.reduce((sum, item) => sum + item.unitPrice * item.qty, 0);
}
`,
      "src/checkout/inventory.ts": `import type { CheckoutItem } from './checkout.types.ts';

const STOCK: Record<string, number> = { 'SKU-1': 12, 'SKU-2': 3, 'SKU-3': 0 };

/**
 * Reserve stock for each line item.
 *
 * @param items line items
 * @returns true when every item could be reserved
 */
export function reserveStock(items: CheckoutItem[]): boolean {
  for (const item of items) {
    if ((STOCK[item.sku] ?? 0) < item.qty) return false;
  }
  return true;
}
`,
      "test/checkout.test.ts": `import test from 'node:test';
import assert from 'node:assert/strict';
import { CheckoutService } from '../src/checkout/checkout.service.ts';

const service = new CheckoutService();

function registeredRequest(overrides = {}) {
  return {
    customer: { id: 'cus_1', email: 'a@example.com', country: 'US' },
    items: [{ sku: 'SKU-1', qty: 2, unitPrice: 1500 }],
    payment: { type: 'card', token: 'tok_visa' },
    ...overrides,
  };
}

test('a registered customer can check out', () => {
  const order = service.createOrder(registeredRequest());
  assert.equal(order.status, 201);
  assert.equal(order.total, 3000);
});

test('an empty cart is rejected', () => {
  const order = service.createOrder(registeredRequest({ items: [] }));
  assert.equal(order.status, 400);
  assert.ok(order.errors.some((e) => e.includes('items')));
});

test('a missing payment token is rejected', () => {
  const order = service.createOrder(registeredRequest({ payment: { type: 'card', token: '' } }));
  assert.equal(order.status, 400);
  assert.ok(order.errors.some((e) => e.includes('payment')));
});

test('a promo code discounts the total', () => {
  const order = service.createOrder(registeredRequest({ promoCode: 'WELCOME10' }));
  assert.equal(order.status, 201);
  assert.equal(order.total, 2700);
});

test('an unknown promo code is ignored', () => {
  const order = service.createOrder(registeredRequest({ promoCode: 'NOPE' }));
  assert.equal(order.status, 201);
  assert.equal(order.total, 3000);
});
`,
    },
    labels: [`service`],
  },
  {
    prNumber: 205,
    title: `feat(pricing): add promo code support`,
    body: `Adds promo codes with a percentage discount applied to the cart subtotal.`,
    author: `sam-okafor`,
    email: `sam@example.com`,
    date: `2026-09-13T14:00:00Z`,
    files: {
      "src/checkout/pricing.ts": `import type { CheckoutItem } from './checkout.types.ts';

interface Promo {
  percentOff: number;
}

const PROMOS: Record<string, Promo> = {
  WELCOME10: { percentOff: 10 },
  SUMMER20: { percentOff: 20 },
};

/**
 * Total the cart, applying a promo code when one is supplied and recognised.
 *
 * @param items line items
 * @param promoCode optional promo code
 * @returns total in minor units
 */
export function priceItems(items: CheckoutItem[], promoCode?: string): number {
  const subtotal = items.reduce((sum, item) => sum + item.unitPrice * item.qty, 0);
  if (!promoCode) return subtotal;
  const promo = PROMOS[promoCode];
  if (!promo) return subtotal;
  return Math.round(subtotal * (1 - promo.percentOff / 100));
}
`,
    },
    labels: [`feature`],
    deployedAt: `2026-09-13T14:20:00Z`,
  },
  {
    prNumber: 208,
    title: `chore(inventory): refactor stock lookup`,
    body: `Extracts availableFor() and simplifies reserveStock. No behaviour change.`,
    author: `lee-tran`,
    email: `lee@example.com`,
    date: `2026-09-13T16:00:00Z`,
    files: {
      "src/checkout/inventory.ts": `import type { CheckoutItem } from './checkout.types.ts';

const STOCK: Record<string, number> = { 'SKU-1': 12, 'SKU-2': 3, 'SKU-3': 0 };

/** Stock available for one SKU. */
export function availableFor(sku: string): number {
  return STOCK[sku] ?? 0;
}

/**
 * Reserve stock for each line item.
 *
 * @param items line items
 * @returns true when every item could be reserved
 */
export function reserveStock(items: CheckoutItem[]): boolean {
  return items.every((item) => availableFor(item.sku) >= item.qty);
}
`,
    },
    labels: [`chore`],
    deployedAt: `2026-09-13T16:20:00Z`,
  },
  {
    prNumber: 211,
    title: `feat(checkout): enforce country-specific tax rules`,
    body: `Checkout must apply the destination country tax rate, so the validator now resolves and checks the country on every request.`,
    author: `sam-okafor`,
    email: `sam@example.com`,
    date: `2026-09-13T18:40:00Z`,
    files: {
      "src/checkout/checkout.validator.ts": `import type { CheckoutRequest, ValidationResult } from './checkout.types.ts';

/** Destinations the checkout flow can currently tax correctly. */
const SUPPORTED_COUNTRIES = ['US', 'GB', 'DE', 'FR', 'IN'];

/** Validates an incoming checkout request before an order is created. */
export class CheckoutValidator {
  /**
   * @param request incoming checkout payload
   * @returns validation outcome with any field errors
   */
  validateCheckout(request: CheckoutRequest): ValidationResult {
    const errors: string[] = [];

    // Tax rules are country specific, so the destination decides the rate.
    const code = request.customer.country.toUpperCase();

    if (!SUPPORTED_COUNTRIES.includes(code)) {
      errors.push('country: ' + code + ' is not a supported destination');
    }
    if (!request.items || request.items.length === 0) {
      errors.push('items: cart is empty');
    }
    if (!request.payment || !request.payment.token) {
      errors.push('payment: token is required');
    }

    return { ok: errors.length === 0, errors };
  }
}
`,
      "test/checkout.test.ts": `import test from 'node:test';
import assert from 'node:assert/strict';
import { CheckoutService } from '../src/checkout/checkout.service.ts';

const service = new CheckoutService();

function registeredRequest(overrides = {}) {
  return {
    customer: { id: 'cus_1', email: 'a@example.com', country: 'US' },
    items: [{ sku: 'SKU-1', qty: 2, unitPrice: 1500 }],
    payment: { type: 'card', token: 'tok_visa' },
    ...overrides,
  };
}

test('a registered customer can check out', () => {
  const order = service.createOrder(registeredRequest());
  assert.equal(order.status, 201);
  assert.equal(order.total, 3000);
});

test('an empty cart is rejected', () => {
  const order = service.createOrder(registeredRequest({ items: [] }));
  assert.equal(order.status, 400);
  assert.ok(order.errors.some((e) => e.includes('items')));
});

test('a missing payment token is rejected', () => {
  const order = service.createOrder(registeredRequest({ payment: { type: 'card', token: '' } }));
  assert.equal(order.status, 400);
  assert.ok(order.errors.some((e) => e.includes('payment')));
});

test('a promo code discounts the total', () => {
  const order = service.createOrder(registeredRequest({ promoCode: 'WELCOME10' }));
  assert.equal(order.status, 201);
  assert.equal(order.total, 2700);
});

test('an unknown promo code is ignored', () => {
  const order = service.createOrder(registeredRequest({ promoCode: 'NOPE' }));
  assert.equal(order.status, 201);
  assert.equal(order.total, 3000);
});

test('an unsupported country is rejected', () => {
  const order = service.createOrder(
    registeredRequest({ customer: { id: 'cus_2', email: 'b@example.com', country: 'ZZ' } }),
  );
  assert.equal(order.status, 400);
  assert.ok(order.errors.some((e) => e.includes('country')));
});
`,
    },
    labels: [`feature`],
    deployedAt: `2026-09-13T18:45:00Z`,
  },
  {
    prNumber: 213,
    title: `docs: clarify checkout flow`,
    body: `Documents the checkout sequence and guest checkout.`,
    author: `dana-ruiz`,
    email: `dana@example.com`,
    date: `2026-09-13T18:49:00Z`,
    files: {
      "README.md": `# checkout-service

Checkout API for the Firefighter demo storefront.

- \`src/checkout/checkout.service.ts\` orchestrates a checkout
- \`src/checkout/checkout.validator.ts\` validates the incoming request
- \`src/checkout/pricing.ts\` totals the cart
- \`src/checkout/inventory.ts\` reserves stock

Run the tests with \`npm test\`.

## Checkout flow

1. \`CheckoutService.createOrder\` receives the request.
2. \`CheckoutValidator.validateCheckout\` checks the customer, items and payment.
3. Valid requests are priced and have stock reserved, then a \`201\` is returned.
4. Invalid requests return a \`400\` listing the offending fields.

Guest checkout is supported: a guest has no customer id.
`,
    },
    labels: [`docs`],
    deployedAt: `2026-09-13T18:50:00Z`,
  },
];
