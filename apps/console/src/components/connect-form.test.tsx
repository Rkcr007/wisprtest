import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectForm } from './connect-form';

/**
 * Connect, rendered.
 *
 * `form.ts` already proves the validation rules; what a rendered test adds is that the screen is
 * actually wired to them — that the submit button cannot get a crawl past the bounds check, that
 * a refusal is announced rather than merely styled red, and that every control is reachable and
 * labelled for somebody who is not using a mouse.
 */

const push = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

const APPLICATION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const JOB_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function renderForm(): ReactElement {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const tree = (
    <QueryClientProvider client={client}>
      <ConnectForm />
    </QueryClientProvider>
  );
  render(tree);
  return tree;
}

/** Type into a labelled control, the way a tester fills the form. */
function fill(label: RegExp, value: string): void {
  const control = screen.getByLabelText(label);
  fireEvent.change(control, { target: { value } });
}

function fillValidForm(): void {
  fill(/^Application$/, APPLICATION_ID);
  fill(/Allowed origins/, 'https://app.example.com');
  fill(/Route allowlist/, '/orders');
  fill(/Depth cap/, '3');
  fill(/Page cap/, '50');
  fill(/Never interact with/, 'button[data-action="delete"]');
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: /Start index/i }));
}

const accepted = {
  jobId: JOB_ID,
  applicationId: APPLICATION_ID,
  messageId: '1712-0',
  requestedAt: '2026-08-02T10:00:00.000Z',
  progressUrl: `/v1/applications/${APPLICATION_ID}/index-progress`,
};

