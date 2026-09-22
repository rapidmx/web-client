// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import type { Mailbox } from "@rapidmx/react-shared/mail/mailApi.js";

const { checkSignEnrollmentStatus, getCurrentSignEnrollment } = vi.hoisted(() => ({
    checkSignEnrollmentStatus: vi.fn(),
    getCurrentSignEnrollment: vi.fn(),
}));
vi.mock("@rapidmx/react-shared/crypto/keyvaultApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@rapidmx/react-shared/crypto/keyvaultApi.js")>()),
    checkSignEnrollmentStatus,
    getCurrentSignEnrollment,
}));

import { SIGNING_SETTINGS_HREF, useSigningEnrollmentWatcher } from "../../../apps/shared/signing/useSigningEnrollmentWatcher.js";
import { getEnrollmentSnapshot } from "../../../apps/shared/signing/enrollmentTracker.js";
import { readStoredSignEnrollment } from "../../../apps/shared/signing/enrollmentStorage.js";
import { getNotificationsSnapshot } from "../../../apps/shared/notifications/store.js";

const mailbox = (uid: string, ownerUserUid: string | undefined = "u1"): Mailbox => ({ uid, ownerUserUid, primarySmtpAddress: `${uid}@example.com`, displayName: uid }) as Mailbox;

function Watcher({ mailboxes, enabled = true, userUid = "u1" }: { mailboxes: Mailbox[]; enabled?: boolean; userUid?: string }) {
    useSigningEnrollmentWatcher({ userUid, mailboxes, enabled });
    return null;
}

const shown = () => getNotificationsSnapshot().visible;

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    checkSignEnrollmentStatus.mockReset();
    getCurrentSignEnrollment.mockReset();
    getCurrentSignEnrollment.mockResolvedValue(null);
});

afterEach(() => {
    vi.useRealTimers();
});

