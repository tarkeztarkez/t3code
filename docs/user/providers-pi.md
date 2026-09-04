# Pi

## Skills

Type `$` in the composer to search the skills Pi makes available for the current project. T3 Code
asks a short-lived Pi process for its command inventory, so the picker includes trusted skills added
by project extensions as well as skills from standard directories. While the picker stays open, T3
Code checks again every five seconds.

Project extensions remain disabled in the agent session. When an extension contributes a skill, T3
Code passes that skill's file to a new Pi session and includes its instructions when you use the
matching `$name` token. Extension commands are not included because their handlers are unavailable
when project extensions are disabled.

## Notebook activity

Pi code-mode notebook calls appear as "Running command" while they run. T3 Code asks GPT-5.6
Luna with minimal reasoning for a short description after it receives the full notebook input. If that request
fails, the row keeps the generic "Ran command" label.

Consecutive notebook calls between assistant messages collapse into one "Ran N commands" row.
Expand the row to see each description, then expand an individual call to inspect its notebook source
and result.
