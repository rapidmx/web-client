// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../testUtils.js";
import MailShell, { MAILBOX_LIST_LIMIT, useMailShell } from "../../../apps/shared/components/mail/layout/MailShell.js";
import { getKeyVault } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import { resetPushClient } from "@rapidmx/react-shared/mail/pushClient.js";
import { getUnlockedKeys } from "@rapidmx/react-shared/crypto/keySession.js";
import { beginPendingSend, finishPendingSend } from "../../../apps/shared/mail/outbox/pendingSends.js";
import { sendState } from "../../../apps/shared/mail/outbox/sendState.js";

// MailShell now wraps its content in KeyEnrollmentGate (see that component), which checks
// getKeyVault() once mailboxUid resolves. Mocked at the module level rather than via the shared
// mockFetch() helper used everywhere else in this file: KeyEnrollmentGate.tsx's dependency on
// @rapidmx/react-shared's crypto/ subpath (added ahead of a real react-shared publish, consumed here
// via a yarn patch) isn't reliably reached by a plain vi.stubGlobal("fetch", ...) the way every other
// @rapidmx/react-shared API call in this suite is - a Vite/Vitest module-resolution quirk specific to
// this not-yet-published subpath, confirmed by direct reproduction. Every test in this file exercises
// MailShell's own behavior, not encryption enrollment, so "already enrolled" is the correct default
// throughout - a mailbox with no keys enrolled yet is KeyEnrollmentGate's own concern, covered by its
// own dedicated test file.
// getEncryptionPolicy()/lookupKeys() are also stubbed here since ComposeWindow.tsx (mounted by clicking
// this shell's own Compose button) calls both unconditionally on mount, regardless of whether a
// mailbox's encryption keys are unlocked - the same real-module-under-jsdom concern as getKeyVault above.
vi.mock("@rapidmx/react-shared/crypto/keyvaultApi.js", () => ({
    getKeyVault: vi.fn().mockResolvedValue({ wrappedKeys: [{ fingerprint: "already-enrolled" }], masterKeyWraps: [] }),
    enrollKey: vi.fn(),
    getEncryptionPolicy: vi.fn().mockResolvedValue({ encryptSameOrg: "optional", encryptFederated: "optional", encryptExternal: "optional" }),
    lookupKeys: vi.fn().mockResolvedValue({ keys: [] }),
    // Pure/no-network, but this file fully replaces the module (see the doc comment above on why
    // importOriginal isn't reliable here) - ComposeWindow.tsx now calls this too, to decide whether to
    // show its "unlock to sign/encrypt" affordance. None of these fixture mailboxes carry real `keys`, so
    // "no active key" (undefined) is the correct default throughout.
    findActivePublicKey: vi.fn().mockReturnValue(undefined),
}));
// Treated as already-unlocked this session (see KeyEnrollmentGate's own getUnlockedKeys() short-circuit)
// so these tests never hit its "Unlock your mailbox" password prompt - that flow is this component's own
// concern, covered by KeyEnrollmentGate.test.tsx.
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({
    MASTER_KEY_AAD_PURPOSE: "master-key",
    ENCRYPTION_PRIVATE_KEY_AAD_PURPOSE: "encrypt-private-key",
    getUnlockedKeys: vi.fn().mockReturnValue({ masterKey: new Uint8Array(32) }),
    unlockWithPassword: vi.fn(),
    // AppShell's sign-out destroys unlocked keys; ComposeWindow re-renders on key lock.
    destroyUnlockedKeys: vi.fn(),
    subscribeKeySession: vi.fn(() => () => undefined),
}));

// The local search index's lifecycle has its own test file; here only the props MailShell hands it matter.
const { lifecycleProps } = vi.hoisted(() => ({ lifecycleProps: [] as { accessibleMailboxUids?: string[] }[] }));
vi.mock("../../../apps/shared/search/LocalIndexLifecycle.js", () => ({
    default: (props: { accessibleMailboxUids?: string[] }) => {
        lifecycleProps.push(props);
        return null;
    },
}));

const AUTH_SERVER_URL = "https://auth.example.com";

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

