// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import EncryptionPolicyPage from "../../../../apps/admin/encryption-policy/index.js";
import { isEncryptionEnabled } from "../../../../apps/shared/components/admin/settings/EncryptionPolicyForm.js";

const optional = { encryptSameOrg: "optional", encryptFederated: "optional", encryptExternal: "optional" };

function mockPolicy(put?: (body: any) => Response, get: Response = jsonResponse(200, optional)) {
    return mockFetch((url, init) => {
        if (url === "/api/admin/release-notes") return jsonResponse(200, {});
        if (url === "/api/system/setup") return jsonResponse(200, { required: false });
        if (url === "/api/system/encryption-policy" && init?.method === "PUT") return put!(JSON.parse(init.body as string));
        if (url === "/api/system/encryption-policy") return get;
        throw new Error(`unexpected ${url}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("EncryptionPolicyPage", () => {
    it("saves each tier's setting", async () => {
        const saved: any[] = [];
        mockPolicy((body) => {
            saved.push(body);
            return jsonResponse(200, body);
        });
        const user = userEvent.setup();
        render(<EncryptionPolicyPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        await user.selectOptions(await screen.findByLabelText("Mail within this server"), "automatic");
        await user.selectOptions(screen.getByLabelText("Mail to everyone else"), "prohibited");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await user.click(await screen.findByRole("button", { name: "Save and turn off encryption" }));
        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(saved).toEqual([{ encryptSameOrg: "automatic", encryptFederated: "optional", encryptExternal: "prohibited" }]);

        await user.selectOptions(screen.getByLabelText("Mail to other RapidMX servers"), "automatic");
        expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
    });

    it("asks before turning encryption off for a kind of mail, naming it, and saves nothing on Cancel", async () => {
        const saved: any[] = [];
        mockPolicy((body) => {
            saved.push(body);
            return jsonResponse(200, body);
        });
        const user = userEvent.setup();
        render(<EncryptionPolicyPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        await user.selectOptions(await screen.findByLabelText("Mail within this server"), "prohibited");
        await user.selectOptions(screen.getByLabelText("Mail to everyone else"), "prohibited");
        await user.click(screen.getByRole("button", { name: "Save" }));
        const dialog = await screen.findByRole("dialog", { name: "Turn off encryption?" });
        expect(within(dialog).getByText("Mail within this server, Mail to everyone else")).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(saved).toEqual([]);

        // Tiers that were already off are not asked about again, and a save that turns none off goes straight through.
        await user.selectOptions(screen.getByLabelText("Mail within this server"), "optional");
        await user.selectOptions(screen.getByLabelText("Mail to everyone else"), "automatic");
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(saved).toHaveLength(1);
    });

    it("closes the question about turning encryption off on Escape and saves nothing", async () => {
        const saved: any[] = [];
        mockPolicy((body) => {
            saved.push(body);
            return jsonResponse(200, body);
        });
        const user = userEvent.setup();
        render(<EncryptionPolicyPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        await user.selectOptions(await screen.findByLabelText("Mail within this server"), "prohibited");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await screen.findByRole("dialog", { name: "Turn off encryption?" });
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(saved).toEqual([]);
    });

    it("does not ask again about a kind of mail that is already set to Never encrypt", async () => {
        const saved: any[] = [];
        mockPolicy(
            (body) => {
                saved.push(body);
                return jsonResponse(200, body);
            },
            jsonResponse(200, { ...optional, encryptExternal: "prohibited" }),
        );
        const user = userEvent.setup();
        render(<EncryptionPolicyPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        await user.selectOptions(await screen.findByLabelText("Mail within this server"), "automatic");
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(saved).toHaveLength(1);
    });

    it("shows a load error", async () => {
        mockPolicy(undefined, jsonResponse(500, { message: "Policy unavailable" }));
        render(<EncryptionPolicyPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("Policy unavailable")).toBeInTheDocument();
    });

    it("shows a save error", async () => {
        mockPolicy(() => jsonResponse(400, { message: "Bad tier" }));
        const user = userEvent.setup();
        render(<EncryptionPolicyPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await user.click(await screen.findByRole("button", { name: "Save" }));
        expect(await screen.findByText("Bad tier")).toBeInTheDocument();
    });

    it("shows generic load and save errors when the request fails with a non-API error", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/system/setup") return jsonResponse(200, { required: false });
            throw new TypeError("network down");
        });
        const { unmount } = render(<EncryptionPolicyPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("Could not load the encryption policy.")).toBeInTheDocument();
        unmount();

        mockPolicy(() => {
            throw new TypeError("network down");
        });
        const user = userEvent.setup();
        render(<EncryptionPolicyPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await user.click(await screen.findByRole("button", { name: "Save" }));
        expect(await screen.findByText("Could not save the encryption policy.")).toBeInTheDocument();
    });

    it("treats encryption as enabled when any tier allows it", () => {
        expect(isEncryptionEnabled({ encryptSameOrg: "prohibited", encryptFederated: "prohibited", encryptExternal: "prohibited" })).toBe(false);
        expect(isEncryptionEnabled({ encryptSameOrg: "prohibited", encryptFederated: "optional", encryptExternal: "prohibited" })).toBe(true);
    });
});
