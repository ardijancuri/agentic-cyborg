# Node + React + PostgreSQL Assistant Addon Template

Copy `src/assistant` into the host backend and adjust the SQL table names inside `toolRegistry.js`.

Copy `src/frontend` into the host frontend or adapt it to the app's existing API/client layout.

Required host decisions:

- Which roles can use the assistant. V1 default: `admin`, `full_admin`.
- Which database tables each read-only tool can query.
- Which frontend routes belong in `pageRegistry.js`.
- Which existing audit logger should receive assistant events.

Do not expose a generic SQL tool. Add one bounded, parameterized read-only tool per business question area.
