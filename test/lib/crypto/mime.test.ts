// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import {
    binaryStringToBytes,
    bytesToBinaryString,
    decodeBase64Text,
    decodeBodyBytes,
    decodeBodyText,
    decodeHeaderText,
    decodeQuotedPrintable,
    encodeAddressListHeaderValue,
    encodeUnstructuredHeaderValue,
    extractAddresses,
    isBinaryString,
    extractDisplayBody,
    parseMimeEntity,
    parseParameterizedHeader,
    plainTextToHtml,
    splitMultipart,
} from "../../../lib/crypto/mime.js";

describe("parseMimeEntity", () => {
    it("splits headers and body, unfolding folded header lines", () => {
        const entity = parseMimeEntity("Subject: a very\r\n long subject\r\nContent-Type: text/plain;\r\n\tcharset=utf-8\r\n\r\nbody\r\nline 2");
        expect(entity.headers["subject"]).toBe("a very long subject");
        expect(entity.headers["content-type"]).toBe("text/plain;\tcharset=utf-8");
        expect(entity.body).toBe("body\r\nline 2");
        expect(entity.rawHeaderBlock).toBe("Subject: a very\r\n long subject\r\nContent-Type: text/plain;\r\n\tcharset=utf-8");
    });

    it("tolerates bare-LF line endings", () => {
        const entity = parseMimeEntity("From: a@b\nTo: c@d\n\nhello\n");
        expect(entity.headers).toEqual({ from: "a@b", to: "c@d" });
        expect(entity.body).toBe("hello\n");
    });

    it("treats a leading blank line as an entity with no headers", () => {
        expect(parseMimeEntity("\r\nbody only")).toEqual({ fields: [], headers: {}, rawHeaderBlock: "", body: "body only" });
        expect(parseMimeEntity("\nbody only").body).toBe("body only");
    });

    it("treats an entity with no blank line as all headers", () => {
        expect(parseMimeEntity("X-A: 1").body).toBe("");
    });

    it("keeps every repeated field in order but maps each name to its first occurrence", () => {
        const entity = parseMimeEntity("HP-Outer: From: a\r\nhp-outer: To: b\r\nFrom: first@x\r\nFROM: second@x\r\n\r\n");
        expect(entity.fields.map((f) => f.value)).toEqual(["From: a", "To: b", "first@x", "second@x"]);
        expect(entity.headers["from"]).toBe("first@x");
    });

    it("skips lines with no colon or an empty field name", () => {
        expect(parseMimeEntity("garbage\r\n: novalue\r\nX: y\r\n\r\n").fields).toEqual([{ name: "X", value: "y" }]);
    });
});

describe("parseParameterizedHeader", () => {
    it("parses quoted and unquoted parameters case-insensitively", () => {
        expect(parseParameterizedHeader('Multipart/Signed; Protocol="application/pkcs7-signature"; MICALG=sha-256; boundary=abc')).toEqual({
            value: "multipart/signed",
            params: { protocol: "application/pkcs7-signature", micalg: "sha-256", boundary: "abc" },
        });
    });

    it("keeps semicolons and escaped quotes inside quoted values", () => {
        expect(parseParameterizedHeader('attachment; filename="a;b \\"c\\".txt"').params["filename"]).toBe('a;b "c".txt');
    });

    it("ignores malformed parameters and keeps the first of a duplicated one", () => {
        expect(parseParameterizedHeader("text/plain; junk; =x; charset=a; CHARSET=b").params).toEqual({ charset: "a" });
    });

    it("returns an empty value for an absent header", () => {
        expect(parseParameterizedHeader(undefined)).toEqual({ value: "", params: {} });
    });
});

