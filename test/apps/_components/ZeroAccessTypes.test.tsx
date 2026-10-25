// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import ZeroAccessTypes, { devicesSyncing, typeIncluded } from "../../../apps/shared/components/settings/ZeroAccessTypes.js";
import type { Mailbox } from "../../../lib/mail/mailApi.js";
import { ApiRequestError } from "../../../lib/util/api.js";

const { notifyApiError, updateMailbox, getMailbox, patchMailbox } = vi.hoisted(() => ({
    notifyApiError: vi.fn(),
    updateMailbox: vi.fn(),
    getMailbox: vi.fn(),
    patchMailbox: vi.fn(),
}));
vi.mock("../../../apps/shared/notifications/apiErrors.js", () => ({ notifyApiError }));
vi.mock("../../../apps/shared/components/settings/layout/SettingsShell.js", () => ({ useSettingsShell: () => ({ mailboxes: [], patchMailbox }) }));
vi.mock("../../../lib/mail/mailApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/mail/mailApi.js")>()),
    updateMailbox,
    getMailbox,
}));

const ALL = ["mail", "calendar", "contacts", "tasks"] as const;
const PHONE = { activesync: { devices: [{ id: "d1", model: "iPhone", types: ["mail", "calendar", "contacts"] as any, lastSeenAt: 1 }] } };
const mailbox = (fields: Partial<Mailbox> = {}) =>
    ({ uid: "mb1", version: 4, ownerUserUid: "u1", primarySmtpAddress: "alice@example.com", displayName: "Alice", ...fields }) as Mailbox;
const box = (name: string) => screen.getByRole("checkbox", { name: new RegExp(`^${name}`) });

afterEach(() => {
    vi.clearAllMocks();
});

describe("ZeroAccessTypes", () => {
    it("counts an undecided mail as on and the rest as off, and names the devices that sync a type", () => {
        expect(typeIncluded(undefined, "mail")).toBe(true);
        expect(typeIncluded({}, "tasks")).toBe(false);
        expect(typeIncluded({ mail: false, tasks: true }, "mail")).toBe(false);
        expect(devicesSyncing(mailbox({ syncClients: PHONE }), "calendar")).toEqual(["iPhone"]);
        expect(devicesSyncing(mailbox({ syncClients: PHONE }), "tasks")).toEqual([]);
        const unnamed = { activesync: { devices: [{ id: "a", types: ["tasks"] as any, lastSeenAt: 1 }, { id: "b", types: ["tasks"] as any, lastSeenAt: 1 }] }, mapi: { lastSeenAt: 1 } };
        expect(devicesSyncing(mailbox({ syncClients: unnamed }), "tasks")).toEqual(["A phone", "Outlook"]);
        expect(devicesSyncing(mailbox(), "mail")).toEqual([]);
    });

    it("shows a switch per type with what it encrypts, and plainly what a device syncing it will lose", () => {
        render(<ZeroAccessTypes mailbox={mailbox({ syncClients: PHONE, zeroAccessTypes: { mail: false, calendar: true, contacts: false, tasks: true } })} types={ALL} canManage />);

        expect(box("Mail")).not.toBeChecked();
        expect(box("Calendar")).toBeChecked();
        expect(screen.getByText(/Names, company, job title, phone numbers/)).toBeInTheDocument();
        // Included although the phone syncs it: what breaks, as an alert.
        expect(screen.getByRole("alert")).toHaveTextContent("Breaks: iPhone syncs this - it shows protected events only as busy blocks");
        // Left off because the phone syncs it: why, not an alert.
        expect(screen.getByText(/Left off because iPhone syncs this - protected, it shows protected contacts by their email address only/)).toBeInTheDocument();
        expect(screen.getByText(/can't open protected mail until you install your exported keys/)).toBeInTheDocument();
        // Nothing syncs tasks: no warning.
        expect(within(box("Tasks").closest("label")!).queryByText(/syncs this/)).not.toBeInTheDocument();
    });

    it("says nothing about mail on a phone once the keys are exported, and pluralises several devices", () => {
        const two = { activesync: { devices: [...PHONE.activesync.devices, { id: "d2", model: "Android", types: ["mail"] as any, lastSeenAt: 1 }] } };
        render(<ZeroAccessTypes mailbox={mailbox({ syncClients: two, zeroAccessKeysExportedAt: 5 })} types={["mail"]} canManage />);
        expect(screen.queryByText(/syncs? this/)).not.toBeInTheDocument();

        render(<ZeroAccessTypes mailbox={mailbox({ syncClients: two, zeroAccessTypes: { calendar: false } })} types={["mail"]} canManage />);
        expect(screen.getByRole("alert")).toHaveTextContent("Breaks: iPhone, Android sync this");
    });

    it("lists what is encrypted and what stays readable, and why", async () => {
        const user = userEvent.setup();
        render(<ZeroAccessTypes mailbox={mailbox({ zeroAccessTypes: { contacts: true } })} types={ALL} canManage />);
        await user.click(screen.getByText(/What.s encrypted, and what isn.t/));
        const rows = screen.getAllByRole("row");
        expect(rows).toHaveLength(5);
        expect(rows[3]).toHaveTextContent("Email addresses - the server needs them to deliver mail and to find each contact's encryption keys");
        expect(rows[2]).toHaveTextContent("Nothing - not protected");
    });

    it("saves one type at a time, retrying once against a newer version, and goes back when saving fails", async () => {
        const user = userEvent.setup();
        updateMailbox.mockRejectedValueOnce(new ApiRequestError("stale", 409)).mockResolvedValueOnce({ version: 8 });
        getMailbox.mockResolvedValue(mailbox({ version: 7 }));
        render(<ZeroAccessTypes mailbox={mailbox()} types={ALL} canManage />);

        await user.click(box("Tasks"));
        await waitFor(() => expect(updateMailbox).toHaveBeenCalledTimes(2));
        expect(updateMailbox.mock.calls.map(([input]) => input)).toEqual([
            { uid: "mb1", version: 4, zeroAccessTypes: { tasks: true } },
            { uid: "mb1", version: 7, zeroAccessTypes: { tasks: true } },
        ]);
        await waitFor(() => expect(box("Tasks")).not.toBeDisabled());
        expect(box("Tasks")).toBeChecked();
        // The shell keeps what was saved, for when this is mounted again.
        expect(patchMailbox).toHaveBeenCalledWith("mb1", { zeroAccessTypes: { tasks: true }, version: 8 });

        updateMailbox.mockRejectedValueOnce(new ApiRequestError("down", 503));
        await user.click(box("Mail"));
        await waitFor(() => expect(notifyApiError).toHaveBeenCalledWith(expect.any(ApiRequestError), "Couldn't save what zero-access encryption protects"));
        expect(box("Mail")).toBeChecked();
        expect(patchMailbox).toHaveBeenCalledTimes(1);
    });

    it("is read-only to anyone but the owner", () => {
        render(<ZeroAccessTypes mailbox={mailbox()} types={ALL} canManage={false} />);
        expect(box("Mail")).toBeDisabled();
    });
});
