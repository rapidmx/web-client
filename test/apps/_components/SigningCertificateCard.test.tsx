// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SigningCertificateCard, { SigningCertificateCardProps } from "../../../apps/shared/components/settings/SigningCertificateCard.js";
import type { EnrollmentSnapshot } from "../../../apps/shared/signing/enrollmentTracker.js";
import { useNow } from "../../../apps/shared/signing/useNow.js";

const NOW = Date.parse("2026-09-21T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const inDays = (days: number) => new Date(NOW + days * 86_400_000).toISOString();

const snapshot = (extra: Partial<EnrollmentSnapshot> = {}): EnrollmentSnapshot => ({
    mailboxUid: "mb1",
    enrollmentId: "enr-1",
    result: null,
    answeredAt: null,
    checking: false,
    checkingNow: false,
    retryAt: 0,
    offline: false,
    gone: false,
    lastCheck: null,
    ...extra,
});

function renderCard(props: Partial<SigningCertificateCardProps> = {}) {
    const onCheck = vi.fn();
    const onRequest = vi.fn();
    const view = render(<SigningCertificateCard mode="pending" enrollment={null} canRequest requesting={false} onCheck={onCheck} onRequest={onRequest} {...props} />);
    return { ...view, onCheck, onRequest };
}

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

const detailed = {
    status: "pending" as const,
    stage: "awaiting-challenge" as const,
    progress: 40,
    requestedAt: ago(3 * 60_000),
    lastCheckedAt: ago(20_000),
    stages: [
        { id: "submitted", label: "Request sent", state: "done" as const, at: ago(3 * 60_000) },
        { id: "awaiting-challenge", label: "Verification e-mail", state: "active" as const },
        { id: "validating", label: "Validation", state: "pending" as const },
        { id: "issued", label: "Issued", state: "failed" as const },
    ],
};

describe("a pending certificate", () => {
    it("shows a determinate progress bar, the steps with their states and times, the status line and how long ago it was requested and checked", () => {
        renderCard({ enrollment: detailed, snapshot: snapshot({ result: detailed }) });
        const bar = screen.getByRole("progressbar", { name: "Certificate progress" });
        expect(bar).toHaveAttribute("aria-valuenow", "40");
        expect(bar).toHaveAttribute("aria-valuemin", "0");
        expect(bar).toHaveAttribute("aria-valuemax", "100");
        expect(bar).toHaveAttribute("aria-valuetext", "40 percent - Waiting for the CA's verification e-mail");
        expect(screen.getByText("Waiting for the CA's verification e-mail", { selector: "p" })).toBeInTheDocument();
        expect(screen.getByText("Pending")).toBeInTheDocument();

        const steps = within(screen.getByRole("list", { name: "Certificate steps" })).getAllByRole("listitem");
        expect(steps).toHaveLength(4);
        expect(steps[0]).toHaveTextContent("Request sent - done");
        expect(steps[1]).toHaveTextContent("Verification e-mail - in progress");
        expect(steps[1]).toHaveAttribute("aria-current", "step");
        expect(steps[2]).toHaveTextContent("Validation - waiting");
        expect(steps[3]).toHaveTextContent("Issued - failed");
        expect(steps[0].textContent).toMatch(/\d/);
        expect(screen.getByText("Requested 3 min ago - last checked 20 s ago")).toBeInTheDocument();
    });

    it("keeps the relative times current as time passes", async () => {
        renderCard({ enrollment: detailed, snapshot: snapshot({ result: detailed }) });
        expect(screen.getByText("Requested 3 min ago - last checked 20 s ago")).toBeInTheDocument();
        await act(() => vi.advanceTimersByTimeAsync(2 * 60_000));
        expect(screen.getByText("Requested 5 min ago - last checked 2 min ago")).toBeInTheDocument();
    });

    it("shows an indeterminate bar and the plain sentence for an older server that says only pending", () => {
        renderCard({ enrollment: { status: "pending" } });
        const bar = screen.getByRole("progressbar");
        expect(bar).not.toHaveAttribute("aria-valuenow");
        expect(bar).toHaveAttribute("aria-valuetext", "In progress");
        // Nothing that is only true of one way of issuing certificates: no "automatic", no "background".
        expect(screen.getByText("Requested - waiting for the certificate. Use Check status to see where the request is.")).toBeInTheDocument();
        expect(screen.queryByText(/automatic|background|email exchange/i)).not.toBeInTheDocument();
        expect(screen.queryByRole("list", { name: "Certificate steps" })).not.toBeInTheDocument();
        // Nothing to say about when it was requested or checked.
        expect(screen.queryByText(/last checked/)).not.toBeInTheDocument();
    });

    it("says only when it was last checked when the server gave no request time, and only when it was requested when nothing checked it", () => {
        const { unmount } = renderCard({ enrollment: { status: "pending" }, snapshot: snapshot({ answeredAt: NOW - 30_000 }) });
        expect(screen.getByText("last checked 30 s ago")).toBeInTheDocument();
        unmount();
        renderCard({ enrollment: { status: "pending", requestedAt: ago(90_000) } });
        expect(screen.getByText("Requested 1 min ago")).toBeInTheDocument();
    });

    it("draws a stage without steps as the usual five, and says 'In progress' when there is a bar but no words", () => {
        const { unmount } = renderCard({ enrollment: { status: "pending", stage: "validating" } });
        expect(within(screen.getByRole("list", { name: "Certificate steps" })).getAllByRole("listitem")).toHaveLength(5);
        expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "60");
        unmount();
        renderCard({ enrollment: { status: "pending", progress: 0 } });
        expect(screen.getByText("In progress", { selector: "p" })).toBeInTheDocument();
        expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
        expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "0 percent - in progress");
    });

    it("has a busy state on the button while it checks, and never fires a second check", async () => {
        const { onCheck } = renderCard({ enrollment: detailed, snapshot: snapshot({ result: detailed, checkingNow: true }) });
        const button = screen.getByRole("button", { name: "Checking..." });
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute("aria-busy", "true");
        await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(button);
        expect(onCheck).not.toHaveBeenCalled();
    });

    it("calls onCheck from 'Check status'", async () => {
        const { onCheck } = renderCard({ enrollment: detailed, snapshot: snapshot({ result: detailed }) });
        await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole("button", { name: "Check status" }));
        expect(onCheck).toHaveBeenCalledTimes(1);
    });

    it("counts down while 'Check status' is unavailable, then offers it again", async () => {
        renderCard({ enrollment: detailed, snapshot: snapshot({ result: detailed, retryAt: NOW + 3000, lastCheck: { at: NOW, outcome: "unchanged" } }) });
        expect(screen.getByRole("button", { name: "Check again in 3 s" })).toBeDisabled();
        await act(() => vi.advanceTimersByTimeAsync(1000));
        expect(screen.getByRole("button", { name: "Check again in 2 s" })).toBeDisabled();
        await act(() => vi.advanceTimersByTimeAsync(2000));
        expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
    });

    it.each([
        [{ at: NOW - 1000, outcome: "unchanged" as const }, {}, "Still waiting - checked just now"],
        [{ at: NOW, outcome: "changed" as const }, {}, "Updated - Waiting for the CA's verification e-mail"],
        [{ at: NOW, outcome: "limited" as const }, {}, "Checked a moment ago - please wait a few seconds before checking again."],
        [{ at: NOW, outcome: "failed" as const }, {}, "Could not check just now - try again in a moment."],
        [null, { offline: true }, "Could not reach the server - showing what was last known."],
    ])("reports the outcome of a check (%j)", (lastCheck, extra, text) => {
        renderCard({ enrollment: detailed, snapshot: snapshot({ result: detailed, lastCheck, ...extra }) });
        const status = screen.getByRole("status");
        expect(status).toHaveAttribute("aria-live", "polite");
        expect(status).toHaveTextContent(text);
    });

    it("says something generic when a change came with no words, and has nothing to say before any check", () => {
        const { unmount } = renderCard({ enrollment: { status: "pending", progress: 5 }, snapshot: snapshot({ lastCheck: { at: NOW, outcome: "changed" } }) });
        expect(screen.getByRole("status")).toHaveTextContent("Updated - In progress".replace("In progress", "the status changed"));
        unmount();
        renderCard({ enrollment: detailed, snapshot: snapshot() });
        expect(screen.getByRole("status")).toHaveTextContent("");
    });

    it("offers no button when there is nothing to call", () => {
        renderCard({ enrollment: detailed, onCheck: undefined });
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("shimmers the filled part of the bar while a step is active", () => {
        renderCard({ enrollment: detailed });
        expect(screen.getByRole("progressbar").firstElementChild).toHaveClass("rr-progress-shimmer");
    });

    it("shows the bar at a visible minimum for a few percent and empty for none", () => {
        const { unmount } = renderCard({ enrollment: { status: "pending", progress: 1, stage: "submitted" } });
        expect((screen.getByRole("progressbar").firstElementChild as HTMLElement).style.width).toBe("3%");
        unmount();
        renderCard({ enrollment: { status: "pending", progress: 0, stage: "submitted" } });
        expect((screen.getByRole("progressbar").firstElementChild as HTMLElement).style.width).toBe("0%");
    });
});

