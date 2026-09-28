// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import FormField from "../../../../lib/components/forms/FormField.js";

describe("FormField", () => {
    it("renders a label associated with the given htmlFor, and its children", () => {
        render(
            <FormField label="Company name" htmlFor="company-name">
                <input id="company-name" />
            </FormField>,
        );

        const input = screen.getByLabelText("Company name");
        expect(input).toBeInTheDocument();
        expect(input.tagName).toBe("INPUT");
    });
});
