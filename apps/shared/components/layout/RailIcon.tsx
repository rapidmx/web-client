///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";

/** The side, in CSS pixels, of the square the icon is fitted into and measured in: the rail is 4rem wide and the title bar 4rem tall, each less its 1px border. */
const SIZE = 63;

/** Pixels this transparent or less count as empty. */
const EMPTY_ALPHA = 24;

/** The number of rows at the top of `size` x `size` RGBA pixel data that are empty - the icon's own margin above its first visible pixel. */
export function emptyRowsAtTop(rgba: ArrayLike<number>, size: number): number {
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (rgba[(y * size + x) * 4 + 3] > EMPTY_ALPHA) {
                return y;
            }
        }
    }
    return 0;
}

/** Whether this environment can decode an image and read it back - not a server, and not jsdom, where there is nothing to measure. */
export function canMeasureImages(): boolean {
    try {
        return typeof new Image().decode === "function";
    } catch {
        return false;
    }
}

/**
 * How many pixels of empty margin an icon has above its first visible pixel when fitted (`object-fit: contain`) into a `SIZE` square.
 * Drawn on a canvas and read back, so it works for any picture the browser can decode from the same origin (or with CORS); `0` where
 * that isn't possible (no canvas, a picture that won't load, one from another origin that taints the canvas).
 */
export async function measureTopMargin(src: string): Promise<number> {
    try {
        const image = new Image();
        image.src = src;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = SIZE;
        canvas.height = SIZE;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context || !image.naturalWidth || !image.naturalHeight) {
            return 0;
        }
        const scale = Math.min(SIZE / image.naturalWidth, SIZE / image.naturalHeight);
        const width = image.naturalWidth * scale;
        const height = image.naturalHeight * scale;
        context.drawImage(image, (SIZE - width) / 2, (SIZE - height) / 2, width, height);
        return emptyRowsAtTop(context.getImageData(0, 0, SIZE, SIZE).data, SIZE);
    } catch {
        return 0;
    }
}

/**
 * The deployment's icon at the top of an app rail (`AppShell`, `AdminShell`, `EscrowShell`): a block as wide as the rail and as tall as the
 * title bar beside it (4rem), flush with the top and left edges of the window - no padding above it - with the bar's own bottom border
 * continued under it, so the two read as one block. The picture is fitted inside the block, never cropped, and raised by whatever empty
 * margin the file itself has above its artwork, so the first visible pixel is at the very top of the window (a logo exported with 6% of
 * air around it would otherwise still leave a gap). The icon is shown once measured (a few milliseconds after it loads).
 */
export default function RailIcon({ src }: { src: string }) {
    const [margin, setMargin] = useState<number | null>(null);
    useEffect(() => {
        let cancelled = false;
        if (!canMeasureImages()) {
            // Nothing to measure with: show the icon as it is (in the same effect pass, so nothing waits and nothing updates later).
            setMargin(0);
            return;
        }
        setMargin(null);
        void measureTopMargin(src).then((measured) => {
            if (!cancelled) {
                setMargin(measured);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [src]);

    return (
        <div className="h-16 w-full shrink-0 overflow-hidden border-b border-border mb-2" data-rail-icon="">
            <img
                src={src}
                width="64"
                height="64"
                alt=""
                className="block h-full w-full object-contain"
                style={{ transform: margin ? `translateY(-${margin}px)` : undefined, opacity: margin === null ? 0 : 1 }}
            />
        </div>
    );
}
