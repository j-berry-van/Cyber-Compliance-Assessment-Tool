# Security Policy

## Supported Versions

We aim to provide security updates for the latest version of CSF Profile Assessment Database.

We recommend always using the latest version for security fixes and improvements.

## Reporting Security Vulnerabilities

Please **DO NOT** report security vulnerabilities through public GitHub issues.

### Preferred Reporting Method

Send security reports directly to: **info@cpatocybersecurity.com**

### What to Include

Please provide the following information:

- **Vulnerability Type**: What kind of security issue (e.g., XSS, injection, data exposure, etc.)
- **Affected Components**: Which parts of the application are affected
- **Impact Assessment**: What could an attacker accomplish
- **Reproduction Steps**: Clear steps to reproduce the vulnerability
- **Proposed Fix**: If you have suggestions for remediation
- **Disclosure Timeline**: Your preferred timeline for public disclosure

### Example Report Format

```
Subject: [SECURITY] Brief description of vulnerability

Vulnerability Type: Cross-Site Scripting (XSS)
Affected Component: Control observation input field
Impact: Potential script execution in user's browser
Severity: High

Reproduction Steps:
1. Navigate to...
2. Enter payload: ...
3. Observe...

Evidence:
[Screenshots, logs, or proof of concept]

Suggested Fix:
Sanitize input using DOMPurify before rendering...
```

## Security Considerations

### Data Storage

