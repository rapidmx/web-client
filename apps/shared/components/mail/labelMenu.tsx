///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { HiOutlineTag } from "react-icons/hi2";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { Label, createLabel } from "@rapidmx/react-shared/mail/labelsApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import FormField from "@rapidmx/react-shared/components/forms/FormField.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";
import MenuButton, { MenuSectionSpec } from "./MenuButton.js";

/**
 * The one multi-select label list this app uses everywhere labels are picked: the Filter menu's "Labels"
 * submenu, the bulk Apply label action in select mode, and the reading pane's own Labels button. All three
 * tick several labels with the menu staying open and commit them with one command, so the keyboard
 * handling, the checkmarks and the partially-applied state behave identically wherever they appear.
 */

/** What the reader has ticked so far, before committing. */
export interface LabelDraft {
    /** Labels currently ticked. */
    draft: string[];
    /** Labels still showing as partially applied - some of the messages being acted on carry them and some
     * don't, and the reader hasn't touched the row, so committing leaves each message as it is. */
    mixed: string[];
    toggle: (labelUid: string) => void;
    /** Unticks everything, including anything still partially applied. */
    clear: () => void;
    /** `true` once the draft differs from what it started as - what the commit row is enabled by. */
    dirty: boolean;
}

/** `a` and `b` hold the same uids, order ignored. */
function sameUids(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((uid) => b.includes(uid));
}

/**
 * Holds the ticked/partially-applied state of a label list while its menu is open, starting again from
 * `applied`/`partial` every time the menu is reopened - so dismissing a menu (Escape, a click outside)
 * discards the draft rather than silently keeping half a change.
 */
export function useLabelDraft(applied: string[], partial: string[], open: boolean): LabelDraft {
    const [state, setState] = useState<{ draft: string[]; mixed: string[] } | null>(null);
    const [wasOpen, setWasOpen] = useState(open);
    if (wasOpen !== open) {
        setWasOpen(open);
        setState(open ? { draft: applied, mixed: partial } : null);
    }
    const current = state ?? { draft: applied, mixed: partial };
    return {
        draft: current.draft,
        mixed: current.mixed,
        toggle: (labelUid) =>
            setState({
                // Touching a partially-applied row settles it: it becomes a plain tick (apply to all).
                draft: current.draft.includes(labelUid)
                    ? current.draft.filter((uid) => uid !== labelUid)
                    : [...current.draft, labelUid],
                mixed: current.mixed.filter((uid) => uid !== labelUid),
            }),
        clear: () => setState({ draft: [], mixed: [] }),
        dirty: !sameUids(current.draft, applied) || !sameUids(current.mixed, partial),
    };
}

export interface LabelSectionsOptions {
    labels: Label[];
    state: LabelDraft;
    /** The row that commits the draft. */
    commit: { label: string; onSelect: () => void; disabled?: boolean };
    /** The row that unticks everything. `keepOpen` false lets a caller (the filter) apply it straight away. */
    clear: { label: string; disabled?: boolean; keepOpen?: boolean; onSelect?: () => void };
    /** What to say instead of the list when this mailbox has no labels. */
    emptyNote: string;
    /** Adds a "New label" row. A `role="menu"` can't hold the text field that needs, so the row closes the
     * menu and opens `NewLabelDialog` - see `LabelMenuButton` and the Filter menu's own use of it. */
    onCreate?: () => void;
    /** Where labels are renamed, recoloured and deleted. */
    managePath?: string;
    /** A line under the list explaining what committing will do. */
    note?: string;
    /** Holds every row while a request is in flight. */
    busy?: boolean;
}

/**
 * The label rows plus their commit/clear rows, as `MenuButton` sections - so the same list can be a menu of
 * its own (`LabelMenuButton` below) or a submenu of another menu (the Filter menu's "Labels" row).
 */