describe("splitMultipart", () => {
    it("discards preamble and epilogue and tolerates transport padding", () => {
        const body = "preamble --b not a delimiter\r\n--b  \r\npart one\r\n--b\r\npart two\r\n--b-- \r\nepilogue\r\n--b\r\nignored";
        expect(splitMultipart(body, "b")).toEqual(["part one", "part two"]);
    });

    it("only recognizes delimiters at the start of a line and not longer boundary-prefixed lines", () => {
        const body = "--b\r\nx --b y\r\n--bb\r\n--b--";
        expect(splitMultipart(body, "b")).toEqual(["x --b y\r\n--bb"]);
    });

    it("handles bare-LF line endings, empty parts, and regex metacharacters in the boundary", () => {
        expect(splitMultipart("--a.b+c\n\n--a.b+c\none\n--a.b+c--", "a.b+c")).toEqual(["", "one"]);
        expect(splitMultipart("--a\r\n--a\r\nz\r\n--a--", "a")).toEqual(["", "z"]);
    });

    it("keeps a trailing part when the close delimiter is missing, and returns nothing without any delimiter", () => {
        expect(splitMultipart("--b\r\ntruncated", "b")).toEqual(["truncated"]);
        expect(splitMultipart("--b", "b")).toEqual([""]);
        expect(splitMultipart("no delimiters here", "b")).toEqual([]);
    });
});

describe("transfer-encoding decoding", () => {
    it("decodes base64 ignoring whitespace, and returns undefined for invalid base64", () => {
        expect(new TextDecoder().decode(decodeBase64Text("aGVs\r\nbG8="))).toBe("hello");
        expect(decodeBase64Text("!!!")).toBeUndefined();
    });

    it("decodes quoted-printable soft breaks and hex escapes, leaving invalid escapes literal", () => {
        const bytes = decodeQuotedPrintable("caf=C3=A9 =\r\nline=ZZ=3d\xc3\xa9=");
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(new TextDecoder().decode(bytes)).toBe("café line=ZZ=é=");
    });

    // Round-4 review (qp.mts): literal text is written run by run - its own bytes for a binary string, its
    // UTF-8 encoding otherwise (never one character at a time, which split surrogate pairs into U+FFFD).
    it("UTF-8 encodes literal runs of already-decoded text without splitting surrogate pairs", () => {
        expect(new TextDecoder().decode(decodeQuotedPrintable("smile 😀=20ok €"))).toBe("smile 😀 ok €");
    });

    // Round-5 review: the bytes-vs-UTF-8 choice was made per literal run, so in already-decoded text a run
    // holding only Latin-1 (`é`) was written as a lone 0xE9 byte while a run with an emoji was UTF-8.
    it("decides bytes vs UTF-8 once for the whole input, not per literal run", () => {
        expect(new TextDecoder().decode(decodeQuotedPrintable("café=20😀"))).toBe("café 😀");
        expect(Array.from(decodeQuotedPrintable("caf\xe9=20ok"))).toEqual([0x63, 0x61, 0x66, 0xe9, 0x20, 0x6f, 0x6b]);
    });

    it("decodes a large quoted-printable body in linear time", () => {
        const body = "abc=3Ddef ".repeat(300_000);
        const started = performance.now();
        const bytes = decodeQuotedPrintable(body);
        expect(bytes.length).toBe(8 * 300_000);
        expect(performance.now() - started).toBeLessThan(1500);
    });

    it("converts between bytes and binary strings, UTF-8 encoding strings that can't be binary", () => {
        const bytes = new Uint8Array(70_000).map((_, i) => i % 256);
        const binary = bytesToBinaryString(bytes);
        expect(binary.length).toBe(70_000);
        expect(isBinaryString(binary)).toBe(true);
        expect(binaryStringToBytes(binary)).toEqual(bytes);
        expect(isBinaryString("€")).toBe(false);
        expect(binaryStringToBytes("€")).toEqual(new Uint8Array([0xe2, 0x82, 0xac]));
    });

    it("decodeBodyBytes dispatches on Content-Transfer-Encoding", () => {
        const decode = (cte: string, body: string) => new TextDecoder().decode(decodeBodyBytes(parseMimeEntity(`Content-Transfer-Encoding: ${cte}\r\n\r\n${body}`)));
        expect(decode("BASE64", "aGk=")).toBe("hi");
        expect(decode("quoted-printable", "h=69")).toBe("hi");
        expect(decode("7bit", "hi")).toBe("hi");
    });

    it("decodeBodyText applies the charset, falls back to UTF-8 for unknown charsets, and passes 8bit text through", () => {
        expect(decodeBodyText(parseMimeEntity("Content-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: base64\r\n\r\n6Q=="))).toBe("é");
        expect(decodeBodyText(parseMimeEntity("Content-Type: text/plain; charset=x-bogus\r\nContent-Transfer-Encoding: base64\r\n\r\nw6k="))).toBe("é");
        expect(decodeBodyText(parseMimeEntity("Content-Transfer-Encoding: base64\r\n\r\n!!!"))).toBe("");
        expect(decodeBodyText(parseMimeEntity("Content-Transfer-Encoding: 8bit\r\n\r\nalready text"))).toBe("already text");
    });

    // Round-4 review: an 8bit body in a binary string (getMessageRawContent()'s Latin-1 decoding) is still raw
    // bytes, so its declared charset must be applied - previously it was returned undecoded.
    it("applies the charset to an 8bit body held as a binary string", () => {
        expect(decodeBodyText(parseMimeEntity("Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\ncaf\xc3\xa9"))).toBe("café");
        expect(decodeBodyText(parseMimeEntity("Content-Type: text/plain; charset=iso-8859-1\r\n\r\ncaf\xe9"))).toBe("café");
        // No charset: UTF-8.
        expect(decodeBodyText(parseMimeEntity("\r\nna\xc3\xafve"))).toBe("naïve");
    });

    it("passes through an 8bit body that was already decoded (not a binary string, or invalid in its charset)", () => {
        expect(decodeBodyText(parseMimeEntity("Content-Transfer-Encoding: 8bit\r\n\r\n€uro"))).toBe("€uro");
        expect(decodeBodyText(parseMimeEntity("Content-Type: text/plain; charset=utf-8\r\n\r\ncafé"))).toBe("café");
        expect(decodeBodyText(parseMimeEntity("Content-Type: text/plain; charset=x-bogus\r\n\r\ncafé"))).toBe("café");
    });

    it("decodeBodyBytes returns a binary-string body's own bytes", () => {
        expect(decodeBodyBytes(parseMimeEntity("Content-Transfer-Encoding: 8bit\r\n\r\n\xe9"))).toEqual(new Uint8Array([0xe9]));
    });
});