describe("an issued certificate", () => {
    const issued = {
        status: "issued" as const,
        subject: "E=jane@example.com",
        issuer: "CN=Example CA",
        serialNumber: "0A1B2C3D4E5F60718293A4B5C6D7E8F9",
        issuedAt: ago(86_400_000),
        installedAt: ago(86_000_000),
        notAfter: inDays(200),
    };

    it("shows the subject, issuer, a shortened copyable serial number, when it was issued and its expiry", async () => {
        renderCard({ mode: "issued", enrollment: issued });
        expect(screen.getByText("Active")).toBeInTheDocument();
        expect(screen.getByText(/^Issued - valid until /)).toBeInTheDocument();
        expect(screen.getByText("E=jane@example.com")).toBeInTheDocument();
        expect(screen.getByText("CN=Example CA")).toBeInTheDocument();
        const serial = screen.getByText("0A1B2C3D...C6D7E8F9");
        expect(serial).toHaveAttribute("title", "0A1B2C3D4E5F60718293A4B5C6D7E8F9");
        expect(screen.getByRole("button", { name: "Copy the certificate's serial number" })).toBeInTheDocument();
        expect(screen.getByText("Valid until")).toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Renew" })).not.toBeInTheDocument();
    });

    it("warns about an expiry inside 30 days and offers Renew to the owner", async () => {
        const { onRequest } = renderCard({ mode: "issued", enrollment: { ...issued, notAfter: inDays(12) } });
        expect(screen.getByRole("alert")).toHaveTextContent("This certificate expires in 12 days.");
        await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole("button", { name: "Renew" }));
        expect(onRequest).toHaveBeenCalledTimes(1);
    });

    it("says tomorrow for one day left, and offers no Renew to someone who cannot request", () => {
        renderCard({ mode: "issued", enrollment: { ...issued, notAfter: new Date(NOW + 3_600_000).toISOString() }, canRequest: false });
        expect(screen.getByRole("alert")).toHaveTextContent("expires tomorrow");
        expect(screen.queryByRole("button", { name: "Renew" })).not.toBeInTheDocument();
    });

    it("falls back to the key's own expiry when the enrollment carries no details, and shows no details list", () => {
        renderCard({ mode: "issued", enrollment: null, keyNotAfter: NOW + 10 * 86_400_000 });
        expect(screen.getByText(/^Issued - valid until /)).toBeInTheDocument();
        expect(screen.getByRole("alert")).toHaveTextContent("in 10 days");
        expect(screen.queryByText("Subject")).not.toBeInTheDocument();
    });

    it("says just 'Issued' with no expiry known, and shows only the details it has", () => {
        renderCard({ mode: "issued", enrollment: { status: "issued", issuedAt: ago(1000), installedAt: ago(500) } });
        expect(screen.getByText("Issued", { selector: "p" })).toBeInTheDocument();
        expect(screen.getByText("Issued", { selector: "dt" })).toBeInTheDocument();
        expect(screen.queryByText("Valid until")).not.toBeInTheDocument();
        expect(screen.queryByText("Subject")).not.toBeInTheDocument();
        expect(screen.queryByText("Serial number")).not.toBeInTheDocument();
    });

    it("keeps a short serial number whole and builds no Renew button without a handler", () => {
        renderCard({ mode: "issued", enrollment: { ...issued, serialNumber: "1A2B", notAfter: inDays(3) }, onRequest: undefined });
        expect(screen.getByText("1A2B")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Renew" })).not.toBeInTheDocument();
    });

    it("shows Renew as busy while a request is under way", () => {
        renderCard({ mode: "issued", enrollment: { ...issued, notAfter: inDays(3) }, requesting: true });
        expect(screen.getByRole("button", { name: "Renew" })).toBeDisabled();
    });
});

