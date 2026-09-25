// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockMatchMedia } from "../testUtils.js";
import QuickCreateTabs from "../../../apps/shared/components/calendar/QuickCreateTabs.js";
import { BOOKING_HREF, mockTaskApi, renderNew } from "./quickCreateHelpers.js";
import { openMoreOptions } from "./eventModalHelpers.js";

// The New event popover's Event | Task | Appointment schedule tabs: the strip itself, what carries over from one tab to another and how the
// dialog behaves around it. What each of the Task and Appointment tabs does is in `EventModal.taskTab` and `EventModal.appointmentTab`.

afterEach(() => {
    vi.unstubAllGlobals();
});

const tab = (name: string) => screen.getByRole("tab", { name });

describe("the tab strip", () => {
    it("offers Event and Task, on Event, when the booking plugin is not running", () => {
        renderNew();

        expect(screen.getByRole("tablist", { name: "What to create" })).toBeInTheDocument();
        expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Event", "Task"]);
        expect(tab("Event")).toHaveAttribute("aria-selected", "true");
        expect(tab("Task")).toHaveAttribute("aria-selected", "false");
        expect(screen.queryByRole("tab", { name: "Appointment schedule" })).not.toBeInTheDocument();
        // The Event tab is the quick form it always was.
        expect(screen.getByLabelText("Title")).toHaveFocus();
        expect(screen.getByLabelText("Add guests")).toBeInTheDocument();
    });

    it("adds Appointment schedule when the booking plugin is running", () => {
        renderNew({ bookingHref: BOOKING_HREF });
        expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Event", "Task", "Appointment schedule"]);
    });

    it("ties each tab to its panel, and only the selected tab is in the Tab order", async () => {
        const user = userEvent.setup();
        renderNew({ bookingHref: BOOKING_HREF });

        const panel = screen.getByRole("tabpanel");
        expect(panel).toHaveAttribute("id", tab("Event").getAttribute("aria-controls"));
        expect(panel).toHaveAttribute("aria-labelledby", tab("Event").id);
        expect(tab("Event")).toHaveAttribute("tabindex", "0");
        expect(tab("Task")).toHaveAttribute("tabindex", "-1");

        await user.click(tab("Task"));
        expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", tab("Task").id);
        expect(screen.getByRole("tabpanel")).toHaveAttribute("id", tab("Task").getAttribute("aria-controls"));
        expect(tab("Task")).toHaveAttribute("tabindex", "0");

        await user.click(tab("Appointment schedule"));
        expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", tab("Appointment schedule").id);
    });

    it("walks along the tabs with the arrow keys, wrapping at both ends, selecting and focusing the one it lands on", async () => {
        mockTaskApi();
        const user = userEvent.setup();
        renderNew({ bookingHref: BOOKING_HREF });

        tab("Event").focus();
        await user.keyboard("{ArrowRight}");
        expect(tab("Task")).toHaveAttribute("aria-selected", "true");
        expect(tab("Task")).toHaveFocus();
        await user.keyboard("{ArrowRight}");
        expect(tab("Appointment schedule")).toHaveFocus();
        await user.keyboard("{ArrowRight}");
        expect(tab("Event")).toHaveAttribute("aria-selected", "true");
        expect(tab("Event")).toHaveFocus();
        await user.keyboard("{ArrowLeft}");
        expect(tab("Appointment schedule")).toHaveAttribute("aria-selected", "true");
        expect(tab("Appointment schedule")).toHaveFocus();
        await user.keyboard("{ArrowLeft}");
        expect(tab("Task")).toHaveFocus();
    });

    it("jumps to the first and last tab with Home and End, and ignores every other key", async () => {
        mockTaskApi();
        const user = userEvent.setup();
        renderNew({ bookingHref: BOOKING_HREF });

        tab("Event").focus();
        await user.keyboard("{End}");
        expect(tab("Appointment schedule")).toHaveAttribute("aria-selected", "true");
        expect(tab("Appointment schedule")).toHaveFocus();
        await user.keyboard("a");
        expect(tab("Appointment schedule")).toHaveAttribute("aria-selected", "true");
        await user.keyboard("{Home}");
        expect(tab("Event")).toHaveAttribute("aria-selected", "true");
        expect(tab("Event")).toHaveFocus();
    });

    it("wraps around just Event and Task when there is no Appointment schedule tab", async () => {
        mockTaskApi();
        const user = userEvent.setup();
        renderNew();

        tab("Event").focus();
        await user.keyboard("{ArrowLeft}");
        expect(tab("Task")).toHaveFocus();
        await user.keyboard("{ArrowRight}");
        expect(tab("Event")).toHaveFocus();
    });

    it("reports a chosen tab to its owner (the strip on its own)", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        render(<QuickCreateTabs tab="event" onChange={onChange} showAppointment />);

        await user.click(screen.getByRole("tab", { name: "Appointment schedule" }));
        expect(onChange).toHaveBeenCalledWith("appointment");
    });
});

