import {
  isBrowserTestMessage,
  isFrameRunMessage,
  protocolMessage,
  PROTOCOL_CHANNEL,
  PROTOCOL_VERSION,
} from './frame-protocol';

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
      prime: null,
    } as never);

    expect(isBrowserTestMessage(malformed)).toBe(true);
    expect(isFrameRunMessage(malformed)).toBe(false);
  });
});
