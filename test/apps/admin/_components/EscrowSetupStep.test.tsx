// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";

const { generateEscrowKeyPair } = vi.hoisted(() => ({ generateEscrowKeyPair: vi.fn() }));
vi.mock("@rapidmx/react-shared/crypto/escrowKeys.js", () => ({ generateEscrowKeyPair }));

import EscrowSetupStep, { DOWNLOAD_URL_LIFETIME_MS, downloadTextFile } from "../../../../apps/shared/components/admin/setup/EscrowSetupStep.js";

const keys = {
    certificateDer: new Uint8Array([1]),
    certificatePem: "-----BEGIN CERTIFICATE-----\nAQ==\n-----END CERTIFICATE-----\n",
    privateKeyPem: "-----BEGIN PRIVATE KEY-----\nAg==\n-----END PRIVATE KEY-----\n",
    publicKey: { publicKey: "AQ==", type: "x509", fingerprint: "abcd", notBefore: Date.UTC(2026, 0, 1), notAfter: Date.UTC(2031, 0, 1) },
};

function mockEscrow(options: { scopes?: unknown[]; create?: (body: any) => Response } = {}) {
    return mockFetch((url, init) => {
        if (url.startsWith("/api/escrow/scopes?")) return jsonResponse(200, options.scopes ?? []);
        if (url === "/api/escrow/scopes" && init?.method === "POST") {
            const body = JSON.parse(init.body as string);
            return options.create ? options.create(body) : jsonResponse(200, { uid: "s1", ...body });
        }
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

let createObjectURL: any;
let revokeObjectURL: any;

beforeEach(() => {
    generateEscrowKeyPair.mockReset().mockResolvedValue(keys);
    createObjectURL = vi.fn(() => "blob:escrow");
    revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

async function addHolder(user: ReturnType<typeof userEvent.setup>, uid: string) {
    const input = screen.getByPlaceholderText(/uid/i);
    await user.type(input, `${uid}{Enter}`);
}

describe("EscrowSetupStep", () => {
    it("defaults to no escrow and lists existing scopes", async () => {
        mockEscrow({ scopes: [{ uid: "s0", name: "Legal" }] });
        render(<EscrowSetupStep />);
        expect(await screen.findByRole("status")).toHaveTextContent("Escrow scopes set up: Legal.");
        expect(screen.getByLabelText("Don't add another escrow scope")).toBeChecked();
        expect(screen.queryByLabelText("Escrow scope name")).not.toBeInTheDocument();
    });

    it("treats a failure to list scopes as none", async () => {
        mockFetch(() => jsonResponse(500, {}));
        render(<EscrowSetupStep />);
        expect(await screen.findByLabelText("Don't use escrow")).toBeChecked();
    });

    it("generates keys, requires the private key to be saved, then creates the scope with the generated public key", async () => {
        const fetchMock = mockEscrow();
        const user = userEvent.setup();
        render(<EscrowSetupStep />);
        await user.click(await screen.findByLabelText("Generate new escrow keys in this browser"));

        await user.clear(screen.getByLabelText("Escrow scope name"));
        await user.click(screen.getByRole("button", { name: "Generate keys" }));
        expect(await screen.findByText("Give the escrow scope a name first.")).toBeInTheDocument();

        await user.type(screen.getByLabelText("Escrow scope name"), "Legal escrow");
        await user.selectOptions(screen.getByLabelText("Keys valid for"), "10");
        await user.click(screen.getByRole("button", { name: "Generate keys" }));
        expect(generateEscrowKeyPair).toHaveBeenCalledWith({ name: "Legal escrow", validDays: 3650 });

        expect(await screen.findByText(/if it.s lost, no escrowed mail can ever be recovered/)).toBeInTheDocument();
        expect(screen.getByLabelText("Escrow scope name")).toBeDisabled();
        expect(screen.queryByRole("button", { name: "Create escrow scope" })).not.toBeInTheDocument();

        // The private key has to be downloaded before it can be marked as saved; the certificate alone isn't enough.
        expect(screen.getByLabelText("I’ve saved the private key somewhere safe")).toBeDisabled();
        expect(screen.getByText("Download the private key before continuing.")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Download certificate" }));
        expect(screen.getByLabelText("I’ve saved the private key somewhere safe")).toBeDisabled();
        await user.click(screen.getByRole("button", { name: "Download private key" }));
        expect(createObjectURL).toHaveBeenCalledTimes(2);
        // Revoked later, so a browser still reading the download isn't cut off.
        expect(revokeObjectURL).not.toHaveBeenCalled();

        await user.click(screen.getByLabelText("I’ve saved the private key somewhere safe"));
        const fingerprint = screen.getByLabelText("Fingerprint (hex SHA-256)");
        expect(fingerprint).toHaveValue("abcd");
        // Generated key fields can't be edited, and what's sent is the generated key regardless of the form.
        expect(fingerprint).toHaveAttribute("readonly");
        expect(screen.getByLabelText("Public key (base64)")).toHaveAttribute("readonly");
        fireEvent.change(fingerprint, { target: { value: "tampered" } });

        await user.click(screen.getByRole("button", { name: "Create escrow scope" }));
        expect(await screen.findByText("At least one holder is required.")).toBeInTheDocument();

        await addHolder(user, "holder-1");
        await user.click(screen.getByRole("button", { name: "Create escrow scope" }));
        await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Escrow scopes set up: Legal escrow."));
        const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === "POST")!;
        expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual(
            expect.objectContaining({
                name: "Legal escrow",
                holderUserUids: ["holder-1"],
                requiredHolders: 1,
                publicKey: keys.publicKey,
            }),
        );
        expect(screen.getByLabelText("Don't add another escrow scope")).toBeChecked();
    });

    it("reports a browser that can't generate keys", async () => {
        mockEscrow();
        generateEscrowKeyPair.mockRejectedValue(new Error("no WebCrypto"));
        const user = userEvent.setup();
        render(<EscrowSetupStep />);
        await user.click(await screen.findByLabelText("Generate new escrow keys in this browser"));
        await user.click(screen.getByRole("button", { name: "Generate keys" }));
        expect(await screen.findByText("This browser couldn't generate the escrow keys.")).toBeInTheDocument();
    });

    it("validates and creates a scope from an existing certificate, showing server errors", async () => {
        let fail = true;
        mockEscrow({ create: (body) => (fail ? jsonResponse(400, { message: "Invalid certificate." }) : jsonResponse(200, { uid: "s2", ...body })) });
        const user = userEvent.setup();
        render(<EscrowSetupStep />);
        await user.click(await screen.findByLabelText("Use a certificate I already have"));

        await user.clear(screen.getByLabelText("Escrow scope name"));
        await user.click(screen.getByRole("button", { name: "Create escrow scope" }));
        expect(await screen.findByText("A name is required.")).toBeInTheDocument();

        await user.type(screen.getByLabelText("Escrow scope name"), "Existing");
        await user.click(screen.getByRole("button", { name: "Create escrow scope" }));
        expect(await screen.findByText("The public key, its type, and its fingerprint are all required.")).toBeInTheDocument();

        await user.type(screen.getByLabelText("Public key (base64)"), "AQ==");
        await user.type(screen.getByLabelText("Fingerprint (hex SHA-256)"), "ff");
        await addHolder(user, "h1");
        fireEvent.change(screen.getByLabelText("Required holders (M-of-N dual control)"), { target: { value: "3" } });
        await user.click(screen.getByRole("button", { name: "Create escrow scope" }));
        expect(await screen.findByText("Required holders must be between 1 and the number of holders.")).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText("Required holders (M-of-N dual control)"), { target: { value: "1" } });
        await user.click(screen.getByRole("button", { name: "Create escrow scope" }));
        expect(await screen.findByText("Invalid certificate.")).toBeInTheDocument();

        fail = false;
        await user.click(screen.getByRole("button", { name: "Create escrow scope" }));
        await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Escrow scopes set up: Existing."));
    });

    it("names downloads 'escrow' when the scope name has no file-safe characters", async () => {
        mockEscrow();
        const filenames: string[] = [];
        const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
            filenames.push(this.download);
        });
        try {
            const user = userEvent.setup();
            render(<EscrowSetupStep />);
            await user.click(await screen.findByLabelText("Generate new escrow keys in this browser"));
            await user.clear(screen.getByLabelText("Escrow scope name"));
            await user.type(screen.getByLabelText("Escrow scope name"), "!!!");
            await user.click(screen.getByRole("button", { name: "Generate keys" }));
            await user.click(await screen.findByRole("button", { name: "Download private key" }));
            await user.click(screen.getByRole("button", { name: "Download certificate" }));
            expect(filenames).toEqual(["escrow-private-key.pem", "escrow-certificate.pem"]);

            // Going back to no escrow discards the generated keys.
            await user.click(screen.getByLabelText("Don't use escrow"));
            expect(screen.getByLabelText("Don't use escrow")).toBeChecked();
            expect(screen.queryByLabelText("Escrow scope name")).not.toBeInTheDocument();
            await user.click(screen.getByLabelText("Generate new escrow keys in this browser"));
            expect(screen.getByRole("button", { name: "Generate keys" })).toBeInTheDocument();
        } finally {
            click.mockRestore();
        }
    });

    it("creates a scope before the existing scopes have loaded, and shows a generic error for a non-API failure", async () => {
        let fail = true;
        mockFetch((url, init) => {
            // The existing scopes never finish loading.
            if (url.startsWith("/api/escrow/scopes?")) return new Promise<Response>(() => undefined);
            if (url === "/api/escrow/scopes" && init?.method === "POST") {
                if (fail) throw new TypeError("network down");
                return jsonResponse(200, { uid: "s3", ...JSON.parse(init.body as string) });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<EscrowSetupStep />);
        await user.click(screen.getByLabelText("Use a certificate I already have"));
        await user.clear(screen.getByLabelText("Escrow scope name"));
        await user.type(screen.getByLabelText("Escrow scope name"), "Early");
        await user.type(screen.getByLabelText("Public key (base64)"), "AQ==");
        await user.type(screen.getByLabelText("Fingerprint (hex SHA-256)"), "ff");
        await addHolder(user, "h1");
        await user.click(screen.getByRole("button", { name: "Create escrow scope" }));
        expect(await screen.findByText("Could not create the escrow scope.")).toBeInTheDocument();

        fail = false;
        await user.click(screen.getByRole("button", { name: "Create escrow scope" }));
        await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Escrow scopes set up: Early."));
    });

    it("downloads text as a named file, revoking its URL only after a delay", () => {
        vi.useFakeTimers();
        try {
            const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
            downloadTextFile("a.pem", "text");
            expect(click).toHaveBeenCalled();
            expect(createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob);
            expect(revokeObjectURL).not.toHaveBeenCalled();
            vi.advanceTimersByTime(DOWNLOAD_URL_LIFETIME_MS);
            expect(revokeObjectURL).toHaveBeenCalledWith("blob:escrow");
            click.mockRestore();
        } finally {
            vi.useRealTimers();
        }
    });
});
