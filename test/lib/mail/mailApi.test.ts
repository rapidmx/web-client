// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch } from "../testUtils.js";
import { ApiRequestError, configureApiBaseUrl, createApiClient } from "../../../lib/util/api.js";
import { deviceTimeZone } from "../../../lib/util/timeZone.js";
import {
    approveReceipt,
    archiveMessage,
    assembleDraft,
    assembleDraftRaw,
    forgetDraftImages,
    attachmentContentUrl,
    autoProvisionMailbox,
    cancelScheduledSend,
    classifyMessage,
    createDraft,
    deleteMessage,
    emptyFolder,
    purgeMessage,
    createFolder,
    createMailbox,
    declineReceipt,
    deleteMailbox,
    getMailbox,
    getMailboxAcl,
    getMessage,
    getMessageRawContent,
    grantMailboxAccess,
    impersonateUser,
    listAttachments,
    listFolders,
    listIngestQueue,
    listMailboxDomains,
    listMailboxes,
    listMessages,
    isSharedWithMe,
    listResourceMailboxes,
    listQuarantine,
    recallMessage,
    releaseQuarantineEntry,
    resolveMailboxOwner,
    revokeMailboxAccess,
    queueMessageSend,
    sendMessage,
    setMessageFlagged,
    setMessageLabels,
    setMessageRead,
    setMessagesFlagged,
    setMessagesLabels,
    setMessagesRead,
    moveMessage,
    moveMessages,
    bulkUpdateMessages,
    MAX_BULK_MESSAGE_UPDATE,
    setMessageRequestReceipt,
    setMessageVerificationSeal,
    VerificationSealConflictError,
    stopImpersonating,
    updateFolder,
    updateMailbox,
    deleteAttachment,
    uploadAttachment,
} from "../../../lib/mail/mailApi.js";

const mailbox = {
    uid: "mb1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ownerUserUid: "u1",
    primarySmtpAddress: "u1@example.com",
    aliasAddresses: [],
    displayName: "User One",
    timezone: "UTC",
    quotaBytes: 1_000_000_000,
    usedBytes: 0,
};

afterEach(() => {
    vi.unstubAllGlobals();
    configureApiBaseUrl("");
});

describe("listMailboxes", () => {
    it("fetches with default pagination", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [mailbox]));
        const result = await listMailboxes();
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes?limit=25&page=0", expect.anything());
        expect(result).toEqual([mailbox]);
    });

    it("forwards a custom page/limit", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listMailboxes({ page: 2, limit: 10 });
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes?limit=10&page=2", expect.anything());
    });

    it("sends ?scope=admin only when the administration scope is asked for", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listMailboxes({ scope: "admin", limit: 50 });
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes?limit=50&page=0&scope=admin", expect.anything());
        await listMailboxes({ limit: 50 });
        expect(fetchMock).toHaveBeenLastCalledWith("/api/mail/mailboxes?limit=50&page=0", expect.anything());
    });
});

describe("isSharedWithMe", () => {
    it("is a delegate's mailbox - an owned one is not - and, from an older server, one with no owner", () => {
        expect(isSharedWithMe({ accessRole: "delegate", ownerUserUid: "u1" })).toBe(true);
        expect(isSharedWithMe({ accessRole: "delegate" })).toBe(true);
        expect(isSharedWithMe({ accessRole: "owner", ownerUserUid: "u1" })).toBe(false);
        expect(isSharedWithMe({ ownerUserUid: undefined })).toBe(true);
        expect(isSharedWithMe({ ownerUserUid: "u1" })).toBe(false);
    });
});

describe("listResourceMailboxes", () => {
    it("fetches with the isResource filter and default pagination", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [mailbox]));
        const result = await listResourceMailboxes();
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes?limit=25&page=0&isResource=true", expect.anything());
        expect(result).toEqual([mailbox]);
    });

    it("forwards a custom page/limit alongside the isResource filter", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listResourceMailboxes({ page: 1, limit: 100 });
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes?limit=100&page=1&isResource=true", expect.anything());
    });
});

describe("getMailbox", () => {
    it("fetches the encoded uid", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, mailbox));
        const result = await getMailbox("mb/1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/mb%2F1", expect.anything());
        expect(result).toEqual(mailbox);
    });

    it("asks for the administration scope only when told to", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, mailbox));
        await getMailbox("mb/1", { scope: "admin" });
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/mb%2F1?scope=admin", expect.anything());
    });
});

describe("createMailbox", () => {
    it("posts the input with aliasAddresses/usedBytes defaults", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, mailbox));
        await createMailbox({
            primarySmtpAddress: "support@example.com",
            displayName: "Support",
            timezone: "UTC",
            quotaBytes: 5_000_000_000,
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/mailboxes",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({
                    aliasAddresses: [],
                    usedBytes: 0,
                    primarySmtpAddress: "support@example.com",
                    displayName: "Support",
                    timezone: "UTC",
                    quotaBytes: 5_000_000_000,
                }),
            }),
        );
    });

    it("omits ownerUserUid when not given, for a true ownerless shared mailbox", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, mailbox));
        await createMailbox({
            primarySmtpAddress: "support@example.com",
            displayName: "Support",
            timezone: "UTC",
            quotaBytes: 5_000_000_000,
        });
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.ownerUserUid).toBeUndefined();
    });
});

describe("resolveMailboxOwner", () => {
    it("asks the server who a typed address, username or uid is, encoding it", async () => {
        const person = { userUid: "u1", displayName: "Jean-Philippe", address: "jp@example.com" };
        const fetchMock = mockFetch(() => jsonResponse(200, person));
        expect(await resolveMailboxOwner("jp@example.com")).toEqual(person);
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/resolve-owner?principal=jp%40example.com", expect.anything());
    });

    it("rejects with the server's own message when nobody is found", async () => {
        mockFetch(() => jsonResponse(404, { message: 'No user found for "nobody".' }));
        await expect(resolveMailboxOwner("nobody")).rejects.toMatchObject({ status: 404, message: 'No user found for "nobody".' });
    });
});

describe("listMailboxDomains", () => {
    it("fetches the configured domain list", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, ["example.com", "example.org"]));
        const result = await listMailboxDomains();
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/domains", expect.anything());
        expect(result).toEqual(["example.com", "example.org"]);
    });
});

describe("autoProvisionMailbox", () => {
    it("posts just the device's time zone when called with no selection", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { status: "created", mailbox }));
        const result = await autoProvisionMailbox();
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/mailboxes/auto-provision",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ timezone: deviceTimeZone() }) }),
        );
        expect(result).toEqual({ status: "created", mailbox });
    });

    it("posts the given alias/domain selection", async () => {
        const fetchMock = mockFetch(() =>
            jsonResponse(200, { status: "existing", mailbox }),
        );
        const result = await autoProvisionMailbox({ alias: "support", domain: "example.com" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/mailboxes/auto-provision",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ alias: "support", domain: "example.com", timezone: deviceTimeZone() }) }),
        );
        expect(result).toEqual({ status: "existing", mailbox });
    });

    it("resolves needs_selection with the alias options to choose from", async () => {
        const options = [{ alias: "jane", domain: "example.com", primarySmtpAddress: "jane@example.com" }];
        mockFetch(() => jsonResponse(200, { status: "needs_selection", options }));
        const result = await autoProvisionMailbox();
        expect(result).toEqual({ status: "needs_selection", options });
    });
});