describe("decodeHeaderText", () => {
    it("decodes B and Q encoded-words, dropping whitespace only between adjacent encoded-words", () => {
        expect(decodeHeaderText("=?UTF-8?B?Q2Fmw6k=?= =?utf-8?q?_au_lait?= ok")).toBe("Café au lait ok");
        expect(decodeHeaderText("Re: =?ISO-8859-1?Q?caf=E9?=")).toBe("Re: café");
        expect(decodeHeaderText("=?UTF-8*en?B?aGk=?=")).toBe("hi");
    });

    it("leaves an encoded-word with an unknown charset, invalid base64, or undecodable bytes verbatim", () => {
        expect(decodeHeaderText("=?x-bogus?B?aGk=?=")).toBe("=?x-bogus?B?aGk=?=");
        expect(decodeHeaderText("=?UTF-8?B?a?=")).toBe("=?UTF-8?B?a?=");
        expect(decodeHeaderText("=?UTF-8?Q?=FF?=")).toBe("=?UTF-8?Q?=FF?=");
    });

    it("decodes a raw 8-bit UTF-8 header held as a binary string, keeping non-UTF-8 bytes as Latin-1", () => {
        expect(decodeHeaderText("caf\xc3\xa9")).toBe("café");
        expect(decodeHeaderText("caf\xe9")).toBe("café");
        expect(decodeHeaderText("plain")).toBe("plain");
    });
});

