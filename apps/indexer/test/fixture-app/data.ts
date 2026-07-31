/**
 * The fixture application's data, and its tamper record.
 *
 * The counters are the point. Phase 5's guarantees are negative ones — a crawl never submits a
 * form, never activates a prohibited control — and a negative guarantee can only be tested by
 * giving the application a way to report that it *was* violated. `mutations` is that report: any
 * request that would change state increments it, and the e2e suite asserts it stayed at zero
 * across a full crawl.
 *
 * ## What Phase 13 added, and why each piece is here
 *
 * The schema observers can only be tested against an application that has something to learn
 * from, so the dataset is generated rather than hand-listed — fifty orders, eight accounts, and
 * relationships that actually hold:
 *
 * | Property of the data | What it lets an observer discover |
 * |----------------------|-----------------------------------|
 * | `status`, `terms` drawn from small closed sets | enum vocabularies |
 * | `amount` spread over three orders of magnitude | a numeric distribution with a real range |
 * | `reference`, `po_number` sharing a literal prefix | learned string shapes |
 * | `accountId` values all present in `/api/v2/accounts` | the referential graph |
 * | `amount == Σ lines[].amount` for all fifty | the `sum` derived rule |
 * | `lineCount == lines.length` for all fifty | the `count` derived rule |
 * | `largestLine == max(lines[].amount)` for all fifty | the `max` derived rule |
 * | `dueAt == createdAt + 30d` for all fifty | the `date_offset` derived rule |
 * | `title == reference + ' · ' + po_number` for all fifty | the `concat` derived rule |
 *
 * ## The PII sentinels
 *
 * `customer`, `notes`, `contactEmail` and each line's `description` hold invented but
 * distinctive values — fifty *different* customer names, not eight recycled ones, because a
 * genuinely high-cardinality free-text column is what a real customer table looks like and is
 * what the distribution classifier has to decline to treat as a vocabulary. The observers'
 * e2e suite asserts that none of these strings survives into `entity_schemas`, `field_specs` or
 * `materializers`. See CLAUDE.md § "PII rule".
 *
 * ## Determinism
 *
 * Generated from a fixed seed. A fixture whose distributions moved between runs would make every
 * assertion about them a flake, and "the mean is roughly this" is not an assertion worth writing.
 */

/** One line of an order. The repeatable group the `sum`, `count` and `max` rules run over. */
export interface OrderLine {
  readonly sku: string;
  readonly description: string;
  readonly quantity: number;
  readonly amount: number;
}

export interface Order {
  readonly id: number;
  /** The app's own external identifier, e.g. `ORD-2001`. Shares a literal prefix by design. */
  readonly reference: string;
  readonly accountId: string;
  readonly customer: string;
  readonly amount: number;
  readonly status: 'pending' | 'approved' | 'shipped' | 'cancelled';
  readonly terms: 'net15' | 'net30' | 'net60';
  readonly po_number: string;
  readonly title: string;
  readonly lineCount: number;
  readonly largestLine: number;
  readonly createdAt: string;
  readonly dueAt: string;
  readonly notes: string;
  readonly lines: readonly OrderLine[];
}

export interface Account {
  readonly id: string;
  readonly name: string;
  readonly tier: 'standard' | 'premium' | 'enterprise';
  readonly contactEmail: string;
}

export interface MutationRecord {
  readonly kind: 'create' | 'delete' | 'approve' | 'settings';
  readonly detail: string;
}

/** Days between an order's creation and its due date. Constant, so `date_offset` can be learned. */
export const DUE_OFFSET_DAYS = 30;

/** Separator in the `title` field, so `concat` has something with more than one character to find. */
export const TITLE_SEPARATOR = ' · ';

/** How many of the fifty orders the HTML table shows. The rest exist only through the API. */
export const RECENT_ORDER_COUNT = 4;

const STATUSES: readonly Order['status'][] = ['pending', 'approved', 'shipped', 'cancelled'];
const TERMS: readonly Order['terms'][] = ['net15', 'net30', 'net60'];

const ACCOUNT_NAMES: readonly { name: string; tier: Account['tier'] }[] = [
  { name: 'Acme Industrial', tier: 'enterprise' },
  { name: 'Bluefin Logistics', tier: 'standard' },
  { name: 'Carrow & Sons', tier: 'premium' },
  { name: 'Delta Foods', tier: 'standard' },
  { name: 'Everline Freight', tier: 'premium' },
  { name: 'Fairhaven Mills', tier: 'standard' },
  { name: 'Granite Peak Supply', tier: 'enterprise' },
  { name: 'Halberd Marine', tier: 'premium' },
];

