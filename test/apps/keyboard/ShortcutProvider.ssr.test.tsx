// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GlobalShortcuts } from "../../../apps/shared/keyboard/GlobalShortcuts.js";
import { SHORTCUTS } from "../../../apps/shared/keyboard/keymap.js";
import { ShortcutProvider, useKeyEnvironment } from "../../../apps/shared/keyboard/ShortcutProvider.js";
import ShortcutsDialog from "../../../apps/shared/keyboard/ShortcutsDialog.js";
import { useShortcutProps } from "../../../apps/shared/keyboard/useShortcutProps.js";
import { useShortcut } from "../../../apps/shared/keyboard/useShortcut.js";

// The server render has no window and no document: nothing in the keyboard layer may touch them while rendering.

function Button() {
    useShortcut(SHORTCUTS.mail.reply, () => undefined);
    const env = useKeyEnvironment();
    const hint = useShortcutProps("Reply", SHORTCUTS.mail.reply);
    return (
        <button {...hint} data-mac={String(env.mac)} data-electron={String(env.electron)}>
            Reply
        </button>
    );
}

describe("the keyboard layer on the server", () => {
    it("renders with no window or navigator, using the fixed server environment (Ctrl, not Cmd)", () => {
        expect(typeof window).toBe("undefined");
        const html = renderToString(
            <ShortcutProvider>
                <Button />
            </ShortcutProvider>,
        );
        expect(html).toContain('title="Reply (Ctrl+R)"');
        expect(html).toContain('aria-keyshortcuts="Control+R"');
        expect(html).toContain('data-mac="false"');
        expect(html).toContain('data-electron="false"');
    });

    it("renders the global shortcuts component, and the help dialog closed, to nothing", () => {
        const html = renderToString(
            <ShortcutProvider>
                <GlobalShortcuts authServerUrl="https://auth.example.com" onToggleHelp={() => undefined} />
                <ShortcutsDialog open={false} onClose={() => undefined} />
            </ShortcutProvider>,
        );
        expect(html).toBe("");
    });
});
