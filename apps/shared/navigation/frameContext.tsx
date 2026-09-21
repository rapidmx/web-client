///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { PropsWithChildren, createContext, useContext, useLayoutEffect } from "react";

/**
 * What the persistent app frame (`AppRouter`'s one mounted `AppShell` chrome) offers to what is rendered inside it. `null`
 * outside a frame - a page not shown by the router (an admin page, a plugin page, a test) renders its own chrome.
 */
export interface AppFrameContextValue {
    /** Hides the frame's chrome (icon rail, header, footer) until the returned function is called - see `FrameTakeover`. */
    enterTakeover: () => () => void;
}

export const AppFrameContext = createContext<AppFrameContextValue | null>(null);

/** `true` inside the persistent app frame. */
export function useInAppFrame(): boolean {
    return useContext(AppFrameContext) !== null;
}

/**
 * Wraps a screen that takes over the whole window - first-time key setup, "your mailbox is being set up" - which used to
 * replace the page's shell entirely. Inside the persistent frame the shell can't be replaced (it stays mounted), so the frame
 * hides its chrome for as long as this is mounted instead; outside a frame it does nothing. A layout effect, so the chrome
 * is gone before the screen is first painted.
 */
export function FrameTakeover({ children }: PropsWithChildren) {
    const frame = useContext(AppFrameContext);
    useLayoutEffect(() => frame?.enterTakeover(), [frame]);
    return <>{children}</>;
}