export function labelSections({
    labels,
    state,
    commit,
    clear,
    emptyNote,
    note,
    busy,
    onCreate,
    managePath = "/settings/labels",
}: LabelSectionsOptions): MenuSectionSpec[] {
    const manageItem = {
        key: "manage",
        label: "Manage labels…",
        onSelect: () => {
            window.location.href = managePath;
        },
    };
    const tailItems = [...(onCreate ? [{ key: "create", label: "New label…", onSelect: onCreate }] : []), manageItem];
    if (labels.length === 0) {
        return [{ key: "labels", label: "Labels", note: emptyNote, items: tailItems }];
    }
    return [
        {
            key: "labels",
            label: "Labels",
            note,
            items: labels.map((label) => ({
                key: label.uid,
                label: label.name,
                role: "menuitemcheckbox" as const,
                checked: state.mixed.includes(label.uid) ? ("mixed" as const) : state.draft.includes(label.uid),
                swatchColor: label.color ?? "#6366f1",
                disabled: busy,
                // Several labels are ticked before anything is committed, so a tick never closes the menu.
                keepOpen: true,
                onSelect: () => state.toggle(label.uid),
            })),
        },
        {
            key: "commands",
            items: [
                {
                    key: "clear",
                    label: clear.label,
                    disabled: busy || clear.disabled || (state.draft.length === 0 && state.mixed.length === 0),
                    keepOpen: clear.keepOpen ?? true,
                    onSelect: () => (clear.onSelect ?? state.clear)(),
                },
                { key: "commit", label: commit.label, disabled: busy || commit.disabled, onSelect: commit.onSelect },
                ...tailItems,
            ],
        },
    ];
}

export interface NewLabelDialogProps {
    open: boolean;
    onClose: () => void;
    mailboxUid: string;
    /** Handed the label the server created, for the caller to add to its own list. */
    onCreated: (label: Label) => void;
}

/** The "New label" form the menus open - a dialog rather than more menu rows, because a `role="menu"`
 * has no place for a text field. Colour is left to Settings > Labels; this is the quick path from a
 * message, so it only asks for the name. */
export function NewLabelDialog({ open, onClose, mailboxUid, onCreated }: NewLabelDialogProps) {
    const [name, setName] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function save() {
        setSaving(true);
        setError(null);
        try {
            onCreated(await createLabel({ mailboxUid, name: name.trim() }));
            setName("");
            onClose();
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not create this label.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <Modal open={open} onClose={onClose} title="New label">
            {error && <Alert>{error}</Alert>}
            <FormField label="Name" htmlFor="new-label-name">
                <input
                    id="new-label-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full text-sm px-3 py-1.5 rounded-md border border-border bg-surface"
                />
            </FormField>
            <div className="flex justify-end gap-2 mt-2">
                <Button type="button" variant="secondary" className="!w-auto" onClick={onClose}>
                    Cancel
                </Button>
                <Button type="button" className="!w-auto" loading={saving} disabled={saving || !name.trim()} onClick={() => void save()}>
                    Create
                </Button>
            </div>
        </Modal>
    );
}

export interface LabelMenuButtonProps extends Omit<LabelSectionsOptions, "state" | "commit"> {
    /** The commit row - this component supplies its action (`onCommit` below) and disables it until the
     * draft actually differs from what it started as. */
    commit: { label: string; disabled?: boolean };
    /** The labels every target already carries. */
    applied: string[];
    /** The labels only some of them carry. */
    partial?: string[];
    /** Called with the labels to end up with, and the ones left partially applied (each target keeps those
     * exactly as they are). */
    onCommit: (labelUids: string[], keepPartial: string[]) => void;
    label: string;
    "aria-label": string;
    disabled?: boolean;
    title?: string;
    className?: string;
    /** With `onLabelCreated`, adds a "New label" row that opens this component's own dialog. */
    mailboxUid?: string;
    onLabelCreated?: (label: Label) => void;
}

/** The label list as a menu button of its own - the bulk Apply label action and the reading pane's Labels. */
export default function LabelMenuButton({
    applied,
    partial = [],
    onCommit,
    labels,
    commit,
    clear,
    emptyNote,
    note,
    busy,
    label,
    "aria-label": ariaLabel,
    disabled,
    title,
    className,
    mailboxUid,
    onLabelCreated,
}: LabelMenuButtonProps) {
    const [open, setOpen] = useState(false);
    const [creating, setCreating] = useState(false);
    const state = useLabelDraft(applied, partial, open);
    return (
        <>
        <MenuButton
            aria-label={ariaLabel}
            label={label}
            icon={<HiOutlineTag size={16} aria-hidden="true" className="shrink-0 text-text-muted" />}
            disabled={disabled}
            title={title}
            className={className}
            onOpenChange={setOpen}
            sections={labelSections({
                labels,
                state,
                commit: { ...commit, disabled: commit.disabled || !state.dirty, onSelect: () => onCommit(state.draft, state.mixed) },
                clear,
                emptyNote,
                note,
                busy,
                onCreate: mailboxUid && onLabelCreated ? () => setCreating(true) : undefined,
            })}
        />
        {mailboxUid && onLabelCreated && (
            <NewLabelDialog
                open={creating}
                onClose={() => setCreating(false)}
                mailboxUid={mailboxUid}
                onCreated={onLabelCreated}
            />
        )}
        </>
    );
}
