///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { routedPage } from "../../_routedPage.js";
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { Label, createLabel, deleteLabel, listLabels, updateLabel } from "@rapidmx/react-shared/mail/labelsApi.js";
import SettingsShell, { SettingsShellProps, useSettingsShell } from "../../../shared/components/settings/layout/SettingsShell.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import FormField from "@rapidmx/react-shared/components/forms/FormField.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";

export type SettingsLabelsPageProps = Omit<SettingsShellProps, "active">;

function SettingsLabelsPage(props: SettingsLabelsPageProps) {
    return (
        <SettingsShell {...props} active="labels">
            <LabelsContent />
        </SettingsShell>
    );
}

const DEFAULT_COLOR = "#6366f1";

function LabelsContent() {
    const { mailboxUid } = useSettingsShell();
    const [labels, setLabels] = useState<Label[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // `editing === null` means the create form; otherwise the label currently being renamed/recolored.
    const [editing, setEditing] = useState<Label | null>(null);
    const [formOpen, setFormOpen] = useState(false);
    const [formName, setFormName] = useState("");
    const [formColor, setFormColor] = useState(DEFAULT_COLOR);
    const [formError, setFormError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    const [deleting, setDeleting] = useState<Label | null>(null);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const [deleteBusy, setDeleteBusy] = useState(false);

    // `SettingsShell` only ever renders its children once `mailboxUid` has resolved — same established
    // non-null pattern as `apps/www/settings/auto-reply/index.tsx`.
    useEffect(() => {
        listLabels(mailboxUid!)
            .then(setLabels)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load labels."))
            .finally(() => setLoading(false));
    }, [mailboxUid]);

    function openCreateForm() {
        setEditing(null);
        setFormName("");
        setFormColor(DEFAULT_COLOR);
        setFormError(null);
        setFormOpen(true);
    }

    function openEditForm(label: Label) {
        setEditing(label);
        setFormName(label.name);
        setFormColor(label.color ?? DEFAULT_COLOR);
        setFormError(null);
        setFormOpen(true);
    }

    async function handleSave() {
        setSaving(true);
        setFormError(null);
        try {
            if (editing) {
                const updated = await updateLabel({ uid: editing.uid, version: editing.version, name: formName, color: formColor });
                setLabels((prev) => prev.map((l) => (l.uid === updated.uid ? updated : l)));
            } else {
                const created = await createLabel({ mailboxUid: mailboxUid!, name: formName, color: formColor });
                setLabels((prev) => [...prev, created]);
            }
            setFormOpen(false);
        } catch (err) {
            setFormError(err instanceof ApiRequestError ? err.message : "Could not save this label.");
        } finally {
            setSaving(false);
        }
    }

    async function handleDelete() {
        setDeleteBusy(true);
        setDeleteError(null);
        try {
            await deleteLabel(deleting!.uid, deleting!.version);
            setLabels((prev) => prev.filter((l) => l.uid !== deleting!.uid));
            setDeleting(null);
        } catch (err) {
            setDeleteError(err instanceof ApiRequestError ? err.message : "Could not delete this label.");
        } finally {
            setDeleteBusy(false);
        }
    }

    return (
        <div className="flex-1 min-w-0 overflow-y-auto p-6">
            <div className="max-w-3xl">
                <div className="flex items-center justify-between mb-5">
                    <h1 className="text-lg font-bold tracking-tight">Labels</h1>
                    <Button type="button" className="!w-auto" onClick={openCreateForm}>
                        + New label
                    </Button>
                </div>

                {error && <Alert>{error}</Alert>}

                {loading ? (
                    <p className="text-sm text-text-muted">Loading&hellip;</p>
                ) : labels.length === 0 ? (
                    <p className="text-sm text-text-muted">No labels yet.</p>
                ) : (
                    <ul className="flex flex-col gap-2">
                        {labels.map((label) => (
                            <li key={label.uid} className="flex items-center justify-between border border-border rounded-md p-3">
                                <div className="flex items-center gap-2">
                                    <span
                                        className="w-3 h-3 rounded-full shrink-0"
                                        style={{ backgroundColor: label.color ?? DEFAULT_COLOR }}
                                        aria-hidden="true"
                                    />
                                    <span className="text-sm font-semibold">{label.name}</span>
                                </div>
                                <div className="flex items-center gap-3">
                                    <button
                                        type="button"
                                        className="text-primary-dark hover:underline font-medium text-sm"
                                        onClick={() => openEditForm(label)}
                                    >
                                        Edit
                                    </button>
                                    <button
                                        type="button"
                                        className="text-danger hover:underline font-medium text-sm"
                                        onClick={() => {
                                            setDeleting(label);
                                            setDeleteError(null);
                                        }}
                                    >
                                        Delete
                                    </button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <Modal open={formOpen} onClose={() => setFormOpen(false)} title={editing ? "Edit label" : "New label"}>
                {formError && <Alert>{formError}</Alert>}
                <FormField label="Name" htmlFor="label-name">
                    <input
                        id="label-name"
                        type="text"
                        value={formName}
                        onChange={(e) => setFormName(e.target.value)}
                        className="w-full text-sm px-3 py-1.5 rounded-md border border-border bg-surface"
                    />
                </FormField>
                <FormField label="Color" htmlFor="label-color">
                    <input
                        id="label-color"
                        type="color"
                        value={formColor}
                        onChange={(e) => setFormColor(e.target.value)}
                        className="h-9 w-16 rounded-md border border-border bg-surface"
                    />
                </FormField>
                <div className="flex justify-end gap-2 mt-2">
                    <Button type="button" variant="secondary" className="!w-auto" onClick={() => setFormOpen(false)}>
                        Cancel
                    </Button>
                    <Button type="button" className="!w-auto" loading={saving} disabled={saving || !formName.trim()} onClick={handleSave}>
                        Save
                    </Button>
                </div>
            </Modal>

            <Modal open={!!deleting} onClose={() => setDeleting(null)} title="Delete this label?">
                {deleteError && <Alert>{deleteError}</Alert>}
                <p className="text-sm text-text-muted mb-4">
                    This removes &ldquo;{deleting?.name}&rdquo; from every message it's applied to. This can't be undone.
                </p>
                <div className="flex justify-end gap-2">
                    <Button type="button" variant="secondary" className="!w-auto" onClick={() => setDeleting(null)}>
                        Cancel
                    </Button>
                    <Button type="button" className="!w-auto" loading={deleteBusy} disabled={deleteBusy} onClick={handleDelete}>
                        Delete label
                    </Button>
                </div>
            </Modal>
        </div>
    );
}

export default routedPage("/settings/labels", SettingsLabelsPage);
