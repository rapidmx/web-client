///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { vi } from "vitest";
import { ACCEPT } from "../../../apps/shared/components/mail/reading/bodyContent.js";

/**
 * `mockFetch()` for the reading pane's tests. The pane's body asks the server for its own sanitized content (`GET /mail/messages/:id/content`,
 * the request that says it accepts `ACCEPT`) on top of whatever the pane's actions request; a test's handler is written for the actions and would
 * answer that request with an error, or count it. This answers only that one request - with a sanitized body - and hands every other request to
 * `impl`, so `fetchMock.mock.calls` is exactly what the test's own handler saw (the compose window's own read of the same URL, for quoting,
 * still reaches `impl`).
 */
export function mockFetchWithServerBody(
    impl: (url: string, init: RequestInit) => Response | Promise<Response>,
    body = "<p>Server body</p>",
): ReturnType<typeof vi.fn> {
    const inner = vi.fn(impl);
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
        String(url).endsWith("/content") && new Headers(init?.headers).get("accept") === ACCEPT
            ? Promise.resolve(new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } }))
            : inner(url, init as RequestInit),
    );
    return inner;
}
