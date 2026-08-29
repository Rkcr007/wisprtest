import { describe, expect, it } from 'vitest';

import { applicationHref, isScreenActive, parseApplicationId } from './screens';

const APP = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('parseApplicationId', () => {
  it('reads the application id from an application route', () => {
    expect(parseApplicationId(`/applications/${APP}/drift`)).toBe(APP);
    expect(parseApplicationId(`/applications/${APP}`)).toBe(APP);
    expect(parseApplicationId(`/applications/${APP}/sessions/${APP}`)).toBe(APP);
  });

  it('returns null on Connect, and on a path whose segment is not a UUID', () => {
    expect(parseApplicationId('/')).toBeNull();
    expect(parseApplicationId('/applications/not-a-uuid/drift')).toBeNull();
    expect(parseApplicationId('/auth/login')).toBeNull();
  });
});

describe('isScreenActive', () => {
  it('marks overview only on the application root, not on indexing', () => {
    expect(isScreenActive(`/applications/${APP}`, APP, 'overview')).toBe(true);
    expect(isScreenActive(`/applications/${APP}/indexing`, APP, 'overview')).toBe(false);
    expect(isScreenActive(`/applications/${APP}/drift`, APP, 'overview')).toBe(false);
  });

  it('keeps Sessions current on the detail view', () => {
    expect(isScreenActive(`/applications/${APP}/sessions`, APP, 'sessions')).toBe(true);
    expect(isScreenActive(`/applications/${APP}/sessions/${APP}`, APP, 'sessions')).toBe(true);
    expect(isScreenActive(`/applications/${APP}/drift`, APP, 'sessions')).toBe(false);
  });

  it('builds hrefs the nav actually uses', () => {
    expect(applicationHref(APP, 'overview')).toBe(`/applications/${APP}`);
    expect(applicationHref(APP, 'drift')).toBe(`/applications/${APP}/drift`);
    expect(applicationHref(APP, 'admin')).toBe(`/applications/${APP}/admin`);
  });
});
