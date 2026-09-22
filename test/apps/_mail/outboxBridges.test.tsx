///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Folder, Message } from "@rapidmx/react-shared/mail/mailApi.js";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { openComposeFromOutside, registerComposeOpener, registerUnlockOpener, requestUnlockFromOutside } from "../../../apps/shared/mail/outbox/composeBridge.js";
import UnlockBridge from "../../../apps/shared/mail/outbox/UnlockBridge.js";
import { useOutboxStatus, OUTBOX_STATUS_LIMIT } from "../../../apps/shared/mail/outbox/useOutboxStatus.js";
import type { MailboxFolders } from "../../../apps/shared/components/mail/layout/MailShell.js";

const { requestUnlock } = vi.hoisted(() => ({ requestUnlock: vi.fn() }));
vi.mock("../../../apps/shared/components/layout/UnlockPromptProvider.js", () => ({ useUnlockPrompt: () => ({ requestUnlock }) }));

describe("compose and unlock bridges", () => {
    it("opens a compose window from outside React while a provider is registered, and says so when none is", () => {
        expect(openComposeFromOutside({ mailboxUid: "mb1" })).toBe(false);
        const open = vi.fn();
        const off = registerComposeOpener(open);
        expect(openComposeFromOutside({ mailboxUid: "mb1" })).toBe(true);
        expect(open).toHaveBeenCalledWith({ mailboxUid: "mb1" });
        // A stale unregister (a newer provider took over) leaves the newer one alone.
        const newer = vi.fn();
        const offNewer = registerComposeOpener(newer);
        off();
        expect(openComposeFromOutside({})).toBe(true);
        expect(newer).toHaveBeenCalled();
        offNewer();
        expect(openComposeFromOutside({})).toBe(false);
    });

    it("asks for an unlock through whatever prompt is registered, and rejects without one", async () => {
        await expect(requestUnlockFromOutside("mb1", [])).rejects.toThrow("No unlock prompt");
        const unlock = vi.fn().mockResolvedValue(undefined);
        const off = registerUnlockOpener(unlock);
        await requestUnlockFromOutside("mb1", []);
        expect(unlock).toHaveBeenCalledWith("mb1", []);
        const newer = vi.fn();
        const offNewer = registerUnlockOpener(newer);
        off();
        await requestUnlockFromOutside("mb1", []);
        expect(newer).toHaveBeenCalled();
        offNewer();
        await expect(requestUnlockFromOutside("mb1", [])).rejects.toThrow();
    });

    it("UnlockBridge connects the app's unlock prompt to it while mounted", async () => {
        requestUnlock.mockResolvedValue({});
        const { unmount } = render(<UnlockBridge />);
        await requestUnlockFromOutside("mb1", []);
        expect(requestUnlock).toHaveBeenCalledWith("mb1", []);
        unmount();
        await expect(requestUnlockFromOutside("mb1", [])).rejects.toThrow();
    });
});

describe("useOutboxStatus", () => {
    const outbox = { uid: "ob1", mailboxUid: "mb1", type: "outbox", name: "Outbox", unreadCount: 0, totalCount: 2 } as Folder;
    const inbox = { uid: "in1", mailboxUid: "mb1", type: "inbox", name: "Inbox", unreadCount: 0, totalCount: 5 } as Folder;
    const mailboxFolders = (folders: Folder[]): MailboxFolders[] => [{ mailbox: { uid: "mb1" } as never, folders }];

    function Probe(props: { folders: MailboxFolders[]; counts?: Record<string, { unread: number; total: number }>; tick?: number; enabled?: boolean }) {
        const statuses = useOutboxStatus(props.folders, props.counts ?? {}, props.tick ?? 0, props.enabled ?? true);
        return <span data-testid="statuses">{JSON.stringify(statuses)}</span>;
    }

    const failed = { uid: "m1", scheduledSendError: "Refused" };
    const going = { uid: "m2" };

    it("reads an occupied Outbox to say what its messages are doing, and again when its count or the live tick changes", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [failed, going]));
        const view = render(<Probe folders={mailboxFolders([outbox, inbox])} />);
        await waitFor(() => expect(view.getByTestId("statuses")).toHaveTextContent('"ob1":{"sending":1,"retrying":0,"failed":1,"scheduled":0}'));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String(fetchMock.mock.calls[0][0])).toContain(`limit=${OUTBOX_STATUS_LIMIT}`);
        view.rerender(<Probe folders={mailboxFolders([outbox, inbox])} tick={1} />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        view.rerender(<Probe folders={mailboxFolders([outbox, inbox])} counts={{ ob1: { unread: 0, total: 3 } }} tick={1} />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    });

    it("costs nothing while the Outbox is empty, forgets what it knew when it empties, and keeps it when a read fails", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [failed]));
        const view = render(<Probe folders={mailboxFolders([{ ...outbox, totalCount: 0 }])} />);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(fetchMock).not.toHaveBeenCalled();
        view.rerender(<Probe folders={mailboxFolders([outbox])} />);
        await waitFor(() => expect(view.getByTestId("statuses")).toHaveTextContent('"failed":1'));
        fetchMock.mockImplementation(() => jsonResponse(500, { message: "down" }));
        view.rerender(<Probe folders={mailboxFolders([outbox])} tick={2} />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(view.getByTestId("statuses")).toHaveTextContent('"failed":1');
        view.rerender(<Probe folders={mailboxFolders([outbox])} counts={{ ob1: { unread: 0, total: 0 } }} tick={2} />);
        await waitFor(() => expect(view.getByTestId("statuses")).toHaveTextContent("{}"));
    });

    it("does nothing while disabled, and ignores an answer that arrives after it was superseded", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [failed]));
        const view = render(<Probe folders={mailboxFolders([outbox])} enabled={false} />);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(fetchMock).not.toHaveBeenCalled();
        let release!: (response: Response) => void;
        fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)));
        view.rerender(<Probe folders={mailboxFolders([outbox])} />);
        await waitFor(() => expect(release).toBeDefined());
        view.unmount();
        release(jsonResponse(200, [failed, going] as unknown));
        await new Promise((resolve) => setTimeout(resolve, 10));
    });
});