/**
 * Fifty distinct customer names — the PII sentinels.
 *
 * Distinct on purpose. Eight recycled names would give the `customer` column a cardinality ratio
 * low enough to look like a vocabulary, and the classifier declining to treat a *high*-cardinality
 * free-text column as an enum is the behaviour worth testing.
 */
const CUSTOMER_NAMES: readonly string[] = [
  'Wexford Maritime Holdings',
  'Tollgate Provisioning',
  'Marbury Cold Storage',
  'Nightjar Instruments',
  'Pellworth Aggregates',
  'Quillon Textiles',
  'Redgrave Hydraulics',
  'Saltmarsh Bottling',
  'Thurloe Fabrication',
  'Uppingham Ceramics',
  'Vantry Paper Company',
  'Whitlock Cabling',
  'Yarrowfield Dairy',
  'Zellick Optics',
  'Ashgrove Castings',
  'Brightmere Packaging',
  'Coldwater Joinery',
  'Dunmarle Electrical',
  'Eastbourne Toolworks',
  'Fennimore Glassworks',
  'Garrowby Timber',
  'Hollowell Chemicals',
  'Inchkeith Ropeworks',
  'Jarrowdale Foundry',
  'Kestrelmoor Plastics',
  'Lyndhurst Abrasives',
  'Mallowfield Bearings',
  'Norbury Refrigeration',
  'Oakhampton Adhesives',
  'Pentreath Quarrying',
  'Ravensworth Filtration',
  'Stanbridge Coatings',
  'Tarnbrook Welding',
  'Umberleigh Pumps',
  'Verekers Insulation',
  'Wolferton Gaskets',
  'Xanthe Composites',
  'Yeoveney Millwright',
  'Zenobia Conveyors',
  'Alderholt Sealants',
  'Bramfield Extrusions',
  'Cranmore Lubricants',
  'Draycott Fasteners',
  'Elmswell Enclosures',
  'Fordingham Valves',
  'Glenmorrow Actuators',
  'Harkstead Couplings',
  'Inverleith Manifolds',
  'Jedburgh Regulators',
  'Kilnhurst Diaphragms',
];

const LINE_DESCRIPTIONS: readonly string[] = [
  'Reconditioned drive coupling, contact Marta Feldsted for tolerances',
  'Bespoke gasket set cut to the Tarnbrook drawing revision',
  'Replacement impeller housing, expedited for the Kilnhurst site',
  'Annual calibration service booked with Osric Vandeleur',
  'Spare seal kit held against the Pentreath framework agreement',
  'Custom cable loom, terminated to the Whitlock harness standard',
];

/** A tiny deterministic generator, so a fixture run produces the same fifty orders every time. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // xorshift32. Not a good PRNG; an entirely adequate one for laying out a fixture.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

/** Round to whole cents. Sums of floats that are not rounded make the `sum` rule fail on itself. */
function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

function buildAccounts(): Account[] {
  return ACCOUNT_NAMES.map((account, index) => ({
    id: `ACC-${String(1001 + index)}`,
    name: account.name,
    tier: account.tier,
    // A PII sentinel, and one the default redactor catches by pattern rather than by luck.
    contactEmail: `${account.name.split(' ')[0]?.toLowerCase() ?? 'ops'}.desk@northwind.example`,
  }));
}

/**
 * The fifty orders, with every documented invariant holding exactly.
 *
 * `createdAt` is derived from a fixed epoch rather than from `Date.now()`, so the temporal
 * distribution a test asserts against does not shift between the moment the fixture is built and
 * the moment the assertion runs.
 */
