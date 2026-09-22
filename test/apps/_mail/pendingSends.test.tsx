///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    beginPendingSend,
    finishPendingSend,
    getPendingSends,
    isSendPending,
    pendingCountFor,
    resetPendingSends,
    setPendingStage,
    subscribePendingSends,
    usePendingSends,
    whenSettled,
} from "../../../apps/shared/mail/outbox/pendingSends.js";
import { flushComposeDrafts } from "../../../apps/shared/components/mail/compose/composeFlushRegistry.js";
import OutboxBadge from "../../../apps/shared/components/mail/OutboxBadge.js";
import { EMPTY_OUTBOX_STATUS, outboxItemStatus, outboxLabel, summarizeOutbox } from "../../../apps/shared/mail/outbox/outboxState.js";
import type { Message } from "@rapidmx/react-shared/mail/mailApi.js";

const entry = (draftUid: string, mailboxUid = "mb1") => ({ draftUid, mailboxUid, subject: "S", recipients: ["a@example.com"], scheduled: false });

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
    vi.useRealTimers();
});

describe("pending sends", () => {
    it("tracks a send until the server has it, one per draft, counted per mailbox", () => {
        expect(beginPendingSend(entry("d1"))).toBe(true);
        expect(beginPendingSend(entry("d1"))).toBe(false);
        expect(beginPendingSend(entry("d2", "mb2"))).toBe(true);
        expect(isSendPending("d1")).toBe(true);
        expect(getPendingSends().map((send) => [send.draftUid, send.stage])).toEqual([["d1", "preparing"], ["d2", "preparing"]]);
        setPendingStage("d1", "queuing");
        expect(getPendingSends()[0].stage).toBe("queuing");
        expect(pendingCountFor("mb1")).toBe(1);
        expect(pendingCountFor("mb2")).toBe(1);
        expect(pendingCountFor("mb3")).toBe(0);
        finishPendingSend("d1");
        finishPendingSend("d2");
        expect(getPendingSends()).toEqual([]);
    });

    it("asks the browser to confirm leaving while anything is pending, and stops when nothing is", () => {
        const leave = () => {
            const event = new Event("beforeunload", { cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
        };
        expect(leave()).toBe(false);
        beginPendingSend(entry("d1"));
        beginPendingSend(entry("d2"));
        expect(leave()).toBe(true);
        finishPendingSend("d1");
        expect(leave()).toBe(true);
        finishPendingSend("d2");
        expect(leave()).toBe(false);
    });

    it("makes Sign Out wait for a send still being prepared, and not for one that is done", async () => {
        beginPendingSend(entry("d1"));
        const flushed = flushComposeDrafts(5_000);
        setTimeout(() => finishPendingSend("d1"), 100);
        await vi.advanceTimersByTimeAsync(100);
        expect(await flushed).toBe(true);
        expect(await flushComposeDrafts(5_000)).toBe(true);
    });

    it("whenSettled resolves at once when nothing is pending, on settling, or false after the timeout", async () => {
        expect(await whenSettled(1000)).toBe(true);
        beginPendingSend(entry("d1"));
        const settled = whenSettled(1000);
        finishPendingSend("d1");
        expect(await settled).toBe(true);
        beginPendingSend(entry("d1"));
        const late = whenSettled(1000);
        await vi.advanceTimersByTimeAsync(1000);
        expect(await late).toBe(false);
        finishPendingSend("d1");
    });

    it("tells subscribers and a component, and forgets everything on reset", () => {
        function Probe() {
            return <span data-testid="count">{usePendingSends().length}</span>;
        }
        const listener = vi.fn();
        const off = subscribePendingSends(listener);
        render(<Probe />);
        expect(screen.getByTestId("count")).toHaveTextContent("0");
        act(() => {
            beginPendingSend(entry("d1"));
        });
        expect(screen.getByTestId("count")).toHaveTextContent("1");
        expect(listener).toHaveBeenCalled();
        off();
        act(() => resetPendingSends());
        expect(screen.getByTestId("count")).toHaveTextContent("0");
    });
});

describe("outboxState", () => {
    const message = (fields: Partial<Message>) => ({ uid: "m", ...fields }) as Message;
    const now = Date.parse("2026-09-21T10:00:00.000Z");

    it("reads what a message in Outbox is doing", () => {
        expect(outboxItemStatus(message({ scheduledSendError: "Refused" }), now)).toEqual({ state: "failed", attempts: 0, error: "Refused" });
        expect(outboxItemStatus(message({ scheduledSendLeaseExpiresAt: "2026-09-21T10:01:00.000Z" }), now)).toEqual({ state: "sending", attempts: 0 });
        expect(outboxItemStatus(message({ scheduledSendLeaseExpiresAt: "2026-09-21T10:01:00.000Z", scheduledSendAttempts: 2 }), now)).toEqual({ state: "retrying", attempts: 2 });
        expect(outboxItemStatus(message({ scheduledSendAttempts: 1, scheduledSendTime: "2026-09-21T10:05:00.000Z" }), now)).toEqual({ state: "retrying", attempts: 1, at: Date.parse("2026-09-21T10:05:00.000Z") });
        expect(outboxItemStatus(message({ scheduledSendAttempts: 1 }), now)).toEqual({ state: "retrying", attempts: 1, at: undefined });
        expect(outboxItemStatus(message({ scheduledSendTime: "2026-09-21T11:00:00.000Z" }), now)).toEqual({ state: "scheduled", attempts: 0, at: Date.parse("2026-09-21T11:00:00.000Z") });
        // Queued and waiting for the server's worker (nothing else set), or a lease that has run out.
        expect(outboxItemStatus(message({}), now)).toEqual({ state: "sending", attempts: 0 });
        expect(outboxItemStatus(message({ scheduledSendLeaseExpiresAt: "2026-09-21T09:00:00.000Z", scheduledSendTime: "2026-09-21T09:30:00.000Z" }), now)).toEqual({ state: "sending", attempts: 0 });
        expect(outboxItemStatus(message({}), undefined)).toMatchObject({ state: "sending" });
        // A background send is queued as a due message: its time is the server's "now", which a browser whose clock is behind sees in the future.
        expect(outboxItemStatus(message({ scheduledSendTime: "2026-09-21T10:00:30.000Z", dateModified: "2026-09-21T10:00:29.000Z" }), now)).toEqual({ state: "sending", attempts: 0 });
        expect(outboxItemStatus(message({ scheduledSendTime: "2026-09-21T13:00:00.000Z", dateModified: "2026-09-21T10:00:29.000Z" }), now)).toMatchObject({ state: "scheduled" });
        // The last error kept on a message that will be tried again is not a failure: only one with no time left to try is.
        expect(outboxItemStatus(message({ scheduledSendError: "Timeout", scheduledSendAttempts: 1, scheduledSendTime: "2026-09-21T10:05:00.000Z" }), now)).toMatchObject({ state: "retrying", attempts: 1 });
        expect(outboxItemStatus(message({ scheduledSendError: "Timeout", scheduledSendLeaseExpiresAt: "2026-09-21T10:01:00.000Z" }), now)).toMatchObject({ state: "sending" });
    });

    it("summarizes a folder and words it for a screen reader", () => {
        const items = [message({ scheduledSendError: "x" }), message({}), message({ scheduledSendAttempts: 1 }), message({ scheduledSendTime: "2999-01-01T00:00:00.000Z" })];
        expect(summarizeOutbox(items)).toEqual({ sending: 1, retrying: 1, failed: 1, scheduled: 1 });
        expect(summarizeOutbox([])).toEqual(EMPTY_OUTBOX_STATUS);
        expect(outboxLabel(3, { sending: 1, retrying: 0, failed: 2, scheduled: 0 }, 0)).toBe("3 messages, 2 failed");
        expect(outboxLabel(2, { sending: 2, retrying: 0, failed: 0, scheduled: 0 }, 0)).toBe("2 messages sending");
        expect(outboxLabel(1, undefined, 1)).toBe("1 message sending");
        expect(outboxLabel(2, { sending: 0, retrying: 0, failed: 0, scheduled: 2 }, 0)).toBe("2 messages scheduled");
        expect(outboxLabel(3, { sending: 0, retrying: 0, failed: 0, scheduled: 2 }, 0)).toBe("3 messages");
        expect(outboxLabel(1, undefined, 0)).toBe("1 message");
    });
});

describe("OutboxBadge", () => {
    it("is a plain count when nothing is on its way", () => {
        render(<OutboxBadge total={2} pendingHere={0} status={{ ...EMPTY_OUTBOX_STATUS, scheduled: 2 }} />);
        const badge = screen.getByTestId("outbox-badge");
        expect(badge).toHaveAttribute("data-state", "idle");
        expect(badge).toHaveAttribute("aria-live", "polite");
        expect(badge).toHaveTextContent("2 messages scheduled");
        expect(badge.querySelector(".rr-sending-dot")).toBeNull();
    });

    it("animates while anything is in flight - sent from here or reported by the server - and says so", () => {
        const { rerender } = render(<OutboxBadge total={1} pendingHere={1} />);
        expect(screen.getByTestId("outbox-badge")).toHaveAttribute("data-state", "sending");
        expect(screen.getByTestId("outbox-badge")).toHaveTextContent("1 message sending");
        expect(screen.getByTestId("outbox-badge").querySelector(".rr-sending-dot")).not.toBeNull();
        rerender(<OutboxBadge total={2} pendingHere={0} status={{ ...EMPTY_OUTBOX_STATUS, sending: 1, retrying: 1 }} />);
        expect(screen.getByTestId("outbox-badge")).toHaveAttribute("data-state", "sending");
        expect(screen.getByTestId("outbox-badge")).toHaveTextContent("2 messages sending");
    });

    it("is red when a message failed and is waiting, even if others are still going", () => {
        render(<OutboxBadge total={3} pendingHere={1} status={{ ...EMPTY_OUTBOX_STATUS, sending: 1, failed: 1 }} />);
        expect(screen.getByTestId("outbox-badge")).toHaveAttribute("data-state", "failed");
        expect(screen.getByTestId("outbox-badge").className).toContain("bg-danger");
        expect(screen.getByTestId("outbox-badge")).toHaveTextContent("3 messages, 1 failed");
    });
});
