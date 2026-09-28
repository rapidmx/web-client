// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import {
    buildComposeBodyHtml,
    buildForwardQuote,
    buildReplyQuote,
    buildReplyRecipients,
    buildReplyThreading,
    forwardSubject,
    MAX_REPLY_REFERENCES,
    replySubject,
} from "../../../../lib/mail/compose/composeQuoting.js";

function messageFixture(overrides: Record<string, unknown> = {}) {
    return {
        uid: "m1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f1",
        mailboxUid: "mb1",
        messageId: "abc@example.com",
        subject: "Hello there",
        from: { address: "sender@example.com", displayName: "Sender One", type: "to" as const },
        recipients: [
            { address: "u1@example.com", displayName: "Me", type: "to" as const },
            { address: "other@example.com", type: "cc" as const },
        ],
        sentDate: "2026-01-01T00:00:00.000Z",
        receivedDate: "2026-01-01T00:00:00.000Z",
        bodyPreview: "Hi there,\njust checking in.",
        flags: { read: false, flagged: false, answered: false, forwarded: false },
        importance: "normal" as const,
        hasAttachments: false,
        ...overrides,
    };
}

/** The content inside a quote's blockquote. */
function blockquoteContent(html: string): string {
    return /<blockquote[^>]*>([\s\S]*)<\/blockquote>$/.exec(html)![1];
}

describe("replySubject", () => {
    it("prepends 'Re: ' when the subject doesn't already have it", () => {
        expect(replySubject("Hello there")).toBe("Re: Hello there");
    });

    it("leaves a subject that already starts with 'Re:' (any casing) unchanged", () => {
        expect(replySubject("Re: Hello there")).toBe("Re: Hello there");
        expect(replySubject("RE: Hello there")).toBe("RE: Hello there");
    });
});

describe("forwardSubject", () => {
    it("prepends 'Fwd: ' when the subject doesn't already have it", () => {
        expect(forwardSubject("Hello there")).toBe("Fwd: Hello there");
    });

    it("leaves a subject that already starts with 'Fwd:' (any casing) unchanged", () => {
        expect(forwardSubject("Fwd: Hello there")).toBe("Fwd: Hello there");
        expect(forwardSubject("FWD: Hello there")).toBe("FWD: Hello there");
    });
});