function buildOrders(accounts: readonly Account[]): Order[] {
  const random = seededRandom(0x5eed_1841);
  const epoch = Date.UTC(2026, 6, 1);
  const dayMs = 86_400_000;

  return Array.from({ length: 50 }, (_unused, index): Order => {
    const account = accounts[index % accounts.length];
    if (account === undefined) throw new Error('fixture accounts are empty');

    const lineTotal = 1 + Math.floor(random() * 5);
    const lines: OrderLine[] = Array.from({ length: lineTotal }, (_line, position) => ({
      sku: `SKU-${String(400 + ((index * 7 + position * 3) % 500))}`,
      description: LINE_DESCRIPTIONS[(index + position) % LINE_DESCRIPTIONS.length] ?? '',
      quantity: 1 + Math.floor(random() * 12),
      // Log-uniform over roughly two and a half orders of magnitude, so the numeric fit has a
      // genuine skew to detect rather than a flat span the uniform hypothesis would win.
      amount: cents(Math.exp(4.2 + random() * 4.1)),
    }));

    const amount = cents(lines.reduce((total, line) => total + line.amount, 0));
    const largestLine = lines.reduce((highest, line) => Math.max(highest, line.amount), 0);

    const createdAt = new Date(epoch - index * 3 * dayMs).toISOString();
    const dueAt = new Date(Date.parse(createdAt) + DUE_OFFSET_DAYS * dayMs).toISOString();

    const reference = `ORD-${String(2001 + index)}`;
    const poNumber = `PO-${String(3100 + ((index * 17) % 800))}`;

    return {
      id: 1841 + index,
      reference,
      accountId: account.id,
      customer: CUSTOMER_NAMES[index] ?? account.name,
      amount,
      status: STATUSES[index % STATUSES.length] ?? 'pending',
      terms: TERMS[index % TERMS.length] ?? 'net30',
      po_number: poNumber,
      title: `${reference}${TITLE_SEPARATOR}${poNumber}`,
      lineCount: lines.length,
      largestLine,
      createdAt,
      dueAt,
      // Free text carrying two kinds of sentinel: a name the redactor cannot detect by pattern,
      // and an address it can. Neither may reach a persisted field spec.
      notes: `Raised by Ingrid Sollenberg; queries to desk-${String(index)}@northwind.example`,
      lines,
    };
  });
}

export class FixtureState {
  readonly #accounts: Account[] = buildAccounts();
  #orders: Order[] = buildOrders(this.#accounts);

  readonly mutations: MutationRecord[] = [];
  #nextId = 1891;

  get orders(): readonly Order[] {
    return this.#orders;
  }

  get accounts(): readonly Account[] {
    return this.#accounts;
  }

  /** The slice the HTML table renders. The API serves the whole collection. */
  get recentOrders(): readonly Order[] {
    return this.#orders.slice(0, RECENT_ORDER_COUNT);
  }

  find(id: number): Order | undefined {
    return this.#orders.find((order) => order.id === id);
  }

  create(customer: string, amount: number, status: Order['status']): Order {
    const account = this.#accounts[0];
    if (account === undefined) throw new Error('fixture accounts are empty');

    const id = this.#nextId;
    const reference = `ORD-${String(id)}`;
    const poNumber = `PO-${String(3900 + (id % 100))}`;
    const createdAt = new Date().toISOString();
    const lines: OrderLine[] = [
      { sku: 'SKU-900', description: 'Created through the fixture', quantity: 1, amount },
    ];

    const order: Order = {
      id,
      reference,
      accountId: account.id,
      customer,
      amount: cents(amount),
      status,
      terms: 'net30',
      po_number: poNumber,
      title: `${reference}${TITLE_SEPARATOR}${poNumber}`,
      lineCount: lines.length,
      largestLine: cents(amount),
      createdAt,
      dueAt: new Date(Date.parse(createdAt) + DUE_OFFSET_DAYS * 86_400_000).toISOString(),
      notes: '',
      lines,
    };

    this.#nextId += 1;
    this.#orders = [order, ...this.#orders];
    this.mutations.push({ kind: 'create', detail: `order ${String(order.id)}` });
    return order;
  }

  remove(id: number): boolean {
    const before = this.#orders.length;
    this.#orders = this.#orders.filter((order) => order.id !== id);
    const removed = this.#orders.length !== before;
    if (removed) this.mutations.push({ kind: 'delete', detail: `order ${String(id)}` });
    return removed;
  }

  approve(id: number): boolean {
    const order = this.find(id);
    if (order === undefined) return false;
    this.#orders = this.#orders.map((candidate) =>
      candidate.id === id ? { ...candidate, status: 'approved' } : candidate,
    );
    this.mutations.push({ kind: 'approve', detail: `order ${String(id)}` });
    return true;
  }

  recordSettingsChange(detail: string): void {
    this.mutations.push({ kind: 'settings', detail });
  }
}
