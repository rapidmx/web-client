///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RefObject, useEffect, useMemo, useRef } from "react";
import type { ShortcutDef, ShortcutScope } from "./keymap.js";
import { parseSpec } from "./parse.js";
import type { ShortcutHandler } from "./registry.js";
import { useShortcutRegistry } from "./ShortcutProvider.js";

export interface UseShortcutOptions {
    /** Overrides the scope the shortcut is defined with - required for a bare spec string, which has none. Default `global`. */
    scope?: ShortcutScope;
    /** Registers only while true: a view offers a shortcut only when it can really do the thing. Default true. */
    enabled?: boolean;
    /** Restricts it to events whose target is inside this element (a compose window). */
    container?: RefObject<Element | null>;
}

/**
 * Claims a shortcut for as long as the calling component is mounted (and `enabled`). `shortcut` is an entry of `SHORTCUTS` - which is what
 * the help dialog and tooltips describe - or a bare spec such as `"alt+n"` for a one-off. The handler is read at the time of the key press,
 * so it always sees the component's current state without the registration being redone; return `false` from it to decline the key.
 *
 * Does nothing outside a `ShortcutProvider`.
 */
export function useShortcut(shortcut: ShortcutDef | string, handler: ShortcutHandler, options: UseShortcutOptions = {}): void {
    const { scope, enabled = true, container } = options;
    const registry = useShortcutRegistry();
    const handlerRef = useRef(handler);
    handlerRef.current = handler;
    const def = useMemo<ShortcutDef>(
        () => (typeof shortcut === "string" ? { id: `custom:${shortcut}`, keys: [shortcut], label: shortcut, scope: "global" } : shortcut),
        [shortcut],
    );
    const resolvedScope = scope ?? def.scope;
    useEffect(() => {
        if (!registry || !enabled) {
            return;
        }
        return registry.add({
            shortcut: def,
            scope: resolvedScope,
            run: (event) => handlerRef.current(event),
            container,
            keys: def.keys.map(parseSpec),
            electronKeys: (def.electronKeys ?? []).map(parseSpec),
        });
    }, [registry, enabled, def, resolvedScope, container]);
}
