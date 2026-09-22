///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect } from "react";
import { useUnlockPrompt } from "../../components/layout/UnlockPromptProvider.js";
import { registerUnlockOpener } from "./composeBridge.js";

/**
 * Lets code with no React context - a pop-up's "Unlock" action - open the app's one unlock prompt (`UnlockPromptProvider`). Renders nothing;
 * mounted once, inside the provider it reaches.
 */
export default function UnlockBridge(): null {
    const { requestUnlock } = useUnlockPrompt();
    useEffect(
        () =>
            registerUnlockOpener(async (mailboxUid, keys) => {
                await requestUnlock(mailboxUid, keys);
            }),
        [requestUnlock],
    );
    return null;
}
