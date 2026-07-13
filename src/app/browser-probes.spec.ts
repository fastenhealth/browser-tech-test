import {
  BrowserProbeEnvironment,
  BrowserProbeService,
  createIdleResults,
  createRunningResults,
  PrimeArtifacts,
  ProbeRunContext,
  ProbeWebSocket,
} from './browser-probes';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
}

class CookieJar {
  private readonly values = new Map<string, string>();
  readonly writes: string[] = [];

  constructor(private readonly allowUnpartitioned = true) {}

  read = (): string =>
    [...this.values.entries()].map(([name, value]) => `${name}=${value}`).join('; ');

  write = (serializedCookie: string): void => {
    this.writes.push(serializedCookie);
    const [pair, ...attributes] = serializedCookie.split(';').map((part) => part.trim());
    const equalsIndex = pair.indexOf('=');
    const name = pair.slice(0, equalsIndex);
    const value = pair.slice(equalsIndex + 1);
    const shouldDelete = attributes.some((attribute) => attribute.toLowerCase() === 'max-age=0');
    const isPartitioned = attributes.some((attribute) => attribute.toLowerCase() === 'partitioned');

    if (!isPartitioned && !this.allowUnpartitioned) {
      return;
    }

    if (shouldDelete) {
      this.values.delete(name);
    } else {
      this.values.set(name, value);
    }
  };
}

class FakeSocket implements ProbeWebSocket {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(private readonly echo: boolean) {
    queueMicrotask(() => this.onopen?.(new Event('open')));
  }

  send(data: string): void {
    this.onmessage?.({ data: 'endpoint greeting' });
    if (this.echo) {
      this.onmessage?.({ data });
    }
  }

  close(): void {}
}

function environment(
  overrides: Partial<BrowserProbeEnvironment> = {},
  cookies = new CookieJar(),
): BrowserProbeEnvironment {
  const storage = new MemoryStorage();
  let clock = 100;
  let uuid = 0;

  return {
    isSecureContext: () => true,
    readCookie: cookies.read,
    writeCookie: cookies.write,
    getLocalStorage: () => storage,
    createWebSocket: () => new FakeSocket(true),
    randomUUID: () => `uuid-${++uuid}`,
    now: () => ++clock,
    isoNow: () => '2026-07-13T12:00:00.000Z',
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    webSocketTimeoutMs: 100,
    ...overrides,
  };
}

const CROSS_SITE_EMBEDDED_CONTEXT: ProbeRunContext = {
  kind: 'embedded',
  isCrossSite: true,
};

describe('browser probe result factories', () => {
  it('creates complete idle and running maps', () => {
    const idle = createIdleResults();
    const running = createRunningResults();

    expect(Object.keys(idle)).toEqual([
      'websocket',
      'third-party-cookie',
      'partitioned-cookie',
      'local-storage',
    ]);
    expect(Object.values(idle).every((result) => result.status === 'idle')).toBe(true);
    expect(Object.values(running).every((result) => result.status === 'running')).toBe(true);
    expect(idle.websocket).not.toBe(running.websocket);
  });
});