describe("updateMailbox", () => {
    it("PUTs the encoded uid with the input", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...mailbox, displayName: "Renamed" }));
        const result = await updateMailbox({ uid: "mb/1", version: 0, displayName: "Renamed" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/mailboxes/mb%2F1",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({ uid: "mb/1", version: 0, displayName: "Renamed" }),
            }),
        );
        expect(result.displayName).toBe("Renamed");
    });
});

describe("deleteMailbox", () => {
    it("DELETEs the encoded uid with the version query param", async () => {
        const fetchMock = mockFetch(() => emptyResponse(200));
        await deleteMailbox("mb/1", 3);
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/mb%2F1?version=3", expect.objectContaining({ method: "DELETE" }));
    });

    it("asks the server to erase the mailbox's data too when told to", async () => {
        const fetchMock = mockFetch(() => emptyResponse(200));
        await deleteMailbox("mb/1", 3, { erase: true });
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/mb%2F1?version=3&erase=true", expect.objectContaining({ method: "DELETE" }));
    });

    it("does not ask for the erasure when the option is off", async () => {
        const fetchMock = mockFetch(() => emptyResponse(200));
        await deleteMailbox("mb1", 0, { erase: false });
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/mb1?version=0", expect.objectContaining({ method: "DELETE" }));
    });
});

describe("listQuarantine", () => {
    it("fetches with the mailboxUid query param and default pagination", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listQuarantine("mb1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/quarantine?limit=25&page=0&mailboxUid=mb1", expect.anything());
    });

    it("adds the administration scope when asked", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listQuarantine("mb1", { scope: "admin" });
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/quarantine?limit=25&page=0&mailboxUid=mb1&scope=admin", expect.anything());
    });
});

describe("releaseQuarantineEntry", () => {
    it("PUTs releasedAt/releasedByUserUid for the encoded uid", async () => {
        const now = new Date("2026-06-01T00:00:00.000Z");
        vi.useFakeTimers().setSystemTime(now);
        const released = { uid: "q1", version: 1, releasedAt: now.toISOString(), releasedByUserUid: "admin-1" };
        const fetchMock = mockFetch(() => jsonResponse(200, released));

        const result = await releaseQuarantineEntry("q/1", 0, "admin-1");

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/quarantine/q%2F1",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({ uid: "q/1", version: 0, releasedAt: now.toISOString(), releasedByUserUid: "admin-1" }),
            }),
        );
        expect(result).toEqual(released);
        vi.useRealTimers();
    });
});

describe("listIngestQueue", () => {
    it("fetches with the mailboxUid query param and default pagination", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listIngestQueue("mb1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/ingest-queue?limit=25&page=0&mailboxUid=mb1", expect.anything());
    });

    it("adds the administration scope when asked", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listIngestQueue("mb1", { scope: "admin" });
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/ingest-queue?limit=25&page=0&mailboxUid=mb1&scope=admin", expect.anything());
    });
});

describe("getMailboxAcl", () => {
    it("fetches the encoded mailbox uid", async () => {
        const acl = { uid: "mb1", version: 0, records: [] };
        const fetchMock = mockFetch(() => jsonResponse(200, acl));
        const result = await getMailboxAcl("mb/1");
        expect(fetchMock).toHaveBeenCalledWith("/api/acls/mb%2F1", expect.anything());
        expect(result).toEqual(acl);
    });
});

describe("grantMailboxAccess", () => {
    it("reads the current ACL then PUTs it with the new record appended", async () => {
        const acl = { uid: "mb1", version: 0, records: [{ userOrRoleId: "owner-1", actions: ["*"] }] };
        const fetchMock = mockFetch((url, init) => {
            if ((init?.method ?? "GET") === "GET") return jsonResponse(200, acl);
            return jsonResponse(200, { ...acl, version: 1 });
        });

        await grantMailboxAccess("mb1", "delegate-1", ["read", "list"]);

        expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/acls/mb1", expect.anything());
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            "/api/acls/mb1",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({
                    uid: "mb1",
                    version: 0,
                    records: [
                        { userOrRoleId: "owner-1", actions: ["*"] },
                        { userOrRoleId: "delegate-1", actions: ["read", "list"] },
                    ],
                }),
            }),
        );
    });

    it("replaces an existing record for the same userOrRoleId rather than duplicating it", async () => {
        const acl = { uid: "mb1", version: 0, records: [{ userOrRoleId: "delegate-1", actions: ["read"] }] };
        mockFetch((url, init) => ((init?.method ?? "GET") === "GET" ? jsonResponse(200, acl) : jsonResponse(200, acl)));

        const fetchMock2 = mockFetch((url, init) => ((init?.method ?? "GET") === "GET" ? jsonResponse(200, acl) : jsonResponse(200, acl)));
        await grantMailboxAccess("mb1", "delegate-1", ["read", "list", "count"]);
        const body = JSON.parse((fetchMock2.mock.calls[1][1] as RequestInit).body as string);
        expect(body.records).toEqual([{ userOrRoleId: "delegate-1", actions: ["read", "list", "count"] }]);
    });
});

describe("revokeMailboxAccess", () => {
    it("reads the current ACL then PUTs it with the matching record removed", async () => {
        const acl = {
            uid: "mb1",
            version: 2,
            records: [
                { userOrRoleId: "owner-1", actions: ["*"] },
                { userOrRoleId: "delegate-1", actions: ["read"] },
            ],
        };
        const fetchMock = mockFetch((url, init) => (
            (init?.method ?? "GET") === "GET" ? jsonResponse(200, acl) : jsonResponse(200, { ...acl, version: 3 })
        ));

        await revokeMailboxAccess("mb1", "delegate-1");

        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            "/api/acls/mb1",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({ uid: "mb1", version: 2, records: [{ userOrRoleId: "owner-1", actions: ["*"] }] }),
            }),
        );
    });
});

const folder = {
    uid: "f1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    name: "Inbox",
    type: "inbox" as const,
    unreadCount: 2,
    totalCount: 5,
};

describe("listFolders", () => {
    it("fetches with the mailboxUid query param", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [folder]));
        const result = await listFolders("mb1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/folders?limit=200&page=0&mailboxUid=mb1", expect.anything());
        expect(result).toEqual([folder]);
    });
});

