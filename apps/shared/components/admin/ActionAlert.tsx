///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode, createContext, useContext } from "react";
import Alert from "../../../../lib/components/feedback/Alert.js";
import { isElevationMessage } from "./elevation.js";

/**
 * What `AdminShell` offers the page inside it: sends the browser to auth-server to confirm the user's identity again, then back to this page. `undefined`
 * outside the shell, and in one with no auth-server to send the browser to.
 */
export const ReconfirmIdentityContext = createContext<(() => void) | undefined>(undefined);

/**
 * `Alert` for the failure of an administrator action. When the failure is the server's refusal for want of a recently confirmed identity (see
 * `actionErrorMessage()`), it also offers to confirm it again right there rather than leaving the user to work out that reloading the page does it.
 */
export default function ActionAlert({ children }: { children: ReactNode }) {
    const reconfirm = useContext(ReconfirmIdentityContext);
    if (!reconfirm || typeof children !== "string" || !isElevationMessage(children)) {
        return <Alert>{children}</Alert>;
    }
    return (
        <Alert>
            <span className="flex-1">{children}</span>
            <button type="button" className="shrink-0 font-semibold underline" onClick={reconfirm}>
                Confirm identity again
            </button>
        </Alert>
    );
}
