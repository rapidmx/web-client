// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it } from "vitest";
import { parseSearchQuery } from "../../../lib/search/queryGrammar.js";

describe("parseSearchQuery: quoted phrases", () => {
    it("never takes an operator-looking word inside a quoted phrase for an operator", () => {
        expect(parseSearchQuery('"meeting from:bob"')).toEqual({ text: '"meeting from:bob"' });
        expect(parseSearchQuery('"has:attachment before:2026-01-01 is:read"')).toEqual({ text: '"has:attachment before:2026-01-01 is:read"' });
        expect(parseSearchQuery('notes "to:carol cc:dave" in:f1')).toEqual({ text: 'notes "to:carol cc:dave"', folderUid: "f1" });
    });

    it("still extracts the operators around, and the quoted value of, a real one", () => {
        expect(parseSearchQuery('from:"bob smith" "budget from:eve" report is:read')).toEqual({
            text: '"budget from:eve" report',
            from: "bob smith",
            flags: ["read"],
        });
        expect(parseSearchQuery('"a b" subject:"x y" has:attachment')).toEqual({ text: '"a b"', subject: "x y", hasAttachment: true });
    });

    it("treats an unbalanced quote as plain text, so an operator after it is still an operator", () => {
        expect(parseSearchQuery('"meeting from:bob')).toEqual({ text: '"meeting', from: "bob" });
    });
});

