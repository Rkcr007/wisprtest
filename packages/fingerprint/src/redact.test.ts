import { describe, expect, it } from 'vitest';

import { defaultRedactor, normalizeWhitespace } from './redact.js';

describe('normalizeWhitespace', () => {
  it('collapses runs and trims, so a layout change does not read as a rename', () => {
    expect(normalizeWhitespace('  Approve \n\t order  ')).toBe('Approve order');
  });
});

describe('defaultRedactor — emails', () => {
  it.each([
    ['priya.sharma@acme-industrial.co.uk', '[email]'],
    ['Owner: j.doe+orders@example.com', 'Owner: [email]'],
    ['a@b.io and c@d.org', '[email] and [email]'],
  ])('masks %j', (input, expected) => {
    expect(defaultRedactor(input)).toBe(expected);
  });

  it('leaves an @-mention that is not an address alone', () => {
    expect(defaultRedactor('Assigned to @priya')).toBe('Assigned to @priya');
  });
});

describe('defaultRedactor — currency', () => {
  it.each([
    ['$46,200.00', '[amount]'],
    ['Total £99.50', 'Total [amount]'],
    ['€1.234,56', '[amount]'],
    ['USD 42', '[amount]'],
    ['₹1,20,000', '[amount]'],
    ['1 200 kr', '[amount]'],
  ])('masks %j', (input, expected) => {
    expect(defaultRedactor(input)).toBe(expected);
  });

  it('masks the whole amount rather than leaving the decimals behind', () => {
    // The ordering bug this guards against: a bare digit-run rule running first turns
    // `$1,200.00` into `$[number].00`, which leaks the magnitude and the precision.
    const redacted = defaultRedactor('Approve $1,200.00');
    expect(redacted).toBe('Approve [amount]');
    expect(redacted).not.toMatch(/\d/);
  });
});

describe('defaultRedactor — phone numbers', () => {
  it.each([
    ['+44 20 7946 0958', '[phone]'],
    ['(555) 123-4567', '[phone]'],
    ['555.123.4567', '[phone]'],
    ['Call 020 7946 0958 now', 'Call [phone] now'],
  ])('masks %j', (input, expected) => {
    expect(defaultRedactor(input)).toBe(expected);
  });
});

describe('defaultRedactor — digit runs', () => {
  it('masks a long run that is not currency or a phone number', () => {
    expect(defaultRedactor('Order 48291057')).toBe('Order [phone]');
  });

  it('leaves short numbers alone, because they are structure not data', () => {
    // "three line items" and "Page 2" have to survive: they are how a tester refers to a
    // control, and masking them would collapse distinct elements onto the same name.
    expect(defaultRedactor('Page 2')).toBe('Page 2');
    expect(defaultRedactor('3 line items')).toBe('3 line items');
    expect(defaultRedactor('Q4 2026')).toBe('Q4 2026');
  });

  it('masks a bare 5-digit run', () => {
    expect(defaultRedactor('ZIP 90210')).toBe('ZIP [number]');
  });
});

describe('defaultRedactor — the properties that make redaction usable as a signal', () => {
  it('is idempotent, so a name can be redacted twice without degrading', () => {
    const once = defaultRedactor('Invoice for priya@acme.com totalling $4,200');
    expect(defaultRedactor(once)).toBe(once);
  });

  it('is deterministic, which is what lets the indexer and the extension agree', () => {
    const input = 'Contact billing@acme.com or +44 20 7946 0958';
    expect(defaultRedactor(input)).toBe(defaultRedactor(input));
  });

  it('preserves shape, so two names that differ only in PII still compare equal', () => {
    expect(defaultRedactor('Invoice for priya@acme.com')).toBe(
      defaultRedactor('Invoice for daniel@northwind.co'),
    );
  });

  it('preserves shape, so two structurally different names still compare different', () => {
    expect(defaultRedactor('Invoice for priya@acme.com')).not.toBe(
      defaultRedactor('Credit note for priya@acme.com'),
    );
  });

  it('leaves a name with no PII untouched apart from whitespace', () => {
    expect(defaultRedactor('  Pending  approval ')).toBe('Pending approval');
  });

  it('handles the empty string', () => {
    expect(defaultRedactor('')).toBe('');
  });
});
