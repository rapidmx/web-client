// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    DESKTOP_OFFER_KEY,
    MAX_NEW_AGE_MS,
    NEW_MAIL_POPUPS_KEY,
    PREVIEW_MAX_LENGTH,
    cleanPreview,
    desktopPermission,
    getDesktopOfferDismissed,
    getNewMailPopupsEnabled,
    noticeFor,
    noticeSender,
    ownAddressesOf,
    requestDesktopPermission,
    setDesktopOfferDismissed,
    setNewMailPopupsEnabled,
    shouldAnnounce,
} from "../../../apps/shared/mail/newMailNotifications.js";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

const NOW = Date.parse("2026-09-20T12:00:00Z");
const folders = [
    { uid: "inbox", type: "inbox" },
    { uid: "sent", type: "sent_items" },
    { uid: "drafts", type: "drafts" },
    { uid: "outbox", type: "outbox" },
    { uid: "deleted", type: "deleted_items" },
    { uid: "junk", type: "junk" },
    { uid: "quarantine", type: "quarantine" },
] as any[];
const ownAddresses = new Set(["me@example.com"]);

function message(overrides: Record<string, unknown> = {}) {
    return {
        uid: "m1",
        folderUid: "inbox",
        mailboxUid: "mb1",
        subject: "Hello",
        from: { address: "Jane@Example.com", displayName: "Jane Doe", type: "to" },
        receivedDate: new Date(NOW - 60_000).toISOString(),
        bodyPreview: "Hi there",
        flags: { read: false },
        ...overrides,
    } as any;
}

describe("cleanPreview", () => {
    it("takes control characters, bidirectional overrides and zero-width characters out and folds whitespace", () => {
        expect(cleanPreview("a\u0000b\u0007c\n\n  d\te‮f​g⁦h⁩i﻿j\u0085k")).toBe("a b c d e f g h i j k");
    });

    it("cuts to the length with an ellipsis, and leaves a short text whole", () => {
        expect(cleanPreview("x".repeat(PREVIEW_MAX_LENGTH))).toBe("x".repeat(PREVIEW_MAX_LENGTH));
        const cut = cleanPreview("x".repeat(PREVIEW_MAX_LENGTH + 50));
        expect(cut).toHaveLength(PREVIEW_MAX_LENGTH);
        expect(cut.endsWith("…")).toBe(true);
        expect(cleanPreview("abcdef ghi", 8)).toBe("abcdef…");
    });

    it("does not treat markup as anything: it stays text", () => {
        expect(cleanPreview('<img src=x onerror="alert(1)"> & <b>bold</b>')).toBe('<img src=x onerror="alert(1)"> & <b>bold</b>');
    });
});

describe("noticeFor", () => {
    it("shows the sender's name and address, the subject and a preview, and where opening it goes", () => {
        expect(noticeFor(message())).toEqual({
            uid: "m1",
            mailboxUid: "mb1",
            folderUid: "inbox",
            senderName: "Jane Doe",
            senderAddress: "Jane@Example.com",
            subject: "Hello",
            preview: "Hi there",
            href: "/messages/m1",
        });
    });

    it("shows a sender with no name by address alone, and escapes a uid in the link", () => {
        const notice = noticeFor(message({ uid: "a/b c", from: { address: "jane@example.com", type: "to" } }));
        expect(notice.senderName).toBe("");
        expect(notice.senderAddress).toBe("jane@example.com");
        expect(notice.href).toBe("/messages/a%2Fb%20c");
    });

    it("cleans the subject and the preview, and cuts the preview to about 140 characters", () => {
        const notice = noticeFor(message({ subject: "Line\u0000 one\r\ntwo", bodyPreview: `${"word ".repeat(60)}` }));
        expect(notice.subject).toBe("Line one two");
        expect(notice.preview.length).toBeLessThanOrEqual(PREVIEW_MAX_LENGTH);
        expect(notice.preview.endsWith("…")).toBe(true);
    });

    it("stands in for a missing subject or body, and for an encrypted message's hidden subject", () => {
        expect(noticeFor(message({ subject: undefined, bodyPreview: undefined })).subject).toBe("(no subject)");
        expect(noticeFor(message({ subject: undefined, bodyPreview: undefined })).preview).toBe("");
        expect(noticeFor(message({ subject: "   " })).subject).toBe("(no subject)");
        const encrypted = noticeFor(message({ subject: "[...]", encrypted: true, bodyPreview: "Zm9v" }));
        expect(encrypted.subject).toBe("(encrypted subject)");
        expect(encrypted.preview).toBe("Encrypted message");
        // An encrypted message whose subject is readable keeps it, and never quotes its body.
        expect(noticeFor(message({ subject: "Contract", encrypted: true, bodyPreview: "cipher" }))).toMatchObject({
            subject: "Contract",
            preview: "Encrypted message",
        });
        // A plain message with the placeholder subject is shown as having none.
        expect(noticeFor(message({ subject: "[...]" })).subject).toBe("(no subject)");
    });
});

