/**
 * Process lifecycle: ordered, idempotent, fault-isolated shutdown.
 *
 * Hooks drain in reverse registration order (LIFO), so a resource always closes before the
 * thing it depends on. A hook that throws is recorded and the drain continues — one failing
 * close must not strand the connections registered before it.
 */

export type ShutdownHook = () => void | Promise<void>;

export interface ShutdownFailure {
  readonly name: string;
  readonly error: unknown;
}

export interface ShutdownResult {
  readonly signal: string;
  readonly failures: readonly ShutdownFailure[];
  readonly durationMs: number;
}

export class Lifecycle {
  readonly #hooks: { name: string; run: ShutdownHook }[] = [];
  #draining: Promise<ShutdownResult> | undefined;

  onShutdown(name: string, run: ShutdownHook): void {
    this.#hooks.push({ name, run });
  }

  get isShuttingDown(): boolean {
    return this.#draining !== undefined;
  }

  /**
   * Begins the drain, or returns the in-flight one. A second SIGTERM while shutting down must
   * not run any hook twice, so the first call's promise is memoised and handed back.
   */
  shutdown(signal: string): Promise<ShutdownResult> {
    this.#draining ??= this.#drain(signal);
    return this.#draining;
  }

  async #drain(signal: string): Promise<ShutdownResult> {
    const startedAt = performance.now();
    const failures: ShutdownFailure[] = [];

    for (const hook of [...this.#hooks].reverse()) {
      try {
        await hook.run();
      } catch (error: unknown) {
        failures.push({ name: hook.name, error });
      }
    }

    return { signal, failures, durationMs: performance.now() - startedAt };
  }
}

export interface SignalHandlerOptions {
  readonly lifecycle: Lifecycle;
  readonly signals: readonly NodeJS.Signals[];
  readonly onShutdown: (result: ShutdownResult) => void;
  readonly process: Pick<NodeJS.Process, 'on' | 'off'>;
}

/** Wires signals to the drain. Returns an uninstall function so tests leave no listeners behind. */
export function installSignalHandlers(options: SignalHandlerOptions): () => void {
  const listeners = options.signals.map((signal) => {
    const listener = (): void => {
      void options.lifecycle.shutdown(signal).then(options.onShutdown);
    };
    options.process.on(signal, listener);
    return { signal, listener };
  });

  return () => {
    for (const { signal, listener } of listeners) {
      options.process.off(signal, listener);
    }
  };
}
