// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// Pure functions, no DOM/Worker/WASM involved - safe to run under either environment, "node" chosen for
// consistency with this feature's other non-DOM test files.
import { describe, expect, it } from "vitest";
import {
    LocalIndexEntity,
    buildMatchExpression,
    buildSearchPredicates,
    entityBindValues,
} from "../../../apps/shared/search/localIndexSchema.js";

function entity(overrides: Partial<LocalIndexEntity> = {}): LocalIndexEntity {
    return {
        entityType: "message",
        entityUid: "m1",
        mailboxUid: "mb1",
        dateForSort: "2026-01-01T00:00:00.000Z",
        participants: "alice@example.com bob@example.com",
        flags: ",read,",
        hasAttachments: false,
        byteSize: 128,
        ...overrides,
    };
}

describe("localIndexSchema", () => {
    describe("entityBindValues", () => {
        it("orders values to match UPSERT_ENTITY_SQL's column list exactly", () => {
            const e = entity({ folderUid: "f1", subject: "Hello", body: "World", attachmentText: "text", hasAttachments: true, entityVersion: "3:f1" });
            expect(entityBindValues(e)).toEqual([
                "message",
                "m1",
                "mb1",
                "f1",
                "2026-01-01T00:00:00.000Z",
                "alice@example.com bob@example.com",
                ",read,",
                1,
                "Hello",
                "World",
                "text",
                128,
                "3:f1",
            ]);
        });

        it("maps missing optional fields to null, not undefined", () => {
            const [, , , folderUid, , , , , subject, body, attachmentText, , entityVersion] = entityBindValues(entity());
            expect(entityVersion).toBeNull();
            expect(folderUid).toBeNull();
            expect(subject).toBeNull();
            expect(body).toBeNull();
            expect(attachmentText).toBeNull();
        });
    });

    describe("buildSearchPredicates", () => {
        it("always scopes to the given mailbox, even with no other filters", () => {
            expect(buildSearchPredicates({}, "mb1")).toEqual({ where: "e.mailbox_uid = ?", params: ["mb1"] });
        });

        it("adds a folder predicate", () => {
            const { where, params } = buildSearchPredicates({ folderUid: "f1" }, "mb1");
            expect(where).toBe("e.mailbox_uid = ? AND e.folder_uid = ?");
            expect(params).toEqual(["mb1", "f1"]);
        });

        it("adds before/after as strict date-string comparisons against date_for_sort", () => {
            const { where, params } = buildSearchPredicates({ before: new Date("2026-02-01"), after: new Date("2026-01-01") }, "mb1");
            expect(where).toBe("e.mailbox_uid = ? AND e.date_for_sort < ? AND e.date_for_sort > ?");
            expect(params).toEqual(["mb1", "2026-02-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]);
        });

        it("adds a hasAttachment predicate for both true and false explicitly", () => {
            expect(buildSearchPredicates({ hasAttachment: true }, "mb1").params).toEqual(["mb1", 1]);
            expect(buildSearchPredicates({ hasAttachment: false }, "mb1").params).toEqual(["mb1", 0]);
        });

        it("adds one LIKE clause per requested flag, ANDed together", () => {
            const { where, params } = buildSearchPredicates({ flags: ["read", "flagged"] }, "mb1");
            expect(where).toBe("e.mailbox_uid = ? AND e.flags LIKE ? AND e.flags LIKE ?");
            expect(params).toEqual(["mb1", "%,read,%", "%,flagged,%"]);
        });

        it("evaluates from/to/cc as a substring match against the combined participants field (documented simplification)", () => {
            const { where, params } = buildSearchPredicates({ from: "alice", to: "bob", cc: "carol" }, "mb1");
            expect(where).toBe("e.mailbox_uid = ? AND e.participants LIKE ? AND e.participants LIKE ? AND e.participants LIKE ?");
            expect(params).toEqual(["mb1", "%alice%", "%bob%", "%carol%"]);
        });
    });

    describe("buildMatchExpression", () => {
        it("returns undefined for a pure structured-filter query with no free text or subject", () => {
            expect(buildMatchExpression({ text: "" })).toBeUndefined();
            expect(buildMatchExpression({ text: "   " })).toBeUndefined();
        });

        it("passes free text through close to verbatim when there's no subject filter", () => {
            expect(buildMatchExpression({ text: "budget OR forecast" })).toBe("budget OR forecast");
        });

        it("scopes to the subject column, quoted, when only subject: is given", () => {
            expect(buildMatchExpression({ text: "", subject: "quarterly review" })).toBe('subject:"quarterly review"');
        });

        it("combines subject: and free text with AND, parenthesizing the free-text side", () => {
            expect(buildMatchExpression({ text: "budget OR forecast", subject: "review" })).toBe('subject:"review" AND (budget OR forecast)');
        });

        it("doubles an embedded double-quote in the subject, matching FTS5's own phrase-escaping rule", () => {
            expect(buildMatchExpression({ text: "", subject: 'the "big" review' })).toBe('subject:"the ""big"" review"');
        });
    });
});
