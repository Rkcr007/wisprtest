# WisprTest — Test Data Engine

The differentiated part of the product, and the part most likely to be built wrong.

A manual tester cannot test "approve a high-value pending order" until a high-value
pending order exists. Today that means leaving the flow, navigating a create form,
filling eight fields, and coming back — by which point they have lost their place.
WisprTest removes that detour: the tester asks for the precondition out loud and keeps
working.

---

## 1. The line that governs everything

The engine must work for **any** customer application without a line of app-specific
code. That is only possible if you are ruthless about which side of this line each
piece falls on.

### Generic — written once, in the product

| Component | Responsibility |
|-----------|----------------|
| `SchemaObserver` | Watch forms and network traffic during indexing; emit candidate entity shapes |
| `SchemaInference` | Consolidate observations into `EntitySchema` + `FieldSpec` with confidence |
| `ConstraintParser` | Utterance → typed `ConstraintSet` |
| `ConstraintSolver` | Satisfy the constraint set against the schema |
| `ValueSampler` | Draw plausible values from learned per-field distributions |
| `ProvenanceBuilder` | Explain every generated field |
| `MaterializerRegistry` | Interface + fallback chain for actually writing the record |
| `SeedLedger` | Record what was created, how, and how to undo it |

### Per-application — learned at index time, stored in memory, never hardcoded

| Artifact | Example |
|----------|---------|
| Entity schemas | `Order` has 9 fields |
| Field types + requiredness | `amount: currency, required` |
| Enum vocabularies | `status ∈ {Draft, Pending approval, Approved, Rejected}` |
| Value distributions | order amounts are log-normal, μ≈$32k, observed range $800–$240k |
| Referential graph | `Order.account → Account.id` |
| Derived-field rules | `amount = Σ line_items.amount` |
| Predicate definitions | "overdue" ⇒ `due_date < now() AND status ≠ Paid` |
| Materializers | `POST /api/v2/orders`, or the `orders.create` form, or a fixture endpoint |
| Environment policy | seeding allowed in staging, forbidden in production |

> **If you write `if (app === '...')` anywhere in this engine, the design is wrong.**
> That value belongs in `entity_schemas` / `field_specs` / `materializers`, loaded at runtime.

---

## 2. Where the per-app knowledge comes from

Three observation channels during indexing. All generic code; all output is per-app data.

### 2.1 Form observation

For each route, extract every `<form>` and form-like region. Per control capture:
label (accessible name), input type, `required`, `pattern`, `min`/`max`/`maxlength`,
`<select>` options, and the field's fingerprint. This yields the **shape** of an entity
and the UI path to create one.

```
/orders/new  →  EntitySchema "Order"
                fields: account(select→ref), line_items(repeatable group),
                        po_number(text,16), terms(select,3), notes(textarea)
                materializer: { kind: "ui", form: "orders.create", route: "/orders/new" }
```

### 2.2 Network observation

While crawling, record request/response pairs. A `POST` whose payload keys align with an
observed form yields an **API materializer** — far faster and more reliable than driving
the UI. `GET` list responses yield **value distributions** and **enum vocabularies** for
free, from real data.

```
POST /api/v2/orders  { accountId, lines[], poNumber, terms }
  → materializer { kind:"api", method:"POST", path:"/api/v2/orders",
                   payloadTemplate: {...}, auth:"session" }

GET /api/v2/orders?limit=100
  → 128 records → status enum, amount distribution, ownership distribution,
                  account reference cardinality
```

Response bodies are scanned for entity relationships (`accountId` in an Order payload
that matches an `id` in the Account collection) to build the **referential graph**.

### 2.3 Derived-rule inference

Given observed records, test simple arithmetic and temporal hypotheses:
`amount == Σ(line_items.amount)` held for 128/128 records → record it as a derived rule
with confidence 1.0. `due_date < created_at` never held → not a rule.

Keep the hypothesis space small and explicit — sum, count, min/max, date offset,
concatenation. This is not a general program synthesiser and must not become one.

**Everything above is stored against a `memory_version`.** When the app changes, drift
reconciliation re-runs these observers on the changed region only.

---

## 3. Composition pipeline

