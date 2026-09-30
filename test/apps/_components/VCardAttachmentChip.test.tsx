// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mailbox, Message } from "../../../lib/mail/mailApi.js";
import ContactCardProvider from "../../../apps/shared/components/contacts/ContactCardProvider.js";
import VCardAttachmentChip from "../../../apps/shared/components/mail/VCardAttachmentChip.js";
import { MailConnectionContext, type MailConnection } from "../../../apps/shared/mail/useMailConnection.js";
import { getNotificationsSnapshot } from "../../../apps/shared/notifications/store.js";
import { jsonResponse, mockFetch } from "../testUtils.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

const ME = { uid: "mb1", ownerUserUid: "u1", primarySmtpAddress: "me@example.com", aliasAddresses: [], displayName: "Me", dateCreated: "2026-01-01T00:00:00.000Z", accessRole: "owner" } as Mailbox;
const MESSAGE = { uid: "m1", mailboxUid: "mb1", folderUid: "inbox" } as Message;

const card = (name: string, email: string) => `BEGIN:VCARD\nFN:${name}\nEMAIL:${email}\nEND:VCARD`;

/** Serves the address book: `existing` are the emails already stored, `failOn` names a contact whose creation fails. */
function serve({ existing = [] as string[], failOn = "" } = {}) {
    const posted: string[] = [];
    mockFetch((url, init) => {
        const path = url.split("?")[0];
        if (init?.method === "POST") {
            const body = JSON.parse(init.body as string);
            if (body.displayName === failOn) {
                return jsonResponse(500, { message: "Disk full" });
            }
            posted.push(body.displayName);
            return jsonResponse(200, { uid: `new-${posted.length}`, ...body });
        }
        if (path === "/api/mail/mailboxes") {
            return jsonResponse(200, [ME]);
        }
        if (path === "/api/mail/folders") {
            return jsonResponse(200, [{ uid: "c1", mailboxUid: "mb1", type: "contacts", name: "Contacts" }]);
        }
        if (path === "/api/mail/contacts") {
            return jsonResponse(
                200,
                existing.map((address, index) => ({ uid: `k${index}`, displayName: address, emails: [{ address, type: "work" }], phones: [], addresses: [] })),
            );
        }
        return jsonResponse(404, { message: `unexpected ${url}` });
    });
    return posted;
}

function renderChip(text: string | (() => Promise<string>), onDownload = vi.fn(), connection: MailConnection | null = { status: "ready", mailboxes: [ME] } as MailConnection) {
    const loadText = typeof text === "string" ? () => Promise.resolve(text) : text;
    render(
        <MailConnectionContext.Provider value={connection}>
            <ContactCardProvider userUid="u1">
                <VCardAttachmentChip label="team.vcf (1 KB)" message={MESSAGE} loadText={loadText} onDownload={onDownload} />
            </ContactCardProvider>
        </MailConnectionContext.Provider>,
    );
    return onDownload;
}

async function choose(user: ReturnType<typeof userEvent.setup>, item: string) {
    await user.click(screen.getByRole("button", { name: "team.vcf (1 KB), contact card actions" }));
    await user.click(await screen.findByRole("menuitem", { name: item }));
}

describe("VCardAttachmentChip", () => {
    it("is a plain download outside a contact card provider", async () => {
        const onDownload = vi.fn();
        render(<VCardAttachmentChip label="team.vcf (1 KB)" message={MESSAGE} loadText={() => Promise.resolve("")} onDownload={onDownload} />);
        await userEvent.setup().click(screen.getByRole("button", { name: "team.vcf (1 KB)" }));
        expect(onDownload).toHaveBeenCalledTimes(1);
    });

    it("opens a menu with both actions instead of downloading", async () => {
        const onDownload = renderChip("");
        const user = userEvent.setup();
        const trigger = screen.getByRole("button", { name: "team.vcf (1 KB), contact card actions" });
        expect(trigger).toHaveAttribute("aria-haspopup", "menu");
        await user.click(trigger);
        expect(await screen.findByRole("menuitem", { name: "Add to address book" })).toBeInTheDocument();
        expect(screen.getByRole("menuitem", { name: "Download" })).toBeInTheDocument();
        expect(onDownload).not.toHaveBeenCalled();
    });

    it("downloads from the menu", async () => {
        const onDownload = renderChip("");
        await choose(userEvent.setup(), "Download");
        expect(onDownload).toHaveBeenCalledTimes(1);
    });

    it("adds one contact", async () => {
        const posted = serve();
        renderChip(card("Ann Lee", "ann@x.com"));
        await choose(userEvent.setup(), "Add to address book");
        await waitFor(() => expect(getNotificationsSnapshot().visible).toMatchObject([{ kind: "success", title: "Address book updated", message: "1 contact added to your address book." }]));
        expect(posted).toEqual(["Ann Lee"]);
    });

    it("adds every card of the file and says how many were already there", async () => {
        const posted = serve({ existing: ["ann@x.com", "bob@x.com"] });
        renderChip([card("Ann", "ann@x.com"), card("Bob", "bob@x.com"), card("Cy", "cy@x.com"), card("Di", "di@x.com")].join("\n"));
        await choose(userEvent.setup(), "Add to address book");
        await waitFor(() =>
            expect(getNotificationsSnapshot().visible).toMatchObject([{ kind: "success", message: "2 contacts added to your address book. 2 contacts were already in your address book." }]),
        );
        expect(posted).toEqual(["Cy", "Di"]);
    });

    it("says so when every card is already there", async () => {
        const posted = serve({ existing: ["ann@x.com"] });
        renderChip(card("Ann", "ann@x.com"));
        await choose(userEvent.setup(), "Add to address book");
        await waitFor(() => expect(getNotificationsSnapshot().visible).toMatchObject([{ kind: "success", message: "1 contact was already in your address book." }]));
        expect(posted).toEqual([]);
    });

    it("says so when the file has no contacts in it", async () => {
        serve();
        renderChip("nothing to see");
        await choose(userEvent.setup(), "Add to address book");
        await waitFor(() => expect(getNotificationsSnapshot().visible).toMatchObject([{ kind: "warning", title: "No contacts found", message: "This file has no contacts in it." }]));
    });

    it("reports a failure, and how many contacts were added before it", async () => {
        const posted = serve({ failOn: "Bob" });
        renderChip([card("Ann", "ann@x.com"), card("Bob", "bob@x.com")].join("\n"));
        await choose(userEvent.setup(), "Add to address book");
        await waitFor(() => expect(getNotificationsSnapshot().visible).toMatchObject([{ kind: "error", title: "Couldn't add to your address book. 1 contact could be added before it failed." }]));
        expect(posted).toEqual(["Ann"]);
    });

    it("reports a failure of the file itself", async () => {
        serve();
        renderChip(() => Promise.reject(new Error("unreadable")));
        await choose(userEvent.setup(), "Add to address book");
        await waitFor(() => expect(getNotificationsSnapshot().visible).toMatchObject([{ kind: "error", title: "Couldn't add to your address book." }]));
    });

    it("asks for the mailboxes itself outside the app frame", async () => {
        const posted = serve();
        renderChip(card("Ann Lee", "ann@x.com"), vi.fn(), null);
        await choose(userEvent.setup(), "Add to address book");
        await waitFor(() => expect(posted).toEqual(["Ann Lee"]));
    });
});
