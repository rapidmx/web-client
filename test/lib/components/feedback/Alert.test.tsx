// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Alert from "../../../../lib/components/feedback/Alert.js";

describe("Alert", () => {
    it("renders its children inside an alert role", () => {
        render(<Alert>Something went wrong.</Alert>);
        expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong.");
    });
});