describe("header value encoding", () => {
    it("flattens CR/LF/NUL in an unstructured value so it can't inject a header", () => {
        expect(encodeUnstructuredHeaderValue("hi\r\nBcc: victim@example.com\0")).toBe("hi Bcc: victim@example.com ");
        expect(encodeUnstructuredHeaderValue("plain ascii\tsubject")).toBe("plain ascii\tsubject");
    });

    it("RFC 2047-encodes non-ASCII into folded words of at most 75 characters that round-trip", () => {
        const subject = `Réunion ${"😀".repeat(30)} fin`;
        const encoded = encodeUnstructuredHeaderValue(subject);
        const words = encoded.split("\r\n ");
        expect(words.length).toBeGreaterThan(1);
        for (const word of words) {
            expect(word.length).toBeLessThanOrEqual(75);
            expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
        }
        expect(decodeHeaderText(parseMimeEntity(`Subject: ${encoded}\r\n\r\n`).headers["subject"])).toBe(subject);
    });

    it("encodes only non-ASCII display names in an address list, keeping addr-specs verbatim", () => {
        expect(encodeAddressListHeaderValue("Bob <bob@example.com>, carol@example.com")).toBe("Bob <bob@example.com>, carol@example.com");
        const encoded = encodeAddressListHeaderValue('"Doe, Zoë" <zoe@example.com>, Jürgen <j@example.com>, <x@example.com>, plain@example.com, "Ann \\"A\\"" <a@example.com>, José');
        expect(encoded).not.toMatch(/[^\x20-\x7e\r\n]/);
        expect(extractAddresses(encoded)).toEqual(["zoe@example.com", "j@example.com", "x@example.com", "plain@example.com", "a@example.com"]);
        expect(encoded).toContain('"Ann \\"A\\"" <a@example.com>');
        expect(decodeHeaderText(encoded)).toBe('Doe, Zoë <zoe@example.com>, Jürgen <j@example.com>, <x@example.com>, plain@example.com, "Ann \\"A\\"" <a@example.com>, José');
    });

    // Round-5 review: group syntax was split on commas only, so the label and `;` ended up inside mailboxes.
    it("keeps RFC 5322 group syntax intact, encoding the group label as its own phrase", () => {
        const encoded = encodeAddressListHeaderValue("Équipe: Zoë <z@example.com>, b@example.com;, c@example.com");
        expect(encoded).not.toMatch(/[^\x20-\x7e\r\n]/);
        expect(encoded).toMatch(/^=\?UTF-8\?B\?[^?]+\?=: =\?UTF-8\?B\?[^?]+\?= <z@example.com>, b@example.com;, c@example.com$/);
        expect(decodeHeaderText(encoded)).toBe("Équipe: Zoë <z@example.com>, b@example.com;, c@example.com");
        expect(extractAddresses(encoded)).toEqual(["z@example.com", "b@example.com", "c@example.com"]);
        // An ASCII label is kept as written, an empty group stays empty, and a quoted label is unquoted to encode.
        expect(encodeAddressListHeaderValue('Team: Zoë <z@example.com>; "Ünd, Co":;')).toMatch(/^Team: =\?UTF-8\?B\?[^?]+\?= <z@example.com>; =\?UTF-8\?B\?[^?]+\?=:;$/);
        // A colon with no closing `;` is not a group, and a colon inside an angle-addr never opens one.
        expect(decodeHeaderText(encodeAddressListHeaderValue("Dr: Zoë <z@example.com>"))).toBe("Dr: Zoë <z@example.com>");
        expect(encodeAddressListHeaderValue("Zoë <@route:z@example.com>; x")).toMatch(/^=\?UTF-8\?B\?[^?]+\?= <@route:z@example.com>; x$/);
    });

    it("flattens CR/LF in an address list", () => {
        expect(encodeAddressListHeaderValue("a@example.com\r\nBcc: b@example.com")).toBe("a@example.com Bcc: b@example.com");
        expect(encodeAddressListHeaderValue("Zoë\r\n <z@example.com>")).toMatch(/^=\?UTF-8\?B\?[^?]+\?= <z@example.com>$/);
    });
});

