///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "text";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
    variant?: ButtonVariant;
    /** Renders a small spinner before the button's content. */
    loading?: boolean;
    className?: string;
}

const BASE =
    "inline-flex items-center justify-center gap-2 font-semibold text-sm rounded-sm border transition-colors disabled:opacity-55 disabled:cursor-not-allowed active:translate-y-px";

/** Primary is gold (the brand's action color, per the style guide's "gold gradient fill" convention);
 * secondary/text hover accents follow the guide's "turning gold on hover" rule too. Teal (`primary`
 * the color token, confusingly named the same as this `primary` variant) stays reserved for
 * structural/navigational chrome — active nav items, links, focus rings — not call-to-action buttons. */
const VARIANTS: Record<ButtonVariant, string> = {
    primary:
        "w-full py-2.5 px-4 bg-gradient-to-b from-accent-soft to-accent border-transparent text-text-on-accent hover:not-disabled:from-accent hover:not-disabled:to-accent-dark",
    secondary:
        "w-full py-2.5 px-4 bg-transparent border-border text-text hover:not-disabled:border-accent hover:not-disabled:text-accent-dark",
    text: "w-auto py-1 px-0.5 border-transparent bg-transparent text-accent-dark hover:not-disabled:underline",
};

export default function Button({ variant = "primary", loading, className, children, ...rest }: ButtonProps) {
    return (
        <button className={[BASE, VARIANTS[variant], className].filter(Boolean).join(" ")} {...rest}>
            {loading && (
                <span className="w-4 h-4 rounded-full border-2 border-current/30 border-t-current animate-spin" />
            )}
            {children}
        </button>
    );
}
