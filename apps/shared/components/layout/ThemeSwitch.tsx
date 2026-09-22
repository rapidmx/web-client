///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useContext, useId, useRef } from "react";
import { HiOutlineComputerDesktop, HiOutlineMoon, HiOutlineSun } from "react-icons/hi2";
import type { AppearanceMode } from "@rapidmx/react-shared/appearance/preferencesApi.js";
import { AppearanceContext, INERT_APPEARANCE } from "../../appearance/appearanceContext.js";

const CHOICES: { mode: AppearanceMode; label: string; hint: string; Icon: typeof HiOutlineSun }[] = [
    { mode: "system", label: "System", hint: "System - follow this device", Icon: HiOutlineComputerDesktop },
    { mode: "light", label: "Light", hint: "Light", Icon: HiOutlineSun },
    { mode: "dark", label: "Dark", hint: "Dark", Icon: HiOutlineMoon },
];

/**
 * The account menu's colour scheme control: a row "Theme" with a three-way segmented control of icon buttons - System, Light, Dark - a
 * `radiogroup` (one tab stop, the arrow keys move and choose, Home/End jump). A choice applies through `useAppearance().setPrefs()`, which
 * changes every open surface in the same frame (the app frame, message cards, the consoles) and saves in the background - and puts the change
 * back, with a notice, if the save fails. Renders nothing where there is no `AppearanceProvider` (a shell that has none, a component tested
 * alone): the hook is inert there and a control that changes nothing would be a lie.
 */
export default function ThemeSwitch() {
    const appearance = useContext(AppearanceContext);
    const buttons = useRef<(HTMLButtonElement | null)[]>([]);
    const labelId = useId();
    if (appearance === INERT_APPEARANCE) {
        return null;
    }
    const current = appearance.prefs.mode;

    function choose(index: number, focus: boolean) {
        const next = CHOICES[(index + CHOICES.length) % CHOICES.length];
        if (next.mode !== current) {
            appearance.setPrefs({ mode: next.mode });
        }
        if (focus) {
            buttons.current[(index + CHOICES.length) % CHOICES.length]?.focus();
        }
    }

    function handleKeyDown(event: React.KeyboardEvent, index: number) {
        const target = { ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowUp: index - 1, Home: 0, End: CHOICES.length - 1 }[event.key];
        if (target !== undefined) {
            event.preventDefault();
            choose(target, true);
        }
    }

    return (
        <div className="flex items-center justify-between gap-3 px-3.5 py-2 border-b border-border">
            <span id={labelId} className="text-sm text-text">
                Theme
            </span>
            <div role="radiogroup" aria-labelledby={labelId} className="inline-flex rounded-sm border border-border bg-surface-alt p-0.5">
                {CHOICES.map(({ mode, label, hint, Icon }, index) => {
                    const selected = mode === current;
                    return (
                        <button
                            key={mode}
                            ref={(element) => {
                                buttons.current[index] = element;
                            }}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            aria-label={label}
                            title={hint}
                            tabIndex={selected ? 0 : -1}
                            onClick={() => choose(index, false)}
                            onKeyDown={(event) => handleKeyDown(event, index)}
                            className={[
                                "flex h-7 w-8 items-center justify-center rounded-[3px] focus-visible:outline-2 focus-visible:outline-primary",
                                selected ? "bg-surface text-primary-dark shadow-sm" : "text-text-muted hover:text-text",
                            ].join(" ")}
                        >
                            <Icon size={16} aria-hidden="true" />
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
