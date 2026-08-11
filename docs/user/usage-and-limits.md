# Usage and limits

T3 Code reports two different kinds of provider activity:

- **Limits** shows how much subscription capacity remains for each supported provider and when its quota windows reset. Open it from the main sidebar or from Settings. Limits come from accounts signed in on the machine running the selected T3 server.
- **Usage** shows tokens processed and estimated API-equivalent cost from local Claude and Codex transcripts. It does not show how much subscription capacity remains.

Provider quota APIs are not equally stable. Codex exposes an official account limits interface. Claude, Cursor, and GitHub Copilot use best-effort provider sources and may temporarily show partial or unavailable data when a provider changes its client or account service.

Credentials remain on the environment host. Only normalized limit cards are sent to connected clients.
