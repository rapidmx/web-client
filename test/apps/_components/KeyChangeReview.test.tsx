// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// The shared old-versus-new key comparison with Accept new key / Keep current key. The message and contact panes that
// use it are covered in MessageDetailPane.keyChange.test.tsx and ContactDetailPane.test.tsx.
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { PinnedKeyChangedError } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import KeyChangeReview, { type KeyChangeReviewProps } from "../../../apps/shared/components/contacts/KeyChangeReview.js";
import {
    KEY_CHANGE_FORBIDDEN_MESSAGE,
    KEY_CHANGE_GENERIC_MESSAGE,
    KEY_CHANGE_INVALID_MESSAGE,
    KEY_CHANGE_NOT_FOUND_MESSAGE,
} from "../../../apps/shared/components/contacts/contactKeys.js";

const { resolveKeyConflict } = vi.hoisted(() => ({ resolveKeyConflict: vi.fn() }));
vi.mock("@rapidmx/react-shared/crypto/keyvaultApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@rapidmx/react-shared/crypto/keyvaultApi.js")>()),
    resolveKeyConflict,
}));

const SINCE = Date.UTC(2025, 5, 1);
const OBSERVED = Date.UTC(2026, 1, 3);

function renderReview(overrides: Partial<KeyChangeReviewProps> = {}) {
    const props: KeyChangeReviewProps = {
        mailboxUid: "mb1",
        address: "jane@example.com",
        useType: "sign",
        ownerName: "Jane Doe",
        current: { fingerprint: "AAAA1111BBBB2222", since: SINCE },
        proposed: { fingerprint: "cccc:3333:dddd:4444", emails: ["jane@example.com"], observedAt: OBSERVED, source: "discovery" },
        canReject: true,
        onResolved: vi.fn(),
        onPinnedKeyChanged: vi.fn(),
        ...overrides,
    };
    render(<KeyChangeReview {...props} />);
    return props;
}

afterEach(() => {
    resolveKeyConflict.mockReset();
});