describe("the signing-certificate watcher", () => {
    it("follows a stored enrollment on any page and raises a pop-up once when it is issued", async () => {
        localStorage.setItem("rapidmx.signEnrollment.mb1", "enr-1");
        checkSignEnrollmentStatus
            .mockResolvedValueOnce({ status: "pending" })
            .mockResolvedValue({ status: "issued", notAfter: "2027-09-21T12:00:00Z" });
        render(<Watcher mailboxes={[mailbox("mb1")]} />);
        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(checkSignEnrollmentStatus).toHaveBeenCalledWith("mb1", "enr-1");
        expect(shown()).toHaveLength(0);

        await act(() => vi.advanceTimersByTimeAsync(15_000));
        expect(shown()).toHaveLength(1);
        expect(shown()[0]).toMatchObject({
            kind: "success",
            title: "Digital signature certificate issued",
            actions: [{ label: "View", href: SIGNING_SETTINGS_HREF }],
        });
        expect(shown()[0].message).toMatch(/^Mail from mb1@example\.com is now signed \(valid until .*2027\)\.$/);
        expect(readStoredSignEnrollment("mb1")).toBeNull();
        // Nothing is asked about once it is over.
        await act(() => vi.advanceTimersByTimeAsync(300_000));
        expect(checkSignEnrollmentStatus).toHaveBeenCalledTimes(2);
        expect(getCurrentSignEnrollment).not.toHaveBeenCalled();
    });

    it("says a certificate that is issued but not installed yet is on its way, not that mail is already signed", async () => {
        localStorage.setItem("rapidmx.signEnrollment.mb1", "enr-1");
        checkSignEnrollmentStatus.mockResolvedValue({ status: "issued", issuedAt: "2026-09-21T10:00:00Z", notAfter: "2027-09-21T12:00:00Z" });
        render(<Watcher mailboxes={[mailbox("mb1")]} />);
        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(shown()[0]).toMatchObject({ kind: "success", title: "Digital signature certificate issued" });
        expect(shown()[0].message).toBe("The certificate for mb1@example.com is issued and is being installed - mail is signed once it is (a few minutes).");
    });

    it("says 'your mailbox' when it cannot tell which one an installing certificate is for", async () => {
        getCurrentSignEnrollment.mockImplementation(async (uid: string) => (uid === "mb1" ? { enrollmentId: "enr-9", status: "pending" } : null));
        checkSignEnrollmentStatus.mockResolvedValue({ status: "issued", issuedAt: "2026-09-21T10:00:00Z" });
        const { rerender } = render(<Watcher mailboxes={[mailbox("mb1")]} />);
        await act(() => vi.advanceTimersByTimeAsync(0));
        rerender(<Watcher mailboxes={[mailbox("mb2")]} />);
        await act(() => vi.advanceTimersByTimeAsync(15_000));
        expect(shown()[0].message).toBe("The certificate for your mailbox is issued and is being installed - mail is signed once it is (a few minutes).");
    });

    it("says so when it failed, with the reason and a way back to the page, and once", async () => {
        localStorage.setItem("rapidmx.signEnrollment.mb1", "enr-1");
        checkSignEnrollmentStatus.mockResolvedValue({ status: "failed", error: "The CA could not verify the address." });
        render(<Watcher mailboxes={[mailbox("mb1")]} />);
        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(shown()).toHaveLength(1);
        expect(shown()[0]).toMatchObject({
            kind: "error",
            title: "Digital signature certificate could not be issued",
            message: "The CA could not verify the address.",
            actions: [{ label: "Try again", href: SIGNING_SETTINGS_HREF }],
        });
    });

    it("has a default reason and a Details action for a failure that cannot be retried", async () => {
        localStorage.setItem("rapidmx.signEnrollment.mb1", "enr-1");
        checkSignEnrollmentStatus.mockResolvedValue({ status: "failed", retryable: false });
        render(<Watcher mailboxes={[mailbox("mb1")]} />);
        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(shown()[0]).toMatchObject({ message: "The certificate authority did not issue a certificate.", actions: [{ label: "Details" }] });
    });

    it("finds an enrollment started on another device through the server, remembers it, and announces it when it ends", async () => {
        getCurrentSignEnrollment.mockResolvedValue({ enrollmentId: "enr-9", status: "pending", stage: "awaiting-challenge" });
        checkSignEnrollmentStatus.mockResolvedValue({ status: "issued" });
        render(<Watcher mailboxes={[mailbox("mb1")]} />);
        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(getCurrentSignEnrollment).toHaveBeenCalledWith("mb1");
        expect(readStoredSignEnrollment("mb1")).toBe("enr-9");
        expect(getEnrollmentSnapshot("mb1")?.result?.stage).toBe("awaiting-challenge");
        expect(shown()).toHaveLength(0);

        await act(() => vi.advanceTimersByTimeAsync(15_000));
        expect(shown()).toHaveLength(1);
        // No expiry is known for an answer without one.
        expect(shown()[0].message).toBe("Mail from mb1@example.com is now signed.");
    });

    it("says 'Your mail' when it cannot tell which mailbox it was for", async () => {
        getCurrentSignEnrollment.mockImplementation(async (uid: string) => (uid === "mb1" ? { enrollmentId: "enr-9", status: "pending" } : null));
        checkSignEnrollmentStatus.mockResolvedValue({ status: "issued" });
        const { rerender } = render(<Watcher mailboxes={[mailbox("mb1")]} />);
        await act(() => vi.advanceTimersByTimeAsync(0));
        // The list was refreshed without that mailbox (no longer accessible) before the answer came; the enrollment is still followed.
        rerender(<Watcher mailboxes={[mailbox("mb2")]} />);
        await act(() => vi.advanceTimersByTimeAsync(15_000));
        expect(shown()).toHaveLength(1);
        expect(shown()[0].message).toBe("Your mail is now signed.");
    });

    it("does not announce a certificate that was issued long ago, an older server (404), or a failed lookup", async () => {
        getCurrentSignEnrollment
            .mockResolvedValueOnce({ enrollmentId: "old", status: "issued" })
            .mockRejectedValueOnce(new ApiRequestError("No route.", 404))
            .mockRejectedValueOnce(new Error("network"));
        render(<Watcher mailboxes={[mailbox("mb1"), mailbox("mb2"), mailbox("mb3")]} />);
        await act(() => vi.advanceTimersByTimeAsync(300_000));
        expect(getCurrentSignEnrollment).toHaveBeenCalledTimes(3);
        expect(checkSignEnrollmentStatus).not.toHaveBeenCalled();
        expect(shown()).toHaveLength(0);
        expect(getEnrollmentSnapshot("mb1")).toBeUndefined();
    });

    it("only follows mailboxes the user owns, and only when enabled and signed in", async () => {
        const { rerender } = render(<Watcher mailboxes={[mailbox("shared", "someone-else"), mailbox("nobody", "")]} />);
        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(getCurrentSignEnrollment).not.toHaveBeenCalled();
        rerender(<Watcher mailboxes={[mailbox("mb1")]} enabled={false} />);
        rerender(<Watcher mailboxes={[mailbox("mb1")]} userUid="" />);
        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(getCurrentSignEnrollment).not.toHaveBeenCalled();
    });

    it("does not start over for a refreshed list of the same mailboxes, and lets go when unmounted", async () => {
        localStorage.setItem("rapidmx.signEnrollment.mb1", "enr-1");
        checkSignEnrollmentStatus.mockResolvedValue({ status: "pending" });
        const { rerender, unmount } = render(<Watcher mailboxes={[mailbox("mb1")]} />);
        await act(() => vi.advanceTimersByTimeAsync(0));
        rerender(<Watcher mailboxes={[mailbox("mb1")]} />);
        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(checkSignEnrollmentStatus).toHaveBeenCalledTimes(1);
        unmount();
        // A pending enrollment is still followed, but nobody is told about it any more (the listener went with the frame).
        checkSignEnrollmentStatus.mockResolvedValue({ status: "issued" });
        await act(() => vi.advanceTimersByTimeAsync(15_000));
        expect(shown()).toHaveLength(0);
    });

    it("ignores a lookup that answers after it was unmounted", async () => {
        let answer: (value: unknown) => void = () => undefined;
        getCurrentSignEnrollment.mockReturnValue(new Promise((resolve) => (answer = resolve)));
        const { unmount } = render(<Watcher mailboxes={[mailbox("mb1")]} />);
        unmount();
        await act(async () => answer({ enrollmentId: "enr-9", status: "pending" }));
        expect(readStoredSignEnrollment("mb1")).toBeNull();
        expect(getEnrollmentSnapshot("mb1")).toBeUndefined();
    });
});
