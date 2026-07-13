import {
  isBrowserTestMessage,
  isFrameResultsMessage,
  isFrameRunMessage,
  isPrimeReadyMessage,
  protocolMessage,
  PROTOCOL_CHANNEL,
  PROTOCOL_VERSION,
} from './frame-protocol';
import { createIdleResults, PrimeArtifacts } from './browser-probes';

const prime: PrimeArtifacts = {
  runId: 'run-1',
  cookieName: 'partitioned-cookie',
  cookieValue: 'partitioned-value',
  thirdPartyCookieName: 'third-party-cookie',
  thirdPartyCookieValue: 'third-party-value',
  storageKey: 'storage-key',
  storageValue: 'storage-value',
  cookiePrepared: true,
  thirdPartyCookiePrepared: true,
  storagePrepared: true,
  errors: [],
};

describe('frame protocol', () => {
  it('creates a versioned protocol envelope', () => {
    const message = protocolMessage({ type: 'frame-ready' });

    expect(message).toEqual({
      channel: PROTOCOL_CHANNEL,
      version: PROTOCOL_VERSION,
      type: 'frame-ready',
    });
  });

  it('rejects unrelated and unsupported messages', () => {
    expect(isBrowserTestMessage(null)).toBe(false);
    expect(isBrowserTestMessage({ type: 'frame-ready' })).toBe(false);
    expect(
      isBrowserTestMessage({
        channel: PROTOCOL_CHANNEL,
        version: PROTOCOL_VERSION + 1,
        type: 'frame-ready',
      }),
    ).toBe(false);
    expect(
      isBrowserTestMessage({
        channel: PROTOCOL_CHANNEL,
        version: PROTOCOL_VERSION,
        type: 'unknown',
      }),
    ).toBe(false);
  });

  it('validates run-specific fields before dispatch', () => {
    const malformed = protocolMessage({
      type: 'frame-run',
      runId: 42,
      webSocketUrl: 'wss://example.test',
      isCrossSite: true,
      prime: null,
    } as never);

    expect(isBrowserTestMessage(malformed)).toBe(true);
    expect(isFrameRunMessage(malformed)).toBe(false);
  });

  it('accepts complete third-party cookie control data', () => {
    const runMessage = protocolMessage({
      type: 'frame-run',
      runId: 'run-1',
      webSocketUrl: 'wss://example.test',
      isCrossSite: true,
      prime,
    });
    const primeMessage = protocolMessage({
      type: 'prime-ready',
      runId: 'run-1',
      prime,
    });

    expect(isFrameRunMessage(runMessage)).toBe(true);
    expect(isPrimeReadyMessage(primeMessage)).toBe(true);
  });

  it('requires every canonical probe in frame results', () => {
    const complete = protocolMessage({
      type: 'frame-results',
      runId: 'run-1',
      results: createIdleResults(),
    });
    const incompleteResults = createIdleResults() as Partial<ReturnType<typeof createIdleResults>>;
    delete incompleteResults['third-party-cookie'];
    const incomplete = protocolMessage({
      type: 'frame-results',
      runId: 'run-1',
      results: incompleteResults,
    } as never);

    expect(isFrameResultsMessage(complete)).toBe(true);
    expect(isFrameResultsMessage(incomplete)).toBe(false);
  });

  it('rejects stale prime payloads without the third-party cookie control', () => {
    const message = protocolMessage({
      type: 'prime-ready',
      runId: 'run-1',
      prime: {
        runId: 'run-1',
        cookieName: 'cookie',
        cookieValue: 'value',
        storageKey: 'key',
        storageValue: 'value',
        cookiePrepared: true,
        storagePrepared: true,
        errors: [],
      },
    } as never);

    expect(isBrowserTestMessage(message)).toBe(true);
    expect(isPrimeReadyMessage(message)).toBe(false);
  });
});
