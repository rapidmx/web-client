// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import EscrowScopeCard from "../../../../apps/shared/components/admin/mailboxes/EscrowScopeCard.js";
import { ELEVATION_ACTION_MESSAGE } from "../../../../apps/shared/components/admin/elevation.js";
import { ApiClientContext } from "../../../../lib/util/apiClientContext.js";
import { createApiClient } from "../../../../lib/util/api.js";

const mailbox = {
    uid: "mb1",
    version: 3,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ownerUserUid: "u1",
    primarySmtpAddress: "u1@example.com",
    aliasAddresses: [],
    displayName: "User One",
    timezone: "UTC",
    quotaBytes: 1_000_000_000,
    usedBytes: 0,
};

const scope = (uid: string, name: string) => ({ uid, name, holderUserUids: ["h1", "h2"], requiredHolders: 2 });

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("EscrowScopeCard", () => {
    it("assigns a scope, then unassigns it by sending null", async () => {
        const bodies: any[] = [];
        mockFetch((url, init) => {
            if (url === "/api/escrow/scopes?limit=200&page=0&sort=%7B%22uid%22%3A%22ASC%22%7D") return jsonResponse(200, [scope("es1", "Legal"), scope("es2", "HR")]);
            if (url === "/api/mail/mailboxes/mb1" && init?.method === "PUT") {
                const body = JSON.parse(init.body as string);
                bodies.push(body);
                return jsonResponse(200, { ...mailbox, version: mailbox.version + bodies.length, escrowScopeId: body.escrowScopeId ?? undefined });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const onUpdate = vi.fn();
        const user = userEvent.setup();
        const { rerender } = render(<EscrowScopeCard mailbox={mailbox} onUpdate={onUpdate} />);

        const select = await screen.findByLabelText("Escrow scope");
        expect(select).toHaveValue("");
        expect(screen.getByRole("button", { name: "Save escrow scope" })).toBeDisabled();
        await user.selectOptions(select, "es2");
        await user.click(screen.getByRole("button", { name: "Save escrow scope" }));

        // Confirmed first, showing the old and new scope with their holders and approvals.
        let dialog = await screen.findByRole("dialog", { name: "Change escrow scope" });
        expect(within(dialog).getByText(/No escrow - nobody can recover/)).toBeInTheDocument();
        expect(within(dialog).getByText("HR")).toBeInTheDocument();
        expect(within(dialog).getByText(/holders h1, h2; 2 of 2 must approve/)).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog", { name: "Change escrow scope" })).not.toBeInTheDocument();
        expect(bodies).toHaveLength(0);

        await user.click(screen.getByRole("button", { name: "Save escrow scope" }));
        dialog = await screen.findByRole("dialog", { name: "Change escrow scope" });
        await user.click(within(dialog).getByRole("button", { name: "Close" }));
        expect(bodies).toHaveLength(0);

        await user.click(screen.getByRole("button", { name: "Save escrow scope" }));
        await user.click(within(await screen.findByRole("dialog", { name: "Change escrow scope" })).getByRole("button", { name: "Confirm and save" }));
        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(bodies[0]).toEqual({ uid: "mb1", version: 3, escrowScopeId: "es2" });
        const updated = onUpdate.mock.calls[0][0];
        expect(updated.escrowScopeId).toBe("es2");
        rerender(<EscrowScopeCard mailbox={updated} onUpdate={onUpdate} />);

        await user.selectOptions(screen.getByLabelText("Escrow scope"), "");
        expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Save escrow scope" }));
        dialog = await screen.findByRole("dialog", { name: "Change escrow scope" });
        expect(within(dialog).getByText("HR")).toBeInTheDocument();
        expect(within(dialog).getByText(/No escrow/)).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Confirm and save" }));
        await vi.waitFor(() => expect(bodies).toHaveLength(2));
        expect(bodies[1]).toEqual({ uid: "mb1", version: 4, escrowScopeId: null });
    });

    it("keeps an assigned scope that isn't in the list selectable, and names it in the confirmation", async () => {
        mockFetch(() => jsonResponse(200, [scope("es1", "Legal")]));
        const user = userEvent.setup();
        render(<EscrowScopeCard mailbox={{ ...mailbox, escrowScopeId: "es-gone" }} onUpdate={vi.fn()} />);

        expect(await screen.findByRole("option", { name: "Unknown scope (es-gone)" })).toBeInTheDocument();
        expect(screen.getByLabelText("Escrow scope")).toHaveValue("es-gone");

        await user.selectOptions(screen.getByLabelText("Escrow scope"), "es1");
        await user.click(screen.getByRole("button", { name: "Save escrow scope" }));
        const dialog = await screen.findByRole("dialog", { name: "Change escrow scope" });
        expect(within(dialog).getByText("Unknown scope (es-gone)")).toBeInTheDocument();
        expect(within(dialog).getByText("Legal")).toBeInTheDocument();
    });

    it("shows load failures", async () => {
        mockFetch(() => jsonResponse(403, { message: "trusted only" }));
        const { unmount } = render(<EscrowScopeCard mailbox={mailbox} onUpdate={vi.fn()} />);
        expect(await screen.findByText("trusted only")).toBeInTheDocument();
        expect(screen.queryByLabelText("Escrow scope")).not.toBeInTheDocument();
        unmount();

        mockFetch(() => {
            throw new TypeError("network down");
        });
        render(<EscrowScopeCard mailbox={mailbox} onUpdate={vi.fn()} />);
        expect(await screen.findByText("Could not load escrow scopes.")).toBeInTheDocument();
    });

    it("tells an administrator whose confirmation of identity has lapsed (api-104) what to do when saving", async () => {
        mockFetch((_url, init) => (init?.method === "PUT" ? jsonResponse(403, { code: "api-104", message: "This operation requires elevation." }) : jsonResponse(200, [scope("es1", "Legal")])));
        const user = userEvent.setup();
        render(<EscrowScopeCard mailbox={mailbox} onUpdate={vi.fn()} />);

        await user.selectOptions(await screen.findByLabelText("Escrow scope"), "es1");
        await user.click(screen.getByRole("button", { name: "Save escrow scope" }));
        await user.click(await screen.findByRole("button", { name: "Confirm and save" }));
        expect(await screen.findByText(ELEVATION_ACTION_MESSAGE)).toBeInTheDocument();
    });

    it("shows save failures", async () => {
        let failure: () => Response = () => jsonResponse(404, { message: "no such scope" });
        mockFetch((url, init) => {
            if (init?.method === "PUT") return failure();
            return jsonResponse(200, [scope("es1", "Legal")]);
        });
        const user = userEvent.setup();
        render(<EscrowScopeCard mailbox={mailbox} onUpdate={vi.fn()} />);

        await user.selectOptions(await screen.findByLabelText("Escrow scope"), "es1");
        await user.click(screen.getByRole("button", { name: "Save escrow scope" }));
        await user.click(await screen.findByRole("button", { name: "Confirm and save" }));
        expect(await screen.findByText("no such scope")).toBeInTheDocument();

        failure = () => {
            throw new TypeError("network down");
        };
        await user.click(screen.getByRole("button", { name: "Save escrow scope" }));
        await user.click(await screen.findByRole("button", { name: "Confirm and save" }));
        expect(await screen.findByText("Could not save the escrow scope.")).toBeInTheDocument();
    });

    it("targets the ApiClient from ApiClientContext, not the default cookie-based fetch, when one is provided", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch((url, init) => {
            if (url.startsWith("/api/")) {
                throw new Error(`unexpected default-fetch call while an ApiClientContext was provided: ${url}`);
            }
            if (url === "https://account-a.example.com/api/escrow/scopes?limit=200&page=0&sort=%7B%22uid%22%3A%22ASC%22%7D") return jsonResponse(200, [scope("es1", "Legal")]);
            if (url === "https://account-a.example.com/api/mail/mailboxes/mb1" && init?.method === "PUT") {
                const body = JSON.parse(init.body as string);
                return jsonResponse(200, { ...mailbox, version: mailbox.version + 1, escrowScopeId: body.escrowScopeId ?? undefined });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(
            <ApiClientContext.Provider value={client}>
                <EscrowScopeCard mailbox={mailbox} onUpdate={vi.fn()} />
            </ApiClientContext.Provider>,
        );

        await user.selectOptions(await screen.findByLabelText("Escrow scope"), "es1");
        await user.click(screen.getByRole("button", { name: "Save escrow scope" }));
        await user.click(await screen.findByRole("button", { name: "Confirm and save" }));

        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        const put = fetchMock.mock.calls.find(([url, init]) => url === "https://account-a.example.com/api/mail/mailboxes/mb1" && init?.method === "PUT")!;
        expect(new Headers((put[1] as RequestInit).headers).get("Authorization")).toBe("jwt tok-a");
    });
});
