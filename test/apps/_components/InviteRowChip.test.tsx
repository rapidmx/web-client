// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageInvite } from "@rapidmx/react-shared/calendar/inviteApi.js";
import type { Message } from "@rapidmx/react-shared/mail/mailApi.js";
import { jsonResponse, mockFetch, mockMatchMedia } from "../testUtils.js";
import InviteRowChip, { showsInviteChip } from "../../../apps/shared/components/mail/invite/InviteRowChip.js";
import { clearInviteCache } from "../../../apps/shared/components/mail/invite/inviteStore.js";
import { dismissAll, getNotificationsSnapshot } from "../../../apps/shared/notifications/store.js";

// The suite runs in UTC (vitest.config.ts), so the reader's own zone is UTC below.

function message(overrides: Partial<Message> = {}): Message {
    return { uid: "m1", meetingMethod: "REQUEST", encrypted: false, subject: "Video Test", ...overrides } as Message;
}

const entry = (uid: string, title: string, startDate: string, endDate: string, extra: Record<string, unknown> = {}) => ({
    uid,
    title,
    startDate,
    endDate,
    allDay: false,
    busy: true,
    tentative: false,
    ...extra,
});

function inviteFixture(overrides: Partial<MessageInvite> = {}): MessageInvite {
    return {
        method: "REQUEST",
        uid: "ical-1",
        sequence: 0,
        summary: "Video Test",
        startDate: "2026-06-16T13:00:00.000Z",
        endDate: "2026-06-16T14:00:00.000Z",
        allDay: false,
        organizer: { address: "boss@example.com", displayName: "The Boss" },
        attendees: [],
        recurring: false,
        isOrganizer: false,
        onCalendar: false,
        outdated: false,
        canRespond: true,
        canAdd: false,
        canRemove: false,
        canPropose: true,
        canAcceptProposal: false,
        conflicts: [],
        schedule: [entry("e1", "Standup", "2026-06-16T11:00:00.000Z", "2026-06-16T11:30:00.000Z")],
        ...overrides,
    };
}

function plain(text: string | null | undefined): string {
    return (text ?? "").replace(/\s+/g, " ");
}

/** Serves the invite routes: `lookup` answers the GET (per message uid), `action` the POSTs. */
function mockInviteServer(
    lookup: (uid: string) => Response | Promise<Response> = () => jsonResponse(200, inviteFixture()),
    action: (url: string, init: RequestInit) => Response | Promise<Response> = () => jsonResponse(200, inviteFixture()),
) {
    return mockFetch((url, init) => ((init?.method ?? "GET") === "GET" ? lookup(url.split("/").pop()!) : action(url, init)));
}

function inviteRequests(fetchMock: ReturnType<typeof mockFetch>) {
    return fetchMock.mock.calls.filter(([url]) => String(url).includes("/calendar-events/invite/"));
}

afterEach(() => {
    vi.unstubAllGlobals();
    clearInviteCache();
    dismissAll();
});

/** Draws a chip and waits until its invitation is in. */
async function renderChip(invite: MessageInvite | null = inviteFixture(), props: Partial<React.ComponentProps<typeof InviteRowChip>> = {}) {
    // Several chips are drawn for the one message uid in a test: each starts from a cold cache.
    clearInviteCache();
    const fetchMock = mockInviteServer(() => (invite ? jsonResponse(200, invite) : jsonResponse(404, { message: "none" })));
    const view = render(<InviteRowChip message={message()} {...props} />);
    if (invite) {
        await waitFor(() => expect(view.container.querySelector("[data-invite-chip]")?.textContent).not.toBe("Meeting request"));
    }
    return { fetchMock, ...view };
}

describe("showsInviteChip", () => {
    it.each([
        [{ meetingMethod: "REQUEST" }, true],
        [{ meetingMethod: "REQUEST", encrypted: true }, false],
        [{ meetingMethod: "REPLY" }, false],
        [{ meetingMethod: "" }, false],
        [{}, false],
    ])("%j -> %s", (fields, expected) => {
        expect(showsInviteChip(fields)).toBe(expected);
    });
});

