///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, ReactNode, useContext } from "react";
import { HiOutlineBars2, HiOutlineXMark } from "react-icons/hi2";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import { EventShellContext } from "./EventShell.js";
import { EventFormController } from "./eventForm.js";
import { QuickTab, quickPanelProps } from "./QuickCreateTabs.js";

export interface QuickFaceFrameProps {
    c: EventFormController;
    /** The `QuickCreateTabs` strip. */
    tabs: ReactNode;
    /** The tab this face is the panel of. */
    tab: QuickTab;
    error: string | null;
    /** Leave the title out (the Appointment schedule tab once it has saved). */
    hideTitle?: boolean;
    /** Enter in a field, or the Save button. */
    onSubmit: (event: FormEvent) => void;
    /** What sits in the tab's panel under the title. */
    children: ReactNode;
    /** The buttons along the bottom (More options, Save). */
    footer: ReactNode;
}

/**
 * The frame the Task and Appointment schedule faces share, drawn the way `EventQuickForm` draws the Event face: a grip to drag the popover
 * and a close button, the tab strip, then the panel - an error, the title (the one the Event tab holds, so switching tabs keeps it) and the
 * face's own rows - and the buttons.
 */
export default function QuickFaceFrame({ c, tabs, tab, error, hideTitle, onSubmit, children, footer }: QuickFaceFrameProps) {
    const { dragHandleProps } = useContext(EventShellContext);
    return (
        <form onSubmit={onSubmit} className="flex flex-col">
            <div className="flex items-center justify-between px-2 pt-2">
                {dragHandleProps ? (
                    <div {...dragHandleProps} aria-hidden="true" className="flex-1 h-7 flex items-center cursor-move text-text-muted select-none touch-none">
                        <HiOutlineBars2 size={20} />
                    </div>
                ) : (
                    <div className="flex-1" />
                )}
                <button
                    type="button"
                    aria-label="Close"
                    onClick={c.onCancel}
                    className="w-8 h-8 flex items-center justify-center rounded-full text-text-muted hover:bg-surface-alt hover:text-text"
                >
                    <HiOutlineXMark size={20} aria-hidden="true" />
                </button>
            </div>

            {tabs}

            <div {...quickPanelProps(tab)} className="flex flex-col gap-3 px-5 pb-3">
                {error && <Alert>{error}</Alert>}

                {!hideTitle && (
                    <div className="pl-8">
                        <input
                            type="text"
                            aria-label="Title"
                            placeholder="Add title"
                            data-autofocus
                            className="w-full text-xl bg-transparent text-text border-0 border-b-2 border-primary/50 focus:border-primary focus:outline-none pb-1 placeholder:text-text-muted"
                            value={c.values.title}
                            onChange={(e) => c.update({ title: e.target.value })}
                        />
                    </div>
                )}

                {children}
            </div>

            <div className="flex items-center justify-end gap-2 px-4 py-3">{footer}</div>
        </form>
    );
}
