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

const { getUnlockedKeys } = vi.hoisted(() => ({ getUnlockedKeys: vi.fn() }));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({ getUnlockedKeys }));

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
    vi.unstubAllGlobals();
    getUnlockedKeys.mockReset();
    buildSignedOnlyMessage.mockReset();
    buildEncryptedMessage.mockReset();
});

describe("ComposeWindow", () => {
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

    it("calls onClose when Close is clicked, and when Discard draft is clicked", async () => {
        mockCompose();
        const onClose = vi.fn();
        const user = userEvent.setup();
        render(<ComposeWindow session={session()} onClose={onClose} onToggleMinimize={vi.fn()} />);
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).toHaveBeenCalledTimes(1);

        await user.click(screen.getByRole("button", { name: "Discard draft" }));
        expect(onClose).toHaveBeenCalledTimes(2);
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

        it("assembles the draft, sets scheduledSendTime, sends it, and closes the window", async () => {
            const fetchMock = mockCompose((url, init) => {
                const method = init?.method ?? "GET";
                if (url === "/api/mail/compose/m1/assemble" && method === "POST") return jsonResponse(200, draft);
                if (url === "/api/mail/messages/m1" && method === "PUT") {
                    const body = JSON.parse(init!.body as string);
                    return jsonResponse(200, { ...draft, scheduledSendTime: body.scheduledSendTime });
                }
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
            const putCall = fetchMock.mock.calls.find((call) => call[0] === "/api/mail/messages/m1" && (call[1] as RequestInit)?.method === "PUT")!;
            const putBody = JSON.parse((putCall[1] as RequestInit).body as string);
            expect(putBody.uid).toBe("m1");
            expect(new Date(putBody.scheduledSendTime).getTime()).toBeGreaterThan(Date.now());
            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m1/send", expect.objectContaining({ method: "POST" })),
            );
            await waitFor(() => expect(onClose).toHaveBeenCalled());
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

        it("shows a generic error message when setting scheduledSendTime fails with a non-API error", async () => {
            mockCompose((url, init) => {
                const method = init?.method ?? "GET";
                if (url === "/api/mail/compose/m1/assemble" && method === "POST") return jsonResponse(200, draft);
                if (url === "/api/mail/messages/m1" && method === "PUT") throw new TypeError("network down");
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
                if (url === "/api/mail/encryption-policy") return jsonResponse(200, overrides?.policy ?? automaticPolicy);
                if (url === "/api/mail/compose/m1/assemble-raw" && method === "POST") return jsonResponse(200, draft);
                if (url === "/api/mail/messages/m1/send" && method === "POST") return jsonResponse(200, draft);
                return undefined;
            });
        }

        it("does not render Sign/Encrypt checkboxes when no key has been unlocked this session", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            mockCryptoEndpoints();
            render(<ComposeWindow session={session()} onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
            await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

            expect(screen.queryByLabelText(/Digitally sign/)).not.toBeInTheDocument();
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
                if (url === "/api/mail/encryption-policy") return jsonResponse(200, automaticPolicy);
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
    });
});