describe("noticeSender", () => {
    it("is Name <address>, or the address alone", () => {
        expect(noticeSender({ senderName: "Jane Doe", senderAddress: "jane@example.com" })).toBe("Jane Doe <jane@example.com>");
        expect(noticeSender({ senderName: "", senderAddress: "jane@example.com" })).toBe("jane@example.com");
    });
});

describe("ownAddressesOf", () => {
    it("lists every mailbox's own addresses, lowercased", () => {
        expect(
            ownAddressesOf([
                { primarySmtpAddress: " Me@Example.com ", aliasAddresses: ["Alias@Example.com", ""] },
                { primarySmtpAddress: "team@example.com" },
                { primarySmtpAddress: "" },
            ] as any[]),
        ).toEqual(new Set(["me@example.com", "alias@example.com", "team@example.com"]));
    });
});

describe("shouldAnnounce", () => {
    const decide = (overrides: Record<string, unknown> = {}, now = NOW) => shouldAnnounce(message(overrides), { folders, ownAddresses, now });

    it("announces unread mail in an Inbox", () => {
        expect(decide()).toBe(true);
        expect(decide({ flags: {} })).toBe(true);
        expect(decide({ inferenceClassification: "focused" })).toBe(true);
    });

    it("does not announce mail in Drafts, Sent Items, Outbox, Deleted Items, Junk Email, quarantine or a folder it doesn't know", () => {
        for (const folderUid of ["sent", "drafts", "outbox", "deleted", "junk", "quarantine", "nowhere"]) {
            expect(decide({ folderUid })).toBe(false);
        }
    });

    it("does not announce mail that is already read, or that Focused Inbox put under Other", () => {
        expect(decide({ flags: { read: true } })).toBe(false);
        expect(decide({ inferenceClassification: "other" })).toBe(false);
    });

    it("does not announce mail the user sent, whatever its capitalisation", () => {
        expect(decide({ from: { address: "ME@example.com" } })).toBe(false);
        expect(decide({ from: undefined })).toBe(true);
    });

    it("does not announce old mail (a bulk import), but does when the date can't be read", () => {
        expect(decide({ receivedDate: new Date(NOW - MAX_NEW_AGE_MS - 1).toISOString() })).toBe(false);
        expect(decide({ receivedDate: new Date(NOW - MAX_NEW_AGE_MS + 1_000).toISOString() })).toBe(true);
        expect(decide({ receivedDate: "not a date" })).toBe(true);
    });

    it("reads the clock itself when not given the time", () => {
        expect(shouldAnnounce(message({ receivedDate: new Date().toISOString() }), { folders, ownAddresses })).toBe(true);
        expect(shouldAnnounce(message({ receivedDate: "2001-01-01T00:00:00Z" }), { folders, ownAddresses })).toBe(false);
    });
});

describe("the pop-ups switch", () => {
    it("is on unless turned off, and remembers", () => {
        expect(getNewMailPopupsEnabled()).toBe(true);
        setNewMailPopupsEnabled(false);
        expect(localStorage.getItem(NEW_MAIL_POPUPS_KEY)).toBe("off");
        expect(getNewMailPopupsEnabled()).toBe(false);
        setNewMailPopupsEnabled(true);
        expect(localStorage.getItem(NEW_MAIL_POPUPS_KEY)).toBeNull();
        expect(getNewMailPopupsEnabled()).toBe(true);
    });

    it("is on, and changes nothing, when storage is blocked", () => {
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        expect(getNewMailPopupsEnabled()).toBe(true);
        expect(() => setNewMailPopupsEnabled(false)).not.toThrow();
        expect(() => setNewMailPopupsEnabled(true)).not.toThrow();
        expect(getDesktopOfferDismissed()).toBe(false);
    });
});

describe("the desktop-notifications offer", () => {
    it("is open until put away, and remembers", () => {
        expect(getDesktopOfferDismissed()).toBe(false);
        setDesktopOfferDismissed(true);
        expect(localStorage.getItem(DESKTOP_OFFER_KEY)).toBe("later");
        expect(getDesktopOfferDismissed()).toBe(true);
        setDesktopOfferDismissed(false);
        expect(getDesktopOfferDismissed()).toBe(false);
    });
});

describe("desktop permission", () => {
    it("is unsupported where there is no Notifications API", async () => {
        vi.stubGlobal("Notification", undefined);
        expect(desktopPermission()).toBe("unsupported");
        expect(await requestDesktopPermission()).toBe("unsupported");
    });

    it("reads the browser's permission and asks for it", async () => {
        const requestPermission = vi.fn().mockResolvedValue("granted");
        vi.stubGlobal("Notification", Object.assign(vi.fn(), { permission: "default", requestPermission }));
        expect(desktopPermission()).toBe("default");
        expect(await requestDesktopPermission()).toBe("granted");
        expect(requestPermission).toHaveBeenCalledTimes(1);
    });

    it("falls back to the current permission when asking throws", async () => {
        vi.stubGlobal(
            "Notification",
            Object.assign(vi.fn(), {
                permission: "denied",
                requestPermission: () => {
                    throw new Error("nope");
                },
            }),
        );
        expect(await requestDesktopPermission()).toBe("denied");
    });
});
