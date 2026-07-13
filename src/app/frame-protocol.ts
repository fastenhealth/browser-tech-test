import { PrimeArtifacts, ProbeResultMap } from './browser-probes';

export const PROTOCOL_CHANNEL = 'browser-tech-test';
export const PROTOCOL_VERSION = 1;

interface ProtocolEnvelope {
  channel: typeof PROTOCOL_CHANNEL;
  version: typeof PROTOCOL_VERSION;
}

export interface FrameReadyMessage extends ProtocolEnvelope {
  type: 'frame-ready';
}

export interface FrameRunMessage extends ProtocolEnvelope {
  type: 'frame-run';
  runId: string;
  webSocketUrl: string;
  prime: PrimeArtifacts | null;
}

export interface FrameResultsMessage extends ProtocolEnvelope {
  type: 'frame-results';
  runId: string;
  results: ProbeResultMap;
}

export interface PrimeReadyMessage extends ProtocolEnvelope {
  type: 'prime-ready';
  runId: string;
  prime: PrimeArtifacts;
}

export interface PrimeCleanupMessage extends ProtocolEnvelope {
  type: 'prime-cleanup';
  runId: string;
}

export type BrowserTestMessage =
  | FrameReadyMessage
  | FrameRunMessage
  | FrameResultsMessage
  | PrimeReadyMessage
  | PrimeCleanupMessage;

const messageTypes = new Set<BrowserTestMessage['type']>([
  'frame-ready',
  'frame-run',
  'frame-results',
  'prime-ready',
  'prime-cleanup',
]);

type ProtocolBody<T extends BrowserTestMessage> = T extends BrowserTestMessage
  ? Omit<T, 'channel' | 'version'>
  : never;

export function protocolMessage<T extends BrowserTestMessage>(message: ProtocolBody<T>): T {
  return {
    channel: PROTOCOL_CHANNEL,
    version: PROTOCOL_VERSION,
    ...message,
  } as T;
}

export function isBrowserTestMessage(value: unknown): value is BrowserTestMessage {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value['channel'] === PROTOCOL_CHANNEL &&
    value['version'] === PROTOCOL_VERSION &&
    typeof value['type'] === 'string' &&
    messageTypes.has(value['type'] as BrowserTestMessage['type'])
  );
}

export function isFrameRunMessage(message: BrowserTestMessage): message is FrameRunMessage {
  return (
    message.type === 'frame-run' &&
    typeof message.runId === 'string' &&
    typeof message.webSocketUrl === 'string' &&
    (message.prime === null || isRecord(message.prime))
  );
}

export function isFrameResultsMessage(message: BrowserTestMessage): message is FrameResultsMessage {
  return (
    message.type === 'frame-results' &&
    typeof message.runId === 'string' &&
    isRecord(message.results)
  );
}

export function isPrimeReadyMessage(message: BrowserTestMessage): message is PrimeReadyMessage {
  return (
    message.type === 'prime-ready' && typeof message.runId === 'string' && isRecord(message.prime)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