describe('BrowserProbeService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('requires an exact WebSocket echo and emits running and final results', async () => {
    const emissions: string[] = [];
    const service = new BrowserProbeService(environment());

    const results = await service.runAll('wss://echo.example.test', null, (result) => {
      emissions.push(`${result.id}:${result.status}`);
    });

    expect(results.websocket.status).toBe('passed');
    expect(results.websocket.summary).toBe('Exact echo received');
    expect(results['third-party-cookie'].status).toBe('passed');
    expect(results['local-storage'].status).toBe('passed');
    expect(results['partitioned-cookie'].status).toBe('inconclusive');
    expect(emissions).toContain('websocket:running');
    expect(emissions).toContain('websocket:passed');
  });

  it('times out when the endpoint only sends a non-matching message', async () => {
    vi.useFakeTimers();
    const service = new BrowserProbeService(
      environment({
        createWebSocket: () => new FakeSocket(false),
        webSocketTimeoutMs: 25,
      }),
    );

    const resultPromise = service.runAll('wss://echo.example.test', null);
    await vi.runAllTimersAsync();
    const results = await resultPromise;

    expect(results.websocket.status).toBe('failed');
    expect(results.websocket.summary).toBe('WebSocket timed out');
    expect(results.websocket.diagnostics).toContain('Ignored a non-matching text message.');
  });

  it('reports first-party cookie and storage seeds as shared in the same bucket', async () => {
    const probeEnvironment = environment();
    const service = new BrowserProbeService(probeEnvironment);
    const prime = await service.createPrimeArtifacts('shared-run');

    const results = await service.runAll(
      'wss://echo.example.test',
      prime,
      undefined,
      CROSS_SITE_EMBEDDED_CONTEXT,
    );

    expect(prime.cookiePrepared).toBe(true);
    expect(prime.thirdPartyCookiePrepared).toBe(true);
    expect(prime.storagePrepared).toBe(true);
    expect(results['third-party-cookie'].status).toBe('shared');
    expect(results['partitioned-cookie'].status).toBe('shared');
    expect(results['local-storage'].status).toBe('shared');
  });

  it('reports prepared seeds as partitioned when a new bucket cannot see them', async () => {
    const firstPartyService = new BrowserProbeService(environment());
    const prime = await firstPartyService.createPrimeArtifacts('partitioned-run');
    const embeddedService = new BrowserProbeService(environment());

    const results = await embeddedService.runAll(
      'wss://echo.example.test',
      prime,
      undefined,
      CROSS_SITE_EMBEDDED_CONTEXT,
    );

    expect(results['third-party-cookie'].status).toBe('partitioned');
    expect(results['partitioned-cookie'].status).toBe('partitioned');
    expect(results['local-storage'].status).toBe('partitioned');
  });

  it('does not claim CHIPS from a cookie roundtrip without a first-party seed', async () => {
    const service = new BrowserProbeService(environment());

    const results = await service.runAll('wss://echo.example.test', null);

    expect(results['partitioned-cookie'].status).toBe('inconclusive');
    expect(results['partitioned-cookie'].detail).toContain('first-party seed');
  });

  it('classifies browser policy exceptions as blocked', async () => {
    const denied = new DOMException('Access denied by browser policy', 'SecurityError');
    const service = new BrowserProbeService(
      environment({
        readCookie: () => {
          throw denied;
        },
        writeCookie: () => {
          throw denied;
        },
        getLocalStorage: () => {
          throw denied;
        },
      }),
    );

    const results = await service.runAll('wss://echo.example.test', null);

    expect(results['partitioned-cookie'].status).toBe('blocked');
    expect(results['third-party-cookie'].status).toBe('blocked');
    expect(results['local-storage'].status).toBe('blocked');
    expect(results['partitioned-cookie'].diagnostics[0]).toContain('SecurityError');
  });

  it('records priming failures instead of throwing', async () => {
    const denied = new DOMException('Denied', 'SecurityError');
    const service = new BrowserProbeService(
      environment({
        isSecureContext: () => false,
        getLocalStorage: () => {
          throw denied;
        },
      }),
    );

    const prime = await service.createPrimeArtifacts('blocked-run');

    expect(prime.cookiePrepared).toBe(false);
    expect(prime.thirdPartyCookiePrepared).toBe(false);
    expect(prime.storagePrepared).toBe(false);
    expect(prime.errors).toHaveLength(3);
    expect(prime.errors.join(' ')).toContain('HTTPS');
    expect(prime.errors.join(' ')).toContain('SecurityError');
  });

  it('cleans up prepared artifacts without disturbing the service', async () => {
    const probeEnvironment = environment();
    const service = new BrowserProbeService(probeEnvironment);
    const prime = await service.createPrimeArtifacts('cleanup-run');

    service.cleanupPrimeArtifacts(prime);

    expect(probeEnvironment.readCookie?.()).not.toContain(`${prime.cookieName}=`);
    expect(probeEnvironment.readCookie?.()).not.toContain(`${prime.thirdPartyCookieName}=`);
    expect(probeEnvironment.getLocalStorage()?.getItem(prime.storageKey)).toBeNull();
  });

  it('treats an unprepared prime as inconclusive after successful CRUD', async () => {
    const service = new BrowserProbeService(environment());
    const prime: PrimeArtifacts = {
      runId: 'failed-prime',
      cookieName: '__Host-browser-tech-test-prime-missing',
      cookieValue: 'missing',
      thirdPartyCookieName: '__Host-browser-tech-test-third-party-prime-missing',
      thirdPartyCookieValue: 'missing',
      storageKey: 'browser-tech-test:prime:missing',
      storageValue: 'missing',
      cookiePrepared: false,
      thirdPartyCookiePrepared: false,
      storagePrepared: false,
      errors: ['The first-party setup was blocked.'],
    };

    const results = await service.runAll(
      'wss://echo.example.test',
      prime,
      undefined,
      CROSS_SITE_EMBEDDED_CONTEXT,
    );

    expect(results['third-party-cookie'].status).toBe('inconclusive');
    expect(results['partitioned-cookie'].status).toBe('inconclusive');
    expect(results['local-storage'].status).toBe('inconclusive');
  });

  it('does not claim third-party access without a first-party control', async () => {
    const service = new BrowserProbeService(environment());

    const results = await service.runAll(
      'wss://echo.example.test',
      null,
      undefined,
      CROSS_SITE_EMBEDDED_CONTEXT,
    );

    expect(results['third-party-cookie'].status).toBe('inconclusive');
    expect(results['third-party-cookie'].detail).toContain('no first-party seed');
  });

  it('does not treat a same-site iframe as a third-party cookie test', async () => {
    const probeEnvironment = environment();
    const service = new BrowserProbeService(probeEnvironment);
    const prime = await service.createPrimeArtifacts('same-origin-run');

    const results = await service.runAll('wss://echo.example.test', prime, undefined, {
      kind: 'embedded',
      isCrossSite: false,
    });

    expect(results['third-party-cookie'].status).toBe('inconclusive');
    expect(results['third-party-cookie'].summary).toBe('Same-site iframe');
  });

  it('treats a changed first-party cookie seed as inconclusive', async () => {
    const probeEnvironment = environment();
    const service = new BrowserProbeService(probeEnvironment);
    const prime = await service.createPrimeArtifacts('changed-seed-run');
    probeEnvironment.writeCookie?.(
      `${prime.thirdPartyCookieName}=changed; Path=/; Max-Age=600; SameSite=None; Secure`,
    );

    const results = await service.runAll(
      'wss://echo.example.test',
      prime,
      undefined,
      CROSS_SITE_EMBEDDED_CONTEXT,
    );

    expect(results['third-party-cookie'].status).toBe('inconclusive');
    expect(results['third-party-cookie'].summary).toBe('First-party seed changed');
    expect(results['third-party-cookie'].diagnostics).toContain('Observed seed value: changed');
  });

  it('reports third-party cookies as blocked when unpartitioned writes are rejected', async () => {
    const firstPartyService = new BrowserProbeService(environment());
    const prime = await firstPartyService.createPrimeArtifacts('blocked-third-party-run');
    const blockedCookies = new CookieJar(false);
    const embeddedService = new BrowserProbeService(environment({}, blockedCookies));

    const results = await embeddedService.runAll(
      'wss://echo.example.test',
      prime,
      undefined,
      CROSS_SITE_EMBEDDED_CONTEXT,
    );

    expect(results['third-party-cookie'].status).toBe('blocked');
    expect(results['partitioned-cookie'].status).toBe('partitioned');
    expect(results['third-party-cookie'].summary).toBe('Third-party cookie writes blocked');
  });

  it('uses unpartitioned SameSite=None cookies for the third-party probe', async () => {
    const cookies = new CookieJar();
    const service = new BrowserProbeService(environment({}, cookies));
    const prime = await service.createPrimeArtifacts('cookie-attributes-run');

    await service.runAll('wss://echo.example.test', prime, undefined, CROSS_SITE_EMBEDDED_CONTEXT);

    const thirdPartyWrites = cookies.writes.filter(
      (cookie) =>
        cookie.includes('browser-tech-test-third-party') && cookie.includes('Max-Age=600'),
    );
    expect(thirdPartyWrites.length).toBeGreaterThanOrEqual(2);
    thirdPartyWrites.forEach((cookie) => {
      expect(cookie).toContain('SameSite=None');
      expect(cookie).toContain('Secure');
      expect(cookie).not.toMatch(/;\s*Partitioned(?:;|$)/);
    });
    expect(cookies.read()).not.toContain('browser-tech-test-third-party-probe');
  });
});
