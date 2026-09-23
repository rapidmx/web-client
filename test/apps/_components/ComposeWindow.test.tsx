// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockMatchMedia } from "../testUtils.js";
import { toBase64 } from "@rapidmx/react-shared/crypto/encoding.js";
import ComposeWindow from "../../../apps/shared/components/mail/compose/ComposeWindow.js";
import type { ComposeSession } from "../../../apps/shared/components/mail/compose/ComposeContext.js";
import { clearMailboxWritabilityCache } from "../../../apps/shared/components/mail/writableMailboxes.js";
import { clearSigningOut, flushComposeDrafts, markSigningOut } from "../../../apps/shared/components/mail/compose/composeFlushRegistry.js";
import { ShortcutProvider } from "../../../apps/shared/keyboard/ShortcutProvider.js";
import { getNotificationsSnapshot } from "../../../apps/shared/notifications/store.js";
import { isSendPending } from "../../../apps/shared/mail/outbox/pendingSends.js";
import { registerUnlockOpener } from "../../../apps/shared/mail/outbox/composeBridge.js";

/** The pop-ups on screen: what the background send raises for a failure (the compose window itself has closed by then). */
const toasts = () => getNotificationsSnapshot().visible;

// "New message" (Alt+N) from inside a window asks the compose context for another one; the window is rendered on its own here, so what it asks
// for is a spy.
const { openCompose } = vi.hoisted(() => ({ openCompose: vi.fn() }));
vi.mock("../../../apps/shared/components/mail/compose/ComposeContext.js", () => ({ useCompose: () => ({ openCompose }) }));

// subscribeKeySession keeps a real listener set, so tests can fire lock/unlock events via emitKeySession().
const { getUnlockedKeys, keySessionListeners } = vi.hoisted(() => ({
    getUnlockedKeys: vi.fn(),
    keySessionListeners: new Set<(event: { mailboxUid: string; state: "unlocked" | "locked" }) => void>(),
}));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({
    getUnlockedKeys,
    subscribeKeySession: (listener: (event: { mailboxUid: string; state: "unlocked" | "locked" }) => void) => {
        keySessionListeners.add(listener);
        return () => keySessionListeners.delete(listener);
    },
}));
function emitKeySession(mailboxUid: string, state: "unlocked" | "locked") {
    act(() => {
        for (const listener of [...keySessionListeners]) listener({ mailboxUid, state });
    });
}

// ComposeWindow's on-demand unlock affordance (the "🔒 Unlock to sign or encrypt" button, shown when a
// key is enrolled but not yet unlocked) calls useUnlockPrompt() - real UnlockPromptProvider is only
// mounted by AppShell.tsx, not by ComposeWindow rendered standalone here, so it's stubbed the same way
// keySession.js is above. No test in this file exercises the unlock flow itself (that belongs to
// UnlockPromptProvider's own test), so requestUnlock is never asserted on beyond being callable.
const { requestUnlock } = vi.hoisted(() => ({ requestUnlock: vi.fn() }));
vi.mock("../../../apps/shared/components/layout/UnlockPromptProvider.js", () => ({
    useUnlockPrompt: () => ({ requestUnlock }),
}));

// The actual CMS/S-MIME crypto (pkijs's ECDH-ES multi-recipient key agreement in particular) is already
// exercised end to end, against real WebCrypto, by react-shared's own smime.test.ts/smimeMessage.test.ts
// - deliberately run under Vitest's "node" environment there, not jsdom (see that repo's vitest.config.ts).
// jsdom's own WebCrypto shim does not reliably support pkijs's ECDH recipient path (confirmed by direct
// reproduction: a real encryptForRecipients() call under this file's jsdom environment throws deep inside
// pkijs's KDF step) - and re-proving CMS correctness here would be redundant with that suite anyway. These
// tests instead stub out buildSignedOnlyMessage()/buildEncryptedMessage() (the two functions that actually
// touch pkijs) and verify ComposeWindow's own responsibility: deciding *when* to call them, with what
// headers/certs, and wiring the result into assembleDraftRaw() - real, unmocked - correctly.
// applyBaselineOuterHeaders()/assembleOutboundMime() are pure string logic with no crypto, so they're kept
// real via importOriginal, rather than re-implementing their behavior a second time here.
const { buildSignedOnlyMessage, buildEncryptedMessage } = vi.hoisted(() => ({
    buildSignedOnlyMessage: vi.fn(),
    buildEncryptedMessage: vi.fn(),
}));
vi.mock("@rapidmx/react-shared/crypto/smimeMessage.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@rapidmx/react-shared/crypto/smimeMessage.js")>()),
    buildSignedOnlyMessage,
    buildEncryptedMessage,
}));

/** A fake DER certificate distinguishable in test assertions - never actually parsed as X.509 here,
 * since buildSignedOnlyMessage()/buildEncryptedMessage() are mocked above. */
function fakeCertDer(label: string): Uint8Array {
    return new TextEncoder().encode(`FAKE-CERT:${label}`);
}
const fakeSigningKey = { fake: "signing-key" } as unknown as CryptoKey;
const fakeEncryptionKey = { fake: "encryption-key" } as unknown as CryptoKey;

// Exposes `onUploadImage` via a button so tests can drive `ComposeWindow`'s own upload-handling logic
// directly (success/failure/not-ready-yet) without needing a real TipTap editor — `ComposeToolbar`'s
// own use of this same prop is already covered in its own test file.
vi.mock("../../../apps/shared/components/mail/compose/RichTextEditor.js", () => ({
    default: ({
        value,
        onChange,
        onUploadImage,
        autoFocusStart,
        onInitialized,
    }: {
        value: string;
        onChange: (v: string) => void;
        onUploadImage: (file: File) => Promise<string | null>;
        autoFocusStart?: boolean;
        onInitialized?: (v: string) => void;
    }) => {
        const [uploadResult, setUploadResult] = React.useState<string>("");
        // Like the real editor, only the value it mounts with counts.
        const [mountedAutoFocusStart] = React.useState(!!autoFocusStart);
        return (
            <div>
                <textarea
                    data-testid="html-editor"
                    data-autofocus-start={String(mountedAutoFocusStart)}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                />
                <button
                    type="button"
                    onClick={async () => {
                        const url = await onUploadImage(new File(["pixels"], "photo.png", { type: "image/png" }));
                        setUploadResult(url ?? "null");
                    }}
                >
                    fake-upload-image
                </button>
                {/* Stands in for TipTap's own serialization of the seeded body (see RichTextEditor's onInitialized). */}
                <button type="button" onClick={() => onInitialized?.(value.replace(/<blockquote>(.*?)<\/blockquote>/g, "<blockquote><p>$1</p></blockquote>"))}>
                    fake-initialize
                </button>
                <span data-testid="upload-result">{uploadResult}</span>
            </div>
        );
    },
}));

const draftsFolder = {
    uid: "f-drafts",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    name: "Drafts",
    type: "drafts" as const,
    unreadCount: 0,
    totalCount: 0,
};
const otherFolder = { ...draftsFolder, uid: "f-inbox", name: "Inbox", type: "inbox" as const };
const draft = {
    uid: "m1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    folderUid: "f-drafts",
    mailboxUid: "mb1",
    messageId: "abc@webmail",
    subject: "",
    from: { address: "u1@example.com", type: "to" as const },
    recipients: [],
    sentDate: "2026-01-01T00:00:00.000Z",
    receivedDate: "2026-01-01T00:00:00.000Z",
    bodyPreview: "",
    flags: { read: true, flagged: false, answered: false, forwarded: false },
    importance: "normal" as const,
    hasAttachments: false,
};

function session(overrides: Partial<ComposeSession> = {}): ComposeSession {
    return { id: "s1", mailboxUid: "mb1", signatureContext: "new", minimized: false, ...overrides };
}

function mockCompose(extra?: (url: string, init?: RequestInit) => Response | undefined) {
    return mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [otherFolder, draftsFolder]);
        if (url.startsWith("/api/mail/mail-signatures")) return jsonResponse(200, []);
        if (url === "/api/mail/messages" && (init?.method ?? "GET") === "POST") return jsonResponse(200, draft);
        // A mailbox with no encryption keys: whether a message is encrypted never hinges on the policy.
        if (url === "/api/mail/mailboxes/mb1") return jsonResponse(200, { uid: "mb1", primarySmtpAddress: "u1@example.com", aliasAddresses: [], keys: [] });
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

function signatureFixture(overrides: Record<string, unknown> = {}) {
    return {
        uid: "sig1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid: "mb1",
        name: "Default",
        contentHtml: "<p>Best,<br>Jane</p>",
        isDefaultForNewMessages: false,
        isDefaultForReplyForward: false,
        ...overrides,
    };
}

/** The recipients a compose field shows as chips. */
function recipientChips(label: string): (string | null)[] {
    return within(screen.getByRole("list", { name: `${label} recipients` }))
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("title"));
}

afterEach(() => {
    clearMailboxWritabilityCache();
    vi.unstubAllGlobals();
    getUnlockedKeys.mockReset();
    buildSignedOnlyMessage.mockReset();
    buildEncryptedMessage.mockReset();
});

