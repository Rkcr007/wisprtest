/**
 * The fixture application's data, and its tamper record.
 *
 * The counters are the point. Phase 5's guarantees are negative ones — a crawl never submits a
 * form, never activates a prohibited control — and a negative guarantee can only be tested by
 * giving the application a way to report that it *was* violated. `mutations` is that report: any
 * request that would change state increments it, and the e2e suite asserts it stayed at zero
 * across a full crawl.
 */

export interface Order {
  readonly id: number;
  readonly customer: string;
  readonly amount: number;
  readonly status: 'pending' | 'approved' | 'shipped';
  readonly lines: number;
}

export interface MutationRecord {
  readonly kind: 'create' | 'delete' | 'approve' | 'settings';
  readonly detail: string;
}

export class FixtureState {
  #orders: Order[] = [
    { id: 1841, customer: 'Acme Industrial', amount: 4210.5, status: 'pending', lines: 3 },
    { id: 1842, customer: 'Bluefin Logistics', amount: 199.0, status: 'approved', lines: 1 },
    { id: 1843, customer: 'Carrow & Sons', amount: 88_400.25, status: 'shipped', lines: 12 },
    { id: 1844, customer: 'Delta Foods', amount: 1250.0, status: 'pending', lines: 5 },
  ];

  readonly mutations: MutationRecord[] = [];
  #nextId = 1845;

  get orders(): readonly Order[] {
    return this.#orders;
  }

  find(id: number): Order | undefined {
    return this.#orders.find((order) => order.id === id);
  }

  create(customer: string, amount: number, status: Order['status']): Order {
    const order: Order = { id: this.#nextId, customer, amount, status, lines: 1 };
    this.#nextId += 1;
    this.#orders = [...this.#orders, order];
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