describe("KeyChangeReview", () => {
    it("compares the current and new keys with their dates, the certificate's addresses and the source", () => {
        renderReview();

        expect(screen.getByText("aaaa 1111 bbbb 2222")).toBeInTheDocument();
        expect(screen.getByText(`First seen ${new Date(SINCE).toLocaleDateString()}`)).toBeInTheDocument();
        expect(screen.getByText("cccc 3333 dddd 4444")).toBeInTheDocument();
        expect(screen.getByText("Certificate for jane@example.com")).toBeInTheDocument();
        expect(screen.getByText(`First seen ${new Date(OBSERVED).toLocaleDateString()}, by key discovery`)).toBeInTheDocument();
        expect(screen.getByText(/routine when Jane Doe renews a certificate, but it can also mean someone is impersonating them/)).toBeInTheDocument();
        expect(screen.getByText(/Confirm the new fingerprint with Jane Doe another way/)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Accept new key" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Keep current key" })).toBeInTheDocument();
    });

    it("labels a header-observed key, a key only seen in the message, and a certificate without addresses", () => {
        const { unmount } = render(
            <KeyChangeReview
                mailboxUid="mb1"
                address="a@example.com"
                useType="sign"
                ownerName="the sender"
                current={{ fingerprint: "aa", since: SINCE }}
                proposed={{ fingerprint: "bb", observedAt: OBSERVED, source: "header" }}
                canReject={false}
                onResolved={vi.fn()}
                onPinnedKeyChanged={vi.fn()}
            />,
        );
        expect(screen.getByText(`First seen ${new Date(OBSERVED).toLocaleDateString()}, from an incoming message`)).toBeInTheDocument();
        expect(screen.queryByText(/Certificate for/)).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Keep current key" })).not.toBeInTheDocument();
        unmount();

        renderReview({ proposed: { fingerprint: "bb", emails: [] } });
        expect(screen.getByText("Certificate for no email address")).toBeInTheDocument();
        expect(screen.getByText("Only seen in this message")).toBeInTheDocument();

        renderReview({ proposed: { fingerprint: "bb", observedAt: OBSERVED } });
        expect(screen.getByText(`First seen ${new Date(OBSERVED).toLocaleDateString()}`)).toBeInTheDocument();
    });

    it.each([
        ["the current key couldn't be loaded", { current: undefined }],
        ["there's no address", { address: undefined }],
        ["the reader is known to lack rights", { canResolve: false }],
    ])("hides the actions when %s", (_label, overrides) => {
        renderReview(overrides);
        expect(screen.queryByRole("button", { name: "Accept new key" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Keep current key" })).not.toBeInTheDocument();
    });

    it("says when the current key couldn't be loaded", () => {
        renderReview({ current: undefined });
        expect(screen.getByText("The key you trust couldn’t be loaded.")).toBeInTheDocument();
    });

    it("asks for confirmation before accepting; Cancel and the close button change nothing", async () => {
        const user = userEvent.setup();
        const props = renderReview({ useType: "encrypt" });

        await user.click(screen.getByRole("button", { name: "Accept new key" }));
        const dialog = screen.getByRole("dialog");
        expect(dialog).toHaveTextContent("Mail you send to jane@example.com will be encrypted to this key.");
        expect(dialog).toHaveTextContent("The current encryption key moves to this contact’s key history.");
        expect(dialog).toHaveTextContent("cccc 3333 dddd 4444");
        expect(dialog).toHaveTextContent("Only accept it once you’ve confirmed this fingerprint with Jane Doe.");

        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Accept new key" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

        expect(resolveKeyConflict).not.toHaveBeenCalled();
        expect(props.onResolved).not.toHaveBeenCalled();
    });

    it("accepts with the given certificate against the pinned fingerprint shown", async () => {
        resolveKeyConflict.mockResolvedValue({ keys: [] });
        const user = userEvent.setup();
        const props = renderReview({ certificate: "bmV3" });

        await user.click(screen.getByRole("button", { name: "Accept new key" }));
        const dialog = screen.getByRole("dialog");
        expect(dialog).toHaveTextContent("Mail from jane@example.com signed with this key will show as verified.");
        expect(dialog).toHaveTextContent("The current signing key moves");
        await user.click(within(dialog).getByRole("button", { name: "Accept new key" }));

        await waitFor(() => expect(props.onResolved).toHaveBeenCalledWith("accept"));
        expect(resolveKeyConflict).toHaveBeenCalledWith("mb1", {
            address: "jane@example.com",
            useType: "sign",
            action: "accept",
            expectedPinnedFingerprint: "AAAA1111BBBB2222",
            certificate: "bmV3",
        });
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("accepts the recorded key when no certificate is given, ignoring close while the request runs", async () => {
        let finish!: (value: unknown) => void;
        resolveKeyConflict.mockReturnValue(new Promise((resolve) => (finish = resolve)));
        const user = userEvent.setup();
        const props = renderReview();

        await user.click(screen.getByRole("button", { name: "Accept new key" }));
        const dialog = screen.getByRole("dialog");
        await user.click(within(dialog).getByRole("button", { name: "Accept new key" }));
        await user.click(within(dialog).getByRole("button", { name: "Close" }));
        expect(screen.getByRole("dialog")).toBeInTheDocument();

        finish({ keys: [] });
        await waitFor(() => expect(props.onResolved).toHaveBeenCalledWith("accept"));
        expect(resolveKeyConflict.mock.calls[0][1]).not.toHaveProperty("certificate");
    });

    it("keeps the current key without a confirmation, never sending a certificate", async () => {
        resolveKeyConflict.mockResolvedValue({ keys: [] });
        const user = userEvent.setup();
        const props = renderReview({ certificate: "bmV3" });

        await user.click(screen.getByRole("button", { name: "Keep current key" }));

        await waitFor(() => expect(props.onResolved).toHaveBeenCalledWith("reject"));
        expect(resolveKeyConflict).toHaveBeenCalledWith("mb1", {
            address: "jane@example.com",
            useType: "sign",
            action: "reject",
            expectedPinnedFingerprint: "AAAA1111BBBB2222",
        });
    });

    it("hands a 409 to the caller to reload instead of showing an error", async () => {
        resolveKeyConflict.mockRejectedValue(new PinnedKeyChangedError("changed"));
        const user = userEvent.setup();
        const props = renderReview();

        await user.click(screen.getByRole("button", { name: "Accept new key" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Accept new key" }));

        await waitFor(() => expect(props.onPinnedKeyChanged).toHaveBeenCalled());
        expect(props.onResolved).not.toHaveBeenCalled();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it.each([
        [new ApiRequestError("bad certificate", 400), KEY_CHANGE_INVALID_MESSAGE],
        [new ApiRequestError("gone", 404), KEY_CHANGE_NOT_FOUND_MESSAGE],
        [new Error("network"), KEY_CHANGE_GENERIC_MESSAGE],
    ])("shows %s as its own copy and keeps the actions", async (err, expected) => {
        resolveKeyConflict.mockRejectedValue(err);
        const user = userEvent.setup();
        const props = renderReview();

        await user.click(screen.getByRole("button", { name: "Accept new key" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Accept new key" }));

        expect(await screen.findByText(expected)).toBeInTheDocument();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Accept new key" })).toBeInTheDocument();
        expect(props.onResolved).not.toHaveBeenCalled();

        // Reopening the confirmation clears the error.
        await user.click(screen.getByRole("button", { name: "Accept new key" }));
        expect(screen.queryByText(expected)).not.toBeInTheDocument();
    });

    it("hides the actions after a 403", async () => {
        resolveKeyConflict.mockRejectedValue(new ApiRequestError("forbidden", 403));
        const user = userEvent.setup();
        renderReview();

        await user.click(screen.getByRole("button", { name: "Keep current key" }));

        expect(await screen.findByText(KEY_CHANGE_FORBIDDEN_MESSAGE)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Accept new key" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Keep current key" })).not.toBeInTheDocument();
    });
});
