// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { BOOKING_HREF, mailboxOptions, renderNew, sentBody } from "./quickCreateHelpers.js";

// The Appointment schedule tab of a new event's popover, shown when the booking plugin is running: a booking type created through the
// plugin's `POST /api/mail/booking-types`, then its public link.

const BOOKING_TYPES = "/api/mail/booking-types";

afterEach(() => {
    vi.unstubAllGlobals();
});

interface BookingApiOptions {
    /** Answers each `POST /mail/booking-types`, in turn (the last one repeats). */
    answers?: (() => Response)[];
}

function mockBookingApi({ answers }: BookingApiOptions = {}) {
    let call = 0;
    return mockFetch((url, init) => {
        if (url === BOOKING_TYPES && init?.method === "POST") {
            const body = JSON.parse(init.body as string);
            const answer = answers?.[Math.min(call++, answers.length - 1)];
            return answer ? answer() : jsonResponse(200, { uid: "b1", mailboxUid: body.mailboxUid, slug: body.slug, name: body.name });
        }
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

async function openAppointmentTab(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("tab", { name: "Appointment schedule" }));
}

describe("the form", () => {
    it("starts with 30 minutes, Monday to Friday 9 to 5 in the mailbox's zone, a video call, and the calendar the bookings go to", async () => {
        const user = userEvent.setup();
        renderNew({ bookingHref: BOOKING_HREF, mailboxOptions: [mailboxOptions[0]] });
        await openAppointmentTab(user);

        expect(screen.getByLabelText("Title")).toHaveAttribute("placeholder", "Add title");
        expect(screen.getByLabelText("Duration")).toHaveValue("30");
        expect(screen.queryByLabelText("Custom duration in minutes")).not.toBeInTheDocument();
        expect(screen.getByLabelText("Buffer after each appointment")).toHaveValue("0");
        const pressed = (day: string) => screen.getByRole("button", { name: day }).getAttribute("aria-pressed");
        expect(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map(pressed)).toEqual([
            "false",
            "true",
            "true",
            "true",
            "true",
            "true",
            "false",
        ]);
        expect(screen.getByLabelText("Bookable from")).toHaveValue("09:00");
        expect(screen.getByLabelText("Bookable until")).toHaveValue("17:00");
        expect(screen.getByText("Times are in America/New York.")).toBeInTheDocument();
        expect(screen.getByRole("checkbox", { name: "Video call" })).toBeChecked();
        expect(screen.getByRole("checkbox", { name: "Phone call" })).not.toBeChecked();
        expect(screen.getByRole("checkbox", { name: "Other" })).not.toBeChecked();
        expect(screen.getByText("Bookings are added to")).toBeInTheDocument();
        expect(screen.getByText("Work")).toBeInTheDocument();
    });

    it("links More options to the plugin's own new-link page for the mailbox", async () => {
        const user = userEvent.setup();
        renderNew({ bookingHref: BOOKING_HREF });
        await openAppointmentTab(user);

        expect(screen.getByRole("link", { name: "More options" })).toHaveAttribute(
            "href",
            "/settings/booking-types/new?mailboxUid=jane%40example.com",
        );
    });

    it("follows the mailbox chosen for the bookings, in the link and in what is created", async () => {
        const fetchMock = mockBookingApi();
        const user = userEvent.setup();
        renderNew({ bookingHref: BOOKING_HREF, mailboxOptions });
        await user.type(screen.getByLabelText("Title"), "Support hours");
        await openAppointmentTab(user);

        await user.selectOptions(screen.getByLabelText("Mailbox"), "mb-shared");
        await user.selectOptions(screen.getByLabelText("Calendar"), "f-s2");
        expect(screen.getByRole("link", { name: "More options" })).toHaveAttribute("href", "/settings/booking-types/new?mailboxUid=mb-shared");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await screen.findByLabelText("Booking link");
        // The shared mailbox has no zone on record here: the device's is used.
        expect(sentBody(fetchMock, BOOKING_TYPES)).toEqual(
            expect.objectContaining({ mailboxUid: "mb-shared", calendarFolderUid: "f-s2", hostDisplayName: "Support", timezone: "UTC" }),
        );
    });
});

describe("creating the schedule", () => {
    it("publishes the booking type with the hours as one window a day, then shows the link with a Copy button", async () => {
        const fetchMock = mockBookingApi();
        const user = userEvent.setup();
        const { onClose, onSaved } = renderNew({ bookingHref: BOOKING_HREF, mailboxOptions });
        await user.type(screen.getByLabelText("Title"), "Intro Call!");
        await openAppointmentTab(user);
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText(/is ready to book/)).toHaveTextContent("“Intro Call!” is ready to book.");
        expect(sentBody(fetchMock, BOOKING_TYPES)).toEqual({
            mailboxUid: "jane@example.com",
            calendarFolderUid: "f1",
            slug: "intro-call",
            name: "Intro Call!",
            hostDisplayName: "Jane Doe",
            meetingTypes: [{ name: "Intro Call!", durationMinutes: 30, locationOptions: [{ type: "video" }] }],
            timezone: "America/New_York",
            availability: [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startMinute: 540, endMinute: 1020 })),
            dateOverrides: [],
            bufferBeforeMinutes: 0,
            bufferAfterMinutes: 0,
            minimumNoticeMinutes: 60,
            bookingWindowDays: 30,
            requiresApproval: false,
            enabled: true,
        });

        // The link, on this site, and not the form any more.
        const link = `${window.location.origin}/book/jane@example.com/intro-call`;
        expect(screen.getByLabelText("Booking link")).toHaveValue(link);
        expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Duration")).not.toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Change its settings" })).toHaveAttribute(
            "href",
            "/settings/booking-types/b1?mailboxUid=jane%40example.com",
        );
        await user.click(screen.getByRole("button", { name: "Copy the booking link" }));
        expect(await screen.findByText("Copied")).toBeInTheDocument();
        // user-event stands in for the clipboard.
        await expect(navigator.clipboard.readText()).resolves.toBe(link);
        // Nothing was written to the calendar, and the popover is still open on the link.
        expect(onSaved).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it("selects the whole link when it is focused, and closes with Done", async () => {
        mockBookingApi();
        const user = userEvent.setup();
        const { onClose } = renderNew({ bookingHref: BOOKING_HREF });
        await user.type(screen.getByLabelText("Title"), "Intro");
        await openAppointmentTab(user);
        await user.click(screen.getByRole("button", { name: "Save" }));

        const input = (await screen.findByLabelText("Booking link"));
        input.focus();
        expect(input.selectionStart).toBe(0);
        expect(input.selectionEnd).toBe(input.value.length);
        expect(screen.queryByRole("link", { name: "More options" })).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Done" }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("closes on Enter once the link is shown", async () => {
        mockBookingApi();
        const user = userEvent.setup();
        const { onClose } = renderNew({ bookingHref: BOOKING_HREF });
        await user.type(screen.getByLabelText("Title"), "Intro");
        await openAppointmentTab(user);
        await user.type(screen.getByLabelText("Title"), "{Enter}");

        await screen.findByLabelText("Booking link");
        fireEvent.submit(screen.getByRole("button", { name: "Done" }).closest("form")!);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("shows the link again after a look at another tab, rather than a second form", async () => {
        mockBookingApi();
        const user = userEvent.setup();
        renderNew({ bookingHref: BOOKING_HREF });
        await user.type(screen.getByLabelText("Title"), "Intro");
        await openAppointmentTab(user);
        await user.click(screen.getByRole("button", { name: "Save" }));
        await screen.findByLabelText("Booking link");

        await user.click(screen.getByRole("tab", { name: "Event" }));
        expect(screen.getByLabelText("Title")).toHaveValue("Intro");
        await user.click(screen.getByRole("tab", { name: "Appointment schedule" }));
        expect(screen.getByLabelText("Booking link")).toBeInTheDocument();
    });

    it("uses the chosen duration, days, hours, buffer and ways to meet", async () => {
        const fetchMock = mockBookingApi();
        const user = userEvent.setup();
        renderNew({ bookingHref: BOOKING_HREF, mailboxOptions });
        await user.type(screen.getByLabelText("Title"), "Office hours");
        await openAppointmentTab(user);

        await user.selectOptions(screen.getByLabelText("Duration"), "custom");
        await user.type(screen.getByLabelText("Custom duration in minutes"), "50");
        // Wednesdays and Saturdays only.
        for (const day of ["Monday", "Tuesday", "Thursday", "Friday", "Saturday"]) {
            await user.click(screen.getByRole("button", { name: day }));
        }
        expect(screen.getByRole("button", { name: "Monday" })).toHaveAttribute("aria-pressed", "false");
        expect(screen.getByRole("button", { name: "Saturday" })).toHaveAttribute("aria-pressed", "true");
        fireEvent.change(screen.getByLabelText("Bookable from"), { target: { value: "10:15" } });
        fireEvent.change(screen.getByLabelText("Bookable until"), { target: { value: "12:00" } });
        await user.selectOptions(screen.getByLabelText("Buffer after each appointment"), "15");
        await user.click(screen.getByRole("checkbox", { name: "Video call" }));
        await user.click(screen.getByRole("checkbox", { name: "Phone call" }));
        await user.click(screen.getByRole("checkbox", { name: "Other" }));
        await user.click(screen.getByRole("button", { name: "Save" }));

        await screen.findByLabelText("Booking link");
        expect(sentBody(fetchMock, BOOKING_TYPES)).toEqual(
            expect.objectContaining({
                meetingTypes: [{ name: "Office hours", durationMinutes: 50, locationOptions: [{ type: "phone" }, { type: "other" }] }],
                availability: [
                    { dayOfWeek: 3, startMinute: 615, endMinute: 720 },
                    { dayOfWeek: 6, startMinute: 615, endMinute: 720 },
                ],
                bufferAfterMinutes: 15,
            }),
        );
    });

    it("names the host by the signed-in address when the mailbox is not among those it knows", async () => {
        const fetchMock = mockBookingApi();
        const user = userEvent.setup();
        renderNew({ bookingHref: BOOKING_HREF });
        await user.type(screen.getByLabelText("Title"), "Intro");
        await openAppointmentTab(user);
        await user.click(screen.getByRole("button", { name: "Save" }));

        await screen.findByLabelText("Booking link");
        expect(sentBody(fetchMock, BOOKING_TYPES).hostDisplayName).toBe("jane@example.com");
    });

    it("finds a free link name when the first is taken, and gives up after a few", async () => {
        const taken = () => jsonResponse(409, { message: "This booking slug is already in use." });
        const fetchMock = mockBookingApi({ answers: [taken, taken, () => jsonResponse(200, { uid: "b9", mailboxUid: "jane@example.com", slug: "intro-3", name: "Intro" })] });
        const user = userEvent.setup();
        renderNew({ bookingHref: BOOKING_HREF });
        await user.type(screen.getByLabelText("Title"), "Intro");
        await openAppointmentTab(user);
        await user.click(screen.getByRole("button", { name: "Save" }));

        await screen.findByLabelText("Booking link");
        expect(fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string).slug)).toEqual(["intro", "intro-2", "intro-3"]);
        expect(screen.getByLabelText("Booking link")).toHaveValue(`${window.location.origin}/book/jane@example.com/intro-3`);
    });

    it("stops after five taken names and shows the server's message", async () => {
        const fetchMock = mockBookingApi({ answers: [() => jsonResponse(409, { message: "This booking slug is already in use." })] });
        const user = userEvent.setup();
        renderNew({ bookingHref: BOOKING_HREF });
        await user.type(screen.getByLabelText("Title"), "Intro");
        await openAppointmentTab(user);
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("This booking slug is already in use.")).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledTimes(5);
        expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    });

    it("shows any other refusal at once, without trying another name", async () => {
        const fetchMock = mockBookingApi({ answers: [() => jsonResponse(403, { message: "You cannot change this mailbox." })] });
        const user = userEvent.setup();
        renderNew({ bookingHref: BOOKING_HREF });
        await user.type(screen.getByLabelText("Title"), "Intro");
        await openAppointmentTab(user);
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("You cannot change this mailbox.")).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("says so plainly when the request did not get an answer", async () => {
        mockBookingApi({
            answers: [
                () => {
                    throw new TypeError("network down");
                },
            ],
        });
        const user = userEvent.setup();
        renderNew({ bookingHref: BOOKING_HREF });
        await user.type(screen.getByLabelText("Title"), "Intro");
        await openAppointmentTab(user);
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("Could not create this appointment schedule.")).toBeInTheDocument();
    });
});

