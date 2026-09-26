// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    downloadBytes,
    emlFileName,
    headerFromAddress,
    headerText,
    saveAsEml,
    sourceText,
} from "../../../apps/shared/components/mail/reading/messageExport.js";

// The bytes of "Subject: café" as a binary string, the way the server's raw endpoint is read: one character per byte.
const RAW = 'From: "Ann" <Ann@X.com>\r\nSubject: cafÃ©\r\n\r\nBody line\r\n';

/** jsdom has no object URLs: gives `URL` the two functions a download uses, and takes them away again. */
function stubObjectUrls(createObjectURL: (blob: Blob) => string, revokeObjectURL: (url: string) => void) {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: revokeObjectURL });
}

afterEach(() => {
    delete (URL as unknown as Record<string, unknown>).createObjectURL;
    delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("emlFileName", () => {
    it.each([
        ["Hello there", "Hello there.eml"],
        ['Q3: "plan" <draft>/final?', "Q3 plan draft final.eml"],
        ["  many    spaces  ", "many spaces.eml"],
        ["...hidden", "hidden.eml"],
        ["ends with dots...", "ends with dots.eml"],
        ["", "message.eml"],
        [undefined, "message.eml"],
        ["///", "message.eml"],
        ["a".repeat(150), `${"a".repeat(100)}.eml`],
    ])("names %j %j", (subject, expected) => {
        expect(emlFileName(subject)).toBe(expected);
    });
});

describe("the raw source", () => {
    it("is read as UTF-8 from the bytes of the binary string", () => {
        expect(sourceText(RAW)).toContain("Subject: café");
    });

    it("has a header block of its own, without the body", () => {
        expect(headerText(RAW)).toBe('From: "Ann" <Ann@X.com>\r\nSubject: café');
    });

    it("gives the address of its From header, lowercased, or none", () => {
        expect(headerFromAddress(RAW)).toBe("ann@x.com");
        expect(headerFromAddress("Subject: none\r\n\r\nbody")).toBeUndefined();
    });
});

describe("downloadBytes", () => {
    it("hands the bytes to the browser as a download, and lets the URL go later", () => {
        vi.useFakeTimers();
        const revokeObjectURL = vi.fn();
        stubObjectUrls(() => "blob:one", revokeObjectURL);
        const clicked: { href: string; download: string }[] = [];
        const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
            clicked.push({ href: this.href, download: this.download });
        });
        downloadBytes(new Uint8Array([1, 2, 3]), "x.bin", "application/octet-stream");
        expect(click).toHaveBeenCalledTimes(1);
        expect(clicked).toEqual([{ href: "blob:one", download: "x.bin" }]);
        expect(document.querySelector("a[download]")).toBeNull();
        expect(revokeObjectURL).not.toHaveBeenCalled();
        vi.advanceTimersByTime(60_000);
        expect(revokeObjectURL).toHaveBeenCalledWith("blob:one");
    });
});

describe("saveAsEml", () => {
    it("saves the message byte for byte, as message/rfc822, named after its subject", async () => {
        let blob: Blob | undefined;
        stubObjectUrls((b) => ((blob = b), "blob:eml"), vi.fn());
        let name = "";
        vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
            name = this.download;
        });
        saveAsEml(RAW, "Hello: there");
        expect(name).toBe("Hello there.eml");
        expect(blob!.type).toBe("message/rfc822");
        const bytes = new Uint8Array(await blob!.arrayBuffer());
        expect(bytes.length).toBe(RAW.length);
        expect(Array.from(bytes.slice(-11))).toEqual(Array.from(RAW.slice(-11)).map((c) => c.charCodeAt(0)));
    });
});