describe("moving between tabs", () => {
    it("keeps the title typed on any tab as the title of the others", async () => {
        mockTaskApi();
        const user = userEvent.setup();
        renderNew({ bookingHref: BOOKING_HREF });

        await user.type(screen.getByLabelText("Title"), "Planning");
        await user.click(tab("Task"));
        expect(screen.getByLabelText("Title")).toHaveValue("Planning");
        await user.type(screen.getByLabelText("Title"), " review");
        await user.click(tab("Appointment schedule"));
        expect(screen.getByLabelText("Title")).toHaveValue("Planning review");
        await user.click(tab("Event"));
        expect(screen.getByLabelText("Title")).toHaveValue("Planning review");
    });

    it("keeps the other Event fields, and the Task and Appointment tabs' own, while another tab is showing", async () => {
        mockTaskApi();
        const user = userEvent.setup();
        renderNew({ bookingHref: BOOKING_HREF });

        await user.type(screen.getByLabelText("Location"), "Room 4");
        await user.click(tab("Task"));
        fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-07-01" } });
        await user.click(tab("Appointment schedule"));
        await user.selectOptions(screen.getByLabelText("Duration"), "45");
        await user.click(tab("Event"));
        expect(screen.getByLabelText("Location")).toHaveValue("Room 4");
        await user.click(tab("Task"));
        expect(screen.getByLabelText("Due date")).toHaveValue("2026-07-01");
        await user.click(tab("Appointment schedule"));
        expect(screen.getByLabelText("Duration")).toHaveValue("45");
    });

    it("returns from an expanded Task card to the Event's quick popover with the Event form as it was", async () => {
        mockTaskApi();
        const user = userEvent.setup();
        renderNew();

        await user.type(screen.getByLabelText("Title"), "Planning");
        await user.type(screen.getByLabelText("Location"), "Room 4");
        await user.click(tab("Task"));
        await user.click(screen.getByRole("button", { name: "More options" }));
        expect(screen.getByRole("dialog").parentElement).toHaveAttribute("data-event-shell", "card");
        expect(screen.getByLabelText("Notes")).toBeInTheDocument();
        // The Task card is not as wide as the Event's.
        expect(screen.getByRole("dialog")).toHaveStyle({ maxWidth: "560px" });

        await user.click(tab("Event"));
        expect(screen.getByRole("dialog").parentElement).toHaveAttribute("data-event-shell", "popover");
        expect(screen.getByLabelText("Title")).toHaveValue("Planning");
        expect(screen.getByLabelText("Location")).toHaveValue("Room 4");
    });

    it("keeps the Event's own More options card as wide as ever, without a tab strip", async () => {
        const user = userEvent.setup();
        renderNew({ bookingHref: BOOKING_HREF });

        await openMoreOptions(user);
        expect(screen.getByRole("dialog")).toHaveStyle({ maxWidth: "880px" });
        expect(screen.queryByRole("tablist", { name: "What to create" })).not.toBeInTheDocument();
    });

    it("closes on a press outside the Task card while it holds nothing", async () => {
        mockTaskApi();
        const user = userEvent.setup();
        const { onClose } = renderNew();

        await user.click(tab("Task"));
        await user.click(screen.getByRole("button", { name: "More options" }));
        fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not close on a press outside once the Task card has notes", async () => {
        mockTaskApi();
        const user = userEvent.setup();
        const { onClose } = renderNew();

        await user.click(tab("Task"));
        await user.click(screen.getByRole("button", { name: "More options" }));
        await user.type(screen.getByLabelText("Notes"), "Remember the agenda");
        fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
        expect(onClose).not.toHaveBeenCalled();
    });
});

