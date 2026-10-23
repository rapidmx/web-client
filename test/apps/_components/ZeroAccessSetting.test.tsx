// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import ZeroAccessSetting from "../../../apps/shared/components/settings/ZeroAccessSetting.js";
import type { Mailbox } from "../../../lib/mail/mailApi.js";

const { notifyApiError } = vi.hoisted(() => ({ notifyApiError: vi.fn() }));
vi.mock("../../../apps/shared/notifications/apiErrors.js", () => ({ notifyApiError }));

const MAILBOX = { uid: "mb1", version: 4, ownerUserUid: "u1", primarySmtpAddress: "alice@example.com", displayName: "Alice" } as Mailbox;
const POLICY = { encryptSameOrg: "optional", encryptFederated: "optional", encryptExternal: "optional" };

interface Server {
    policy?: object | Response;
    members?: object[] | Response;
    put?: (body: any) => Response;
    get?: Response;
}

function mockServer({ policy = { ...POLICY, allowZeroAccess: true }, members = [], put, get }: Server) {
    const respond = (value: object | Response) => (value instanceof Response ? value : jsonResponse(200, value));
    return mockFetch((url, init) => {
        if (url === "/api/system/encryption-policy") return respond(policy);
        if (url === "/api/mail/mailboxes/mb1/access") return respond(members);
        if (url === "/api/mail/mailboxes/mb1" && init?.method === "PUT") return put!(JSON.parse(init.body as string));
        if (url.startsWith("/api/mail/mailboxes/mb1")) return get!;
        throw new Error(`unexpected ${url}`);
    });
}