describe("InviteRowChip", () => {
    it("draws nothing, and asks the server nothing, for a row that is not an unencrypted meeting request", async () => {
        const fetchMock = mockInviteServer();
        const rows: Partial<Message>[] = [{ meetingMethod: undefined }, { meetingMethod: "REPLY" }, { meetingMethod: "CANCEL" }, { meetingMethod: "REQUEST", encrypted: true }];
        for (const row of rows) {
            const { container, unmount } = render(<InviteRowChip message={message(row)} />);
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(container).toBeEmptyDOMElement();
            unmount();
        }
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("says when the meeting starts, that it has no conflicts, and offers RSVP", async () => {
        const { fetchMock, container } = await renderChip();
        const chip = container.querySelector("[data-invite-chip]")!;

        expect(plain(chip.textContent)).toContain("Tue 6/16/2026 1:00 PM");
        expect(chip).toHaveTextContent("No conflicts");
        expect(within(chip as HTMLElement).getByRole("button", { name: "RSVP to Video Test" })).toHaveTextContent("RSVP");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/calendar-events/invite/m1", expect.anything());
    });

    it("looks a message up once however many chips ask about it", async () => {
        const fetchMock = mockInviteServer();
        render(
            <>
                <InviteRowChip message={message()} />
                <InviteRowChip message={message()} />
            </>,
        );
        await waitFor(() => expect(screen.getAllByRole("button", { name: /RSVP/ })).toHaveLength(2));
        expect(inviteRequests(fetchMock)).toHaveLength(1);
    });

    it("says only 'Meeting request', with no button, until the invitation is in - and when it never comes", async () => {
        mockInviteServer(() => new Promise<Response>(() => undefined));
        const { container, unmount } = render(<InviteRowChip message={message()} />);
        expect(container.querySelector("[data-invite-chip]")).toHaveTextContent("Meeting request");
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
        unmount();

        const fetchMock = mockInviteServer(() => jsonResponse(500, { message: "Boom" }));
        const failed = render(<InviteRowChip message={message({ uid: "m2" })} />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        await act(async () => undefined);
        expect(failed.container.querySelector("[data-invite-chip]")).toHaveTextContent("Meeting request");
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
        expect(getNotificationsSnapshot().visible).toEqual([]);
    });

    it("shows a start of 'Meeting request' when the invitation names none", async () => {
        const { container } = await renderChip(inviteFixture({ startDate: undefined }));
        expect(container.querySelector("[data-invite-chip]")).toHaveTextContent(/^Meeting requestNo conflictsRSVP$/);
    });

    it("shows a date only for an all-day meeting", async () => {
        const { container } = await renderChip(inviteFixture({ allDay: true, timezone: "UTC", startDate: "2026-06-16T00:00:00.000Z", endDate: "2026-06-17T00:00:00.000Z" }));
        expect(plain(container.querySelector("[data-invite-chip]")!.textContent)).toContain("Tue 6/16/2026No conflicts");
    });

    it.each([
        [1, "Conflicts with 1 event"],
        [2, "Conflicts with 2 events"],
    ])("counts %i conflicts", async (count, text) => {
        const conflicts = Array.from({ length: count }, (_, i) => entry(`c${i}`, `Clash ${i}`, "2026-06-16T13:15:00.000Z", "2026-06-16T13:45:00.000Z"));
        const { container } = await renderChip(inviteFixture({ conflicts }));
        expect(container.querySelector("[data-invite-chip]")).toHaveTextContent(text);
        expect(container.querySelector("[data-invite-chip]")).not.toHaveTextContent("No conflicts");
    });

    it.each([
        ["accepted", "Accepted"],
        ["tentative", "Tentative"],
        ["declined", "Declined"],
    ] as const)("shows the answer '%s' instead of conflicts", async (response, label) => {
        const conflicts = [entry("c1", "Clash", "2026-06-16T13:15:00.000Z", "2026-06-16T13:45:00.000Z")];
        const { container } = await renderChip(inviteFixture({ response, conflicts }));
        expect(container.querySelector("[data-invite-chip]")).toHaveTextContent(label);
        expect(container.querySelector("[data-invite-chip]")).not.toHaveTextContent("Conflicts");
    });

    it("shows the answer the message itself records when the invitation has none yet", async () => {
        const fetchMock = mockInviteServer();
        const { container } = render(<InviteRowChip message={message({ meetingResponse: "accepted" })} />);
        await waitFor(() => expect(container.querySelector("[data-invite-chip]")).toHaveTextContent("Accepted"));
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("offers no RSVP to the organizer or when the request is not addressed to the reader", async () => {
        const first = await renderChip(inviteFixture({ isOrganizer: true }));
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
        first.unmount();

        await renderChip(inviteFixture({ canRespond: false }));
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("names an untitled meeting in the button's name", async () => {
        await renderChip(inviteFixture({ summary: " " }));
        expect(screen.getByRole("button", { name: "RSVP to this meeting" })).toBeInTheDocument();
    });

    it("keeps clicks and touches to itself, popover included, so a row neither opens nor swipes", async () => {
        const user = userEvent.setup();
        const outer = { click: vi.fn(), touchStart: vi.fn(), touchMove: vi.fn(), touchEnd: vi.fn(), touchCancel: vi.fn() };
        mockInviteServer();
        render(
            <div
                onClick={outer.click}
                onTouchStart={outer.touchStart}
                onTouchMove={outer.touchMove}
                onTouchEnd={outer.touchEnd}
                onTouchCancel={outer.touchCancel}
            >
                <InviteRowChip message={message()} />
            </div>,
        );
        const rsvp = await screen.findByRole("button", { name: /RSVP/ });
        fireEvent.touchStart(rsvp, { touches: [{ clientX: 10, clientY: 10 }] });
        fireEvent.touchMove(rsvp, { touches: [{ clientX: 200, clientY: 10 }] });
        fireEvent.touchEnd(rsvp);
        fireEvent.touchCancel(rsvp);
        await user.click(rsvp);

        // Inside the popover, which is drawn on the page's body but sits under the chip in React's tree.
        const dialog = await screen.findByRole("dialog");
        fireEvent.touchStart(within(dialog).getByRole("heading"), { touches: [{ clientX: 10, clientY: 10 }] });
        fireEvent.touchMove(within(dialog).getByRole("heading"), { touches: [{ clientX: 200, clientY: 10 }] });
        await user.click(within(dialog).getByRole("heading"));

        for (const spy of Object.values(outer)) {
            expect(spy).not.toHaveBeenCalled();
        }
    });

    describe("the RSVP popover", () => {
        it("opens a dialog with the meeting, its conflicts and a day view around it, and puts focus on the first button", async () => {
            const user = userEvent.setup();
            const conflicts = [entry("c1", "Design review", "2026-06-16T13:30:00.000Z", "2026-06-16T14:30:00.000Z")];
            await renderChip(inviteFixture({ conflicts, schedule: [entry("e1", "Standup", "2026-06-16T11:00:00.000Z", "2026-06-16T11:30:00.000Z"), ...conflicts] }));
            const rsvp = screen.getByRole("button", { name: "RSVP to Video Test" });
            expect(rsvp).toHaveAttribute("aria-expanded", "false");
            expect(rsvp).toHaveAttribute("aria-haspopup", "dialog");
            await user.click(rsvp);

            const dialog = await screen.findByRole("dialog", { name: "RSVP: Video Test" });
            expect(rsvp).toHaveAttribute("aria-expanded", "true");
            expect(within(dialog).getByRole("heading", { name: "Video Test" })).toBeInTheDocument();
            expect(plain(dialog.textContent)).toContain("Tue, Jun 16, 2026, 1:00 PM - 2:00 PM UTC");
            expect(dialog).toHaveTextContent("Conflicts with: Design review");
            const events = within(within(dialog).getByRole("list", { name: "Events" })).getAllByRole("listitem");
            expect(events.map((item) => item.getAttribute("data-kind")).sort()).toEqual(["busy", "conflict", "invite"]);
            expect(within(dialog).getByRole("button", { name: "Accept" })).toHaveFocus();
            expect(within(dialog).getByRole("button", { name: "Decline" })).toBeEnabled();
            expect(within(dialog).getByRole("button", { name: "Tentative" })).toHaveTextContent("?");
            expect(within(dialog).getByRole("button", { name: "More actions" })).toHaveAttribute("aria-haspopup", "menu");
        });

        it("names an untitled meeting and says it repeats", async () => {
            const user = userEvent.setup();
            await renderChip(inviteFixture({ summary: " ", recurring: true }));
            await user.click(screen.getByRole("button", { name: "RSVP to this meeting" }));

            const dialog = await screen.findByRole("dialog", { name: "RSVP: (no title)" });
            expect(within(dialog).getByRole("heading", { name: "(no title)" })).toBeInTheDocument();
            expect(dialog).toHaveTextContent("(Repeats)");
        });

        it("marks the current answer and does not offer it again", async () => {
            const user = userEvent.setup();
            await renderChip(inviteFixture({ response: "tentative" }));
            await user.click(screen.getByRole("button", { name: /RSVP/ }));

            const dialog = await screen.findByRole("dialog");
            expect(within(dialog).getByRole("button", { name: "Tentative" })).toBeDisabled();
            expect(within(dialog).getByRole("button", { name: "Tentative" })).toHaveAttribute("aria-pressed", "true");
            expect(within(dialog).getByRole("button", { name: "Accept" })).toHaveAttribute("aria-pressed", "false");
            // Focus starts on the first button that can be pressed.
            expect(within(dialog).getByRole("button", { name: "Accept" })).toHaveFocus();
        });

        it("closes on Escape and returns focus to RSVP", async () => {
            const user = userEvent.setup();
            await renderChip();
            const rsvp = screen.getByRole("button", { name: /RSVP/ });
            await user.click(rsvp);
            await screen.findByRole("dialog");

            await user.keyboard("{Escape}");

            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
            expect(rsvp).toHaveFocus();
        });

        it("closes on a click elsewhere, and RSVP toggles it", async () => {
            const user = userEvent.setup();
            await renderChip();
            const rsvp = screen.getByRole("button", { name: /RSVP/ });
            await user.click(rsvp);
            await screen.findByRole("dialog");
            await user.click(rsvp);
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

            await user.click(rsvp);
            await screen.findByRole("dialog");
            fireEvent.pointerDown(document.body);
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        });

        it.each([
            ["Accept", "accepted"],
            ["Decline", "declined"],
            ["Tentative", "tentative"],
        ] as const)("%s sends the answer, closes, and updates the chip and the list", async (name, response) => {
            const user = userEvent.setup();
            const onResponded = vi.fn();
            const fetchMock = mockInviteServer(
                () => jsonResponse(200, inviteFixture()),
                () => jsonResponse(200, inviteFixture({ response })),
            );
            const { container } = render(<InviteRowChip message={message({ uid: "m/1" })} onResponded={onResponded} />);
            await user.click(await screen.findByRole("button", { name: /RSVP/ }));
            await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name }));

            await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
            expect(fetchMock).toHaveBeenLastCalledWith(
                "/api/mail/calendar-events/invite/m%2F1/respond",
                expect.objectContaining({ method: "POST", body: JSON.stringify({ responseStatus: response }) }),
            );
            expect(container.querySelector("[data-invite-chip]")).toHaveTextContent({ accepted: "Accepted", declined: "Declined", tentative: "Tentative" }[response]);
            expect(onResponded).toHaveBeenCalledWith(expect.objectContaining({ uid: "m/1", meetingResponse: response }));
            expect(screen.getByRole("button", { name: /RSVP/ })).toHaveFocus();
        });

        it("keeps the answer in the cache, so a card for the same message agrees", async () => {
            const user = userEvent.setup();
            mockInviteServer(
                () => jsonResponse(200, inviteFixture()),
                () => jsonResponse(200, inviteFixture({ response: "accepted", onCalendar: true })),
            );
            const { rerender } = render(<InviteRowChip message={message()} />);
            await user.click(await screen.findByRole("button", { name: /RSVP/ }));
            await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Accept" }));
            await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

            rerender(<InviteRowChip message={message({ meetingResponse: undefined })} />);
            expect(screen.getByText("Accepted")).toBeInTheDocument();
        });

        it("disables the buttons while an answer is on its way, and on failure raises a pop-up and stays open", async () => {
            const user = userEvent.setup();
            let fail!: (response: Response) => void;
            mockInviteServer(
                () => jsonResponse(200, inviteFixture()),
                () => new Promise<Response>((resolve) => (fail = resolve)),
            );
            const onResponded = vi.fn();
            render(<InviteRowChip message={message()} onResponded={onResponded} />);
            await user.click(await screen.findByRole("button", { name: /RSVP/ }));
            const dialog = await screen.findByRole("dialog");
            await user.click(within(dialog).getByRole("button", { name: "Decline" }));

            for (const name of ["Accept", "Decline", "Tentative", "More actions"]) {
                expect(within(dialog).getByRole("button", { name })).toBeDisabled();
            }
            expect(within(dialog).getByRole("button", { name: "Decline" })).toHaveAttribute("aria-busy", "true");
            fail(jsonResponse(500, { message: "The mail server is down" }));

            await waitFor(() =>
                expect(getNotificationsSnapshot().visible).toMatchObject([{ kind: "error", title: "Couldn't decline this meeting" }]),
            );
            expect(screen.getByRole("dialog")).toBeInTheDocument();
            expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Accept" })).toBeEnabled();
            expect(onResponded).not.toHaveBeenCalled();
        });

        describe("the More actions menu", () => {
            async function openMenu(invite: MessageInvite = inviteFixture()) {
                const user = userEvent.setup();
                const rendered = await renderChip(invite);
                await user.click(screen.getByRole("button", { name: /RSVP/ }));
                const dialog = await screen.findByRole("dialog");
                await user.click(within(dialog).getByRole("button", { name: "More actions" }));
                return { user, dialog, ...rendered };
            }

            it("offers Propose new time and Open in calendar, focusing the first", async () => {
                const { dialog } = await openMenu();
                const menu = within(dialog).getByRole("menu", { name: "More actions" });

                expect(within(menu).getByRole("menuitem", { name: "Propose new time" })).toHaveFocus();
                expect(within(menu).getByRole("menuitem", { name: "Open in calendar" })).toHaveAttribute("href", "/calendar?date=2026-06-16&view=day");
                expect(within(dialog).getByRole("button", { name: "More actions" })).toHaveAttribute("aria-expanded", "true");
            });

            it("leaves Propose new time out when the reader cannot propose", async () => {
                const { dialog } = await openMenu(inviteFixture({ canPropose: false }));
                const menu = within(dialog).getByRole("menu");
                expect(within(menu).queryByRole("menuitem", { name: "Propose new time" })).not.toBeInTheDocument();
                expect(within(menu).getByRole("menuitem", { name: "Open in calendar" })).toHaveFocus();
            });

            it("moves with the arrow keys, wrapping", async () => {
                const { user, dialog } = await openMenu();
                const menu = within(dialog).getByRole("menu");
                await user.keyboard("{ArrowDown}");
                expect(within(menu).getByRole("menuitem", { name: "Open in calendar" })).toHaveFocus();
                await user.keyboard("{ArrowDown}");
                expect(within(menu).getByRole("menuitem", { name: "Propose new time" })).toHaveFocus();
                await user.keyboard("{ArrowUp}");
                expect(within(menu).getByRole("menuitem", { name: "Open in calendar" })).toHaveFocus();
            });

            it("closes on Escape before the popover does, returning focus to the button", async () => {
                const { user, dialog } = await openMenu();
                await user.keyboard("{Escape}");

                expect(within(dialog).queryByRole("menu")).not.toBeInTheDocument();
                expect(within(dialog).getByRole("button", { name: "More actions" })).toHaveFocus();
                expect(screen.getByRole("dialog")).toBeInTheDocument();
                await user.keyboard("{Escape}");
                expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
            });

            it("closes when the button is pressed again", async () => {
                const { user, dialog } = await openMenu();
                await user.click(within(dialog).getByRole("button", { name: "More actions" }));
                expect(within(dialog).queryByRole("menu")).not.toBeInTheDocument();
            });

            it("Propose new time swaps the day view for the form, prefilled in the reader's zone; Cancel brings the day view back", async () => {
                const { user, dialog } = await openMenu();
                await user.click(within(dialog).getByRole("menuitem", { name: "Propose new time" }));

                const form = within(dialog).getByRole("form", { name: "Propose a new time" });
                expect(within(form).getByLabelText("Date")).toHaveValue("2026-06-16");
                expect(within(form).getByLabelText("Start")).toHaveValue("13:00");
                expect(within(form).getByLabelText("End")).toHaveValue("14:00");
                expect(within(dialog).queryByRole("list", { name: "Events" })).not.toBeInTheDocument();
                expect(within(dialog).queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();

                await user.click(within(form).getByRole("button", { name: "Cancel" }));
                expect(within(dialog).getByRole("list", { name: "Events" })).toBeInTheDocument();
                expect(within(dialog).getByRole("button", { name: "Accept" })).toBeInTheDocument();
            });

            it("sends the proposal, closes, and keeps the reader's earlier answer in the list", async () => {
                const user = userEvent.setup();
                const onResponded = vi.fn();
                const fetchMock = mockInviteServer(
                    () => jsonResponse(200, inviteFixture()),
                    () => jsonResponse(200, inviteFixture()),
                );
                render(<InviteRowChip message={message({ meetingResponse: "tentative" })} onResponded={onResponded} />);
                await user.click(await screen.findByRole("button", { name: /RSVP/ }));
                const dialog = await screen.findByRole("dialog");
                await user.click(within(dialog).getByRole("button", { name: "More actions" }));
                await user.click(within(dialog).getByRole("menuitem", { name: "Propose new time" }));
                fireEvent.change(within(dialog).getByLabelText("Start"), { target: { value: "15:00" } });
                fireEvent.change(within(dialog).getByLabelText("End"), { target: { value: "16:00" } });
                await user.type(within(dialog).getByLabelText("Comment (optional)"), "Later?");
                await user.click(within(dialog).getByRole("button", { name: "Send proposal" }));

                await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
                expect(fetchMock).toHaveBeenLastCalledWith(
                    "/api/mail/calendar-events/invite/m1/propose",
                    expect.objectContaining({
                        method: "POST",
                        body: JSON.stringify({ startDate: "2026-06-16T15:00:00.000Z", endDate: "2026-06-16T16:00:00.000Z", comment: "Later?" }),
                    }),
                );
                expect(onResponded).toHaveBeenCalledWith(expect.objectContaining({ meetingResponse: "tentative" }));
            });

            it("rejects an end that is not after the start without sending anything", async () => {
                const { user, dialog, fetchMock } = await openMenu();
                await user.click(within(dialog).getByRole("menuitem", { name: "Propose new time" }));
                fireEvent.change(within(dialog).getByLabelText("End"), { target: { value: "12:00" } });
                await user.click(within(dialog).getByRole("button", { name: "Send proposal" }));

                expect(within(dialog).getByRole("alert")).toHaveTextContent("The end time must be after the start time.");
                expect(inviteRequests(fetchMock)).toHaveLength(1);
            });

            it("keeps the form open and raises a pop-up when the proposal fails", async () => {
                const user = userEvent.setup();
                let fail!: (response: Response) => void;
                mockInviteServer(
                    () => jsonResponse(200, inviteFixture()),
                    () => new Promise<Response>((resolve) => (fail = resolve)),
                );
                render(<InviteRowChip message={message()} />);
                await user.click(await screen.findByRole("button", { name: /RSVP/ }));
                const dialog = await screen.findByRole("dialog");
                await user.click(within(dialog).getByRole("button", { name: "More actions" }));
                await user.click(within(dialog).getByRole("menuitem", { name: "Propose new time" }));
                await user.click(within(dialog).getByRole("button", { name: "Send proposal" }));
                expect(within(dialog).getByRole("button", { name: "Send proposal" })).toBeDisabled();
                fail(jsonResponse(500, { message: "Boom" }));

                await waitFor(() => expect(getNotificationsSnapshot().visible).toMatchObject([{ kind: "error", title: "Couldn't send the proposed time" }]));
                expect(within(screen.getByRole("dialog")).getByRole("form")).toBeInTheDocument();
                expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Send proposal" })).toBeEnabled();
            });
        });

        describe("its size", () => {
            async function heightFor(invite: MessageInvite, propose = false) {
                const user = userEvent.setup();
                await renderChip(invite);
                await user.click(screen.getByRole("button", { name: /RSVP/ }));
                const dialog = await screen.findByRole("dialog");
                if (propose) {
                    await user.click(within(dialog).getByRole("button", { name: "More actions" }));
                    await user.click(within(dialog).getByRole("menuitem", { name: "Propose new time" }));
                }
                return parseInt((screen.getByRole("dialog")).style.height, 10);
            }

            it("grows with the day view, the conflicts line and all-day events, and is a fixed size for the form", async () => {
                const base = await heightFor(inviteFixture({ schedule: [] }));
                expect(base).toBe(190 + 5 * 36);
                cleanup();

                const withConflict = await heightFor(inviteFixture({ schedule: [], conflicts: [entry("c1", "Clash", "2026-06-16T13:00:00.000Z", "2026-06-16T13:30:00.000Z")] }));
                expect(withConflict).toBe(base + 22);
                cleanup();

                const allDay = await heightFor(inviteFixture({ schedule: [entry("a1", "Holiday", "2026-06-16T00:00:00.000Z", "2026-06-17T00:00:00.000Z", { allDay: true })] }));
                expect(allDay).toBe(base + 22);
                cleanup();

                const longMeeting = await heightFor(inviteFixture({ endDate: "2026-06-16T17:00:00.000Z", schedule: [] }));
                expect(longMeeting).toBe(190 + 8 * 36);
                cleanup();

                const noTimes = await heightFor(inviteFixture({ startDate: undefined, endDate: undefined, schedule: [] }));
                expect(noTimes).toBe(base);
                cleanup();

                expect(await heightFor(inviteFixture(), true)).toBe(340);
            });

        });
    });

    describe("on a phone", () => {
        it("opens a modal dialog instead, which Escape closes", async () => {
            mockMatchMedia(true);
            const user = userEvent.setup();
            await renderChip();
            const rsvp = screen.getByRole("button", { name: /RSVP/ });
            await user.click(rsvp);

            const dialog = await screen.findByRole("dialog", { name: "Meeting invitation" });
            expect(dialog).toHaveAttribute("aria-modal", "true");
            expect(within(dialog).getByRole("heading", { name: "Video Test" })).toBeInTheDocument();
            await user.click(within(dialog).getByRole("button", { name: "Accept" }));
            await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

            await user.click(rsvp);
            await screen.findByRole("dialog");
            await user.keyboard("{Escape}");
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        });
    });
});
