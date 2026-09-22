///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { routedPage } from "../../_routedPage.js";
import React from "react";
import SettingsShell, { SettingsShellProps } from "../../../shared/components/settings/layout/SettingsShell.js";
import AppearanceForm from "../../../shared/appearance/AppearanceForm.js";

export type SettingsAppearancePageProps = Omit<SettingsShellProps, "active">;

/** Settings > Appearance: the colour scheme, theme colours and background. Not mailbox-scoped - it is the signed-in user's own. */
function SettingsAppearancePage(props: SettingsAppearancePageProps) {
    return (
        <SettingsShell {...props} active="appearance">
            <AppearanceForm />
        </SettingsShell>
    );
}

export default routedPage("/settings/appearance", SettingsAppearancePage);
