import { describe, expect, it } from 'vitest';

import {
  initialCrawlForm,
  issuesFromGateway,
  lines,
  parseCrawlForm,
  type CrawlFormValues,
} from './form';

/**
 * The Connect form's validation, which is the console's half of a safety property.
 *
 * `apps/gateway/src/routes/crawl.ts` refuses a crawl whose bounds are incomplete, and it refuses
 * it because a crawl that can go anywhere and click anything is a crawl that can delete a
 * customer's data. This form is where those bounds are decided, so the tests that matter most
 * here are the negative ones: that nothing gets past `parseCrawlForm` without a blast radius
 * somebody chose.
 */

const APPLICATION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/** A form a tester has filled in completely. Every test below starts from this and breaks one thing. */
const filled: CrawlFormValues = {
  ...initialCrawlForm,
  applicationId: APPLICATION_ID,
  allowedOrigins: 'https://app.example.com',
  routeAllowlist: '/orders\n/settings',
  maxDepth: '3',
  maxPages: '50',
  neverInteractSelectors: 'button[data-action="delete"]',
};

describe('lines', () => {
  it('trims, drops blanks, and keeps one entry per line', () => {
    expect(lines('  /orders \n\n /settings\n   \n')).toEqual(['/orders', '/settings']);
  });

  it('reads an empty textarea as no entries rather than as one empty entry', () => {
    expect(lines('')).toEqual([]);
    expect(lines('   \n  \n')).toEqual([]);
  });
});

describe('parseCrawlForm — the bounds are required', () => {
  it('refuses the initial form, naming every bound that decides blast radius', () => {
    const result = parseCrawlForm(initialCrawlForm);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    // The four bounds that decide where the crawl may go and how much of it it may take.
    expect(result.issues.allowedOrigins).toBeDefined();
    expect(result.issues.routeAllowlist).toBeDefined();
    expect(result.issues.maxDepth).toBeDefined();
    expect(result.issues.maxPages).toBeDefined();
    // Plus the never-interact decision, and the application itself.
    expect(result.issues.neverInteractSelectors).toBeDefined();
    expect(result.issues.applicationId).toBeDefined();
  });

  it('ships no defaults for the four blast-radius bounds', () => {
    // If any of these ever gains a pre-filled value, the refusal above becomes decorative: the
    // bound would be WisprTest's decision wearing the tester's name.
    expect(initialCrawlForm.allowedOrigins).toBe('');
    expect(initialCrawlForm.routeAllowlist).toBe('');
    expect(initialCrawlForm.maxDepth).toBe('');
    expect(initialCrawlForm.maxPages).toBe('');
  });

  it.each([
    ['allowedOrigins', { allowedOrigins: '' }],
    ['routeAllowlist', { routeAllowlist: '' }],
    ['maxDepth', { maxDepth: '' }],
    ['maxPages', { maxPages: '' }],
  ] as const)('refuses an otherwise complete form with no %s', (field, override) => {
    const result = parseCrawlForm({ ...filled, ...override });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[field]).toBeDefined();
  });

  it('accepts a fully bounded form and produces a contract-valid request', () => {
    const result = parseCrawlForm(filled);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.applicationId).toBe(APPLICATION_ID);
    expect(result.request.bounds.allowedOrigins).toEqual(['https://app.example.com']);
    expect(result.request.bounds.routeAllowlist).toEqual(['/orders', '/settings']);
    expect(result.request.bounds.maxDepth).toBe(3);
    expect(result.request.bounds.maxPages).toBe(50);
    expect(result.request.bounds.neverInteractSelectors).toEqual(['button[data-action="delete"]']);
    expect(result.request.bounds.viewport).toEqual({ width: 1440, height: 900 });
    expect(result.request.authProfile).toEqual({ kind: 'none' });
  });
});

