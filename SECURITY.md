# Security Policy

## Supported Versions

Co-Engram is currently in `0.x` development. Security fixes are applied to the latest `0.x` release only.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please report vulnerabilities privately:

### Preferred: GitHub Security Advisory

1. Go to https://github.com/co-engram/co-engram/security/advisories/new
2. Click "Report a vulnerability"
3. Fill in the details (description, reproduction, impact)

This allows us to collaborate on a fix before public disclosure. You'll be credited in the advisory once published.

### Alternative: Email

Send details to **yang.yang29@zte.com.cn** with the subject `[SECURITY] co-engram: <brief summary>`.

Include:

- Description of the vulnerability
- Steps to reproduce
- Affected versions (if known)
- Suggested fix (optional)
- Whether you've already disclosed this anywhere

## Response Time

- **Acknowledgement**: within 48 hours
- **Initial assessment**: within 7 days
- **Fix or mitigation**: target 30 days (depends on severity)

## Disclosure Policy

We follow **coordinated disclosure**:

1. You report privately
2. We acknowledge and investigate
3. We develop a fix and coordinate a release date with you
4. We publish the fix and a security advisory simultaneously
5. Public disclosure happens **after** a fix is available

We will credit you in the advisory unless you request anonymity.

## Scope

**In scope:**

- Security vulnerabilities in Co-Engram's TypeScript code
- Memory corruption, injection, or bypass of access controls
- Crashes or denial-of-service from malformed inputs
- Privilege escalation through the plugin/MCP interfaces

**Out of scope:**

- Vulnerabilities in dependencies (report to upstream)
- Social engineering or phishing
- Physical attacks
- Theoretical attacks without proof of exploitability

## What You Can Expect

- We will treat all reports seriously and respond respectfully
- We will credit reporters (unless anonymity is requested)
- We will not take legal action against good-faith reporters
- We will keep you informed of progress

Thank you for helping keep Co-Engram and its users safe.
