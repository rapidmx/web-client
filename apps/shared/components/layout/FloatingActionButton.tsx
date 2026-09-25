///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ButtonHTMLAttributes } from "react";
import type { IconType } from "react-icons";

export interface FloatingActionButtonProps
    extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children" | "className" | "type"> {
    /** The button's accessible name (it shows only the icon). */
    label: string;
    icon: IconType;
}

/**
 * The phone layout's primary action - "New message" in Mail, "New event" in Calendar, "New contact" in Contacts - as a small round accent button
 * floating at the bottom right, just above the bottom tab bar (which is `h-14`, fixed). A real `<button>` named by `label`; hidden from `md` up,
 * where each page keeps its own toolbar button. Any other button attribute (`onPointerEnter`, `onFocus`, ...) is passed through.
 */
export default function FloatingActionButton({ label, icon: Icon, ...rest }: FloatingActionButtonProps) {
    return (
        <button
            {...rest}
            type="button"
            aria-label={label}
            className="md:hidden fixed right-4 bottom-[4.5rem] z-30 w-12 h-12 flex items-center justify-center rounded-full bg-primary text-white shadow-lg hover:bg-primary-dark"
        >
            <Icon size={22} aria-hidden="true" />
        </button>
    );
}
