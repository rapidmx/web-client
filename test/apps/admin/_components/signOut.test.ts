// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch, mockLocation } from "../../testUtils.js";
import {
    CONSOLE_LOGOUT_TIMEOUT_MS,
    CONSOLE_SIGN_OUT_CHANNEL,
    signOutOfConsole,
} from "../../../../apps/shared/components/admin/signOut.js";
import { SIGN_OUT_CHANNEL } from "../../../../apps/shared/search/localIndexRpcClient.js";

const AUTH_SERVER_URL = "https://auth.example.com";

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("signOutOfConsole", () => {
    it("uses the same cross-tab channel AppShell listens on", () => {
        expect(CONSOLE_SIGN_OUT_CHANNEL).toBe(SIGN_OUT_CHANNEL);
    });

    it("announces the sign-out to other tabs, logs out of auth-server, then navigates", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/admin";
        const fetchMock = mockFetch(() => emptyResponse(204));
        const other = new BroadcastChannel(CONSOLE_SIGN_OUT_CHANNEL);
        const received = new Promise((resolve) => other.addEventListener("message", (event) => resolve(event.data)));

        await signOutOfConsole(AUTH_SERVER_URL);

        expect(fetchMock).toHaveBeenCalledWith(
            `${AUTH_SERVER_URL}/api/auth/logout`,
            expect.objectContaining({ method: "POST", credentials: "include" }),
        );
        expect(location.href).toBe(AUTH_SERVER_URL);
        expect(await received).toEqual({ type: "sign-out" });
        other.close();
    });

    it("still navigates when auth-server's logout fails", async () => {
        const location = mockLocation();
        mockFetch(() => jsonResponse(500, { message: "down" }));
        await signOutOfConsole(AUTH_SERVER_URL);
        expect(location.href).toBe(AUTH_SERVER_URL);
    });

    it("aborts a hung logout after the timeout and navigates anyway", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/admin";
        vi.useFakeTimers();
        let signal: AbortSignal | undefined;
        mockFetch(
            (_url, init) =>
                new Promise<Response>((_resolve, reject) => {
                    signal = init.signal as AbortSignal;
                    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
                }),
        );

        const done = signOutOfConsole(AUTH_SERVER_URL);
        await vi.advanceTimersByTimeAsync(CONSOLE_LOGOUT_TIMEOUT_MS - 1);
        expect(location.href).toBe("https://mail.example.com/admin");
        await vi.advanceTimersByTimeAsync(1);
        await done;
        expect(signal!.aborted).toBe(true);
        expect(location.href).toBe(AUTH_SERVER_URL);
    });

    it("skips the logout call and navigates to '/' without an auth-server, and without BroadcastChannel", async () => {
        const location = mockLocation();
        const fetchMock = mockFetch(() => emptyResponse(204));
        vi.stubGlobal("BroadcastChannel", undefined);

        await signOutOfConsole(undefined);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(location.href).toBe("/");
    });
});
