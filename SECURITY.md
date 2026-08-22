# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: go to the
[Security tab](https://github.com/TheR4iner/fixitalia/security/advisories/new)
and open a draft advisory. That keeps the report private until a fix is out.

Please do not open a public issue for a vulnerability.

This is a personal project maintained in spare time by one person. Expect an
acknowledgement within a week, and a fix on a timeline that depends on
severity. If a report has been sitting unanswered for two weeks, a nudge is
welcome rather than rude.

## What is in scope

fixitalia has no accounts, no login, no cookies, no analytics, and stores no
personal data of its visitors. That removes most of the usual categories, and
it means the reports worth sending are narrower than the template suggests:

- Anything allowing writes to the database through the public API.
- Injection through an ingest source, where crafted upstream data reaches a
  query or the rendered page.
- Exposure of the search or database layer, which should not be reachable from
  the internet at all.
- Cross-site scripting in the rendered transcript or document text. That text
  comes from external HTML, so it is the most plausible route.
- Anything reaching the deploy path or the container images.

## What is not a vulnerability

- **A wrong number.** That is a bug and an important one, but it is not a
  security issue. Open a normal issue: see
  [CONTRIBUTING.md](./CONTRIBUTING.md), where it is the most valuable report
  you can file.
- **Personal data of politicians.** Names, party, attendance, votes and
  speeches are published by the Camera and the Senato themselves. Requests
  about how that data is presented go through the contact on the site, not
  here.
- Missing security headers on responses served by the edge, absent a concrete
  exploit.
- Automated scanner output with no demonstrated impact.

## Dependencies

`npm audit` runs weekly and on every pull request, and Dependabot alerts are
enabled. Advisories in dependencies are usually already known; a report is
still useful if you can show one is actually reachable in this codebase.
