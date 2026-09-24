// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import InviteTimeline, { placeBlocks } from "../../../apps/shared/components/mail/invite/InviteTimeline.js";

// The suite runs in UTC (vitest.config.ts), so the reader's own zone is UTC below.

const entry = (uid: string, title: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
    uid,
    title,
    startDate: `2026-06-16T${start}:00.000Z`,
    endDate: `2026-06-16T${end}:00.000Z`,
    allDay: false,
    busy: true,
    tentative: false,
    ...extra,
});

function draw(invite: Partial<React.ComponentProps<typeof InviteTimeline>["invite"]> = {}) {
    return render(
        <InviteTimeline
            invite={{ summary: "Planning", startDate: "2026-06-16T13:00:00.000Z", endDate: "2026-06-16T14:00:00.000Z", conflicts: [], schedule: [], ...invite }}
        />,
    );
}

/** The blocks drawn, by data-kind and title. */
function blocks() {
    return within(screen.getByRole("list", { name: "Events" }))
        .getAllByRole("listitem")
        .map((item) => ({ kind: item.getAttribute("data-kind"), title: item.querySelector("span")!.textContent, style: (item).style }));
}

describe("placeBlocks", () => {
    it("puts blocks that do not overlap in one column each of their own cluster", () => {
        expect(
            placeBlocks([
                { start: 0, end: 10 },
                { start: 10, end: 20 },
            ]),
        ).toEqual([
            { column: 0, columns: 1 },
            { column: 0, columns: 1 },
        ]);
    });

    it("sets overlapping blocks side by side", () => {
        expect(
            placeBlocks([
                { start: 0, end: 30 },
                { start: 10, end: 20 },
            ]),
        ).toEqual([
            { column: 0, columns: 2 },
            { column: 1, columns: 2 },
        ]);
    });

    it("reuses a column that has freed up within the same cluster, and sizes the cluster by its widest point", () => {
        expect(
            placeBlocks([
                { start: 0, end: 20 },
                { start: 5, end: 10 },
                { start: 12, end: 30 },
            ]),
        ).toEqual([
            { column: 0, columns: 2 },
            { column: 1, columns: 2 },
            { column: 1, columns: 2 },
        ]);
    });

    it("starts a new cluster once everything before it has ended", () => {
        expect(
            placeBlocks([
                { start: 0, end: 10 },
                { start: 5, end: 15 },
                { start: 20, end: 30 },
            ]),
        ).toEqual([
            { column: 0, columns: 2 },
            { column: 1, columns: 2 },
            { column: 0, columns: 1 },
        ]);
    });

    it("is empty for nothing", () => {
        expect(placeBlocks([])).toEqual([]);
    });
});

