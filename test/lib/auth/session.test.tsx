// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../testUtils.js";
import {
    SESSION_LOG_MAX,
    SESSION_REFRESH_AFTER_MS,
    SESSION_REFRESH_MIN_GAP_MS,
    SESSION_REFRESH_RETRY_MS,
    SESSION_RECOVERY_COOLDOWN_MS,
    SESSION_REFRESH_CHECK_MS,
    type SessionRefreshOptions,
    getSessionLog,
    logSessionEvent,
    recoverSession,
    refreshSession,
    refreshedRecently,
    resetSessionRecovery,
    setSessionRefreshRetryDelay,
    useRedirectIfUnauthenticated,
    useSessionRefresh,
} from "../../../lib/auth/session.js";
import { ApiClientContext } from "../../../lib/util/apiClientContext.js";
import { apiFetch, createApiClient } from "../../../lib/util/api.js";

const AUTH = "https://auth.example.com";
const REFRESHED_AT_KEY = "rapidmx.session.refreshedAt";
const LOG_KEY = "rapidmx.session.log";
/** Older than the minimum gap between forced refreshes, so a forced refresh is not skipped. */
const STALE_MS = SESSION_REFRESH_MIN_GAP_MS + 5_000;

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
    // A refused refresh is asked once more after a delay; tests that do not exercise the delay make it immediate.
    setSessionRefreshRetryDelay(0);
    // Going to sign-in prints the session log.
    vi.spyOn(console, "info").mockImplementation(() => undefined);
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

    it("rejects with the server's error and records nothing when the refresh is refused twice", async () => {
        const fetchMock = mockFetch(() => jsonResponse(401, { message: "Authentication failed" }));
        await expect(refreshSession(AUTH)).rejects.toMatchObject({ status: 401 });
        expect(fetchMock).toHaveBeenCalledTimes(2);
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

    it("refreshes without Web Locks where there is no navigator", async () => {
        vi.stubGlobal("navigator", undefined);
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        await expect(refreshSession(AUTH)).resolves.toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("takes a Web Lock, and does nothing when another tab refreshed while it waited for the lock", async () => {
        const request = vi.fn(async (_name: string, cb: () => Promise<boolean>) => {
            // The other tab held the lock, refreshed, and released it.
            localStorage.setItem(REFRESHED_AT_KEY, String(Date.now()));
            return cb();
        });
        vi.stubGlobal("navigator", { locks: { request } });
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        await expect(refreshSession(AUTH)).resolves.toBe(false);
        expect(request).toHaveBeenCalledTimes(1);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe("recoverSession", () => {
    it("refreshes whatever this browser remembers of the last refresh (unless it was seconds ago), and says it worked", async () => {
        localStorage.setItem(REFRESHED_AT_KEY, String(Date.now() - STALE_MS));
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

    it("says it did not work when the refresh is refused (even on the retry), forgets the last refresh so the next check asks again, and does not ask again at once", async () => {
        localStorage.setItem(REFRESHED_AT_KEY, String(Date.now() - STALE_MS));
        const fetchMock = mockFetch(() => jsonResponse(401, { message: "Invalid or missing authentication token." }));
        await expect(recoverSession(AUTH)).resolves.toBe(false);
        expect(localStorage.getItem(REFRESHED_AT_KEY)).toBe("0");
        await expect(recoverSession(AUTH)).resolves.toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not send a second refresh when one succeeded seconds ago, and says the session was renewed", async () => {
        localStorage.setItem(REFRESHED_AT_KEY, String(Date.now() - 2_000));
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        await expect(recoverSession(AUTH)).resolves.toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(getSessionLog().map((entry) => entry.e)).toEqual(["refresh:skip"]);
    });
});

describe("useSessionRefresh", () => {
    it("without a session, refreshes even when this browser remembers a refresh that is not seconds old", async () => {
        const location = mockLocation();
        localStorage.setItem(REFRESHED_AT_KEY, String(Date.now() - STALE_MS));
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        render(<RefreshComponent authServerUrl={AUTH} />);
        await waitFor(() => expect(location.reload).toHaveBeenCalledTimes(1));
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("with a session, renews it when a request is refused, and sends the request again", async () => {
        localStorage.setItem(REFRESHED_AT_KEY, String(Date.now() - STALE_MS));
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
        expect(fetchMock).toHaveBeenCalledTimes(2);
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

describe("refreshSession retry and sharing", () => {
    function sequence(...statuses: number[]) {
        let i = 0;
        return mockFetch(() => jsonResponse(statuses[Math.min(i++, statuses.length - 1)], {}));
    }

    it("shares one refresh between concurrent callers in the same tab", async () => {
        const fetchMock = sequence(200);
        const results = await Promise.all([refreshSession(AUTH), refreshSession(AUTH), refreshSession(AUTH, true)]);
        // The forced caller waits for the first refresh, then finds it made seconds ago.
        expect(results).toEqual([true, true, false]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("lets a forced caller that joins a refresh that is skipped as not due ask again afterward", async () => {
        // The unforced one was skipped (a refresh 20 minutes ago is not due): the forced one still posts.
        const fetchMock = sequence(200);
        localStorage.setItem(REFRESHED_AT_KEY, String(Date.now() - 20 * 60 * 1000));
        const [a, b] = await Promise.all([refreshSession(AUTH), refreshSession(AUTH, true)]);
        expect([a, b]).toEqual([false, true]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("passes a rejection to a forced caller that joined an unforced refresh, without posting again", async () => {
        const fetchMock = sequence(401);
        const unforced = refreshSession(AUTH);
        const forced = refreshSession(AUTH, true);
        await expect(unforced).rejects.toMatchObject({ status: 401 });
        await expect(forced).rejects.toMatchObject({ status: 401 });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not repeat a forced refresh that succeeded seconds ago, and logs why", async () => {
        const fetchMock = sequence(200);
        await expect(refreshSession(AUTH, true)).resolves.toBe(true);
        await expect(refreshSession(AUTH, true, "nouser")).resolves.toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(getSessionLog().map((entry) => entry.e)).toEqual(["refresh:start", "refresh:ok", "refresh:skip"]);
        expect(getSessionLog()[2].d).toContain("reason=nouser");
    });

    it("asks once more after a refusal, and succeeds when the retry is accepted", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
        setSessionRefreshRetryDelay(SESSION_REFRESH_RETRY_MS);
        const fetchMock = sequence(401, 200);
        const result = refreshSession(AUTH);
        await vi.advanceTimersByTimeAsync(SESSION_REFRESH_RETRY_MS - 1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await expect(result).resolves.toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(Number(localStorage.getItem(REFRESHED_AT_KEY))).toBeGreaterThan(0);
        expect(getSessionLog().map((entry) => entry.e)).toEqual(["refresh:start", "refresh:rejected", "refresh:retry", "refresh:ok"]);
        expect(getSessionLog()[1].d).toContain("status=401");
    });

    it("rejects when the retry is refused too, after exactly one retry", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
        setSessionRefreshRetryDelay(SESSION_REFRESH_RETRY_MS);
        const fetchMock = mockFetch(() => jsonResponse(403, { code: "FORBIDDEN" }));
        const result = refreshSession(AUTH);
        const assertion = expect(result).rejects.toMatchObject({ status: 403 });
        await vi.advanceTimersByTimeAsync(10 * SESSION_REFRESH_RETRY_MS);
        await assertion;
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const log = getSessionLog();
        expect(log.map((entry) => entry.e)).toEqual(["refresh:start", "refresh:rejected", "refresh:retry", "refresh:rejected"]);
        expect(log[3].d).toContain("code=FORBIDDEN");
        expect(log[3].d).toContain("attempt=2");
    });

    it("gives up the retry when another tab renewed the session while it waited", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
        setSessionRefreshRetryDelay(SESSION_REFRESH_RETRY_MS);
        const fetchMock = sequence(401);
        const result = refreshSession(AUTH);
        await vi.advanceTimersByTimeAsync(0);
        localStorage.setItem(REFRESHED_AT_KEY, String(Date.now()));
        await vi.advanceTimersByTimeAsync(SESSION_REFRESH_RETRY_MS);
        await expect(result).resolves.toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(getSessionLog().at(-1)?.e).toBe("refresh:skip");
    });

    it("does not retry a network failure or a server error, and logs it without secrets", async () => {
        const fetchMock = mockFetch(() => {
            throw new TypeError("Failed to fetch");
        });
        await expect(refreshSession(AUTH)).rejects.toThrow("Failed to fetch");
        mockFetch(() => jsonResponse(503, {}));
        await expect(refreshSession(AUTH)).rejects.toMatchObject({ status: 503 });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const errors = getSessionLog().filter((entry) => entry.e === "refresh:error");
        expect(errors.map((entry) => entry.d)).toEqual(["Failed to fetch", expect.stringContaining("status=503")]);
    });

    it("rejects with the network failure when the retry cannot reach the server", async () => {
        let calls = 0;
        mockFetch(() => {
            if (calls++ === 0) {
                return jsonResponse(401, {});
            }
            throw new TypeError("Failed to fetch");
        });
        await expect(refreshSession(AUTH)).rejects.toThrow("Failed to fetch");
        expect(getSessionLog().at(-1)).toMatchObject({ e: "refresh:error", d: "Failed to fetch attempt=2" });
    });

    it("treats a record of the last refresh that is not a number as none", () => {
        localStorage.setItem(REFRESHED_AT_KEY, "garbage");
        expect(refreshedRecently(1000)).toBe(false);
    });

    it("logs a failure that is not an Error as unknown", async () => {
        mockFetch(() => Promise.reject("boom"));
        await expect(refreshSession(AUTH)).rejects.toBe("boom");
        expect(getSessionLog().at(-1)).toMatchObject({ e: "refresh:error", d: "unknown" });
    });

    it("refreshedRecently ignores a cleared or future-dated record", () => {
        expect(refreshedRecently(1000)).toBe(false);
        localStorage.setItem(REFRESHED_AT_KEY, "0");
        expect(refreshedRecently(1000)).toBe(false);
        localStorage.setItem(REFRESHED_AT_KEY, String(Date.now() + 60_000));
        expect(refreshedRecently(1000)).toBe(false);
        localStorage.setItem(REFRESHED_AT_KEY, String(Date.now() - 100));
        expect(refreshedRecently(1000)).toBe(true);
    });
});

describe("session log", () => {
    it("keeps only the last entries, oldest dropped first", () => {
        for (let i = 0; i < SESSION_LOG_MAX + 10; i++) {
            logSessionEvent("e", String(i));
        }
        const log = getSessionLog();
        expect(log).toHaveLength(SESSION_LOG_MAX);
        expect(log[0].d).toBe("10");
        expect(log.at(-1)?.d).toBe(String(SESSION_LOG_MAX + 9));
        expect(Number.isNaN(Date.parse(log[0].t))).toBe(false);
    });

    it("omits the detail when there is none", () => {
        logSessionEvent("bare");
        expect(Object.keys(getSessionLog()[0]).sort()).toEqual(["e", "t"]);
    });

    it("starts afresh from stored data that is not a list or not JSON", () => {
        localStorage.setItem(LOG_KEY, '{"a":1}');
        expect(getSessionLog()).toEqual([]);
        localStorage.setItem(LOG_KEY, "not json");
        expect(getSessionLog()).toEqual([]);
        logSessionEvent("again");
        expect(getSessionLog()).toHaveLength(1);
    });

    it("survives blocked storage", () => {
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        expect(() => logSessionEvent("x", "y")).not.toThrow();
        expect(getSessionLog()).toEqual([]);
    });

    it("never records token or cookie values", async () => {
        mockFetch(() => jsonResponse(401, { message: "secret-token-value", token: "secret-token-value" }));
        vi.spyOn(document, "cookie", "get").mockReturnValue("jwt=secret-token-value; refresh=secret-token-value");
        await expect(refreshSession(AUTH)).rejects.toBeDefined();
        const stored = localStorage.getItem(LOG_KEY) ?? "";
        expect(stored).not.toContain("secret-token-value");
        expect(stored).toContain("refresh:rejected");
    });
});

describe("waking a long-idle tab", () => {
    it("a visibility check and a refused request that arrive together produce one POST /auth/refresh, and the request is sent again", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
        localStorage.setItem(REFRESHED_AT_KEY, String(Date.now()));
        let refreshed = false;
        let answerRefresh: (response: Response) => void = () => undefined;
        const fetchMock = mockFetch((url) => {
            if (url.endsWith("/auth/refresh")) {
                return new Promise<Response>((resolve) => (answerRefresh = (r) => ((refreshed = true), resolve(r))));
            }
            return refreshed ? jsonResponse(200, { data: 1 }) : jsonResponse(401, { message: "Expired" });
        });
        render(<RefreshComponent userUid="u1" authServerUrl={AUTH} />);
        await act(async () => undefined);
        expect(fetchMock).not.toHaveBeenCalled();

        // The laptop slept for two hours: the tab was hidden, then comes back; the access token cookie is long gone.
        const visibility = vi.spyOn(document, "visibilityState", "get");
        visibility.mockReturnValue("hidden");
        await act(async () => {
            document.dispatchEvent(new Event("visibilitychange"));
        });
        vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
        visibility.mockReturnValue("visible");
        await act(async () => {
            document.dispatchEvent(new Event("visibilitychange"));
        });
        const request = apiFetch("/mail/mailboxes");
        await act(async () => undefined);
        await act(async () => answerRefresh(jsonResponse(200, {})));
        await expect(request).resolves.toEqual({ data: 1 });

        const posts = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/auth/refresh"));
        expect(posts).toHaveLength(1);
        const log = getSessionLog();
        expect(log.find((entry) => entry.e === "visible")?.d).toBe(`hiddenFor=${2 * 60 * 60 * 1000}ms`);
        expect(log.filter((entry) => entry.e === "refresh:start")).toHaveLength(1);
    });

    it("logs an unknown hidden time when the tab was never seen hidden, and also checks on focus", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
        localStorage.setItem(REFRESHED_AT_KEY, String(Date.now()));
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        render(<RefreshComponent userUid="u1" authServerUrl={AUTH} />);
        await act(async () => undefined);
        await act(async () => {
            document.dispatchEvent(new Event("visibilitychange"));
        });
        expect(getSessionLog().find((entry) => entry.e === "visible")?.d).toBe("hiddenFor=unknown");

        vi.setSystemTime(Date.now() + SESSION_REFRESH_AFTER_MS + 60_000);
        await act(async () => {
            window.dispatchEvent(new Event("focus"));
        });
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(getSessionLog().some((entry) => entry.e === "check" && entry.d === "focus")).toBe(true);
    });

    it("a rejected refresh with a session logs why, prints the log, and goes to sign-in only after the retry", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearInterval", "Date"] });
        setSessionRefreshRetryDelay(SESSION_REFRESH_RETRY_MS);
        const location = mockLocation();
        location.href = "https://mail.example.com/mail";
        const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
        const fetchMock = mockFetch(() => jsonResponse(401, { message: "Invalid or missing authentication token." }));
        render(<RefreshComponent userUid="u1" authServerUrl={AUTH} />);
        await act(async () => undefined);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(location.href).toBe("https://mail.example.com/mail");

        await act(async () => {
            await vi.advanceTimersByTimeAsync(SESSION_REFRESH_RETRY_MS);
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(location.href).toContain(`${AUTH}/auth/signin?return_to=`);
        expect(info).toHaveBeenCalledTimes(1);
        expect(info.mock.calls[0][1]).toEqual(getSessionLog());
        const leave = getSessionLog().find((entry) => entry.e === "leave");
        expect(leave?.d).toContain("refresh-rejected");
        expect(leave?.d).toContain("sinceOk=never");
    });

    it("without a session, does not repeat a refresh another tab just made, and reloads", async () => {
        const location = mockLocation();
        localStorage.setItem(REFRESHED_AT_KEY, String(Date.now() - 1_000));
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        render(<RefreshComponent authServerUrl={AUTH} />);
        await waitFor(() => expect(location.reload).toHaveBeenCalledTimes(1));
        expect(fetchMock).not.toHaveBeenCalled();
        expect(getSessionLog().map((entry) => entry.e)).toEqual(["refresh:skip", "reload-after-refresh"]);
    });

    it("without a session, logs and prints why it went to sign-in", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/mail";
        const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
        mockFetch(() => jsonResponse(401, {}));
        render(<RefreshComponent authServerUrl={AUTH} />);
        await waitFor(() => expect(location.href).toContain(`${AUTH}/auth/signin?return_to=`));
        expect(info).toHaveBeenCalledTimes(1);
        expect(getSessionLog().at(-1)).toMatchObject({ e: "leave", d: expect.stringContaining("no-session refresh-rejected") });
    });
});

describe("unmounting while a refresh or a save is pending", () => {
    it("without a session, neither reloads nor redirects once unmounted", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/mail";
        let answer: (response: Response) => void = () => undefined;
        mockFetch(() => new Promise<Response>((resolve) => (answer = resolve)));
        const first = render(<RefreshComponent authServerUrl={AUTH} />);
        await waitFor(() => expect(answer).not.toBe(undefined));
        first.unmount();
        await act(async () => answer(jsonResponse(200, {})));
        expect(location.reload).not.toHaveBeenCalled();

        resetSessionRecovery();
        setSessionRefreshRetryDelay(0);
        localStorage.clear();
        let calls = 0;
        mockFetch(() => (calls++ === 0 ? new Promise<Response>((resolve) => (answer = resolve)) : jsonResponse(401, {})));
        const second = render(<RefreshComponent authServerUrl={AUTH} />);
        await waitFor(() => expect(calls).toBe(1));
        second.unmount();
        await act(async () => answer(jsonResponse(401, {})));
        await waitFor(() => expect(calls).toBe(2));
        await act(async () => undefined);
        expect(location.href).toBe("https://mail.example.com/mail");
    });

    it("with a session, does not leave for sign-in if unmounted while saving", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/mail";
        mockFetch(() => jsonResponse(401, {}));
        let finish: () => void = () => undefined;
        const beforeRedirect = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
        const { unmount } = render(<RefreshComponent userUid="u1" authServerUrl={AUTH} options={{ beforeRedirect }} />);
        await waitFor(() => expect(beforeRedirect).toHaveBeenCalledTimes(1));
        unmount();
        await act(async () => finish());
        expect(location.href).toBe("https://mail.example.com/mail");
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