describe("createFolder", () => {
    it("posts with zeroed counts filled in, and the given fields", async () => {
        const created = { ...folder, uid: "f-new", name: "Birthdays", type: "calendar" as const, color: "#2563eb" };
        const fetchMock = mockFetch(() => jsonResponse(200, created));
        const result = await createFolder({ mailboxUid: "mb1", name: "Birthdays", type: "calendar", color: "#2563eb" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/folders",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ unreadCount: 0, totalCount: 0, mailboxUid: "mb1", name: "Birthdays", type: "calendar", color: "#2563eb" }),
            }),
        );
        expect(result).toEqual(created);
    });
});

describe("updateFolder", () => {
    it("puts the given fields to the folder's uid", async () => {
        const updated = { ...folder, name: "Renamed", color: "#dc2626" };
        const fetchMock = mockFetch(() => jsonResponse(200, updated));
        const result = await updateFolder({ uid: "f1", version: 0, name: "Renamed", color: "#dc2626" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/folders/f1",
            expect.objectContaining({ method: "PUT", body: JSON.stringify({ uid: "f1", version: 0, name: "Renamed", color: "#dc2626" }) }),
        );
        expect(result).toEqual(updated);
    });
});

const message = {
    uid: "m1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    folderUid: "f1",
    mailboxUid: "mb1",
    messageId: "abc@example.com",
    subject: "Hello",
    from: { address: "a@example.com", type: "to" as const },
    recipients: [{ address: "b@example.com", type: "to" as const }],
    sentDate: "2026-01-01T00:00:00.000Z",
    receivedDate: "2026-01-01T00:00:00.000Z",
    bodyPreview: "Hi there",
    flags: { read: false, flagged: false, answered: false, forwarded: false },
    importance: "normal" as const,
    hasAttachments: false,
};

describe("listMessages", () => {
    it("fetches with the folderUid query param and no sort/filter of its own", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [message]));
        const result = await listMessages("f1");
        // The server already defaults to newest received first with a stable tiebreaker, so an unsorted,
        // unfiltered list sends neither - naming a sort here would only be able to get it wrong.
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages?limit=25&page=0&folderUid=f1", expect.anything());
        expect(result).toEqual([message]);
    });

    it("passes sortBy, sortOrder and filter through when they are set", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listMessages("f1", { limit: 50, page: 2, sortBy: "from", sortOrder: "desc", filter: "unread" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/messages?limit=50&page=2&folderUid=f1&sortBy=from&sortOrder=desc&filter=unread",
            expect.anything(),
        );
    });

    it("sends a label selection as one comma-separated labelUids value, alongside a filter", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listMessages("f1", { filter: "unread", labelUids: ["lbl-red", "lbl-blue"] });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/messages?limit=25&page=0&folderUid=f1&filter=unread&labelUids=lbl-red%2Clbl-blue",
            expect.anything(),
        );
    });

    it("sends no labelUids at all for an empty selection", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listMessages("f1", { labelUids: [] });
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages?limit=25&page=0&folderUid=f1", expect.anything());
    });
});

describe("getMessage", () => {
    it("fetches the encoded uid", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, message));
        const result = await getMessage("m/1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m%2F1", expect.anything());
        expect(result).toEqual(message);
    });
});

describe("recallMessage", () => {
    it("POSTs to the encoded uid's recall route", async () => {
        const updated = { ...message, recallRequestedAt: "2026-01-02T00:00:00.000Z" };
        const fetchMock = mockFetch(() => jsonResponse(200, updated));
        const result = await recallMessage("m/1");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/messages/m%2F1/recall",
            expect.objectContaining({ method: "POST" }),
        );
        expect(result).toEqual(updated);
    });
});

describe("archiveMessage", () => {
    it("POSTs to the encoded uid's archive route", async () => {
        const updated = { ...message, folderUid: "archive-folder" };
        const fetchMock = mockFetch(() => jsonResponse(200, updated));
        const result = await archiveMessage("m/1");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/messages/m%2F1/archive",
            expect.objectContaining({ method: "POST" }),
        );
        expect(result).toEqual(updated);
    });
});

describe("classifyMessage", () => {
    it("POSTs classifyAs with applyToSender defaulted to false", async () => {
        const updated = { ...message, inferenceClassification: "other" };
        const fetchMock = mockFetch(() => jsonResponse(200, updated));
        const result = await classifyMessage("m1", "other");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/messages/m1/classify",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ classifyAs: "other", applyToSender: false }) }),
        );
        expect(result).toEqual(updated);
    });

    it("forwards an explicit applyToSender", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, message));
        await classifyMessage("m1", "focused", true);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/messages/m1/classify",
            expect.objectContaining({ body: JSON.stringify({ classifyAs: "focused", applyToSender: true }) }),
        );
    });
});

describe("setMessageRead", () => {
    it("PUTs the message's uid/version with only the read flag changed", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...message, flags: { ...message.flags, read: true } }));
        await setMessageRead(message, true);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/messages/m1",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({
                    uid: "m1",
                    version: 0,
                    flags: { read: true, flagged: false, answered: false, forwarded: false },
                }),
            }),
        );
    });
});

describe("setMessageFlagged", () => {
    it("PUTs the message's uid/version with only the flagged flag changed", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...message, flags: { ...message.flags, flagged: true } }));
        await setMessageFlagged(message, true);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/messages/m1",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({
                    uid: "m1",
                    version: 0,
                    flags: { read: false, flagged: true, answered: false, forwarded: false },
                }),
            }),
        );
    });
});

describe("moveMessage", () => {
    it("PUTs the message's uid/version with the new folderUid", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...message, folderUid: "f2" }));
        await moveMessage(message, "f2");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/messages/m1",
            expect.objectContaining({ method: "PUT", body: JSON.stringify({ uid: "m1", version: 0, folderUid: "f2" }) }),
        );
    });
});

