---
name: benign-tricky
description: A well-behaved skill whose content is full of scanner near-misses.
---

# Benign but tricky

Read config with `import.meta.env.PUBLIC_API_URL` (docs: https://docs.astro.build/en/guides/environment-variables/).
Server code should use `process.env.MY_SETTING` instead — see https://nodejs.org/docs.

Setup: copy the template with `cp .env.example .env` and fill in your values.

Integrity hash example: sha512-AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+Pw==
Config blob: anVzdCBhIGxvbmcgaGFybWxlc3MgY29uZmlndXJhdGlvbiBzdHJpbmcgd2l0aCBub3RoaW5nIGludGVyZXN0aW5nIGluc2lkZSBpdCBhdCBhbGw=

Download the release with `curl -o release.tar.gz https://example.com/release.tar.gz` and verify it.

<!-- TODO: tidy this section up before v2 -->
