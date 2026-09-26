///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";

export interface PermanentDeleteDialogProps {
    open: boolean;
    title: string;
    /** The question, ending in what cannot be undone. */
    message: string;
    /** The destructive button's own words ("Delete permanently"). */
    confirmLabel: string;
    /** The delete is on the wire: the dialog stays up, and can be neither confirmed again nor dismissed. */
    busy: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}

/**
 * The confirmation in front of every permanent delete. A `Modal`, so Escape and the Cancel button dismiss it and Tab stays inside it. Focus
 * starts on the dialog itself, never on the destructive button, so pressing Enter (or the Delete key again) on a dialog the reader did not
 * mean to open keeps their mail. It remembers nothing: every permanent delete asks.
 */
export default function PermanentDeleteDialog({ open, title, message, confirmLabel, busy, onConfirm, onCancel }: PermanentDeleteDialogProps) {
    return (
        <Modal open={open} onClose={() => !busy && onCancel()} title={title}>
            <p className="text-sm mb-5">{message}</p>
            <div className="flex gap-3 justify-end mt-5">
                <Button type="button" variant="secondary" className="!w-auto" disabled={busy} onClick={onCancel}>
                    Cancel
                </Button>
                <Button
                    type="button"
                    className="!w-auto !bg-none !bg-danger !border-danger hover:!bg-danger"
                    loading={busy}
                    disabled={busy}
                    onClick={onConfirm}
                >
                    {confirmLabel}
                </Button>
            </div>
        </Modal>
    );
}