describe("ComposeWindow", () => {
    describe("From (sending mailbox)", () => {
        const ownMailbox = { uid: "mb-own", ownerUserUid: "u1", displayName: "Me", primarySmtpAddress: "me@example.com", aliasAddresses: [] };
        const sharedMailbox = { uid: "mb-shared", displayName: "Support", primarySmtpAddress: "support@example.com", aliasAddresses: [] };

        /** Two mailboxes (shared listed first), each with its own Drafts folder; a created draft echoes the
         * mailbox it was created in. */
        function mockTwoMailboxes(extra?: (url: string, init?: RequestInit) => Response | undefined) {
            let draftCount = 0;
            return mockFetch((url, init) => {
                const custom = extra?.(url, init);
                if (custom) return custom;
                const method = init?.method ?? "GET";
                if (url.startsWith("/api/mail/mailboxes?")) return jsonResponse(200, [sharedMailbox, ownMailbox]);
                if (url === "/api/mail/mailboxes/mb-own") return jsonResponse(200, ownMailbox);
                if (url === "/api/mail/mailboxes/mb-shared") return jsonResponse(200, sharedMailbox);
                if (url.startsWith("/api/mail/folders")) {
                    const mailboxUid = new URLSearchParams(url.split("?")[1]).get("mailboxUid")!;
                    return jsonResponse(200, [{ ...draftsFolder, uid: `drafts-${mailboxUid}`, mailboxUid }]);
                }
                if (url.startsWith("/api/mail/mail-signatures")) return jsonResponse(200, []);
                if (url === "/api/mail/messages" && method === "POST") {
                    const body = JSON.parse(init.body as string);
                    draftCount += 1;
                    return jsonResponse(200, { ...draft, uid: `m-${draftCount}`, mailboxUid: body.mailboxUid, folderUid: body.folderUid });
                }
                if (url.startsWith("/api/mail/messages/") && method === "DELETE") return new Response(null, { status: 204 });
                throw new Error(`unexpected ${method} ${url}`);
            });
        }

        function draftCreates(fetchMock: ReturnType<typeof mockFetch>) {
            return fetchMock.mock.calls
                .filter(([url, init]) => url === "/api/mail/messages" && (init as RequestInit | undefined)?.method === "POST")
                .map(([, init]) => JSON.parse((init as RequestInit).body as string));
        }

        it("defaults a fresh message to the caller's own mailbox, even when it isn't listed first", async () => {
            const fetchMock = mockTwoMailboxes();
            render(<ComposeWindow session={session({ mailboxUid: undefined })} userUid="u1" onClose={vi.fn()} onToggleMinimize={vi.fn()} />);

            expect(await screen.findByLabelText("From")).toHaveValue("mb-own");
            await waitFor(() => expect(draftCreates(fetchMock)).toEqual([expect.objectContaining({ mailboxUid: "mb-own", folderUid: "drafts-mb-own" })]));
        });

        it("keeps the session's mailbox (e.g. a reply to a shared mailbox's message) as the default", async () => {
            mockTwoMailboxes();
            render(<ComposeWindow session={session({ mailboxUid: "mb-shared" })} userUid="u1" onClose={vi.fn()} onToggleMinimize={vi.fn()} />);

            expect(await screen.findByLabelText("From")).toHaveValue("mb-shared");
            expect(screen.getByRole("option", { name: "Support <support@example.com> (shared)" })).toBeInTheDocument();
        });

        it("switching From discards the current draft and starts a new one in the new mailbox's Drafts, keeping what was typed", async () => {
            const fetchMock = mockTwoMailboxes();
            const user = userEvent.setup();
            render(<ComposeWindow session={session({ mailboxUid: undefined })} userUid="u1" onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            const from = await screen.findByLabelText("From");
            await waitFor(() => expect(draftCreates(fetchMock)).toHaveLength(1));
            await user.type(screen.getByLabelText("To"), "jane@example.com");

            await user.selectOptions(from, "mb-shared");

            await waitFor(() =>
                expect(draftCreates(fetchMock)[1]).toEqual(expect.objectContaining({ mailboxUid: "mb-shared", folderUid: "drafts-mb-shared" })),
            );
            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m-1?version=0", expect.objectContaining({ method: "DELETE" })),
            );
            // The replacement draft is created before the old one is deleted, never the other way around.
            const calls = fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${url}`);
            const secondCreate = calls.findIndex((c, i) => c === "POST /api/mail/messages" && calls.indexOf("POST /api/mail/messages") !== i);
            expect(calls.indexOf("DELETE /api/mail/messages/m-1?version=0")).toBeGreaterThan(secondCreate);
            // Leaving the field for From turned what was typed into a recipient.
            expect(recipientChips("To")).toEqual(["jane@example.com"]);
        });

        it("keeps the old draft when the replacement draft can't be created", async () => {
            const fetchMock = mockTwoMailboxes((url, init) =>
                url === "/api/mail/messages" && init?.method === "POST" && String(init.body).includes("mb-shared")
                    ? jsonResponse(500, { message: "no drafts for you" })
                    : undefined,
            );
            const user = userEvent.setup();
            render(<ComposeWindow session={session({ mailboxUid: undefined })} userUid="u1" onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            const from = await screen.findByLabelText("From");
            await waitFor(() => expect(draftCreates(fetchMock)).toHaveLength(1));

            await user.selectOptions(from, "mb-shared");

            expect(await screen.findByText("no drafts for you")).toBeInTheDocument();
            expect(fetchMock).not.toHaveBeenCalledWith(expect.stringMatching(/^\/api\/mail\/messages\/m-1/), expect.objectContaining({ method: "DELETE" }));
        });

        const viewOnly = { uid: "mb-view", displayName: "Announcements", primarySmtpAddress: "news@example.com", aliasAddresses: [] };

        function access(canCreate: boolean) {
            return jsonResponse(200, { canRead: true, canCreate, canUpdate: canCreate, canDelete: canCreate, canManage: false });
        }

        function accessChecks(fetchMock: ReturnType<typeof mockFetch>) {
            return fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.endsWith("/access/me"));
        }

        it("doesn't offer From mailboxes the caller can only view, dropping them as each check answers", async () => {
            const fetchMock = mockTwoMailboxes((url) => {
                if (url.startsWith("/api/mail/mailboxes?")) return jsonResponse(200, [sharedMailbox, ownMailbox, viewOnly]);
                if (url === "/api/mail/mailboxes/mb-view/access/me") return access(false);
                if (url === "/api/mail/mailboxes/mb-shared/access/me") return access(true);
                return undefined;
            });
            render(<ComposeWindow session={session({ mailboxUid: undefined })} userUid="u1" onClose={vi.fn()} onToggleMinimize={vi.fn()} />);

            expect(await screen.findByLabelText("From")).toHaveValue("mb-own");
            await waitFor(() => expect(screen.queryByRole("option", { name: /Announcements/ })).not.toBeInTheDocument());
            expect(screen.getByRole("option", { name: "Support <support@example.com> (shared)" })).toBeInTheDocument();
            // The caller's own mailbox is never checked.
            expect(accessChecks(fetchMock).sort()).toEqual(["/api/mail/mailboxes/mb-shared/access/me", "/api/mail/mailboxes/mb-view/access/me"]);
        });

        it("makes no access checks for a trusted caller", async () => {
            const fetchMock = mockTwoMailboxes((url) => (url.startsWith("/api/mail/mailboxes?") ? jsonResponse(200, [sharedMailbox, ownMailbox, viewOnly]) : undefined));
            render(<ComposeWindow session={session({ mailboxUid: undefined })} userUid="u1" trusted onClose={vi.fn()} onToggleMinimize={vi.fn()} />);

            await screen.findByLabelText("From");
            await waitFor(() => expect(draftCreates(fetchMock)).toHaveLength(1));
            expect(screen.getByRole("option", { name: /Announcements/ })).toBeInTheDocument();
            expect(accessChecks(fetchMock)).toEqual([]);
        });

        it("switches a view-only sender (e.g. a reply in a read-only share) to the caller's own mailbox", async () => {
            const fetchMock = mockTwoMailboxes((url, init) => {
                if (url.startsWith("/api/mail/mailboxes?")) return jsonResponse(200, [viewOnly, sharedMailbox, ownMailbox]);
                if (url === "/api/mail/mailboxes/mb-view/access/me") return access(false);
                if (url === "/api/mail/mailboxes/mb-shared/access/me") return jsonResponse(500, { message: "boom" });
                if (url === "/api/mail/messages" && init?.method === "POST" && String(init.body).includes("mb-view")) {
                    return jsonResponse(403, { message: "forbidden" });
                }
                return undefined;
            });
            render(<ComposeWindow session={session({ mailboxUid: "mb-view" })} userUid="u1" onClose={vi.fn()} onToggleMinimize={vi.fn()} />);

            await waitFor(() => expect(screen.getByLabelText("From")).toHaveValue("mb-own"));
            await waitFor(() => expect(draftCreates(fetchMock).at(-1)).toEqual(expect.objectContaining({ mailboxUid: "mb-own" })));
            expect(screen.queryByRole("option", { name: /Announcements/ })).not.toBeInTheDocument();
            expect(screen.queryByText("forbidden")).not.toBeInTheDocument();
        });

        it("falls back to a mailbox whose access couldn't be checked when nothing is known writable, and stays put when there's no alternative", async () => {
            mockTwoMailboxes((url) => {
                if (url.startsWith("/api/mail/mailboxes?")) return jsonResponse(200, [viewOnly, sharedMailbox]);
                if (url === "/api/mail/mailboxes/mb-view/access/me") return access(false);
                if (url === "/api/mail/mailboxes/mb-shared/access/me") return jsonResponse(404, { message: "no route" });
                return undefined;
            });
            const first = render(<ComposeWindow session={session({ mailboxUid: "mb-view" })} userUid="u1" onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.queryByLabelText("From")).not.toBeInTheDocument());
            first.unmount();

            // A later compose already knows mb-view is view-only, so never even defaults to it.
            mockTwoMailboxes((url) => (url.startsWith("/api/mail/mailboxes?") ? jsonResponse(200, [viewOnly, sharedMailbox, ownMailbox]) : undefined));
            const second = render(<ComposeWindow session={session({ mailboxUid: undefined })} userUid="u2" onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            expect(await screen.findByLabelText("From")).toHaveValue("mb-shared");
            second.unmount();

            mockTwoMailboxes((url) => (url.startsWith("/api/mail/mailboxes?") ? jsonResponse(200, [viewOnly]) : undefined));
            render(<ComposeWindow session={session({ mailboxUid: "mb-view" })} userUid="u1" onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(screen.queryByLabelText("From")).not.toBeInTheDocument();
        });

        it("deletes a superseded draft when the window closes before its replacement exists", async () => {
            const replacement = deferred<Response>();
            const fetchMock = mockTwoMailboxes((url, init) =>
                url === "/api/mail/messages" && init?.method === "POST" && String(init.body).includes("mb-shared")
                    ? (replacement.promise as unknown as Response)
                    : undefined,
            );
            const { unmount } = render(<ComposeWindow session={session({ mailboxUid: undefined })} userUid="u1" onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            const from = await screen.findByLabelText("From");
            await waitFor(() => expect(draftCreates(fetchMock)).toHaveLength(1));
            fireEvent.change(from, { target: { value: "mb-shared" } });
            await waitFor(() => expect(draftCreates(fetchMock)).toHaveLength(2));

            unmount();

            await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m-1?version=0", expect.objectContaining({ method: "DELETE" })));
        });

        it("locks From once an attachment has been uploaded onto the draft", async () => {
            mockTwoMailboxes((url, init) =>
                url.startsWith("/api/mail/attachments/upload") && (init?.method ?? "GET") === "POST"
                    ? jsonResponse(200, { uid: "a1", messageUid: "m-1", filename: "photo.png", contentType: "image/png", sizeBytes: 6 })
                    : undefined,
            );
            const user = userEvent.setup();
            render(<ComposeWindow session={session({ mailboxUid: undefined })} userUid="u1" onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            const from = await screen.findByLabelText("From");
            await waitFor(() => expect(screen.getByLabelText("Attach files")).not.toBeDisabled());

            await user.click(await screen.findByRole("button", { name: "fake-upload-image" }));

            await waitFor(() => expect(from).toBeDisabled());
        });

        function deferred<T>() {
            let resolve!: (value: T) => void;
            const promise = new Promise<T>((res) => {
                resolve = res;
            });
            return { promise, resolve };
        }

        it("defaults to the first listed mailbox when the caller owns none of them, showing a bare address for an unnamed one", async () => {
            const unnamed = { ...sharedMailbox, uid: "mb-unnamed", displayName: "", primarySmtpAddress: "team@example.com" };
            mockTwoMailboxes((url) => (url.startsWith("/api/mail/mailboxes?") ? jsonResponse(200, [unnamed, sharedMailbox]) : undefined));
            render(<ComposeWindow session={session({ mailboxUid: undefined })} userUid="u1" onClose={vi.fn()} onToggleMinimize={vi.fn()} />);

            expect(await screen.findByLabelText("From")).toHaveValue("mb-unnamed");
            expect(screen.getByRole("option", { name: "team@example.com (shared)" })).toBeInTheDocument();
        });

        it.each([
            ["the API's own message", () => jsonResponse(500, { message: "mailboxes boom" }), "mailboxes boom"],
            [
                "a generic message",
                () => {
                    throw new TypeError("network down");
                },
                "Could not load your mailboxes.",
            ],
        ])("shows %s when there's no session mailbox to fall back on and the mailbox list fails", async (_label, respond, expected) => {
            mockTwoMailboxes((url) => (url.startsWith("/api/mail/mailboxes?") ? respond() : undefined));
            render(<ComposeWindow session={session({ mailboxUid: undefined })} userUid="u1" onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            expect(await screen.findByText(expected)).toBeInTheDocument();
        });

        it("ignores a mailbox list that arrives after the window closed", async () => {
            const list = deferred<Response>();
            const fetchMock = mockTwoMailboxes((url) => (url.startsWith("/api/mail/mailboxes?") ? (list.promise as unknown as Response) : undefined));
            const { unmount } = render(<ComposeWindow session={session({ mailboxUid: undefined })} userUid="u1" onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(fetchMock).toHaveBeenCalled());

            unmount();
            list.resolve(jsonResponse(200, [sharedMailbox, ownMailbox]));
            await new Promise((resolve) => setTimeout(resolve, 20));

            expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/mail/folders"))).toBe(false);
        });

        it("ignores a Drafts folder lookup (success or failure) for a mailbox the user already switched away from", async () => {
            const folderRequests: { mailboxUid: string; request: ReturnType<typeof deferred<Response>> }[] = [];
            const fetchMock = mockTwoMailboxes((url) => {
                if (!url.startsWith("/api/mail/folders")) return undefined;
                const mailboxUid = new URLSearchParams(url.split("?")[1]).get("mailboxUid")!;
                const request = deferred<Response>();
                folderRequests.push({ mailboxUid, request });
                return request.promise as unknown as Response;
            });
            render(<ComposeWindow session={session({ mailboxUid: undefined })} userUid="u1" onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            const from = await screen.findByLabelText("From");
            await waitFor(() => expect(folderRequests).toHaveLength(1));

            // No draft exists yet on either switch.
            fireEvent.change(from, { target: { value: "mb-shared" } });
            await waitFor(() => expect(folderRequests).toHaveLength(2));
            fireEvent.change(from, { target: { value: "mb-own" } });
            await waitFor(() => expect(folderRequests).toHaveLength(3));

            folderRequests[0].request.resolve(jsonResponse(200, [{ ...draftsFolder, uid: "drafts-stale", mailboxUid: "mb-own" }]));
            folderRequests[1].request.resolve(jsonResponse(500, { message: "stale folder failure" }));
            folderRequests[2].request.resolve(jsonResponse(200, [{ ...draftsFolder, uid: "drafts-mb-own", mailboxUid: "mb-own" }]));

            await waitFor(() => expect(draftCreates(fetchMock)).toEqual([expect.objectContaining({ mailboxUid: "mb-own", folderUid: "drafts-mb-own" })]));
            expect(screen.queryByText("stale folder failure")).not.toBeInTheDocument();
        });

        it("deletes a draft that finishes creating after the user switched From, even if that delete fails", async () => {
            const ownDraft = deferred<Response>();
            const fetchMock = mockTwoMailboxes((url, init) => {
                const method = init?.method ?? "GET";
                if (url === "/api/mail/messages" && method === "POST" && String(init?.body).includes("mb-own")) {
                    return ownDraft.promise as unknown as Response;
                }
                if (url.startsWith("/api/mail/messages/m-orphan") && method === "DELETE") return jsonResponse(500, { message: "delete failed" });
                return undefined;
            });
            render(<ComposeWindow session={session({ mailboxUid: undefined })} userUid="u1" onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            const from = await screen.findByLabelText("From");
            await waitFor(() => expect(draftCreates(fetchMock)).toHaveLength(1));

            fireEvent.change(from, { target: { value: "mb-shared" } });
            await waitFor(() => expect(draftCreates(fetchMock)).toHaveLength(2));
            ownDraft.resolve(jsonResponse(200, { ...draft, uid: "m-orphan", mailboxUid: "mb-own" }));

            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m-orphan?version=0", expect.objectContaining({ method: "DELETE" })),
            );
            await waitFor(() => expect(screen.getByLabelText("Attach files")).not.toBeDisabled());
        });

        it("still starts the new draft when deleting the superseded one fails, and ignores re-selecting the current sender", async () => {
            const fetchMock = mockTwoMailboxes((url, init) =>
                url.startsWith("/api/mail/messages/m-1") && init?.method === "DELETE" ? jsonResponse(500, { message: "delete failed" }) : undefined,
            );
            render(<ComposeWindow session={session({ mailboxUid: undefined })} userUid="u1" onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            const from = await screen.findByLabelText("From");
            await waitFor(() => expect(draftCreates(fetchMock)).toHaveLength(1));

            fireEvent.change(from, { target: { value: "mb-own" } });
            expect(draftCreates(fetchMock)).toHaveLength(1);

            fireEvent.change(from, { target: { value: "mb-shared" } });
            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m-1?version=0", expect.objectContaining({ method: "DELETE" })),
            );
            expect(draftCreates(fetchMock)).toHaveLength(2);
            expect(screen.queryByText("delete failed")).not.toBeInTheDocument();
        });

        it("an autosave that lands after a From switch never resurrects the old draft, and its delete uses the saved version", async () => {
            const save = deferred<Response>();
            const replacement = deferred<Response>();
            const fetchMock = mockTwoMailboxes((url, init) => {
                const method = init?.method ?? "GET";
                if (url === "/api/mail/compose/m-1/assemble" && method === "POST") return save.promise as unknown as Response;
                if (url === "/api/mail/compose/m-2/assemble" && method === "POST") return jsonResponse(200, { ...draft, uid: "m-2", version: 1 });
                if (url === "/api/mail/messages" && method === "POST" && String(init?.body).includes("mb-shared")) {
                    return replacement.promise as unknown as Response;
                }
                return undefined;
            });
            render(<ComposeWindow session={session({ mailboxUid: undefined })} userUid="u1" autosaveDelayMs={5} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            const from = await screen.findByLabelText("From");
            await waitFor(() => expect(screen.getByLabelText("Attach files")).not.toBeDisabled());

            fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Switching" } });
            await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/mail/compose/m-1/assemble", expect.objectContaining({ method: "POST" })));
            fireEvent.change(from, { target: { value: "mb-shared" } });
            await waitFor(() => expect(draftCreates(fetchMock)).toHaveLength(2));

            save.resolve(jsonResponse(200, { ...draft, uid: "m-1", version: 5 }));
            await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Draft saved"));
            replacement.resolve(jsonResponse(200, { ...draft, uid: "m-2", mailboxUid: "mb-shared", folderUid: "drafts-mb-shared" }));

            await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m-1?version=5", expect.objectContaining({ method: "DELETE" })));
            // The edit is re-saved onto the replacement draft rather than the discarded one.
            await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/mail/compose/m-2/assemble", expect.objectContaining({ method: "POST" })));
        });

        it("shows no From field for a caller with only one mailbox", async () => {
            mockCompose((url) => (url.startsWith("/api/mail/mailboxes?") ? jsonResponse(200, [ownMailbox]) : undefined));
            render(<ComposeWindow session={session()} userUid="u1" onClose={vi.fn()} onToggleMinimize={vi.fn()} />);

            await screen.findByLabelText("Attach files");
            expect(screen.queryByLabelText("From")).not.toBeInTheDocument();
        });
    });

    it("resolves the Drafts folder for the given mailbox and starts a blank draft", async () => {
        const fetchMock = mockCompose();
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages", expect.objectContaining({ method: "POST" })),
        );
        expect(await screen.findByLabelText("Attach files")).not.toBeDisabled();
    });

    it("shows an error when the Drafts folder can't be resolved", async () => {
        mockFetch((url) => {
            if (url.startsWith("/api/mail/folders")) return jsonResponse(500, { message: "folder boom" });
            throw new Error(`unexpected ${url}`);
        });
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
        expect(await screen.findByText("folder boom")).toBeInTheDocument();
    });

    it("shows a generic error when the Drafts folder lookup fails with a non-API error", async () => {
        mockFetch(() => {
            throw new TypeError("network down");
        });
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
        expect(await screen.findByText("Could not load your Drafts folder.")).toBeInTheDocument();
    });

    it("shows an error when starting the draft fails", async () => {
        mockCompose((url, init) =>
            url === "/api/mail/messages" && (init?.method ?? "GET") === "POST" ? jsonResponse(500, { message: "boom" }) : undefined,
        );
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error when starting the draft fails with a non-API error", async () => {
        mockCompose((url, init) => {
            if (url === "/api/mail/messages" && (init?.method ?? "GET") === "POST") throw new TypeError("network down");
            return undefined;
        });
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
        expect(await screen.findByText("Could not start a new draft.")).toBeInTheDocument();
    });

    it("prefills the To field from the session's initialTo", async () => {
        mockCompose();
        render(<ComposeWindow session={session({ initialTo: "jane@example.com" })} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
        expect(recipientChips("To")).toEqual(["jane@example.com"]);
        expect(screen.getByLabelText("To")).toHaveValue("");
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
    });

    it("shows 'New Message' as the title until a subject is typed, then switches to it", async () => {
        mockCompose();
        const user = userEvent.setup();
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);

        expect(screen.getByRole("dialog", { name: "New Message" })).toBeInTheDocument();
        await user.type(screen.getByLabelText("Subject"), "Hi there");
        expect(screen.getByRole("dialog", { name: "Hi there" })).toBeInTheDocument();
    });

    it("reveals Cc/Bcc fields on request", async () => {
        mockCompose();
        const user = userEvent.setup();
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);

        expect(screen.queryByLabelText("Cc")).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Cc Bcc" }));
        await user.type(screen.getByLabelText("Cc"), "cc@example.com");
        await user.type(screen.getByLabelText("Bcc"), "bcc@example.com");
        expect(recipientChips("Cc")).toEqual(["cc@example.com"]);
        expect(screen.getByLabelText("Bcc")).toHaveValue("bcc@example.com");
    });

    it("requires at least one recipient before sending", async () => {
        mockCompose();
        const user = userEvent.setup();
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

        await user.click(screen.getByRole("button", { name: "Send" }));

        expect(await screen.findByText("At least one recipient is required.")).toBeInTheDocument();
    });

    it("assembles and sends the draft, then closes the window", async () => {
        const fetchMock = mockCompose((url, init) => {
            const method = init?.method ?? "GET";
            if (url === "/api/mail/compose/m1/assemble" && method === "POST") return jsonResponse(200, draft);
            if (url === "/api/mail/messages/m1/send" && method === "POST") return jsonResponse(200, draft);
            return undefined;
        });
        const onClose = vi.fn();
        const user = userEvent.setup();
        render(<ComposeWindow session={session()} onClose={onClose} onToggleMinimize={vi.fn()} />);
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

        await user.type(screen.getByLabelText("To"), "b@example.com, c@example.com");
        await user.type(screen.getByLabelText("Subject"), "Hi there");
        await user.type(screen.getByTestId("html-editor"), "<p>hello</p>");
        await user.click(screen.getByRole("button", { name: "Send" }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/compose/m1/assemble", expect.objectContaining({ method: "POST" })),
        );
        const assembleCall = fetchMock.mock.calls.find((call) => call[0] === "/api/mail/compose/m1/assemble")!;
        const body = JSON.parse((assembleCall[1] as RequestInit).body as string);
        expect(body.to).toEqual([{ address: "b@example.com" }, { address: "c@example.com" }]);
        expect(body.subject).toBe("Hi there");
        await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it("does not set requestReceipt when the checkbox is left unchecked", async () => {
        const fetchMock = mockCompose((url, init) => {
            const method = init?.method ?? "GET";
            if (url === "/api/mail/compose/m1/assemble" && method === "POST") return jsonResponse(200, draft);
            if (url === "/api/mail/messages/m1/send" && method === "POST") return jsonResponse(200, draft);
            return undefined;
        });
        const user = userEvent.setup();
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

        await user.type(screen.getByLabelText("To"), "b@example.com");
        await user.click(screen.getByRole("button", { name: "Send" }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m1/send", expect.objectContaining({ method: "POST" })),
        );
        expect(fetchMock.mock.calls.some(([url]) => url === "/api/mail/messages/m1")).toBe(false);
    });

    it("sets requestReceipt before sending when 'Request a read receipt' is checked", async () => {
        const fetchMock = mockCompose((url, init) => {
            const method = init?.method ?? "GET";
            if (url === "/api/mail/compose/m1/assemble" && method === "POST") return jsonResponse(200, draft);
            if (url === "/api/mail/messages/m1" && method === "PUT") return jsonResponse(200, { ...draft, requestReceipt: true });
            if (url === "/api/mail/messages/m1/send" && method === "POST") return jsonResponse(200, draft);
            return undefined;
        });
        const user = userEvent.setup();
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

        await user.type(screen.getByLabelText("To"), "b@example.com");
        await user.click(screen.getByLabelText("Request a read receipt"));
        await user.click(screen.getByRole("button", { name: "Send" }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/messages/m1",
                expect.objectContaining({ method: "PUT", body: JSON.stringify({ uid: "m1", version: 0, requestReceipt: true }) }),
            ),
        );
    });

    it("shows a failure that happens after Send as a sticky pop-up - the window has already closed", async () => {
        mockCompose((url, init) =>
            url === "/api/mail/compose/m1/assemble" && (init?.method ?? "GET") === "POST"
                ? jsonResponse(500, { message: "assemble failed" })
                : undefined,
        );
        const onClose = vi.fn();
        const user = userEvent.setup();
        render(<ComposeWindow session={session()} onClose={onClose} onToggleMinimize={vi.fn()} />);
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

        await user.type(screen.getByLabelText("To"), "b@example.com");
        await user.type(screen.getByLabelText("Subject"), "Hello");
        await user.click(screen.getByRole("button", { name: "Send" }));

        expect(onClose).toHaveBeenCalledTimes(1);
        await waitFor(() => expect(toasts()).toHaveLength(1));
        expect(toasts()[0]).toMatchObject({ kind: "error", title: "This message wasn't sent", sticky: true });
        expect(toasts()[0].message).toContain("assemble failed");
        expect(toasts()[0].message).toContain('To b@example.com - "Hello"');
        expect(toasts()[0].actions.map((action) => action.label)).toEqual(["Retry", "Open draft"]);
    });

    it("says it could not send when the failure is not an API error", async () => {
        mockCompose((url, init) => {
            if (url === "/api/mail/compose/m1/assemble" && (init?.method ?? "GET") === "POST") return jsonResponse(200, draft);
            if (url === "/api/mail/messages/m1/send") throw new TypeError("network down");
            if (url === "/api/mail/messages/m1") return jsonResponse(200, draft);
            return undefined;
        });
        const user = userEvent.setup();
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

        await user.type(screen.getByLabelText("To"), "b@example.com");
        await user.click(screen.getByRole("button", { name: "Send" }));

        await waitFor(() => expect(toasts()).toHaveLength(1));
        expect(toasts()[0].message).toContain("Could not send this message.");
    });

    describe("a failed send", () => {
        const details = {
            message: "The message could not be delivered.",
            code: "api-500",
            details: {
                recipients: [
                    { address: "b@example.com", smtpCode: 550, enhancedStatus: "5.1.1", response: "No such user here" },
                    { address: "c@example.com", smtpCode: 452, response: "Mailbox full" },
                ],
                transportError: "connect ECONNREFUSED 10.0.0.5:25",
            },
        };

        /** Types a recipient and clicks Send against a server whose send endpoint answers `sendResponse`. */
        async function sendAndFail(sendResponse: () => Response, onClose = vi.fn()) {
            const fetchMock = mockCompose((url, init) => {
                if (url === "/api/mail/compose/m1/assemble" && (init?.method ?? "GET") === "POST") return jsonResponse(200, draft);
                if (url === "/api/mail/messages/m1/send") return sendResponse();
                if (init?.method === "DELETE") return new Response(null, { status: 204 });
                return undefined;
            });
            const user = userEvent.setup();
            const view = render(<ComposeWindow session={session()} onClose={onClose} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
            await user.type(screen.getByLabelText("To"), "b@example.com");
            await user.click(screen.getByRole("button", { name: "Send" }));
            await waitFor(() => expect(toasts()).toHaveLength(1));
            return { fetchMock, user, onClose, view };
        }

        it("closes at once and keeps the draft: the pop-up carries the message and the technical details, and nothing is deleted", async () => {
            const { fetchMock, onClose } = await sendAndFail(() => jsonResponse(502, details));

            expect(onClose).toHaveBeenCalledTimes(1);
            expect(toasts()[0].message).toContain("The message could not be delivered.");
            expect(toasts()[0].details).toEqual([
                "recipients 1: address=b@example.com smtpCode=550 enhancedStatus=5.1.1 response=No such user here",
                "recipients 2: address=c@example.com smtpCode=452 response=Mailbox full",
                "transportError: connect ECONNREFUSED 10.0.0.5:25",
            ]);
            expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);
        });

        it("has just the message when the response has no details to parse", async () => {
            await sendAndFail(() => jsonResponse(500, { message: "Relay access denied" }));
            expect(toasts()[0].message).toContain("Relay access denied");
            expect(toasts()[0].details).toEqual([]);
        });

        it("'Retry' sends the same draft again, and the failure pop-up is resolved by it", async () => {
            let calls = 0;
            const { fetchMock } = await sendAndFail(() => (++calls === 1 ? jsonResponse(500, { message: "Try later" }) : jsonResponse(202, { status: "queued", message: draft })));
            const retry = toasts()[0].actions.find((action) => action.label === "Retry")!;
            await act(async () => retry.onClick!());
            await waitFor(() => expect(calls).toBe(2));
            expect(fetchMock.mock.calls.filter(([url]) => url === "/api/mail/messages/m1/send")).toHaveLength(2);
            await waitFor(() => expect(toasts().filter((toast) => toast.kind === "error")).toHaveLength(0));
        });

        it("shows no Not sent marker on a minimized window that hasn't failed", async () => {
            const fetchMock = mockCompose();
            render(<ComposeWindow session={session({ minimized: true })} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            // Let the draft be created, so nothing settles after the test.
            await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/mail/messages")).toBe(true));
            await act(async () => undefined);
            expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
            expect(screen.queryByText("Not sent")).not.toBeInTheDocument();
        });
    });

    it("uploads a selected attachment against the draft and lists it", async () => {
        const attachment = {
            uid: "a1",
            version: 0,
            dateCreated: "2026-01-01T00:00:00.000Z",
            dateModified: "2026-01-01T00:00:00.000Z",
            messageUid: "m1",
            folderUid: "f-drafts",
            mailboxUid: "mb1",
            filename: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 12,
            isInline: false,
        };
        mockCompose((url, init) =>
            url.startsWith("/api/mail/attachments/upload") && (init?.method ?? "GET") === "POST" ? jsonResponse(200, attachment) : undefined,
        );
        const user = userEvent.setup();
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

        const file = new File(["hello"], "notes.txt", { type: "text/plain" });
        await user.upload(screen.getByLabelText("Attach files"), file);

        expect(await screen.findByText("notes.txt")).toBeInTheDocument();
    });

    it("shows an error message when an attachment upload fails", async () => {
        mockCompose((url, init) =>
            url.startsWith("/api/mail/attachments/upload") && (init?.method ?? "GET") === "POST"
                ? jsonResponse(500, { message: "too large" })
                : undefined,
        );
        const user = userEvent.setup();
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

        const file = new File(["hello"], "big.bin", { type: "application/octet-stream" });
        await user.upload(screen.getByLabelText("Attach files"), file);

        expect(await screen.findByText("too large")).toBeInTheDocument();
    });

    it("shows a generic error message when an attachment upload fails with a non-API error", async () => {
        mockCompose((url, init) => {
            if (url.startsWith("/api/mail/attachments/upload") && (init?.method ?? "GET") === "POST") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

        const file = new File(["hello"], "big.bin", { type: "application/octet-stream" });
        await user.upload(screen.getByLabelText("Attach files"), file);

        expect(await screen.findByText("Could not upload attachment.")).toBeInTheDocument();
    });

    it("ignores a change event with no file list", async () => {
        mockCompose();
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

        const input = screen.getByLabelText("Attach files");
        Object.defineProperty(input, "files", { value: null, configurable: true });
        fireEvent.change(input);

        expect(screen.queryByText(/too large|boom/)).not.toBeInTheDocument();
    });

    it("does nothing when Send is clicked before the draft has loaded", async () => {
        let resolveDraft: (() => void) | undefined;
        mockCompose((url, init) => {
            if (url === "/api/mail/messages" && (init?.method ?? "GET") === "POST") {
                return new Promise((resolve) => {
                    resolveDraft = () => resolve(jsonResponse(200, draft));
                });
            }
            return undefined;
        });
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
        await waitFor(() => expect(resolveDraft).toBeDefined());

        fireEvent.click(screen.getByRole("button", { name: "Send" }));

        expect(screen.queryByText("At least one recipient is required.")).not.toBeInTheDocument();
        resolveDraft!();
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
    });

    it("closes straight away, deleting the untouched blank draft, when Close or Discard draft is clicked with nothing typed", async () => {
        const fetchMock = mockCompose((url, init) => (init?.method === "DELETE" ? new Response(null, { status: 204 }) : undefined));
        const onClose = vi.fn();
        const user = userEvent.setup();
        render(<ComposeWindow session={session()} onClose={onClose} onToggleMinimize={vi.fn()} />);
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).toHaveBeenCalledTimes(1);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m1?version=0", expect.objectContaining({ method: "DELETE" })));

        await user.click(screen.getByRole("button", { name: "Discard draft" }));
        expect(onClose).toHaveBeenCalledTimes(2);
        expect(screen.queryByRole("dialog", { name: "Discard this draft?" })).not.toBeInTheDocument();
    });

    it("calls onToggleMinimize when the header, Minimize button, or minimized bar is clicked", async () => {
        mockCompose();
        const onToggleMinimize = vi.fn();
        const user = userEvent.setup();
        const { rerender } = render(
            <ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={onToggleMinimize} />,
        );

        await user.click(screen.getByText("New Message"));
        expect(onToggleMinimize).toHaveBeenCalledTimes(1);

        await user.click(screen.getByRole("button", { name: "Minimize" }));
        expect(onToggleMinimize).toHaveBeenCalledTimes(2);

        rerender(<ComposeWindow session={session({ minimized: true })} onClose={vi.fn()} onToggleMinimize={onToggleMinimize} />);
        await user.click(screen.getByRole("button", { name: "Restore" }));
        expect(onToggleMinimize).toHaveBeenCalledTimes(3);
    });

    it("shows just a compact title bar when minimized, using the subject as its label", async () => {
        mockCompose();
        const user = userEvent.setup();
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
        await user.type(screen.getByLabelText("Subject"), "Hi there");

        // Not minimized yet: the full editor is present.
        expect(screen.getByTestId("html-editor")).toBeInTheDocument();
    });

    it("renders a minimized session as a compact bar with a Discard action, and no editor", async () => {
        const fetchMock = mockCompose();
        render(<ComposeWindow session={session({ minimized: true })} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);

        expect(screen.getByRole("dialog", { name: "New Message" })).toBeInTheDocument();
        expect(screen.queryByTestId("html-editor")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Discard draft" })).toBeInTheDocument();
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages", expect.objectContaining({ method: "POST" })),
        );
    });

    it("calls onClose from the minimized bar's Discard action without toggling minimize", async () => {
        const onClose = vi.fn();
        const onToggleMinimize = vi.fn();
        const user = userEvent.setup();
        render(<ComposeWindow session={session({ minimized: true })} onClose={onClose} onToggleMinimize={onToggleMinimize} />);

        await user.click(screen.getByRole("button", { name: "Discard draft" }));

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onToggleMinimize).not.toHaveBeenCalled();
    });

    it("toggles between the default and expanded size", async () => {
        mockCompose();
        const user = userEvent.setup();
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Expand" }));
        expect(screen.getByRole("button", { name: "Collapse" })).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Collapse" }));
        expect(screen.getByRole("button", { name: "Expand" })).toBeInTheDocument();
    });

    it("uploads an image via onUploadImage and resolves to the attachment's content URL.", async () => {
        mockCompose((url, init) =>
            url.startsWith("/api/mail/attachments/upload") && (init?.method ?? "GET") === "POST"
                ? jsonResponse(200, {
                      uid: "a1",
                      version: 0,
                      dateCreated: "2026-01-01T00:00:00.000Z",
                      dateModified: "2026-01-01T00:00:00.000Z",
                      messageUid: "m1",
                      folderUid: "f-drafts",
                      mailboxUid: "mb1",
                      filename: "photo.png",
                      mimeType: "image/png",
                      sizeBytes: 6,
                      isInline: false,
                  })
                : undefined,
        );
        const user = userEvent.setup();
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

        await user.click(screen.getByText("fake-upload-image"));

        await waitFor(() => expect(screen.getByTestId("upload-result")).toHaveTextContent("/api/mail/attachments/a1/content"));
    });

    it("resolves to null and shows an error when the image upload fails.", async () => {
        mockCompose((url, init) =>
            url.startsWith("/api/mail/attachments/upload") && (init?.method ?? "GET") === "POST" ? jsonResponse(500, { message: "too large" }) : undefined,
        );
        const user = userEvent.setup();
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

        await user.click(screen.getByText("fake-upload-image"));

        await waitFor(() => expect(screen.getByTestId("upload-result")).toHaveTextContent("null"));
        expect(await screen.findByText("too large")).toBeInTheDocument();
    });

    it("resolves to null and shows a generic error when the image upload fails with a non-API error.", async () => {
        mockCompose((url, init) => {
            if (url.startsWith("/api/mail/attachments/upload") && (init?.method ?? "GET") === "POST") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

        await user.click(screen.getByText("fake-upload-image"));

        expect(await screen.findByText("Could not upload image.")).toBeInTheDocument();
    });

    it("resolves to null and shows an error when an image is uploaded before the draft has loaded.", async () => {
        let resolveDraft: (() => void) | undefined;
        mockCompose((url, init) => {
            if (url === "/api/mail/messages" && (init?.method ?? "GET") === "POST") {
                return new Promise((resolve) => {
                    resolveDraft = () => resolve(jsonResponse(200, draft));
                });
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
        await waitFor(() => expect(resolveDraft).toBeDefined());

        await user.click(screen.getByText("fake-upload-image"));

        await waitFor(() => expect(screen.getByTestId("upload-result")).toHaveTextContent("null"));
        expect(await screen.findByText("Please wait for the draft to finish loading before inserting an image.")).toBeInTheDocument();
        resolveDraft!();
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
    });

    it("resizes wider/taller when the corner handle is dragged up and to the left.", async () => {
        mockCompose();
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
        const dialog = await screen.findByRole("dialog", { name: "New Message" });
        vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({
            width: 480,
            height: 520,
            top: 0,
            left: 0,
            right: 480,
            bottom: 520,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        });

        act(() => { fireEvent.pointerDown(screen.getByRole("separator", { name: "Resize" }), { clientX: 500, clientY: 500 }); });
        act(() => { fireEvent.pointerMove(window, { clientX: 450, clientY: 470 }); });

        expect(dialog.style.width).toBe("530px");
        expect(dialog.style.height).toBe("550px");

        act(() => { fireEvent.pointerUp(window); });
        act(() => { fireEvent.pointerMove(window, { clientX: 400, clientY: 400 }); });
        // A move after pointerup shouldn't change anything further — the drag session already ended.
        expect(dialog.style.width).toBe("530px");
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
    });

    it("resizing from the left edge only changes width; from the top edge only changes height.", async () => {
        mockCompose();
        const { container } = render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
        const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
        vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({
            width: 480,
            height: 520,
            top: 0,
            left: 0,
            right: 480,
            bottom: 520,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        });

        const [topHandle, leftHandle] = container.querySelectorAll('[aria-hidden="true"]');
        act(() => { fireEvent.pointerDown(leftHandle, { clientX: 500, clientY: 500 }); });
        act(() => { fireEvent.pointerMove(window, { clientX: 480, clientY: 480 }); });
        expect(dialog.style.width).toBe("500px");
        expect(dialog.style.height).toBe("520px");
        act(() => { fireEvent.pointerUp(window); });

        act(() => { fireEvent.pointerDown(topHandle, { clientX: 500, clientY: 500 }); });
        act(() => { fireEvent.pointerMove(window, { clientX: 480, clientY: 480 }); });
        expect(dialog.style.height).toBe("540px");
        act(() => { fireEvent.pointerUp(window); });
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
    });

    it("clamps a resize to the minimum width/height.", async () => {
        mockCompose();
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
        const dialog = await screen.findByRole("dialog", { name: "New Message" });
        vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({
            width: 480,
            height: 520,
            top: 0,
            left: 0,
            right: 480,
            bottom: 520,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        });

        act(() => { fireEvent.pointerDown(screen.getByRole("separator", { name: "Resize" }), { clientX: 500, clientY: 500 }); });
        act(() => { fireEvent.pointerMove(window, { clientX: 5000, clientY: 5000 }); });

        expect(dialog.style.width).toBe("320px");
        expect(dialog.style.height).toBe("320px");
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
    });

    it("resets manual sizing back to a preset when Expand/Collapse is clicked afterward.", async () => {
        mockCompose();
        const user = userEvent.setup();
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
        const dialog = await screen.findByRole("dialog", { name: "New Message" });
        vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({
            width: 480,
            height: 520,
            top: 0,
            left: 0,
            right: 480,
            bottom: 520,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        });

        act(() => { fireEvent.pointerDown(screen.getByRole("separator", { name: "Resize" }), { clientX: 500, clientY: 500 }); });
        act(() => { fireEvent.pointerMove(window, { clientX: 450, clientY: 470 }); });
        act(() => { fireEvent.pointerUp(window); });
        expect(dialog.style.width).toBe("530px");

        await user.click(screen.getByRole("button", { name: "Expand" }));

        expect(dialog.style.width).toBe("");
        expect(dialog.className).toContain("w-[720px]");
    });

    describe("on mobile", () => {
        it("renders full-screen, ignoring expanded/manualSize, and hides the resize handles and Expand/Collapse button", async () => {
            mockMatchMedia(true);
            mockCompose();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            const dialog = await screen.findByRole("dialog", { name: "New Message" });

            expect(dialog.className).toContain("fixed inset-0 w-full h-full rounded-none");
            expect(dialog.className).not.toContain("w-[480px]");
            expect(screen.queryByRole("separator", { name: "Resize" })).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Expand" })).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Collapse" })).not.toBeInTheDocument();
            // Minimize/Close stay available — minimizing is still meaningful full-screen (see
            // ComposeContext's mobile session-visibility logic).
            expect(screen.getByRole("button", { name: "Minimize" })).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
        });
    });

    describe("scheduled send", () => {
        function futureLocalValue(hoursFromNow = 24): string {
            const future = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
            return new Date(future.getTime() - future.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
        }

        it("opens the schedule picker via the 'Send later' caret, closed by default", async () => {
            mockCompose();
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send later" })).not.toBeDisabled());

            expect(screen.queryByLabelText("Send at")).not.toBeInTheDocument();
            await user.click(screen.getByRole("button", { name: "Send later" }));
            expect(screen.getByLabelText("Send at")).toBeInTheDocument();
        });

        it("closes the picker on an outside click, without scheduling anything", async () => {
            const fetchMock = mockCompose();
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send later" })).not.toBeDisabled());

            await user.click(screen.getByRole("button", { name: "Send later" }));
            expect(screen.getByLabelText("Send at")).toBeInTheDocument();

            await user.click(document.body);
            expect(screen.queryByLabelText("Send at")).not.toBeInTheDocument();
            expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/send"))).toBe(false);
        });

        it("requires at least one recipient before scheduling, and closes the picker either way", async () => {
            mockCompose();
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send later" })).not.toBeDisabled());

            await user.click(screen.getByRole("button", { name: "Send later" }));
            await user.type(screen.getByLabelText("Send at"), futureLocalValue());
            await user.click(screen.getAllByRole("button", { name: "Send later" })[1]);

            expect(await screen.findByText("At least one recipient is required.")).toBeInTheDocument();
            expect(screen.queryByLabelText("Send at")).not.toBeInTheDocument();
        });

        it("assembles the draft, sends it with scheduledSendTime, and closes the window", async () => {
            const fetchMock = mockCompose((url, init) => {
                const method = init?.method ?? "GET";
                if (url === "/api/mail/compose/m1/assemble" && method === "POST") return jsonResponse(200, draft);
                if (url === "/api/mail/messages/m1/send" && method === "POST") return jsonResponse(200, draft);
                return undefined;
            });
            const onClose = vi.fn();
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={onClose} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send later" })).not.toBeDisabled());

            await user.type(screen.getByLabelText("To"), "b@example.com");
            await user.click(screen.getByRole("button", { name: "Send later" }));
            await user.type(screen.getByLabelText("Send at"), futureLocalValue());
            await user.click(screen.getAllByRole("button", { name: "Send later" })[1]);

            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith("/api/mail/compose/m1/assemble", expect.objectContaining({ method: "POST" })),
            );
            await waitFor(() => expect(onClose).toHaveBeenCalled());
            expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/mail/messages/m1" && (init as RequestInit)?.method === "PUT")).toBe(false);
            const sendCall = fetchMock.mock.calls.find(([url, init]) => url === "/api/mail/messages/m1/send" && (init as RequestInit)?.method === "POST")!;
            expect(new Date(JSON.parse((sendCall[1] as RequestInit).body as string).scheduledSendTime).getTime()).toBeGreaterThan(Date.now());
        });

        it("also sets requestReceipt before scheduling when the checkbox is checked", async () => {
            const fetchMock = mockCompose((url, init) => {
                const method = init?.method ?? "GET";
                if (url === "/api/mail/compose/m1/assemble" && method === "POST") return jsonResponse(200, draft);
                if (url === "/api/mail/messages/m1" && method === "PUT") {
                    const body = JSON.parse(init!.body as string);
                    return jsonResponse(200, { ...draft, ...body });
                }
                if (url === "/api/mail/messages/m1/send" && method === "POST") return jsonResponse(200, draft);
                return undefined;
            });
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send later" })).not.toBeDisabled());

            await user.type(screen.getByLabelText("To"), "b@example.com");
            await user.click(screen.getByLabelText("Request a read receipt"));
            await user.click(screen.getByRole("button", { name: "Send later" }));
            await user.type(screen.getByLabelText("Send at"), futureLocalValue());
            await user.click(screen.getAllByRole("button", { name: "Send later" })[1]);

            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith(
                    "/api/mail/messages/m1",
                    expect.objectContaining({ body: JSON.stringify({ uid: "m1", version: 0, requestReceipt: true }) }),
                ),
            );
        });

        it("shows an error message when assembling fails", async () => {
            mockCompose((url, init) =>
                url === "/api/mail/compose/m1/assemble" && (init?.method ?? "GET") === "POST"
                    ? jsonResponse(500, { message: "assemble failed" })
                    : undefined,
            );
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send later" })).not.toBeDisabled());

            await user.type(screen.getByLabelText("To"), "b@example.com");
            await user.click(screen.getByRole("button", { name: "Send later" }));
            await user.type(screen.getByLabelText("Send at"), futureLocalValue());
            await user.click(screen.getAllByRole("button", { name: "Send later" })[1]);

            await waitFor(() => expect(toasts()).toHaveLength(1));
            expect(toasts()[0].message).toContain("assemble failed");
        });

        it("shows a generic error message when scheduling fails with a non-API error", async () => {
            mockCompose((url, init) => {
                const method = init?.method ?? "GET";
                if (url === "/api/mail/compose/m1/assemble" && method === "POST") return jsonResponse(200, draft);
                if (url === "/api/mail/messages/m1/send" && method === "POST") throw new TypeError("network down");
                if (url === "/api/mail/messages/m1") return jsonResponse(200, draft);
                return undefined;
            });
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send later" })).not.toBeDisabled());

            await user.type(screen.getByLabelText("To"), "b@example.com");
            await user.click(screen.getByRole("button", { name: "Send later" }));
            await user.type(screen.getByLabelText("Send at"), futureLocalValue());
            await user.click(screen.getAllByRole("button", { name: "Send later" })[1]);

            await waitFor(() => expect(toasts()).toHaveLength(1));
            expect(toasts()[0].message).toContain("Could not schedule this message.");
        });
    });

    describe("draft autosave and discard", () => {
        function deferredResponse() {
            let resolve!: (value: Response) => void;
            const promise = new Promise<Response>((res) => {
                resolve = res;
            });
            return { promise, resolve };
        }

        function assembleCalls(fetchMock: ReturnType<typeof mockFetch>) {
            return fetchMock.mock.calls
                .filter(([url]) => url === "/api/mail/compose/m1/assemble")
                .map(([, init]) => JSON.parse((init as RequestInit).body as string));
        }

        /** mockCompose plus an assemble endpoint that bumps the draft's version, and DELETE support. */
        function mockSaves(extra?: (url: string, init?: RequestInit) => Response | undefined) {
            let version = 0;
            return mockCompose((url, init) => {
                const custom = extra?.(url, init);
                if (custom) return custom;
                const method = init?.method ?? "GET";
                if (url === "/api/mail/compose/m1/assemble" && method === "POST") {
                    version += 1;
                    return jsonResponse(200, { ...draft, version });
                }
                if (url.startsWith("/api/mail/messages/m1?") && method === "DELETE") return new Response(null, { status: 204 });
                if (url === "/api/mail/messages/m1/send" && method === "POST") return jsonResponse(200, draft);
                return undefined;
            });
        }

        async function renderReady(props: Partial<React.ComponentProps<typeof ComposeWindow>> = {}) {
            const onClose = vi.fn();
            const utils = render(<ComposeWindow session={session()} onClose={onClose} onToggleMinimize={vi.fn()} autosaveDelayMs={5} {...props} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
            await screen.findByTestId("html-editor");
            return { ...utils, onClose };
        }

        it("autosaves recipients, subject, and body after a pause in editing, and doesn't re-save unchanged content", async () => {
            const fetchMock = mockSaves();
            await renderReady();

            fireEvent.change(screen.getByLabelText("To"), { target: { value: "b@example.com" } });
            fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Draft subject" } });
            fireEvent.change(screen.getByTestId("html-editor"), { target: { value: "<p>work in progress</p>" } });

            await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Draft saved"));
            expect(assembleCalls(fetchMock)).toEqual([
                { to: [{ address: "b@example.com" }], cc: [], bcc: [], subject: "Draft subject", html: "<p>work in progress</p>" },
            ]);
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(assembleCalls(fetchMock)).toHaveLength(1);
        });

        it("shows 'Saving…' while a save is in flight and reports a failed save", async () => {
            const save = deferredResponse();
            mockSaves((url) => (url === "/api/mail/compose/m1/assemble" ? (save.promise as unknown as Response) : undefined));
            await renderReady();

            fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Hi" } });
            await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saving…"));
            save.resolve(jsonResponse(500, { message: "nope" }));

            await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Couldn't save draft"));
        });

        it("never autosaves a message the user asked to encrypt, and confirms before Close throws it away", async () => {
            getUnlockedKeys.mockReturnValue({
                masterKey: new Uint8Array(32),
                encryptionPrivateKey: fakeEncryptionKey,
                encryptionCertDer: fakeCertDer("alice-encrypt"),
                encryptionFingerprint: "fp-own",
            });
            const fetchMock = mockSaves();
            const user = userEvent.setup();
            const { onClose } = await renderReady();

            await user.click(screen.getByLabelText("Encrypt this message"));
            fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Secret plans" } });
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(assembleCalls(fetchMock)).toHaveLength(0);

            await user.click(screen.getByRole("button", { name: "Close" }));
            expect(await screen.findByText(/Encrypted messages aren't saved as drafts/)).toBeInTheDocument();
            expect(onClose).not.toHaveBeenCalled();
        });

        it("Close saves unsaved edits immediately, closing once they're saved, and keeps the draft", async () => {
            const fetchMock = mockSaves();
            const { onClose } = await renderReady({ autosaveDelayMs: 60_000 });

            fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Keep me" } });
            fireEvent.click(screen.getByRole("button", { name: "Close" }));

            expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
            expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
            await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
            expect(assembleCalls(fetchMock)).toEqual([expect.objectContaining({ subject: "Keep me" })]);
            expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);
        });

        it("Close doesn't save again when the edits are already saved", async () => {
            const fetchMock = mockSaves();
            const { onClose, unmount } = await renderReady();

            fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Saved already" } });
            await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Draft saved"));
            fireEvent.click(screen.getByRole("button", { name: "Close" }));
            unmount();

            expect(onClose).toHaveBeenCalledTimes(1);
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(assembleCalls(fetchMock)).toHaveLength(1);
        });

        it("saves a pending edit right away when the window unmounts before the debounce fires", async () => {
            const fetchMock = mockSaves();
            const { unmount } = await renderReady({ autosaveDelayMs: 60_000 });

            fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Unmounted" } });
            unmount();

            await waitFor(() => expect(assembleCalls(fetchMock)).toEqual([expect.objectContaining({ subject: "Unmounted" })]));
        });

        it("Discard draft asks for confirmation when there's content; Keep editing (or Escape) keeps everything", async () => {
            const fetchMock = mockSaves();
            const user = userEvent.setup();
            const { onClose } = await renderReady({ autosaveDelayMs: 60_000 });

            fireEvent.change(screen.getByTestId("html-editor"), { target: { value: "<p>don't lose me</p>" } });
            await user.click(screen.getByRole("button", { name: "Discard draft" }));
            expect(await screen.findByRole("dialog", { name: "Discard this draft?" })).toBeInTheDocument();

            await user.click(screen.getByRole("button", { name: "Keep editing" }));
            expect(screen.queryByRole("dialog", { name: "Discard this draft?" })).not.toBeInTheDocument();

            await user.click(screen.getByRole("button", { name: "Discard draft" }));
            await screen.findByRole("dialog", { name: "Discard this draft?" });
            await user.keyboard("{Escape}");
            await waitFor(() => expect(screen.queryByRole("dialog", { name: "Discard this draft?" })).not.toBeInTheDocument());

            expect(onClose).not.toHaveBeenCalled();
            expect(screen.getByTestId("html-editor")).toHaveValue("<p>don't lose me</p>");
            expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);
        });

        it("confirmed Discard deletes the server draft (after any in-flight save, with its new version) and closes", async () => {
            const save = deferredResponse();
            const fetchMock = mockSaves((url) => (url === "/api/mail/compose/m1/assemble" ? (save.promise as unknown as Response) : undefined));
            const user = userEvent.setup();
            const { onClose } = await renderReady();

            fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Throwaway" } });
            await waitFor(() => expect(assembleCalls(fetchMock)).toHaveLength(1));
            await user.click(screen.getByRole("button", { name: "Discard draft" }));
            await user.click(await screen.findByRole("button", { name: "Discard" }));

            expect(onClose).not.toHaveBeenCalled();
            expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);
            save.resolve(jsonResponse(200, { ...draft, version: 3 }));
            await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m1?version=3", expect.objectContaining({ method: "DELETE" })));
            await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
        });

        it("the minimized bar's Discard also confirms when there's content", async () => {
            mockSaves();
            const onClose = vi.fn();
            const { rerender } = render(<ComposeWindow session={session()} onClose={onClose} onToggleMinimize={vi.fn()} autosaveDelayMs={60_000} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
            fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Minimized content" } });

            rerender(<ComposeWindow session={session({ minimized: true })} onClose={onClose} onToggleMinimize={vi.fn()} autosaveDelayMs={60_000} />);
            fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));

            expect(await screen.findByRole("dialog", { name: "Discard this draft?" })).toBeInTheDocument();
            expect(onClose).not.toHaveBeenCalled();
        });

        it("sending waits for an autosave already on the wire, so it can't overwrite the assembled message", async () => {
            const save = deferredResponse();
            let first = true;
            const fetchMock = mockSaves((url) => {
                if (url === "/api/mail/compose/m1/assemble" && first) {
                    first = false;
                    return save.promise as unknown as Response;
                }
                return undefined;
            });
            const { onClose } = await renderReady();

            fireEvent.change(screen.getByLabelText("To"), { target: { value: "b@example.com" } });
            await waitFor(() => expect(assembleCalls(fetchMock)).toHaveLength(1));
            fireEvent.click(screen.getByRole("button", { name: "Send" }));
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(assembleCalls(fetchMock)).toHaveLength(1);

            save.resolve(jsonResponse(200, { ...draft, version: 1 }));
            await waitFor(() => expect(onClose).toHaveBeenCalled());
            expect(assembleCalls(fetchMock)).toHaveLength(2);
        });

        it("doesn't autosave a plaintext copy over the assembled message when the send itself then fails", async () => {
            const fetchMock = mockSaves((url) => (url === "/api/mail/messages/m1/send" ? jsonResponse(500, { message: "relay down" }) : undefined));
            await renderReady();

            fireEvent.change(screen.getByLabelText("To"), { target: { value: "b@example.com" } });
            fireEvent.click(screen.getByRole("button", { name: "Send" }));

            await waitFor(() => expect(toasts()).toHaveLength(1));
            expect(toasts()[0].message).toContain("relay down");
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(assembleCalls(fetchMock)).toHaveLength(1);
        });
    });

    describe("signature resolution", () => {
        it("seeds the editor with the mailbox's isDefaultForNewMessages signature for a fresh compose", async () => {
            mockCompose((url) =>
                url.startsWith("/api/mail/mail-signatures")
                    ? jsonResponse(200, [
                          signatureFixture({ uid: "sig-reply", isDefaultForReplyForward: true }),
                          signatureFixture({ uid: "sig-new", isDefaultForNewMessages: true }),
                      ])
                    : undefined,
            );
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);

            expect(await screen.findByTestId("html-editor")).toHaveValue("<p></p><p>Best,<br>Jane</p>");
        });

        it("seeds the editor with the mailbox's isDefaultForReplyForward signature, plus the quoted content, for a reply/forward", async () => {
            mockCompose((url) =>
                url.startsWith("/api/mail/mail-signatures")
                    ? jsonResponse(200, [
                          signatureFixture({ uid: "sig-new", isDefaultForNewMessages: true }),
                          signatureFixture({ uid: "sig-reply", isDefaultForReplyForward: true }),
                      ])
                    : undefined,
            );
            render(
                <ComposeWindow
                    session={session({ signatureContext: "reply_forward", initialQuotedHtml: "<blockquote>Hi</blockquote>" })}
                    onClose={vi.fn()}
                    onToggleMinimize={vi.fn()}
                />,
            );

            expect(await screen.findByTestId("html-editor")).toHaveValue("<p></p><p>Best,<br>Jane</p><p></p><p></p><blockquote>Hi</blockquote>");
        });

        it("seeds the editor with just the quoted content when the mailbox has no matching default signature", async () => {
            mockCompose((url) =>
                url.startsWith("/api/mail/mail-signatures") ? jsonResponse(200, [signatureFixture()]) : undefined,
            );
            render(
                <ComposeWindow
                    session={session({ signatureContext: "reply_forward", initialQuotedHtml: "<blockquote>Hi</blockquote>" })}
                    onClose={vi.fn()}
                    onToggleMinimize={vi.fn()}
                />,
            );

            expect(await screen.findByTestId("html-editor")).toHaveValue("<p></p><p></p><blockquote>Hi</blockquote>");
        });

        it("falls back to just the quoted content when the signature list fails to load", async () => {
            mockCompose((url) => (url.startsWith("/api/mail/mail-signatures") ? jsonResponse(500, { message: "boom" }) : undefined));
            render(
                <ComposeWindow
                    session={session({ initialQuotedHtml: "<blockquote>Hi</blockquote>" })}
                    onClose={vi.fn()}
                    onToggleMinimize={vi.fn()}
                />,
            );

            expect(await screen.findByTestId("html-editor")).toHaveValue("<p></p><p></p><blockquote>Hi</blockquote>");
        });

        it("does not mount the editor until the signature lookup resolves", async () => {
            let resolveSignatures: (() => void) | undefined;
            mockCompose((url) => {
                if (url.startsWith("/api/mail/mail-signatures")) {
                    return new Promise((resolve) => {
                        resolveSignatures = () => resolve(jsonResponse(200, []));
                    });
                }
                return undefined;
            });
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);

            await waitFor(() => expect(resolveSignatures).toBeDefined());
            expect(screen.queryByTestId("html-editor")).not.toBeInTheDocument();

            resolveSignatures!();
            expect(await screen.findByTestId("html-editor")).toBeInTheDocument();
        });
    });

    describe("initial focus and reply layout", () => {
        function renderSession(overrides: Partial<ComposeSession>, props: Partial<React.ComponentProps<typeof ComposeWindow>> = {}) {
            const onClose = vi.fn();
            const utils = render(<ComposeWindow session={session(overrides)} onClose={onClose} onToggleMinimize={vi.fn()} {...props} />);
            return { ...utils, onClose };
        }

        const replySession = {
            signatureContext: "reply_forward" as const,
            initialTo: "sender@example.com",
            initialSubject: "Re: Hi",
            initialQuotedHtml: "<blockquote>Hi</blockquote>",
        };

        it("starts a reply in the body, at its top above the quote, not in To", async () => {
            mockCompose();
            renderSession(replySession);

            const editor = await screen.findByTestId("html-editor");
            expect(editor).toHaveValue("<p></p><p></p><blockquote>Hi</blockquote>");
            expect(editor).toHaveAttribute("data-autofocus-start", "true");
            expect(screen.getByLabelText("To")).not.toHaveFocus();
            expect(screen.getByLabelText("Subject")).not.toHaveFocus();
        });

        it("starts a forward in the body too, even with no recipient yet", async () => {
            mockCompose();
            renderSession({ signatureContext: "reply_forward", initialQuotedHtml: "<p>---------- Forwarded message ----------</p>" });

            expect(await screen.findByTestId("html-editor")).toHaveAttribute("data-autofocus-start", "true");
            expect(screen.getByLabelText("To")).not.toHaveFocus();
        });

        it("starts a new message in To, without focusing the body", async () => {
            mockCompose();
            renderSession({});

            expect(await screen.findByTestId("html-editor")).toHaveAttribute("data-autofocus-start", "false");
            expect(screen.getByLabelText("To")).toHaveFocus();
        });

        it("starts a new message with prefilled recipients (the Contacts Email action) in Subject", async () => {
            mockCompose();
            renderSession({ initialTo: "bob@example.com" });

            expect(await screen.findByTestId("html-editor")).toHaveAttribute("data-autofocus-start", "false");
            expect(screen.getByLabelText("Subject")).toHaveFocus();
        });

        it("neither moves the caret again nor reseeds the body when a minimized reply is restored", async () => {
            mockCompose();
            const { rerender } = renderSession(replySession);
            fireEvent.change(await screen.findByTestId("html-editor"), { target: { value: "<p>Thanks!</p><blockquote>Hi</blockquote>" } });

            rerender(<ComposeWindow session={session({ ...replySession, minimized: true })} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            expect(screen.queryByTestId("html-editor")).not.toBeInTheDocument();
            rerender(<ComposeWindow session={session(replySession)} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);

            const editor = await screen.findByTestId("html-editor");
            expect(editor).toHaveValue("<p>Thanks!</p><blockquote>Hi</blockquote>");
            expect(editor).toHaveAttribute("data-autofocus-start", "false");
        });

        it("keeps focus out of To when a minimized new message is restored", async () => {
            mockCompose();
            const { rerender } = renderSession({});
            await screen.findByTestId("html-editor");
            act(() => screen.getByLabelText("To").blur());

            rerender(<ComposeWindow session={session({ minimized: true })} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            rerender(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);

            await screen.findByTestId("html-editor");
            expect(screen.getByLabelText("To")).not.toHaveFocus();
        });

        it("treats an untouched reply as unchanged: no autosave, and Close discards it without asking", async () => {
            const fetchMock = mockCompose((url, init) => {
                if (url === "/api/mail/compose/m1/assemble") return jsonResponse(200, draft);
                return init?.method === "DELETE" ? new Response(null, { status: 204 }) : undefined;
            });
            const user = userEvent.setup();
            const { onClose } = renderSession(replySession, { autosaveDelayMs: 5 });
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
            await screen.findByTestId("html-editor");

            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(fetchMock.mock.calls.filter(([url]) => url === "/api/mail/compose/m1/assemble")).toHaveLength(0);

            await user.click(screen.getByRole("button", { name: "Close" }));
            expect(onClose).toHaveBeenCalledTimes(1);
            expect(screen.queryByRole("dialog", { name: "Discard this draft?" })).not.toBeInTheDocument();
        });

        it("takes the editor's own serialization of an untouched body as the baseline, so it still isn't autosaved or confirmed", async () => {
            const fetchMock = mockCompose((url, init) => {
                if (url === "/api/mail/compose/m1/assemble") return jsonResponse(200, draft);
                return init?.method === "DELETE" ? new Response(null, { status: 204 }) : undefined;
            });
            const user = userEvent.setup();
            const { onClose } = renderSession(replySession, { autosaveDelayMs: 5 });
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

            await user.click(await screen.findByRole("button", { name: "fake-initialize" }));
            expect(screen.getByTestId("html-editor")).toHaveValue("<p></p><p></p><blockquote><p>Hi</p></blockquote>");
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(fetchMock.mock.calls.filter(([url]) => url === "/api/mail/compose/m1/assemble")).toHaveLength(0);

            await user.click(screen.getByRole("button", { name: "Close" }));
            expect(onClose).toHaveBeenCalledTimes(1);
            expect(screen.queryByRole("dialog", { name: "Discard this draft?" })).not.toBeInTheDocument();
        });

        it("keeps an edit made before the editor reported its serialization", async () => {
            mockCompose();
            const user = userEvent.setup();
            renderSession(replySession, { autosaveDelayMs: 60_000 });
            const editor = await screen.findByTestId("html-editor");

            fireEvent.change(editor, { target: { value: "<p>Typed</p><blockquote>Hi</blockquote>" } });
            await user.click(screen.getByRole("button", { name: "fake-initialize" }));

            expect(editor).toHaveValue("<p>Typed</p><blockquote>Hi</blockquote>");
            await user.click(screen.getByRole("button", { name: "Close" }));
            expect(await screen.findByRole("dialog", { name: "Couldn't save this draft" })).toBeInTheDocument();
        });

        it("changes nothing when the editor serializes the body exactly as seeded", async () => {
            mockCompose();
            const user = userEvent.setup();
            renderSession({ signatureContext: "reply_forward", initialQuotedHtml: "<p>quoted</p>" });

            await user.click(await screen.findByRole("button", { name: "fake-initialize" }));
            expect(screen.getByTestId("html-editor")).toHaveValue("<p></p><p></p><p>quoted</p>");
        });

        it("starts a reply to an encrypted message with Encrypt requested, and never autosaves it", async () => {
            getUnlockedKeys.mockReturnValue({
                masterKey: new Uint8Array(32),
                encryptionPrivateKey: fakeEncryptionKey,
                encryptionCertDer: fakeCertDer("alice-encrypt"),
                encryptionFingerprint: "fp-own",
            });
            const fetchMock = mockCompose((url) => (url === "/api/mail/compose/m1/assemble" ? jsonResponse(200, draft) : undefined));
            renderSession({ ...replySession, initialQuotedHtml: "<blockquote>Decrypted secret</blockquote>", initialEncrypt: true }, { autosaveDelayMs: 5 });

            expect(await screen.findByLabelText("Encrypt this message")).toBeChecked();
            fireEvent.change(await screen.findByTestId("html-editor"), { target: { value: "<p>More</p><blockquote>Decrypted secret</blockquote>" } });
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(fetchMock.mock.calls.filter(([url]) => url === "/api/mail/compose/m1/assemble")).toHaveLength(0);
        });
    });

    describe("recipient autocomplete", () => {
        const janeContact = { displayName: "Jane (personal)", address: "Jane@Example.com", kind: "contact" };
        const janeDirectory = { displayName: "Jane Doe", address: "jane@example.com", kind: "user" };
        const janetRoom = { displayName: "Janet Room", address: "janet@example.com", kind: "room" };

        function mockSuggestions(extra?: (url: string, init?: RequestInit) => Response | undefined) {
            return mockCompose((url, init) => {
                const custom = extra?.(url, init);
                if (custom) return custom;
                if (url.startsWith("/api/mail/directory/contacts?")) return jsonResponse(200, [janeContact]);
                if (url.startsWith("/api/mail/directory?")) return jsonResponse(200, [janeDirectory, janetRoom]);
                return undefined;
            });
        }

        it("suggests the sender's contacts first, then the directory, and sends a picked recipient with its name", async () => {
            const fetchMock = mockSuggestions((url, init) => {
                const method = init?.method ?? "GET";
                if (url === "/api/mail/compose/m1/assemble" && method === "POST") return jsonResponse(200, draft);
                if (url === "/api/mail/messages/m1/send" && method === "POST") return jsonResponse(200, draft);
                return undefined;
            });
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

            await user.type(screen.getByLabelText("To"), "ja");
            const listbox = await screen.findByRole("listbox", { name: "To suggestions" });
            expect(within(listbox).getAllByRole("option").map((option) => option.textContent)).toEqual([
                "Jane (personal)Jane@Example.comContact",
                "Janet Roomjanet@example.comRoom",
            ]);
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/directory/contacts?q=ja&limit=8&mailboxUid=mb1", expect.anything());
            await user.keyboard("{ArrowDown}{Enter}");
            expect(recipientChips("To")).toEqual(["Janet Room <janet@example.com>"]);

            await user.type(screen.getByLabelText("To"), "bob@example.com");
            await user.click(screen.getByRole("button", { name: "Send" }));
            await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/mail/compose/m1/assemble", expect.objectContaining({ method: "POST" })));
            const assembleCall = fetchMock.mock.calls.find((call) => call[0] === "/api/mail/compose/m1/assemble")!;
            expect(JSON.parse((assembleCall[1] as RequestInit).body as string).to).toEqual([
                { address: "janet@example.com", displayName: "Janet Room" },
                { address: "bob@example.com" },
            ]);
        });

        it("suggests in Cc and Bcc too, and looks a picked recipient's keys up without waiting for a blur", async () => {
            const fetchMock = mockSuggestions((url) => {
                if (url.startsWith("/api/mail/mailboxes/mb1/keys/lookup")) return jsonResponse(200, { keys: [] });
                if (url === "/api/system/encryption-policy") return jsonResponse(200, { encryptSameOrg: "optional", encryptFederated: "optional", encryptExternal: "optional" });
                return undefined;
            });
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
            await user.click(screen.getByRole("button", { name: "Cc Bcc" }));

            await user.type(screen.getByLabelText("Cc"), "jan");
            await user.click(within(await screen.findByRole("listbox", { name: "Cc suggestions" })).getByRole("option", { name: /Janet Room/ }));
            expect(recipientChips("Cc")).toEqual(["Janet Room <janet@example.com>"]);
            expect(screen.getByLabelText("Cc")).toHaveFocus();
            await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/keys/lookup") && String(url).includes("janet%40example.com"))).toBe(true));

            await user.type(screen.getByLabelText("Bcc"), "ja");
            await screen.findByRole("listbox", { name: "Bcc suggestions" });
            await user.keyboard("{Tab}");
            expect(recipientChips("Bcc")).toEqual(['"Jane (personal)" <Jane@Example.com>']);
        });
    });

    describe("end-to-end encryption/signing", () => {
        const mailboxFixture = {
            uid: "mb1",
            version: 0,
            dateCreated: "2026-01-01T00:00:00.000Z",
            dateModified: "2026-01-01T00:00:00.000Z",
            ownerUserUid: "u1",
            primarySmtpAddress: "u1@example.com",
            aliasAddresses: [],
            displayName: "User One",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
            encryptPreference: { preferEncrypt: "mutual" as const },
        };
        const automaticPolicy = { encryptSameOrg: "automatic", encryptFederated: "automatic", encryptExternal: "automatic" };

        function mockCryptoEndpoints(
            extra?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined,
            overrides?: { mailbox?: unknown; policy?: unknown },
        ) {
            return mockCompose((url, init) => {
                const custom = extra?.(url, init);
                if (custom) return custom;
                const method = init?.method ?? "GET";
                if (url === "/api/mail/mailboxes/mb1") return jsonResponse(200, overrides?.mailbox ?? mailboxFixture);
                if (url === "/api/system/encryption-policy") return jsonResponse(200, overrides?.policy ?? automaticPolicy);
                if (url === "/api/mail/compose/m1/assemble-raw" && method === "POST") return jsonResponse(200, draft);
                if (url === "/api/mail/messages/m1/send" && method === "POST") return jsonResponse(200, draft);
                return undefined;
            });
        }

        it("does not update state after unmounting before the mailbox/policy fetch settles", async () => {
            let resolveMailbox: ((v: Response) => void) | undefined;
            let resolvePolicy: ((v: Response) => void) | undefined;
            mockCompose((url) => {
                if (url === "/api/mail/mailboxes/mb1") return new Promise((resolve) => (resolveMailbox = resolve));
                if (url === "/api/system/encryption-policy") return new Promise((resolve) => (resolvePolicy = resolve));
                return undefined;
            });
            const { unmount } = render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);

            await waitFor(() => expect(resolveMailbox).toBeDefined());
            await waitFor(() => expect(resolvePolicy).toBeDefined());
            unmount();
            resolveMailbox!(jsonResponse(200, mailboxFixture));
            resolvePolicy!(jsonResponse(200, automaticPolicy));
            // No assertion beyond "this doesn't throw/warn" - see KeyEnrollmentGate.test.tsx's identical
            // pattern for why: a regression here surfaces as a React console.error, not an exception.
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        it("shows a 'supports encryption' badge for a recipient once compose-time discovery resolves on blur", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            mockCryptoEndpoints((url) => {
                if (url.startsWith("/api/mail/mailboxes/mb1/keys/lookup")) {
                    return jsonResponse(200, {
                        keys: [
                            {
                                publicKey: toBase64(fakeCertDer("bob-encrypt")),
                                type: "x509",
                                useType: "encrypt",
                                fingerprint: "fp-bob",
                                notBefore: Date.now() - 1000,
                                notAfter: Date.now() + 1_000_000,
                            },
                        ],
                        encryptPreference: { preferEncrypt: "mutual" },
                    });
                }
                return undefined;
            });
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

            await user.type(screen.getByLabelText("To"), "bob@example.com");
            await user.tab();

            expect(await screen.findByText(/bob@example\.com supports encryption/)).toBeInTheDocument();
        });

        it("shows a 'no encryption key found' badge for a recipient discovery couldn't find keys for", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            mockCryptoEndpoints((url) => (url.startsWith("/api/mail/mailboxes/mb1/keys/lookup") ? jsonResponse(200, { keys: [] }) : undefined));
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

            await user.type(screen.getByLabelText("To"), "nokey@example.com");
            await user.tab();

            expect(await screen.findByText(/nokey@example\.com no encryption key found/)).toBeInTheDocument();
        });

        it("runs discovery for a Bcc recipient too, on its own blur", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            mockCryptoEndpoints((url) => (url.startsWith("/api/mail/mailboxes/mb1/keys/lookup") ? jsonResponse(200, { keys: [] }) : undefined));
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

            await user.click(screen.getByRole("button", { name: "Cc Bcc" }));
            await user.type(screen.getByLabelText("Bcc"), "hidden@example.com");
            await user.tab();

            expect(await screen.findByText(/hidden@example\.com no encryption key found/)).toBeInTheDocument();
        });

        it("does not re-run discovery for an address already looked up", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            const fetchMock = mockCryptoEndpoints((url) =>
                url.startsWith("/api/mail/mailboxes/mb1/keys/lookup") ? jsonResponse(200, { keys: [] }) : undefined,
            );
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

            await user.type(screen.getByLabelText("To"), "nokey@example.com");
            await user.tab();
            await screen.findByText(/no encryption key found/);
            const lookupCallsAfterFirstBlur = fetchMock.mock.calls.filter(([url]) => String(url).includes("/keys/lookup")).length;

            await user.click(screen.getByLabelText("To"));
            await user.tab();
            await new Promise((resolve) => setTimeout(resolve, 0));
            const lookupCallsAfterSecondBlur = fetchMock.mock.calls.filter(([url]) => String(url).includes("/keys/lookup")).length;
            expect(lookupCallsAfterSecondBlur).toBe(lookupCallsAfterFirstBlur);
        });

        it("does not run discovery on blur before the mailbox/policy fetch has resolved", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            const fetchMock = mockCompose((url) => {
                if (url === "/api/mail/mailboxes/mb1") return new Promise(() => undefined);
                if (url === "/api/system/encryption-policy") return new Promise(() => undefined);
                return undefined;
            });
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByLabelText("To")).toBeInTheDocument());

            await user.type(screen.getByLabelText("To"), "bob@example.com");
            await user.tab();
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/keys/lookup"))).toBe(false);
        });

        it("does not render Sign/Encrypt checkboxes when no key has been unlocked this session", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            mockCryptoEndpoints();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

            expect(screen.queryByLabelText(/Digitally sign/)).not.toBeInTheDocument();
            expect(screen.queryByLabelText(/Encrypt this message/)).not.toBeInTheDocument();
        });

        it("shows an unlock affordance when a key is enrolled but not unlocked, and reveals the toggles once unlocked", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            requestUnlock.mockImplementation(async () => {
                getUnlockedKeys.mockReturnValue({
                    masterKey: new Uint8Array(32),
                    encryptionPrivateKey: fakeEncryptionKey,
                    encryptionCertDer: fakeCertDer("alice-encrypt"),
                    encryptionFingerprint: "fp-encrypt",
                });
            });
            mockCryptoEndpoints(undefined, {
                mailbox: {
                    ...mailboxFixture,
                    keys: [
                        {
                            publicKey: "base64cert",
                            type: "x509",
                            useType: "encrypt",
                            fingerprint: "fp-encrypt",
                            notBefore: Date.now() - 1000,
                            notAfter: Date.now() + 1_000_000,
                        },
                    ],
                },
            });
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

            const unlockLink = await screen.findByText("Unlock to sign or encrypt this message");
            expect(screen.queryByLabelText(/Encrypt this message/)).not.toBeInTheDocument();

            await user.click(unlockLink);

            expect(requestUnlock).toHaveBeenCalledWith(
                "mb1",
                expect.arrayContaining([expect.objectContaining({ fingerprint: "fp-encrypt" })]),
            );
            expect(await screen.findByLabelText(/Encrypt this message/)).toBeInTheDocument();
            expect(screen.queryByText("Unlock to sign or encrypt this message")).not.toBeInTheDocument();
        });

        it("dismisses the unlock affordance's click without revealing the toggles when the unlock dialog is cancelled", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            requestUnlock.mockRejectedValue(new Error("Unlock cancelled."));
            mockCryptoEndpoints(undefined, {
                mailbox: {
                    ...mailboxFixture,
                    keys: [
                        {
                            publicKey: "base64cert",
                            type: "x509",
                            useType: "encrypt",
                            fingerprint: "fp-encrypt",
                            notBefore: Date.now() - 1000,
                            notAfter: Date.now() + 1_000_000,
                        },
                    ],
                },
            });
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

            await user.click(await screen.findByText("Unlock to sign or encrypt this message"));

            expect(await screen.findByText("Unlock to sign or encrypt this message")).toBeInTheDocument();
            expect(screen.queryByLabelText(/Encrypt this message/)).not.toBeInTheDocument();
        });

        it("sends a detached-signed message when a signing key is unlocked, with the real Subject visible in the outer envelope", async () => {
            getUnlockedKeys.mockReturnValue({
                masterKey: new Uint8Array(32),
                signingPrivateKey: fakeSigningKey,
                signingCertDer: fakeCertDer("alice-sign"),
                signingFingerprint: "fp-sign",
            });
            buildSignedOnlyMessage.mockResolvedValue({
                contentType: 'multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="b1"',
                body: "SIGNED-BODY",
            });
            const fetchMock = mockCryptoEndpoints();
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

            expect(await screen.findByLabelText("Digitally sign this message")).toBeChecked();
            await user.type(screen.getByLabelText("To"), "b@example.com");
            await user.click(screen.getByRole("button", { name: "Cc Bcc" }));
            await user.type(screen.getByLabelText("Cc"), "cc@example.com");
            await user.type(screen.getByLabelText("Subject"), "Hi there");
            await user.type(screen.getByTestId("html-editor"), "<p>hello</p>");
            await user.click(screen.getByRole("button", { name: "Send" }));

            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith("/api/mail/compose/m1/assemble-raw", expect.objectContaining({ method: "POST" })),
            );
            expect(buildSignedOnlyMessage).toHaveBeenCalledWith(
                'text/html; charset="utf-8"',
                "<p>hello</p>",
                expect.objectContaining({
                    from: expect.stringContaining("u1@example.com"),
                    to: "b@example.com",
                    cc: "cc@example.com",
                    subject: "Hi there",
                }),
                fakeCertDer("alice-sign"),
                fakeSigningKey,
            );
            const call = fetchMock.mock.calls.find((c) => c[0] === "/api/mail/compose/m1/assemble-raw")!;
            const body = JSON.parse((call[1] as RequestInit).body as string);
            // Signing alone never obscures the Subject - only an encrypted message's outer envelope does.
            expect(body.subject).toBe("Hi there");
            expect(body.rawMime).toContain("Subject: Hi there");
            expect(body.rawMime).toContain("multipart/signed");
            expect(body.rawMime).toContain("SIGNED-BODY");
        });

        it("does not sign when the Sign checkbox is unchecked", async () => {
            getUnlockedKeys.mockReturnValue({
                masterKey: new Uint8Array(32),
                signingPrivateKey: fakeSigningKey,
                signingCertDer: fakeCertDer("alice-sign"),
                signingFingerprint: "fp-sign",
            });
            const fetchMock = mockCompose((url, init) => {
                const method = init?.method ?? "GET";
                if (url === "/api/mail/mailboxes/mb1") return jsonResponse(200, mailboxFixture);
                if (url === "/api/system/encryption-policy") return jsonResponse(200, automaticPolicy);
                if (url === "/api/mail/compose/m1/assemble" && method === "POST") return jsonResponse(200, draft);
                if (url === "/api/mail/messages/m1/send" && method === "POST") return jsonResponse(200, draft);
                return undefined;
            });
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

            await user.click(await screen.findByLabelText("Digitally sign this message"));
            await user.type(screen.getByLabelText("To"), "b@example.com");
            await user.click(screen.getByRole("button", { name: "Send" }));

            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith("/api/mail/compose/m1/assemble", expect.objectContaining({ method: "POST" })),
            );
        });

        it("auto-encrypts (without checking the box) when both parties prefer mutual and policy is automatic, and always encrypts to self", async () => {
            const ownEncryptCert = fakeCertDer("alice-encrypt");
            const bobCert = fakeCertDer("bob-encrypt");
            getUnlockedKeys.mockReturnValue({
                masterKey: new Uint8Array(32),
                encryptionPrivateKey: fakeEncryptionKey,
                encryptionCertDer: ownEncryptCert,
                encryptionFingerprint: "fp-own",
            });
            buildEncryptedMessage.mockResolvedValue({
                contentType: 'application/pkcs7-mime; smime-type="enveloped-data"; name="smime.p7m"',
                additionalHeaders: { "Content-Transfer-Encoding": "base64" },
                body: "ENCRYPTED-BASE64-BODY",
            });
            const fetchMock = mockCryptoEndpoints((url) => {
                if (url.startsWith("/api/mail/mailboxes/mb1/keys/lookup")) {
                    return jsonResponse(200, {
                        keys: [
                            {
                                publicKey: toBase64(bobCert),
                                type: "x509",
                                useType: "encrypt",
                                fingerprint: "fp-bob",
                                notBefore: Date.now() - 1000,
                                notAfter: Date.now() + 1_000_000,
                            },
                        ],
                        encryptPreference: { preferEncrypt: "mutual" },
                    });
                }
                return undefined;
            });
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

            expect(await screen.findByLabelText("Encrypt this message")).not.toBeChecked();
            await user.type(screen.getByLabelText("To"), "bob@example.com");
            await user.type(screen.getByLabelText("Subject"), "Secret");
            await user.type(screen.getByTestId("html-editor"), "<p>hello</p>");
            await user.click(screen.getByRole("button", { name: "Send" }));

            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith("/api/mail/compose/m1/assemble-raw", expect.objectContaining({ method: "POST" })),
            );
            expect(buildEncryptedMessage).toHaveBeenCalledTimes(1);
            const [bodyContentType, bodyText, protectedHeaders, outerHeaders, recipientCertDers, signing] =
                buildEncryptedMessage.mock.calls[0];
            expect(bodyContentType).toBe('text/html; charset="utf-8"');
            expect(bodyText).toBe("<p>hello</p>");
            expect(protectedHeaders).toMatchObject({ subject: "Secret", to: "bob@example.com" });
            expect(outerHeaders).toMatchObject({ subject: "[...]", to: "bob@example.com" });
            // Per the spec's "Encrypt to Self": the sender's own cert MUST be included alongside the
            // recipient's, so the sender's own stored Sent copy is decryptable too.
            expect((recipientCertDers as Uint8Array[]).map((c) => toBase64(c))).toEqual([toBase64(ownEncryptCert), toBase64(bobCert)]);
            expect(signing).toBeUndefined();
            const call = fetchMock.mock.calls.find((c) => c[0] === "/api/mail/compose/m1/assemble-raw")!;
            const body = JSON.parse((call[1] as RequestInit).body as string);
            // RFC 9788 hcp_baseline: the outer envelope's own Subject is obscured even though the real
            // one travels protected inside the encrypted payload.
            expect(body.subject).toBe("[...]");
            expect(body.rawMime).toContain("application/pkcs7-mime");
            expect(body.rawMime).toContain('smime-type="enveloped-data"');
            expect(body.rawMime).not.toContain("Secret");
        });

        it("fails open: a failed key lookup is not 'must encrypt', so a message nobody asked to encrypt just sends plaintext (no block)", async () => {
            const own = fakeCertDer("alice-encrypt");
            getUnlockedKeys.mockReturnValue({
                masterKey: new Uint8Array(32),
                encryptionPrivateKey: fakeEncryptionKey,
                encryptionCertDer: own,
                encryptionFingerprint: "fp-own",
            });
            const fetchMock = mockCryptoEndpoints((url, init) => {
                const method = init?.method ?? "GET";
                if (url.startsWith("/api/mail/mailboxes/mb1/keys/lookup")) return jsonResponse(500, { message: "lookup boom" });
                if (url === "/api/mail/compose/m1/assemble" && method === "POST") return jsonResponse(200, draft);
                return undefined;
            });
            const user = userEvent.setup();
            const onClose = vi.fn();
            render(<ComposeWindow session={session()} onClose={onClose} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

            await user.type(screen.getByLabelText("To"), "bob@example.com");
            await user.click(screen.getByRole("button", { name: "Send" }));

            // Nothing asked for encryption and the recipient's key could not be checked: unknown counts as unencrypted, so it goes.
            await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
            expect(screen.queryByText(/encryption keys couldn't be checked/)).not.toBeInTheDocument();
            await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/mail/compose/m1/assemble", expect.objectContaining({ method: "POST" })));
            expect(toasts().filter((toast) => toast.kind === "error" || toast.kind === "warning")).toEqual([]);
        });

        it("still sends plaintext after a failed key lookup when no policy tier auto-encrypts and encryption wasn't requested", async () => {
            getUnlockedKeys.mockReturnValue({
                masterKey: new Uint8Array(32),
                encryptionPrivateKey: fakeEncryptionKey,
                encryptionCertDer: fakeCertDer("alice-encrypt"),
                encryptionFingerprint: "fp-own",
            });
            const fetchMock = mockCryptoEndpoints(
                (url, init) => {
                    const method = init?.method ?? "GET";
                    if (url.startsWith("/api/mail/mailboxes/mb1/keys/lookup")) return jsonResponse(500, { message: "lookup boom" });
                    if (url === "/api/mail/compose/m1/assemble" && method === "POST") return jsonResponse(200, draft);
                    return undefined;
                },
                { policy: { encryptSameOrg: "optional", encryptFederated: "optional", encryptExternal: "prohibited" } },
            );
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

            await user.type(screen.getByLabelText("To"), "bob@example.com");
            await user.click(screen.getByRole("button", { name: "Send" }));

            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith("/api/mail/compose/m1/assemble", expect.objectContaining({ method: "POST" })),
            );
        });

        it("blocks and offers to send in plaintext when a recipient has no usable encryption key and the user requests encryption", async () => {
            getUnlockedKeys.mockReturnValue({
                masterKey: new Uint8Array(32),
                encryptionPrivateKey: fakeEncryptionKey,
                encryptionCertDer: fakeCertDer("alice-encrypt"),
                encryptionFingerprint: "fp-own",
            });
            const fetchMock = mockCryptoEndpoints((url, init) => {
                const method = init?.method ?? "GET";
                if (url.startsWith("/api/mail/mailboxes/mb1/keys/lookup")) return jsonResponse(200, { keys: [] });
                if (url === "/api/mail/compose/m1/assemble" && method === "POST") return jsonResponse(200, draft);
                return undefined;
            });
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

            await user.type(screen.getByLabelText("To"), "nokey1@example.com, nokey2@example.com");
            await user.click(await screen.findByLabelText("Encrypt this message"));
            await user.click(screen.getByRole("button", { name: "Send" }));

            const blockedAlert = await screen.findByText(/can.t be encrypted for everyone/);
            expect(blockedAlert.textContent).toContain("has no encryption key on file");
            expect(blockedAlert.textContent).toContain("these recipients");
            expect(screen.queryByRole("dialog")).toBeInTheDocument(); // still open, not sent
            expect(fetchMock.mock.calls.some(([url]) => url === "/api/mail/compose/m1/assemble-raw")).toBe(false);

            await user.click(screen.getByRole("button", { name: "Send without encryption" }));
            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith("/api/mail/compose/m1/assemble", expect.objectContaining({ method: "POST" })),
            );
        });

        it("explains why, per-recipient, when policy prohibits encryption for that recipient's tier", async () => {
            getUnlockedKeys.mockReturnValue({
                masterKey: new Uint8Array(32),
                encryptionPrivateKey: fakeEncryptionKey,
                encryptionCertDer: fakeCertDer("alice-encrypt"),
                encryptionFingerprint: "fp-own",
            });
            mockCryptoEndpoints(
                (url) => (url.startsWith("/api/mail/mailboxes/mb1/keys/lookup") ? jsonResponse(200, { keys: [] }) : undefined),
                { policy: { encryptSameOrg: "automatic", encryptFederated: "prohibited", encryptExternal: "prohibited" } },
            );
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

            await user.type(screen.getByLabelText("To"), "far@other.com");
            await user.click(await screen.findByLabelText("Encrypt this message"));
            await user.click(screen.getByRole("button", { name: "Send" }));

            const blockedAlert = await screen.findByText(/can.t be encrypted for everyone/);
            expect(blockedAlert.textContent).toContain("organization's encryption policy");
            expect(blockedAlert.textContent).toContain("this recipient");
        });

        it("runs discovery but still sends plaintext when policy is optional and the recipient doesn't prefer mutual encryption", async () => {
            getUnlockedKeys.mockReturnValue({
                masterKey: new Uint8Array(32),
                encryptionPrivateKey: fakeEncryptionKey,
                encryptionCertDer: fakeCertDer("alice-encrypt"),
                encryptionFingerprint: "fp-own",
            });
            const fetchMock = mockCryptoEndpoints(
                (url, init) => {
                    const method = init?.method ?? "GET";
                    if (url.startsWith("/api/mail/mailboxes/mb1/keys/lookup")) {
                        return jsonResponse(200, {
                            keys: [
                                {
                                    publicKey: toBase64(fakeCertDer("bob-encrypt")),
                                    type: "x509",
                                    useType: "encrypt",
                                    fingerprint: "fp-bob",
                                    notBefore: Date.now() - 1000,
                                    notAfter: Date.now() + 1_000_000,
                                },
                            ],
                            encryptPreference: { preferEncrypt: "nopreference" },
                        });
                    }
                    if (url === "/api/mail/compose/m1/assemble" && method === "POST") return jsonResponse(200, draft);
                    return undefined;
                },
                { policy: { encryptSameOrg: "optional", encryptFederated: "optional", encryptExternal: "optional" } },
            );
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

            expect(await screen.findByLabelText("Encrypt this message")).not.toBeChecked();
            await user.type(screen.getByLabelText("To"), "bob@example.com");
            await user.click(screen.getByRole("button", { name: "Send" }));

            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith("/api/mail/compose/m1/assemble", expect.objectContaining({ method: "POST" })),
            );
            expect(buildEncryptedMessage).not.toHaveBeenCalled();
        });

        it("uses the bare address as the From header when the mailbox has no display name", async () => {
            getUnlockedKeys.mockReturnValue({
                masterKey: new Uint8Array(32),
                signingPrivateKey: fakeSigningKey,
                signingCertDer: fakeCertDer("alice-sign"),
                signingFingerprint: "fp-sign",
            });
            buildSignedOnlyMessage.mockResolvedValue({ contentType: 'multipart/signed; boundary="b1"', body: "SIGNED-BODY" });
            mockCryptoEndpoints(undefined, { mailbox: { ...mailboxFixture, displayName: "" } });
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

            await user.type(screen.getByLabelText("To"), "b@example.com");
            await user.click(screen.getByRole("button", { name: "Send" }));

            await waitFor(() => expect(buildSignedOnlyMessage).toHaveBeenCalled());
            expect(buildSignedOnlyMessage).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                expect.objectContaining({ from: "u1@example.com" }),
                expect.anything(),
                expect.anything(),
            );
        });

        it("falls back to a localhost Message-ID domain when the mailbox address has no domain part", async () => {
            getUnlockedKeys.mockReturnValue({
                masterKey: new Uint8Array(32),
                signingPrivateKey: fakeSigningKey,
                signingCertDer: fakeCertDer("alice-sign"),
                signingFingerprint: "fp-sign",
            });
            buildSignedOnlyMessage.mockResolvedValue({ contentType: 'multipart/signed; boundary="b1"', body: "SIGNED-BODY" });
            mockCryptoEndpoints(undefined, { mailbox: { ...mailboxFixture, primarySmtpAddress: "localuser" } });
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

            await user.type(screen.getByLabelText("To"), "b@example.com");
            await user.click(screen.getByRole("button", { name: "Send" }));

            await waitFor(() => expect(buildSignedOnlyMessage).toHaveBeenCalled());
            expect(buildSignedOnlyMessage).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                expect.objectContaining({ messageId: expect.stringMatching(/@localhost>$/) }),
                expect.anything(),
                expect.anything(),
            );
        });

        it("rejects signing/encrypting a message that already has an attachment, with a clear explanation", async () => {
            getUnlockedKeys.mockReturnValue({
                masterKey: new Uint8Array(32),
                signingPrivateKey: fakeSigningKey,
                signingCertDer: fakeCertDer("alice-sign"),
                signingFingerprint: "fp-sign",
            });
            const attachment = {
                uid: "a1",
                version: 0,
                dateCreated: "2026-01-01T00:00:00.000Z",
                dateModified: "2026-01-01T00:00:00.000Z",
                messageUid: "m1",
                folderUid: "f-drafts",
                mailboxUid: "mb1",
                filename: "photo.png",
                mimeType: "image/png",
                sizeBytes: 10,
                isInline: false,
            };
            mockCryptoEndpoints((url, init) => {
                const method = init?.method ?? "GET";
                if (url.startsWith("/api/mail/attachments/upload") && method === "POST") return jsonResponse(200, attachment);
                return undefined;
            });
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByLabelText("Attach files")).not.toBeDisabled());

            const file = new File(["pixels"], "photo.png", { type: "image/png" });
            await user.upload(screen.getByLabelText("Attach files"), file);
            await waitFor(() => expect(screen.getByText("photo.png")).toBeInTheDocument());

            await user.type(screen.getByLabelText("To"), "b@example.com");
            await user.click(screen.getByRole("button", { name: "Send" }));

            expect(await screen.findByText(/cannot include file attachments yet/)).toBeInTheDocument();
        });

        it("also blocks a scheduled send when encryption is requested but not every recipient has a usable key", async () => {
            getUnlockedKeys.mockReturnValue({
                masterKey: new Uint8Array(32),
                encryptionPrivateKey: fakeEncryptionKey,
                encryptionCertDer: fakeCertDer("alice-encrypt"),
                encryptionFingerprint: "fp-own",
            });
            const fetchMock = mockCryptoEndpoints((url) => (url.startsWith("/api/mail/mailboxes/mb1/keys/lookup") ? jsonResponse(200, { keys: [] }) : undefined));
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send later" })).not.toBeDisabled());

            await user.type(screen.getByLabelText("To"), "nokey@example.com");
            await user.click(await screen.findByLabelText("Encrypt this message"));
            await user.click(screen.getByRole("button", { name: "Send later" }));
            const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
            await user.type(screen.getByLabelText("Send at"), new Date(future.getTime() - future.getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
            await user.click(screen.getAllByRole("button", { name: "Send later" })[1]);

            expect(await screen.findByText(/can.t be encrypted for everyone/)).toBeInTheDocument();
            expect(fetchMock.mock.calls.some(([url]) => url === "/api/mail/compose/m1/assemble-raw")).toBe(false);
        });

        const activeKey = (useType: "sign" | "encrypt") => ({
            publicKey: "base64cert",
            type: "x509",
            useType,
            fingerprint: `fp-${useType}`,
            notBefore: Date.now() - 1000,
            notAfter: Date.now() + 1_000_000,
        });
        const signingKeys = {
            masterKey: new Uint8Array(32),
            signingPrivateKey: fakeSigningKey,
            signingCertDer: fakeCertDer("alice-sign"),
            signingFingerprint: "fp-sign",
        };
        const encryptionKeys = {
            masterKey: new Uint8Array(32),
            encryptionPrivateKey: fakeEncryptionKey,
            encryptionCertDer: fakeCertDer("alice-encrypt"),
            encryptionFingerprint: "fp-own",
        };
        function futureLocal(): string {
            const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
            return new Date(future.getTime() - future.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
        }

        it("re-renders when this mailbox's keys lock, and blocks (never downgrades) a send the Sign toggle was on for", async () => {
            getUnlockedKeys.mockReturnValue(signingKeys);
            requestUnlock.mockReset();
            requestUnlock.mockResolvedValue(signingKeys);
            const fetchMock = mockCryptoEndpoints(
                (url, init) => (url === "/api/mail/compose/m1/assemble" && init?.method === "POST" ? jsonResponse(200, draft) : undefined),
                { mailbox: { ...mailboxFixture, keys: [activeKey("sign")] } },
            );
            const user = userEvent.setup();
            const onClose = vi.fn();
            render(<ComposeWindow session={session()} onClose={onClose} onToggleMinimize={vi.fn()} autosaveDelayMs={60_000} />);
            expect(await screen.findByLabelText("Digitally sign this message")).toBeChecked();
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

            getUnlockedKeys.mockReturnValue(undefined);
            emitKeySession("other-mailbox", "locked");
            expect(screen.getByLabelText("Digitally sign this message")).toBeInTheDocument();
            emitKeySession("mb1", "locked");
            expect(screen.queryByLabelText("Digitally sign this message")).not.toBeInTheDocument();
            expect(screen.getByText("Unlock to sign or encrypt this message")).toBeInTheDocument();

            await user.type(screen.getByLabelText("To"), "b@example.com");
            await user.click(screen.getByRole("button", { name: "Send" }));

            expect(await screen.findByText(/can't be signed right now/)).toBeInTheDocument();
            expect(requestUnlock).toHaveBeenCalledWith("mb1", expect.arrayContaining([expect.objectContaining({ useType: "sign" })]));
            expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/mail/compose/"))).toBe(false);
            expect(onClose).not.toHaveBeenCalled();

            await user.click(screen.getByRole("button", { name: "Send without signing or encryption" }));
            await waitFor(() => expect(onClose).toHaveBeenCalled());
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/compose/m1/assemble", expect.objectContaining({ method: "POST" }));
            expect(buildSignedOnlyMessage).not.toHaveBeenCalled();
        });

        it("unsubscribes from key-session events on unmount", async () => {
            mockCryptoEndpoints();
            const { unmount } = render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(keySessionListeners.size).toBe(1));
            unmount();
            expect(keySessionListeners.size).toBe(0);
        });

        it("blocks an encrypted send once the encryption key has locked, re-prompting the unlock dialog", async () => {
            getUnlockedKeys.mockReturnValue(encryptionKeys);
            requestUnlock.mockReset();
            requestUnlock.mockRejectedValue(new Error("Unlock cancelled."));
            const fetchMock = mockCryptoEndpoints((url) => (url.startsWith("/api/mail/mailboxes/mb1/keys/lookup") ? jsonResponse(200, { keys: [] }) : undefined), {
                mailbox: { ...mailboxFixture, keys: [activeKey("encrypt")] },
            });
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} autosaveDelayMs={60_000} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
            await user.click(await screen.findByLabelText("Encrypt this message"));

            getUnlockedKeys.mockReturnValue(undefined);
            emitKeySession("mb1", "locked");
            await user.type(screen.getByLabelText("To"), "b@example.com");
            await user.click(screen.getByRole("button", { name: "Send" }));

            expect(await screen.findByText(/can't be encrypted right now - your encryption key is locked/)).toBeInTheDocument();
            expect(requestUnlock).toHaveBeenCalledWith("mb1", expect.arrayContaining([expect.objectContaining({ useType: "encrypt" })]));
            expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/mail/compose/"))).toBe(false);
        });

        it("fails open when the encryption policy couldn't be loaded: nothing is blocked and the message sends unencrypted", async () => {
            getUnlockedKeys.mockReturnValue(encryptionKeys);
            const fetchMock = mockCryptoEndpoints((url, init) => {
                if (url === "/api/system/encryption-policy") return jsonResponse(500, { message: "policy down" });
                if (url === "/api/mail/compose/m1/assemble" && init?.method === "POST") return jsonResponse(200, draft);
                return undefined;
            });
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} autosaveDelayMs={60_000} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

            await user.type(screen.getByLabelText("To"), "b@example.com");
            await user.click(screen.getByRole("button", { name: "Send" }));

            await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/mail/compose/m1/assemble", expect.objectContaining({ method: "POST" })));
            expect(screen.queryByText(/encryption settings couldn't be loaded/)).not.toBeInTheDocument();
            expect(requestUnlock).not.toHaveBeenCalled();
            expect(buildEncryptedMessage).not.toHaveBeenCalled();
            expect(toasts().filter((toast) => toast.kind === "error" || toast.kind === "warning")).toEqual([]);
        });

        it("blocks an encrypted message with Bcc recipients rather than disclosing them in the shared envelope", async () => {
            getUnlockedKeys.mockReturnValue(encryptionKeys);
            const fetchMock = mockCryptoEndpoints((url, init) => {
                if (url.startsWith("/api/mail/mailboxes/mb1/keys/lookup")) {
                    return jsonResponse(200, { keys: [{ ...activeKey("encrypt"), publicKey: toBase64(fakeCertDer("peer")) }], encryptPreference: { preferEncrypt: "mutual" } });
                }
                if (url === "/api/mail/compose/m1/assemble" && init?.method === "POST") return jsonResponse(200, draft);
                return undefined;
            });
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} autosaveDelayMs={60_000} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

            await user.type(screen.getByLabelText("To"), "bob@example.com");
            await user.click(screen.getByRole("button", { name: "Cc Bcc" }));
            await user.type(screen.getByLabelText("Bcc"), "hidden@example.com");
            await user.click(screen.getByRole("button", { name: "Send" }));

            // The recipients' keys are only looked up by the background send, so the refusal is a pop-up with the override as its action.
            await waitFor(() => expect(toasts()).toHaveLength(1));
            expect(toasts()[0].message).toContain("Bcc recipients can't be used with encrypted messages. Remove Bcc recipients or turn off encryption.");
            expect(buildEncryptedMessage).not.toHaveBeenCalled();
            expect(toasts()[0].actions.map((action) => action.label)).toEqual(["Send without encryption", "Open draft"]);

            await act(async () => toasts()[0].actions[0].onClick!());
            await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/mail/compose/m1/assemble", expect.objectContaining({ method: "POST" })));
            expect(buildEncryptedMessage).not.toHaveBeenCalled();
        });

        it("rejects signing a message whose body embeds an inline image", async () => {
            getUnlockedKeys.mockReturnValue(signingKeys);
            mockCryptoEndpoints();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} autosaveDelayMs={60_000} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

            fireEvent.change(screen.getByLabelText("To"), { target: { value: "b@example.com" } });
            fireEvent.change(await screen.findByTestId("html-editor"), { target: { value: '<p><img src="/api/mail/attachments/a1/content"></p>' } });
            fireEvent.click(screen.getByRole("button", { name: "Send" }));

            expect(await screen.findByText(/cannot include inline images yet/)).toBeInTheDocument();
            expect(buildSignedOnlyMessage).not.toHaveBeenCalled();
        });

        it("'Send without encryption' after a blocked scheduled send replays the schedule instead of sending immediately", async () => {
            getUnlockedKeys.mockReturnValue(encryptionKeys);
            const fetchMock = mockCryptoEndpoints((url, init) => {
                const method = init?.method ?? "GET";
                if (url.startsWith("/api/mail/mailboxes/mb1/keys/lookup")) return jsonResponse(200, { keys: [] });
                if (url === "/api/mail/compose/m1/assemble" && method === "POST") return jsonResponse(200, draft);
                if (url === "/api/mail/messages/m1/send" && method === "POST") return jsonResponse(200, draft);
                return undefined;
            });
            const onClose = vi.fn();
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={onClose} onToggleMinimize={vi.fn()} autosaveDelayMs={60_000} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send later" })).not.toBeDisabled());

            await user.type(screen.getByLabelText("To"), "nokey@example.com");
            await user.click(await screen.findByLabelText("Encrypt this message"));
            await user.click(screen.getByRole("button", { name: "Send later" }));
            await user.type(screen.getByLabelText("Send at"), futureLocal());
            await user.click(screen.getAllByRole("button", { name: "Send later" })[1]);
            await screen.findByText(/can.t be encrypted for everyone/);

            await user.click(screen.getByRole("button", { name: "Send without encryption" }));

            await waitFor(() => expect(onClose).toHaveBeenCalled());
            const sendCall = fetchMock.mock.calls.find(([url, init]) => url === "/api/mail/messages/m1/send" && (init as RequestInit | undefined)?.method === "POST")!;
            expect(new Date(JSON.parse((sendCall[1] as RequestInit).body as string).scheduledSendTime).getTime()).toBeGreaterThan(Date.now());
        });
    });
});

describe("ComposeWindow (round-4 fixes)", () => {
    const encryptKey = {
        publicKey: "base64cert",
        type: "x509",
        useType: "encrypt",
        fingerprint: "fp-encrypt",
        notBefore: Date.now() - 1000,
        notAfter: Date.now() + 1_000_000,
    };
    const signKey = { ...encryptKey, useType: "sign", fingerprint: "fp-sign" };
    const mailboxFixture = {
        uid: "mb1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        ownerUserUid: "u1",
        primarySmtpAddress: "u1@example.com",
        aliasAddresses: [],
        displayName: "User One",
        timezone: "UTC",
        quotaBytes: 1_000_000_000,
        usedBytes: 0,
        encryptPreference: { preferEncrypt: "mutual" as const },
    };
    const automaticPolicy = { encryptSameOrg: "automatic", encryptFederated: "automatic", encryptExternal: "automatic" };
    const mutualLookup = {
        keys: [{ ...encryptKey, publicKey: toBase64(fakeCertDer("bob-encrypt")), fingerprint: "fp-bob" }],
        encryptPreference: { preferEncrypt: "mutual" },
    };

    function deferred<T>() {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((res) => {
            resolve = res;
        });
        return { promise, resolve };
    }

    function callsTo(fetchMock: ReturnType<typeof mockFetch>, match: (url: string, method: string) => boolean) {
        return fetchMock.mock.calls.filter(([url, init]) => match(String(url), (init as RequestInit | undefined)?.method ?? "GET"));
    }
    const isAssemble = (url: string) => /^\/api\/mail\/compose\/[^/]+\/assemble$/.test(url);
    const isLookup = (url: string) => url.includes("/keys/lookup");

    /** mockCompose plus the mailbox/policy/send endpoints, an assemble that bumps the draft version, and DELETE. */
    function mockRound4(
        extra?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined,
        mailbox: Record<string, unknown> = mailboxFixture,
    ) {
        let version = 0;
        return mockCompose((url, init) => {
            const custom = extra?.(url, init);
            if (custom) return custom as Response;
            const method = init?.method ?? "GET";
            if (url === "/api/mail/mailboxes/mb1") return jsonResponse(200, mailbox);
            if (url === "/api/system/encryption-policy") return jsonResponse(200, automaticPolicy);
            if (isLookup(url)) return jsonResponse(200, { keys: [] });
            if (url === "/api/mail/compose/m1/assemble" && method === "POST") {
                version += 1;
                return jsonResponse(200, { ...draft, version });
            }
            if (url === "/api/mail/messages/m1/send" && method === "POST") return jsonResponse(200, draft);
            if (url.startsWith("/api/mail/messages/m1?") && method === "DELETE") return new Response(null, { status: 204 });
            return undefined;
        });
    }

    async function renderReady(props: Partial<React.ComponentProps<typeof ComposeWindow>> = {}) {
        const onClose = vi.fn();
        const utils = render(<ComposeWindow session={session()} onClose={onClose} onToggleMinimize={vi.fn()} autosaveDelayMs={60_000} {...props} />);
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
        await screen.findByTestId("html-editor");
        return { ...utils, onClose };
    }

    it("closes the moment Send is pressed - without waiting for the server - and keeps the draft", async () => {
        const send = deferred<Response>();
        const fetchMock = mockRound4((url, init) => (url === "/api/mail/messages/m1/send" && init?.method === "POST" ? send.promise : undefined), {
            ...mailboxFixture,
            keys: [],
        });
        getUnlockedKeys.mockReturnValue(undefined);
        const { onClose } = await renderReady();

        fireEvent.change(screen.getByLabelText("To"), { target: { value: "bob@example.com" } });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));

        // The request hasn't even been answered, and the window is already gone - the only feedback is the Outbox indicator.
        expect(onClose).toHaveBeenCalledTimes(1);
        await waitFor(() => expect(callsTo(fetchMock, (url, method) => url === "/api/mail/messages/m1/send" && method === "POST")).toHaveLength(1));
        expect(screen.queryByRole("button", { name: "Sending…" })).not.toBeInTheDocument();
        send.resolve(jsonResponse(202, { status: "queued", message: draft }));
        await waitFor(() => expect(isSendPending("m1")).toBe(false));
        expect(callsTo(fetchMock, (_url, method) => method === "DELETE")).toHaveLength(0);
        expect(toasts()).toEqual([]);
    });

    it("sends once however many times Send is pressed (a double click, the shortcut held down)", async () => {
        const fetchMock = mockRound4(undefined, { ...mailboxFixture, keys: [] });
        getUnlockedKeys.mockReturnValue(undefined);
        const { onClose } = await renderReady();

        fireEvent.change(screen.getByLabelText("To"), { target: { value: "bob@example.com" } });
        const send = screen.getByRole("button", { name: "Send" });
        fireEvent.click(send);
        fireEvent.click(send);
        fireEvent.click(send);

        await waitFor(() => expect(isSendPending("m1")).toBe(false));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(callsTo(fetchMock, (url, method) => url === "/api/mail/messages/m1/send" && method === "POST")).toHaveLength(1);
    });

    describe("recipient discovery and autosave", () => {
        it("looks up a reply's prefilled recipients without a blur, and never autosaves a message policy will encrypt", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            const fetchMock = mockRound4((url) => (isLookup(url) ? jsonResponse(200, mutualLookup) : undefined), { ...mailboxFixture, keys: [encryptKey] });
            const { onClose } = await renderReady({ session: session({ initialTo: "bob@example.com" }), autosaveDelayMs: 5 });

            expect(await screen.findByText(/bob@example\.com supports encryption/)).toBeInTheDocument();
            expect(callsTo(fetchMock, isLookup)).toHaveLength(1);
            fireEvent.change(screen.getByTestId("html-editor"), { target: { value: "<p>the secret</p>" } });
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(callsTo(fetchMock, isAssemble)).toHaveLength(0);

            fireEvent.click(screen.getByRole("button", { name: "Close" }));
            expect(await screen.findByText(/Encrypted messages aren't saved as drafts/)).toBeInTheDocument();
            expect(onClose).not.toHaveBeenCalled();
        });

        it("treats the same address typed with different casing across To/Cc as one recipient, so an asymmetric lookup outcome can't spuriously block auto-encryption", async () => {
            // Regression test: recipientStatuses used to be keyed by the raw, non-normalized address.
            // "Bob@Example.com" (To) and "bob@example.com" (Cc) named the same real mailbox but were
            // tracked as two independent cache entries; if the second's lookup failed or lagged while the
            // first succeeded, decideMessageEncryption()'s all-or-nothing check saw a spurious unresolved
            // recipient and denied auto-encryption even though the one real recipient's key was found. The
            // mocked lowercase lookup below answers with a failure specifically to prove the fixed code
            // never even calls it - the already-resolved, normalized cache entry is reused instead.
            getUnlockedKeys.mockReturnValue(undefined);
            const fetchMock = mockRound4((url) => {
                if (isLookup(url) && url.includes("Bob%40Example.com")) return jsonResponse(200, mutualLookup);
                if (isLookup(url) && url.includes("bob%40example.com")) return jsonResponse(500, { message: "boom" });
                return undefined;
            }, { ...mailboxFixture, keys: [encryptKey] });
            const { onClose } = await renderReady();

            fireEvent.change(screen.getByLabelText("To"), { target: { value: "Bob@Example.com" } });
            fireEvent.blur(screen.getByLabelText("To"));
            expect(await screen.findByText(/Bob@Example\.com supports encryption/)).toBeInTheDocument();

            fireEvent.click(screen.getByRole("button", { name: "Cc Bcc" }));
            fireEvent.change(screen.getByLabelText("Cc"), { target: { value: "bob@example.com" } });
            fireEvent.blur(screen.getByLabelText("Cc"));
            // Long enough for a (wrongly) re-triggered lookup to have landed if the fix regressed.
            await new Promise((resolve) => setTimeout(resolve, 30));

            expect(callsTo(fetchMock, isLookup)).toHaveLength(1);
            fireEvent.click(screen.getByRole("button", { name: "Close" }));
            expect(await screen.findByText(/Encrypted messages aren't saved as drafts/)).toBeInTheDocument();
            expect(onClose).not.toHaveBeenCalled();
        });

        it("saves the draft while a recipient's lookup is still pending (fail open), and keeps saving once it shows the message stays plaintext", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            const lookup = deferred<Response>();
            const fetchMock = mockRound4((url) => (isLookup(url) && url.includes("nokey") ? lookup.promise : undefined), {
                ...mailboxFixture,
                keys: [encryptKey],
            });
            await renderReady({ session: session({ initialTo: "nokey@example.com" }), autosaveDelayMs: 5 });

            await waitFor(() => expect(callsTo(fetchMock, isLookup)).toHaveLength(1));
            fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Plain" } });
            // Unknown is not held against the message: it is saved although the check has not answered.
            await waitFor(() => expect(callsTo(fetchMock, isAssemble)).toHaveLength(1));

            lookup.resolve(jsonResponse(200, { keys: [] }));
            fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Plain again" } });
            await waitFor(() => expect(callsTo(fetchMock, isAssemble)).toHaveLength(2));
            expect(screen.queryByText(/Encrypted messages aren't saved/)).not.toBeInTheDocument();
        });

        it("replaces the plaintext copy it already saved with an empty draft when a late answer shows the message must be encrypted, and stops saving", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            const lookup = deferred<Response>();
            const fetchMock = mockRound4((url) => (isLookup(url) ? lookup.promise : undefined), { ...mailboxFixture, keys: [encryptKey] });
            const { onClose } = await renderReady({ session: session({ initialTo: "bob@example.com" }), autosaveDelayMs: 5 });

            await waitFor(() => expect(callsTo(fetchMock, isLookup)).toHaveLength(1));
            fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Secret plan" } });
            await waitFor(() => expect(callsTo(fetchMock, isAssemble)).toHaveLength(1));
            expect(JSON.parse(String((callsTo(fetchMock, isAssemble)[0][1] as RequestInit).body)).subject).toBe("Secret plan");

            // The slow lookup answers: the recipient has a key, policy encrypts - the saved plaintext is replaced by a blank draft.
            lookup.resolve(jsonResponse(200, mutualLookup));
            await waitFor(() => expect(callsTo(fetchMock, isAssemble)).toHaveLength(2));
            expect(JSON.parse(String((callsTo(fetchMock, isAssemble)[1][1] as RequestInit).body))).toMatchObject({ subject: "", to: [], html: "" });

            fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Secret plan v2" } });
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(callsTo(fetchMock, isAssemble)).toHaveLength(2);
            fireEvent.click(screen.getByRole("button", { name: "Close" }));
            expect(await screen.findByText(/Encrypted messages aren't saved as drafts/)).toBeInTheDocument();
            expect(onClose).not.toHaveBeenCalled();
        });

        it("reports the copy it could not replace, once", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            const lookup = deferred<Response>();
            let assembles = 0;
            const fetchMock = mockRound4(
                (url, init) => {
                    if (isLookup(url)) return lookup.promise;
                    if (url === "/api/mail/compose/m1/assemble" && init?.method === "POST") {
                        assembles += 1;
                        return assembles === 1 ? jsonResponse(200, draft) : jsonResponse(500, { message: "nope" });
                    }
                    return undefined;
                },
                { ...mailboxFixture, keys: [encryptKey] },
            );
            await renderReady({ session: session({ initialTo: "bob@example.com" }), autosaveDelayMs: 5 });
            await waitFor(() => expect(callsTo(fetchMock, isLookup)).toHaveLength(1));
            fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Secret plan" } });
            await waitFor(() => expect(assembles).toBe(1));

            lookup.resolve(jsonResponse(200, mutualLookup));
            await waitFor(() => expect(toasts()).toHaveLength(1));
            expect(toasts()[0]).toMatchObject({ kind: "warning", title: "An earlier draft copy is still saved" });
        });

        it("fails open when the encryption policy is unavailable: a mailbox with an encryption key still saves its drafts", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            const fetchMock = mockRound4((url) => (url === "/api/system/encryption-policy" ? jsonResponse(500, { message: "down" }) : undefined), {
                ...mailboxFixture,
                keys: [encryptKey],
            });
            await renderReady({ autosaveDelayMs: 5 });

            fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Maybe secret" } });
            await waitFor(() => expect(callsTo(fetchMock, isAssemble)).toHaveLength(1));
            expect(screen.queryByText(/encryption settings/i)).not.toBeInTheDocument();
        });

        it("looks up a recipient blurred before the mailbox had loaded as soon as it does, and never twice while on the wire", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            const mailbox = deferred<Response>();
            const lookup = deferred<Response>();
            const fetchMock = mockRound4((url) => {
                if (url === "/api/mail/mailboxes/mb1") return mailbox.promise;
                if (isLookup(url)) return lookup.promise;
                return undefined;
            });
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} autosaveDelayMs={60_000} />);
            const to = await screen.findByLabelText("To");

            fireEvent.change(to, { target: { value: "late@example.com" } });
            fireEvent.blur(to);
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(callsTo(fetchMock, isLookup)).toHaveLength(0);

            mailbox.resolve(jsonResponse(200, mailboxFixture));
            await waitFor(() => expect(callsTo(fetchMock, isLookup)).toHaveLength(1));
            fireEvent.blur(to);
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(callsTo(fetchMock, isLookup)).toHaveLength(1);

            lookup.resolve(jsonResponse(200, { keys: [] }));
            expect(await screen.findByText(/late@example\.com no encryption key found/)).toBeInTheDocument();
        });

        it("drops a lookup made for the previous sender once From has changed", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            const oldLookup = deferred<Response>();
            let created = 0;
            mockRound4((url, init) => {
                const method = init?.method ?? "GET";
                if (url.startsWith("/api/mail/mailboxes?")) {
                    return jsonResponse(200, [mailboxFixture, { ...mailboxFixture, uid: "mb2", primarySmtpAddress: "two@example.com", displayName: "Two" }]);
                }
                if (url === "/api/mail/mailboxes/mb2") return jsonResponse(200, { ...mailboxFixture, uid: "mb2", primarySmtpAddress: "two@example.com" });
                if (url.startsWith("/api/mail/mailboxes/mb1/keys/lookup")) return oldLookup.promise;
                if (url.startsWith("/api/mail/mailboxes/mb2/keys/lookup")) return jsonResponse(200, { keys: [] });
                if (url === "/api/mail/messages" && method === "POST") {
                    created += 1;
                    return jsonResponse(200, { ...draft, uid: created === 1 ? "m1" : "m2" });
                }
                return undefined;
            });
            render(<ComposeWindow session={session()} trusted onClose={vi.fn()} onToggleMinimize={vi.fn()} autosaveDelayMs={60_000} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
            fireEvent.change(screen.getByLabelText("To"), { target: { value: "bob@example.com" } });
            fireEvent.blur(screen.getByLabelText("To"));

            fireEvent.change(await screen.findByLabelText("From"), { target: { value: "mb2" } });
            expect(await screen.findByText(/bob@example\.com no encryption key found/)).toBeInTheDocument();
            oldLookup.resolve(jsonResponse(200, mutualLookup));
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(screen.queryByText(/supports encryption/)).not.toBeInTheDocument();
        });
    });

    describe("keys read at send time", () => {
        it("refuses an auto-encrypted send when the mailbox's encryption key was never unlocked this session - a pop-up with Unlock, not a plaintext send", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            requestUnlock.mockReset();
            requestUnlock.mockRejectedValue(new Error("Unlock cancelled."));
            const unregister = registerUnlockOpener(async (mailboxUid, keys) => {
                await requestUnlock(mailboxUid, keys);
            });
            const fetchMock = mockRound4((url) => (isLookup(url) ? jsonResponse(200, mutualLookup) : undefined), { ...mailboxFixture, keys: [encryptKey] });
            await renderReady();

            fireEvent.change(screen.getByLabelText("To"), { target: { value: "bob@example.com" } });
            fireEvent.click(screen.getByRole("button", { name: "Send" }));

            await waitFor(() => expect(toasts()).toHaveLength(1));
            expect(toasts()[0].message).toMatch(/can't be encrypted right now - your encryption key is locked/);
            expect(toasts()[0].actions.map((action) => action.label)).toEqual(["Unlock", "Send without encryption", "Open draft"]);
            expect(callsTo(fetchMock, (url) => url.startsWith("/api/mail/compose/"))).toHaveLength(0);
            expect(buildEncryptedMessage).not.toHaveBeenCalled();

            await act(async () => toasts()[0].actions[0].onClick!());
            expect(requestUnlock).toHaveBeenCalledWith("mb1", [expect.objectContaining({ useType: "encrypt" })]);
            unregister();
        });

        it("re-reads the keys after the recipient lookups: a key object destroyed meanwhile blocks the signed send", async () => {
            const bothKeys = {
                masterKey: new Uint8Array(32),
                signingPrivateKey: fakeSigningKey,
                signingCertDer: fakeCertDer("alice-sign"),
                encryptionPrivateKey: fakeEncryptionKey,
                encryptionCertDer: fakeCertDer("alice-encrypt"),
            };
            getUnlockedKeys.mockReturnValue(bothKeys);
            requestUnlock.mockReset();
            requestUnlock.mockRejectedValue(new Error("Unlock cancelled."));
            const fetchMock = mockRound4(
                (url) => {
                    if (!isLookup(url)) return undefined;
                    // The session locks (destroying this key object) while the lookup is on the wire.
                    getUnlockedKeys.mockReturnValue({ ...bothKeys, destroyed: true });
                    return jsonResponse(200, { keys: [] });
                },
                { ...mailboxFixture, keys: [signKey, encryptKey] },
            );
            await renderReady();
            expect(await screen.findByLabelText("Digitally sign this message")).toBeChecked();

            fireEvent.change(screen.getByLabelText("To"), { target: { value: "bob@example.com" } });
            fireEvent.click(screen.getByRole("button", { name: "Send" }));

            await waitFor(() => expect(toasts()).toHaveLength(1));
            expect(toasts()[0].message).toMatch(/can't be signed right now/);
            expect(toasts()[0].actions.map((action) => action.label)).toContain("Unlock");
            expect(buildSignedOnlyMessage).not.toHaveBeenCalled();
            expect(callsTo(fetchMock, (url) => url.startsWith("/api/mail/compose/"))).toHaveLength(0);
        });
    });

    it("deletes a draft superseded by a From switch only after its in-flight autosave, retrying with the stored version", async () => {
        getUnlockedKeys.mockReturnValue(undefined);
        const save = deferred<Response>();
        let created = 0;
        const fetchMock = mockRound4((url, init) => {
            const method = init?.method ?? "GET";
            if (url.startsWith("/api/mail/mailboxes?")) {
                return jsonResponse(200, [mailboxFixture, { ...mailboxFixture, uid: "mb2", primarySmtpAddress: "two@example.com", displayName: "Two" }]);
            }
            if (url === "/api/mail/mailboxes/mb2") return jsonResponse(200, { ...mailboxFixture, uid: "mb2" });
            if (url === "/api/mail/messages" && method === "POST") {
                created += 1;
                return jsonResponse(200, { ...draft, uid: created === 1 ? "m1" : "m2" });
            }
            if (url === "/api/mail/compose/m1/assemble" && method === "POST") return save.promise;
            if (url === "/api/mail/messages/m1?version=5" && method === "DELETE") return jsonResponse(409, { message: "version conflict" });
            if (url === "/api/mail/messages/m1" && method === "GET") return jsonResponse(200, { ...draft, version: 7 });
            return undefined;
        }, { ...mailboxFixture, keys: [] });
        render(<ComposeWindow session={session()} trusted onClose={vi.fn()} onToggleMinimize={vi.fn()} autosaveDelayMs={5} />);
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
        await screen.findByTestId("html-editor");

        fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Switching" } });
        await waitFor(() => expect(callsTo(fetchMock, isAssemble)).toHaveLength(1));
        fireEvent.change(await screen.findByLabelText("From"), { target: { value: "mb2" } });
        await waitFor(() => expect(created).toBe(2));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(callsTo(fetchMock, (_url, method) => method === "DELETE")).toHaveLength(0);

        save.resolve(jsonResponse(200, { ...draft, version: 5 }));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m1?version=7", expect.objectContaining({ method: "DELETE" })));
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m1?version=5", expect.objectContaining({ method: "DELETE" }));
    });

    describe("leaving with unsaved edits", () => {
        function beforeUnload(): Event {
            const event = new Event("beforeunload", { cancelable: true });
            window.dispatchEvent(event);
            return event;
        }

        it("saves a pending edit straight away and asks the browser to confirm leaving; nothing to confirm once saved", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            const fetchMock = mockRound4(undefined, { ...mailboxFixture, keys: [] });
            await renderReady();

            expect(beforeUnload().defaultPrevented).toBe(false);
            fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Almost lost" } });
            expect(beforeUnload().defaultPrevented).toBe(true);
            await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Draft saved"));
            expect(callsTo(fetchMock, isAssemble)).toHaveLength(1);
            expect(beforeUnload().defaultPrevented).toBe(false);
        });

        it("confirms while a save is still on the wire; after Send the pending send is what asks, until the server has the message", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            const save = deferred<Response>();
            const send = deferred<Response>();
            mockRound4(
                (url, init) => {
                    if (url === "/api/mail/compose/m1/assemble" && init?.method === "POST") return save.promise;
                    if (url === "/api/mail/messages/m1/send") return send.promise;
                    return undefined;
                },
                { ...mailboxFixture, keys: [] },
            );
            await renderReady({ autosaveDelayMs: 5 });

            fireEvent.change(screen.getByLabelText("To"), { target: { value: "bob@example.com" } });
            await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saving…"));
            expect(beforeUnload().defaultPrevented).toBe(true);

            fireEvent.click(screen.getByRole("button", { name: "Send" }));
            // The window is finished, but the message has not reached the server yet: leaving now would lose it, so the browser is asked.
            expect(isSendPending("m1")).toBe(true);
            expect(beforeUnload().defaultPrevented).toBe(true);
            save.resolve(jsonResponse(200, draft));
            send.resolve(jsonResponse(202, { status: "queued", message: draft }));
            await waitFor(() => expect(isSendPending("m1")).toBe(false));
            expect(beforeUnload().defaultPrevented).toBe(false);
        });

        it("doesn't confirm after Discard, even with a save still on the wire", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            const save = deferred<Response>();
            mockRound4((url, init) => (url === "/api/mail/compose/m1/assemble" && init?.method === "POST" ? save.promise : undefined), {
                ...mailboxFixture,
                keys: [],
            });
            await renderReady({ autosaveDelayMs: 5 });

            fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Throwaway" } });
            await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saving…"));
            fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
            fireEvent.click(await screen.findByRole("button", { name: "Discard" }));

            expect(beforeUnload().defaultPrevented).toBe(false);
        });

        it("Sign Out's flush saves an edit still waiting on the debounce, and doesn't save it twice", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            const fetchMock = mockRound4(undefined, { ...mailboxFixture, keys: [] });
            await renderReady();

            fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Signing out" } });
            await act(() => flushComposeDrafts(1_000));
            expect(callsTo(fetchMock, isAssemble)).toHaveLength(1);
            await act(() => flushComposeDrafts(1_000));
            expect(callsTo(fetchMock, isAssemble)).toHaveLength(1);
        });
    });

    describe("round-5 fixes", () => {
        const noKeys = { ...mailboxFixture, keys: [] };
        const attachmentFixture = {
            uid: "a1",
            version: 0,
            dateCreated: "2026-01-01T00:00:00.000Z",
            dateModified: "2026-01-01T00:00:00.000Z",
            messageUid: "m1",
            folderUid: "f-drafts",
            mailboxUid: "mb1",
            filename: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 12,
            isInline: false,
        };
        const isUpload = (url: string, method: string) => url.startsWith("/api/mail/attachments/upload") && method === "POST";
        const pause = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        function beforeUnload(): Event {
            const event = new Event("beforeunload", { cancelable: true });
            window.dispatchEvent(event);
            return event;
        }
        function assembleBodies(fetchMock: ReturnType<typeof mockFetch>) {
            return callsTo(fetchMock, isAssemble).map(([, init]) => JSON.parse((init as RequestInit).body as string));
        }

        describe("saves that fail keep the window open", () => {
            it("Close offers Discard or Keep editing when the save is rejected, instead of closing silently", async () => {
                getUnlockedKeys.mockReturnValue(undefined);
                const fetchMock = mockRound4(
                    (url, init) => (isAssemble(url) && init?.method === "POST" ? jsonResponse(400, { message: "At least one recipient is required." }) : undefined),
                    noKeys,
                );
                const user = userEvent.setup();
                const { onClose } = await renderReady();

                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "No recipients yet" } });
                await user.click(screen.getByRole("button", { name: "Close" }));

                const dialog = await screen.findByRole("dialog", { name: "Couldn't save this draft" });
                expect(dialog).toHaveTextContent("It couldn't be saved (At least one recipient is required). Keep editing and try again, or discard it.");
                expect(screen.getByRole("status")).toHaveTextContent("Couldn't save draft");
                expect(onClose).not.toHaveBeenCalled();

                await user.click(screen.getByRole("button", { name: "Keep editing" }));
                expect(screen.queryByRole("dialog", { name: "Couldn't save this draft" })).not.toBeInTheDocument();
                expect(screen.getByLabelText("Subject")).toHaveValue("No recipients yet");
                expect(screen.getByRole("button", { name: "Close" })).not.toBeDisabled();

                await user.click(screen.getByRole("button", { name: "Close" }));
                await screen.findByRole("dialog", { name: "Couldn't save this draft" });
                expect(callsTo(fetchMock, isAssemble)).toHaveLength(2);
                await user.click(screen.getByRole("button", { name: "Discard" }));
                await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
                expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m1?version=0", expect.objectContaining({ method: "DELETE" }));
            });

            it("explains a save that couldn't reach the server", async () => {
                getUnlockedKeys.mockReturnValue(undefined);
                mockRound4((url, init) => {
                    if (isAssemble(url) && init?.method === "POST") throw new TypeError("Failed to fetch");
                    return undefined;
                }, noKeys);
                const { onClose } = await renderReady();

                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Offline" } });
                fireEvent.click(screen.getByRole("button", { name: "Close" }));

                expect(await screen.findByRole("dialog", { name: "Couldn't save this draft" })).toHaveTextContent("(the server couldn't be reached)");
                expect(onClose).not.toHaveBeenCalled();
            });

            it("Close before the draft exists (or its body has loaded) can't save it, so it asks instead", async () => {
                getUnlockedKeys.mockReturnValue(undefined);
                mockRound4((url, init) => (url === "/api/mail/messages" && init?.method === "POST" ? jsonResponse(500, { message: "Drafts folder is full." }) : undefined), noKeys);
                const onClose = vi.fn();
                render(<ComposeWindow session={session()} onClose={onClose} onToggleMinimize={vi.fn()} autosaveDelayMs={5} />);
                await screen.findByText("Drafts folder is full.");
                await screen.findByTestId("html-editor");
                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Nowhere to go" } });
                await waitFor(() => expect(beforeUnload().defaultPrevented).toBe(true));
                fireEvent.click(screen.getByRole("button", { name: "Close" }));
                expect(await screen.findByRole("dialog", { name: "Couldn't save this draft" })).toHaveTextContent("(Drafts folder is full)");
                expect(onClose).not.toHaveBeenCalled();
                cleanup();

                const creating = deferred<Response>();
                mockRound4((url, init) => (url === "/api/mail/messages" && init?.method === "POST" ? creating.promise : undefined), noKeys);
                render(<ComposeWindow session={session()} onClose={onClose} onToggleMinimize={vi.fn()} />);
                await screen.findByTestId("html-editor");
                await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeDisabled());
                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Too soon" } });
                await pause(20);
                fireEvent.click(screen.getByRole("button", { name: "Close" }));
                expect(await screen.findByRole("dialog", { name: "Couldn't save this draft" })).toHaveTextContent("(the draft hasn't been created yet)");
                cleanup();

                const signatures = deferred<Response>();
                mockRound4((url) => (url.startsWith("/api/mail/mail-signatures") ? signatures.promise : undefined), noKeys);
                render(<ComposeWindow session={session()} onClose={onClose} onToggleMinimize={vi.fn()} />);
                await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Body not loaded" } });
                fireEvent.click(screen.getByRole("button", { name: "Close" }));
                expect(await screen.findByRole("dialog", { name: "Couldn't save this draft" })).toBeInTheDocument();
                expect(onClose).not.toHaveBeenCalled();
            });

            it("Sign Out's flush reports a failed save and shows why; page-leave does the same for a save that already failed", async () => {
                getUnlockedKeys.mockReturnValue(undefined);
                let failing = true;
                mockRound4((url, init) => (isAssemble(url) && init?.method === "POST" && failing ? jsonResponse(503, { message: "Try later." }) : undefined), noKeys);
                const user = userEvent.setup();
                await renderReady();

                let flushed: boolean | undefined;
                await act(async () => {
                    flushed = await flushComposeDrafts(1_000);
                });
                expect(flushed).toBe(true);
                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Signing out" } });
                await act(async () => {
                    flushed = await flushComposeDrafts(1_000);
                });
                expect(flushed).toBe(false);
                expect(await screen.findByRole("dialog", { name: "Couldn't save this draft" })).toHaveTextContent("(Try later)");
                await user.click(screen.getByRole("button", { name: "Keep editing" }));

                // Not waiting on the debounce any more, but still unsaved after that failure.
                expect(beforeUnload().defaultPrevented).toBe(true);
                expect(await screen.findByRole("dialog", { name: "Couldn't save this draft" })).toBeInTheDocument();
                await user.click(screen.getByRole("button", { name: "Keep editing" }));

                failing = false;
                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Signing out again" } });
                await act(async () => {
                    flushed = await flushComposeDrafts(1_000);
                });
                expect(flushed).toBe(true);
                expect(beforeUnload().defaultPrevented).toBe(false);
            });

            it("page-leave saves a pending edit and shows why when that save fails", async () => {
                getUnlockedKeys.mockReturnValue(undefined);
                mockRound4((url, init) => (isAssemble(url) && init?.method === "POST" ? jsonResponse(500, { message: "Disk full" }) : undefined), noKeys);
                await renderReady();

                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Leaving" } });
                expect(beforeUnload().defaultPrevented).toBe(true);
                expect(await screen.findByRole("dialog", { name: "Couldn't save this draft" })).toHaveTextContent("(Disk full)");
            });

            it("page-leave asks to confirm for content that isn't saved as a draft (encrypted), without a save error, and Sign Out reports it unsaved", async () => {
                getUnlockedKeys.mockReturnValue({
                    masterKey: new Uint8Array(32),
                    encryptionPrivateKey: fakeEncryptionKey,
                    encryptionCertDer: fakeCertDer("alice-encrypt"),
                    encryptionFingerprint: "fp-own",
                });
                const fetchMock = mockRound4(undefined, { ...mailboxFixture, keys: [encryptKey] });
                const user = userEvent.setup();
                await renderReady({ autosaveDelayMs: 5 });

                await user.click(screen.getByLabelText("Encrypt this message"));
                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Secret" } });
                await pause();
                expect(beforeUnload().defaultPrevented).toBe(true);
                let flushed: boolean | undefined;
                await act(async () => {
                    flushed = await flushComposeDrafts(1_000);
                });
                expect(flushed).toBe(false);
                expect(screen.queryByRole("dialog", { name: "Couldn't save this draft" })).not.toBeInTheDocument();
                expect(callsTo(fetchMock, isAssemble)).toHaveLength(0);
            });

            it("never asks the browser to confirm leaving while signing out", async () => {
                getUnlockedKeys.mockReturnValue(undefined);
                mockRound4(undefined, noKeys);
                await renderReady();
                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Forced out" } });
                markSigningOut();
                try {
                    expect(beforeUnload().defaultPrevented).toBe(false);
                } finally {
                    clearSigningOut();
                }
                expect(beforeUnload().defaultPrevented).toBe(true);
            });
        });

        describe("overlapping saves", () => {
            it("chains a save behind the one on the wire, and the later one sends the latest content", async () => {
                getUnlockedKeys.mockReturnValue(undefined);
                const first = deferred<Response>();
                let assembles = 0;
                const fetchMock = mockRound4((url, init) => {
                    if (isAssemble(url) && init?.method === "POST") {
                        assembles += 1;
                        return assembles === 1 ? first.promise : jsonResponse(200, { ...draft, version: 2 });
                    }
                    return undefined;
                }, noKeys);
                await renderReady({ autosaveDelayMs: 5 });

                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "One" } });
                await waitFor(() => expect(assembles).toBe(1));
                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Two" } });
                await pause();
                expect(assembles).toBe(1);

                first.resolve(jsonResponse(200, { ...draft, version: 1 }));
                await waitFor(() => expect(assembles).toBe(2));
                await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Draft saved"));
                await pause();
                expect(assembleBodies(fetchMock).map((body) => body.subject)).toEqual(["One", "Two"]);
            });

            it("Close while the same content is already being saved waits for that save instead of repeating it", async () => {
                getUnlockedKeys.mockReturnValue(undefined);
                const save = deferred<Response>();
                const fetchMock = mockRound4((url, init) => (isAssemble(url) && init?.method === "POST" ? save.promise : undefined), noKeys);
                const { onClose } = await renderReady({ autosaveDelayMs: 5 });

                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Once" } });
                await waitFor(() => expect(callsTo(fetchMock, isAssemble)).toHaveLength(1));
                fireEvent.click(screen.getByRole("button", { name: "Close" }));
                await pause(20);
                expect(onClose).not.toHaveBeenCalled();

                save.resolve(jsonResponse(200, { ...draft, version: 1 }));
                await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
                expect(callsTo(fetchMock, isAssemble)).toHaveLength(1);
            });
        });

        describe("encryption settings that haven't loaded", () => {
            it("retries a failed policy load with backoff and autosaves once it loads", async () => {
                getUnlockedKeys.mockReturnValue(undefined);
                let policyCalls = 0;
                const fetchMock = mockRound4((url) => {
                    if (url === "/api/system/encryption-policy") {
                        policyCalls += 1;
                        return policyCalls < 3 ? jsonResponse(500, { message: "down" }) : undefined;
                    }
                    return undefined;
                }, { ...mailboxFixture, keys: [encryptKey] });
                await renderReady({ session: session({ initialTo: "nokey@example.com" }), autosaveDelayMs: 5, cryptoRetryDelaysMs: [5, 5, 5] });

                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Plain after all" } });
                await waitFor(() => expect(callsTo(fetchMock, isAssemble)).toHaveLength(1));
                expect(policyCalls).toBe(3);
                // The mailbox had loaded the first time - retries only re-fetch what's missing.
                expect(callsTo(fetchMock, (url) => url === "/api/mail/mailboxes/mb1")).toHaveLength(1);
                expect(screen.queryByText(/encryption settings couldn't be checked/)).not.toBeInTheDocument();
            });

            it("says nothing once the retries run out - drafts save and Close closes, whatever the policy is doing", async () => {
                getUnlockedKeys.mockReturnValue(undefined);
                let policyCalls = 0;
                const fetchMock = mockRound4((url) => {
                    if (url === "/api/system/encryption-policy") {
                        policyCalls += 1;
                        return jsonResponse(500, { message: "down" });
                    }
                    return undefined;
                }, { ...mailboxFixture, keys: [encryptKey] });
                const user = userEvent.setup();
                const { onClose } = await renderReady({ session: session({ initialTo: "nokey@example.com" }), autosaveDelayMs: 5, cryptoRetryDelaysMs: [5] });

                await waitFor(() => expect(policyCalls).toBe(2));
                await pause();
                expect(policyCalls).toBe(2);
                expect(screen.queryByText(/encryption settings/i)).not.toBeInTheDocument();
                expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Maybe secret" } });
                await waitFor(() => expect(callsTo(fetchMock, isAssemble)).toHaveLength(1));

                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Maybe secret, edited" } });
                await user.click(screen.getByRole("button", { name: "Close" }));
                await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
                expect(screen.queryByRole("dialog", { name: "Discard this draft?" })).not.toBeInTheDocument();
                expect(callsTo(fetchMock, isAssemble)).toHaveLength(2);
            });

            it("a mailbox that couldn't be loaded changes nothing: drafts save, no message, no Retry - and it is retried in the background", async () => {
                getUnlockedKeys.mockReturnValue(undefined);
                let mailboxCalls = 0;
                const fetchMock = mockRound4((url) => {
                    if (url !== "/api/mail/mailboxes/mb1") return undefined;
                    mailboxCalls += 1;
                    return mailboxCalls === 1 ? jsonResponse(502, { message: "gateway" }) : undefined;
                }, noKeys);
                await renderReady({ autosaveDelayMs: 5, cryptoRetryDelaysMs: [5] });

                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Unknown" } });
                await waitFor(() => expect(callsTo(fetchMock, isAssemble)).toHaveLength(1));
                await waitFor(() => expect(mailboxCalls).toBe(2));
                expect(screen.queryByText(/encryption settings/i)).not.toBeInTheDocument();
                expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
                // The policy had loaded the first time; only what is missing is asked for again.
                expect(callsTo(fetchMock, (url) => url === "/api/system/encryption-policy")).toHaveLength(1);
            });

            it("Close before the mailbox and policy have loaded just saves the draft and closes - no confirmation", async () => {
                getUnlockedKeys.mockReturnValue(undefined);
                const mailboxResponse = deferred<Response>();
                const fetchMock = mockRound4((url) => (url === "/api/mail/mailboxes/mb1" ? mailboxResponse.promise : undefined), noKeys);
                const user = userEvent.setup();
                const onClose = vi.fn();
                render(<ComposeWindow session={session()} onClose={onClose} onToggleMinimize={vi.fn()} autosaveDelayMs={60_000} />);
                await screen.findByTestId("html-editor");
                await waitFor(() => expect(screen.getByLabelText("Attach files")).not.toBeDisabled());

                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Too early" } });
                await user.click(screen.getByRole("button", { name: "Close" }));
                await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
                expect(screen.queryByRole("dialog", { name: "Discard this draft?" })).not.toBeInTheDocument();
                expect(callsTo(fetchMock, isAssemble)).toHaveLength(1);
            });

            it("Close with a recipient whose lookup hasn't run saves and closes too", async () => {
                getUnlockedKeys.mockReturnValue(undefined);
                const fetchMock = mockRound4(undefined, { ...mailboxFixture, keys: [encryptKey] });
                const { onClose } = await renderReady();

                fireEvent.change(screen.getByLabelText("To"), { target: { value: "carol@example.com" } });
                fireEvent.click(screen.getByRole("button", { name: "Close" }));

                await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
                expect(callsTo(fetchMock, isAssemble)).toHaveLength(1);
            });
        });

        describe("discarding after attaching", () => {
            it("refreshes the draft's version after an upload, so Discard deletes the draft", async () => {
                getUnlockedKeys.mockReturnValue(undefined);
                const fetchMock = mockRound4((url, init) => {
                    const method = init?.method ?? "GET";
                    if (isUpload(url, method)) return jsonResponse(200, attachmentFixture);
                    if (url === "/api/mail/messages/m1" && method === "GET") return jsonResponse(200, { ...draft, version: 4, hasAttachments: true });
                    if (url === "/api/mail/messages/m1?version=4" && method === "DELETE") return new Response(null, { status: 204 });
                    if (url.startsWith("/api/mail/messages/m1?") && method === "DELETE") return jsonResponse(404, { message: "Not found" });
                    return undefined;
                }, noKeys);
                const user = userEvent.setup();
                const { onClose } = await renderReady();

                await user.upload(screen.getByLabelText("Attach files"), new File(["hello"], "notes.txt", { type: "text/plain" }));
                await screen.findByText("notes.txt");
                await waitFor(() => expect(callsTo(fetchMock, (url, method) => url === "/api/mail/messages/m1" && method === "GET")).toHaveLength(1));

                await user.click(screen.getByRole("button", { name: "Discard draft" }));
                await user.click(await screen.findByRole("button", { name: "Discard" }));
                await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
                expect(callsTo(fetchMock, (_url, method) => method === "DELETE").map(([url]) => url)).toEqual(["/api/mail/messages/m1?version=4"]);
            });

            it("keeps the version when an inserted image's refresh reports nothing newer", async () => {
                getUnlockedKeys.mockReturnValue(undefined);
                const fetchMock = mockRound4((url, init) => {
                    const method = init?.method ?? "GET";
                    if (isUpload(url, method)) return jsonResponse(200, { ...attachmentFixture, filename: "photo.png" });
                    if (url === "/api/mail/messages/m1" && method === "GET") return jsonResponse(200, { ...draft, version: 0 });
                    return undefined;
                }, noKeys);
                const user = userEvent.setup();
                const { onClose } = await renderReady();

                await user.click(screen.getByText("fake-upload-image"));
                await waitFor(() => expect(callsTo(fetchMock, (url, method) => url === "/api/mail/messages/m1" && method === "GET")).toHaveLength(1));
                await user.click(screen.getByRole("button", { name: "Discard draft" }));
                await user.click(await screen.findByRole("button", { name: "Discard" }));
                await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
                expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m1?version=0", expect.objectContaining({ method: "DELETE" }));
            });

            it("retries a stale-version delete once with the server's version, and keeps the window open with the error when it can't", async () => {
                getUnlockedKeys.mockReturnValue(undefined);
                let attempt = 0;
                const fetchMock = mockRound4((url, init) => {
                    const method = init?.method ?? "GET";
                    if (isUpload(url, method)) return jsonResponse(200, attachmentFixture);
                    if (url === "/api/mail/messages/m1" && method === "GET") {
                        // The post-upload refresh fails; then the lookup for Discard's retry fails once, then answers.
                        const gets = callsTo(fetchMock, (u, m) => u === "/api/mail/messages/m1" && m === "GET").length;
                        return gets <= 2 ? jsonResponse(500, { message: "Lookup failed." }) : jsonResponse(200, { ...draft, version: 6 });
                    }
                    if (url === "/api/mail/messages/m1?version=0" && method === "DELETE") {
                        attempt += 1;
                        if (attempt === 2) throw new TypeError("Failed to fetch");
                        return jsonResponse(409, { message: "Version conflict" });
                    }
                    if (url === "/api/mail/messages/m1?version=6" && method === "DELETE") return new Response(null, { status: 204 });
                    return undefined;
                }, noKeys);
                const user = userEvent.setup();
                const { onClose } = await renderReady();

                await user.upload(screen.getByLabelText("Attach files"), new File(["hello"], "notes.txt", { type: "text/plain" }));
                await screen.findByText("notes.txt");
                await waitFor(() => expect(callsTo(fetchMock, (url, method) => url === "/api/mail/messages/m1" && method === "GET")).toHaveLength(1));

                await user.click(screen.getByRole("button", { name: "Discard draft" }));
                await user.click(await screen.findByRole("button", { name: "Discard" }));
                expect(await screen.findByText("Couldn't discard this draft: Lookup failed.")).toBeInTheDocument();
                expect(onClose).not.toHaveBeenCalled();
                expect(screen.getByRole("button", { name: "Discard draft" })).not.toBeDisabled();

                await user.click(screen.getByRole("button", { name: "Discard draft" }));
                await user.click(await screen.findByRole("button", { name: "Discard" }));
                expect(await screen.findByText("Couldn't discard this draft: the server couldn't be reached.")).toBeInTheDocument();
                expect(onClose).not.toHaveBeenCalled();

                await user.click(screen.getByRole("button", { name: "Discard draft" }));
                await user.click(await screen.findByRole("button", { name: "Discard" }));
                await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
                expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m1?version=6", expect.objectContaining({ method: "DELETE" }));
            });

            it("treats a draft that's already gone as discarded", async () => {
                getUnlockedKeys.mockReturnValue(undefined);
                mockRound4((url, init) => {
                    const method = init?.method ?? "GET";
                    if (url.startsWith("/api/mail/messages/m1?") && method === "DELETE") return jsonResponse(404, { message: "Not found" });
                    if (url === "/api/mail/messages/m1" && method === "GET") return jsonResponse(404, { message: "Not found" });
                    return undefined;
                }, noKeys);
                const { onClose } = await renderReady();

                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Gone already" } });
                fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
                fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
                await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
                expect(screen.queryByText(/Couldn't discard this draft/)).not.toBeInTheDocument();
            });

            it("closes a blank window straight away even when deleting its draft fails", async () => {
                getUnlockedKeys.mockReturnValue(undefined);
                const fetchMock = mockRound4((url, init) => (init?.method === "DELETE" ? jsonResponse(500, { message: "down" }) : undefined), noKeys);
                const { onClose } = await renderReady();

                fireEvent.click(screen.getByRole("button", { name: "Close" }));
                expect(onClose).toHaveBeenCalledTimes(1);
                await waitFor(() => expect(callsTo(fetchMock, (_url, method) => method === "DELETE")).toHaveLength(1));
            });
        });
    });

    describe("round-6 fixes", () => {
        const noKeys = { ...mailboxFixture, keys: [] };
        const withEncryptKey = { ...mailboxFixture, keys: [encryptKey] };
        const unlockedEncrypt = {
            masterKey: new Uint8Array(32),
            encryptionPrivateKey: fakeEncryptionKey,
            encryptionCertDer: fakeCertDer("alice-encrypt"),
            encryptionFingerprint: "fp-own",
        };
        const optionalPolicy = { encryptSameOrg: "optional", encryptFederated: "optional", encryptExternal: "prohibited" };
        const pause = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const subjects = (fetchMock: ReturnType<typeof mockFetch>) =>
            callsTo(fetchMock, isAssemble).map(([, init]) => JSON.parse((init as RequestInit).body as string).subject);

        /** mockRound4 whose first assemble waits on the returned deferred; later ones answer at once (version 2). */
        function mockSlowFirstSave(mailbox: Record<string, unknown>, extra?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
            const first = deferred<Response>();
            let assembles = 0;
            const fetchMock = mockRound4((url, init) => {
                if (isAssemble(url) && init?.method === "POST") {
                    assembles += 1;
                    return assembles === 1 ? first.promise : jsonResponse(200, { ...draft, version: 2 });
                }
                return extra?.(url, init);
            }, mailbox);
            return { fetchMock, first };
        }

        describe("a save queued behind a slow one re-checks whether it may save", () => {
            it("skips the queued save once Encrypt was turned on while it waited", async () => {
                getUnlockedKeys.mockReturnValue(unlockedEncrypt);
                const { fetchMock, first } = mockSlowFirstSave(withEncryptKey);
                const user = userEvent.setup();
                await renderReady({ session: session({ initialTo: "nokey@example.com" }), autosaveDelayMs: 5 });

                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "One" } });
                await waitFor(() => expect(callsTo(fetchMock, isAssemble)).toHaveLength(1));
                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Two" } });
                await pause();
                await user.click(screen.getByLabelText("Encrypt this message"));
                fireEvent.change(screen.getByTestId("html-editor"), { target: { value: "<p>the secret</p>" } });

                first.resolve(jsonResponse(200, { ...draft, version: 1 }));
                await pause();
                expect(subjects(fetchMock)).toEqual(["One"]);
                expect(screen.getByRole("status")).not.toHaveTextContent("Draft saved");
            });

            it("skips the queued save once a send has started, so only the send assembles the latest content", async () => {
                getUnlockedKeys.mockReturnValue(undefined);
                const { fetchMock, first } = mockSlowFirstSave(noKeys);
                const { onClose } = await renderReady({ autosaveDelayMs: 5 });

                fireEvent.change(screen.getByLabelText("To"), { target: { value: "bob@example.com" } });
                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "One" } });
                await waitFor(() => expect(callsTo(fetchMock, isAssemble)).toHaveLength(1));
                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Two" } });
                await pause();
                fireEvent.click(screen.getByRole("button", { name: "Send" }));

                first.resolve(jsonResponse(200, { ...draft, version: 1 }));
                await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
                expect(subjects(fetchMock)).toEqual(["One", "Two"]);
            });

            it("skips the queued save after Discard, and deletes with the version the earlier save stored", async () => {
                getUnlockedKeys.mockReturnValue(undefined);
                const { fetchMock, first } = mockSlowFirstSave(noKeys);
                const { onClose } = await renderReady({ autosaveDelayMs: 5 });

                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "One" } });
                await waitFor(() => expect(callsTo(fetchMock, isAssemble)).toHaveLength(1));
                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Two" } });
                await pause();
                fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
                fireEvent.click(await screen.findByRole("button", { name: "Discard" }));

                first.resolve(jsonResponse(200, { ...draft, version: 3 }));
                await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
                expect(subjects(fetchMock)).toEqual(["One"]);
                expect(callsTo(fetchMock, (_url, method) => method === "DELETE").map(([url]) => url)).toEqual(["/api/mail/messages/m1?version=3"]);
            });

            it("Close keeps the window open with the encrypted-message prompt when Encrypt was turned on while its save waited", async () => {
                getUnlockedKeys.mockReturnValue(unlockedEncrypt);
                const { fetchMock, first } = mockSlowFirstSave(withEncryptKey);
                const user = userEvent.setup();
                const { onClose } = await renderReady({ session: session({ initialTo: "nokey@example.com" }), autosaveDelayMs: 5 });

                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "One" } });
                await waitFor(() => expect(callsTo(fetchMock, isAssemble)).toHaveLength(1));
                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Two" } });
                fireEvent.click(screen.getByRole("button", { name: "Close" }));
                await user.click(screen.getByLabelText("Encrypt this message"));

                first.resolve(jsonResponse(200, { ...draft, version: 1 }));
                expect(await screen.findByRole("dialog", { name: "Discard this draft?" })).toHaveTextContent(/Encrypted messages aren't saved as drafts/);
                expect(onClose).not.toHaveBeenCalled();
                expect(subjects(fetchMock)).toEqual(["One"]);
            });

            it("Close does not ask about a recipient still to be checked that was added while its save waited: it saves what is there and closes", async () => {
                getUnlockedKeys.mockReturnValue(undefined);
                const { fetchMock, first } = mockSlowFirstSave(withEncryptKey, (url) => (isLookup(url) && url.includes("new") ? deferred<Response>().promise : undefined));
                const { onClose } = await renderReady({ session: session({ initialTo: "nokey@example.com" }), autosaveDelayMs: 5 });

                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "One" } });
                await waitFor(() => expect(callsTo(fetchMock, isAssemble)).toHaveLength(1));
                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Two" } });
                fireEvent.click(screen.getByRole("button", { name: "Close" }));
                fireEvent.change(screen.getByLabelText("To"), { target: { value: "nokey@example.com, new@example.com" } });

                first.resolve(jsonResponse(200, { ...draft, version: 1 }));
                await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
                expect(screen.queryByRole("dialog", { name: "Discard this draft?" })).not.toBeInTheDocument();
            });

            it("Sign Out's flush reports a skipped save as unsaved without a save-failed prompt", async () => {
                getUnlockedKeys.mockReturnValue(unlockedEncrypt);
                const { fetchMock, first } = mockSlowFirstSave(withEncryptKey);
                const user = userEvent.setup();
                await renderReady({ session: session({ initialTo: "nokey@example.com" }) });
                await screen.findByText(/nokey@example\.com no encryption key found/);

                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "One" } });
                let firstFlush!: Promise<boolean>;
                act(() => {
                    firstFlush = flushComposeDrafts(1_000);
                });
                await waitFor(() => expect(callsTo(fetchMock, isAssemble)).toHaveLength(1));
                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Two" } });
                let secondFlush!: Promise<boolean>;
                act(() => {
                    secondFlush = flushComposeDrafts(1_000);
                });
                await user.click(screen.getByLabelText("Encrypt this message"));

                first.resolve(jsonResponse(200, { ...draft, version: 1 }));
                let results: boolean[] = [];
                await act(async () => {
                    results = await Promise.all([firstFlush, secondFlush]);
                });
                expect(results).toEqual([true, false]);
                expect(screen.queryByRole("dialog", { name: "Couldn't save this draft" })).not.toBeInTheDocument();
                expect(subjects(fetchMock)).toEqual(["One"]);
            });
        });

        describe("autosave before the recipients are known", () => {
            it("autosaves a message with no recipients even when policy could auto-encrypt it - nothing to encrypt for yet - and Close closes", async () => {
                getUnlockedKeys.mockReturnValue(undefined);
                const fetchMock = mockRound4(undefined, withEncryptKey);
                const user = userEvent.setup();
                const { onClose } = await renderReady({ autosaveDelayMs: 5 });

                fireEvent.change(screen.getByTestId("html-editor"), { target: { value: "<p>not secret at all</p>" } });
                await waitFor(() => expect(callsTo(fetchMock, isAssemble)).toHaveLength(1));

                await user.click(screen.getByRole("button", { name: "Close" }));
                await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
                expect(screen.queryByRole("dialog", { name: "Discard this draft?" })).not.toBeInTheDocument();
            });

            it("still autosaves a message with no recipients when no policy tier auto-encrypts", async () => {
                getUnlockedKeys.mockReturnValue(undefined);
                const fetchMock = mockRound4((url) => (url === "/api/system/encryption-policy" ? jsonResponse(200, optionalPolicy) : undefined), withEncryptKey);
                await renderReady({ autosaveDelayMs: 5 });

                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Plain" } });
                await waitFor(() => expect(callsTo(fetchMock, isAssemble)).toHaveLength(1));
            });

            it("never stores a failed lookup as 'no key': it is retried silently, the draft saves meanwhile, and a later blur looks it up again", async () => {
                getUnlockedKeys.mockReturnValue(undefined);
                let failing = true;
                const fetchMock = mockRound4((url) => (isLookup(url) && failing ? jsonResponse(500, { message: "lookup down" }) : undefined), withEncryptKey);
                const user = userEvent.setup();
                const { onClose } = await renderReady({ session: session({ initialTo: "nokey@example.com" }), autosaveDelayMs: 5, cryptoRetryDelaysMs: [5] });

                fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Maybe secret" } });
                await waitFor(() => expect(callsTo(fetchMock, isLookup)).toHaveLength(2));
                await pause();
                expect(callsTo(fetchMock, isLookup)).toHaveLength(2);
                expect(screen.queryByText(/encryption settings/i)).not.toBeInTheDocument();
                expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
                expect(screen.queryByText(/no encryption key found/)).not.toBeInTheDocument();
                // Not held against the message: it is saved although its recipient could not be checked.
                await waitFor(() => expect(callsTo(fetchMock, isAssemble)).toHaveLength(1));

                failing = false;
                fireEvent.change(screen.getByLabelText("To"), { target: { value: "nokey@example.com, other@example.com" } });
                fireEvent.blur(screen.getByLabelText("To"));
                expect((await screen.findAllByText(/nokey@example\.com no encryption key found/)).length).toBeGreaterThan(0);
                await user.click(screen.getByRole("button", { name: "Close" }));
                await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
            });

            it("stops a pending lookup retry when the window unmounts", async () => {
                getUnlockedKeys.mockReturnValue(undefined);
                const fetchMock = mockRound4((url) => (isLookup(url) ? jsonResponse(500, { message: "lookup down" }) : undefined), withEncryptKey);
                const { unmount } = await renderReady({ session: session({ initialTo: "nokey@example.com" }), cryptoRetryDelaysMs: [400] });

                await waitFor(() => expect(callsTo(fetchMock, isLookup)).toHaveLength(1));
                await pause(10);
                unmount();
                await pause(500);
                expect(callsTo(fetchMock, isLookup)).toHaveLength(1);
            });

            it("refuses a requested-encryption send whose recipient lookup failed, even when no policy tier auto-encrypts - the user asked for encryption", async () => {
                getUnlockedKeys.mockReturnValue(unlockedEncrypt);
                const fetchMock = mockRound4((url) => {
                    if (url === "/api/system/encryption-policy") return jsonResponse(200, optionalPolicy);
                    if (isLookup(url)) return jsonResponse(500, { message: "lookup down" });
                    return undefined;
                }, withEncryptKey);
                const user = userEvent.setup();
                await renderReady();

                fireEvent.change(screen.getByLabelText("To"), { target: { value: "bob@example.com" } });
                await user.click(screen.getByLabelText("Encrypt this message"));
                await user.click(screen.getByRole("button", { name: "Send" }));

                await waitFor(() => expect(toasts()).toHaveLength(1));
                expect(toasts()[0].message).toMatch(/encryption keys couldn't be checked/);
                expect(toasts()[0].actions.map((action) => action.label)).toEqual(["Send without encryption", "Open draft"]);
                expect(callsTo(fetchMock, (url) => url.startsWith("/api/mail/compose/"))).toHaveLength(0);
            });
        });

        it("sends unencrypted when the mailbox couldn't be loaded and nothing is unlocked (fail open) - no block, no message", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            const fetchMock = mockRound4((url) => (url === "/api/mail/mailboxes/mb1" ? jsonResponse(502, { message: "gateway" }) : undefined), withEncryptKey);
            const user = userEvent.setup();
            const { onClose } = await renderReady({ cryptoRetryDelaysMs: [] });

            fireEvent.change(screen.getByLabelText("To"), { target: { value: "bob@example.com" } });
            await user.click(screen.getByRole("button", { name: "Send" }));

            await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
            await waitFor(() => expect(callsTo(fetchMock, isAssemble)).toHaveLength(1));
            expect(screen.queryByText(/encryption settings/i)).not.toBeInTheDocument();
            expect(toasts().filter((toast) => toast.kind === "error")).toEqual([]);
        });

        it("Discard never deletes a copy another window has sent, scheduled or started sending; it deletes one that's still a draft", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            const freshCopies: Record<string, unknown>[] = [
                { folderUid: "f-sent" },
                { scheduledSendTime: "2026-02-01T00:00:00.000Z" },
                { scheduledSendLeaseExpiresAt: "2026-02-01T00:00:00.000Z" },
                { scheduledSendRelayedAt: "2026-02-01T00:00:00.000Z" },
                {},
            ];
            let gets = 0;
            const fetchMock = mockRound4((url, init) => {
                const method = init?.method ?? "GET";
                if (url === "/api/mail/messages/m1?version=0" && method === "DELETE") return jsonResponse(409, { message: "Version conflict" });
                if (url === "/api/mail/messages/m1" && method === "GET") return jsonResponse(200, { ...draft, version: 9, ...freshCopies[gets++] });
                return undefined;
            }, noKeys);
            const user = userEvent.setup();
            const { onClose } = await renderReady();
            fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Mine" } });

            for (let attempt = 1; attempt <= 4; attempt++) {
                await user.click(screen.getByRole("button", { name: "Discard draft" }));
                await user.click(await screen.findByRole("button", { name: "Discard" }));
                await waitFor(() => expect(gets).toBe(attempt));
                expect(await screen.findByText(/Couldn't discard this draft: This message was already sent or scheduled from another window/)).toBeInTheDocument();
                expect(onClose).not.toHaveBeenCalled();
            }
            expect(callsTo(fetchMock, (url, method) => method === "DELETE" && url.endsWith("version=9"))).toHaveLength(0);

            await user.click(screen.getByRole("button", { name: "Discard draft" }));
            await user.click(await screen.findByRole("button", { name: "Discard" }));
            await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m1?version=9", expect.objectContaining({ method: "DELETE" }));
        });

        it("never deletes a superseded draft that another window has since sent", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            let created = 0;
            const fetchMock = mockRound4((url, init) => {
                const method = init?.method ?? "GET";
                if (url.startsWith("/api/mail/mailboxes?")) {
                    return jsonResponse(200, [mailboxFixture, { ...mailboxFixture, uid: "mb2", primarySmtpAddress: "two@example.com", displayName: "Two" }]);
                }
                if (url === "/api/mail/mailboxes/mb2") return jsonResponse(200, { ...noKeys, uid: "mb2" });
                if (url === "/api/mail/messages" && method === "POST") {
                    created += 1;
                    return jsonResponse(200, { ...draft, uid: created === 1 ? "m1" : "m2" });
                }
                if (url === "/api/mail/messages/m1?version=0" && method === "DELETE") return jsonResponse(409, { message: "Version conflict" });
                if (url === "/api/mail/messages/m1" && method === "GET") return jsonResponse(200, { ...draft, folderUid: "f-sent", version: 4 });
                return undefined;
            }, noKeys);
            render(<ComposeWindow session={session()} trusted onClose={vi.fn()} onToggleMinimize={vi.fn()} autosaveDelayMs={60_000} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

            fireEvent.change(await screen.findByLabelText("From"), { target: { value: "mb2" } });
            await waitFor(() => expect(callsTo(fetchMock, (url, method) => url === "/api/mail/messages/m1" && method === "GET")).toHaveLength(1));
            await pause();
            expect(callsTo(fetchMock, (url, method) => method === "DELETE" && url.startsWith("/api/mail/messages/m1?"))).toHaveLength(1);
        });

        it("leaves a display name the server would refuse (an @ or look-alike, or a line break) out of a signed message's From", async () => {
            const signingKeys = { masterKey: new Uint8Array(32), signingPrivateKey: fakeSigningKey, signingCertDer: fakeCertDer("alice-sign"), signingFingerprint: "fp-sign" };
            buildSignedOnlyMessage.mockResolvedValue({ contentType: 'multipart/signed; boundary="b1"', body: "SIGNED-BODY" });
            for (const displayName of ["Sales @ Acme", "Sales ＠ Acme", "Sales ﹫ Acme", "Sales\r\nBcc: x"]) {
                getUnlockedKeys.mockReturnValue(signingKeys);
                buildSignedOnlyMessage.mockClear();
                mockRound4(
                    (url, init) => (url === "/api/mail/compose/m1/assemble-raw" && init?.method === "POST" ? jsonResponse(200, draft) : undefined),
                    { ...mailboxFixture, displayName, keys: [signKey] },
                );
                const { onClose } = await renderReady();
                fireEvent.change(screen.getByLabelText("To"), { target: { value: "bob@example.com" } });
                fireEvent.click(screen.getByRole("button", { name: "Send" }));
                await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
                expect(buildSignedOnlyMessage).toHaveBeenCalledWith(
                    expect.anything(),
                    expect.anything(),
                    expect.objectContaining({ from: "u1@example.com" }),
                    expect.anything(),
                    expect.anything(),
                );
                cleanup();
            }
        });
    });
});


describe("ComposeWindow keyboard shortcuts", () => {
    const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) => fireEvent.keyDown(target, { key, ...init });
    const CTRL = { ctrlKey: true };

    function mockShortcutServer(extra?: (url: string, init?: RequestInit) => Response | undefined) {
        let version = 0;
        return mockCompose((url, init) => {
            const custom = extra?.(url, init);
            if (custom) return custom;
            const method = init?.method ?? "GET";
            if (url === "/api/mail/compose/m1/assemble" && method === "POST") {
                version += 1;
                return jsonResponse(200, { ...draft, version });
            }
            if (url.startsWith("/api/mail/messages/m1?") && method === "DELETE") return new Response(null, { status: 204 });
            if (url === "/api/mail/messages/m1/send" && method === "POST") return jsonResponse(200, draft);
            return undefined;
        });
    }
    const calls = (fetchMock: ReturnType<typeof mockFetch>, url: string, method = "POST") =>
        fetchMock.mock.calls.filter(([u, init]) => u === url && ((init as RequestInit | undefined)?.method ?? "GET") === method);

    async function renderReady(props: Partial<React.ComponentProps<typeof ComposeWindow>> = {}, sessionOverrides: Partial<ComposeSession> = {}) {
        const onClose = vi.fn();
        render(
            <ShortcutProvider>
                <ComposeWindow session={session(sessionOverrides)} onClose={onClose} onToggleMinimize={vi.fn()} autosaveDelayMs={60_000} {...props} />
            </ShortcutProvider>,
        );
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
        await screen.findByTestId("html-editor");
        return { onClose };
    }

    const encryptionKeys = () => ({
        masterKey: new Uint8Array(32),
        encryptionPrivateKey: fakeEncryptionKey,
        encryptionCertDer: fakeCertDer("alice-encrypt"),
        encryptionFingerprint: "fp-own",
    });

    it("Ctrl+Enter sends from anywhere in the window - a field included - the way the Send button does", async () => {
        const fetchMock = mockShortcutServer();
        const { onClose } = await renderReady({}, { initialTo: "b@example.com" });
        fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Hi there" } });

        expect(press("Enter", CTRL, screen.getByLabelText("Subject"))).toBe(false);

        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
        expect(calls(fetchMock, "/api/mail/compose/m1/assemble")).toHaveLength(1);
        expect(calls(fetchMock, "/api/mail/messages/m1/send")).toHaveLength(1);
    });

    it("takes Ctrl+Enter and does nothing while Send is disabled (no draft yet)", async () => {
        let createDraft: ((response: Response) => void) | undefined;
        const fetchMock = mockShortcutServer((url, init) =>
            url === "/api/mail/messages" && init?.method === "POST" ? (new Promise((resolve) => (createDraft = resolve)) as unknown as Response) : undefined,
        );
        render(
            <ShortcutProvider>
                <ComposeWindow session={session({ initialTo: "b@example.com" })} onClose={vi.fn()} onToggleMinimize={vi.fn()} autosaveDelayMs={60_000} />
            </ShortcutProvider>,
        );
        expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

        expect(press("Enter", CTRL, screen.getByLabelText("Subject"))).toBe(false);

        expect(calls(fetchMock, "/api/mail/compose/m1/assemble")).toHaveLength(0);
        await waitFor(() => expect(createDraft).toBeDefined());
        createDraft!(jsonResponse(200, draft));
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
    });

    it("does not take Ctrl+Enter from outside the window", async () => {
        const fetchMock = mockShortcutServer();
        await renderReady({}, { initialTo: "b@example.com" });

        expect(press("Enter", CTRL)).toBe(true);

        expect(calls(fetchMock, "/api/mail/compose/m1/assemble")).toHaveLength(0);
    });

    it("Ctrl+S saves the draft now, without waiting for the autosave pause", async () => {
        const fetchMock = mockShortcutServer();
        await renderReady();
        fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Save me" } });
        expect(calls(fetchMock, "/api/mail/compose/m1/assemble")).toHaveLength(0);

        expect(press("s", CTRL, screen.getByLabelText("Subject"))).toBe(false);

        await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Draft saved"));
        expect(calls(fetchMock, "/api/mail/compose/m1/assemble")).toHaveLength(1);
        expect(JSON.parse((calls(fetchMock, "/api/mail/compose/m1/assemble")[0][1] as RequestInit).body as string)).toMatchObject({ subject: "Save me" });
    });

    it("takes Ctrl+S and saves nothing when there is nothing to save, so the browser's Save page never opens", async () => {
        const fetchMock = mockShortcutServer();
        await renderReady();

        expect(press("s", CTRL, screen.getByLabelText("Subject"))).toBe(false);

        expect(calls(fetchMock, "/api/mail/compose/m1/assemble")).toHaveLength(0);
    });

    it("never saves a message headed for encryption with Ctrl+S - as autosave never does", async () => {
        getUnlockedKeys.mockReturnValue(encryptionKeys());
        const fetchMock = mockShortcutServer();
        const user = userEvent.setup();
        await renderReady();
        await user.click(screen.getByLabelText("Encrypt this message"));
        fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Secret plans" } });

        expect(press("s", CTRL, screen.getByLabelText("Subject"))).toBe(false);

        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(calls(fetchMock, "/api/mail/compose/m1/assemble")).toHaveLength(0);
    });

    it("Escape closes through the same path as the Close button: it keeps the draft (saving what is unsaved first)", async () => {
        const fetchMock = mockShortcutServer();
        const { onClose } = await renderReady();
        fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Keep me" } });

        expect(press("Escape", {}, screen.getByLabelText("Subject"))).toBe(false);

        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
        expect(calls(fetchMock, "/api/mail/compose/m1/assemble")).toHaveLength(1);
        expect(calls(fetchMock, "/api/mail/messages/m1", "DELETE")).toHaveLength(0);
    });

    it("Escape on a window nothing was typed in closes it and deletes the blank draft, as Close does", async () => {
        const fetchMock = mockShortcutServer();
        const { onClose } = await renderReady();

        press("Escape", {}, screen.getByLabelText("Subject"));

        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(true));
    });

    it("Escape asks the existing question before closing a message that cannot be kept as a draft, and the prompt's own Escape wins over the window's", async () => {
        getUnlockedKeys.mockReturnValue(encryptionKeys());
        mockShortcutServer();
        const user = userEvent.setup();
        const { onClose } = await renderReady();
        await user.click(screen.getByLabelText("Encrypt this message"));
        fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Secret plans" } });

        press("Escape", {}, screen.getByLabelText("Subject"));
        const prompt = await screen.findByRole("dialog", { name: "Discard this draft?" });
        expect(onClose).not.toHaveBeenCalled();

        // With the prompt open only it is listening: its Escape closes the prompt (it is a modal), and the window behind it stays.
        expect(press("Escape", {}, prompt)).toBe(true);
        await waitFor(() => expect(screen.queryByRole("dialog", { name: "Discard this draft?" })).not.toBeInTheDocument());
        expect(onClose).not.toHaveBeenCalled();
    });

    it("Ctrl+Enter sends and closes at once, and the key held down (repeats) sends once", async () => {
        const fetchMock = mockShortcutServer();
        const { onClose } = await renderReady({}, { initialTo: "b@example.com" });

        press("Enter", CTRL, screen.getByLabelText("Subject"));
        press("Enter", CTRL, screen.getByLabelText("Subject"));
        press("Enter", CTRL, screen.getByLabelText("Subject"));

        await waitFor(() => expect(isSendPending("m1")).toBe(false));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(calls(fetchMock, "/api/mail/messages/m1/send", "POST")).toHaveLength(1);
    });

    it("Alt+N opens another new message from the same sending mailbox - Ctrl+N as well in the desktop client", async () => {
        mockShortcutServer();
        await renderReady();
        const subject = screen.getByLabelText("Subject");

        expect(press("n", { altKey: true }, subject)).toBe(false);
        expect(openCompose).toHaveBeenCalledWith({ mailboxUid: "mb1" });
        expect(press("n", CTRL, subject)).toBe(true);

        (window as { rapidmx?: unknown }).rapidmx = {};
        try {
            expect(press("n", CTRL, subject)).toBe(false);
            expect(openCompose).toHaveBeenCalledTimes(2);
        } finally {
            delete (window as { rapidmx?: unknown }).rapidmx;
        }
    });

    it("does not register its keys for a minimized window", async () => {
        mockShortcutServer();
        render(
            <ShortcutProvider>
                <ComposeWindow session={session({ minimized: true })} onClose={vi.fn()} onToggleMinimize={vi.fn()} />
            </ShortcutProvider>,
        );
        const bar = screen.getByRole("button", { name: "Restore" });
        expect(press("Enter", CTRL, bar)).toBe(true);
        expect(press("Escape", {}, bar)).toBe(true);
        expect(press("s", CTRL, bar)).toBe(true);
    });

    it("names its shortcuts on the Send and Close buttons, leaving their accessible names alone", async () => {
        mockShortcutServer();
        await renderReady();
        const send = screen.getByRole("button", { name: "Send" });
        expect(send).toHaveAttribute("title", "Send (Ctrl+Enter)");
        expect(send).toHaveAttribute("aria-keyshortcuts", "Control+Enter");
        const close = screen.getByRole("button", { name: "Close" });
        expect(close).toHaveAttribute("title", "Close (Esc)");
        expect(close).toHaveAttribute("aria-keyshortcuts", "Escape");
        // The other header buttons have none.
        expect(screen.getByRole("button", { name: "Minimize" })).toHaveAttribute("title", "Minimize");
        expect(screen.getByRole("button", { name: "Minimize" })).not.toHaveAttribute("aria-keyshortcuts");
    });
});
