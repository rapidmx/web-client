///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { mergeFirstPage } from "../../../apps/shared/mail/mergeFirstPage.js";

interface Row {
    id: string;
    version?: number;
    note?: string;
}

const row = (id: string, extra: Partial<Row> = {}): Row => ({ id, ...extra });
const idOf = (r: Row) => r.id;
const ids = (rows: Row[]) => rows.map((r) => r.id);

describe("mergeFirstPage", () => {
    it("replaces the list with the fresh page when the whole listing fits on it - dropping what was removed elsewhere", () => {
        const merged = mergeFirstPage([row("a"), row("b"), row("c")], [row("n"), row("a"), row("c")], idOf, 5);
        expect(ids(merged.rows)).toEqual(["n", "a", "c"]);
        expect(merged.complete).toBe(true);
        expect(merged.added).toBe(1);
    });

    it("puts the fresh rows first and keeps the older loaded rows it did not repeat when the page is full", () => {
        const current = [row("d"), row("c"), row("b"), row("a")];
        const merged = mergeFirstPage(current, [row("e"), row("d"), row("c")], idOf, 3);
        expect(ids(merged.rows)).toEqual(["e", "d", "c", "b", "a"]);
        expect(merged.complete).toBe(false);
        expect(merged.added).toBe(1);
    });

    it("counts the rows that were not on screen, and none when nothing new arrived", () => {
        expect(mergeFirstPage([row("a"), row("b")], [row("x"), row("y"), row("a")], idOf, 3).added).toBe(2);
        expect(mergeFirstPage([row("a"), row("b")], [row("a"), row("b")], idOf, 2).added).toBe(0);
    });

    it("keeps a full page's own order, so a row that moved up stays where the server put it, once", () => {
        const merged = mergeFirstPage([row("c"), row("b"), row("a")], [row("a"), row("c"), row("b")], idOf, 3);
        expect(ids(merged.rows)).toEqual(["a", "c", "b"]);
    });

    it("takes the fresh copy of a row in both by default", () => {
        const merged = mergeFirstPage([row("a", { note: "old" })], [row("a", { note: "new" })], idOf, 2);
        expect(merged.rows[0].note).toBe("new");
    });

    it("lets the caller pick the copy to keep, so a fetch that began before a change does not undo it", () => {
        const keepNewer = (current: Row, fresh: Row) => ((current.version ?? 0) > (fresh.version ?? 0) ? current : fresh);
        const merged = mergeFirstPage(
            [row("a", { version: 2, note: "read just now" }), row("b", { version: 0 })],
            [row("a", { version: 1, note: "stale" }), row("b", { version: 1, note: "server" })],
            idOf,
            5,
            keepNewer,
        );
        expect(merged.rows.map((r) => r.note)).toEqual(["read just now", "server"]);
    });

    it("handles an empty list and an empty fresh page", () => {
        expect(mergeFirstPage([], [row("a")], idOf, 5)).toEqual({ rows: [row("a")], added: 1, complete: true });
        expect(mergeFirstPage([row("a")], [], idOf, 5)).toEqual({ rows: [], added: 0, complete: true });
        expect(mergeFirstPage([], [], idOf, 0)).toEqual({ rows: [], added: 0, complete: false });
    });
});