const checkbox = () => screen.getByRole("checkbox", { name: /Enable zero-access encryption/ });

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe("ZeroAccessSetting", () => {
    it("is on by default for an owner on a server that allows it, and saves turning it off and on", async () => {
        const saved: any[] = [];
        mockServer({
            put: (body) => {
                saved.push(body);
                return jsonResponse(200, { ...MAILBOX, ...body, version: body.version + 1 });
            },
        });
        const user = userEvent.setup();
        render(<ZeroAccessSetting mailbox={MAILBOX} canManage />);

        await waitFor(() => expect(checkbox()).toBeEnabled());
        expect(checkbox()).toBeChecked();
        await user.click(checkbox());
        await waitFor(() => expect(checkbox()).toBeEnabled());
        expect(checkbox()).not.toBeChecked();

        expect(saved).toEqual([{ uid: "mb1", version: 4, zeroAccessEnabled: false }]);
        expect(screen.queryByRole("note")).not.toBeInTheDocument();
    });

    it("shows the mailbox's own choice to turn it off", async () => {
        mockServer({});
        render(<ZeroAccessSetting mailbox={{ ...MAILBOX, zeroAccessEnabled: false }} canManage />);

        await waitFor(() => expect(checkbox()).toBeEnabled());
        expect(checkbox()).not.toBeChecked();
    });

    it("is disabled, unchecked and explained when the administrator turned it off for the server", async () => {
        mockServer({ policy: { ...POLICY, allowZeroAccess: false } });
        render(<ZeroAccessSetting mailbox={MAILBOX} canManage />);

        expect(await screen.findByText(/Your administrator has turned off zero-access encryption/)).toBeInTheDocument();
        expect(checkbox()).toBeDisabled();
        expect(checkbox()).not.toBeChecked();
    });

    it("is disabled and explained on a server without zero-access encryption, or when the policy can't be read", async () => {
        mockServer({ policy: POLICY });
        const { unmount } = render(<ZeroAccessSetting mailbox={MAILBOX} canManage />);
        expect(await screen.findByText(/doesn.t offer zero-access encryption/)).toBeInTheDocument();
        expect(checkbox()).toBeDisabled();
        unmount();

        mockServer({ policy: jsonResponse(500, {}) });
        render(<ZeroAccessSetting mailbox={MAILBOX} canManage />);
        expect(await screen.findByText(/doesn.t offer zero-access encryption/)).toBeInTheDocument();
    });

    it("is disabled and explained for an ownerless mailbox or one with delegates", async () => {
        mockServer({});
        const { unmount } = render(<ZeroAccessSetting mailbox={{ ...MAILBOX, ownerUserUid: undefined }} canManage={false} />);
        expect(await screen.findByText(/isn.t available yet for a mailbox shared with other people/)).toBeInTheDocument();
        expect(checkbox()).toBeDisabled();
        unmount();

        mockServer({ members: [{ userOrRoleId: "u1", role: "manager" }, { userOrRoleId: "u2", role: "viewer" }] });
        render(<ZeroAccessSetting mailbox={MAILBOX} canManage />);
        expect(await screen.findByText(/isn.t available yet for a mailbox shared with other people/)).toBeInTheDocument();
    });

    it("treats a member list it can't read, or one listing only the owner, as unshared", async () => {
        mockServer({ members: jsonResponse(500, {}) });
        const { unmount } = render(<ZeroAccessSetting mailbox={MAILBOX} canManage />);
        await waitFor(() => expect(checkbox()).toBeEnabled());
        unmount();

        mockServer({ members: [{ userOrRoleId: "u1", role: "manager" }] });
        render(<ZeroAccessSetting mailbox={MAILBOX} canManage />);
        await waitFor(() => expect(checkbox()).toBeEnabled());
    });

    it("is read-only, with a reason, for someone other than the owner, without listing the mailbox's members", async () => {
        const fetch = mockServer({});
        render(<ZeroAccessSetting mailbox={MAILBOX} canManage={false} />);

        expect(await screen.findByText(/Only this mailbox.s owner, signed in as themselves, can change this/)).toBeInTheDocument();
        expect(checkbox()).toBeDisabled();
        expect(checkbox()).toBeChecked();
        expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/access"))).toBe(false);
    });

    it("retries once with the current version when its copy of the mailbox was out of date", async () => {
        const saved: any[] = [];
        mockServer({
            put: (body) => {
                saved.push(body);
                return body.version === 4 ? jsonResponse(409, { message: "version conflict" }) : jsonResponse(200, { ...MAILBOX, ...body });
            },
            get: jsonResponse(200, { ...MAILBOX, version: 6 }),
        });
        const user = userEvent.setup();
        render(<ZeroAccessSetting mailbox={MAILBOX} canManage />);

        await waitFor(() => expect(checkbox()).toBeEnabled());
        await user.click(checkbox());
        await waitFor(() => expect(saved).toHaveLength(2));

        expect(saved[1]).toEqual({ uid: "mb1", version: 6, zeroAccessEnabled: false });
        expect(notifyApiError).not.toHaveBeenCalled();
        await waitFor(() => expect(checkbox()).not.toBeChecked());
    });

    it("puts the checkbox back and reports the error when saving fails", async () => {
        mockServer({ put: () => jsonResponse(500, { message: "boom" }) });
        const user = userEvent.setup();
        render(<ZeroAccessSetting mailbox={MAILBOX} canManage />);

        await waitFor(() => expect(checkbox()).toBeEnabled());
        await user.click(checkbox());

        await waitFor(() => expect(notifyApiError).toHaveBeenCalledWith(expect.anything(), "Couldn't save the zero-access encryption setting"));
        expect(checkbox()).toBeChecked();
    });

    it("does not update after unmounting before the policy has loaded", async () => {
        let release: (() => void) | undefined;
        const fetch = mockFetch(
            () =>
                new Promise<Response>((resolve) => {
                    release = () => resolve(jsonResponse(200, { ...POLICY, allowZeroAccess: false }));
                }),
        );
        const { unmount } = render(<ZeroAccessSetting mailbox={MAILBOX} canManage />);
        await waitFor(() => expect(fetch).toHaveBeenCalled());
        unmount();
        release!();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
});
