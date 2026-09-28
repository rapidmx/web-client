///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { vi } from "vitest";

/** Builds a real `Response` with a JSON body and `content-type: application/json`. */
export function jsonResponse(status: number, body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        statusText: init.statusText ?? "",
        headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(init.headers)) },
    });
}

/** Builds a real `Response` with no body and no `content-type` — the shape of e.g. a 204/logout response. */
export function emptyResponse(status: number, init: ResponseInit = {}): Response {
    return new Response(null, { status, statusText: init.statusText ?? "", headers: init.headers });
}

/**
 * Stubs `global.fetch` with the given implementation and returns the underlying mock so call args can be
 * asserted on. `apiFetch()` (the only thing in `lib/api.ts` that touches `fetch` directly) always calls
 * it as `fetch(url, init)`, never with a `Request` object, so the mock signature is narrowed to that.
 */
export function mockFetch(
    impl: (url: string, init: RequestInit) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
    const fn = vi.fn(impl);
    vi.stubGlobal("fetch", fn);
    return fn;
}

/**
 * Stubs `window.matchMedia` so tests can force `useIsMobile()`'s mobile/desktop branch on demand,
 * overriding `test/apps/setup.ts`'s default "never matches" stub. Returns a controller whose
 * `setMatches()` both updates what a fresh `matchMedia()` call reports AND fires a `change` event on
 * every already-created `MediaQueryList` (mirroring a real browser resizing across the breakpoint),
 * so `useIsMobile()`'s `addEventListener("change", ...)` listener path is exercisable too. Call
 * `vi.unstubAllGlobals()` in an `afterEach` to restore the default stub between tests in the same file.
 */
export function mockMatchMedia(initialMatches = false): { setMatches: (matches: boolean) => void } {
    let matches = initialMatches;
    const listeners = new Set<(e: MediaQueryListEvent) => void>();
    const mql = {
        get matches() {
            return matches;
        },
        media: "",
        onchange: null,
        addEventListener: (_type: string, listener: (e: MediaQueryListEvent) => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: (e: MediaQueryListEvent) => void) => listeners.delete(listener),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(() => false),
    };
    vi.stubGlobal(
        "matchMedia",
        vi.fn(() => mql),
    );
    return {
        setMatches(next: boolean) {
            matches = next;
            listeners.forEach((listener) => listener({ matches: next } as MediaQueryListEvent));
        },
    };
}

/**
 * Stubs `window.IntersectionObserver` so a test can simulate a sentinel element intersecting its scroll
 * container, overriding `test/apps/setup.ts`'s default no-op stub. Returns a controller whose `trigger()`
 * invokes the most recently constructed observer's callback as if its observed element just became visible
 * (mirroring an infinite-scroll sentinel entering the viewport).
 */
export function mockIntersectionObserver(): { trigger: (isIntersecting?: boolean) => void } {
    let latestCallback: IntersectionObserverCallback | undefined;
    // A plain `function`, not an arrow function: the component invokes this via `new IntersectionObserver(...)`,
    // and arrow functions aren't constructible at all (`new` on one throws before the body ever runs) - vitest's
    // mock wrapper swallows that, so an arrow-function implementation here would silently never set the callback.
    vi.stubGlobal(
        "IntersectionObserver",
        vi.fn().mockImplementation(function (callback: IntersectionObserverCallback) {
            latestCallback = callback;
            return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
        }),
    );
    return {
        trigger(isIntersecting = true) {
            latestCallback?.([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
        },
    };
}

/**
 * Replaces `window.location` with a plain, fully-writable stub so `window.location.href = "..."`,
 * `window.location.replace(...)`, and `window.location.reload()` can be asserted on directly — jsdom's
 * real `Location` either throws "Not implemented: navigation" or actually attempts to navigate when touched.
 */
export function mockLocation(): { href: string; replace: ReturnType<typeof vi.fn>; reload: ReturnType<typeof vi.fn> } {
    const location = { href: "", replace: vi.fn(), reload: vi.fn() };
    Object.defineProperty(window, "location", {
        configurable: true,
        writable: true,
        value: location,
    });
    return location;
}