describe("wording that follows how this deployment issues certificates", () => {
    const automatic = { backend: "rfc8823" as const, automatic: true, adminUpload: false, ca: { host: "acme.ca.example" }, typicalDurationMinutes: 5 };
    const manual = { backend: "manual" as const, automatic: false, adminUpload: true, contactEmail: "admin@example.com" };

    it("says an automatic request is with the CA, where its verification e-mail goes and how long it usually takes - above the stages", () => {
        renderCard({ enrollment: { ...detailed, provider: "rfc8823" }, info: automatic, address: "jane@example.com" });
        expect(screen.getByText("Requested from acme.ca.example. The CA sends a verification e-mail to jane@example.com; this usually takes about 5 minutes.")).toBeInTheDocument();
        expect(screen.getByRole("list", { name: "Certificate steps" })).toBeInTheDocument();
        expect(screen.getByText("You can leave this page - you will be told when the certificate is issued or the request fails.")).toBeInTheDocument();
    });

    it("says only as much as it knows: one minute, no CA host, no address, no duration - and the enrollment's own provider wins over the deployment's", () => {
        const { unmount } = renderCard({ enrollment: { status: "pending", provider: "rfc8823" }, info: { ...automatic, typicalDurationMinutes: 1 }, address: undefined });
        expect(screen.getByText("Requested from acme.ca.example. The CA sends a verification e-mail to this mailbox; this usually takes about 1 minute.")).toBeInTheDocument();
        unmount();
        const second = renderCard({ enrollment: { status: "pending" }, info: { backend: "rfc8823", automatic: true, adminUpload: false }, address: "jane@example.com" });
        expect(screen.getByText("Requested from the certificate authority. The CA sends a verification e-mail to jane@example.com.")).toBeInTheDocument();
        second.unmount();
        // The deployment is manual now, but this request was made to a CA.
        renderCard({ enrollment: { status: "pending", provider: "rfc8823" }, info: manual });
        expect(screen.getByText(/^Requested from the certificate authority\./)).toBeInTheDocument();
        expect(screen.queryByText(/administrator has to upload/)).not.toBeInTheDocument();
    });

    it("says a manual deployment's request waits for an administrator - with the date, no bar, no stages, never 'automatically'", () => {
        renderCard({ enrollment: { status: "pending", provider: "manual", requestedAt: ago(3 * 60_000) }, info: manual });
        expect(
            screen.getByText("This server issues signing certificates manually: an administrator has to upload the certificate for your request. Contact your administrator."),
        ).toBeInTheDocument();
        expect(screen.getByText("Administrator: admin@example.com")).toBeInTheDocument();
        expect(screen.getByText(/^Requested \S+.*\d/)).toBeInTheDocument();
        expect(screen.queryByText(/^Requested \d+ min ago/)).not.toBeInTheDocument();
        expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
        expect(screen.queryByRole("list", { name: "Certificate steps" })).not.toBeInTheDocument();
        expect(screen.queryByText(/automatic|background/i)).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Check status" })).toBeInTheDocument();
    });

    it("takes a manual deployment from the deployment's description when the enrollment does not say, without a contact address", () => {
        renderCard({ enrollment: { status: "pending" }, info: { backend: "manual", automatic: false, adminUpload: true } });
        expect(screen.getByText(/^This server issues signing certificates manually/)).toBeInTheDocument();
        expect(screen.queryByText(/^Administrator:/)).not.toBeInTheDocument();
    });

    it("shows what the CA reported and when it last worked - as a warning row, with 'never' when it never has", () => {
        const { unmount } = renderCard({
            enrollment: detailed,
            info: { ...automatic, health: { ok: false, lastError: "Rate limit exceeded", lastSuccessAt: "2026-09-21T09:15:00Z" } },
        });
        expect(screen.getByRole("alert")).toHaveTextContent(/^The certificate authority reported a problem: Rate limit exceeded \(last successful contact .*\d.*\)$/);
        unmount();
        renderCard({ enrollment: detailed, info: { ...automatic, health: { ok: false, lastError: "Unreachable" } } });
        expect(screen.getByRole("alert")).toHaveTextContent("The certificate authority reported a problem: Unreachable (last successful contact never)");
        cleanup();
        renderCard({ enrollment: detailed, info: { ...automatic, health: { ok: true } } });
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("says a request that has waited more than an hour without a change is taking longer than expected, with when it was last checked", () => {
        const stale = { status: "pending" as const, provider: "rfc8823" as const, requestedAt: ago(2 * 3_600_000), updatedAt: ago(90 * 60_000), lastCheckedAt: ago(30_000) };
        renderCard({ enrollment: stale, info: automatic });
        expect(screen.getByText("This is taking longer than expected - last checked 30 s ago. Use Check status to ask again.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
        cleanup();
        // Recent activity, or a young request, is not late; and with nothing known about a check the sentence leaves it out.
        renderCard({ enrollment: { ...stale, updatedAt: ago(5 * 60_000) }, info: automatic });
        expect(screen.queryByText(/taking longer than expected/)).not.toBeInTheDocument();
        cleanup();
        renderCard({ enrollment: { status: "pending", requestedAt: ago(2 * 3_600_000) }, info: automatic });
        expect(screen.getByText("This is taking longer than expected. Use Check status to ask again.")).toBeInTheDocument();
    });
});

describe("what R3's server adds", () => {
    it("shows the server's note under a pending certificate's status, and says a CA that could not be reached will be asked again - as a pending one, not a failure", () => {
        renderCard({ enrollment: { ...detailed, note: "Waiting for the CA to send its e-mail.", errorCode: "ca-unreachable", retryable: true } });
        expect(screen.getByText("The certificate authority could not be reached just now - it will be asked again.")).toBeInTheDocument();
        expect(screen.getByText("Waiting for the CA to send its e-mail.")).toBeInTheDocument();
        expect(screen.getByText("Pending")).toBeInTheDocument();
        expect(screen.queryByText("Failed", { selector: "span" })).not.toBeInTheDocument();
    });

    it("says an issued certificate is being installed until the server says it is in the mailbox, with its note", () => {
        const issued = { status: "issued" as const, issuedAt: ago(60_000), notAfter: inDays(300), note: "It is put into your mailbox by a background job.", subject: "E=jane@example.com" };
        const { unmount } = renderCard({ mode: "issued", enrollment: issued });
        expect(screen.getByText("Issued - installing it on your mailbox (this takes a few minutes)")).toBeInTheDocument();
        expect(screen.getByText("It is put into your mailbox by a background job.")).toBeInTheDocument();
        expect(screen.getByText("Active")).toBeInTheDocument();
        unmount();
        renderCard({ mode: "issued", enrollment: { ...issued, installedAt: ago(1000), note: undefined } });
        expect(screen.getByText(/^Issued - valid until /)).toBeInTheDocument();
        expect(screen.queryByText(/installing it on your mailbox/)).not.toBeInTheDocument();
    });
});

describe("a failed certificate", () => {
    it("shows the reason, the steps up to the failure and a Try again button", async () => {
        const failed = { status: "failed" as const, error: "The CA could not verify the address.", stages: detailed.stages };
        const { onRequest } = renderCard({ mode: "failed", enrollment: failed });
        expect(screen.getByText("Failed", { selector: "span" })).toBeInTheDocument();
        expect(screen.getByRole("alert")).toHaveTextContent("Failed: The CA could not verify the address.");
        expect(screen.getByRole("list", { name: "Certificate steps" })).toBeInTheDocument();
        await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole("button", { name: "Try again" }));
        expect(onRequest).toHaveBeenCalledTimes(1);
    });

    it("says something even with no reason, and hides Try again when the server says it cannot be retried, or the viewer cannot request", () => {
        const { unmount } = renderCard({ mode: "failed", enrollment: null });
        expect(screen.getByRole("alert")).toHaveTextContent("Failed: the certificate could not be issued.");
        unmount();
        const second = renderCard({ mode: "failed", enrollment: { status: "failed", retryable: false } });
        expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
        second.unmount();
        const third = renderCard({ mode: "failed", enrollment: { status: "failed" }, canRequest: false });
        expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
        third.unmount();
        renderCard({ mode: "failed", enrollment: { status: "failed" }, onRequest: undefined });
        expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    });
});

describe("an expired certificate", () => {
    it("says when it expired and offers a new request", async () => {
        const { onRequest } = renderCard({ mode: "expired", enrollment: null, keyNotAfter: NOW - 86_400_000 });
        expect(screen.getByText("Expired", { selector: "span" })).toBeInTheDocument();
        expect(screen.getByText(/^Expired on .*Mail from this mailbox is no longer signed\.$/)).toBeInTheDocument();
        await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole("button", { name: "Request a new certificate" }));
        expect(onRequest).toHaveBeenCalledTimes(1);
    });

    it("still says it expired with no date, and offers nothing to someone who cannot request", () => {
        const { unmount } = renderCard({ mode: "expired", enrollment: null, canRequest: false });
        expect(screen.getByText("This certificate has expired. Mail from this mailbox is no longer signed.")).toBeInTheDocument();
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
        unmount();
        renderCard({ mode: "expired", enrollment: null, onRequest: undefined });
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });
});

describe("useNow", () => {
    function Clock({ enabled }: { enabled: boolean }) {
        return <span data-testid="now">{useNow(1000, enabled)}</span>;
    }

    it("re-reads the time on its interval, and stands still when disabled", async () => {
        const { unmount } = render(<Clock enabled />);
        const first = Number(screen.getByTestId("now").textContent);
        await act(() => vi.advanceTimersByTimeAsync(3000));
        expect(Number(screen.getByTestId("now").textContent)).toBeGreaterThanOrEqual(first + 3000);
        unmount();
        render(<Clock enabled={false} />);
        const still = screen.getByTestId("now").textContent;
        await act(() => vi.advanceTimersByTimeAsync(3000));
        expect(screen.getByTestId("now").textContent).toBe(still);
    });
});