describe("bulk message updates", () => {
    const second = { ...message, uid: "m2" };

    it("PUTs the whole selection to the collection route in one request", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [message, second]));
        const result = await setMessagesRead([message, second], true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/messages",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify([
                    { uid: "m1", version: 0, flags: { read: true, flagged: false, answered: false, forwarded: false } },
                    { uid: "m2", version: 0, flags: { read: true, flagged: false, answered: false, forwarded: false } },
                ]),
            }),
        );
        expect(result).toEqual([message, second]);
    });

    it("flags, moves and relabels a selection through the same route", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await setMessagesFlagged([message], true);
        await moveMessages([message], "f2");
        await setMessagesLabels([message], ["l1"]);
        const bodies = fetchMock.mock.calls.map((call: any) => JSON.parse(call[1].body));
        expect(bodies[0][0].flags).toEqual({ read: false, flagged: true, answered: false, forwarded: false });
        expect(bodies[1][0]).toEqual({ uid: "m1", version: 0, folderUid: "f2" });
        expect(bodies[2][0]).toEqual({ uid: "m1", version: 0, labelUids: ["l1"] });
    });

    it("chunks a selection longer than MAX_BULK_MESSAGE_UPDATE rather than letting the server refuse it", async () => {
        const updates = Array.from({ length: MAX_BULK_MESSAGE_UPDATE + 5 }, (_unused, index) => ({
            uid: `m${index}`,
            version: 0,
        }));
        const fetchMock = mockFetch((_url, init) => jsonResponse(200, JSON.parse(String(init.body))));
        const result = await bulkUpdateMessages(updates);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).length).toBe(MAX_BULK_MESSAGE_UPDATE);
        expect(JSON.parse(String(fetchMock.mock.calls[1][1].body)).length).toBe(5);
        expect(result.length).toBe(MAX_BULK_MESSAGE_UPDATE + 5);
    });

    it("stops at the first rejected chunk instead of sending the rest", async () => {
        const updates = Array.from({ length: MAX_BULK_MESSAGE_UPDATE + 1 }, (_unused, index) => ({
            uid: `m${index}`,
            version: 0,
        }));
        const fetchMock = mockFetch(() => jsonResponse(409, { message: "stale version" }));
        await expect(bulkUpdateMessages(updates)).rejects.toBeInstanceOf(ApiRequestError);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("sends nothing at all for an empty selection", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        expect(await bulkUpdateMessages([])).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe("setMessageLabels", () => {
    it("PUTs the message's uid/version with the full new labelUids list", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...message, labelUids: ["l1", "l2"] }));
        await setMessageLabels(message, ["l1", "l2"]);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/messages/m1",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({ uid: "m1", version: 0, labelUids: ["l1", "l2"] }),
            }),
        );
    });
});

describe("cancelScheduledSend", () => {
    it("PUTs the message's uid/version, clearing scheduledSendTime and moving it into the given Drafts folder", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...message, folderUid: "f-drafts", scheduledSendTime: undefined }));
        await cancelScheduledSend(message, "f-drafts");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/messages/m1",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({ uid: "m1", version: 0, scheduledSendTime: null, folderUid: "f-drafts" }),
            }),
        );
    });
});

describe("setMessageRequestReceipt", () => {
    it("PUTs the message's uid/version with requestReceipt", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...message, requestReceipt: true }));
        await setMessageRequestReceipt(message, true);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/messages/m1",
            expect.objectContaining({ method: "PUT", body: JSON.stringify({ uid: "m1", version: 0, requestReceipt: true }) }),
        );
    });
});

describe("setMessageVerificationSeal", () => {
    const seal = "v1.eyJ2IjoxfQ.AAAA";

    it("PUTs { seal, masterKeyGeneration } to the encoded message's verification-seal route and returns the message", async () => {
        const updated = { ...message, verificationSeal: seal, verificationSealGeneration: 2 };
        const fetchMock = mockFetch(() => jsonResponse(200, updated));
        const result = await setMessageVerificationSeal("m/1", seal, 2);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/messages/m%2F1/verification-seal",
            expect.objectContaining({ method: "PUT", body: JSON.stringify({ seal, masterKeyGeneration: 2 }) }),
        );
        expect(result).toEqual(updated);
    });

    it("maps a 409 to VerificationSealConflictError (still an ApiRequestError with status 409)", async () => {
        mockFetch(() => jsonResponse(409, { message: "A different seal is stored.", code: "CONFLICT" }));
        const err = await setMessageVerificationSeal("m1", seal, 0).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(VerificationSealConflictError);
        expect(err).toBeInstanceOf(ApiRequestError);
        expect(err).toMatchObject({ name: "VerificationSealConflictError", status: 409, message: "A different seal is stored.", code: "CONFLICT" });
    });

    it.each([400, 403])("rethrows a %i as a plain ApiRequestError", async (status) => {
        mockFetch(() => jsonResponse(status, { message: "nope" }));
        const err = await setMessageVerificationSeal("m1", seal, 0).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ApiRequestError);
        expect(err).not.toBeInstanceOf(VerificationSealConflictError);
        expect((err as ApiRequestError).status).toBe(status);
    });

    it("rethrows a non-API failure unchanged", async () => {
        const boom = new TypeError("network down");
        mockFetch(() => {
            throw boom;
        });
        await expect(setMessageVerificationSeal("m1", seal, 0)).rejects.toBe(boom);
    });
});

describe("approveReceipt", () => {
    it("POSTs the receipt type to the approve route", async () => {
        const updated = { ...message, deliveryReceiptPending: false };
        const fetchMock = mockFetch(() => jsonResponse(200, updated));
        const result = await approveReceipt("m1", "delivery");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/messages/m1/receipt/approve",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ type: "delivery" }) }),
        );
        expect(result).toEqual(updated);
    });
});

describe("declineReceipt", () => {
    it("POSTs the receipt type to the decline route", async () => {
        const updated = { ...message, readReceiptPending: false };
        const fetchMock = mockFetch(() => jsonResponse(200, updated));
        const result = await declineReceipt("m1", "read");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/messages/m1/receipt/decline",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ type: "read" }) }),
        );
        expect(result).toEqual(updated);
    });
});

const attachment = {
    uid: "a1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    messageUid: "m1",
    folderUid: "f1",
    mailboxUid: "mb1",
    filename: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1234,
    isInline: false,
};

describe("listAttachments", () => {
    it("fetches with the folderUid/messageUid query params", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [attachment]));
        const result = await listAttachments("f1", "m1");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/attachments?limit=200&page=0&folderUid=f1&messageUid=m1",
            expect.anything(),
        );
        expect(result).toEqual([attachment]);
    });
});

describe("attachmentContentUrl", () => {
    it("builds the same-origin download URL for an encoded uid", () => {
        expect(attachmentContentUrl("a/1")).toBe("/api/mail/attachments/a%2F1/content");
    });

    it("prefixes the configured API base URL", () => {
        configureApiBaseUrl("https://mail.example.com");
        expect(attachmentContentUrl("a1")).toBe("https://mail.example.com/api/mail/attachments/a1/content");
    });
});

describe("deleteAttachment", () => {
    it("deletes the attachment at its version, through the client it is given", async () => {
        const fetchMock = mockFetch(() => new Response(null, { status: 204 }));
        await deleteAttachment("a/1", 4);
        expect(fetchMock.mock.calls[0][0]).toBe("/api/mail/attachments/a%2F1?version=4");
        expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("DELETE");

        const client = createApiClient({ baseUrl: "https://a.example.com", getAccessToken: async () => "tok" });
        await deleteAttachment("a1", 5, client);
        expect(fetchMock.mock.calls[1][0]).toBe("https://a.example.com/api/mail/attachments/a1?version=5");
    });
});