describe("buildReplyQuote", () => {
    it("starts with an 'On <date>, Name <address> wrote:' line", () => {
        const when = new Date("2026-01-01T00:00:00.000Z").toLocaleString();
        expect(buildReplyQuote(messageFixture()).startsWith(`<p>On ${when}, Sender One &lt;sender@example.com&gt; wrote:</p>`)).toBe(true);
    });

    it("falls back to the body preview, one <p> per line, when no body is given", () => {
        expect(blockquoteContent(buildReplyQuote(messageFixture()))).toBe("<p>Hi there,</p><p>just checking in.</p>");
    });

    it("renders a blank line as a non-collapsing paragraph", () => {
        const message = messageFixture({ bodyPreview: "Hi there,\n\nJust checking in." });
        expect(buildReplyQuote(message)).toContain("<p>&nbsp;</p>");
    });

    it("shows just the address when the sender has no display name", () => {
        const message = messageFixture({ from: { address: "sender@example.com", type: "to" as const } });
        expect(buildReplyQuote(message)).toContain(", sender@example.com wrote:");
    });

    it("doesn't repeat the address when the display name is the whole From header", () => {
        const message = messageFixture({ from: { address: "bob@partner.test", displayName: '"Bob Allen" <bob@partner.test>', type: "to" as const } });
        expect(buildReplyQuote(message)).toContain(", Bob Allen &lt;bob@partner.test&gt; wrote:");
    });

    it("shows the address alone when the display name is a different address", () => {
        const message = messageFixture({ from: { address: "bob@partner.test", displayName: "ceo@corp.test", type: "to" as const } });
        expect(buildReplyQuote(message)).toContain(", bob@partner.test wrote:");
    });

    it("HTML-escapes the body preview", () => {
        const message = messageFixture({ bodyPreview: '<script>alert(1)</script> & "quoted"' });
        const html = buildReplyQuote(message);
        expect(html).not.toContain("<script>alert(1)</script>");
        expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
        expect(html).toContain("&amp;");
        expect(html).toContain("&quot;quoted&quot;");
    });

    it("quotes the full HTML body instead of the truncated preview", () => {
        const longText = "word ".repeat(400).trim();
        const message = messageFixture({ bodyPreview: longText.slice(0, 255) });
        const html = buildReplyQuote(message, { html: `<p>${longText}</p><p>The end.</p>` });
        expect(blockquoteContent(html)).toBe(`<p>${longText}</p><p>The end.</p>`);
    });

    it("prefers the HTML body over the text body", () => {
        const html = buildReplyQuote(messageFixture(), { html: "<p><b>Rich</b></p>", text: "Plain" });
        expect(blockquoteContent(html)).toBe("<p><b>Rich</b></p>");
    });

    it("quotes the full text body, escaped, when there is no HTML body", () => {
        const text = `First line <b>not bold</b>\n\n${"x".repeat(500)}\nLast line`;
        const html = buildReplyQuote(messageFixture(), { text });
        expect(blockquoteContent(html)).toBe(
            `<p>First line &lt;b&gt;not bold&lt;/b&gt;</p><p>&nbsp;</p><p>${"x".repeat(500)}</p><p>Last line</p>`,
        );
    });

    it("sanitizes the HTML body: no scripts, handlers, javascript: links, styles, forms, frames or remote resources", () => {
        const html = buildReplyQuote(messageFixture(), {
            html:
                "<html><head><style>body{background:url(https://tracker.example/bg.png)}</style>" +
                '<link rel="stylesheet" href="https://tracker.example/s.css"></head>' +
                '<body><p onclick="evil()">Hello <a href="javascript:evil()">bad</a> <a href="https://example.com/page">good</a></p>' +
                '<script>evil()</script><iframe src="https://tracker.example/f"></iframe>' +
                '<form action="https://tracker.example/f"><input name="x"></form>' +
                '<p style="background-image:url(https://tracker.example/p.png);color:red">Styled</p>' +
                '<img src="https://tracker.example/pixel.gif"><img src="cid:logo@x"><img alt="inline" src="data:image/png;base64,AAAA">' +
                "</body></html>",
        });
        const quoted = blockquoteContent(html);
        expect(quoted).not.toMatch(/tracker\.example|script|onclick|javascript:|<style|<link|<iframe|<form|<input|cid:/i);
        expect(quoted).toContain('<a href="https://example.com/page">good</a>');
        expect(quoted).toContain("color:red");
        expect(quoted).toContain('<img alt="inline" src="data:image/png;base64,AAAA">');
        expect(quoted.match(/<img/g)).toHaveLength(1);
    });

    it("falls back to the text body when the HTML body sanitizes to nothing visible", () => {
        const html = buildReplyQuote(messageFixture(), { html: "<script>evil()</script><p>&nbsp; </p>", text: "Plain body" });
        expect(blockquoteContent(html)).toBe("<p>Plain body</p>");
    });

    it("keeps an HTML body that is only an embedded image", () => {
        const html = buildReplyQuote(messageFixture(), { html: '<img src="data:image/png;base64,AAAA">' });
        expect(blockquoteContent(html)).toBe('<img src="data:image/png;base64,AAAA">');
    });

    it("falls back to the preview when neither body has content", () => {
        const html = buildReplyQuote(messageFixture({ bodyPreview: "Preview" }), { html: "", text: "  \n " });
        expect(blockquoteContent(html)).toBe("<p>Preview</p>");
    });

    it("quotes an empty paragraph when there is no body and no preview", () => {
        const html = buildReplyQuote(messageFixture({ bodyPreview: undefined }), {});
        expect(blockquoteContent(html)).toBe("<p>&nbsp;</p>");
    });
});

describe("buildForwardQuote", () => {
    it("includes the forwarded-message header block with From/Date/Subject/To", () => {
        const html = buildForwardQuote(messageFixture());
        expect(html).toContain("---------- Forwarded message ----------");
        expect(html).toContain("From: Sender One &lt;sender@example.com&gt;");
        expect(html).toContain("Subject: Hello there");
        expect(html).toContain("To: Me &lt;u1@example.com&gt;");
    });

    it("omits cc/bcc recipients from the To: header line", () => {
        const html = buildForwardQuote(messageFixture());
        expect(html).not.toContain("other@example.com");
    });

    it("shows each To recipient's name and address, without repeating an address the name already carries", () => {
        const message = messageFixture({
            recipients: [
                { address: "dave@partner.test", displayName: "Dave Diaz <dave@partner.test>", type: "to" as const },
                { address: "eve@partner.test", displayName: "someone-else@corp.test", type: "to" as const },
            ],
        });
        expect(buildForwardQuote(message)).toContain("To: Dave Diaz &lt;dave@partner.test&gt;, eve@partner.test");
    });

    it("falls back to '(no subject)' when the subject is blank", () => {
        const html = buildForwardQuote(messageFixture({ subject: "" }));
        expect(html).toContain("Subject: (no subject)");
    });

    it("quotes the full, sanitized body", () => {
        const html = buildForwardQuote(messageFixture(), { html: "<p>Full body</p><script>evil()</script>" });
        expect(blockquoteContent(html)).toBe("<p>Full body</p>");
    });
});

