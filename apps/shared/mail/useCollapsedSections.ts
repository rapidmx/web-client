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
 * **Every** section can be collapsed, the one holding the open folder and the primary mailbox included, and a collapsed one stays collapsed
 * across reloads even while its own folder is the selected one: the toggle always toggles and always remembers.
 *
 * The one exception is *navigation*: when the section holding the open folder (`activeId`) **changes** - the reader picks a folder in
 * another section, or a search result or a link lands in one - that section is shown open, so the folder just highlighted is not hidden
 * from them. That is an in-memory override of this page view, never written as the reader's choice: it does not apply to the first
 * section the page resolves (a reload lands on whatever was chosen), and it ends when they navigate to yet another section. Toggling
 * the section it opened forgets the override and remembers the reader's new choice (the opposite of what was showing).
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

/** Whether a section is open by the reader's choice, or by the default rule where they have made none (a navigation's override not considered). */
export function sectionChosenOpen(id: string, choices: SectionChoices, primaryUid: string | undefined): boolean {
    const collapsed = choices[id];
    return collapsed === undefined ? id === ALL_MAILBOXES_SECTION || id === primaryUid : !collapsed;
}

export interface SidebarSectionsOptions {
    /** The signed-in user, whose choices these are; `undefined` keeps them for this page view only. */
    userUid: string | undefined;
    /** The user's primary mailbox, which - with "All mailboxes" - is open until they choose otherwise. */
    primaryUid: string | undefined;
    /**
     * The section holding the folder that is open: `ALL_MAILBOXES_SECTION` for an aggregate view, else that mailbox's uid; `undefined`
     * while that is not known yet (the address not read, the mailboxes not loaded). Moving from one section to another opens the new one
     * (see this module's doc comment); the first section that becomes known does not.
     */
    activeId: string | undefined;
}

export interface SidebarSections {
    /** Whether the section shows its folders. */
    isExpanded: (id: string) => boolean;
    /** Opens a collapsed section, collapses an open one, and remembers it as the reader's choice. */
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
    // The section the last navigation opened, if any: derived while rendering from the change of `activeId` (no effect, so the section is
    // already open in the render that highlights its folder). A first `activeId` (from undefined) is not a navigation.
    const [nav, setNav] = useState<{ activeId: string | undefined; opened: string | undefined }>({ activeId, opened: undefined });
    let currentNav = nav;
    if (nav.activeId !== activeId) {
        currentNav = { activeId, opened: nav.activeId === undefined ? undefined : activeId };
        setNav(currentNav);
    }
    // Kept in step with what was last rendered, and moved on by a toggle at once, so two toggles before a re-render both count.
    const choicesRef = useRef(current.choices);
    choicesRef.current = current.choices;
    const openedRef = useRef(currentNav.opened);
    openedRef.current = currentNav.opened;

    const toggle = useCallback(
        (id: string) => {
            const expanded = openedRef.current === id || sectionChosenOpen(id, choicesRef.current, primaryUid);
            const next = { ...choicesRef.current, [id]: expanded };
            choicesRef.current = next;
            setLoaded({ userUid, choices: next });
            writeSectionChoices(userUid, next);
            if (openedRef.current === id) {
                // The reader's own choice replaces the override that had opened it.
                openedRef.current = undefined;
                setNav({ activeId, opened: undefined });
            }
        },
        [activeId, primaryUid, userUid],
    );

    const choices = current.choices;
    const opened = currentNav.opened;
    return useMemo(
        () => ({
            isExpanded: (id: string) => id === opened || sectionChosenOpen(id, choices, primaryUid),
            toggle,
        }),
        [opened, choices, primaryUid, toggle],
    );
}
