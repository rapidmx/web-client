// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import { jsonResponse, mockFetch } from "../testUtils.js";
import RequestChangeForm, { ChangeSubject } from "../../../apps/shared/components/calendar/RequestChangeForm.js";
import { getNotificationsSnapshot, resetNotifications } from "../../../apps/shared/notifications/store.js";

// A guest's request to the organizer: what it starts from, what it refuses, and what it sends. Runs with TZ=UTC (see vitest.config.ts).

beforeAll(() => {
    const noRects = { length: 0, item: () => null, [Symbol.iterator]: () => [][Symbol.iterator]() };
    Range.prototype.getClientRects = () => noRects;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
});

beforeEach(() => {
    resetNotifications();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const subject = (overrides: Partial<ChangeSubject> = {}): ChangeSubject => ({
    uid: "e/1",
    title: "Planning",
    location: "Room A",
    startDate: "2026-06-10T09:00:00.000Z",
    endDate: "2026-06-10T10:00:00.000Z",
    allDay: false,
    recurring: false,
    description: null,
    descriptionHtml: "<p>Agenda</p>",
    guestAddresses: ["jane@example.com", "bob@example.com"],
    ...overrides,
});

function renderForm(props: Partial<React.ComponentProps<typeof RequestChangeForm>> = {}) {
    const handlers = { onSent: vi.fn(), onCancel: vi.fn() };
    const utils = render(<RequestChangeForm subject={subject()} canChange canInvite {...handlers} {...props} />);
    return { ...handlers, ...utils };
}

function mockRequest(status = 200, body: unknown = { requested: true, changes: ["title"], addAttendees: [] }) {
    return mockFetch((url) => (url === "/api/mail/calendar-events/e%2F1/request-change" ? jsonResponse(status, body) : undefined));
}

/** The calls that sent the request (the guests field also asks for suggestions as names are typed). */
function requestsSent(fetchMock: ReturnType<typeof vi.fn>) {
    return fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/request-change"));
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>) {
    return JSON.parse((requestsSent(fetchMock)[0][1] as RequestInit).body as string);
}

async function descriptionEditor(container: HTMLElement): Promise<Editor> {
    return await waitFor(() => {
        const found: { editor?: Editor } | null = container.querySelector(".ProseMirror");
        expect(found?.editor).toBeDefined();
        return found!.editor!;
    });
}

const send = () => fireEvent.click(screen.getByRole("button", { name: "Send request" }));

describe("RequestChangeForm fields", () => {
    it("offers the title, location, times, description and guests, starting from what the event says", async () => {
        const { container } = renderForm();

        expect(screen.getByRole("form", { name: "Request a change" })).toBeInTheDocument();
        expect(screen.getByLabelText("Title")).toHaveValue("Planning");
        expect(screen.getByLabelText("Location")).toHaveValue("Room A");
        expect(screen.getByLabelText("Starts")).toHaveValue("2026-06-10T09:00");
        expect(screen.getByLabelText("Ends")).toHaveValue("2026-06-10T10:00");
        expect(screen.getByLabelText("Guests to add")).toBeInTheDocument();
        const editor = await descriptionEditor(container);
        expect(editor.getHTML()).toBe("<p>Agenda</p>");
        expect(screen.getByText(/Nothing on your calendar changes until their update arrives/)).toBeInTheDocument();
    });

    it("is Add guests, with only the guests field, when the organizer lets guests invite others but not change the event", () => {
        renderForm({ canChange: false });

        expect(screen.getByRole("form", { name: "Add guests" })).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Add guests" })).toBeInTheDocument();
        expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Starts")).not.toBeInTheDocument();
        expect(screen.getByLabelText("Guests to add")).toBeInTheDocument();
    });

    it("has no guests field when the organizer does not let guests invite others", () => {
        renderForm({ canInvite: false });
        expect(screen.queryByLabelText("Guests to add")).not.toBeInTheDocument();
        expect(screen.getByLabelText("Title")).toBeInTheDocument();
    });

    it("does not offer the time of a series or of an all-day event, and says why", () => {
        const { unmount } = renderForm({ subject: subject({ recurring: true }) });
        expect(screen.queryByLabelText("Starts")).not.toBeInTheDocument();
        expect(screen.getByText("A change here applies to the whole series; its times can only be changed by the organizer.")).toBeInTheDocument();
        unmount();

        const second = renderForm({ subject: subject({ allDay: true }) });
        expect(screen.queryByLabelText("Starts")).not.toBeInTheDocument();
        expect(screen.getByText("The time of this event can only be changed by the organizer.")).toBeInTheDocument();
        second.unmount();

        renderForm({ subject: subject({ startDate: undefined, endDate: undefined }) });
        expect(screen.queryByLabelText("Starts")).not.toBeInTheDocument();
    });

    it("starts a description from the plain text when the event has no HTML, and from nothing at all", async () => {
        const { container, unmount } = renderForm({ subject: subject({ descriptionHtml: undefined, description: "Plain\ntext" }) });
        expect((await descriptionEditor(container)).getHTML()).toBe("<p>Plain</p><p>text</p>");
        unmount();

        const second = renderForm({ subject: subject({ descriptionHtml: undefined, description: undefined, location: undefined }) });
        expect(screen.getByLabelText("Location")).toHaveValue("");
        expect((await descriptionEditor(second.container)).getHTML()).toBe("<p></p>");
    });

    it("closes with Cancel or the close button", () => {
        const { onCancel } = renderForm();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
        expect(onCancel).toHaveBeenCalledTimes(2);
    });
});

describe("RequestChangeForm sending", () => {
    it("says to change something first, and sends nothing, when nothing differs", async () => {
        const fetchMock = mockRequest();
        renderForm();
        await screen.findByRole("toolbar");
        send();
        expect(await screen.findByText("Change something first.")).toBeInTheDocument();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("sends only the title that was changed, then says so and is done", async () => {
        const fetchMock = mockRequest();
        const { onSent } = renderForm();
        fireEvent.change(screen.getByLabelText("Title"), { target: { value: "  Planning, again " } });
        send();

        await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/calendar-events/e%2F1/request-change", expect.objectContaining({ method: "POST" }));
        expect(sentBody(fetchMock)).toEqual({ title: "Planning, again" });
        expect(getNotificationsSnapshot().visible).toEqual([expect.objectContaining({ kind: "success", title: "Your change was sent to the organizer" })]);
    });

    it("sends a new location, and one for an event that had none", async () => {
        const fetchMock = mockRequest();
        const { onSent } = renderForm({ subject: subject({ location: undefined }) });
        fireEvent.change(screen.getByLabelText("Location"), { target: { value: "Room B" } });
        send();
        await waitFor(() => expect(onSent).toHaveBeenCalled());
        expect(sentBody(fetchMock)).toEqual({ location: "Room B" });
    });

    it("refuses to clear the title or the location, since the server would", () => {
        const fetchMock = mockRequest();
        renderForm();
        fireEvent.change(screen.getByLabelText("Title"), { target: { value: " " } });
        send();
        expect(screen.getByRole("alert")).toHaveTextContent("Enter a title, or leave it as it is.");

        fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Planning" } });
        fireEvent.change(screen.getByLabelText("Location"), { target: { value: "" } });
        send();
        expect(screen.getByRole("alert")).toHaveTextContent("Enter a location, or leave it as it is.");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("sends a new time as ISO instants, both start and end", async () => {
        const fetchMock = mockRequest();
        const { onSent } = renderForm();
        fireEvent.change(screen.getByLabelText("Starts"), { target: { value: "2026-06-10T14:00" } });
        fireEvent.change(screen.getByLabelText("Ends"), { target: { value: "2026-06-10T15:30" } });
        send();
        await waitFor(() => expect(onSent).toHaveBeenCalled());
        expect(sentBody(fetchMock)).toEqual({ startDate: "2026-06-10T14:00:00.000Z", endDate: "2026-06-10T15:30:00.000Z" });
    });

    it("refuses a time that ends before it starts, or that is not a time", () => {
        const fetchMock = mockRequest();
        renderForm();
        fireEvent.change(screen.getByLabelText("Starts"), { target: { value: "2026-06-10T11:00" } });
        send();
        expect(screen.getByRole("alert")).toHaveTextContent("The end time must be after the start time.");

        fireEvent.change(screen.getByLabelText("Starts"), { target: { value: "" } });
        send();
        expect(screen.getByRole("alert")).toHaveTextContent("The end time must be after the start time.");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("sends a changed description as sanitized HTML and the plain text derived from it, and not one that is only rewritten", async () => {
        const fetchMock = mockRequest();
        const { container, onSent } = renderForm();
        const editor = await descriptionEditor(container);

        // The same words, written the way the editor writes them: not a change.
        act(() => {
            editor.commands.setContent("<p>Agenda</p><p></p>");
        });
        send();
        expect(await screen.findByText("Change something first.")).toBeInTheDocument();

        act(() => {
            editor.commands.setContent('<p>New <strong>agenda</strong> <a href="https://example.com">here</a></p>');
        });
        send();
        await waitFor(() => expect(onSent).toHaveBeenCalled());
        expect(sentBody(fetchMock)).toEqual({
            descriptionHtml: '<p>New <strong>agenda</strong> <a href="https://example.com/" rel="noopener noreferrer">here</a></p>',
            description: "New agenda here (https://example.com/)",
        });
    });

    it("refuses to clear the description, or to send one that is too long", async () => {
        const fetchMock = mockRequest();
        const { container } = renderForm();
        const editor = await descriptionEditor(container);

        act(() => {
            editor.commands.setContent("<p></p>");
        });
        send();
        expect(await screen.findByText("Enter a description, or leave it as it is.")).toBeInTheDocument();

        act(() => {
            editor.commands.setContent(`<p>${"a".repeat(33_000)}</p>`);
        });
        send();
        expect(await screen.findByText("The description is too long.")).toBeInTheDocument();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("adds guests typed with Enter, a comma or a semicolon, each once, and lets one be taken off again", async () => {
        const fetchMock = mockRequest();
        const user = userEvent.setup();
        const { onSent } = renderForm({ canChange: false });
        const box = screen.getByLabelText("Guests to add");

        await user.type(box, "cy@example.com{Enter}");
        await user.type(box, "di@example.com,");
        await user.type(box, "ed@example.com;");
        // Already invited (in any case), or already added: skipped.
        await user.type(box, "BOB@example.com{Enter}");
        await user.type(box, "cy@example.com{Enter}");
        expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["cy@example.com", "di@example.com", "ed@example.com"]);

        await user.click(screen.getByRole("button", { name: "Remove di@example.com" }));
        send();

        await waitFor(() => expect(onSent).toHaveBeenCalled());
        expect(sentBody(fetchMock)).toEqual({ addAttendees: [{ address: "cy@example.com" }, { address: "ed@example.com" }] });
    });

    it("adds an address still in the box when the request is sent, and stops at one that is not an address", async () => {
        const fetchMock = mockRequest();
        const user = userEvent.setup();
        const { onSent } = renderForm({ canChange: false });

        await user.type(screen.getByLabelText("Guests to add"), "not-an-address{Enter}");
        // Committed, it stays as a flagged chip; the error comes with the send.
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(screen.getByLabelText("Guests to add")).toHaveValue("");
        expect(screen.getByText("not-an-address").closest("li")).toHaveTextContent("not-an-address (not a valid email address)");
        send();
        expect(screen.getByRole("alert")).toHaveTextContent("“not-an-address” isn’t a valid email address.");
        expect(requestsSent(fetchMock)).toEqual([]);

        await user.click(screen.getByRole("button", { name: "Remove not-an-address" }));
        await user.type(screen.getByLabelText("Guests to add"), "fay@example.com");
        send();
        await waitFor(() => expect(onSent).toHaveBeenCalled());
        expect(sentBody(fetchMock)).toEqual({ addAttendees: [{ address: "fay@example.com" }] });
    });

    it("suggests people by name as they are typed, and asks for the one picked to be added with their name and address", async () => {
        const fetchMock = mockFetch((url) => {
            if (url === "/api/mail/calendar-events/e%2F1/request-change") {
                return jsonResponse(200, { requested: true, changes: ["addAttendees"], addAttendees: [] });
            }
            if (url.startsWith("/api/mail/directory/contacts")) {
                return jsonResponse(200, []);
            }
            return url.startsWith("/api/mail/directory") ? jsonResponse(200, [{ displayName: "Support Desk", address: "support@example.com", kind: "shared" }]) : undefined;
        });
        const user = userEvent.setup();
        const { onSent } = renderForm({ canChange: false });

        await user.type(screen.getByLabelText("Guests to add"), "sup");
        await user.click(await screen.findByRole("option", { name: /Support Desk/ }, { timeout: 5000 }));
        expect(screen.getByText("Support Desk").closest("li")).toHaveAttribute("title", "Support Desk <support@example.com>");
        send();

        await waitFor(() => expect(onSent).toHaveBeenCalled());
        expect(sentBody(fetchMock)).toEqual({ addAttendees: [{ address: "support@example.com", displayName: "Support Desk" }] });
    });

    it("sends a change alone when the organizer does not let guests invite others", async () => {
        const fetchMock = mockRequest();
        const { onSent } = renderForm({ canInvite: false });
        fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Retro" } });
        send();
        await waitFor(() => expect(onSent).toHaveBeenCalled());
        expect(sentBody(fetchMock)).toEqual({ title: "Retro" });
    });

    it("sends a change and guests together", async () => {
        const fetchMock = mockRequest();
        const user = userEvent.setup();
        const { onSent } = renderForm();
        fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Retro" } });
        await user.type(screen.getByLabelText("Guests to add"), "gus@example.com{Enter}");
        send();
        await waitFor(() => expect(onSent).toHaveBeenCalled());
        expect(sentBody(fetchMock)).toEqual({ title: "Retro", addAttendees: [{ address: "gus@example.com" }] });
    });

    it("keeps the form, with an error pop-up, when the server refuses", async () => {
        mockRequest(403, { message: "The organizer does not allow guests to change this event." });
        const { onSent } = renderForm();
        fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Retro" } });
        send();

        await waitFor(() => expect(getNotificationsSnapshot().visible).toEqual([expect.objectContaining({ kind: "error", title: "Couldn't send your change" })]));
        expect(onSent).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Send request" })).toBeEnabled();
        expect(screen.getByLabelText("Title")).toHaveValue("Retro");
    });

    it("disables the buttons while the request is out", async () => {
        let finish: (response: Response) => void = () => undefined;
        mockFetch(() => new Promise<Response>((resolve) => (finish = resolve)));
        const { onSent } = renderForm();
        fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Retro" } });
        send();

        await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled());
        expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
        finish(jsonResponse(200, { requested: true, changes: ["title"], addAttendees: [] }));
        await waitFor(() => expect(onSent).toHaveBeenCalled());
    });
});
