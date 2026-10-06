// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { resumeFromDraft } from "../../../apps/shared/components/mail/compose/draftResume.js";

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
