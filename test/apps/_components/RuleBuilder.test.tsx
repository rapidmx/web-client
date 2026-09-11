// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import RuleBuilder, {
    ActionTypeDef,
    ConditionFieldDef,
    RuleBuilderValue,
} from "../../../apps/shared/components/rules/RuleBuilder.js";

interface TestConditions {
    fromContains?: string[];
    hasAttachment?: boolean;
    importance?: string;
}

interface TestAction {
    type: "reject" | "add_header";
    headerName?: string;
}

const CONDITION_FIELDS: ConditionFieldDef[] = [
    { key: "fromContains", label: "From contains", kind: "list" },
    { key: "hasAttachment", label: "Has an attachment", kind: "boolean" },
    {
        key: "importance",
        label: "Importance",
        kind: "select",
        options: [
            { value: "low", label: "Low" },
            { value: "high", label: "High" },
        ],
    },
];

const ACTION_TYPES: ActionTypeDef<TestAction>[] = [
    { value: "reject", label: "Reject", createDefault: () => ({ type: "reject" }), render: () => null },
    {
        value: "add_header",
        label: "Add header",
        createDefault: () => ({ type: "add_header", headerName: "" }),
        render: (action, onChange) => (
            <input
                aria-label="Header name"
                value={action.headerName ?? ""}
                onChange={(e) => onChange({ ...action, headerName: e.target.value })}
            />
        ),
    },
];

const EMPTY_VALUE: RuleBuilderValue<TestConditions, TestAction> = {
    enabled: true,
    sequence: 0,
    stopProcessingRules: false,
    conditions: {},
    actions: [],
};

/** Wraps `RuleBuilder` as a real controlled component (owning its own state) so interaction tests can
 * assert on re-rendered output, not just the last `onChange` call in isolation. */
function ControlledRuleBuilder({
    initial = EMPTY_VALUE,
    onChangeSpy,
    actionTypes = ACTION_TYPES,
}: {
    initial?: typeof EMPTY_VALUE;
    onChangeSpy?: (v: typeof EMPTY_VALUE) => void;
    actionTypes?: ActionTypeDef<TestAction>[];
}) {
    const [value, setValue] = useState(initial);
    return (
        <RuleBuilder
            value={value}
            onChange={(next) => {
                setValue(next);
                onChangeSpy?.(next);
            }}
            conditionFields={CONDITION_FIELDS}
            actionTypes={actionTypes}
        />
    );
}

