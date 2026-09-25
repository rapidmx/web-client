///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// Global setup for the frontend (apps/www) test suite. Vitest applies `setupFiles` across every test
// environment configured for this project, including the plain `node` environment the backend
// `test/**/*.test.ts` suite runs under — guard everything here on `document` actually existing so this
// file is a no-op for those tests rather than throwing on a DOM API that isn't present.
import "@testing-library/jest-dom/vitest";

if (typeof document !== "undefined") {
    const { cleanup, configure } = await import("@testing-library/react");
    // How long a `findBy*()` / `waitFor()` keeps looking before it gives up (one second by default). It returns the moment
    // what it waits for is there, so this only matters when something is slow: the first render of a page imports its
    // heaviest code (the reading pane, the compose window) and transforms it on demand, which takes seconds on a busy CI
    // runner (measured here: over five seconds with the machine kept busy). Waiting for a condition that never comes still fails - just
    // after this, not after one second.
    configure({ asyncUtilTimeout: 10_000 });
    const { resetPushClient } = await import("@rapidmx/react-shared/mail/pushClient.js");
    const { clearListSnapshots } = await import("../../apps/shared/mail/listSnapshots.js");
    const { clearOriginalMessageCache } = await import("../../apps/shared/components/mail/compose/quotedBody.js");
    const { resetNotifications } = await import("../../apps/shared/notifications/store.js");
    const { resetPendingSends } = await import("../../apps/shared/mail/outbox/pendingSends.js");
    const { resetSendJobs } = await import("../../apps/shared/mail/outbox/sendState.js");
    const { resetOutgoingReplies } = await import("../../apps/shared/mail/outbox/outgoingReplies.js");
    const { setApiUnauthorizedObserver } = await import("@rapidmx/react-shared/util/api.js");
    // `window.location` (a stub, so `location.href = ...` can be asserted on) and the window's size are replaced by tests with
    // `Object.defineProperty()`, which nothing undoes: jsdom keeps one window for the whole file, so a test that ran after one of
    // those would read a stub's (empty) `search` where it set `?folderUid=` - and pass or fail on the order the tests ran in.
    const windowDefaults = (["location", "innerWidth", "innerHeight"] as const).map((name) => [name, Object.getOwnPropertyDescriptor(window, name)] as const);
    const initialUrl = window.location.href;
    afterEach(async () => {
        cleanup();
        for (const [name, descriptor] of windowDefaults) {
            if (descriptor) {
                Object.defineProperty(window, name, descriptor);
            }
        }
        // Where a test navigated to (`history.pushState()`) is not where the next one starts.
        window.history.replaceState(null, "", initialUrl);
        // The notification stack, its history, the messages being sent and what was kept of them are module-level too: a pop-up (or a send)
        // one test raised must not be on screen - or block a same-uid send - in the next.
        resetNotifications();
        resetPendingSends();
        resetSendJobs();
        resetOutgoingReplies();
        setApiUnauthorizedObserver(undefined);
        // A signing-certificate enrollment being followed (a pending one is kept after its page has gone) must not poll into the next test. Imported here,
        // not above: a module loaded by this setup file would be loaded before a test file's `vi.mock()` of `keyvaultApi` and keep the real one.
        (await import("../../apps/shared/signing/enrollmentTracker.js")).resetEnrollmentTracker();
        // Short-lived, module-level copies of what a folder listed and of a message's body (see `listSnapshots.ts`,
        // `quotedBody.ts`) would otherwise show a test the previous test's rows and quote for the same uid.
        clearListSnapshots();
        clearOriginalMessageCache();
        // The tab's one push client (see `useMailLiveUpdates()`) outlives a component; a test that stubs the WebSocket
        // must not inherit the previous test's connection - or, once a sign-out closed it, a client that never reopens.
        resetPushClient();
        // jsdom keeps one `localStorage` for the whole file, so a preference a test leaves behind (the mail
        // list's own sort/filter/conversation settings, the local-index byte budget) would silently become
        // the *next* test's starting state - and did, before this line existed.
        localStorage.clear();
        // Likewise what a test remembered for the tab's session (the admin-access answer, the elevation attempt).
        sessionStorage.clear();
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
