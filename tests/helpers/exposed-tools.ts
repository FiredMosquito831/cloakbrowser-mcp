// The 2.21.0 test rule: a test may only call a tool the last tools/list returned.
//
// The 2.20.0 meta-only deadlock was invisible to the suite because a harness
// called `browser_navigate` without ever asserting that the client had been told
// about it: `callTool` forwarded a name the broker had never exposed, the broker
// answered with an isError, and the test read that as "the hold works". A helper
// that records the exposed set and refuses an unexposed name turns that class of
// bug into a failing test at the call site, once, everywhere.
//
// The helper is deliberately transport-agnostic: any object with a `request`
// function shaped like JSON-RPC over MCP can be wrapped.

export interface JsonRpcLike {
  result?: {
    tools?: { name?: string }[];
    content?: { type?: string; text?: string }[];
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: { code: number; message: string };
}

export interface Requestable {
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<JsonRpcLike>;
}

export interface ExposedTools {
  /** The names the last tools/list returned (empty before the first one). */
  names(): string[];
  /** Run tools/list and record its names. */
  list(): Promise<string[]>;
  /**
   * Call a tool. Throws before sending anything when the name is not in the last
   * tools/list, which is exactly the situation the client would be in.
   */
  call(name: string, args?: Record<string, unknown>): Promise<JsonRpcLike>;
}

export function exposedTools(session: Requestable): ExposedTools {
  let current: string[] | null = null;
  return {
    names: () => (current === null ? [] : [...current]),
    list: async () => {
      const response = await session.request('tools/list', {});
      if (response.error !== undefined) {
        throw new Error(`tools/list failed: ${response.error.message}`);
      }
      current = (response.result?.tools ?? []).map((tool) => String(tool.name ?? ''));
      return [...current];
    },
    call: async (name, args = {}) => {
      if (current === null) {
        throw new Error(
          `the test called "${name}" before any tools/list: call list() first, because a client can ` +
            'only call a tool it was told about',
        );
      }
      if (!current.includes(name)) {
        throw new Error(
          `the test called "${name}", which the last tools/list did not return (exposed: ` +
            `${current.join(', ')}). This is the 2.20.0 meta-only deadlock: the client would have no ` +
            'such tool to call.',
        );
      }
      return session.request('tools/call', { name, arguments: args });
    },
  };
}
