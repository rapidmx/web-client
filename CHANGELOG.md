# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-09-11

### Added
- Added the webmail and admin console React UI extracted verbatim from rapidmx/server
- Added a package.json exports map so apps/book (staying in rapidmx/server) can still reach the handful of
- Added a Tailwind @source for react-shared's own source so its component classnames get scanned
- Added missing scaffold files

### Changed
- apps/www, apps/admin, and apps/shared/components (including apps/shared/styles/app.css, the Tailwind
- entry point and design tokens), moved as one unit rather than split - AppShell (the chrome every page
- wraps in) transitively pulls in most of the component tree including compose/tiptap, so a partial move
- wasn't realistic.
- primitives it needs - Alert, Button, BrandingChrome - as a package import instead of a relative path.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Copy apps/shared/styles/app.css into dist/apps on build, alongside the compiled JS
- tsc never copies non-TS assets into outDir, so AppShell.tsx's own `import "../../styles/app.css"`
- resolved fine when consumed from raw TSX source (rapidmx/server's own Vite build bundles this way) but
- broke when consumed via this package's compiled dist (electron-client's Vite build does, since it goes
- through the package's exports map) - dist/apps/shared/styles/app.css simply didn't exist. dist/ should
- be a self-consistent mirror of apps/ on its own merits, not something each consumer works around.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Update every import of react-shared modules to their new nested paths
- Update every import of the 8 moved components to @rapidmx/react-shared/components/*
- Update NOTES.md
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Update NOTES.md with the root cause: server builds one Rollup entry per page, so Tailwind's automatic per-chunk content detection only ever covered whichever one chunk app.css got attached to
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Updated react-shared dependency

### Fixed
- Fixed an incomplete Tailwind build in server by adding an explicit @source for this package's own apps/** tree

### Removed
- Removed Button, Alert, Skeleton, FormField, PopoverPortal, ContactAvatar, MiniDatePicker, and BottomTabBar, now provided by @rapidmx/react-shared

[Unreleased]: https://github.com/rapidmx/web-client/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/rapidmx/web-client/releases/tag/v0.2.0
