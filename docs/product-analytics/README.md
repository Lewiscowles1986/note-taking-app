# Product analytics documentation

Plain-language notes about the app's product analytics (PostHog), kept in
[Diátaxis](https://diataxis.fr) form: one file answers one question for one
reader.

## For QA — checking it works

How-to:

- [Verify analytics are sent](qa/how-to-verify-analytics.md)

## For the engineer — what exists and how to change it

Explanation:

- [Product analytics setup (staged changes)](engineer/analytics-setup.md)

How-to, one document per change type:

- [Reconfigure the SDK](engineer/how-to-reconfigure-sdk.md)
- [Add an analytics event](engineer/how-to-add-analytics-event.md)
- [Manage user identification](engineer/how-to-manage-identification.md)
- [Add a structured log event](engineer/how-to-add-log-event.md)
- [Analytics code and the Test Quality workflow](engineer/quality-workflow.md)

## For the privacy team — what data moves

Explanation:

- [What the app records and where it goes](privacy/what-is-recorded.md)

## For the app user — what this means for you

Explanation:

- [What's recorded when you use the app](user/what-is-recorded.md)

## Front-matter key

| Field | Meaning |
|---|---|
| `audience` | Who the file is written for: `engineer`, `privacy`, `user`, or `QA` |
| `diataxis` | Diátaxis type: `howto` or `explanation` |
| `reading-time` | Rough time to read the file end to end |
| `staged-files` | Files the document describes, as of the review date |
| `last-reviewed` | Date the contents were checked against the code |
