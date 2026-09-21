///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";
import { formatSpec, specsFor } from "./format.js";
import { HELP_SCOPES, SCOPE_LABELS, SHORTCUTS, ShortcutDef, shortcutRank } from "./keymap.js";
import { useKeyEnvironment, useRegisteredShortcuts } from "./ShortcutProvider.js";
import { useShortcut } from "./useShortcut.js";

export interface ShortcutsDialogProps {
    open: boolean;
    onClose: () => void;
}

function Keys({ shortcut }: { shortcut: ShortcutDef }) {
    const env = useKeyEnvironment();
    return (
        <span className="flex flex-wrap justify-end gap-x-1.5 gap-y-1 shrink-0">
            {specsFor(shortcut, env).map((spec, index) => (
                <React.Fragment key={spec}>
                    {index > 0 && <span className="text-xs text-text-muted self-center">or</span>}
                    <kbd className="px-1.5 py-0.5 rounded-sm border border-border bg-surface-alt text-xs font-sans font-semibold whitespace-nowrap">
                        {formatSpec(spec, env)}
                    </kbd>
                </React.Fragment>
            ))}
        </span>
    );
}

/**
 * The keyboard shortcuts help dialog: what can be done from the keyboard *here*. It lists what is registered right now (see
 * `useRegisteredShortcuts()`), so it shows the global shortcuts and those of the view that is on screen - and the compose window's while one
 * is open - in groups, with the platform's own key names (Ctrl or Cmd, Alt or Option), and in the desktop client also the keys only it has.
 * A shortcut a view cannot do at the moment (no message selected) is not registered, and so not listed.
 *
 * Built on `Modal`: focus moves into the dialog and stays there, Escape closes it, and it has an accessible name. `?` and Ctrl+/ close it too.
 */
export default function ShortcutsDialog({ open, onClose }: ShortcutsDialogProps) {
    // Mounted only while open: the body subscribes to the registry, which every view's shortcuts change as it mounts - not something the
    // whole app should re-render for while the dialog is closed.
    return open ? <ShortcutsDialogBody onClose={onClose} /> : null;
}

function ShortcutsDialogBody({ onClose }: { onClose: () => void }) {
    const registrations = useRegisteredShortcuts();
    useShortcut(SHORTCUTS.global.help, onClose, { scope: "dialog" });
    const groups = HELP_SCOPES.map((scope) => {
        const listed = new Map<string, ShortcutDef>();
        for (const registration of registrations) {
            if (registration.scope === scope) {
                listed.set(registration.shortcut.id, registration.shortcut);
            }
        }
        return { scope, shortcuts: [...listed.values()].sort((a, b) => shortcutRank(a) - shortcutRank(b)) };
    }).filter((group) => group.shortcuts.length > 0);

    return (
        <Modal open onClose={onClose} title="Keyboard shortcuts">
            <div className="flex flex-col gap-5">
                {groups.map(({ scope, shortcuts }) => (
                    <section key={scope} aria-labelledby={`shortcuts-${scope}`}>
                        <h3 id={`shortcuts-${scope}`} className="text-xs font-bold uppercase tracking-wide text-text-muted mb-2">
                            {SCOPE_LABELS[scope]}
                        </h3>
                        <ul className="flex flex-col gap-1.5">
                            {shortcuts.map((shortcut) => (
                                <li key={shortcut.id} className="flex items-start justify-between gap-4 text-sm">
                                    <span>{shortcut.label}</span>
                                    <Keys shortcut={shortcut} />
                                </li>
                            ))}
                        </ul>
                    </section>
                ))}
                <p className="text-xs text-text-muted border-t border-border pt-3">
                    Some browsers keep a few keys for themselves, so a shortcut may not work everywhere.
                </p>
            </div>
        </Modal>
    );
}
