///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `MenuButton` lives in `lib/components/menus` so shared form components (`ImageEditBadge`) can use it; this keeps the mail components' import path working.
export { default, menuHeight } from "../../../../lib/components/menus/MenuButton.js";
export type { MenuCommandSpec, MenuSubmenuSpec, MenuItemSpec, MenuSectionSpec, MenuButtonProps } from "../../../../lib/components/menus/MenuButton.js";