describe('parseCrawlForm — the never-interact list', () => {
  it('refuses an empty list that nobody acknowledged', () => {
    const result = parseCrawlForm({ ...filled, neverInteractSelectors: '' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.neverInteractSelectors).toContain('never click');
  });

  it('accepts an empty list once it is an explicit decision', () => {
    const result = parseCrawlForm({
      ...filled,
      neverInteractSelectors: '',
      noDestructiveControls: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.bounds.neverInteractSelectors).toEqual([]);
  });

  it('keeps a non-empty list even when the acknowledgement is also ticked', () => {
    const result = parseCrawlForm({ ...filled, noDestructiveControls: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.bounds.neverInteractSelectors).toHaveLength(1);
  });
});

describe('parseCrawlForm — values the contract rejects', () => {
  it('refuses an origin that is not an absolute http(s) URL', () => {
    const result = parseCrawlForm({ ...filled, allowedOrigins: 'app.example.com' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.allowedOrigins).toBeDefined();
  });

  it('refuses a route allowlist entry that is not an absolute path', () => {
    const result = parseCrawlForm({ ...filled, routeAllowlist: 'orders' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.routeAllowlist).toBeDefined();
  });

  it.each([
    ['not a number', 'three'],
    ['a fraction', '2.5'],
    ['a negative depth', '-1'],
    ['beyond the contract ceiling', '33'],
  ])('refuses %s as a depth cap', (_label, value) => {
    const result = parseCrawlForm({ ...filled, maxDepth: value });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.maxDepth).toBeDefined();
  });

  it('refuses a page cap of zero — a crawl that indexes nothing is not a bound', () => {
    const result = parseCrawlForm({ ...filled, maxPages: '0' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.maxPages).toBeDefined();
  });

  it('allows a depth cap of zero, which indexes the entry route alone', () => {
    const result = parseCrawlForm({ ...filled, maxDepth: '0' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.bounds.maxDepth).toBe(0);
  });

  it('refuses an unthrottled crawl', () => {
    const result = parseCrawlForm({ ...filled, requestsPerMinute: '0' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.requestsPerMinute).toBeDefined();
  });

  it('attaches a viewport issue to the axis that caused it', () => {
    const result = parseCrawlForm({ ...filled, viewportHeight: '10' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.viewportHeight).toBeDefined();
    expect(result.issues.viewportWidth).toBeUndefined();
  });

  it.each([['not-a-uuid'], [''], ['3f2504e0-4f89-41d3-9a0c']])(
    'refuses %o as an application id',
    (value) => {
      const result = parseCrawlForm({ ...filled, applicationId: value });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.applicationId).toBeDefined();
    },
  );

  it('trims the application id before validating it', () => {
    const result = parseCrawlForm({ ...filled, applicationId: `  ${APPLICATION_ID}  ` });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applicationId).toBe(APPLICATION_ID);
  });
});

describe('parseCrawlForm — auth profiles', () => {
  const formLogin: CrawlFormValues = {
    ...filled,
    authKind: 'form',
    loginPath: '/login',
    usernameLabel: 'Email address',
    passwordLabel: 'Password',
    submitLabel: 'Sign in',
    successPath: '/dashboard',
    credentialsProvider: 'env',
    credentialsKey: 'NORTHSTAR_CRAWL_CREDENTIALS',
  };

  it('builds a form profile that references credentials rather than carrying them', () => {
    const result = parseCrawlForm(formLogin);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.authProfile).toEqual({
      kind: 'form',
      loginPath: '/login',
      usernameLabel: 'Email address',
      passwordLabel: 'Password',
      submitLabel: 'Sign in',
      successPath: '/dashboard',
      credentialsRef: { provider: 'env', key: 'NORTHSTAR_CRAWL_CREDENTIALS' },
    });
    // The profile is a pointer. Nothing resembling a secret value has a field to travel in.
    expect(JSON.stringify(result.request.authProfile)).not.toContain('password:');
  });

  it('refuses a form profile with no credentials reference, on that field', () => {
    const result = parseCrawlForm({ ...formLogin, credentialsKey: '' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.credentialsKey).toBeDefined();
  });

  it('refuses a form profile whose login path is not a path', () => {
    const result = parseCrawlForm({ ...formLogin, loginPath: 'login' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.loginPath).toBeDefined();
  });

  it('builds a storage-state profile from a reference', () => {
    const result = parseCrawlForm({
      ...filled,
      authKind: 'storage_state',
      stateProvider: 'file',
      stateKey: '/var/run/secrets/northstar-state.json',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.authProfile).toEqual({
      kind: 'storage_state',
      stateRef: { provider: 'file', key: '/var/run/secrets/northstar-state.json' },
    });
  });

  it('puts a storage-state failure on the one field the tester can act on', () => {
    const result = parseCrawlForm({ ...filled, authKind: 'storage_state', stateKey: '' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.stateKey).toBeDefined();
  });

  it('does not leak the previous variant when the profile is switched back to none', () => {
    const result = parseCrawlForm({ ...formLogin, authKind: 'none' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.authProfile).toEqual({ kind: 'none' });
  });
});

describe('issuesFromGateway', () => {
  it('lands the origin-allowlist refusal on the field it names', () => {
    const issues = issuesFromGateway([
      {
        path: 'bounds.allowedOrigins',
        message: 'the crawl bounds do not allow the application’s own origin',
      },
    ]);

    expect(issues.allowedOrigins).toBe(
      'the crawl bounds do not allow the application’s own origin',
    );
    expect(issues.form).toBeUndefined();
  });

  it('maps an unknown application onto the application field', () => {
    const issues = issuesFromGateway([{ path: 'id', message: 'no such application' }]);

    expect(issues.applicationId).toBe('no such application');
  });

  it('maps a nested viewport issue onto its axis', () => {
    const issues = issuesFromGateway([{ path: 'bounds.viewport.height', message: 'too short' }]);

    expect(issues.viewportHeight).toBe('too short');
  });

  it('maps an auth issue onto its field', () => {
    const issues = issuesFromGateway([
      { path: 'authProfile.credentialsRef', message: 'unreadable reference' },
    ]);

    expect(issues.credentialsKey).toBe('unreadable reference');
  });

  it('falls back to the form-level slot rather than dropping an unrecognised path', () => {
    const issues = issuesFromGateway([{ path: 'something.else', message: 'refused' }]);

    expect(issues.form).toBe('refused');
  });

  it('keeps the first message per field when the gateway reports several', () => {
    const issues = issuesFromGateway([
      { path: 'bounds.maxPages', message: 'first' },
      { path: 'bounds.maxPages', message: 'second' },
    ]);

    expect(issues.maxPages).toBe('first');
  });
});
