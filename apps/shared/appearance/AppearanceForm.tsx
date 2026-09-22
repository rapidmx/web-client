///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { DragEvent, useEffect, useRef, useState } from "react";
import {
    APPEARANCE_MODES,
    AppearanceMode,
    BACKGROUND_BLUR_MAX,
    BACKGROUND_DIM_MAX,
    BACKGROUND_FITS,
    BACKGROUND_IMAGE_TYPES,
    BACKGROUND_MAX_BYTES,
    BackgroundFit,
    BackgroundKind,
    ColorKey,
    DEFAULT_BACKGROUND,
    validateBackgroundFile,
} from "@rapidmx/react-shared/appearance/preferencesApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import ColorField from "./ColorField.js";
import { normalizeHex } from "./color.js";
import { useAppearance } from "./appearanceContext.js";
import { DEFAULT_PALETTE, contrastWarnings } from "./theme.js";

const MODE_LABELS: Record<AppearanceMode, { label: string; hint: string }> = {
    system: { label: "System", hint: "Follow this device" },
    light: { label: "Light", hint: "Always light" },
    dark: { label: "Dark", hint: "Always dark" },
};

const FIT_LABELS: Record<BackgroundFit, string> = {
    cover: "Cover (fill the window)",
    contain: "Contain (show all of it)",
    tile: "Tile (repeat)",
};

const COLOR_FIELDS: { key: ColorKey; label: string; description: string; token: string }[] = [
    { key: "primary", label: "Primary", description: "Links, the selected app and folder, and focus rings.", token: "--rr-color-primary" },
    { key: "accent", label: "Accent", description: "Main buttons and highlights.", token: "--rr-color-accent" },
    { key: "surface", label: "Surface", description: "Panels, lists and menus.", token: "--rr-color-surface" },
    { key: "text", label: "Text", description: "Everything written on a surface.", token: "--rr-color-text" },
];

/** The colour a token has right now on the page (the app's, the branding's, or the user's own), as `#rrggbb`; `fallback` where it can't be read (jsdom, or a value that isn't a colour). Only called from an effect, so there is always a document. */
function readToken(token: string, fallback: string): string {
    return normalizeHex(getComputedStyle(document.documentElement).getPropertyValue(token)) ?? fallback;
}

const DEFAULT_TOKEN_COLORS: Record<ColorKey, { light: string; dark: string }> = {
    primary: { light: "#0d9488", dark: "#2dd4bf" },
    accent: { light: "#a3690a", dark: "#f2af0d" },
    surface: { light: DEFAULT_PALETTE.light.surface, dark: DEFAULT_PALETTE.dark.surface },
    text: { light: DEFAULT_PALETTE.light.text, dark: DEFAULT_PALETTE.dark.text },
};

/** The colour a new "Colour" background starts as. */
const STARTING_BACKGROUND_COLOR = { light: "#dbe4ee", dark: "#1e293b" };

function formatBytes(bytes: number): string {
    return `${bytes / (1024 * 1024)} MB`;
}

/**
 * Settings > Appearance: the colour scheme, the theme colours and the background. Every control changes the app itself at once - the
 * page you are on is the preview - and saves in the background (`useAppearance()`); a save that fails puts the change back and says so
 * here. Nothing waits on the server, and nothing is disabled while it works.
 */
