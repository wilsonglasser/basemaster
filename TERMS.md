# BaseMaster - Terms of Use & Disclaimer

By installing, running, or otherwise using BaseMaster (the "Software") you acknowledge and agree to the terms below. If you do not agree, do not use the Software.

## Experimental software

BaseMaster is **experimental and under active development**. Features may change, break, or be removed without notice between versions. The Software has not been certified for production use, regulated environments, or any safety-critical workload. There is no warranty, express or implied, that the Software is fit for any particular purpose.

## User responsibility

The Software is a **direct interface to your databases**. It can run any SQL statement you send through it, including statements that modify or destroy data (`DROP`, `DELETE`, `UPDATE`, `TRUNCATE`, `ALTER`, schema changes, data transfer, dump/import, and so on).

**Every action executed through BaseMaster is the sole responsibility of the user.** You are responsible for:

- Knowing what each query, click, drag-and-drop, or AI-suggested action will do before confirming it.
- Operating against the correct connection, schema, and table - confirmation prompts and color cues are aids, not guarantees.
- Maintaining your own backups before any destructive or large-scale operation.
- Verifying credentials, permissions, and network configuration so you do not act against the wrong target.
- Reviewing any SQL produced by AI features (chat, autocomplete, agent) before executing it.

The authors and contributors of BaseMaster are **not responsible for any data loss, corruption, downtime, financial loss, security incident, or other harm** arising from the use or misuse of the Software, regardless of whether such harm was foreseeable.

## No warranty

The Software is provided "AS IS", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and non-infringement. In no event shall the authors or copyright holders be liable for any claim, damages, or other liability, whether in an action of contract, tort or otherwise, arising from, out of, or in connection with the Software or the use or other dealings in the Software.

This is consistent with the [MIT License](LICENSE) under which BaseMaster is distributed.

## Third-party services

BaseMaster connects to third-party database servers, optional cloud AI providers (Anthropic, OpenAI, Google, etc.), and may discover Docker containers running locally. **Use of those services is governed by their own terms.** You are responsible for ensuring your use of the Software through them complies with the relevant agreements, privacy policies, and applicable laws.

## Local data

BaseMaster stores connection profiles, settings, and query history locally on your machine (typically under your OS user data directory). Passwords are kept in the OS keyring whenever possible. The local SQLite store and exported `.bmconn` bundles can include sensitive metadata; **handle them as you would any credential file**.

## Reporting issues

If you encounter a bug, especially one with destructive potential, please report it at <https://github.com/wilsonglasser/basemaster/issues>. Pull requests are welcome.

---

By continuing to use BaseMaster you confirm that you have read and accepted these terms.
