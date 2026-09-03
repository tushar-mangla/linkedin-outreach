# Plan: Fix Project Paths and Environment Setup

## Goal

The goal of this plan is to get the `linkedin-outreach` application into a runnable state by correcting file path discrepancies in `package.json`, setting up the necessary environment variables, and ensuring the database migration script can execute successfully.

## Assumptions

- The user has `npm` (or a compatible package manager) and `node` installed.
- The provided `DATABASE_URL` and `GEMINI_API_KEY` are correct and have the necessary permissions.
- The Neon Postgres database is accessible from the development environment.
- The developer has write permissions to the project directory.

## User Journeys

**Current Journey:**
1. The user clones the repository.
2. The user installs dependencies with `npm install`.
3. The user attempts to run database migrations with `npm run db:migrate`.
4. The command fails with `Error: Cannot find module './migrate.ts'` because the path in `package.json` is incorrect (`api/src/db/migrate.ts`).
5. The user is blocked and cannot run the application.

**Improved Journey:**
1. The user clones the repository.
2. The user's environment is configured by the coding agent, which creates a `.env` file and fixes script paths.
3. The user (or the testing agent) runs `npm run db:migrate`.
4. The command succeeds, applying the database schema to the Neon Postgres database.
5. The user (or the testing agent) runs `npm run api:dev`.
6. The application starts without any path-related errors.

## Acceptance Criteria

1.  A `.env` file must exist in the project root.
2.  The `.env` file must contain the `DATABASE_URL` and `GEMINI_API_KEY` provided by the user.
3.  The `.gitignore` file must contain an entry for `.env`.
4.  The `main` script path in `package.json` must be corrected to point to `dist/index.js`.
5.  The `api:dev` script in `package.json` must be corrected to point to `src/index.ts`.
6.  The `db:migrate` script in `package.json` must be corrected to point to `src/db/migrate.ts`.
7.  Running `npm install` should complete without errors.
8.  Running `npm run db:generate` should complete without path-related errors.
9.  Running `npm run db:migrate` must execute successfully against the provided Neon Postgres database URL.
10. Running `npm run api:dev` must start the application without "Cannot find module" errors.

## Affected Components/Files

- **`package.json`**: The `main` and `scripts` sections will be modified.
- **`.env`**: This file will be created at the project root.
- **`.gitignore`**: This file will be verified to ensure it ignores the `.env` file.

## Frontend/API/Database Contract

No changes are being made to the API or database contracts. This plan focuses solely on correcting the project's configuration and structure to make the existing implementation functional.

## Schema or Migration Approach

The existing migration approach using `drizzle-kit` and `ts-node` will be maintained. The plan ensures that the `db:migrate` script, which executes the migration, is correctly pointed to the migration script (`src/db/migrate.ts`). The `drizzle.config.ts` file is already correctly configured to find the database schema and handle the database connection.

## Implementation Sequence

1.  **Verify `.gitignore`:**
    - Read the `.gitignore` file and confirm that it contains a line for `.env`. (This has been pre-verified and is correct).

2.  **Create `.env` file:**
    - Create a new file named `.env` in the project root.
    - Add the following content to the file, using the credentials provided by the user:
      ```
      DATABASE_URL="postgresql://neondb_owner:npg_wXW41MaGdCsZ@ep-holy-salad-axs3myoo-pooler.c-4.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
      GEMINI_API_KEY="AIzaSyDrv-A7ew1_jjIscHPXT8YUzPxPeuk43vY"
      ```

3.  **Update `package.json`:**
    - Read the `package.json` file.
    - **Modify the `main` entry:** Change `"main": "api/dist/index.js"` to `"main": "dist/index.js"`.
    - **Modify the `scripts` section:**
        - Change `"api:dev": "ts-node-dev --respawn --transpile-only api/src/index.ts"` to `"api:dev": "ts-node-dev --respawn --transpile-only src/index.ts"`.
        - Change `"db:migrate": "ts-node api/src/db/migrate.ts"` to `"db:migrate": "ts-node src/db/migrate.ts"`.
    - Write the updated content back to `package.json`.

## Test Plan

The `coding-tester` will perform the following steps to verify the fix:

1.  **Verify File Creation:**
    - Check that the `.env` file exists at the project root.
    - Read the `.env` file and confirm it contains the correct `DATABASE_URL` and `GEMINI_API_KEY`.

2.  **Verify `package.json` Changes:**
    - Read `package.json` and confirm that the paths for `main`, `api:dev`, and `db:migrate` have been corrected.

3.  **Install Dependencies:**
    - Run `npm install` in the terminal. Verify that it completes successfully.

4.  **Test Database Scripts:**
    - Run `npm run db:generate`. Verify that it completes without path errors.
    - Run `npm run db:migrate`. Verify that the script connects to the database and reports a successful migration (or that no migrations are pending). There should be no "Cannot find module" errors.

5.  **Test Application Startup:**
    - Run `npm run api:dev`.
    - Verify that the script starts without "Cannot find module" errors and that `ts-node-dev` reports that it is running.

## Risks

- **Incorrect Credentials:** If the provided `DATABASE_URL` is incorrect, the `db:migrate` step will fail with an authentication or connection error. This is outside the scope of the code fix, but the test plan will reveal it.
- **Further Logic Errors:** The `api:dev` script points to `src/index.ts`, which currently only exports modules. While this plan will fix the path error, the script may not start a functional server. This is acceptable as the primary goal is to fix the configuration errors. A subsequent task may be needed to implement the server logic.
- **Missing Dependencies:** There's a small risk that fixing the paths might uncover missing dependencies that were not apparent before. The `npm install` and subsequent script runs should identify this.

## Rollback Notes

- Delete the created `.env` file.
- Revert the changes to `package.json` using `git checkout -- package.json`.

## Definition of Done

The task is considered done when all acceptance criteria are met, and the test plan has been executed successfully by the `coding-tester`. Specifically, the project's pathing issues are resolved, environment variables are correctly configured, and the database migration and application startup scripts can be run without "Cannot find module" errors.