export default function AppearanceForm() {
    const appearance = useAppearance();
    const { prefs, resolved, setPrefs, uploadBackground, removeBackground, reset, error, clearError, saving, isDefault, backgroundUrl } = appearance;
    const background = prefs.background;
    const colors = prefs.colors;

    // The kind the radio shows: chosen before it can take effect ("Image" is chosen before there is one).
    const [kind, setKind] = useState<BackgroundKind>(background?.kind ?? "none");
    useEffect(() => setKind(background?.kind ?? "none"), [background?.kind]);
    const [fileError, setFileError] = useState<string | null>(null);
    const [dragging, setDragging] = useState(false);
    const [uploading, setUploading] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    // What the colour fields show while unset: the tokens as they are on the page (a deployment's branding may have its own).
    const [current, setCurrent] = useState<Record<ColorKey, string>>(() => ({
        primary: DEFAULT_TOKEN_COLORS.primary[resolved],
        accent: DEFAULT_TOKEN_COLORS.accent[resolved],
        surface: DEFAULT_TOKEN_COLORS.surface[resolved],
        text: DEFAULT_TOKEN_COLORS.text[resolved],
    }));
    useEffect(() => {
        setCurrent(
            Object.fromEntries(COLOR_FIELDS.map((field) => [field.key, readToken(field.token, DEFAULT_TOKEN_COLORS[field.key][resolved])])) as Record<
                ColorKey,
                string
            >,
        );
    }, [resolved, colors]);

    const warnings = contrastWarnings(colors, resolved);
    const hasImage = background?.imageVersion !== undefined;

    function chooseKind(next: BackgroundKind) {
        setKind(next);
        if (next === "none") {
            setPrefs({ background: { kind: "none" } });
        } else if (next === "color") {
            setPrefs({ background: { kind: "color", color: background?.color ?? STARTING_BACKGROUND_COLOR[resolved] } });
        } else if (hasImage) {
            setPrefs({ background: { kind: "image" } });
        }
    }

    function handleFile(file: File | undefined) {
        if (!file) {
            return;
        }
        const problem = validateBackgroundFile(file);
        if (problem) {
            setFileError(problem);
            return;
        }
        setFileError(null);
        setUploading(file.name);
        void uploadBackground(file).finally(() => setUploading(null));
    }

    function handleDrop(event: DragEvent<HTMLDivElement>) {
        event.preventDefault();
        setDragging(false);
        handleFile(event.dataTransfer.files[0]);
    }

    const showImageControls = kind === "image";
    const dim = background?.dim ?? DEFAULT_BACKGROUND.dim;
    const blur = background?.blur ?? DEFAULT_BACKGROUND.blur;
    const fit = background?.fit ?? DEFAULT_BACKGROUND.fit;

    return (
        <div className="flex-1 min-w-0 overflow-y-auto p-6">
            <div className="max-w-2xl flex flex-col gap-8">
                <div>
                    <h1 className="text-lg font-bold tracking-tight mb-1">Appearance</h1>
                    <p className="text-sm text-text-muted">
                        Choose how RapidMX looks for you. Every change shows straight away, across the whole app, and is saved to your account
                        for your other devices.
                    </p>
                    <p role="status" aria-live="polite" className="mt-1 h-4 text-xs text-text-muted">
                        {saving ? "Saving…" : ""}
                    </p>
                </div>

                {error && (
                    <Alert>
                        <span className="flex-1">{error}</span>
                        <button type="button" className="font-semibold underline hover:no-underline" onClick={clearError}>
                            Dismiss
                        </button>
                    </Alert>
                )}

                <fieldset className="flex flex-col gap-2">
                    <legend className="text-sm font-semibold mb-1">Colour scheme</legend>
                    <div className="flex flex-wrap gap-2">
                        {APPEARANCE_MODES.map((mode) => (
                            <label
                                key={mode}
                                className={[
                                    "flex cursor-pointer items-center gap-2 rounded-sm border px-3 py-2 text-sm",
                                    prefs.mode === mode ? "border-primary bg-primary/10" : "border-border hover:bg-surface-alt",
                                ].join(" ")}
                            >
                                <input
                                    type="radio"
                                    name="appearance-mode"
                                    value={mode}
                                    checked={prefs.mode === mode}
                                    onChange={() => setPrefs({ mode })}
                                />
                                <span>
                                    <span className="font-semibold">{MODE_LABELS[mode].label}</span>
                                    <span className="ml-1.5 text-xs text-text-muted">{MODE_LABELS[mode].hint}</span>
                                </span>
                            </label>
                        ))}
                    </div>
                </fieldset>

                <fieldset className="flex flex-col gap-4">
                    <legend className="text-sm font-semibold mb-1">Theme colours</legend>
                    <p className="text-xs text-text-muted -mt-2">
                        These apply in both the light and the dark scheme. A colour you have not chosen stays as the app (or your organization)
                        has it.
                    </p>
                    {COLOR_FIELDS.map((field) => (
                        <ColorField
                            key={field.key}
                            id={`appearance-${field.key}`}
                            label={field.label}
                            description={field.description}
                            value={colors?.[field.key]}
                            current={current[field.key]}
                            onChange={(hex) => setPrefs({ colors: { [field.key]: hex } })}
                            onReset={() => setPrefs({ colors: { [field.key]: null } })}
                        />
                    ))}
                    {warnings.map((warning) => (
                        // The warning's own colours, not the theme's: it is about a theme that may be unreadable.
                        <p key={warning.id} role="status" className="rounded-sm bg-warning px-3 py-2 text-sm font-medium text-warning-contrast">
                            {warning.message}
                        </p>
                    ))}
                </fieldset>

                <fieldset className="flex flex-col gap-4">
                    <legend className="text-sm font-semibold mb-1">Background</legend>
                    <div className="flex flex-wrap gap-2">
                        {(["none", "color", "image"] as const).map((option) => (
                            <label
                                key={option}
                                className={[
                                    "flex cursor-pointer items-center gap-2 rounded-sm border px-3 py-2 text-sm",
                                    kind === option ? "border-primary bg-primary/10" : "border-border hover:bg-surface-alt",
                                ].join(" ")}
                            >
                                <input
                                    type="radio"
                                    name="appearance-background"
                                    value={option}
                                    checked={kind === option}
                                    onChange={() => chooseKind(option)}
                                />
                                <span className="font-semibold">{option === "none" ? "None" : option === "color" ? "Colour" : "Image"}</span>
                            </label>
                        ))}
                    </div>

                    {kind === "color" && background?.color && (
                        <ColorField
                            id="appearance-background-color"
                            label="Background colour"
                            description="Shows behind every panel of the app."
                            value={background.color}
                            current={background.color}
                            onChange={(hex) => setPrefs({ background: { kind: "color", color: hex } })}
                        />
                    )}

                    {showImageControls && (
                        <div className="flex flex-col gap-4">
                            <div
                                role="group"
                                aria-label="Background image"
                                onDragEnter={(event) => {
                                    event.preventDefault();
                                    setDragging(true);
                                }}
                                onDragOver={(event) => {
                                    event.preventDefault();
                                    setDragging(true);
                                }}
                                onDragLeave={() => setDragging(false)}
                                onDrop={handleDrop}
                                className={[
                                    "flex flex-wrap items-center gap-4 rounded-md border-2 border-dashed p-4",
                                    dragging ? "border-primary bg-primary/10" : "border-border",
                                ].join(" ")}
                            >
                                {hasImage && backgroundUrl && (
                                    <img
                                        src={backgroundUrl}
                                        alt="Your background image"
                                        className="h-20 w-32 shrink-0 rounded-sm border border-border object-cover"
                                    />
                                )}
                                <div className="min-w-0 flex-1 basis-48 text-sm">
                                    <p className="font-semibold">{hasImage ? "Replace the image" : "Add an image"}</p>
                                    <p className="text-xs text-text-muted">
                                        Drag a picture here, or choose one. PNG, JPEG, WebP or AVIF, up to {formatBytes(BACKGROUND_MAX_BYTES)}.
                                    </p>
                                    {uploading && (
                                        <p role="status" className="mt-1 text-xs text-text-muted">
                                            Uploading {uploading}&hellip;
                                        </p>
                                    )}
                                </div>
                                <input
                                    ref={inputRef}
                                    type="file"
                                    accept={BACKGROUND_IMAGE_TYPES.join(",")}
                                    aria-label="Choose a background image"
                                    className="sr-only"
                                    onChange={(event) => {
                                        handleFile(event.target.files?.[0]);
                                        // The same file can be chosen again.
                                        event.target.value = "";
                                    }}
                                />
                                <div className="flex shrink-0 gap-2">
                                    <Button type="button" variant="secondary" className="!w-auto" onClick={() => inputRef.current?.click()}>
                                        Choose image
                                    </Button>
                                    {hasImage && (
                                        <Button
                                            type="button"
                                            variant="secondary"
                                            className="!w-auto"
                                            onClick={() => {
                                                setFileError(null);
                                                void removeBackground();
                                            }}
                                        >
                                            Remove
                                        </Button>
                                    )}
                                </div>
                            </div>
                            {fileError && (
                                <p role="alert" className="text-sm text-danger">
                                    {fileError}
                                </p>
                            )}

                            {hasImage && (
                                <div className="flex flex-col gap-4">
                                    <div>
                                        <label htmlFor="appearance-dim" className="flex justify-between text-sm font-semibold">
                                            <span>Dim</span>
                                            <span className="font-normal text-text-muted">{Math.round(dim * 100)}%</span>
                                        </label>
                                        <input
                                            id="appearance-dim"
                                            type="range"
                                            min={0}
                                            max={Math.round(BACKGROUND_DIM_MAX * 100)}
                                            step={1}
                                            value={Math.round(dim * 100)}
                                            aria-valuetext={`${Math.round(dim * 100)} percent`}
                                            onChange={(event) => setPrefs({ background: { dim: Number(event.target.value) / 100 } })}
                                            className="w-full accent-primary"
                                        />
                                        <p className="text-xs text-text-muted">Lays the app&rsquo;s surface colour over the picture so text stays easy to read.</p>
                                    </div>
                                    <div>
                                        <label htmlFor="appearance-blur" className="flex justify-between text-sm font-semibold">
                                            <span>Blur</span>
                                            <span className="font-normal text-text-muted">{blur} px</span>
                                        </label>
                                        <input
                                            id="appearance-blur"
                                            type="range"
                                            min={0}
                                            max={BACKGROUND_BLUR_MAX}
                                            step={1}
                                            value={blur}
                                            aria-valuetext={`${blur} pixels`}
                                            onChange={(event) => setPrefs({ background: { blur: Number(event.target.value) } })}
                                            className="w-full accent-primary"
                                        />
                                    </div>
                                    <div>
                                        <label htmlFor="appearance-fit" className="block text-sm font-semibold mb-1">
                                            Fit
                                        </label>
                                        <select
                                            id="appearance-fit"
                                            value={fit}
                                            onChange={(event) => setPrefs({ background: { fit: event.target.value as BackgroundFit } })}
                                            className="w-full max-w-xs rounded-sm border border-border bg-surface px-2 py-1.5 text-sm text-text"
                                        >
                                            {BACKGROUND_FITS.map((option) => (
                                                <option key={option} value={option}>
                                                    {FIT_LABELS[option]}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </fieldset>

                <div>
                    <Button type="button" variant="secondary" className="!w-auto" disabled={isDefault} onClick={() => void reset()}>
                        Reset all
                    </Button>
                </div>
            </div>
        </div>
    );
}
