// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../../testUtils.js";
import EscrowScopeDetailPage from "../../../../apps/admin/escrow-scopes/[uid].js";

const scope = {
    uid: "es1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    name: "Legal Hold Q1",
    description: "eDiscovery scope",
    publicKey: {
        publicKey: "base64cert",
        type: "x509",
        fingerprint: "abc123",
        notBefore: 1735689600000,
        notAfter: 1767225600000,
    },
    holderUserUids: ["u1", "u2"],
    requiredHolders: 2,
    notifySubjectOnAccess: false,
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("EscrowScopeDetailPage", () => {
    it("renders the loaded scope's fields", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/scopes/es1") return jsonResponse(200, scope);
            throw new Error(`unexpected ${url}`);
        });
        render(<EscrowScopeDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "es1" }} />);

        expect(await screen.findByRole("heading", { name: "Legal Hold Q1" })).toBeInTheDocument();
        expect(screen.getByLabelText("Name")).toHaveValue("Legal Hold Q1");
        expect(screen.getByLabelText("Public key (base64)")).toHaveValue("base64cert");
        expect(screen.getByLabelText("Fingerprint (hex SHA-256)")).toHaveValue("abc123");
        expect(screen.getByText("u1")).toBeInTheDocument();
        expect(screen.getByText("u2")).toBeInTheDocument();
        expect(screen.getByLabelText("Required holders (M-of-N dual control)")).toHaveValue(2);
    });

    it("validates the name before saving", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/scopes/es1") return jsonResponse(200, scope);
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        render(<EscrowScopeDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "es1" }} />);
        await screen.findByLabelText("Name");

        await user.clear(screen.getByLabelText("Name"));
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(await screen.findByText("A name is required.")).toBeInTheDocument();
    });

    it("validates the holder list is not emptied out before saving", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/scopes/es1") return jsonResponse(200, scope);
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        render(<EscrowScopeDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "es1" }} />);
        await screen.findByLabelText("Name");

        await user.click(screen.getAllByRole("button", { name: "Remove" })[0]);
        await user.click(screen.getAllByRole("button", { name: "Remove" })[0]);
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(await screen.findByText("At least one holder is required.")).toBeInTheDocument();
    });

    it("validates the public key fields are not blanked out before saving", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/scopes/es1") return jsonResponse(200, scope);
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        render(<EscrowScopeDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "es1" }} />);
        await screen.findByLabelText("Name");

        await user.clear(screen.getByLabelText("Public key (base64)"));
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(
            await screen.findByText("The public key, its type, and its fingerprint are all required."),
        ).toBeInTheDocument();
    });

    it("validates requiredHolders stays within 1..holderUserUids.length before saving", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/scopes/es1") return jsonResponse(200, scope);
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        render(<EscrowScopeDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "es1" }} />);
        await screen.findByLabelText("Name");

        const requiredHolders = screen.getByLabelText("Required holders (M-of-N dual control)");
        await user.clear(requiredHolders);
        await user.type(requiredHolders, "5");
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(
            await screen.findByText("Required holders must be between 1 and the number of holders."),
        ).toBeInTheDocument();
    });

    it("edits the description", async () => {
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/scopes/es1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, scope);
            if (url === "/api/escrow/scopes/es1" && init?.method === "PUT") {
                const body = JSON.parse(init.body as string);
                return jsonResponse(200, { ...scope, version: 1, description: body.description });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<EscrowScopeDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "es1" }} />);
        await screen.findByLabelText("Name");

        await user.clear(screen.getByLabelText("Description (optional)"));
        await user.type(screen.getByLabelText("Description (optional)"), "Updated description");
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(screen.getByLabelText("Description (optional)")).toHaveValue("Updated description");
    });

    it("renders an empty description field when the loaded scope has none", async () => {
        const { description, ...scopeWithoutDescription } = scope;
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/scopes/es1") return jsonResponse(200, scopeWithoutDescription);
            throw new Error(`unexpected ${url}`);
        });
        render(<EscrowScopeDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "es1" }} />);

        expect(await screen.findByLabelText("Name")).toBeInTheDocument();
        expect(screen.getByLabelText("Description (optional)")).toHaveValue("");
    });

    it("sends a null description when the field is cleared to empty", async () => {
        let requestBody: any;
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/scopes/es1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, scope);
            if (url === "/api/escrow/scopes/es1" && init?.method === "PUT") {
                requestBody = JSON.parse(init.body as string);
                return jsonResponse(200, { ...scope, version: 1, description: undefined });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<EscrowScopeDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "es1" }} />);
        await screen.findByLabelText("Name");

        await user.clear(screen.getByLabelText("Description (optional)"));
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        await vi.waitFor(() => expect(requestBody).toBeDefined());
        expect(requestBody.description).toBeNull();
        // No key field was touched, so the stored key isn't re-sent (and so never truncated).
        expect(requestBody).not.toHaveProperty("publicKey");
    });

    it("confirms a notifySubjectOnAccess change", async () => {
        let requestBody: any;
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/scopes/es1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, scope);
            if (url === "/api/escrow/scopes/es1" && init?.method === "PUT") {
                requestBody = JSON.parse(init.body as string);
                return jsonResponse(200, { ...scope, ...requestBody, version: 1 });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<EscrowScopeDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "es1" }} />);
        await screen.findByLabelText("Name");

        await user.click(screen.getByLabelText("Notify subject on access"));
        await user.click(screen.getByRole("button", { name: "Save changes" }));
        expect(await screen.findByText("Notify subject on access: off → on")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Confirm and save" }));
        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(requestBody.notifySubjectOnAccess).toBe(true);
        expect(requestBody).not.toHaveProperty("publicKey");
    });

    it("keeps the original epoch-ms of an untouched date and revokedAt when only the validity window changes", async () => {
        let requestBody: any;
        const revokedScope = {
            ...scope,
            notifySubjectOnAccess: true,
            publicKey: { ...scope.publicKey, notBefore: 1735689600123, revokedAt: 1740000000456 },
        };
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/scopes/es1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, revokedScope);
            if (url === "/api/escrow/scopes/es1" && init?.method === "PUT") {
                requestBody = JSON.parse(init.body as string);
                return jsonResponse(200, { ...revokedScope, ...requestBody, version: 1 });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<EscrowScopeDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "es1" }} />);
        await screen.findByLabelText("Name");

        fireEvent.change(screen.getByLabelText("Not after"), { target: { value: "2030-01-01T00:00" } });
        await user.click(screen.getByLabelText("Notify subject on access"));
        await user.click(screen.getByRole("button", { name: "Save changes" }));
        expect(await screen.findByText("Notify subject on access: on → off")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Confirm and save" }));
        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(requestBody.publicKey).toEqual({
            publicKey: "base64cert",
            type: "x509",
            fingerprint: "abc123",
            notBefore: 1735689600123,
            notAfter: new Date("2030-01-01T00:00").getTime(),
            revokedAt: 1740000000456,
        });
    });

    it("drops revokedAt and keeps both original dates when the key material is replaced", async () => {
        let requestBody: any;
        const revokedScope = { ...scope, publicKey: { ...scope.publicKey, notAfter: 1767225600789, revokedAt: 1740000000456 } };
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/scopes/es1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, revokedScope);
            if (url === "/api/escrow/scopes/es1" && init?.method === "PUT") {
                requestBody = JSON.parse(init.body as string);
                return jsonResponse(200, { ...revokedScope, ...requestBody, version: 1 });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<EscrowScopeDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "es1" }} />);
        await screen.findByLabelText("Name");

        await user.type(screen.getByLabelText("Fingerprint (hex SHA-256)"), "d");
        fireEvent.change(screen.getByLabelText("Not before"), { target: { value: "2025-06-01T00:00" } });
        await user.click(screen.getByRole("button", { name: "Save changes" }));
        await user.click(await screen.findByRole("button", { name: "Confirm and save" }));
        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(requestBody.publicKey).toEqual({
            publicKey: "base64cert",
            type: "x509",
            fingerprint: "abc123d",
            notBefore: new Date("2025-06-01T00:00").getTime(),
            notAfter: 1767225600789,
        });
    });

    it("saves changes and shows a confirmation", async () => {
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/scopes/es1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, scope);
            if (url === "/api/escrow/scopes/es1" && init?.method === "PUT") {
                return jsonResponse(200, { ...scope, version: 1, name: "Renamed scope" });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<EscrowScopeDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "es1" }} />);
        await screen.findByLabelText("Name");

        await user.clear(screen.getByLabelText("Name"));
        await user.type(screen.getByLabelText("Name"), "Renamed scope");
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Renamed scope" })).toBeInTheDocument();
    });

    it("refuses to add the signed-in admin as a holder, but keeps an admin who was already one", async () => {
        const fetchMock = mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/scopes/es1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, scope);
            if (url === "/api/escrow/scopes/es1" && init?.method === "PUT") return jsonResponse(200, { ...scope, version: 1 });
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        const { unmount } = render(
            <EscrowScopeDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "es1" }} />,
        );
        await screen.findByLabelText("Name");

        await user.type(screen.getByLabelText("Holder user uids"), "admin-1");
        await user.click(screen.getByRole("button", { name: "Add" }));
        await user.click(screen.getByRole("button", { name: "Save changes" }));
        expect(await screen.findByText(/You can't add yourself as a holder/)).toBeInTheDocument();
        expect(screen.queryByText("Confirm escrow scope changes")).not.toBeInTheDocument();
        expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === "PUT")).toBe(false);
        unmount();

        // u1 is already a holder, so an unrelated save by u1 goes straight through.
        render(<EscrowScopeDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "es1" }} />);
        await screen.findByLabelText("Name");
        await user.click(screen.getByRole("button", { name: "Save changes" }));
        expect(await screen.findByText("Saved.")).toBeInTheDocument();
    });

    it("confirms holder, approval-count, and key changes with a diff before saving", async () => {
        let requestBody: any;
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/scopes/es1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, scope);
            if (url === "/api/escrow/scopes/es1" && init?.method === "PUT") {
                requestBody = JSON.parse(init.body as string);
                return jsonResponse(200, { ...scope, ...requestBody, version: 1 });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<EscrowScopeDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "es1" }} />);
        await screen.findByLabelText("Name");

        await user.click(screen.getAllByRole("button", { name: "Remove" })[1]);
        await user.type(screen.getByLabelText("Holder user uids"), "u3");
        await user.click(screen.getByRole("button", { name: "Add" }));
        fireEvent.change(screen.getByLabelText("Required holders (M-of-N dual control)"), { target: { value: "1" } });
        await user.type(screen.getByLabelText("Public key (base64)"), "X");
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(await screen.findByText("Confirm escrow scope changes")).toBeInTheDocument();
        expect(screen.getByText("Add holders: u3")).toBeInTheDocument();
        expect(screen.getByText("Remove holders: u2")).toBeInTheDocument();
        expect(screen.getByText("Required approvals: 2 → 1")).toBeInTheDocument();
        expect(screen.getByText("Replace the public key")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByText("Confirm escrow scope changes")).not.toBeInTheDocument();
        expect(requestBody).toBeUndefined();

        await user.click(screen.getByRole("button", { name: "Save changes" }));
        await user.click(await screen.findByRole("button", { name: "Confirm and save" }));
        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(requestBody.holderUserUids).toEqual(["u1", "u3"]);
        expect(requestBody.requiredHolders).toBe(1);
    });

    it("lists fingerprint, key type, and validity changes in the confirmation", async () => {
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/scopes/es1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, scope);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<EscrowScopeDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "es1" }} />);
        await screen.findByLabelText("Name");

        await user.type(screen.getByLabelText("Fingerprint (hex SHA-256)"), "d");
        await user.type(screen.getByLabelText("Key type"), "v3");
        fireEvent.change(screen.getByLabelText("Not after"), { target: { value: "2030-01-01T00:00" } });
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(await screen.findByText("Fingerprint: abc123 → abc123d")).toBeInTheDocument();
        expect(screen.getByText("Replace the public key")).toBeInTheDocument();
        expect(screen.getByText(/^Key validity: .* → .*2030-01-01T00:00$/)).toBeInTheDocument();
        // Closing the modal (Escape) leaves the edits unsaved.
        await user.keyboard("{Escape}");
        expect(screen.queryByText("Confirm escrow scope changes")).not.toBeInTheDocument();
    });

    it("shows an error message when saving fails", async () => {
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/scopes/es1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, scope);
            if (url === "/api/escrow/scopes/es1" && init?.method === "PUT") return jsonResponse(409, { message: "version conflict" });
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<EscrowScopeDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "es1" }} />);
        await screen.findByLabelText("Name");

        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(await screen.findByText("version conflict")).toBeInTheDocument();
    });

    it("shows a generic error message when saving fails with a non-API error", async () => {
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/scopes/es1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, scope);
            if (url === "/api/escrow/scopes/es1" && init?.method === "PUT") throw new TypeError("network down");
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<EscrowScopeDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "es1" }} />);
        await screen.findByLabelText("Name");

        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(await screen.findByText("Could not save this escrow scope.")).toBeInTheDocument();
    });

    it("shows an error message when the scope fails to load", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            return jsonResponse(404, { message: "not found" });
        });
        render(<EscrowScopeDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "es1" }} />);
        expect(await screen.findByText("not found")).toBeInTheDocument();
    });

    it("shows a generic error message when loading fails with a non-API error", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            throw new TypeError("network down");
        });
        render(<EscrowScopeDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "es1" }} />);
        expect(await screen.findByText("Could not load this escrow scope.")).toBeInTheDocument();
    });

    it("falls back to 'Escrow scope not found.' when the load succeeds with no scope and no error", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/scopes/es1") return jsonResponse(200, null);
            throw new Error(`unexpected ${url}`);
        });
        render(<EscrowScopeDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "es1" }} />);
        expect(await screen.findByText("Escrow scope not found.")).toBeInTheDocument();
    });

    it("deletes the scope via the confirmation modal and redirects to the list", async () => {
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/scopes/es1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, scope);
            if (url === "/api/escrow/scopes/es1?version=0" && init?.method === "DELETE") return jsonResponse(200, {});
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const location = mockLocation();
        const user = userEvent.setup();
        render(<EscrowScopeDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "es1" }} />);
        await screen.findByLabelText("Name");

        await user.click(screen.getByRole("button", { name: "Delete scope" }));
        await user.click(screen.getByRole("button", { name: "Delete" }));

        await vi.waitFor(() => expect(location.href).toBe("/admin/escrow-scopes"));
    });

    it("shows a generic error message in the modal when deletion fails with a non-API error", async () => {
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/scopes/es1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, scope);
            if (url === "/api/escrow/scopes/es1?version=0" && init?.method === "DELETE") {
                throw new TypeError("network down");
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<EscrowScopeDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "es1" }} />);
        await screen.findByLabelText("Name");

        await user.click(screen.getByRole("button", { name: "Delete scope" }));
        await user.click(screen.getByRole("button", { name: "Delete" }));

        expect(await screen.findByText("Could not delete this escrow scope.")).toBeInTheDocument();
    });

    it("shows an error in the modal (e.g. a referencing Matter) without closing it, and Cancel closes it", async () => {
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/scopes/es1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, scope);
            if (url === "/api/escrow/scopes/es1?version=0" && init?.method === "DELETE") {
                return jsonResponse(409, { message: "This escrow scope is referenced by an existing Matter and cannot be deleted." });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<EscrowScopeDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "es1" }} />);
        await screen.findByLabelText("Name");

        await user.click(screen.getByRole("button", { name: "Delete scope" }));
        await user.click(screen.getByRole("button", { name: "Delete" }));

        expect(
            await screen.findByText("This escrow scope is referenced by an existing Matter and cannot be deleted."),
        ).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByText("Delete escrow scope")).not.toBeInTheDocument();
    });

    it("keeps the delete confirmation open while deleting", async () => {
        const pending: ((response: Response) => void)[] = [];
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/scopes/es1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, scope);
            if (init?.method === "DELETE") return new Promise<Response>((resolve) => pending.push(resolve));
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<EscrowScopeDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "es1" }} />);
        await screen.findByLabelText("Name");

        await user.click(screen.getByRole("button", { name: "Delete scope" }));
        const dialog = await screen.findByRole("dialog", { name: "Delete escrow scope" });
        await user.click(within(dialog).getByRole("button", { name: "Delete" }));
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        await user.keyboard("{Escape}");
        expect(screen.getByRole("dialog", { name: "Delete escrow scope" })).toBeInTheDocument();
        pending[0](jsonResponse(409, { message: "referenced by a Matter" }));
        expect(await within(dialog).findByText("referenced by a Matter")).toBeInTheDocument();
    });
});
