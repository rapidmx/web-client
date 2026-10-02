// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAMERA_BLOCKED_MESSAGE, CAMERA_FAILED_MESSAGE, CAMERA_MISSING_MESSAGE } from "../../../../lib/components/forms/CameraCaptureModal.js";
import ImageEditBadge, { type ImageEditBadgeProps } from "../../../../lib/components/forms/ImageEditBadge.js";

// jsdom has neither a camera nor media streams nor a canvas: the stream, `getUserMedia()`, `matchMedia()` and the canvas below are stand-ins that record what the component
// asked of them. Whether a real browser shows the preview, honours `capture` or prompts for permission is not exercised here.

const TRACKS = [{ stop: vi.fn() }, { stop: vi.fn() }];
const STREAM = { getTracks: () => TRACKS };

function props(overrides: Partial<ImageEditBadgeProps> = {}): ImageEditBadgeProps {
    return { position: "bottom-right", hasImage: false, label: "Change banner", onFile: vi.fn(), ...overrides };
}

function setMediaDevices(getUserMedia: ((constraints: unknown) => Promise<unknown>) | undefined) {
    Object.defineProperty(navigator, "mediaDevices", { value: getUserMedia ? { getUserMedia } : undefined, configurable: true });
}

function setTouch(coarse: boolean | undefined) {
    vi.stubGlobal("matchMedia", coarse === undefined ? undefined : vi.fn(() => ({ matches: coarse })));
}

beforeEach(() => {
    TRACKS.forEach((track) => track.stop.mockClear());
    setTouch(undefined);
    setMediaDevices(undefined);
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    delete (window as { isSecureContext?: unknown }).isSecureContext;
});

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Change banner" }));
}

