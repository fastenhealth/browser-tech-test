import { isCrossSite } from './site';

describe('isCrossSite', () => {
  it('treats subdomains and port changes on one registrable domain as same-site', () => {
    expect(isCrossSite('https://app.example.com:8443', 'https://auth.example.com')).toBe(false);
  });

  it('uses schemeful site boundaries', () => {
    expect(isCrossSite('http://app.example.com', 'https://auth.example.com')).toBe(true);
  });

  it('includes private suffixes such as github.io', () => {
    expect(
      isCrossSite(
        'https://first-owner.github.io/browser-tech-test/',
        'https://second-owner.github.io/browser-tech-test/',
      ),
    ).toBe(true);
  });

  it('treats identical localhost sites as same-site', () => {
    expect(isCrossSite('http://localhost:4200', 'http://localhost:4300')).toBe(false);
  });
});
