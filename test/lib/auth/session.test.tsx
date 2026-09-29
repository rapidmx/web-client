// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../testUtils.js";
import {
    SESSION_REFRESH_AFTER_MS,
    SESSION_RECOVERY_COOLDOWN_MS,
    SESSION_REFRESH_CHECK_MS,
    type SessionRefreshOptions,
    recoverSession,
    refreshSession,
    resetSessionRecovery,
    useRedirectIfUnauthenticated,
    useSessionRefresh,
} from "../../../lib/auth/session.js";
import { ApiClientContext } from "../../../lib/util/apiClientContext.js";
import { apiFetch, createApiClient } from "../../../lib/util/api.js";

const AUTH = "https://auth.example.com";
const REFRESHED_AT_KEY = "rapidmx.session.refreshedAt";

function RedirectComponent({ userUid, authServerUrl }: { userUid?: string; authServerUrl?: string }) {
    useRedirectIfUnauthenticated(userUid, authServerUrl);
    return null;
}

function RefreshComponent({
    userUid,
    authServerUrl,
    options,
}: {
    userUid?: string;
    authServerUrl?: string;
    options?: SessionRefreshOptions;
}) {
    useSessionRefresh(userUid, authServerUrl, options);
    return null;
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetSessionRecovery();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("useRedirectIfUnauthenticated", () => {
    it("redirects to auth-server's sign-in page with return_to when there is no userUid", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/admin/mailboxes";
        render(<RedirectComponent authServerUrl={AUTH} />);
        await waitFor(() =>
            expect(location.href).toBe(
                `${AUTH}/auth/signin?return_to=` + encodeURIComponent("https://mail.example.com/admin/mailboxes"),
            ),
        );
    });

    it("does not redirect once userUid is present", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/admin";
        render(<RedirectComponent userUid="u1" authServerUrl={AUTH} />);
        expect(location.href).toBe("https://mail.example.com/admin");
    });

    it("logs an error instead of redirecting when authServerUrl is not configured", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/admin";
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        render(<RedirectComponent />);
        await waitFor(() => expect(errorSpy).toHaveBeenCalled());
        expect(location.href).toBe("https://mail.example.com/admin");
    });
});

