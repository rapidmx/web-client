// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// Forced onto the plain `node` environment (see the audit log page's own SSR test) so `window` and `document` are
// genuinely absent, the way they are while the server renders the page. (Node itself ships a WebSocket now, so the push
// client's own guard is the absence of an origin to connect to.)
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getPushClient, pushUrl } from "@rapidmx/react-shared/mail/pushClient.js";
import { NO_LIVE_UPDATES, useMailLiveUpdates } from "../../../apps/shared/mail/useMailLiveUpdates.js";
import MailAddress, { RecipientLine } from "../../../apps/shared/components/mail/MailAddress.js";
import SendFailureAlert from "../../../apps/shared/components/mail/compose/SendFailureAlert.js";
import MailShell from "../../../apps/shared/components/mail/layout/MailShell.js";
import NewMailToasts from "../../../apps/shared/components/mail/NewMailToasts.js";
import UserMenu from "../../../apps/shared/components/layout/UserMenu.js";
import { useNewMailNotifications } from "../../../apps/shared/mail/useNewMailNotifications.js";
import { useUnreadTitle } from "../../../apps/shared/mail/useUnreadTitle.js";
import { desktopPermission, getNewMailPopupsEnabled } from "../../../apps/shared/mail/newMailNotifications.js";

function Probe() {
    const { live, folderCounts } = useMailLiveUpdates({ userUid: "u1", mailboxes: [], mailboxFolders: [], onFolderCreated: () => undefined });
    return <span>{`${live.tick}:${Object.keys(folderCounts.counts).length}`}</span>;
}

describe("live updates SSR guard (no window)", () => {
    it("renders the hook without touching window or document (effects never run while rendering on the server)", () => {
        expect(typeof window).toBe("undefined");
        expect(typeof document).toBe("undefined");
        expect(renderToStaticMarkup(<Probe />)).toBe("<span>0:0</span>");
        expect(NO_LIVE_UPDATES.tick).toBe(0);
    });

    it("renders the whole shell server-side without opening anything", () => {
        expect(() => renderToStaticMarkup(<MailShell userUid="u1">content</MailShell>)).not.toThrow();
    });

    it("the shared push client is created and started without a window, and simply has nothing to connect to", () => {
        expect(pushUrl()).toBeUndefined();
        const client = getPushClient();
        expect(() => client.start()).not.toThrow();
        expect(client.status).toBe("idle");
    });

    it("renders the new-mail pop-ups, the notification switches and the admin lookup without a window, touching no browser API", () => {
        function Probe() {
            const notifications = useNewMailNotifications({ mailboxes: [], mailboxFolders: [] });
            useUnreadTitle(3);
            return <span>{notifications.offerDesktop ? "offer" : "no offer"}</span>;
        }
        expect(renderToStaticMarkup(<Probe />)).toBe("<span>no offer</span>");
        const html = renderToStaticMarkup(
            <NewMailToasts
                toasts={[{ uid: "m1", mailboxUid: "mb", folderUid: "f", senderName: "Jane", senderAddress: "jane@example.com", subject: "Hi", preview: "There", href: "/messages/m1" }]}
                onDismiss={() => undefined}
                offerDesktop
                onEnableDesktop={() => undefined}
                onDeclineDesktop={() => undefined}
            />,
        );
        expect(html).toContain("role=\"status\"");
        expect(html).toContain("Jane");
        expect(renderToStaticMarkup(<UserMenu userUid="u1" authServerUrl="https://auth.example.com" onSignOut={() => undefined} detectAdmin showNotificationSettings />)).toContain(
            "Account menu",
        );
        // The storage-backed settings read as their defaults where there is no storage or Notifications API.
        expect(getNewMailPopupsEnabled()).toBe(true);
        expect(desktopPermission()).toBe("unsupported");
    });

    it("renders the sender/recipient and send-failure components too", () => {
        expect(renderToStaticMarkup(<MailAddress recipient={{ displayName: "Jane", address: "jane@example.com" }} />)).toContain("jane");
        expect(
            renderToStaticMarkup(<RecipientLine label="To" recipients={[{ address: "a@example.com" }, { address: "b@example.com" }, { address: "c@example.com" }, { address: "d@example.com" }]} />),
        ).toContain("and 1 more");
        expect(renderToStaticMarkup(<SendFailureAlert message="Not delivered" lines={["recipients 1: address=a@example.com"]} />)).toContain("Technical details");
    });
});
