// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Focused on the `client?: ApiClient` threading `useMessageActions()` itself adds - see `folderOfType.test.ts`,
// `messageReadState.test.ts` and `senderBlocking.test.ts` for the same proof on the modules it calls into.
import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../../lib/mail/mailApi.js";
import { ApiClientContext } from "../../../lib/util/apiClientContext.js";
import type { ApiClient } from "../../../lib/util/api.js";
import { useMessageActions } from "../../../apps/shared/components/mail/reading/useMessageActions.js";

const mailApi = vi.hoisted(() => ({
    moveMessage: vi.fn(),
    reportMessage: vi.fn(),
    setMessageFlagged: vi.fn(),
    getMessageRawContent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../lib/mail/mailApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/mail/mailApi.js")>()),
    ...mailApi,
}));

const senderListsApi = vi.hoisted(() => ({
    addBlockedSender: vi.fn(),
    addSafeSender: vi.fn(),
    removeBlockedSender: vi.fn(),
    removeSafeSender: vi.fn(),
}));
vi.mock("../../../lib/mail/senderListsApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/mail/senderListsApi.js")>()),
    ...senderListsApi,
}));

const folderOfType = vi.hoisted(() => ({ resolveFolderOfType: vi.fn().mockResolvedValue("junk-uid") }));
vi.mock("../../../apps/shared/mail/folderOfType.js", () => folderOfType);

const permanentDelete = vi.hoisted(() => ({
    usePermanentDelete: vi.fn(() => ({ requestPermanentDelete: vi.fn(), busy: false, dialog: null })),
}));
vi.mock("../../../apps/shared/mail/usePermanentDelete.js", () => permanentDelete);

function message(uid = "m1"): Message {
    return {
        uid,
        version: 1,
        mailboxUid: "mb1",
        folderUid: "inbox",
        subject: "Hi",
        from: { address: "sender@example.com" },
        flags: { read: false, flagged: false },
    } as Message;
}

function setUp(client?: ApiClient) {
    const msg = message();
    const trackMessageChange = vi.fn().mockReturnValue({ settle: vi.fn(), revert: vi.fn() });
    const view = renderHook(
        () =>
            useMessageActions({
                message: msg,
                newest: () => msg,
                remember: vi.fn(),
                folders: [],
                // Already in Junk Email: block()'s own move-to-Junk step is then a no-op, isolating the assertions below to
                // exactly the call each test means to check, rather than also exercising resolveFolderOfType/moveMessage.
                inJunk: true,
                inDeletedItems: false,
                trackMessageChange,
            }),
        {
            wrapper: ({ children }) =>
                client ? <ApiClientContext.Provider value={client}>{children}</ApiClientContext.Provider> : <>{children}</>,
        },
    );
    return { view, msg };
}

beforeEach(() => {
    mailApi.moveMessage.mockReset().mockImplementation(async (message: Message, folderUid: string) => ({ ...message, folderUid, version: message.version + 1 }));
    mailApi.reportMessage.mockReset();
    mailApi.setMessageFlagged.mockReset().mockImplementation(async (message: Message, flagged: boolean) => ({ ...message, flags: { ...message.flags, flagged } }));
    mailApi.getMessageRawContent.mockReset().mockResolvedValue(undefined);
    senderListsApi.addBlockedSender.mockReset().mockResolvedValue({ changed: true });
    senderListsApi.addSafeSender.mockReset().mockResolvedValue({ changed: true });
    senderListsApi.removeBlockedSender.mockReset().mockResolvedValue({ changed: true });
    senderListsApi.removeSafeSender.mockReset().mockResolvedValue({ changed: true });
    folderOfType.resolveFolderOfType.mockReset().mockResolvedValue("junk-uid");
});

describe("useMessageActions - ApiClient threading", () => {
    it("passes no client (the default global fetch path) with no ApiClientContext.Provider above it", async () => {
        const { view } = setUp();

        await act(async () => {
            await view.result.current.toggleFlag();
        });
        expect(mailApi.setMessageFlagged).toHaveBeenCalledWith(expect.objectContaining({ uid: "m1" }), true, undefined);

        await act(async () => {
            await view.result.current.blockSender();
        });
        expect(senderListsApi.addBlockedSender).toHaveBeenCalledWith("mb1", "sender@example.com", undefined);
    });

    it("passes the ApiClientContext value through to every REST call it makes", async () => {
        const client = {} as ApiClient;
        const { view } = setUp(client);

        await act(async () => {
            await view.result.current.toggleFlag();
        });
        expect(mailApi.setMessageFlagged).toHaveBeenCalledWith(expect.objectContaining({ uid: "m1" }), true, client);

        await act(async () => {
            await view.result.current.blockSender();
        });
        expect(senderListsApi.addBlockedSender).toHaveBeenCalledWith("mb1", "sender@example.com", client);

        // Report junk, when the server has the route, threads the client too.
        mailApi.reportMessage.mockResolvedValue({ kind: "junk", folderUid: "inbox", moved: false, learned: false });
        await act(async () => {
            await view.result.current.reportJunk();
        });
        expect(mailApi.reportMessage).toHaveBeenCalledWith("m1", "junk", { alwaysTrustSender: false }, client);
    });

    it("threads the client through resolveFolderOfType and moveMessage when a report route is missing (404 fallback)", async () => {
        const client = {} as ApiClient;
        const { ApiRequestError } = await import("../../../lib/util/api.js");
        mailApi.reportMessage.mockRejectedValue(new ApiRequestError("not found", 404));
        const { view } = setUp(client);

        await act(async () => {
            await view.result.current.reportJunk();
        });

        await waitFor(() => expect(folderOfType.resolveFolderOfType).toHaveBeenCalledWith("mb1", "junk", "Junk Email", [], undefined, client));
        expect(mailApi.moveMessage).toHaveBeenCalledWith(expect.objectContaining({ uid: "m1" }), "junk-uid", client);
    });
});
