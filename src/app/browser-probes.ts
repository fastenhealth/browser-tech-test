import { Inject, Injectable, InjectionToken } from '@angular/core';

export type ProbeId = 'websocket' | 'partitioned-cookie' | 'local-storage';

export type ProbeStatus =
  | 'idle'
  | 'running'
  | 'passed'
  | 'partitioned'
  | 'shared'
  | 'blocked'
  | 'failed'
  | 'unsupported'
  | 'inconclusive';

export interface ProbeResult {
  id: ProbeId;
  status: ProbeStatus;
  summary: string;
  detail: string;
  checkedAt: string;
  diagnostics: string[];
  durationMs?: number;
}

export type ProbeResultMap = Record<ProbeId, ProbeResult>;

export interface PrimeArtifacts {
  runId: string;
  cookieName: string;
  cookieValue: string;
  storageKey: string;
  storageValue: string;
  cookiePrepared: boolean;
  storagePrepared: boolean;
  errors: string[];
}

export interface ProbeDefinition {
  id: ProbeId;
  label: string;
  description: string;
}

export const PROBE_DEFINITIONS: readonly ProbeDefinition[] = [
  {
    id: 'websocket',
    label: 'WebSocket',
    description: 'Connects to a secure endpoint and verifies an exact echo.',
  },
  {
    id: 'partitioned-cookie',
    label: 'Partitioned cookie',
    description: 'Checks a secure cookie roundtrip and compares an optional first-party seed.',
  },
  {
    id: 'local-storage',
    label: 'Local storage',
    description: 'Exercises storage CRUD and compares an optional first-party seed.',
  },
];

const definitionById = Object.fromEntries(
  PROBE_DEFINITIONS.map((definition) => [definition.id, definition]),
) as Record<ProbeId, ProbeDefinition>;

function createResults(status: 'idle' | 'running'): ProbeResultMap {
  const checkedAt = new Date().toISOString();
  const createResult = (id: ProbeId): ProbeResult => {
    const definition = definitionById[id];
    return {
      id,
      status,
      summary: status === 'idle' ? 'Not run' : 'Running',
      detail: status === 'idle' ? definition.description : `Running ${definition.label} probe...`,
      checkedAt,
      diagnostics: [],
    };
  };

  return {
    websocket: createResult('websocket'),
    'partitioned-cookie': createResult('partitioned-cookie'),
    'local-storage': createResult('local-storage'),
  };
}

export function createIdleResults(): ProbeResultMap {
  return createResults('idle');
}

export function createRunningResults(): ProbeResultMap {
  return createResults('running');
}

export interface ProbeWebSocket {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface BrowserProbeEnvironment {
  isSecureContext(): boolean;
  readCookie: (() => string) | null;
  writeCookie: ((serializedCookie: string) => void) | null;
  getLocalStorage(): Storage | null;
  createWebSocket: ((url: string) => ProbeWebSocket) | null;
  randomUUID(): string;
  now(): number;
  isoNow(): string;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(timer: unknown): void;
  webSocketTimeoutMs: number;
}

function defaultEnvironment(): BrowserProbeEnvironment {
  const WebSocketConstructor = globalThis.WebSocket;
  const hasDocument = typeof globalThis.document !== 'undefined';

  return {
    isSecureContext: () => {
      if (typeof globalThis.isSecureContext === 'boolean') {
        return globalThis.isSecureContext;
      }

      const location = globalThis.location;
      return (
        location?.protocol === 'https:' ||
        location?.hostname === 'localhost' ||
        location?.hostname === '127.0.0.1'
      );
    },
    readCookie: hasDocument ? () => globalThis.document.cookie : null,
    writeCookie: hasDocument
      ? (serializedCookie) => {
          globalThis.document.cookie = serializedCookie;
        }
      : null,
    getLocalStorage: () => {
      if (typeof globalThis.window === 'undefined') {
        return null;
      }
      return globalThis.window.localStorage;
    },
    createWebSocket:
      typeof WebSocketConstructor === 'function'
        ? (url) => new WebSocketConstructor(url) as ProbeWebSocket
        : null,
    randomUUID: () => {
      if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
      }
      return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    },
    now: () => globalThis.performance?.now() ?? Date.now(),
    isoNow: () => new Date().toISOString(),
    setTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimer: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
    webSocketTimeoutMs: 8_000,
  };
}

