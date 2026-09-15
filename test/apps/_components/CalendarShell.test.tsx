// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../testUtils.js";
import { DEFAULT_CALENDAR_COLOR, accentColorForMailbox } from "@rapidmx/react-shared/calendar/calendarColors.js";
import CalendarShell, { useCalendarShell } from "../../../apps/shared/components/calendar/layout/CalendarShell.js";

const mailboxA = {
    uid: "mb-a",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ownerUserUid: "u1",
    primarySmtpAddress: "a@example.com",
    aliasAddresses: [],
    displayName: "Mailbox A",
    timezone: "UTC",
    quotaBytes: 1_000_000_000,
    usedBytes: 0,
};
const mailboxB = { ...mailboxA, uid: "mb-b", displayName: "Mailbox B", ownerUserUid: undefined };

const calendarFolder = {
    uid: "f-cal",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb-a",
    name: "Calendar",
    type: "calendar" as const,
    unreadCount: 0,
    totalCount: 0,
};

function mockMailboxesAndFolders(mailboxes: unknown[], folders: unknown[]) {
    return mockFetch((url) => {
        // Checked before the general "/api/mail/mailboxes" prefix below, which would otherwise also
        // match this sub-path and hand `MailboxProvisioning` the mailbox list as if it were its own
        // response shape. 404 matches this feature's real default (disabled unless an admin configures it).
        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, mailboxes);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, folders);
        throw new Error(`unexpected ${url}`);
    });
}

/** Gives each mailbox its own calendar folder (uid `f-cal-<mailboxUid>`), keyed off `listFolders()`'s
 * `mailboxUid` query param. */
