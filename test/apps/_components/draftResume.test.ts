// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { resumeFromDraft } from "../../../apps/shared/components/mail/compose/draftResume.js";

const { getUnlockedKeys, evaluateMessageSecurity } = vi.hoisted(() => ({ getUnlockedKeys: vi.fn(), evaluateMessageSecurity: vi.fn() }));
vi.mock("../../../lib/crypto/keySession.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/crypto/keySession.js")>()),
    getUnlockedKeys,
}));
vi.mock("../../../lib/crypto/messageSecurity.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/crypto/messageSecurity.js")>()),
    evaluateMessageSecurity,
}));

function draft(overrides: Record<string, unknown> = {}) {
    return {
        uid: "d1",
        version: 0,
        dateCreated: "",
        dateModified: "",
        folderUid: "f-drafts",
        mailboxUid: "mb1",
        messageId: "d1@example.com",
        subject: "Resume",
        from: { address: "me@example.com", type: "to" },
        recipients: [
            { address: "tina@example.com", displayName: "Tina", type: "to" },
            { address: "cc@example.com", type: "cc" },
            { address: "bcc@example.com", type: "bcc" },
        ],
        sentDate: "",
        receivedDate: "",
        bodyPreview: "the preview",
        flags: { read: true, flagged: false, answered: false, forwarded: false },
        importance: "normal",
        hasAttachments: false,
        requestReceipt: true,
        ...overrides,
    } as never;
}

function serve(content: Response, attachments: unknown[] = []) {
    mockFetch((url) => {
        if (url.startsWith("/api/mail/messages/d1/content")) return content;
        if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, attachments);
        throw new Error(`unexpected ${url}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("resumeFromDraft()", () => {
    it("reads the recipients, subject, receipt request, body and attachments back from the server", async () => {
        serve(new Response("<p>Hi Tina</p>", { status: 200, headers: { "content-type": "text/html" } }), [{ uid: "a1", filename: "cv.pdf" }]);

        const resume = await resumeFromDraft(draft());

        expect(resume).toMatchObject({
            mailboxUid: "mb1",
            to: "Tina <tina@example.com>",
            cc: "cc@example.com",
            bcc: "bcc@example.com",
            subject: "Resume",
            requestReceipt: true,
            attachments: [{ uid: "a1", filename: "cv.pdf" }],
        });
        expect(resume?.html).toContain("Hi Tina");
    });

    it("turns a plain-text body into paragraphs, escaping it", async () => {
        mockFetch((url) => {
            if (url.startsWith("/api/mail/messages/d1/content")) return new Response("one < two\n\nline a\nline b", { status: 200, headers: { "content-type": "text/plain" } });
            if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, []);
            if (url.startsWith("/api/mail/messages/d1/raw") || url.includes("d1")) return new Response("Content-Type: text/plain\r\n\r\none < two\r\n\r\nline a\r\nline b", { status: 200 });
            throw new Error(`unexpected ${url}`);
        });

        const resume = await resumeFromDraft(draft());

        expect(resume?.html).toContain("&lt;");
        expect(resume?.html).toContain("<p>");
    });

    it("falls back to the preview when no body can be loaded", async () => {
        mockFetch((url) => {
            if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, []);
            return new Response("", { status: 500 });
        });

        const resume = await resumeFromDraft(draft({ requestReceipt: undefined }));

        expect(resume?.html).toBe("<p>the preview</p>");
        expect(resume?.requestReceipt).toBe(false);
    });

    it("returns nothing for an encrypted draft", async () => {
        expect(await resumeFromDraft(draft({ encrypted: true }))).toBeUndefined();
    });
});

describe("resumeFromDraft() for a draft sealed in a zero-access mailbox", () => {
    const sealed = { zeroAccess: { keyFingerprint: "fp", sealedSummary: "s" }, subject: "[...]" };
    const serveRaw = (raw: Response) =>
        mockFetch((url) => {
            if (url.startsWith("/api/mail/messages/d1/raw")) return raw;
            if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, []);
            throw new Error(`unexpected ${url}`);
        });

    afterEach(() => {
        getUnlockedKeys.mockReset();
        evaluateMessageSecurity.mockReset();
    });

    it("decrypts it with the unlocked keys, taking its body and subject from the decrypted message, never the server's /content", async () => {
        const keys = { masterKey: new Uint8Array(1) };
        getUnlockedKeys.mockReturnValue(keys);
        evaluateMessageSecurity.mockResolvedValue({ state: "protected_at_rest", zeroAccess: true, subject: "The real subject", html: "<p>Hidden body</p>", attachments: [] });
        const fetchMock = serveRaw(new Response("sealed mime", { status: 200 }));

        const resume = await resumeFromDraft(draft(sealed));

        expect(resume).toMatchObject({ subject: "The real subject", to: "Tina <tina@example.com>" });
        expect(resume!.html).toContain("Hidden body");
        expect(evaluateMessageSecurity).toHaveBeenCalledWith("sealed mime", keys);
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/content"))).toBe(false);
    });

    it("keeps the draft's own subject when the decrypted message has none", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(1) });
        evaluateMessageSecurity.mockResolvedValue({ state: "protected_at_rest", zeroAccess: true, text: "plain body", attachments: [] });
        serveRaw(new Response("sealed mime", { status: 200 }));

        const resume = await resumeFromDraft(draft(sealed));

        expect(resume).toMatchObject({ subject: "[...]" });
        expect(resume!.html).toContain("plain body");
    });

    it("leaves it to read while the mailbox is locked", async () => {
        getUnlockedKeys.mockReturnValue(undefined);
        expect(await resumeFromDraft(draft(sealed))).toBeUndefined();
    });

    it("leaves it to read when it doesn't open with the unlocked keys, or can't be fetched", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(1) });
        evaluateMessageSecurity.mockResolvedValue({ state: "none" });
        serveRaw(new Response("sealed mime", { status: 200 }));
        expect(await resumeFromDraft(draft(sealed))).toBeUndefined();

        serveRaw(new Response("nope", { status: 500 }));
        expect(await resumeFromDraft(draft(sealed))).toBeUndefined();
    });
});
