import {
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import {
  BrowserProbeService,
  PrimeArtifacts,
  ProbeId,
  ProbeResult,
  ProbeResultMap,
  ProbeStatus,
  PROBE_DEFINITIONS,
  createIdleResults,
  createRunningResults,
} from './browser-probes';
import {
  BrowserTestMessage,
  FrameResultsMessage,
  isBrowserTestMessage,
  isFrameResultsMessage,
  isFrameRunMessage,
  isPrimeReadyMessage,
  protocolMessage,
} from './frame-protocol';
import { isCrossSite } from './site';

type AppMode = 'host' | 'frame' | 'prime';

interface Comparison {
  label: string;
  detail: string;
  tone: ProbeStatus;
}

interface PrimeSession {
  local: boolean;
  popup: Window | null;
  prime: Promise<PrimeArtifacts | null>;
}

const DEFAULT_WEBSOCKET_URL = 'wss://ws.postman-echo.com/raw';
const FRAME_TIMEOUT_MS = 15_000;
const READY_TIMEOUT_MS = 7_000;
const PRIME_TIMEOUT_MS = 8_000;

@Component({
  selector: 'app-root',
  imports: [],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  @ViewChild('testFrame') private testFrame?: ElementRef<HTMLIFrameElement>;

  private readonly probes = inject(BrowserProbeService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly parentOrigin = new URLSearchParams(window.location.search).get('parentOrigin');
  private readonly openerOrigin = new URLSearchParams(window.location.search).get('openerOrigin');
  private currentRunId: string | null = null;
  private pendingFrameRun:
    | {
        runId: string;
        resolve: (results: ProbeResultMap) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    | undefined;
  private pendingPrime:
    | {
        runId: string;
        popup: Window;
        resolve: (prime: PrimeArtifacts | null) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    | undefined;
  private readyWaiters = new Set<() => void>();
  private primeArtifacts: PrimeArtifacts | null = null;

  protected readonly mode: AppMode = readMode();
  protected readonly probeDefinitions = PROBE_DEFINITIONS;
  protected readonly hostResults = signal<ProbeResultMap>(createIdleResults());
  protected readonly frameResults = signal<ProbeResultMap>(createIdleResults());
  protected readonly auxiliaryResults = signal<ProbeResultMap>(createIdleResults());
  protected readonly isRunning = signal(false);
  protected readonly frameReady = signal(false);
  protected readonly frameIssue = signal<string | null>(null);
  protected readonly configurationIssue = signal<string | null>(null);
  protected readonly copyState = signal('Copy JSON');
  protected readonly primeState = signal('Preparing first-party controls');
  protected readonly webSocketInput = signal(readQuery('ws') ?? DEFAULT_WEBSOCKET_URL);
  protected readonly frameInput = signal(readQuery('frame') ?? deploymentUrl());
  protected readonly appliedWebSocketUrl = signal(this.webSocketInput());
  protected readonly appliedFrameUrl = signal(this.frameInput());
  protected readonly frameSrc = signal(
    buildModeUrl(this.appliedFrameUrl(), 'frame', this.appliedWebSocketUrl()),
  );
  protected readonly trustedFrameSrc = computed<SafeResourceUrl>(() =>
    this.sanitizer.bypassSecurityTrustResourceUrl(this.frameSrc()),
  );
  protected readonly frameOrigin = computed(() => safeOrigin(this.frameSrc()));
  protected readonly contextRelationship = computed(() => {
    if (this.frameOrigin() === window.location.origin) {
      return 'Same origin';
    }
    return isCrossSite(window.location.origin, this.frameOrigin())
      ? 'Cross site'
      : 'Same site, cross origin';
  });
  protected readonly secureContextLabel = window.isSecureContext ? 'Secure context' : 'Not secure';
  protected readonly browserLabel = detectBrowser();
  protected readonly locationOrigin = window.location.origin;

  constructor() {
    window.addEventListener('message', this.handleMessage);
    this.destroyRef.onDestroy(() => {
      window.removeEventListener('message', this.handleMessage);
      this.clearPendingWork();
      if (this.primeArtifacts) {
        this.probes.cleanupPrimeArtifacts(this.primeArtifacts);
      }
    });
  }

  ngOnInit(): void {
    if (this.mode === 'frame') {
      queueMicrotask(() => this.announceFrameReady());
    } else if (this.mode === 'prime') {
      queueMicrotask(() => void this.preparePrimeContext());
    }
  }

  protected updateWebSocketInput(event: Event): void {
    this.webSocketInput.set((event.target as HTMLInputElement).value);
  }

  protected updateFrameInput(event: Event): void {
    this.frameInput.set((event.target as HTMLInputElement).value);
  }

  protected applyConfiguration(event: Event): void {
    event.preventDefault();

    try {
      const webSocketUrl = new URL(this.webSocketInput());
      const frameUrl = new URL(this.frameInput(), window.location.href);

      if (!['ws:', 'wss:'].includes(webSocketUrl.protocol)) {
        throw new Error('The WebSocket endpoint must use ws:// or wss://.');
      }
      if (!['http:', 'https:'].includes(frameUrl.protocol)) {
        throw new Error('The iframe URL must use http:// or https://.');
      }

      this.configurationIssue.set(null);
      this.appliedWebSocketUrl.set(webSocketUrl.toString());
      this.appliedFrameUrl.set(frameUrl.toString());
      this.frameReady.set(false);
      this.frameIssue.set(null);
      this.resetResults();
      this.frameSrc.set(buildModeUrl(this.appliedFrameUrl(), 'frame', this.appliedWebSocketUrl()));
      updateAddressBar(this.appliedFrameUrl(), this.appliedWebSocketUrl());
    } catch (error) {
      this.configurationIssue.set(errorMessage(error));
    }
  }

  protected async runAll(): Promise<void> {
    if (this.isRunning()) {
      return;
    }

    const runId = createRunId();
    this.currentRunId = runId;
    this.isRunning.set(true);
    this.frameIssue.set(null);
    this.hostResults.set(createRunningResults());
    this.frameResults.set(createRunningResults());

    // Open the cross-origin control synchronously while this call still has user activation.
    const primeSession = this.startPrimeSession(runId);
    const hostRun = this.probes.runAll(this.appliedWebSocketUrl(), null, (result) =>
      this.setResult(this.hostResults, result),
    );

    let prime: PrimeArtifacts | null = null;
    try {
      prime = await primeSession.prime;
      const [, frameResults] = await Promise.all([hostRun, this.requestFrameResults(runId, prime)]);
      this.frameResults.set(frameResults);
    } catch (error) {
      this.frameIssue.set(errorMessage(error));
      this.frameResults.set(unavailableResults(errorMessage(error)));
      await hostRun;
    } finally {
      this.finishPrimeSession(primeSession, prime);
      if (this.currentRunId === runId) {
        this.isRunning.set(false);
        this.currentRunId = null;
      }
    }
  }

  protected resetResults(): void {
    this.hostResults.set(createIdleResults());
    this.frameResults.set(createIdleResults());
    this.frameIssue.set(null);
    this.copyState.set('Copy JSON');
  }

  protected async copyReport(): Promise<void> {
    const report = JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        pageUrl: window.location.href,
        pageOrigin: window.location.origin,
        frameUrl: this.frameSrc(),
        frameOrigin: this.frameOrigin(),
        contextRelationship: this.contextRelationship(),
        secureContext: window.isSecureContext,
        userAgent: navigator.userAgent,
        webSocketUrl: this.appliedWebSocketUrl(),
        outsideIframe: this.hostResults(),
        insideIframe: this.frameResults(),
      },
      null,
      2,
    );

    try {
      await writeClipboard(report);
      this.copyState.set('Copied');
    } catch {
      this.copyState.set('Copy failed');
    }
    window.setTimeout(() => this.copyState.set('Copy JSON'), 1800);
  }

  protected resultFor(results: ProbeResultMap, id: ProbeId): ProbeResult {
    return results[id];
  }

  protected statusLabel(status: ProbeStatus): string {
    return STATUS_LABELS[status];
  }

  protected statusDescription(status: ProbeStatus): string {
    return STATUS_DESCRIPTIONS[status];
  }

  protected formatTimestamp(timestamp: string): string {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? timestamp : DIAGNOSTIC_TIME_FORMATTER.format(date);
  }

  protected diagnosticTarget(id: ProbeId): string {
    if (id === 'websocket') {
      return `Exact echo response from ${this.appliedWebSocketUrl()}`;
    }
    return DIAGNOSTIC_TARGETS[id];
  }

  protected comparisonFor(id: ProbeId): Comparison {
    const outside = this.hostResults()[id];
    const inside = this.frameResults()[id];

    if (outside.status === 'idle' || inside.status === 'idle') {
      return { label: 'Not run', detail: 'No comparison available', tone: 'idle' };
    }
    if (outside.status === 'running' || inside.status === 'running') {
      return { label: 'Running', detail: 'Waiting for both contexts', tone: 'running' };
    }
    if (id === 'third-party-cookie') {
      return this.thirdPartyCookieComparison(inside);
    }
    if (inside.status === 'partitioned') {
      return {
        label: 'Partitioned',
        detail: 'The iframe was isolated from its first-party control',
        tone: 'partitioned',
      };
    }
    if (inside.status === 'shared') {
      return {
        label: 'Shared',
        detail: 'The iframe observed its first-party control value',
        tone: 'shared',
      };
    }
    if (outside.status === 'passed' && inside.status === 'passed') {
      return {
        label: 'Both available',
        detail: 'The operation completed in both browsing contexts',
        tone: 'passed',
      };
    }
    if (inside.status === 'blocked') {
      return { label: 'Iframe blocked', detail: inside.summary, tone: 'blocked' };
    }
    if (inside.status === 'inconclusive' || outside.status === 'inconclusive') {
      return {
        label: 'Inconclusive',
        detail: 'The round trip did not prove partition isolation',
        tone: 'inconclusive',
      };
    }

    return {
      label: 'Different result',
      detail: `${outside.summary} / ${inside.summary}`,
      tone: inside.status,
    };
  }

  private thirdPartyCookieComparison(inside: ProbeResult): Comparison {
    if (!isCrossSite(window.location.origin, this.frameOrigin())) {
      return {
        label: 'Same-site control',
        detail: 'Configure a cross-site iframe to exercise third-party cookie policy',
        tone: 'inconclusive',
      };
    }
    if (inside.status === 'shared') {
      return {
        label: 'JavaScript access available',
        detail: 'The iframe read and wrote the JavaScript-visible unpartitioned cookie',
        tone: 'shared',
      };
    }
    if (inside.status === 'partitioned') {
      return {
        label: 'Isolated in iframe',
        detail: 'Cookie writes work, but the first-party cookie is not visible',
        tone: 'partitioned',
      };
    }
    if (inside.status === 'blocked') {
      return {
        label: 'Blocked in iframe',
        detail: inside.summary,
        tone: 'blocked',
      };
    }
    if (inside.status === 'inconclusive') {
      return {
        label: 'Inconclusive',
        detail: inside.summary,
        tone: 'inconclusive',
      };
    }

    return {
      label: inside.status === 'unsupported' ? 'Unsupported' : 'Probe failed',
      detail: inside.summary,
      tone: inside.status,
    };
  }

  protected closePrime(): void {
    if (this.primeArtifacts) {
      this.probes.cleanupPrimeArtifacts(this.primeArtifacts);
      this.primeArtifacts = null;
    }
    window.close();
  }

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    if (!isBrowserTestMessage(event.data)) {
      return;
    }

    if (this.mode === 'frame') {
      this.handleFrameCommand(event, event.data);
      return;
    }
    if (this.mode === 'prime') {
      this.handlePrimeCommand(event, event.data);
      return;
    }

    const frameWindow = this.testFrame?.nativeElement.contentWindow;
    if (frameWindow && event.source === frameWindow && event.origin === this.frameOrigin()) {
      if (event.data.type === 'frame-ready') {
        this.frameReady.set(true);
        this.readyWaiters.forEach((resolve) => resolve());
        this.readyWaiters.clear();
      } else if (isFrameResultsMessage(event.data)) {
        this.resolveFrameResults(event.data);
      }
      return;
    }

    const pendingPrime = this.pendingPrime;
    if (
      pendingPrime &&
      event.source === pendingPrime.popup &&
      event.origin === this.frameOrigin() &&
      isPrimeReadyMessage(event.data) &&
      event.data.runId === pendingPrime.runId
    ) {
      clearTimeout(pendingPrime.timeout);
      this.pendingPrime = undefined;
      pendingPrime.resolve(event.data.prime);
    }
  };

  private handleFrameCommand(event: MessageEvent<unknown>, message: BrowserTestMessage): void {
    if (
      !this.parentOrigin ||
      event.source !== window.parent ||
      event.origin !== this.parentOrigin ||
      !isFrameRunMessage(message)
    ) {
      return;
    }

    this.auxiliaryResults.set(createRunningResults());
    void this.probes
      .runAll(
        message.webSocketUrl,
        message.prime,
        (result) => this.setResult(this.auxiliaryResults, result),
        {
          kind: 'embedded',
          isCrossSite: message.isCrossSite,
        },
      )
      .then((results) => {
        window.parent.postMessage(
          protocolMessage<FrameResultsMessage>({
            type: 'frame-results',
            runId: message.runId,
            results,
          }),
          this.parentOrigin!,
        );
      });
  }

  private handlePrimeCommand(event: MessageEvent<unknown>, message: BrowserTestMessage): void {
    const runId = readQuery('runId');
    if (
      !runId ||
      !this.openerOrigin ||
      event.source !== window.opener ||
      event.origin !== this.openerOrigin ||
      message.type !== 'prime-cleanup' ||
      message.runId !== runId
    ) {
      return;
    }
    this.closePrime();
  }

  private announceFrameReady(): void {
    if (!this.parentOrigin || window.parent === window) {
      return;
    }
    window.parent.postMessage(protocolMessage({ type: 'frame-ready' }), this.parentOrigin);
  }

  private async preparePrimeContext(): Promise<void> {
    const runId = readQuery('runId');
    if (!runId) {
      this.primeState.set('Missing run identifier');
      return;
    }

    this.primeArtifacts = await this.probes.createPrimeArtifacts(runId);
    this.primeState.set('First-party controls ready');
    if (window.opener && this.openerOrigin) {
      window.opener.postMessage(
        protocolMessage({
          type: 'prime-ready',
          runId,
          prime: this.primeArtifacts,
        }),
        this.openerOrigin,
      );
    }
  }

  private startPrimeSession(runId: string): PrimeSession {
    if (this.frameOrigin() === window.location.origin) {
      return {
        local: true,
        popup: null,
        prime: Promise.resolve(this.probes.createPrimeArtifacts(runId)),
      };
    }

    const popupUrl = buildModeUrl(
      this.appliedFrameUrl(),
      'prime',
      this.appliedWebSocketUrl(),
      runId,
    );
    const popup = window.open(popupUrl, 'browser-tech-test-prime', 'popup,width=520,height=420');
    if (!popup) {
      return { local: false, popup: null, prime: Promise.resolve(null) };
    }

    const prime = new Promise<PrimeArtifacts | null>((resolve) => {
      const timeout = window.setTimeout(() => {
        if (this.pendingPrime?.runId === runId) {
          this.pendingPrime = undefined;
        }
        resolve(null);
      }, PRIME_TIMEOUT_MS);
      this.pendingPrime = { runId, popup, resolve, timeout };
    });

    return { local: false, popup, prime };
  }

  private finishPrimeSession(session: PrimeSession, prime: PrimeArtifacts | null): void {
    if (session.local && prime) {
      this.probes.cleanupPrimeArtifacts(prime);
      return;
    }

    if (session.popup && !session.popup.closed) {
      session.popup.postMessage(
        protocolMessage({
          type: 'prime-cleanup',
          runId: prime?.runId ?? this.currentRunId ?? '',
        }),
        this.frameOrigin(),
      );
      window.setTimeout(() => session.popup?.close(), 1000);
    }
  }

  private async requestFrameResults(
    runId: string,
    prime: PrimeArtifacts | null,
  ): Promise<ProbeResultMap> {
    await this.waitForFrameReady();
    const frameWindow = this.testFrame?.nativeElement.contentWindow;
    if (!frameWindow) {
      throw new Error('The iframe window is unavailable.');
    }

    const resultPromise = new Promise<ProbeResultMap>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pendingFrameRun = undefined;
        reject(new Error('The iframe did not return results before the timeout.'));
      }, FRAME_TIMEOUT_MS);
      this.pendingFrameRun = { runId, resolve, timeout };
    });

    frameWindow.postMessage(
      protocolMessage({
        type: 'frame-run',
        runId,
        webSocketUrl: this.appliedWebSocketUrl(),
        isCrossSite: isCrossSite(window.location.origin, this.frameOrigin()),
        prime,
      }),
      this.frameOrigin(),
    );
    return resultPromise;
  }

  private waitForFrameReady(): Promise<void> {
    if (this.frameReady()) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const ready = (): void => {
        clearTimeout(timeout);
        resolve();
      };
      const timeout = window.setTimeout(() => {
        this.readyWaiters.delete(ready);
        reject(new Error('The iframe did not become ready. Check its URL and origin.'));
      }, READY_TIMEOUT_MS);
      this.readyWaiters.add(ready);
    });
  }

  private resolveFrameResults(message: FrameResultsMessage): void {
    const pending = this.pendingFrameRun;
    if (!pending || pending.runId !== message.runId) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingFrameRun = undefined;
    pending.resolve(message.results);
  }

  private setResult(
    target: { update: (updater: (current: ProbeResultMap) => ProbeResultMap) => void },
    result: ProbeResult,
  ): void {
    target.update((current) => ({ ...current, [result.id]: result }));
  }

  private clearPendingWork(): void {
    if (this.pendingFrameRun) {
      clearTimeout(this.pendingFrameRun.timeout);
    }
    if (this.pendingPrime) {
      clearTimeout(this.pendingPrime.timeout);
    }
    this.pendingFrameRun = undefined;
    this.pendingPrime = undefined;
    this.readyWaiters.clear();
  }
}