export const BROWSER_PROBE_ENVIRONMENT = new InjectionToken<BrowserProbeEnvironment>(
  'BROWSER_PROBE_ENVIRONMENT',
  {
    providedIn: 'root',
    factory: defaultEnvironment,
  },
);

const blockedErrorNames = new Set([
  'InvalidStateError',
  'NotAllowedError',
  'QuotaExceededError',
  'SecurityError',
]);

type ResultCallback = (result: ProbeResult) => void;

@Injectable({ providedIn: 'root' })
export class BrowserProbeService {
  constructor(
    @Inject(BROWSER_PROBE_ENVIRONMENT)
    private readonly environment: BrowserProbeEnvironment,
  ) {}

  async runAll(
    webSocketUrl: string,
    prime: PrimeArtifacts | null,
    onResult: ResultCallback = () => undefined,
  ): Promise<ProbeResultMap> {
    const running = createRunningResults();
    for (const definition of PROBE_DEFINITIONS) {
      this.notify(onResult, running[definition.id]);
    }

    const probes: Array<Promise<ProbeResult>> = [
      this.runWebSocketProbe(webSocketUrl),
      Promise.resolve(this.runPartitionedCookieProbe(prime)),
      Promise.resolve(this.runLocalStorageProbe(prime)),
    ];

    const completed = await Promise.all(
      probes.map(async (probe) => {
        const result = await probe;
        this.notify(onResult, result);
        return result;
      }),
    );

    return Object.fromEntries(completed.map((result) => [result.id, result])) as ProbeResultMap;
  }

  async createPrimeArtifacts(runId: string): Promise<PrimeArtifacts> {
    const token = this.randomToken();
    const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48) || 'run';
    const prime: PrimeArtifacts = {
      runId,
      cookieName: `__Host-browser-tech-test-prime-${token}`,
      cookieValue: `first-party-${token}`,
      storageKey: `browser-tech-test:prime:${safeRunId}:${token}`,
      storageValue: `first-party-${this.randomToken()}`,
      cookiePrepared: false,
      storagePrepared: false,
      errors: [],
    };

    if (!this.environment.isSecureContext()) {
      prime.errors.push('Cookie prime was not prepared because partitioned cookies require HTTPS.');
    } else if (!this.environment.readCookie || !this.environment.writeCookie) {
      prime.errors.push('Cookie prime was not prepared because the cookie API is unavailable.');
    } else {
      try {
        this.setPartitionedCookie(prime.cookieName, prime.cookieValue);
        prime.cookiePrepared = this.readCookie(prime.cookieName) === prime.cookieValue;
        if (!prime.cookiePrepared) {
          prime.errors.push('The browser did not retain the first-party partitioned cookie seed.');
        }
      } catch (error) {
        prime.errors.push(`Cookie prime failed: ${this.describeError(error)}`);
      }
    }

    try {
      const storage = this.environment.getLocalStorage();
      if (!storage) {
        prime.errors.push('Local storage prime was not prepared because the API is unavailable.');
      } else {
        storage.setItem(prime.storageKey, prime.storageValue);
        prime.storagePrepared = storage.getItem(prime.storageKey) === prime.storageValue;
        if (!prime.storagePrepared) {
          prime.errors.push('The browser did not retain the first-party local storage seed.');
        }
      }
    } catch (error) {
      prime.errors.push(`Local storage prime failed: ${this.describeError(error)}`);
    }