describe("uploadAttachment", () => {
    it("posts the file's raw bytes with its own content-type, not JSON", async () => {
        const file = new File(["hello"], "note.txt", { type: "text/plain" });
        const fetchMock = mockFetch(() => jsonResponse(200, attachment));

        const result = await uploadAttachment("m1", file);

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/attachments/upload?messageUid=m1&filename=note.txt&mimeType=text%2Fplain",
            expect.objectContaining({ method: "POST", body: file, credentials: "include" }),
        );
        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect(new Headers(init.headers).get("Content-Type")).toBe("text/plain");
        expect(result).toEqual(attachment);
    });

    it("targets the configured API base URL", async () => {
        configureApiBaseUrl("https://mail.example.com");
        const fetchMock = mockFetch(() => jsonResponse(200, attachment));
        await uploadAttachment("m1", new File(["hello"], "note.txt", { type: "text/plain" }));
        expect(fetchMock.mock.calls[0][0]).toBe(
            "https://mail.example.com/api/mail/attachments/upload?messageUid=m1&filename=note.txt&mimeType=text%2Fplain",
        );
    });

    it("falls back to application/octet-stream when the file has no type", async () => {
        const file = new File(["hello"], "note");
        const fetchMock = mockFetch(() => jsonResponse(200, attachment));

        await uploadAttachment("m1", file);

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/attachments/upload?messageUid=m1&filename=note&mimeType=application%2Foctet-stream",
            expect.anything(),
        );
    });

    it("writes a space in the file name as %20, never as the + of a form (the server would keep the plus sign: Screenshot+2025.png)", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, attachment));
        await uploadAttachment("m1", new File(["x"], "Screenshot 2025-12-02 223133.png", { type: "image/png" }));
        const url = fetchMock.mock.calls[0][0] as string;
        expect(url).toContain("filename=Screenshot%202025-12-02%20223133.png");
        expect(url).not.toContain("+");
    });

    it("sends an inline image with the Content-ID it was given, so the server can point the message's cid: reference at it", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, attachment));
        await uploadAttachment("m1", new File(["x"], "a.png", { type: "image/png" }), { inline: true, contentId: "pic@x" });
        expect(fetchMock.mock.calls[0][0]).toBe("/api/mail/attachments/upload?messageUid=m1&filename=a.png&mimeType=image%2Fpng&isInline=true&contentId=pic%40x");
    });

    it("gives an inline image a Content-ID of its own when none was given", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, attachment));
        await uploadAttachment("m1", new File(["x"], "a.png", { type: "image/png" }), { inline: true });
        const params = new URL(fetchMock.mock.calls[0][0] as string, "http://localhost").searchParams;
        expect(params.get("isInline")).toBe("true");
        expect(params.get("contentId")).toMatch(/^[0-9a-f-]{36}@inline\.rapidmx$/);
    });

    it("throws ApiRequestError using the body's message field on a non-ok response", async () => {
        const file = new File(["hello"], "note.txt", { type: "text/plain" });
        mockFetch(() => jsonResponse(400, { message: "too large", code: "api-101" }));

        await expect(uploadAttachment("m1", file)).rejects.toMatchObject({
            name: "ApiRequestError",
            message: "too large",
            status: 400,
            code: "api-101",
        });
    });

    it("falls back to the body's error field when message is absent", async () => {
        const file = new File(["hello"], "note.txt", { type: "text/plain" });
        mockFetch(() => jsonResponse(400, { error: "too large" }));

        await expect(uploadAttachment("m1", file)).rejects.toMatchObject({ message: "too large" });
    });

    it("treats an unparseable JSON body as no body", async () => {
        const file = new File(["hello"], "note.txt", { type: "text/plain" });
        mockFetch(() => new Response("not json", { status: 200, headers: { "content-type": "application/json" } }));

        const result = await uploadAttachment("m1", file);

        expect(result).toBeUndefined();
    });

    it("returns undefined for a non-JSON success response body", async () => {
        const file = new File(["hello"], "note.txt", { type: "text/plain" });
        mockFetch(() => new Response("", { status: 200, headers: { "content-type": "text/plain" } }));

        const result = await uploadAttachment("m1", file);

        expect(result).toBeUndefined();
    });

    it("falls back to statusText when the error response has no JSON body", async () => {
        const file = new File(["hello"], "note.txt", { type: "text/plain" });
        mockFetch(() => new Response(null, { status: 500, statusText: "Server Error" }));

        await expect(uploadAttachment("m1", file)).rejects.toMatchObject({ message: "Server Error", status: 500 });
    });

    it("falls back to statusText when the JSON body has neither message nor error", async () => {
        const file = new File(["hello"], "note.txt", { type: "text/plain" });
        mockFetch(() => jsonResponse(400, {}, { statusText: "Bad Request" }));

        await expect(uploadAttachment("m1", file)).rejects.toMatchObject({ message: "Bad Request" });
    });

    it("falls back to a generic message when there is no body and no statusText", async () => {
        const file = new File(["hello"], "note.txt", { type: "text/plain" });
        mockFetch(() => new Response(null, { status: 500, statusText: "" }));

        await expect(uploadAttachment("m1", file)).rejects.toMatchObject({ message: "Upload failed." });
    });
});

describe("createDraft", () => {
    it("posts the mailboxUid/folderUid with a generated messageId", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, message));
        await createDraft("mb1", "f1");
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
        expect(body.mailboxUid).toBe("mb1");
        expect(body.folderUid).toBe("f1");
        expect(body.messageId).toMatch(/@webmail$/);
        expect(body.inReplyTo).toBeUndefined();
        expect(body.references).toBeUndefined();
    });

    it("records what a reply replies to, so the server can thread it", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, message));
        await createDraft("mb1", "f1", { inReplyTo: "parent@example.com", references: ["root@example.com", "parent@example.com"] });
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.inReplyTo).toBe("parent@example.com");
        expect(body.references).toEqual(["root@example.com", "parent@example.com"]);
    });

    it("sends neither field for an empty threading argument", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, message));
        await createDraft("mb1", "f1", { inReplyTo: "", references: [] });
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect("inReplyTo" in body).toBe(false);
        expect("references" in body).toBe(false);
    });
});

describe("deleteMessage", () => {
    it("DELETEs the encoded message uid with its version", async () => {
        const fetchMock = mockFetch(() => new Response(null, { status: 204 }));
        await deleteMessage("m/1", 3);
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m%2F1?version=3", expect.objectContaining({ method: "DELETE" }));
    });
});

describe("purgeMessage", () => {
    it("DELETEs the encoded message uid with purge=true and no version", async () => {
        const fetchMock = mockFetch(() => new Response(null, { status: 204 }));
        await purgeMessage("m/1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m%2F1?purge=true", expect.objectContaining({ method: "DELETE" }));
    });

    it("rejects with the server's refusal, e.g. a legal hold", async () => {
        mockFetch(() => jsonResponse(409, { message: "This action is blocked by an active legal hold: x." }));
        await expect(purgeMessage("m1")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("legal hold") });
    });
});

describe("emptyFolder", () => {
    it("DELETEs the messages collection scoped to the encoded folder", async () => {
        const fetchMock = mockFetch(() => new Response(null, { status: 204 }));
        await emptyFolder("f/1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages?folderUid=f%2F1", expect.objectContaining({ method: "DELETE" }));
    });

    it("rejects with the server's refusal", async () => {
        mockFetch(() => jsonResponse(403, { message: "forbidden" }));
        await expect(emptyFolder("f1")).rejects.toMatchObject({ status: 403 });
    });
});

