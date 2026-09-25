///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Which of the Mail sidebar's sections - "All mailboxes" and one per mailbox - are open, and the reader's own choices about it.
 *
 * A section the reader has never touched follows the **default rule**: "All mailboxes" and the signed-in user's primary mailbox
 * (`primaryMailboxUid()`) are open, every other mailbox is collapsed - so a mailbox that is newly shared with them arrives closed.
 * Once they toggle a section the choice is remembered for that section, replacing the default, whatever the default later says.
 *
 * The section holding the folder that is open (`activeId`) is **never collapsed**: it shows open, and its toggle does nothing, so a
 * highlighted folder is never inside a hidden section. That is derived - it is not written as the reader's choice - so once they
 * move on to another folder the section goes back to what they chose (or the default). The price is that the section of the folder
 * being read cannot be collapsed (its toggle is `aria-disabled`); the reader collapses it after opening a folder elsewhere.
 *
 * The choices are kept per signed-in user, per device, in `localStorage` (`rapidmx:mail-sidebar-collapsed:<userUid>`), the way
 * `listPreferences.ts` keeps the list arrangement: `{ "<section id>": <collapsed> }`. Every read tolerates a missing, corrupt or
 * blocked store (and keeps only the booleans of a partly-valid one), every write swallows its failure - a blocked store only means the
 * choices do not survive a reload.
 */
import { useCallback, useMemo, useRef, useState } from "react";

const STORAGE_KEY_PREFIX = "rapidmx:mail-sidebar-collapsed:";

/** The id of the "All mailboxes" section; every mailbox's section is its uid. */
export const ALL_MAILBOXES_SECTION = "all";

/** What the reader chose per section: `true` collapsed, `false` open. A section that is not there follows the default rule. */
export type SectionChoices = Record<string, boolean>;

/** The `localStorage` key one user's choices are kept under. */
export function collapsedSectionsKey(userUid: string): string {
    return `${STORAGE_KEY_PREFIX}${userUid}`;
}

/** Reads a user's stored choices - none for an unknown user, a missing entry, unparsable JSON, something that is not an object, or a store that throws. */
export function readSectionChoices(userUid: string | undefined): SectionChoices {
    if (!userUid) {
        return {};
    }
    let stored: unknown;
    try {
        const raw = localStorage.getItem(collapsedSectionsKey(userUid));
        stored = raw === null ? null : JSON.parse(raw);
    } catch {
        return {};
    }
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
        return {};
    }
    // Only what is a real choice: a value that is not a boolean falls back to the default for its own section, not for all of them.
    return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
}

/** Stores a user's choices. Best-effort - see this module's own doc comment. */
export function writeSectionChoices(userUid: string | undefined, choices: SectionChoices): void {
    if (!userUid) {
        return;
    }
    try {
        localStorage.setItem(collapsedSectionsKey(userUid), JSON.stringify(choices));
    } catch {
        // Best-effort - see this module's own doc comment.
    }
}

/** Whether a section is open by the reader's choice, or by the default rule where they have made none (`activeId` not considered). */
export function sectionChosenOpen(id: string, choices: SectionChoices, primaryUid: string | undefined): boolean {
    const collapsed = choices[id];
    return collapsed === undefined ? id === ALL_MAILBOXES_SECTION || id === primaryUid : !collapsed;
}

export interface SidebarSectionsOptions {
    /** The signed-in user, whose choices these are; `undefined` keeps them for this page view only. */
    userUid: string | undefined;
    /** The user's primary mailbox, which - with "All mailboxes" - is open until they choose otherwise. */
    primaryUid: string | undefined;
    /** The section holding the folder that is open: `ALL_MAILBOXES_SECTION` for an aggregate view, else that mailbox's uid. Never collapsed. */
    activeId: string | undefined;
}

export interface SidebarSections {
    /** Whether the section shows its folders. */
    isExpanded: (id: string) => boolean;
    /** Whether the section holds the open folder, so it is open whatever was chosen and cannot be collapsed. */
    isLocked: (id: string) => boolean;
    /** Opens a collapsed section, collapses an open one, and remembers it; does nothing for the locked section. */
    toggle: (id: string) => void;
}

/** See this module's doc comment. */
export function useSidebarSections({ userUid, primaryUid, activeId }: SidebarSectionsOptions): SidebarSections {
    const [loaded, setLoaded] = useState(() => ({ userUid, choices: readSectionChoices(userUid) }));
    let current = loaded;
    if (loaded.userUid !== userUid) {
        // Another user signed in on this page: theirs are not the last one's choices.
        current = { userUid, choices: readSectionChoices(userUid) };
        setLoaded(current);
    }
    // Kept in step with what was last rendered, and moved on by a toggle at once, so two toggles before a re-render both count.
    const choicesRef = useRef(current.choices);
    choicesRef.current = current.choices;

    const toggle = useCallback(
        (id: string) => {
            if (id === activeId) {
                return;
            }
            const next = { ...choicesRef.current, [id]: sectionChosenOpen(id, choicesRef.current, primaryUid) };
            choicesRef.current = next;
            setLoaded({ userUid, choices: next });
            writeSectionChoices(userUid, next);
        },
        [activeId, primaryUid, userUid],
    );

    const choices = current.choices;
    return useMemo(
        () => ({
            isExpanded: (id: string) => id === activeId || sectionChosenOpen(id, choices, primaryUid),
            isLocked: (id: string) => id === activeId,
            toggle,
        }),
        [activeId, choices, primaryUid, toggle],
    );
}