describe("the dialog around the tabs", () => {
    it("closes on Escape and on the X from every tab, without saving anything", async () => {
        const fetchMock = mockTaskApi();
        const user = userEvent.setup();
        const { onClose } = renderNew({ bookingHref: BOOKING_HREF });

        await user.click(tab("Task"));
        await user.keyboard("{Escape}");
        expect(onClose).toHaveBeenCalledTimes(1);
        await user.click(tab("Appointment schedule"));
        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toEqual([]);
    });

    it("saves the tab that is showing on Enter in its title field", async () => {
        const fetchMock = mockTaskApi();
        const user = userEvent.setup();
        const { onClose, onSaved } = renderNew();

        await user.click(tab("Task"));
        await user.type(screen.getByLabelText("Title"), "Buy milk{Enter}");

        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
        // A task was created, not an event.
        expect(fetchMock.mock.calls.map(([url]) => url)).toContain("/api/mail/tasks");
        expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain("/api/mail/calendar-events");
        expect(onSaved).not.toHaveBeenCalled();
    });

    it("still saves an event on Enter on the Event tab, after a look at another tab", async () => {
        const fetchMock = mockFetch((url, init) => {
            if (url.startsWith("/api/mail/task-lists")) return jsonResponse(200, []);
            if (url === "/api/mail/calendar-events" && init?.method === "POST") return jsonResponse(200, { uid: "e1" });
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        const { onSaved } = renderNew();

        await user.type(screen.getByLabelText("Title"), "Planning");
        await user.click(tab("Task"));
        await user.click(tab("Event"));
        await user.type(screen.getByLabelText("Title"), "{Enter}");

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(JSON.parse((fetchMock.mock.calls.find(([, init]) => (init as RequestInit).method === "POST")![1] as RequestInit).body as string).title).toBe(
            "Planning",
        );
    });

    it("draws the Task tab in the phone's bottom sheet, which grows into the card", async () => {
        mockMatchMedia(true);
        mockTaskApi();
        const user = userEvent.setup();
        renderNew({ bookingHref: BOOKING_HREF });
        await waitFor(() => expect(screen.getByRole("dialog").parentElement).toHaveAttribute("data-event-shell", "sheet"));

        await user.click(tab("Task"));
        expect(screen.getByRole("dialog").parentElement).toHaveAttribute("data-event-shell", "sheet");
        await user.click(tab("Appointment schedule"));
        expect(screen.getByRole("dialog").parentElement).toHaveAttribute("data-event-shell", "sheet");
        await user.click(tab("Task"));
        await user.click(screen.getByRole("button", { name: "More options" }));
        expect(screen.getByRole("dialog").parentElement).toHaveAttribute("data-event-shell", "card");
    });

    it("leaves an existing event alone: its details and its form have no tabs", async () => {
        const user = userEvent.setup();
        renderNew({
            bookingHref: BOOKING_HREF,
            occurrence: {
                uid: "e1",
                version: 2,
                dateCreated: "2026-01-01T00:00:00.000Z",
                dateModified: "2026-01-01T00:00:00.000Z",
                folderUid: "f1",
                mailboxUid: "jane@example.com",
                title: "Standup",
                startDate: "2026-06-10T09:00:00.000Z",
                endDate: "2026-06-10T10:00:00.000Z",
                allDay: false,
                timezone: "UTC",
                organizer: { address: "jane@example.com", type: "to" },
                attendees: [],
                status: "confirmed",
                busyStatus: "busy",
                icalUid: "abc",
                sequence: 0,
                occurrenceKey: "e1",
                isRecurringOccurrence: false,
            },
        });

        expect(screen.queryByRole("tablist", { name: "What to create" })).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Modify" }));
        expect(screen.getByLabelText("Title")).toHaveValue("Standup");
        expect(screen.queryByRole("tablist", { name: "What to create" })).not.toBeInTheDocument();
    });
});