beforeEach(() => {
  push.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ConnectForm — the bounds gate', () => {
  it('does not send a crawl when the bounds are empty', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderForm();

    submit();

    // The gateway would refuse this anyway. The point is that it never gets asked.
    await waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names each missing bound on its own field rather than in one banner', async () => {
    vi.stubGlobal('fetch', vi.fn());
    renderForm();

    submit();

    await waitFor(() => {
      expect(screen.getByLabelText(/Allowed origins/).getAttribute('aria-invalid')).toBe('true');
    });
    for (const label of [/Allowed origins/, /Route allowlist/, /Depth cap/, /Page cap/, /Never interact with/]) {
      expect(screen.getByLabelText(label).getAttribute('aria-invalid')).toBe('true');
    }
  });

  it('ships the blast-radius fields empty, so the tester must choose them', () => {
    renderForm();

    for (const label of [/Allowed origins/, /Route allowlist/, /Depth cap/, /Page cap/]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe('');
    }
  });

  it('pre-fills the operational tuning, which carries no safety', () => {
    renderForm();

    expect((screen.getByLabelText(/Navigations per minute/) as HTMLInputElement).value).toBe('60');
    expect((screen.getByLabelText(/Viewport width/) as HTMLInputElement).value).toBe('1440');
  });

  it('refuses an empty never-interact list until it is acknowledged', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(accepted), { status: 202, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderForm();

    fillValidForm();
    fill(/Never interact with/, '');
    submit();

    await waitFor(() => {
      expect(screen.getByLabelText(/Never interact with/).getAttribute('aria-invalid')).toBe('true');
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // Ticking the acknowledgement makes the empty list a decision, and the crawl may start.
    fireEvent.click(screen.getByLabelText(/no destructive controls/i));
    submit();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it('posts a contract-shaped request once the form is complete', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(accepted), { status: 202, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderForm();

    fillValidForm();
    submit();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/applications/${APPLICATION_ID}/crawl`);
    const body = JSON.parse(init.body as string) as { bounds: Record<string, unknown> };
    expect(body.bounds.maxPages).toBe(50);
    expect(body.bounds.allowedOrigins).toEqual(['https://app.example.com']);
    expect(body.bounds.neverInteractSelectors).toEqual(['button[data-action="delete"]']);
  });

  it('sends the browser to the indexing screen with the page cap it just set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(accepted), { status: 202, headers: { 'content-type': 'application/json' } }),
      ),
    );
    renderForm();

    fillValidForm();
    submit();

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(
        `/applications/${APPLICATION_ID}/indexing?jobId=${JOB_ID}&pageCap=50`,
      );
    });
  });
});

describe('ConnectForm — refusals from the server', () => {
  it('attaches the gateway’s origin complaint to the origin field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 'validation_failed',
            message: 'the crawl bounds do not allow the application’s own origin',
            issues: [{ path: 'bounds.allowedOrigins', message: 'must include the registered origin' }],
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    renderForm();

    fillValidForm();
    submit();

    await waitFor(() => {
      expect(screen.getByText(/must include the registered origin/)).toBeDefined();
    });
    expect(screen.getByLabelText(/Allowed origins/).getAttribute('aria-invalid')).toBe('true');
  });

  it('announces a failure rather than leaving the screen looking idle', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    renderForm();

    fillValidForm();
    submit();

    await waitFor(() => {
      const alerts = screen.getAllByRole('alert').map((node) => node.textContent);
      expect(alerts.join(' ')).toContain('offline');
    });
  });

  it('leaves no row suggesting a crawl is running after a refusal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    renderForm();

    fillValidForm();
    submit();

    await waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText(/No crawls started here yet/)).toBeDefined();
  });

  it('disables the submit button while the request is in flight', async () => {
    let release: (value: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
      ),
    );
    renderForm();

    fillValidForm();
    submit();

    await waitFor(() => {
      expect((screen.getByRole('button', { name: /Starting index/i }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });

    release(
      new Response(JSON.stringify(accepted), { status: 202, headers: { 'content-type': 'application/json' } }),
    );
  });
});

describe('ConnectForm — keyboard and assistive technology', () => {
  it('gives every control a label a keyboard user can be told', () => {
    renderForm();

    for (const label of [
      /^Application$/,
      /Allowed origins/,
      /Route allowlist/,
      /Depth cap/,
      /Page cap/,
      /Never interact with/,
      /Navigations per minute/,
      /Interactions per screen/,
      /Viewport width/,
      /Viewport height/,
      /^Profile$/,
    ]) {
      expect(screen.getByLabelText(label)).toBeDefined();
    }
  });

  it('associates each control with its own hint through aria-describedby', () => {
    renderForm();
    const control = screen.getByLabelText(/Page cap/);

    const describedBy = control.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    const hint = document.getElementById(describedBy ?? '');
    expect(hint?.textContent).toContain('Hard ceiling');
  });

  it('adds the error to the description without dropping the hint', async () => {
    vi.stubGlobal('fetch', vi.fn());
    renderForm();

    submit();

    await waitFor(() => {
      expect(screen.getByLabelText(/Page cap/).getAttribute('aria-invalid')).toBe('true');
    });
    const ids = (screen.getByLabelText(/Page cap/).getAttribute('aria-describedby') ?? '').split(' ');
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(document.getElementById(id)).not.toBeNull();
    }
  });

  it('uses native controls throughout, so tab order is document order', () => {
    renderForm();
    const form = screen.getByRole('button', { name: /Start index/i }).closest('form');
    const interactive = form?.querySelectorAll('input, select, textarea, button, [tabindex]') ?? [];

    expect(interactive.length).toBeGreaterThan(10);
    for (const node of interactive) {
      // A positive tabindex overrides document order and desynchronises the visual and keyboard
      // sequences; a div with a click handler is not reachable by keyboard at all.
      const tabIndex = node.getAttribute('tabindex');
      expect(tabIndex === null || Number(tabIndex) <= 0).toBe(true);
      expect(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON']).toContain(node.tagName);
    }
  });

  it('submits on Enter from a text field, without a mouse', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(accepted), { status: 202, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderForm();

    fillValidForm();
    const form = screen.getByRole('button', { name: /Start index/i }).closest('form');
    fireEvent.submit(form as HTMLFormElement);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps the browser’s own validation out of the way so the typed messages are the ones shown', () => {
    renderForm();
    const form = screen.getByRole('button', { name: /Start index/i }).closest('form');

    // `noValidate`: otherwise the browser blocks submit with its own untranslatable bubble and the
    // field-level messages this form computes are never reached.
    expect((form as HTMLFormElement).noValidate).toBe(true);
  });

  it('reveals the auth fields only for the profile that needs them', () => {
    renderForm();

    expect(screen.queryByLabelText(/Login path/)).toBeNull();

    fireEvent.change(screen.getByLabelText(/^Profile$/), { target: { value: 'form' } });
    expect(screen.getByLabelText(/Login path/)).toBeDefined();
    expect(screen.getByLabelText(/Credentials reference/)).toBeDefined();

    fireEvent.change(screen.getByLabelText(/^Profile$/), { target: { value: 'storage_state' } });
    expect(screen.queryByLabelText(/Login path/)).toBeNull();
    expect(screen.getByLabelText(/Storage state reference/)).toBeDefined();
  });

  it('never renders a control that would hold a credential', () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/^Profile$/), { target: { value: 'form' } });

    // Credentials are referenced, never pasted: a password input here would be a password stored.
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0);
    expect(screen.getByLabelText(/Credentials reference/).getAttribute('type')).toBe('text');
  });

  it('says plainly that the recent-applications list needs a route the gateway does not have', () => {
    renderForm();

    // CLAUDE.md rule #1: an honest gap beats a table filled from a guess.
    expect(screen.getByText(/GET \/v1\/applications/)).toBeDefined();
  });
});
