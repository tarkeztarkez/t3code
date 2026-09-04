# Pi

## Notebook activity

Pi code-mode notebook calls appear as "Running command" while they run. T3 Code asks GPT-5.6
Luna with minimal reasoning for a short description after it receives the full notebook input. If that request
fails, the row keeps the generic "Ran command" label.

Consecutive notebook calls between assistant messages collapse into one "Ran N commands" row.
Expand the row to see each description, then expand an individual call to inspect its notebook source
and result.
