import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
    plugins: [react()],
    // Forces every resolution of react/react-dom to the same physical module instance - this package's
    // own portal-linked @rapidmx/react-shared has its own independent devDependency copy of React
    // (needed to run its own tests standalone), which would otherwise resolve as a second instance and
    // break every hook it exports with "Invalid hook call" - see rapidmx/server's identical fix (and
    // its own .claude/NOTES.md entry) for the full incident this is preempting.
    resolve: {
        dedupe: ["react", "react-dom"],
    },
    test: {
        globals: true,
        // Every page/component test needs a DOM - unlike react-shared (mostly plain fetch/logic), this
        // package is UI-only, so jsdom is the project-wide default here rather than an opt-in per file.
        environment: "jsdom",
        setupFiles: ["./test/apps/setup.ts"],
        include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
        // Pins the test process's local timezone to UTC - the calendar views (MonthView/TimeGridView)
        // use date-fns's local-time-aware functions, so a UTC ISO fixture and the components' own
        // local-time calculations only agree everywhere the suite runs if both sides pin the same zone.
        // Carried over verbatim from rapidmx/server's own vitest.config.ts, which hit this for real.
        env: { TZ: "UTC" },
        fileParallelism: false,
        pool: "forks",
        clearMocks: true,
        coverage: {
            enabled: true,
            provider: "v8",
            include: ["apps/**/*.ts", "apps/**/*.tsx"],
            exclude: ["**/node_modules/**", "**/test/**"],
            reporter: ["text", "json", "html", "lcov"],
            thresholds: {
                // This package is fully unit-tested and held to 100% - fails the build if new code lands
                // without matching tests. Carried over from rapidmx/server's own vitest.config.ts, which
                // enforced this on the same code before the 2026-09-10 extraction (see .claude/NOTES.md).
                'apps/**': {
                    // Branches held at 99%, not 100%, as a deliberate one-off: `ComposeWindow.tsx` has a
                    // single branch (`e.target.files ?? []`) that's genuinely exercised on both sides -
                    // confirmed via repeated isolated/small-group/single-threaded re-runs - but that
                    // `@vitest/coverage-v8`'s branch derivation reproducibly fails to attribute correctly
                    // only at full-suite scale (statements/lines/functions all stay 100% regardless). See
                    // rapidmx/server's `.claude/NOTES.md`'s 2026-09-07 "Floating Compose window" entry for
                    // the full investigation. Revisit if this ever creeps further - it should stay pinned
                    // to this one known branch, not a general excuse to skip writing branch-coverage tests.
                    branches: 99,
                    functions: 100,
                    lines: 100,
                    statements: 100,
                },
            },
            reportsDirectory: "coverage",
        },
        reporters: ["default", "junit"],
        outputFile: {
            junit: "junit.xml",
        },
    },
});