function mockPerMailboxFolders(mailboxes: { uid: string }[]) {
    return mockFetch((url) => {
        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, mailboxes);
        if (url.startsWith("/api/mail/folders")) {
            const mailbox = mailboxes.find((mb) => url.includes(`mailboxUid=${mb.uid}`));
            return jsonResponse(200, mailbox ? [{ ...calendarFolder, uid: `f-cal-${mailbox.uid}`, mailboxUid: mailbox.uid }] : []);
        }
        throw new Error(`unexpected ${url}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("CalendarShell", () => {
    it("shows a skeleton sidebar immediately, instead of a blank pane, while mailboxes are still loading", async () => {
        let resolveMailboxes: (() => void) | undefined;
        mockFetch((url) => {
            if (url.startsWith("/api/mail/mailboxes")) {
                return new Promise((resolve) => {
                    resolveMailboxes = () => resolve(jsonResponse(200, [mailboxA]));
                });
            }
            throw new Error(`unexpected ${url}`);
        });
        const { container } = render(<CalendarShell userUid="u1">content</CalendarShell>);

        await waitFor(() => expect(resolveMailboxes).toBeDefined());
        expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
        expect(screen.queryByText("content")).not.toBeInTheDocument();

        resolveMailboxes!();
        await screen.findByText("content");
    });


    it("redirects to auth-server's sign-in page when there is no userUid", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/calendar";
        render(<CalendarShell authServerUrl="https://auth.example.com">content</CalendarShell>);
        await waitFor(() =>
            expect(location.href).toBe(
                `https://auth.example.com/auth/signin?return_to=${encodeURIComponent("https://mail.example.com/calendar")}`,
            ),
        );
        expect(screen.queryByText("content")).not.toBeInTheDocument();
    });

    it("shows an error message when loading mailboxes fails", async () => {
        mockFetch(() => jsonResponse(500, { message: "boom" }));
        render(<CalendarShell userUid="u1">content</CalendarShell>);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when loading mailboxes fails with a non-API error", async () => {
        mockFetch(() => {
            throw new TypeError("network down");
        });
        render(<CalendarShell userUid="u1">content</CalendarShell>);
        expect(await screen.findByText("Could not load your mailboxes.")).toBeInTheDocument();
    });

    it("shows a full-screen no-mailbox page — not the app's own chrome/content at all — when the caller has none", async () => {
        mockMailboxesAndFolders([], []);
        render(<CalendarShell userUid="u1">content</CalendarShell>);
        expect(await screen.findByText("No mailbox available")).toBeInTheDocument();
        expect(screen.queryByText("content")).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Mailbox")).not.toBeInTheDocument();
        expect(screen.queryByRole("navigation", { name: "Apps" })).not.toBeInTheDocument();
    });

    it("passes plugin app rail items through to AppShell", async () => {
        mockMailboxesAndFolders([mailboxA], [calendarFolder]);
        render(
            <CalendarShell userUid="u1" pluginNav={{ appRail: [{ id: "notes", href: "/notes", label: "Notes" }] }}>
                content
            </CalendarShell>,
        );

        await screen.findByText("content");
        const rail = within(screen.getByRole("navigation", { name: "Apps" }));
        expect(rail.getByRole("link", { name: "Notes" })).toHaveAttribute("href", "/notes");
        expect(rail.getByRole("link", { name: "Calendar" })).toHaveAttribute("aria-current", "page");
    });

    it("renders a single mailbox's calendar with no mailbox switcher", async () => {
        mockMailboxesAndFolders([mailboxA], [calendarFolder]);
        render(<CalendarShell userUid="u1">content</CalendarShell>);

        await screen.findByText("content");
        expect(screen.queryByLabelText("Mailbox")).not.toBeInTheDocument();
    });

    it("fetches every accessible mailbox's calendar folders, grouped per mailbox and flattened, with no switcher", async () => {
        function Probe() {
            const { calendarFolders, mailboxCalendars } = useCalendarShell();
            return (
                <span>
                    {`${calendarFolders.map((f) => f.uid).join(",")}|${mailboxCalendars.map((mc) => `${mc.mailbox.uid}:${mc.calendarFolders.length}`).join(",")}`}
                </span>
            );
        }
        mockPerMailboxFolders([mailboxA, mailboxB]);
        render(
            <CalendarShell userUid="u1">
                <Probe />
            </CalendarShell>,
        );

        expect(await screen.findByText("f-cal-mb-a,f-cal-mb-b|mb-a:1,mb-b:1")).toBeInTheDocument();
        expect(screen.queryByLabelText("Mailbox")).not.toBeInTheDocument();
    });

    it("colors the caller's own uncolored calendar the default, and another mailbox's with its accent", async () => {
        function Probe() {
            const { calendarFolders, colorFor } = useCalendarShell();
            return <span>{calendarFolders.map((f) => `${f.uid}=${colorFor(f)}`).join(",")}</span>;
        }
        mockPerMailboxFolders([mailboxA, mailboxB]);
        render(
            <CalendarShell userUid="u1">
                <Probe />
            </CalendarShell>,
        );

        expect(
            await screen.findByText(`f-cal-mb-a=${DEFAULT_CALENDAR_COLOR},f-cal-mb-b=${accentColorForMailbox("mb-b")}`),
        ).toBeInTheDocument();
    });

    it("keeps an explicitly colored calendar's own color regardless of mailbox", async () => {
        function Probe() {
            const { calendarFolders, colorFor } = useCalendarShell();
            return <span>{calendarFolders.map((f) => colorFor(f)).join(",")}</span>;
        }
        mockMailboxesAndFolders([mailboxB], [{ ...calendarFolder, mailboxUid: "mb-b", color: "#16a34a" }]);
        render(
            <CalendarShell userUid="u1">
                <Probe />
            </CalendarShell>,
        );

        expect(await screen.findByText("#16a34a")).toBeInTheDocument();
    });

    it("reports one mailbox's folder-load failure on that mailbox's own entry, without hiding the others", async () => {
        function Probe() {
            const { mailboxCalendars } = useCalendarShell();
            return <span>{mailboxCalendars.map((mc) => `${mc.mailbox.uid}:${mc.calendarFolders.length}:${mc.error ?? ""}`).join(",")}</span>;
        }
        mockFetch((url) => {
            if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailboxA, mailboxB]);
            if (url.startsWith("/api/mail/folders") && url.includes("mb-b")) return jsonResponse(500, { message: "folder boom" });
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [calendarFolder]);
            throw new Error(`unexpected ${url}`);
        });
        render(
            <CalendarShell userUid="u1">
                <Probe />
            </CalendarShell>,
        );

        expect(await screen.findByText("mb-a:1:,mb-b:0:folder boom")).toBeInTheDocument();
    });

    it("uses a generic per-mailbox error message when loading folders fails with a non-API error", async () => {
        function Probe() {
            const { mailboxCalendars } = useCalendarShell();
            return <span>{mailboxCalendars.map((mc) => mc.error ?? "").join(",")}</span>;
        }
        mockFetch((url) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailboxA]);
            throw new TypeError("network down");
        });
        render(
            <CalendarShell userUid="u1">
                <Probe />
            </CalendarShell>,
        );
        expect(await screen.findByText("Could not load this mailbox's calendar folder.")).toBeInTheDocument();
    });

    it("defaults the new-event mailbox to the caller's own mailbox even when it isn't listed first", async () => {
        function Probe() {
            const { mailboxUid, folderUid } = useCalendarShell();
            return <span>{`${mailboxUid}/${folderUid}`}</span>;
        }
        mockPerMailboxFolders([mailboxB, mailboxA]);
        render(
            <CalendarShell userUid="u1">
                <Probe />
            </CalendarShell>,
        );
        expect(await screen.findByText("mb-a/f-cal-mb-a")).toBeInTheDocument();
    });

    it("honors a ?mailboxUid= query param that names an accessible mailbox", async () => {
        function Probe() {
            const { mailboxUid, folderUid } = useCalendarShell();
            return <span>{`${mailboxUid}/${folderUid}`}</span>;
        }
        const location = mockLocation();
        (location as any).search = "?mailboxUid=mb-b";
        mockPerMailboxFolders([mailboxA, mailboxB]);
        render(
            <CalendarShell userUid="u1">
                <Probe />
            </CalendarShell>,
        );
        expect(await screen.findByText("mb-b/f-cal-mb-b")).toBeInTheDocument();
        mockLocation();
    });

    it("ignores a ?mailboxUid= query param that isn't one of the caller's accessible mailboxes", async () => {
        function Probe() {
            const { mailboxUid } = useCalendarShell();
            return <span>{`mailbox:${mailboxUid}`}</span>;
        }
        const location = mockLocation();
        (location as any).search = "?mailboxUid=not-mine";
        mockPerMailboxFolders([mailboxA, mailboxB]);
        render(
            <CalendarShell userUid="u1">
                <Probe />
            </CalendarShell>,
        );

        expect(await screen.findByText("mailbox:mb-a")).toBeInTheDocument();
        mockLocation();
    });

    it("provides the resolved mailbox/folder/mailboxes to children via useCalendarShell()", async () => {
        function Probe() {
            const { mailboxUid, folderUid, mailboxes } = useCalendarShell();
            return <span>{`${mailboxUid}/${folderUid}/${mailboxes.length}`}</span>;
        }
        mockMailboxesAndFolders([mailboxA], [calendarFolder]);
        render(
            <CalendarShell userUid="u1">
                <Probe />
            </CalendarShell>,
        );

        expect(await screen.findByText("mb-a/f-cal/1")).toBeInTheDocument();
    });

    it("useCalendarShell()'s default (no enclosing CalendarShell) is a harmless no-op, not a crash", async () => {
        function Probe() {
            const { calendarFolders, mailboxes, reloadFolders, colorFor } = useCalendarShell();
            return (
                <>
                    <button type="button" onClick={reloadFolders}>
                        {`${calendarFolders.length}/${mailboxes.length}`}
                    </button>
                    <span data-testid="default-color">{colorFor({ ...calendarFolder, color: undefined })}</span>
                </>
            );
        }
        const user = userEvent.setup();
        render(<Probe />);

        expect(screen.getByText("0/0")).toBeInTheDocument();
        expect(screen.getByTestId("default-color")).toHaveTextContent(DEFAULT_CALENDAR_COLOR);
        await user.click(screen.getByText("0/0"));
        expect(screen.getByText("0/0")).toBeInTheDocument();
    });

    it("ignores folder results that land after the shell unmounted", async () => {
        let resolveFolders: ((value: Response) => void) | undefined;
        const fetchMock = mockFetch((url) => {
            if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailboxA]);
            if (url.startsWith("/api/mail/folders")) {
                return new Promise<Response>((resolve) => {
                    resolveFolders = resolve;
                });
            }
            throw new Error(`unexpected ${url}`);
        });
        const { unmount } = render(<CalendarShell userUid="u1">content</CalendarShell>);
        await waitFor(() => expect(resolveFolders).toBeDefined());

        unmount();
        resolveFolders!(jsonResponse(200, [calendarFolder]));
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(fetchMock.mock.calls.filter(([url]: [string]) => url.startsWith("/api/mail/folders"))).toHaveLength(1);
    });
});