const STATUS_LABELS: Record<ProbeStatus, string> = {
  idle: 'Not run',
  running: 'Running',
  passed: 'Passed',
  partitioned: 'Partitioned',
  shared: 'Shared',
  blocked: 'Blocked',
  failed: 'Failed',
  unsupported: 'Unsupported',
  inconclusive: 'Inconclusive',
};

const STATUS_DESCRIPTIONS: Record<ProbeStatus, string> = {
  idle: 'This test has not been run yet.',
  running: 'This test is currently in progress.',
  passed: 'The operation completed successfully in this browser context.',
  partitioned: 'The iframe is isolated from the matching first-party value.',
  shared: 'The iframe can access the matching first-party value.',
  blocked: 'The browser prevented access to a feature required by this test.',
  failed: 'The operation did not complete successfully.',
  unsupported: 'This browser does not support a feature required by this test.',
  inconclusive: 'The test completed without producing a definitive result.',
};

const DIAGNOSTIC_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const DIAGNOSTIC_TARGETS: Record<Exclude<ProbeId, 'websocket'>, string> = {
  'third-party-cookie':
    'JavaScript-visible unpartitioned SameSite=None cookie write, read, removal, and first-party seed visibility',
  'partitioned-cookie':
    'Secure partitioned cookie write, read, removal, and first-party seed visibility',
  'local-storage': 'Local storage write, read, overwrite, removal, and first-party seed visibility',
};

