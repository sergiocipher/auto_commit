// Structural types for the I/O that core needs injected. Both the browser
// fetch and Node 22's fetch satisfy HttpFetch, so neither runtime's typings
// are required here.

export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export type HttpFetch = (url: string, init?: HttpRequestInit) => Promise<HttpResponse>;

/** Epoch milliseconds. */
export type Clock = () => number;
