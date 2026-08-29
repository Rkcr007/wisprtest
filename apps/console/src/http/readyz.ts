/**
 * Console readiness: is the gateway accepting traffic?
 *
 * Liveness (`/api/healthz`) touches nothing external so a control-plane blip cannot convince
 * the orchestrator to kill every replica. Readiness is the opposite question — should traffic
 * land here — and a console that cannot reach the gateway is a page of failures, so the
 * probe asks the gateway and reports what it said.
 *
 * The request is unauthenticated on purpose. The gateway's `/readyz` is public (and exempt
 * from rate limiting). Attaching the session cookie or a minted token would turn a kubelet
 * probe into a credential leak in every orchestrator log that records outbound headers.
 */

export type GatewayProbeStatus = 'ready' | 'not_ready' | 'unreachable';

export interface GatewayProbe {
  readonly status: GatewayProbeStatus;
  /** HTTP status of the last response. Null if nothing answered. */
  readonly httpStatus: number | null;
}

export interface ProbeGatewayOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2_000;

/**
 * Ask the gateway whether it is ready, then whether it is alive.
 *
 * `/readyz` is preferred. A 503 from it is a real "not ready" — postgres or redis is down —
 * and falling through to `/healthz` would hide that. `/healthz` is only used when `/readyz`
 * is missing (404) or the socket never answered, which is what the Track I brief asked for.
 *
 * @param gatewayBaseUrl - `GATEWAY_URL` with no path. Credentials in the URL are stripped
 *   before the request so a misconfigured connection string cannot travel as a header.
 * @param options.fetch - Test seam.
 * @param options.timeoutMs - Per-attempt ceiling. Defaults to 2s, matching the gateway's own
 *   dependency probes.
 */
export async function probeGatewayReady(
  gatewayBaseUrl: string,
  options: ProbeGatewayOptions = {},
): Promise<GatewayProbe> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = stripUserinfo(gatewayBaseUrl).replace(/\/$/, '');

  let lastStatus: number | null = null;

  for (const path of ['/readyz', '/healthz'] as const) {
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      lastStatus = response.status;

      if (response.status >= 200 && response.status < 300) {
        return { status: 'ready', httpStatus: response.status };
      }

      // A definite answer from /readyz. Do not ask /healthz — that endpoint does not check
      // dependencies, so it would report a wedged gateway as ready.
      if (path === '/readyz' && response.status !== 404) {
        return { status: 'not_ready', httpStatus: response.status };
      }
    } catch {
      // Connection refused, DNS, timeout. Try the next path.
    }
  }

  return {
    status: lastStatus === null ? 'unreachable' : 'not_ready',
    httpStatus: lastStatus,
  };
}

/**
 * Drop `user:pass@` from a URL so a DATABASE-style mistake in GATEWAY_URL cannot become an
 * Authorization header or a log line.
 */
export function stripUserinfo(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url;
  }
}