describe("RuleBuilder", () => {
    it("renders every condition field by kind", () => {
        render(<ControlledRuleBuilder />);
        expect(screen.getByLabelText("From contains")).toBeInTheDocument();
        expect(screen.getByRole("checkbox", { name: "Has an attachment" })).toBeInTheDocument();
    });

    it("adds a list-condition entry via the Add button and renders it as a removable chip", async () => {
        const user = userEvent.setup();
        render(<ControlledRuleBuilder />);

        await user.type(screen.getByLabelText("From contains"), "spam.example.com");
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(screen.getByText("spam.example.com")).toBeInTheDocument();
        expect(screen.getByLabelText("From contains")).toHaveValue("");
    });

    it("adds a list-condition entry via Enter", async () => {
        const user = userEvent.setup();
        render(<ControlledRuleBuilder />);

        await user.type(screen.getByLabelText("From contains"), "spam.example.com{Enter}");

        expect(screen.getByText("spam.example.com")).toBeInTheDocument();
    });

    it("does not add a blank or duplicate entry", async () => {
        const user = userEvent.setup();
        render(<ControlledRuleBuilder />);

        await user.click(screen.getByRole("button", { name: "Add" }));
        expect(screen.queryByText("spam.example.com")).not.toBeInTheDocument();

        await user.type(screen.getByLabelText("From contains"), "spam.example.com{Enter}");
        await user.type(screen.getByLabelText("From contains"), "spam.example.com{Enter}");
        expect(screen.getAllByText("spam.example.com")).toHaveLength(1);
    });

    it("removes a list-condition entry", async () => {
        const user = userEvent.setup();
        render(<ControlledRuleBuilder />);

        await user.type(screen.getByLabelText("From contains"), "spam.example.com{Enter}");
        await user.click(screen.getByRole("button", { name: "Remove spam.example.com" }));

        expect(screen.queryByText("spam.example.com")).not.toBeInTheDocument();
    });

    it("renders a select condition field defaulting to 'Any', with its options", () => {
        render(<ControlledRuleBuilder />);
        const select = screen.getByLabelText("Importance");
        expect(select).toHaveValue("");
        expect(screen.getByRole("option", { name: "Any" })).toBeInTheDocument();
        expect(screen.getByRole("option", { name: "Low" })).toBeInTheDocument();
        expect(screen.getByRole("option", { name: "High" })).toBeInTheDocument();
    });

    it("renders just the 'Any' option, without crashing, when a select field's own options are omitted", () => {
        // `options` is typed optional (only "required" by doc comment, for "select" fields) so a caller
        // could still omit it by mistake — this proves that mistake degrades gracefully instead of
        // throwing on `field.options.map(...)`.
        render(
            <RuleBuilder
                value={EMPTY_VALUE}
                onChange={vi.fn()}
                conditionFields={[{ key: "importance", label: "Importance", kind: "select" }]}
                actionTypes={ACTION_TYPES}
            />,
        );
        expect(within(screen.getByLabelText("Importance")).getAllByRole("option")).toHaveLength(1);
    });

    it("sets a select condition's value, and clears it back to undefined via 'Any'", async () => {
        const onChangeSpy = vi.fn();
        const user = userEvent.setup();
        render(<ControlledRuleBuilder onChangeSpy={onChangeSpy} />);

        await user.selectOptions(screen.getByLabelText("Importance"), "high");
        expect(screen.getByLabelText("Importance")).toHaveValue("high");
        expect(onChangeSpy).toHaveBeenLastCalledWith(expect.objectContaining({ conditions: { importance: "high" } }));

        await user.selectOptions(screen.getByLabelText("Importance"), "");
        expect(screen.getByLabelText("Importance")).toHaveValue("");
        expect(onChangeSpy).toHaveBeenLastCalledWith(expect.objectContaining({ conditions: { importance: undefined } }));
    });

    it("toggles a boolean condition", async () => {
        const user = userEvent.setup();
        render(<ControlledRuleBuilder />);

        const checkbox = screen.getByRole("checkbox", { name: "Has an attachment" });
        expect(checkbox).not.toBeChecked();
        await user.click(checkbox);
        expect(checkbox).toBeChecked();
        await user.click(checkbox);
        expect(checkbox).not.toBeChecked();
    });

    it("shows an empty-state message when there are no actions yet", () => {
        render(<ControlledRuleBuilder />);
        expect(screen.getByText("No actions yet.")).toBeInTheDocument();
    });

    it("adds an action of the selected type and removes it", async () => {
        const user = userEvent.setup();
        render(<ControlledRuleBuilder />);

        await user.selectOptions(screen.getByLabelText("New action type"), "add_header");
        await user.click(screen.getByRole("button", { name: "Add action" }));

        // "Add header" also names the <select>'s own <option>, still present (if hidden) in the DOM.
        expect(screen.getByText("Add header", { selector: "span" })).toBeInTheDocument();
        expect(screen.getByLabelText("Header name")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Remove" }));
        expect(screen.getByText("No actions yet.")).toBeInTheDocument();
    });

    it("adds the first registered action type by default", async () => {
        const user = userEvent.setup();
        render(<ControlledRuleBuilder />);

        await user.click(screen.getByRole("button", { name: "Add action" }));
        expect(screen.getByText("Reject", { selector: "span" })).toBeInTheDocument();
    });

    it("edits an action's own type-specific fields via its render() callback", async () => {
        const user = userEvent.setup();
        render(<ControlledRuleBuilder />);

        await user.selectOptions(screen.getByLabelText("New action type"), "add_header");
        await user.click(screen.getByRole("button", { name: "Add action" }));
        await user.type(screen.getByLabelText("Header name"), "X-Flag");

        expect(screen.getByLabelText("Header name")).toHaveValue("X-Flag");
    });

    it("updates only the targeted action when multiple actions are present", async () => {
        const user = userEvent.setup();
        render(<ControlledRuleBuilder />);

        await user.selectOptions(screen.getByLabelText("New action type"), "add_header");
        await user.click(screen.getByRole("button", { name: "Add action" }));
        await user.click(screen.getByRole("button", { name: "Add action" }));

        const headerInputs = screen.getAllByLabelText("Header name");
        expect(headerInputs).toHaveLength(2);
        await user.type(headerInputs[1], "Second");

        expect(headerInputs[0]).toHaveValue("");
        expect(headerInputs[1]).toHaveValue("Second");
    });

    it("falls back to the raw action type as a label when no matching action-type def is found", () => {
        render(
            <ControlledRuleBuilder
                initial={{ ...EMPTY_VALUE, actions: [{ type: "unknown_type" as TestAction["type"] }] }}
            />,
        );
        expect(screen.getByText("unknown_type")).toBeInTheDocument();
    });

    it("does nothing when 'Add action' is clicked with no registered action types to choose from", async () => {
        const onChangeSpy = vi.fn();
        const user = userEvent.setup();
        render(<ControlledRuleBuilder actionTypes={[]} onChangeSpy={onChangeSpy} />);

        await user.click(screen.getByRole("button", { name: "Add action" }));

        expect(onChangeSpy).not.toHaveBeenCalled();
        expect(screen.getByText("No actions yet.")).toBeInTheDocument();
    });

    it("toggles Enabled and Stop processing more rules, and edits Sequence", async () => {
        const user = userEvent.setup();
        render(<ControlledRuleBuilder />);

        const enabled = screen.getByRole("checkbox", { name: "Enabled" });
        expect(enabled).toBeChecked();
        await user.click(enabled);
        expect(enabled).not.toBeChecked();

        const stop = screen.getByRole("checkbox", { name: "Stop processing more rules once this one matches" });
        await user.click(stop);
        expect(stop).toBeChecked();

        const sequence = screen.getByRole("spinbutton");
        await user.clear(sequence);
        await user.type(sequence, "5");
        expect(sequence).toHaveValue(5);
    });

    it("calls onChange with the full updated value on every edit", async () => {
        const onChangeSpy = vi.fn();
        const user = userEvent.setup();
        render(<ControlledRuleBuilder onChangeSpy={onChangeSpy} />);

        await user.click(screen.getByRole("checkbox", { name: "Enabled" }));
        expect(onChangeSpy).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    });
});