describe("refreshSession", () => {
    it("posts to auth-server's refresh route with credentials and records when it happened", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        expect(await refreshSession(AUTH)).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(`${AUTH}/api/auth/refresh`);
        expect(init.method).toBe("POST");
        expect(init.credentials).toBe("include");
        expect(Number(localStorage.getItem(REFRESHED_AT_KEY))).toBeGreaterThan(0);
    });

    it("does nothing when the session was refreshed recently, unless forced", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        localStorage.setItem(REFRESHED_AT_KEY, String(Date.now() - 60_000));
        expect(await refreshSession(AUTH)).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(await refreshSession(AUTH, true)).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("refreshes when the last refresh is older than the threshold", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        localStorage.setItem(REFRESHED_AT_KEY, String(Date.now() - SESSION_REFRESH_AFTER_MS - 1000));
        expect(await refreshSession(AUTH)).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("rejects with the server's error and records nothing when the refresh is refused", async () => {
        mockFetch(() => jsonResponse(401, { message: "Authentication failed" }));
        await expect(refreshSession(AUTH)).rejects.toMatchObject({ status: 401 });
        expect(localStorage.getItem(REFRESHED_AT_KEY)).toBeNull();
    });

    it("still refreshes when storage cannot be read or written, treating it as no record of a recent refresh", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("storage blocked");
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("storage blocked");
        });
        expect(await refreshSession(AUTH)).toBe(true);
        expect(await refreshSession(AUTH)).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("serialises concurrent refreshes through Web Locks so the second finds it already done", async () => {
        let tail: Promise<unknown> = Promise.resolve();
        vi.stubGlobal("navigator", {
            locks: { request: (_name: string, cb: () => Promise<boolean>) => (tail = tail.then(cb)) },
        });
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        const results = await Promise.all([refreshSession(AUTH), refreshSession(AUTH)]);
        expect(results).toEqual([true, false]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe("recoverSession", () => {
    it("refreshes whatever this browser remembers of the last refresh, and says it worked", async () => {
        localStorage.setItem(REFRESHED_AT_KEY, String(Date.now()));
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        await expect(recoverSession(AUTH)).resolves.toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe(`${AUTH}/api/auth/refresh`);
    });

    it("shares one refresh between requests refused together, then reuses the outcome for a while", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        const [a, b] = await Promise.all([recoverSession(AUTH), recoverSession(AUTH)]);
        expect([a, b]).toEqual([true, true]);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await expect(recoverSession(AUTH)).resolves.toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(SESSION_RECOVERY_COOLDOWN_MS + 1);
        await expect(recoverSession(AUTH)).resolves.toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("says it did not work when the refresh is refused, forgets the last refresh so the next check asks again, and does not ask again at once", async () => {
        localStorage.setItem(REFRESHED_AT_KEY, String(Date.now()));
        const fetchMock = mockFetch(() => jsonResponse(401, { message: "Invalid or missing authentication token." }));
        await expect(recoverSession(AUTH)).resolves.toBe(false);
        expect(localStorage.getItem(REFRESHED_AT_KEY)).toBe("0");
        await expect(recoverSession(AUTH)).resolves.toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe("useSessionRefresh", () => {
    it("without a session, refreshes even when this browser remembers a recent refresh", async () => {
        const location = mockLocation();
        localStorage.setItem(REFRESHED_AT_KEY, String(Date.now()));
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        render(<RefreshComponent authServerUrl={AUTH} />);
        await waitFor(() => expect(location.reload).toHaveBeenCalledTimes(1));
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("with a session, renews it when a request is refused, and sends the request again", async () => {
        localStorage.setItem(REFRESHED_AT_KEY, String(Date.now()));
        let refreshed = false;
        const fetchMock = mockFetch((url) => {
            if (url.endsWith("/auth/refresh")) {
                refreshed = true;
                return jsonResponse(200, {});
            }
            return refreshed ? jsonResponse(200, { data: 1 }) : jsonResponse(401, { message: "Expired" });
        });
        render(<RefreshComponent userUid="u1" authServerUrl={AUTH} />);
        await expect(apiFetch("/mail/mailboxes")).resolves.toEqual({ data: 1 });
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/mail/mailboxes", `${AUTH}/api/auth/refresh`, "/api/mail/mailboxes"]);
    });

    it("stops renewing on a refused request once the page unmounts, or while paused", async () => {
        const { unmount } = render(<RefreshComponent userUid="u1" authServerUrl={AUTH} />);
        unmount();
        const fetchMock = mockFetch(() => jsonResponse(401, {}));
        await expect(apiFetch("/x")).rejects.toMatchObject({ status: 401 });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        render(<RefreshComponent userUid="u1" authServerUrl={AUTH} options={{ paused: true }} />);
        await expect(apiFetch("/x")).rejects.toMatchObject({ status: 401 });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("without a session, refreshes silently and reloads the page", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/";
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        render(<RefreshComponent authServerUrl={AUTH} />);
        await waitFor(() => expect(location.reload).toHaveBeenCalledTimes(1));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(location.href).toBe("https://mail.example.com/");
    });

    it("without a session, redirects to sign-in with return_to when the refresh is refused", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/mail";
        mockFetch(() => jsonResponse(401, { message: "Authentication failed" }));
        render(<RefreshComponent authServerUrl={AUTH} />);
        await waitFor(() =>
            expect(location.href).toBe(
                `${AUTH}/auth/signin?return_to=` + encodeURIComponent("https://mail.example.com/mail"),
            ),
        );
        expect(location.reload).not.toHaveBeenCalled();
    });

    it("without a session, does not reload again when a reload just made still found none", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/mail";
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        sessionStorage.setItem("rapidmx.session.reloadedAt", String(Date.now()));
        render(<RefreshComponent authServerUrl={AUTH} />);
        await waitFor(() => expect(location.href).toContain(`${AUTH}/auth/signin?return_to=`));
        expect(fetchMock).not.toHaveBeenCalled();
        expect(location.reload).not.toHaveBeenCalled();
    });

    it("logs an error instead of redirecting when authServerUrl is not configured and there is no session", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/admin";
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        render(<RefreshComponent />);
        await waitFor(() => expect(errorSpy).toHaveBeenCalled());
        expect(location.href).toBe("https://mail.example.com/admin");
    });

    it("with a session, refreshes on load when this browser has no record of a recent refresh", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        render(<RefreshComponent userUid="u1" authServerUrl={AUTH} />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    });

    it("with a session, does not refresh on load when one just happened", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        localStorage.setItem(REFRESHED_AT_KEY, String(Date.now()));
        render(<RefreshComponent userUid="u1" authServerUrl={AUTH} />);
        await act(async () => undefined);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("with a session, refreshes again once the token is due, without leaving the page", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
        const location = mockLocation();
        location.href = "https://mail.example.com/mail";
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        localStorage.setItem(REFRESHED_AT_KEY, String(Date.now()));
        render(<RefreshComponent userUid="u1" authServerUrl={AUTH} />);
        expect(fetchMock).not.toHaveBeenCalled();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(SESSION_REFRESH_AFTER_MS - SESSION_REFRESH_CHECK_MS);
        });
        expect(fetchMock).not.toHaveBeenCalled();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(2 * SESSION_REFRESH_CHECK_MS);
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(location.href).toBe("https://mail.example.com/mail");
        expect(location.reload).not.toHaveBeenCalled();
    });

    it("with a session, retries a transient failure at the next check", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
        let fail = true;
        const fetchMock = mockFetch(() => (fail ? jsonResponse(503, {}) : jsonResponse(200, {})));
        render(<RefreshComponent userUid="u1" authServerUrl={AUTH} />);
        await act(async () => undefined);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        fail = false;
        await act(async () => {
            await vi.advanceTimersByTimeAsync(SESSION_REFRESH_CHECK_MS);
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(localStorage.getItem(REFRESHED_AT_KEY)).not.toBeNull();
    });

    it("with a session, redirects to sign-in with return_to when the refresh is rejected", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/mail";
        const fetchMock = mockFetch(() => jsonResponse(401, { message: "Authentication failed" }));
        render(<RefreshComponent userUid="u1" authServerUrl={AUTH} />);
        await waitFor(() =>
            expect(location.href).toBe(
                `${AUTH}/auth/signin?return_to=` + encodeURIComponent("https://mail.example.com/mail"),
            ),
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(location.reload).not.toHaveBeenCalled();
    });

    it("with a session, runs beforeRedirect first and waits for it before leaving", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/mail";
        mockFetch(() => jsonResponse(403, { message: "Forbidden" }));
        let finish: () => void = () => undefined;
        const beforeRedirect = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
        render(<RefreshComponent userUid="u1" authServerUrl={AUTH} options={{ beforeRedirect }} />);
        await waitFor(() => expect(beforeRedirect).toHaveBeenCalledTimes(1));
        expect(location.href).toBe("https://mail.example.com/mail");
        await act(async () => finish());
        await waitFor(() => expect(location.href).toContain(`${AUTH}/auth/signin?return_to=`));
    });

    it("with a session, still redirects when beforeRedirect fails", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/mail";
        mockFetch(() => jsonResponse(401, {}));
        const beforeRedirect = vi.fn(() => Promise.reject(new Error("save failed")));
        render(<RefreshComponent userUid="u1" authServerUrl={AUTH} options={{ beforeRedirect }} />);
        await waitFor(() => expect(location.href).toContain(`${AUTH}/auth/signin?return_to=`));
        expect(beforeRedirect).toHaveBeenCalledTimes(1);
    });

    it("with a session, does not run beforeRedirect for a failure that is not a rejection", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/mail";
        const fetchMock = mockFetch(() => jsonResponse(503, {}));
        const beforeRedirect = vi.fn(async () => undefined);
        render(<RefreshComponent userUid="u1" authServerUrl={AUTH} options={{ beforeRedirect }} />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        await act(async () => undefined);
        expect(beforeRedirect).not.toHaveBeenCalled();
        expect(location.href).toBe("https://mail.example.com/mail");
    });

    it("with a session that is paused, never refreshes", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        render(<RefreshComponent userUid="u1" authServerUrl={AUTH} options={{ paused: true }} />);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(2 * SESSION_REFRESH_AFTER_MS);
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("without a session and paused, goes straight to sign-in rather than refreshing", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/mail";
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        render(<RefreshComponent authServerUrl={AUTH} options={{ paused: true }} />);
        await waitFor(() => expect(location.href).toContain(`${AUTH}/auth/signin?return_to=`));
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("with a session, checks again when the tab becomes visible", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        localStorage.setItem(REFRESHED_AT_KEY, String(Date.now()));
        render(<RefreshComponent userUid="u1" authServerUrl={AUTH} />);
        await act(async () => undefined);
        expect(fetchMock).not.toHaveBeenCalled();

        // The laptop slept past the token's lifetime: no timer ran, but waking the tab checks at once.
        vi.setSystemTime(Date.now() + SESSION_REFRESH_AFTER_MS + 60_000);
        await act(async () => {
            document.dispatchEvent(new Event("visibilitychange"));
        });
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    });

    it("with a session, does not start a second refresh while one is still on the wire", async () => {
        let answer: (response: Response) => void = () => undefined;
        const fetchMock = mockFetch(() => new Promise<Response>((resolve) => (answer = resolve)));
        render(<RefreshComponent userUid="u1" authServerUrl={AUTH} />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

        await act(async () => {
            document.dispatchEvent(new Event("visibilitychange"));
            window.dispatchEvent(new Event("online"));
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await act(async () => answer(jsonResponse(200, {})));
        await waitFor(() => expect(localStorage.getItem(REFRESHED_AT_KEY)).not.toBeNull());
    });

    it("stops checking once the page unmounts", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        localStorage.setItem(REFRESHED_AT_KEY, String(Date.now()));
        const { unmount } = render(<RefreshComponent userUid="u1" authServerUrl={AUTH} />);
        unmount();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(2 * SESSION_REFRESH_AFTER_MS);
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

// A component under an `ApiClientContext.Provider` (e.g. one account of the native, multi-account
// `tauri-client`) has its network calls routed through that explicit `ApiClient` instead of this app's own
// `jwt` cookie - there is nothing here for auth-server's cookie-based session-refresh/redirect logic to do,
// and it would be actively wrong (there is no cookie for this origin to refresh, and the client's own token
// lifecycle is the host app's job via a different mechanism entirely). Proven both ways: present, both hooks
// go completely inert regardless of what `userUid`/`options` say; absent (every test above, and the plain
// `render()` calls below with no wrapping provider), behavior is exactly what it always was.
describe("useRedirectIfUnauthenticated and useSessionRefresh under an ApiClientContext.Provider", () => {
    const client = createApiClient({ baseUrl: "https://tauri.example.com", getAccessToken: async () => "tok" });

    function withClientProvider(children: React.ReactNode) {
        return <ApiClientContext.Provider value={client}>{children}</ApiClientContext.Provider>;
    }

    it("useRedirectIfUnauthenticated does not redirect even with no userUid", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/admin";
        render(withClientProvider(<RedirectComponent authServerUrl={AUTH} />));
        await act(async () => undefined);
        expect(location.href).toBe("https://mail.example.com/admin");
    });

    it("useSessionRefresh never refreshes, reloads or redirects with no userUid", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/mail";
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        render(withClientProvider(<RefreshComponent authServerUrl={AUTH} />));
        await act(async () => undefined);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(location.reload).not.toHaveBeenCalled();
        expect(location.href).toBe("https://mail.example.com/mail");
    });

    it("useSessionRefresh never refreshes with a session either, including on visibilitychange", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        render(withClientProvider(<RefreshComponent userUid="u1" authServerUrl={AUTH} />));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(2 * SESSION_REFRESH_AFTER_MS);
            document.dispatchEvent(new Event("visibilitychange"));
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("useSessionRefresh stays inert even when paused is explicitly false and no session is present", async () => {
        // Not just `paused` doing the work under the hood - the provider itself is what disables it.
        const location = mockLocation();
        location.href = "https://mail.example.com/mail";
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        render(withClientProvider(<RefreshComponent authServerUrl={AUTH} options={{ paused: false }} />));
        await act(async () => undefined);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(location.href).toBe("https://mail.example.com/mail");
    });
});
