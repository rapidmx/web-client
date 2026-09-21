///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ariaKeyShortcuts, withHint } from "./format.js";
import type { ShortcutDef } from "./keymap.js";
import { useKeyEnvironment } from "./ShortcutProvider.js";

/**
 * What a control that a keyboard shortcut also triggers gets: a tooltip naming the key - `Reply (Ctrl+R)`, in this platform's own key names -
 * and `aria-keyshortcuts` for assistive technology. The accessible name is left alone (the control keeps its own label), so a tooltip suffix never
 * changes what a screen reader or a test finds it by. With `active` false - the shortcut isn't registered right now - it is just the plain label.
 */
export function useShortcutProps(label: string, shortcut: ShortcutDef, active = true): { title: string; "aria-keyshortcuts"?: string } {
    const env = useKeyEnvironment();
    return active ? { title: withHint(label, shortcut, env), "aria-keyshortcuts": ariaKeyShortcuts(shortcut, env) } : { title: label };
}
