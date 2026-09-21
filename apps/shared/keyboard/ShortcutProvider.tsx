///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { PropsWithChildren, createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { dispatchKeyEvent } from "./dispatch.js";
import { KeyEnvironment, SERVER_ENVIRONMENT, currentEnvironment } from "./platform.js";
import { Registration, ShortcutRegistry } from "./registry.js";

interface ShortcutContextValue {
    registry: ShortcutRegistry;
    env: KeyEnvironment;
}

const ShortcutContext = createContext<ShortcutContextValue | null>(null);

/**
 * The web client's one keyboard layer. Mounted once, by `AppChrome` (the frame that stays mounted as the router swaps pages), so shortcuts
 * work in every view - mail, calendar, contacts, tasks, settings - and a page change only changes which handlers are registered.
 *
 * One `keydown` listener on `document` (bubbling, so what a widget handles itself and `preventDefault()`s is left alone) hands each key to
 * `dispatchKeyEvent()`. Views claim keys with `useShortcut()`. Outside a provider - an admin page, a component rendered on its own - that
 * hook does nothing.
 *
 * The platform (macOS, the desktop client) is read after mount, never during render, so the server render and hydration agree.
 */
export function ShortcutProvider({ children }: PropsWithChildren) {
    const registry = useMemo(() => new ShortcutRegistry(), []);
    const [env, setEnv] = useState<KeyEnvironment>(SERVER_ENVIRONMENT);
    useEffect(() => {
        setEnv(currentEnvironment());
    }, []);
    useEffect(() => {
        function handleKeyDown(event: KeyboardEvent) {
            dispatchKeyEvent(registry, event, currentEnvironment(), document);
        }
        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [registry]);
    const value = useMemo(() => ({ registry, env }), [registry, env]);
    return <ShortcutContext.Provider value={value}>{children}</ShortcutContext.Provider>;
}

/** The registry, or `null` outside a `ShortcutProvider`. */
export function useShortcutRegistry(): ShortcutRegistry | null {
    return useContext(ShortcutContext)?.registry ?? null;
}

/** The platform as the keyboard layer sees it - `SERVER_ENVIRONMENT` until the client has mounted, and outside a provider. */
export function useKeyEnvironment(): KeyEnvironment {
    return useContext(ShortcutContext)?.env ?? SERVER_ENVIRONMENT;
}

const NO_REGISTRATIONS: readonly Registration[] = [];
const getNoRegistrations = () => NO_REGISTRATIONS;
const NEVER = () => () => undefined;

/** Everything registered right now, updating as views mount and unmount - what the help dialog lists. Empty outside a provider. */
export function useRegisteredShortcuts(): readonly Registration[] {
    const registry = useShortcutRegistry();
    return useSyncExternalStore(registry?.subscribe ?? NEVER, registry?.getSnapshot ?? getNoRegistrations, getNoRegistrations);
}
