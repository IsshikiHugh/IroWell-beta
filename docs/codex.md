# Codex in IroWell

Choose **Codex** in a new conversation before sending its first message. The engine stays fixed after creation. The last engine choice is remembered for that host and project. Claude and Codex conversations can run together.

## Runtime and native environment

Open **Codex account → Install on this host** once. IroWell installs exactly `@openai/codex@0.164.0` under:

```
$IRO_DIR/runtimes/codex-0.164.0-<platform>-<arch>/
```

`IRO_DIR` defaults to `~/.iro-coding`. Installation runs on the execution host, including over SSH; it does not copy a local binary to a different platform or replace a global Codex installation. Claude is optional and can be absent.

The daemon inherits the execution host's `CODEX_HOME` (default `~/.codex`). Codex reads its own authentication, config, project instructions, Skills and MCP configuration. Start the daemon with the desired environment; restarting just the browser does not change an existing daemon's environment. IroWell stores display metadata and unsent messages separately under `$IRO_DIR/codex/<home-hash>/`, and never edits Codex databases or transcripts.

Model and effort choices come from the runtime. **Execute / Plan** and **Permissions** are separate controls. Unavailable permission profiles are disabled. Session changes apply to the next turn. The effective initial permission profile appears beside the native option. The only lifecycle override is `thread_unload_delay_secs = 0`, so an unsubscribed, idle conversation can be handed over without waiting for Codex's normal unload delay. IroWell adds a short file-link formatting instruction while preserving configured developer instructions.

Codex shares Claude’s model/effort panel, dropdowns, tool cards and diff renderer. Permissions distinguish **Auto · workspace** (automatic work inside the workspace, manual approval outside), **Auto-review · Approve for me** (Codex reviews escalation requests while keeping the workspace sandbox), and **Full access** (no sandbox or approval prompts). Auto-review uses native `approvalsReviewer: "auto_review"` with `approvalPolicy: "on-request"`; managed restrictions disable unavailable choices. The default choice retains native settings.

## Login and subscription

An existing native Codex login is recognized automatically. **Codex account** shows the account, subscription windows and reset times. Missing quota data stays unavailable; checking it never sends a model request.

Custom providers configured through native Codex settings (including cc-switch) are supported. The toolbar shows **Codex · <provider id>**; its account panel shows the provider name, API endpoint and authentication method separately from any native Codex login. Provider credentials stay in Codex configuration or the execution host’s environment. Third-party balance and usage are checked with that provider, not through ChatGPT subscription limits.

- On this machine, **Sign in with ChatGPT** opens the browser flow.
- On an SSH host, it requests device login and shows the verification link and one-time code. Device login must be enabled for the account.
- If device login is unavailable, run `ssh -L 1455:localhost:1455 <host>` and run `codex login` on that host, then refresh the account view. The CLI must use the same `CODEX_HOME` as the daemon. The managed CLI can be run with `node <runtime-directory>/node_modules/@openai/codex/bin/codex.js login`.
- **Use API key** is an explicit alternative with separate API billing.

Login and logout affect other native Codex clients sharing that home. Account changes wait until IroWell's Codex work and handovers have finished. IroWell never reads or refreshes OAuth tokens itself.

## Settings

Settings has **General**, **Claude**, and **Codex** tabs. General holds the host theme, the default conversation engine, and IroWell UI plugins. Codex defaults cover model, reasoning effort, work mode, and permissions for new IroWell conversations on that host. **Use Codex config** removes the IroWell override; it never edits native provider settings or credentials. Existing conversations keep their own choices. Claude defaults remain separate.

The Codex tab shows the active provider, effective defaults and their native source, plus read-only Skills and MCP information. **Re-read native configuration** refreshes external changes such as cc-switch edits for new conversations. MCP connection status comes from the selected live Codex session; without one, the page shows host inventory and labels unavailable connection status explicitly.

## Conversations

Type **$** in the composer to find an enabled native Skill by name or description, or use **/skills** to open the same picker. Select with ↑/↓ and Enter/Tab, or click; Enter selects without sending. The composer inserts `$name` and sends the selected Skill's exact path as a native `skill` input item. Skills come from the execution host and current project, including over SSH. Same-name entries show their paths. Selections follow draft switches and queued messages; deleting the mention removes its explicit invocation.

Text, attached images, command output, changes/diffs, native plans, MCP calls, searches and subagent activity use native turn/item identities. Images are saved on the execution machine. Approvals keep their native choices and scopes; one browser's answer resolves the request for every browser. Closing a browser only stops observation.

**Past sessions → Codex** lists native history with pagination. Histories imported from another client open for reading. **Branch and continue** is the default continuation path; continuing in place asks you to confirm the original client has stopped. IroWell's per-thread lease coordinates its own daemon generations; it does not lock an independent Codex CLI or desktop client.

A turn's menu can branch through a finished turn or **Revert conversation to here**. Revert requires confirmation and removes that turn and later conversation history. It does not restore files. Legacy native histories can be read; conversation revert is offered only for paginated histories. Sidebar archive hides the IroWell row and retains native history.

Native plans are read-only. Claude's progress editor, workplace and cross-session scripts are not attached to Codex sessions. Generic file browsing, Markdown/Mermaid, terminals, ports and UI plugins remain available. Managed background terminals appear in Tasks; detaching stops them.

## Recovery and updates

A runtime crash invalidates pending approvals and marks affected conversations detached. Reattach reads native history. Requests with uncertain execution results are never resent automatically. Unsent queued messages remain available through **Send now** or can be taken back into the composer.

Updates prepare the exact managed runtime version before activation. A running turn, approval, or managed background task stays with the old daemon. The old runtime must emit `thread/closed` (or report `notLoaded`) before the new one resumes the same `thread.id` and IroWell `sid`. Commands arriving during handover wait. An unload timeout restores the old subscription. Old runtime directories are retained; downgrading requires checking native-history compatibility first.

## Validation and maintenance

App Server is experimental. The version authority is `server/codex-runtime.json`; change it only with a matching generated schema and passing regressions. `server/shared.mjs` is the release file manifest, shared by fingerprinting and SSH packaging.

```sh
npm ci --prefix test
# No model calls: fake App Server, browser, approval races, history, recovery and handover.
node test/run.mjs codex quick
# Optional real protocol check: fresh temporary CODEX_HOME, no login or model calls.
node test/codex-native.mjs /absolute/path/to/@openai/codex/bin/codex.js
```

The native check generates the experimental JSON schema from the exact executable and checks config, thread creation and confirmed unload. `test/fixtures/codex-app-server.mjs` is the small protocol peer for repeatable tests. `IRO_CHROMIUM` may name an existing Chrome executable. `IRO_TEST_CODEX_BIN` and `IRO_TEST_CODEX_STATE` are test-only overrides.

Before publishing a runtime upgrade, explicitly enable real validation in a temporary project on both a local and SSH host: sign in with a subscription, ask for a small temporary-file edit, exercise command/file approvals, attach an image, interrupt a turn, branch, and revert conversation history. Verify the file survives conversation revert. Repeat reconnect and update with pending approval and background work. These steps use the account's model quota and are not run by the automated suites.

Protocol references: [App Server](https://learn.chatgpt.com/docs/app-server), [authentication](https://learn.chatgpt.com/docs/auth), [release notes](https://learn.chatgpt.com/docs/changelog).