describe("buildComposeBodyHtml", () => {
    it("is empty with neither a signature nor a quote", () => {
        expect(buildComposeBodyHtml()).toBe("");
        expect(buildComposeBodyHtml("", "")).toBe("");
    });

    it("puts the caret's paragraph and a blank line above the quote", () => {
        expect(buildComposeBodyHtml(undefined, "<blockquote>Hi</blockquote>")).toBe("<p></p><p></p><blockquote>Hi</blockquote>");
    });

    it("puts an empty paragraph above the signature", () => {
        expect(buildComposeBodyHtml("<p>Best,<br>Jane</p>")).toBe("<p></p><p>Best,<br>Jane</p>");
    });

    it("orders the empty paragraph, the signature, a blank line, another blank line, then the quote", () => {
        expect(buildComposeBodyHtml("<p>Best,<br>Jane</p>", "<blockquote>Hi</blockquote>")).toBe(
            "<p></p><p>Best,<br>Jane</p><p></p><p></p><blockquote>Hi</blockquote>",
        );
    });

    it("leaves a signature-only body with exactly one empty paragraph, so nothing but a reply gains a blank line", () => {
        expect(buildComposeBodyHtml("<p>Best,<br>Jane</p>").match(/<p><\/p>/g)).toHaveLength(1);
        expect(buildComposeBodyHtml(undefined, "<blockquote>Hi</blockquote>").match(/<p><\/p>/g)).toHaveLength(2);
    });
});

describe("buildReplyThreading", () => {
    it("replies to a thread's first message with that message alone", () => {
        expect(buildReplyThreading(messageFixture({ messageId: "root@example.com", references: [] }) as any)).toEqual({
            inReplyTo: "root@example.com",
            references: ["root@example.com"],
        });
    });

    it("appends the replied-to message to its own chain", () => {
        expect(
            buildReplyThreading(messageFixture({ messageId: "second@example.com", references: ["root@example.com"] }) as any),
        ).toEqual({ inReplyTo: "second@example.com", references: ["root@example.com", "second@example.com"] });
    });

    it("tolerates a message with no references at all", () => {
        const { references } = buildReplyThreading(messageFixture({ messageId: "only@example.com", references: undefined }));
        expect(references).toEqual(["only@example.com"]);
    });

    it("never repeats the replied-to message, wherever its own chain already names it", () => {
        expect(
            buildReplyThreading(messageFixture({ messageId: "b@example.com", references: ["a@example.com", "b@example.com"] }) as any)
                .references,
        ).toEqual(["a@example.com", "b@example.com"]);
        expect(
            buildReplyThreading(messageFixture({ messageId: "b@example.com", references: ["b@example.com", "a@example.com"] }) as any)
                .references,
        ).toEqual(["a@example.com", "b@example.com"]);
    });

    it("drops blank and duplicated entries and trims each one", () => {
        expect(
            buildReplyThreading(
                messageFixture({ messageId: " c@example.com ", references: [" a@example.com ", "", "a@example.com", "   "] }) as any,
            ),
        ).toEqual({ inReplyTo: "c@example.com", references: ["a@example.com", "c@example.com"] });
    });

    it("keeps the thread's root and the newest ancestors when the chain is longer than the cap", () => {
        const long: string[] = Array.from({ length: MAX_REPLY_REFERENCES + 10 }, (_, i) => `r${i}@example.com`);
        const { references } = buildReplyThreading(messageFixture({ messageId: "latest@example.com", references: long }));
        expect(references).toHaveLength(MAX_REPLY_REFERENCES);
        expect(references[0]).toBe("r0@example.com");
        expect(references[references.length - 1]).toBe("latest@example.com");
        expect(references[references.length - 2]).toBe(`r${long.length - 1}@example.com`);
    });
});

