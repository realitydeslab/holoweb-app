/**
 * Typed shim for the WKWebView boundary (window.webkit). This is the only place
 * that reads untyped host globals.
 */

/** A WKScriptMessageHandlerWithReply channel: postMessage resolves with the native reply. */
export interface ReplyMessageHandler {
  postMessage(message: unknown): Promise<unknown> | undefined;
}

export interface WebKitNamespace {
  messageHandlers?: Record<string, ReplyMessageHandler | undefined>;
  /** iOS 27 WKJSHandle factory; present when allowsJSHandleCreationInPageWorld is enabled. */
  createJSHandle?: (value: object) => unknown;
}

/** Transport used by the bridge. Implemented by WKWebView and by the desktop mock. */
export interface Transport {
  readonly kind: 'webkit' | 'mock' | 'none';
  post(message: Record<string, unknown>): Promise<unknown>;
  createHandle(value: object): unknown | null;
}

export function getWebKit(): WebKitNamespace | undefined {
  const host = globalThis as unknown as { webkit?: WebKitNamespace };
  return host.webkit;
}

export const HANDLER_NAME = 'holoweb';

/** Transport over window.webkit.messageHandlers.holoweb, or undefined if absent. */
export function webkitTransport(): Transport | undefined {
  const webkit = getWebKit();
  const handler = webkit?.messageHandlers?.[HANDLER_NAME];
  if (!webkit || !handler) return undefined;
  return {
    kind: 'webkit',
    post: async (message) => {
      // A handler registered without reply returns undefined; treat it as an empty reply.
      const reply = await handler.postMessage(message);
      return reply ?? {};
    },
    createHandle: (value) =>
      typeof webkit.createJSHandle === 'function' ? webkit.createJSHandle(value) : null,
  };
}

/** Transport that rejects every call; used when neither WebKit nor the mock is available. */
export function nullTransport(): Transport {
  return {
    kind: 'none',
    post: async () => {
      throw new DOMException('HoloWeb native bridge unavailable', 'NotSupportedError');
    },
    createHandle: () => null,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
