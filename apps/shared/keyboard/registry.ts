///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { RefObject } from "react";
import type { ShortcutDef, ShortcutScope } from "./keymap.js";
import { ParsedSpec } from "./parse.js";

/**
 * What a handler does with its key. Returning `false` says it did not handle it (nothing selected, a button that is disabled right now)
 * - the key is then left alone, and a handler of a lower scope may take it. Anything else means it did, and the key is consumed.
 */
export type ShortcutHandler = (event: KeyboardEvent) => boolean | void;

/** One mounted view's claim on a shortcut. */
export interface Registration {
    /** Unique per registration. */
    id: number;
    shortcut: ShortcutDef;
    scope: ShortcutScope;
    /** Called at event time; reads whatever the component holds now. */
    run: ShortcutHandler;
    /** Applies only to events whose target is inside this element (a compose window). */
    container?: RefObject<Element | null>;
    keys: ParsedSpec[];
    electronKeys: ParsedSpec[];
    /** Later registrations win over earlier ones in the same scope. */
    order: number;
}

/**
 * The shortcuts that are mounted right now. Components add and remove their claims as they mount and unmount, so a page switch changes
 * what a key does with nothing to re-wire; the dispatcher (`dispatchKeyEvent()`) looks handlers up here at the time of the key press,
 * and the help dialog lists what is here.
 */
export class ShortcutRegistry {
    private registrations: readonly Registration[] = [];
    private counter = 0;
    private listeners = new Set<() => void>();

    /** Adds a claim; returns what removes it. */
    add(claim: Omit<Registration, "id" | "order">): () => void {
        const registration: Registration = { ...claim, id: ++this.counter, order: this.counter };
        this.registrations = [...this.registrations, registration];
        this.publish();
        return () => {
            this.registrations = this.registrations.filter((existing) => existing.id !== registration.id);
            this.publish();
        };
    }

    /** The current claims, oldest first. A new array whenever they change (so it can be a `useSyncExternalStore()` snapshot). */
    getSnapshot = (): readonly Registration[] => this.registrations;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    private publish(): void {
        this.listeners.forEach((listener) => listener());
    }
}
