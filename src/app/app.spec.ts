import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { createIdleResults, ProbeResultMap } from './browser-probes';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render title', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('Browser Context Lab');
    expect(compiled.querySelectorAll('.matrix-row')).toHaveLength(4);
    expect(compiled.querySelector('[data-probe="third-party-cookie"]')).not.toBeNull();
  });

  it('should expose canonical probe statuses for browser tests', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;

    const outsideStatus = compiled.querySelector('[data-testid="websocket-outside-status"]');
    const comparisonStatus = compiled.querySelector('[data-testid="websocket-comparison-status"]');

    expect(outsideStatus?.textContent?.trim()).toBe('Not run');
    expect(outsideStatus?.getAttribute('data-status')).toBe('idle');
    expect(comparisonStatus?.textContent?.trim()).toBe('Not run');
    expect(comparisonStatus?.getAttribute('data-status')).toBe('idle');
  });

  it('should explain probe statuses with hover tooltips', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    const statuses = compiled.querySelectorAll<HTMLElement>('.status');

    expect(statuses).toHaveLength(12);
    statuses.forEach((status) => {
      expect(status.title).toBe('This test has not been run yet.');
    });
  });

  it('should show detailed diagnostics for completed probe results', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    const results = createIdleResults();

    results.websocket = {
      ...results.websocket,
      status: 'failed',
      summary: 'WebSocket connection failed',
      detail: 'The endpoint rejected the connection.',
      checkedAt: '2026-07-13T12:34:56.000Z',
      durationMs: 125.4,
      diagnostics: ['Connection closed with code 1006.'],
    };
    results['partitioned-cookie'] = {
      ...results['partitioned-cookie'],
      status: 'blocked',
      summary: 'HTTPS required',
      detail: 'Secure cookies cannot be tested in this context.',
      checkedAt: '2026-07-13T12:34:57.000Z',
      durationMs: 0.2,
      diagnostics: [],
    };
    (
      fixture.componentInstance as unknown as {
        hostResults: { set(results: ProbeResultMap): void };
      }
    ).hostResults.set(results);
    fixture.detectChanges();

    const diagnostics = compiled.querySelector<HTMLDetailsElement>(
      '[data-testid="websocket-outside-diagnostics"]',
    );

    expect(diagnostics).not.toBeNull();
    expect(diagnostics?.open).toBe(false);
    expect(diagnostics?.textContent).toContain('Top-level page');
    expect(diagnostics?.textContent).toContain(window.location.origin);
    expect(diagnostics?.textContent).toContain('Failed');
    expect(diagnostics?.textContent).toContain('failed');
    expect(diagnostics?.textContent).toContain('125.4 ms');
    expect(diagnostics?.textContent).toContain('Exact echo response from');
    expect(diagnostics?.textContent).toContain('Connection closed with code 1006.');
    expect(diagnostics?.querySelector('time')?.dateTime).toBe('2026-07-13T12:34:56.000Z');

    const emptyDiagnostics = compiled.querySelector<HTMLDetailsElement>(
      '[data-testid="partitioned-cookie-outside-diagnostics"]',
    );
    expect(emptyDiagnostics?.textContent).toContain('Secure partitioned cookie write');
    expect(emptyDiagnostics?.textContent).toContain(
      'No additional browser messages were reported.',
    );
  });

  it('should not classify a same-site iframe as a third-party cookie success', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    const hostResults = createIdleResults();
    const frameResults = createIdleResults();

    hostResults['third-party-cookie'] = {
      ...hostResults['third-party-cookie'],
      status: 'passed',
      summary: 'First-party cookie roundtrip passed',
      detail: 'The top-level baseline passed.',
    };
    frameResults['third-party-cookie'] = {
      ...frameResults['third-party-cookie'],
      status: 'shared',
      summary: 'Third-party cookie available',
      detail: 'The iframe observed the seed.',
    };
    const component = fixture.componentInstance as unknown as {
      hostResults: { set(results: ProbeResultMap): void };
      frameResults: { set(results: ProbeResultMap): void };
    };
    component.hostResults.set(hostResults);
    component.frameResults.set(frameResults);
    fixture.detectChanges();

    const comparison = compiled.querySelector(
      '[data-testid="third-party-cookie-comparison-status"]',
    );
    const row = compiled.querySelector('[data-probe="third-party-cookie"]');

    expect(comparison?.getAttribute('data-status')).toBe('inconclusive');
    expect(row?.textContent).toContain('Same-site control');
    expect(row?.textContent).toContain('Configure a cross-site iframe');
  });
});