- **Local / desktop mode (default):** all assessment data is stored locally in the browser (localStorage)
- **Self-hosted multi-user mode:** assessment data, including the organization profile, is stored in a SQLite database on the server you run (see the multi-user section below)
- In neither mode is data sent to a server operated by this project. The only outbound call the app can make is the optional AI proxy, if you configure a key
- Users (or the server's administrator) are responsible for securing the machines that hold the data
- Exported CSV files may contain sensitive assessment data

### Input Validation

- User inputs are sanitized using DOMPurify before rendering
- CSV imports are validated before processing
- Markdown content is safely rendered to prevent XSS

### Assessment Data Protection

- Assessment data may contain sensitive organizational security information
- Control observations and findings could reveal vulnerabilities
- Action plans may reference confidential remediation strategies
- Score data indicates organizational security posture

**Recommendation**: Treat all exported data as confidential and apply appropriate access controls.

### Browser Security

- Local mode: the application runs entirely client-side, with no authentication (single-user local application)
- Multi-user mode: the client talks to your server and every request needs a signed-in session (see below)
- Browser security policies apply
- Local storage accessible only from the same origin

### Multi-user (server) mode threat model

Multi-user mode is built for a team that trusts each other with one shared workspace and runs its own server. Setup
instructions are in [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

What the server does:

- **Accounts:** created only by an administrator; there is no self-signup. The one exception is first-run setup, which
  creates the administrator and is refused once any account exists. Run it before exposing the server.
- **Password storage:** salted scrypt via Node's built-in `crypto` (no native hashing dependency), minimum 10 characters.
  Unknown usernames cost the same hashing work as known ones to blunt username enumeration by timing.
- **Sessions:** random 256-bit tokens, stored only as SHA-256 hashes in the database, valid 14 days and extended on
  use. The cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` when `COOKIE_SECURE=true` or when `TRUST_PROXY=true` and the
  proxy reports https. Disabling an account or an administrator resetting its password ends its sessions.
- **CSRF:** `SameSite=Lax` plus a rule that state-changing requests must be `application/json`, which a cross-site
  form post cannot send.
- **Rate limiting:** sign-in and setup allow 20 attempts per 15 minutes per IP; the AI proxy has its own per-IP limit.
  Behind a proxy set `TRUST_PROXY=true`, otherwise every client shares the proxy's IP.
- **Authorization:** all data endpoints require a session; account management requires an administrator; the last
  active administrator cannot be disabled. There is **no per-assessment access control**: every active account can read
  and change every assessment, finding, comment and the organization profile.
- **Attribution:** the server records which account last changed each record. Comment and audit-entry author names come
  from the "acting user" selector in the app, which a signed-in person can still change, so they are not proof of
  authorship.
- **Transport:** run it behind HTTPS (for example Caddy or nginx terminating TLS). Without HTTPS, passwords and session
  cookies cross the network in clear text.

What you are responsible for:

- **All data in one file.** Everything, including the organization profile (crown jewels, security tooling) and password
  hashes, lives in `DATA_DIR/csf.db`. Restrict its file permissions to the server's user, encrypt the disk or backups as
  your policy requires, and back it up (`sqlite3 ... ".backup ..."`; see the self-hosting guide).
- **Admin password recovery** is done by someone with shell access to the host, who can also read the database. Host
  access is therefore equivalent to full access to the data.
- Keep Node.js, the dependencies and the host patched.

Supported AI-proxy configuration: in multi-user mode `/api/ai/*` requires a signed-in session and is rate limited, and
the Claude API key stays in the server's environment (the browser never sees it). Running the proxy without accounts
(local mode with the optional backend) is a single-user, localhost setup: do not expose that backend to an untrusted
network, because it has no authentication.

## AI-Assisted Security Review

This project uses AI-assisted review in two layers, mapped to NIST CSF 2.0 functions the same way the app itself maps assessments:

### Layer 1: PR-time diff review (continuous — CSF DE.CM)

Every same-repo pull request is analyzed by [Anthropic's claude-code-security-review](https://github.com/anthropics/claude-code-security-review) GitHub Action (MIT license). It reviews only the changed files, filters false positives, and leaves inline comments. See `.github/workflows/security-review.yml`.

Operating notes:

- **Findings are advisory, never auto-filed.** A human maintainer verifies every finding before it becomes an issue or a fix. Unverified AI findings are noise at best and a disclosure problem at worst.
- **Fork PRs are skipped by design.** GitHub strips repo secrets from `pull_request` runs triggered from forks, so the workflow guards on `head.repo.full_name == github.repository`. Maintainers review external PRs locally with the `/security-review` slash command that ships with Claude Code.
- **The action itself is a prompt-injection surface.** Per Anthropic's own documentation, the reviewer is not hardened against adversarial PR content. The repository uses GitHub's "require approval for outside contributors" workflow setting, and this check stays out of required branch protection until a maintainer has verified a green run.
- **Setup (maintainers):** add a `CLAUDE_API_KEY` repository secret (a dedicated Anthropic API key with a spend cap, enabled for the Claude API and Claude Code). Runs are billed API usage with a 20-minute default timeout.
- **The reviewer is a third-party dependency too.** Both actions in the workflow are pinned to full commit SHAs rather than tags or `@main`, and both belong in the same supply-chain inventory (GV.SC) this section describes. Pin bumps happen deliberately, via PR.
- **Coverage is honest, not total.** Because fork PRs and Dependabot runs are skipped, the automated layer only sees maintainer branches. External contributions, the population that most needs review, get human review plus a local `/security-review` pass instead.

### Layer 2: point-in-time deep review (periodic — CSF ID.RA)

Scheduled deep assessments use [Google's Mantis](https://github.com/google/mantis) (Apache-2.0), a toolkit of security-review skills for AI coding agents covering threat modeling through finding calibration. Mantis is demonstration-grade by Google's own statement and is deliberately **not** wired into CI: it has no CLI, its output is non-deterministic, and running it requires an isolated environment. Assessments run offline on a scoped copy of the repository, findings are human-verified, and confirmed issues enter the normal vulnerability response process above.

### Why two layers

Diff review catches what a change introduces; it cannot see what the codebase already carries. Deep review sees the whole system but is too slow and expensive to run per-PR. Together they cover continuous monitoring (DE.CM) and periodic risk assessment (ID.RA) without pretending either tool replaces the supply-chain and access controls (GV.SC, PR.AA) that bound what any code change can reach.

## Vulnerability Response Process

1. **Report Received**: We'll acknowledge receipt within 48 hours
2. **Initial Assessment**: We'll evaluate severity and impact within 72 hours
3. **Investigation**: We'll investigate and develop fixes
4. **Fix Development**: We'll create and test patches
5. **Coordinated Disclosure**: We'll work with reporter on disclosure timeline
6. **Release**: We'll release patched version with security advisory

### Timeline Expectations

| Severity | Target Resolution |
|----------|-------------------|
| Critical | 1-7 days |
| High | 7-30 days |
| Medium | 30-90 days |
| Low | Next scheduled release |

## Bug Bounty

We don't currently offer a formal bug bounty program, but we deeply appreciate security research and will:

- Acknowledge contributors in release notes
- Provide credit in security advisories

## Security Best Practices for Users

### Installation

- Clone/download only from the official [GitHub repository](https://github.com/CPAtoCybersecurity/csf_profile)
- Keep your installation up to date
- Verify you're using the latest release

### Configuration

- Run the application in a secure browser environment
- Keep your browser updated
- Be cautious when importing CSV files from untrusted sources

### Data Handling

- Regularly back up your assessment data via CSV export (local mode). In multi-user mode the administrator backs up the server database; see [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)
- Store exported files securely with appropriate access controls
- Do not share assessment exports containing sensitive findings publicly
- Clear browser data when assessments are complete if using shared machines

### Network Considerations

- The application runs locally and doesn't require network access
- If deploying to a server, ensure proper authentication and HTTPS
- Consider network segmentation if hosting assessment data centrally

## Known Security Limitations

### Client-Side Storage

- Browser storage is not encrypted at rest by default
- Anyone with physical access to the machine can access stored data
- Browser developer tools can inspect stored assessment data

**Mitigation**: Use full-disk encryption and secure your workstation.

### CSV Import/Export

- Imported CSV files could contain malicious formulas (CSV injection)
- Exported data is unencrypted plain text

**Mitigation**: Only import CSV files from trusted sources. Handle exports as confidential documents.

### No Authentication

- The application has no built-in user authentication
- All users of the same browser profile share the same data

**Mitigation**: Use separate browser profiles or machines for different assessments.

## Security Updates

Security updates are distributed through:

- GitHub Releases with security tags
- Security advisories on GitHub
- README and documentation updates

**Subscribe** to the repository to receive notifications about security updates.

## Contact

- For **non-security issues**: Use [GitHub Issues](https://github.com/CPAtoCybersecurity/csf_profile/issues)
- For **security concerns**: Email the security contact directly (do not use public issues)

We take security seriously and appreciate the community's help in keeping CSF Profile Assessment Database secure for cybersecurity professionals.
