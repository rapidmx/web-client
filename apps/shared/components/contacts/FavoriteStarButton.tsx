///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { HiOutlineStar, HiStar } from "react-icons/hi2";

export interface FavoriteStarButtonProps {
    favorite: boolean;
    onToggle: () => void;
    disabled?: boolean;
    className?: string;
}

/** The star that marks a contact as a favorite: filled when it is one. A toggle button (`aria-pressed`) named "Favorite". */
export default function FavoriteStarButton({ favorite, onToggle, disabled, className }: FavoriteStarButtonProps) {
    return (
        <button
            type="button"
            aria-label="Favorite"
            title={favorite ? "Remove from favorites" : "Add to favorites"}
            aria-pressed={favorite}
            disabled={disabled}
            onClick={onToggle}
            className={[
                "inline-flex items-center justify-center rounded-sm p-1 hover:bg-surface-alt disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-primary",
                favorite ? "text-warning" : "text-text-muted hover:text-text",
                className,
            ]
                .filter(Boolean)
                .join(" ")}
        >
            {favorite ? <HiStar aria-hidden="true" className="size-6" /> : <HiOutlineStar aria-hidden="true" className="size-6" />}
        </button>
    );
}