describe("buildReplyRecipients", () => {
    const own = ["me@example.com", "Alias@Example.com"];
    const to = (address: string, displayName?: string) => ({ address, ...(displayName ? { displayName } : {}), type: "to" as const });
    const cc = (address: string, displayName?: string) => ({ address, ...(displayName ? { displayName } : {}), type: "cc" as const });
    const bcc = (address: string) => ({ address, type: "bcc" as const });

    it("replies to the sender only", () => {
        const message = messageFixture({
            from: to("sender@example.com", "Sender One"),
            recipients: [to("me@example.com"), to("bob@example.com"), cc("carol@example.com")],
        });
        expect(buildReplyRecipients(message, own, false)).toEqual({ to: [to("sender@example.com", "Sender One")], cc: [] });
    });

    it("replies all to the sender and the original To, with the original Cc as Cc, keeping display names", () => {
        const message = messageFixture({
            from: to("sender@example.com", "Sender One"),
            recipients: [to("bob@example.com", "Bob"), to("me@example.com"), cc("carol@example.com", "Carol"), bcc("hidden@example.com")],
        });
        expect(buildReplyRecipients(message, own, true)).toEqual({
            to: [to("sender@example.com", "Sender One"), to("bob@example.com", "Bob")],
            cc: [cc("carol@example.com", "Carol")],
        });
    });

    it("leaves out the mailbox's primary address and aliases, case-insensitively, from To and Cc", () => {
        const message = messageFixture({
            from: to("sender@example.com"),
            recipients: [to("ME@example.com"), to(" bob@example.com"), cc("alias@example.COM"), cc("carol@example.com")],
        });
        expect(buildReplyRecipients(message, own, true)).toEqual({
            to: [to("sender@example.com"), to(" bob@example.com")],
            cc: [cc("carol@example.com")],
        });
    });

    it("never repeats an address, in To or between To and Cc", () => {
        const message = messageFixture({
            from: to("sender@example.com"),
            recipients: [
                to("Sender@example.com"),
                to("bob@example.com"),
                to("BOB@example.com"),
                cc("bob@example.com"),
                cc("carol@example.com"),
                cc("carol@example.com"),
            ],
        });
        expect(buildReplyRecipients(message, own, true)).toEqual({
            to: [to("sender@example.com"), to("bob@example.com")],
            cc: [cc("carol@example.com")],
        });
    });

    it("cleans up a display name that carries the address, and drops one naming a different address", () => {
        const message = messageFixture({
            from: to("sender@example.com", '"Sender One" <sender@example.com>'),
            recipients: [to("bob@example.com", "Bob <BOB@example.com>"), cc("carol@example.com", "billing@corp.test")],
        });
        expect(buildReplyRecipients(message, own, true)).toEqual({
            to: [to("sender@example.com", "Sender One"), to("bob@example.com", "Bob")],
            cc: [{ address: "carol@example.com", displayName: undefined, type: "cc" }],
        });
    });

    it("cleans up the display name of a reply to a message the mailbox sent to nobody else", () => {
        const message = messageFixture({ from: to("me@example.com", "Ada <me@example.com>"), recipients: [] });
        expect(buildReplyRecipients(message, own, false)).toEqual({ to: [to("me@example.com", "Ada")], cc: [] });
    });

    it("never carries Bcc recipients over", () => {
        const message = messageFixture({ from: to("sender@example.com"), recipients: [bcc("hidden@example.com")] });
        expect(buildReplyRecipients(message, own, true)).toEqual({ to: [to("sender@example.com")], cc: [] });
    });

    it("skips recipients without an address", () => {
        const message = messageFixture({ from: to("sender@example.com"), recipients: [to(""), cc("  ")] });
        expect(buildReplyRecipients(message, own, true)).toEqual({ to: [to("sender@example.com")], cc: [] });
    });

    describe("a message the mailbox sent itself", () => {
        it("replies to the original To recipients, not back to the mailbox", () => {
            const message = messageFixture({
                from: to("Me@Example.com", "Me"),
                recipients: [to("bob@example.com", "Bob"), cc("carol@example.com"), bcc("hidden@example.com")],
            });
            expect(buildReplyRecipients(message, own, false)).toEqual({ to: [to("bob@example.com", "Bob")], cc: [] });
        });

        it("replies all to the original To, with the original Cc minus the mailbox as Cc", () => {
            const message = messageFixture({
                from: to("alias@example.com"),
                recipients: [to("bob@example.com"), to("me@example.com"), cc("carol@example.com"), cc("me@example.com"), bcc("hidden@example.com")],
            });
            expect(buildReplyRecipients(message, own, true)).toEqual({ to: [to("bob@example.com")], cc: [cc("carol@example.com")] });
        });

        it("replies to the original Cc when there was no other To recipient", () => {
            const message = messageFixture({ from: to("me@example.com"), recipients: [to("me@example.com"), cc("carol@example.com")] });
            expect(buildReplyRecipients(message, own, false)).toEqual({ to: [cc("carol@example.com")], cc: [] });
            expect(buildReplyRecipients(message, own, true)).toEqual({ to: [cc("carol@example.com")], cc: [] });
        });

        it("replies to the mailbox itself when it sent the message to nobody else", () => {
            const message = messageFixture({ from: to("me@example.com", "Me"), recipients: [to("alias@example.com"), bcc("hidden@example.com")] });
            expect(buildReplyRecipients(message, own, true)).toEqual({ to: [to("me@example.com", "Me")], cc: [] });
        });
    });
});