const inboxFolder = {
    uid: "f-inbox",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb-a",
    name: "Inbox",
    type: "inbox" as const,
    unreadCount: 3,
    totalCount: 10,
};
const draftsFolder = {
    ...inboxFolder,
    uid: "f-drafts",
    name: "Drafts",
    type: "drafts" as const,
    unreadCount: 0,
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

/** Gives each mailbox its own distinct Inbox (uid `f-inbox-<mailboxUid>`, 3 unread), keyed off the
 * `mailboxUid` query param `listFolders()` sends - for tests that need per-mailbox folder trees to differ. */
function mockPerMailboxFolders(mailboxes: { uid: string }[]) {
    return mockFetch((url) => {
        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, mailboxes);
        if (url.startsWith("/api/mail/folders")) {
            const mailbox = mailboxes.find((mb) => url.includes(`mailboxUid=${mb.uid}`));
            return jsonResponse(200, mailbox ? [{ ...inboxFolder, uid: `f-inbox-${mailbox.uid}`, mailboxUid: mailbox.uid }] : []);
        }
        throw new Error(`unexpected ${url}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("MailShell", () => {
    it("hands the local index lifecycle the accessible mailboxes to keep - but only when the list isn't a possibly-truncated full page", async () => {
        lifecycleProps.length = 0;
        mockPerMailboxFolders([mailboxA, mailboxB]);
        const { unmount } = render(<MailShell userUid="u1">content</MailShell>);
        await waitFor(() => expect(lifecycleProps.at(-1)?.accessibleMailboxUids).toEqual(["mb-a", "mb-b"]));
        unmount();

        lifecycleProps.length = 0;
        const fullPage = Array.from({ length: MAILBOX_LIST_LIMIT }, (_, i) => ({ ...mailboxA, uid: `mb-${i}`, displayName: `Mailbox ${i}` }));
        mockPerMailboxFolders(fullPage);
        render(<MailShell userUid="u1">content</MailShell>);
        expect((await screen.findAllByText("Mailbox 99")).length).toBeGreaterThan(0);
        expect(lifecycleProps.every((props) => props.accessibleMailboxUids === undefined)).toBe(true);
    });

    it("redirects to auth-server's sign-in page when there is no userUid", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/";
        render(<MailShell authServerUrl={AUTH_SERVER_URL}>content</MailShell>);
        await waitFor(() =>
            expect(location.href).toBe(`${AUTH_SERVER_URL}/auth/signin?return_to=${encodeURIComponent("https://mail.example.com/")}`),
        );
        expect(screen.queryByText("content")).not.toBeInTheDocument();
    });

    it("shows an error message when loading mailboxes fails", async () => {
        mockFetch(() => jsonResponse(500, { message: "boom" }));
        render(<MailShell userUid="u1">content</MailShell>);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when loading mailboxes fails with a non-API error", async () => {
        mockFetch(() => {
            throw new TypeError("network down");
        });
        render(<MailShell userUid="u1">content</MailShell>);
        expect(await screen.findByText("Could not load your mailboxes.")).toBeInTheDocument();
    });

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
        const { container } = render(<MailShell userUid="u1">content</MailShell>);

        await waitFor(() => expect(resolveMailboxes).toBeDefined());
        expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
        expect(screen.queryByText("content")).not.toBeInTheDocument();

        resolveMailboxes!();
        await screen.findByText("content");
    });

    it("shows a skeleton folder list while folders are still loading for an already-resolved mailbox", async () => {
        let resolveFolders: (() => void) | undefined;
        mockFetch((url) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailboxA]);
            if (url.startsWith("/api/mail/folders")) {
                return new Promise((resolve) => {
                    resolveFolders = () => resolve(jsonResponse(200, [draftsFolder, inboxFolder]));
                });
            }
            throw new Error(`unexpected ${url}`);
        });
        const { container } = render(<MailShell userUid="u1">content</MailShell>);

        await waitFor(() => expect(resolveFolders).toBeDefined());
        await screen.findByText("content");
        expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
        expect(screen.queryByText("Inbox")).not.toBeInTheDocument();

        resolveFolders!();
        await screen.findByText("Inbox");
    });

    it("shows a full-screen no-mailbox page — not the app's own chrome/content at all — when the caller has none", async () => {
        mockMailboxesAndFolders([], []);
        render(<MailShell userUid="u1">content</MailShell>);
        expect(await screen.findByText("No mailbox available")).toBeInTheDocument();
        expect(screen.queryByText("content")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Compose" })).not.toBeInTheDocument();
        expect(screen.queryByRole("navigation", { name: "Apps" })).not.toBeInTheDocument();
    });

    it("passes plugin app rail items through to AppShell", async () => {
        mockMailboxesAndFolders([mailboxA], [inboxFolder]);
        render(
            <MailShell userUid="u1" pluginNav={{ appRail: [{ id: "notes", href: "/notes", label: "Notes" }] }}>
                content
            </MailShell>,
        );

        await screen.findByText("content");
        const rail = within(screen.getByRole("navigation", { name: "Apps" }));
        expect(rail.getByRole("link", { name: "Notes" })).toHaveAttribute("href", "/notes");
        expect(rail.getByRole("link", { name: "Mail" })).toHaveAttribute("aria-current", "page");
    });

    it("renders a single mailbox's folders (well-known order) with no mailbox switcher", async () => {
        mockMailboxesAndFolders([mailboxA], [draftsFolder, inboxFolder]);
        render(<MailShell userUid="u1">content</MailShell>);

        await screen.findByText("Inbox");
        expect(screen.queryByLabelText("Mailbox")).not.toBeInTheDocument();
        expect(screen.getByText("3")).toBeInTheDocument(); // Inbox unread badge
        expect(screen.getByRole("button", { name: "Compose" })).toBeInTheDocument();

        const folderLinks = screen.getAllByRole("link").filter((el) => el.getAttribute("href")?.includes("folderUid="));
        expect(folderLinks.map((el) => el.getAttribute("href"))).toEqual([
            "/?mailboxUid=mb-a&folderUid=f-inbox",
            "/?mailboxUid=mb-a&folderUid=f-drafts",
        ]);
    });

    it("renders a well-known Archive folder (type: archive) with its label, sorted after Deleted Items and Junk, the last of the well-known folders", async () => {
        const junkFolder = { ...inboxFolder, uid: "f-junk", name: "Junk Email", type: "junk" as const, unreadCount: 0 };
        const archiveWellKnownFolder = { ...inboxFolder, uid: "f-archive-wk", name: "Archive", type: "archive" as const, unreadCount: 0 };
        const deletedFolder = { ...inboxFolder, uid: "f-deleted", name: "Deleted Items", type: "deleted_items" as const, unreadCount: 0 };
        mockMailboxesAndFolders([mailboxA], [deletedFolder, archiveWellKnownFolder, junkFolder, inboxFolder]);
        render(<MailShell userUid="u1">content</MailShell>);

        await screen.findByText("Inbox");
        expect(screen.getByText("Archive")).toBeInTheDocument();

        const folderLinks = screen.getAllByRole("link").filter((el) => el.getAttribute("href")?.includes("folderUid="));
        expect(folderLinks.map((el) => el.getAttribute("href"))).toEqual([
            "/?mailboxUid=mb-a&folderUid=f-inbox",
            "/?mailboxUid=mb-a&folderUid=f-deleted",
            "/?mailboxUid=mb-a&folderUid=f-junk",
            "/?mailboxUid=mb-a&folderUid=f-archive-wk",
        ]);
    });

    it("clicking Compose opens the floating Compose window for the resolved mailbox, without navigating away", async () => {
        const draft = {
            uid: "m1",
            version: 0,
            dateCreated: "2026-01-01T00:00:00.000Z",
            dateModified: "2026-01-01T00:00:00.000Z",
            folderUid: "f-drafts",
            mailboxUid: "mb-a",
            messageId: "abc@webmail",
            subject: "",
            from: { address: "a@example.com", type: "to" as const },
            recipients: [],
            sentDate: "2026-01-01T00:00:00.000Z",
            receivedDate: "2026-01-01T00:00:00.000Z",
            bodyPreview: "",
            flags: { read: true, flagged: false, answered: false, forwarded: false },
            importance: "normal" as const,
            hasAttachments: false,
        };
        const fetchMock = mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
            if (url === "/api/mail/mailboxes/mb-a") return jsonResponse(200, mailboxA);
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailboxA]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [draftsFolder, inboxFolder]);
            if (url === "/api/mail/messages" && (init?.method ?? "GET") === "POST") return jsonResponse(200, draft);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<MailShell userUid="u1">content</MailShell>);
        await screen.findByRole("button", { name: "Compose" });

        await user.click(screen.getByRole("button", { name: "Compose" }));

        expect(await screen.findByRole("dialog", { name: "New Message" })).toBeInTheDocument();
        expect(screen.getByText("content")).toBeInTheDocument();
        // `ComposeWindow` resolves its own Drafts folder from the mailboxUid it was opened with.
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages", expect.objectContaining({ method: "POST" })),
        );
    });

    it("defaults to the mailbox's Inbox folder and highlights it", async () => {
        mockMailboxesAndFolders([mailboxA], [draftsFolder, inboxFolder]);
        render(<MailShell userUid="u1">content</MailShell>);

        const inboxLink = await screen.findByRole("link", { name: /Inbox/ });
        expect(inboxLink.className).toContain("bg-primary/10");
        // Drafts shows how many messages it holds (10), not an unread count.
        const draftsLink = screen.getByRole("link", { name: /^Drafts/ });
        expect(draftsLink.className).not.toContain("bg-primary/10");
    });

    it("renders every accessible mailbox's own folder tree at once, marking a shared one, with no mailbox switcher", async () => {
        mockPerMailboxFolders([mailboxA, mailboxB]);
        render(<MailShell userUid="u1">content</MailShell>);

        // "All Mailboxes" only renders once every mailbox's folders have loaded.
        await screen.findByText("All Mailboxes");
        expect(screen.getByText("Mailbox A")).toBeInTheDocument();
        expect(screen.getByText("Mailbox B (shared)")).toBeInTheDocument();
        expect(screen.queryByLabelText("Mailbox")).not.toBeInTheDocument();
        const folderLinks = screen.getAllByRole("link").filter((el) => el.getAttribute("href")?.includes("folderUid="));
        expect(folderLinks.map((el) => el.getAttribute("href"))).toEqual([
            "/?mailboxUid=mb-a&folderUid=f-inbox-mb-a",
            "/?mailboxUid=mb-b&folderUid=f-inbox-mb-b",
        ]);
    });

    it("shows an All Mailboxes aggregate section, summing unread counts across mailboxes, only when there's more than one mailbox", async () => {
        mockPerMailboxFolders([mailboxA, mailboxB]);
        render(<MailShell userUid="u1">content</MailShell>);

        await screen.findByText("All Mailboxes");
        const aggregateInbox = screen.getAllByRole("link").find((el) => el.getAttribute("href") === "/?aggregate=inbox")!;
        // 3 unread in each mailbox's own Inbox.
        expect(aggregateInbox.textContent).toBe("Inbox6 6 unread");
        expect(screen.getAllByRole("link").some((el) => el.getAttribute("href") === "/?aggregate=junk")).toBe(true);
        expect(screen.getAllByRole("link").some((el) => el.getAttribute("href") === "/?aggregate=outbox")).toBe(false);
    });

    it("omits the All Mailboxes section for a single-mailbox user", async () => {
        mockMailboxesAndFolders([mailboxA], [inboxFolder]);
        render(<MailShell userUid="u1">content</MailShell>);

        await screen.findByText("content");
        expect(screen.queryByText("All Mailboxes")).not.toBeInTheDocument();
    });

    it("shows one mailbox's folder-load failure inline in its own section without blanking the others", async () => {
        mockFetch((url) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailboxA, mailboxB]);
            if (url.startsWith("/api/mail/folders") && url.includes("mb-b")) return jsonResponse(500, { message: "b boom" });
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
            throw new Error(`unexpected ${url}`);
        });
        render(<MailShell userUid="u1">content</MailShell>);

        expect(await screen.findByText("b boom")).toBeInTheDocument();
        expect(screen.getAllByRole("link").some((el) => el.getAttribute("href") === "/?mailboxUid=mb-a&folderUid=f-inbox")).toBe(true);
    });

    it("resolves ?aggregate= to an aggregate pseudo-folder, with no single mailbox/folder, and highlights it", async () => {
        const location = mockLocation();
        (location as any).search = "?aggregate=inbox";
        function Probe() {
            const { mailboxUid, folderUid, aggregateFolderType } = useMailShell();
            return <span>{`${mailboxUid}/${folderUid}/${aggregateFolderType}`}</span>;
        }
        mockPerMailboxFolders([mailboxA, mailboxB]);
        render(
            <MailShell userUid="u1">
                <Probe />
            </MailShell>,
        );

        expect(await screen.findByText("undefined/undefined/inbox")).toBeInTheDocument();
        await screen.findByText("All Mailboxes");
        const aggregateInbox = screen.getAllByRole("link").find((el) => el.getAttribute("href") === "/?aggregate=inbox")!;
        expect(aggregateInbox.className).toContain("bg-primary/10");
    });

    it("ignores an unrecognized ?aggregate= value, falling back to the normal Inbox selection", async () => {
        const location = mockLocation();
        (location as any).search = "?aggregate=outbox";
        mockMailboxesAndFolders([mailboxA], [draftsFolder, inboxFolder]);
        render(<MailShell userUid="u1">content</MailShell>);

        const inboxLink = await screen.findByRole("link", { name: /Inbox/ });
        expect(inboxLink.className).toContain("bg-primary/10");
    });

    it("has no sidebar sender picker - the sender is chosen in the compose window's own From field", async () => {
        mockPerMailboxFolders([mailboxB, mailboxA]);
        render(<MailShell userUid="u1">content</MailShell>);

        await screen.findByText("All Mailboxes");
        expect(screen.queryByLabelText("Compose from")).not.toBeInTheDocument();
    });

    it("shows an error message when loading folders fails", async () => {
        mockFetch((url) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailboxA]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(500, { message: "folder boom" });
            throw new Error(`unexpected ${url}`);
        });
        render(<MailShell userUid="u1">content</MailShell>);
        expect(await screen.findByText("folder boom")).toBeInTheDocument();
    });

    it("shows a generic error message when loading folders fails with a non-API error", async () => {
        mockFetch((url) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailboxA]);
            throw new TypeError("network down");
        });
        render(<MailShell userUid="u1">content</MailShell>);
        expect(await screen.findByText("Could not load folders.")).toBeInTheDocument();
    });

    it("signs out to auth-server", async () => {
        mockMailboxesAndFolders([mailboxA], [inboxFolder]);
        const location = mockLocation();
        const user = userEvent.setup();
        render(
            <MailShell userUid="u1" authServerUrl={AUTH_SERVER_URL}>
                content
            </MailShell>,
        );

        await screen.findByText("content");
        await user.click(screen.getByRole("button", { name: "Account menu" }));
        await user.click(screen.getByRole("menuitem", { name: "Sign Out" }));
        await waitFor(() => expect(location.href).toBe(AUTH_SERVER_URL));
    });

    it("signs out to '/' when authServerUrl is not configured", async () => {
        mockMailboxesAndFolders([mailboxA], [inboxFolder]);
        const location = mockLocation();
        const user = userEvent.setup();
        render(<MailShell userUid="u1">content</MailShell>);

        await screen.findByText("content");
        await user.click(screen.getByRole("button", { name: "Account menu" }));
        await user.click(screen.getByRole("menuitem", { name: "Sign Out" }));
        await waitFor(() => expect(location.href).toBe("/"));
    });

    it("sorts folders not in the well-known order alphabetically by name, after well-known folders", async () => {
        const projectsFolder = { ...inboxFolder, uid: "f-projects", name: "Projects", type: "user" as const, unreadCount: 0 };
        const archiveFolder = { ...inboxFolder, uid: "f-archive", name: "Archive", type: "user" as const, unreadCount: 0 };
        mockMailboxesAndFolders([mailboxA], [projectsFolder, inboxFolder, archiveFolder]);
        render(<MailShell userUid="u1">content</MailShell>);

        await screen.findByText("Inbox");
        const folderLinks = screen.getAllByRole("link").filter((el) => el.getAttribute("href")?.includes("folderUid="));
        expect(folderLinks.map((el) => el.textContent)).toEqual(["Inbox3 3 unread", "Archive", "Projects"]);
    });

    it("excludes calendar/contacts/tasks folders from the folder tree — those back their own dedicated apps, not Mail", async () => {
        const calendarFolder = { ...inboxFolder, uid: "f-cal", name: "Calendar", type: "calendar" as const, unreadCount: 0 };
        const contactsFolder = { ...inboxFolder, uid: "f-con", name: "Contacts", type: "contacts" as const, unreadCount: 0 };
        const tasksFolder = { ...inboxFolder, uid: "f-tsk", name: "Tasks", type: "tasks" as const, unreadCount: 0 };
        mockMailboxesAndFolders([mailboxA], [inboxFolder, calendarFolder, contactsFolder, tasksFolder]);
        render(<MailShell userUid="u1">content</MailShell>);

        await screen.findByText("Inbox");
        const folderLinks = screen.getAllByRole("link").filter((el) => el.getAttribute("href")?.includes("folderUid="));
        expect(folderLinks.map((el) => el.textContent)).toEqual(["Inbox3 3 unread"]);
    });

    it("honors a ?mailboxUid= query param that names an accessible mailbox, highlighting that mailbox's Inbox", async () => {
        const location = mockLocation();
        (location as any).search = "?mailboxUid=mb-b";
        mockPerMailboxFolders([mailboxA, mailboxB]);
        render(<MailShell userUid="u1">content</MailShell>);

        await screen.findByText("All Mailboxes");
        const linkFor = (href: string) => screen.getAllByRole("link").find((el) => el.getAttribute("href") === href)!;
        expect(linkFor("/?mailboxUid=mb-b&folderUid=f-inbox-mb-b").className).toContain("bg-primary/10");
        expect(linkFor("/?mailboxUid=mb-a&folderUid=f-inbox-mb-a").className).not.toContain("bg-primary/10");
    });

    it("ignores a ?mailboxUid= query param that isn't one of the caller's accessible mailboxes", async () => {
        const location = mockLocation();
        (location as any).search = "?mailboxUid=not-mine";
        mockPerMailboxFolders([mailboxA, mailboxB]);
        render(<MailShell userUid="u1">content</MailShell>);

        await screen.findByText("All Mailboxes");
        const linkFor = (href: string) => screen.getAllByRole("link").find((el) => el.getAttribute("href") === href)!;
        expect(linkFor("/?mailboxUid=mb-a&folderUid=f-inbox-mb-a").className).toContain("bg-primary/10");
    });

    it("honors a ?folderUid= query param that names one of the mailbox's folders", async () => {
        const location = mockLocation();
        (location as any).search = "?folderUid=f-drafts";
        mockMailboxesAndFolders([mailboxA], [draftsFolder, inboxFolder]);
        render(<MailShell userUid="u1">content</MailShell>);

        const draftsLink = await screen.findByRole("link", { name: /^Drafts/ });
        expect(draftsLink.className).toContain("bg-primary/10");
    });

    it("ignores a ?folderUid= query param that isn't one of the mailbox's folders", async () => {
        const location = mockLocation();
        (location as any).search = "?folderUid=not-a-folder";
        mockMailboxesAndFolders([mailboxA], [draftsFolder, inboxFolder]);
        render(<MailShell userUid="u1">content</MailShell>);

        const inboxLink = await screen.findByRole("link", { name: /Inbox/ });
        expect(inboxLink.className).toContain("bg-primary/10");
    });

    it("does not show the impersonation banner when impersonating is not set", async () => {
        mockMailboxesAndFolders([mailboxA], [inboxFolder]);
        render(<MailShell userUid="u1">content</MailShell>);
        await screen.findByText("content");
        expect(screen.queryByText(/You are viewing as/)).not.toBeInTheDocument();
    });

    it("shows the impersonation banner and returns to admin when 'Return to admin' is clicked", async () => {
        mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailboxA]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
            if (url === "https://auth.example.com/api/admin/impersonate/stop" && init?.method === "POST") {
                return jsonResponse(200, { restored: true });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const location = mockLocation();
        const user = userEvent.setup();
        render(
            <MailShell userUid="u1" authServerUrl={AUTH_SERVER_URL} impersonationBaseUrl={AUTH_SERVER_URL} impersonating>
                content
            </MailShell>,
        );

        expect(await screen.findByText(/You are viewing as/)).toBeInTheDocument();
        expect(screen.getByText("u1", { selector: "strong" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Return to admin" }));

        expect(await screen.findByRole("button", { name: "Returning to admin…" })).toBeInTheDocument();
        await waitFor(() => expect(location.href).toBe("/admin"));
    });

    it("still returns to admin even when the stop-impersonating request fails", async () => {
        mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailboxA]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
            if (url === "https://auth.example.com/api/admin/impersonate/stop" && init?.method === "POST") {
                return jsonResponse(500, { message: "boom" });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const location = mockLocation();
        const user = userEvent.setup();
        render(
            <MailShell userUid="u1" authServerUrl={AUTH_SERVER_URL} impersonationBaseUrl={AUTH_SERVER_URL} impersonating>
                content
            </MailShell>,
        );

        await user.click(await screen.findByRole("button", { name: "Return to admin" }));
        await waitFor(() => expect(location.href).toBe("/admin"));
    });

    it("calls this app's own local dev-only stop endpoint when impersonationBaseUrl isn't provided (yarn dev)", async () => {
        mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailboxA]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
            if (url === "/api/admin/impersonate/stop" && init?.method === "POST") {
                return jsonResponse(200, { restored: true });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const location = mockLocation();
        const user = userEvent.setup();
        render(
            <MailShell userUid="u1" impersonating>
                content
            </MailShell>,
        );

        await user.click(await screen.findByRole("button", { name: "Return to admin" }));
        await waitFor(() => expect(location.href).toBe("/admin"));
    });

    it("never offers first-time key setup while impersonating, even for the impersonated user's own mailbox", async () => {
        vi.mocked(getUnlockedKeys).mockReturnValue(undefined);
        vi.mocked(getKeyVault).mockResolvedValue({ wrappedKeys: [], masterKeyWraps: [] });
        try {
            mockMailboxesAndFolders([mailboxA], [inboxFolder]);
            const { unmount } = render(
                <MailShell userUid="u1" impersonating>
                    content
                </MailShell>,
            );
            await waitFor(() => expect(getKeyVault).toHaveBeenCalledWith("mb-a"));
            expect(await screen.findByText("content")).toBeInTheDocument();
            expect(screen.queryByText("Protect your mailbox")).not.toBeInTheDocument();
            unmount();

            render(<MailShell userUid="u1">content</MailShell>);
            expect(await screen.findByText("Protect your mailbox")).toBeInTheDocument();
        } finally {
            vi.mocked(getUnlockedKeys).mockReturnValue({ masterKey: new Uint8Array(32) });
            vi.mocked(getKeyVault).mockResolvedValue({ wrappedKeys: [{ fingerprint: "already-enrolled" }], masterKeyWraps: [] } as never);
        }
    });

    it("opens the folder drawer via the mobile hamburger button, and closes it via the drawer's own close button", async () => {
        mockMailboxesAndFolders([mailboxA], [draftsFolder, inboxFolder]);
        const user = userEvent.setup();
        render(<MailShell userUid="u1">content</MailShell>);
        await screen.findByText("content");

        expect(screen.queryByRole("dialog", { name: "Folders" })).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Open folders" }));
        const drawer = screen.getByRole("dialog", { name: "Folders" });
        expect(drawer).toBeInTheDocument();
        // The drawer holds its own copy of the folder tree (for mobile) — confirm it rendered, not just the dialog chrome.
        expect(within(drawer).getByRole("link", { name: /Inbox/ })).toBeInTheDocument();

        await user.click(within(drawer).getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("dialog", { name: "Folders" })).not.toBeInTheDocument();
    });

    it("provides the resolved mailbox/folder/lists to children via useMailShell()", async () => {
        function Probe() {
            const { mailboxUid, folderUid, mailboxes, mailboxFolders } = useMailShell();
            return (
                <span>{`${mailboxUid}/${folderUid}/${mailboxes.length}/${mailboxFolders[0]?.folders.length}`}</span>
            );
        }
        mockMailboxesAndFolders([mailboxA], [draftsFolder, inboxFolder]);
        render(
            <MailShell userUid="u1">
                <Probe />
            </MailShell>,
        );

        expect(await screen.findByText("mb-a/f-inbox/1/2")).toBeInTheDocument();
    });

    describe("onFolderCreated()", () => {
        /** Renders a button that files `folder` into the shell's own tree, plus the folder names it holds. */
        function FolderProbe({ folder }: { folder: Record<string, unknown> }) {
            const { mailboxFolders, onFolderCreated } = useMailShell();
            return (
                <>
                    <button type="button" onClick={() => onFolderCreated(folder as never)}>
                        create
                    </button>
                    <span>{`folders:${mailboxFolders.map((mf) => mf.folders.map((f) => f.name).join(",")).join("|")}`}</span>
                </>
            );
        }

        it("adds a folder to its own mailbox's tree, so the sidebar has it with no reload", async () => {
            const user = userEvent.setup();
            mockMailboxesAndFolders([mailboxA], [inboxFolder]);
            render(
                <MailShell userUid="u1">
                    <FolderProbe folder={{ uid: "f-new", mailboxUid: "mb-a", name: "Receipts", type: "user" }} />
                </MailShell>,
            );
            await screen.findByText("folders:Inbox");

            await user.click(screen.getByRole("button", { name: "create" }));

            expect(screen.getByText("folders:Inbox,Receipts")).toBeInTheDocument();
            expect(await screen.findByRole("link", { name: /Receipts/ })).toBeInTheDocument();
        });

        it("ignores a folder type this sidebar never lists", async () => {
            const user = userEvent.setup();
            mockMailboxesAndFolders([mailboxA], [inboxFolder]);
            render(
                <MailShell userUid="u1">
                    <FolderProbe folder={{ uid: "f-cal", mailboxUid: "mb-a", name: "Team calendar", type: "calendar" }} />
                </MailShell>,
            );
            await screen.findByText("folders:Inbox");

            await user.click(screen.getByRole("button", { name: "create" }));

            expect(screen.getByText("folders:Inbox")).toBeInTheDocument();
        });

        it("does nothing outside a shell, where there is no tree to file it into", async () => {
            const user = userEvent.setup();
            render(<FolderProbe folder={{ uid: "f-new", mailboxUid: "mb-a", name: "Receipts", type: "user" }} />);

            await user.click(screen.getByRole("button", { name: "create" }));

            expect(screen.getByText("folders:")).toBeInTheDocument();
        });
    });

    describe("live updates", () => {
        /** A stand-in for the push WebSocket, driven by hand. */
        class FakePushSocket {
            static instances: FakePushSocket[] = [];
            readyState = 1;
            onopen: unknown = null;
            onmessage: ((e: { data: unknown }) => void) | null = null;
            onclose: unknown = null;
            onerror: unknown = null;
            constructor(public url: string) {
                FakePushSocket.instances.push(this);
            }
            send() {
                // Nothing is ever delivered.
            }
            close() {
                // Nothing to close.
            }
            receive(frame: unknown) {
                this.onmessage?.({ data: JSON.stringify(frame) });
            }
        }

        function LiveProbe() {
            const { live } = useMailShell();
            return <span data-testid="live">{`tick:${live.tick} folders:${live.folderUids ? [...live.folderUids].join(",") : "any"}`}</span>;
        }

        /** Folder lists whose unread counts a test can change between refreshes. */
        function mockLiveFolders(mailboxes: { uid: string }[], unread: { current: Record<string, number> }) {
            return mockFetch((url) => {
                if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, mailboxes);
                if (url.startsWith("/api/mail/folders")) {
                    const mailbox = mailboxes.find((mb) => url.includes(`mailboxUid=${mb.uid}`))!;
                    const uid = `f-inbox-${mailbox.uid}`;
                    return jsonResponse(200, [{ ...inboxFolder, uid, mailboxUid: mailbox.uid, unreadCount: unread.current[uid] ?? 3 }]);
                }
                throw new Error(`unexpected ${url}`);
            });
        }

        // Earlier tests in this file replace window.location (mockLocation) and never put it back; the push URL is built
        // from its origin.
        beforeEach(() => {
            Object.defineProperty(window, "location", { configurable: true, writable: true, value: new URL("http://localhost:3000/") });
        });

        afterEach(() => {
            FakePushSocket.instances = [];
            resetPushClient();
        });

        it("updates a folder's unread badge, and the All Mailboxes total, when a push event says mail arrived - without a reload", async () => {
            vi.stubGlobal("WebSocket", FakePushSocket);
            const unread = { current: {} as Record<string, number> };
            mockLiveFolders([mailboxA, mailboxB], unread);
            render(
                <MailShell userUid="u1">
                    <LiveProbe />
                </MailShell>,
            );
            await screen.findAllByText("Mailbox A");
            // 3 unread in each inbox; All Mailboxes sums them.
            expect((await screen.findAllByText("6")).length).toBeGreaterThan(0);
            expect(screen.getByTestId("live")).toHaveTextContent("tick:0");

            unread.current = { "f-inbox-mb-a": 4, "f-inbox-mb-b": 3 };
            const socket = FakePushSocket.instances[0];
            socket.receive({ id: 0, type: "SUBSCRIBED", data: ["u1"] });
            act(() => socket.receive({ type: "MessageMongo", action: "create", data: { uid: "m9", folderUid: "f-inbox-mb-a" } }));

            await waitFor(() => expect(screen.getByTestId("live")).toHaveTextContent("tick:1 folders:f-inbox-mb-a"), { timeout: 3000 });
            await waitFor(() => expect(screen.getAllByText("7").length).toBeGreaterThan(0), { timeout: 3000 });
            expect(screen.getAllByText("4").length).toBeGreaterThan(0);
        });

        it("shows a folder another client just created, once", async () => {
            vi.stubGlobal("WebSocket", FakePushSocket);
            mockLiveFolders([mailboxA], { current: {} });
            render(<MailShell userUid="u1">content</MailShell>);
            await screen.findAllByText("Inbox");
            const socket = FakePushSocket.instances[0];
            socket.receive({ id: 0, type: "SUBSCRIBED", data: ["u1"] });

            const created = { ...inboxFolder, uid: "f-receipts", mailboxUid: "mb-a", name: "Receipts", type: "user" as const, unreadCount: 0 };
            act(() => {
                socket.receive({ type: "FolderMongo", action: "create", data: created });
                socket.receive({ type: "FolderMongo", action: "create", data: created });
            });
            // Once per sidebar rendering - the same number as the Inbox, not doubled by the second event.
            const receipts = await screen.findAllByText("Receipts");
            expect(receipts).toHaveLength(screen.getAllByText("Inbox").length);
        });

        it("keeps working, on the safety-net poll alone, when the push socket can't be opened", async () => {
            vi.stubGlobal(
                "WebSocket",
                class {
                    constructor() {
                        throw new Error("blocked");
                    }
                },
            );
            mockLiveFolders([mailboxA], { current: {} });
            render(
                <MailShell userUid="u1">
                    <LiveProbe />
                </MailShell>,
            );
            expect((await screen.findAllByText("Inbox")).length).toBeGreaterThan(0);
            expect(screen.getByTestId("live")).toHaveTextContent("tick:0");
        });

        describe("folder badges", () => {
            const folderOf = (type: string, uid: string, unreadCount: number, totalCount: number, name = type) =>
                ({ ...inboxFolder, uid, type, name, unreadCount, totalCount }) as any;

            it("shows unread for the Inbox, Archive and other folders, messages for Drafts and Outbox, and nothing for Sent, Deleted and Junk", async () => {
                mockMailboxesAndFolders(
                    [mailboxA],
                    [
                        folderOf("inbox", "f1", 3, 10, "Inbox"),
                        folderOf("drafts", "f2", 5, 4, "Drafts"),
                        folderOf("outbox", "f3", 0, 1, "Outbox"),
                        folderOf("sent_items", "f4", 6, 20, "Sent Items"),
                        folderOf("junk", "f5", 7, 7, "Junk Email"),
                        folderOf("archive", "f6", 2, 9, "Archive"),
                        folderOf("deleted_items", "f7", 8, 8, "Deleted Items"),
                        folderOf("user", "f8", 0, 5, "Projects"),
                    ],
                );
                render(<MailShell userUid="u1">content</MailShell>);
                await screen.findByText("Inbox");
                const texts = screen
                    .getAllByRole("link")
                    .filter((el) => el.getAttribute("href")?.includes("folderUid="))
                    .map((el) => el.textContent);
                expect(texts).toEqual([
                    "Inbox3 3 unread",
                    "Drafts4 4 messages",
                    "Outbox1 1 message",
                    "Sent Items",
                    "Deleted Items",
                    "Junk Email",
                    "Archive2 2 unread",
                    "Projects",
                ]);
            });

            it("puts an unread folder's name in bold, and a folder with nothing to show in normal weight", async () => {
                mockMailboxesAndFolders([mailboxA], [folderOf("inbox", "f1", 3, 10, "Inbox"), folderOf("user", "f2", 0, 5, "Projects")]);
                render(<MailShell userUid="u1">content</MailShell>);
                expect((await screen.findByText("Inbox")).className).toContain("font-semibold");
                expect(screen.getByText("Projects").className).not.toContain("font-semibold");
            });

            it("applies the same rules to the All Mailboxes entries", async () => {
                mockPerMailboxFolders([mailboxA, mailboxB]);
                render(<MailShell userUid="u1">content</MailShell>);
                await screen.findByText("All Mailboxes");
                const aggregate = (type: string) => screen.getAllByRole("link").find((el) => el.getAttribute("href") === `/?aggregate=${type}`)!;
                expect(aggregate("inbox").textContent).toBe("Inbox6 6 unread");
                // Junk has no badge whatever its unread count.
                expect(aggregate("junk").textContent).toBe("Junk Email");
            });

            describe("the Outbox indicator", () => {
                const outboxLink = () => screen.getAllByRole("link").find((el) => el.getAttribute("href")?.includes("folderUid=fo"))!;

                function mockWithOutbox(outboxMessages: unknown[], outboxTotal = 2) {
                    return mockFetch((url) => {
                        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
                        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailboxA]);
                        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [folderOf("inbox", "f1", 0, 1, "Inbox"), folderOf("outbox", "fo", 0, outboxTotal, "Outbox")]);
                        if (url.startsWith("/api/mail/messages")) return jsonResponse(200, outboxMessages);
                        throw new Error(`unexpected ${url}`);
                    });
                }

                it("is a red pill when a message failed and is waiting, saying so to a screen reader", async () => {
                    mockWithOutbox([{ uid: "m1", scheduledSendError: "Refused" }, { uid: "m2" }]);
                    render(<MailShell userUid="u1">content</MailShell>);
                    await screen.findByText("Outbox");
                    await waitFor(() => expect(within(outboxLink()).getByTestId("outbox-badge")).toHaveAttribute("data-state", "failed"));
                    expect(outboxLink().textContent).toBe("Outbox2 2 messages, 1 failed");
                });

                it("animates while messages are on their way, from the server's view or from a message this tab is still handing over", async () => {
                    mockWithOutbox([{ uid: "m1" }], 1);
                    render(<MailShell userUid="u1">content</MailShell>);
                    await screen.findByText("Outbox");
                    await waitFor(() => expect(within(outboxLink()).getByTestId("outbox-badge")).toHaveAttribute("data-state", "sending"));
                    expect(outboxLink().textContent).toBe("Outbox1 1 message sending");
                });

                it("counts a scheduled message plainly", async () => {
                    mockWithOutbox([{ uid: "m1", scheduledSendTime: "2999-01-01T00:00:00.000Z" }], 1);
                    render(<MailShell userUid="u1">content</MailShell>);
                    await screen.findByText("Outbox");
                    await waitFor(() => expect(outboxLink().textContent).toBe("Outbox1 1 message scheduled"));
                    expect(within(outboxLink()).getByTestId("outbox-badge")).toHaveAttribute("data-state", "idle");
                });

                it("shows the Outbox already - with the message being sent - before the server has created it, and hands over to the real folder", async () => {
                    mockMailboxesAndFolders([mailboxA], [folderOf("inbox", "f1", 0, 1, "Inbox")]);
                    render(<MailShell userUid="u1">content</MailShell>);
                    await screen.findByText("Inbox");
                    expect(screen.queryByText("Outbox")).not.toBeInTheDocument();
                    act(() => {
                        beginPendingSend({ draftUid: "d1", mailboxUid: "mb-a", subject: "S", recipients: ["a@example.com"], scheduled: false });
                    });
                    const row = screen.getByText("Outbox").parentElement!;
                    expect(row.tagName).toBe("DIV");
                    expect(row.textContent).toBe("Outbox1 1 message sending");
                    expect(within(row).getByTestId("outbox-badge")).toHaveAttribute("data-state", "sending");
                    act(() => finishPendingSend("d1"));
                    expect(screen.queryByText("Outbox")).not.toBeInTheDocument();
                });

                it("shows the Outbox and Sent Items - in their places, without a link - the moment a message is on its way in a brand-new account, and hands over to the real folders without a duplicate row", async () => {
                    let folders: unknown[] = [folderOf("inbox", "f1", 0, 1, "Inbox"), folderOf("drafts", "f2", 0, 0, "Drafts"), folderOf("deleted_items", "f9", 0, 0, "Deleted Items")];
                    mockFetch((url) => {
                        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
                        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailboxA]);
                        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, folders);
                        throw new Error(`unexpected ${url}`);
                    });
                    render(<MailShell userUid="u1">content</MailShell>);
                    await screen.findByText("Inbox");
                    const rows = () =>
                        Array.from(document.body.querySelectorAll("a[href*='folderUid='], [data-folder-placeholder]")).map((el) =>
                            el.hasAttribute("data-folder-placeholder") ? `~${el.textContent?.replace(/[0-9].*/, "")}` : el.textContent?.replace(/[0-9].*/, ""),
                        );
                    expect(rows()).toEqual(["Inbox", "Drafts", "Deleted Items"]);

                    act(() => {
                        beginPendingSend({ draftUid: "d1", mailboxUid: "mb-a", subject: "S", recipients: ["a@example.com"], scheduled: false });
                    });
                    expect(rows()).toEqual(["Inbox", "Drafts", "~Outbox", "~Sent Items", "Deleted Items"]);
                    expect(screen.getAllByText("Outbox")).toHaveLength(1);

                    // The server accepted it, made the folders (all of them, at once) and said so.
                    folders = [...folders, folderOf("outbox", "f3", 0, 1, "Outbox"), folderOf("sent_items", "f4", 0, 0, "Sent Items"), folderOf("junk", "f5", 0, 0, "Junk Email"), folderOf("archive", "f6", 0, 0, "Archive")];
                    await act(async () => {
                        sendState.queuedListener!("mb-a");
                    });
                    await waitFor(() => expect(rows()).toEqual(["Inbox", "Drafts", "Outbox", "Sent Items", "Deleted Items", "Junk Email", "Archive"]));
                    expect(screen.getAllByText("Outbox")).toHaveLength(1);
                    expect(screen.getAllByText("Sent Items")).toHaveLength(1);
                    expect(document.querySelector("[data-folder-placeholder]")).toBeNull();
                    act(() => finishPendingSend("d1"));
                    expect(rows()).toEqual(["Inbox", "Drafts", "Outbox", "Sent Items", "Deleted Items", "Junk Email", "Archive"]);
                });

                it("says a message this tab is still handing over is sending, next to the folder's own count", async () => {
                    mockWithOutbox([], 1);
                    render(<MailShell userUid="u1">content</MailShell>);
                    await screen.findByText("Outbox");
                    await waitFor(() => expect(outboxLink().textContent).toBe("Outbox1 1 message"));
                    act(() => {
                        beginPendingSend({ draftUid: "d1", mailboxUid: "mb-a", subject: "S", recipients: ["a@example.com"], scheduled: false });
                    });
                    expect(outboxLink().textContent).toBe("Outbox1 1 message sending");
                    act(() => finishPendingSend("d1"));
                });
            });
        });

        describe("counts that follow what the user does", () => {
            /** Buttons that change a message the way a reading pane does: unread to read, in the Inbox. */
            function ChangeProbe() {
                const { trackMessageChange } = useMailShell();
                const unreadMessage = { uid: "m1", folderUid: "f-inbox-mb-a", mailboxUid: "mb-a", flags: { read: false } } as any;
                const readMessage = { ...unreadMessage, flags: { read: true } };
                const trackers = React.useRef<ReturnType<typeof trackMessageChange>[]>([]);
                return (
                    <>
                        <button onClick={() => trackers.current.push(trackMessageChange(unreadMessage, readMessage))}>read it</button>
                        <button onClick={() => trackers.current.pop()?.settle()}>server accepted</button>
                        <button onClick={() => trackers.current.pop()?.revert()}>server refused</button>
                    </>
                );
            }

            const inboxBadge = () =>
                screen.getAllByRole("link").find((el) => el.getAttribute("href")?.includes("folderUid=f-inbox-mb-a"))!.textContent;

            it("drops the badge the moment a message is read, and lets the server's count settle it afterwards", async () => {
                vi.stubGlobal("WebSocket", FakePushSocket);
                const unread = { current: { "f-inbox-mb-a": 3 } as Record<string, number> };
                mockLiveFolders([mailboxA], unread);
                const user = userEvent.setup();
                render(
                    <MailShell userUid="u1">
                        <ChangeProbe />
                    </MailShell>,
                );
                await screen.findAllByText("Inbox");
                expect(inboxBadge()).toBe("Inbox3 3 unread");

                await user.click(screen.getByRole("button", { name: "read it" }));
                expect(inboxBadge()).toBe("Inbox2 2 unread");

                // The server agrees - the badge stays.
                unread.current = { "f-inbox-mb-a": 2 };
                await user.click(screen.getByRole("button", { name: "server accepted" }));
                await new Promise((resolve) => setTimeout(resolve, 900));
                expect(inboxBadge()).toBe("Inbox2 2 unread");
            });

            it("puts the badge back when the server refuses the change", async () => {
                vi.stubGlobal("WebSocket", FakePushSocket);
                mockLiveFolders([mailboxA], { current: { "f-inbox-mb-a": 3 } });
                const user = userEvent.setup();
                render(
                    <MailShell userUid="u1">
                        <ChangeProbe />
                    </MailShell>,
                );
                await screen.findAllByText("Inbox");
                await user.click(screen.getByRole("button", { name: "read it" }));
                expect(inboxBadge()).toBe("Inbox2 2 unread");
                await user.click(screen.getByRole("button", { name: "server refused" }));
                expect(inboxBadge()).toBe("Inbox3 3 unread");
            });

            it("shows the server's count over its own when they differ - it can't drift", async () => {
                vi.stubGlobal("WebSocket", FakePushSocket);
                // The server counts 5 whatever this page thinks.
                mockLiveFolders([mailboxA], { current: { "f-inbox-mb-a": 5 } });
                const user = userEvent.setup();
                render(
                    <MailShell userUid="u1">
                        <ChangeProbe />
                    </MailShell>,
                );
                await screen.findAllByText("Inbox");
                await user.click(screen.getByRole("button", { name: "read it" }));
                await user.click(screen.getByRole("button", { name: "server accepted" }));
                await waitFor(() => expect(inboxBadge()).toBe("Inbox5 5 unread"), { timeout: 3000 });
            });

            it("applies the counts the server publishes for a folder", async () => {
                vi.stubGlobal("WebSocket", FakePushSocket);
                mockLiveFolders([mailboxA], { current: { "f-inbox-mb-a": 3 } });
                render(<MailShell userUid="u1">content</MailShell>);
                await screen.findAllByText("Inbox");
                const socket = FakePushSocket.instances[0];
                socket.receive({ id: 0, type: "SUBSCRIBED", data: ["u1"] });

                // The server publishes to the folder's channel and its mailbox's, so the same event is heard twice.
                const event = { type: "FolderMongo", action: "update", data: { uid: "f-inbox-mb-a", mailboxUid: "mb-a", unreadCount: 8, totalCount: 30 } };
                act(() => {
                    socket.receive(event);
                    socket.receive(event);
                });
                await waitFor(() => expect(inboxBadge()).toBe("Inbox8 8 unread"));
            });

            it("counts a new message in its folder at once, and keeps that count when the server agrees", async () => {
                vi.stubGlobal("WebSocket", FakePushSocket);
                const unread = { current: { "f-inbox-mb-a": 3 } as Record<string, number> };
                mockLiveFolders([mailboxA], unread);
                render(<MailShell userUid="u1">content</MailShell>);
                await screen.findAllByText("Inbox");
                const socket = FakePushSocket.instances[0];
                socket.receive({ id: 0, type: "SUBSCRIBED", data: ["u1"] });

                unread.current = { "f-inbox-mb-a": 4 };
                act(() => socket.receive({ type: "MessageMongo", action: "create", data: newMail("m9") }));
                expect(inboxBadge()).toBe("Inbox4 4 unread");
                await new Promise((resolve) => setTimeout(resolve, 1200));
                expect(inboxBadge()).toBe("Inbox4 4 unread");
            });
        });

        const newMail = (uid: string, overrides: Record<string, unknown> = {}) => ({
            uid,
            version: 0,
            folderUid: "f-inbox-mb-a",
            mailboxUid: "mb-a",
            subject: "Contract signed",
            from: { address: "dana@client.example", displayName: "Dana Whitfield", type: "to" },
            receivedDate: new Date().toISOString(),
            bodyPreview: "Great news: the contract is signed.",
            flags: { read: false, flagged: false, answered: false, forwarded: false },
            ...overrides,
        });

        describe("new mail pop-ups", () => {
            async function shellWithSocket() {
                vi.stubGlobal("WebSocket", FakePushSocket);
                mockLiveFolders([mailboxA], { current: { "f-inbox-mb-a": 3 } });
                render(<MailShell userUid="u1">content</MailShell>);
                await screen.findAllByText("Inbox");
                const socket = FakePushSocket.instances[0];
                socket.receive({ id: 0, type: "SUBSCRIBED", data: ["u1"] });
                return socket;
            }

            it("shows the sender, the subject and a preview of a message that arrives, in a polite live region", async () => {
                const socket = await shellWithSocket();
                act(() => socket.receive({ type: "MessageMongo", action: "create", data: newMail("m9") }));

                const region = screen.getByTestId("notification-others");
                expect(region).toHaveAttribute("aria-live", "polite");
                const toast = within(region).getByRole("link");
                expect(toast).toHaveAttribute("href", "/messages/m9");
                expect(toast).toHaveTextContent("Dana Whitfield");
                expect(toast).toHaveTextContent("<dana@client.example>");
                expect(toast).toHaveTextContent("Contract signed");
                expect(toast).toHaveTextContent("Great news: the contract is signed.");
            });

            it("shows nothing for a message that is not new Inbox mail, or that this page already announced", async () => {
                const socket = await shellWithSocket();
                act(() => {
                    socket.receive({ type: "MessageMongo", action: "create", data: newMail("sent", { folderUid: "f-elsewhere" }) });
                    socket.receive({ type: "MessageMongo", action: "create", data: newMail("read", { flags: { read: true } }) });
                    socket.receive({ type: "MessageMongo", action: "update", data: newMail("update") });
                    socket.receive({ type: "MessageMongo", action: "create", data: newMail("mine", { from: { address: "a@example.com", type: "to" } }) });
                });
                expect(within(screen.getByTestId("notification-others")).queryByRole("link")).not.toBeInTheDocument();

                act(() => {
                    socket.receive({ type: "MessageMongo", action: "create", data: newMail("dup") });
                    socket.receive({ type: "MessageMongo", action: "create", data: newMail("dup") });
                });
                expect(within(screen.getByTestId("notification-others")).getAllByRole("link")).toHaveLength(1);
            });

            it("shows nothing while the user has turned pop-ups off", async () => {
                localStorage.setItem("rapidmx-new-mail-popups", "off");
                const socket = await shellWithSocket();
                act(() => socket.receive({ type: "MessageMongo", action: "create", data: newMail("m9") }));
                expect(within(screen.getByTestId("notification-others")).queryByRole("link")).not.toBeInTheDocument();
            });

            it("offers desktop notifications in the pop-up, and remembers 'Not now'", async () => {
                vi.stubGlobal("Notification", Object.assign(vi.fn(), { permission: "default", requestPermission: vi.fn() }));
                const user = userEvent.setup();
                const socket = await shellWithSocket();
                act(() => socket.receive({ type: "MessageMongo", action: "create", data: newMail("m9") }));

                await user.click(await screen.findByRole("button", { name: "Not now" }));
                expect(screen.queryByRole("button", { name: "Turn on desktop notifications" })).not.toBeInTheDocument();
                expect(localStorage.getItem("rapidmx-desktop-notifications-offer")).not.toBeNull();
            });

            it("asks the browser for permission only when 'Turn on desktop notifications' is clicked", async () => {
                const requestPermission = vi.fn().mockResolvedValue("granted");
                vi.stubGlobal("Notification", Object.assign(vi.fn(), { permission: "default", requestPermission }));
                const user = userEvent.setup();
                const socket = await shellWithSocket();
                expect(requestPermission).not.toHaveBeenCalled();
                act(() => socket.receive({ type: "MessageMongo", action: "create", data: newMail("m9") }));

                await user.click(await screen.findByRole("button", { name: "Turn on desktop notifications" }));
                expect(requestPermission).toHaveBeenCalledTimes(1);
                await waitFor(() => expect(screen.queryByRole("button", { name: "Turn on desktop notifications" })).not.toBeInTheDocument());
            });
        });

        describe("the tab title", () => {
            it("carries the unread count of every Inbox, and drops it when everything is read", async () => {
                document.title = "Acme: Mail";
                vi.stubGlobal("WebSocket", FakePushSocket);
                mockLiveFolders([mailboxA, mailboxB], { current: {} });
                const { unmount } = render(<MailShell userUid="u1">content</MailShell>);
                await waitFor(() => expect(document.title).toBe("(6) Acme: Mail"));

                const socket = FakePushSocket.instances[0];
                socket.receive({ id: 0, type: "SUBSCRIBED", data: ["u1"] });
                act(() =>
                    socket.receive({ type: "FolderMongo", action: "update", data: { uid: "f-inbox-mb-a", unreadCount: 0, totalCount: 10 } }),
                );
                await waitFor(() => expect(document.title).toBe("(3) Acme: Mail"));

                unmount();
                expect(document.title).toBe("Acme: Mail");
            });
        });
    });
});


describe("MailShell keyboard shortcuts", () => {
    const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) => fireEvent.keyDown(target, { key, ...init });

    function mockComposeableMail() {
        const draft = {
            uid: "m1",
            version: 0,
            dateCreated: "2026-01-01T00:00:00.000Z",
            dateModified: "2026-01-01T00:00:00.000Z",
            folderUid: "f-drafts",
            mailboxUid: "mb-a",
            messageId: "abc@webmail",
            subject: "",
            from: { address: "a@example.com", type: "to" as const },
            recipients: [],
            sentDate: "2026-01-01T00:00:00.000Z",
            receivedDate: "2026-01-01T00:00:00.000Z",
            bodyPreview: "",
            flags: { read: true, flagged: false, answered: false, forwarded: false },
            importance: "normal" as const,
            hasAttachments: false,
        };
        return mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
            if (url === "/api/mail/mailboxes/mb-a") return jsonResponse(200, mailboxA);
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailboxA]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [draftsFolder, inboxFolder]);
            if (url === "/api/mail/messages" && (init?.method ?? "GET") === "POST") return jsonResponse(200, draft);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
    }

    it("Alt+N opens the compose window for the resolved mailbox, as the Compose button does", async () => {
        const fetchMock = mockComposeableMail();
        render(<MailShell userUid="u1">content</MailShell>);
        await screen.findByRole("button", { name: "Compose" });

        expect(press("n", { altKey: true })).toBe(false);

        expect(await screen.findByRole("dialog", { name: "New Message" })).toBeInTheDocument();
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages", expect.objectContaining({ method: "POST" })));
        // Another Alt+N from inside the window opens another one.
        expect(press("n", { altKey: true }, screen.getByLabelText("Subject"))).toBe(false);
        await waitFor(() => expect(screen.getAllByRole("dialog", { name: "New Message" })).toHaveLength(2));
    });

    it("names the shortcut on the Compose button, leaving its name alone", async () => {
        mockComposeableMail();
        render(<MailShell userUid="u1">content</MailShell>);

        const button = await screen.findByRole("button", { name: "Compose" });
        expect(button).toHaveAttribute("title", "Compose (Alt+N)");
        expect(button).toHaveAttribute("aria-keyshortcuts", "Alt+N");
    });

    it("has no new-message key until there is a mailbox to send from (the mailbox-less screen has none)", async () => {
        mockFetch((url) => {
            if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, []);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, []);
            throw new Error(`unexpected ${url}`);
        });
        render(<MailShell userUid="u1">content</MailShell>);
        await screen.findByText("No mailbox available");

        expect(press("n", { altKey: true })).toBe(true);
    });
});
