import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Build output (dist/) contains compiled copies of the test files; .entropy/ holds payload bundles;
    // .claude/ holds agent worktrees (full repo copies).
    exclude: [...configDefaults.exclude, '**/dist/**', '.entropy/**', '.claude/**']
  }
});
