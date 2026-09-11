///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode, useState } from "react";
import Button from "../buttons/Button.js";

const INPUT_CLASS =
    "flex-1 text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

/** One condition field this scope's `Conditions` shape supports — `"list"` renders an add/remove chip
 * editor for a `string[]` field, `"boolean"` a plain checkbox, `"select"` a fixed-choice dropdown for a
 * field with a small closed set of string values (e.g. `MailFilterConditions.importance`). */
export interface ConditionFieldDef {
    key: string;
    label: string;
    kind: "list" | "boolean" | "select";
    placeholder?: string;
    /** Required when `kind` is `"select"` — the fixed set of values this field may hold, plus an
     * implicit "Any" option that clears the field entirely. */
    options?: { value: string; label: string }[];
}

/** One action type this scope's `Action` union supports — the per-scope registry the shared condition
 * editor/chrome below is deliberately kept out of (transport-rule and mail-filter actions are
 * different enough vocabularies that one component special-casing both would be worse than this). */
export interface ActionTypeDef<A> {
    value: string;
    label: string;
    /** Builds a fresh default action of this type when picked from "Add action". */
    createDefault: () => A;
    /** Renders this action's own type-specific fields (e.g. header name/value). `null` for an action
     * type with nothing further to configure. */
    render: (action: A, onChange: (next: A) => void) => ReactNode;
}

export interface RuleBuilderValue<C extends object, A extends { type: string }> {
    enabled: boolean;
    sequence: number;
    stopProcessingRules: boolean;
    conditions: C;
    actions: A[];
}

export interface RuleBuilderProps<C extends object, A extends { type: string }> {
    value: RuleBuilderValue<C, A>;
    onChange: (next: RuleBuilderValue<C, A>) => void;
    conditionFields: ConditionFieldDef[];
    actionTypes: ActionTypeDef<A>[];
}

/**
 * Shared condition-row editor and enabled/sequence/stop-processing chrome for a rule that matches
 * conditions and runs actions in order — `TransportRule` (admin, org-wide) and `MailFilterRule`
 * (mailbox-scoped) both have this same `{enabled, sequence, stopProcessingRules, conditions, actions}`
 * shape. Conditions are driven by a declarative `conditionFields` list so both scopes share this one
 * editor despite their `Conditions` types not being identical — `MailFilterConditions.importance`
 * (`MailFilterRule`'s one condition field `TransportRuleConditions` has no equivalent of) is what forced
 * this list beyond `"list"`/`"boolean"` to add a third `"select"` kind for a small fixed-choice field,
 * confirming the shared editor still generalizes rather than needing a fork; actions are driven by a
 * small per-scope `actionTypes` registry instead, since the two action vocabularies (reject/quarantine/
 * add-header/add-recipient vs. move/copy/delete/mark-read/forward) are different enough that one
 * component special-casing both would be worse than this split.
 */