```
utterance: "I need a pending order for Acme Industrial with three line items"
   │
   ▼
[1] ConstraintParser        (generic)
    entity: Order
    constraints:
      status  = "Pending approval"      (enum match, conf 0.96)
      account ≈ "Acme Industrial"       (ref resolve, conf 0.99)
      |line_items| = 3                  (cardinality)
   │
   ▼
[2] SchemaLoad              (per-app data)
    EntitySchema(Order) @ memory_version 18 — 9 fields, 3 required unspecified
   │
   ▼
[3] ConstraintSolver        (generic)
    - satisfy explicit constraints
    - resolve references against real records (Acme Industrial exists → use its id)
    - fill required-but-unspecified from ValueSampler
    - evaluate derived rules last (amount = Σ lines = $46,200)
    - check predicate constraints ("overdue" ⇒ back-date due_date)
   │
   ▼
[4] ProvenanceBuilder       (generic)
    per field: value + why + confidence
   │
   ▼
CompositionPlan  ──►  PREVIEW TO HUMAN  ──►  approval  ──►  Materialize
```

### ConstraintParser output

```ts
type Constraint =
  | { kind: 'equals';      field: string; value: unknown }
  | { kind: 'reference';   field: string; phrase: string }        // "for Acme Industrial"
  | { kind: 'cardinality'; field: string; count: number }         // "three line items"
  | { kind: 'comparison';  field: string; op: '>'|'<'|'>='|'<='; value: number }
  | { kind: 'predicate';   name: string };                        // "overdue", "expired"

type ConstraintSet = { entity: string; constraints: Constraint[]; confidence: number };
```

Parsing runs T0/T1 first against learned enum vocabularies and field names. Only novel
phrasing escalates to T2 — and, as everywhere else, a successful T2 parse writes back an
alias so the phrasing is T0 next time.

### Predicates are the interesting case

"Give me a customer with an overdue invoice" is not a field assignment. `overdue` is a
**predicate over fields**, and it spans **two entities**. The solver must:

1. Recognise `overdue` as a learned predicate on `Invoice`:
   `due_date < now() AND status ≠ 'Paid'`
2. See that the utterance's head noun is `customer` → `Account`
3. Walk the referential graph: `Invoice.account → Account`
4. Produce a **composition graph**, not a single record:
   `Account(new) ← Invoice(new, due_date = now() − 22d, status = 'Overdue')`
5. Order materialization by dependency — Account first, then Invoice with the returned id

Predicates are learned during indexing wherever a UI surfaces a named status derived from
field values (a badge reading "Overdue" on rows where `due_date < today`). Where inference
is uncertain, the console lets a QA lead define predicates by hand — a small, high-value
configuration surface.

**The output is a DAG of records, not one record.** Build for that from the start;
retrofitting multi-entity composition later is a rewrite.

### Value sampling

Never `faker` defaults. Sample from **this application's observed distribution** so
seeded data is indistinguishable from real data and does not break downstream validation.

- Numeric → fit to observed distribution, draw within observed range
- Enum → sample by observed frequency unless constrained
- String → learned pattern (prefix, length, charset) from observed values
- Reference → prefer an existing real record; create only if the utterance demands novelty
- Date → relative to `now()`, offset chosen to satisfy any predicate
- Uniqueness → check for collision against observed values before returning

### Provenance — non-negotiable

Every field in the plan carries an explanation. This is what the preview card renders,
and it is what makes the feature trustworthy rather than spooky.

```ts
type ProvenanceEntry = {
  field: string;
  value: unknown;
  source: 'requested' | 'reference_matched' | 'sampled' | 'derived'
        | 'predicate_solved' | 'default';
  explanation: string;   // "matched from 64 known accounts"
  confidence: number;
};
```

---

## 4. Materialization — three adapters, one fallback chain

The plan describes *what* to create. Adapters decide *how*. Each `EntitySchema` may have
several materializers with a priority order.

### Adapter 1 — API (priority 1)

Replay the observed create request with the composed payload.

- **Pros:** 100–400 ms, no UI dependency, no flake
- **Cons:** bypasses client-side validation; breaks when the API changes
- **Verification:** issue the observed read-back request and assert the record exists
- **Auth:** reuse the tester's live session (cookie/bearer from the attached tab).
  WisprTest never stores app credentials.

### Adapter 2 — UI (priority 2)

Drive the real create form in a background context (offscreen tab or Playwright worker on
the indexer), using the same fingerprint resolver as the runtime.

- **Pros:** always available, exercises real validation, survives API changes
- **Cons:** 3–15 s, subject to UI drift
- **Verification:** post-submit assertion on the resulting detail route