function readMode(): AppMode {
  const mode = readQuery('mode');
  return mode === 'frame' || mode === 'prime' ? mode : 'host';
}

function readQuery(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

function deploymentUrl(): string {
  const url = new URL(window.location.href);
  ['mode', 'parentOrigin', 'openerOrigin', 'runId', 'frame', 'ws'].forEach((key) =>
    url.searchParams.delete(key),
  );
  url.hash = '';
  return url.toString();
}

function buildModeUrl(
  input: string,
  mode: 'frame' | 'prime',
  webSocketUrl: string,
  runId?: string,
): string {
  const url = new URL(input, window.location.href);
  ['frame', 'parentOrigin', 'openerOrigin', 'runId'].forEach((key) => url.searchParams.delete(key));
  url.searchParams.set('mode', mode);
  url.searchParams.set('ws', webSocketUrl);
  if (mode === 'frame') {
    url.searchParams.set('parentOrigin', window.location.origin);
  } else {
    url.searchParams.set('openerOrigin', window.location.origin);
    if (runId) {
      url.searchParams.set('runId', runId);
    }
  }
  return url.toString();
}

function updateAddressBar(frameUrl: string, webSocketUrl: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('frame', frameUrl);
  url.searchParams.set('ws', webSocketUrl);
  window.history.replaceState(null, '', url);
}

function safeOrigin(url: string): string {
  try {
    return new URL(url, window.location.href).origin;
  } catch {
    return '';
  }
}

function createRunId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function detectBrowser(): string {
  const userAgent = navigator.userAgent;
  const match = userAgent.match(/(Firefox|Edg|Chrome|Safari)\/?\s?([\d.]+)/);
  return match ? `${match[1]} ${match[2]}` : 'Current browser';
}

function unavailableResults(detail: string): ProbeResultMap {
  const result = (id: ProbeId): ProbeResult => ({
    id,
    status: 'failed',
    summary: 'Iframe unavailable',
    detail,
    checkedAt: new Date().toISOString(),
    diagnostics: [],
  });

  return {
    websocket: result('websocket'),
    'third-party-cookie': result('third-party-cookie'),
    'partitioned-cookie': result('partitioned-cookie'),
    'local-storage': result('local-storage'),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writeClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) {
    throw new Error('Clipboard access was denied.');
  }
}