export default function RuleBuilder<C extends object, A extends { type: string }>({
    value,
    onChange,
    conditionFields,
    actionTypes,
}: RuleBuilderProps<C, A>) {
    const [draftText, setDraftText] = useState<Record<string, string>>({});
    const [newActionType, setNewActionType] = useState(actionTypes[0]?.value ?? "");
    const conditions = value.conditions as Record<string, unknown>;

    function patch(next: Partial<RuleBuilderValue<C, A>>) {
        onChange({ ...value, ...next });
    }

    function addListEntry(key: string) {
        const text = (draftText[key] ?? "").trim();
        if (!text) return;
        const existing = (conditions[key] as string[] | undefined) ?? [];
        if (existing.includes(text)) return;
        patch({ conditions: { ...conditions, [key]: [...existing, text] } as C });
        setDraftText({ ...draftText, [key]: "" });
    }

    function removeListEntry(key: string, entry: string) {
        const existing = (conditions[key] as string[] | undefined) ?? [];
        patch({ conditions: { ...conditions, [key]: existing.filter((e) => e !== entry) } as C });
    }

    function toggleBoolean(key: string) {
        patch({ conditions: { ...conditions, [key]: !conditions[key] } as C });
    }

    function setSelect(key: string, value: string) {
        patch({ conditions: { ...conditions, [key]: value || undefined } as C });
    }

    function addAction() {
        const def = actionTypes.find((t) => t.value === newActionType);
        if (!def) return;
        patch({ actions: [...value.actions, def.createDefault()] });
    }

    function updateAction(index: number, next: A) {
        patch({ actions: value.actions.map((a, i) => (i === index ? next : a)) });
    }

    function removeAction(index: number) {
        patch({ actions: value.actions.filter((_, i) => i !== index) });
    }

    return (
        <div className="flex flex-col gap-5">
            <div className="bg-surface border border-border rounded-md p-6">
                <h2 className="text-base font-bold uppercase tracking-wide mb-4">Conditions</h2>
                <div className="flex flex-col gap-4">
                    {conditionFields.map((field) => {
                        if (field.kind === "boolean") {
                            return (
                                <label key={field.key} className="flex items-center gap-2 text-sm">
                                    <input
                                        type="checkbox"
                                        checked={!!conditions[field.key]}
                                        onChange={() => toggleBoolean(field.key)}
                                    />
                                    {field.label}
                                </label>
                            );
                        }
                        if (field.kind === "select") {
                            return (
                                <div key={field.key}>
                                    <label className="text-sm font-semibold mb-1.5 block" htmlFor={`condition-${field.key}`}>
                                        {field.label}
                                    </label>
                                    <select
                                        id={`condition-${field.key}`}
                                        className={INPUT_CLASS}
                                        value={(conditions[field.key] as string | undefined) ?? ""}
                                        onChange={(e) => setSelect(field.key, e.target.value)}
                                    >
                                        <option value="">Any</option>
                                        {(field.options ?? []).map((opt) => (
                                            <option key={opt.value} value={opt.value}>
                                                {opt.label}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            );
                        }
                        return (
                            <div key={field.key}>
                                <div className="text-sm font-semibold mb-1.5">{field.label}</div>
                                <div className="flex flex-wrap gap-2 mb-2">
                                    {((conditions[field.key] as string[] | undefined) ?? []).map((entry) => (
                                        <span
                                            key={entry}
                                            className="inline-flex items-center gap-1.5 text-xs py-1 px-2.5 rounded-pill bg-surface-alt"
                                        >
                                            {entry}
                                            <button
                                                type="button"
                                                aria-label={`Remove ${entry}`}
                                                onClick={() => removeListEntry(field.key, entry)}
                                                className="text-text-muted hover:text-danger"
                                            >
                                                &times;
                                            </button>
                                        </span>
                                    ))}
                                </div>
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        aria-label={field.label}
                                        className={INPUT_CLASS}
                                        placeholder={field.placeholder ?? "Add a value"}
                                        value={draftText[field.key] ?? ""}
                                        onChange={(e) => setDraftText({ ...draftText, [field.key]: e.target.value })}
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") {
                                                e.preventDefault();
                                                addListEntry(field.key);
                                            }
                                        }}
                                    />
                                    <Button
                                        type="button"
                                        variant="secondary"
                                        className="!w-auto"
                                        onClick={() => addListEntry(field.key)}
                                    >
                                        Add
                                    </Button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            <div className="bg-surface border border-border rounded-md p-6">
                <h2 className="text-base font-bold uppercase tracking-wide mb-4">Actions</h2>
                <div className="flex flex-col gap-3 mb-4">
                    {value.actions.length === 0 && <p className="text-sm text-text-muted">No actions yet.</p>}
                    {value.actions.map((action, index) => {
                        const def = actionTypes.find((t) => t.value === action.type);
                        return (
                            <div key={index} className="border border-border rounded-sm p-3">
                                <div className="flex items-center justify-between mb-2">
                                    <span className="text-sm font-semibold">{def?.label ?? action.type}</span>
                                    <button
                                        type="button"
                                        onClick={() => removeAction(index)}
                                        className="text-sm text-danger hover:underline"
                                    >
                                        Remove
                                    </button>
                                </div>
                                {def?.render(action, (next) => updateAction(index, next))}
                            </div>
                        );
                    })}
                </div>
                <div className="flex gap-2">
                    <select
                        aria-label="New action type"
                        className={INPUT_CLASS}
                        value={newActionType}
                        onChange={(e) => setNewActionType(e.target.value)}
                    >
                        {actionTypes.map((t) => (
                            <option key={t.value} value={t.value}>
                                {t.label}
                            </option>
                        ))}
                    </select>
                    <Button type="button" variant="secondary" className="!w-auto" onClick={addAction}>
                        Add action
                    </Button>
                </div>
            </div>

            <div className="bg-surface border border-border rounded-md p-6">
                <h2 className="text-base font-bold uppercase tracking-wide mb-4">Settings</h2>
                <div className="flex flex-col gap-3">
                    <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={value.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
                        Enabled
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                        <input
                            type="checkbox"
                            checked={value.stopProcessingRules}
                            onChange={(e) => patch({ stopProcessingRules: e.target.checked })}
                        />
                        Stop processing more rules once this one matches
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                        Sequence (evaluation order, ascending)
                        <input
                            type="number"
                            className="w-20 text-sm py-1.5 px-2 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary"
                            value={value.sequence}
                            onChange={(e) => patch({ sequence: Number(e.target.value) })}
                        />
                    </label>
                </div>
            </div>
        </div>
    );
}