describe("what it checks first", () => {
    async function openWithTitle(title: string | null = "Intro") {
        const fetchMock = mockBookingApi();
        const user = userEvent.setup();
        renderNew({ bookingHref: BOOKING_HREF });
        if (title) {
            await user.type(screen.getByLabelText("Title"), title);
        }
        await openAppointmentTab(user);
        return { user, fetchMock };
    }
    const noRequest = (fetchMock: ReturnType<typeof vi.fn>) => expect(fetchMock).not.toHaveBeenCalled();

    it("needs a title", async () => {
        const { user, fetchMock } = await openWithTitle(null);
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("A title is required.")).toBeInTheDocument();
        noRequest(fetchMock);
    });

    it("needs a whole number of minutes the plugin allows", async () => {
        const { user, fetchMock } = await openWithTitle();
        await user.selectOptions(screen.getByLabelText("Duration"), "custom");
        const message = "A duration is a whole number of minutes from 5 to 1440.";

        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText(message)).toBeInTheDocument();
        await user.type(screen.getByLabelText("Custom duration in minutes"), "2");
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText(message)).toBeInTheDocument();
        await user.clear(screen.getByLabelText("Custom duration in minutes"));
        await user.type(screen.getByLabelText("Custom duration in minutes"), "1441");
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText(message)).toBeInTheDocument();
        await user.clear(screen.getByLabelText("Custom duration in minutes"));
        await user.type(screen.getByLabelText("Custom duration in minutes"), "7.5");
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText(message)).toBeInTheDocument();
        noRequest(fetchMock);
    });

    it("needs a day to book", async () => {
        const { user, fetchMock } = await openWithTitle();
        for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) {
            await user.click(screen.getByRole("button", { name: day }));
        }
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Choose at least one day people can book.")).toBeInTheDocument();
        noRequest(fetchMock);
    });

    it("needs the first bookable time to be before the last", async () => {
        const { user, fetchMock } = await openWithTitle();
        fireEvent.change(screen.getByLabelText("Bookable from"), { target: { value: "17:00" } });
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("The first bookable time must be before the last.")).toBeInTheDocument();
        noRequest(fetchMock);
    });

    it("needs the hours to hold at least one appointment", async () => {
        const { user, fetchMock } = await openWithTitle();
        fireEvent.change(screen.getByLabelText("Bookable until"), { target: { value: "09:20" } });
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("The hours people can book are shorter than one appointment.")).toBeInTheDocument();
        noRequest(fetchMock);
    });

    it("needs a way to meet", async () => {
        const { user, fetchMock } = await openWithTitle();
        await user.click(screen.getByRole("checkbox", { name: "Video call" }));
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Choose at least one way to meet.")).toBeInTheDocument();
        noRequest(fetchMock);
    });

    it("clears the last problem when it is tried again", async () => {
        const { user } = await openWithTitle(null);
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("A title is required.")).toBeInTheDocument();
        await user.type(screen.getByLabelText("Title"), "Intro");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await screen.findByLabelText("Booking link");
        expect(screen.queryByText("A title is required.")).not.toBeInTheDocument();
    });
});