describe("parseSearchQuery", () => {
    it("returns the whole string as text when there are no operators", () => {
        expect(parseSearchQuery("quarterly budget")).toEqual({ text: "quarterly budget" });
    });

    it.each([
        ["from:", "from:alice@example.com meeting notes", "from", "alice@example.com", "meeting notes"],
        ["to:", "to:bob@example.com meeting notes", "to", "bob@example.com", "meeting notes"],
        ["cc:", "cc:carol@example.com meeting notes", "cc", "carol@example.com", "meeting notes"],
        ["subject:", "subject:quarterly report", "subject", "quarterly", "report"],
        ["in:", "in:f1 meeting notes", "folderUid", "f1", "meeting notes"],
    ] as const)("parses %s into a single-value field, leaving the rest as text", (_label, raw, field, expectedValue, expectedText) => {
        const result = parseSearchQuery(raw);
        expect((result as any)[field]).toBe(expectedValue);
        expect(result.text).toBe(expectedText);
    });

    it("parses has:attachment", () => {
        expect(parseSearchQuery("has:attachment invoices")).toEqual({ text: "invoices", hasAttachment: true });
    });

    it("is case-insensitive on the operator keyword itself", () => {
        expect(parseSearchQuery("FROM:alice@example.com HAS:ATTACHMENT report")).toEqual({
            from: "alice@example.com",
            hasAttachment: true,
            text: "report",
        });
    });

    it("parses before:/after: as real Date objects", () => {
        const result = parseSearchQuery("before:2026-06-01 after:2026-01-01 taxes");
        expect(result.before).toEqual(new Date(2026, 5, 1));
        expect(result.after).toEqual(new Date(2026, 0, 1));
        expect(result.text).toBe("taxes");
    });

    describe("date-only values in a non-UTC runtime zone", () => {
        const originalTz = process.env.TZ;
        afterEach(() => {
            process.env.TZ = originalTz;
        });

        it("parses a date-only before:/after: value as local midnight, not UTC midnight", () => {
            // Node applies a runtime `process.env.TZ` change to `Date`'s local-time methods immediately.
            process.env.TZ = "America/New_York";
            const result = parseSearchQuery("before:2026-01-02 after:2026-07-01");
            expect(result.before?.toISOString()).toBe("2026-01-02T05:00:00.000Z");
            expect(result.after?.toISOString()).toBe("2026-07-01T04:00:00.000Z");
        });

        it("keeps a full ISO date-time value exactly as written", () => {
            process.env.TZ = "America/New_York";
            const result = parseSearchQuery("before:2026-01-02T00:00:00Z after:2026-01-01T12:30:00-08:00");
            expect(result.before?.toISOString()).toBe("2026-01-02T00:00:00.000Z");
            expect(result.after?.toISOString()).toBe("2026-01-01T20:30:00.000Z");
        });
    });

    it.each(["2026-02-30", "2026-13-01", "2026-00-10"])("leaves a date-only value naming a nonexistent date (%s) in the free-text remainder", (value) => {
        const result = parseSearchQuery(`before:${value} taxes`);
        expect(result.before).toBeUndefined();
        expect(result.text).toBe(`before:${value} taxes`);
    });

    it("parses a date-only value with a two-digit year literally rather than as 19xx", () => {
        expect(parseSearchQuery("after:0099-03-04").after?.getFullYear()).toBe(99);
    });

    it("leaves an unparseable before:/after: value in the free-text remainder", () => {
        const result = parseSearchQuery("before:not-a-date taxes");
        expect(result.before).toBeUndefined();
        expect(result.text).toBe("before:not-a-date taxes");
    });

    it("accumulates repeated is: tokens into an array", () => {
        const result = parseSearchQuery("is:read is:flagged project status");
        expect(result.flags).toEqual(["read", "flagged"]);
        expect(result.text).toBe("project status");
    });

    it("splits a single comma-separated is: token the same way as repeated tokens", () => {
        const result = parseSearchQuery("is:read,flagged project status");
        expect(result.flags).toEqual(["read", "flagged"]);
    });

    it("drops an empty entry left behind by a trailing comma", () => {
        const result = parseSearchQuery("is:read, project status");
        expect(result.flags).toEqual(["read"]);
    });

    it("accumulates repeated label: tokens into an array", () => {
        const result = parseSearchQuery("label:l1 label:l2 travel");
        expect(result.labels).toEqual(["l1", "l2"]);
        expect(result.text).toBe("travel");
    });

    it("maps type: onto entityTypes, dropping an unrecognized value", () => {
        const result = parseSearchQuery("type:message type:bogus type:contact people");
        expect(result.entityTypes).toEqual(["message", "contact"]);
        expect(result.text).toBe("people");
    });

    it("omits entityTypes entirely when every type: token is unrecognized", () => {
        const result = parseSearchQuery("type:bogus people");
        expect(result.entityTypes).toBeUndefined();
        expect(result.text).toBe("people");
    });

    it("preserves a quoted phrase verbatim in the free-text remainder", () => {
        const result = parseSearchQuery('"quarterly report" from:alice@example.com');
        expect(result.text).toBe('"quarterly report"');
        expect(result.from).toBe("alice@example.com");
    });

    it("preserves a leading-dash negated term verbatim in the free-text remainder", () => {
        const result = parseSearchQuery("budget -draft");
        expect(result).toEqual({ text: "budget -draft" });
    });

    it("does not treat a dash-prefixed operator-looking token as an operator", () => {
        const result = parseSearchQuery("-from:alice@example.com budget");
        expect(result.from).toBeUndefined();
        expect(result.text).toBe("-from:alice@example.com budget");
    });

    it("does not treat an operator-looking token inside a quoted phrase as an operator", () => {
        const result = parseSearchQuery('"from:alice@example.com" budget');
        expect(result.from).toBeUndefined();
        expect(result.text).toBe('"from:alice@example.com" budget');
    });

    it("supports a quoted value for a single-value operator", () => {
        const result = parseSearchQuery('subject:"quarterly report" urgent');
        expect(result.subject).toBe("quarterly report");
        expect(result.text).toBe("urgent");
    });

    it("collapses the extra whitespace left behind after removing operator tokens", () => {
        const result = parseSearchQuery("from:alice@example.com   has:attachment   report");
        expect(result.text).toBe("report");
    });

    it("returns an empty text remainder (not throwing) for a query that is only operators", () => {
        const result = parseSearchQuery("from:alice@example.com has:attachment");
        expect(result.text).toBe("");
        expect(result.from).toBe("alice@example.com");
        expect(result.hasAttachment).toBe(true);
    });

    it("parses every operator from the spec's own table together in one query", () => {
        const result = parseSearchQuery(
            "from:alice@example.com to:bob@example.com cc:carol@example.com subject:budget has:attachment " +
                "before:2026-06-01 after:2026-01-01 in:f1 is:flagged label:l1 type:message report",
        );
        expect(result).toEqual({
            text: "report",
            from: "alice@example.com",
            to: "bob@example.com",
            cc: "carol@example.com",
            subject: "budget",
            hasAttachment: true,
            before: new Date(2026, 5, 1),
            after: new Date(2026, 0, 1),
            folderUid: "f1",
            flags: ["flagged"],
            labels: ["l1"],
            entityTypes: ["message"],
        });
    });
});