describe("assembleDraft", () => {
    it("posts the compose input to the encoded draft's assemble endpoint", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, message));
        const input = { to: [{ address: "b@example.com" }], subject: "Hi", html: "<p>Hi</p>" };
        const result = await assembleDraft("m/1", input);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/compose/m%2F1/assemble",
            expect.objectContaining({ method: "POST", body: JSON.stringify(input) }),
        );
        expect(result).toEqual(message);
    });

    describe("a picture embedded as a data: URI (a quoted original's image, one pasted into the editor)", () => {
        const PNG = "data:image/png;base64,iVBORw==";
        const JPG = "data:image/jpeg;base64,/9j/4A==";
        const PNG_SIGNATURE = "\x89PNG\r\n\x1a\n";
        /** A `data:` URI that really starts like a PNG, followed by `rest`. */
        const pngUri = (rest: string) => `data:image/png;base64,${btoa(PNG_SIGNATURE + rest)}`;
        const input = (html: string) => ({ to: [{ address: "b@example.com" }], subject: "Hi", html });
        const sent = (fetchMock: ReturnType<typeof mockFetch>) => fetchMock.mock.calls.filter(([url]) => String(url).includes("/assemble")).map(([, init]) => JSON.parse(init.body as string));
        const uploads = (fetchMock: ReturnType<typeof mockFetch>) => fetchMock.mock.calls.filter(([url]) => String(url).includes("/attachments/upload"));
        const respond = (url: string) => (url.includes("/attachments/upload") ? jsonResponse(200, { ...attachment, uid: "att 1" }) : jsonResponse(200, message));

        it("is attached to the draft as an inline part, and the message refers to the attachment instead - once, however often it is saved", async () => {
            const fetchMock = mockFetch(respond);
            const html = `<p>Hi</p><img src="${PNG}" alt="pic"><IMG alt='b' src='${PNG}'>`;

            await assembleDraft("d-once", input(html));
            await assembleDraft("d-once", input(html));

            expect(uploads(fetchMock)).toHaveLength(1);
            const url = new URL(uploads(fetchMock)[0][0] as string, "http://localhost");
            expect(url.searchParams.get("messageUid")).toBe("d-once");
            expect(url.searchParams.get("filename")).toBe("image.png");
            expect(url.searchParams.get("mimeType")).toBe("image/png");
            expect(url.searchParams.get("isInline")).toBe("true");
            expect(url.searchParams.get("contentId")).toMatch(/@inline\.rapidmx$/);
            const expected = `<p>Hi</p><img src="/api/mail/attachments/att%201/content" alt="pic"><IMG alt='b' src='/api/mail/attachments/att%201/content'>`;
            expect(sent(fetchMock).map((body) => body.html)).toEqual([expected, expected]);
        });

        it("attaches each different picture, naming it after its type", async () => {
            const fetchMock = mockFetch(respond);
            await assembleDraft("d-two", input(`<img src="${PNG}"><img src="${JPG}">`));
            expect(uploads(fetchMock).map(([url]) => new URL(url as string, "http://localhost").searchParams.get("filename"))).toEqual(["image.png", "image.jpg"]);
        });

        it("leaves one that is not a picture it can read as it was, and touches nothing when there is none", async () => {
            const fetchMock = mockFetch(respond);
            const broken = '<img src="data:image/png;base64,!!!">';
            await assembleDraft("d-bad", input(broken));
            await assembleDraft("d-none", input('<img src="https://example.com/a.png"><p>text</p>'));
            expect(uploads(fetchMock)).toHaveLength(0);
            expect(sent(fetchMock).map((body) => body.html)).toEqual([broken, '<img src="https://example.com/a.png"><p>text</p>']);
        });

        it("does not attach an SVG or any other type the quote itself would not embed, nor a picture over the size cap", async () => {
            const fetchMock = mockFetch(respond);
            const svg = `<img src="data:image/svg+xml;base64,${btoa("<svg xmlns='http://www.w3.org/2000/svg'/>")}">`;
            const tiff = `<img src="data:image/tiff;base64,${btoa("II*")}">`;
            const big = `<img src="${pngUri("A".repeat(2_000_001 - PNG_SIGNATURE.length))}">`;
            await assembleDraft("d-types", input(`${svg}${tiff}${big}`));
            expect(uploads(fetchMock)).toHaveLength(0);
            expect(sent(fetchMock).map((body) => body.html)).toEqual([`${svg}${tiff}${big}`]);

            const atCap = pngUri("A".repeat(2_000_000 - PNG_SIGNATURE.length));
            await assembleDraft("d-types", input(`<img src="${atCap}">`));
            expect(uploads(fetchMock)).toHaveLength(1);
        });

        it("tells two pictures of the same size apart, and attaches each once", async () => {
            const fetchMock = mockFetch(respond);
            const one = pngUri("A".repeat(500) + "x" + "A".repeat(500));
            const two = pngUri("A".repeat(500) + "y" + "A".repeat(500));
            await assembleDraft("d-same", input(`<img src="${one}"><img src="${two}">`));
            await assembleDraft("d-same", input(`<img src="${two}"><img src="${one}">`));
            expect(uploads(fetchMock)).toHaveLength(2);
        });

        it("uploads through the client it is given (its server, its token), not the cookie-based global fetch", async () => {
            const fetchMock = mockFetch(respond);
            const client = createApiClient({ baseUrl: "https://a.example.com", getAccessToken: async () => "tok" });
            await assembleDraft("d-client", input(`<img src="${PNG}">`), client);
            const [url, init] = uploads(fetchMock)[0];
            expect(url).toMatch(/^https:\/\/a\.example\.com\/api\/mail\/attachments\/upload\?/);
            expect(new Headers((init as RequestInit).headers).get("Authorization")).toBe("jwt tok");
        });

        it("leaves a picture whose bytes are not of the type it declares as it was (a quote can label anything image/png)", async () => {
            const fetchMock = mockFetch(respond);
            const forged = `<img src="data:image/png;base64,${btoa("MZ this is an executable, not a PNG")}"><img src="data:image/jpeg;base64,${btoa("%PDF-1.7")}"><img src="data:image/gif;base64,${btoa("not a gif")}">`;
            await assembleDraft("d-forged", input(forged));
            expect(uploads(fetchMock)).toHaveLength(0);
            expect(sent(fetchMock).map((body) => body.html)).toEqual([forged]);
        });

        it("attaches each kind of picture the type it declares, by its own signature", async () => {
            const fetchMock = mockFetch(respond);
            const uri = (type: string, bytes: number[]) => `<img src="data:image/${type};base64,${btoa(String.fromCharCode(...bytes))}">`;
            const text = (value: string) => Array.from(value, (char) => char.charCodeAt(0));
            const html = [
                uri("png", [0x89, 0x50, 0x4e, 0x47]),
                uri("jpg", [0xff, 0xd8, 0xff, 0xe0]),
                uri("gif", text("GIF89a")),
                uri("webp", [...text("RIFF"), 1, 2, 3, 4, ...text("WEBP")]),
                uri("avif", [0, 0, 0, 0x1c, ...text("ftypavif")]),
                uri("bmp", text("BM6")),
            ].join("");
            await assembleDraft("d-kinds", input(html));
            expect(uploads(fetchMock)).toHaveLength(6);
        });

        it("attaches at most 20 pictures to a draft; the rest stay as they were", async () => {
            const fetchMock = mockFetch(respond);
            const pictures = Array.from({ length: 25 }, (_, n) => `<img src="${pngUri(`picture ${n}`)}">`);
            await assembleDraft("d-cap", input(pictures.join("")));
            expect(uploads(fetchMock)).toHaveLength(20);
            const html = sent(fetchMock)[0].html as string;
            expect(html.match(/data:image\/png/g)).toHaveLength(5);
        });

        it("tells apart pictures however alike their text, by a cryptographic digest of the whole of it", async () => {
            const digest = vi.spyOn(crypto.subtle, "digest");
            mockFetch(respond);
            await assembleDraft("d-digest", input(`<img src="${PNG}">`));
            expect(digest).toHaveBeenCalledWith("SHA-256", expect.anything());
            digest.mockRestore();
        });

        it("still tells pictures apart where Web Crypto is not available", async () => {
            const fetchMock = mockFetch(respond);
            vi.stubGlobal("crypto", { randomUUID: () => "id" });
            await assembleDraft("d-nosubtle", input(`<img src="${pngUri("a")}"><img src="${pngUri("b")}">`));
            await assembleDraft("d-nosubtle", input(`<img src="${pngUri("b")}">`));
            vi.unstubAllGlobals();
            expect(uploads(fetchMock)).toHaveLength(2);
        });

        it("forgets a draft's pictures when asked, and no other's", async () => {
            const fetchMock = mockFetch(respond);
            const html = `<img src="${PNG}">`;
            await assembleDraft("d-forget", input(html));
            await assembleDraft("d-keep", input(html));
            expect(uploads(fetchMock)).toHaveLength(2);
            forgetDraftImages("d-forget");
            await assembleDraft("d-forget", input(html));
            await assembleDraft("d-keep", input(html));
            expect(uploads(fetchMock)).toHaveLength(3);
        });

        it("holds a bounded number of pictures, the oldest going first", async () => {
            const fetchMock = mockFetch(respond);
            const picture = (n: number) => `<img src="${pngUri(`picture ${n}`)}">`;
            for (let n = 0; n < 300; n++) {
                await assembleDraft("d-many", input(picture(n)));
            }
            const before = uploads(fetchMock).length;
            await assembleDraft("d-many", input(picture(299)));
            expect(uploads(fetchMock)).toHaveLength(before);
            await assembleDraft("d-many", input(picture(0)));
            expect(uploads(fetchMock)).toHaveLength(before + 1);
        });

        it("fails the save, rather than quietly dropping the picture, when it cannot be attached", async () => {
            mockFetch((url) => (url.includes("/attachments/upload") ? jsonResponse(413, { message: "too large" }) : jsonResponse(200, message)));
            await expect(assembleDraft("d-big", input(`<img src="${PNG}">`))).rejects.toMatchObject({ status: 413 });
        });
    });
});

