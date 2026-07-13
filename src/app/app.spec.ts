import { TestBed } from '@angular/core/testing';
import { App } from './app';

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
    expect(compiled.querySelectorAll('.matrix-row')).toHaveLength(3);
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
});