    return prime;
  }

  cleanupPrimeArtifacts(prime: PrimeArtifacts): void {
    try {
      this.deletePartitionedCookie(prime.cookieName);
    } catch {
      // Cleanup is best-effort and can be denied independently in embedded contexts.
    }

    try {
      this.environment.getLocalStorage()?.removeItem(prime.storageKey);
    } catch {
      // Cleanup is best-effort and can be denied independently in embedded contexts.
    }
  }

  private runWebSocketProbe(url: string): Promise<ProbeResult> {
    const startedAt = this.environment.now();
    const diagnostics: string[] = [];
    const factory = this.environment.createWebSocket;

    if (!factory) {
      return Promise.resolve(
        this.result(
          'websocket',
          'unsupported',
          'WebSocket API unavailable',
          'This browser context does not expose the WebSocket constructor.',
          diagnostics,
          startedAt,
        ),
      );
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return Promise.resolve(
        this.result(
          'websocket',
          'failed',
          'Invalid WebSocket endpoint',
          'Enter a valid wss:// URL.',
          [`Received endpoint: ${url || '(empty)'}`],
          startedAt,
        ),
      );
    }

    if (parsedUrl.protocol !== 'wss:') {
      return Promise.resolve(
        this.result(
          'websocket',
          'blocked',
          'Secure WebSocket required',
          'The test only connects to wss:// endpoints so it can run from GitHub Pages.',
          [`Received protocol: ${parsedUrl.protocol}`],
          startedAt,
        ),
      );
    }

    return new Promise((resolve) => {
      const payload = `browser-tech-test:${this.randomToken()}`;
      let socket: ProbeWebSocket | null = null;
      let timer: unknown;
      let finished = false;

      const detachAndClose = (): void => {
        if (!socket) {
          return;
        }
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        try {
          socket.close(1000, 'Probe complete');
        } catch {
          // A socket can already be closed by the remote endpoint.
        }
      };

      const finish = (
        status: ProbeStatus,
        summary: string,
        detail: string,
        extraDiagnostics: string[] = [],
      ): void => {
        if (finished) {
          return;
        }
        finished = true;
        if (timer !== undefined) {
          this.environment.clearTimer(timer);
        }
        detachAndClose();
        resolve(
          this.result(
            'websocket',
            status,
            summary,
            detail,
            [...diagnostics, ...extraDiagnostics],
            startedAt,
          ),
        );
      };

      try {
        socket = factory(parsedUrl.toString());
        socket.onopen = () => {
          diagnostics.push('Connection opened; sending an exact-match nonce.');
          try {
            socket?.send(payload);
          } catch (error) {
            const status = this.statusForError(error);
            finish(
              status,
              'WebSocket send failed',
              'The connection opened but the probe payload could not be sent.',
              [this.describeError(error)],
            );
          }
        };
        socket.onmessage = (event) => {
          if (event.data === payload) {
            finish(
              'passed',
              'Exact echo received',
              'The socket connected and returned the exact probe payload.',
            );
            return;
          }

          if (diagnostics.length < 8) {
            diagnostics.push(
              `Ignored a non-matching ${typeof event.data === 'string' ? 'text' : 'binary'} message.`,
            );
          }
        };
        socket.onerror = () => {
          finish(
            'failed',
            'WebSocket connection failed',
            'The browser reported a connection error. The endpoint, network, CSP, or firewall may be responsible.',
          );
        };
        socket.onclose = (event) => {
          finish(
            'failed',
            'Socket closed before echo',
            'The endpoint closed before returning the exact probe payload.',
            [`Close code ${event.code}${event.reason ? `: ${event.reason}` : ''}`],
          );
        };
        timer = this.environment.setTimer(() => {
          finish(
            'failed',
            'WebSocket timed out',
            'No exact echo arrived before the probe timeout.',
            [`Timeout: ${this.environment.webSocketTimeoutMs} ms`],
          );
        }, this.environment.webSocketTimeoutMs);
      } catch (error) {
        const status = this.statusForError(error);
        finish(
          status,
          'WebSocket construction failed',
          'The browser could not create a socket for this endpoint.',
          [this.describeError(error)],
        );
      }
    });
  }

  private runPartitionedCookieProbe(prime: PrimeArtifacts | null): ProbeResult {
    const startedAt = this.environment.now();
    const diagnostics: string[] = [];

    if (!this.environment.isSecureContext()) {
      return this.result(
        'partitioned-cookie',
        'blocked',
        'HTTPS required',
        'Secure __Host- partitioned cookies cannot be tested in this context.',
        diagnostics,
        startedAt,
      );
    }

    if (!this.environment.readCookie || !this.environment.writeCookie) {
      return this.result(
        'partitioned-cookie',
        'unsupported',
        'Cookie API unavailable',
        'This context does not expose document.cookie.',
        diagnostics,
        startedAt,
      );
    }

    const probeName = `__Host-browser-tech-test-probe-${this.randomToken()}`;
    const probeValue = `roundtrip-${this.randomToken()}`;

    try {
      const firstPartyValue = prime?.cookiePrepared ? this.readCookie(prime.cookieName) : null;
      this.setPartitionedCookie(probeName, probeValue);
      const roundtripValue = this.readCookie(probeName);

      if (roundtripValue !== probeValue) {
        return this.result(
          'partitioned-cookie',
          'blocked',
          'Partitioned cookie unavailable',
          'The browser did not retain the secure partitioned cookie.',
          ['The write completed without an exception, but its value was not readable.'],
          startedAt,
        );
      }

      diagnostics.push('A secure __Host- cookie completed a write/read roundtrip.');
      if (!prime) {
        return this.result(
          'partitioned-cookie',
          'inconclusive',
          'Cookie roundtrip passed',
          'A first-party seed is required to prove whether the cookie jar is partitioned.',
          diagnostics,
          startedAt,
        );
      }

      diagnostics.push(...prime.errors.map((error) => `Prime: ${error}`));
      if (!prime.cookiePrepared) {
        return this.result(
          'partitioned-cookie',
          'inconclusive',
          'Cookie works; seed unavailable',
          'The cookie roundtrip passed, but first-party priming failed so isolation cannot be classified.',
          diagnostics,
          startedAt,
        );
      }

      if (firstPartyValue === prime.cookieValue) {
        return this.result(
          'partitioned-cookie',
          'shared',
          'First-party cookie is visible',
          'This context can read the first-party seed, so the observed cookie jar is shared.',
          diagnostics,
          startedAt,
        );
      }

      if (firstPartyValue === null) {
        return this.result(
          'partitioned-cookie',
          'partitioned',
          'Cookie jar is isolated',
          'The first-party seed is hidden while a new partitioned cookie works in this context.',
          diagnostics,
          startedAt,
        );
      }

      return this.result(
        'partitioned-cookie',
        'inconclusive',
        'First-party seed changed',
        'A value was present under the seed name, but it did not match the prepared first-party value.',
        [...diagnostics, `Observed seed value: ${firstPartyValue}`],
        startedAt,
      );
    } catch (error) {
      const status = this.statusForError(error);
      return this.result(
        'partitioned-cookie',
        status,
        status === 'blocked' ? 'Cookie access blocked' : 'Cookie probe failed',
        'The context rejected cookie access before the probe could complete.',
        [this.describeError(error)],
        startedAt,
      );
    } finally {
      try {
        this.deletePartitionedCookie(probeName);
      } catch {
        // The result already records access failures; cleanup remains best-effort.
      }
    }
  }

  private runLocalStorageProbe(prime: PrimeArtifacts | null): ProbeResult {
    const startedAt = this.environment.now();
    const diagnostics: string[] = [];
    const probeKey = `browser-tech-test:probe:${this.randomToken()}`;
    const firstValue = `write-${this.randomToken()}`;
    const secondValue = `overwrite-${this.randomToken()}`;
    let storage: Storage | null = null;

    try {
      storage = this.environment.getLocalStorage();
      if (!storage) {
        return this.result(
          'local-storage',
          'unsupported',
          'Local storage unavailable',
          'This context does not expose the localStorage API.',
          diagnostics,
          startedAt,
        );
      }

      const firstPartyValue = prime?.storagePrepared ? storage.getItem(prime.storageKey) : null;

      storage.setItem(probeKey, firstValue);
      if (storage.getItem(probeKey) !== firstValue) {
        throw new Error('The first localStorage value did not roundtrip.');
      }

      storage.setItem(probeKey, secondValue);
      if (storage.getItem(probeKey) !== secondValue) {
        throw new Error('The overwritten localStorage value did not roundtrip.');
      }

      storage.removeItem(probeKey);
      if (storage.getItem(probeKey) !== null) {
        throw new Error('The localStorage key remained after removal.');
      }

      diagnostics.push('Write, read, overwrite, and remove checks passed.');
      if (!prime) {
        return this.result(
          'local-storage',
          'passed',
          'Local storage CRUD passed',
          'Values can be written, read, overwritten, and removed in this context.',
          diagnostics,
          startedAt,
        );
      }

      diagnostics.push(...prime.errors.map((error) => `Prime: ${error}`));
      if (!prime.storagePrepared) {
        return this.result(
          'local-storage',
          'inconclusive',
          'Storage works; seed unavailable',
          'CRUD passed, but first-party priming failed so isolation cannot be classified.',
          diagnostics,
          startedAt,
        );
      }

      if (firstPartyValue === prime.storageValue) {
        return this.result(
          'local-storage',
          'shared',
          'First-party storage is visible',
          'CRUD passed and this context can read the first-party seed.',
          diagnostics,
          startedAt,
        );
      }

      if (firstPartyValue === null) {
        return this.result(
          'local-storage',
          'partitioned',
          'Storage bucket is isolated',
          'CRUD passed, but the prepared first-party seed is not visible in this context.',
          diagnostics,
          startedAt,
        );
      }

      return this.result(
        'local-storage',
        'inconclusive',
        'First-party seed changed',
        'CRUD passed, but the value under the seed key did not match the prepared value.',
        [...diagnostics, `Observed seed value: ${firstPartyValue}`],
        startedAt,
      );
    } catch (error) {
      const status = this.statusForError(error);
      return this.result(
        'local-storage',
        status,
        status === 'blocked' ? 'Local storage blocked' : 'Local storage CRUD failed',
        'The storage checks could not complete in this context.',
        [this.describeError(error)],
        startedAt,
      );
    } finally {
      try {
        storage?.removeItem(probeKey);
      } catch {
        // Cleanup is best-effort after a failed or blocked probe.
      }
    }
  }

  private setPartitionedCookie(name: string, value: string): void {
    if (!this.environment.writeCookie) {
      throw new Error('Cookie writing is unavailable.');
    }
    this.environment.writeCookie(
      `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=600; SameSite=None; Secure; Partitioned`,
    );
  }

  private deletePartitionedCookie(name: string): void {
    this.environment.writeCookie?.(
      `${name}=; Path=/; Max-Age=0; SameSite=None; Secure; Partitioned`,
    );
  }

  private readCookie(name: string): string | null {
    if (!this.environment.readCookie) {
      return null;
    }

    const prefix = `${name}=`;
    const pair = this.environment
      .readCookie()
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix));

    if (!pair) {
      return null;
    }

    try {
      return decodeURIComponent(pair.slice(prefix.length));
    } catch {
      return pair.slice(prefix.length);
    }
  }

  private result(
    id: ProbeId,
    status: ProbeStatus,
    summary: string,
    detail: string,
    diagnostics: string[],
    startedAt: number,
  ): ProbeResult {
    return {
      id,
      status,
      summary,
      detail,
      checkedAt: this.environment.isoNow(),
      diagnostics,
      durationMs: Math.max(0, Math.round((this.environment.now() - startedAt) * 10) / 10),
    };
  }

  private statusForError(error: unknown): 'blocked' | 'failed' {
    const name = this.errorName(error);
    return blockedErrorNames.has(name) ? 'blocked' : 'failed';
  }

  private errorName(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'name' in error) {
      return String(error.name);
    }
    return 'Error';
  }

  private describeError(error: unknown): string {
    if (error instanceof Error || (typeof error === 'object' && error !== null)) {
      const name = this.errorName(error);
      const message = 'message' in error ? String(error.message) : '';
      return message ? `${name}: ${message}` : name;
    }
    return String(error);
  }

  private randomToken(): string {
    return this.environment
      .randomUUID()
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 48);
  }

  private notify(callback: ResultCallback, result: ProbeResult): void {
    try {
      callback(result);
    } catch {
      // A rendering callback must not prevent the remaining probes from finishing.
    }
  }
}