describe("assembleDraftRaw", () => {
    it("posts the raw MIME source to the encoded draft's assemble-raw endpoint", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, message));
        const input = { to: [{ address: "b@example.com" }], subject: "[...]", rawMime: "raw mime source" };
        const result = await assembleDraftRaw("m/1", input);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/compose/m%2F1/assemble-raw",
            expect.objectContaining({ method: "POST", body: JSON.stringify(input) }),
        );
        expect(result).toEqual(message);
    });
});

describe("getMessageRawContent", () => {
    it("fetches the encoded message's raw endpoint and returns its text body", async () => {
        const fetchMock = mockFetch(() => new Response("From: a@example.com\r\n\r\nbody", { status: 200, headers: { "content-type": "message/rfc822" } }));
        const result = await getMessageRawContent("m/1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m%2F1/raw", { credentials: "include" });
        expect(result).toBe("From: a@example.com\r\n\r\nbody");
    });

    // Round-4 review: `res.text()` UTF-8-decoded the whole message, replacing a non-UTF-8 8bit part's bytes
    // with U+FFFD before its charset was known. The result is now a binary string: one code unit per byte.
    it("returns the body as a byte-preserving binary string, not UTF-8-decoded text", async () => {
        const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, 0xc3, 0xa9, 0x80, 0xff]);
        mockFetch(() => new Response(bytes, { status: 200, headers: { "content-type": "message/rfc822" } }));
        const result = await getMessageRawContent("m1");
        expect(Array.from(result, (ch) => ch.charCodeAt(0))).toEqual(Array.from(bytes));
    });

    it("targets the configured API base URL", async () => {
        configureApiBaseUrl("https://mail.example.com");
        const fetchMock = mockFetch(() => new Response("raw", { status: 200 }));
        await getMessageRawContent("m1");
        expect(fetchMock).toHaveBeenCalledWith("https://mail.example.com/api/mail/messages/m1/raw", { credentials: "include" });
    });

    it("throws ApiRequestError using the body's message field on a non-ok JSON response", async () => {
        mockFetch(() => jsonResponse(404, { message: "no such message", code: "api-404" }));
        await expect(getMessageRawContent("m1")).rejects.toMatchObject({
            name: "ApiRequestError",
            message: "no such message",
            status: 404,
            code: "api-404",
        });
    });

    it("falls back to statusText when a non-ok response has no JSON body", async () => {
        mockFetch(() => new Response(null, { status: 500, statusText: "Server Error" }));
        await expect(getMessageRawContent("m1")).rejects.toMatchObject({ message: "Server Error", status: 500 });
    });

    it("falls back to the body's error field when message is absent", async () => {
        mockFetch(() => jsonResponse(500, { error: "internal failure" }));
        await expect(getMessageRawContent("m1")).rejects.toMatchObject({ message: "internal failure" });
    });

    it("falls back to a generic message when there is no body and no statusText", async () => {
        mockFetch(() => new Response(null, { status: 500, statusText: "" }));
        await expect(getMessageRawContent("m1")).rejects.toMatchObject({ message: "Could not load this message's raw content." });
    });

    it("falls back to a generic message when the error response claims JSON but isn't parseable", async () => {
        mockFetch(() => new Response("not actually json", { status: 500, statusText: "", headers: { "content-type": "application/json" } }));
        await expect(getMessageRawContent("m1")).rejects.toMatchObject({ message: "Could not load this message's raw content." });
    });
});