describe("ImageEditBadge", () => {
    it("is a button named by its label that opens a menu with Upload file and Take photo", async () => {
        const user = userEvent.setup();
        render(<ImageEditBadge {...props()} />);
        const badge = screen.getByRole("button", { name: "Change banner" });
        expect(badge).toHaveAttribute("aria-haspopup", "menu");
        expect(badge).toHaveAttribute("aria-expanded", "false");
        await user.click(badge);
        expect(badge).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByRole("menu", { name: "Change banner" })).toBeInTheDocument();
        expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Upload file", "Take photo"]);
    });

    it("has Remove photo in the menu only when there is a picture and something to call", async () => {
        const user = userEvent.setup();
        const onRemove = vi.fn();
        const { rerender } = render(<ImageEditBadge {...props({ hasImage: true, onRemove })} />);
        await openMenu(user);
        expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Upload file", "Take photo", "Remove photo"]);
        await user.click(screen.getByRole("menuitem", { name: "Remove photo" }));
        expect(onRemove).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();

        rerender(<ImageEditBadge {...props({ hasImage: false, onRemove })} />);
        await openMenu(user);
        expect(screen.queryByRole("menuitem", { name: "Remove photo" })).not.toBeInTheDocument();
        await user.keyboard("{Escape}");

        rerender(<ImageEditBadge {...props({ hasImage: true })} />);
        await openMenu(user);
        expect(screen.queryByRole("menuitem", { name: "Remove photo" })).not.toBeInTheDocument();
    });

    it("sits at the lower right of an avatar or the upper right of a banner, in the default size or a small one", () => {
        const { rerender } = render(<ImageEditBadge {...props()} />);
        let badge = screen.getByRole("button", { name: "Change banner" });
        expect(badge).toHaveClass("absolute", "bottom-0", "right-0", "h-7", "w-7", "rounded-full");
        rerender(<ImageEditBadge {...props({ position: "top-right", size: "sm" })} />);
        badge = screen.getByRole("button", { name: "Change banner" });
        expect(badge).toHaveClass("absolute", "top-2", "right-2", "h-5", "w-5");
        expect(badge).not.toHaveClass("bottom-0");
    });

    it("is disabled while busy", () => {
        render(<ImageEditBadge {...props({ busy: true })} />);
        expect(screen.getByRole("button", { name: "Change banner" })).toBeDisabled();
    });

    it("opens with the arrow keys, moves with them, chooses with Enter, and gives focus back to the badge on Escape", async () => {
        const user = userEvent.setup();
        const click = vi.spyOn(HTMLInputElement.prototype, "click");
        render(<ImageEditBadge {...props()} />);
        const badge = screen.getByRole("button", { name: "Change banner" });
        badge.focus();
        await user.keyboard("{ArrowDown}");
        await waitFor(() => expect(screen.getByRole("menuitem", { name: "Upload file" })).toHaveFocus());
        await user.keyboard("{Enter}");
        expect(click).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        expect(badge).toHaveFocus();

        await user.keyboard("{ArrowDown}");
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        expect(badge).toHaveFocus();
    });

    it("closes on a click outside", async () => {
        const user = userEvent.setup();
        render(
            <div>
                <ImageEditBadge {...props()} />
                <p>elsewhere</p>
            </div>,
        );
        await openMenu(user);
        await user.click(screen.getByText("elsewhere"));
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
});

describe("ImageEditBadge: Upload file", () => {
    it("opens the file picker (any image), and hands the chosen file over as it is", async () => {
        const user = userEvent.setup();
        const onFile = vi.fn();
        const click = vi.spyOn(HTMLInputElement.prototype, "click");
        render(<ImageEditBadge {...props({ onFile, fileInputLabel: "Banner file" })} />);
        await openMenu(user);
        await user.click(screen.getByRole("menuitem", { name: "Upload file" }));
        expect(click).toHaveBeenCalledTimes(1);
        const input = screen.getByLabelText("Banner file");
        expect(input).toHaveAttribute("accept", "image/*");
        expect(input).not.toHaveAttribute("capture");
        const file = new File([new Uint8Array(3)], "wide.png", { type: "image/png" });
        await user.upload(input, file);
        expect(onFile).toHaveBeenCalledWith(file);
        expect((input as HTMLInputElement).value).toBe("");
    });

    it("ignores a cancelled choice, and names the file input 'Image file' without a label of its own", () => {
        const onFile = vi.fn();
        render(<ImageEditBadge {...props({ onFile })} />);
        fireEvent.change(screen.getByLabelText("Image file"), { target: { files: [] } });
        expect(onFile).not.toHaveBeenCalled();
    });
});

describe("ImageEditBadge: Take photo", () => {
    it("opens the device's camera app through a capture input on a touch device, and hands over the photo", async () => {
        setTouch(true);
        const user = userEvent.setup();
        const onFile = vi.fn();
        const click = vi.spyOn(HTMLInputElement.prototype, "click");
        render(<ImageEditBadge {...props({ onFile })} />);
        await openMenu(user);
        await user.click(screen.getByRole("menuitem", { name: "Take photo" }));
        expect(click).toHaveBeenCalledTimes(1);
        const input = screen.getByLabelText("Image file (camera)");
        expect(click.mock.contexts[0]).toBe(input);
        expect(input).toHaveAttribute("capture", "user");
        expect(input).toHaveAttribute("accept", "image/*");
        const file = new File([new Uint8Array(3)], "IMG_1.jpg", { type: "image/jpeg" });
        await user.upload(input, file);
        expect(onFile).toHaveBeenCalledWith(file);
    });

    it("is not offered on a computer without a camera API, and says why", async () => {
        const user = userEvent.setup();
        const { unmount } = render(<ImageEditBadge {...props()} />);
        await openMenu(user);
        const item = screen.getByRole("menuitem", { name: "Take photo" });
        expect(item).toBeDisabled();
        expect(item).toHaveAttribute("title", "This browser cannot use the camera - choose Upload file instead.");
        unmount();

        Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
        render(<ImageEditBadge {...props()} />);
        await openMenu(user);
        expect(screen.getByRole("menuitem", { name: "Take photo" })).toHaveAttribute("title", "The camera needs a secure (https) connection.");
    });

    describe("with a camera on a computer", () => {
        function canvasStub(blob: Blob | null) {
            const drawImage = vi.fn();
            vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({ drawImage })) as never);
            vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(((callback: BlobCallback) => callback(blob)));
            return drawImage;
        }

        async function openCamera(user: ReturnType<typeof userEvent.setup>) {
            await openMenu(user);
            await user.click(screen.getByRole("menuitem", { name: "Take photo" }));
            return screen.findByRole("dialog", { name: "Take photo" });
        }

        it("shows the live preview (front camera, mirrored), captures the frame as photo.jpg, and releases the camera", async () => {
            const getUserMedia = vi.fn(async () => STREAM);
            setMediaDevices(getUserMedia);
            const drawImage = canvasStub(new Blob([new Uint8Array(9)], { type: "image/jpeg" }));
            const user = userEvent.setup();
            const onFile = vi.fn();
            render(<ImageEditBadge {...props({ onFile })} />);
            const dialog = await openCamera(user);
            expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 1280 } } });

            const video = screen.getByLabelText("Camera preview");
            expect(video).toHaveAttribute("playsinline");
            expect(video.autoplay).toBe(true);
            expect(video.muted).toBe(true);
            expect(video).toHaveClass("-scale-x-100");
            await waitFor(() => expect(video.srcObject).toBe(STREAM));
            const capture = screen.getByRole("button", { name: "Capture" });
            expect(capture).toBeDisabled();

            Object.defineProperty(video, "videoWidth", { value: 640 });
            Object.defineProperty(video, "videoHeight", { value: 480 });
            fireEvent.loadedMetadata(video);
            await user.click(capture);

            expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 640, 480);
            expect(onFile).toHaveBeenCalledTimes(1);
            const file = onFile.mock.calls[0][0] as File;
            expect(file.name).toBe("photo.jpg");
            expect(file.type).toBe("image/jpeg");
            expect(file.size).toBe(9);
            TRACKS.forEach((track) => expect(track.stop).toHaveBeenCalledTimes(1));
            expect(dialog).not.toBeInTheDocument();
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        });

        it("stops the camera when Cancel or the close button is pressed", async () => {
            setMediaDevices(async () => STREAM);
            const user = userEvent.setup();
            render(<ImageEditBadge {...props()} />);
            await openCamera(user);
            await waitFor(() => expect((screen.getByLabelText("Camera preview")).srcObject).toBe(STREAM));
            await user.click(screen.getByRole("button", { name: "Cancel" }));
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
            TRACKS.forEach((track) => expect(track.stop).toHaveBeenCalledTimes(1));

            await openCamera(user);
            await waitFor(() => expect((screen.getByLabelText("Camera preview")).srcObject).toBe(STREAM));
            await user.click(screen.getByRole("button", { name: "Close" }));
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
            TRACKS.forEach((track) => expect(track.stop).toHaveBeenCalledTimes(2));
        });

        it("stops the camera when the page goes away, and when it only answers after the dialog was closed", async () => {
            setMediaDevices(async () => STREAM);
            const user = userEvent.setup();
            const { unmount } = render(<ImageEditBadge {...props()} />);
            await openCamera(user);
            await waitFor(() => expect((screen.getByLabelText("Camera preview")).srcObject).toBe(STREAM));
            unmount();
            TRACKS.forEach((track) => expect(track.stop).toHaveBeenCalledTimes(1));

            let grant!: (stream: unknown) => void;
            setMediaDevices(() => new Promise((resolve) => (grant = resolve)));
            render(<ImageEditBadge {...props()} />);
            await openCamera(user);
            await user.click(screen.getByRole("button", { name: "Cancel" }));
            await act(async () => grant(STREAM));
            TRACKS.forEach((track) => expect(track.stop).toHaveBeenCalledTimes(2));
        });

        it.each([
            ["NotAllowedError", CAMERA_BLOCKED_MESSAGE],
            ["SecurityError", CAMERA_BLOCKED_MESSAGE],
            ["NotFoundError", CAMERA_MISSING_MESSAGE],
            ["OverconstrainedError", CAMERA_MISSING_MESSAGE],
            ["DevicesNotFoundError", CAMERA_MISSING_MESSAGE],
            ["AbortError", CAMERA_FAILED_MESSAGE],
        ])("says what went wrong when the camera answers %s, tells onError, and cannot capture", async (name, message) => {
            setMediaDevices(async () => {
                throw Object.assign(new Error("no"), { name });
            });
            const user = userEvent.setup();
            const onError = vi.fn();
            render(<ImageEditBadge {...props({ onError })} />);
            await openCamera(user);
            expect(await screen.findByRole("alert")).toHaveTextContent(message);
            expect(onError).toHaveBeenCalledWith(message);
            expect(screen.getByRole("button", { name: "Capture" })).toBeDisabled();
        });

        it("treats a rejection without a name as the camera failing, with nobody listening to onError", async () => {
            setMediaDevices(() => Promise.reject(undefined));
            const user = userEvent.setup();
            render(<ImageEditBadge {...props()} />);
            await openCamera(user);
            expect(await screen.findByRole("alert")).toHaveTextContent(CAMERA_FAILED_MESSAGE);
        });

        it("takes one picture however often Capture is pressed before the frame is encoded", async () => {
            setMediaDevices(async () => STREAM);
            canvasStub(null);
            const callbacks: BlobCallback[] = [];
            const toBlob = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(((callback: BlobCallback) => callbacks.push(callback)));
            const user = userEvent.setup();
            const onFile = vi.fn();
            render(<ImageEditBadge {...props({ onFile })} />);
            await openCamera(user);
            const video = screen.getByLabelText("Camera preview");
            await waitFor(() => expect((video as HTMLVideoElement).srcObject).toBe(STREAM));
            fireEvent.loadedMetadata(video);
            const capture = screen.getByRole("button", { name: "Capture" });
            fireEvent.click(capture);
            fireEvent.click(capture);
            expect(toBlob).toHaveBeenCalledTimes(1);
            expect(capture).toBeDisabled();

            act(() => callbacks[0](new Blob([new Uint8Array(3)], { type: "image/jpeg" })));
            expect(onFile).toHaveBeenCalledTimes(1);
        });

        it("hands over no picture when the dialog was cancelled or left while the frame was still being encoded", async () => {
            setMediaDevices(async () => STREAM);
            canvasStub(null);
            const callbacks: BlobCallback[] = [];
            vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(((callback: BlobCallback) => callbacks.push(callback)));
            const user = userEvent.setup();
            const onFile = vi.fn();
            const { unmount } = render(<ImageEditBadge {...props({ onFile })} />);
            for (const leave of ["cancel", "unmount"]) {
                await openCamera(user);
                const video = screen.getByLabelText("Camera preview");
                await waitFor(() => expect((video as HTMLVideoElement).srcObject).toBe(STREAM));
                fireEvent.loadedMetadata(video);
                fireEvent.click(screen.getByRole("button", { name: "Capture" }));
                if (leave === "cancel") {
                    await user.click(screen.getByRole("button", { name: "Cancel" }));
                } else {
                    unmount();
                }
            }
            act(() => callbacks.forEach((callback) => callback(new Blob([new Uint8Array(3)], { type: "image/jpeg" }))));
            expect(onFile).not.toHaveBeenCalled();
        });

        it("says so, and keeps the camera, when the frame could not be turned into a picture", async () => {
            setMediaDevices(async () => STREAM);
            canvasStub(null);
            const user = userEvent.setup();
            const onFile = vi.fn();
            const onError = vi.fn();
            render(<ImageEditBadge {...props({ onFile, onError })} />);
            await openCamera(user);
            const video = screen.getByLabelText("Camera preview");
            await waitFor(() => expect((video as HTMLVideoElement).srcObject).toBe(STREAM));
            fireEvent.loadedMetadata(video);
            await user.click(screen.getByRole("button", { name: "Capture" }));
            expect(await screen.findByRole("alert")).toHaveTextContent("The picture could not be captured - try again.");
            expect(onError).toHaveBeenCalledWith("The picture could not be captured - try again.");
            expect(onFile).not.toHaveBeenCalled();
            TRACKS.forEach((track) => expect(track.stop).not.toHaveBeenCalled());
        });
    });
});
