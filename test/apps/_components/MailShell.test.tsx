// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../testUtils.js";
import MailShell, { MAILBOX_LIST_LIMIT, useMailShell } from "../../../apps/shared/components/mail/layout/MailShell.js";

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

    it("renders a well-known Archive folder (type: archive) with its label, sorted after Junk and before Deleted Items", async () => {
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
            "/?mailboxUid=mb-a&folderUid=f-junk",
            "/?mailboxUid=mb-a&folderUid=f-archive-wk",
            "/?mailboxUid=mb-a&folderUid=f-deleted",
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
        const draftsLink = screen.getByRole("link", { name: "Drafts" });
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
        expect(aggregateInbox.textContent).toBe("Inbox6");
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
        expect(location.href).toBe(AUTH_SERVER_URL);
    });

    it("signs out to '/' when authServerUrl is not configured", async () => {
        mockMailboxesAndFolders([mailboxA], [inboxFolder]);
        const location = mockLocation();
        const user = userEvent.setup();
        render(<MailShell userUid="u1">content</MailShell>);

        await screen.findByText("content");
        await user.click(screen.getByRole("button", { name: "Account menu" }));
        await user.click(screen.getByRole("menuitem", { name: "Sign Out" }));
        expect(location.href).toBe("/");
    });

    it("sorts folders not in the well-known order alphabetically by name, after well-known folders", async () => {
        const projectsFolder = { ...inboxFolder, uid: "f-projects", name: "Projects", type: "user" as const, unreadCount: 0 };
        const archiveFolder = { ...inboxFolder, uid: "f-archive", name: "Archive", type: "user" as const, unreadCount: 0 };
        mockMailboxesAndFolders([mailboxA], [projectsFolder, inboxFolder, archiveFolder]);
        render(<MailShell userUid="u1">content</MailShell>);

        await screen.findByText("Inbox");
        const folderLinks = screen.getAllByRole("link").filter((el) => el.getAttribute("href")?.includes("folderUid="));
        expect(folderLinks.map((el) => el.textContent)).toEqual(["Inbox3", "Archive", "Projects"]);
    });

    it("excludes calendar/contacts/tasks folders from the folder tree — those back their own dedicated apps, not Mail", async () => {
        const calendarFolder = { ...inboxFolder, uid: "f-cal", name: "Calendar", type: "calendar" as const, unreadCount: 0 };
        const contactsFolder = { ...inboxFolder, uid: "f-con", name: "Contacts", type: "contacts" as const, unreadCount: 0 };
        const tasksFolder = { ...inboxFolder, uid: "f-tsk", name: "Tasks", type: "tasks" as const, unreadCount: 0 };
        mockMailboxesAndFolders([mailboxA], [inboxFolder, calendarFolder, contactsFolder, tasksFolder]);
        render(<MailShell userUid="u1">content</MailShell>);

        await screen.findByText("Inbox");
        const folderLinks = screen.getAllByRole("link").filter((el) => el.getAttribute("href")?.includes("folderUid="));
        expect(folderLinks.map((el) => el.textContent)).toEqual(["Inbox3"]);
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

        const draftsLink = await screen.findByRole("link", { name: "Drafts" });
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
            if (url === "https://auth.example.com/api/admin/impersonate/stop" && init?.method === "GET") {
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
            if (url === "https://auth.example.com/api/admin/impersonate/stop" && init?.method === "GET") {
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
            if (url === "/api/admin/impersonate/stop" && init?.method === "GET") {
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
});