describe("extractDisplayBody", () => {
    it("returns html only for text/html and text only for text/plain (the default with no Content-Type)", () => {
        expect(extractDisplayBody(parseMimeEntity("Content-Type: TEXT/HTML\r\n\r\n<p>x</p>"))).toEqual({ html: "<p>x</p>" });
        expect(extractDisplayBody(parseMimeEntity("Content-Type: text/plain\r\n\r\n<p>x</p>"))).toEqual({ text: "<p>x</p>" });
        expect(extractDisplayBody(parseMimeEntity("\r\nno headers"))).toEqual({ text: "no headers" });
        expect(extractDisplayBody(parseMimeEntity("Content-Type: image/png\r\n\r\nxx"))).toEqual({});
    });

    it("prefers a text/html alternative, skips attachments, and falls back to the first text/plain part", () => {
        const alternative = [
            "Content-Type: multipart/mixed; boundary=outer",
            "",
            "--outer",
            "Content-Type: text/html",
            "Content-Disposition: attachment; filename=a.html",
            "",
            "<p>attachment</p>",
            "--outer",
            "Content-Type: multipart/alternative; boundary=inner",
            "",
            "--inner",
            "Content-Type: text/plain",
            "",
            "plain",
            "--inner",
            "Content-Type: text/html",
            "Content-Transfer-Encoding: quoted-printable",
            "",
            "<p>rich=3D</p>",
            "--inner--",
            "--outer--",
        ].join("\r\n");
        expect(extractDisplayBody(parseMimeEntity(alternative))).toEqual({ html: "<p>rich=</p>" });

        const plainOnly = ["Content-Type: multipart/mixed; boundary=m", "", "--m", "Content-Type: image/png", "", "xx", "--m", "", "first", "--m", "", "second", "--m--"].join("\r\n");
        expect(extractDisplayBody(parseMimeEntity(plainOnly))).toEqual({ text: "first" });
    });

    it("returns nothing for a multipart with no boundary, no displayable part, or nesting beyond the depth limit", () => {
        expect(extractDisplayBody(parseMimeEntity("Content-Type: multipart/mixed\r\n\r\nx"))).toEqual({});
        expect(extractDisplayBody(parseMimeEntity("Content-Type: multipart/mixed; boundary=m\r\n\r\n--m\r\nContent-Type: image/png\r\n\r\nx\r\n--m--"))).toEqual({});
        let nested = "Content-Type: text/html\r\n\r\n<p>deep</p>";
        for (let i = 0; i < 9; i++) {
            nested = `Content-Type: multipart/mixed; boundary=b${i}\r\n\r\n--b${i}\r\n${nested}\r\n--b${i}--`;
        }
        expect(extractDisplayBody(parseMimeEntity(nested))).toEqual({});
    });
});

describe("plainTextToHtml", () => {
    it("escapes markup inside a whitespace-preserving pre", () => {
        expect(plainTextToHtml(`<script>&"'`)).toBe(
            '<pre style="white-space: pre-wrap; word-wrap: break-word; font-family: inherit">&lt;script&gt;&amp;&quot;&#39;</pre>',
        );
    });
});

describe("extractAddresses", () => {
    it("extracts lowercased addr-specs from display names, quoted commas, comments, and groups", () => {
        expect(extractAddresses('"Doe, Jane <x@evil>" <Jane@Example.com>, bob@example.com (Bob, maybe), Team: c@d.e, f@g.h;, undisclosed-recipients:;')).toEqual([
            "jane@example.com",
            "bob@example.com",
            "c@d.e",
            "f@g.h",
        ]);
        expect(extractAddresses(undefined)).toEqual([]);
        expect(extractAddresses("")).toEqual([]);
    });
});
