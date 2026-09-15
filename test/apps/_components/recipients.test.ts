///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import {
    formatRecipient,
    isValidRecipientAddress,
    parseRecipient,
    parseRecipientList,
    splitRecipientList,
    splitTypedRecipients,
} from "../../../apps/shared/components/mail/compose/recipients.js";

describe("recipients", () => {
    it("splits at commas and semicolons outside quotes and angle brackets", () => {
        expect(splitRecipientList(" a@example.com, b@example.com;c@example.com ,, ; ")).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
        expect(splitRecipientList('"Smith, John" <john@example.com>; "Semi;colon \\" quote" <s@example.com>')).toEqual([
            '"Smith, John" <john@example.com>',
            '"Semi;colon \\" quote" <s@example.com>',
        ]);
        expect(splitRecipientList("Odd <a,b@example.com>, next@example.com")).toEqual(["Odd <a,b@example.com>", "next@example.com"]);
        // An unterminated quote or bracket runs to the end; a trailing backslash is kept.
        expect(splitRecipientList('"Open, quote <x@example.com>, y@example.com')).toEqual(['"Open, quote <x@example.com>, y@example.com']);
        expect(splitRecipientList("Open <x@example.com, y@example.com")).toEqual(["Open <x@example.com, y@example.com"]);
        expect(splitRecipientList('"trailing\\')).toEqual(['"trailing\\']);
        expect(splitRecipientList("")).toEqual([]);
    });

    it("splits typed text into finished recipients and the rest", () => {
        expect(splitTypedRecipients("a@example.com, b@exa")).toEqual({ finished: ["a@example.com"], rest: " b@exa" });
        expect(splitTypedRecipients("a@example.com;")).toEqual({ finished: ["a@example.com"], rest: "" });
        expect(splitTypedRecipients('"Smith, J')).toEqual({ finished: [], rest: '"Smith, J' });
        expect(splitTypedRecipients(",")).toEqual({ finished: [], rest: "" });
    });

    it("parses names and addresses", () => {
        expect(parseRecipient("jane@example.com")).toEqual({ address: "jane@example.com" });
        expect(parseRecipient(" Jane Doe <jane@example.com> ")).toEqual({ address: "jane@example.com", displayName: "Jane Doe" });
        expect(parseRecipient('"Doe, Jane \\"JD\\"" <jane@example.com>')).toEqual({ address: "jane@example.com", displayName: 'Doe, Jane "JD"' });
        expect(parseRecipient("<jane@example.com>")).toEqual({ address: "jane@example.com" });
        expect(parseRecipient('"" <jane@example.com>')).toEqual({ address: "jane@example.com" });
        expect(parseRecipient("not an address")).toEqual({ address: "not an address" });
        expect(parseRecipientList("Jane <jane@example.com>, bob@example.com")).toEqual([
            { address: "jane@example.com", displayName: "Jane" },
            { address: "bob@example.com" },
        ]);
    });

    it("formats recipients, quoting names that need it, and round-trips them", () => {
        expect(formatRecipient({ address: "jane@example.com" })).toBe("jane@example.com");
        expect(formatRecipient({ address: "jane@example.com", displayName: "  " })).toBe("jane@example.com");
        expect(formatRecipient({ address: "jane@example.com", displayName: "Jane Doe" })).toBe("Jane Doe <jane@example.com>");
        const tricky = { address: "jane@example.com", displayName: 'Doe; Jane "JD" \\ (HQ)' };
        const formatted = formatRecipient(tricky);
        expect(formatted).toBe('"Doe; Jane \\"JD\\" \\\\ (HQ)" <jane@example.com>');
        expect(parseRecipientList(`${formatted}, bob@example.com`)).toEqual([tricky, { address: "bob@example.com" }]);
    });

    it("validates plain addresses", () => {
        expect(isValidRecipientAddress("jane@example.com")).toBe(true);
        for (const address of ["jane", "jane@", "@example.com", "a b@example.com", "a@b@example.com", "not an address", "<a@example.com>"]) {
            expect(isValidRecipientAddress(address)).toBe(false);
        }
    });
});