describe("sendMessage", () => {
    it("posts to the encoded message's send endpoint", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, message));
        const result = await sendMessage("m/1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m%2F1/send", expect.objectContaining({ method: "POST" }));
        expect(result).toEqual(message);
        expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("body");
    });

    it("sends a scheduled time in the send request's body", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...message, scheduledSendTime: "2026-06-01T09:00:00.000Z" }));
        await sendMessage("m1", { scheduledSendTime: "2026-06-01T09:00:00.000Z" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/messages/m1/send",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ scheduledSendTime: "2026-06-01T09:00:00.000Z" }) }),
        );
    });
});

describe("queueMessageSend", () => {
    it("posts { background: true } and resolves the 202 answer as queued", async () => {
        const fetchMock = mockFetch(() => jsonResponse(202, { status: "queued", message }));
        const result = await queueMessageSend("m/1");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/messages/m%2F1/send",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ background: true }) }),
        );
        expect(result).toEqual({ queued: true, message });
    });

    it("treats a plain message answer (a server without a send queue, which relayed first) as already sent", async () => {
        mockFetch(() => jsonResponse(200, message));
        expect(await queueMessageSend("m1")).toEqual({ queued: false, message });
    });

    it("sends the ordinary synchronous way when the message class has no send job (501)", async () => {
        const fetchMock = mockFetch((url, init) =>
            (init).body ? jsonResponse(501, { message: "Background sends are not supported." }) : jsonResponse(200, message),
        );
        expect(await queueMessageSend("m1")).toEqual({ queued: false, message });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[1][1]).not.toHaveProperty("body");
    });

    it("rejects with the server's own error when it refused to queue the message", async () => {
        mockFetch(() => jsonResponse(400, { message: "At least one recipient is required.", code: "api-1" }));
        await expect(queueMessageSend("m1")).rejects.toMatchObject({ status: 400, message: "At least one recipient is required." });
    });
});

describe("impersonateUser", () => {
    it("posts the target user's uid to auth-server, with credentials included", async () => {
        const impersonationResult = { token: "tok", user: { uid: "u1", roles: [], scopes: [] } };
        const fetchMock = mockFetch(() => jsonResponse(200, impersonationResult));
        const result = await impersonateUser("https://auth.example.com", "u1");
        expect(fetchMock).toHaveBeenCalledWith(
            "https://auth.example.com/api/admin/impersonate",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ userUid: "u1" }),
                credentials: "include",
            }),
        );
        expect(result).toEqual(impersonationResult);
    });

    it("posts to this app's own local dev-only endpoint when impersonationBaseUrl is empty", async () => {
        const impersonationResult = { token: "tok", user: { uid: "u1", roles: [], scopes: [] } };
        const fetchMock = mockFetch(() => jsonResponse(200, impersonationResult));
        const result = await impersonateUser("", "u1");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/admin/impersonate",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ userUid: "u1" }) }),
        );
        expect(result).toEqual(impersonationResult);
    });
});

describe("stopImpersonating", () => {
    it("POSTs auth-server's stop endpoint with credentials included", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { restored: true }));
        const result = await stopImpersonating("https://auth.example.com");
        expect(fetchMock).toHaveBeenCalledWith(
            "https://auth.example.com/api/admin/impersonate/stop",
            expect.objectContaining({ method: "POST", credentials: "include" }),
        );
        expect(result).toEqual({ restored: true });
    });

    it("POSTs this app's own local dev-only stop endpoint when impersonationBaseUrl is empty", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { restored: true }));
        const result = await stopImpersonating("");
        expect(fetchMock).toHaveBeenCalledWith("/api/admin/impersonate/stop", expect.objectContaining({ method: "POST" }));
        expect(result).toEqual({ restored: true });
    });
});

describe("with an explicit ApiClient", () => {
    it("a directly network-backed function (getMailbox) routes through the given client's own baseUrl/token", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, mailbox));
        const result = await getMailbox("mb1", {}, client);
        expect(fetchMock).toHaveBeenCalledWith("https://account-a.example.com/api/mail/mailboxes/mb1", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
        expect(result).toEqual(mailbox);
    });

    it("grantMailboxAccess (read-modify-write via the internal getMailboxAcl call) threads the client through both requests", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const acl = { uid: "mb1", version: 0, records: [] };
        const fetchMock = mockFetch((url, init) => ((init?.method ?? "GET") === "GET" ? jsonResponse(200, acl) : jsonResponse(200, { ...acl, version: 1 })));

        await grantMailboxAccess("mb1", "delegate-1", ["read"], client);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toBe("https://account-a.example.com/api/acls/mb1");
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
        }
    });

    it("setMessagesRead (bulk update via the internal bulkUpdateMessages helper) threads the client through every chunk", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, [{ ...message, flags: { ...message.flags, read: true } }]));
        await setMessagesRead([message], true, client);
        expect(fetchMock).toHaveBeenCalledWith(
            "https://account-a.example.com/api/mail/messages",
            expect.objectContaining({ method: "PUT" }),
        );
        expect((fetchMock.mock.calls[0][1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
    });

    it("two distinct clients (two accounts) never cross-talk on the same call in the same test run", async () => {
        const clientA = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const clientB = createApiClient({ baseUrl: "https://account-b.example.com", getAccessToken: async () => "tok-b" });
        const fetchMock = mockFetch(() => jsonResponse(200, mailbox));

        await getMailbox("mb1", {}, clientA);
        await getMailbox("mb1", {}, clientB);

        expect(fetchMock.mock.calls[0][0]).toBe("https://account-a.example.com/api/mail/mailboxes/mb1");
        expect((fetchMock.mock.calls[0][1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
        expect(fetchMock.mock.calls[1][0]).toBe("https://account-b.example.com/api/mail/mailboxes/mb1");
        expect((fetchMock.mock.calls[1][1].headers as Headers).get("Authorization")).toBe("jwt tok-b");
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by a client created elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, mailbox));
        await getMailbox("mb1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/mb1", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});

describe("uploadAttachment through an explicit client", () => {
    it("goes to the client's origin with its token and the file's own type", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, attachment));
        const client = createApiClient({ baseUrl: "https://a.example.com", getAccessToken: async () => "tok" });
        const file = new File(["hello"], "note.txt", { type: "text/plain" });
        await expect(uploadAttachment("m1", file, { inline: true, contentId: "c@x" }, client)).resolves.toEqual(attachment);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("https://a.example.com/api/mail/attachments/upload?messageUid=m1&filename=note.txt&mimeType=text%2Fplain&isInline=true&contentId=c%40x");
        expect(init).toMatchObject({ method: "POST", body: file });
        expect((init as RequestInit).credentials).toBeUndefined();
        const headers = (init as RequestInit).headers as Headers;
        expect(headers.get("Content-Type")).toBe("text/plain");
        expect(headers.get("Authorization")).toBe("jwt tok");
    });
});