describe("InviteTimeline", () => {
    it("draws nothing for an invitation with no usable time", () => {
        for (const invite of [{ startDate: undefined }, { endDate: undefined }, { startDate: "garbage" }, { endDate: "2026-06-16T13:00:00.000Z" }]) {
            const { container, unmount } = draw(invite);
            expect(container).toBeEmptyDOMElement();
            unmount();
        }
    });

    it("draws the hours from two before the meeting to two after, labelled", () => {
        const { container } = draw();
        const labels = Array.from(container.querySelectorAll("[aria-hidden='true'] span")).map((node) => node.textContent);
        expect(labels.map((label) => label.replace(/\s+/g, " "))).toEqual(["11 AM", "12 PM", "1 PM", "2 PM", "3 PM"]);
        expect(screen.getByRole("group", { name: "Your schedule around this meeting" })).toBeInTheDocument();
    });

    it("highlights the meeting and marks conflicts, busy, free and tentative events differently", () => {
        const conflict = entry("c1", "Design review", "13:30", "14:30");
        draw({
            conflicts: [conflict],
            schedule: [
                entry("e1", "Standup", "11:00", "11:30"),
                conflict,
                entry("e2", "Lunch", "12:00", "12:30", { busy: false }),
                entry("e3", "Maybe", "15:00", "15:30", { tentative: true }),
            ],
        });

        const byTitle = Object.fromEntries(blocks().map((block) => [block.title, block.kind]));
        expect(byTitle).toEqual({ Planning: "invite", "Design review": "conflict", Standup: "busy", Lunch: "free", Maybe: "busy" });
        const conflictItem = screen.getByTitle(/Design review/);
        expect(conflictItem).toHaveTextContent("conflicts with this meeting");
        expect(screen.getByTitle(/^Planning/)).toHaveTextContent("this meeting");
        expect(screen.getByTitle(/^Maybe/)).toHaveTextContent("tentative");
        expect(screen.getByTitle(/^Maybe/).className).toContain("border-dashed");
        expect(screen.getByTitle(/^Standup/).className).not.toContain("border-dashed");
    });

    it("places blocks at their hour, by their length", () => {
        draw({ schedule: [entry("e1", "Standup", "11:30", "12:00")] });
        const byTitle = Object.fromEntries(blocks().map((block) => [block.title, block.style]));
        // The window starts at 11:00; an hour is 36px.
        expect(byTitle.Standup.top).toBe("18px");
        expect(byTitle.Standup.height).toBe("18px");
        expect(byTitle.Planning.top).toBe("72px");
        expect(byTitle.Planning.height).toBe("35px");
    });

    it("sets overlapping events side by side", () => {
        draw({ schedule: [entry("e1", "Overlap", "13:15", "13:45")] });
        const byTitle = Object.fromEntries(blocks().map((block) => [block.title, block.style]));
        // Half the room each (the browser writes the calc() its own way): the second starts halfway across.
        expect(byTitle.Planning.width).toContain("0.5 *");
        expect(byTitle.Overlap.width).toContain("0.5 *");
        expect(byTitle.Overlap.left).toContain("0.5 *");
        expect(byTitle.Planning.left).not.toContain("0.5 *");
    });

    it("draws a conflict the schedule does not list, once, and names untitled events", () => {
        const conflict = entry("c1", "", "13:00", "13:30");
        const first = draw({ conflicts: [conflict], schedule: [] });
        expect(blocks().map((block) => block.title).sort()).toEqual(["(no title)", "Planning"]);
        first.unmount();

        const again = entry("c2", "Also", "13:00", "13:30");
        draw({ conflicts: [again], schedule: [again] });
        expect(screen.getAllByTitle(/^Also/)).toHaveLength(1);
    });

    it("lists all-day events above the hours instead of drawing them", () => {
        draw({ schedule: [entry("a1", "Holiday", "00:00", "23:59", { allDay: true }), entry("a2", "", "00:00", "23:59", { allDay: true })] });
        const allDay = screen.getByRole("list", { name: "All-day events" });
        expect(within(allDay).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["All day: Holiday", "All day: (no title)"]);
        expect(blocks().map((block) => block.title)).toEqual(["Planning"]);
    });

    it("leaves out events that are outside the hours shown or have no usable times, and clips ones that reach into them", () => {
        draw({
            schedule: [
                entry("e1", "Early", "05:00", "06:00"),
                entry("e2", "Broken", "13:00", "14:00", { startDate: "garbage" }),
                entry("e3", "Broken end", "13:00", "14:00", { endDate: "garbage" }),
                entry("e4", "Long", "10:00", "12:00"),
            ],
        });
        const titles = blocks().map((block) => block.title);
        expect(titles).toEqual(["Long", "Planning"]);
        // Clipped to the 11:00 start of the window.
        expect(blocks()[0].style.top).toBe("0px");
        expect(blocks()[0].style.height).toBe("35px");
    });

    it("gives a very short meeting a readable block, and names an untitled one", () => {
        draw({ summary: " ", endDate: "2026-06-16T13:05:00.000Z" });
        expect(blocks()[0].title).toBe("(no title)");
        expect(blocks()[0].style.height).toBe("18px");
    });

    it("keeps to the meeting's day: to midnight for one that runs past it, and from midnight for an early one", () => {
        const { container, unmount } = draw({ startDate: "2026-06-16T22:00:00.000Z", endDate: "2026-06-17T02:00:00.000Z" });
        const hours = () => Array.from(container.querySelectorAll("[aria-hidden='true'] span")).map((node) => node.textContent.replace(/\s+/g, " "));
        expect(hours()[0]).toBe("7 PM");
        expect(hours()[hours().length - 1]).toBe("11 PM");
        unmount();

        const early = draw({ startDate: "2026-06-16T00:00:00.000Z", endDate: "2026-06-16T00:30:00.000Z" });
        const earlyHours = Array.from(early.container.querySelectorAll("[aria-hidden='true'] span")).map((node) => node.textContent.replace(/\s+/g, " "));
        expect(earlyHours).toEqual(["12 AM", "1 AM", "2 AM", "3 AM", "4 AM"]);
    });

    it("shows at least five hours for a short meeting late in the day", () => {
        const { container } = draw({ startDate: "2026-06-16T23:00:00.000Z", endDate: "2026-06-16T23:30:00.000Z" });
        const hours = Array.from(container.querySelectorAll("[aria-hidden='true'] span")).map((node) => node.textContent.replace(/\s+/g, " "));
        expect(hours).toEqual(["7 PM", "8 PM", "9 PM", "10 PM", "11 PM"]);
    });
});
