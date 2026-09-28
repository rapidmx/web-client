// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { formatMailAddress, splitMailAddress } from "../../../lib/mail/mailAddress.js";

describe("splitMailAddress", () => {
    it("keeps a distinct name and the address", () => {
        expect(splitMailAddress({ displayName: "Jean-Philippe", address: "jp@example.com" })).toEqual({
            name: "Jean-Philippe",
            address: "jp@example.com",
        });
    });

    it("reads the name from either displayName or name, displayName first", () => {
        expect(splitMailAddress({ name: "Jane", address: "jane@example.com" }).name).toBe("Jane");
        expect(splitMailAddress({ displayName: "Jane D", name: "Other", address: "jane@example.com" }).name).toBe("Jane D");
    });

    it("has no name when there is none, it is blank, or it is only the address again", () => {
        expect(splitMailAddress({ address: "jane@example.com" })).toEqual({ address: "jane@example.com" });
        expect(splitMailAddress({ displayName: "   ", address: "jane@example.com" })).toEqual({ address: "jane@example.com" });
        expect(splitMailAddress({ displayName: "Jane@Example.com", address: "jane@example.com" })).toEqual({
            address: "jane@example.com",
        });
    });

    it("trims and collapses whitespace, and drops line breaks and invisible or bidirectional-override characters", () => {
        expect(splitMailAddress({ displayName: "  Jane \n\t  Doe‮ ", address: " jane@example.com\r\n" })).toEqual({
            name: "Jane Doe",
            address: "jane@example.com",
        });
        expect(splitMailAddress({ displayName: "Ja​ne", address: "⁦jane@example.com⁩" })).toEqual({
            name: "Ja ne",
            address: "jane@example.com",
        });
    });

    it("reduces a name that is the whole From header (name plus the sender's own address) to the name", () => {
        expect(splitMailAddress({ displayName: '"Bob Allen" <bob@example.com>', address: "bob@example.com" })).toEqual({
            name: "Bob Allen",
            address: "bob@example.com",
        });
        expect(splitMailAddress({ displayName: "Bob Allen <BOB@example.com>", address: "bob@example.com" })).toEqual({
            name: "Bob Allen",
            address: "bob@example.com",
        });
        // Nothing but the address in brackets: no name at all.
        expect(splitMailAddress({ displayName: "<bob@example.com>", address: "bob@example.com" })).toEqual({ address: "bob@example.com" });
    });

    it("leaves a name that carries a different address exactly as it is, so it can be seen for what it is", () => {
        expect(splitMailAddress({ displayName: '"CEO" <ceo@bank.com>', address: "evil@example.net" })).toEqual({
            name: '"CEO" <ceo@bank.com>',
            address: "evil@example.net",
        });
        expect(splitMailAddress({ displayName: "Team <not-an-address>", address: "team@example.com" }).name).toBe("Team <not-an-address>");
    });
});

describe("formatMailAddress", () => {
    it("shows Name <address> for a named sender, so the address is never hidden", () => {
        expect(formatMailAddress({ displayName: "Jean-Philippe", address: "jp@example.com" })).toBe("Jean-Philippe <jp@example.com>");
    });

    it("shows the bare address with no name, a blank name, or a name that equals the address", () => {
        expect(formatMailAddress({ address: "jp@example.com" })).toBe("jp@example.com");
        expect(formatMailAddress({ displayName: "", address: "jp@example.com" })).toBe("jp@example.com");
        expect(formatMailAddress({ displayName: "JP@example.com", address: "jp@example.com" })).toBe("jp@example.com");
    });

    it("does not repeat the address when the name is the whole From header", () => {
        expect(formatMailAddress({ displayName: '"Bob Allen" <bob@example.com>', address: "bob@example.com" })).toBe(
            "Bob Allen <bob@example.com>",
        );
    });

    it("quotes a name with a comma, so it reads as one name", () => {
        expect(formatMailAddress({ displayName: "Doe, Jane", address: "jane@example.com" })).toBe('"Doe, Jane" <jane@example.com>');
    });

    it("quotes a name with quotes or backslashes, escaping them", () => {
        expect(formatMailAddress({ displayName: 'Jane "JD" Doe', address: "jane@example.com" })).toBe(
            '"Jane \\"JD\\" Doe" <jane@example.com>',
        );
        expect(formatMailAddress({ displayName: "Doe\\Jane", address: "jane@example.com" })).toBe('"Doe\\\\Jane" <jane@example.com>');
    });

    it("quotes a name with angle brackets, so it can't pose as a second address", () => {
        expect(formatMailAddress({ displayName: "Jane <boss@example.com>", address: "jane@example.com" })).toBe(
            '"Jane <boss@example.com>" <jane@example.com>',
        );
    });

    it("quotes a name with an @ or a look-alike of one", () => {
        expect(formatMailAddress({ displayName: "Support @ Acme", address: "help@acme.example" })).toBe('"Support @ Acme" <help@acme.example>');
        expect(formatMailAddress({ displayName: "ceo＠bank.com", address: "evil@example.net" })).toBe(
            '"ceo＠bank.com" <evil@example.net>',
        );
    });

    it("leaves a name with only a period or hyphen unquoted", () => {
        expect(formatMailAddress({ displayName: "Dr. Jane O-Neil", address: "jane@example.com" })).toBe("Dr. Jane O-Neil <jane@example.com>");
    });

    it("always shows the real address, even when the name contains a different one", () => {
        const shown = formatMailAddress({ displayName: "ceo@bank.com", address: "evil@example.net" });
        expect(shown).toBe('"ceo@bank.com" <evil@example.net>');
        expect(shown.endsWith("<evil@example.net>")).toBe(true);
    });
});
