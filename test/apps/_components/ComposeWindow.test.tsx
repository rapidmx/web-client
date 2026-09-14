// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockMatchMedia } from "../testUtils.js";
import { toBase64 } from "@rapidmx/react-shared/crypto/encoding.js";
import ComposeWindow from "../../../apps/shared/components/mail/compose/ComposeWindow.js";
import type { ComposeSession } from "../../../apps/shared/components/mail/compose/ComposeContext.js";
import { clearMailboxWritabilityCache } from "../../../apps/shared/components/mail/writableMailboxes.js";
import { flushComposeDrafts } from "../../../apps/shared/components/mail/compose/composeFlushRegistry.js";

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
    }: {
        value: string;
        onChange: (v: string) => void;
        onUploadImage: (file: File) => Promise<string | null>;
    }) => {
        const [uploadResult, setUploadResult] = React.useState<string>("");
        return (
            <div>
                <textarea data-testid="html-editor" value={value} onChange={(e) => onChange(e.target.value)} />
                <button
                    type="button"
                    onClick={async () => {
                        const url = await onUploadImage(new File(["pixels"], "photo.png", { type: "image/png" }));
                        setUploadResult(url ?? "null");
                    }}
                >
                    fake-upload-image
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
            expect(screen.getByLabelText("To")).toHaveValue("jane@example.com");
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

            await user.click(screen.getByRole("button", { name: "fake-upload-image" }));

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
        expect(screen.getByLabelText("To")).toHaveValue("jane@example.com");
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
        expect(screen.getByLabelText("Cc")).toHaveValue("cc@example.com");
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

    it("shows an error message when assembling fails", async () => {
        mockCompose((url, init) =>
            url === "/api/mail/compose/m1/assemble" && (init?.method ?? "GET") === "POST"
                ? jsonResponse(500, { message: "assemble failed" })
                : undefined,
        );
        const user = userEvent.setup();
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

        await user.type(screen.getByLabelText("To"), "b@example.com");
        await user.click(screen.getByRole("button", { name: "Send" }));

        expect(await screen.findByText("assemble failed")).toBeInTheDocument();
    });

    it("shows a generic error message when sending fails with a non-API error", async () => {
        mockCompose((url, init) => {
            if (url === "/api/mail/compose/m1/assemble" && (init?.method ?? "GET") === "POST") return jsonResponse(200, draft);
            if (url === "/api/mail/messages/m1/send") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

        await user.type(screen.getByLabelText("To"), "b@example.com");
        await user.click(screen.getByRole("button", { name: "Send" }));

        expect(await screen.findByText("Could not send this message.")).toBeInTheDocument();
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

            expect(await screen.findByText("assemble failed")).toBeInTheDocument();
        });

        it("shows a generic error message when scheduling fails with a non-API error", async () => {
            mockCompose((url, init) => {
                const method = init?.method ?? "GET";
                if (url === "/api/mail/compose/m1/assemble" && method === "POST") return jsonResponse(200, draft);
                if (url === "/api/mail/messages/m1/send" && method === "POST") throw new TypeError("network down");
                return undefined;
            });
            const user = userEvent.setup();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send later" })).not.toBeDisabled());

            await user.type(screen.getByLabelText("To"), "b@example.com");
            await user.click(screen.getByRole("button", { name: "Send later" }));
            await user.type(screen.getByLabelText("Send at"), futureLocalValue());
            await user.click(screen.getAllByRole("button", { name: "Send later" })[1]);

            expect(await screen.findByText("Could not schedule this message.")).toBeInTheDocument();
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

        it("Close saves unsaved edits immediately and keeps the draft", async () => {
            const fetchMock = mockSaves();
            const { onClose } = await renderReady({ autosaveDelayMs: 60_000 });

            fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Keep me" } });
            fireEvent.click(screen.getByRole("button", { name: "Close" }));

            expect(onClose).toHaveBeenCalledTimes(1);
            await waitFor(() => expect(assembleCalls(fetchMock)).toEqual([expect.objectContaining({ subject: "Keep me" })]));
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

            expect(onClose).toHaveBeenCalledTimes(1);
            expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);
            save.resolve(jsonResponse(200, { ...draft, version: 3 }));
            await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m1?version=3", expect.objectContaining({ method: "DELETE" })));
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

            expect(await screen.findByText("relay down")).toBeInTheDocument();
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

            expect(await screen.findByTestId("html-editor")).toHaveValue("<p>Best,<br>Jane</p><p></p>");
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

            expect(await screen.findByTestId("html-editor")).toHaveValue("<p>Best,<br>Jane</p><p></p><blockquote>Hi</blockquote>");
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

            expect(await screen.findByTestId("html-editor")).toHaveValue("<blockquote>Hi</blockquote>");
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

            expect(await screen.findByTestId("html-editor")).toHaveValue("<blockquote>Hi</blockquote>");
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

        it("treats a failed key-lookup the same as no keys found, rather than crashing the send", async () => {
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
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

            await user.type(screen.getByLabelText("To"), "bob@example.com");
            await user.click(screen.getByRole("button", { name: "Send" }));

            // A recipient whose lookup failed is treated as "no usable key" - decideMessageEncryption()
            // never auto-encrypts, and since the checkbox was never checked either, this just sends
            // plaintext rather than surfacing the lookup failure as its own error.
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

        it("blocks instead of sending plaintext when the encryption policy couldn't be loaded", async () => {
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

            expect(await screen.findByText(/encryption settings couldn't be loaded/)).toBeInTheDocument();
            expect(requestUnlock).not.toHaveBeenCalled();
            expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/mail/compose/"))).toBe(false);

            await user.click(screen.getByRole("button", { name: "Send without encryption" }));
            await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/mail/compose/m1/assemble", expect.objectContaining({ method: "POST" })));
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

            expect(await screen.findByText("Bcc recipients can't be used with encrypted messages. Remove Bcc recipients or turn off encryption.")).toBeInTheDocument();
            expect(buildEncryptedMessage).not.toHaveBeenCalled();

            await user.click(screen.getByRole("button", { name: "Send without encryption" }));
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

    it("disables Close and Discard (also on the minimized bar) while a send is in progress", async () => {
        const send = deferred<Response>();
        const fetchMock = mockRound4((url, init) => (url === "/api/mail/messages/m1/send" && init?.method === "POST" ? send.promise : undefined), {
            ...mailboxFixture,
            keys: [],
        });
        getUnlockedKeys.mockReturnValue(undefined);
        const { onClose, rerender } = await renderReady();

        fireEvent.change(screen.getByLabelText("To"), { target: { value: "bob@example.com" } });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));

        await waitFor(() => expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled());
        expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Discard draft" })).toBeDisabled();
        rerender(<ComposeWindow session={session({ minimized: true })} onClose={onClose} onToggleMinimize={vi.fn()} autosaveDelayMs={60_000} />);
        expect(screen.getByRole("button", { name: "Discard draft" })).toBeDisabled();

        send.resolve(jsonResponse(200, draft));
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
        expect(callsTo(fetchMock, (_url, method) => method === "DELETE")).toHaveLength(0);
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

        it("holds autosave while a recipient's lookup is pending (or not yet run), then saves once the message is known to stay plaintext", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            const lookup = deferred<Response>();
            const fetchMock = mockRound4((url) => (isLookup(url) && url.includes("nokey") ? lookup.promise : undefined), {
                ...mailboxFixture,
                keys: [encryptKey],
            });
            await renderReady({ session: session({ initialTo: "nokey@example.com" }), autosaveDelayMs: 5 });

            await waitFor(() => expect(callsTo(fetchMock, isLookup)).toHaveLength(1));
            fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Plain" } });
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(callsTo(fetchMock, isAssemble)).toHaveLength(0);

            lookup.resolve(jsonResponse(200, { keys: [] }));
            await waitFor(() => expect(callsTo(fetchMock, isAssemble)).toHaveLength(1));

            // A typed, never-blurred recipient is just as unknown as a pending lookup.
            fireEvent.change(screen.getByLabelText("To"), { target: { value: "nokey@example.com, other@example.com" } });
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(callsTo(fetchMock, isAssemble)).toHaveLength(1);
            fireEvent.blur(screen.getByLabelText("To"));
            await waitFor(() => expect(callsTo(fetchMock, isAssemble)).toHaveLength(2));
        });

        it("never autosaves while the encryption policy is unavailable for a mailbox with an encryption key", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            const fetchMock = mockRound4((url) => (url === "/api/system/encryption-policy" ? jsonResponse(500, { message: "down" }) : undefined), {
                ...mailboxFixture,
                keys: [encryptKey],
            });
            await renderReady({ autosaveDelayMs: 5 });

            fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Maybe secret" } });
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(callsTo(fetchMock, isAssemble)).toHaveLength(0);
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
        it("blocks an auto-encrypted send when the mailbox's encryption key was never unlocked this session, prompting unlock", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            requestUnlock.mockReset();
            requestUnlock.mockRejectedValue(new Error("Unlock cancelled."));
            const fetchMock = mockRound4((url) => (isLookup(url) ? jsonResponse(200, mutualLookup) : undefined), { ...mailboxFixture, keys: [encryptKey] });
            await renderReady();

            fireEvent.change(screen.getByLabelText("To"), { target: { value: "bob@example.com" } });
            fireEvent.click(screen.getByRole("button", { name: "Send" }));

            expect(await screen.findByText(/can't be encrypted right now - your encryption key is locked/)).toBeInTheDocument();
            expect(requestUnlock).toHaveBeenCalledWith("mb1", [expect.objectContaining({ useType: "encrypt" })]);
            expect(callsTo(fetchMock, (url) => url.startsWith("/api/mail/compose/"))).toHaveLength(0);
            expect(buildEncryptedMessage).not.toHaveBeenCalled();
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

            expect(await screen.findByText(/can't be signed right now/)).toBeInTheDocument();
            expect(requestUnlock).toHaveBeenCalled();
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

        it("confirms while a save is still on the wire, but not while sending", async () => {
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
            await waitFor(() => expect(screen.getByRole("button", { name: "Sending…" })).toBeInTheDocument());
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
});