Reusing the resolver here is why the fingerprint package must be shared — the UI adapter
is the runtime executor pointed at a form.

### Adapter 3 — Fixture (priority 0 when configured)

Customer-provided seeding endpoint, factory, or SQL. Configured per application in the
console.

- **Pros:** fastest, most reliable, explicitly sanctioned by the customer's platform team
- **Cons:** requires customer engineering effort
- **Enterprise note:** this is the adapter security review will ask for. Support it well.

### Fallback chain

```
fixture (if configured & verified)
   ↓ fail
api (if observed & verified within TTL)
   ↓ fail
ui (always available if the form was indexed)
   ↓ fail
surface the failure with the concrete reason and offer the manual path
```

Never silently degrade without telling the tester which adapter ran — it changes what the
test actually covered. If the API adapter created the record, client-side validation was
never exercised, and the tester needs to know that.

```ts
interface Materializer {
  readonly kind: 'api' | 'ui' | 'fixture';
  canHandle(plan: CompositionPlan): boolean;
  materialize(plan: CompositionPlan, ctx: SeedContext): Promise<MaterializationResult>;
  verify(result: MaterializationResult): Promise<boolean>;
  inverse(result: MaterializationResult): InverseOperation | null;
}
```

---

## 5. Reversibility — the adoption gate

Testers will not adopt a tool that quietly fills staging with garbage. Every seeded
record gets a ledger entry with an inverse operation.

```ts
type SeedLedgerEntry = {
  id: string; tenantId: string; sessionId: string;
  entity: string; externalRef: string;         // "ORD-4903"
  adapterUsed: 'api' | 'ui' | 'fixture';
  payload: unknown; provenance: ProvenanceEntry[];
  inverseOp: InverseOperation | null;
  createdAt: string; revertedAt: string | null;
};

type InverseOperation =
  | { kind: 'api';     method: 'DELETE'; path: string }
  | { kind: 'ui';      flow: string }                    // indexed delete flow
  | { kind: 'fixture'; command: string }
  | { kind: 'none';    reason: string };                 // no delete path exists
```

Revert scopes: single record, whole session, everything seeded in an environment.
Multi-entity graphs revert in **reverse dependency order**.

When `inverseOp` is `none`, say so in the preview **before** creating. A tester deciding
whether to seed a record that cannot be removed deserves to know that up front.

---

## 6. Human-in-the-loop

Seeding is action class **S**. It is never speculative and never silent.

1. Compose the plan (no writes)
2. Render the preview: entity, field values, provenance per field, record count, adapter
   that will run, and whether it can be reverted
3. Wait for explicit approval ("yes", click, keypress)
4. Materialize, verify, write the ledger entry
5. Show the created record with a distinct visual treatment in the app under test

Auto-seeding without preview is a supportable future preference for trusted flows —
but the default is, and stays, approval.

---

## 7. Failure modes to design against

| Failure | Mitigation |
|---------|-----------|
| Schema confidence too low to compose | Refuse with the specific missing field; offer to index the create form |
| Reference target does not exist | Offer to create it as part of the graph, or ask which existing record to use |
| Unsatisfiable constraints | Report the conflict in plain language; never silently drop a constraint |
| API adapter 4xx on replay | Fall back to UI; mark the API materializer unverified; enqueue re-observation |
| Uniqueness collision | Resample with an incrementing discriminator, bounded retries |
| Production environment | Blocked by policy unless explicitly and auditably enabled |
| Seeded data breaks a later assertion | Ledger + session timeline make provenance auditable after the fact |

---

## 8. What to build in what order

Do not build this engine before the runtime works. Sequence:

1. `SchemaObserver` in the indexer — forms only. Persist `EntitySchema` + `FieldSpec`.
2. Network observation → distributions, enums, API materializer candidates.
3. `ConstraintParser` — equals / reference / cardinality only. No predicates yet.
4. `ConstraintSolver` + `ValueSampler` + `ProvenanceBuilder` → single-entity plan.
5. Preview UI + approval + **UI adapter** (always available, proves the loop end to end).
6. Ledger + revert.
7. API adapter + verification + fallback chain.
8. Predicates and multi-entity composition graphs.
9. Derived-rule inference.
10. Fixture adapter + console configuration.

Steps 1–6 are a shippable feature. Steps 7–10 are what make it fast and general.
Resist the urge to start at 8.
