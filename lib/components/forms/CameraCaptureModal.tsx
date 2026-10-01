///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useRef, useState } from "react";
import Button from "../buttons/Button.js";
import Alert from "../feedback/Alert.js";
import Modal from "../overlays/Modal.js";

export interface CameraCaptureModalProps {
    /** Called with the captured picture (a JPEG of the frame on screen); the camera is already released. The caller closes the dialog. */
    onCapture: (file: File) => void;
    onClose: () => void;
    /** Also told why the camera could not be used or the picture not captured (the dialog shows it itself too). */
    onError?: (message: string) => void;
}

export const CAMERA_BLOCKED_MESSAGE = "Camera access was blocked - allow it in your browser's settings, or choose Upload file.";
export const CAMERA_MISSING_MESSAGE = "No camera was found on this device - choose Upload file instead.";
export const CAMERA_FAILED_MESSAGE = "The camera could not be started - choose Upload file instead.";

/** The friendly reason a `getUserMedia()` rejection gives (`NotAllowedError`/`SecurityError`: the user or the page's policy said no; `NotFoundError`/`OverconstrainedError`: no camera). */
function cameraErrorMessage(err: unknown): string {
    const name = (err as { name?: string } | null)?.name;
    if (name === "NotAllowedError" || name === "SecurityError") {
        return CAMERA_BLOCKED_MESSAGE;
    }
    if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") {
        return CAMERA_MISSING_MESSAGE;
    }
    return CAMERA_FAILED_MESSAGE;
}

/**
 * A dialog with the live picture of the device's camera (the front one where there is a choice) and a Capture button, for a computer with a webcam - a phone's own
 * camera is reached through a file input's `capture` attribute instead. Asking for the camera is what makes the browser prompt for permission; every track is
 * stopped again when the dialog goes away (captured, cancelled, or the page left), which is what turns the camera's light off.
 */
export default function CameraCaptureModal({ onCapture, onClose, onError }: CameraCaptureModalProps) {
    const video = useRef<HTMLVideoElement>(null);
    const stream = useRef<MediaStream | null>(null);
    const [ready, setReady] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // From pressing Capture until the frame is encoded: a second press then would hand the caller a second picture.
    const [capturing, setCapturing] = useState(false);

    function fail(message: string) {
        setError(message);
        onError?.(message);
    }

    function stop() {
        stream.current?.getTracks().forEach((track) => track.stop());
        stream.current = null;
    }

    useEffect(() => {
        let cancelled = false;
        navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 1280 } } }).then(
            (media) => {
                if (cancelled) {
                    media.getTracks().forEach((track) => track.stop());
                    return;
                }
                stream.current = media;
                video.current!.srcObject = media;
            },
            (err) => !cancelled && fail(cameraErrorMessage(err)),
        );
        return () => {
            cancelled = true;
            stop();
        };
    }, []);

    function capture() {
        setCapturing(true);
        const element = video.current!;
        const canvas = document.createElement("canvas");
        canvas.width = element.videoWidth;
        canvas.height = element.videoHeight;
        canvas.getContext("2d")!.drawImage(element, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
            (blob) => {
                if (!blob) {
                    setCapturing(false);
                    fail("The picture could not be captured - try again.");
                    return;
                }
                stop();
                onCapture(new File([blob], "photo.jpg", { type: "image/jpeg" }));
            },
            "image/jpeg",
            0.92,
        );
    }

    return (
        <Modal open onClose={onClose} title="Take photo">
            {error && <Alert>{error}</Alert>}
            {/* Mirrored like a mirror, which is what looking at yourself expects; the picture that is kept is not. */}
            <video
                ref={video}
                autoPlay
                playsInline
                muted
                aria-label="Camera preview"
                onLoadedMetadata={() => setReady(true)}
                className={`w-full aspect-square object-cover rounded-sm bg-black -scale-x-100 ${error ? "hidden" : ""}`}
            />
            <div className="mt-5 flex justify-end gap-2">
                <Button type="button" variant="secondary" className="!w-auto" onClick={onClose}>
                    Cancel
                </Button>
                <Button type="button" className="!w-auto" disabled={!ready || !!error || capturing} onClick={capture}>
                    Capture
                </Button>
            </div>
        </Modal>
    );
}
