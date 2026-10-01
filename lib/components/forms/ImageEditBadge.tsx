///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useRef, useState } from "react";
import { HiArrowUpTray, HiCamera, HiTrash } from "react-icons/hi2";
import MenuButton, { type MenuItemSpec } from "../menus/MenuButton.js";
import CameraCaptureModal from "./CameraCaptureModal.js";

export interface ImageEditBadgeProps {
    /** Where the badge sits on the picture it edits: the lower right of an avatar, the upper right of a banner. */
    position: "bottom-right" | "top-right";
    /** Whether there is a picture to remove: "Remove photo" is in the menu only then. */
    hasImage: boolean;
    /** `"sm"` (20px) for a picture too small for the default 28px badge, such as a 48px avatar. */
    size?: "sm" | "md";
    /** Disables the badge while a chosen picture is being worked on. */
    busy?: boolean;
    /** The badge's accessible name, which also names its menu ("Change contact photo", "Change banner"). */
    label: string;
    /** The accessible name of the (hidden) file input "Upload file" opens. The camera input is named "<this> (camera)". */
    fileInputLabel?: string;
    /** Called with the picture as it was chosen or captured; the caller makes it fit what it stores. */
    onFile: (file: File) => void;
    /** Called by "Remove photo". Without it there is no such row. */
    onRemove?: () => void;
    /** Told why the camera could not be used (the camera dialog shows it too). */
    onError?: (message: string) => void;
}

/** How "Take photo" reaches the camera on this device, or why it cannot: a touch device (a phone or tablet) hands the picking to its own camera app through an input's
 * `capture`; anything else with `getUserMedia` gets the live preview dialog. */
function cameraAccess(): { mode: "capture" | "preview"; unavailable?: undefined } | { mode?: undefined; unavailable: string } {
    if (typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches) {
        return { mode: "capture" };
    }
    if (typeof navigator.mediaDevices?.getUserMedia === "function") {
        return { mode: "preview" };
    }
    return {
        unavailable:
            window.isSecureContext === false ? "The camera needs a secure (https) connection." : "This browser cannot use the camera - choose Upload file instead.",
    };
}

const POSITIONS = { "bottom-right": "bottom-0 right-0", "top-right": "top-2 right-2" };
const SIZES = { sm: { box: "h-5 w-5", icon: 12 }, md: { box: "h-7 w-7", icon: 14 } };

/**
 * A round camera badge laid over the corner of a picture - an avatar or a banner - that opens a menu to change it: "Upload file", "Take photo" and, when there is a
 * picture, "Remove photo". The badge is `position: absolute`, so the caller wraps the picture in a `relative` element (`relative inline-block` for an avatar) and puts this
 * inside it. The menu is `MenuButton`'s: arrow keys, Enter, Escape and a click outside close it, focus returns to the badge. "Take photo" opens the device's camera app through
 * an input's `capture` on a phone or tablet, and a live preview dialog (`getUserMedia`) on a computer; it is disabled, with a title that says why, where there is neither.
 */
export default function ImageEditBadge({ position, hasImage, busy, size = "md", label, fileInputLabel = "Image file", onFile, onRemove, onError }: ImageEditBadgeProps) {
    const fileInput = useRef<HTMLInputElement>(null);
    const captureInput = useRef<HTMLInputElement>(null);
    const [cameraOpen, setCameraOpen] = useState(false);

    function fileChanged(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (file) {
            onFile(file);
        }
        // The same file can be chosen again.
        e.target.value = "";
    }

    const camera = cameraAccess();
    const items: MenuItemSpec[] = [
        { key: "upload", label: "Upload file", icon: <HiArrowUpTray size={14} />, onSelect: () => fileInput.current?.click() },
        {
            key: "camera",
            label: "Take photo",
            icon: <HiCamera size={14} />,
            disabled: !camera.mode,
            title: camera.unavailable,
            onSelect: () => (camera.mode === "capture" ? captureInput.current?.click() : setCameraOpen(true)),
        },
    ];
    if (hasImage && onRemove) {
        items.push({ key: "remove", label: "Remove photo", icon: <HiTrash size={14} />, onSelect: onRemove });
    }
    return (
        <>
            <MenuButton
                iconOnly
                label={label}
                aria-label={label}
                title={label}
                icon={<HiCamera size={SIZES[size].icon} aria-hidden="true" />}
                disabled={busy}
                width={192}
                sections={[{ key: "image", items }]}
                className={`absolute ${POSITIONS[position]} flex ${SIZES[size].box} items-center justify-center rounded-full bg-black/70 text-white ring-2 ring-surface hover:bg-black/80 disabled:opacity-50`}
            />
            <input ref={fileInput} type="file" accept="image/*" aria-label={fileInputLabel} className="sr-only" tabIndex={-1} onChange={fileChanged} />
            {/* `capture` has a phone or tablet open its camera app instead of the picker. */}
            <input
                ref={captureInput}
                type="file"
                accept="image/*"
                capture="user"
                aria-label={`${fileInputLabel} (camera)`}
                className="sr-only"
                tabIndex={-1}
                onChange={fileChanged}
            />
            {cameraOpen && (
                <CameraCaptureModal
                    onClose={() => setCameraOpen(false)}
                    onError={onError}
                    onCapture={(file) => {
                        setCameraOpen(false);
                        onFile(file);
                    }}
                />
            )}
        </>
    );
}
