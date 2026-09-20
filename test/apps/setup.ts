///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// Global setup for the frontend (apps/www) test suite. Vitest applies `setupFiles` across every test
// environment configured for this project, including the plain `node` environment the backend
// `test/**/*.test.ts` suite runs under — guard everything here on `document` actually existing so this
// file is a no-op for those tests rather than throwing on a DOM API that isn't present.
import "@testing-library/jest-dom/vitest";

if (typeof document !== "undefined") {
    const { cleanup } = await import("@testing-library/react");
    const { resetPushClient } = await import("@rapidmx/react-shared/mail/pushClient.js");
    afterEach(() => {
        cleanup();
        // The tab's one push client (see `useMailLiveUpdates()`) outlives a component; a test that stubs the WebSocket
        // must not inherit the previous test's connection - or, once a sign-out closed it, a client that never reopens.
        resetPushClient();
        // jsdom keeps one `localStorage` for the whole file, so a preference a test leaves behind (the mail
        // list's own sort/filter/conversation settings, the local-index byte budget) would silently become
        // the *next* test's starting state - and did, before this line existed.
        localStorage.clear();
    });

    // jsdom doesn't implement `window.matchMedia` at all (confirmed: it's simply `undefined`, not a
    // stub that always returns non-matching). Default every test to "never matches" (i.e. `useIsMobile()`
    // reads as desktop, exactly today's pre-mobile-refactor behavior) so the many existing tests that
    // don't know `useIsMobile` exists keep passing unmodified; a test that needs the mobile branch calls
    // `mockMatchMedia(true)` (see `testUtils.ts`) to override this default.
    if (typeof window.matchMedia !== "function") {
        window.matchMedia = (query: string) =>
            ({
                matches: false,
                media: query,
                onchange: null,
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
                addListener: vi.fn(),
                removeListener: vi.fn(),
                dispatchEvent: vi.fn(() => false),
            }) as MediaQueryList;
    }

    // jsdom's own WebSocket really tries to connect - to the test page's origin, where nothing listens - and then
    // reconnects forever. `MailShell` opens the push socket (see `useMailLiveUpdates()`), so default every test to one
    // that never connects and never closes; a test of the push behavior swaps in its own fake with `vi.stubGlobal()`.
    (window as any).WebSocket = class NeverConnectingWebSocket {
        readyState = 0;
        onopen = null;
        onmessage = null;
        onclose = null;
        onerror = null;
        send() {
            // Nothing is ever delivered.
        }
        close() {
            // Nothing to close.
        }
    };

    // jsdom implements no layout, so `Element.scrollIntoView` doesn't exist at all — a component that
    // scrolls the message it just opened into view (`ConversationThreadPane`) would throw on render. A
    // test that cares about where it scrolled spies on this.
    if (typeof Element.prototype.scrollIntoView !== "function") {
        Element.prototype.scrollIntoView = vi.fn();
    }

    // jsdom doesn't implement `IntersectionObserver` at all — default to a no-op stub (never fires) so the
    // many tests that don't care about infinite-scroll behavior keep passing unmodified; a test that needs
    // to simulate a sentinel intersecting uses `mockIntersectionObserver()` (see `testUtils.ts`) to override
    // this default and capture the real callback to invoke manually.
    if (typeof (window as any).IntersectionObserver !== "function") {
        (window as any).IntersectionObserver = vi.fn().mockImplementation(function () {
            return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
        });
    }
}
