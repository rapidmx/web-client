///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPushClient } from "@rapidmx/react-shared/mail/pushClient.js";
import { PUSH_NOTICE_ID, PUSH_OFFLINE_NOTICE_MS, usePushConnectionNotice } from "../../../apps/shared/notifications/pushStatus.js";
import { dismiss, getNotificationsSnapshot } from "../../../apps/shared/notifications/store.js";

function Probe({ enabled = true }: { enabled?: boolean }) {
    usePushConnectionNotice(enabled);
    return null;
}

/** Sets the shared push client's status the way the client itself would: the listeners hear it. */
function setStatus(status: "connecting" | "open" | "reconnecting" | "closed") {
    const client = getPushClient() as unknown as { setStatus(status: string): void };
    act(() => client.setStatus(status));
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

const shown = () => getNotificationsSnapshot().visible.filter((item) => item.id === PUSH_NOTICE_ID);

describe("usePushConnectionNotice", () => {
    it("says nothing for a short outage, and one subtle pop-up after more than ten seconds offline", () => {
        render(<Probe />);
        setStatus("reconnecting");
        act(() => {
            vi.advanceTimersByTime(PUSH_OFFLINE_NOTICE_MS - 1);
        });
        setStatus("open");
        act(() => {
            vi.advanceTimersByTime(60_000);
        });
        expect(shown()).toHaveLength(0);
        setStatus("reconnecting");
        setStatus("closed");
        setStatus("reconnecting");
        act(() => {
            vi.advanceTimersByTime(PUSH_OFFLINE_NOTICE_MS);
        });
        expect(shown()).toHaveLength(1);
        expect(shown()[0]).toMatchObject({ kind: "info", title: "Live updates are paused", sticky: true });
    });

    it("goes by itself when the connection is back, and comes again for the next outage", () => {
        render(<Probe />);
        setStatus("reconnecting");
        act(() => {
            vi.advanceTimersByTime(PUSH_OFFLINE_NOTICE_MS);
        });
        expect(shown()).toHaveLength(1);
        setStatus("open");
        expect(shown()).toHaveLength(0);
        setStatus("reconnecting");
        act(() => {
            vi.advanceTimersByTime(PUSH_OFFLINE_NOTICE_MS);
        });
        expect(shown()).toHaveLength(1);
    });

    it("shows once per outage even when the user dismissed it, and never keeps the notification in the history", () => {
        render(<Probe />);
        setStatus("connecting");
        setStatus("reconnecting");
        act(() => {
            vi.advanceTimersByTime(PUSH_OFFLINE_NOTICE_MS);
            dismiss(PUSH_NOTICE_ID);
        });
        setStatus("connecting");
        setStatus("reconnecting");
        act(() => {
            vi.advanceTimersByTime(PUSH_OFFLINE_NOTICE_MS * 3);
        });
        expect(shown()).toHaveLength(0);
        expect(getNotificationsSnapshot().history).toHaveLength(0);
    });

    it("does nothing while disabled or after unmounting", () => {
        const { unmount, rerender } = render(<Probe enabled={false} />);
        setStatus("reconnecting");
        act(() => {
            vi.advanceTimersByTime(PUSH_OFFLINE_NOTICE_MS * 2);
        });
        expect(shown()).toHaveLength(0);
        rerender(<Probe enabled />);
        setStatus("open");
        setStatus("reconnecting");
        unmount();
        act(() => {
            vi.advanceTimersByTime(PUSH_OFFLINE_NOTICE_MS * 2);
        });
        expect(shown()).toHaveLength(0);
    });
});
