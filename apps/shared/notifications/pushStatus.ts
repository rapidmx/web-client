///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect } from "react";
import { getPushClient, PushStatus } from "@rapidmx/react-shared/mail/pushClient.js";
import { dismiss, notify } from "./store.js";

/** How long the live connection has to be down before anyone is told: a reconnect within a few seconds is not worth a word. */
export const PUSH_OFFLINE_NOTICE_MS = 10_000;

export const PUSH_NOTICE_ID = "push-connection";

/**
 * A subtle info pop-up when the live connection (new mail, folder counts, send results) has been down for more than `PUSH_OFFLINE_NOTICE_MS`,
 * which goes by itself the moment it is back. Shown once per outage - dismissing it does not bring it back until the connection has
 * reconnected and dropped again. The page keeps working meanwhile (it polls), which is what the message says.
 */
export function usePushConnectionNotice(enabled: boolean): void {
    useEffect(() => {
        if (!enabled) {
            return;
        }
        const client = getPushClient();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let shown = false;
        const off = client.onStatus((status: PushStatus) => {
            if (status === "reconnecting") {
                if (timer === undefined && !shown) {
                    timer = setTimeout(() => {
                        shown = true;
                        notify({
                            id: PUSH_NOTICE_ID,
                            kind: "info",
                            title: "Live updates are paused",
                            message: "The connection is being restored. The page keeps refreshing on its own, so new mail may take a little longer to appear.",
                            sticky: true,
                            history: false,
                        });
                    }, PUSH_OFFLINE_NOTICE_MS);
                }
            } else {
                clearTimeout(timer);
                timer = undefined;
                if (status === "open" && shown) {
                    shown = false;
                    dismiss(PUSH_NOTICE_ID);
                }
            }
        });
        return () => {
            off();
            clearTimeout(timer);
        };
    }, [enabled]);
}
